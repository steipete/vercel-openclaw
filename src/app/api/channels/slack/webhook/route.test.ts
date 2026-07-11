/**
 * Tests for POST /api/channels/slack/webhook.
 *
 * Covers: missing signature headers (401), invalid signature (401),
 * no Slack config (404), URL verification challenge, happy path enqueue,
 * and dedup rejection.
 *
 * Run: npm test src/app/api/channels/slack/webhook/route.test.ts
 */

import assert from "node:assert/strict";
import { mock } from "node:test";
import test from "node:test";

import {
  channelDedupKey,
  channelUserMessageDedupKey,
} from "@/server/channels/keys";
import { hostSuspensionOperationKey } from "@/server/store/keyspace";
import type { HostSuspensionState } from "@/server/sandbox/host-suspension";
import { getStore } from "@/server/store/store";
import {
  withHarness,
  type FakeSandboxHandle,
  type ScenarioHarness,
} from "@/test-utils/harness";
import {
  buildSlackWebhook,
  buildSlackUrlVerification,
} from "@/test-utils/webhook-builders";
import {
  callRoute,
  buildPostRequest,
  getSlackWebhookRoute,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";
import { slackWebhookWorkflowRuntime } from "@/app/api/channels/slack/webhook/route";
import { _setAiGatewayTokenOverrideForTesting } from "@/server/env";
import { getServerLogs, _resetLogBuffer } from "@/server/log";
import { gatewayReadyResponse } from "@/test-utils/fake-fetch";
import {
  _setBundleAdmissionForTesting,
  type VerifiedBundleAdmission,
} from "@/server/openclaw/bundle-identity";
import type { VerifiedBundleIdentity } from "@/shared/bundle-identity";

const SLACK_SIGNING_SECRET = "test-slack-signing-secret-direct";

const VERIFIED_BUNDLE_IDENTITY: VerifiedBundleIdentity = {
  packageSpec: "openclaw@2026.7.2",
  version: "2026.7.2",
  forkSha: "a".repeat(40),
  upstreamSha: "b".repeat(40),
  canonicalSha256: "c".repeat(64),
  capabilities: ["gateway-suspend-v1"],
  verified: true,
};

const VERIFIED_BUNDLE_ADMISSION: VerifiedBundleAdmission = {
  identity: VERIFIED_BUNDLE_IDENTITY,
  canonicalTarball: "openclaw-canonical.tgz",
  canonicalTarballUrl: "https://example.invalid/openclaw-canonical.tgz",
  assets: {},
  externalPlugins: [],
};

async function configureSlack(
  h: ScenarioHarness,
  options: { admitGatewaySuspend?: boolean } = {},
) {
  const admitGatewaySuspend = options.admitGatewaySuspend === true;
  _setBundleAdmissionForTesting(
    admitGatewaySuspend ? VERIFIED_BUNDLE_ADMISSION : null,
  );
  await h.mutateMeta((meta) => {
    meta.channels.slack = {
      signingSecret: SLACK_SIGNING_SECRET,
      botToken: "xoxb-test-bot-token",
      configuredAt: Date.now(),
    };
    meta.bundleIdentity = admitGatewaySuspend
      ? structuredClone(VERIFIED_BUNDLE_IDENTITY)
      : null;
  });
}

async function prepareSlackRouteRepair(
  h: ScenarioHarness,
  sandboxId: string,
): Promise<{
  handle: FakeSandboxHandle;
  routeProbeCount: { value: number };
}> {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  await configureSlack(h);
  await h.mutateMeta((meta) => {
    meta.status = "running";
    meta.sandboxId = sandboxId;
    meta.snapshotId = `snap-${sandboxId}`;
    meta.portUrls = {
      "3000": `https://${sandboxId}-3000.fake.vercel.run`,
    };
  });
  const handle = (await h.controller.get({ sandboxId })) as FakeSandboxHandle;
  const routeProbeCount = { value: 0 };
  handle.responders.push((cmd, args) => {
    if (cmd !== "bash" || args?.[0] !== "-c") {
      return undefined;
    }
    const script = args[1] ?? "";
    if (
      script.includes("http://localhost:3000/") &&
      script.includes("openclaw-app")
    ) {
      return { exitCode: 0, output: async () => "ok" };
    }
    if (script.includes("/slack/events")) {
      routeProbeCount.value += 1;
      return { exitCode: 0, output: async () => "401" };
    }
    return undefined;
  });
  h.fakeFetch.onGet(
    `https://${sandboxId}-3000.fake.vercel.run`,
    () => gatewayReadyResponse(),
  );
  return { handle, routeProbeCount };
}

// ===========================================================================
// Signature / auth validation
// ===========================================================================

test("Slack webhook: missing signature headers returns 401", async () => {
  await withHarness(async () => {
    const route = getSlackWebhookRoute();
    const req = buildPostRequest(
      "/api/channels/slack/webhook",
      JSON.stringify({ type: "event_callback" }),
    );
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 401);
  });
});

test("Slack webhook: invalid signature returns 401", async () => {
  await withHarness(async (h) => {
    await configureSlack(h);
    const route = getSlackWebhookRoute();
    const req = buildSlackWebhook({
      signingSecret: "wrong-secret-not-matching",
    });
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 401);
  });
});

test("Slack webhook: no Slack config returns 404", async () => {
  await withHarness(async () => {
    const route = getSlackWebhookRoute();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const req = buildPostRequest(
      "/api/channels/slack/webhook",
      JSON.stringify({ type: "event_callback" }),
      {
        "x-slack-signature": "v0=fakesig",
        "x-slack-request-timestamp": timestamp,
      },
    );
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 404);
  });
});

// ===========================================================================
// URL verification challenge
// ===========================================================================

test("Slack webhook: url_verification returns challenge", async () => {
  await withHarness(async (h) => {
    await configureSlack(h);
    const route = getSlackWebhookRoute();
    const req = buildSlackUrlVerification(SLACK_SIGNING_SECRET, "my-challenge");
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 200);
    assert.equal(result.text, "my-challenge");
  });
});

// ===========================================================================
// Happy path
// ===========================================================================

test("Slack webhook: valid event enqueues job and returns 200", async () => {
  await withHarness(async (h) => {
    await configureSlack(h);
    const route = getSlackWebhookRoute();
    const startMock = mock.method(slackWebhookWorkflowRuntime, "start", async () => {});
    const req = buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET });
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

test("Slack webhook: bot reply skip bypasses a host ingress fence", async () => {
  await withHarness(async (h) => {
    await configureSlack(h);
    const now = Date.now();
    await getStore().setValue<HostSuspensionState>(hostSuspensionOperationKey(), {
      version: 1,
      operationId: "operation-fenced",
      requestId: "operation-fenced",
      sandboxId: "sbx-fenced",
      lifecycleAttemptId: null,
      intent: "stop",
      reason: "test-stop",
      phase: "prepared",
      ingressFenced: true,
      suspensionId: "suspension-fenced",
      leaseExpiresAtMs: now + 120_000,
      stopRequestDeadlineAtMs: null,
      monitorHeartbeatAtMs: now,
      startedAtMs: now,
      updatedAtMs: now,
      stoppedAtMs: null,
      resumedAtMs: null,
      lastError: null,
      lastErrorCode: null,
      lastErrorClass: null,
    });
    let deleteCalls = 0;
    h.fakeFetch.onPost(/slack\.com\/api\/chat\.delete$/, () => {
      deleteCalls += 1;
      return Response.json({ ok: true });
    });
    const payload = {
      type: "event_callback",
      event_id: "Ev_BOT_CLEANUP_FENCED",
      event: {
        type: "message",
        channel: "C-bot",
        thread_ts: "thread-1",
        ts: "bot-reply-ts",
        bot_id: "B-bot",
        text: "reply",
      },
    };

    const result = await callRoute(
      getSlackWebhookRoute().POST,
      buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET, payload }),
    );

    assert.equal(result.status, 200);
    assert.equal(deleteCalls, 0);
    assert.ok(
      getServerLogs().some(
        (entry) => entry.message === "channels.slack_webhook_bot_skip",
      ),
    );
  });
});

test("Slack webhook: forwards signature headers to the workflow handoff", async () => {
  await withHarness(async (h) => {
    await configureSlack(h);
    const route = getSlackWebhookRoute();
    const startMock = mock.method(slackWebhookWorkflowRuntime, "start", async () => {});
    const req = buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET });
    try {
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200);
      assert.equal(startMock.mock.callCount(), 1);
      // workflowApi.start(workflow, args) — we assert on args (the second arg).
      const call = startMock.mock.calls[0];
      const args = call.arguments?.[1] as unknown[] | undefined;
      assert.ok(Array.isArray(args), "start must be called with args array");
      assert.equal(args.length, 1, "drainChannelWorkflow expects a single v1 envelope");
      const envelope = args[0] as {
        version?: number;
        channel?: string;
        workflowHandoff?: { slackForwardHeaders?: Record<string, string> };
      };
      assert.equal(envelope.version, 1, "workflow envelope must be v1");
      assert.equal(envelope.channel, "slack");
      const handoff = envelope.workflowHandoff ?? null;
      assert.ok(handoff, "handoff must be present");
      const headers = handoff.slackForwardHeaders ?? null;
      assert.ok(headers, "slackForwardHeaders must be present on handoff");
      assert.ok(
        typeof headers["x-slack-signature"] === "string"
          && headers["x-slack-signature"].length > 0,
        "x-slack-signature must be captured",
      );
      assert.ok(
        typeof headers["x-slack-request-timestamp"] === "string"
          && headers["x-slack-request-timestamp"].length > 0,
        "x-slack-request-timestamp must be captured",
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

test("Slack webhook: duplicate event_id is deduplicated", async () => {
  await withHarness(async (h) => {
    await configureSlack(h);
    const route = getSlackWebhookRoute();
    const startMock = mock.method(slackWebhookWorkflowRuntime, "start", async () => {});
    const payload = {
      type: "event_callback",
      event_id: "Ev_DEDUP_TEST",
      event: {
        type: "message",
        text: "hello",
        channel: "C123",
        ts: "1234567890.000001",
        user: "U123",
      },
    };

    try {
      // First request
      const req1 = buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET, payload });
      const result1 = await callRoute(route.POST, req1);
      assert.equal(result1.status, 200);
      resetAfterCallbacks();

      // Second request with same event_id — should be deduped
      const req2 = buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET, payload });
      const result2 = await callRoute(route.POST, req2);
      assert.equal(result2.status, 200);
      const body2 = result2.json as { ok: boolean };
      assert.equal(body2.ok, true);
      assert.equal(startMock.mock.callCount(), 1);
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Slack webhook: stopped sandbox posts boot message and starts wake workflow with signed handoff", async () => {
  await withHarness(async (h) => {
    await configureSlack(h);
    _resetLogBuffer();
    await h.mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = null;
      meta.snapshotId = "snap-slack-wake";
    });

    h.fakeFetch.onPost(/slack\.com\/api\/chat\.postMessage$/, (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        channel?: string;
        thread_ts?: string;
        text?: string;
      };
      assert.equal(body.channel, "C-wake");
      assert.equal(body.thread_ts, "1710000000.000100");
      assert.match(body.text ?? "", /Waking the sandbox/);
      return Response.json({ ok: true, ts: "boot-wake-ts" });
    });

    const payload = {
      type: "event_callback",
      event_id: "Ev_STOPPED_WAKE",
      team_id: "T-wake",
      api_app_id: "A-wake",
      event: {
        type: "app_mention",
        text: "<@U-bot> are you awake?",
        channel: "C-wake",
        ts: "1710000000.000100",
        thread_ts: "1710000000.000100",
        user: "U-user",
      },
    };
    const req = buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET, payload });
    const route = getSlackWebhookRoute();
    const startMock = mock.method(slackWebhookWorkflowRuntime, "start", async () => {});

    try {
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { ok: true });
      assert.equal(startMock.mock.callCount(), 1);

      const call = startMock.mock.calls[0];
      const args = call.arguments?.[1] as unknown[] | undefined;
      assert.ok(Array.isArray(args));
      assert.equal(args.length, 1);
      const envelope = args[0] as {
        version?: number;
        channel?: string;
        payload?: unknown;
        bootMessageId?: string | null;
        workflowHandoff?: {
          slackForwardHeaders?: Record<string, string>;
          slackRawBody?: string;
        };
      };
      assert.equal(envelope.version, 1);
      assert.equal(envelope.channel, "slack");
      assert.deepEqual(envelope.payload, payload);
      assert.equal(envelope.bootMessageId, "boot-wake-ts");
      assert.equal(envelope.workflowHandoff?.slackRawBody, JSON.stringify(payload));
      assert.equal(
        envelope.workflowHandoff?.slackForwardHeaders?.["x-slack-signature"],
        req.headers.get("x-slack-signature"),
      );
      assert.equal(
        envelope.workflowHandoff?.slackForwardHeaders?.["x-slack-request-timestamp"],
        req.headers.get("x-slack-request-timestamp"),
      );

      const logs = getServerLogs().map((entry) => entry.message);
      assert.ok(logs.includes("channels.slack_fast_path_skipped"));
      assert.ok(logs.includes("channels.slack_boot_message_sent"));
      assert.ok(logs.includes("channels.slack_workflow_started"));
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Slack webhook: top-level stopped sandbox wake posts boot message in the user thread", async () => {
  await withHarness(async (h) => {
    await configureSlack(h);
    await h.mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = null;
      meta.snapshotId = "snap-slack-top-level-wake";
    });

    h.fakeFetch.onPost(/slack\.com\/api\/chat\.postMessage$/, (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        channel?: string;
        thread_ts?: string;
        text?: string;
      };
      assert.equal(body.channel, "C-top-level-wake");
      assert.equal(body.thread_ts, "1710000000.000333");
      assert.match(body.text ?? "", /Waking the sandbox/);
      return Response.json({ ok: true, ts: "boot-top-level-wake-ts" });
    });

    const payload = {
      type: "event_callback",
      event_id: "Ev_TOP_LEVEL_WAKE",
      team_id: "T-wake",
      api_app_id: "A-wake",
      event: {
        type: "app_mention",
        text: "<@U-bot> are you awake?",
        channel: "C-top-level-wake",
        ts: "1710000000.000333",
        user: "U-user",
      },
    };
    const req = buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET, payload });
    const route = getSlackWebhookRoute();
    const startMock = mock.method(slackWebhookWorkflowRuntime, "start", async () => {});

    try {
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { ok: true });
      assert.equal(startMock.mock.callCount(), 1);
      const call = startMock.mock.calls[0];
      const args = call.arguments?.[1] as unknown[] | undefined;
      assert.ok(Array.isArray(args));
      assert.equal(args.length, 1);
      const envelope = args[0] as {
        bootMessageId?: string | null;
      };
      assert.equal(envelope.bootMessageId, "boot-top-level-wake-ts");
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Slack webhook: app_mention + message for same user post collapses to one workflow", async () => {
  await withHarness(async (h) => {
    await configureSlack(h);
    const route = getSlackWebhookRoute();
    const startMock = mock.method(slackWebhookWorkflowRuntime, "start", async () => {});

    const channel = "C123";
    const ts = "1234567890.000001";
    const appMention = {
      type: "event_callback",
      event_id: "Ev_APP_MENTION",
      event: { type: "app_mention", text: "@bot hello", channel, ts, user: "U1" },
    };
    const message = {
      type: "event_callback",
      event_id: "Ev_MESSAGE",
      event: { type: "message", text: "@bot hello", channel, ts, user: "U1" },
    };

    try {
      const r1 = await callRoute(
        route.POST,
        buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET, payload: appMention }),
      );
      assert.equal(r1.status, 200);
      resetAfterCallbacks();
      const r2 = await callRoute(
        route.POST,
        buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET, payload: message }),
      );
      assert.equal(r2.status, 200);
      assert.equal(
        startMock.mock.callCount(),
        1,
        "second sibling event must not start a second workflow",
      );
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Slack webhook: generic fast-path 5xx closes unknown without replay", async () => {
  await withHarness(async (h) => {
    await configureSlack(h);
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-slack-non-ok";
      meta.snapshotId = "snap-slack-non-ok";
      meta.portUrls = {
        "3000": "https://sbx-slack-non-ok-3000.fake.vercel.run",
      };
    });

    h.fakeFetch.onGet("https://sbx-slack-non-ok-3000.fake.vercel.run", () => gatewayReadyResponse());
    h.fakeFetch.onPost(/slack\/events$/, () =>
      new Response("bad gateway", { status: 502 }),
    );

    const route = getSlackWebhookRoute();
    const startMock = mock.method(slackWebhookWorkflowRuntime, "start", async () => {});

    try {
      const req = buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET });
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { ok: true });
      assert.equal(
        startMock.mock.callCount(),
        0,
        "generic 5xx cannot prove native rejection",
      );
      const meta = await h.getMeta();
      assert.equal(
        meta.channelDiagnostics?.slack?.lastDeliveryState?.state,
        "visibility-unknown",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Slack webhook: unreadable 5xx response closes unknown without replay", async () => {
  await withHarness(async (h) => {
    await configureSlack(h);
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-slack-unreadable-5xx";
      meta.portUrls = {
        "3000": "https://sbx-slack-unreadable-5xx-3000.fake.vercel.run",
      };
    });
    h.fakeFetch.onGet(
      "https://sbx-slack-unreadable-5xx-3000.fake.vercel.run",
      () => gatewayReadyResponse(),
    );
    h.fakeFetch.onPost(/slack\/events$/, () => {
      const response = new Response(null, { status: 502 });
      Object.defineProperty(response, "text", {
        value: async () => {
          throw new Error("body unavailable");
        },
      });
      return response;
    });

    const route = getSlackWebhookRoute();
    const startMock = mock.method(
      slackWebhookWorkflowRuntime,
      "start",
      async () => {},
    );
    try {
      const result = await callRoute(
        route.POST,
        buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET }),
      );

      assert.equal(result.status, 200);
      assert.equal(startMock.mock.callCount(), 0);
      const meta = await h.getMeta();
      assert.equal(
        meta.channelDiagnostics?.slack?.lastDeliveryState?.state,
        "visibility-unknown",
      );
    } finally {
      startMock.mock.restore();
      resetAfterCallbacks();
    }
  });
});

test("Slack webhook: unverified gateway_unavailable 503 closes unknown", async () => {
  await withHarness(async (h) => {
    await configureSlack(h);
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-slack-unverified-gateway-unavailable";
      meta.portUrls = {
        "3000": "https://sbx-slack-unverified-gateway-unavailable-3000.fake.vercel.run",
      };
    });
    h.fakeFetch.onGet(
      "https://sbx-slack-unverified-gateway-unavailable-3000.fake.vercel.run",
      () => gatewayReadyResponse(),
    );
    h.fakeFetch.onPost(/slack\/events$/, () =>
      Response.json(
        { error: { code: "gateway_unavailable" } },
        { status: 503 },
      ),
    );

    const route = getSlackWebhookRoute();
    const startMock = mock.method(
      slackWebhookWorkflowRuntime,
      "start",
      async () => {},
    );
    try {
      _resetLogBuffer();
      const result = await callRoute(
        route.POST,
        buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET }),
      );

      assert.equal(result.status, 200);
      assert.equal(startMock.mock.callCount(), 0);
      const meta = await h.getMeta();
      assert.equal(
        meta.channelDiagnostics?.slack?.lastDeliveryState?.state,
        "visibility-unknown",
      );
      assert.equal(
        getServerLogs().some(
          (entry) =>
            entry.message ===
            "channels.slack_fast_path_acceptance_unknown",
        ),
        true,
      );
    } finally {
      startMock.mock.restore();
      resetAfterCallbacks();
    }
  });
});

test("Slack webhook: admitted gateway closure revalidates before workflow", async () => {
  await withHarness(async (h) => {
    await configureSlack(h, { admitGatewaySuspend: true });
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-slack-admitted-gateway-unavailable";
      meta.portUrls = {
        "3000":
          "https://sbx-slack-admitted-gateway-unavailable-3000.fake.vercel.run",
      };
    });
    h.fakeFetch.onGet(
      "https://sbx-slack-admitted-gateway-unavailable-3000.fake.vercel.run",
      () => gatewayReadyResponse(),
    );
    h.fakeFetch.onPost(/slack\/events$/, () =>
      Response.json(
        { error: { code: "gateway_unavailable" } },
        { status: 503 },
      ),
    );

    const route = getSlackWebhookRoute();
    const startMock = mock.method(
      slackWebhookWorkflowRuntime,
      "start",
      async () => {},
    );
    try {
      const result = await callRoute(
        route.POST,
        buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET }),
      );

      assert.equal(result.status, 200);
      assert.equal(startMock.mock.callCount(), 1);
      const workflowArgs = startMock.mock.calls[0]?.arguments?.[1] as
        | unknown[]
        | undefined;
      const envelope = workflowArgs?.[0] as {
        workflowHandoff?: {
          revalidateSandboxBeforeForward?: boolean;
        };
      };
      assert.equal(
        envelope.workflowHandoff?.revalidateSandboxBeforeForward,
        true,
      );
      const meta = await h.getMeta();
      assert.equal(
        meta.channelDiagnostics?.slack?.lastForward?.classification,
        "gateway-unavailable",
      );
    } finally {
      startMock.mock.restore();
      resetAfterCallbacks();
    }
  });
});

test("Slack webhook: fast path 404 repairs config sync and retries native handler", async () => {
  await withHarness(async (h) => {
    _resetLogBuffer();
    const { handle, routeProbeCount } = await prepareSlackRouteRepair(
      h,
      "sbx-slack-route-repair",
    );
    let forwardCount = 0;
    h.fakeFetch.onPost(/slack\/events$/, () => {
      forwardCount += 1;
      return forwardCount === 1
        ? new Response("missing route", { status: 404 })
        : new Response("ok", { status: 200 });
    });

    const route = getSlackWebhookRoute();
    const startMock = mock.method(slackWebhookWorkflowRuntime, "start", async () => {});

    try {
      const req = buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET });
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { ok: true });
      assert.equal(forwardCount, 2, "404 should be retried after config sync repair");
      assert.equal(routeProbeCount.value, 1, "repair should prove /slack/events is mounted");
      assert.equal(startMock.mock.callCount(), 0, "successful repair must not start workflow fallback");
      assert.ok(
        handle.commands.some((c) => c.cmd === "bash" && c.args?.[0]?.includes("restart-gateway")),
        "repair should restart the gateway before retrying Slack delivery",
      );
      const logs = getServerLogs().map((entry) => entry.message);
      assert.ok(logs.includes("channels.slack_fast_path_route_missing_repair"));
      assert.ok(logs.includes("channels.slack_fast_path_ok"));
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Slack webhook: route-repair rejection is classified before replay", async () => {
  await withHarness(async (h) => {
    _resetLogBuffer();
    await prepareSlackRouteRepair(h, "sbx-slack-repair-rejected");
    let forwardCount = 0;
    h.fakeFetch.onPost(/slack\/events$/, () => {
      forwardCount += 1;
      return forwardCount === 1
        ? new Response("missing route", { status: 404 })
        : Response.json(
            { error: { code: "gateway_unavailable" } },
            { status: 503 },
          );
    });

    const route = getSlackWebhookRoute();
    const startMock = mock.method(
      slackWebhookWorkflowRuntime,
      "start",
      async () => {},
    );
    try {
      const result = await callRoute(
        route.POST,
        buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET }),
      );

      assert.equal(result.status, 200);
      assert.equal(forwardCount, 2);
      assert.equal(startMock.mock.callCount(), 0);
      const meta = await h.getMeta();
      assert.equal(
        meta.channelDiagnostics?.slack?.lastDeliveryState?.state,
        "visibility-unknown",
      );
      assert.equal(
        meta.channelDiagnostics?.slack?.lastForward?.attempts,
        2,
      );
    } finally {
      startMock.mock.restore();
      resetAfterCallbacks();
    }
  });
});

test("Slack webhook: route-repair timeout closes unknown without replay", async () => {
  await withHarness(async (h) => {
    _resetLogBuffer();
    await prepareSlackRouteRepair(h, "sbx-slack-repair-timeout");
    let forwardCount = 0;
    h.fakeFetch.onPost(/slack\/events$/, () => {
      forwardCount += 1;
      if (forwardCount === 1) {
        return new Response("missing route", { status: 404 });
      }
      throw Object.assign(new Error("repair response timed out"), {
        name: "TimeoutError",
      });
    });

    const route = getSlackWebhookRoute();
    const startMock = mock.method(
      slackWebhookWorkflowRuntime,
      "start",
      async () => {},
    );
    try {
      const result = await callRoute(
        route.POST,
        buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET }),
      );

      assert.equal(result.status, 200);
      assert.equal(forwardCount, 2);
      assert.equal(startMock.mock.callCount(), 0);
      const meta = await h.getMeta();
      assert.equal(
        meta.channelDiagnostics?.slack?.lastDeliveryState?.state,
        "visibility-unknown",
      );
      assert.equal(
        meta.channelDiagnostics?.slack?.lastForward?.attempts,
        2,
      );
    } finally {
      startMock.mock.restore();
      resetAfterCallbacks();
    }
  });
});

test("Slack webhook: fast path refreshes AI Gateway token before native forward", async () => {
  await withHarness(async (h) => {
    await configureSlack(h);
    _resetLogBuffer();
    _setAiGatewayTokenOverrideForTesting("fresh-slack-fast-path-token");
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-slack-token-refresh";
      meta.snapshotId = "snap-slack-token-refresh";
      meta.portUrls = {
        "3000": "https://sbx-slack-token-refresh-3000.fake.vercel.run",
      };
      meta.lastTokenRefreshAt = Date.now() - 60 * 60 * 1000;
      meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) - 60;
      meta.lastTokenSource = "oidc";
    });
    await h.controller.get({ sandboxId: "sbx-slack-token-refresh" });

    h.fakeFetch.onGet("https://sbx-slack-token-refresh-3000.fake.vercel.run", () => gatewayReadyResponse());
    let networkPolicyCountAtForward = -1;
    h.fakeFetch.onPost(/slack\/events$/, () => {
      networkPolicyCountAtForward =
        h.controller.getHandle("sbx-slack-token-refresh")?.networkPolicies.length ?? -1;
      return new Response("ok", { status: 200 });
    });

    const route = getSlackWebhookRoute();
    const startMock = mock.method(slackWebhookWorkflowRuntime, "start", async () => {});

    try {
      const result = await callRoute(
        route.POST,
        buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET }),
      );
      assert.equal(result.status, 200);
      assert.equal(startMock.mock.callCount(), 0);
      assert.equal(
        networkPolicyCountAtForward,
        1,
        "AI Gateway network policy must be refreshed before native Slack forward",
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

test("Slack webhook: running fast path does not post wrapper processing placeholder", async () => {
  await withHarness(async (h) => {
    await configureSlack(h);
    _resetLogBuffer();
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-slack-fast-path-no-placeholder";
      meta.snapshotId = "snap-slack-fast-path-no-placeholder";
      meta.portUrls = {
        "3000": "https://sbx-slack-fast-path-no-placeholder-3000.fake.vercel.run",
      };
    });

    h.fakeFetch.onGet("https://sbx-slack-fast-path-no-placeholder-3000.fake.vercel.run", () => gatewayReadyResponse());

    let wrapperPostMessageCalls = 0;
    h.fakeFetch.onPost(/slack\.com\/api\/chat\.postMessage$/, () => {
      wrapperPostMessageCalls += 1;
      return Response.json({ ok: true, ts: "placeholder-fast-ts" });
    });
    let forwarded = false;
    h.fakeFetch.onPost(/slack\/events$/, () => {
      forwarded = true;
      return new Response("ok", { status: 200 });
    });

    const payload = {
      type: "event_callback",
      event_id: "Ev_FAST_NO_PLACEHOLDER",
      event: {
        type: "message",
        text: "hello slow bot",
        channel: "C-fast-no-placeholder",
        ts: "1710000000.000200",
        user: "U-user",
      },
    };
    const route = getSlackWebhookRoute();
    const startMock = mock.method(slackWebhookWorkflowRuntime, "start", async () => {});

    try {
      const result = await callRoute(
        route.POST,
        buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET, payload }),
      );
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { ok: true });
      assert.equal(startMock.mock.callCount(), 0);
      assert.equal(forwarded, true);
      assert.equal(wrapperPostMessageCalls, 0);

      assert.equal(
        getServerLogs().some(
          (entry) => entry.message === "channels.slack_fast_path_processing_placeholder_sent",
        ),
        false,
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Slack webhook: fast path token refresh failure logs and still forwards", async () => {
  await withHarness(async (h) => {
    await configureSlack(h);
    _resetLogBuffer();
    _setAiGatewayTokenOverrideForTesting("fresh-slack-fast-path-token");
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-slack-token-refresh-fails";
      meta.snapshotId = "snap-slack-token-refresh-fails";
      meta.portUrls = {
        "3000": "https://sbx-slack-token-refresh-fails-3000.fake.vercel.run",
      };
      meta.lastTokenRefreshAt = Date.now() - 60 * 60 * 1000;
      meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) - 60;
      meta.lastTokenSource = "oidc";
    });
    const handle = await h.controller.get({ sandboxId: "sbx-slack-token-refresh-fails" });
    (handle as { networkPolicyHandler?: () => Promise<never> }).networkPolicyHandler = async () => {
      throw new Error("network policy unavailable");
    };

    h.fakeFetch.onGet("https://sbx-slack-token-refresh-fails-3000.fake.vercel.run", () => gatewayReadyResponse());
    let forwarded = false;
    h.fakeFetch.onPost(/slack\/events$/, () => {
      forwarded = true;
      return new Response("ok", { status: 200 });
    });

    const route = getSlackWebhookRoute();
    const startMock = mock.method(slackWebhookWorkflowRuntime, "start", async () => {});

    try {
      const result = await callRoute(
        route.POST,
        buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET }),
      );
      assert.equal(result.status, 200);
      assert.equal(startMock.mock.callCount(), 0);
      assert.equal(forwarded, true, "fast path should continue after refresh failure");
      assert.ok(
        getServerLogs().some((entry) => entry.message === "channels.fast_path_token_refresh"),
        "refresh failure should still produce a structured token outcome log",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("Slack webhook: releases dedup lock and returns 500 when workflow start fails", async () => {
  await withHarness(async (h) => {
    await configureSlack(h);
    await h.mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = null;
    });
    h.fakeFetch.onPost(/slack\.com\/api\/chat\.postMessage$/, () =>
      Response.json({ ok: true, ts: "boot-start-failed" }),
    );
    h.fakeFetch.onPost(/slack\.com\/api\/chat\.delete$/, () =>
      Response.json({ ok: false, error: "not_authed" }),
    );
    const route = getSlackWebhookRoute();
    const payload = {
      type: "event_callback",
      event_id: "Ev_START_FAIL",
      event: {
        type: "message",
        text: "hello",
        channel: "C123",
        ts: "1234567890.000001",
        user: "U123",
      },
    };
    const dedupKey = channelDedupKey("slack", payload.event_id);
    const userMessageDedupKey = channelUserMessageDedupKey(
      "slack",
      payload.event.channel,
      payload.event.ts,
    );
    const startMock = mock.method(slackWebhookWorkflowRuntime, "start", async () => {
      throw new Error("workflow engine unavailable");
    });

    try {
      const req = buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET, payload });
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

      const reacquiredUserMessageToken = await getStore().acquireLock(
        userMessageDedupKey,
        60,
      );
      assert.ok(
        reacquiredUserMessageToken,
        "user-message dedup lock should be released when workflow start fails",
      );
      await getStore().releaseLock(userMessageDedupKey, reacquiredUserMessageToken!);

      assert.equal(startMock.mock.callCount(), 1);
      const cleanupFailure = getServerLogs().find(
        (entry) =>
          entry.message ===
          "channels.slack_boot_message_cleanup_after_handoff_failed",
      );
      assert.ok(cleanupFailure);
      const handoffFailure = getServerLogs().find(
        (entry) => entry.message === "channels.slack_workflow_start_failed",
      );
      assert.equal(handoffFailure?.data?.bootMessageCleanupAttempted, true);
      assert.equal(handoffFailure?.data?.bootMessageCleanupSucceeded, false);
    } finally {
      startMock.mock.restore();
    }
  });
});
