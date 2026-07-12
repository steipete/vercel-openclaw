import assert from "node:assert/strict";
import test, { mock } from "node:test";

import type { VerifiedBundleIdentity } from "@/shared/bundle-identity";
import type { SingleMeta, RestorePhaseMetrics } from "@/shared/types";
import { getServerLogs, _resetLogBuffer } from "@/server/log";
import {
  _resetStoreForTesting,
  getInitializedMeta,
  getStore,
} from "@/server/store/store";
import {
  channelBootMessageKey,
  channelConfigLockKey,
} from "@/server/store/keyspace";
import {
  setSlackChannelConfig,
  setTelegramChannelConfig,
} from "@/server/channels/state";
import {
  getChannelDlqRecord,
  recordChannelDlqFailure,
} from "@/server/channels/dlq";
import {
  processChannelStep,
  forwardToNativeHandlerWithRetry,
  buildExistingBootHandle,
  toWorkflowProcessingError,
  type DrainChannelWorkflowDependencies,
  type ChannelWorkflowHandoff,
  type RetryingForwardResult,
  type TelegramProbeResult,
} from "@/server/workflows/channels/drain-channel-step";
import { drainChannelWorkflow } from "@/server/workflows/channels/drain-channel-workflow";

class TestRetryableError extends Error {
  retryAfter?: string | number | Date;

  constructor(
    message: string,
    options?: { retryAfter?: string | number | Date },
  ) {
    super(message);
    this.name = "RetryableError";
    this.retryAfter = options?.retryAfter;
  }

  static is(err: unknown): err is TestRetryableError {
    return err instanceof TestRetryableError;
  }
}

class TestFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalError";
  }

  static is(err: unknown): err is TestFatalError {
    return err instanceof TestFatalError;
  }
}

function asMeta(meta: Partial<SingleMeta>): SingleMeta {
  return meta as SingleMeta;
}

function createFallbackTelegramConfig() {
  return {
    botToken: "123456:handoff-token",
    webhookSecret: "handoff-secret",
    webhookUrl: "https://example.test/api/channels/telegram/webhook",
    botUsername: "handoff_bot",
    configuredAt: 1_777_000_000_000,
  };
}

const VERIFIED_DELIVERY_BUNDLE_IDENTITY: VerifiedBundleIdentity = {
  packageSpec: "openclaw@2026.7.11",
  version: "2026.7.11",
  forkSha: "1".repeat(40),
  upstreamSha: "2".repeat(40),
  canonicalSha256: "3".repeat(64),
  capabilities: [
    "gateway-suspend-v1",
    "telegram-durable-ack-v1",
  ],
  verified: true,
};

function createWorkflowDependencies(
  overrides: Partial<DrainChannelWorkflowDependencies> = {},
): DrainChannelWorkflowDependencies {
  return {
    isRetryable: () => false,
    createSlackAdapter: () => ({}) as never,
    createTelegramAdapter: () => ({}) as never,
    createDiscordAdapter: () => ({}) as never,
    runWithBootMessages: async () => ({
      meta: asMeta({ status: "running", sandboxId: "sbx-stale" }),
      bootMessageSent: false,
      admissionReady: true,
    }),
    ensureSandboxReady: async () =>
      asMeta({
        status: "running",
        sandboxId: "sbx-restored",
        channels: { telegram: null, slack: null, discord: null, whatsapp: null },
      }),
    syncGatewayConfigToSandbox: async () => ({
      outcome: "applied",
      reason: "config_written_and_restarted",
      liveConfigFresh: true,
      operatorMessage: null,
    }),
    getSandboxDomain: async () => "https://sandbox.example.test",
    forwardToNativeHandler: async () => ({
      ok: true,
      status: 200,
      durationMs: 0,
      bodyLength: 0,
      bodyHead: "",
      headers: null,
    }),
    forwardTelegramToNativeHandlerLocally: async () => ({
      ok: true,
      status: 200,
      durationMs: 0,
      bodyLength: 0,
      bodyHead: "",
      headers: null,
      error: null,
    }),
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => ({
      ok: true,
      acceptance: "accepted",
      status: 200,
      attempts: 1,
      totalMs: 50,
      transport: "public",
      retries: [],
    }),
    waitForTelegramNativeHandler: async (): Promise<TelegramProbeResult> => ({
      ready: true,
      attempts: 1,
      waitMs: 0,
      lastStatus: 401,
      publicUrl: "https://sandbox.example.test",
      timeline: [{ attempt: 1, elapsedMs: 0, status: 401 }],
    }),
    probeTelegramNativeHandlerLocally: async () => ({
      status: 401,
      ready: true,
      error: null,
    }),
    buildExistingBootHandle: async () => undefined,
    hydrateVerifiedBundleIdentity: async () => null,
    RetryableError: TestRetryableError as never,
    FatalError: TestFatalError as never,
    // Workflow DevKit metadata helpers. In a normal step these would
    // come from AsyncLocalStorage; here we stub sensible defaults.
    getStepMetadata: (() => ({
      stepName: "processChannelStep",
      stepId: "test-step-id",
      stepStartedAt: new Date(),
      attempt: 1,
    })) as never,
    getWorkflowMetadata: (() => ({
      workflowId: "test-workflow-id",
      workflowRunId: "test-run-id",
      workflowStartedAt: new Date(),
    })) as never,
    ...overrides,
  };
}

const WORKFLOW_TEST_ENV_KEYS = [
  "NODE_ENV",
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "REDIS_URL",
  "KV_URL",
  "SESSION_SECRET",
] as const;

let workflowTestEnvOriginals: Record<string, string | undefined> = {};

test.beforeEach(async () => {
  workflowTestEnvOriginals = {};
  for (const key of WORKFLOW_TEST_ENV_KEYS) {
    workflowTestEnvOriginals[key] = process.env[key];
  }
  (process.env as Record<string, string | undefined>)["NODE_ENV"] = "test";
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.REDIS_URL;
  delete process.env.KV_URL;
  process.env.SESSION_SECRET = "test-channel-workflow-session-secret";
  _resetStoreForTesting();
  _resetLogBuffer();
});

test.afterEach(async () => {
  for (const key of WORKFLOW_TEST_ENV_KEYS) {
    const value = workflowTestEnvOriginals[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      (process.env as Record<string, string | undefined>)[key] = value;
    }
  }
});

test("processChannelStep skips ensureSandboxReady when boot returns running", async () => {
  let ensureCalls = 0;
  let forwardedSandboxId: string | null = null;

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({ status: "running", sandboxId: "sbx-booted" }),
      bootMessageSent: false,
      admissionReady: true,
    }),
    ensureSandboxReady: async () => {
      ensureCalls += 1;
      return asMeta({
        status: "running",
        sandboxId: "sbx-restored",
        channels: { telegram: null, slack: null, discord: null, whatsapp: null },
      });
    },
    forwardToNativeHandlerWithRetry: async (_channel: unknown, _payload: unknown, meta: SingleMeta): Promise<RetryingForwardResult> => {
      forwardedSandboxId = meta.sandboxId ?? null;
      return { ok: true, status: 200, attempts: 1, totalMs: 50, transport: "public", retries: [] };
    },
  });

  await processChannelStep("telegram", { update_id: 1 }, "test", "req-1", null, { dependencies });

  // When boot returns running, ensureSandboxReady is skipped to avoid
  // the redundant public gateway probe that times out in workflow steps.
  assert.equal(ensureCalls, 0);
  assert.equal(forwardedSandboxId, "sbx-booted");
});

test("drainChannelWorkflow settles legacy Telegram work without a config generation", async () => {
  await drainChannelWorkflow({
    version: 1,
    channel: "telegram",
    payload: { update_id: 99 },
    origin: "https://example.test",
    requestId: "req-missing-generation",
    workflowHandoff: null,
  });

  const staleLog = getServerLogs().find(
    (entry) => entry.message === "channels.telegram_workflow_handoff_stale",
  );
  assert.equal(staleLog?.data?.reason, "missing");
  assert.equal(staleLog?.data?.phase, "step-start");
});

test("processChannelStep revalidates lifecycle after fast-path admission closes", async () => {
  let ensureCalls = 0;
  let forwardedSandboxId: string | null = null;
  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({ status: "running", sandboxId: "sbx-quiescing" }),
      bootMessageSent: true,
      admissionReady: true,
    }),
    ensureSandboxReady: async () => {
      ensureCalls += 1;
      return asMeta({
        status: "running",
        sandboxId: "sbx-resumed",
        channels: {
          telegram: null,
          slack: null,
          discord: null,
          whatsapp: null,
        },
      });
    },
    forwardToNativeHandlerWithRetry: async (
      _channel: unknown,
      _payload: unknown,
      meta: SingleMeta,
    ): Promise<RetryingForwardResult> => {
      forwardedSandboxId = meta.sandboxId ?? null;
      return {
        ok: true,
        acceptance: "accepted",
        status: 200,
        attempts: 1,
        totalMs: 50,
        transport: "public",
        retries: [],
      };
    },
  });

  await processChannelStep(
    "telegram",
    { update_id: 2 },
    "test",
    "req-admission-closed",
    null,
    {
      dependencies,
      workflowHandoff: { revalidateSandboxBeforeForward: true },
    },
  );

  assert.equal(ensureCalls, 1);
  assert.equal(forwardedSandboxId, "sbx-resumed");
});

test("processChannelStep rechecks admission when raw metadata is running", async () => {
  let ensureCalls = 0;
  let forwardedSandboxId: string | null = null;

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({ status: "running", sandboxId: "sbx-fenced" }),
      bootMessageSent: false,
      admissionReady: false,
    }),
    ensureSandboxReady: async () => {
      ensureCalls += 1;
      return asMeta({
        status: "running",
        sandboxId: "sbx-admitted",
        channels: { telegram: null, slack: null, discord: null, whatsapp: null },
      });
    },
    forwardToNativeHandlerWithRetry: async (
      _channel: unknown,
      _payload: unknown,
      meta: SingleMeta,
    ): Promise<RetryingForwardResult> => {
      forwardedSandboxId = meta.sandboxId ?? null;
      return {
        ok: true,
        acceptance: "accepted",
        status: 200,
        attempts: 1,
        totalMs: 50,
        transport: "public",
        retries: [],
      };
    },
  });

  await processChannelStep("slack", {}, "test", "req-fenced", null, {
    dependencies,
  });

  assert.equal(ensureCalls, 1);
  assert.equal(forwardedSandboxId, "sbx-admitted");
});

test("processChannelStep re-enters lifecycle when workflow admission closes", async () => {
  let ensureCalls = 0;
  let ensureReason: string | null = null;
  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-closing",
        bundleIdentity: VERIFIED_DELIVERY_BUNDLE_IDENTITY,
      }),
      bootMessageSent: false,
      admissionReady: true,
    }),
    hydrateVerifiedBundleIdentity: async () =>
      VERIFIED_DELIVERY_BUNDLE_IDENTITY,
    ensureSandboxReady: async (options) => {
      ensureCalls += 1;
      ensureReason = options.reason;
      return asMeta({ status: "running", sandboxId: "sbx-resumed" });
    },
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => ({
      ok: false,
      acceptance: "rejected",
      status: 503,
      attempts: 1,
      totalMs: 5,
      transport: "public",
      retries: [{ attempt: 1, reason: "gateway-unavailable", status: 503 }],
      attemptsDetail: [
        {
          attempt: 1,
          startedAtMs: Date.now(),
          elapsedMs: 5,
          durationMs: 5,
          status: 503,
          ok: false,
          bodyLength: 19,
          bodyHead: "gateway unavailable",
          headers: null,
          transport: "public",
          classification: "gateway-unavailable",
          acceptance: "rejected",
          error: null,
          detail: null,
          processSnapshot: null,
          logTail: null,
        },
      ],
    }),
  });

  await assert.rejects(
    processChannelStep(
      "slack",
      { event_id: "Ev-closing", event: {} },
      "test",
      "req-workflow-admission-closed",
      null,
      { dependencies },
    ),
    (error: unknown) => {
      assert.ok(error instanceof TestRetryableError);
      return true;
    },
  );

  assert.equal(ensureCalls, 1);
  assert.equal(ensureReason, "channel:slack:gateway-admission-closed");
});

test("processChannelStep clears Telegram boot message after durable acceptance", async () => {
  let updateCalls = 0;
  let clearCalls = 0;

  const dependencies = createWorkflowDependencies({
    buildExistingBootHandle: async () => ({
      async update(text: string) {
        updateCalls += 1;
        void text;
      },
      async clear() {
        clearCalls += 1;
      },
    }),
    runWithBootMessages: async () => ({
      meta: asMeta({ status: "running", sandboxId: "sbx-telegram-accepted" }),
      bootMessageSent: true,
      admissionReady: true,
    }),
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => ({
      ok: true,
      acceptance: "accepted",
      status: 200,
      attempts: 1,
      totalMs: 50,
      transport: "local",
      retries: [],
    }),
  });

  await processChannelStep("telegram", { update_id: 1 }, "test", "req-clear", 17, {
    dependencies,
  });

  assert.equal(updateCalls, 0);
  assert.equal(clearCalls, 1);

  const logs = getServerLogs();
  const cleanupLog = logs.find(
    (entry) => entry.message === "channels.telegram_boot_message_cleared_after_accept",
  );
  assert.ok(cleanupLog, "placeholder cleanup should be logged");
  assert.equal(cleanupLog?.data?.deliveryId, "telegram:1");
  assert.equal(cleanupLog?.data?.requestId, "req-clear");
  assert.equal(cleanupLog?.data?.bootMessageId, 17);
  assert.equal(cleanupLog?.data?.forwardStatus, 200);
  assert.equal(cleanupLog?.data?.forwardAttempts, 1);
  assert.equal(cleanupLog?.data?.forwardTransport, "local");
  assert.equal(cleanupLog?.data?.clearOnAccept, true);
  assert.equal(cleanupLog?.data?.placeholderAction, "cleared");
});

test("processChannelStep closes unknown Telegram acceptance without redrive", async () => {
  const updates: string[] = [];
  let clearCalls = 0;
  const dependencies = createWorkflowDependencies({
    buildExistingBootHandle: async () => ({
      async update(text: string) {
        updates.push(text);
      },
      async clear() {
        clearCalls += 1;
      },
    }),
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-telegram-unknown",
        portUrls: { "8787": "https://telegram.example.test" },
      }),
      bootMessageSent: true,
      admissionReady: true,
    }),
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => ({
      ok: false,
      acceptance: "unknown",
      status: 502,
      attempts: 1,
      totalMs: 50,
      transport: "public",
      retries: [],
      attemptsDetail: [
        {
          attempt: 1,
          startedAtMs: Date.now(),
          elapsedMs: 50,
          durationMs: 50,
          status: 502,
          ok: false,
          bodyLength: 0,
          bodyHead: "",
          headers: null,
          transport: "public",
          classification: "acceptance-unknown",
          acceptance: "unknown",
        },
      ],
    }),
  });

  await recordChannelDlqFailure({
    channel: "telegram",
    deliveryId: "telegram:404",
    phase: "workflow-step-failed",
    terminal: true,
    retryable: false,
    deliveryOutcome: "not-accepted",
    requestId: "req-previous-failure",
    receivedAtMs: null,
    error: new Error("previous definite rejection"),
  });

  await processChannelStep(
    "telegram",
    { update_id: 404, message: { text: "uncertain" } },
    "test",
    "req-unknown",
    17,
    { dependencies },
  );

  assert.equal(clearCalls, 0);
  assert.deepEqual(updates, [
    "🦞 Delivery could not be confirmed. Check for a reply before retrying.",
  ]);
  const meta = await getInitializedMeta();
  assert.equal(
    meta.channelDiagnostics?.telegram?.lastDeliveryState?.state,
    "visibility-unknown",
  );
  assert.equal(
    meta.channelDiagnostics?.telegram?.lastDeliveryState?.terminal,
    true,
  );
  const blockedFailure = await getChannelDlqRecord(
    "telegram",
    "telegram:404",
  );
  assert.equal(blockedFailure?.errorMessage, "native_delivery_outcome_unknown");
  assert.equal(blockedFailure?.deliveryOutcome, "unknown");
  assert.equal(blockedFailure?.recoveryState, "blocked");
});

test("processChannelStep falls back to ensureSandboxReady when boot returns non-running", async () => {
  let ensureCalls = 0;
  let forwardedSandboxId: string | null = null;

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({ status: "booting", sandboxId: "sbx-stale" }),
      bootMessageSent: true,
      admissionReady: false,
    }),
    ensureSandboxReady: async () => {
      ensureCalls += 1;
      return asMeta({
        status: "running",
        sandboxId: "sbx-restored",
        channels: { telegram: null, slack: null, discord: null, whatsapp: null },
      });
    },
    forwardToNativeHandlerWithRetry: async (_channel: unknown, _payload: unknown, meta: SingleMeta): Promise<RetryingForwardResult> => {
      forwardedSandboxId = meta.sandboxId ?? null;
      return { ok: true, status: 200, attempts: 1, totalMs: 50, transport: "public", retries: [] };
    },
  });

  await processChannelStep("telegram", { update_id: 1 }, "test", "req-1", null, { dependencies });

  assert.equal(ensureCalls, 1);
  assert.equal(forwardedSandboxId, "sbx-restored");
});

test("processChannelStep settles a queued Telegram handoff after config deletion", async () => {
  const fallbackTelegramConfig = createFallbackTelegramConfig();
  let bootClearCalls = 0;
  let bootCalls = 0;
  let forwardCalls = 0;

  const dependencies = createWorkflowDependencies({
    buildExistingBootHandle: async () => ({
      async update() {},
      async clear() {
        bootClearCalls += 1;
      },
    }),
    runWithBootMessages: async () => {
      bootCalls += 1;
      throw new Error("must not wake after channel deletion");
    },
    forwardToNativeHandlerWithRetry: async () => {
      forwardCalls += 1;
      throw new Error("must not forward after channel deletion");
    },
  });

  await processChannelStep(
    "telegram",
    { update_id: 1, message: { chat: { id: 123 } } },
    "test",
    "req-handoff",
    17,
    {
      dependencies,
      workflowHandoff: {
        fallbackTelegramConfig,
        telegramConfigGeneration: fallbackTelegramConfig.configuredAt,
      } satisfies ChannelWorkflowHandoff,
    },
  );

  const meta = await getInitializedMeta();
  assert.equal(meta.channels.telegram, null);
  assert.equal(bootClearCalls, 1);
  assert.equal(bootCalls, 0);
  assert.equal(forwardCalls, 0);
  assert.equal(
    getServerLogs().find(
      (entry) => entry.message === "channels.telegram_workflow_handoff_stale",
    )?.data?.reason,
    "deleted",
  );
  const failure = await getChannelDlqRecord(
    "telegram",
    `telegram:legacy:${fallbackTelegramConfig.botUsername}:${fallbackTelegramConfig.configuredAt}:1`,
  );
  assert.equal(failure?.terminal, true);
  assert.equal(failure?.deliveryOutcome, "not-accepted");
  assert.equal(failure?.errorMessage, "telegram-config-deleted");
});

test("processChannelStep settles a queued Telegram handoff after config rotation", async () => {
  const existingConfig = {
    ...createFallbackTelegramConfig(),
    webhookSecret: "existing-secret",
    botUsername: "existing_bot",
    configuredAt: createFallbackTelegramConfig().configuredAt + 1,
  };
  const fallbackTelegramConfig = createFallbackTelegramConfig();
  let bootCalls = 0;
  let forwardCalls = 0;

  await setTelegramChannelConfig(existingConfig);

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => {
      bootCalls += 1;
      throw new Error("must not wake after channel rotation");
    },
    forwardToNativeHandlerWithRetry: async () => {
      forwardCalls += 1;
      throw new Error("must not forward after channel rotation");
    },
  });

  await processChannelStep(
    "telegram",
    { update_id: 2, message: { chat: { id: 456 } } },
    "test",
    "req-existing",
    null,
    {
      dependencies,
      workflowHandoff: {
        fallbackTelegramConfig,
        telegramConfigGeneration: fallbackTelegramConfig.configuredAt,
      } satisfies ChannelWorkflowHandoff,
    },
  );

  const meta = await getInitializedMeta();
  assert.equal(meta.channels.telegram?.webhookSecret, existingConfig.webhookSecret);
  assert.equal(bootCalls, 0);
  assert.equal(forwardCalls, 0);
  assert.equal(
    getServerLogs().find(
      (entry) => entry.message === "channels.telegram_workflow_handoff_stale",
    )?.data?.reason,
    "rotated",
  );
  const failure = await getChannelDlqRecord(
    "telegram",
    `telegram:legacy:${fallbackTelegramConfig.botUsername}:${fallbackTelegramConfig.configuredAt}:2`,
  );
  assert.equal(failure?.terminal, true);
  assert.equal(failure?.deliveryOutcome, "not-accepted");
  assert.equal(failure?.errorMessage, "telegram-config-rotated");
});

test("processChannelStep rechecks Telegram config after sandbox wake", async () => {
  const currentConfig = createFallbackTelegramConfig();
  let forwardCalls = 0;
  await setTelegramChannelConfig(currentConfig);

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => {
      await setTelegramChannelConfig(null);
      return {
        meta: asMeta({
          status: "running",
          sandboxId: "sbx-config-deleted-during-wake",
          channels: {
            telegram: currentConfig,
            slack: null,
            discord: null,
            whatsapp: null,
          },
        }),
        bootMessageSent: false,
        admissionReady: true,
      };
    },
    forwardToNativeHandlerWithRetry: async () => {
      forwardCalls += 1;
      throw new Error("must not forward after channel deletion during wake");
    },
  });

  await processChannelStep(
    "telegram",
    { update_id: 4, message: { chat: { id: 999 } } },
    "test",
    "req-deleted-during-wake",
    null,
    {
      dependencies,
      workflowHandoff: {
        fallbackTelegramConfig: currentConfig,
        telegramConfigGeneration: currentConfig.configuredAt,
      } satisfies ChannelWorkflowHandoff,
    },
  );

  assert.equal(forwardCalls, 0);
  assert.equal(
    getServerLogs().find(
      (entry) => entry.message === "channels.telegram_workflow_handoff_stale",
    )?.data?.phase,
    "post-wake",
  );
});

test("processChannelStep releases the Telegram config lease before native dispatch", async () => {
  const currentConfig = createFallbackTelegramConfig();
  let forwardedWebhookSecret: string | null = null;

  await setTelegramChannelConfig(currentConfig);
  const store = getStore();
  const acquireLock = store.acquireLock.bind(store);
  const configLeaseTtls: number[] = [];
  store.acquireLock = async (key, ttlSeconds) => {
    if (key === channelConfigLockKey("telegram")) {
      configLeaseTtls.push(ttlSeconds);
    }
    return acquireLock(key, ttlSeconds);
  };

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-current",
        channels: {
          telegram: currentConfig,
          slack: null,
          discord: null,
          whatsapp: null,
        },
      }),
      bootMessageSent: false,
      admissionReady: true,
    }),
    forwardToNativeHandlerWithRetry: async (
      _channel: unknown,
      _payload: unknown,
      meta: SingleMeta,
    ): Promise<RetryingForwardResult> => {
      const competingConfigLock = await getStore().acquireLock(
        channelConfigLockKey("telegram"),
        90,
      );
      assert.equal(
        typeof competingConfigLock,
        "string",
        "admin config mutation must not wait for the native turn",
      );
      if (competingConfigLock) {
        await getStore().releaseLock(
          channelConfigLockKey("telegram"),
          competingConfigLock,
        );
      }
      forwardedWebhookSecret = meta.channels.telegram?.webhookSecret ?? null;
      return {
        ok: true,
        status: 200,
        attempts: 1,
        totalMs: 50,
        transport: "public",
        retries: [],
      };
    },
  });

  await processChannelStep(
    "telegram",
    { update_id: 3, message: { chat: { id: 789 } } },
    "test",
    "req-current",
    null,
    {
      dependencies,
      workflowHandoff: {
        fallbackTelegramConfig: currentConfig,
        telegramConfigGeneration: currentConfig.configuredAt,
      } satisfies ChannelWorkflowHandoff,
    },
  );

  assert.equal(forwardedWebhookSecret, currentConfig.webhookSecret);
  assert.equal(configLeaseTtls[0], 90);
  store.acquireLock = acquireLock;
});

test("processChannelStep closes Telegram delivery as unknown when config rotates during dispatch", async () => {
  const currentConfig = createFallbackTelegramConfig();
  await setTelegramChannelConfig(currentConfig);

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-lease-lost",
        channels: {
          telegram: currentConfig,
          slack: null,
          discord: null,
          whatsapp: null,
        },
      }),
      bootMessageSent: false,
      admissionReady: true,
    }),
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      await setTelegramChannelConfig({
        ...currentConfig,
        botToken: "rotated-token",
        configuredAt: currentConfig.configuredAt + 1,
      });
      return {
        ok: true,
        acceptance: "accepted",
        status: 200,
        attempts: 1,
        totalMs: 50,
        transport: "public",
        retries: [],
      };
    },
  });

  await processChannelStep(
        "telegram",
        { update_id: 88, message: { chat: { id: 789 } } },
        "test",
        "req-lease-lost",
        null,
        {
          dependencies,
          workflowHandoff: {
            fallbackTelegramConfig: currentConfig,
            telegramConfigGeneration: currentConfig.configuredAt,
          },
          requireTelegramConfigGeneration: true,
        },
      );

  const failure = await getChannelDlqRecord(
    "telegram",
    `telegram:legacy:${currentConfig.botUsername}:${currentConfig.configuredAt}:88`,
  );
  assert.equal(failure?.deliveryOutcome, "unknown");
  assert.equal(failure?.terminal, true);
});

test("processChannelStep fails closed when post-wake bundle identity cannot be verified", async () => {
  let capturedAdmission: boolean | undefined;
  let capturedGatewayAdmission: boolean | undefined;
  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-unverified-bundle",
        bundleIdentity: VERIFIED_DELIVERY_BUNDLE_IDENTITY,
      }),
      bootMessageSent: false,
      admissionReady: true,
    }),
    hydrateVerifiedBundleIdentity: async () => null,
    forwardToNativeHandlerWithRetry: async (
      ...args: Parameters<
        DrainChannelWorkflowDependencies["forwardToNativeHandlerWithRetry"]
      >
    ): Promise<RetryingForwardResult> => {
      capturedAdmission = args[9];
      capturedGatewayAdmission = args[10];
      return {
        ok: true,
        acceptance: "accepted",
        status: 200,
        attempts: 1,
        totalMs: 50,
        transport: "public",
        retries: [],
      };
    },
  });

  await processChannelStep(
    "telegram",
    { update_id: 3 },
    "test",
    "req-durable-ack-admitted",
    null,
    { dependencies },
  );

  assert.equal(capturedAdmission, false);
  assert.equal(capturedGatewayAdmission, false);
});

test("processChannelStep admits capabilities verified after a cold wake", async () => {
  let capturedTelegramAdmission: boolean | undefined;
  let capturedGatewayAdmission: boolean | undefined;
  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-cold-bundle",
        bundleIdentity: VERIFIED_DELIVERY_BUNDLE_IDENTITY,
      }),
      bootMessageSent: false,
      admissionReady: true,
    }),
    hydrateVerifiedBundleIdentity: async (identity) =>
      identity === VERIFIED_DELIVERY_BUNDLE_IDENTITY
        ? VERIFIED_DELIVERY_BUNDLE_IDENTITY
        : null,
    forwardToNativeHandlerWithRetry: async (
      ...args: Parameters<
        DrainChannelWorkflowDependencies["forwardToNativeHandlerWithRetry"]
      >
    ): Promise<RetryingForwardResult> => {
      capturedTelegramAdmission = args[9];
      capturedGatewayAdmission = args[10];
      return {
        ok: true,
        acceptance: "accepted",
        status: 200,
        attempts: 1,
        totalMs: 50,
        transport: "public",
        retries: [],
      };
    },
  });

  await processChannelStep(
    "telegram",
    { update_id: 4 },
    "test",
    "req-post-wake-capabilities",
    null,
    { dependencies },
  );

  assert.equal(capturedTelegramAdmission, true);
  assert.equal(capturedGatewayAdmission, true);
});

test("processChannelStep uses the current verified post-wake capabilities", async () => {
  let capturedTelegramAdmission: boolean | undefined;
  let capturedGatewayAdmission: boolean | undefined;
  const currentIdentity: VerifiedBundleIdentity = {
    ...VERIFIED_DELIVERY_BUNDLE_IDENTITY,
    capabilities: [],
  };
  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-current-bundle",
        bundleIdentity: currentIdentity,
      }),
      bootMessageSent: false,
      admissionReady: true,
    }),
    hydrateVerifiedBundleIdentity: async () => currentIdentity,
    forwardToNativeHandlerWithRetry: async (
      ...args: Parameters<
        DrainChannelWorkflowDependencies["forwardToNativeHandlerWithRetry"]
      >
    ): Promise<RetryingForwardResult> => {
      capturedTelegramAdmission = args[9];
      capturedGatewayAdmission = args[10];
      return {
        ok: true,
        acceptance: "accepted",
        status: 200,
        attempts: 1,
        totalMs: 50,
        transport: "public",
        retries: [],
      };
    },
  });

  await processChannelStep(
    "telegram",
    { update_id: 5 },
    "test",
    "req-current-capabilities",
    null,
    { dependencies },
  );

  assert.equal(capturedTelegramAdmission, false);
  assert.equal(capturedGatewayAdmission, false);
});

test("processChannelStep converts retrying forward fetch exception into RetryableError", async () => {
  const dependencies = createWorkflowDependencies({
    forwardToNativeHandlerWithRetry: async () => {
      throw new Error("native_handler_timeout channel=telegram timeoutMs=30000");
    },
  });

  await assert.rejects(
    processChannelStep("telegram", { update_id: 1 }, "test", "req-1", null, { dependencies }),
    (error: unknown) => {
      assert.ok(error instanceof TestRetryableError);
      assert.equal((error as TestRetryableError).retryAfter, "15s");
      return true;
    },
  );
});

test("processChannelStep converts native forward 502 into RetryableError (Telegram retrying path)", async () => {
  const dependencies = createWorkflowDependencies({
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => ({
      ok: false,
      status: 502,
      attempts: 6,
      totalMs: 6000,
      transport: "public",
      retries: [{ attempt: 1, reason: "proxy-error", status: 502 }],
    }),
  });

  await assert.rejects(
    processChannelStep("telegram", { update_id: 1 }, "test", "req-1", null, { dependencies }),
    (error: unknown) => {
      assert.ok(error instanceof TestRetryableError);
      assert.equal((error as TestRetryableError).retryAfter, "15s");
      return true;
    },
  );
});

test("processChannelStep keeps native forward 404 fatal (Telegram retrying path)", async () => {
  const dependencies = createWorkflowDependencies({
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => ({
      ok: false,
      status: 404,
      attempts: 1,
      totalMs: 50,
      transport: "public",
      retries: [],
    }),
  });

  await assert.rejects(
    processChannelStep("telegram", { update_id: 1 }, "test", "req-1", null, { dependencies }),
    (error: unknown) => {
      assert.ok(error instanceof TestFatalError);
      return true;
    },
  );
});

test("processChannelStep uses retrying forward for Telegram and Slack", async () => {
  let retryingCalled = false;
  let directCalled = false;

  const telegramDeps = createWorkflowDependencies({
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      retryingCalled = true;
      return { ok: true, status: 200, attempts: 1, totalMs: 50, transport: "public", retries: [] };
    },
    forwardToNativeHandler: async () => {
      directCalled = true;
      return { ok: true, status: 200, durationMs: 0, bodyLength: 0, bodyHead: "", headers: null };
    },
  });

  await processChannelStep("telegram", { update_id: 1 }, "test", "req-tg", null, { dependencies: telegramDeps });
  assert.ok(retryingCalled, "Telegram should use retrying forward");
  assert.ok(!directCalled, "Telegram should not use direct forward");

  retryingCalled = false;
  directCalled = false;

  const slackDeps = createWorkflowDependencies({
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      retryingCalled = true;
      return { ok: true, status: 200, attempts: 1, totalMs: 50, transport: "public", retries: [] };
    },
    forwardToNativeHandler: async () => {
      directCalled = true;
      return { ok: true, status: 200, durationMs: 0, bodyLength: 0, bodyHead: "", headers: null };
    },
  });

  await processChannelStep("slack", { event: {} }, "test", "req-slack", null, { dependencies: slackDeps });
  assert.ok(retryingCalled, "Slack should use retrying forward");
  assert.ok(!directCalled, "Slack should not use direct forward");
});

test("processChannelStep converts retrying forward 504 (exhausted) into RetryableError", async () => {
  const dependencies = createWorkflowDependencies({
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => ({
      ok: false,
      status: 504,
      attempts: 6,
      totalMs: 30000,
      transport: null,
      retries: [
        { attempt: 1, reason: "proxy-error", status: 503 },
        { attempt: 2, reason: "fetch-exception", error: "connect ECONNREFUSED" },
      ],
    }),
  });

  await assert.rejects(
    processChannelStep("telegram", { update_id: 1 }, "test", "req-1", null, { dependencies }),
    (error: unknown) => {
      assert.ok(error instanceof TestRetryableError);
      assert.equal((error as TestRetryableError).retryAfter, "15s");
      return true;
    },
  );
});

test("processChannelStep treats retrying forward 500 as retryable at workflow level", async () => {
  // A 500 from the handler is NOT retried within the forward loop (handler processed
  // the request), but is still retryable at the workflow step level since the
  // existing error mapper treats native_forward_failed >= 500 as transient.
  const dependencies = createWorkflowDependencies({
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => ({
      ok: false,
      status: 500,
      attempts: 1,
      totalMs: 100,
      transport: "public",
      retries: [],
    }),
  });

  await assert.rejects(
    processChannelStep("telegram", { update_id: 1 }, "test", "req-1", null, { dependencies }),
    (error: unknown) => {
      assert.ok(error instanceof TestRetryableError);
      assert.equal((error as TestRetryableError).retryAfter, "15s");
      return true;
    },
  );
});

test("toWorkflowProcessingError returns RetryableError for sandbox_not_ready", () => {
  const error = toWorkflowProcessingError(
    "slack",
    new Error("sandbox_not_ready: gateway probe still loading"),
    createWorkflowDependencies(),
  );

  assert.ok(error instanceof TestRetryableError);
  assert.equal((error as TestRetryableError).retryAfter, "15s");
});

test("toWorkflowProcessingError returns RetryableError for SANDBOX_READY_TIMEOUT", () => {
  const error = toWorkflowProcessingError(
    "telegram",
    new Error("SANDBOX_READY_TIMEOUT: sandbox did not become ready in time"),
    createWorkflowDependencies(),
  );

  assert.ok(error instanceof TestRetryableError);
  assert.equal((error as TestRetryableError).retryAfter, "15s");
});

test("toWorkflowProcessingError returns RetryableError for native_handler_timeout", () => {
  const error = toWorkflowProcessingError(
    "telegram",
    new Error("native_handler_timeout channel=telegram timeoutMs=30000"),
    createWorkflowDependencies(),
  );

  assert.ok(error instanceof TestRetryableError);
  assert.equal((error as TestRetryableError).retryAfter, "15s");
});

test("toWorkflowProcessingError returns RetryableError for native_forward_failed 503", () => {
  const error = toWorkflowProcessingError(
    "telegram",
    new Error("native_forward_failed status=503"),
    createWorkflowDependencies(),
  );

  assert.ok(error instanceof TestRetryableError);
  assert.equal((error as TestRetryableError).retryAfter, "15s");
});

test("toWorkflowProcessingError returns FatalError for native_forward_failed 404", () => {
  const error = toWorkflowProcessingError(
    "telegram",
    new Error("native_forward_failed status=404"),
    createWorkflowDependencies(),
  );

  assert.ok(error instanceof TestFatalError);
});

// ===========================================================================
// Story F: retry budget escalation from RetryableError to FatalError
// ===========================================================================

test("retry budget: sandbox_not_ready stays retryable inside budget", () => {
  const error = toWorkflowProcessingError(
    "slack",
    new Error("sandbox_not_ready"),
    createWorkflowDependencies(),
    { attempt: 2, wallClockMs: 30_000, exceeded: false, reason: null },
  );
  assert.ok(error instanceof TestRetryableError);
});

test("retry budget: sandbox_not_ready escalates to FatalError when exceeded", () => {
  const error = toWorkflowProcessingError(
    "slack",
    new Error("sandbox_not_ready"),
    createWorkflowDependencies(),
    {
      attempt: 10,
      wallClockMs: 11 * 60 * 1000,
      exceeded: true,
      reason: "sandbox_persistently_failing:10_attempts:660000ms",
    },
  );
  assert.ok(error instanceof TestFatalError);
  assert.match(
    (error as Error).message,
    /sandbox_persistently_failing:10_attempts:660000ms/,
    "fatal error message carries the budget-reason suffix",
  );
});

test("retry budget: native_forward_failed 5xx escalates to FatalError when exceeded", () => {
  const error = toWorkflowProcessingError(
    "telegram",
    new Error("native_forward_failed status=504"),
    createWorkflowDependencies(),
    {
      attempt: 25,
      wallClockMs: 8 * 60 * 1000,
      exceeded: true,
      reason: "sandbox_persistently_failing:25_attempts:480000ms",
    },
  );
  assert.ok(error instanceof TestFatalError);
});

test("retry budget: non-retryable 4xx stays fatal regardless of budget", () => {
  // 404 is already fatal — budget state should not change the outcome.
  const error = toWorkflowProcessingError(
    "slack",
    new Error("native_forward_failed status=404"),
    createWorkflowDependencies(),
    { attempt: 1, wallClockMs: 1000, exceeded: false, reason: null },
  );
  assert.ok(error instanceof TestFatalError);
});

test("retry budget: isRetryable-classified error escalates on exceeded budget", () => {
  const deps = createWorkflowDependencies({
    isRetryable: () => true,
  });
  const error = toWorkflowProcessingError(
    "discord",
    new Error("transient-something-else"),
    deps,
    { attempt: 30, wallClockMs: 15 * 60 * 1000, exceeded: true, reason: "sandbox_persistently_failing:30_attempts:900000ms" },
  );
  assert.ok(error instanceof TestFatalError);
});

test("retry budget: omitting retryBudget preserves original retryable/fatal classification", () => {
  // No retryBudget passed — sandbox_not_ready must remain retryable.
  const error = toWorkflowProcessingError(
    "slack",
    new Error("sandbox_not_ready"),
    createWorkflowDependencies(),
  );
  assert.ok(error instanceof TestRetryableError);
});

// ===========================================================================
// Telegram probe skip gate: lastRestoreMetrics.telegramListenerReady
// ===========================================================================

test("processChannelStep skips probe loop when lastRestoreMetrics.telegramListenerReady === true", async () => {
  _resetLogBuffer();

  let localProbeCalls = 0;
  let publicProbeCalls = 0;

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-listener-ready",
        portUrls: { "3000": "https://gw.test", "8787": "https://tg.test" },
        channels: {
          telegram: { botToken: "tok", webhookSecret: "secret" } as never,
          slack: null,
          discord: null,
          whatsapp: null,
        },
        lastRestoreMetrics: {
          totalMs: 1_000,
          localReadyMs: 500,
          telegramListenerReady: true,
        } as RestorePhaseMetrics,
      }),
      bootMessageSent: false,
      admissionReady: true,
    }),
    probeTelegramNativeHandlerLocally: async () => {
      localProbeCalls += 1;
      return { status: 401, ready: true, error: null };
    },
    waitForTelegramNativeHandler: async (): Promise<TelegramProbeResult> => {
      publicProbeCalls += 1;
      return {
        ready: true,
        attempts: 1,
        waitMs: 0,
        lastStatus: 401,
        publicUrl: "https://tg.test",
        timeline: [{ attempt: 1, elapsedMs: 0, status: 401 }],
      };
    },
  });

  await processChannelStep("telegram", { update_id: 1 }, "test", "req-listener-ready", null, {
    dependencies,
  });

  assert.equal(
    localProbeCalls,
    0,
    "probeTelegramNativeHandlerLocally must NOT be called when telegramListenerReady === true",
  );
  assert.equal(
    publicProbeCalls,
    0,
    "waitForTelegramNativeHandler must NOT be called when telegramListenerReady === true",
  );

  // The skip is surfaced on the emitted wake summary so upstream observability can
  // distinguish a trusted-from-restore skip from a natural probe success.
  const logs = getServerLogs();
  const summary = logs.find((e) => e.message === "channels.telegram_wake_summary");
  assert.ok(summary, "telegram_wake_summary must be emitted");
  assert.equal(
    summary!.data?.telegramProbeSkippedReason,
    "local-handler-ready",
    "summary should record skip-reason 'local-handler-ready' when trusted from restore metrics",
  );
});

test("processChannelStep preserves probe behavior when telegramListenerReady !== true", async () => {
  _resetLogBuffer();

  let localProbeCalls = 0;

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-listener-unproven",
        portUrls: { "3000": "https://gw.test", "8787": "https://tg.test" },
        channels: {
          telegram: { botToken: "tok", webhookSecret: "secret" } as never,
          slack: null,
          discord: null,
          whatsapp: null,
        },
        lastRestoreMetrics: {
          totalMs: 1_000,
          localReadyMs: 500,
          telegramListenerReady: false,
        } as RestorePhaseMetrics,
      }),
      bootMessageSent: false,
      admissionReady: true,
    }),
    probeTelegramNativeHandlerLocally: async () => {
      localProbeCalls += 1;
      return { status: 401, ready: true, error: null };
    },
  });

  await processChannelStep("telegram", { update_id: 1 }, "test", "req-listener-unproven", null, {
    dependencies,
  });

  assert.ok(
    localProbeCalls >= 1,
    "probeTelegramNativeHandlerLocally must run at least once when telegramListenerReady !== true",
  );
});

// ===========================================================================
// Telegram wake summary log
// ===========================================================================

test("processChannelStep emits channels.telegram_wake_summary for Telegram requests", async () => {
  _resetLogBuffer();

  const fakeRestoreMetrics: Partial<RestorePhaseMetrics> = {
    totalMs: 2000,
    sandboxCreateMs: 900,
    assetSyncMs: 0,
    startupScriptMs: 600,
    localReadyMs: 400,
    postLocalReadyBlockingMs: 1600,
    publicReadyMs: 100,
    bootOverlapMs: 50,
    skippedStaticAssetSync: true,
    skippedDynamicConfigSync: true,
    dynamicConfigReason: "hash-match",
    telegramReconcileBlocking: true,
    telegramReconcileMs: 700,
    telegramSecretSyncBlocking: true,
    telegramSecretSyncMs: 350,
    hotSpareHit: false,
    hotSparePromotionMs: 0,
    hotSpareRejectReason: "feature-disabled",
  };

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-wake-summary",
        channels: { telegram: null, slack: null, discord: null, whatsapp: null },
        lastRestoreMetrics: fakeRestoreMetrics as RestorePhaseMetrics,
      }),
      bootMessageSent: true,
      admissionReady: true,
    }),
  });

  const receivedAtMs = Date.now() - 50;
  await processChannelStep("telegram", { update_id: 1 }, "test", "req-wake", null, {
    receivedAtMs,
    dependencies,
  });

  const logs = getServerLogs();
  const summaryLogs = logs.filter((e) => e.message === "channels.telegram_wake_summary");
  assert.equal(summaryLogs.length, 1, "exactly one telegram_wake_summary log expected");

  const data = summaryLogs[0].data ?? {};
  assert.equal(data.channel, "telegram");
  assert.equal(data.requestId, "req-wake");
  assert.equal(data.sandboxId, "sbx-wake-summary");
  assert.equal(typeof data.endToEndMs, "number");
  assert.ok((data.endToEndMs as number) >= 0);
  assert.equal(data.restoreTotalMs, 2000);
  assert.equal(data.startupScriptMs, 600);
  assert.equal(data.localReadyMs, 400);
  assert.equal(data.postLocalReadyBlockingMs, 1600);
  assert.equal(data.skippedStaticAssetSync, true);
  assert.equal(data.skippedDynamicConfigSync, true);
  assert.equal(data.dynamicConfigReason, "hash-match");
  assert.equal(data.telegramReconcileBlocking, true);
  assert.equal(data.telegramReconcileMs, 700);
  assert.equal(data.telegramSecretSyncBlocking, true);
  assert.equal(data.telegramSecretSyncMs, 350);
  assert.equal(data.telegramProbeReady, true);
  assert.equal(data.telegramProbeLastStatus, null);
  assert.equal(data.telegramProbePublicUrl, null);
  assert.equal(data.telegramProbeSkippedReason, "local-handler-ready");
  assert.equal(data.telegramLocalProbeStatus, 401);
  assert.equal(data.telegramLocalProbeReady, true);
  assert.equal(data.telegramLocalProbeError, null);
  assert.equal(data.retryingForwardAttempts, 1);
  assert.equal(data.hotSpareHit, false);
  assert.equal(data.hotSparePromotionMs, 0);
  assert.equal(data.hotSpareRejectReason, "feature-disabled");
});

test("processChannelStep collapses Telegram public probe into forward retry loop after local stall", async () => {
  _resetLogBuffer();

  let publicProbeCalls = 0;
  let preferLocalHint: boolean | null = null;

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-mismatch",
        portUrls: { "3000": "https://gw.test", "8787": "https://tg.test" },
        channels: {
          telegram: { botToken: "tok", webhookSecret: "secret" } as never,
          slack: null,
          discord: null,
          whatsapp: null,
        },
        lastRestoreMetrics: {
          totalMs: 17_400,
          localReadyMs: 2_000,
          postLocalReadyBlockingMs: 15_400,
          telegramReconcileBlocking: true,
          telegramReconcileMs: 600,
          telegramSecretSyncBlocking: true,
          telegramSecretSyncMs: 250,
        } as RestorePhaseMetrics,
      }),
      bootMessageSent: true,
      admissionReady: true,
    }),
    probeTelegramNativeHandlerLocally: async () => ({
      status: 404,
      ready: false,
      error: "connect ECONNREFUSED",
      detail: "handler-not-bound",
      durationMs: 35,
      bodyLength: 0,
      bodyHead: "",
      headers: null,
    }),
    waitForTelegramNativeHandler: async () => {
      publicProbeCalls += 1;
      return {
        ready: true,
        attempts: 20,
        waitMs: 15_000,
        lastStatus: 401,
        publicUrl: "https://tg.test",
        timeline: [{ attempt: 20, elapsedMs: 15_000, status: 401 }],
      };
    },
    forwardToNativeHandlerWithRetry: async (
      _channel,
      _payload,
      _meta,
      _getSandboxDomain,
      _forwardTelegramToNativeHandlerLocally,
      preferLocalTelegramForward,
    ) => {
      preferLocalHint = preferLocalTelegramForward ?? null;
      return {
        ok: true,
        status: 200,
        attempts: 2,
        totalMs: 120,
        transport: "public",
        retries: [{ attempt: 1, reason: "proxy-error", status: 502 }],
      };
    },
  });

  await processChannelStep("telegram", { update_id: 99 }, "test", "req-mismatch", null, {
    dependencies,
  });

  assert.equal(publicProbeCalls, 0, "public Telegram readiness probe should not block the critical path");
  assert.equal(preferLocalHint, false, "local forward should not be preferred after a failed local hint");

  const logs = getServerLogs();
  const mismatchLog = logs.find((entry) => entry.message === "channels.telegram_probe_local_mismatch");
  assert.equal(mismatchLog, undefined, "public-probe mismatch log is obsolete when public probe is skipped");

  const summaryLog = logs.find((entry) => entry.message === "channels.telegram_wake_summary");
  assert.ok(summaryLog, "telegram wake summary should be emitted");
  assert.equal(summaryLog.data?.telegramProbeReady, false);
  assert.equal(summaryLog.data?.telegramProbeLastStatus, null);
  assert.equal(summaryLog.data?.telegramProbeSkippedReason, "collapsed-forward-loop");
  assert.equal(summaryLog.data?.telegramReadinessMode, "single-local-hint");
  assert.equal(typeof summaryLog.data?.telegramPreForwardProbeMs, "number");
  assert.equal(typeof summaryLog.data?.telegramWorkflowToFirstForwardAttemptMs, "number");
  assert.equal(summaryLog.data?.telegramLocalProbeStatus, 404);
  assert.equal(summaryLog.data?.telegramLocalProbeReady, false);
  assert.equal(summaryLog.data?.telegramLocalProbeError, "connect ECONNREFUSED");
  assert.equal(summaryLog.data?.telegramLocalProbeDetail, "handler-not-bound");
  assert.equal(summaryLog.data?.retryingForwardAttempts, 2);
  assert.equal(summaryLog.data?.retryingForwardTransport, "public");
});

test("processChannelStep does NOT emit telegram_wake_summary for Slack requests", async () => {
  _resetLogBuffer();

  const dependencies = createWorkflowDependencies();

  await processChannelStep("slack", { event: {} }, "test", "req-slack-no-summary", null, { dependencies });

  const logs = getServerLogs();
  const summaryLogs = logs.filter((e) => e.message === "channels.telegram_wake_summary");
  assert.equal(summaryLogs.length, 0, "no telegram_wake_summary log for Slack channel");
});

test("processChannelStep includes webhookToWorkflowMs when receivedAtMs is provided", async () => {
  _resetLogBuffer();

  const dependencies = createWorkflowDependencies({
    ensureSandboxReady: async () =>
      asMeta({
        status: "running",
        sandboxId: "sbx-timing",
        channels: { telegram: null, slack: null, discord: null, whatsapp: null },
      }),
  });

  const receivedAtMs = Date.now() - 100;
  await processChannelStep("telegram", { update_id: 2 }, "test", "req-timing", null, {
    receivedAtMs,
    dependencies,
  });

  const logs = getServerLogs();
  const summaryLogs = logs.filter((e) => e.message === "channels.telegram_wake_summary");
  assert.equal(summaryLogs.length, 1);

  const data = summaryLogs[0].data ?? {};
  assert.equal(typeof data.webhookToWorkflowMs, "number");
  assert.ok((data.webhookToWorkflowMs as number) >= 0);
  assert.equal(typeof data.workflowToSandboxReadyMs, "number");
  assert.equal(typeof data.forwardMs, "number");
});

test("processChannelStep sets webhookToWorkflowMs to null when receivedAtMs is not provided", async () => {
  _resetLogBuffer();

  const dependencies = createWorkflowDependencies({
    ensureSandboxReady: async () =>
      asMeta({
        status: "running",
        sandboxId: "sbx-no-received",
        channels: { telegram: null, slack: null, discord: null, whatsapp: null },
      }),
  });

  await processChannelStep("telegram", { update_id: 3 }, "test", "req-no-ts", null, {
    dependencies,
  });

  const logs = getServerLogs();
  const summaryLogs = logs.filter((e) => e.message === "channels.telegram_wake_summary");
  assert.equal(summaryLogs.length, 1);

  const data = summaryLogs[0].data ?? {};
  assert.equal(data.webhookToWorkflowMs, null);
  assert.equal(data.endToEndMs, null);
});

test("processChannelStep forward captures Telegram webhook secret and correct port domain", async () => {
  _resetLogBuffer();

  let capturedChannel: string | null = null;
  let capturedPayload: unknown = null;
  let capturedMeta: SingleMeta | null = null;
  let capturedGetSandboxDomain: ((port?: number) => Promise<string>) | null = null;

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-tg-forward",
        portUrls: { "3000": "https://sbx.example.test", "8787": "https://sbx-8787.example.test" },
        channels: {
          telegram: { botToken: "tok", webhookSecret: "secret-123" } as never,
          slack: null,
          discord: null,
          whatsapp: null,
        },
      }),
      bootMessageSent: false,
      admissionReady: true,
    }),
    forwardToNativeHandlerWithRetry: async (
      channel: unknown,
      payload: unknown,
      meta: SingleMeta,
      getSandboxDomain: (port?: number) => Promise<string>,
    ): Promise<RetryingForwardResult> => {
      capturedChannel = channel as string;
      capturedPayload = payload;
      capturedMeta = meta;
      capturedGetSandboxDomain = getSandboxDomain;
      return { ok: true, status: 200, attempts: 1, totalMs: 50, transport: "public", retries: [] };
    },
  });

  const telegramUpdate = { update_id: 999, message: { chat: { id: 12345 }, text: "hello" } };
  await processChannelStep("telegram", telegramUpdate, "test", "req-forward", null, { dependencies });

  // Verify the forward received the right data
  assert.equal(capturedChannel, "telegram");
  assert.deepStrictEqual(capturedPayload, telegramUpdate);
  assert.ok(capturedMeta, "meta should be captured");
  const meta = capturedMeta as SingleMeta;
  assert.equal(meta.sandboxId, "sbx-tg-forward");
  assert.equal(meta.channels.telegram?.webhookSecret, "secret-123");
  assert.ok(meta.portUrls?.["8787"], "portUrls should include port 8787");
  assert.ok(capturedGetSandboxDomain, "getSandboxDomain should be passed");
});

test("processChannelStep forward passes meta with portUrls from boot result", async () => {
  // Simulates the scenario where runWithBootMessages returns running meta
  // and the forward needs portUrls to resolve the sandbox domain.
  let forwardedPortUrls: Record<string, string> | null = null;

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-ports",
        portUrls: { "3000": "https://gw.test", "8787": "https://tg.test" },
        channels: { telegram: null, slack: null, discord: null, whatsapp: null },
      }),
      bootMessageSent: false,
      admissionReady: true,
    }),
    forwardToNativeHandlerWithRetry: async (
      _channel: unknown,
      _payload: unknown,
      meta: SingleMeta,
    ): Promise<RetryingForwardResult> => {
      forwardedPortUrls = (meta.portUrls as Record<string, string>) ?? null;
      return { ok: true, status: 200, attempts: 1, totalMs: 50, transport: "public", retries: [] };
    },
  });

  await processChannelStep("telegram", { update_id: 1 }, "test", "req-ports", null, { dependencies });

  assert.ok(forwardedPortUrls, "portUrls should be present in forwarded meta");
  assert.equal(forwardedPortUrls["3000"], "https://gw.test");
  assert.equal(forwardedPortUrls["8787"], "https://tg.test");
});

// ---------------------------------------------------------------------------
// Telegram native handler readiness probe tests
// ---------------------------------------------------------------------------

test("processChannelStep uses local Telegram native handler readiness before forwarding", async () => {
  let probeCallCount = 0;
  let forwardCalledAfterLocalProbe = false;
  let localProbeCallCount = 0;

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-probe-test",
        portUrls: { "3000": "https://gw.test", "8787": "https://tg.test" },
        channels: {
          telegram: { botToken: "tok", webhookSecret: "secret" } as never,
          slack: null,
          discord: null,
          whatsapp: null,
        },
      }),
      bootMessageSent: true,
      admissionReady: true,
    }),
    waitForTelegramNativeHandler: async () => {
      probeCallCount += 1;
      return {
        ready: true,
        attempts: 5,
        waitMs: 2500,
        lastStatus: 401,
        publicUrl: "https://tg.test",
        timeline: [{ attempt: 5, elapsedMs: 2500, status: 401 }],
      };
    },
    probeTelegramNativeHandlerLocally: async () => {
      localProbeCallCount += 1;
      return {
        status: 401,
        ready: true,
        error: null,
      };
    },
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      forwardCalledAfterLocalProbe = localProbeCallCount > 0;
      return { ok: true, status: 200, attempts: 1, totalMs: 50, transport: "local", retries: [] };
    },
  });

  await processChannelStep("telegram", { update_id: 1 }, "test", "req-probe", null, { dependencies });

  assert.equal(localProbeCallCount, 1, "local probe should be called exactly once for Telegram");
  assert.equal(probeCallCount, 0, "public probe should be skipped when local handler is ready");
  assert.ok(forwardCalledAfterLocalProbe, "forward should only happen after local probe completes");
});

test("processChannelStep does NOT run Telegram-specific probe for Slack", async () => {
  let probeCallCount = 0;

  const dependencies = createWorkflowDependencies({
    waitForTelegramNativeHandler: async () => {
      probeCallCount += 1;
      return {
        ready: true,
        attempts: 1,
        waitMs: 0,
        lastStatus: 401,
        publicUrl: "https://tg.test",
        timeline: [{ attempt: 1, elapsedMs: 0, status: 401 }],
      };
    },
  });

  await processChannelStep("slack", { event: {} }, "test", "req-no-probe-slack", null, { dependencies });
  assert.equal(probeCallCount, 0, "Telegram probe should NOT run for Slack — Slack relies on retry-on-404");
});

test("processChannelStep skips public Telegram probe when local handler is not ready", async () => {
  let probeCallCount = 0;
  let forwardCalled = false;

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-probe-timeout",
        portUrls: { "3000": "https://gw.test", "8787": "https://tg.test" },
        channels: {
          telegram: { botToken: "tok", webhookSecret: "secret" } as never,
          slack: null,
          discord: null,
          whatsapp: null,
        },
      }),
      bootMessageSent: true,
      admissionReady: true,
    }),
    probeTelegramNativeHandlerLocally: async () => ({
      status: 404,
      ready: false,
      error: null,
    }),
    waitForTelegramNativeHandler: async () => {
      probeCallCount += 1;
      return {
        ready: true,
        attempts: 5,
        waitMs: 2500,
        lastStatus: 401,
        publicUrl: "https://tg.test",
        timeline: [{ attempt: 5, elapsedMs: 2500, status: 401 }],
      };
    },
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      forwardCalled = true;
      return { ok: true, status: 200, attempts: 1, totalMs: 50, transport: "public", retries: [] };
    },
  });

  await processChannelStep("telegram", { update_id: 1 }, "test", "req-probe-timeout", null, { dependencies });

  assert.equal(probeCallCount, 0, "public probe should not block the critical path when local handler is not ready");
  assert.ok(forwardCalled, "forward retry loop should still be attempted after local probe hint");
});

test("processChannelStep still forwards when both Telegram probes time out", async () => {
  // If both probes time out, we should still attempt the forward (best effort).
  let forwardCalled = false;

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-probe-timeout",
        portUrls: { "3000": "https://gw.test", "8787": "https://tg.test" },
        channels: {
          telegram: { botToken: "tok", webhookSecret: "secret" } as never,
          slack: null,
          discord: null,
          whatsapp: null,
        },
      }),
      bootMessageSent: true,
      admissionReady: true,
    }),
    probeTelegramNativeHandlerLocally: async () => ({
      status: 404,
      ready: false,
      error: "connect ECONNREFUSED",
    }),
    waitForTelegramNativeHandler: async () => {
      return {
        ready: false,
        attempts: 20,
        waitMs: 15000,
        lastStatus: 404,
        publicUrl: "https://tg.test",
        timeline: [{ attempt: 20, elapsedMs: 15000, status: 404 }],
      };
    },
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      forwardCalled = true;
      return { ok: true, status: 200, attempts: 1, totalMs: 50, transport: "public", retries: [] };
    },
  });

  await processChannelStep("telegram", { update_id: 1 }, "test", "req-probe-timeout", null, { dependencies });

  assert.ok(forwardCalled, "forward should still be attempted even after both probes time out");
});

test("processChannelStep accepts local Telegram empty 200 without retrying", async () => {
  _resetLogBuffer();

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-local-200",
        portUrls: { "3000": "https://gw.test", "8787": "https://tg.test" },
        channels: {
          telegram: { botToken: "tok", webhookSecret: "secret" } as never,
          slack: null,
          discord: null,
          whatsapp: null,
        },
      }),
      bootMessageSent: false,
      admissionReady: true,
    }),
    probeTelegramNativeHandlerLocally: async () => ({
      status: 401,
      ready: true,
      error: null,
      durationMs: 40,
      bodyLength: 12,
      bodyHead: "unauthorized",
      headers: null,
    }),
    forwardToNativeHandlerWithRetry: async () => ({
      ok: true,
      status: 200,
      attempts: 1,
      totalMs: 42,
      transport: "local",
      retries: [],
      attemptsDetail: [
        {
          attempt: 1,
          startedAtMs: Date.now(),
          elapsedMs: 42,
          durationMs: 42,
          status: 200,
          ok: true,
          bodyLength: 0,
          bodyHead: "",
          headers: {
            server: null,
            contentType: "text/plain; charset=utf-8",
            contentLength: null,
            xPoweredBy: null,
            via: null,
            cacheControl: null,
          },
          transport: "local",
          classification: "accepted",
        },
      ],
    }),
    forwardTelegramToNativeHandlerLocally: async () => {
      return {
        ok: true,
        status: 200,
        durationMs: 42,
        bodyLength: 0,
        bodyHead: "",
        headers: {
          server: null,
          contentType: "text/plain; charset=utf-8",
          contentLength: null,
          xPoweredBy: null,
          via: null,
          cacheControl: null,
        },
        error: null,
      };
    },
  });

  await processChannelStep("telegram", { update_id: 1 }, "test", "req-local-200", null, {
    dependencies,
  });

  const logs = getServerLogs();
  const summary = logs.find((entry) => entry.message === "channels.telegram_wake_summary");
  assert.ok(summary, "telegram wake summary should be emitted");
  assert.equal(summary.data?.retryingForwardAttempts, 1);
  assert.equal(summary.data?.retryingForwardTransport, "local");
  const attemptTimeline = summary.data?.retryingForwardAttemptTimeline as
    | Array<{ classification?: string }>
    | undefined;
  assert.equal(
    attemptTimeline?.[0]?.classification,
    "accepted",
  );
});

// ===========================================================================
// Slack workflow wake path tests (mirror Telegram coverage)
// ===========================================================================

test("processChannelStep converts retrying Slack forward fetch exception into RetryableError", async () => {
  const dependencies = createWorkflowDependencies({
    forwardToNativeHandlerWithRetry: async () => {
      throw new Error("native_handler_timeout channel=slack timeoutMs=30000");
    },
  });

  await assert.rejects(
    processChannelStep("slack", { event: {} }, "test", "req-slack-fetch", null, { dependencies }),
    (error: unknown) => {
      assert.ok(error instanceof TestRetryableError);
      assert.equal((error as TestRetryableError).retryAfter, "15s");
      return true;
    },
  );
});

test("processChannelStep converts native Slack forward 502 into RetryableError (retrying path)", async () => {
  const dependencies = createWorkflowDependencies({
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => ({
      ok: false,
      status: 502,
      attempts: 6,
      totalMs: 6000,
      transport: "public",
      retries: [{ attempt: 1, reason: "proxy-error", status: 502 }],
    }),
  });

  await assert.rejects(
    processChannelStep("slack", { event: {} }, "test", "req-slack-502", null, { dependencies }),
    (error: unknown) => {
      assert.ok(error instanceof TestRetryableError);
      assert.equal((error as TestRetryableError).retryAfter, "15s");
      return true;
    },
  );
});

test("processChannelStep converts retrying Slack forward 504 (exhausted) into RetryableError", async () => {
  const dependencies = createWorkflowDependencies({
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => ({
      ok: false,
      status: 504,
      attempts: 20,
      totalMs: 45000,
      transport: null,
      retries: [
        { attempt: 1, reason: "handler-not-ready", status: 404 },
        { attempt: 2, reason: "fetch-exception", error: "connect ECONNREFUSED" },
      ],
    }),
  });

  await assert.rejects(
    processChannelStep("slack", { event: {} }, "test", "req-slack-504", null, { dependencies }),
    (error: unknown) => {
      assert.ok(error instanceof TestRetryableError);
      assert.equal((error as TestRetryableError).retryAfter, "15s");
      return true;
    },
  );
});

test("processChannelStep treats Slack retrying forward 500 as retryable at workflow level", async () => {
  const dependencies = createWorkflowDependencies({
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => ({
      ok: false,
      status: 500,
      attempts: 1,
      totalMs: 100,
      transport: "public",
      retries: [],
    }),
  });

  await assert.rejects(
    processChannelStep("slack", { event: {} }, "test", "req-slack-500", null, { dependencies }),
    (error: unknown) => {
      assert.ok(error instanceof TestRetryableError);
      assert.equal((error as TestRetryableError).retryAfter, "15s");
      return true;
    },
  );
});

test("processChannelStep surfaces Slack retrying forward 200 (after 404 recovery) as success", async () => {
  // Simulates the retry wrapper succeeding after several 404 attempts while
  // the Slack Bolt HTTPReceiver finishes registering its /slack/events route.
  let capturedChannel: string | null = null;
  const dependencies = createWorkflowDependencies({
    forwardToNativeHandlerWithRetry: async (channel: unknown): Promise<RetryingForwardResult> => {
      capturedChannel = channel as string;
      return {
        ok: true,
        status: 200,
        attempts: 4,
        totalMs: 6200,
        transport: "public",
        retries: [
          { attempt: 1, reason: "handler-not-ready", status: 404 },
          { attempt: 2, reason: "handler-not-ready", status: 404 },
          { attempt: 3, reason: "handler-not-ready", status: 404 },
        ],
      };
    },
  });

  await processChannelStep("slack", { event: {} }, "test", "req-slack-recover", null, { dependencies });
  assert.equal(capturedChannel, "slack");
});

test("processChannelStep clears Slack boot message after native acceptance", async () => {
  let updateCalls = 0;
  let clearCalls = 0;

  const dependencies = createWorkflowDependencies({
    buildExistingBootHandle: async () => ({
      async update(text: string) {
        updateCalls += 1;
        void text;
      },
      async clear() {
        clearCalls += 1;
      },
    }),
    runWithBootMessages: async () => ({
      meta: asMeta({ status: "running", sandboxId: "sbx-slack-accepted" }),
      bootMessageSent: true,
      admissionReady: true,
    }),
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => ({
      ok: true,
      status: 200,
      attempts: 2,
      totalMs: 250,
      transport: "public",
      retries: [{ attempt: 1, reason: "handler-not-ready", status: 404 }],
    }),
  });

  await processChannelStep(
    "slack",
    { event: { channel: "C-slack-accepted", ts: "1710000000.000444" } },
    "test",
    "req-slack-boot-clear",
    "boot-slack-ts",
    { dependencies },
  );

  assert.equal(updateCalls, 0);
  assert.equal(clearCalls, 1);
  const logs = getServerLogs();
  const cleanupLog = logs.find(
    (entry) => entry.message === "channels.slack_boot_message_cleared_after_accept",
  );
  assert.ok(cleanupLog, "Slack boot cleanup should be logged after native accept");
  assert.equal(cleanupLog?.data?.bootMessageId, "boot-slack-ts");
  assert.equal(cleanupLog?.data?.placeholderAction, "cleared");
});

test("Slack accepted delivery does not replay when cleanup debt persistence fails", async () => {
  const config = {
    signingSecret: "slack-signing-secret",
    botToken: "xoxb-slack-token",
    configuredAt: Date.now(),
  };
  await setSlackChannelConfig(config);
  const store = getStore();
  const originalSetValue = store.setValue.bind(store);
  const setValueMock = mock.method(
    store,
    "setValue",
    async (...args: Parameters<typeof store.setValue>) => {
      if (args[0].includes(":boot-message:")) {
        throw new Error("cleanup debt store unavailable");
      }
      return originalSetValue(...args);
    },
  );
  let forwardCalls = 0;
  const dependencies = createWorkflowDependencies({
    buildExistingBootHandle: async () => ({
      async update() {},
      async clear() {
        throw new Error("Slack cleanup unavailable");
      },
    }),
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-slack-cleanup-debt-failure",
        channels: {
          telegram: null,
          slack: config,
          discord: null,
          whatsapp: null,
        },
      }),
      bootMessageSent: true,
      admissionReady: true,
    }),
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      forwardCalls += 1;
      return {
        ok: true,
        acceptance: "accepted",
        status: 200,
        attempts: 1,
        totalMs: 10,
        transport: "public",
        retries: [],
      };
    },
  });

  try {
    await processChannelStep(
      "slack",
      { event_id: "Ev-cleanup-debt", event: { channel: "C-cleanup-debt" } },
      "test",
      "req-slack-cleanup-debt",
      "boot-cleanup-debt-ts",
      {
        dependencies,
        workflowHandoff: {
          slackCleanupConfig: config,
          slackConfigGeneration: config.configuredAt,
          slackBootTarget: { channel: "C-cleanup-debt", threadTs: null },
        },
      },
    );
    assert.equal(forwardCalls, 1);
    assert.ok(
      getServerLogs().some(
        (entry) =>
          entry.message ===
          "channels.slack_boot_message_cleanup_owner_persist_failed",
      ),
    );
  } finally {
    setValueMock.mock.restore();
  }
});

test("processChannelStep durably retries Slack boot cleanup after API rejection", async () => {
  await setSlackChannelConfig({
    signingSecret: "slack-signing-secret",
    botToken: "xoxb-slack-token",
    configuredAt: Date.now(),
  });
  let deleteCalls = 0;
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith("chat.delete")) {
        deleteCalls += 1;
        return deleteCalls === 1
          ? Response.json({ ok: false, error: "service_unavailable" })
          : Response.json({ ok: true });
      }
      return Response.json({ ok: true });
    },
  );
  let forwardCalls = 0;
  const dependencies = createWorkflowDependencies({
    isRetryable: (error) =>
      (error as { name?: unknown } | null)?.name === "RetryableSendError",
    buildExistingBootHandle,
    runWithBootMessages: async () => ({
      meta: asMeta({ status: "running", sandboxId: "sbx-slack-cleanup-rejected" }),
      bootMessageSent: true,
      admissionReady: true,
    }),
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      forwardCalls += 1;
      return {
        ok: true,
        status: 200,
        attempts: 1,
        totalMs: 50,
        transport: "public",
        retries: [],
      };
    },
  });

  try {
    const run = () =>
      processChannelStep(
        "slack",
        { event: { channel: "C-cleanup", ts: "1710000000.000555" } },
        "test",
        "req-slack-cleanup-rejected",
        "boot-slack-rejected",
        { dependencies },
      );
    await assert.rejects(run(), TestRetryableError);
    await run();

    assert.equal(deleteCalls, 2);
    assert.equal(forwardCalls, 1);
    assert.equal(
      getServerLogs().some(
        (entry) =>
          entry.message === "channels.slack_boot_message_cleared_after_accept",
      ),
      false,
    );
    assert.ok(
      getServerLogs().some(
        (entry) =>
          entry.message ===
          "channels.slack_boot_message_cleanup_after_accept_failed",
      ),
    );
  } finally {
    fetchMock.mock.restore();
  }
});

test("processChannelStep honors Slack cleanup Retry-After without forwarding again", async () => {
  const config = {
    signingSecret: "signing",
    botToken: "rate-token",
    configuredAt: Date.now(),
  };
  await setSlackChannelConfig(config);
  let deleteCalls = 0;
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith("chat.delete")) {
        deleteCalls += 1;
        return deleteCalls === 1
          ? Response.json(
              { ok: false, error: "ratelimited" },
              { status: 429, headers: { "retry-after": "301" } },
            )
          : Response.json({ ok: true });
      }
      return Response.json({ ok: true });
    },
  );
  let forwardCalls = 0;
  const dependencies = createWorkflowDependencies({
    buildExistingBootHandle,
    runWithBootMessages: async () => ({
      meta: asMeta({ status: "running", sandboxId: "sbx-cleanup-rate-limit" }),
      bootMessageSent: true,
      admissionReady: true,
    }),
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      forwardCalls += 1;
      return {
        ok: true,
        acceptance: "accepted",
        status: 200,
        attempts: 1,
        totalMs: 10,
        transport: "public",
        retries: [],
      };
    },
  });
  const run = () =>
    processChannelStep(
      "slack",
      {
        event_id: "Ev-cleanup-rate-limit",
        event: { channel: "C-cleanup-rate-limit" },
      },
      "test",
      "req-cleanup-rate-limit",
      "boot-cleanup-rate-limit",
      {
        dependencies,
        workflowHandoff: {
          slackCleanupConfig: config,
          slackConfigGeneration: config.configuredAt,
          slackBootTarget: {
            channel: "C-cleanup-rate-limit",
            threadTs: null,
          },
        },
      },
    );

  try {
    await assert.rejects(run(), (error: unknown) => {
      assert.ok(error instanceof TestRetryableError);
      assert.equal(error.retryAfter, 301_000);
      return true;
    });
    await run();
    assert.equal(forwardCalls, 1);
    assert.equal(deleteCalls, 2);
  } finally {
    fetchMock.mock.restore();
  }
});

test("processChannelStep exhausts cleanup when Retry-After exceeds its remaining budget", async () => {
  const config = {
    signingSecret: "signing",
    botToken: "rate-token",
    configuredAt: Date.now(),
  };
  await setSlackChannelConfig(config);
  let deleteCalls = 0;
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0]) => {
      if (!String(input).endsWith("chat.delete")) {
        return Response.json({ ok: true });
      }
      deleteCalls += 1;
      return deleteCalls === 1
        ? Response.json({ ok: false, error: "service_unavailable" })
        : Response.json(
            { ok: false, error: "ratelimited" },
            { status: 429, headers: { "retry-after": "301" } },
          );
    },
  );
  let forwardCalls = 0;
  const dependencies = createWorkflowDependencies({
    buildExistingBootHandle,
    runWithBootMessages: async () => ({
      meta: asMeta({ status: "running", sandboxId: "sbx-cleanup-rate-exhausted" }),
      bootMessageSent: true,
      admissionReady: true,
    }),
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      forwardCalls += 1;
      return {
        ok: true,
        acceptance: "accepted",
        status: 200,
        attempts: 1,
        totalMs: 10,
        transport: "public",
        retries: [],
      };
    },
  });
  const run = () =>
    processChannelStep(
      "slack",
      {
        event_id: "Ev-cleanup-rate-exhausted",
        event: { channel: "C-cleanup-rate-exhausted" },
      },
      "test",
      "req-cleanup-rate-exhausted",
      "boot-cleanup-rate-exhausted",
      {
        dependencies,
        workflowHandoff: {
          slackCleanupConfig: config,
          slackConfigGeneration: config.configuredAt,
          slackBootTarget: {
            channel: "C-cleanup-rate-exhausted",
            threadTs: null,
          },
        },
      },
    );
  let nowMs = Date.now();
  const dateMock = mock.method(Date, "now", () => nowMs);

  try {
    await assert.rejects(run(), TestRetryableError);
    nowMs += 5 * 60 * 1000;
    await run();
    assert.equal(forwardCalls, 1);
    assert.equal(deleteCalls, 2);
    const abandoned = getServerLogs().find(
      (entry) =>
        entry.message === "channels.slack_boot_message_cleanup_abandoned" &&
        String(entry.data?.cleanupRetryReason).includes("rate_limit_301000ms"),
    );
    assert.ok(abandoned);
  } finally {
    dateMock.mock.restore();
    fetchMock.mock.restore();
  }
});

test("processChannelStep retries cleanup-only when owner retirement fails after delete", async () => {
  const config = {
    signingSecret: "slack-signing-secret",
    botToken: "xoxb-slack-token",
    configuredAt: Date.now(),
  };
  await setSlackChannelConfig(config);
  const store = getStore();
  const originalDeleteValue = store.deleteValue.bind(store);
  let ownerDeleteFailures = 1;
  const deleteValueMock = mock.method(
    store,
    "deleteValue",
    async (key: string) => {
      if (key.includes(":boot-message:") && ownerDeleteFailures > 0) {
        ownerDeleteFailures -= 1;
        throw new Error("owner retirement unavailable");
      }
      return originalDeleteValue(key);
    },
  );
  let slackDeleteCalls = 0;
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith("chat.delete")) {
        slackDeleteCalls += 1;
        return slackDeleteCalls === 1
          ? Response.json({ ok: true })
          : Response.json({ ok: false, error: "message_not_found" });
      }
      return Response.json({ ok: true });
    },
  );
  let forwardCalls = 0;
  const dependencies = createWorkflowDependencies({
    isRetryable: (error) =>
      (error as { name?: unknown } | null)?.name === "RetryableSendError",
    buildExistingBootHandle,
    runWithBootMessages: async () => ({
      meta: asMeta({ status: "running", sandboxId: "sbx-owner-retire" }),
      bootMessageSent: true,
      admissionReady: true,
    }),
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      forwardCalls += 1;
      return {
        ok: true,
        acceptance: "accepted",
        status: 200,
        attempts: 1,
        totalMs: 10,
        transport: "public",
        retries: [],
      };
    },
  });
  const run = () =>
    processChannelStep(
      "slack",
      { event_id: "Ev-owner-retire", event: { channel: "C-owner-retire" } },
      "test",
      "req-owner-retire",
      "boot-owner-retire",
      {
        dependencies,
        workflowHandoff: {
          slackCleanupConfig: config,
          slackConfigGeneration: config.configuredAt,
          slackBootTarget: { channel: "C-owner-retire", threadTs: null },
        },
      },
    );

  try {
    await assert.rejects(run(), TestRetryableError);
    await run();
    assert.equal(forwardCalls, 1);
    assert.equal(slackDeleteCalls, 2);
  } finally {
    fetchMock.mock.restore();
    deleteValueMock.mock.restore();
  }
});

test("processChannelStep retires cleanup debt on permanent Slack rejection", async () => {
  const config = {
    signingSecret: "slack-signing-secret",
    botToken: "xoxb-revoked",
    configuredAt: Date.now(),
  };
  await setSlackChannelConfig(config);
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0]) =>
      String(input).endsWith("chat.delete")
        ? Response.json({ ok: false, error: "invalid_auth" })
        : Response.json({ ok: true }),
  );
  let forwardCalls = 0;
  const dependencies = createWorkflowDependencies({
    buildExistingBootHandle,
    runWithBootMessages: async () => ({
      meta: asMeta({ status: "running", sandboxId: "sbx-permanent-cleanup" }),
      bootMessageSent: true,
      admissionReady: true,
    }),
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      forwardCalls += 1;
      return {
        ok: true,
        acceptance: "accepted",
        status: 200,
        attempts: 1,
        totalMs: 10,
        transport: "public",
        retries: [],
      };
    },
  });

  try {
    await processChannelStep(
      "slack",
      { event_id: "Ev-permanent-cleanup", event: { channel: "C-permanent" } },
      "test",
      "req-permanent-cleanup",
      "boot-permanent-cleanup",
      {
        dependencies,
        workflowHandoff: {
          slackCleanupConfig: config,
          slackConfigGeneration: config.configuredAt,
          slackBootTarget: { channel: "C-permanent", threadTs: null },
        },
      },
    );
    assert.equal(forwardCalls, 1);
    const abandoned = getServerLogs().find(
      (entry) =>
        entry.message === "channels.slack_boot_message_cleanup_abandoned",
    );
    assert.equal(abandoned?.data?.permanentCleanupFailure, true);
    assert.equal(abandoned?.data?.slackErrorCode, "invalid_auth");
  } finally {
    fetchMock.mock.restore();
  }
});

test("processChannelStep retries invalid_auth cleanup with a rotated same-bot token", async () => {
  const originalConfig = {
    signingSecret: "slack-signing-secret",
    botToken: "xoxb-cleanup-old",
    configuredAt: Date.now(),
    team: "T-cleanup-rotation",
    botId: "B-cleanup-rotation",
  };
  const rotatedConfig = {
    ...originalConfig,
    botToken: "xoxb-cleanup-current",
    configuredAt: originalConfig.configuredAt + 1,
  };
  await setSlackChannelConfig(originalConfig);
  const deleteAuthorizations: string[] = [];
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (!String(input).endsWith("chat.delete")) {
        return Response.json({ ok: true });
      }
      deleteAuthorizations.push(String(new Headers(init?.headers).get("authorization")));
      if (deleteAuthorizations.length === 1) {
        await setSlackChannelConfig(rotatedConfig);
        return Response.json({ ok: false, error: "invalid_auth" });
      }
      return Response.json({ ok: true });
    },
  );
  let forwardCalls = 0;
  const dependencies = createWorkflowDependencies({
    buildExistingBootHandle,
    runWithBootMessages: async () => ({
      meta: asMeta({ status: "running", sandboxId: "sbx-cleanup-rotation" }),
      bootMessageSent: true,
      admissionReady: true,
    }),
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      forwardCalls += 1;
      return {
        ok: true,
        acceptance: "accepted",
        status: 200,
        attempts: 1,
        totalMs: 10,
        transport: "public",
        retries: [],
      };
    },
  });
  const run = () =>
    processChannelStep(
      "slack",
      {
        event_id: "Ev-cleanup-rotation",
        event: { channel: "C-cleanup-rotation" },
      },
      "test",
      "req-cleanup-rotation",
      "boot-cleanup-rotation",
      {
        dependencies,
        workflowHandoff: {
          slackCleanupConfig: originalConfig,
          slackConfigGeneration: originalConfig.configuredAt,
          slackBootTarget: {
            channel: "C-cleanup-rotation",
            threadTs: null,
          },
        },
      },
    );

  try {
    await assert.rejects(run(), TestRetryableError);
    assert.equal(
      getServerLogs().some(
        (entry) =>
          entry.message === "channels.slack_boot_message_cleanup_abandoned",
      ),
      false,
    );
    await run();
    assert.equal(forwardCalls, 1);
    assert.deepEqual(deleteAuthorizations, [
      `Bearer ${originalConfig.botToken}`,
      `Bearer ${rotatedConfig.botToken}`,
    ]);
    assert.ok(
      getServerLogs().some(
        (entry) =>
          entry.message ===
          "channels.slack_boot_message_cleanup_credential_refreshed",
      ),
    );
  } finally {
    fetchMock.mock.restore();
  }
});

test("processChannelStep retires cleanup after the rotated token also rejects", async () => {
  const originalConfig = {
    signingSecret: "slack-signing-secret",
    botToken: "xoxb-cleanup-old-terminal",
    configuredAt: Date.now(),
    team: "T-cleanup-rotation-terminal",
    botId: "B-cleanup-rotation-terminal",
  };
  const rotatedConfig = {
    ...originalConfig,
    botToken: "xoxb-cleanup-current-terminal",
    configuredAt: originalConfig.configuredAt + 1,
  };
  await setSlackChannelConfig(originalConfig);
  const deleteAuthorizations: string[] = [];
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (!String(input).endsWith("chat.delete")) {
        return Response.json({ ok: true });
      }
      deleteAuthorizations.push(String(new Headers(init?.headers).get("authorization")));
      if (deleteAuthorizations.length === 1) {
        await setSlackChannelConfig(rotatedConfig);
      }
      return Response.json({ ok: false, error: "invalid_auth" });
    },
  );
  let forwardCalls = 0;
  const dependencies = createWorkflowDependencies({
    buildExistingBootHandle,
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-cleanup-rotation-terminal",
      }),
      bootMessageSent: true,
      admissionReady: true,
    }),
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      forwardCalls += 1;
      return {
        ok: true,
        acceptance: "accepted",
        status: 200,
        attempts: 1,
        totalMs: 10,
        transport: "public",
        retries: [],
      };
    },
  });
  const run = () =>
    processChannelStep(
      "slack",
      {
        event_id: "Ev-cleanup-rotation-terminal",
        event: { channel: "C-cleanup-rotation-terminal" },
      },
      "test",
      "req-cleanup-rotation-terminal",
      "boot-cleanup-rotation-terminal",
      {
        dependencies,
        workflowHandoff: {
          slackCleanupConfig: originalConfig,
          slackConfigGeneration: originalConfig.configuredAt,
          slackBootTarget: {
            channel: "C-cleanup-rotation-terminal",
            threadTs: null,
          },
        },
      },
    );

  try {
    await assert.rejects(run(), TestRetryableError);
    await run();
    assert.equal(forwardCalls, 1);
    assert.deepEqual(deleteAuthorizations, [
      `Bearer ${originalConfig.botToken}`,
      `Bearer ${rotatedConfig.botToken}`,
    ]);
    const abandoned = getServerLogs().find(
      (entry) =>
        entry.message === "channels.slack_boot_message_cleanup_abandoned",
    );
    assert.equal(abandoned?.data?.permanentCleanupFailure, true);
    assert.equal(abandoned?.data?.slackErrorCode, "invalid_auth");
  } finally {
    fetchMock.mock.restore();
  }
});

test("processChannelStep keeps cleanup ledger store failures out of delivery failure", async () => {
  const config = {
    signingSecret: "slack-signing-secret",
    botToken: "xoxb-cleanup-ledger",
    configuredAt: Date.now(),
  };
  await setSlackChannelConfig(config);
  const store = getStore();
  const originalSetValue = store.setValue.bind(store);
  const originalCompareAndSetValueToken =
    store.compareAndSetValueToken.bind(store);
  let failResolvedFence = false;
  let failedResolvedFenceWrites = 0;
  let failCleanupCas = false;
  const setValueMock = mock.method(
    store,
    "setValue",
    async (...args: Parameters<typeof store.setValue>) => {
      if (
        failResolvedFence &&
        failedResolvedFenceWrites < 5 &&
        args[0].includes(":failed-resolved:")
      ) {
        failedResolvedFenceWrites += 1;
        throw new Error("accepted fence store unavailable");
      }
      return originalSetValue(...args);
    },
  );
  const compareAndSetValueTokenMock = mock.method(
    store,
    "compareAndSetValueToken",
    async (...args: Parameters<typeof store.compareAndSetValueToken>) => {
      if (failCleanupCas && args[0].includes(":boot-message:")) {
        failCleanupCas = false;
        throw new Error("cleanup owner CAS unavailable");
      }
      return originalCompareAndSetValueToken(...args);
    },
  );
  let deleteCalls = 0;
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith("chat.delete")) {
        deleteCalls += 1;
        return deleteCalls === 1
          ? Response.json({ ok: false, error: "service_unavailable" })
          : Response.json({ ok: true });
      }
      return Response.json({ ok: true });
    },
  );
  let forwardCalls = 0;
  const dependencies = createWorkflowDependencies({
    buildExistingBootHandle,
    runWithBootMessages: async () => ({
      meta: asMeta({ status: "running", sandboxId: "sbx-cleanup-ledger" }),
      bootMessageSent: true,
      admissionReady: true,
    }),
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      forwardCalls += 1;
      return {
        ok: true,
        acceptance: "accepted",
        status: 200,
        attempts: 1,
        totalMs: 10,
        transport: "public",
        retries: [],
      };
    },
  });
  const run = () =>
    processChannelStep(
      "slack",
      { event_id: "Ev-cleanup-ledger", event: { channel: "C-cleanup-ledger" } },
      "test",
      "req-cleanup-ledger",
      "boot-cleanup-ledger",
      {
        dependencies,
        workflowHandoff: {
          slackCleanupConfig: config,
          slackConfigGeneration: config.configuredAt,
          slackBootTarget: { channel: "C-cleanup-ledger", threadTs: null },
        },
      },
    );

  try {
    await assert.rejects(run(), TestRetryableError);
    failResolvedFence = true;
    await assert.rejects(run(), TestRetryableError);
    failResolvedFence = false;
    failCleanupCas = true;
    await assert.rejects(run(), TestRetryableError);
    await run();
    assert.equal(forwardCalls, 1);
    assert.equal(deleteCalls, 2);
    assert.equal(
      getServerLogs().some(
        (entry) =>
          entry.message === "channels.workflow_retryable_failure_recorded" ||
          entry.message === "channels.workflow_terminal_failure_recorded",
      ),
      false,
    );
  } finally {
    fetchMock.mock.restore();
    compareAndSetValueTokenMock.mock.restore();
    setValueMock.mock.restore();
  }
});

test("processChannelStep gives accepted cleanup a fresh retry budget", async () => {
  const config = {
    signingSecret: "slack-signing-secret",
    botToken: "xoxb-transient",
    configuredAt: Date.now(),
  };
  await setSlackChannelConfig(config);
  let deleteCalls = 0;
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith("chat.delete")) {
        deleteCalls += 1;
        return Response.json({ ok: false, error: "service_unavailable" });
      }
      return Response.json({ ok: true });
    },
  );
  let forwardCalls = 0;
  const dependencies = createWorkflowDependencies({
    buildExistingBootHandle,
    getStepMetadata: (() => ({
      stepName: "processChannelStep",
      stepId: "cleanup-budget-step",
      stepStartedAt: new Date(),
      attempt: 25,
    })) as never,
    runWithBootMessages: async () => ({
      meta: asMeta({ status: "running", sandboxId: "sbx-cleanup-budget" }),
      bootMessageSent: true,
      admissionReady: true,
    }),
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      forwardCalls += 1;
      return {
        ok: true,
        acceptance: "accepted",
        status: 200,
        attempts: 1,
        totalMs: 10,
        transport: "public",
        retries: [],
      };
    },
  });

  try {
    await assert.rejects(
      processChannelStep(
        "slack",
        { event_id: "Ev-cleanup-budget", event: { channel: "C-budget" } },
        "test",
        "req-cleanup-budget",
        "boot-cleanup-budget",
        {
          dependencies,
          receivedAtMs: Date.now() - 2 * 60 * 60 * 1000,
          workflowHandoff: {
            slackCleanupConfig: config,
            slackConfigGeneration: config.configuredAt,
            slackBootTarget: { channel: "C-budget", threadTs: null },
          },
        },
      ),
      TestRetryableError,
    );
    assert.equal(forwardCalls, 1);
    assert.equal(deleteCalls, 1);
    assert.equal(
      getServerLogs().some(
        (entry) =>
          entry.message === "channels.slack_boot_message_cleanup_abandoned",
      ),
      false,
    );
  } finally {
    fetchMock.mock.restore();
  }
});

test("processChannelStep bounds accepted cleanup by its persisted attempt count", async () => {
  const config = {
    signingSecret: "slack-signing-secret",
    botToken: "xoxb-cleanup-attempt-cap",
    configuredAt: Date.now(),
  };
  await setSlackChannelConfig(config);
  let deleteCalls = 0;
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith("chat.delete")) {
        deleteCalls += 1;
        return Response.json({ ok: false, error: "service_unavailable" });
      }
      return Response.json({ ok: true });
    },
  );
  let forwardCalls = 0;
  const dependencies = createWorkflowDependencies({
    buildExistingBootHandle,
    runWithBootMessages: async () => ({
      meta: asMeta({ status: "running", sandboxId: "sbx-cleanup-attempt-cap" }),
      bootMessageSent: true,
      admissionReady: true,
    }),
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      forwardCalls += 1;
      return {
        ok: true,
        acceptance: "accepted",
        status: 200,
        attempts: 1,
        totalMs: 10,
        transport: "public",
        retries: [],
      };
    },
  });
  const run = () =>
    processChannelStep(
      "slack",
      {
        event_id: "Ev-cleanup-attempt-cap",
        event: { channel: "C-cleanup-attempt-cap" },
      },
      "test",
      "req-cleanup-attempt-cap",
      "boot-cleanup-attempt-cap",
      {
        dependencies,
        workflowHandoff: {
          slackCleanupConfig: config,
          slackConfigGeneration: config.configuredAt,
          slackBootTarget: {
            channel: "C-cleanup-attempt-cap",
            threadTs: null,
          },
        },
      },
    );

  try {
    for (let attempt = 1; attempt < 25; attempt += 1) {
      await assert.rejects(run(), TestRetryableError);
    }
    await run();
    assert.equal(forwardCalls, 1);
    assert.equal(deleteCalls, 25);
    const abandoned = getServerLogs().find(
      (entry) =>
        entry.message === "channels.slack_boot_message_cleanup_abandoned",
    );
    assert.equal(abandoned?.data?.permanentCleanupFailure, false);
    assert.equal(abandoned?.data?.cleanupAttempt, 25);
    assert.match(
      String(abandoned?.data?.cleanupRetryReason),
      /25_attempts/,
    );
  } finally {
    fetchMock.mock.restore();
  }
});

test("processChannelStep bounds accepted cleanup by its persisted elapsed time", async () => {
  const config = {
    signingSecret: "slack-signing-secret",
    botToken: "xoxb-cleanup-wall-clock",
    configuredAt: Date.now(),
  };
  await setSlackChannelConfig(config);
  let deleteCalls = 0;
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith("chat.delete")) {
        deleteCalls += 1;
        return Response.json({ ok: false, error: "service_unavailable" });
      }
      return Response.json({ ok: true });
    },
  );
  let forwardCalls = 0;
  const dependencies = createWorkflowDependencies({
    buildExistingBootHandle,
    runWithBootMessages: async () => ({
      meta: asMeta({ status: "running", sandboxId: "sbx-cleanup-wall-clock" }),
      bootMessageSent: true,
      admissionReady: true,
    }),
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      forwardCalls += 1;
      return {
        ok: true,
        acceptance: "accepted",
        status: 200,
        attempts: 1,
        totalMs: 10,
        transport: "public",
        retries: [],
      };
    },
  });
  const run = () =>
    processChannelStep(
      "slack",
      {
        event_id: "Ev-cleanup-wall-clock",
        event: { channel: "C-cleanup-wall-clock" },
      },
      "test",
      "req-cleanup-wall-clock",
      "boot-cleanup-wall-clock",
      {
        dependencies,
        workflowHandoff: {
          slackCleanupConfig: config,
          slackConfigGeneration: config.configuredAt,
          slackBootTarget: {
            channel: "C-cleanup-wall-clock",
            threadTs: null,
          },
        },
      },
    );
  let nowMs = Date.now();
  const dateMock = mock.method(Date, "now", () => nowMs);

  try {
    await assert.rejects(run(), TestRetryableError);
    nowMs += 10 * 60 * 1000;
    await run();
    assert.equal(forwardCalls, 1);
    assert.equal(deleteCalls, 1);
    const abandoned = getServerLogs().find(
      (entry) =>
        entry.message === "channels.slack_boot_message_cleanup_abandoned",
    );
    assert.equal(abandoned?.data?.cleanupAttempt, 1);
    assert.equal(abandoned?.data?.cleanupElapsedMs, 10 * 60 * 1000);
  } finally {
    dateMock.mock.restore();
    fetchMock.mock.restore();
  }
});

test("processChannelStep repairs stopped-sandbox Slack config sync before forwarding", async () => {
  const config = {
    signingSecret: "slack-signing-secret",
    botToken: "xoxb-stopped-setup",
    configuredAt: Date.now(),
    liveConfigSync: {
      outcome: "skipped" as const,
      reason: "sandbox_not_running",
      liveConfigFresh: false,
      checkedAt: Date.now(),
    },
  };
  await setSlackChannelConfig(config);
  let syncCalls = 0;
  let forwardCalls = 0;
  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-cold-slack",
        channels: {
          telegram: null,
          slack: config,
          discord: null,
          whatsapp: null,
        },
      }),
      bootMessageSent: false,
      admissionReady: true,
    }),
    syncGatewayConfigToSandbox: async () => {
      syncCalls += 1;
      return {
        outcome: "applied",
        reason: "config_written_and_restarted",
        liveConfigFresh: true,
        operatorMessage: null,
      };
    },
    forwardToNativeHandlerWithRetry: async () => {
      forwardCalls += 1;
      return {
        ok: true,
        acceptance: "accepted",
        status: 200,
        attempts: 1,
        totalMs: 1,
        transport: "public",
        retries: [],
      };
    },
  });

  await processChannelStep(
    "slack",
    { event_id: "Ev_cold_setup" },
    "https://host.example",
    "req-cold-setup",
    null,
    {
      dependencies,
      requireSlackConfigGeneration: true,
      workflowHandoff: {
        slackCleanupConfig: config,
        slackConfigGeneration: config.configuredAt,
        slackRawBody: '{"event_id":"Ev_cold_setup"}',
        slackForwardHeaders: {
          "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
          "x-slack-signature": "v0=old",
        },
      },
    },
  );

  assert.equal(syncCalls, 1);
  assert.equal(forwardCalls, 1);
  assert.equal(
    (await getInitializedMeta()).channels.slack?.liveConfigSync?.liveConfigFresh,
    true,
  );
});

test("processChannelStep creates and clears the Slack placeholder inside durable workflow", async () => {
  const config = {
    signingSecret: "slack-signing-secret",
    botToken: "xoxb-slack-token",
    configuredAt: Date.now(),
  };
  await setSlackChannelConfig(config);
  const calls: string[] = [];
  const postBodies: Array<Record<string, unknown>> = [];
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("chat.postMessage")) {
        postBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ ok: true, ts: "boot-durable-ts" });
      }
      if (url.endsWith("chat.delete")) {
        return Response.json({ ok: true });
      }
      throw new Error(`unexpected Slack API call: ${url}`);
    },
  );
  const dependencies = createWorkflowDependencies({
    buildExistingBootHandle,
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-slack-durable-placeholder",
        channels: {
          telegram: null,
          slack: config,
          discord: null,
          whatsapp: null,
        },
      }),
      bootMessageSent: true,
      admissionReady: true,
    }),
  });

  try {
    await processChannelStep(
      "slack",
      { event_id: "Ev-durable", event: { channel: "C-durable" } },
      "test",
      "req-slack-durable",
      null,
      {
        dependencies,
        workflowHandoff: {
          slackCleanupConfig: {
            botToken: config.botToken,
            configuredAt: config.configuredAt,
          },
          slackConfigGeneration: config.configuredAt,
          slackBootTarget: { channel: "C-durable", threadTs: "thread-1" },
        },
      },
    );
    assert.deepEqual(calls, [
      "https://slack.com/api/chat.postMessage",
      "https://slack.com/api/chat.delete",
    ]);
    assert.match(
      String(postBodies[0]?.client_msg_id),
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  } finally {
    fetchMock.mock.restore();
  }
});

test("Slack accepted-placeholder cleanup retries without forwarding twice", async () => {
  const config = {
    signingSecret: "slack-signing-secret",
    botToken: "xoxb-slack-token",
    configuredAt: Date.now(),
  };
  await setSlackChannelConfig(config);
  let deleteCalls = 0;
  let forwardCalls = 0;
  let postCalls = 0;
  let clientMessageId: string | null = null;
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = String(input);
      if (url.endsWith("chat.postMessage")) {
        postCalls += 1;
        clientMessageId = String(
          JSON.parse(String(init?.body))?.client_msg_id ?? "",
        );
        return Response.json({ ok: true, ts: "boot-cleanup-retry-ts" });
      }
      if (url.endsWith("chat.delete")) {
        deleteCalls += 1;
        return deleteCalls === 1
          ? Response.json({ ok: false, error: "service_unavailable" })
          : Response.json({ ok: true });
      }
      throw new Error(`unexpected Slack API call: ${url}`);
    },
  );
  const dependencies = createWorkflowDependencies({
    isRetryable: (error) =>
      (error as { name?: unknown } | null)?.name === "RetryableSendError",
    buildExistingBootHandle,
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-slack-cleanup-retry",
        channels: {
          telegram: null,
          slack: config,
          discord: null,
          whatsapp: null,
        },
      }),
      bootMessageSent: true,
      admissionReady: true,
    }),
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      forwardCalls += 1;
      return {
        ok: true,
        acceptance: "accepted",
        status: 200,
        attempts: 1,
        totalMs: 10,
        transport: "public",
        retries: [],
      };
    },
  });
  const run = () =>
    processChannelStep(
      "slack",
      { event_id: "Ev-cleanup-retry", event: { channel: "C-cleanup-retry" } },
      "test",
      "req-slack-cleanup-retry",
      null,
      {
        dependencies,
        receivedAtMs: Date.now(),
        workflowHandoff: {
          slackCleanupConfig: {
            botToken: config.botToken,
            configuredAt: config.configuredAt,
          },
          slackConfigGeneration: config.configuredAt,
          slackBootTarget: { channel: "C-cleanup-retry", threadTs: null },
        },
      },
    );

  try {
    await assert.rejects(run(), TestRetryableError);
    assert.equal(
      await getChannelDlqRecord("slack", "slack:Ev-cleanup-retry"),
      null,
    );
    await setSlackChannelConfig({
      ...config,
      botToken: "xoxb-rotated-after-accept",
      configuredAt: config.configuredAt + 1,
    });
    await run();
    assert.equal(forwardCalls, 1);
    assert.equal(postCalls, 1);
    assert.equal(deleteCalls, 2);
    assert.ok(clientMessageId);
    assert.equal(
      await getStore().getValue(
        channelBootMessageKey("slack", clientMessageId),
      ),
      null,
    );
    assert.equal(
      await getChannelDlqRecord("slack", "slack:Ev-cleanup-retry"),
      null,
    );
    const accepted = (await getInitializedMeta()).channelDiagnostics?.slack
      ?.lastForward;
    assert.equal(accepted?.deliveryId, "slack:Ev-cleanup-retry");
    assert.equal(accepted?.ok, true);
    assert.equal(accepted?.classification, "accepted");
  } finally {
    fetchMock.mock.restore();
  }
});

test("Slack workflow retry reuses one persisted placeholder", async () => {
  const config = {
    signingSecret: "slack-signing-secret",
    botToken: "xoxb-slack-token",
    configuredAt: Date.now(),
  };
  await setSlackChannelConfig(config);
  const calls: string[] = [];
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("chat.postMessage")) {
        return Response.json({ ok: true, ts: "boot-retry-ts" });
      }
      return Response.json({ ok: true });
    },
  );
  let forwardCalls = 0;
  const dependencies = createWorkflowDependencies({
    buildExistingBootHandle,
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-slack-retry-placeholder",
        channels: {
          telegram: null,
          slack: config,
          discord: null,
          whatsapp: null,
        },
      }),
      bootMessageSent: true,
      admissionReady: true,
    }),
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      forwardCalls += 1;
      return forwardCalls === 1
        ? {
            ok: false,
            acceptance: "rejected",
            status: 502,
            attempts: 1,
            totalMs: 50,
            transport: "public",
            retries: [],
          }
        : {
            ok: true,
            acceptance: "accepted",
            status: 200,
            attempts: 1,
            totalMs: 50,
            transport: "public",
            retries: [],
          };
    },
  });
  const run = () =>
    processChannelStep(
      "slack",
      { event_id: "Ev-retry", event: { channel: "C-retry" } },
      "test",
      "req-slack-retry",
      null,
      {
        dependencies,
        workflowHandoff: {
          slackCleanupConfig: {
            botToken: config.botToken,
            configuredAt: config.configuredAt,
          },
          slackConfigGeneration: config.configuredAt,
          slackBootTarget: { channel: "C-retry", threadTs: null },
        },
      },
    );

  try {
    await assert.rejects(run(), TestRetryableError);
    await run();
    assert.equal(
      calls.filter((url) => url.endsWith("chat.postMessage")).length,
      1,
    );
    assert.equal(
      calls.filter((url) => url.endsWith("chat.update")).length,
      2,
    );
    assert.equal(
      calls.filter((url) => url.endsWith("chat.delete")).length,
      1,
    );
  } finally {
    fetchMock.mock.restore();
  }
});

test("Slack reconciles provider acceptance lost before the local sent record", async () => {
  const config = {
    signingSecret: "slack-signing-secret",
    botToken: "xoxb-slack-token",
    configuredAt: Date.now(),
  };
  await setSlackChannelConfig(config);
  const clientMessageId = "5aa26f2b-52ee-5ef0-a512-d33969f4dabc";
  const acceptedMessages = new Map<string, string>();
  const postedClientMessageIds: string[] = [];
  let loseFirstResponse = true;
  let deleteCalls = 0;
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = String(input);
      if (url.endsWith("chat.delete")) {
        deleteCalls += 1;
        return Response.json({ ok: true });
      }
      assert.ok(url.endsWith("chat.postMessage"));
      const body = JSON.parse(String(init?.body)) as {
        client_msg_id: string;
      };
      postedClientMessageIds.push(body.client_msg_id);
      const messageTs =
        acceptedMessages.get(body.client_msg_id) ?? "boot-accepted-once-ts";
      acceptedMessages.set(body.client_msg_id, messageTs);
      if (loseFirstResponse) {
        loseFirstResponse = false;
        throw new Error("socket closed after Slack accepted request");
      }
      return Response.json({ ok: true, ts: messageTs });
    },
  );

  try {
    await assert.rejects(
      buildExistingBootHandle(
        "slack",
        { event: { channel: "C-crash-window" } },
        null,
        { slack: config },
        { channel: "C-crash-window", threadTs: null },
        clientMessageId,
      ),
      (error: unknown) => {
        assert.equal((error as Error).name, "RetryableSendError");
        return true;
      },
    );
    assert.deepEqual(
      await getStore().getValue(
        channelBootMessageKey("slack", clientMessageId),
      ),
      {
        channel: "C-crash-window",
        configuredAt: config.configuredAt,
        clientMessageId,
        state: "posting",
      },
    );

    const recoveredHandle = await buildExistingBootHandle(
      "slack",
      { event: { channel: "C-crash-window" } },
      null,
      { slack: config },
      { channel: "C-crash-window", threadTs: null },
      clientMessageId,
    );
    assert.ok(recoveredHandle);
    assert.deepEqual(postedClientMessageIds, [clientMessageId, clientMessageId]);
    assert.equal(acceptedMessages.size, 1);
    assert.deepEqual(
      await getStore().getValue(
        channelBootMessageKey("slack", clientMessageId),
      ),
      {
        channel: "C-crash-window",
        configuredAt: config.configuredAt,
        clientMessageId,
        state: "sent",
        messageId: "boot-accepted-once-ts",
      },
    );

    await recoveredHandle.clear();
    assert.equal(deleteCalls, 1);
    assert.equal(
      await getStore().getValue(
        channelBootMessageKey("slack", clientMessageId),
      ),
      null,
    );
  } finally {
    fetchMock.mock.restore();
  }
});

test("Slack deletes an accepted placeholder when the sent record cannot persist", async () => {
  const config = {
    signingSecret: "slack-signing-secret",
    botToken: "xoxb-slack-token",
    configuredAt: Date.now(),
  };
  await setSlackChannelConfig(config);
  const clientMessageId = "967748eb-2110-5e83-a534-17a266b708fc";
  const recordKey = channelBootMessageKey("slack", clientMessageId);
  const store = getStore();
  const setValue = store.setValue.bind(store);
  store.setValue = async <T>(key: string, value: T, ttlSeconds?: number) => {
    if (
      key === recordKey &&
      (value as { state?: string }).state === "sent"
    ) {
      throw new Error("durable store unavailable after Slack accepted");
    }
    await setValue(key, value, ttlSeconds);
  };
  let deleteCalls = 0;
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("chat.postMessage")) {
        return Response.json({ ok: true, ts: "boot-needs-cleanup-ts" });
      }
      assert.ok(url.endsWith("chat.delete"));
      deleteCalls += 1;
      return Response.json({ ok: true });
    },
  );

  try {
    await assert.rejects(
      buildExistingBootHandle(
        "slack",
        { event: { channel: "C-store-failure" } },
        null,
        { slack: config },
        { channel: "C-store-failure", threadTs: null },
        clientMessageId,
      ),
      (error: unknown) => {
        assert.equal((error as Error).name, "RetryableSendError");
        return true;
      },
    );
    assert.equal(deleteCalls, 1);
  } finally {
    store.setValue = setValue;
    fetchMock.mock.restore();
  }
});

test("Slack reconciles a posting intent with the rotated same-bot token", async () => {
  const originalConfig = {
    signingSecret: "original-signing-secret",
    botToken: "xoxb-original-token",
    configuredAt: Date.now(),
    team: "T-same",
    botId: "B-same",
  };
  const currentConfig = {
    ...originalConfig,
    signingSecret: "current-signing-secret",
    botToken: "xoxb-current-token",
    configuredAt: originalConfig.configuredAt + 1,
  };
  await setSlackChannelConfig(currentConfig);
  const clientMessageId = "bfa76d1d-071d-54f3-a65e-412f908c1912";
  await getStore().setValue(
    channelBootMessageKey("slack", clientMessageId),
    {
      channel: "C-rotated-reconcile",
      configuredAt: originalConfig.configuredAt,
      clientMessageId,
      team: originalConfig.team,
      botId: originalConfig.botId,
      state: "posting",
    },
    3600,
  );
  const authorizations: string[] = [];
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      authorizations.push(
        new Headers(init?.headers).get("authorization") ?? "",
      );
      return String(input).endsWith("chat.postMessage")
        ? Response.json({ ok: true, ts: "boot-rotated-reconcile-ts" })
        : Response.json({ ok: true });
    },
  );

  try {
    const handle = await buildExistingBootHandle(
      "slack",
      { event: { channel: "C-rotated-reconcile" } },
      null,
      { slack: originalConfig },
      { channel: "C-rotated-reconcile", threadTs: null },
      clientMessageId,
    );
    assert.ok(handle);
    await handle.clear();
    assert.deepEqual(authorizations, [
      "Bearer xoxb-current-token",
      "Bearer xoxb-current-token",
    ]);
  } finally {
    fetchMock.mock.restore();
  }
});

test("Slack retains posting intent when reconciliation gets a definite 4xx", async () => {
  const config = {
    signingSecret: "slack-signing-secret",
    botToken: "xoxb-slack-token",
    configuredAt: Date.now(),
  };
  await setSlackChannelConfig(config);
  const clientMessageId = "25a22523-462b-53f1-afbf-c00a6ddca5fc";
  const recordKey = channelBootMessageKey("slack", clientMessageId);
  await getStore().setValue(
    recordKey,
    {
      channel: "C-reconcile-4xx",
      configuredAt: config.configuredAt,
      clientMessageId,
      state: "posting",
    },
    3600,
  );
  const fetchMock = mock.method(globalThis, "fetch", async () =>
    Response.json({ ok: false, error: "not_in_channel" }),
  );

  try {
    await assert.rejects(
      buildExistingBootHandle(
        "slack",
        { event: { channel: "C-reconcile-4xx" } },
        null,
        { slack: config },
        { channel: "C-reconcile-4xx", threadTs: null },
        clientMessageId,
      ),
      (error: unknown) => (error as Error).name === "RetryableSendError",
    );
    assert.equal(
      (
        await getStore().getValue<{ state: string }>(recordKey)
      )?.state,
      "posting",
    );
  } finally {
    fetchMock.mock.restore();
  }
});

test("Slack preserves a sent record when its read is unavailable", async () => {
  const config = {
    signingSecret: "slack-signing-secret",
    botToken: "xoxb-slack-token",
    configuredAt: Date.now(),
  };
  await setSlackChannelConfig(config);
  const clientMessageId = "4703daa7-c26e-5727-a4ff-870ce75c65ef";
  const recordKey = channelBootMessageKey("slack", clientMessageId);
  const store = getStore();
  const sentRecord = {
    channel: "C-read-failure",
    configuredAt: config.configuredAt,
    clientMessageId,
    state: "sent",
    messageId: "boot-preserved-ts",
  } as const;
  await store.setValue(recordKey, sentRecord, 3600);
  const getValue = store.getValue.bind(store);
  let failRecordRead = true;
  store.getValue = async <T>(key: string) => {
    if (key === recordKey && failRecordRead) {
      failRecordRead = false;
      throw new Error("intent read unavailable");
    }
    return getValue<T>(key);
  };
  let fetchCalls = 0;
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    fetchCalls += 1;
    throw new Error("Slack must not be called when intent read is unavailable");
  });

  try {
    await assert.rejects(
      buildExistingBootHandle(
        "slack",
        { event: { channel: "C-read-failure" } },
        null,
        { slack: config },
        { channel: "C-read-failure", threadTs: null },
        clientMessageId,
      ),
      (error: unknown) => (error as Error).name === "RetryableSendError",
    );
    assert.equal(fetchCalls, 0);
    assert.deepEqual(await getValue(recordKey), sentRecord);
  } finally {
    store.getValue = getValue;
    fetchMock.mock.restore();
  }
});

test("Telegram Workflow retry never posts a non-idempotent wake placeholder", async () => {
  const config = createFallbackTelegramConfig();
  await setTelegramChannelConfig(config);
  let telegramApiCalls = 0;
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    telegramApiCalls += 1;
    throw new Error("Telegram API must not be called for a cold placeholder");
  });
  let forwardCalls = 0;
  const dependencies = createWorkflowDependencies({
    buildExistingBootHandle,
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-telegram-no-placeholder",
        channels: {
          telegram: config,
          slack: null,
          discord: null,
          whatsapp: null,
        },
      }),
      bootMessageSent: false,
      admissionReady: true,
    }),
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      forwardCalls += 1;
      return forwardCalls === 1
        ? {
            ok: false,
            acceptance: "rejected",
            status: 502,
            attempts: 1,
            totalMs: 50,
            transport: "local",
            retries: [],
          }
        : {
            ok: true,
            acceptance: "accepted",
            status: 200,
            attempts: 1,
            totalMs: 50,
            transport: "local",
            retries: [],
          };
    },
  });
  const run = () =>
    processChannelStep(
      "telegram",
      { update_id: 801, message: { chat: { id: 42 } } },
      "test",
      "req-telegram-no-placeholder",
      null,
      {
        dependencies,
        requireTelegramConfigGeneration: true,
        workflowHandoff: {
          fallbackTelegramConfig: config,
          telegramConfigGeneration: config.configuredAt,
          telegramDeliveryId: "telegram:801",
          telegramBootTarget: { chatId: 42, threadId: null },
        },
      },
    );

  try {
    await assert.rejects(run(), TestRetryableError);
    await run();
    assert.equal(forwardCalls, 2);
    assert.equal(telegramApiCalls, 0);
  } finally {
    fetchMock.mock.restore();
  }
});

test("Slack placeholder construction failure is recorded by workflow catch", async () => {
  const config = {
    signingSecret: "slack-signing-secret",
    botToken: "xoxb-slack-token",
    configuredAt: Date.now(),
  };
  await setSlackChannelConfig(config);
  const dependencies = createWorkflowDependencies({
    buildExistingBootHandle: async () => {
      throw new Error("placeholder_post_succeeded_then_record_failed");
    },
  });

  await assert.rejects(
    processChannelStep(
      "slack",
      { event_id: "Ev-placeholder-failed", event: { channel: "C-failed" } },
      "test",
      "req-slack-placeholder-failed",
      null,
      {
        dependencies,
        workflowHandoff: {
          slackCleanupConfig: {
            botToken: config.botToken,
            configuredAt: config.configuredAt,
          },
          slackConfigGeneration: config.configuredAt,
          slackBootTarget: { channel: "C-failed", threadTs: null },
        },
      },
    ),
    TestFatalError,
  );
  const failure = await getChannelDlqRecord(
    "slack",
    "slack:Ev-placeholder-failed",
  );
  assert.equal(failure?.terminal, true);
  assert.equal(failure?.errorMessage, "placeholder_post_succeeded_then_record_failed");
});

test("stale Slack handoff cleans a legacy placeholder before wake", async () => {
  const originalConfig = {
    signingSecret: "original-signing-secret",
    botToken: "xoxb-original-token",
    configuredAt: Date.now(),
  };
  await setSlackChannelConfig({
    ...originalConfig,
    botToken: "xoxb-current-token",
    configuredAt: originalConfig.configuredAt + 1,
  });
  let deleteAuthorization: string | null = null;
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      deleteAuthorization = new Headers(init?.headers).get("authorization");
      return Response.json({ ok: true });
    },
  );
  let wakeCalls = 0;
  const dependencies = createWorkflowDependencies({
    buildExistingBootHandle,
    runWithBootMessages: async () => {
      wakeCalls += 1;
      throw new Error("must not wake stale Slack handoff");
    },
  });

  try {
    await processChannelStep(
      "slack",
      { event_id: "Ev-stale-start", event: { channel: "C-stale-start" } },
      "test",
      "req-slack-stale-start",
      "legacy-boot-ts",
      {
        dependencies,
        workflowHandoff: {
          slackCleanupConfig: {
            botToken: originalConfig.botToken,
            configuredAt: originalConfig.configuredAt,
          },
          slackConfigGeneration: originalConfig.configuredAt,
        },
      },
    );
    assert.equal(wakeCalls, 0);
    assert.equal(deleteAuthorization, "Bearer xoxb-original-token");
  } finally {
    fetchMock.mock.restore();
  }
});

test("Slack placeholder update rejects a 200 response with ok false", async () => {
  const config = {
    signingSecret: "slack-signing-secret",
    botToken: "xoxb-slack-token",
    configuredAt: Date.now(),
  };
  await setSlackChannelConfig(config);
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      return url.endsWith("chat.postMessage")
        ? Response.json({ ok: true, ts: "boot-update-ts" })
        : Response.json({ ok: false, error: "message_not_found" });
    },
  );

  try {
    const handle = await buildExistingBootHandle(
      "slack",
      { event: { channel: "C-update" } },
      null,
      { slack: config },
      { channel: "C-update", threadTs: null },
    );
    assert.ok(handle);
    await assert.rejects(
      handle.update("still waking"),
      /message_not_found/,
    );
  } finally {
    fetchMock.mock.restore();
  }
});

test("processChannelStep cleans a Slack boot message with its handoff credential after rotation", async () => {
  const originalConfig = {
    signingSecret: "original-signing-secret",
    botToken: "xoxb-original-token",
    configuredAt: Date.now(),
  };
  const rotatedConfig = {
    signingSecret: "rotated-signing-secret",
    botToken: "xoxb-rotated-token",
    configuredAt: originalConfig.configuredAt + 1,
  };
  await setSlackChannelConfig(originalConfig);
  let forwardCalls = 0;
  let deleteAuthorization: string | null = null;
  const fetchMock = mock.method(globalThis, "fetch", async (
    _input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    deleteAuthorization = new Headers(init?.headers).get("authorization");
    return Response.json({ ok: true });
  });
  const dependencies = createWorkflowDependencies({
    buildExistingBootHandle,
    runWithBootMessages: async () => {
      await setSlackChannelConfig(rotatedConfig);
      return {
        meta: asMeta({
          status: "running",
          sandboxId: "sbx-slack-rotated",
          channels: {
            telegram: null,
            slack: rotatedConfig,
            discord: null,
            whatsapp: null,
          },
        }),
        bootMessageSent: true,
        admissionReady: true,
      };
    },
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      forwardCalls += 1;
      return {
        ok: true,
        status: 200,
        attempts: 1,
        totalMs: 50,
        transport: "public",
        retries: [],
      };
    },
  });

  try {
    await processChannelStep(
      "slack",
      { event: { channel: "C-rotated", ts: "1710000000.000666" } },
      "test",
      "req-slack-rotated",
      "boot-slack-original",
      {
        dependencies,
        workflowHandoff: {
          slackCleanupConfig: {
            botToken: originalConfig.botToken,
            configuredAt: originalConfig.configuredAt,
          },
        },
      },
    );

    assert.equal(deleteAuthorization, "Bearer xoxb-original-token");
    assert.equal(forwardCalls, 0);
    const failure = await getChannelDlqRecord(
      "slack",
      "slack:C-rotated:1710000000.000666",
    );
    assert.equal(failure?.terminal, true);
    assert.equal(failure?.deliveryOutcome, "not-accepted");
  } finally {
    fetchMock.mock.restore();
  }
});

test("processChannelStep keeps Slack 401 fatal (signature failure is unrecoverable)", async () => {
  // Unlike Telegram, a 401 from Slack Bolt means signature re-verification
  // failed — retrying cannot recover. The workflow must treat it as fatal.
  const dependencies = createWorkflowDependencies({
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => ({
      ok: false,
      acceptance: "rejected",
      status: 401,
      attempts: 1,
      totalMs: 50,
      transport: "public",
      retries: [],
    }),
  });

  await assert.rejects(
    processChannelStep(
      "slack",
      { event_id: "Ev-fatal", event: {} },
      "test",
      "req-slack-401",
      null,
      {
        dependencies,
        workflowHandoff: {
          slackForwardHeaders: {
            "x-slack-request-timestamp": "1710000000",
            "x-slack-signature": "v0=original",
          },
          slackRawBody: JSON.stringify({ event_id: "Ev-fatal", event: {} }),
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof TestFatalError);
      return true;
    },
  );

  const meta = await getInitializedMeta();
  assert.equal(
    meta.channelDiagnostics?.slack?.lastDeliveryState?.state,
    "terminal-failed",
  );
  const record = await getChannelDlqRecord("slack", "slack:Ev-fatal");
  assert.ok(record);
  assert.equal(record.deliveryOutcome, "not-accepted");
  assert.equal(record.recoveryState, "blocked");
  const failureLog = getServerLogs().find(
    (entry) => entry.message === "channels.workflow_terminal_failure_recorded",
  );
  assert.ok(failureLog);
  assert.equal("replayToken" in (failureLog.data ?? {}), false);
});

test("generic 403 closes workflow forwarding as unknown without replay", async () => {
  let fetchCalls = 0;
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    fetchCalls += 1;
    return new Response('{"type":"forbidden"}', { status: 403 });
  });
  try {
    const result = await forwardToNativeHandlerWithRetry(
      "slack",
      { event_id: "Ev-403", event: {} },
      asMeta({
        status: "running",
        sandboxId: "sbx-403",
        channels: {
          telegram: null,
          slack: {
            signingSecret: "signing-secret",
            botToken: "xoxb-token",
            configuredAt: Date.now(),
          },
          discord: null,
          whatsapp: null,
        },
      }),
      async () => "https://sandbox.example",
      null,
      false,
      {
        "x-slack-signature": "v0=sig",
        "x-slack-request-timestamp": "1700000000",
      },
      '{"event_id":"Ev-403","event":{}}',
      "slack:Ev-403",
      false,
      false,
      "https://control.example",
    );
    assert.equal(fetchCalls, 1);
    assert.equal(result.acceptance, "unknown");
    assert.equal(result.status, 403);
  } finally {
    fetchMock.mock.restore();
  }
});

test("admitted direct-local Telegram 500 remains unknown without retry", async () => {
  let localCalls = 0;
  const result = await forwardToNativeHandlerWithRetry(
    "telegram",
    { update_id: 7001 },
    asMeta({
      status: "running",
      sandboxId: "sbx-local-telegram-500",
      channels: {
        telegram: {
          ...createFallbackTelegramConfig(),
          webhookSecret: "local-secret",
        },
        slack: null,
        discord: null,
        whatsapp: null,
      },
    }),
    async () => "https://sandbox.example",
    async () => {
      localCalls += 1;
      return {
        ok: false,
        status: 500,
        durationMs: 5,
        bodyLength: 18,
        bodyHead: "response failed after spool commit",
        headers: null,
      };
    },
    true,
    null,
    null,
    "telegram:bot:7001",
    true,
    false,
    "https://control.example",
  );

  assert.equal(localCalls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.acceptance, "unknown");
  assert.equal(result.attempts, 1);
  assert.equal(result.attemptsDetail?.[0]?.transport, "local");
  assert.equal(
    result.attemptsDetail?.[0]?.classification,
    "acceptance-unknown",
  );
  assert.equal(result.attemptsDetail?.[0]?.acceptance, "unknown");
});

test("admitted direct-local Telegram durable marker stays accepted", async () => {
  let localCalls = 0;
  const result = await forwardToNativeHandlerWithRetry(
    "telegram",
    { update_id: 7003 },
    asMeta({
      status: "running",
      sandboxId: "sbx-local-telegram-durable",
      channels: {
        telegram: {
          ...createFallbackTelegramConfig(),
          webhookSecret: "local-secret",
        },
        slack: null,
        discord: null,
        whatsapp: null,
      },
    }),
    async () => "https://sandbox.example",
    async () => {
      localCalls += 1;
      return {
        ok: false,
        status: 500,
        durationMs: 5,
        bodyLength: 0,
        bodyHead: "",
        headers: { openclawDeliveryAccepted: "durable" },
      };
    },
    true,
    null,
    null,
    "telegram:bot:7003",
    true,
    false,
    "https://control.example",
  );

  assert.equal(localCalls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.status, 500);
  assert.equal(result.acceptance, "accepted");
  assert.equal(result.attemptsDetail?.[0]?.classification, "accepted");
  assert.equal(result.attemptsDetail?.[0]?.acceptance, "accepted");
});

test("public Telegram 500 remains acceptance-unknown", async () => {
  let fetchCalls = 0;
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    fetchCalls += 1;
    return new Response("spool status unavailable", { status: 500 });
  });
  try {
    const result = await forwardToNativeHandlerWithRetry(
      "telegram",
      { update_id: 7002 },
      asMeta({
        status: "running",
        sandboxId: "sbx-public-telegram-500",
        channels: {
          telegram: createFallbackTelegramConfig(),
          slack: null,
          discord: null,
          whatsapp: null,
        },
      }),
      async () => "https://sandbox.example",
      null,
      false,
      null,
      null,
      "telegram:bot:7002",
      true,
      false,
      "https://control.example",
    );

    assert.equal(fetchCalls, 1);
    assert.equal(result.ok, false);
    assert.equal(result.acceptance, "unknown");
    assert.equal(result.attemptsDetail?.[0]?.transport, "public");
  } finally {
    fetchMock.mock.restore();
  }
});

test("processChannelStep preserves Slack native acceptance across config rotation", async () => {
  const originalConfig = {
    signingSecret: "original-signing-secret",
    botToken: "xoxb-original-token",
    configuredAt: Date.now(),
  };
  await setSlackChannelConfig(originalConfig);
  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-slack-post-dispatch-rotation",
        channels: {
          telegram: null,
          slack: originalConfig,
          discord: null,
          whatsapp: null,
        },
      }),
      bootMessageSent: false,
      admissionReady: true,
    }),
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      await setSlackChannelConfig({
        ...originalConfig,
        botToken: "xoxb-rotated-token",
        configuredAt: originalConfig.configuredAt + 1,
      });
      return {
        ok: true,
        acceptance: "accepted",
        status: 200,
        attempts: 1,
        totalMs: 20,
        transport: "public",
        retries: [],
      };
    },
  });

  await processChannelStep(
    "slack",
    { event_id: "Ev-accepted-before-rotation", event: {} },
    "test",
    "req-slack-accepted-before-rotation",
    null,
    {
      dependencies,
      workflowHandoff: {
        slackCleanupConfig: {
          botToken: originalConfig.botToken,
          configuredAt: originalConfig.configuredAt,
        },
        slackConfigGeneration: originalConfig.configuredAt,
        slackForwardHeaders: {
          "x-slack-signature": "v0=original",
          "x-slack-request-timestamp": "1700000000",
        },
        slackRawBody:
          '{"event_id":"Ev-accepted-before-rotation","event":{}}',
      },
    },
  );

  const meta = await getInitializedMeta();
  assert.equal(meta.channelDiagnostics?.slack?.lastForward?.ok, true);
  assert.equal(
    meta.channelDiagnostics?.slack?.lastForward?.classification,
    "accepted",
  );
  assert.equal(
    await getChannelDlqRecord("slack", "slack:Ev-accepted-before-rotation"),
    null,
  );
});

test("processChannelStep passes slackForwardHeaders from handoff through to the retry wrapper", async () => {
  let capturedHeaders: Record<string, string> | null | undefined;
  const dependencies = createWorkflowDependencies({
    forwardToNativeHandlerWithRetry: async (
      _channel: unknown,
      _payload: unknown,
      _meta: SingleMeta,
      _getDomain: unknown,
      _forwardTelegramLocally: unknown,
      _preferLocal: unknown,
      extraForwardHeaders: Record<string, string> | null | undefined,
      _rawBody: unknown,
      _deliveryId: unknown,
      _telegramDurableAcceptanceAdmitted: unknown,
      _gatewayAdmissionRejectionAdmitted: boolean | undefined,
    ): Promise<RetryingForwardResult> => {
      capturedHeaders = extraForwardHeaders;
      return { ok: true, status: 200, attempts: 1, totalMs: 50, transport: "public", retries: [] };
    },
  });

  const slackForwardHeaders = {
    "x-slack-signature": "v0=deadbeef",
    "x-slack-request-timestamp": "1700000000",
  };

  await processChannelStep(
    "slack",
    { event: {} },
    "test",
    "req-slack-headers",
    null,
    {
      dependencies,
      workflowHandoff: {
        slackForwardHeaders,
      } satisfies ChannelWorkflowHandoff,
    },
  );

  assert.deepStrictEqual(capturedHeaders, slackForwardHeaders);
});

test("processChannelStep emits channels.slack_wake_summary for Slack requests", async () => {
  _resetLogBuffer();

  const dependencies = createWorkflowDependencies({
    ensureSandboxReady: async () =>
      asMeta({
        status: "running",
        sandboxId: "sbx-slack-summary",
        channels: { telegram: null, slack: null, discord: null, whatsapp: null },
      }),
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => ({
      ok: true,
      status: 200,
      attempts: 2,
      totalMs: 2500,
      transport: "public",
      retries: [{ attempt: 1, reason: "handler-not-ready", status: 404 }],
    }),
  });

  const receivedAtMs = Date.now() - 100;
  await processChannelStep(
    "slack",
    { event: {} },
    "test",
    "req-slack-summary",
    null,
    {
      receivedAtMs,
      dependencies,
      workflowHandoff: {
        slackForwardHeaders: {
          "x-slack-signature": "v0=abc",
          "x-slack-request-timestamp": "1700000000",
        },
      } satisfies ChannelWorkflowHandoff,
    },
  );

  const logs = getServerLogs();
  const summaryLogs = logs.filter((entry) => entry.message === "channels.slack_wake_summary");
  assert.equal(summaryLogs.length, 1);
  const data = summaryLogs[0].data ?? {};
  assert.equal(typeof data.webhookToWorkflowMs, "number");
  assert.equal(typeof data.workflowToSandboxReadyMs, "number");
  assert.equal(typeof data.forwardMs, "number");
  assert.equal(data.retryingForwardAttempts, 2);
  assert.equal(data.retryingForwardRetries, 1);
  assert.equal(data.slackForwardHasSignature, true);
  assert.equal(data.slackForwardHasTimestamp, true);
  const headerKeys = data.slackForwardHeaderKeys as string[] | null;
  assert.ok(Array.isArray(headerKeys));
  assert.ok(headerKeys.includes("x-slack-signature"));
  assert.ok(headerKeys.includes("x-slack-request-timestamp"));

  // And telegram_wake_summary must NOT be emitted for Slack.
  const telegramSummaryLogs = logs.filter((entry) => entry.message === "channels.telegram_wake_summary");
  assert.equal(telegramSummaryLogs.length, 0);
});

test("processChannelStep rejects hosted Discord before forwarding", async () => {
  let capturedHeaders: Record<string, string> | null = null;
  let capturedRawBody: string | null = null;
  let capturedDeliveryId: string | null = null;
  let capturedGatewayAdmission = false;

  const dependencies = createWorkflowDependencies({
    hydrateVerifiedBundleIdentity: async () => VERIFIED_DELIVERY_BUNDLE_IDENTITY,
    forwardToNativeHandlerWithRetry: async (
      _channel,
      _payload,
      _meta,
      _getSandboxDomain,
      _localForward,
      _preferLocal,
      extraForwardHeaders,
      rawBody,
      deliveryId,
      _telegramAdmission,
      gatewayAdmission,
    ): Promise<RetryingForwardResult> => {
      capturedHeaders = extraForwardHeaders ?? null;
      capturedRawBody = rawBody ?? null;
      capturedDeliveryId = deliveryId ?? null;
      capturedGatewayAdmission = gatewayAdmission;
      return { ok: true, status: 200, attempts: 1, totalMs: 50, transport: "public", retries: [] };
    },
  });

  await assert.rejects(
    processChannelStep(
      "discord",
      { id: "interaction-handoff-1", application_id: "app", token: "tok" },
      "test",
      "req-discord-handoff",
      null,
      {
        dependencies,
        workflowHandoff: {
          discordForwardHeaders: {
            "x-signature-ed25519": "sig",
            "x-signature-timestamp": "1700000000",
            "content-type": "application/json",
          },
          discordRawBody: '{"id":"interaction-handoff-1"}',
        } satisfies ChannelWorkflowHandoff,
      },
    ),
    /hosted_discord_transport_unavailable/,
  );

  assert.equal(capturedHeaders, null);
  assert.equal(capturedRawBody, null);
  assert.equal(capturedDeliveryId, null);
  assert.equal(capturedGatewayAdmission, false);
});

test("processChannelStep rejects hosted WhatsApp before delivery side effects", async () => {
  _resetLogBuffer();
  let bootCalls = 0;
  let handleCalls = 0;
  let forwardCalls = 0;
  let readinessCalls = 0;

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => {
      bootCalls += 1;
      throw new Error("must not wake");
    },
    buildExistingBootHandle: async () => {
      handleCalls += 1;
      return undefined;
    },
    forwardToNativeHandlerWithRetry: async () => {
      forwardCalls += 1;
      throw new Error("must not forward");
    },
    ensureSandboxReady: async () => {
      readinessCalls += 1;
      throw new Error("must not reconcile");
    },
  });

  await assert.rejects(
    processChannelStep(
      "whatsapp",
      { entry: [] },
      "test",
      "req-wa-rejected",
      "wamid.boot",
      { dependencies },
    ),
    (error: unknown) => {
      assert.ok(error instanceof TestFatalError);
      assert.equal(error.message, "hosted_whatsapp_transport_unavailable");
      return true;
    },
  );

  assert.equal(bootCalls, 0);
  assert.equal(handleCalls, 0);
  assert.equal(forwardCalls, 0);
  assert.equal(readinessCalls, 0);
  const rejectionLog = getServerLogs().find(
    (entry) => entry.message === "channels.whatsapp_workflow_rejected",
  );
  assert.equal(rejectionLog?.data?.reason, "hosted-transport-unavailable");
});

test("processChannelStep emits no Discord wake summary when hosted transport is unavailable", async () => {
  _resetLogBuffer();
  const dependencies = createWorkflowDependencies({
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => ({
      ok: true,
      status: 200,
      attempts: 2,
      totalMs: 250,
      transport: "public",
      retries: [{ attempt: 1, reason: "handler-not-ready", status: 404 }],
    }),
  });

  await assert.rejects(
    processChannelStep(
      "discord",
      { id: "interaction-summary-1", application_id: "app", token: "tok" },
      "test",
      "req-discord-summary",
      null,
      { dependencies, receivedAtMs: Date.now() - 20 },
    ),
    /hosted_discord_transport_unavailable/,
  );
  const logs = getServerLogs();
  const discordSummary = logs.find((entry) => entry.message === "channels.discord_wake_summary");
  assert.equal(discordSummary, undefined);
});
