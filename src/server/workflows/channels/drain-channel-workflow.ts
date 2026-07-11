import {
  isChannelName,
  type ChannelName,
  type SlackChannelConfig,
  type TelegramChannelConfig,
} from "@/shared/channels";
import { acquireChannelConfigLease } from "@/server/channels/config-lock";
import type { BootMessageHandle } from "@/server/channels/core/types";
import type { QueuedChannelJob } from "@/server/channels/driver";
import { deleteSlackMessage } from "@/server/channels/slack/adapter";
import { extractTelegramChatId } from "@/server/channels/telegram/adapter";
import { deleteMessage, editMessageText } from "@/server/channels/telegram/bot-api";
import { deriveChannelDeliveryId } from "@/server/channels/delivery-id";
import {
  recordChannelDlqFailure,
  resolveChannelDlqFailure,
  type ChannelDlqDeliveryOutcome,
} from "@/server/channels/dlq";
import { logError, logInfo, logWarn } from "@/server/log";
import {
  recordChannelDeliveryClosedOutcome,
  recordChannelLastForward,
} from "@/server/channels/last-forward";
import {
  OPENCLAW_GATEWAY_SUSPEND_CAPABILITY,
  OPENCLAW_TELEGRAM_DURABLE_ACK_CAPABILITY,
  isAdmittedTelegramDurableAcceptance,
  isDefiniteNativePreAdmissionError,
  isAdmittedGatewayAdmissionUnavailableResponse,
  type NativeDeliveryAcceptance,
} from "@/server/channels/native-response-contract";
import { ensureUsableAiGatewayCredential, markSandboxPortUrlStale } from "@/server/sandbox/lifecycle";
import { getInitializedMeta } from "@/server/store/store";
import { getStore } from "@/server/store/store";
import { createHmac } from "node:crypto";
import { channelForwardDiagnosticKey } from "@/server/store/keyspace";
// Discord deferred-interaction tokens are valid for 15 minutes. Soft-
// deadline a little under that so a reply attempt at 13.5min still
// has wall-clock to land before Discord starts returning 404
// INVALID_WEBHOOK_TOKEN. If we're already past this when a workflow
// step enters (long retries, long sandbox wake, or long OpenClaw
// turn), abort and send the user an out-of-band "took too long"
// notice via the interaction token while it's still valid.
const DISCORD_INTERACTION_SOFT_DEADLINE_MS = 13.5 * 60 * 1000;

type DiscordInteractionContext = {
  applicationId: string;
  token: string;
  channelId: string | null;
  userId: string | null;
};

function extractDiscordInteractionForTimeout(
  payload: unknown,
): DiscordInteractionContext | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as {
    application_id?: unknown;
    token?: unknown;
    channel_id?: unknown;
    user?: { id?: unknown };
    member?: { user?: { id?: unknown } };
  };
  if (typeof p.application_id !== "string" || typeof p.token !== "string") {
    return null;
  }
  return {
    applicationId: p.application_id,
    token: p.token,
    channelId: typeof p.channel_id === "string" ? p.channel_id : null,
    userId:
      typeof p.member?.user?.id === "string"
        ? p.member.user.id
        : typeof p.user?.id === "string"
          ? p.user.id
          : null,
  };
}

type DiscordTimeoutNoticeResult = {
  ok: boolean;
  method: "interaction-edit" | "channel-fallback" | "none";
  status: number | null;
};

async function sendDiscordTimeoutNotice(input: {
  payload: unknown;
  botToken: string | null;
  content: string;
}): Promise<DiscordTimeoutNoticeResult> {
  const parsed = extractDiscordInteractionForTimeout(input.payload);
  if (!parsed) return { ok: false, method: "none", status: null };

  // Attempt the interaction-token edit first — this is the Discord-native
  // path and preserves the original ephemeral/deferred response flow.
  const editUrl = `https://discord.com/api/v10/webhooks/${parsed.applicationId}/${parsed.token}/messages/@original`;
  const edit = await fetch(editUrl, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: input.content,
      allowed_mentions: { parse: [] },
    }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  if (edit?.ok) {
    return { ok: true, method: "interaction-edit", status: edit.status };
  }

  // Interaction token may have already expired; fall back to a bot-token
  // channel message so the user still sees something instead of a silent
  // "Thinking…" indicator that never resolves.
  if (!input.botToken || !parsed.channelId) {
    return {
      ok: false,
      method: "interaction-edit",
      status: edit?.status ?? null,
    };
  }
  const fallbackContent = parsed.userId
    ? `<@${parsed.userId}> ${input.content}`
    : input.content;
  const fallback = await fetch(
    `https://discord.com/api/v10/channels/${parsed.channelId}/messages`,
    {
      method: "POST",
      headers: {
        authorization: `Bot ${input.botToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content: fallbackContent,
        allowed_mentions: parsed.userId
          ? { users: [parsed.userId] }
          : { parse: [] },
      }),
      signal: AbortSignal.timeout(5_000),
    },
  ).catch(() => null);
  return {
    ok: fallback?.ok === true,
    method: "channel-fallback",
    status: fallback?.status ?? null,
  };
}
async function recordWorkflowFailure(input: {
  channel: string;
  requestId: string | null;
  deliveryId: string;
  terminal: boolean;
  error: unknown;
  diag: Record<string, unknown>;
  receivedAtMs: number | null;
  deliveryOutcome: ChannelDlqDeliveryOutcome;
}): Promise<void> {
  const record = await recordChannelDlqFailure({
    channel: input.channel as ChannelName,
    deliveryId: input.deliveryId,
    phase: "workflow-step-failed",
    terminal: input.terminal,
    retryable: !input.terminal,
    deliveryOutcome: input.deliveryOutcome,
    requestId: input.requestId,
    receivedAtMs: input.receivedAtMs,
    error: input.error,
    diag: input.diag,
  });
  if (record) {
    logError(
      input.terminal
        ? "channels.workflow_terminal_failure_recorded"
        : "channels.workflow_retryable_failure_recorded",
      {
        channel: record.channel,
        deliveryId: record.deliveryId,
        phase: record.phase,
        terminal: record.terminal,
        retryable: record.retryable,
        deliveryOutcome: record.deliveryOutcome,
        recoveryState: record.recoveryState,
        requestId: record.requestId,
        failureCount: record.failureCount,
        firstFailedAt: record.firstFailedAt,
        failedAt: record.failedAt,
        errorName: record.errorName,
        errorMessage: record.errorMessage,
      },
    );
  }
}

export type RetryingForwardResult = {
  ok: boolean;
  acceptance?: NativeDeliveryAcceptance;
  status: number;
  attempts: number;
  totalMs: number;
  transport?: "public" | "local" | null;
  retries: Array<{ attempt: number; reason: string; status?: number; error?: string }>;
  attemptsDetail?: ForwardAttemptDetail[];
};

export type DrainChannelWorkflowDependencies = {
  isRetryable: typeof import("@/server/channels/driver").isRetryable;
  createSlackAdapter: typeof import("@/server/channels/slack/adapter").createSlackAdapter;
  createTelegramAdapter: typeof import("@/server/channels/telegram/adapter").createTelegramAdapter;
  createDiscordAdapter: typeof import("@/server/channels/discord/adapter").createDiscordAdapter;
  reconcileDiscordIntegration: typeof import("@/server/channels/discord/reconcile").reconcileDiscordIntegration;
  runWithBootMessages: typeof import("@/server/channels/core/boot-messages").runWithBootMessages;
  ensureSandboxReady: typeof import("@/server/sandbox/lifecycle").ensureSandboxReady;
  getSandboxDomain: typeof import("@/server/sandbox/lifecycle").getSandboxDomain;
  forwardToNativeHandler: typeof forwardToNativeHandler;
  forwardTelegramToNativeHandlerLocally: typeof forwardTelegramToNativeHandlerLocally;
  forwardToNativeHandlerWithRetry: typeof forwardToNativeHandlerWithRetry;
  waitForTelegramNativeHandler: typeof waitForTelegramNativeHandler;
  probeTelegramNativeHandlerLocally: typeof probeTelegramNativeHandlerLocally;
  buildExistingBootHandle: typeof buildExistingBootHandle;
  hydrateVerifiedBundleIdentity: typeof import("@/server/openclaw/bundle-identity").hydrateVerifiedBundleIdentity;
  RetryableError: typeof import("workflow").RetryableError;
  FatalError: typeof import("workflow").FatalError;
  getStepMetadata: typeof import("workflow").getStepMetadata;
  getWorkflowMetadata: typeof import("workflow").getWorkflowMetadata;
};

type DrainChannelErrorDependencies = Pick<
  DrainChannelWorkflowDependencies,
  "FatalError" | "RetryableError" | "isRetryable"
>;

// Cap runaway retries of transient-looking failures (sandbox timeout,
// 5xx, handler timeout, isRetryable-classified). Both a wall-clock
// budget and an attempt fuse. 10 minutes is long enough to tolerate
// ambient infra blips but short enough that a permanently broken
// sandbox stops burning Fluid Compute on retry ping-pong.
const WORKFLOW_RETRY_WALL_CLOCK_BUDGET_MS = 10 * 60 * 1000;
const WORKFLOW_RETRY_HARD_ATTEMPT_CAP = 25;
const PERSISTENT_SANDBOX_FAILURE_PREFIX = "sandbox_persistently_failing";

export type WorkflowRetryBudget = {
  attempt: number | null;
  wallClockMs: number | null;
  exceeded: boolean;
  reason: string | null;
};

function resolveRetryBudget(
  receivedAtMs: number | null,
  dependencies: Pick<
    DrainChannelWorkflowDependencies,
    "getStepMetadata" | "getWorkflowMetadata"
  >,
): WorkflowRetryBudget {
  let attempt: number | null = null;
  let workflowStartedAtMs: number | null = null;
  try {
    attempt = dependencies.getStepMetadata().attempt;
  } catch {
    // Metadata is only available inside a step; calling outside throws.
  }
  try {
    workflowStartedAtMs = dependencies
      .getWorkflowMetadata()
      .workflowStartedAt.getTime();
  } catch {
    // Same caveat as above.
  }
  const baseMs = receivedAtMs ?? workflowStartedAtMs;
  const wallClockMs =
    typeof baseMs === "number" ? Date.now() - baseMs : null;
  const wallClockExceeded =
    wallClockMs !== null && wallClockMs >= WORKFLOW_RETRY_WALL_CLOCK_BUDGET_MS;
  const attemptExceeded =
    attempt !== null && attempt >= WORKFLOW_RETRY_HARD_ATTEMPT_CAP;
  const exceeded = wallClockExceeded || attemptExceeded;
  return {
    attempt,
    wallClockMs,
    exceeded,
    reason: exceeded
      ? `${PERSISTENT_SANDBOX_FAILURE_PREFIX}:${attempt ?? "unknown"}_attempts:${wallClockMs ?? "unknown"}ms`
      : null,
  };
}

export type ProcessChannelStepOptions = {
  receivedAtMs?: number | null;
  dependencies?: DrainChannelWorkflowDependencies;
  workflowHandoff?: ChannelWorkflowHandoff | null;
  requireTelegramConfigGeneration?: boolean;
};

export type ChannelWorkflowHandoff = {
  /** Re-enter lifecycle readiness when fast-path admission closed mid-stop. */
  revalidateSandboxBeforeForward?: boolean;
  slackCleanupConfig?: Pick<
    SlackChannelConfig,
    "botToken" | "configuredAt"
  > | null;
  fallbackTelegramConfig?: TelegramChannelConfig | null;
  /** Configuration generation that authenticated the queued Telegram update. */
  telegramConfigGeneration?: number | null;
  slackForwardHeaders?: Record<string, string> | null;
  slackRawBody?: string | null;
  discordForwardHeaders?: Record<string, string> | null;
  discordRawBody?: string | null;
};

type WorkflowCapabilityAdmissions = {
  telegramDurableAcceptanceAdmitted: boolean;
  gatewayAdmissionRejectionAdmitted: boolean;
  source: "post-wake-verified" | "post-wake-unverified";
};

async function resolveWorkflowCapabilityAdmissions(input: {
  meta: import("@/shared/types").SingleMeta;
  hydrateVerifiedBundleIdentity: DrainChannelWorkflowDependencies["hydrateVerifiedBundleIdentity"];
}): Promise<WorkflowCapabilityAdmissions> {
  const verifiedIdentity = await input
    .hydrateVerifiedBundleIdentity(input.meta.bundleIdentity)
    .catch(() => null);
  if (verifiedIdentity) {
    return {
      telegramDurableAcceptanceAdmitted:
        verifiedIdentity.capabilities.includes(
          OPENCLAW_TELEGRAM_DURABLE_ACK_CAPABILITY,
        ),
      gatewayAdmissionRejectionAdmitted:
        verifiedIdentity.capabilities.includes(
          OPENCLAW_GATEWAY_SUSPEND_CAPABILITY,
        ),
      source: "post-wake-verified",
    };
  }
  return {
    telegramDurableAcceptanceAdmitted: false,
    gatewayAdmissionRejectionAdmitted: false,
    source: "post-wake-unverified",
  };
}

// Versioned workflow envelope. All new callers pass a single v1 envelope
// instead of positional args so that adding fields in future deploys can
// never corrupt in-flight payloads already queued in Workflow DevKit.
export type DrainChannelWorkflowEnvelopeV1 = {
  version: 1;
  channel: string;
  payload: unknown;
  origin: string;
  requestId: string | null;
  bootMessageId?: number | string | null;
  receivedAtMs?: number | null;
  workflowHandoff?: ChannelWorkflowHandoff | null;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDrainChannelWorkflowEnvelopeLike(
  value: unknown,
): value is Record<string, unknown> {
  return isPlainObject(value) && "version" in value;
}

function isDrainChannelWorkflowEnvelopeV1(
  value: unknown,
): value is DrainChannelWorkflowEnvelopeV1 {
  if (!isPlainObject(value)) return false;
  return value.version === 1 && typeof value.channel === "string";
}

async function throwFatalWorkflowEnvelopeError(message: string): Promise<never> {
  const { FatalError } = await import("workflow");
  throw new FatalError(message);
}

type TelegramRestoreContractAssessment = {
  status: "verified" | "not-expected" | "unverified";
  restoreMetricsRecordedAt: number | null;
  telegramExpected: boolean | null;
  telegramListenerReady: boolean | null;
  telegramListenerWaitMs: number | null;
};

function assessTelegramRestoreContract(
  meta: import("@/shared/types").SingleMeta,
): TelegramRestoreContractAssessment {
  const restore = meta.lastRestoreMetrics;
  if (!restore) {
    return {
      status: "unverified",
      restoreMetricsRecordedAt: null,
      telegramExpected: null,
      telegramListenerReady: null,
      telegramListenerWaitMs: null,
    };
  }
  if (restore.telegramExpected !== true) {
    return {
      status: "not-expected",
      restoreMetricsRecordedAt: restore.recordedAt,
      telegramExpected: restore.telegramExpected ?? false,
      telegramListenerReady: restore.telegramListenerReady ?? null,
      telegramListenerWaitMs: restore.telegramListenerWaitMs ?? null,
    };
  }
  return {
    status: restore.telegramListenerReady === true ? "verified" : "unverified",
    restoreMetricsRecordedAt: restore.recordedAt,
    telegramExpected: true,
    telegramListenerReady: restore.telegramListenerReady ?? false,
    telegramListenerWaitMs: restore.telegramListenerWaitMs ?? null,
  };
}

function telegramLocalProbeSawConnectionRefused(
  probe: TelegramLocalProbeResult | null,
): boolean {
  if (!probe) return false;
  return [probe.error, probe.detail, probe.bodyHead].some(
    (value) => typeof value === "string" && /ECONNREFUSED|connection refused/i.test(value),
  );
}

export async function drainChannelWorkflow(
  channelOrEnvelope: string | DrainChannelWorkflowEnvelopeV1,
  payload?: unknown,
  origin?: string,
  requestId?: string | null,
  bootMessageId?: number | string | null,
  receivedAtMs?: number | null,
  workflowHandoff?: ChannelWorkflowHandoff | null,
): Promise<void> {
  "use workflow";

  // Accept either the v1 envelope (new callers) or the legacy positional
  // form (still queued in Workflow DevKit from prior deploys). Parsing the
  // envelope first is cheap and keeps both shapes working during rollout.
  if (isDrainChannelWorkflowEnvelopeV1(channelOrEnvelope)) {
    const env = channelOrEnvelope;
    await processChannelStep(
      env.channel,
      env.payload,
      env.origin,
      env.requestId,
      env.bootMessageId ?? null,
      {
        receivedAtMs: env.receivedAtMs ?? null,
        workflowHandoff: env.workflowHandoff ?? null,
        requireTelegramConfigGeneration: true,
      },
    );
    return;
  }

  // Looks like an envelope (has `version`) but isn't v1 — either a future
  // vN we don't understand yet, or a malformed v1. Fail closed with a
  // FatalError so Workflow DevKit doesn't retry indefinitely and
  // operators see the version mismatch cleanly in logs. Without this
  // the value falls through to legacy positional parsing below, where
  // the object gets treated as a string `channel`, and processChannelStep
  // silently corrupts.
  if (isDrainChannelWorkflowEnvelopeLike(channelOrEnvelope)) {
    await throwFatalWorkflowEnvelopeError(
      `unsupported_drain_channel_workflow_envelope_version:${String(channelOrEnvelope.version)}`,
    );
  }

  // Legacy positional form. Accept only when the first arg is a string
  // channel name. Anything else is programmer error / corrupted queue
  // payload and must be surfaced, not silently coerced.
  if (typeof channelOrEnvelope !== "string") {
    await throwFatalWorkflowEnvelopeError(
      "invalid_legacy_drain_channel_workflow_channel",
    );
  }

  await processChannelStep(
    channelOrEnvelope,
    payload,
    origin as string,
    requestId ?? null,
    bootMessageId ?? null,
    {
      receivedAtMs: receivedAtMs ?? null,
      workflowHandoff: workflowHandoff ?? null,
      requireTelegramConfigGeneration: true,
    },
  );
}

export async function processChannelStep(
  channel: string,
  payload: unknown,
  origin: string,
  requestId: string | null,
  bootMessageId?: number | string | null,
  options?: ProcessChannelStepOptions,
): Promise<void> {
  "use step";

  const receivedAtMs = options?.receivedAtMs ?? null;
  const workflowStartedAt = Date.now();
  const fallbackTelegramConfig =
    channel === "telegram"
      ? options?.workflowHandoff?.fallbackTelegramConfig ?? null
      : null;
  const slackCleanupConfig =
    channel === "slack"
      ? options?.workflowHandoff?.slackCleanupConfig ?? null
      : null;
  const telegramConfigGeneration =
    channel === "telegram"
      ? options?.workflowHandoff?.telegramConfigGeneration ??
        fallbackTelegramConfig?.configuredAt ??
        null
      : null;
  const deliveryId = deriveChannelDeliveryId({
    channel,
    payload,
    requestId,
    receivedAtMs,
  });
  const resolvedDependencies =
    options?.dependencies ?? (await loadDrainChannelWorkflowDependencies());
  if (channel === "whatsapp") {
    logWarn("channels.whatsapp_workflow_rejected", {
      channel,
      requestId,
      deliveryId,
      reason: "hosted-transport-unavailable",
    });
    throw new resolvedDependencies.FatalError(
      "hosted_whatsapp_transport_unavailable",
    );
  }
  // Diagnostic trace — every phase appends here, written to store at the end.
  const diag: Record<string, unknown> = {
    channel,
    requestId,
    deliveryId,
    bootMessageId: bootMessageId ?? null,
    receivedAtMs,
    workflowStartedAt,
  };

  async function persistDiagSnapshot(
    phase: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await getStore().setValue(
        channelForwardDiagnosticKey(),
        {
          ...diag,
          ...extra,
          phase,
          phaseUpdatedAt: Date.now(),
        },
        3600,
      );
    } catch {
      // Best effort only. Do not interfere with delivery path.
    }
  }

  console.log(`[DIAG] processChannelStep START channel=${channel} requestId=${requestId} bootMessageId=${bootMessageId ?? "none"}`);
  await persistDiagSnapshot("workflow-step-started");

  const {
    reconcileDiscordIntegration,
    runWithBootMessages,
    ensureSandboxReady,
    getSandboxDomain,
    forwardToNativeHandler,
    forwardTelegramToNativeHandlerLocally,
    forwardToNativeHandlerWithRetry,
    probeTelegramNativeHandlerLocally,
    buildExistingBootHandle,
    hydrateVerifiedBundleIdentity,
  } = resolvedDependencies;

  if (channel === "discord") {
    try {
      await reconcileDiscordIntegration();
    } catch (err) {
      logWarn("channels.discord_integration_reconcile_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const existingBootHandle = await buildExistingBootHandle(
    channel,
    payload,
    bootMessageId,
    {
      slack: slackCleanupConfig,
      telegram: fallbackTelegramConfig,
    },
  );
  diag.hasExistingBootHandle = Boolean(existingBootHandle);
  let nativeAcceptance: NativeDeliveryAcceptance | null = null;
  let finalForwardClassification: string | null = null;

  async function currentTelegramConfigOrSettle(
    phase: "step-start" | "post-wake" | "pre-forward",
  ): Promise<TelegramChannelConfig | null | undefined> {
    if (channel !== "telegram") {
      return null;
    }

    const state = await readTelegramWorkflowConfigState({
      fallbackTelegramConfig,
      expectedGeneration: telegramConfigGeneration,
      requireGeneration:
        options?.requireTelegramConfigGeneration === true,
    });
    if (state.status === "untracked" || state.status === "current") {
      return state.config;
    }

    diag.telegramConfigGuard = state.status;
    diag.telegramConfigGuardPhase = phase;
    diag.outcome = `settled:telegram-config-${state.status}`;
    diag.completedAt = Date.now();
    diag.totalDurationMs = Date.now() - workflowStartedAt;
    await existingBootHandle?.clear().catch((error) => {
      logWarn("channels.telegram_stale_handoff_boot_cleanup_failed", {
        requestId,
        deliveryId,
        phase,
        reason: state.status,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    await recordChannelDeliveryClosedOutcome({
      channel: "telegram",
      deliveryId,
      outcome: "failed",
      reason: `telegram-config-${state.status}`,
    });
    await resolveChannelDlqFailure("telegram", deliveryId).catch(() => {});
    await persistDiagSnapshot("telegram-config-stale", {
      telegramConfigGuard: state.status,
      telegramConfigGuardPhase: phase,
      outcome: diag.outcome,
    });
    logWarn("channels.telegram_workflow_handoff_stale", {
      requestId,
      deliveryId,
      phase,
      reason: state.status,
      expectedGeneration: telegramConfigGeneration,
    });
    return undefined;
  }

  // Discord interaction tokens expire 15 minutes after the user's slash
  // command. If we're already past the soft deadline on step entry
  // (Workflow DevKit long retries, or an unusually slow queue handoff),
  // skip the wake entirely and send an out-of-band "took too long"
  // notice while the token is still valid. Throwing a plain Error puts
  // this on the FatalError side of toWorkflowProcessingError so the
  // workflow does NOT retry — the interaction is permanently expired.
  if (channel === "discord" && typeof receivedAtMs === "number") {
    const ageMs = Date.now() - receivedAtMs;
    diag.discordInteractionAgeMsAtStepStart = ageMs;
    if (ageMs >= DISCORD_INTERACTION_SOFT_DEADLINE_MS) {
      const metaForDiscord = await getInitializedMeta();
      const notice = await sendDiscordTimeoutNotice({
        payload,
        botToken: metaForDiscord.channels.discord?.botToken ?? null,
        content: "🦞 Sorry — I took too long waking up. Try again.",
      });
      diag.discordInteractionExpiredPreempt = notice;
      logWarn("channels.discord_interaction_expired_preempt", {
        requestId,
        deliveryId,
        ageMs,
        notice,
        phase: "step-start",
      });
      throw new Error(
        `discord_interaction_expired_preempt ageMs=${ageMs} phase=step-start`,
      );
    }
  }

  try {
    if ((await currentTelegramConfigOrSettle("step-start")) === undefined) {
      return;
    }

    // --- Phase 1: Wake the sandbox ---
    console.log(`[DIAG] Phase 1: runWithBootMessages starting`);
    // Slack and Telegram keep the boot message alive past sandbox-ready so we
    // can fill the ~5s Claude-generating gap before the real reply arrives.
    const deferBootCleanup = channel === "slack" || channel === "telegram";
    const bootResult = await runWithBootMessages({
      channel: channel as ChannelName,
      adapter: buildMinimalBootAdapter(),
      message: { text: "", chatId: "", from: "" } as never,
      origin,
      reason: `channel:${channel}`,
      timeoutMs: WORKFLOW_SANDBOX_READY_TIMEOUT_MS,
      pollIntervalMs: channel === "telegram" ? 250 : undefined,
      existingBootHandle,
      deferCleanupToCaller: deferBootCleanup,
    });

    diag.bootResultStatus = bootResult.meta.status;
    diag.bootResultSandboxId = bootResult.meta.sandboxId;
    diag.bootMessageSent = bootResult.bootMessageSent;
    diag.bootCompletedAt = Date.now();
    diag.bootDurationMs = Date.now() - workflowStartedAt;
    console.log(`[DIAG] Phase 1 DONE: status=${bootResult.meta.status} sandboxId=${bootResult.meta.sandboxId} bootMessageSent=${bootResult.bootMessageSent} durationMs=${diag.bootDurationMs}`);
    await persistDiagSnapshot("boot-complete", {
      bootResultStatus: diag.bootResultStatus,
      bootResultSandboxId: diag.bootResultSandboxId,
      bootMessageSent: diag.bootMessageSent,
      bootDurationMs: diag.bootDurationMs,
    });

    const revalidateSandboxBeforeForward =
      options?.workflowHandoff?.revalidateSandboxBeforeForward === true;
    const useBootMetaDirectly =
      bootResult.admissionReady &&
      bootResult.meta.status === "running" &&
      !revalidateSandboxBeforeForward;
    const readyMeta = useBootMetaDirectly
      ? bootResult.meta
      : await ensureSandboxReady({
          origin,
          reason: `channel:${channel}`,
          timeoutMs: WORKFLOW_SANDBOX_READY_TIMEOUT_MS,
        });
    const currentMeta = await getInitializedMeta();
    const currentTelegramConfig =
      await currentTelegramConfigOrSettle("post-wake");
    if (channel === "telegram" && currentTelegramConfig === undefined) {
      return;
    }
    let effectiveReadyMeta = {
      ...readyMeta,
      channels: readyMeta.channels ?? currentMeta.channels,
    };
    if (channel === "telegram" && currentTelegramConfig) {
      effectiveReadyMeta = {
        ...effectiveReadyMeta,
        channels: {
          ...effectiveReadyMeta.channels,
          telegram: currentTelegramConfig,
        },
      };
    }
    let telegramRestoreContract =
      channel === "telegram"
        ? assessTelegramRestoreContract(effectiveReadyMeta)
        : null;

    const sandboxReadyAt = Date.now();
    diag.readyMetaStatus = effectiveReadyMeta.status;
    diag.readyMetaSandboxId = effectiveReadyMeta.sandboxId;
    diag.readyMetaPortUrlKeys = effectiveReadyMeta.portUrls ? Object.keys(effectiveReadyMeta.portUrls) : null;
    diag.readyMetaPortUrls = effectiveReadyMeta.portUrls;
    diag.readyMetaHasWebhookSecret = Boolean(effectiveReadyMeta.channels?.telegram?.webhookSecret);
    diag.usedBootMetaDirectly = useBootMetaDirectly;
    diag.revalidatedSandboxBeforeForward = revalidateSandboxBeforeForward;
    diag.telegramRestoreContractStatus = telegramRestoreContract?.status ?? null;
    diag.telegramRestoreContractRecordedAt =
      telegramRestoreContract?.restoreMetricsRecordedAt ?? null;
    diag.telegramRestoreExpected = telegramRestoreContract?.telegramExpected ?? null;
    diag.telegramRestoreListenerReady =
      telegramRestoreContract?.telegramListenerReady ?? null;
    diag.telegramRestoreListenerWaitMs =
      telegramRestoreContract?.telegramListenerWaitMs ?? null;
    diag.sandboxReadyAt = sandboxReadyAt;
    console.log(`[DIAG] Sandbox ready: status=${effectiveReadyMeta.status} sandboxId=${effectiveReadyMeta.sandboxId} portUrls=${JSON.stringify(effectiveReadyMeta.portUrls)} hasWebhookSecret=${diag.readyMetaHasWebhookSecret} usedBootMeta=${diag.usedBootMetaDirectly}`);
    await persistDiagSnapshot("sandbox-ready", {
      readyMetaStatus: diag.readyMetaStatus,
      readyMetaSandboxId: diag.readyMetaSandboxId,
      sandboxReadyAt,
      workflowToSandboxReadyMs: sandboxReadyAt - workflowStartedAt,
      restoreMetrics: effectiveReadyMeta.lastRestoreMetrics ?? null,
      telegramRestoreContractStatus: diag.telegramRestoreContractStatus,
      telegramRestoreContractRecordedAt: diag.telegramRestoreContractRecordedAt,
      telegramRestoreExpected: diag.telegramRestoreExpected,
      telegramRestoreListenerReady: diag.telegramRestoreListenerReady,
      telegramRestoreListenerWaitMs: diag.telegramRestoreListenerWaitMs,
    });

    logInfo("channels.workflow_sandbox_ready", {
      channel,
      requestId,
      bootResultStatus: bootResult.meta.status,
      sandboxId: effectiveReadyMeta.sandboxId,
      portUrlKeys: effectiveReadyMeta.portUrls ? Object.keys(effectiveReadyMeta.portUrls) : null,
      telegramRestoreContractStatus: telegramRestoreContract?.status ?? null,
      telegramRestoreContractRecordedAt:
        telegramRestoreContract?.restoreMetricsRecordedAt ?? null,
      telegramRestoreExpected: telegramRestoreContract?.telegramExpected ?? null,
      telegramRestoreListenerReady:
        telegramRestoreContract?.telegramListenerReady ?? null,
      telegramRestoreListenerWaitMs:
        telegramRestoreContract?.telegramListenerWaitMs ?? null,
    });

    if (
      channel === "telegram"
      && diag.usedBootMetaDirectly === true
      && telegramRestoreContract?.status === "unverified"
    ) {
      logWarn("channels.telegram_restore_contract_unverified", {
        channel,
        requestId,
        sandboxId: effectiveReadyMeta.sandboxId,
        restoreMetricsRecordedAt: telegramRestoreContract.restoreMetricsRecordedAt,
        telegramExpected: telegramRestoreContract.telegramExpected,
        telegramListenerReady: telegramRestoreContract.telegramListenerReady,
        telegramListenerWaitMs: telegramRestoreContract.telegramListenerWaitMs,
      });
    }

    // --- Phase 1.5: Proactively refresh AI Gateway token if close to expiry ---
    //
    // The sandbox holds an Authorization-header transform whose OIDC token
    // typically expires after ~1h. Once it expires, every chat completion
    // inside the sandbox 401s from ai-gateway.vercel.sh, and OpenClaw still
    // returns HTTP 200 to our webhook forward — so we never see the 401 at
    // this layer. Refreshing proactively when the TTL is low is the only
    // cheap way to avoid the user-visible "Something went wrong" reply.
    try {
      const tokenResult = await ensureUsableAiGatewayCredential({
        minRemainingMs: 10 * 60 * 1000,
        reason: `channel:${channel}:pre-forward`,
        controlPlaneOrigin: origin,
      });
      diag.preForwardTokenRefreshed = tokenResult.refreshed;
      diag.preForwardTokenReason = tokenResult.reason;
      diag.preForwardTokenSource = tokenResult.credential?.source ?? null;
      if (tokenResult.refreshed) {
        logInfo("channels.pre_forward_token_refreshed", {
          channel,
          requestId,
          sandboxId: effectiveReadyMeta.sandboxId,
          source: tokenResult.credential?.source ?? null,
          expiresAt: tokenResult.credential?.expiresAt ?? null,
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      diag.preForwardTokenError = errorMsg;
      logWarn("channels.pre_forward_token_refresh_failed", {
        channel,
        requestId,
        sandboxId: effectiveReadyMeta.sandboxId,
        error: errorMsg,
      });
      // Do not fail the delivery — the forward may still succeed with the
      // existing token if it has not yet expired.
    }

    // --- Phase 2: Forward raw payload to native handler ---
    let forwardResult: {
      ok: boolean;
      status: number;
      acceptance: NativeDeliveryAcceptance;
    };
    let retryingResult: RetryingForwardResult | null = null;

    const forwardStartedAt = Date.now();
    if (channel === "telegram") {
      diag.telegramWorkflowToFirstForwardAttemptMs = forwardStartedAt - workflowStartedAt;
    }
    console.log(`[DIAG] Phase 2: forwarding to native handler channel=${channel}`);

    // For Telegram, port 3000 readiness is not enough. Use at most one local
    // 127.0.0.1 probe as a transport hint, then let the retrying forward loop
    // be the readiness mechanism. Serial local/public probe loops add seconds
    // before the first real delivery attempt on the core chat path.
    if (channel === "telegram") {
      const telegramConfigBeforeProbe =
        await currentTelegramConfigOrSettle("pre-forward");
      if (telegramConfigBeforeProbe === undefined) {
        return;
      }
      if (telegramConfigBeforeProbe) {
        effectiveReadyMeta = {
          ...effectiveReadyMeta,
          channels: {
            ...effectiveReadyMeta.channels,
            telegram: telegramConfigBeforeProbe,
          },
        };
      }
      const { OPENCLAW_TELEGRAM_WEBHOOK_PORT } = await import("@/server/openclaw/config");
      const webhookSecret = effectiveReadyMeta.channels?.telegram?.webhookSecret ?? null;
      // Fast-restore already verified a local 401 on 127.0.0.1:8787 before
      // returning (config.ts:~927).  When that metric is present and fresh we
      // trust it and skip the redundant probe loop — each probe iteration pays
      // a 300-1500ms @vercel/sandbox runCommand roundtrip, and the public probe
      // loop burns up to 15s on Vercel's edge catch-all 200s even after the
      // handler is actually ready.
      //
      // Gate on status==="running" in addition to telegramListenerReady so
      // that readyMeta captured before the atomic status+metrics flip in
      // lifecycle.ts cannot cause us to trust stale previous-cycle metrics
      // while the current restore is still rebinding the handler.
      const restoreListenerReady =
        effectiveReadyMeta.status === "running"
        && effectiveReadyMeta.lastRestoreMetrics?.telegramListenerReady === true;
      const readinessMode = "single-local-hint";
      diag.telegramReadinessMode = readinessMode;
      const preForwardProbeStartedAt = Date.now();
      const localProbeResult: TelegramLocalProbeResult | null = restoreListenerReady
        ? {
            status: 401,
            ready: true,
            durationMs: 0,
            error: null,
            detail: "trusted-from-last-restore-metrics",
          }
        : effectiveReadyMeta.sandboxId
          ? await probeTelegramNativeHandlerLocally(
              effectiveReadyMeta.sandboxId,
              OPENCLAW_TELEGRAM_WEBHOOK_PORT,
              webhookSecret,
            )
          : null;
      diag.telegramProbeReady = null;
      diag.telegramProbeAttempts = null;
      diag.telegramProbeWaitMs = null;
      diag.telegramProbeLastStatus = null;
      diag.telegramProbePublicUrl = null;
      diag.telegramProbeTimeline = null;
      diag.telegramProbeSkippedReason =
        localProbeResult?.ready === true
          ? "local-handler-ready"
          : "collapsed-forward-loop";
      diag.telegramLocalProbeStatus = localProbeResult?.status ?? null;
      diag.telegramLocalProbeReady = localProbeResult?.ready ?? null;
      diag.telegramLocalProbeError = localProbeResult?.error ?? null;
      diag.telegramLocalProbeDetail = localProbeResult?.detail ?? null;
      diag.telegramLocalProbeDurationMs = localProbeResult?.durationMs ?? null;
      diag.telegramLocalProbeBodyLength = localProbeResult?.bodyLength ?? null;
      diag.telegramLocalProbeBodyHead = localProbeResult?.bodyHead ?? null;
      diag.telegramLocalProbeHeaders = localProbeResult?.headers ?? null;
      diag.telegramPreForwardProbeMs = Date.now() - preForwardProbeStartedAt;
      console.log(
        `[DIAG] Telegram native handler probe done: readinessMode=${readinessMode} publicReady=skipped attempts=0 waitMs=0 lastStatus=n/a localStatus=${localProbeResult?.status ?? "n/a"} localError=${localProbeResult?.error ?? "none"} localDetail=${localProbeResult?.detail ?? "none"}`,
      );
      await persistDiagSnapshot("telegram-probe-complete", {
        telegramProbeReady: diag.telegramProbeReady ?? null,
        telegramProbeAttempts: diag.telegramProbeAttempts ?? null,
        telegramProbeWaitMs: diag.telegramProbeWaitMs ?? null,
        telegramProbeLastStatus: diag.telegramProbeLastStatus ?? null,
        telegramProbeSkippedReason: diag.telegramProbeSkippedReason ?? null,
        telegramLocalProbeStatus: diag.telegramLocalProbeStatus ?? null,
        telegramLocalProbeReady: diag.telegramLocalProbeReady ?? null,
        telegramLocalProbeError: diag.telegramLocalProbeError ?? null,
        telegramLocalProbeDetail: diag.telegramLocalProbeDetail ?? null,
        telegramLocalProbeDurationMs: diag.telegramLocalProbeDurationMs ?? null,
        telegramReadinessMode: diag.telegramReadinessMode ?? null,
        telegramPreForwardProbeMs: diag.telegramPreForwardProbeMs ?? null,
      });

      const publicProbeSawDeadSandbox = false;
      const localProbeSawDeadSandbox = telegramLocalProbeSawConnectionRefused(localProbeResult);
      if (
        localProbeResult?.ready !== true
        && localProbeSawDeadSandbox
      ) {
        logWarn("channels.telegram_probe_dead_sandbox_reconcile", {
          channel,
          requestId,
          deliveryId,
          sandboxId: effectiveReadyMeta.sandboxId,
          publicProbeSawDeadSandbox,
          localProbeSawDeadSandbox,
          publicLastStatus: null,
          publicAttempts: null,
          publicWaitMs: null,
          publicUrl: null,
          localStatus: localProbeResult?.status ?? null,
          localError: localProbeResult?.error ?? null,
          localDetail: localProbeResult?.detail ?? null,
          action: "ensure_sandbox_ready_before_forward",
        });
        const repairedMeta = await ensureSandboxReady({
          origin,
          reason: "channel:telegram-dead-handler-port",
          timeoutMs: WORKFLOW_SANDBOX_READY_TIMEOUT_MS,
        });
        const repairedCurrentMeta = await getInitializedMeta();
        effectiveReadyMeta = {
          ...repairedMeta,
          channels: repairedMeta.channels ?? repairedCurrentMeta.channels,
        };
        telegramRestoreContract = assessTelegramRestoreContract(effectiveReadyMeta);
        diag.readyMetaStatus = effectiveReadyMeta.status;
        diag.readyMetaSandboxId = effectiveReadyMeta.sandboxId;
        diag.readyMetaPortUrlKeys = effectiveReadyMeta.portUrls ? Object.keys(effectiveReadyMeta.portUrls) : null;
        diag.readyMetaPortUrls = effectiveReadyMeta.portUrls;
        diag.readyMetaHasWebhookSecret = Boolean(effectiveReadyMeta.channels?.telegram?.webhookSecret);
        diag.telegramRestoreContractStatus = telegramRestoreContract.status;
        diag.telegramRestoreContractRecordedAt = telegramRestoreContract.restoreMetricsRecordedAt;
        diag.telegramRestoreExpected = telegramRestoreContract.telegramExpected;
        diag.telegramRestoreListenerReady = telegramRestoreContract.telegramListenerReady;
        diag.telegramRestoreListenerWaitMs = telegramRestoreContract.telegramListenerWaitMs;
        logInfo("channels.telegram_probe_dead_sandbox_recovered", {
          channel,
          requestId,
          deliveryId,
          sandboxId: effectiveReadyMeta.sandboxId,
          status: effectiveReadyMeta.status,
          portUrlKeys: effectiveReadyMeta.portUrls ? Object.keys(effectiveReadyMeta.portUrls) : null,
          telegramRestoreContractStatus: telegramRestoreContract.status,
        });
      }

      const capabilityAdmissions =
        await resolveWorkflowCapabilityAdmissions({
          meta: effectiveReadyMeta,
          hydrateVerifiedBundleIdentity,
        });
      diag.bundleCapabilityAdmissionSource = capabilityAdmissions.source;
      diag.telegramDurableAcceptanceAdmitted =
        capabilityAdmissions.telegramDurableAcceptanceAdmitted;
      diag.gatewayAdmissionRejectionAdmitted =
        capabilityAdmissions.gatewayAdmissionRejectionAdmitted;

      // The retry deadline is checked before each attempt, so one last fetch
      // can consume its full timeout after the wrapper deadline. Derive the
      // lease from both hard bounds plus cleanup margin; no config mutation
      // can pass the final generation check before dispatch settles.
      const telegramForwardLeaseTtlSeconds = Math.ceil(
        (
          RETRYING_FORWARD_TIMEOUT_MS +
          NATIVE_FORWARD_PER_FETCH_TIMEOUT_MS +
          30_000
        ) / 1000,
      );
      const configLease = await acquireChannelConfigLease("telegram", {
        ttlSeconds: telegramForwardLeaseTtlSeconds,
      });
      try {
        const telegramConfigBeforeForward =
          await currentTelegramConfigOrSettle("pre-forward");
        if (telegramConfigBeforeForward === undefined) {
          return;
        }
        if (telegramConfigBeforeForward) {
          effectiveReadyMeta = {
            ...effectiveReadyMeta,
            channels: {
              ...effectiveReadyMeta.channels,
              telegram: telegramConfigBeforeForward,
            },
          };
        }
        retryingResult = await forwardToNativeHandlerWithRetry(
          channel as ChannelName,
          payload,
          effectiveReadyMeta,
          getSandboxDomain,
          forwardTelegramToNativeHandlerLocally,
          localProbeResult?.ready === true,
          null,
          null,
          deliveryId,
          capabilityAdmissions.telegramDurableAcceptanceAdmitted,
          capabilityAdmissions.gatewayAdmissionRejectionAdmitted,
          origin,
        );
      } finally {
        await configLease.release();
      }
      diag.telegramReadinessMode = readinessMode;
      diag.telegramPreForwardProbeMs = Date.now() - preForwardProbeStartedAt;
      if (retryingResult.attemptsDetail?.[0]?.startedAtMs != null) {
        diag.telegramWorkflowToFirstForwardAttemptMs = Math.max(
          0,
          retryingResult.attemptsDetail[0].startedAtMs - workflowStartedAt,
        );
      }
      forwardResult = {
        ok: retryingResult.ok,
        status: retryingResult.status,
        acceptance:
          retryingResult.acceptance ??
          (retryingResult.ok ? "accepted" : "rejected"),
      };
    } else if (channel === "slack") {
      // Slack on port 3000 returns 404 until Bolt's HTTPReceiver registers
      // /slack/events (no base-server catch-all to worry about). The retry
      // wrapper handles the 404 window, 5xx, and fetch exceptions. Slack
      // signature headers from the original webhook request must be forwarded
      // intact — Bolt re-verifies signatures and rejects with 401 otherwise.
      let slackForwardHeaders =
        options?.workflowHandoff?.slackForwardHeaders ?? null;
      const slackRawBody = options?.workflowHandoff?.slackRawBody ?? null;
      // Always re-sign the Slack webhook when we have the signing secret
      // and raw body. The age-only gate (> 240s of Bolt's 5-minute wall)
      // missed a second failure mode: if the Slack signing secret rotated
      // between the original webhook ingest and this workflow step, the
      // original signature no longer matches the stored secret Bolt will
      // verify against, and Bolt fatally 401s regardless of timestamp age.
      // HMAC-SHA256 over the raw body takes microseconds; re-signing every
      // workflow forward is strictly safer than gating on age. Callers
      // that still want the age observable keep it in diag.
      // Emit a decision log unconditionally so post-mortem can
      // distinguish "resigned and still 401'd" from "didn't resign".
      const SLACK_RESIGN_AGE_SECONDS = 240;
      if (slackForwardHeaders && slackRawBody) {
        const signingSecret =
          effectiveReadyMeta.channels?.slack?.signingSecret ?? null;
        const originalTsRaw =
          slackForwardHeaders["x-slack-request-timestamp"] ?? null;
        const originalTs =
          typeof originalTsRaw === "string" && /^\d+$/.test(originalTsRaw)
            ? parseInt(originalTsRaw, 10)
            : null;
        const nowSeconds = Math.floor(Date.now() / 1000);
        const ageSeconds =
          originalTs !== null ? nowSeconds - originalTs : null;
        const shouldResign = signingSecret !== null;
        diag.slackOriginalTimestamp = originalTs;
        diag.slackSignatureAgeSeconds = ageSeconds;
        diag.slackSignatureResigned = shouldResign;
        diag.slackSignatureResignThresholdSeconds = SLACK_RESIGN_AGE_SECONDS;
        diag.slackSignatureResignReason = shouldResign
          ? "always-resign-workflow-forward"
          : "missing-signing-secret";
        logInfo("channels.slack_signature_decision", {
          requestId,
          deliveryId,
          resigned: shouldResign,
          ageSeconds,
          thresholdSeconds: SLACK_RESIGN_AGE_SECONDS,
          hasSigningSecret: Boolean(signingSecret),
          reason: shouldResign
            ? "always-resign-workflow-forward"
            : "missing-signing-secret",
        });
        if (shouldResign && signingSecret) {
          const freshTs = String(nowSeconds);
          const baseString = `v0:${freshTs}:${slackRawBody}`;
          const hmac = createHmac("sha256", signingSecret)
            .update(baseString)
            .digest("hex");
          slackForwardHeaders = {
            ...slackForwardHeaders,
            "x-slack-signature": `v0=${hmac}`,
            "x-slack-request-timestamp": freshTs,
          };
          logInfo("channels.slack_signature_resigned", {
            requestId,
            deliveryId,
            originalTs,
            ageSeconds,
            freshTs,
          });
        }
      }
      diag.slackForwardHeaderKeys = slackForwardHeaders
        ? Object.keys(slackForwardHeaders).sort()
        : null;
      diag.slackForwardHasSignature = Boolean(
        slackForwardHeaders?.["x-slack-signature"],
      );
      diag.slackForwardHasTimestamp = Boolean(
        slackForwardHeaders?.["x-slack-request-timestamp"],
      );
      const capabilityAdmissions = await resolveWorkflowCapabilityAdmissions({
        meta: effectiveReadyMeta,
        hydrateVerifiedBundleIdentity,
      });
      diag.bundleCapabilityAdmissionSource = capabilityAdmissions.source;
      diag.gatewayAdmissionRejectionAdmitted =
        capabilityAdmissions.gatewayAdmissionRejectionAdmitted;
      retryingResult = await forwardToNativeHandlerWithRetry(
        channel as ChannelName,
        payload,
        effectiveReadyMeta,
        getSandboxDomain,
        null,
        false,
        slackForwardHeaders,
        slackRawBody,
        deliveryId,
        false,
        capabilityAdmissions.gatewayAdmissionRejectionAdmitted,
        origin,
      );
      forwardResult = {
        ok: retryingResult.ok,
        status: retryingResult.status,
        acceptance:
          retryingResult.acceptance ??
          (retryingResult.ok ? "accepted" : "rejected"),
      };
    } else if (channel === "discord") {
      // Second Discord deadline check: sandbox wake can eat most of the
      // 15-minute interaction token budget. If we're past the soft
      // deadline now, don't bother forwarding — OpenClaw's native
      // Discord handler will race the expired token and the user just
      // sees "Thinking…" forever. Preempt with an out-of-band notice.
      if (channel === "discord" && typeof receivedAtMs === "number") {
        const ageMs = Date.now() - receivedAtMs;
        diag.discordInteractionAgeMsBeforeForward = ageMs;
        if (ageMs >= DISCORD_INTERACTION_SOFT_DEADLINE_MS) {
          const notice = await sendDiscordTimeoutNotice({
            payload,
            botToken: effectiveReadyMeta.channels.discord?.botToken ?? null,
            content: "🦞 Sorry — I took too long waking up. Try again.",
          });
          diag.discordInteractionExpiredPreempt = notice;
          logWarn("channels.discord_interaction_expired_preempt", {
            requestId,
            deliveryId,
            ageMs,
            notice,
            phase: "pre-forward",
          });
          throw new Error(
            `discord_interaction_expired_preempt ageMs=${ageMs} phase=pre-forward`,
          );
        }
      }
      const extraForwardHeaders =
        options?.workflowHandoff?.discordForwardHeaders ?? null;
      const rawBody = options?.workflowHandoff?.discordRawBody ?? null;
      diag[`${channel}ForwardHeaderKeys`] = extraForwardHeaders
        ? Object.keys(extraForwardHeaders).sort()
        : null;
      diag[`${channel}ForwardUsesRawBody`] = Boolean(rawBody);
      retryingResult = await forwardToNativeHandlerWithRetry(
        channel as ChannelName,
        payload,
        effectiveReadyMeta,
        getSandboxDomain,
        null,
        false,
        extraForwardHeaders,
        rawBody,
        deliveryId,
        false,
        false,
        origin,
      );
      forwardResult = {
        ok: retryingResult.ok,
        status: retryingResult.status,
        acceptance:
          retryingResult.acceptance ??
          (retryingResult.ok ? "accepted" : "rejected"),
      };
    } else {
      const directResult = await forwardToNativeHandler(
        channel as ChannelName,
        payload,
        effectiveReadyMeta,
        getSandboxDomain,
        null,
        null,
        deliveryId,
      );
      forwardResult = {
        ok: directResult.ok,
        status: directResult.status,
        acceptance: directResult.ok ? "accepted" : "rejected",
      };
    }

    const gatewayAdmissionClosed = retryingResult?.attemptsDetail?.some(
      (attempt) => attempt.classification === "gateway-unavailable",
    ) === true;
    if (gatewayAdmissionClosed) {
      // The native gateway explicitly closed admission while quiescing. Re-enter
      // lifecycle readiness once, then let the rejected result retry the step.
      // Replaying against the same closing gateway cannot become accepted.
      diag.gatewayAdmissionClosedRevalidation = "started";
      await ensureSandboxReady({
        origin,
        reason: `channel:${channel}:gateway-admission-closed`,
        timeoutMs: WORKFLOW_SANDBOX_READY_TIMEOUT_MS,
      });
      diag.gatewayAdmissionClosedRevalidation = "completed";
    }

    const forwardCompletedAt = Date.now();
    nativeAcceptance = forwardResult.acceptance;
    diag.forwardOk = forwardResult.ok;
    diag.forwardStatus = forwardResult.status;
    diag.forwardAcceptance = forwardResult.acceptance;
    diag.forwardDurationMs = forwardCompletedAt - forwardStartedAt;
    diag.forwardAttempts = retryingResult?.attempts ?? null;
    diag.forwardRetries = retryingResult?.retries ?? null;
    diag.forwardTotalMs = retryingResult?.totalMs ?? null;
    diag.forwardTransport =
      retryingResult?.transport
      ?? (channel === "telegram" || channel === "slack" ? "public" : null);
    diag.forwardAttemptTimeline = retryingResult?.attemptsDetail ?? null;
    console.log(`[DIAG] Phase 2 DONE: ok=${forwardResult.ok} status=${forwardResult.status} attempts=${retryingResult?.attempts ?? 1} retries=${JSON.stringify(retryingResult?.retries ?? [])} durationMs=${diag.forwardDurationMs}`);
    await persistDiagSnapshot("native-forward-complete", {
      forwardOk: diag.forwardOk,
      forwardStatus: diag.forwardStatus,
      forwardDurationMs: diag.forwardDurationMs,
      forwardAttempts: diag.forwardAttempts,
      forwardRetries: diag.forwardRetries,
      forwardTotalMs: diag.forwardTotalMs,
      forwardTransport: diag.forwardTransport,
      forwardAttemptTimeline: diag.forwardAttemptTimeline,
    });

    logInfo("channels.workflow_native_forward_result", {
      channel,
      requestId,
      sandboxId: effectiveReadyMeta.sandboxId,
      ok: forwardResult.ok,
      status: forwardResult.status,
      acceptance: forwardResult.acceptance,
      transport: retryingResult?.transport
        ?? (channel === "telegram" || channel === "slack" ? "public" : null),
      retryingForwardAttempts: retryingResult?.attempts ?? null,
      retryingForwardTotalMs: retryingResult?.totalMs ?? null,
      retryingForwardRetries: retryingResult?.retries?.length ?? null,
    });

    // Persist most-recent forward outcome to channel diagnostics so the
    // operator-facing surfaces (/api/channels/summary readiness,
    // /api/admin/why-not-ready, channel UI panels) can report ongoing
    // delivery health, not just the one-shot config-sync result.
    if (isChannelName(channel)) {
      const lastAttempt = retryingResult?.attemptsDetail?.[
        retryingResult.attemptsDetail.length - 1
      ] ?? null;
      const finalClassification =
        retryingResult && retryingResult.attempts >= RETRYING_FORWARD_MAX_ATTEMPTS && !forwardResult.ok
          ? "exhausted"
          : lastAttempt?.classification ?? (forwardResult.ok ? "accepted" : "handler-error");
      finalForwardClassification = finalClassification;
      const port = portForChannel(channel);
      const sandboxUrl = effectiveReadyMeta.portUrls?.[String(port)] ?? null;
      await recordChannelLastForward(
        channel,
        {
          ok: forwardResult.ok,
          status: forwardResult.status,
          classification: finalClassification,
          attempts: retryingResult?.attempts ?? 1,
          totalMs:
            retryingResult?.totalMs ??
            (forwardCompletedAt - forwardStartedAt),
          transport:
            retryingResult?.transport ??
            (channel === "telegram" || channel === "slack" ? "public" : null),
          sandboxUrl,
          sandboxId: effectiveReadyMeta.sandboxId ?? null,
          finalReasonHead: lastAttempt?.bodyHead
            ? lastAttempt.bodyHead.slice(0, 200)
            : null,
          startedAt: forwardStartedAt,
          completedAt: forwardCompletedAt,
          deliveryId: deliveryId ?? null,
        },
        forwardResult.acceptance === "unknown"
          ? { closedOutcome: "unknown" }
          : undefined,
      );
    }

    // Emit one end-to-end Telegram wake summary per request.
    if (channel === "telegram") {
      const restore = effectiveReadyMeta.lastRestoreMetrics;
      logInfo("channels.telegram_wake_summary", {
        channel,
        requestId,
        sandboxId: effectiveReadyMeta.sandboxId,
        bootResultStatus: bootResult.meta.status,
        webhookToWorkflowMs: typeof receivedAtMs === "number" ? Math.max(0, workflowStartedAt - receivedAtMs) : null,
        workflowToSandboxReadyMs: sandboxReadyAt - workflowStartedAt,
        forwardMs: forwardCompletedAt - forwardStartedAt,
        endToEndMs: typeof receivedAtMs === "number" ? Math.max(0, forwardCompletedAt - receivedAtMs) : null,
        restoreTotalMs: restore?.totalMs ?? null,
        sandboxCreateMs: restore?.sandboxCreateMs ?? null,
        assetSyncMs: restore?.assetSyncMs ?? null,
        startupScriptMs: restore?.startupScriptMs ?? null,
        localReadyMs: restore?.localReadyMs ?? null,
        postLocalReadyBlockingMs: restore?.postLocalReadyBlockingMs ?? null,
        publicReadyMs: restore?.publicReadyMs ?? null,
        bootOverlapMs: restore?.bootOverlapMs ?? null,
        skippedStaticAssetSync: restore?.skippedStaticAssetSync ?? null,
        skippedDynamicConfigSync: restore?.skippedDynamicConfigSync ?? null,
        dynamicConfigReason: restore?.dynamicConfigReason ?? null,
        telegramProbeReady: diag.telegramProbeReady ?? diag.telegramLocalProbeReady ?? null,
        telegramRestoreContractStatus: telegramRestoreContract?.status ?? null,
        telegramRestoreContractRecordedAt:
          telegramRestoreContract?.restoreMetricsRecordedAt ?? null,
        telegramRestoreExpected: telegramRestoreContract?.telegramExpected ?? null,
        telegramRestoreListenerReady:
          telegramRestoreContract?.telegramListenerReady ?? null,
        telegramRestoreListenerWaitMs:
          telegramRestoreContract?.telegramListenerWaitMs ?? null,
        telegramProbeLastStatus: diag.telegramProbeLastStatus ?? null,
        telegramProbePublicUrl: diag.telegramProbePublicUrl ?? null,
        telegramProbeSkippedReason:
          typeof diag.telegramProbeSkippedReason === "string"
            ? diag.telegramProbeSkippedReason
            : null,
        telegramReadinessMode: diag.telegramReadinessMode ?? null,
        telegramPreForwardProbeMs: diag.telegramPreForwardProbeMs ?? null,
        telegramWorkflowToFirstForwardAttemptMs: diag.telegramWorkflowToFirstForwardAttemptMs ?? null,
        telegramLocalProbeStatus: diag.telegramLocalProbeStatus ?? null,
        telegramLocalProbeReady: diag.telegramLocalProbeReady ?? null,
        telegramLocalProbeError: diag.telegramLocalProbeError ?? null,
        telegramLocalProbeDetail: diag.telegramLocalProbeDetail ?? null,
        telegramLocalProbeDurationMs: diag.telegramLocalProbeDurationMs ?? null,
        telegramLocalProbeBodyLength: diag.telegramLocalProbeBodyLength ?? null,
        telegramLocalProbeBodyHead: diag.telegramLocalProbeBodyHead ?? null,
        telegramLocalProbeHeaders: diag.telegramLocalProbeHeaders ?? null,
        retryingForwardAttempts: retryingResult?.attempts ?? null,
        retryingForwardTotalMs: retryingResult?.totalMs ?? null,
        retryingForwardTransport: retryingResult?.transport ?? null,
        retryingForwardAttemptTimeline: retryingResult?.attemptsDetail ?? null,
        telegramReconcileBlocking: restore?.telegramReconcileBlocking ?? null,
        telegramReconcileMs: restore?.telegramReconcileMs ?? null,
        telegramSecretSyncBlocking: restore?.telegramSecretSyncBlocking ?? null,
        telegramSecretSyncMs: restore?.telegramSecretSyncMs ?? null,
        hotSpareHit: restore?.hotSpareHit ?? null,
        hotSparePromotionMs: restore?.hotSparePromotionMs ?? null,
        hotSpareRejectReason: restore?.hotSpareRejectReason ?? null,
      });
    }

    // Emit one end-to-end Slack wake summary per request.
    if (channel === "slack") {
      const restore = effectiveReadyMeta.lastRestoreMetrics;
      logInfo("channels.slack_wake_summary", {
        channel,
        requestId,
        sandboxId: effectiveReadyMeta.sandboxId,
        bootResultStatus: bootResult.meta.status,
        webhookToWorkflowMs: typeof receivedAtMs === "number" ? Math.max(0, workflowStartedAt - receivedAtMs) : null,
        workflowToSandboxReadyMs: sandboxReadyAt - workflowStartedAt,
        forwardMs: forwardCompletedAt - forwardStartedAt,
        endToEndMs: typeof receivedAtMs === "number" ? Math.max(0, forwardCompletedAt - receivedAtMs) : null,
        restoreTotalMs: restore?.totalMs ?? null,
        sandboxCreateMs: restore?.sandboxCreateMs ?? null,
        assetSyncMs: restore?.assetSyncMs ?? null,
        startupScriptMs: restore?.startupScriptMs ?? null,
        localReadyMs: restore?.localReadyMs ?? null,
        publicReadyMs: restore?.publicReadyMs ?? null,
        bootOverlapMs: restore?.bootOverlapMs ?? null,
        skippedStaticAssetSync: restore?.skippedStaticAssetSync ?? null,
        skippedDynamicConfigSync: restore?.skippedDynamicConfigSync ?? null,
        dynamicConfigReason: restore?.dynamicConfigReason ?? null,
        slackForwardHeaderKeys: diag.slackForwardHeaderKeys ?? null,
        slackForwardHasSignature: diag.slackForwardHasSignature ?? null,
        slackForwardHasTimestamp: diag.slackForwardHasTimestamp ?? null,
        retryingForwardAttempts: retryingResult?.attempts ?? null,
        retryingForwardTotalMs: retryingResult?.totalMs ?? null,
        retryingForwardTransport: retryingResult?.transport ?? null,
        retryingForwardRetries: retryingResult?.retries?.length ?? null,
        retryingForwardAttemptTimeline: retryingResult?.attemptsDetail ?? null,
        hotSpareHit: restore?.hotSpareHit ?? null,
        hotSparePromotionMs: restore?.hotSparePromotionMs ?? null,
        hotSpareRejectReason: restore?.hotSpareRejectReason ?? null,
      });
    }

    if (channel === "discord") {
      const restore = effectiveReadyMeta.lastRestoreMetrics;
      logInfo(`channels.${channel}_wake_summary`, {
        channel,
        requestId,
        sandboxId: effectiveReadyMeta.sandboxId,
        bootResultStatus: bootResult.meta.status,
        webhookToWorkflowMs: typeof receivedAtMs === "number" ? Math.max(0, workflowStartedAt - receivedAtMs) : null,
        workflowToSandboxReadyMs: sandboxReadyAt - workflowStartedAt,
        forwardMs: forwardCompletedAt - forwardStartedAt,
        endToEndMs: typeof receivedAtMs === "number" ? Math.max(0, forwardCompletedAt - receivedAtMs) : null,
        restoreTotalMs: restore?.totalMs ?? null,
        sandboxCreateMs: restore?.sandboxCreateMs ?? null,
        assetSyncMs: restore?.assetSyncMs ?? null,
        startupScriptMs: restore?.startupScriptMs ?? null,
        localReadyMs: restore?.localReadyMs ?? null,
        publicReadyMs: restore?.publicReadyMs ?? null,
        bootOverlapMs: restore?.bootOverlapMs ?? null,
        skippedStaticAssetSync: restore?.skippedStaticAssetSync ?? null,
        skippedDynamicConfigSync: restore?.skippedDynamicConfigSync ?? null,
        dynamicConfigReason: restore?.dynamicConfigReason ?? null,
        forwardHeaderKeys: diag[`${channel}ForwardHeaderKeys`] ?? null,
        forwardUsesRawBody: diag[`${channel}ForwardUsesRawBody`] ?? null,
        retryingForwardAttempts: retryingResult?.attempts ?? null,
        retryingForwardTotalMs: retryingResult?.totalMs ?? null,
        retryingForwardTransport: retryingResult?.transport ?? null,
        retryingForwardRetries: retryingResult?.retries?.length ?? null,
        retryingForwardAttemptTimeline: retryingResult?.attemptsDetail ?? null,
        hotSpareHit: restore?.hotSpareHit ?? null,
        hotSparePromotionMs: restore?.hotSparePromotionMs ?? null,
        hotSpareRejectReason: restore?.hotSpareRejectReason ?? null,
      });
    }

    // Native acceptance and user-visible reply are separate states. There is
    // not yet a reply observer that could clear a retained wake notice, so
    // acceptance transfers UI ownership to the native handler and clears it;
    // otherwise every successful delivery would leave a permanent placeholder.
    // Uncertain native acceptance keeps an explicit warning visible instead.
    if (existingBootHandle) {
      if (channel === "slack" && forwardResult.ok) {
        diag.bootMessageAction = "slack-cleared-after-native-accept";
        diag.bootMessageClearedAt = Date.now();
        await existingBootHandle
          .clear()
          .then(() => {
            logInfo("channels.slack_boot_message_cleared_after_accept", {
              channel,
              requestId,
              deliveryId,
              bootMessageId: bootMessageId ?? null,
              forwardStatus: forwardResult.status,
              forwardAttempts: retryingResult?.attempts ?? null,
              forwardTransport: retryingResult?.transport ?? null,
              forwardTotalMs: retryingResult?.totalMs ?? null,
              placeholderAction: "cleared",
              clearOnAccept: true,
              reason: "native_handler_accepted_event",
            });
          })
          .catch((bootError) => {
            logWarn("channels.slack_boot_message_cleanup_after_accept_failed", {
              channel,
              requestId,
              deliveryId,
              bootMessageId: bootMessageId ?? null,
              phase: "accepted-forward",
              forwardStatus: forwardResult.status,
              error:
                bootError instanceof Error
                  ? bootError.message
                  : String(bootError),
            });
          });
      } else if (channel === "telegram" && forwardResult.ok) {
        diag.bootMessageAction = "telegram-cleared-after-durable-accept";
        diag.bootMessageClearedAt = Date.now();
        await existingBootHandle
          .clear()
          .then(() => {
            logInfo("channels.telegram_boot_message_cleared_after_accept", {
              channel,
              requestId,
              deliveryId,
              bootMessageId: bootMessageId ?? null,
              forwardStatus: forwardResult.status,
              forwardAttempts: retryingResult?.attempts ?? null,
              forwardTransport: retryingResult?.transport ?? null,
              forwardTotalMs: retryingResult?.totalMs ?? null,
              placeholderAction: "cleared",
              clearOnAccept: true,
              reason: "native_handler_durably_accepted_update",
            });
          })
          .catch((bootError) => {
            logWarn("channels.telegram_boot_message_cleanup_after_accept_failed", {
              channel,
              requestId,
              deliveryId,
              bootMessageId: bootMessageId ?? null,
              phase: "accepted-forward",
              forwardStatus: forwardResult.status,
              error:
                bootError instanceof Error
                  ? bootError.message
                  : String(bootError),
            });
          });
      } else if (
        (channel === "slack" || channel === "telegram") &&
        forwardResult.acceptance === "unknown"
      ) {
        diag.bootMessageAction = `${channel}-terminal-acceptance-unknown`;
        await existingBootHandle
          .update(
            "🦞 Delivery could not be confirmed. Check for a reply before retrying.",
          )
          .catch((bootError) => {
            logWarn("channels.workflow_boot_unknown_update_failed", {
              channel,
              requestId,
              deliveryId,
              error:
                bootError instanceof Error
                  ? bootError.message
                  : String(bootError),
            });
          });
      } else {
        // Forward failed. Instead of silently deleting the boot message
        // (which left the user staring at an empty channel after their
        // boot placeholder vanished), edit it to a status-
        // appropriate message so they know whether we're still trying
        // or have given up. A retryable 5xx becomes a RetryableError
        // upstream and the workflow step re-enters from the top; keep
        // the message alive for that retry. A non-retryable 4xx is
        // terminal, so tell the user explicitly.
        const retryableForwardFailure = forwardResult.status >= 500;
        await existingBootHandle
          .update(
            retryableForwardFailure
              ? "🦞 Route not ready yet. Retrying\u2026"
              : "🦞 Channel route failed. Try again in a minute.",
          )
          .catch((bootError) => {
            logWarn("channels.workflow_boot_forward_failure_update_failed", {
              channel,
              requestId,
              deliveryId,
              forwardStatus: forwardResult.status,
              retryableForwardFailure,
              error:
                bootError instanceof Error
                  ? bootError.message
                  : String(bootError),
            });
          });
      }
    }

    diag.outcome =
      forwardResult.acceptance === "accepted"
        ? "success"
        : forwardResult.acceptance === "unknown"
          ? "delivery-unknown"
          : `failed:${forwardResult.status}`;
    diag.completedAt = Date.now();
    diag.totalDurationMs = Date.now() - workflowStartedAt;
    console.log(`[DIAG] processChannelStep END outcome=${diag.outcome} totalMs=${diag.totalDurationMs}`);

    // Write diagnostic trace to store for admin retrieval
    try {
      await getStore().setValue(channelForwardDiagnosticKey(), diag, 3600);
    } catch { /* best effort */ }

    if (forwardResult.acceptance === "rejected") {
      throw new Error(
        `native_forward_failed status=${forwardResult.status}`,
      );
    }
    if (
      forwardResult.acceptance === "unknown" &&
      isChannelName(channel)
    ) {
      // Unknown supersedes any older definite rejection for this delivery.
      const blockedRecord = await recordChannelDlqFailure({
        channel,
        deliveryId,
        phase: "workflow-step-failed",
        terminal: true,
        retryable: false,
        deliveryOutcome: "unknown",
        requestId,
        receivedAtMs,
        error: new Error("native_delivery_outcome_unknown"),
        diag,
      }).catch(() => null);
      if (!blockedRecord) {
        logWarn("channels.dlq_unknown_outcome_record_failed", {
          channel,
          deliveryId,
        });
      }
    }
    if (
      forwardResult.acceptance === "accepted" &&
      isChannelName(channel)
    ) {
      await resolveChannelDlqFailure(channel, deliveryId).catch((error) => {
        logWarn("channels.dlq_resolution_failed", {
          channel,
          deliveryId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  } catch (error) {
    diag.outcome = "error";
    diag.error = error instanceof Error ? error.message : String(error);
    diag.completedAt = Date.now();
    diag.totalDurationMs = Date.now() - workflowStartedAt;
    console.log(`[DIAG] processChannelStep ERROR: ${diag.error} totalMs=${diag.totalDurationMs}`);

    // Write diagnostic trace to store even on failure
    try {
      await getStore().setValue(channelForwardDiagnosticKey(), diag, 3600);
    } catch { /* best effort */ }

    const retryBudget = resolveRetryBudget(receivedAtMs, resolvedDependencies);
    diag.workflowAttempt = retryBudget.attempt;
    diag.workflowRetryWallClockMs = retryBudget.wallClockMs;
    diag.workflowRetryBudgetExceeded = retryBudget.exceeded;
    diag.workflowRetryBudgetReason = retryBudget.reason;

    const workflowError = toWorkflowProcessingError(
      channel,
      error,
      resolvedDependencies,
      retryBudget,
    );
    const terminal = workflowError.name === "FatalError";
    const persistentFailure = terminal && retryBudget.exceeded;
    if (terminal && isChannelName(channel)) {
      const closedOutcome =
        nativeAcceptance === "unknown" ? "unknown" : "failed";
      await recordChannelDeliveryClosedOutcome({
        channel,
        deliveryId,
        outcome: closedOutcome,
        reason:
          closedOutcome === "unknown"
            ? "native-delivery-outcome-unknown"
            : `terminal_${finalForwardClassification ?? "workflow-failure"}`,
      });
    }

    // Pre-forward exceptions (sandbox ready timeout, probe failure, etc.)
    // and post-forward throws both land here. Slack/Telegram pass
    // deferCleanupToCaller: true so the boot message is still alive —
    // surface the terminal vs retryable state to the user instead of
    // letting the boot placeholder linger forever (terminal) or vanish
    // silently (retryable). Best effort: boot-handle errors must not
    // shadow the original workflow failure being thrown.
    //
    // When the retry budget is exhausted, use a stronger message so the
    // user knows this isn't a transient blip they'll hear back about.
    if (existingBootHandle) {
      await existingBootHandle
        .update(
          persistentFailure
            ? "🦞 The sandbox is having trouble. Our team has been notified."
            : terminal
              ? "🦞 Something went wrong — try again in a moment."
              : "🦞 Still waking the sandbox. Retrying\u2026",
        )
        .catch((bootError) => {
          logWarn("channels.workflow_boot_failure_update_failed", {
            channel,
            requestId,
            deliveryId,
            terminal,
            persistentFailure,
            error:
              bootError instanceof Error
                ? bootError.message
                : String(bootError),
          });
        });
    }

    await recordWorkflowFailure({
      channel,
      requestId,
      deliveryId,
      terminal,
      error,
      diag,
      receivedAtMs,
      deliveryOutcome:
        nativeAcceptance === "unknown" ? "unknown" : "not-accepted",
    });
    throw workflowError;
  }
}

type TelegramWorkflowConfigState =
  | { status: "untracked"; config: TelegramChannelConfig | null }
  | { status: "current"; config: TelegramChannelConfig }
  | { status: "deleted" | "missing" | "rotated"; config: null };

async function readTelegramWorkflowConfigState(input: {
  fallbackTelegramConfig: TelegramChannelConfig | null;
  expectedGeneration: number | null;
  requireGeneration: boolean;
}): Promise<TelegramWorkflowConfigState> {
  const current = (await getInitializedMeta()).channels.telegram;
  if (!input.fallbackTelegramConfig) {
    if (input.requireGeneration) {
      return { status: "missing", config: null };
    }
    return { status: "untracked", config: current };
  }

  if (!current) {
    return { status: "deleted", config: null };
  }

  const expectedGeneration =
    input.expectedGeneration ?? input.fallbackTelegramConfig.configuredAt;
  const sameGeneration = current.configuredAt === expectedGeneration;
  const sameCredentials =
    current.botToken === input.fallbackTelegramConfig.botToken &&
    current.webhookSecret === input.fallbackTelegramConfig.webhookSecret;
  return sameGeneration && sameCredentials
    ? { status: "current", config: current }
    : { status: "rotated", config: null };
}

const NATIVE_HANDLER_TIMEOUT_ERROR = "native_handler_timeout";

const TELEGRAM_PROBE_MAX_ATTEMPTS = 20;
const TELEGRAM_PROBE_INTERVAL_MS = 500;
const TELEGRAM_PROBE_TIMEOUT_MS = 15_000;

export type TelegramProbeResult = {
  ready: boolean;
  attempts: number;
  waitMs: number;
  lastStatus: number | null;
  publicUrl?: string | null;
  timeline?: TelegramProbeAttempt[];
};

export type TelegramProbeAttempt = {
  attempt: number;
  elapsedMs: number;
  durationMs?: number | null;
  status: number | null;
  bodyLength?: number | null;
  bodyHead?: string | null;
  headers?: DiagnosticHeaders | null;
  error?: string | null;
};

export type TelegramLocalProbeResult = {
  status: number | null;
  ready: boolean;
  durationMs?: number | null;
  bodyLength?: number | null;
  bodyHead?: string | null;
  headers?: DiagnosticHeaders | null;
  error: string | null;
  detail?: string | null;
};

export type DiagnosticHeaders = {
  server?: string | null;
  contentType?: string | null;
  contentLength?: string | null;
  xPoweredBy?: string | null;
  via?: string | null;
  cacheControl?: string | null;
  openclawDeliveryAccepted?: string | null;
};

type TelegramLocalProbeJson = {
  status?: number;
  durationMs?: number;
  bodyLength?: number;
  bodyHead?: string;
  headers?: DiagnosticHeaders | null;
  error?: string | null;
  detail?: string | null;
};

type TelegramForwardProbeJson = {
  ok?: boolean;
  status?: number;
  durationMs?: number;
  bodyLength?: number;
  bodyHead?: string;
  headers?: DiagnosticHeaders | null;
  error?: string | null;
  detail?: string | null;
  processSnapshot?: string | null;
  logTail?: string | null;
};

function parseWorkflowJson<T>(stdout: string): T | null {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    return null;
  }
}

export type ForwardAttemptDetail = {
  attempt: number;
  startedAtMs: number;
  elapsedMs: number;
  durationMs: number | null;
  status: number | null;
  ok: boolean | null;
  bodyLength: number | null;
  bodyHead: string | null;
  headers: DiagnosticHeaders | null;
  transport: "public" | "local";
  classification: string;
  acceptance?: NativeDeliveryAcceptance;
  error?: string | null;
  detail?: string | null;
  processSnapshot?: string | null;
  logTail?: string | null;
};

function pickDiagnosticHeaders(headers: Headers): DiagnosticHeaders {
  return {
    server: headers.get("server"),
    contentType: headers.get("content-type"),
    contentLength: headers.get("content-length"),
    xPoweredBy: headers.get("x-powered-by"),
    via: headers.get("via"),
    cacheControl: headers.get("cache-control"),
    openclawDeliveryAccepted: headers.get("x-openclaw-delivery-accepted"),
  };
}

function optionalDiagnosticString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Poll the Telegram native handler on port 8787 until the webhook route
 * is registered.  The gateway starts a base HTTP server on 8787 immediately,
 * but the Telegram provider takes 2-4 seconds to register the
 * `/telegram-webhook` path. During that window the base server can return
 * a response that does not carry OpenClaw's durable-acceptance marker.
 *
 * We send a GET to `/telegram-webhook` — the registered handler returns
 * 401 (missing secret header), while the base server returns 404.
 * When we see 401, the handler is ready and we can forward the real payload.
 */
async function waitForTelegramNativeHandler(
  getSandboxDomain: (port?: number) => Promise<string>,
  port: number,
  webhookSecret: string | null,
): Promise<TelegramProbeResult> {
  const startedAt = Date.now();
  const deadline = startedAt + TELEGRAM_PROBE_TIMEOUT_MS;
  let lastStatus: number | null = null;
  let lastPublicUrl: string | null = null;
  const timeline: TelegramProbeAttempt[] = [];

  for (let attempt = 1; attempt <= TELEGRAM_PROBE_MAX_ATTEMPTS && Date.now() < deadline; attempt++) {
    try {
      const sandboxUrl = await getSandboxDomain(port);
      lastPublicUrl = sandboxUrl;
      const attemptStartedAt = Date.now();
      // Send a POST with an invalid secret — if the Telegram handler is
      // registered it returns 401 (secret mismatch).  The base server
      // returns 404 (path not found) or 200 (generic catch-all).
      const resp = await fetch(`${sandboxUrl}/telegram-webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(webhookSecret ? { "x-telegram-bot-api-secret-token": "probe-invalid-secret" } : {}),
        },
        body: JSON.stringify({ probe: true }),
        signal: AbortSignal.timeout(3_000),
      });
      const probeBody = await resp.text().catch(() => "");
      lastStatus = resp.status;
      timeline.push({
        attempt,
        elapsedMs: Date.now() - startedAt,
        durationMs: Date.now() - attemptStartedAt,
        status: resp.status,
        bodyLength: probeBody.length,
        bodyHead: probeBody.slice(0, 200),
        headers: pickDiagnosticHeaders(resp.headers),
      });

      // 401 = Telegram handler is registered and rejecting our invalid secret.
      // This means the real forward with the correct secret will be accepted.
      if (resp.status === 401) {
        console.log(`[DIAG] telegram_probe: ready at attempt=${attempt} status=401 waitMs=${Date.now() - startedAt}`);
        return {
          ready: true,
          attempts: attempt,
          waitMs: Date.now() - startedAt,
          lastStatus: 401,
          publicUrl: lastPublicUrl,
          timeline,
        };
      }

      console.log(`[DIAG] telegram_probe: attempt=${attempt} status=${resp.status} (not ready)`);
    } catch (err) {
      timeline.push({
        attempt,
        elapsedMs: Date.now() - startedAt,
        durationMs: null,
        status: null,
        bodyLength: null,
        bodyHead: null,
        headers: null,
        error: err instanceof Error ? err.message : String(err),
      });
      console.log(`[DIAG] telegram_probe: attempt=${attempt} error=${err instanceof Error ? err.message : String(err)}`);
    }

    if (attempt < TELEGRAM_PROBE_MAX_ATTEMPTS && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, TELEGRAM_PROBE_INTERVAL_MS));
    }
  }

  console.log(`[DIAG] telegram_probe: TIMEOUT after ${Date.now() - startedAt}ms lastStatus=${lastStatus}`);
  // Timed out — proceed anyway and let the retrying forward handle it.
  return {
    ready: false,
    attempts: TELEGRAM_PROBE_MAX_ATTEMPTS,
    waitMs: Date.now() - startedAt,
    lastStatus,
    publicUrl: lastPublicUrl,
    timeline,
  };
}

async function probeTelegramNativeHandlerLocally(
  sandboxId: string,
  port: number,
  webhookSecret: string | null,
): Promise<TelegramLocalProbeResult> {
  try {
    const [{ getSandboxController }, { OPENCLAW_TELEGRAM_INTERNAL_WEBHOOK_PATH }] = await Promise.all([
      import("@/server/sandbox/controller"),
      import("@/server/openclaw/config"),
    ]);
    const sandbox = await getSandboxController().get({ sandboxId });
    const script = `
const startedAt = Date.now();
const [port, path, useSecret] = process.argv.slice(1);
const url = \`http://127.0.0.1:\${port}\${path}\`;
const headers = { "content-type": "application/json" };
if (useSecret === "1") headers["x-telegram-bot-api-secret-token"] = "probe-invalid-secret";
function pick(headers) {
  return {
    server: headers.get("server"),
    contentType: headers.get("content-type"),
    contentLength: headers.get("content-length"),
    xPoweredBy: headers.get("x-powered-by"),
	    via: headers.get("via"),
	    cacheControl: headers.get("cache-control"),
	    openclawDeliveryAccepted: headers.get("x-openclaw-delivery-accepted"),
  };
}
fetch(url, {
  method: "POST",
  headers,
  body: JSON.stringify({ probe: true }),
  signal: AbortSignal.timeout(3000),
}).then(async (response) => {
  const text = await response.text().catch(() => "");
  process.stdout.write(JSON.stringify({
    status: response.status,
    durationMs: Date.now() - startedAt,
    bodyLength: text.length,
    bodyHead: text.slice(0, 200),
    headers: pick(response.headers),
    error: null,
  }));
}).catch((error) => {
  process.stdout.write(JSON.stringify({
    status: 0,
    durationMs: Date.now() - startedAt,
    bodyLength: 0,
    bodyHead: "",
    headers: null,
    error: error instanceof Error ? error.message : String(error),
    detail: error instanceof Error && "cause" in error
      ? String((error as Error & { cause?: unknown }).cause ?? "")
      : null,
  }));
});
`.trim();
    const result = await sandbox.runCommand("node", [
      "-e",
      script,
      String(port),
      OPENCLAW_TELEGRAM_INTERNAL_WEBHOOK_PATH,
      webhookSecret ? "1" : "0",
    ], {
      signal: AbortSignal.timeout(5_000),
    });
    const stdout = (await result.output("stdout")).trim();
    const parsed = parseWorkflowJson<TelegramLocalProbeJson>(stdout);
    const status = parsed && typeof parsed.status === "number" ? parsed.status : null;
    return {
      status,
      ready: status === 401,
      durationMs: parsed?.durationMs ?? null,
      bodyLength: parsed?.bodyLength ?? null,
      bodyHead: parsed?.bodyHead ?? null,
      headers: parsed?.headers ?? null,
      error: parsed?.error ?? null,
      detail: parsed?.detail ?? null,
    };
  } catch (error) {
    return {
      status: null,
      ready: false,
      durationMs: null,
      bodyLength: null,
      bodyHead: null,
      headers: null,
      error: error instanceof Error ? error.message : String(error),
      detail:
        error instanceof Error && "cause" in error
          ? String((error as Error & { cause?: unknown }).cause ?? "")
          : null,
    };
  }
}

async function forwardTelegramToNativeHandlerLocally(
  sandboxId: string,
  payload: unknown,
  webhookSecret: string | null,
  deliveryId: string | null = null,
): Promise<{
  ok: boolean;
  status: number;
  durationMs: number;
  bodyLength: number;
  bodyHead: string;
  headers: DiagnosticHeaders | null;
  error?: string | null;
  detail?: string | null;
  processSnapshot?: string | null;
  logTail?: string | null;
}> {
  try {
    const [{ getSandboxController }, { OPENCLAW_TELEGRAM_INTERNAL_WEBHOOK_PATH, OPENCLAW_TELEGRAM_WEBHOOK_PORT }] = await Promise.all([
      import("@/server/sandbox/controller"),
      import("@/server/openclaw/config"),
    ]);
    const sandbox = await getSandboxController().get({ sandboxId });
    const script = `
const startedAt = Date.now();
const [port, path, payloadJson, secret, deliveryId] = process.argv.slice(1);
const url = \`http://127.0.0.1:\${port}\${path}\`;
const headers = { "content-type": "application/json" };
if (secret) headers["x-telegram-bot-api-secret-token"] = secret;
if (deliveryId) headers["x-openclaw-delivery-id"] = deliveryId;
function pick(headers) {
  return {
    server: headers.get("server"),
    contentType: headers.get("content-type"),
    contentLength: headers.get("content-length"),
    xPoweredBy: headers.get("x-powered-by"),
    via: headers.get("via"),
    cacheControl: headers.get("cache-control"),
    openclawDeliveryAccepted: headers.get("x-openclaw-delivery-accepted"),
  };
}
async function collectFailureContext() {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const run = async (cmd, args) => {
    try {
      const out = await execFileAsync(cmd, args, { timeout: 2000, maxBuffer: 64 * 1024 });
      return String(out.stdout || "").trim().slice(-4000);
    } catch (error) {
      return String(error && error.message ? error.message : error).slice(-1000);
    }
  };
  const processSnapshot = await run("sh", ["-c", "ps -eo pid,comm,args | grep -E '[o]penclaw|[n]ode|[t]elegram' | tail -40"]);
  const logTail = await run("sh", ["-c", "tail -120 /tmp/openclaw/openclaw-*.log /tmp/openclaw.log 2>/dev/null | grep -Ei 'telegram|webhook|8787|plugin|error|failed|listen|exception' | tail -80"]);
  return { processSnapshot, logTail };
}
fetch(url, {
  method: "POST",
  headers,
  body: payloadJson,
  signal: AbortSignal.timeout(5000),
}).then(async (response) => {
  const text = await response.text().catch(() => "");
  const context = response.ok ? { processSnapshot: null, logTail: null } : await collectFailureContext();
  process.stdout.write(JSON.stringify({
    ok: response.ok,
    status: response.status,
    durationMs: Date.now() - startedAt,
    bodyLength: text.length,
    bodyHead: text.slice(0, 300),
    headers: pick(response.headers),
    error: null,
    detail: null,
    processSnapshot: context.processSnapshot,
    logTail: context.logTail,
  }));
}).catch((error) => {
  collectFailureContext().then((context) => process.stdout.write(JSON.stringify({
    ok: false,
    status: 0,
    durationMs: Date.now() - startedAt,
    bodyLength: 0,
    bodyHead: "",
    headers: null,
    error: error instanceof Error ? error.message : String(error),
    detail: error instanceof Error && "cause" in error
      ? String((error as Error & { cause?: unknown }).cause ?? "")
      : null,
    processSnapshot: context.processSnapshot,
    logTail: context.logTail,
  })));
});
`.trim();
    const result = await sandbox.runCommand("node", [
      "-e",
      script,
      String(OPENCLAW_TELEGRAM_WEBHOOK_PORT),
      OPENCLAW_TELEGRAM_INTERNAL_WEBHOOK_PATH,
      JSON.stringify(payload),
      webhookSecret ?? "",
      deliveryId ?? "",
    ], {
      signal: AbortSignal.timeout(8_000),
    });
    const stdout = (await result.output("stdout")).trim();
    const parsed = parseWorkflowJson<TelegramForwardProbeJson>(stdout);
    return {
      ok: parsed?.ok === true,
      status: parsed && typeof parsed.status === "number" ? parsed.status : 0,
      durationMs: parsed?.durationMs ?? 0,
      bodyLength: parsed?.bodyLength ?? 0,
      bodyHead: parsed?.bodyHead ?? "",
      headers: parsed?.headers ?? null,
      error: parsed?.error ?? null,
      detail: parsed?.detail ?? null,
      processSnapshot: parsed?.processSnapshot ?? null,
      logTail: parsed?.logTail ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      durationMs: 0,
      bodyLength: 0,
      bodyHead: "",
      headers: null,
      error: error instanceof Error ? error.message : String(error),
      detail:
        error instanceof Error && "cause" in error
          ? String((error as Error & { cause?: unknown }).cause ?? "")
          : null,
      processSnapshot: null,
      logTail: null,
    };
  }
}

/**
 * Minimal adapter that satisfies runWithBootMessages type requirements.
 * Only the boot message handle matters — message extraction is unused
 * because we forward the raw payload to the native handler.
 */
function buildMinimalBootAdapter() {
  return {
    extractMessage: async () => ({ kind: "skip" as const, reason: "native-forward" }),
    sendReply: async () => {},
    // sendBootMessage MUST be present — without it, runWithBootMessages
    // exits immediately when there's no existingBootHandle, skipping
    // the entire sandbox-ready polling loop.
    sendBootMessage: async () => ({
      async update() {},
      async clear() {},
    }),
  };
}

class NativeForwardPreDispatchError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "NativeForwardPreDispatchError";
    this.cause = cause;
  }
}

async function resolveNativeForwardSandboxDomain(
  getSandboxDomain: (port?: number) => Promise<string>,
  port?: number,
): Promise<string> {
  try {
    return await getSandboxDomain(port);
  } catch (error) {
    // No request can leave this process until the destination resolves.
    // Preserve this distinction so workflow retry never closes it as unknown.
    throw new NativeForwardPreDispatchError(error);
  }
}

/**
 * Forward the raw webhook payload to OpenClaw's native channel handler on
 * the sandbox, matching the fast-path forwarding used in webhook routes.
 */
async function forwardToNativeHandler(
  channel: ChannelName,
  payload: unknown,
  meta: import("@/shared/types").SingleMeta,
  getSandboxDomain: (port?: number) => Promise<string>,
  extraForwardHeaders: Record<string, string> | null = null,
  rawBody: string | null = null,
  deliveryId: string | null = null,
): Promise<{ ok: boolean; status: number; durationMs: number; bodyLength: number; bodyHead: string; headers: DiagnosticHeaders | null }> {
  const { OPENCLAW_TELEGRAM_WEBHOOK_PORT } = await import("@/server/openclaw/config");

  let forwardUrl: string;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (deliveryId) {
    headers["x-openclaw-delivery-id"] = deliveryId;
  }

  switch (channel) {
    case "telegram": {
      const sandboxUrl = await resolveNativeForwardSandboxDomain(
        getSandboxDomain,
        OPENCLAW_TELEGRAM_WEBHOOK_PORT,
      );
      forwardUrl = `${sandboxUrl}/telegram-webhook`;
      if (meta.channels.telegram?.webhookSecret) {
        headers["x-telegram-bot-api-secret-token"] = meta.channels.telegram.webhookSecret;
      }
      break;
    }
    case "slack": {
      const sandboxUrl = await resolveNativeForwardSandboxDomain(
        getSandboxDomain,
      );
      forwardUrl = `${sandboxUrl}/slack/events`;
      break;
    }
    case "whatsapp": {
      throw new Error("hosted_whatsapp_transport_unavailable");
    }
    case "discord": {
      const sandboxUrl = await resolveNativeForwardSandboxDomain(
        getSandboxDomain,
      );
      forwardUrl = `${sandboxUrl}/discord-webhook`;
      break;
    }
    default:
      throw new Error(`unsupported_native_forward_channel:${channel}`);
  }

  if (extraForwardHeaders) {
    for (const [k, v] of Object.entries(extraForwardHeaders)) {
      headers[k] = v;
    }
  }

  // Signature-verifying channel handlers need the exact raw request bytes.
  // Any re-serialization can produce a different byte sequence and fail native
  // verification with 401. When rawBody is provided, use it verbatim.
  const forwardBody = rawBody != null
    ? rawBody
    : JSON.stringify(payload);

  console.log(`[DIAG] native_forward_attempt url=${forwardUrl} channel=${channel} sandboxId=${meta.sandboxId} hasSecret=${Boolean(headers["x-telegram-bot-api-secret-token"])} bodySource=${channel === "slack" && rawBody != null ? "raw" : "serialized"} deliveryId=${deliveryId ?? "none"}`);

  const t0 = Date.now();
  // Per-fetch timeout that sits under the outer retry budget
  // (RETRYING_FORWARD_TIMEOUT_MS = 45s). Without this, a single wedged
  // fetch could hang the entire retry loop past its deadline. The 40s
  // budget leaves enough room for the retry wrapper to catch the abort
  // and surface it as a fetch-exception classification.
  const response = await fetch(forwardUrl, {
    method: "POST",
    headers,
    body: forwardBody,
    signal: AbortSignal.timeout(NATIVE_FORWARD_PER_FETCH_TIMEOUT_MS),
  });
  const durationMs = Date.now() - t0;

  // Always capture response body for diagnostics. 300 chars on ok is
  // enough to confirm shape; 2048 on error retains useful stack traces
  // and validation details for post-mortem. Log volume concern is
  // bounded by the ring buffer (1000 entries) and only non-ok responses
  // take the larger cap.
  let responseBody: string | null = null;
  try {
    responseBody = await response.text();
  } catch { /* best effort */ }

  const bodyLength = responseBody?.length ?? 0;
  const bodyHeadLimit = response.ok
    ? NATIVE_FORWARD_OK_BODY_HEAD_CHARS
    : NATIVE_FORWARD_ERROR_BODY_HEAD_CHARS;
  const bodyHead = (responseBody ?? "").slice(0, bodyHeadLimit);
  const bodyHeadTruncated = bodyLength > bodyHead.length;
  const headersSnapshot = pickDiagnosticHeaders(response.headers);
  console.log(`[DIAG] native_forward_response status=${response.status} ok=${response.ok} durationMs=${durationMs} bodyLength=${bodyLength} bodyHeadLen=${bodyHead.length} truncated=${bodyHeadTruncated} body=${bodyHead} headers=${JSON.stringify(headersSnapshot)}`);

  if (!response.ok) {
    logWarn("channels.native_forward_error_response", {
      channel,
      status: response.status,
      forwardUrl,
      sandboxId: meta.sandboxId,
      responseBody: bodyHead,
      responseBodyTruncated: bodyHeadTruncated,
      responseHeaders: headersSnapshot,
    });
  }

  return { ok: response.ok, status: response.status, durationMs, bodyLength, bodyHead, headers: headersSnapshot };
}

// Per-fetch timeout for workflow-side native forwards. Sits below the
// outer retry wrapper's 45s deadline so a single wedged connection
// doesn't starve the retry loop.
const NATIVE_FORWARD_PER_FETCH_TIMEOUT_MS = 40_000;
const NATIVE_FORWARD_OK_BODY_HEAD_CHARS = 300;
const NATIVE_FORWARD_ERROR_BODY_HEAD_CHARS = 2048;

const RETRYING_FORWARD_MAX_ATTEMPTS = 20;
const RETRYING_FORWARD_RETRY_INTERVAL_MS = 2_000;
const RETRYING_FORWARD_TIMEOUT_MS = 45_000;
// SANDBOX_NOT_LISTENING is not transient — Vercel returns this when the
// sandbox port is not accepting connections. Retrying the same dead URL
// won't recover. After 1 attempt + URL cache refresh + 1 retry with the
// fresh URL, bail and surface the failure.
const SANDBOX_NOT_LISTENING_MAX_ATTEMPTS = 2;

function portForChannel(channel: ChannelName): number {
  // Telegram's webhook listener runs on its own port (8787); all other
  // channels are routed through the gateway's primary port (3000, the
  // default for getSandboxDomain).
  const OPENCLAW_GATEWAY_PORT = 3000;
  const OPENCLAW_TELEGRAM_PORT = 8787;
  return channel === "telegram" ? OPENCLAW_TELEGRAM_PORT : OPENCLAW_GATEWAY_PORT;
}

/**
 * Returns true when a non-ok native-handler response is shaped like an
 * auth failure worth one-shotting through the AI Gateway credential
 * refresh. Slack 401 is excluded because Slack Bolt's 401 is signature
 * re-verification failure (see Story 3 in iter1 — we already re-sign
 * before forwarding; if Bolt still 401s, no AI Gateway refresh helps).
 */
function shouldAttemptAiGatewayCredentialRecovery(
  channel: ChannelName,
  status: number,
): boolean {
  if (status === 403) return true;
  if (status === 401) return channel === "telegram";
  return false;
}

/**
 * Collapsed probe + forward: sends the real payload directly to the native
 * handler, retrying on proxy-level failures (502/503/504), fetch exceptions,
 * and handler-not-ready responses (401/404).
 *
 * 401/404 are retried because the native handler (e.g. Telegram on port 8787)
 * may be listening at the TCP level but not yet have its webhook routes and
 * secret validation fully initialized.  The gateway boots port 3000 first;
 * the Telegram webhook listener on 8787 registers its path a few seconds
 * later.  During that window the handler returns 401 (secret check against
 * an uninitialized route) or 404 (path not yet registered).
 *
 * Duplicate-safety: retries happen only after explicit pre-admission rejection.
 * Unmarked Telegram success, proxy failures, and fetch exceptions close as
 * unknown because the handler may already have accepted the delivery.
 */
async function forwardToNativeHandlerWithRetry(
  channel: ChannelName,
  payload: unknown,
  meta: import("@/shared/types").SingleMeta,
  getSandboxDomain: (port?: number) => Promise<string>,
  forwardTelegramToNativeHandlerLocally: ((
    sandboxId: string,
    payload: unknown,
    webhookSecret: string | null,
    deliveryId?: string | null,
  ) => Promise<{
    ok: boolean;
    status: number;
    durationMs: number;
    bodyLength: number;
    bodyHead: string;
    headers: DiagnosticHeaders | null;
    error?: string | null;
    detail?: string | null;
    processSnapshot?: string | null;
    logTail?: string | null;
  }>) | null,
  preferLocalTelegramForward = false,
  extraForwardHeaders: Record<string, string> | null = null,
  rawBody: string | null = null,
  deliveryId: string | null = null,
  telegramDurableAcceptanceAdmitted: boolean,
  gatewayAdmissionRejectionAdmitted: boolean,
  controlPlaneOrigin: string,
): Promise<RetryingForwardResult> {
  const startedAt = Date.now();
  const deadline = startedAt + RETRYING_FORWARD_TIMEOUT_MS;
  const retries: Array<{ attempt: number; reason: string; status?: number; error?: string }> = [];
  const attemptsDetail: ForwardAttemptDetail[] = [];
  let terminalAttemptResult: RetryingForwardResult | null = null;
  // Track whether we have already burned our one-shot AI Gateway credential
  // refresh. The sandbox's AI Gateway OIDC token is injected via firewall
  // transform; if it silently expires between our proactive refresh at
  // Phase 1.5 and the actual forward, the handler can return a non-ok
  // response. Force a refresh exactly once, then retry the forward.
  let triedCredentialRecovery = false;

  for (let attempt = 1; attempt <= RETRYING_FORWARD_MAX_ATTEMPTS && Date.now() < deadline; attempt++) {
    const attemptStartedAt = Date.now();
    try {
      const useLocalForward =
        channel === "telegram"
        && meta.sandboxId != null
        && forwardTelegramToNativeHandlerLocally != null
        && preferLocalTelegramForward;
      const transport: "public" | "local" = useLocalForward ? "local" : "public";
      const result = useLocalForward
        ? await forwardTelegramToNativeHandlerLocally(
            meta.sandboxId as string,
            payload,
            meta.channels.telegram?.webhookSecret ?? null,
            deliveryId,
          )
        : await forwardToNativeHandler(channel, payload, meta, getSandboxDomain, extraForwardHeaders, rawBody, deliveryId);

      // Retry only explicit pre-admission rejection. Generic proxy errors and
      // transport failures may occur after acceptance, so they remain unknown.
      // Handler-not-ready (401/404) means the native route rejected the request.
      //
      // Channel-specific behavior:
      // - Telegram: retries on 401 (webhook secret validation against an
      //   uninitialized route) AND 404 (path not yet registered).
      // - Slack: retries on 404 only. 401 from Slack Bolt means the signature
      //   failed re-verification — retrying won't recover since the payload
      //   body and signing secret are fixed; treat as fatal.
      //
      const telegramDurablyAccepted =
        isAdmittedTelegramDurableAcceptance(
          telegramDurableAcceptanceAdmitted,
          result.headers?.openclawDeliveryAccepted,
        );
      const isHandlerNotReady =
        result.status === 404
        || (result.status === 401 && channel === "telegram");
      const gatewayAdmissionClosed = isAdmittedGatewayAdmissionUnavailableResponse(
        gatewayAdmissionRejectionAdmitted,
        result.status,
        result.bodyHead,
      );
      // Vercel sandbox tunnel returns 502 with this body when the sandbox
      // process isn't listening on the requested port. This is a stale
      // public-URL signal — the cached sb-XXX.vercel.run points at a port
      // that has stopped accepting connections. Retrying the same URL is
      // pointless; we need to refresh the URL and reconcile sandbox state.
      const isSandboxNotListening =
        result.status === 502
        && typeof result.bodyHead === "string"
        && /sandbox is not listening/i.test(result.bodyHead);
      const acceptance: NativeDeliveryAcceptance = result.ok
        ? channel === "telegram" && !telegramDurablyAccepted
          ? "unknown"
          : "accepted"
        : gatewayAdmissionClosed || isSandboxNotListening || isHandlerNotReady
          ? "rejected"
          : result.status >= 500 || result.status === 0
            ? "unknown"
            : "rejected";
      const classification = acceptance === "unknown"
        ? "acceptance-unknown"
        : gatewayAdmissionClosed
          ? "gateway-unavailable"
          : isSandboxNotListening
          ? "sandbox-not-listening"
          : result.status >= 502
            ? "proxy-error"
            : isHandlerNotReady
              ? "handler-not-ready"
              : result.ok
                ? "accepted"
                : "handler-error";
      attemptsDetail.push({
        attempt,
        startedAtMs: attemptStartedAt,
        elapsedMs: Date.now() - startedAt,
        durationMs: result.durationMs,
        status: result.status,
        ok: result.ok,
        bodyLength: result.bodyLength,
        bodyHead: result.bodyHead,
        headers: result.headers,
        transport,
        classification,
        acceptance,
        error: "error" in result ? optionalDiagnosticString(result.error) : null,
        detail: "detail" in result ? optionalDiagnosticString(result.detail) : null,
        processSnapshot: "processSnapshot" in result ? optionalDiagnosticString(result.processSnapshot) : null,
        logTail: "logTail" in result ? optionalDiagnosticString(result.logTail) : null,
      });
      logInfo("channels.forward_attempt", {
        channel,
        attempt,
        transport,
        status: result.status,
        classification,
        acceptance,
        elapsedMs: Date.now() - attemptStartedAt,
        bodyLength: result.bodyLength,
        error: "error" in result ? optionalDiagnosticString(result.error) : null,
        detail: "detail" in result ? optionalDiagnosticString(result.detail) : null,
        processSnapshot: "processSnapshot" in result ? optionalDiagnosticString(result.processSnapshot) : null,
        logTail: "logTail" in result ? optionalDiagnosticString(result.logTail) : null,
        deliveryId,
      });
      const definitelyRejectedBeforeAdmission =
        gatewayAdmissionClosed || isSandboxNotListening || isHandlerNotReady;
      if (definitelyRejectedBeforeAdmission) {
        const reason = classification;
        const entry = { attempt, reason, status: result.status };
        retries.push(entry);
        logInfo("channels.native_forward_retry", {
          channel,
          attempt,
          status: result.status,
          reason,
          durationMs: result.durationMs,
          bodyLength: result.bodyLength,
          bodyHead: result.bodyHead,
          transport,
          responseHeaders: result.headers,
          error: "error" in result ? optionalDiagnosticString(result.error) : null,
          detail: "detail" in result ? optionalDiagnosticString(result.detail) : null,
          processSnapshot: "processSnapshot" in result ? optionalDiagnosticString(result.processSnapshot) : null,
          logTail: "logTail" in result ? optionalDiagnosticString(result.logTail) : null,
          retryElapsedMs: Date.now() - startedAt,
          deliveryId,
        });

        if (classification === "gateway-unavailable") {
          const totalMs = Date.now() - startedAt;
          terminalAttemptResult = {
            ok: false,
            acceptance: "rejected",
            status: result.status,
            attempts: attempt,
            totalMs,
            transport,
            retries,
            attemptsDetail,
          };
          logInfo("channels.retrying_forward_gateway_admission_closed", {
            channel,
            attempts: attempt,
            totalMs,
            deliveryId,
          });
          break;
        }

        // Sandbox public URL is dead. The cached sb-XXX.vercel.run is no
        // longer accepting connections. Hammering it 20× × 2s = 40s wasted
        // with no chance of recovery via retry alone. Refresh the URL cache
        // and reconcile sandbox status, then allow at most one more attempt
        // with the fresh URL before bailing.
        if (classification === "sandbox-not-listening") {
          if (attempt === 1) {
            try {
              const port = portForChannel(channel);
              await markSandboxPortUrlStale(
                meta.sandboxId ?? null,
                port,
                "sandbox-not-listening",
              );
            } catch (e) {
              logWarn("channels.sandbox_port_url_refresh_failed", {
                channel,
                attempt,
                error: e instanceof Error ? e.message : String(e),
                deliveryId,
              });
            }
          }
          if (attempt >= SANDBOX_NOT_LISTENING_MAX_ATTEMPTS) {
            const totalMs = Date.now() - startedAt;
            terminalAttemptResult = {
              ok: false,
              acceptance: "rejected",
              status: result.status,
              attempts: attempt,
              totalMs,
              transport,
              retries,
              attemptsDetail,
            };
            logWarn("channels.retrying_forward_stale_port_terminal", {
              channel,
              attempts: attempt,
              totalMs,
              retryCount: retries.length,
              attemptsDetail,
              deliveryId,
            });
            break;
          }
        }

        if (attempt < RETRYING_FORWARD_MAX_ATTEMPTS && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, RETRYING_FORWARD_RETRY_INTERVAL_MS));
        }
        continue;
      }

      if (acceptance === "unknown") {
        const totalMs = Date.now() - startedAt;
        logWarn("channels.native_forward_acceptance_unknown", {
          channel,
          status: result.status,
          attempts: attempt,
          totalMs,
          transport,
          deliveryId,
        });
        return {
          ok: false,
          acceptance,
          status: result.status,
          attempts: attempt,
          totalMs,
          transport,
          retries,
          attemptsDetail,
        };
      }

      // Any other direct handler response: normally do NOT retry.
      // Exception: auth-shaped failures (401 Unauthorized on non-Slack
      // channels, or 403 Forbidden anywhere) may be a stale AI Gateway
      // OIDC bearer. Force-refresh exactly once and retry. Slack 401
      // is excluded because Slack Bolt's 401 means signature
      // re-verification failed — no amount of AI Gateway token refresh
      // recovers that. Non-auth-shaped 4xx (400/422/429) and 5xx other
      // than the proxy-error bucket above should be treated as handler
      // responses and returned as-is; a pointless refresh there just
      // burns one wasted forward per message and pollutes retry metrics.
      const credentialRecoveryEligible =
        !result.ok &&
        shouldAttemptAiGatewayCredentialRecovery(channel, result.status);
      if (
        credentialRecoveryEligible &&
        !triedCredentialRecovery &&
        attempt < RETRYING_FORWARD_MAX_ATTEMPTS &&
        Date.now() < deadline
      ) {
        triedCredentialRecovery = true;
        try {
          const recovery = await ensureUsableAiGatewayCredential({
            minRemainingMs: Number.POSITIVE_INFINITY,
            reason: `channel:${channel}:forward-recovery`,
            controlPlaneOrigin,
          });
          logInfo("channels.ai_gateway_credential_recovery", {
            channel,
            attempt,
            status: result.status,
            refreshed: recovery.refreshed,
            source: recovery.credential?.source ?? null,
          });
        } catch (recoveryError) {
          logWarn("channels.ai_gateway_credential_recovery_failed", {
            channel,
            attempt,
            status: result.status,
            error:
              recoveryError instanceof Error
                ? recoveryError.message
                : String(recoveryError),
          });
        }
        await new Promise((r) =>
          setTimeout(r, RETRYING_FORWARD_RETRY_INTERVAL_MS),
        );
        continue;
      }

      // 200 (success), or non-ok after we already tried credential recovery:
      // return as-is.
      const totalMs = Date.now() - startedAt;
      logInfo("channels.retrying_forward_complete", {
        channel,
        ok: result.ok,
        status: result.status,
        attempts: attempt,
        totalMs,
        transport,
        retryCount: retries.length,
        attemptsDetail,
        triedCredentialRecovery,
        credentialRecoveryEligible,
        deliveryId,
      });
      return {
        ok: acceptance === "accepted",
        acceptance,
        status: result.status,
        attempts: attempt,
        totalMs,
        transport,
        retries,
        attemptsDetail,
      };
    } catch (error) {
      if (
        error instanceof NativeForwardPreDispatchError ||
        isDefiniteNativePreAdmissionError(error)
      ) {
        const errorMsg =
          error instanceof Error ? error.message : String(error);
        const entry = {
          attempt,
          reason: "pre-dispatch-exception",
          error: errorMsg,
        };
        retries.push(entry);
        attemptsDetail.push({
          attempt,
          startedAtMs: attemptStartedAt,
          elapsedMs: Date.now() - startedAt,
          durationMs: null,
          status: null,
          ok: false,
          bodyLength: null,
          bodyHead: null,
          headers: null,
          transport: "public",
          classification: "pre-dispatch-exception",
          acceptance: "rejected",
          error: errorMsg,
        });
        logInfo("channels.native_forward_retry", {
          channel,
          attempt,
          reason: "pre-dispatch-exception",
          error: errorMsg,
          retryElapsedMs: Date.now() - startedAt,
          deliveryId,
        });
        if (
          attempt < RETRYING_FORWARD_MAX_ATTEMPTS &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) =>
            setTimeout(resolve, RETRYING_FORWARD_RETRY_INTERVAL_MS),
          );
          continue;
        }
        terminalAttemptResult = {
          ok: false,
          acceptance: "rejected",
          status: 503,
          attempts: attempt,
          totalMs: Date.now() - startedAt,
          transport: "public",
          retries,
          attemptsDetail,
        };
        break;
      }

      // Connection refused, DNS failure, or timeout does not prove rejection;
      // the request may have reached the handler before the response was lost.
      const errorMsg = error instanceof Error ? error.message : String(error);
      const entry = { attempt, reason: "fetch-exception" as const, error: errorMsg };
      retries.push(entry);
      attemptsDetail.push({
        attempt,
        startedAtMs: attemptStartedAt,
        elapsedMs: Date.now() - startedAt,
        durationMs: null,
        status: null,
        ok: null,
        bodyLength: null,
        bodyHead: null,
        headers: null,
        transport: "public",
        classification: "fetch-exception",
        acceptance: "unknown",
        error: errorMsg,
      });
      logInfo("channels.native_forward_retry", {
        channel,
        attempt,
        reason: "fetch-exception",
        error: errorMsg,
        retryElapsedMs: Date.now() - startedAt,
        deliveryId,
      });
      return {
        ok: false,
        acceptance: "unknown",
        status: 0,
        attempts: attempt,
        totalMs: Date.now() - startedAt,
        transport: "public",
        retries,
        attemptsDetail,
      };
    }
  }

  // Exhausted retries — report as gateway timeout.
  const totalMs = Date.now() - startedAt;
  if (terminalAttemptResult) {
    return terminalAttemptResult;
  }
  logWarn("channels.retrying_forward_exhausted", {
    channel,
    attempts: RETRYING_FORWARD_MAX_ATTEMPTS,
    totalMs,
    retryCount: retries.length,
    attemptsDetail,
    deliveryId,
  });
  return {
    ok: false,
    acceptance:
      attemptsDetail.at(-1)?.acceptance === "rejected"
        ? "rejected"
        : "unknown",
    status: 504,
    attempts: RETRYING_FORWARD_MAX_ATTEMPTS,
    totalMs,
    transport: null,
    retries,
    attemptsDetail,
  };
}

export async function buildExistingBootHandle(
  channel: string,
  payload: unknown,
  bootMessageId?: number | string | null,
  cleanupConfig?: {
    slack?: Pick<SlackChannelConfig, "botToken" | "configuredAt"> | null;
    telegram?: TelegramChannelConfig | null;
  },
): Promise<BootMessageHandle | undefined> {
  if (typeof bootMessageId === "number" && channel === "telegram") {
    const meta = await getInitializedMeta();
    // The route posted this exact placeholder before enqueue. A handed-off
    // credential is safe only for editing/deleting that message; delivery and
    // sandbox config always use the current persisted generation.
    const tgConfig = cleanupConfig?.telegram ?? meta.channels.telegram;
    const chatId = extractTelegramChatId(payload);
    if (tgConfig && chatId) {
      const token = tgConfig.botToken;
      const numChatId = Number(chatId);
      return {
        async update(text: string) {
          try {
            await editMessageText(token, numChatId, bootMessageId, text);
          } catch (error) {
            logWarn("channels.telegram_boot_message_update_failed", {
              bootMessageId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
        async clear() {
          try {
            await deleteMessage(token, numChatId, bootMessageId);
          } catch (error) {
            logWarn("channels.telegram_boot_message_cleanup_failed", {
              bootMessageId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      };
    }
  }
  if (typeof bootMessageId === "string" && channel === "slack") {
    const meta = await getInitializedMeta();
    const slackConfig = cleanupConfig?.slack ?? meta.channels.slack;
    const slackPayload = payload as { event?: { channel?: string } } | null;
    const slackChannel = slackPayload?.event?.channel;
    if (slackConfig && slackChannel) {
      const token = slackConfig.botToken;
      return {
        async update(text: string) {
          try {
            await fetch("https://slack.com/api/chat.update", {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ channel: slackChannel, ts: bootMessageId, text }),
              signal: AbortSignal.timeout(5_000),
            });
          } catch (error) {
            logWarn("channels.slack_boot_message_update_failed", {
              bootMessageTs: bootMessageId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
        async clear() {
          try {
            await deleteSlackMessage({
              botToken: token,
              channel: slackChannel,
              ts: bootMessageId,
              timeoutMs: 5_000,
            });
          } catch (error) {
            logWarn("channels.slack_boot_message_cleanup_failed", {
              bootMessageTs: bootMessageId,
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        },
      };
    }
  }
  return undefined;
}

export function buildQueuedChannelJob(
  payload: unknown,
  origin: string,
  requestId: string | null,
): QueuedChannelJob<unknown> {
  return {
    payload,
    origin,
    receivedAt: Date.now(),
    requestId,
  };
}

// Workflows can run for up to 5 minutes — give the sandbox 2 minutes to
// restore instead of the old 25-second queue consumer timeout.
const WORKFLOW_SANDBOX_READY_TIMEOUT_MS = 120_000;
const WORKFLOW_RETRY_AFTER = "15s";

function parseNativeForwardFailedStatus(errorMsg: string): number | null {
  const match = /native_forward_failed status=(\d+)/.exec(errorMsg);
  if (!match) {
    return null;
  }

  const status = Number.parseInt(match[1], 10);
  return Number.isNaN(status) ? null : status;
}

export function toWorkflowProcessingError(
  channel: string,
  error: unknown,
  dependencies: DrainChannelErrorDependencies,
  retryBudget?: WorkflowRetryBudget,
): Error {
  const message = `drain_channel_workflow_failed:${channel}:${formatChannelError(error)}`;
  const errorMsg = formatChannelError(error);
  const retryBudgetExceeded = retryBudget?.exceeded === true;
  const exhaustedMessage = retryBudgetExceeded
    ? `${message}:${retryBudget?.reason ?? PERSISTENT_SANDBOX_FAILURE_PREFIX}`
    : message;

  // Sandbox readiness failures are transient infrastructure issues while the
  // sandbox is restoring. Retry the workflow step so the webhook can recover
  // once the sandbox becomes available again — UNLESS we have already been
  // retrying past the wall-clock / attempt budget. A permanently broken
  // sandbox or AI Gateway outage would otherwise retry indefinitely and
  // burn Fluid Compute minutes for a user who sees nothing but a
  // ping-ponging boot message.
  const nativeForwardFailedStatus = parseNativeForwardFailedStatus(errorMsg);
  if (
    errorMsg.includes("sandbox_not_ready") ||
    errorMsg.includes("SANDBOX_READY_TIMEOUT") ||
    errorMsg.includes(NATIVE_HANDLER_TIMEOUT_ERROR) ||
    (nativeForwardFailedStatus !== null && nativeForwardFailedStatus >= 500)
  ) {
    if (retryBudgetExceeded) {
      return new dependencies.FatalError(exhaustedMessage);
    }
    return new dependencies.RetryableError(message, {
      retryAfter: WORKFLOW_RETRY_AFTER,
    });
  }

  if (nativeForwardFailedStatus !== null) {
    return new dependencies.FatalError(message);
  }

  if (dependencies.isRetryable(error)) {
    if (retryBudgetExceeded) {
      return new dependencies.FatalError(exhaustedMessage);
    }
    return new dependencies.RetryableError(message, {
      retryAfter: WORKFLOW_RETRY_AFTER,
    });
  }

  return new dependencies.FatalError(message);
}

async function loadDrainChannelWorkflowDependencies(): Promise<DrainChannelWorkflowDependencies> {
  const [
    { isRetryable },
    { createSlackAdapter },
    { createTelegramAdapter },
    { createDiscordAdapter },
    { reconcileDiscordIntegration },
    { runWithBootMessages },
    { ensureSandboxReady, getSandboxDomain },
    { hydrateVerifiedBundleIdentity },
    { RetryableError, FatalError, getStepMetadata, getWorkflowMetadata },
  ] = await Promise.all([
    import("@/server/channels/driver"),
    import("@/server/channels/slack/adapter"),
    import("@/server/channels/telegram/adapter"),
    import("@/server/channels/discord/adapter"),
    import("@/server/channels/discord/reconcile"),
    import("@/server/channels/core/boot-messages"),
    import("@/server/sandbox/lifecycle"),
    import("@/server/openclaw/bundle-identity"),
    import("workflow"),
  ]);

  return {
    isRetryable,
    createSlackAdapter,
    createTelegramAdapter,
    createDiscordAdapter,
    reconcileDiscordIntegration,
    runWithBootMessages,
    ensureSandboxReady,
    getSandboxDomain,
    forwardToNativeHandler,
    forwardTelegramToNativeHandlerLocally,
    forwardToNativeHandlerWithRetry,
    waitForTelegramNativeHandler,
    probeTelegramNativeHandlerLocally,
    buildExistingBootHandle,
    hydrateVerifiedBundleIdentity,
    RetryableError,
    FatalError,
    getStepMetadata,
    getWorkflowMetadata,
  };
}

function formatChannelError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
