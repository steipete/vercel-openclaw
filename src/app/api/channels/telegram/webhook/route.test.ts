/**
 * Tests for POST /api/channels/telegram/webhook.
 *
 * Covers: missing secret header (401), wrong secret (401),
 * no Telegram config (404), happy path enqueue, and dedup.
 *
 * Run: npm test src/app/api/channels/telegram/webhook/route.test.ts
 */

import assert from "node:assert/strict";
import { mock } from "node:test";
import test from "node:test";

import { channelDedupKey } from "@/server/channels/keys";
import { getStore } from "@/server/store/store";
import { getChannelDlqRecord } from "@/server/channels/dlq";
import {
  markChannelFastPathDispatching,
  readChannelHandoff,
} from "@/server/channels/handoff-ledger";
import { FakeSandboxHandle } from "@/test-utils/fake-sandbox-controller";
import { withHarness, type ScenarioHarness } from "@/test-utils/harness";
import { buildTelegramWebhook } from "@/test-utils/webhook-builders";
import {
  callRoute,
  buildPostRequest,
  getTelegramWebhookRoute,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";
import {
  _setTelegramNativeFastPathForTesting,
  telegramWebhookWorkflowRuntime,
} from "@/app/api/channels/telegram/webhook/route";
import { _setAiGatewayTokenOverrideForTesting } from "@/server/env";
import { getServerLogs, _resetLogBuffer } from "@/server/log";
import {
  _setBundleAdmissionForTesting,
  type VerifiedBundleAdmission,
} from "@/server/openclaw/bundle-identity";
import type { VerifiedBundleIdentity } from "@/shared/bundle-identity";
import { channelConfigLockKey } from "@/server/store/keyspace";

const TELEGRAM_WEBHOOK_SECRET = "test-telegram-webhook-secret-direct";

const VERIFIED_BUNDLE_IDENTITY: VerifiedBundleIdentity = {
  packageSpec: "openclaw@2026.7.2",
  version: "2026.7.2",
  forkSha: "a".repeat(40),
  upstreamSha: "b".repeat(40),
  canonicalSha256: "c".repeat(64),
  capabilities: [
    "admin-http-rpc-v1",
    "cron-projection-v1",
    "gateway-suspend-v1",
    "telegram-durable-ack-v1",
  ],
  verified: true,
};

const VERIFIED_BUNDLE_ADMISSION: VerifiedBundleAdmission = {
  identity: VERIFIED_BUNDLE_IDENTITY,
  canonicalTarball: "openclaw-canonical.tgz",
  canonicalTarballUrl: "https://example.invalid/openclaw-canonical.tgz",
  assets: {},
  externalPlugins: [],
};

async function configureTelegram(
  h: ScenarioHarness,
  options: { admitDurableAck?: boolean } = {},
) {
  _setTelegramNativeFastPathForTesting(true);
  const admitDurableAck = options.admitDurableAck !== false;
  _setBundleAdmissionForTesting(
    admitDurableAck ? VERIFIED_BUNDLE_ADMISSION : null,
  );
  await h.mutateMeta((meta) => {
    meta.channels.telegram = {
      botToken: "test-telegram-bot-token",
      botId: "123",
      webhookSecret: TELEGRAM_WEBHOOK_SECRET,
      webhookUrl: "https://test.example.com/api/channels/telegram/webhook",
      botUsername: "test_bot",
      configuredAt: Date.now(),
    };
    meta.bundleIdentity = admitDurableAck
      ? structuredClone(VERIFIED_BUNDLE_IDENTITY)
      : null;
  });
}

// ===========================================================================
// Auth / signature validation
// ===========================================================================

test("Telegram webhook: missing secret header returns 401", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    _resetLogBuffer();
    const route = getTelegramWebhookRoute();
    const req = buildPostRequest(
      "/api/channels/telegram/webhook",
      JSON.stringify({ update_id: 1, message: { text: "hi" } }),
    );
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 401);
    const rejected = getServerLogs().find(
      (entry) => entry.message === "channels.telegram_webhook_rejected",
    );
    assert.ok(rejected, "missing secret rejection should be logged");
    assert.equal(rejected.data?.reason, "missing_or_invalid_secret");
    assert.equal(rejected.data?.hasSecretHeader, false);
  });
});

test("Telegram webhook: wrong secret returns 401", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    _resetLogBuffer();
    const route = getTelegramWebhookRoute();
    const req = buildTelegramWebhook({
      webhookSecret: "wrong-secret-entirely",
    });
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 401);
    const rejected = getServerLogs().find(
      (entry) => entry.message === "channels.telegram_webhook_rejected",
    );
    assert.ok(rejected, "invalid secret rejection should be logged");
    assert.equal(rejected.data?.reason, "missing_or_invalid_secret");
    assert.equal(rejected.data?.hasSecretHeader, true);
  });
});

test("Telegram webhook: pending activation fails closed with retryable 503", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    await h.mutateMeta((meta) => {
      if (!meta.channels.telegram) return;
      meta.channels.telegram.webhookSetupPending = true;
    });
    const result = await callRoute(
      getTelegramWebhookRoute().POST,
      buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET }),
    );
    assert.equal(result.status, 503);
    assert.equal(
      (result.json as { error: string }).error,
      "CONFIG_ACTIVATION_PENDING",
    );
  });
});

test("Telegram webhook: pending disconnect fails closed with retryable 503", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    await h.mutateMeta((meta) => {
      if (!meta.channels.telegram) return;
      meta.channels.telegram.deletionPending = true;
    });
    const result = await callRoute(
      getTelegramWebhookRoute().POST,
      buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET }),
    );
    assert.equal(result.status, 503);
    assert.equal(
      (result.json as { error: string }).error,
      "DISCONNECT_PENDING",
    );
  });
});

test("Telegram webhook: no Telegram config returns 404", async () => {
  await withHarness(async () => {
    _resetLogBuffer();
    const route = getTelegramWebhookRoute();
    const req = buildPostRequest(
      "/api/channels/telegram/webhook",
      JSON.stringify({ update_id: 1 }),
      { "x-telegram-bot-api-secret-token": "any-secret" },
    );
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 404);
    const rejected = getServerLogs().find(
      (entry) => entry.message === "channels.telegram_webhook_rejected",
    );
    assert.ok(rejected, "missing config rejection should be logged");
    assert.equal(rejected.data?.reason, "telegram_not_configured");
  });
});

test("Telegram webhook: invalid JSON is acknowledged and logged", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    _resetLogBuffer();
    const route = getTelegramWebhookRoute();
    const req = buildPostRequest(
      "/api/channels/telegram/webhook",
      "{not-json",
      { "x-telegram-bot-api-secret-token": TELEGRAM_WEBHOOK_SECRET },
    );
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { ok: true });
    const rejected = getServerLogs().find(
      (entry) => entry.message === "channels.telegram_webhook_rejected",
    );
    assert.ok(rejected, "invalid JSON ack should be logged");
    assert.equal(rejected.data?.reason, "invalid_json");
    assert.equal(rejected.data?.bodyLength, "{not-json".length);
  });
});

// ===========================================================================
// Happy path
// ===========================================================================

test("Telegram webhook: valid event enqueues job and returns 200", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    h.fakeFetch.onPost(/api\.telegram\.org/, () =>
      Response.json({ ok: true, result: { message_id: 1 } }),
    );
    const route = getTelegramWebhookRoute();
    const startMock = mock.method(telegramWebhookWorkflowRuntime, "start", async () => {});
    const req = buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET });
    try {
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200);
      const body = result.json as { ok: boolean };
      assert.equal(body.ok, true);
      assert.equal(startMock.mock.callCount(), 1);
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Telegram webhook: admission mismatch does not claim bundle identity is missing", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    _setBundleAdmissionForTesting(null);
    h.fakeFetch.onPost(/api\.telegram\.org/, () =>
      Response.json({ ok: true, result: { message_id: 1 } }),
    );
    const route = getTelegramWebhookRoute();
    const startMock = mock.method(
      telegramWebhookWorkflowRuntime,
      "start",
      async () => {},
    );
    try {
      _resetLogBuffer();
      const result = await callRoute(
        route.POST,
        buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET }),
      );

      assert.equal(result.status, 200);
      const capabilityLog = getServerLogs().find(
        (entry) =>
          entry.message === "telegram.delivery.bundle_capability_missing",
      );
      assert.ok(capabilityLog);
      assert.equal(capabilityLog.data?.bundleIdentityMissing, false);
      assert.equal(capabilityLog.data?.bundleIdentityVerified, false);
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Telegram webhook: passes receivedAtMs to drainChannelWorkflow", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    h.fakeFetch.onPost(/api\.telegram\.org/, () =>
      Response.json({ ok: true, result: { message_id: 1 } }),
    );
    const route = getTelegramWebhookRoute();
    const beforeMs = Date.now();
    const startMock = mock.method(telegramWebhookWorkflowRuntime, "start", async () => {});
    const req = buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET });
    try {
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200);
      assert.equal(startMock.mock.callCount(), 1);

      // drainChannelWorkflow v1 envelope carries receivedAtMs as a field.
      const args = startMock.mock.calls[0].arguments[1] as unknown[];
      assert.equal(args.length, 1, "workflow expects a single v1 envelope");
      const envelope = args[0] as {
        version?: number;
        receivedAtMs?: number;
        workflowHandoff?: {
          fallbackTelegramConfig?: { configuredAt?: number };
          telegramConfigGeneration?: number;
        };
      };
      assert.equal(envelope.version, 1, "envelope must be v1");
      assert.equal(
        envelope.workflowHandoff?.telegramConfigGeneration,
        envelope.workflowHandoff?.fallbackTelegramConfig?.configuredAt,
      );
      const receivedAtMs = envelope.receivedAtMs as number;
      assert.equal(typeof receivedAtMs, "number", "receivedAtMs should be a number");
      assert.ok(receivedAtMs >= beforeMs, "receivedAtMs should be at or after test start");
      assert.ok(receivedAtMs <= Date.now(), "receivedAtMs should be at or before now");
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

// ===========================================================================
// Stale running status — fast path failure triggers wake
// ===========================================================================

test("Telegram webhook: fast path connection failure closes unknown without blind replay", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    // Simulate stale "running" status — sandbox is actually dead
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-stale-dead";
      meta.snapshotId = "snap-123";
      // Fast-path requires telegramListenerReady=true to fire.  The test
      // exercises the network-failure reconcile path, which only runs inside
      // the fast-path's catch branch, so the gate must be satisfied here.
      meta.lastRestoreMetrics = {
        sandboxCreateMs: 0,
        tokenWriteMs: 0,
        assetSyncMs: 0,
        startupScriptMs: 0,
        forcePairMs: 0,
        firewallSyncMs: 0,
        localReadyMs: 0,
        publicReadyMs: 0,
        totalMs: 0,
        skippedStaticAssetSync: false,
        assetSha256: null,
        vcpus: 1,
        recordedAt: Date.now(),
        telegramListenerReady: true,
      };
    });
    // Pre-create the sandbox handle with "stopped" status so reconciliation
    // correctly transitions meta.status to "stopped"
    const handle = await h.controller.get({ sandboxId: "sbx-stale-dead" });
    (handle as FakeSandboxHandle).setStatus("stopped");
    // Fast path fetch will throw (no handler registered for the sandbox domain)
    // Boot message succeeds
    h.fakeFetch.onPost(/api\.telegram\.org/, () =>
      Response.json({ ok: true, result: { message_id: 1 } }),
    );
    const route = getTelegramWebhookRoute();
    const startMock = mock.method(telegramWebhookWorkflowRuntime, "start", async () => {});
    const req = buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET });
    try {
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200);
      assert.equal(
        startMock.mock.callCount(),
        0,
        "possibly accepted delivery must not be blindly replayed",
      );
      const telegramApiCalls = h.fakeFetch
        .requests()
        .filter((entry) => entry.url.includes("api.telegram.org"));
      assert.equal(
        telegramApiCalls.length,
        0,
        "unknown warm delivery must not invent a cold-wake notice",
      );
      const meta = await h.getMeta();
      assert.equal(
        meta.channelDiagnostics?.telegram?.lastDeliveryState?.state,
        "visibility-unknown",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Telegram webhook: pre-dispatch setup failure starts durable workflow", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "oc-pre-dispatch-missing";
      meta.snapshotId = "snap-pre-dispatch-missing";
      meta.portUrls = {};
      meta.lastRestoreMetrics = null;
    });
    h.fakeFetch.onPost(/api\.telegram\.org/, () =>
      Response.json({ ok: true, result: { message_id: 1 } }),
    );

    const route = getTelegramWebhookRoute();
    const startMock = mock.method(
      telegramWebhookWorkflowRuntime,
      "start",
      async () => {},
    );
    try {
      _resetLogBuffer();
      const result = await callRoute(
        route.POST,
        buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET }),
      );

      assert.equal(result.status, 200);
      assert.equal(startMock.mock.callCount(), 1);
      const setupFailure = getServerLogs().find(
        (entry) =>
          entry.message === "channels.telegram_fast_path_setup_failed",
      );
      assert.ok(setupFailure);
      assert.equal(setupFailure.data?.dispatchState, "not-started");
      assert.equal(setupFailure.data?.action, "start_drain_channel_workflow");
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Telegram webhook: connection refusal remains workflow-retryable", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-connection-refused";
      meta.snapshotId = "snap-connection-refused";
      meta.portUrls = {
        "8787": "https://sbx-connection-refused-8787.fake.vercel.run",
      };
      meta.lastRestoreMetrics = null;
    });
    h.fakeFetch.onPost(/telegram-webhook$/, () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNREFUSED" },
      });
    });
    h.fakeFetch.onPost(/api\.telegram\.org/, () =>
      Response.json({ ok: true, result: { message_id: 2 } }),
    );

    const route = getTelegramWebhookRoute();
    const startMock = mock.method(
      telegramWebhookWorkflowRuntime,
      "start",
      async () => {},
    );
    try {
      _resetLogBuffer();
      const result = await callRoute(
        route.POST,
        buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET }),
      );

      assert.equal(result.status, 200);
      assert.equal(startMock.mock.callCount(), 1);
      const setupFailure = getServerLogs().find(
        (entry) =>
          entry.message === "channels.telegram_fast_path_setup_failed",
      );
      assert.ok(setupFailure);
      assert.equal(setupFailure.data?.dispatchState, "started");
      assert.equal(setupFailure.data?.classification, "gateway-unavailable");
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

// ===========================================================================
// Fast-path gate: running sandbox attempts live 8787 forward
// ===========================================================================

test("Telegram webhook: fast path fires when telegramListenerReady is missing", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    // status=running + sandbox + portUrls present but lastRestoreMetrics is missing.
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-telegram-gate-missing";
      meta.snapshotId = "snap-telegram-gate-missing";
      meta.portUrls = {
        "3000": "https://sbx-telegram-gate-missing-3000.fake.vercel.run",
        "8787": "https://sbx-telegram-gate-missing-8787.fake.vercel.run",
      };
      meta.lastRestoreMetrics = null;
    });

    let fastPathForwardCount = 0;
    h.fakeFetch.onPost(/telegram-webhook$/, async () => {
      fastPathForwardCount += 1;
      assert.equal(
        await getStore().acquireLock(channelConfigLockKey("telegram"), 90),
        null,
        "warm delivery must retain the Telegram config lease through dispatch",
      );
      return new Response("ok", {
        status: 200,
        headers: { "x-openclaw-delivery-accepted": "durable" },
      });
    });
    // Boot message responder for the workflow fallthrough path.
    h.fakeFetch.onPost(/api\.telegram\.org/, () =>
      Response.json({ ok: true, result: { message_id: 1 } }),
    );

    const route = getTelegramWebhookRoute();
    const startMock = mock.method(telegramWebhookWorkflowRuntime, "start", async () => {});
    try {
      _resetLogBuffer();
      const req = buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET });
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200);
      assert.equal(
        fastPathForwardCount,
        1,
        "fast-path should use the live 8787 surface when restore metrics are missing",
      );
      assert.equal(
        startMock.mock.callCount(),
        0,
        "workflow must not start when the live 8787 forward succeeds",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Telegram webhook: busy config lease falls back durably before dispatch", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-telegram-config-busy";
      meta.portUrls = {
        "8787": "https://sbx-telegram-config-busy-8787.fake.vercel.run",
      };
    });
    let forwardCalls = 0;
    h.fakeFetch.onPost(/telegram-webhook$/, () => {
      forwardCalls += 1;
      return new Response("ok", { status: 200 });
    });
    h.fakeFetch.onPost(/api\.telegram\.org/, () =>
      Response.json({ ok: true, result: { message_id: 1 } }),
    );
    const token = await getStore().acquireLock(
      channelConfigLockKey("telegram"),
      90,
    );
    assert.ok(token);
    const startMock = mock.method(
      telegramWebhookWorkflowRuntime,
      "start",
      async () => {},
    );

    try {
      const result = await callRoute(
        getTelegramWebhookRoute().POST,
        buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET }),
      );
      assert.equal(result.status, 200);
      assert.equal(forwardCalls, 0);
      assert.equal(startMock.mock.callCount(), 1);
      assert.equal(
        getServerLogs().find(
          (entry) => entry.message === "channels.telegram_fast_path_setup_failed",
        )?.data?.error,
        "telegram_config_lease_unavailable_before_dispatch",
      );
      resetAfterCallbacks();
    } finally {
      await getStore().releaseLock(channelConfigLockKey("telegram"), token);
      startMock.mock.restore();
    }
  });
});

test("Telegram webhook: fast path fires when telegramListenerReady is stale false", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    // status=running but listener readiness was NOT proven during restore.
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-telegram-gate-false";
      meta.snapshotId = "snap-telegram-gate-false";
      meta.portUrls = {
        "3000": "https://sbx-telegram-gate-false-3000.fake.vercel.run",
        "8787": "https://sbx-telegram-gate-false-8787.fake.vercel.run",
      };
      meta.lastRestoreMetrics = {
        sandboxCreateMs: 0,
        tokenWriteMs: 0,
        assetSyncMs: 0,
        startupScriptMs: 0,
        forcePairMs: 0,
        firewallSyncMs: 0,
        localReadyMs: 0,
        publicReadyMs: 0,
        totalMs: 0,
        skippedStaticAssetSync: false,
        assetSha256: null,
        vcpus: 1,
        recordedAt: Date.now(),
        telegramListenerReady: false,
      };
    });

    let fastPathForwardCount = 0;
    h.fakeFetch.onPost(/telegram-webhook$/, () => {
      fastPathForwardCount += 1;
      return new Response("ok", { status: 200 });
    });
    h.fakeFetch.onPost(/api\.telegram\.org/, () =>
      Response.json({ ok: true, result: { message_id: 1 } }),
    );

    const route = getTelegramWebhookRoute();
    const startMock = mock.method(telegramWebhookWorkflowRuntime, "start", async () => {});
    try {
      const req = buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET });
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200);
      assert.equal(
        fastPathForwardCount,
        1,
        "fast-path should test the live 8787 surface even when restore readiness is stale false",
      );
      assert.equal(
        startMock.mock.callCount(),
        0,
        "workflow must not start when the live 8787 forward succeeds",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Telegram webhook: fast path fires when status=running AND telegramListenerReady=true", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-telegram-gate-ready";
      meta.snapshotId = "snap-telegram-gate-ready";
      meta.portUrls = {
        "3000": "https://sbx-telegram-gate-ready-3000.fake.vercel.run",
        "8787": "https://sbx-telegram-gate-ready-8787.fake.vercel.run",
      };
      meta.lastRestoreMetrics = {
        sandboxCreateMs: 0,
        tokenWriteMs: 0,
        assetSyncMs: 0,
        startupScriptMs: 0,
        forcePairMs: 0,
        firewallSyncMs: 0,
        localReadyMs: 0,
        publicReadyMs: 0,
        totalMs: 0,
        skippedStaticAssetSync: false,
        assetSha256: null,
        vcpus: 1,
        recordedAt: Date.now(),
        telegramListenerReady: true,
      };
    });

    let capturedForwardUrl: string | null = null;
    h.fakeFetch.onPost(/telegram-webhook$/, (url) => {
      capturedForwardUrl = url;
      return new Response("ok", {
        status: 200,
        headers: { "x-openclaw-delivery-accepted": "durable" },
      });
    });

    const route = getTelegramWebhookRoute();
    const startMock = mock.method(telegramWebhookWorkflowRuntime, "start", async () => {});
    try {
      const req = buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET });
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { ok: true });
      const forwardUrl = capturedForwardUrl as string | null;
      if (typeof forwardUrl !== "string") {
        assert.fail(
          "fast-path should forward to the native handler on port 8787",
        );
      }
      assert.ok(
        forwardUrl.includes("8787"),
        `forward should hit the 8787 surface (got ${forwardUrl})`,
      );
      assert.ok(
        forwardUrl.endsWith("/telegram-webhook"),
        `forward should end with /telegram-webhook (got ${forwardUrl})`,
      );
      assert.equal(
        startMock.mock.callCount(),
        0,
        "workflow must NOT start when fast-path succeeds",
      );
      const planLog = getServerLogs().find(
        (entry) =>
          entry.message === "channels.telegram_webhook_plan" &&
          entry.data?.sandboxId === "sbx-telegram-gate-ready",
      );
      assert.ok(planLog, "accepted fast-path should log the planner decision");
      assert.equal(planLog.data?.routeOutcome, "fast-path-accepted");
      assert.equal(planLog.data?.workflowKind, "do-not-start");
      assert.equal(planLog.data?.userNoticeKind, "do-not-send");
      assert.equal(planLog.data?.fastPathKind, "accepted");
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Telegram webhook: durable marker without verified bundle capability stays unknown", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h, { admitDurableAck: false });
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-unverified-durable-marker";
      meta.snapshotId = "snap-unverified-durable-marker";
      meta.portUrls = {
        "8787": "https://sbx-unverified-durable-marker-8787.fake.vercel.run",
      };
      meta.lastRestoreMetrics = null;
    });
    h.fakeFetch.onPost(/telegram-webhook$/, () =>
      new Response("ok", {
        status: 200,
        headers: { "x-openclaw-delivery-accepted": "durable" },
      }),
    );

    const route = getTelegramWebhookRoute();
    const startMock = mock.method(
      telegramWebhookWorkflowRuntime,
      "start",
      async () => {},
    );
    try {
      _resetLogBuffer();
      const result = await callRoute(
        route.POST,
        buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET }),
      );

      assert.equal(result.status, 200);
      assert.equal(startMock.mock.callCount(), 0);
      const capabilityLog = getServerLogs().find(
        (entry) =>
          entry.message === "telegram.delivery.bundle_capability_missing",
      );
      assert.ok(capabilityLog);
      assert.equal(
        capabilityLog.data?.capabilityId,
        "telegram-durable-ack-v1",
      );
      assert.equal(capabilityLog.data?.bundleIdentityMissing, true);
      const meta = await h.getMeta();
      assert.equal(
        meta.channelDiagnostics?.telegram?.lastDeliveryState?.state,
        "visibility-unknown",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Telegram webhook: fast path refreshes AI Gateway token before native forward", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    _resetLogBuffer();
    _setAiGatewayTokenOverrideForTesting("fresh-telegram-fast-path-token");
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-telegram-token-refresh";
      meta.snapshotId = "snap-telegram-token-refresh";
      meta.portUrls = {
        "3000": "https://sbx-telegram-token-refresh-3000.fake.vercel.run",
        "8787": "https://sbx-telegram-token-refresh-8787.fake.vercel.run",
      };
      meta.lastTokenRefreshAt = Date.now() - 60 * 60 * 1000;
      meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) - 60;
      meta.lastTokenSource = "oidc";
      meta.lastRestoreMetrics = {
        sandboxCreateMs: 0,
        tokenWriteMs: 0,
        assetSyncMs: 0,
        startupScriptMs: 0,
        forcePairMs: 0,
        firewallSyncMs: 0,
        localReadyMs: 0,
        publicReadyMs: 0,
        totalMs: 0,
        skippedStaticAssetSync: false,
        assetSha256: null,
        vcpus: 1,
        recordedAt: Date.now(),
        telegramListenerReady: true,
      };
    });
    await h.controller.get({ sandboxId: "sbx-telegram-token-refresh" });

    let networkPolicyCountAtForward = -1;
    h.fakeFetch.onPost(/telegram-webhook$/, () => {
      networkPolicyCountAtForward =
        h.controller.getHandle("sbx-telegram-token-refresh")?.networkPolicies.length ?? -1;
      return new Response("ok", { status: 200 });
    });

    const route = getTelegramWebhookRoute();
    const startMock = mock.method(telegramWebhookWorkflowRuntime, "start", async () => {});

    try {
      _resetLogBuffer();
      const result = await callRoute(
        route.POST,
        buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET }),
      );
      assert.equal(result.status, 200);
      assert.equal(startMock.mock.callCount(), 0);
      assert.equal(
        networkPolicyCountAtForward,
        1,
        "AI Gateway network policy must be refreshed before native Telegram forward",
      );
      assert.ok(
        getServerLogs().some((entry) => entry.message === "channels.fast_path_token_refresh"),
        "token refresh outcome should be logged for fast-path triage",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("Telegram webhook: unmarked empty 200 closes unknown without timing inference", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-telegram-empty-200";
      meta.snapshotId = "snap-telegram-empty-200";
      meta.portUrls = {
        "3000": "https://sbx-telegram-empty-200-3000.fake.vercel.run",
        "8787": "https://sbx-telegram-empty-200-8787.fake.vercel.run",
      };
      meta.lastRestoreMetrics = {
        sandboxCreateMs: 0,
        tokenWriteMs: 0,
        assetSyncMs: 0,
        startupScriptMs: 0,
        forcePairMs: 0,
        firewallSyncMs: 0,
        localReadyMs: 0,
        publicReadyMs: 0,
        totalMs: 0,
        skippedStaticAssetSync: false,
        assetSha256: null,
        vcpus: 1,
        recordedAt: Date.now(),
        telegramListenerReady: true,
      };
    });

    h.fakeFetch.onPost(/telegram-webhook$/, () => new Response("", { status: 200 }));
    const sendMessageCalls: string[] = [];
    h.fakeFetch.onPost(/api\.telegram\.org.*\/sendMessage$/, (url) => {
      sendMessageCalls.push(url);
      return Response.json({ ok: true, result: { message_id: 91 } });
    });

    const route = getTelegramWebhookRoute();
    const startMock = mock.method(telegramWebhookWorkflowRuntime, "start", async () => {});

    try {
      _resetLogBuffer();
      const result = await callRoute(
        route.POST,
        buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET }),
      );

      assert.equal(result.status, 200);
      assert.equal(startMock.mock.callCount(), 0);
      assert.equal(sendMessageCalls.length, 0);
      const logs = getServerLogs();
      assert.ok(
        logs.some(
          (entry) =>
            entry.message ===
            "channels.telegram_fast_path_acceptance_unknown",
        ),
      );
      const meta = await h.getMeta();
      assert.equal(
        meta.channelDiagnostics?.telegram?.lastDeliveryState?.state,
        "visibility-unknown",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Telegram webhook: generic native 500 closes unknown without blind workflow", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-telegram-handler-500";
      meta.snapshotId = "snap-telegram-handler-500";
      meta.portUrls = {
        "3000": "https://sbx-telegram-handler-500-3000.fake.vercel.run",
        "8787": "https://sbx-telegram-handler-500-8787.fake.vercel.run",
      };
      meta.lastRestoreMetrics = {
        sandboxCreateMs: 0,
        tokenWriteMs: 0,
        assetSyncMs: 0,
        startupScriptMs: 0,
        forcePairMs: 0,
        firewallSyncMs: 0,
        localReadyMs: 0,
        publicReadyMs: 0,
        totalMs: 0,
        skippedStaticAssetSync: false,
        assetSha256: null,
        vcpus: 1,
        recordedAt: Date.now(),
        telegramListenerReady: true,
      };
    });

    h.fakeFetch.onPost(/telegram-webhook$/, () =>
      new Response("native handler failed", { status: 500 }),
    );
    const sendMessageCalls: string[] = [];
    h.fakeFetch.onPost(/api\.telegram\.org.*\/sendMessage$/, (url) => {
      sendMessageCalls.push(url);
      return Response.json({ ok: true, result: { message_id: 92 } });
    });

    const route = getTelegramWebhookRoute();
    const startMock = mock.method(telegramWebhookWorkflowRuntime, "start", async () => {});

    try {
      _resetLogBuffer();
      const result = await callRoute(
        route.POST,
        buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET }),
      );

      assert.equal(result.status, 200);
      assert.equal(startMock.mock.callCount(), 0);
      assert.equal(sendMessageCalls.length, 0);
      const unknownLog = getServerLogs().find(
        (entry) =>
          entry.message === "channels.telegram_fast_path_acceptance_unknown",
      );
      assert.ok(unknownLog);
      assert.equal(unknownLog.data?.status, 500);
      assert.equal(unknownLog.data?.action, "ack_without_blind_redrive");
      const meta = await h.getMeta();
      assert.equal(
        meta.channelDiagnostics?.telegram?.lastForward?.classification,
        "acceptance-unknown",
      );
      assert.equal(
        meta.channelDiagnostics?.telegram?.lastDeliveryState?.state,
        "visibility-unknown",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Telegram webhook: repairs stale Telegram port URL once before workflow wake path", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-telegram-repair";
      meta.snapshotId = "snap-telegram-repair";
      meta.portUrls = {
        "3000": "https://sbx-telegram-repair-3000.fake.vercel.run",
        "8787": "https://stale-telegram-repair-8787.fake.vercel.run",
      };
      meta.lastRestoreMetrics = {
        sandboxCreateMs: 0,
        tokenWriteMs: 0,
        assetSyncMs: 0,
        startupScriptMs: 0,
        forcePairMs: 0,
        firewallSyncMs: 0,
        localReadyMs: 0,
        publicReadyMs: 0,
        totalMs: 0,
        skippedStaticAssetSync: false,
        assetSha256: null,
        vcpus: 1,
        recordedAt: Date.now(),
        telegramListenerReady: true,
      };
    });

    let forwardCalls = 0;
    h.fakeFetch.onPost(/telegram-webhook$/, () => {
      forwardCalls += 1;
      if (forwardCalls === 1) {
        return new Response(
          JSON.stringify({
            error: {
              code: "502",
              id: "fra1:iad1::87bgt-test",
              message: "This sandbox is not listening on the requested port.",
            },
          }),
          { status: 502, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("ok", {
        status: 200,
        headers: { "x-openclaw-delivery-accepted": "durable" },
      });
    });
    const sendMessageCalls: string[] = [];
    h.fakeFetch.onPost(/api\.telegram\.org.*\/sendMessage$/, (url) => {
      sendMessageCalls.push(url);
      return Response.json({ ok: true, result: { message_id: 88 } });
    });

    const route = getTelegramWebhookRoute();
    const startMock = mock.method(telegramWebhookWorkflowRuntime, "start", async () => {});

    try {
      _resetLogBuffer();
      const req = buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET });
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { ok: true });
      assert.equal(forwardCalls, 2, "stale-port repair should make exactly one retry");
      assert.equal(startMock.mock.callCount(), 0, "workflow should not start after stale-port repair accepts");
      assert.equal(sendMessageCalls.length, 0, "stale-port repair should avoid sending a waiting message");

      const logs = getServerLogs();
      const repairAttemptLog = logs.find(
        (entry) => entry.message === "channels.telegram_fast_path_stale_port_repair_attempt",
      );
      assert.ok(repairAttemptLog, "stale-port repair attempt should be logged");
      assert.equal(repairAttemptLog.data?.oldUrl, "https://stale-telegram-repair-8787.fake.vercel.run");
      assert.equal(repairAttemptLog.data?.newUrl, "https://sbx-telegram-repair-8787.fake.vercel.run");
      assert.equal(repairAttemptLog.data?.attempt, 2);

      const repairResultLog = logs.find(
        (entry) => entry.message === "channels.telegram_fast_path_stale_port_repair_result",
      );
      assert.ok(repairResultLog, "stale-port repair result should be logged");
      assert.equal(repairResultLog.data?.accepted, true);
      assert.equal(repairResultLog.data?.workflowStarted, false);
      assert.equal(repairResultLog.data?.bootMessageSent, false);
      assert.equal(repairResultLog.data?.classification, "accepted");

      const okLog = logs.find(
        (entry) => entry.message === "channels.telegram_fast_path_ok" && entry.data?.repairedStalePort === true,
      );
      assert.ok(okLog, "repaired fast-path success should be logged");

      const forwardOutcomeLogs = logs.filter((entry) => entry.message === "channels.forward_outcome");
      const acceptedOutcome = forwardOutcomeLogs.find(
        (entry) => entry.data?.channel === "telegram" && entry.data?.ok === true,
      );
      assert.ok(acceptedOutcome, "accepted stale-port repair should update lastForward");
      assert.equal(acceptedOutcome.data?.attempts, 2);
      assert.equal(acceptedOutcome.data?.classification, "accepted");

      const meta = await h.getMeta();
      assert.equal(
        meta.portUrls?.["8787"],
        "https://sbx-telegram-repair-8787.fake.vercel.run",
        "dead Telegram port URL should be refreshed before repair retry",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Telegram webhook: stale-port repair timeout closes unknown without replay", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-telegram-repair-timeout";
      meta.snapshotId = "snap-telegram-repair-timeout";
      meta.portUrls = {
        "3000":
          "https://sbx-telegram-repair-timeout-3000.fake.vercel.run",
        "8787":
          "https://stale-telegram-repair-timeout-8787.fake.vercel.run",
      };
      meta.lastRestoreMetrics = {
        sandboxCreateMs: 0,
        tokenWriteMs: 0,
        assetSyncMs: 0,
        startupScriptMs: 0,
        forcePairMs: 0,
        firewallSyncMs: 0,
        localReadyMs: 0,
        publicReadyMs: 0,
        totalMs: 0,
        skippedStaticAssetSync: false,
        assetSha256: null,
        vcpus: 1,
        recordedAt: Date.now(),
        telegramListenerReady: true,
      };
    });

    let forwardCalls = 0;
    h.fakeFetch.onPost(/telegram-webhook$/, () => {
      forwardCalls += 1;
      if (forwardCalls === 1) {
        return new Response(
          JSON.stringify({
            error: {
              code: "502",
              id: "fra1:iad1::repair-timeout",
              message:
                "This sandbox is not listening on the requested port.",
            },
          }),
          { status: 502, headers: { "content-type": "application/json" } },
        );
      }
      throw Object.assign(new Error("repair response timed out"), {
        name: "TimeoutError",
      });
    });

    const route = getTelegramWebhookRoute();
    const startMock = mock.method(
      telegramWebhookWorkflowRuntime,
      "start",
      async () => {},
    );

    try {
      const result = await callRoute(
        route.POST,
        buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET }),
      );

      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { ok: true });
      assert.equal(forwardCalls, 2);
      assert.equal(startMock.mock.callCount(), 0);
      assert.equal(
        h.fakeFetch
          .requests()
          .some((entry) => entry.url.includes("api.telegram.org")),
        false,
      );
      const meta = await h.getMeta();
      assert.equal(
        meta.channelDiagnostics?.telegram?.lastForward?.attempts,
        2,
      );
      assert.equal(
        meta.channelDiagnostics?.telegram?.lastDeliveryState?.state,
        "visibility-unknown",
      );
      assert.equal(
        meta.channelDiagnostics?.telegram?.lastForward?.sandboxUrl,
        "https://sbx-telegram-repair-timeout-8787.fake.vercel.run",
      );
    } finally {
      startMock.mock.restore();
      resetAfterCallbacks();
    }
  });
});

test("Telegram webhook: suspension admission 503 wakes without dead-gateway reconcile", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-telegram-suspended";
      meta.snapshotId = "snap-telegram-suspended";
      meta.portUrls = {
        "3000": "https://sbx-telegram-suspended-3000.fake.vercel.run",
        "8787": "https://sbx-telegram-suspended-8787.fake.vercel.run",
      };
      meta.lastRestoreMetrics = {
        sandboxCreateMs: 0,
        tokenWriteMs: 0,
        assetSyncMs: 0,
        startupScriptMs: 0,
        forcePairMs: 0,
        firewallSyncMs: 0,
        localReadyMs: 0,
        publicReadyMs: 0,
        totalMs: 0,
        skippedStaticAssetSync: false,
        assetSha256: null,
        vcpus: 1,
        recordedAt: Date.now(),
        telegramListenerReady: true,
      };
    });

    h.fakeFetch.onPost(/telegram-webhook$/, () =>
      Response.json(
        {
          error: {
            code: "gateway_unavailable",
            message: "Gateway is suspended and is not accepting new work.",
          },
        },
        { status: 503 },
      ),
    );
    h.fakeFetch.onPost(/api\.telegram\.org.*\/sendMessage$/, () =>
      Response.json({ ok: true, result: { message_id: 93 } }),
    );
    const route = getTelegramWebhookRoute();
    let revalidateSandboxBeforeForward: boolean | undefined;
    const startMock = mock.method(
      telegramWebhookWorkflowRuntime,
      "start",
      async (_workflow: unknown, args: unknown[]) => {
        const envelope = args[0] as {
          workflowHandoff?: { revalidateSandboxBeforeForward?: boolean };
        };
        revalidateSandboxBeforeForward =
          envelope.workflowHandoff?.revalidateSandboxBeforeForward;
      },
    );

    try {
      _resetLogBuffer();
      const result = await callRoute(
        route.POST,
        buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET }),
      );

      assert.equal(result.status, 200);
      assert.equal(startMock.mock.callCount(), 1);
      assert.equal(revalidateSandboxBeforeForward, true);
      const logs = getServerLogs();
      const fallback = logs.find(
        (entry) =>
          entry.message ===
          "channels.telegram_fast_path_fallback_to_workflow",
      );
      assert.ok(fallback);
      assert.equal(fallback.data?.classification, "gateway-unavailable");
      assert.equal(fallback.data?.reason, "gateway_admission_closed");
      assert.equal(
        logs.some(
          (entry) =>
            entry.message === "channels.telegram_fast_path_reconciled",
        ),
        false,
      );
      assert.equal(
        logs.some((entry) => entry.message === "sandbox.port_url_dead"),
        false,
      );
      const meta = await h.getMeta();
      assert.equal(meta.status, "running");
      assert.equal(meta.sandboxId, "sbx-telegram-suspended");
      assert.equal(
        meta.portUrls?.["8787"],
        "https://sbx-telegram-suspended-8787.fake.vercel.run",
      );
    } finally {
      startMock.mock.restore();
      resetAfterCallbacks();
    }
  });
});

test("Telegram webhook: unverified gateway_unavailable 503 closes unknown", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h, { admitDurableAck: false });
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-unverified-gateway-unavailable";
      meta.portUrls = {
        "8787": "https://sbx-unverified-gateway-unavailable-8787.fake.vercel.run",
      };
    });
    h.fakeFetch.onPost(/telegram-webhook$/, () =>
      Response.json(
        { error: { code: "gateway_unavailable" } },
        { status: 503 },
      ),
    );

    const route = getTelegramWebhookRoute();
    const startMock = mock.method(
      telegramWebhookWorkflowRuntime,
      "start",
      async () => {},
    );
    try {
      _resetLogBuffer();
      const result = await callRoute(
        route.POST,
        buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET }),
      );

      assert.equal(result.status, 200);
      assert.equal(startMock.mock.callCount(), 0);
      const meta = await h.getMeta();
      assert.equal(
        meta.channelDiagnostics?.telegram?.lastDeliveryState?.state,
        "visibility-unknown",
      );
      const capabilityLog = getServerLogs().find(
        (entry) =>
          entry.message === "telegram.delivery.bundle_capability_missing" &&
          entry.data?.capabilityId === "gateway-suspend-v1",
      );
      assert.ok(capabilityLog);
      assert.equal(capabilityLog.data?.bundleIdentityMissing, true);
    } finally {
      startMock.mock.restore();
      resetAfterCallbacks();
    }
  });
});

test("Telegram webhook: fast path non-ok response falls through to workflow wake path", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-telegram-non-ok";
      meta.snapshotId = "snap-telegram-non-ok";
      meta.portUrls = {
        "3000": "https://sbx-telegram-non-ok-3000.fake.vercel.run",
        "8787": "https://stale-telegram-8787.fake.vercel.run",
      };
      meta.lastRestoreMetrics = {
        sandboxCreateMs: 0,
        tokenWriteMs: 0,
        assetSyncMs: 0,
        startupScriptMs: 0,
        forcePairMs: 0,
        firewallSyncMs: 0,
        localReadyMs: 0,
        publicReadyMs: 0,
        totalMs: 0,
        skippedStaticAssetSync: false,
        assetSha256: null,
        vcpus: 1,
        recordedAt: Date.now(),
        telegramListenerReady: true,
      };
    });

    h.fakeFetch.onPost(/telegram-webhook$/, () =>
      new Response(
        JSON.stringify({
          error: {
            code: "502",
            id: "fra1:iad1::87bgt-test",
            message: "This sandbox is not listening on the requested port.",
          },
        }),
        { status: 502, headers: { "content-type": "application/json" } },
      ),
    );
    const bootMessageId = 88;
    const sendMessageCalls: string[] = [];
    h.fakeFetch.onPost(/api\.telegram\.org.*\/sendMessage$/, (url) => {
      sendMessageCalls.push(url);
      return Response.json({ ok: true, result: { message_id: bootMessageId } });
    });

    const route = getTelegramWebhookRoute();
    let workflowBootMessageId: number | string | null | undefined;
    const startMock = mock.method(telegramWebhookWorkflowRuntime, "start", async (_workflow: unknown, args: unknown[]) => {
      const envelope = Array.isArray(args) ? args[0] as { bootMessageId?: number | string | null } : null;
      workflowBootMessageId = envelope?.bootMessageId;
    });

    try {
      _resetLogBuffer();
      const req = buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET });
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { ok: true });
      assert.equal(
        startMock.mock.callCount(),
        1,
        "workflow MUST start when native handler returned non-2xx so the update is not silently dropped",
      );
      assert.equal(sendMessageCalls.length, 0, "webhook route must not create a pre-handoff placeholder");
      assert.equal(workflowBootMessageId, null, "durable workflow owns placeholder creation");
      const logs = getServerLogs();
      const bootMessageLog = logs.find(
        (entry) => entry.message === "channels.telegram_boot_message_sent",
      );
      assert.equal(bootMessageLog, undefined);
      const planLog = logs.find(
        (entry) =>
          entry.message === "channels.telegram_webhook_plan" &&
          entry.data?.sandboxId === "sbx-telegram-non-ok",
      );
      assert.ok(planLog, "non-ok fast path should log the planner decision");
      assert.equal(planLog.data?.fastPathKind, "fallback-to-workflow");
      assert.equal(planLog.data?.fastPathReason, "sandbox-not-listening");
      assert.equal(planLog.data?.workflowReason, "fast-path-fallback");
      assert.equal(planLog.data?.userNoticeKind, "send-before-workflow");
      const gatewayErrorLog = logs.find(
        (entry) => entry.message === "channels.telegram_fast_path_gateway_error",
      );
      assert.ok(gatewayErrorLog, "gateway error log should be emitted");
      assert.equal(gatewayErrorLog.data?.classification, "sandbox-not-listening");
      assert.match(
        String(gatewayErrorLog.data?.bodyHead ?? ""),
        /sandbox is not listening/i,
      );
      const staleLog = logs.find((entry) => entry.message === "sandbox.port_url_dead");
      assert.ok(staleLog, "stale Telegram port URL should be invalidated");
      assert.equal(staleLog.data?.port, 8787);
      assert.equal(staleLog.data?.reason, "fast-path-not-listening");
      assert.equal(
        staleLog.data?.cachedUrl,
        "https://stale-telegram-8787.fake.vercel.run",
      );
      const refreshLog = logs.find((entry) => entry.message === "sandbox.port_urls.refreshed");
      assert.ok(refreshLog, "Telegram port URL should be refreshed after stale invalidation");
      assert.equal(refreshLog.data?.port, 8787);
      const deadPortLog = logs.find(
        (entry) => entry.message === "channels.telegram_fast_path_dead_port_recorded",
      );
      assert.ok(deadPortLog, "dead Telegram port should be recorded before workflow handoff");
      assert.equal(deadPortLog.data?.action, "start_drain_channel_workflow");
      assert.equal(deadPortLog.data?.staleRefreshed, true);
      const meta = await h.getMeta();
      assert.equal(
        meta.portUrls?.["8787"],
        "https://sbx-telegram-non-ok-8787.fake.vercel.run",
        "dead Telegram port URL should be refreshed before workflow retry",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

// ===========================================================================
// Dedup
// ===========================================================================

test("Telegram webhook: duplicate update_id is deduplicated", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    const config = (await h.getMeta()).channels.telegram;
    assert.ok(config);
    const telegramDeliveryId = `telegram:bot:${config.botId}:99999`;
    _resetLogBuffer();
    h.fakeFetch.onPost(/api\.telegram\.org/, () =>
      Response.json({ ok: true, result: { message_id: 1 } }),
    );
    const route = getTelegramWebhookRoute();
    const startMock = mock.method(telegramWebhookWorkflowRuntime, "start", async () => {});

    const payload = {
      update_id: 99999,
      message: {
        message_id: 1,
        from: { id: 12345, first_name: "Test", is_bot: false },
        chat: { id: 12345, type: "private", first_name: "Test" },
        date: Math.floor(Date.now() / 1000),
        text: "dedup test",
      },
    };

    try {
      const req1 = buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET, payload });
      const result1 = await callRoute(route.POST, req1);
      assert.equal(result1.status, 200);
      resetAfterCallbacks();

      const req2 = buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET, payload });
      const result2 = await callRoute(route.POST, req2);
      assert.equal(result2.status, 200);
      const body2 = result2.json as { ok: boolean };
      assert.equal(body2.ok, true);
      assert.equal(startMock.mock.callCount(), 1);
      const dedupSkip = getServerLogs().find(
        (entry) => entry.message === "channels.telegram_webhook_dedup_skip",
      );
      assert.ok(dedupSkip, "duplicate Telegram update skip should be logged");
      assert.equal(dedupSkip.data?.updateId, "99999");
      assert.equal(
        dedupSkip.data?.dedupKey,
        channelDedupKey("telegram", telegramDeliveryId),
      );
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Telegram webhook: the same update_id stays deduplicated after same-bot config rotation", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    const firstConfig = (await h.getMeta()).channels.telegram;
    assert.ok(firstConfig);
    h.fakeFetch.onPost(/api\.telegram\.org/, () =>
      Response.json({ ok: true, result: { message_id: 1 } }),
    );
    const route = getTelegramWebhookRoute();
    const startMock = mock.method(
      telegramWebhookWorkflowRuntime,
      "start",
      async () => {},
    );
    const payload = {
      update_id: 777,
      message: { chat: { id: 123 }, text: "generation scoped" },
    };

    try {
      const first = await callRoute(
        route.POST,
        buildTelegramWebhook({
          webhookSecret: firstConfig.webhookSecret,
          payload,
        }),
      );
      assert.equal(first.status, 200);
      resetAfterCallbacks();

      const secondSecret = "rotated-webhook-secret";
      await h.mutateMeta((meta) => {
        assert.ok(meta.channels.telegram);
        meta.channels.telegram = {
          ...meta.channels.telegram,
          webhookSecret: secondSecret,
          configuredAt: firstConfig.configuredAt + 1,
        };
      });
      const second = await callRoute(
        route.POST,
        buildTelegramWebhook({ webhookSecret: secondSecret, payload }),
      );
      assert.equal(second.status, 200);
      assert.equal(startMock.mock.callCount(), 1);
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Telegram webhook: previous-secret retry keeps its original delivery generation", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    const firstConfig = (await h.getMeta()).channels.telegram;
    assert.ok(firstConfig);
    h.fakeFetch.onPost(/api\.telegram\.org/, () =>
      Response.json({ ok: true, result: { message_id: 1 } }),
    );
    const route = getTelegramWebhookRoute();
    const startMock = mock.method(
      telegramWebhookWorkflowRuntime,
      "start",
      async () => {},
    );
    const payload = {
      update_id: 778,
      message: { chat: { id: 123 }, text: "grace retry" },
    };

    try {
      const first = await callRoute(
        route.POST,
        buildTelegramWebhook({
          webhookSecret: firstConfig.webhookSecret,
          payload,
        }),
      );
      assert.equal(first.status, 200);
      resetAfterCallbacks();
      _resetLogBuffer();

      await h.mutateMeta((meta) => {
        assert.ok(meta.channels.telegram);
        meta.channels.telegram = {
          ...meta.channels.telegram,
          webhookSecret: "current-secret-after-rotation",
          configuredAt: firstConfig.configuredAt + 1,
          botId: firstConfig.botId ?? "123",
          previousWebhookSecret: firstConfig.webhookSecret,
          previousSecretExpiresAt: Date.now() + 60_000,
          previousBotId: firstConfig.botId ?? "123",
          previousBotUsername: firstConfig.botUsername,
          previousConfiguredAt: firstConfig.configuredAt,
        };
      });
      const retry = await callRoute(
        route.POST,
        buildTelegramWebhook({
          webhookSecret: firstConfig.webhookSecret,
          payload,
        }),
      );
      assert.equal(retry.status, 200);
      assert.equal(startMock.mock.callCount(), 1);
      const dedupSkip = getServerLogs().find(
        (entry) => entry.message === "channels.telegram_webhook_dedup_skip",
      );
      assert.equal(
        dedupSkip?.data?.dedupKey,
        channelDedupKey(
          "telegram",
          `telegram:bot:${firstConfig.botId}:778`,
        ),
      );
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Telegram webhook: unexpected enqueue failure returns 500", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    const route = getTelegramWebhookRoute();
    const store = getStore();
    const acquireMock = mock.method(store, "acquireLock", async () => {
      throw new Error("store unavailable");
    });

    try {
      const req = buildTelegramWebhook({
        webhookSecret: TELEGRAM_WEBHOOK_SECRET,
        payload: {
          update_id: 123456,
          message: {
            message_id: 1,
            from: { id: 123, first_name: "Test", is_bot: false },
            chat: { id: 123, type: "private", first_name: "Test" },
            date: Math.floor(Date.now() / 1000),
            text: "hello",
          },
        },
      });
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 500);
      assert.deepEqual(result.json, {
        ok: false,
        error: "WORKFLOW_START_FAILED",
        retryable: true,
      });
    } finally {
      acquireMock.mock.restore();
    }
  });
});

test("Telegram webhook: creates no boot message before a failed workflow start", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    const config = (await h.getMeta()).channels.telegram;
    assert.ok(config);
    const bootMessageId = 77;
    const sendCalls: string[] = [];
    const deleteCalls: string[] = [];
    h.fakeFetch.onPost(/api\.telegram\.org.*\/sendMessage$/, (url) => {
      sendCalls.push(url);
      return Response.json({ ok: true, result: { message_id: bootMessageId } });
    });
    h.fakeFetch.onPost(/api\.telegram\.org.*\/deleteMessage$/, (url) => {
      deleteCalls.push(url);
      return Response.json({ ok: true, result: true });
    });
    const route = getTelegramWebhookRoute();
    const payload = {
      update_id: 99997,
      message: {
        message_id: 1,
        from: { id: 12345, first_name: "Test", is_bot: false },
        chat: { id: 12345, type: "private", first_name: "Test" },
        date: Math.floor(Date.now() / 1000),
        text: "boot cleanup",
      },
    };
    const dedupKey = channelDedupKey(
      "telegram",
      `telegram:${config.botUsername}:${config.configuredAt}:${payload.update_id}`,
    );
    const startMock = mock.method(telegramWebhookWorkflowRuntime, "start", async () => {
      throw new Error("workflow engine unavailable");
    });

    try {
      const req = buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET, payload });
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 500);
      assert.deepEqual(result.json, {
        ok: false,
        error: "WORKFLOW_START_FAILED",
        retryable: true,
      });

      assert.equal(sendCalls.length, 0, "webhook route must not create a placeholder");
      assert.equal(deleteCalls.length, 0, "there is no pre-handoff placeholder to clean up");

      const reacquiredToken = await getStore().acquireLock(dedupKey, 60);
      assert.ok(reacquiredToken, "dedup lock should still be released when workflow start fails");
      await getStore().releaseLock(dedupKey, reacquiredToken!);
      assert.equal(startMock.mock.callCount(), 1);
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Telegram webhook: releases dedup lock and returns 500 when workflow start fails", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    const config = (await h.getMeta()).channels.telegram;
    assert.ok(config);
    h.fakeFetch.onPost(/api\.telegram\.org/, () =>
      Response.json({ ok: true, result: { message_id: 42 } }),
    );
    const route = getTelegramWebhookRoute();
    const payload = {
      update_id: 99998,
      message: {
        message_id: 1,
        from: { id: 12345, first_name: "Test", is_bot: false },
        chat: { id: 12345, type: "private", first_name: "Test" },
        date: Math.floor(Date.now() / 1000),
        text: "start fail",
      },
    };
    const dedupKey = channelDedupKey(
      "telegram",
      `telegram:${config.botUsername}:${config.configuredAt}:${payload.update_id}`,
    );
    const startMock = mock.method(telegramWebhookWorkflowRuntime, "start", async () => {
      throw new Error("workflow engine unavailable");
    });

    try {
      const req = buildTelegramWebhook({ webhookSecret: TELEGRAM_WEBHOOK_SECRET, payload });
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 500);
      assert.deepEqual(result.json, {
        ok: false,
        error: "WORKFLOW_START_FAILED",
        retryable: true,
      });

      const reacquiredToken = await getStore().acquireLock(dedupKey, 60);
      assert.ok(reacquiredToken, "dedup lock should be released when workflow start fails");
      await getStore().releaseLock(dedupKey, reacquiredToken!);
      assert.equal(startMock.mock.callCount(), 1);
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Telegram webhook: retry does not terminalize an active fast-path dispatch", async () => {
  await withHarness(async (h) => {
    await configureTelegram(h);
    const payload = {
      update_id: 99999,
      message: {
        message_id: 1,
        from: { id: 12345, first_name: "Test", is_bot: false },
        chat: { id: 12345, type: "private", first_name: "Test" },
        date: Math.floor(Date.now() / 1000),
        text: "active dispatch retry",
      },
    };
    const deliveryId = `telegram:bot:123:${payload.update_id}`;
    const dispatch = await markChannelFastPathDispatching({
      channel: "telegram",
      deliveryId,
    });
    assert.equal(dispatch.action, "dispatch");
    await getStore().acquireLock(
      channelDedupKey("telegram", deliveryId),
      60 * 60,
    );

    const result = await callRoute(
      getTelegramWebhookRoute().POST,
      buildTelegramWebhook({
        webhookSecret: TELEGRAM_WEBHOOK_SECRET,
        payload,
      }),
    );

    assert.equal(result.status, 500);
    assert.equal(
      (await readChannelHandoff("telegram", deliveryId))?.state,
      "fast-path-dispatching",
    );
    assert.equal(await getChannelDlqRecord("telegram", deliveryId), null);
  });
});
