import { createHash, randomUUID } from "node:crypto";

import { APIError as VercelSandboxApiError } from "@vercel/sandbox";

import { pollUntil } from "@/server/async/poll";
import { ApiError } from "@/shared/http";
import {
  computePolicyHash,
  FIREWALL_FAIL_CLOSED_LAST_ERROR,
  FIREWALL_FAIL_CLOSED_REASON,
  type OperationContext,
  type RestorePhaseMetrics,
  type RestorePreparedReason,
  type SingleMeta,
} from "@/shared/types";
import {
  withOperationContext,
} from "@/server/observability/operation-context";
import {
  getAiGatewayBearerTokenOptional,
  resolveAiGatewayCredentialOptional,
  isVercelDeployment,
} from "@/server/env";
import {
  applyFirewallPolicyToSandbox,
  controlPlaneDomains,
  toNetworkPolicy,
} from "@/server/firewall/policy";
import { logError, logInfo, logWarn } from "@/server/log";
import { getPublicOrigin } from "@/server/public-url";
import {
  setupOpenClaw,
  CommandFailedError,
  OPENCLAW_BUNDLE_IDENTITY_PATH,
  verifyPersistedVerifiedBundleRuntime,
} from "@/server/openclaw/bootstrap";
import {
  admitConfiguredOpenClawBundle,
  hydrateVerifiedBundleIdentity,
  matchesConfiguredBundleIdentity,
  verifiedBundleIdentitiesEqual,
} from "@/server/openclaw/bundle-identity";
import { isVerifiedBundleIdentity } from "@/shared/bundle-identity";
import {
  buildClearStaleGatewayLockShell,
  computeGatewayConfigHash,
  GATEWAY_CONFIG_HASH_VERSION,
  OPENCLAW_BIN,
  OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
  OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH,
  OPENCLAW_GATEWAY_TOKEN_PATH,
  OPENCLAW_LOG_FILE,
  OPENCLAW_OPERATOR_SCOPES,
  OPENCLAW_STATE_DIR,
  OPENCLAW_TELEGRAM_WEBHOOK_PORT,
  type GatewayConfigHashInput,
} from "@/server/openclaw/config";
import {
  OPENCLAW_RESTORE_ASSET_MANIFEST_PATH,
  buildDynamicRestoreFiles,
  buildRestoreAssetManifest,
  buildRestoreRuntimeEnv,
  buildStaticRestoreFiles,
  type RestoreAssetManifest,
} from "@/server/openclaw/restore-assets";
import { buildRestoreDecision } from "@/server/sandbox/restore-attestation";
import type { RestoreDecision } from "@/shared/restore-decision";
import type { LiveConfigSyncResult } from "@/shared/live-config-sync";
import { getSandboxController } from "@/server/sandbox/controller";
import type { SandboxHandle } from "@/server/sandbox/controller";
import {
  SetupProgressWriter,
  beginSetupProgress,
  clearSetupProgress,
} from "@/server/sandbox/setup-progress";
import { getSandboxVcpus } from "@/server/sandbox/resources";
import {
  deleteVercelSnapshot,
  isSnapshotNotFoundError,
} from "@/server/sandbox/snapshot-delete";
import {
  GatewayAdminRpcError,
  isGatewaySuspensionCapabilityUnavailable,
} from "@/server/openclaw/admin-rpc";
import {
  clearInactiveHostSuspension,
  clearHostSuspensionAfterGatewayReplacement,
  clearHostSuspensionAfterDelete,
  enqueueHostStopOperation,
  ensureHostStopMonitor,
  getHostMutationFence,
  HostSuspensionBusyError,
  HostSuspensionStateCorruptError,
  HOST_STOP_REQUEST_MAX_MS,
  markHostSuspensionStopped,
  markHostSuspensionStopRequesting,
  markHostSuspensionStopping,
  prepareHostSuspension,
  readHostSuspensionState,
  renewHostSuspension,
  rollbackHostSuspension,
  thawHostSuspensionIfNeeded,
  type HostSuspensionState,
} from "@/server/sandbox/host-suspension";
import {
  estimateSandboxTimeoutRemainingMs,
  SANDBOX_TIMEOUT_SAFETY_RUNWAY_MS,
  getSandboxPlatformTimeoutMs,
  getSandboxSleepAfterMs,
  getSandboxTimeoutExtensionMs,
  getSandboxTouchThrottleMs,
} from "@/server/sandbox/timeout";
import {
  getStore,
  getInitializedMeta,
  mutateMeta,
  wait,
} from "@/server/store/store";
import {
  cronJobsKey,
  lifecycleLockKey,
  startLockKey,
  tokenRefreshLockKey,
} from "@/server/store/keyspace";
import {
  clearLegacyCronStateForReset,
  fenceCronProjectionStateForReset,
  normalizeResetCronProjectionGeneration,
} from "@/server/cron/projection";
import { cancelSupersededCronWake } from "@/server/cron/dispatch";
import {
  isHotSpareEnabled,
  preCreateHotSpare,
  preCreateHotSpareFromSnapshot,
  promoteHotSpare,
  applyPreCreateToMeta,
  applyPromoteToMeta,
  clearHotSpareState,
} from "@/server/sandbox/hot-spare";
import {
  armSandboxDeadline,
  claimSandboxDeadlineStop,
  clearSandboxDeadline,
  readSandboxDeadlineRemainingMs,
} from "@/server/sandbox/deadline-coordinator";

const OPENCLAW_PORT = 3000;
const SANDBOX_PORTS = [OPENCLAW_PORT, OPENCLAW_TELEGRAM_WEBHOOK_PORT];
const BUNDLE_CANDIDATE_OWNERSHIP_TAG = "openclaw-bundle-candidate";

function sandboxApiStatus(error: unknown): number | null {
  if (error instanceof VercelSandboxApiError) {
    return error.response.status;
  }
  if (isRecord(error) && isRecord(error.response)) {
    const status = error.response.status;
    if (typeof status === "number") return status;
  }
  if (isRecord(error) && typeof error.status === "number") {
    return error.status;
  }
  return null;
}

function isSandboxGoneError(error: unknown): boolean {
  if (error instanceof GatewayAdminRpcError) return false;
  const status = sandboxApiStatus(error);
  if (status === 404 || status === 410) return true;
  if (!(error instanceof Error)) return false;
  // Test doubles and older controller adapters may only preserve the status
  // prefix. Do not classify arbitrary command output containing these digits.
  return /^(?:HTTP\s+)?(?:404|410)(?:\b|:)/i.test(error.message.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


function computeMetaGatewayConfigHash(meta: SingleMeta): string {
  const slack = meta.channels.slack;
  return computeGatewayConfigHash({
    telegramBotToken: meta.channels.telegram?.botToken,
    telegramWebhookSecret: meta.channels.telegram?.webhookSecret,
    slackCredentials: slack
      ? { botToken: slack.botToken, signingSecret: slack.signingSecret }
      : undefined,
    bundleCapabilities: meta.bundleIdentity?.capabilities,
  });
}


// Lock base TTLs are kept short so a Vercel Function killed mid-operation
// leaves a stuck lock behind for at most TTL seconds. The auto-renewer
// (LOCK_RENEW_INTERVAL_MS) extends the lock while the holder is alive.
const LIFECYCLE_LOCK_TTL_SECONDS = 90;
const START_LOCK_TTL_SECONDS = 90;
const TOKEN_REFRESH_LOCK_TTL_SECONDS = 60;
const LOCK_RENEW_INTERVAL_MS = 25_000;
const STALE_OPERATION_MS = 5 * 60 * 1000;
const HOST_STOP_RUNNING_GRACE_MS = 15_000;
const HOST_SUSPENSION_RENEW_WINDOW_MS = 30_000;
const READY_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const PREPARE_RESTORE_SYNC_BUDGET_MS = 270_000;
// Durable reconciliation owns slow platform stops. Function callers wait only
// long enough for the common case, preserving budget for setup and stamping.
const PERSISTENT_STOP_CONFIRM_TIMEOUT_MS = 30_000;
const READY_WAIT_POLL_MS = 1_000;

function buildConfigSyncRestoreMetricsPatch(): RestorePhaseMetrics {
  const now = Date.now();
  return {
    sandboxCreateMs: 0,
    tokenWriteMs: 0,
    assetSyncMs: 0,
    startupScriptMs: 0,
    forcePairMs: 0,
    firewallSyncMs: 0,
    localReadyMs: 0,
    publicReadyMs: 0,
    totalMs: 0,
    skippedStaticAssetSync: true,
    skippedDynamicConfigSync: false,
    dynamicConfigHash: null,
    dynamicConfigReason: "hash-miss",
    assetSha256: null,
    vcpus: 0,
    recordedAt: now,
  };
}

/** Default TTL safety window — refresh when remaining TTL <= 10 minutes. */
const DEFAULT_MIN_REMAINING_MS = 10 * 60 * 1000;
/** Circuit breaker: open after this many consecutive failures. */
const BREAKER_FAILURE_THRESHOLD = 3;
/** Circuit breaker: keep open for 30 seconds. */
const BREAKER_OPEN_DURATION_MS = 30_000;
/** Maximum time to wait for a contended token refresh lock (ms). */
const TOKEN_REFRESH_LOCK_WAIT_MS = 5_000;
/** Poll interval while waiting for contended token refresh lock. */
const TOKEN_REFRESH_LOCK_POLL_MS = 500;

// ---------------------------------------------------------------------------
// Slack credential validation for restore
// ---------------------------------------------------------------------------

/** Definitive Slack auth errors that mean the token is permanently invalid. */
const SLACK_DEFINITIVE_AUTH_ERRORS = [
  "invalid_auth",
  "token_revoked",
  "account_inactive",
  "token_expired",
  "org_login_required",
];

const SLACK_RESTORE_VALIDATION_TIMEOUT_MS = 5_000;

type SlackRestoreCredentials = { botToken: string; signingSecret: string };

/**
 * Validate Slack credentials before writing them into the gateway config.
 *
 * - If config is null/unconfigured, returns null (no Slack).
 * - On success, returns `{ botToken, signingSecret }`.
 * - On definitive auth failure (`invalid_auth`, `token_revoked`, etc.),
 *   logs a warning, writes `lastError` to metadata, and returns null so
 *   Slack is omitted from the gateway config (preventing a startup crash).
 * - On timeout or transient errors, returns the credentials unchanged
 *   (don't break Slack just because their API is slow or flaky).
 */
async function validateSlackCredentialsForRestore(
  slackConfig: { botToken: string; signingSecret: string; [key: string]: unknown } | null | undefined,
): Promise<SlackRestoreCredentials | null> {
  if (!slackConfig) return null;

  try {
    const { fetchSlackAuthIdentity } = await import("@/server/channels/slack/auth");
    // Use a custom fetch wrapper with a shorter timeout for restore
    await fetchSlackAuthIdentity(slackConfig.botToken, (url, init) =>
      globalThis.fetch(url, {
        ...init,
        signal: AbortSignal.timeout(SLACK_RESTORE_VALIDATION_TIMEOUT_MS),
      }),
    );
    // Validation passed — token is valid
    return { botToken: slackConfig.botToken, signingSecret: slackConfig.signingSecret };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Check if this is a definitive auth failure
    const isDefinitiveFailure = SLACK_DEFINITIVE_AUTH_ERRORS.some(
      (code) => errorMessage.includes(code),
    );

    if (isDefinitiveFailure) {
      logWarn("sandbox.restore.slack_credentials_invalid", {
        error: errorMessage,
        action: "omitting_slack_from_config",
      });

      // Persist the error to metadata so the admin UI shows the problem
      try {
        await mutateMeta((meta) => {
          if (meta.channels.slack) {
            meta.channels.slack.lastError = `Token validation failed during restore: ${errorMessage}`;
          }
        });
      } catch {
        // Best effort — don't let meta write failure block the restore
      }

      return null;
    }

    // Transient error or timeout — include the credentials anyway.
    // Don't break Slack just because their API is temporarily unreachable.
    logInfo("sandbox.restore.slack_validation_inconclusive", {
      error: errorMessage,
      action: "including_slack_credentials",
    });
    return { botToken: slackConfig.botToken, signingSecret: slackConfig.signingSecret };
  }
}

// ---------------------------------------------------------------------------
// Gateway restart helper
// ---------------------------------------------------------------------------

async function assertRunningGatewayMutationAllowed(input: {
  sandboxId: string;
  lifecycleAttemptId: string | null;
  lease: AutoRenewedLockLease;
}): Promise<void> {
  await input.lease.assertOwned();
  const [fence, meta] = await Promise.all([
    getHostMutationFence(),
    getInitializedMeta(),
  ]);
  if (fence) {
    throw new ApiError(
      409,
      "HOST_SUSPENSION_CONFLICT",
      "Gateway configuration cannot restart while lifecycle suspension is fenced.",
    );
  }
  if (
    meta.status !== "running"
    || meta.sandboxId !== input.sandboxId
    || (meta.lifecycleAttemptId ?? null) !== input.lifecycleAttemptId
  ) {
    throw new LifecycleLockOwnershipLostError();
  }
}

/**
 * Kill the running gateway and launch a new one via the on-disk restart script.
 * The script reads tokens from disk and uses setsid to background the gateway.
 */
async function restartGateway(
  sandbox: SandboxHandle,
  reason: string = "unspecified",
  assertCurrent?: () => Promise<void>,
): Promise<void> {
  const startedAt = Date.now();
  logInfo("gateway.restart_started", {
    sandboxId: sandbox.sandboxId,
    reason,
  });
  // Split shutdown from launch. The second ownership assertion renews the
  // lifecycle lease immediately before the short launch-only command, so a
  // successor cannot prepare suspension between a long shutdown and launch.
  await assertCurrent?.();
  const stopped = await sandbox.runCommand({
    cmd: "bash",
    args: [OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH],
    env: { OPENCLAW_RESTART_PHASE: "kill" },
  });
  if (stopped.exitCode !== 0) {
    throw new CommandFailedError({
      command: "bash restart-gateway kill",
      exitCode: stopped.exitCode,
      output: await stopped.output("both"),
    });
  }
  await assertCurrent?.();
  const started = await sandbox.runCommand({
    cmd: "bash",
    args: [OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH],
    env: { OPENCLAW_RESTART_PHASE: "start" },
  });
  if (started.exitCode !== 0) {
    throw new CommandFailedError({
      command: "bash restart-gateway start",
      exitCode: started.exitCode,
      output: await started.output("both"),
    });
  }
  await assertCurrent?.();
  logInfo("gateway.restart_completed", {
    sandboxId: sandbox.sandboxId,
    durationMs: Date.now() - startedAt,
    exitCode: started.exitCode,
    reason,
  });
}

async function waitForGatewayRootReady(sandbox: SandboxHandle): Promise<void> {
  await pollUntil({
    label: "config-sync-gateway-ready",
    timeoutMs: 15_000,
    initialDelayMs: 200,
    maxDelayMs: 500,
    step: async () => {
      const result = await sandbox.runCommand("bash", [
        "-c",
        `curl -s -f --max-time 1 http://localhost:${OPENCLAW_PORT}/ 2>/dev/null | grep -q 'openclaw-app' && echo ok || echo not-ready`,
      ]);
      const out = await result.output("stdout");
      if (out.trim() === "ok") return { done: true, result: true };
      return { done: false };
    },
    timeoutError: () => new Error("Gateway did not become ready after config sync restart"),
  });
}

async function waitForConfiguredChannelRoutesReady(params: {
  sandbox: SandboxHandle;
  slackConfigured: boolean;
  telegramConfigured: boolean;
}): Promise<void> {
  if (!params.slackConfigured && !params.telegramConfigured) {
    return;
  }

  const totalTimeoutMs = 30_000;
  const probes: Array<{
    channel: "slack" | "telegram";
    command: string;
    readyStatuses: readonly string[];
  }> = [];

  if (params.slackConfigured) {
    probes.push({
      channel: "slack",
      command: `curl -s -o /dev/null -w '%{http_code}' --max-time 2 -X POST http://localhost:${OPENCLAW_PORT}/slack/events 2>/dev/null || echo 000`,
      readyStatuses: ["400", "401", "403"],
    });
  }

  if (params.telegramConfigured) {
    probes.push({
      channel: "telegram",
      command: `curl -s -o /dev/null -w '%{http_code}' --max-time 2 -X POST -H 'Content-Type: application/json' -H 'x-telegram-bot-api-secret-token: probe-invalid-secret' -d '{"probe":true}' http://127.0.0.1:${OPENCLAW_TELEGRAM_WEBHOOK_PORT}/telegram-webhook 2>/tmp/openclaw-config-sync-tg-probe.err || echo 000`,
      readyStatuses: ["401"],
    });
  }

  for (const probe of probes) {
    let lastStatus = "000";
    let lastAttempt = 0;
    let lastError = "";

    await pollUntil({
      label: `config-sync-${probe.channel}-route-ready`,
      timeoutMs: totalTimeoutMs,
      initialDelayMs: 250,
      maxDelayMs: 1_000,
      step: async ({ attempt, elapsedMs }) => {
        const result = await params.sandbox.runCommand("bash", [
          "-c",
          probe.command,
        ]);
        const stdout = (await result.output("stdout")).trim();
        const stderr = await result.output("stderr").catch(() => "");
        const status = stdout.slice(-3);
        lastStatus = status;
        lastAttempt = attempt;
        lastError = stderr.trim().slice(-200);
        logInfo("gateway.route_probe", {
          channel: probe.channel,
          status,
          attempt,
          elapsedMs,
          exitCode: result.exitCode,
          stderrHead: lastError || null,
        });
        if (probe.readyStatuses.includes(status)) {
          logInfo("gateway.route_ready", {
            channel: probe.channel,
            status,
            attempts: attempt,
            elapsedMs,
          });
          return { done: true, result: true };
        }
        return { done: false };
      },
      timeoutError: ({ attempt, elapsedMs }) => {
        const attempts = attempt > 0 ? attempt : lastAttempt;
        const totalMs = elapsedMs > 0 ? elapsedMs : totalTimeoutMs;
        logWarn("gateway.route_ready_timeout", {
          channel: probe.channel,
          lastStatus,
          attempts,
          totalMs,
          lastError: lastError || null,
          readyStatuses: probe.readyStatuses,
        });
        return new Error(
          `${probe.channel} route never returned ready status after ${attempts} attempts (${totalMs}ms; last status: ${lastStatus})`,
        );
      },
    });
  }
}

export type BackgroundScheduler = (callback: () => Promise<void> | void) => void;

export type SandboxLifecycleGuard = () => Promise<boolean>;

type AutoRenewedLockOptions = {
  key: string;
  token: string;
  ttlSeconds: number;
  label: string;
};

type AutoRenewedLockLease = {
  assertOwned(): Promise<void>;
};

class LifecycleLockUnavailableError extends Error {
  constructor() {
    super("Sandbox lifecycle lock unavailable.");
    this.name = "LifecycleLockUnavailableError";
  }
}

class LifecycleLockOwnershipLostError extends Error {
  constructor() {
    super("Sandbox lifecycle lock ownership was lost.");
    this.name = "LifecycleLockOwnershipLostError";
  }
}

class LifecycleAttemptFailedError extends Error {
  constructor(
    readonly attemptId: string,
    readonly failure: unknown,
  ) {
    super(failure instanceof Error ? failure.message : String(failure));
    this.name = "LifecycleAttemptFailedError";
  }
}

export class SandboxLifecycleGuardRejectedError extends Error {
  constructor() {
    super("Sandbox lifecycle guard rejected the operation.");
    this.name = "SandboxLifecycleGuardRejectedError";
  }
}

export class SandboxBundleMigrationRequiredError extends ApiError {
  constructor() {
    super(
      409,
      "OPENCLAW_BUNDLE_MIGRATION_REQUIRED",
      "Refusing to replace an existing persistent sandbox without an atomic data migration. Keep the current runtime or explicitly reset after migrating its data.",
    );
    this.name = "SandboxBundleMigrationRequiredError";
  }
}

export class SandboxBundleQuiesceFailedError extends ApiError {
  constructor(detail: string) {
    super(
      502,
      "OPENCLAW_BUNDLE_QUIESCE_FAILED",
      `The existing persistent sandbox could not be quiesced before bundle migration: ${detail}`,
    );
    this.name = "SandboxBundleQuiesceFailedError";
  }
}

const BUNDLE_MIGRATION_SUSPENSION_REASON = "sandbox.bundle_migration_required";
const BUNDLE_MIGRATION_REQUIRED_LAST_ERROR =
  "OPENCLAW_BUNDLE_MIGRATION_REQUIRED: "
  + "The persistent sandbox requires an explicit bundle data migration.";

type PersistentAutoSaveInput = {
  sandboxId: string;
  lifecycleAttemptId: string | null;
  dynamicConfigHash: string;
  assetSha256: string;
};

type CooperativePersistentStopOptions = {
  meta: SingleMeta;
  sandbox: SandboxHandle;
  reason: string;
  lease?: AutoRenewedLockLease;
  deadlineAtMs?: number;
  pendingAutoSave?: PersistentAutoSaveInput;
  afterPrepare?: () => Promise<void>;
};

const MIN_PLATFORM_STOP_REQUEST_BUDGET_MS = 5_000;

function assertPlatformStopBudget(deadlineAtMs: number | undefined): void {
  if (
    deadlineAtMs !== undefined
    && deadlineAtMs - Date.now() < MIN_PLATFORM_STOP_REQUEST_BUDGET_MS
  ) {
    throw new ApiError(
      503,
      "SANDBOX_STOP_BUDGET_EXHAUSTED",
      "Not enough function budget remains to begin a durable sandbox stop.",
    );
  }
}

async function requestPlatformStopWithinDeadline(input: {
  sandbox: SandboxHandle;
  deadlineAtMs?: number;
}): Promise<void> {
  const request = input.sandbox.stop({ blocking: false });
  if (input.deadlineAtMs === undefined) {
    await request;
    return;
  }

  const remainingMs = Math.max(1, input.deadlineAtMs - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ApiError(
          504,
          "SANDBOX_STOP_REQUEST_TIMEOUT",
          "The platform stop request exceeded the remaining function budget.",
        )), remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function prepareDedicatedHostSuspension(input: {
  sandbox: SandboxHandle;
  lifecycleAttemptId: string | null;
  reason: string;
  intent?: "stop" | "reset";
}): Promise<HostSuspensionState | null> {
  const existing = await readHostSuspensionState();
  if (
    existing?.ingressFenced
    && existing.sandboxId === input.sandbox.sandboxId
  ) {
    if (existing.lifecycleAttemptId !== input.lifecycleAttemptId) {
      throw new ApiError(
        409,
        "HOST_SUSPENSION_CONFLICT",
        "A fenced lifecycle operation belongs to a different sandbox generation.",
      );
    }
    const completedStop = existing.phase === "stopped"
      || existing.phase === "thawing"
      || existing.phase === "rollback-pending";
    if (completedStop) {
      if (!await thawHostSuspensionIfNeeded({
        sandbox: input.sandbox,
        lifecycleAttemptId: input.lifecycleAttemptId,
      })) {
        throw new ApiError(
          503,
          "HOST_SUSPENSION_THAW_FAILED",
          "The prior Gateway suspension could not be resumed before a new stop.",
        );
      }
    } else if (
      existing.reason !== input.reason
      || existing.intent !== (input.intent ?? "stop")
    ) {
      throw new ApiError(
        409,
        "HOST_SUSPENSION_CONFLICT",
        "A different fenced lifecycle operation is still in progress.",
      );
    }
  }

  try {
    return await prepareHostSuspension(input);
  } catch (error) {
    if (!isGatewaySuspensionCapabilityUnavailable(error)) throw error;
    await clearInactiveHostSuspension({ sandboxId: input.sandbox.sandboxId });
    return null;
  }
}

async function requestCooperativePersistentStop(
  options: CooperativePersistentStopOptions,
): Promise<SingleMeta> {
  const { sandbox } = options;
  const beforeStop = options.meta;
  const stopAttemptId = randomUUID();
  let suspension: HostSuspensionState | null = null;
  let parkedForStop = false;
  let platformStopRequestStarted = false;
  try {
    assertPlatformStopBudget(options.deadlineAtMs);
    await options.lease?.assertOwned();
    suspension = await prepareDedicatedHostSuspension({
      sandbox,
      lifecycleAttemptId: beforeStop.lifecycleAttemptId ?? null,
      reason: options.reason,
    });
    await options.afterPrepare?.();
    await options.lease?.assertOwned();
    assertPlatformStopBudget(options.deadlineAtMs);
    if (suspension) {
      suspension = await renewHostSuspension({ state: suspension, sandbox });
      suspension = await markHostSuspensionStopRequesting(suspension);
    }

    const snapshottingMeta = await mutateMeta((meta) => {
      if (
        (meta.lifecycleAttemptId ?? null) !== (beforeStop.lifecycleAttemptId ?? null)
        || meta.sandboxId !== beforeStop.sandboxId
      ) return;
      if (options.pendingAutoSave && meta.restorePreparedStatus !== "preparing") return;
      // Persist only the exact config generation that was synchronized. A
      // concurrent channel mutation must retry preparation, never attest old
      // sandbox bytes under a newer metadata hash.
      if (
        options.pendingAutoSave
        && computeMetaGatewayConfigHash(meta)
          !== options.pendingAutoSave.dynamicConfigHash
      ) return;
      meta.sandboxId = sandbox.sandboxId;
      meta.status = "snapshotting";
      meta.portUrls = null;
      meta.lastAccessedAt = Date.now();
      meta.lastError = null;
      if (meta.lastRestoreMetrics) {
        meta.lastRestoreMetrics = {
          ...meta.lastRestoreMetrics,
          telegramListenerReady: false,
        };
      }
      meta.pendingPersistentAutoSave = options.pendingAutoSave
        ? {
            sandboxId: sandbox.sandboxId,
            lifecycleAttemptId: options.pendingAutoSave.lifecycleAttemptId,
            operationId: suspension?.operationId ?? null,
            dynamicConfigHash: options.pendingAutoSave.dynamicConfigHash,
            assetSha256: options.pendingAutoSave.assetSha256,
            createdAt: Date.now(),
          }
        : null;
      meta.activePersistentStop = {
        stopAttemptId,
        sandboxId: sandbox.sandboxId,
        lifecycleAttemptId: beforeStop.lifecycleAttemptId ?? null,
        operationId: suspension?.operationId ?? null,
        reason: options.reason,
        startedAt: Date.now(),
      };
    });
    const parkedPending = snapshottingMeta.pendingPersistentAutoSave;
    const pendingMatches = options.pendingAutoSave
      ? parkedPending?.sandboxId === sandbox.sandboxId
        && parkedPending.lifecycleAttemptId
          === options.pendingAutoSave.lifecycleAttemptId
        && parkedPending.operationId === (suspension?.operationId ?? null)
        && parkedPending.dynamicConfigHash
          === options.pendingAutoSave.dynamicConfigHash
        && parkedPending.assetSha256 === options.pendingAutoSave.assetSha256
      : parkedPending === null;
    if (
      (snapshottingMeta.lifecycleAttemptId ?? null)
        !== (beforeStop.lifecycleAttemptId ?? null)
      || snapshottingMeta.sandboxId !== sandbox.sandboxId
      || snapshottingMeta.status !== "snapshotting"
      || snapshottingMeta.activePersistentStop?.stopAttemptId !== stopAttemptId
      || !pendingMatches
    ) {
      throw new LifecycleLockOwnershipLostError();
    }
    parkedForStop = true;

    if (suspension) {
      suspension = await ensureHostStopMonitor(suspension);
    }

    // The durable state and monitor precede the platform request. If this
    // invocation disappears, the monitor can adopt and reconcile the stop.
    await options.lease?.assertOwned();
    platformStopRequestStarted = true;
    await requestPlatformStopWithinDeadline({
      sandbox,
      deadlineAtMs: options.deadlineAtMs,
    });
    if (suspension) {
      suspension = await markHostSuspensionStopping(suspension);
    }
    await clearSandboxDeadline(sandbox.sandboxId, {
      lifecycleAttemptId: beforeStop.lifecycleAttemptId ?? null,
    });
    return snapshottingMeta;
  } catch (error) {
    if (platformStopRequestStarted) {
      logWarn("sandbox.stop.request_outcome_ambiguous", {
        sandboxId: sandbox.sandboxId,
        reason: options.reason,
        error: error instanceof Error ? error.message : String(error),
      });
      if (suspension) await ensureHostStopMonitor(suspension);
      return getInitializedMeta();
    }

    if (parkedForStop) {
      await mutateMeta((meta) => {
        if (
          (meta.lifecycleAttemptId ?? null) !== (beforeStop.lifecycleAttemptId ?? null)
          || meta.sandboxId !== sandbox.sandboxId
          || meta.status !== "snapshotting"
        ) return;
        meta.sandboxId = beforeStop.sandboxId;
        meta.status = beforeStop.status;
        meta.portUrls = beforeStop.portUrls;
        meta.lastAccessedAt = beforeStop.lastAccessedAt;
        meta.pendingPersistentAutoSave = beforeStop.pendingPersistentAutoSave;
        meta.activePersistentStop = beforeStop.activePersistentStop;
      });
    }
    if (suspension) {
      await rollbackHostSuspension({ state: suspension, sandbox, error });
    }
    throw error;
  }
}

async function quiesceSandboxForBundleMigration(input: {
  sandbox: SandboxHandle;
  lifecycleAttemptId: string | null;
  lease?: AutoRenewedLockLease;
}): Promise<boolean> {
  try {
    const meta = await getInitializedMeta();
    if (meta.lifecycleAttemptId !== input.lifecycleAttemptId) {
      throw new LifecycleLockOwnershipLostError();
    }
    await requestCooperativePersistentStop({
      meta,
      sandbox: input.sandbox,
      reason: BUNDLE_MIGRATION_SUSPENSION_REASON,
      lease: input.lease,
    });
    const stopped = await waitForConfirmedPersistentStop();
    return stopped.status === "stopped"
      || terminalBundleReadyFailure(stopped.lastError)?.code
        === "OPENCLAW_BUNDLE_MIGRATION_REQUIRED";
  } catch (error) {
    if (error instanceof LifecycleLockOwnershipLostError) throw error;
    if (error instanceof HostSuspensionBusyError) throw error;
    if (
      error instanceof ApiError
      && error.code === "SANDBOX_STOP_TIMEOUT"
      && (await getInitializedMeta()).status === "snapshotting"
    ) {
      return false;
    }
    throw new SandboxBundleQuiesceFailedError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function assertLifecycleGuardCurrent(
  lifecycleGuard?: SandboxLifecycleGuard,
): Promise<void> {
  if (lifecycleGuard && !(await lifecycleGuard())) {
    throw new SandboxLifecycleGuardRejectedError();
  }
}

export class SandboxLifecycleLockContendedError extends ApiError {
  constructor() {
    super(409, "LIFECYCLE_LOCK_CONTENDED", "Sandbox lifecycle work is already in progress.");
    this.name = "SandboxLifecycleLockContendedError";
  }
}

function configuredBundleMatchesStoredIdentity(
  identity: SingleMeta["bundleIdentity"],
): boolean {
  const bundleMode = Boolean(process.env.OPENCLAW_BUNDLE_URL?.trim());
  if (!bundleMode) return identity === null;
  if (!isVerifiedBundleIdentity(identity)) return false;
  const sourceSha = process.env.OPENCLAW_BUNDLE_SOURCE_SHA?.trim();
  const canonicalSha256 = process.env.OPENCLAW_BUNDLE_SHA256?.trim();
  const packageSpec = process.env.OPENCLAW_PACKAGE_SPEC?.trim();
  return sourceSha === identity.forkSha
    && canonicalSha256 === identity.canonicalSha256
    && (!packageSpec || packageSpec === identity.packageSpec);
}

async function fenceRunningBundleMismatch(
  expected: SingleMeta,
): Promise<SingleMeta> {
  if (process.env.OPENCLAW_BUNDLE_URL?.trim()) {
    try {
      const admission = await admitConfiguredOpenClawBundle();
      if (!admission) {
        throw new Error("No configured bundle admission was produced.");
      }
      if (
        isVerifiedBundleIdentity(expected.bundleIdentity)
        && verifiedBundleIdentitiesEqual(
          expected.bundleIdentity,
          admission.identity,
        )
      ) return getInitializedMeta();
    } catch (error) {
      throw new ApiError(
        503,
        "OPENCLAW_BUNDLE_ADMISSION_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  try {
    return await withLifecycleLock(async (lease) => {
      const current = await getInitializedMeta();
      if (
        current.status !== "running"
        || !current.sandboxId
        || current.sandboxId !== expected.sandboxId
        || (current.lifecycleAttemptId ?? null)
          !== (expected.lifecycleAttemptId ?? null)
      ) return current;
      const sandbox = await getSandboxController().get({
        sandboxId: current.sandboxId,
        resume: false,
      });
      if (sandbox.status !== "running") {
        return mutateMeta((meta) => {
          if (
            meta.status !== "running"
            || meta.sandboxId !== current.sandboxId
            || (meta.lifecycleAttemptId ?? null)
              !== (current.lifecycleAttemptId ?? null)
          ) return;
          meta.status = "error";
          meta.portUrls = null;
          meta.lastError = BUNDLE_MIGRATION_REQUIRED_LAST_ERROR;
          meta.lastGatewayProbeReady = false;
        });
      }
      await quiesceSandboxForBundleMigration({
        sandbox,
        lifecycleAttemptId: current.lifecycleAttemptId ?? null,
        lease,
      });
      return getInitializedMeta();
    });
  } catch (error) {
    if (error instanceof LifecycleLockUnavailableError) return getInitializedMeta();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Structured result types for token refresh
// ---------------------------------------------------------------------------

export type TokenRefreshResult = {
  refreshed: boolean;
  reason: string;
  credential?: { token: string; source: string; expiresAt: number | null } | null;
  retryAfterMs?: number;
};

export type EnsureUsableCredentialOptions = {
  /** Minimum remaining TTL in ms before a refresh is triggered (default: 600000 = 10 min). */
  minRemainingMs?: number;
  /** Force refresh regardless of TTL or throttle. */
  force?: boolean;
  /** When true, treat missing credential as an error (used during boot on Vercel). */
  required?: boolean;
  /** Human-readable reason for logging. */
  reason?: string;
  /** Canonical host origin that must remain reachable after policy refresh. */
  controlPlaneOrigin?: string;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function recoverRollbackPendingSandbox(
  expected: SingleMeta,
): Promise<SingleMeta> {
  const expectedStatus = expected.status;
  if (
    (expectedStatus !== "error" && expectedStatus !== "running")
    || !expected.sandboxId
  ) return expected;
  const sandboxId = expected.sandboxId;
  const lifecycleAttemptId = expected.lifecycleAttemptId ?? null;
  try {
    return await withSandboxLifecycleMutationLock(async (assertOwned) => {
      const [current, suspension] = await Promise.all([
        getInitializedMeta(),
        readHostSuspensionState(),
      ]);
      if (
        current.status !== expectedStatus
        || current.sandboxId !== sandboxId
        || (current.lifecycleAttemptId ?? null) !== lifecycleAttemptId
        || suspension?.phase !== "rollback-pending"
        || suspension.sandboxId !== sandboxId
        || suspension.lifecycleAttemptId !== lifecycleAttemptId
      ) return current;
      await assertOwned();
      let sandbox: SandboxHandle;
      try {
        sandbox = await getSandboxController().get({
          sandboxId,
          resume: false,
        });
      } catch (error) {
        if (!isSandboxGoneError(error)) throw error;
        const deleted = await mutateMeta((meta) => {
          if (
            meta.status !== expectedStatus
            || meta.sandboxId !== sandboxId
            || (meta.lifecycleAttemptId ?? null) !== lifecycleAttemptId
          ) return;
          failPendingPersistentAutoSave(meta);
          meta.status = "uninitialized";
          meta.sandboxId = null;
          meta.portUrls = null;
          meta.lifecycleAttemptId = null;
          meta.lastError = null;
          meta.lastGatewayProbeReady = false;
        });
        if (deleted.status !== "uninitialized" || deleted.sandboxId !== null) {
          return deleted;
        }
        await clearHostSuspensionAfterDelete({
          sandboxId,
          operationId: suspension.operationId,
        });
        await clearSandboxDeadline(sandboxId, { lifecycleAttemptId });
        return deleted;
      }
      await assertOwned();
      if (sandbox.status !== "running") return current;
      if (!await thawHostSuspensionIfNeeded({ sandbox, lifecycleAttemptId })) {
        return getInitializedMeta();
      }
      await assertOwned();
      return mutateMeta((meta) => {
        if (
          meta.status !== expectedStatus
          || meta.sandboxId !== sandboxId
          || (meta.lifecycleAttemptId ?? null) !== lifecycleAttemptId
        ) return;
        meta.status = "running";
        meta.portUrls = resolvePortUrls(sandbox);
        meta.lastAccessedAt = Date.now();
        meta.lastError = null;
        meta.lastGatewayProbeReady = false;
      });
    });
  } catch (error) {
    if (error instanceof SandboxLifecycleLockContendedError) {
      return getInitializedMeta();
    }
    throw error;
  }
}

export async function ensureSandboxRunning(options: {
  origin: string;
  reason: string;
  schedule?: BackgroundScheduler;
  lifecycleGuard?: SandboxLifecycleGuard;
  op?: OperationContext;
}): Promise<{ state: "running" | "waiting"; meta: SingleMeta }> {
  let meta = await getInitializedMeta();
  // If a non-blocking stop is mid-snapshot, try to advance to "stopped" so
  // the restore path can run instead of bouncing through "waiting" again.
  if (meta.status === "snapshotting") {
    meta = await reconcileSnapshottingStatus();
  }
  if (
    (meta.status === "error" || meta.status === "running")
    && meta.sandboxId
  ) {
    meta = await recoverRollbackPendingSandbox(meta);
  }
  // Bundle migration failures are operator-actionable terminal states. Keep
  // them stable instead of letting a waiter erase the code and start again.
  if (meta.status === "error" && terminalBundleReadyFailure(meta.lastError)) {
    return { state: "waiting", meta };
  }
  const opCtx = options.op ? withOperationContext(options.op, {
    sandboxId: meta.sandboxId,
    snapshotId: meta.snapshotId,
    status: meta.status,
  }) : { reason: options.reason, status: meta.status };
  logInfo("sandbox.ensure_running", opCtx);

  if (meta.status === "running" && meta.sandboxId) {
    if (!configuredBundleMatchesStoredIdentity(meta.bundleIdentity)) {
      meta = await fenceRunningBundleMismatch(meta);
      return { state: "waiting", meta };
    }
    const hostSuspension = await readHostSuspensionState();
    if (hostSuspension?.ingressFenced) {
      if (
        hostSuspension.phase !== "stopped"
        && hostSuspension.phase !== "thawing"
        && hostSuspension.phase !== "rollback-pending"
      ) {
        return { state: "waiting", meta };
      }
      const sandbox = await getSandboxController().get({
        sandboxId: meta.sandboxId,
        resume: false,
      });
      const thawed = await thawHostSuspensionIfNeeded({
        sandbox,
        lifecycleAttemptId: meta.lifecycleAttemptId ?? null,
      });
      if (!thawed) {
        return { state: "waiting", meta };
      }
      meta = await getInitializedMeta();
    }

    // Check if the sandbox has likely timed out — if so, reconcile instead
    // of returning stale "running" state. The platform auto-stops sandboxes
    // after sleepAfterMs, but our metadata is never updated.
    const remainingMs = estimateSandboxTimeoutRemainingMs(
      meta.lastAccessedAt,
      getSandboxSleepAfterMs(),
    );
    if (remainingMs === null || remainingMs > 0) {
      return { state: "running", meta };
    }

    logInfo("sandbox.ensure_running.timeout_expired", {
      ...opCtx,
      lastAccessedAt: meta.lastAccessedAt,
      sleepAfterMs: getSandboxSleepAfterMs(),
    });
    const health = await reconcileSandboxHealth({
      origin: options.origin,
      reason: options.reason,
      schedule: options.schedule,
      lifecycleGuard: options.lifecycleGuard,
      op: options.op,
    });
    if (health.status === "ready") {
      return { state: "running", meta: health.meta };
    }
    return { state: "waiting", meta: health.meta };
  }

  if (isBusyStatus(meta.status)) {
    if (isOperationStale(meta)) {
      logWarn("sandbox.stale_operation", options.op
        ? withOperationContext(options.op, { status: meta.status, updatedAt: meta.updatedAt })
        : { status: meta.status, updatedAt: meta.updatedAt });
      await scheduleLifecycleWork({ ...options, meta });
    } else if (options.op) {
      logInfo("sandbox.ensure_running.busy_waiting", withOperationContext(options.op, {
        status: meta.status,
        action: "waiting",
      }));
    }
    return { state: "waiting", meta };
  }

  const action = meta.snapshotId && meta.status !== "uninitialized" ? "restore" : "create";
  if (options.op) {
    logInfo("sandbox.ensure_running.scheduling", withOperationContext(options.op, {
      action,
      statusBefore: meta.status,
      sandboxId: meta.sandboxId,
      snapshotId: meta.snapshotId,
    }));
  }

  await scheduleLifecycleWork({ ...options, meta });
  return { state: "waiting", meta: await getInitializedMeta() };
}

export type SandboxReadyAction =
  | "already-running"
  | "created-or-restored"
  | "recovered-stale-running";

export type WaitForSandboxReadyOptions = {
  origin: string;
  reason: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  reconcile?: boolean;
  lifecycleGuard?: SandboxLifecycleGuard;
  op?: OperationContext;
};

export type WaitForSandboxReadyResult = {
  meta: SingleMeta;
  readyAction: SandboxReadyAction;
};

export type ResetSandboxOptions = {
  origin: string;
  reason: string;
  op?: OperationContext;
  expectedOperationId?: string;
  expectedSandboxId?: string;
  expectedLifecycleAttemptId?: string | null;
};

export type ResetSandboxDeps = {
  deleteSnapshot?: (snapshotId: string) => Promise<void>;
};

const BUNDLE_READY_FAILURES = {
  OPENCLAW_BUNDLE_MIGRATION_REQUIRED: {
    status: 409,
    fallbackMessage: "The persistent sandbox requires an explicit bundle data migration.",
  },
  OPENCLAW_BUNDLE_QUIESCE_FAILED: {
    status: 502,
    fallbackMessage: "The persistent sandbox could not be quiesced for bundle migration.",
  },
  OPENCLAW_BUNDLE_CANDIDATE_CLEANUP_FAILED: {
    status: 502,
    fallbackMessage: "The unverified bundle sandbox could not be deleted safely.",
  },
} as const;

function stableBundleReadyFailure(lastError: string | null): ApiError | null {
  for (const [code, failure] of Object.entries(BUNDLE_READY_FAILURES)) {
    if (lastError === code || lastError?.startsWith(`${code}:`)) {
      const detail = lastError?.slice(code.length + 1).trim();
      return new ApiError(
        failure.status,
        code,
        detail || failure.fallbackMessage,
      );
    }
  }
  return null;
}

function terminalBundleReadyFailure(lastError: string | null): ApiError | null {
  const failure = stableBundleReadyFailure(lastError);
  return failure?.code === "OPENCLAW_BUNDLE_CANDIDATE_CLEANUP_FAILED"
    ? null
    : failure;
}
function sandboxReadyFailure(
  lastError: string | null,
  context: "reconciling" | "waiting",
): ApiError {
  return stableBundleReadyFailure(lastError) ?? new ApiError(
    502,
    "SANDBOX_READY_FAILED",
    `Sandbox entered error state while ${context}: ${lastError ?? "unknown"}.`,
  );
}

export async function waitForSandboxReady(
  options: WaitForSandboxReadyOptions,
): Promise<WaitForSandboxReadyResult> {
  const timeoutMs = options.timeoutMs ?? READY_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? READY_WAIT_POLL_MS;

  const initialMeta = await getInitializedMeta();
  if (initialMeta.status === "error") {
    const terminalFailure = terminalBundleReadyFailure(initialMeta.lastError);
    if (terminalFailure) throw terminalFailure;
  }
  const wasRunningInitially =
    initialMeta.status === "running" && Boolean(initialMeta.sandboxId);

  let recoveredStaleRunning = false;

  function resolveAction(): SandboxReadyAction {
    if (recoveredStaleRunning) return "recovered-stale-running";
    if (wasRunningInitially) return "already-running";
    return "created-or-restored";
  }

  // Optional reconciliation pre-step
  if (options.reconcile) {
    const health = await reconcileSandboxHealth({
      origin: options.origin,
      reason: options.reason,
      lifecycleGuard: options.lifecycleGuard,
      op: options.op,
    });

    recoveredStaleRunning = health.repaired;

    if (health.meta.status === "error") {
      throw sandboxReadyFailure(health.meta.lastError, "reconciling");
    }

    if (health.status === "ready") {
      return {
        meta: await getInitializedMeta(),
        readyAction: resolveAction(),
      };
    }
  }

  try {
    return await pollUntil<WaitForSandboxReadyResult, SingleMeta>({
      label: "sandbox.ready",
      timeoutMs,
      initialDelayMs: pollIntervalMs,
      state: initialMeta,
      step: async () => {
        const result = await ensureSandboxRunning({
          origin: options.origin,
          reason: options.reason,
          lifecycleGuard: options.lifecycleGuard,
          op: options.op,
        });

        if (result.meta.status === "error") {
          throw sandboxReadyFailure(result.meta.lastError, "waiting");
        }

        if ((await probeGatewayReady()).ready) {
          return {
            done: true,
            result: {
              meta: await getInitializedMeta(),
              readyAction: resolveAction(),
            },
          };
        }
        return {
          done: false,
          state: await getInitializedMeta(),
          delayMs: pollIntervalMs,
        };
      },
      timeoutError: ({ state }) =>
        new ApiError(
          504,
          "SANDBOX_READY_TIMEOUT",
          `Sandbox did not become ready within ${Math.ceil(timeoutMs / 1000)} seconds (last status: ${state?.status ?? "unknown"}).`,
        ),
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === "SANDBOX_READY_TIMEOUT") {
      const latest = await getInitializedMeta();
      const stableFailure = stableBundleReadyFailure(latest.lastError);
      if (latest.status === "error" && stableFailure) throw stableFailure;
    }
    throw error;
  }
}

export async function ensureSandboxReady(options: {
  origin: string;
  reason: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  lifecycleGuard?: SandboxLifecycleGuard;
  op?: OperationContext;
}): Promise<SingleMeta> {
  const lifecycleGuard = options.lifecycleGuard;
  if (lifecycleGuard) {
    const guardedOptions = { ...options, lifecycleGuard };
    return withGuardedLifecycleLock(guardedOptions, async (lease) =>
      ensureSandboxReadyWithinLifecycleLock({ ...guardedOptions, lease }),
    );
  }
  const result = await waitForSandboxReady({ ...options, reconcile: true });
  return result.meta;
}

export async function ensureSandboxReadyForCron(options: {
  origin: string;
  reason: string;
  aliveThroughMs: number;
  lifecycleGuard: SandboxLifecycleGuard;
}): Promise<{ meta: SingleMeta; credential: TokenRefreshResult }> {
  return withGuardedLifecycleLock(options, async (lease) => {
    const meta = await ensureSandboxReadyWithinLifecycleLock({
      ...options,
      refreshGatewayToken: false,
      lease,
    });
    await assertLifecycleGuardCurrent(options.lifecycleGuard);
    await ensureSandboxAliveThrough(options.aliveThroughMs);
    await assertLifecycleGuardCurrent(options.lifecycleGuard);
    const credential = await ensureUsableAiGatewayCredentialWithinLifecycleLock(
      {
        force: true,
        required: true,
        reason: options.reason,
        controlPlaneOrigin: options.origin,
      },
      () => lease.assertOwned(),
    );
    await assertLifecycleGuardCurrent(options.lifecycleGuard);
    return { meta, credential };
  });
}

async function withGuardedLifecycleLock<T>(
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    lifecycleGuard: SandboxLifecycleGuard;
    reason?: string;
  },
  action: (lease: AutoRenewedLockLease) => Promise<T>,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? READY_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? READY_WAIT_POLL_MS;
  const deadlineMs = Date.now() + timeoutMs;
  let reportedContention = false;
  while (true) {
    try {
      return await withLifecycleLock(async (lease) => {
        await assertLifecycleGuardCurrent(options.lifecycleGuard);
        return action(lease);
      });
    } catch (error) {
      if (!(error instanceof LifecycleLockUnavailableError)) throw error;
      if (!reportedContention) {
        reportedContention = true;
        logInfo("sandbox.lifecycle_lock_contended", {
          reason: options.reason ?? "guarded-lifecycle",
          guarded: true,
        });
      }
      if (Date.now() >= deadlineMs) {
        throw new SandboxLifecycleLockContendedError();
      }
      await wait(pollIntervalMs);
    }
  }
}

async function ensureSandboxReadyWithinLifecycleLock(options: {
  origin: string;
  reason: string;
  lifecycleGuard: SandboxLifecycleGuard;
  refreshGatewayToken?: boolean;
  op?: OperationContext;
  lease: AutoRenewedLockLease;
}): Promise<SingleMeta> {
  let current = await getInitializedMeta();
  if (current.status === "running" && current.sandboxId) {
    const probe = await probeGatewayReady();
    if (probe.ready) {
      await assertLifecycleGuardCurrent(options.lifecycleGuard);
      if (options.refreshGatewayToken !== false) {
        await ensureUsableAiGatewayCredentialWithinLifecycleLock(
          {
            force: true,
            reason: "guarded-sandbox-ready",
            controlPlaneOrigin: options.origin,
          },
          () => options.lease.assertOwned(),
        );
      }
      await assertLifecycleGuardCurrent(options.lifecycleGuard);
      return mutateMeta((meta) => {
        meta.lastAccessedAt = Date.now();
      });
    }
    await assertLifecycleGuardCurrent(options.lifecycleGuard);
    await markSandboxUnavailable(
      `Guarded health reconciliation: gateway unreachable (${options.reason})`,
      current.sandboxId,
    );
    current = await getInitializedMeta();
  }
  const ready = await createAndBootstrapSandboxWithinLifecycleLock(
    options.origin,
    {
      lifecycleGuard: options.lifecycleGuard,
      op: options.op,
      lease: options.lease,
    },
  );
  if (ready.status !== "running" || !ready.sandboxId) {
    throw new ApiError(
      502,
      "SANDBOX_READY_FAILED",
      `Sandbox entered ${ready.status} during guarded readiness.`,
    );
  }
  await assertLifecycleGuardCurrent(options.lifecycleGuard);
  return ready;
}

export async function resetSandbox(
  options: ResetSandboxOptions,
  deps: ResetSandboxDeps = {},
): Promise<SingleMeta> {
  const deleteSnapshot = deps.deleteSnapshot ?? deleteVercelSnapshot;
  let resetTarget: Pick<
    SingleMeta,
    "sandboxId" | "lifecycleAttemptId" | "gatewayToken"
  > | null = null;
  let sandboxDestroyed = false;
  let destroyedSandboxId: string | null = null;
  let destroyedOperationId: string | null = null;
  const ctx = (extra: Record<string, unknown> = {}) =>
    options.op
      ? withOperationContext(options.op, extra)
      : { reason: options.reason, ...extra };

  logInfo("sandbox.reset_requested", ctx());

  try {
    return await withLifecycleLock(async (lease) => {
      await lease.assertOwned();
      const current = await getInitializedMeta();
      if (options.expectedOperationId !== undefined) {
        const suspension = await readHostSuspensionState();
        const currentOwnsExpectedGeneration =
          current.sandboxId === options.expectedSandboxId
          && (current.lifecycleAttemptId ?? null)
            === options.expectedLifecycleAttemptId;
        const currentAlreadyCleared = current.sandboxId === null
          && current.lifecycleAttemptId === null;
        if (
          suspension?.operationId !== options.expectedOperationId
          || suspension.intent !== "reset"
          || suspension.phase !== "stopping"
          || suspension.lifecycleAttemptId
            !== options.expectedLifecycleAttemptId
          || (
            options.expectedSandboxId !== undefined
            && suspension.sandboxId !== options.expectedSandboxId
          )
          || (!currentOwnsExpectedGeneration && !currentAlreadyCleared)
        ) {
          throw new ApiError(
            409,
            "RESET_OPERATION_SUPERSEDED",
            "The monitored reset operation no longer owns the sandbox generation.",
          );
        }
      }
      resetTarget = {
        sandboxId: current.sandboxId,
        lifecycleAttemptId: current.lifecycleAttemptId,
        gatewayToken: current.gatewayToken,
      };
      const assertResetGeneration = async (): Promise<void> => {
        await lease.assertOwned();
        const latest = await getInitializedMeta();
        if (
          !resetTarget
          || latest.sandboxId !== resetTarget.sandboxId
          || (latest.lifecycleAttemptId ?? null)
            !== (resetTarget.lifecycleAttemptId ?? null)
          || latest.gatewayToken !== resetTarget.gatewayToken
        ) {
          throw new LifecycleLockOwnershipLostError();
        }
      };
      const snapshotIds = collectTrackedSnapshotIds(current);

      logInfo("sandbox.reset.start", ctx({
        status: current.status,
        sandboxId: current.sandboxId,
        snapshotCount: snapshotIds.length,
      }));

      await destroyCurrentSandboxWithoutSnapshot(current, ctx, {
        lease,
        onSandboxResolved(sandboxId) {
          if (resetTarget?.sandboxId !== null) {
            resetTarget = {
              sandboxId,
              lifecycleAttemptId: current.lifecycleAttemptId,
              gatewayToken: current.gatewayToken,
            };
          }
        },
        onSandboxDestroyed(sandboxId, operationId) {
          sandboxDestroyed = true;
          destroyedSandboxId = sandboxId;
          destroyedOperationId = operationId;
        },
      });
      await lease.assertOwned();
      const failedSnapshotIds = await deleteTrackedSnapshotsForReset(
        snapshotIds,
        deleteSnapshot,
        ctx,
        assertResetGeneration,
      );
      await lease.assertOwned();
      await clearResetCronState(ctx, {
        lease,
        expected: resetTarget,
      });
      await lease.assertOwned();

      if (failedSnapshotIds.length > 0) {
        const errorMessage =
          `Sandbox reset failed while deleting snapshots: ${failedSnapshotIds.join(", ")}`;

        const failedIdSet = new Set(failedSnapshotIds);
        const failedSnapshotHistory = current.snapshotHistory.filter((record) =>
          failedIdSet.has(record.snapshotId),
        );
        const failedMeta = await mutateMeta((meta) => {
          if (
            !resetTarget
            || meta.sandboxId !== resetTarget.sandboxId
            || (meta.lifecycleAttemptId ?? null)
              !== (resetTarget.lifecycleAttemptId ?? null)
          ) return;
          clearSandboxRuntimeStateForReset(meta);
          meta.status = "error";
          meta.lastError = errorMessage;
          meta.snapshotId =
            current.snapshotId && failedIdSet.has(current.snapshotId)
              ? current.snapshotId
              : null;
          meta.snapshotHistory = failedSnapshotHistory;
        });
        if (failedMeta.status !== "error" || failedMeta.sandboxId !== null) {
          throw new LifecycleLockOwnershipLostError();
        }
        await lease.assertOwned();
        await clearResetHostSuspensionAfterCommit(
          destroyedSandboxId ?? resetTarget.sandboxId,
          destroyedOperationId,
        );

        logError("sandbox.reset.snapshot_delete_failed", ctx({
          failedSnapshotIds,
          attemptedSnapshotIds: snapshotIds,
        }));
        return getInitializedMeta();
      }

      const resetMeta = await mutateMeta((meta) => {
        if (
          !resetTarget
          || meta.sandboxId !== resetTarget.sandboxId
          || (meta.lifecycleAttemptId ?? null)
            !== (resetTarget.lifecycleAttemptId ?? null)
        ) return;
        clearSandboxRuntimeStateForReset(meta);
        meta.status = "uninitialized";
        meta.lastError = null;
      });
      if (resetMeta.status !== "uninitialized" || resetMeta.sandboxId !== null) {
        throw new LifecycleLockOwnershipLostError();
      }
      await lease.assertOwned();
      await clearResetHostSuspensionAfterCommit(
        destroyedSandboxId ?? resetTarget.sandboxId,
        destroyedOperationId,
      );
      await lease.assertOwned();

      logInfo("sandbox.reset.completed", ctx({
        status: resetMeta.status,
        snapshotCount: snapshotIds.length,
      }));

      return resetMeta;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof LifecycleLockUnavailableError) {
      logInfo("sandbox.reset.lifecycle_lock_contended", ctx({ error: message }));
      throw new SandboxLifecycleLockContendedError();
    }

    logError("sandbox.reset_failed", ctx({ error: message }));
    if (sandboxDestroyed) {
      await clearResetHostSuspensionAfterCommit(
        destroyedSandboxId,
        destroyedOperationId,
      ).catch((cleanupError) => {
        logWarn("sandbox.reset.host_suspension_cleanup_failed", ctx({
          error: cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
        }));
      });
    }
    try {
      await mutateMeta((meta) => {
        if (
          !resetTarget
          || meta.sandboxId !== resetTarget.sandboxId
          || meta.lifecycleAttemptId !== resetTarget.lifecycleAttemptId
        ) return;
        if (sandboxDestroyed) {
          clearSandboxRuntimeStateForReset(meta);
          meta.status = "error";
        }
        meta.lastError = `Sandbox reset failed: ${message}`;
      });
    } catch (metaError) {
      logWarn("sandbox.reset.meta_update_failed", ctx({
        error: message,
        metaError: metaError instanceof Error ? metaError.message : String(metaError),
      }));
    }
    throw error;
  }
}

async function cleanupBeforeSnapshot(
  sandbox: SandboxHandle,
  firewallMode: SingleMeta["firewall"]["mode"],
): Promise<void> {
  logInfo("openclaw.pre_snapshot_cleanup", { sandboxId: sandbox.sandboxId });

  const cleanupCommands = [
    `rm -f ${OPENCLAW_LOG_FILE} || true`,
    "rm -rf /tmp/openclaw || true",
    "rm -rf /home/vercel-sandbox/.npm || true",
    "rm -rf /root/.npm || true",
    "rm -rf /tmp/openclaw-npm-cache || true",
  ];

  if (firewallMode !== "learning") {
    cleanupCommands.push("rm -f /tmp/shell-commands-for-learning.log || true");
  }

  try {
    const result = await sandbox.runCommand("bash", [
      "-lc",
      cleanupCommands.join("\n"),
    ]);

    if (result.exitCode !== 0) {
      const output = await result.output("both");
      throw new CommandFailedError({
        command: "cleanup-before-snapshot",
        exitCode: result.exitCode,
        output,
      });
    }
  } catch (error) {
    logWarn("openclaw.pre_snapshot_cleanup_failed", {
      sandboxId: sandbox.sandboxId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

type StopSandboxInternalOptions = {
  deadlineAtMs?: number;
  pendingAutoSave?: PersistentAutoSaveInput;
  lifecycleGuard?: SandboxLifecycleGuard;
};

async function stopSandboxWithOptions(
  options: StopSandboxInternalOptions = {},
): Promise<SingleMeta> {
  logInfo("sandbox.stop_requested");
  try {
    return await withLifecycleLock(async (lease) => {
      await assertLifecycleGuardCurrent(options.lifecycleGuard);
      const meta = await getInitializedMeta();
      if (meta.status === "stopped") {
        const operation = await readHostSuspensionState();
        if (
          operation
          && operation.sandboxId === meta.sandboxId
          && operation.lifecycleAttemptId === (meta.lifecycleAttemptId ?? null)
        ) {
          await markHostSuspensionStopped(operation);
        }
        logInfo("sandbox.already_stopped", { sandboxId: meta.sandboxId });
        return meta;
      }
      if (meta.status === "snapshotting") {
        const operation = await readHostSuspensionState();
        if (operation) await ensureHostStopMonitor(operation);
        logInfo("sandbox.stop_already_in_progress", { sandboxId: meta.sandboxId });
        return meta;
      }
      if (!meta.sandboxId) {
        throw new ApiError(
          409,
          "SANDBOX_NOT_RUNNING",
          "Sandbox is not running and cannot be stopped.",
        );
      }
      if (
        options.pendingAutoSave
        && (
          meta.sandboxId !== options.pendingAutoSave.sandboxId
          || (meta.lifecycleAttemptId ?? null)
            !== options.pendingAutoSave.lifecycleAttemptId
        )
      ) {
        throw new LifecycleLockOwnershipLostError();
      }

      logInfo("sandbox.stopping", { sandboxId: meta.sandboxId });
      try {
        const sandbox = await getSandboxController().get({ sandboxId: meta.sandboxId });
        await assertLifecycleGuardCurrent(options.lifecycleGuard);
        const stoppedMeta = await requestCooperativePersistentStop({
          meta,
          sandbox,
          reason: "sandbox.stop",
          lease,
          deadlineAtMs: options.deadlineAtMs,
          pendingAutoSave: options.pendingAutoSave,
          afterPrepare: async () => {
            await cleanupBeforeSnapshot(sandbox, meta.firewall.mode);
            logInfo("sandbox.status_transition", {
              from: meta.status,
              to: "snapshotting",
              sandboxId: meta.sandboxId,
            });
          },
        });

        // Hot-spare: best-effort pre-create a candidate sandbox after stop.
        if (
          isHotSpareEnabled()
          && !process.env.OPENCLAW_BUNDLE_URL?.trim()
        ) {
          try {
            const hotSpareApiKey = await getAiGatewayBearerTokenOptional();
            const result = await preCreateHotSpare(stoppedMeta, {
              create: (opts) => getSandboxController().create(opts),
              getSandboxVcpus,
              getSandboxSleepAfterMs: getSandboxPlatformTimeoutMs,
              sandboxPorts: SANDBOX_PORTS,
              networkPolicy: toNetworkPolicy(
                stoppedMeta.firewall.mode,
                stoppedMeta.firewall.allowlist,
                hotSpareApiKey ?? undefined,
                requiredControlPlaneDomains(stoppedMeta),
              ),
            });
            if (result.status !== "skipped") {
              await mutateMeta((m) => applyPreCreateToMeta(m, result));
            }
          } catch (err) {
            logWarn("hot_spare.post_stop_pre_create_failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        return stoppedMeta;
      } catch (err) {
        // The sandbox may have already been stopped by the platform (timeout
        // expiry, etc.).  The Vercel API returns 404 or 410 in this case.
        // With v2 persistent sandboxes, a gone sandbox means it was deleted.
        // Mark as uninitialized so the next ensure creates a fresh one.
        const message = err instanceof Error ? err.message : String(err);
        if (isSandboxGoneError(err)) {
          const latest = await getInitializedMeta();
          if (
            !latest.sandboxId
            || (latest.lifecycleAttemptId ?? null) !== (meta.lifecycleAttemptId ?? null)
          ) throw err;
          const goneSandboxId = latest.sandboxId;
          logWarn("sandbox.stop.sandbox_already_gone", {
            sandboxId: goneSandboxId,
            error: message,
          });
          const goneMeta = await mutateMeta((next) => {
            if (
              next.sandboxId !== goneSandboxId
              || (next.lifecycleAttemptId ?? null) !== (meta.lifecycleAttemptId ?? null)
            ) return;
            failPendingPersistentAutoSave(next);
            next.activePersistentStop = null;
            next.sandboxId = null;
            next.portUrls = null;
            next.status = "uninitialized";
            next.lastAccessedAt = Date.now();
            next.lastError = null;
          });
          if (goneMeta.sandboxId !== null || goneMeta.status !== "uninitialized") {
            return goneMeta;
          }
          const goneSuspension = await readHostSuspensionState();
          if (
            goneSuspension?.sandboxId === goneSandboxId
            && goneSuspension.lifecycleAttemptId
              === (meta.lifecycleAttemptId ?? null)
          ) {
            await clearHostSuspensionAfterDelete({
              sandboxId: goneSandboxId,
              operationId: goneSuspension.operationId,
            });
          }
          await clearSandboxDeadline(goneSandboxId, {
            lifecycleAttemptId: meta.lifecycleAttemptId ?? null,
          });
          return goneMeta;
        }
        throw err;
      }
    });
  } catch (error) {
    if (error instanceof LifecycleLockUnavailableError) {
      throw new SandboxLifecycleLockContendedError();
    }
    throw error;
  }
}

export async function stopSandbox(): Promise<SingleMeta> {
  return stopSandboxWithOptions();
}

export async function stopSandboxForDeadline(claim: {
  generationId: string;
  claimedAtMs: number;
}): Promise<SingleMeta> {
  return stopSandboxWithOptions({
    lifecycleGuard: () => claimSandboxDeadlineStop(claim),
  });
}

export async function snapshotSandbox(): Promise<SingleMeta> {
  logInfo("sandbox.snapshot_requested");
  return stopSandbox();
}

export async function markSandboxUnavailable(
  reason: string,
  expectedSandboxId?: string,
  expectedLifecycleAttemptId?: string | null,
): Promise<SingleMeta> {
  return mutateMeta((meta) => {
    if (
      (expectedSandboxId !== undefined && meta.sandboxId !== expectedSandboxId)
      || (
        expectedLifecycleAttemptId !== undefined
        && (meta.lifecycleAttemptId ?? null) !== expectedLifecycleAttemptId
      )
    ) {
      logWarn("sandbox.mark_unavailable_skipped_stale", {
        reason,
        expectedSandboxId,
        expectedLifecycleAttemptId,
        actualSandboxId: meta.sandboxId,
        actualLifecycleAttemptId: meta.lifecycleAttemptId ?? null,
      });
      return;
    }

    meta.sandboxId = null;
    meta.portUrls = null;
    meta.status = meta.snapshotId ? "stopped" : "error";
    meta.lastError = reason;
  });
}

export async function getSandboxDomain(port = OPENCLAW_PORT): Promise<string> {
  const meta = await getInitializedMeta();
  if (!meta.sandboxId || (meta.status !== "running" && meta.status !== "booting")) {
    throw new ApiError(409, "SANDBOX_NOT_RUNNING", "Sandbox is not running.");
  }

  const cached = meta.portUrls?.[String(port)];
  if (cached) {
    return cached;
  }

  const sandbox = await getSandboxController().get({ sandboxId: meta.sandboxId });
  const domain = sandbox.domain(port);
  await mutateMeta((next) => {
    next.portUrls = {
      ...(next.portUrls ?? {}),
      [String(port)]: domain,
    };
  });
  logInfo("sandbox.port_urls.refreshed", {
    port,
    newUrl: domain,
    sandboxId: meta.sandboxId,
    source: "cache_miss",
  });
  return domain;
}

/**
 * The cached public URL for a sandbox port is dead — Vercel returned
 * SANDBOX_NOT_LISTENING for the cached `sb-XXX.vercel.run`. Clear the
 * cache so the next `getSandboxDomain()` call re-fetches via the SDK,
 * and reconcile sandbox liveness in case Vercel has suspended it.
 *
 * The expected sandboxId guard prevents us from clobbering a fresh URL
 * that another concurrent reconcile/restart already wrote.
 */
export async function markSandboxPortUrlStale(
  expectedSandboxId: string | null,
  port: number = OPENCLAW_PORT,
  reason: string = "sandbox-not-listening",
): Promise<{ refreshed: boolean; oldUrl: string | null; newUrl: string | null }> {
  let oldUrl: string | null = null;
  let currentSandboxId: string | null = null;
  let skipReason: string | null = null;

  await mutateMeta((next) => {
    currentSandboxId = next.sandboxId;
    if (!next.sandboxId) {
      skipReason = "no_sandbox";
      return;
    }
    if (expectedSandboxId && expectedSandboxId !== next.sandboxId) {
      skipReason = "sandbox_id_mismatch";
      return;
    }
    const portKey = String(port);
    oldUrl = next.portUrls?.[portKey] ?? null;
    if (!next.portUrls || !(portKey in next.portUrls)) {
      // Already cleared by a concurrent call; nothing to do.
      return;
    }
    const remaining = { ...next.portUrls };
    delete remaining[portKey];
    next.portUrls = Object.keys(remaining).length === 0 ? null : remaining;
  });

  if (skipReason) {
    logWarn("sandbox.port_url_dead.skipped", {
      reason,
      port,
      why: skipReason,
      expectedSandboxId,
      currentSandboxId,
    });
    return { refreshed: false, oldUrl, newUrl: null };
  }

  logWarn("sandbox.port_url_dead", {
    port,
    cachedUrl: oldUrl,
    sandboxId: currentSandboxId,
    reason,
  });

  // Reconcile sandbox status — if Vercel has suspended/destroyed the
  // sandbox out from under us, the next forward will fail fast on
  // SANDBOX_NOT_RUNNING instead of probing a phantom URL.
  try {
    await reconcileStaleRunningStatus();
  } catch (err) {
    logWarn("sandbox.port_url_dead.reconcile_failed", {
      sandboxId: currentSandboxId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Refresh the URL via SDK so the caller can immediately retry with a
  // fresh value. If Vercel returns the same URL after a not-listening
  // response, the sandbox is still not usable; mark it unavailable so the
  // caller's normal ensure/reconcile path restores it with the right origin.
  try {
    const newUrl = await getSandboxDomain(port);
    if (oldUrl && newUrl === oldUrl) {
      logWarn("sandbox.port_url_dead.same_url_after_refresh", {
        sandboxId: currentSandboxId,
        port,
        url: newUrl,
        reason,
        action: "mark_unavailable",
      });
      await markSandboxUnavailable(
        `Port ${port} still returned the same dead sandbox URL after refresh (${reason})`,
        currentSandboxId ?? undefined,
      );
    }
    return { refreshed: true, oldUrl, newUrl };
  } catch (err) {
    logWarn("sandbox.port_url_dead.refresh_failed", {
      sandboxId: currentSandboxId,
      port,
      error: err instanceof Error ? err.message : String(err),
    });
    return { refreshed: false, oldUrl, newUrl: null };
  }
}

/**
 * Write an updated openclaw.json into the running sandbox and restart the
 * gateway so new HTTP routes (e.g. `/slack/events`) are registered.
 *
 * OpenClaw's chokidar file watcher hot-reloads channel providers on config
 * change, but does NOT register new HTTP route handlers — that requires a
 * full gateway restart.  Without this restart, first-time Slack setup on a
 * running sandbox leaves `/slack/events` returning 404 until the next
 * stop+ensure cycle.
 *
 * Called after channel credentials are saved or removed in the admin UI.
 * No-op when the sandbox is not running.
 */
export async function syncGatewayConfigToSandbox(): Promise<LiveConfigSyncResult> {
  try {
    return await withLifecycleLock(syncGatewayConfigToSandboxWithinLifecycleLock);
  } catch (error) {
    const reason = error instanceof LifecycleLockUnavailableError
      ? "lifecycle_lock_contended"
      : error instanceof Error
        ? error.message
        : String(error);
    logWarn("sandbox.config_sync_failed", { reason });
    return {
      outcome: "failed",
      reason,
      liveConfigFresh: false,
      operatorMessage: "Config sync could not acquire the current sandbox lifecycle generation.",
    };
  }
}

async function syncGatewayConfigToSandboxWithinLifecycleLock(
  lease: AutoRenewedLockLease,
): Promise<LiveConfigSyncResult> {
  const meta = await getInitializedMeta();
  if (meta.status !== "running" || !meta.sandboxId) {
    logInfo("sandbox.config_sync_skipped", {
      reason: "sandbox_not_running",
      status: meta.status,
      sandboxId: meta.sandboxId,
    });
    return { outcome: "skipped", reason: "sandbox_not_running", liveConfigFresh: false, operatorMessage: null };
  }

  const { getPublicOrigin } = await import("@/server/public-url");
  const proxyOrigin = getPublicOrigin();
  const verifiedBundleIdentity = matchesConfiguredBundleIdentity(
    meta.bundleIdentity,
  )
    ? meta.bundleIdentity
    : null;

  const slack = meta.channels.slack;
  const files = buildDynamicRestoreFiles({
    proxyOrigin,
    telegramBotToken: meta.channels.telegram?.botToken,
    telegramWebhookSecret: meta.channels.telegram?.webhookSecret,
    slackCredentials: slack
      ? { botToken: slack.botToken, signingSecret: slack.signingSecret }
      : undefined,
    bundleCapabilities: verifiedBundleIdentity?.capabilities,
  });

  const sandboxId = meta.sandboxId;
  try {
    const sandbox = await getSandboxController().get({ sandboxId, resume: false });
    await assertRunningGatewayMutationAllowed({
      sandboxId,
      lifecycleAttemptId: meta.lifecycleAttemptId ?? null,
      lease,
    });
    await sandbox.writeFiles(files);
    logInfo("sandbox.config_sync_written", {
      sandboxId,
      fileCount: files.length,
      filePaths: files.map((f) => f.path),
    });

    // Restart the gateway so new HTTP route handlers are registered.
    // Without this, hot-reload restarts the channel provider but does not
    // wire up new routes like /slack/events.
    const restartStartedAt = Date.now();
    try {
      await restartGateway(sandbox, "config-sync", () =>
        assertRunningGatewayMutationAllowed({
          sandboxId,
          lifecycleAttemptId: meta.lifecycleAttemptId ?? null,
          lease,
        }));
    } catch (restartErr) {
      logWarn("sandbox.config_sync_restart_failed", {
        sandboxId,
        error: restartErr instanceof Error ? restartErr.message : String(restartErr),
        durationMs: Date.now() - restartStartedAt,
      });
      return {
        outcome: "degraded",
        reason: "config_written_restart_failed",
        liveConfigFresh: false,
        operatorMessage: "Credentials were saved, but the running sandbox did not restart cleanly. Live routes may still be stale until the next successful restart.",
      };
    }

    // Invalidate cached port URLs. Even if `sandbox.domain(port)` returns
    // the same URL after restart, clearing the cache forces a fresh
    // observation on the next forward (logged via getSandboxDomain) — and
    // catches the case where Vercel rotated the public tunnel URL across
    // the restart.
    let invalidatedPortUrls: Record<string, string> | null = null;
    await mutateMeta((next) => {
      if (
        next.sandboxId !== sandboxId
        || (next.lifecycleAttemptId ?? null) !== (meta.lifecycleAttemptId ?? null)
      ) return;
      if (!next.portUrls) return;
      invalidatedPortUrls = { ...next.portUrls };
      next.portUrls = null;
    });
    if (invalidatedPortUrls) {
      logInfo("sandbox.port_urls.invalidated", {
        sandboxId,
        reason: "gateway-restart",
        oldUrls: invalidatedPortUrls,
      });
    }

    // Poll for gateway readiness after restart, then verify configured channel
    // routes. The root page can respond before Slack finishes registering
    // /slack/events, so root readiness alone is not enough for OAuth setup.
    await waitForGatewayRootReady(sandbox);
    await waitForConfiguredChannelRoutesReady({
      sandbox,
      slackConfigured: Boolean(slack),
      telegramConfigured: Boolean(meta.channels.telegram),
    });

    await assertRunningGatewayMutationAllowed({
      sandboxId,
      lifecycleAttemptId: meta.lifecycleAttemptId ?? null,
      lease,
    });
    const synchronized = await mutateMeta((next) => {
      if (
        next.sandboxId !== sandboxId
        || (next.lifecycleAttemptId ?? null) !== (meta.lifecycleAttemptId ?? null)
      ) return;
      if (next.channels.telegram) {
        next.lastRestoreMetrics = {
          ...(next.lastRestoreMetrics ?? buildConfigSyncRestoreMetricsPatch()),
          recordedAt: Date.now(),
          telegramExpected: true,
          telegramConfigPresent: true,
          telegramListenerReady: true,
          telegramListenerStatus: 401,
          telegramListenerError: null,
        };
      }
    });
    await assertRunningGatewayMutationAllowed({
      sandboxId,
      lifecycleAttemptId: meta.lifecycleAttemptId ?? null,
      lease,
    });
    if (
      synchronized.sandboxId !== sandboxId
      || (synchronized.lifecycleAttemptId ?? null)
        !== (meta.lifecycleAttemptId ?? null)
    ) {
      throw new LifecycleLockOwnershipLostError();
    }

    logInfo("sandbox.config_sync_restarted", { sandboxId });
    return { outcome: "applied", reason: "config_written_and_restarted", liveConfigFresh: true, operatorMessage: null };
  } catch (error) {
    logWarn("sandbox.config_sync_failed", {
      sandboxId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      outcome: "failed",
      reason: error instanceof Error ? error.message : String(error),
      liveConfigFresh: false,
      operatorMessage: "Config sync failed. The sandbox may be serving stale configuration.",
    };
  }
}

// ---------------------------------------------------------------------------
// Dynamic config reconciliation
// ---------------------------------------------------------------------------

export type DynamicConfigReconcileResult = {
  verified: boolean;
  changed: boolean;
  reason:
    | "already-fresh"
    | "rewritten-and-restarted"
    | "rewrite-failed"
    | "restart-failed"
    | "sandbox-unavailable";
};

/**
 * Verify that the running sandbox's gateway config matches the expected hash
 * computed from current channel state.  When stale, rewrite dynamic config
 * files and restart the gateway, then re-verify.
 *
 * Idempotent — safe to call on every launch-verify or watchdog cycle.
 */
export async function ensureRunningSandboxDynamicConfigFresh(input: {
  origin: string;
  op?: OperationContext;
  expectedSandboxId?: string;
  expectedLifecycleAttemptId?: string | null;
}): Promise<DynamicConfigReconcileResult> {
  try {
    return await withLifecycleLock((lease) =>
      ensureRunningSandboxDynamicConfigFreshWithinLifecycleLock(input, lease));
  } catch (error) {
    logWarn("sandbox.config_reconcile.lifecycle_unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { verified: false, changed: false, reason: "sandbox-unavailable" };
  }
}

async function ensureRunningSandboxDynamicConfigFreshWithinLifecycleLock(
  input: {
    origin: string;
    op?: OperationContext;
    expectedSandboxId?: string;
    expectedLifecycleAttemptId?: string | null;
  },
  lease: AutoRenewedLockLease,
): Promise<DynamicConfigReconcileResult> {
  const meta = await getInitializedMeta();
  if (
    (input.expectedSandboxId !== undefined
      && meta.sandboxId !== input.expectedSandboxId)
    || (input.expectedLifecycleAttemptId !== undefined
      && (meta.lifecycleAttemptId ?? null) !== input.expectedLifecycleAttemptId)
  ) {
    return { verified: false, changed: false, reason: "sandbox-unavailable" };
  }
  if (meta.status !== "running" || !meta.sandboxId) {
    logInfo("sandbox.config_reconcile.skipped", {
      reason: "sandbox_unavailable",
      status: meta.status,
      sandboxId: meta.sandboxId,
    });
    return { verified: false, changed: false, reason: "sandbox-unavailable" };
  }

  const sandboxId = meta.sandboxId;
  const verifiedBundleIdentity = matchesConfiguredBundleIdentity(
    meta.bundleIdentity,
  )
    ? meta.bundleIdentity
    : null;

  // Compute expected hash from current channel state.
  const configHashInput: GatewayConfigHashInput = {
    telegramBotToken: meta.channels.telegram?.botToken,
    telegramWebhookSecret: meta.channels.telegram?.webhookSecret,
    slackCredentials: meta.channels.slack
      ? {
          botToken: meta.channels.slack.botToken,
          signingSecret: meta.channels.slack.signingSecret,
        }
      : undefined,
    bundleCapabilities: verifiedBundleIdentity?.capabilities,
  };
  const expectedHash = computeGatewayConfigHash(configHashInput);

  // Runtime reconcile compares against runtimeDynamicConfigHash (what is
  // actually on the running sandbox) — NOT snapshotDynamicConfigHash (what
  // was last persisted for a prepared restore target).
  const runtimeHash = meta.runtimeDynamicConfigHash ?? meta.snapshotConfigHash;

  logInfo("sandbox.config_reconcile.checkpoint_before", {
    sandboxId,
    runtimeDynamicConfigHash: runtimeHash,
    snapshotConfigHash: meta.snapshotConfigHash,
    expectedHash,
    hashVersion: GATEWAY_CONFIG_HASH_VERSION,
  });

  // Already fresh — no work needed.
  if (runtimeHash === expectedHash) {
    logInfo("sandbox.config_reconcile.already_fresh", {
      sandboxId,
      configHash: expectedHash,
    });
    return { verified: true, changed: false, reason: "already-fresh" };
  }

  // Stale — rewrite dynamic config files.
  const slack = meta.channels.slack;
  const files = buildDynamicRestoreFiles({
    proxyOrigin: input.origin,
    telegramBotToken: meta.channels.telegram?.botToken,
    telegramWebhookSecret: meta.channels.telegram?.webhookSecret,
    slackCredentials: slack
      ? { botToken: slack.botToken, signingSecret: slack.signingSecret }
      : undefined,
    bundleCapabilities: verifiedBundleIdentity?.capabilities,
  });

  let sandbox: SandboxHandle;
  try {
    sandbox = await getSandboxController().get({ sandboxId, resume: false });
    await assertRunningGatewayMutationAllowed({
      sandboxId,
      lifecycleAttemptId: meta.lifecycleAttemptId ?? null,
      lease,
    });
  } catch (error) {
    logWarn("sandbox.config_reconcile.sandbox_lookup_failed", {
      sandboxId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { verified: false, changed: false, reason: "sandbox-unavailable" };
  }

  try {
    await sandbox.writeFiles(files);
    logInfo("sandbox.config_reconcile.checkpoint_after_rewrite", {
      sandboxId,
      fileCount: files.length,
    });
  } catch (error) {
    logWarn("sandbox.config_reconcile.rewrite_failed", {
      sandboxId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { verified: false, changed: false, reason: "rewrite-failed" };
  }

  // Restart the gateway so it picks up the new config.
  try {
    await restartGateway(sandbox, "dynamic-config-reconcile", () =>
      assertRunningGatewayMutationAllowed({
        sandboxId,
        lifecycleAttemptId: meta.lifecycleAttemptId ?? null,
        lease,
      }));
    logInfo("sandbox.config_reconcile.checkpoint_after_restart", { sandboxId });
  } catch (error) {
    logWarn("sandbox.config_reconcile.restart_failed", {
      sandboxId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { verified: false, changed: true, reason: "restart-failed" };
  }

  // Update runtime truth only. Prepared persisted-state truth is stamped only
  // by prepare/manual snapshot paths, so mark restore target dirty when
  // the running sandbox diverges.
  const updated = await mutateMeta((next) => {
    if (
      next.sandboxId !== sandboxId
      || (next.lifecycleAttemptId ?? null) !== (meta.lifecycleAttemptId ?? null)
    ) return;
    next.runtimeDynamicConfigHash = expectedHash;
    if (
      next.restorePreparedStatus === "ready" ||
      next.restorePreparedStatus === "unknown"
    ) {
      next.restorePreparedStatus = "dirty";
      next.restorePreparedReason = "dynamic-config-changed";
    }

    // Move oracle to pending unless it is mid-cycle.
    if (next.restoreOracle.status !== "running") {
      next.restoreOracle.status = "pending";
    }
    next.restoreOracle.pendingReason = "dynamic-config-changed";
    next.restoreOracle.lastBlockedReason = null;
  });
  if (
    updated.sandboxId !== sandboxId
    || (updated.lifecycleAttemptId ?? null) !== (meta.lifecycleAttemptId ?? null)
    || updated.runtimeDynamicConfigHash !== expectedHash
  ) {
    throw new LifecycleLockOwnershipLostError();
  }

  logInfo("sandbox.config_reconcile.checkpoint_verified", {
    sandboxId,
    configHash: expectedHash,
  });

  return { verified: true, changed: true, reason: "rewritten-and-restarted" };
}

// ---------------------------------------------------------------------------
// Restore target truth
// ---------------------------------------------------------------------------

/**
 * Mark the next restore target as dirty.  Call this whenever the running
 * sandbox diverges from its prepared persisted state (channel config change, deploy
 * drift, manual reset).
 */
export async function markRestoreTargetDirty(input: {
  reason: RestorePreparedReason;
}): Promise<SingleMeta> {
  logInfo("sandbox.restore_target.mark_dirty", { reason: input.reason });
  return mutateMeta((next) => {
    next.restorePreparedStatus = "dirty";
    next.restorePreparedReason = input.reason;

    // Move oracle to pending unless it is mid-cycle.
    if (next.restoreOracle.status !== "running") {
      next.restoreOracle.status = "pending";
    }
    next.restoreOracle.pendingReason = input.reason;
    next.restoreOracle.lastBlockedReason = null;
  });
}

/**
 * Check whether a prepared restore image is still reusable given the
 * desired config and asset hashes.
 */
export function isPreparedRestoreReusable(input: {
  meta: Pick<
    SingleMeta,
    | "persistedStateDynamicConfigHash"
    | "persistedStateAssetSha256"
    | "snapshotDynamicConfigHash"
    | "snapshotAssetSha256"
    | "restorePreparedStatus"
  >;
  desiredDynamicConfigHash: string;
  desiredAssetSha256: string;
}): boolean {
  return (
    input.meta.restorePreparedStatus === "ready" &&
    (input.meta.persistedStateDynamicConfigHash ?? input.meta.snapshotDynamicConfigHash) === input.desiredDynamicConfigHash &&
    (input.meta.persistedStateAssetSha256 ?? input.meta.snapshotAssetSha256) === input.desiredAssetSha256
  );
}

export type PrepareRestoreAction = {
  id:
    | "ensure-running"
    | "reconcile-dynamic-config"
    | "sync-static-assets"
    | "verify-ready"
    | "snapshot"
    | "stamp-meta";
  status: "completed" | "skipped" | "failed";
  message: string;
};

export type PrepareRestoreResult = {
  ok: boolean;
  destructive: boolean;
  state: SingleMeta["restorePreparedStatus"];
  reason: SingleMeta["restorePreparedReason"];
  snapshotId: string | null;
  snapshotDynamicConfigHash: string | null;
  runtimeDynamicConfigHash: string | null;
  snapshotAssetSha256: string | null;
  runtimeAssetSha256: string | null;
  preparedAt: number | null;
  actions: PrepareRestoreAction[];
  decision: RestoreDecision;
};

function completePendingPersistentAutoSave(
  meta: SingleMeta,
  expected: {
    sandboxId: string;
    lifecycleAttemptId: string | null;
    operationId: string | null;
  },
  savedAt: number,
): boolean {
  const pending = meta.pendingPersistentAutoSave;
  if (
    meta.restorePreparedStatus !== "preparing"
    || pending?.sandboxId !== expected.sandboxId
    || pending.lifecycleAttemptId !== expected.lifecycleAttemptId
    || pending.operationId !== expected.operationId
  ) return false;

  meta.persistedStateDynamicConfigHash = pending.dynamicConfigHash;
  meta.persistedStateAssetSha256 = pending.assetSha256;
  meta.persistedStateSavedAt = savedAt;
  meta.persistedStateSource = "persistent-auto-save";
  meta.pendingPersistentAutoSave = null;
  meta.restorePreparedStatus = "ready";
  meta.restorePreparedReason = "prepared";
  meta.restorePreparedAt = savedAt;
  meta.restoreOracle.status = "ready";
  meta.restoreOracle.pendingReason = null;
  meta.restoreOracle.lastCompletedAt = savedAt;
  meta.restoreOracle.lastBlockedReason = null;
  meta.restoreOracle.lastError = null;
  meta.restoreOracle.consecutiveFailures = 0;
  meta.restoreOracle.lastResult = "prepared";
  return true;
}

function failPendingPersistentAutoSave(meta: SingleMeta): void {
  if (!meta.pendingPersistentAutoSave) return;
  meta.pendingPersistentAutoSave = null;
  meta.persistedStateDynamicConfigHash = null;
  meta.persistedStateAssetSha256 = null;
  meta.persistedStateSavedAt = null;
  meta.persistedStateSource = null;
  meta.restorePreparedStatus = "failed";
  meta.restorePreparedReason = "prepare-failed";
  meta.restorePreparedAt = null;
}

async function waitForConfirmedPersistentStop(options?: {
  deadlineAtMs?: number;
}): Promise<SingleMeta> {
  const immediate = await reconcileSnapshottingStatus();
  if (immediate.status !== "snapshotting") return immediate;

  const remainingBudgetMs = options?.deadlineAtMs === undefined
    ? PERSISTENT_STOP_CONFIRM_TIMEOUT_MS
    : Math.min(
        PERSISTENT_STOP_CONFIRM_TIMEOUT_MS,
        options.deadlineAtMs - Date.now(),
      );
  const timeoutMs = Math.max(1, remainingBudgetMs);

  return pollUntil<SingleMeta, SingleMeta>({
    label: "sandbox.persistent-stop",
    timeoutMs,
    initialDelayMs: READY_WAIT_POLL_MS,
    state: immediate,
    step: async () => {
      const current = await reconcileSnapshottingStatus();
      return current.status === "snapshotting"
        ? { done: false, state: current, delayMs: READY_WAIT_POLL_MS }
        : { done: true, result: current };
    },
    timeoutError: ({ state }) => new ApiError(
      504,
      "SANDBOX_STOP_TIMEOUT",
      `Sandbox persistent stop was not confirmed (last status: ${state?.status ?? "unknown"}).`,
    ),
  });
}

/**
 * Prepare the next restore target.  When `destructive` is true, the sandbox
 * is stopped so Sandbox v2 auto-saves state matching current config and
 * assets.  When `destructive` is false, the function reports whether the
 * current persisted state is reusable without modifying state.
 */
export async function prepareRestoreTarget(input: {
  origin: string;
  reason: string;
  destructive?: boolean;
  op?: OperationContext;
}): Promise<PrepareRestoreResult> {
  const syncDeadlineAtMs = Date.now() + PREPARE_RESTORE_SYNC_BUDGET_MS;
  const actions: PrepareRestoreAction[] = [];
  const meta = await getInitializedMeta();
  const isDestructive = input.destructive ?? false;
  const ownsPrepareTarget = (candidate: SingleMeta): boolean =>
    candidate.sandboxId === meta.sandboxId
    && (candidate.lifecycleAttemptId ?? null)
      === (meta.lifecycleAttemptId ?? null);

  logInfo("sandbox.restore_target.prepare_start", {
    destructive: isDestructive,
    reason: input.reason,
    status: meta.status,
    sandboxId: meta.sandboxId,
  });

  // Single source of truth: compute the canonical decision once.
  const decision = buildRestoreDecision({
    meta,
    source: isDestructive ? "prepare" : "inspect",
    destructive: isDestructive,
  });

  logInfo("sandbox.restore.decision", {
    source: decision.source,
    destructive: decision.destructive,
    reusable: decision.reusable,
    needsPrepare: decision.needsPrepare,
    blocking: decision.blocking,
    reasons: decision.reasons,
    requiredActions: decision.requiredActions,
    nextAction: decision.nextAction,
    status: decision.status,
    sandboxId: decision.sandboxId,
    snapshotId: decision.snapshotId,
    idleMs: decision.idleMs,
    minIdleMs: decision.minIdleMs,
    probeReady: decision.probeReady,
  });

  // Check if the existing snapshot is already prepared and fresh.
  if (decision.reusable) {
    logInfo("sandbox.restore_target.already_prepared", {
      snapshotId: meta.snapshotId,
      persistedStateDynamicConfigHash: meta.persistedStateDynamicConfigHash,
      persistedStateAssetSha256: meta.persistedStateAssetSha256,
      persistedStateSource: meta.persistedStateSource,
    });
    return {
      ok: true,
      destructive: false,
      state: meta.restorePreparedStatus,
      reason: meta.restorePreparedReason,
      snapshotId: meta.snapshotId,
      snapshotDynamicConfigHash: meta.persistedStateDynamicConfigHash ?? meta.snapshotDynamicConfigHash,
      runtimeDynamicConfigHash: meta.runtimeDynamicConfigHash,
      snapshotAssetSha256: meta.persistedStateAssetSha256 ?? meta.snapshotAssetSha256,
      runtimeAssetSha256: meta.runtimeAssetSha256,
      preparedAt: meta.restorePreparedAt,
      actions: [{ id: "stamp-meta", status: "skipped", message: "already prepared" }],
      decision,
    };
  }

  // Non-destructive: report status without mutating.
  if (!input.destructive) {
    logInfo("sandbox.restore_target.non_destructive_check", {
      currentState: meta.restorePreparedStatus,
      reasons: decision.reasons,
      requiredActions: decision.requiredActions,
    });
    return {
      ok: false,
      destructive: false,
      state: meta.restorePreparedStatus === "ready" ? "dirty" : meta.restorePreparedStatus,
      reason: meta.restorePreparedReason,
      snapshotId: meta.snapshotId,
      snapshotDynamicConfigHash: meta.persistedStateDynamicConfigHash ?? meta.snapshotDynamicConfigHash,
      runtimeDynamicConfigHash: meta.runtimeDynamicConfigHash,
      snapshotAssetSha256: meta.persistedStateAssetSha256 ?? meta.snapshotAssetSha256,
      runtimeAssetSha256: meta.runtimeAssetSha256,
      preparedAt: meta.restorePreparedAt,
      actions: [{ id: "snapshot", status: "failed", message: "destructive snapshot required but not allowed" }],
      decision,
    };
  }

  // Destructive: ensure running, reconcile, snapshot, stamp.
  const preparingMeta = await mutateMeta((next) => {
    if (!ownsPrepareTarget(next)) return;
    next.restorePreparedStatus = "preparing";
    next.restorePreparedReason = null;
    next.persistedStateDynamicConfigHash = null;
    next.persistedStateAssetSha256 = null;
    next.persistedStateSavedAt = null;
    next.persistedStateSource = null;
    next.pendingPersistentAutoSave = null;
    next.restorePreparedAt = null;
  });
  if (!ownsPrepareTarget(preparingMeta)) {
    throw new LifecycleLockOwnershipLostError();
  }

  // Step 1: Ensure the sandbox is running.
  if (meta.status !== "running" || !meta.sandboxId) {
    actions.push({ id: "ensure-running", status: "failed", message: `sandbox status: ${meta.status}` });
    await mutateMeta((next) => {
      if (!ownsPrepareTarget(next)) return;
      next.restorePreparedStatus = "failed";
      next.restorePreparedReason = "prepare-failed";
    });
    const failMeta = await getInitializedMeta();
    return {
      ok: false,
      destructive: true,
      state: failMeta.restorePreparedStatus,
      reason: failMeta.restorePreparedReason,
      snapshotId: failMeta.snapshotId,
      snapshotDynamicConfigHash: failMeta.snapshotDynamicConfigHash,
      runtimeDynamicConfigHash: failMeta.runtimeDynamicConfigHash,
      snapshotAssetSha256: failMeta.snapshotAssetSha256,
      runtimeAssetSha256: failMeta.runtimeAssetSha256,
      preparedAt: failMeta.restorePreparedAt,
      actions,
      decision: buildRestoreDecision({ meta: failMeta, source: "prepare", destructive: true }),
    };
  }
  actions.push({ id: "ensure-running", status: "completed", message: "sandbox running" });

  // Step 2: Reconcile dynamic config on the live sandbox.
  const reconcileResult = await ensureRunningSandboxDynamicConfigFresh({
    origin: input.origin,
    op: input.op,
    expectedSandboxId: meta.sandboxId,
    expectedLifecycleAttemptId: meta.lifecycleAttemptId ?? null,
  });
  actions.push({
    id: "reconcile-dynamic-config",
    status: reconcileResult.verified ? "completed" : "failed",
    message: reconcileResult.reason,
  });
  if (!reconcileResult.verified) {
    await mutateMeta((next) => {
      if (!ownsPrepareTarget(next)) return;
      next.restorePreparedStatus = "failed";
      next.restorePreparedReason = "prepare-failed";
    });
    const failMeta = await getInitializedMeta();
    return {
      ok: false,
      destructive: true,
      state: failMeta.restorePreparedStatus,
      reason: failMeta.restorePreparedReason,
      snapshotId: failMeta.snapshotId,
      snapshotDynamicConfigHash: failMeta.snapshotDynamicConfigHash,
      runtimeDynamicConfigHash: failMeta.runtimeDynamicConfigHash,
      snapshotAssetSha256: failMeta.snapshotAssetSha256,
      runtimeAssetSha256: failMeta.runtimeAssetSha256,
      preparedAt: failMeta.restorePreparedAt,
      actions,
      decision: buildRestoreDecision({ meta: failMeta, source: "prepare", destructive: true }),
    };
  }

  // Step 3: Sync static assets from the same metadata generation that will be
  // hashed and attested below.
  const assetMeta = await getInitializedMeta();
  if (!ownsPrepareTarget(assetMeta)) {
    throw new LifecycleLockOwnershipLostError();
  }
  try {
    const sandbox = await getSandboxController().get({ sandboxId: assetMeta.sandboxId! });
    const slack = assetMeta.channels.slack;
    await syncRestoreAssetsIfNeeded(sandbox, {
      origin: input.origin,
      telegramBotToken: assetMeta.channels.telegram?.botToken,
      telegramWebhookSecret: assetMeta.channels.telegram?.webhookSecret,
      slackCredentials: slack
        ? { botToken: slack.botToken, signingSecret: slack.signingSecret }
        : undefined,
      bundleCapabilities: matchesConfiguredBundleIdentity(
        assetMeta.bundleIdentity,
      )
        ? assetMeta.bundleIdentity.capabilities
        : undefined,
    });
    actions.push({ id: "sync-static-assets", status: "completed", message: "runtime assets fresh" });
  } catch (err) {
    actions.push({
      id: "sync-static-assets",
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    });
    await mutateMeta((next) => {
      if (!ownsPrepareTarget(next)) return;
      next.restorePreparedStatus = "failed";
      next.restorePreparedReason = "prepare-failed";
    });
    const failMeta = await getInitializedMeta();
    return {
      ok: false,
      destructive: true,
      state: failMeta.restorePreparedStatus,
      reason: failMeta.restorePreparedReason,
      snapshotId: failMeta.snapshotId,
      snapshotDynamicConfigHash: failMeta.snapshotDynamicConfigHash,
      runtimeDynamicConfigHash: failMeta.runtimeDynamicConfigHash,
      snapshotAssetSha256: failMeta.snapshotAssetSha256,
      runtimeAssetSha256: failMeta.runtimeAssetSha256,
      preparedAt: failMeta.restorePreparedAt,
      actions,
      decision: buildRestoreDecision({ meta: failMeta, source: "prepare", destructive: true }),
    };
  }

  // Step 4: Verify gateway readiness before snapshotting.
  const readiness = await probeGatewayReady();
  actions.push({
    id: "verify-ready",
    status: readiness.ready ? "completed" : "failed",
    message:
      readiness.ready
        ? "gateway ready"
        : readiness.error ??
          `gateway not ready${readiness.statusCode ? ` (status ${readiness.statusCode})` : ""}`,
  });
  if (!readiness.ready) {
    await mutateMeta((next) => {
      if (!ownsPrepareTarget(next)) return;
      next.restorePreparedStatus = "failed";
      next.restorePreparedReason = "prepare-failed";
    });
    const failMeta = await getInitializedMeta();
    return {
      ok: false,
      destructive: true,
      state: failMeta.restorePreparedStatus,
      reason: failMeta.restorePreparedReason,
      snapshotId: failMeta.snapshotId,
      snapshotDynamicConfigHash: failMeta.snapshotDynamicConfigHash,
      runtimeDynamicConfigHash: failMeta.runtimeDynamicConfigHash,
      snapshotAssetSha256: failMeta.snapshotAssetSha256,
      runtimeAssetSha256: failMeta.runtimeAssetSha256,
      preparedAt: failMeta.restorePreparedAt,
      actions,
      decision: buildRestoreDecision({ meta: failMeta, source: "prepare", destructive: true }),
    };
  }

  const synchronizedMeta = await getInitializedMeta();
  if (!ownsPrepareTarget(synchronizedMeta)) {
    throw new LifecycleLockOwnershipLostError();
  }
  // Step 5: Stop and let Vercel Sandbox v2 persist the named sandbox state.
  try {
    const pendingDynamicConfigHash = computeMetaGatewayConfigHash(synchronizedMeta);
    if (synchronizedMeta.runtimeDynamicConfigHash !== pendingDynamicConfigHash) {
      throw new ApiError(
        409,
        "SANDBOX_PREPARE_CONFIG_CHANGED",
        "Sandbox config changed during restore preparation; retry after runtime sync.",
      );
    }
    const pendingAssetSha256 = buildRestoreAssetManifest().sha256;
    await stopSandboxWithOptions({
      deadlineAtMs: syncDeadlineAtMs,
      pendingAutoSave: {
        sandboxId: synchronizedMeta.sandboxId!,
        lifecycleAttemptId: synchronizedMeta.lifecycleAttemptId ?? null,
        dynamicConfigHash: pendingDynamicConfigHash,
        assetSha256: pendingAssetSha256,
      },
    });
    const stopped = await waitForConfirmedPersistentStop({
      deadlineAtMs: syncDeadlineAtMs,
    });
    if (stopped.status !== "stopped") {
      throw new Error(
        `Persistent auto-save did not complete successfully (status: ${stopped.status}).`,
      );
    }
    if (
      stopped.restorePreparedStatus !== "ready"
      || stopped.pendingPersistentAutoSave !== null
    ) {
      throw new Error("Persistent auto-save completed without an exact preparation attestation.");
    }
    actions.push({
      id: "snapshot",
      status: "completed",
      message: "persistent auto-save confirmed by Sandbox SDK",
    });
    actions.push({
      id: "stamp-meta",
      status: "completed",
      message: "persistent auto-save truth recorded",
    });
  } catch (err) {
    actions.push({
      id: "snapshot",
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    });
    const stopStillReconciling = err instanceof ApiError
      && err.code === "SANDBOX_STOP_TIMEOUT"
      && (await getInitializedMeta()).status === "snapshotting";
    if (!stopStillReconciling) {
      await mutateMeta((next) => {
        if (!ownsPrepareTarget(next)) return;
        next.persistedStateDynamicConfigHash = null;
        next.persistedStateAssetSha256 = null;
        next.persistedStateSavedAt = null;
        next.persistedStateSource = null;
        next.pendingPersistentAutoSave = null;
        next.restorePreparedStatus = "failed";
        next.restorePreparedReason = "prepare-failed";
        next.restorePreparedAt = null;
      });
    }
    const failMeta = await getInitializedMeta();
    return {
      ok: false,
      destructive: true,
      state: failMeta.restorePreparedStatus,
      reason: failMeta.restorePreparedReason,
      snapshotId: failMeta.snapshotId,
      snapshotDynamicConfigHash: failMeta.snapshotDynamicConfigHash,
      runtimeDynamicConfigHash: failMeta.runtimeDynamicConfigHash,
      snapshotAssetSha256: failMeta.snapshotAssetSha256,
      runtimeAssetSha256: failMeta.runtimeAssetSha256,
      preparedAt: failMeta.restorePreparedAt,
      actions,
      decision: buildRestoreDecision({ meta: failMeta, source: "prepare", destructive: true }),
    };
  }

  const finalMeta = await getInitializedMeta();
  const finalDecision = buildRestoreDecision({ meta: finalMeta, source: "prepare", destructive: true });

  logInfo("sandbox.restore_target.prepare_complete", {
    snapshotId: finalMeta.snapshotId,
    persistedStateDynamicConfigHash: finalMeta.persistedStateDynamicConfigHash,
    persistedStateAssetSha256: finalMeta.persistedStateAssetSha256,
    persistedStateSource: finalMeta.persistedStateSource,
    restorePreparedStatus: finalMeta.restorePreparedStatus,
  });

  logInfo("sandbox.restore.decision", {
    source: finalDecision.source,
    destructive: finalDecision.destructive,
    reusable: finalDecision.reusable,
    needsPrepare: finalDecision.needsPrepare,
    blocking: finalDecision.blocking,
    reasons: finalDecision.reasons,
    requiredActions: finalDecision.requiredActions,
    nextAction: finalDecision.nextAction,
    status: finalDecision.status,
    sandboxId: finalDecision.sandboxId,
    snapshotId: finalDecision.snapshotId,
    idleMs: finalDecision.idleMs,
    minIdleMs: finalDecision.minIdleMs,
    probeReady: finalDecision.probeReady,
  });

  return {
    ok: true,
    destructive: true,
    state: finalMeta.restorePreparedStatus,
    reason: finalMeta.restorePreparedReason,
    snapshotId: finalMeta.snapshotId,
    snapshotDynamicConfigHash: finalMeta.persistedStateDynamicConfigHash ?? finalMeta.snapshotDynamicConfigHash,
    runtimeDynamicConfigHash: finalMeta.runtimeDynamicConfigHash,
    snapshotAssetSha256: finalMeta.persistedStateAssetSha256 ?? finalMeta.snapshotAssetSha256,
    runtimeAssetSha256: finalMeta.runtimeAssetSha256,
    preparedAt: finalMeta.restorePreparedAt,
    actions,
    decision: finalDecision,
  };
}

// ---------------------------------------------------------------------------
// Hot-spare lifecycle helper
// ---------------------------------------------------------------------------

export type PrepareHotSpareResult = {
  ok: boolean;
  reason: "created" | "skipped" | "failed" | "snapshot-missing";
  candidateSandboxId: string | null;
};

/**
 * Prepare a hot-spare sandbox from the latest prepared restore target.  Intended to be called by the watchdog after a successful oracle
 * prepare so the spare is ready before the next Telegram wake arrives.
 */
export async function prepareHotSpareFromPreparedRestore(options?: {
  op?: OperationContext;
}): Promise<PrepareHotSpareResult> {
  void options; // reserved for future observability threading

  if (process.env.OPENCLAW_BUNDLE_URL?.trim()) {
    logWarn("sandbox.hot_spare.prepare.skipped", {
      reason: "bundle-persistent-name-not-preserved",
    });
    return { ok: false, reason: "skipped", candidateSandboxId: null };
  }

  const meta = await getInitializedMeta();

  if (!meta.snapshotId) {
    logInfo("sandbox.hot_spare.prepare.skipped", {
      reason: "snapshot-missing",
    });
    return { ok: false, reason: "snapshot-missing", candidateSandboxId: null };
  }

  const hotSpareApiKey = await getAiGatewayBearerTokenOptional();
  const restoreEnv = buildRestoreRuntimeEnv({
    gatewayToken: meta.gatewayToken,
    apiKey: hotSpareApiKey,
  });

  const result = await preCreateHotSpareFromSnapshot(meta, {
    create: (createOptions) => getSandboxController().create(createOptions),
    getSandboxVcpus,
    getSandboxSleepAfterMs: getSandboxPlatformTimeoutMs,
    sandboxPorts: SANDBOX_PORTS,
    restoreEnv,
    networkPolicy: toNetworkPolicy(
      meta.firewall.mode,
      meta.firewall.allowlist,
      hotSpareApiKey ?? undefined,
      requiredControlPlaneDomains(meta),
    ),
  });

  await mutateMeta((next) => {
    applyPreCreateToMeta(next, result);
  });

  logInfo("sandbox.hot_spare.prepare.result", {
    status: result.status,
    candidateSandboxId: result.candidateSandboxId,
    snapshotId: meta.snapshotId,
  });

  return {
    ok: result.status !== "failed",
    reason: result.status === "created"
      ? "created"
      : result.status === "skipped"
        ? "skipped"
        : "failed",
    candidateSandboxId: result.candidateSandboxId,
  };
}

export async function touchRunningSandbox(): Promise<SingleMeta> {
  try {
    return await withSandboxLifecycleMutationLock((assertOwned) =>
      touchRunningSandboxWithinLifecycleLock(assertOwned));
  } catch (error) {
    if (error instanceof SandboxLifecycleLockContendedError) {
      return getInitializedMeta();
    }
    throw error;
  }
}

async function touchRunningSandboxWithinLifecycleLock(
  assertOwned: () => Promise<void>,
): Promise<SingleMeta> {
  const meta = await getInitializedMeta();
  if (!meta.sandboxId || meta.status !== "running") {
    return meta;
  }
  const hostSuspension = await readHostSuspensionState();
  if (hostSuspension?.ingressFenced) {
    logInfo("sandbox.timeout_top_up_skipped", {
      sandboxId: meta.sandboxId,
      reason: "host-suspension-fenced",
      phase: hostSuspension.phase,
    });
    return meta;
  }
  const sandboxId = meta.sandboxId;
  const lifecycleAttemptId = meta.lifecycleAttemptId ?? null;
  const readOwnedRunningMeta = async (): Promise<SingleMeta | null> => {
    const [latest, suspension] = await Promise.all([
      getInitializedMeta(),
      readHostSuspensionState(),
    ]);
    return latest.status === "running"
      && latest.sandboxId === sandboxId
      && (latest.lifecycleAttemptId ?? null) === lifecycleAttemptId
      && !suspension?.ingressFenced
      ? latest
      : null;
  };
  const markCapturedUnavailable = async (reason: string): Promise<SingleMeta> => {
    if (!await readOwnedRunningMeta()) return getInitializedMeta();
    return markSandboxUnavailable(reason, sandboxId, lifecycleAttemptId);
  };

  const now = Date.now();
  const throttleMs = getSandboxTouchThrottleMs();
  if (meta.lastAccessedAt && now - meta.lastAccessedAt < throttleMs) {
    return meta;
  }

  let sandbox: SandboxHandle;
  try {
    await assertOwned();
    sandbox = await getSandboxController().get({ sandboxId, resume: false });
    await assertOwned();
  } catch (error) {
    if (error instanceof LifecycleLockOwnershipLostError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return markCapturedUnavailable(`sandbox lookup failed: ${message}`);
  }
  if (!await readOwnedRunningMeta()) return getInitializedMeta();

  // If the SDK says the sandbox is no longer running (e.g. platform timeout),
  // reconcile metadata immediately instead of attempting timeout extension.
  if (sandbox.status !== "running") {
    logInfo("sandbox.heartbeat_stale_detected", {
      sandboxId,
      sdkStatus: sandbox.status,
      metaStatus: meta.status,
    });
    return markCapturedUnavailable(
      `heartbeat detected sandbox status: ${sandbox.status}`,
    );
  }

  const targetSleepAfterMs = getSandboxPlatformTimeoutMs();

  try {
    if (!await readOwnedRunningMeta()) return getInitializedMeta();
    const remainingMs = sandbox.timeoutRemaining;
    const extendByMs = getSandboxTimeoutExtensionMs({
      currentTotalMs: sandbox.timeout,
      currentRemainingMs: remainingMs,
      targetRemainingMs: targetSleepAfterMs,
    });

    if (extendByMs > 0) {
      await assertOwned();
      await sandbox.extendTimeout(extendByMs);
      await assertOwned();
      if (!await readOwnedRunningMeta()) return getInitializedMeta();
      logInfo("sandbox.timeout_topped_up", {
        sandboxId: meta.sandboxId,
        remainingMs,
        extendByMs,
        targetSleepAfterMs,
      });
    } else {
      logInfo("sandbox.timeout_top_up_skipped", {
        sandboxId: meta.sandboxId,
        remainingMs,
        targetSleepAfterMs,
        reason: "already-at-or-above-target",
      });
    }
  } catch (error) {
    if (error instanceof LifecycleLockOwnershipLostError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("sandbox_timeout_invalid")) {
      // Timeout already at max — sandbox is fine, ignore.
    } else {
      logWarn("sandbox.extend_timeout_failed", {
        sandboxId,
        error: message,
      });
      return markCapturedUnavailable(
        `extend timeout failed: ${message}`,
      );
    }
  }

  // Internal gateway liveness check — runs curl inside the sandbox to detect
  // a dead gateway process without hitting the external URL (which could wake
  // a sleeping sandbox).  Only safe because we confirmed sandbox.status ===
  // "running" above.  Skipped in test mode (FakeSandboxHandle doesn't have
  // curl and would produce false negatives).
  if (process.env.NODE_ENV !== "test") {
    try {
      const liveness = await sandbox.runCommand("sh", [
      "-c",
        "curl -sf -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:3000/",
    ]);
      const stdout = await liveness.output("stdout");
      const httpCode = parseInt(stdout.trim(), 10);
      if (liveness.exitCode !== 0 || !httpCode || httpCode === 0) {
        logWarn("sandbox.heartbeat_gateway_dead", {
          sandboxId,
          exitCode: liveness.exitCode,
          httpCode,
        });
        return markCapturedUnavailable(
          `heartbeat gateway liveness failed (exit ${liveness.exitCode}, http ${httpCode})`,
        );
      }
    } catch (error) {
      // Don't mark unavailable on runCommand errors — could be transient
      logWarn("sandbox.heartbeat_liveness_error", {
        sandboxId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const current = await readOwnedRunningMeta();
  if (!current) return getInitializedMeta();
  await armSandboxDeadline(current, undefined, {
    activityAtMs: Date.now(),
    nativeTimeoutRemainingMs: sandbox.timeoutRemaining,
  });
  // The deadline stop may have won while this request waited for admission.
  // Return current lifecycle truth so callers never proxy stale running meta.
  return getInitializedMeta();
}

export async function ensureSandboxAliveThrough(deadlineMs: number): Promise<SingleMeta> {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= Date.now()) {
    throw new Error("sandbox alive-through deadline must be a future timestamp");
  }
  const meta = await getInitializedMeta();
  if (!meta.sandboxId || meta.status !== "running") {
    throw new Error("sandbox is not running for alive-through extension");
  }
  const sandboxId = meta.sandboxId;
  // Read-only lookup: ensureSandboxReady owns intentional session resume.
  const sandbox = await getSandboxController().get({ sandboxId, resume: false });
  if (sandbox.status !== "running") {
    throw new Error(`sandbox is ${sandbox.status} during alive-through extension`);
  }

  const requiredRemainingMs = deadlineMs - Date.now();
  const remainingMs = sandbox.timeoutRemaining;
  const requiredNativeRemainingMs =
    requiredRemainingMs + SANDBOX_TIMEOUT_SAFETY_RUNWAY_MS + 2_000;
  const extendByMs = getSandboxTimeoutExtensionMs({
    currentTotalMs: sandbox.timeout,
    currentRemainingMs: remainingMs,
    targetRemainingMs: requiredNativeRemainingMs,
  });
  if (extendByMs > 0) {
    await sandbox.extendTimeout(extendByMs);
  }
  const requiredVerifiedRemainingMs =
    Math.max(0, deadlineMs - Date.now()) + SANDBOX_TIMEOUT_SAFETY_RUNWAY_MS;
  const verifiedRemainingMs = sandbox.timeoutRemaining;
  if (verifiedRemainingMs + 1_000 < requiredVerifiedRemainingMs) {
    throw new Error("sandbox timeout extension did not reach cron deadline");
  }

  const latest = await getInitializedMeta();
  if (
    latest.sandboxId !== sandboxId
    || latest.status !== "running"
    || (latest.lifecycleAttemptId ?? null) !== (meta.lifecycleAttemptId ?? null)
  ) {
    throw new Error("sandbox changed during alive-through extension");
  }
  const deadline = await armSandboxDeadline(latest, undefined, {
    activityAtMs: Date.now(),
    nativeTimeoutRemainingMs: verifiedRemainingMs,
  });
  if (
    !deadline
    || deadline.sandboxId !== sandboxId
    || deadline.lifecycleAttemptId !== (meta.lifecycleAttemptId ?? null)
    || deadline.deadlineAtMs < deadlineMs
  ) {
    throw new Error("sandbox deadline coordinator cannot keep cron work alive through deadline");
  }
  const committed = await getInitializedMeta();
  if (
    committed.status !== "running"
    || committed.sandboxId !== sandboxId
    || (committed.lifecycleAttemptId ?? null) !== (meta.lifecycleAttemptId ?? null)
  ) {
    throw new Error("sandbox changed before alive-through commit");
  }
  logInfo("sandbox.timeout_extended_for_cron", {
    sandboxId,
    deadlineMs,
    remainingMs,
    extendByMs,
    requiredVerifiedRemainingMs,
    verifiedRemainingMs,
  });
  return committed;
}

export async function getRunningSandboxTimeoutRemainingMs(): Promise<number | null> {
  const meta = await getInitializedMeta();
  if (!meta.sandboxId || meta.status !== "running") {
    return null;
  }
  const coordinatedRemainingMs = await readSandboxDeadlineRemainingMs(meta);
  if (coordinatedRemainingMs !== null) return coordinatedRemainingMs;
  try {
    const sandbox = await getSandboxController().get({
      sandboxId: meta.sandboxId,
      resume: false,
    });
    return sandbox.timeoutRemaining;
  } catch {
    return estimateSandboxTimeoutRemainingMs(
      meta.lastAccessedAt,
      getSandboxSleepAfterMs(),
    );
  }
}

/**
 * Debounce + in-flight coalesce for reconcileStaleRunningStatus. When a
 * burst of fast-path fetches fails simultaneously (sandbox just went
 * stopped, 5 webhooks arrive in the same second), every webhook falls
 * through to reconcile. Without coalescing, each takes the lifecycle
 * lock serially and does the same @vercel/sandbox `get()` + mutateMeta
 * dance — linear latency pile-up for duplicate work.
 *
 * This state is module-scoped, not Redis-backed. That gives per-Vercel-
 * function-instance coalescing, which is sufficient for bursty webhook
 * storms hitting the same instance. Multi-instance deployments each
 * get independent debounces — the cost of an extra reconcile per
 * instance during a storm is negligible compared to the cost of
 * coordinating via Redis.
 */
const RECONCILE_STALE_RUNNING_DEBOUNCE_MS = 5_000;
const reconcileStaleRunningInFlight = new Map<string, Promise<SingleMeta>>();
let lastReconcileStaleRunningResult:
  | { generationKey: string; reconciledAtMs: number; meta: SingleMeta }
  | null = null;

function sandboxGenerationKey(
  meta: Pick<SingleMeta, "sandboxId" | "lifecycleAttemptId">,
): string {
  return `${meta.sandboxId ?? "none"}:${meta.lifecycleAttemptId ?? "none"}`;
}

/**
 * Test-only helper to clear the debounce state between tests. The
 * module-scoped cache would otherwise leak across test cases.
 */
export function _resetReconcileStaleRunningDebounceForTesting(): void {
  reconcileStaleRunningInFlight.clear();
  lastReconcileStaleRunningResult = null;
}

async function runReconcileStaleRunningStatus(meta: SingleMeta): Promise<SingleMeta> {
  if (!meta.sandboxId || meta.status !== "running") {
    return meta;
  }
  const sandboxId = meta.sandboxId;
  const lifecycleAttemptId = meta.lifecycleAttemptId ?? null;
  const matchingFenceExists = async (): Promise<boolean> => {
    try {
      const suspension = await readHostSuspensionState();
      return Boolean(
        suspension?.ingressFenced
        && suspension.sandboxId === sandboxId
        && suspension.lifecycleAttemptId === lifecycleAttemptId
      );
    } catch (error) {
      if (!(error instanceof HostSuspensionStateCorruptError)) throw error;
      return true;
    }
  };
  if (await matchingFenceExists()) {
      logInfo("sandbox.stale_running_reconcile_deferred", {
        sandboxId,
        metaStatus: meta.status,
      });
      return getInitializedMeta();
  }
  const mutateIfCurrent = (mutator: (next: SingleMeta) => void) =>
    mutateMeta((next) => {
      if (
        next.status !== "running"
        || next.sandboxId !== sandboxId
        || (next.lifecycleAttemptId ?? null) !== lifecycleAttemptId
      ) return;
      mutator(next);
    });

  try {
    const sandbox = await getSandboxController().get({
      sandboxId,
      resume: false,
    });
    const sdkStatus = sandbox.status;
    if (sdkStatus === "running") {
      return getInitializedMeta();
    }
    if (
      sdkStatus !== "stopped"
      && sdkStatus !== "failed"
      && sdkStatus !== "aborted"
    ) {
      logInfo("sandbox.stale_running_reconcile_deferred", {
        sandboxId,
        sdkStatus,
        metaStatus: meta.status,
      });
      return getInitializedMeta();
    }
    if (await matchingFenceExists()) return getInitializedMeta();
    logInfo("sandbox.stale_running_reconciled", {
      sandboxId: meta.sandboxId,
      sdkStatus,
      metaStatus: meta.status,
    });
    return mutateIfCurrent((next) => {
      const terminalFailure = sdkStatus === "failed" || sdkStatus === "aborted";
      next.status = terminalFailure ? "error" : "stopped";
      next.lastError = terminalFailure ? `sandbox ${sdkStatus}` : null;
      next.lastGatewayProbeReady = false;
    });
  } catch (error) {
    if (!isSandboxGoneError(error)) {
      logWarn("sandbox.stale_running_reconcile_lookup_failed", {
        sandboxId,
        error: error instanceof Error ? error.message : String(error),
      });
      return getInitializedMeta();
    }
    if (await matchingFenceExists()) return getInitializedMeta();
    logInfo("sandbox.stale_running_reconciled", {
      sandboxId: meta.sandboxId,
      sdkStatus: "not-found",
      metaStatus: meta.status,
    });
    return mutateIfCurrent((next) => {
      next.sandboxId = null;
      next.portUrls = null;
      next.pendingPersistentAutoSave = null;
      next.activePersistentStop = null;
      next.status = "uninitialized";
      next.lastError = null;
      next.lastGatewayProbeReady = false;
    });
  }
}

/**
 * Check if a sandbox that metadata says is "running" has actually stopped
 * (e.g. platform timeout). If the SDK confirms it's stopped/failed, update
 * metadata to "stopped" so the UI shows the truth instead of a stale status.
 *
 * Returns the reconciled metadata. Concurrent calls within the debounce
 * window share one underlying reconcile; subsequent calls within 5s
 * reuse the cached result.
 */
export async function reconcileStaleRunningStatus(): Promise<SingleMeta> {
  const current = await getInitializedMeta();
  if (!current.sandboxId || current.status !== "running") return current;
  const generationKey = sandboxGenerationKey(current);
  const now = Date.now();
  if (
    lastReconcileStaleRunningResult &&
    lastReconcileStaleRunningResult.generationKey === generationKey
    &&
    now - lastReconcileStaleRunningResult.reconciledAtMs <=
      RECONCILE_STALE_RUNNING_DEBOUNCE_MS
  ) {
    logInfo("sandbox.reconcile_stale_running_status_debounced", {
      ageMs: now - lastReconcileStaleRunningResult.reconciledAtMs,
      status: lastReconcileStaleRunningResult.meta.status,
      sandboxId: lastReconcileStaleRunningResult.meta.sandboxId,
    });
    return structuredClone(lastReconcileStaleRunningResult.meta);
  }

  const inFlight = reconcileStaleRunningInFlight.get(generationKey);
  if (inFlight) {
    logInfo("sandbox.reconcile_stale_running_status_joined_in_flight", {});
    return structuredClone(await inFlight);
  }

  const promise = (async () => {
    try {
      return await withLifecycleLock(async (lease) => {
        await lease.assertOwned();
        return runReconcileStaleRunningStatus(current);
      });
    } catch (error) {
      if (!(error instanceof LifecycleLockUnavailableError)) throw error;
      logInfo("sandbox.stale_running_reconcile_deferred", {
        sandboxId: current.sandboxId,
        reason: "lifecycle-lock-contended",
      });
      return getInitializedMeta();
    }
  })()
    .then((meta) => {
      lastReconcileStaleRunningResult = {
        generationKey,
        reconciledAtMs: Date.now(),
        meta: structuredClone(meta),
      };
      return meta;
    })
    .finally(() => {
      reconcileStaleRunningInFlight.delete(generationKey);
    });
  reconcileStaleRunningInFlight.set(generationKey, promise);

  return structuredClone(await promise);
}

/**
 * Reconcile meta while a non-blocking stop is finishing persistent auto-save.
 *
 * After `stopSandbox()` calls `sandbox.stop({ blocking: false })` the app
 * parks meta at `status = "snapshotting"`.  The SDK continues saving persistent state in the background; this helper polls `sandbox.status` and
 * transitions meta to `"stopped"` (happy path), `"error"` (snapshot failed),
 * or leaves it untouched if the snapshot is still in flight.
 *
 * The SDK status is authoritative. A stale transitional state remains fenced;
 * it is never projected as stopped while the platform still reports running,
 * stopping, pending, or snapshotting.
 */
export async function reconcileSnapshottingStatus(): Promise<SingleMeta> {
  const meta = await getInitializedMeta();
  let hostSuspension: HostSuspensionState | null;
  try {
    hostSuspension = await readHostSuspensionState();
  } catch (error) {
    if (!(error instanceof HostSuspensionStateCorruptError)) throw error;
    // Status and explicit reset are the recovery surfaces for a corrupt
    // record. Preserve lifecycle metadata so callers can expose the synthetic
    // fail-closed fence instead of losing diagnostics to a 500 response.
    return meta;
  }
  if (
    meta.status === "error"
    && meta.lastError === FIREWALL_FAIL_CLOSED_LAST_ERROR
    && meta.sandboxId
    && (
      !hostSuspension
      || hostSuspension.sandboxId !== meta.sandboxId
      || hostSuspension.lifecycleAttemptId !== (meta.lifecycleAttemptId ?? null)
      || hostSuspension.reason !== FIREWALL_FAIL_CLOSED_REASON
    )
  ) {
    const sandboxId = meta.sandboxId;
    const lifecycleAttemptId = meta.lifecycleAttemptId ?? null;
    return withLifecycleLock(async (lease) => {
      await lease.assertOwned();
      const current = await getInitializedMeta();
      if (
        current.status !== "error"
        || current.lastError !== FIREWALL_FAIL_CLOSED_LAST_ERROR
        || current.sandboxId !== sandboxId
        || (current.lifecycleAttemptId ?? null) !== lifecycleAttemptId
      ) return current;
      const latest = await readHostSuspensionState();
      if (latest?.ingressFenced) return current;
      await enqueueHostStopOperation({
        sandboxId,
        lifecycleAttemptId,
        reason: FIREWALL_FAIL_CLOSED_REASON,
        assertOwned: () => lease.assertOwned(),
      });
      return current;
    });
  }
  if (
    meta.sandboxId
    && hostSuspension?.ingressFenced
    && hostSuspension.sandboxId === meta.sandboxId
    && hostSuspension.lifecycleAttemptId === (meta.lifecycleAttemptId ?? null)
    && hostSuspension.reason === FIREWALL_FAIL_CLOSED_REASON
    && ["stop-requesting", "stopping"].includes(hostSuspension.phase)
  ) {
    const firewallSandboxId = meta.sandboxId;
    const firewallLifecycleAttemptId = meta.lifecycleAttemptId ?? null;
    return withLifecycleLock(async (lease) => {
      await lease.assertOwned();
      const current = await getInitializedMeta();
      const currentHostSuspension = await readHostSuspensionState();
      if (
        current.sandboxId !== firewallSandboxId
        || (current.lifecycleAttemptId ?? null)
          !== firewallLifecycleAttemptId
        || currentHostSuspension?.operationId !== hostSuspension.operationId
        || currentHostSuspension.reason !== FIREWALL_FAIL_CLOSED_REASON
        || !currentHostSuspension.ingressFenced
      ) return current;
      let sandbox: SandboxHandle;
      try {
        sandbox = await getSandboxController().get({
          sandboxId: firewallSandboxId,
          resume: false,
        });
      } catch (error) {
        if (!isSandboxGoneError(error)) throw error;
        const gone = await mutateMeta((next) => {
          if (
            next.sandboxId !== firewallSandboxId
            || (next.lifecycleAttemptId ?? null)
              !== firewallLifecycleAttemptId
          ) return;
          next.status = "stopped";
          next.portUrls = null;
          next.lastGatewayProbeReady = false;
        });
        await markHostSuspensionStopped(currentHostSuspension);
        return gone;
      }
      await lease.assertOwned();
      try {
        await sandbox.updateNetworkPolicy("deny-all");
      } catch {
        // Confirmed termination below is the authoritative fail-closed edge.
      }
      await sandbox.stop({ blocking: true });
      await lease.assertOwned();
      const stopped = await mutateMeta((next) => {
        if (
          next.sandboxId !== firewallSandboxId
          || (next.lifecycleAttemptId ?? null)
            !== firewallLifecycleAttemptId
        ) return;
        next.status = "stopped";
        next.portUrls = null;
        next.lastGatewayProbeReady = false;
      });
      await markHostSuspensionStopped(currentHostSuspension);
      return stopped;
    });
  }
  if (meta.status !== "snapshotting" || !meta.sandboxId) {
    if (
      meta.status !== "running"
      || !meta.sandboxId
      || !hostSuspension?.ingressFenced
      || hostSuspension.sandboxId !== meta.sandboxId
      || hostSuspension.lifecycleAttemptId !== (meta.lifecycleAttemptId ?? null)
    ) {
      return meta;
    }
    const sandboxId = meta.sandboxId;
    const runningLifecycleAttemptId = meta.lifecycleAttemptId ?? null;
    if (hostSuspension.phase === "rollback-pending") {
      let sandbox: SandboxHandle;
      try {
        sandbox = await getSandboxController().get({ sandboxId, resume: false });
      } catch (error) {
        if (!isSandboxGoneError(error)) return meta;
        return markSandboxUnavailable(
          "Sandbox disappeared while Gateway suspension rollback was pending.",
          sandboxId,
          runningLifecycleAttemptId,
        );
      }
      if (sandbox.status !== "running") return meta;
      const thawed = await thawHostSuspensionIfNeeded({
        sandbox,
        lifecycleAttemptId: runningLifecycleAttemptId,
      });
      if (!thawed) return meta;
      return mutateMeta((next) => {
        if (
          next.sandboxId !== sandboxId
          || next.status !== "running"
          || (next.lifecycleAttemptId ?? null) !== runningLifecycleAttemptId
        ) return;
        next.lastError = null;
        next.lastGatewayProbeReady = false;
      });
    }
    const preStopPhase = hostSuspension.phase === "fencing"
      || hostSuspension.phase === "preparing"
      || hostSuspension.phase === "prepared";
    const preStopDeadlineElapsed = preStopPhase
      && Date.now() - hostSuspension.updatedAtMs >= HOST_STOP_REQUEST_MAX_MS;
    const stopRequestDeadlineElapsed = hostSuspension.phase === "stop-requesting"
      && hostSuspension.stopRequestDeadlineAtMs !== null
      && Date.now() >= hostSuspension.stopRequestDeadlineAtMs;
    if (!preStopDeadlineElapsed && !stopRequestDeadlineElapsed) return meta;

    let sandbox: SandboxHandle;
    try {
      sandbox = await getSandboxController().get({
        sandboxId,
        resume: false,
      });
    } catch (error) {
      if (!isSandboxGoneError(error)) {
        logWarn("sandbox.host_suspension_orphan_lookup_failed", {
          sandboxId,
          operationId: hostSuspension.operationId,
          error: error instanceof Error ? error.message : String(error),
        });
        return meta;
      }
      const deletedMeta = await mutateMeta((next) => {
        if (
          next.sandboxId !== sandboxId
          || next.status !== "running"
          || (next.lifecycleAttemptId ?? null) !== runningLifecycleAttemptId
        ) return;
        failPendingPersistentAutoSave(next);
        next.sandboxId = null;
        next.portUrls = null;
        next.status = "uninitialized";
        next.lastError = null;
      });
      if (deletedMeta.sandboxId !== null || deletedMeta.status !== "uninitialized") {
        return deletedMeta;
      }
      await clearHostSuspensionAfterDelete({
        sandboxId,
        operationId: hostSuspension.operationId,
      });
      await clearSandboxDeadline(sandboxId, {
        lifecycleAttemptId: runningLifecycleAttemptId,
      });
      return deletedMeta;
    }

    if (sandbox.status === "stopped") {
      if (
        hostSuspension.phase !== "stop-requesting"
        && hostSuspension.phase !== "stopping"
        && hostSuspension.phase !== "stopped"
      ) return meta;
      const stoppedMeta = await mutateMeta((next) => {
        if (
          next.sandboxId !== sandboxId
          || next.status !== "running"
          || (next.lifecycleAttemptId ?? null) !== runningLifecycleAttemptId
        ) return;
        next.status = "stopped";
        next.lastError = null;
        next.lastGatewayProbeReady = false;
      });
      if (
        stoppedMeta.status !== "stopped"
        || stoppedMeta.sandboxId !== sandboxId
        || (stoppedMeta.lifecycleAttemptId ?? null) !== runningLifecycleAttemptId
      ) return stoppedMeta;
      await markHostSuspensionStopped(hostSuspension);
      await clearSandboxDeadline(sandboxId, {
        lifecycleAttemptId: runningLifecycleAttemptId,
      });
      return stoppedMeta;
    }
    if (sandbox.status !== "running") return meta;

    try {
      await rollbackHostSuspension({
        state: hostSuspension,
        sandbox,
        error: new Error("Host suspension was abandoned before platform stop."),
      });
    } catch (error) {
      logWarn("sandbox.host_suspension_orphan_rollback_failed", {
        sandboxId,
        operationId: hostSuspension.operationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return meta;
    }
    return mutateMeta((next) => {
      if (
        next.sandboxId !== sandboxId
        || next.status !== "running"
        || (next.lifecycleAttemptId ?? null) !== runningLifecycleAttemptId
      ) return;
      next.lastError = "Abandoned host suspension rolled back; Gateway admission resumed.";
      next.lastGatewayProbeReady = false;
    });
  }

  const capturedSandboxId = meta.sandboxId;
  const capturedLifecycleAttemptId = meta.lifecycleAttemptId ?? null;
  const capturedStop = meta.activePersistentStop;
  const capturedOperationId = capturedStop
    ? capturedStop.operationId ?? undefined
    : hostSuspension?.sandboxId === capturedSandboxId
      && hostSuspension.lifecycleAttemptId === capturedLifecycleAttemptId
      ? hostSuspension.operationId
      : undefined;
  const ownsCapturedStop = (next: SingleMeta): boolean =>
    next.sandboxId === capturedSandboxId
    && next.status === "snapshotting"
    && (next.lifecycleAttemptId ?? null) === capturedLifecycleAttemptId
    && (
      capturedStop === null
        ? next.activePersistentStop === null
        : next.activePersistentStop?.stopAttemptId === capturedStop.stopAttemptId
    );
  const readCapturedHostOperation = async (): Promise<{
    owned: boolean;
    state: HostSuspensionState | null;
  }> => {
    try {
      const latest = await readHostSuspensionState();
      const owned = capturedOperationId === undefined
        ? latest === null
        : latest?.sandboxId === capturedSandboxId
          && latest.operationId === capturedOperationId
          && latest.lifecycleAttemptId === capturedLifecycleAttemptId;
      return { owned, state: latest };
    } catch (error) {
      if (!(error instanceof HostSuspensionStateCorruptError)) throw error;
      return { owned: false, state: null };
    }
  };
  let sandbox: SandboxHandle;
  try {
    sandbox = await getSandboxController().get({
      sandboxId: capturedSandboxId,
      resume: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isSandboxGoneError(error)) {
      logWarn("sandbox.snapshotting_reconcile_lookup_failed", {
        sandboxId: capturedSandboxId,
        error: message,
      });
      return meta;
    }

    logInfo("sandbox.snapshotting_reconciled", {
      sandboxId: capturedSandboxId,
      sdkStatus: "not-found",
      outcome: "deleted",
    });
    if (!(await readCapturedHostOperation()).owned) {
      return getInitializedMeta();
    }
    const deletedMeta = await mutateMeta((next) => {
      if (!ownsCapturedStop(next)) return;
      failPendingPersistentAutoSave(next);
      next.status = "uninitialized";
      next.sandboxId = null;
      next.portUrls = null;
      next.bundleIdentity = null;
      next.bundleCandidate = null;
      next.persistedStateDynamicConfigHash = null;
      next.persistedStateAssetSha256 = null;
      next.persistedStateSavedAt = null;
      next.persistedStateSource = null;
      next.restorePreparedStatus = "failed";
      next.restorePreparedReason = "prepare-failed";
      next.activePersistentStop = null;
      next.lifecycleAttemptId = null;
      next.lastError = "Persistent sandbox was deleted before stop completed.";
      next.lastGatewayProbeReady = false;
    });
    if (deletedMeta.status !== "uninitialized" || deletedMeta.sandboxId !== null) {
      return deletedMeta;
    }
    if (capturedOperationId) {
      await clearHostSuspensionAfterDelete({
        sandboxId: capturedSandboxId,
        operationId: capturedOperationId,
      });
    }
    await clearSandboxDeadline(capturedSandboxId, {
      lifecycleAttemptId: capturedLifecycleAttemptId,
    });
    return deletedMeta;
  }

  const sdkStatus = sandbox.status;
  if (sdkStatus === "stopped") {
    const capturedHostOperation = await readCapturedHostOperation();
    if (!capturedHostOperation.owned) return getInitializedMeta();
    const bundleMigrationRequired = (
      capturedStop?.reason
      ?? capturedHostOperation.state?.reason
    ) === BUNDLE_MIGRATION_SUSPENSION_REASON;
    logInfo("sandbox.snapshotting_reconciled", {
      sandboxId: capturedSandboxId,
      sdkStatus,
      outcome: "stopped",
    });
    const stoppedMeta = await mutateMeta((next) => {
      if (!ownsCapturedStop(next)) return;
      next.status = bundleMigrationRequired ? "error" : "stopped";
      next.lastError = bundleMigrationRequired
        ? BUNDLE_MIGRATION_REQUIRED_LAST_ERROR
        : null;
      next.lastGatewayProbeReady = false;
      if (bundleMigrationRequired) {
        failPendingPersistentAutoSave(next);
      } else {
        const completedAutoSave = completePendingPersistentAutoSave(next, {
          sandboxId: capturedSandboxId,
          lifecycleAttemptId: capturedLifecycleAttemptId,
          operationId: capturedOperationId ?? null,
        }, Date.now());
        if (!completedAutoSave) failPendingPersistentAutoSave(next);
      }
      next.activePersistentStop = null;
    });
    if (
      stoppedMeta.status === "snapshotting"
      || stoppedMeta.sandboxId !== capturedSandboxId
      || (stoppedMeta.lifecycleAttemptId ?? null) !== capturedLifecycleAttemptId
    ) return stoppedMeta;
    if (capturedHostOperation.state) {
      await markHostSuspensionStopped(capturedHostOperation.state);
    }
    await clearSandboxDeadline(capturedSandboxId, {
      lifecycleAttemptId: capturedLifecycleAttemptId,
    });
    return stoppedMeta;
  }
  if (sdkStatus === "failed" || sdkStatus === "aborted") {
    const failedHostOperation = await readCapturedHostOperation();
    if (!failedHostOperation.owned) {
      return getInitializedMeta();
    }
    logWarn("sandbox.snapshotting_reconciled", {
      sandboxId: capturedSandboxId,
      sdkStatus,
      outcome: "failed",
    });
    const failedMeta = await mutateMeta((next) => {
      if (!ownsCapturedStop(next)) return;
      failPendingPersistentAutoSave(next);
      next.status = "error";
      next.lastError = `snapshot ${sdkStatus}`;
      next.lastGatewayProbeReady = false;
      next.activePersistentStop = null;
    });
    if (
      failedMeta.status !== "error"
      || failedMeta.sandboxId !== capturedSandboxId
      || (failedMeta.lifecycleAttemptId ?? null) !== capturedLifecycleAttemptId
    ) return failedMeta;
    if (failedHostOperation.state) {
      await markHostSuspensionStopped(failedHostOperation.state);
    }
    await clearSandboxDeadline(capturedSandboxId, {
      lifecycleAttemptId: capturedLifecycleAttemptId,
    });
    return failedMeta;
  }

  const currentHostOperation = await readCapturedHostOperation();
  if (!currentHostOperation.owned) return getInitializedMeta();
  const monitoredHostSuspension = capturedOperationId && currentHostOperation.state
    ? await ensureHostStopMonitor(currentHostOperation.state)
    : null;

  const stopRequestDeadlineElapsed = sdkStatus === "running"
    && monitoredHostSuspension?.ingressFenced === true
    && monitoredHostSuspension.phase === "stop-requesting"
    && monitoredHostSuspension.stopRequestDeadlineAtMs !== null
    && Date.now() >= monitoredHostSuspension.stopRequestDeadlineAtMs;

  if (
      monitoredHostSuspension?.ingressFenced
      && (
        monitoredHostSuspension.phase === "stop-requesting"
        || monitoredHostSuspension.phase === "stopping"
      )
      && !stopRequestDeadlineElapsed
      && monitoredHostSuspension.leaseExpiresAtMs !== null
      && monitoredHostSuspension.leaseExpiresAtMs - Date.now() <= HOST_SUSPENSION_RENEW_WINDOW_MS
  ) {
    try {
      const renewed = await renewHostSuspension({
        state: monitoredHostSuspension,
        sandbox,
      });
      if (monitoredHostSuspension.phase === "stop-requesting") {
        await markHostSuspensionStopRequesting(renewed);
      } else {
        await markHostSuspensionStopping(renewed);
      }
      logInfo("sandbox.host_suspension.lease_renewed_during_stop", {
        sandboxId: meta.sandboxId,
        operationId: renewed.operationId,
        leaseExpiresAtMs: renewed.leaseExpiresAtMs,
        sdkStatus,
      });
    } catch (error) {
      logWarn("sandbox.host_suspension.lease_renew_failed_during_stop", {
        sandboxId: meta.sandboxId,
        operationId: monitoredHostSuspension.operationId,
        sdkStatus,
        busy: error instanceof HostSuspensionBusyError,
        error: error instanceof Error ? error.message : String(error),
      });
      // Keep snapshotting metadata and the host fence. A transient control
      // failure is not evidence that the platform stopped.
      return meta;
    }
  }

  if (sdkStatus === "running") {
    if (
      monitoredHostSuspension?.ingressFenced
      && monitoredHostSuspension.phase === "stop-requesting"
      && !stopRequestDeadlineElapsed
    ) {
      // The SDK request has not returned yet. It may already be committing
      // server-side, so never roll admission back based on a lagging running
      // observation; the durable monitor keeps the lease renewed.
      return meta;
    }

    const stopTransitionAgeMs = monitoredHostSuspension?.phase === "stopping"
      ? Date.now() - monitoredHostSuspension.updatedAtMs
      : monitoredHostSuspension
        ? Number.POSITIVE_INFINITY
        : Date.now() - meta.updatedAt;

    if (
      (
        !monitoredHostSuspension
        || (
          monitoredHostSuspension.ingressFenced
          && monitoredHostSuspension.phase === "stopping"
        )
      )
      && stopTransitionAgeMs < HOST_STOP_RUNNING_GRACE_MS
    ) {
      return meta;
    }

    if (monitoredHostSuspension?.ingressFenced) {
      const latestMeta = await getInitializedMeta();
      const latestSuspension = await readHostSuspensionState();
      if (
        !ownsCapturedStop(latestMeta)
        || latestSuspension?.operationId !== monitoredHostSuspension.operationId
      ) return latestMeta;
      try {
        const stopFailure = monitoredHostSuspension.phase === "stop-requesting"
          ? new Error(
              `Sandbox stop request did not commit within ${HOST_STOP_REQUEST_MAX_MS}ms.`,
            )
          : new Error("Sandbox remained running after non-blocking stop acceptance.");
        await rollbackHostSuspension({
          state: monitoredHostSuspension,
          sandbox,
          error: stopFailure,
        });
      } catch (error) {
        logWarn("sandbox.snapshotting_running_rollback_failed", {
          sandboxId: capturedSandboxId,
          operationId: monitoredHostSuspension.operationId,
          error: error instanceof Error ? error.message : String(error),
        });
        return meta;
      }
    }

    logWarn("sandbox.snapshotting_reconciled", {
      sandboxId: capturedSandboxId,
      sdkStatus,
      outcome: "stop-not-applied-rolled-back",
    });
    const runningMeta = await mutateMeta((next) => {
      if (!ownsCapturedStop(next)) return;
      failPendingPersistentAutoSave(next);
      next.status = "running";
      next.portUrls = resolvePortUrls(sandbox);
      next.lastError = "Sandbox stop was not applied; Gateway admission resumed.";
      next.lastGatewayProbeReady = false;
      next.activePersistentStop = null;
    });
    if (
      runningMeta.status === "running"
      && runningMeta.sandboxId === capturedSandboxId
      && (runningMeta.lifecycleAttemptId ?? null) === capturedLifecycleAttemptId
    ) {
      await armSandboxDeadline(runningMeta, undefined, {
        activityAtMs: Date.now(),
        nativeTimeoutRemainingMs: sandbox.timeoutRemaining,
      });
    }
    return runningMeta;
  }

  if (isOperationStale(meta)) {
    logWarn("sandbox.snapshotting_reconciled", {
      sandboxId: meta.sandboxId,
      sdkStatus,
      outcome: "stale-still-transitional",
    });
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Token refresh — structured result, distributed lock, circuit breaker, TTL
// ---------------------------------------------------------------------------

/**
 * Compute remaining TTL from persisted sandbox credential metadata.
 * Returns `Infinity` for api-key sources, `null` when no expiry is recorded.
 */
function getSandboxCredentialRemainingMs(
  meta: Pick<SingleMeta, "lastTokenExpiresAt" | "lastTokenSource">,
  now = Date.now(),
): number | null {
  if (meta.lastTokenSource === "api-key") {
    return Number.POSITIVE_INFINITY;
  }
  if (meta.lastTokenExpiresAt == null) {
    return null;
  }
  return meta.lastTokenExpiresAt * 1000 - now;
}

/**
 * Check whether the persisted sandbox credential has at least `minRemainingMs`
 * of TTL left. This is the only TTL authority — function-local OIDC tokens
 * are never used for freshness decisions.
 */
function hasSufficientSandboxCredentialTtl(
  meta: Pick<SingleMeta, "lastTokenExpiresAt" | "lastTokenSource">,
  minRemainingMs: number,
  now = Date.now(),
): boolean {
  const remainingMs = getSandboxCredentialRemainingMs(meta, now);
  return remainingMs != null && remainingMs > minRemainingMs;
}

/**
 * Produce a version string from the credential-relevant metadata fields.
 * Used to detect whether another request refreshed the token while this
 * request was waiting on the distributed lock.
 */
function getSandboxCredentialVersion(
  meta: Pick<
    SingleMeta,
    "lastTokenRefreshAt" | "lastTokenExpiresAt" | "lastTokenSource"
  >,
): string {
  return [
    meta.lastTokenRefreshAt ?? "none",
    meta.lastTokenExpiresAt ?? "none",
    meta.lastTokenSource ?? "none",
  ].join(":");
}

/**
 * High-level entry point for AI Gateway credential management.
 *
 * Wraps TTL-based freshness check, circuit breaker, distributed lock, and
 * the actual refresh into a single call that returns a structured result.
 */
export async function ensureUsableAiGatewayCredential(
  opts?: EnsureUsableCredentialOptions,
): Promise<TokenRefreshResult> {
  try {
    return await withSandboxLifecycleMutationLock((assertOwned) =>
      ensureUsableAiGatewayCredentialWithinLifecycleLock(opts, assertOwned));
  } catch (error) {
    if (error instanceof SandboxLifecycleLockContendedError) {
      return { refreshed: false, reason: "lifecycle-lock-contended" };
    }
    throw error;
  }
}

async function ensureUsableAiGatewayCredentialWithinLifecycleLock(
  opts?: EnsureUsableCredentialOptions,
  assertOwned: () => Promise<void> = async () => {},
): Promise<TokenRefreshResult> {
  const minRemainingMs = opts?.minRemainingMs ?? DEFAULT_MIN_REMAINING_MS;
  const force = opts?.force ?? false;
  const required = opts?.required ?? false;
  const reason = opts?.reason ?? "ensure-usable";

  const meta = await getInitializedMeta();
  if (!meta.sandboxId || meta.status !== "running") {
    return { refreshed: false, reason: "sandbox-not-running" };
  }
  const sandboxId = meta.sandboxId;
  const lifecycleAttemptId = meta.lifecycleAttemptId ?? null;
  const ownsCredentialMutation = async (): Promise<boolean> => {
    const [latest, suspension] = await Promise.all([
      getInitializedMeta(),
      readHostSuspensionState(),
    ]);
    return latest.status === "running"
      && latest.sandboxId === sandboxId
      && (latest.lifecycleAttemptId ?? null) === lifecycleAttemptId
      && !suspension?.ingressFenced;
  };
  if (!await ownsCredentialMutation()) {
    return { refreshed: false, reason: "host-suspension-fenced" };
  }

  // Resolve current credential to check TTL / source.
  const credential = await resolveAiGatewayCredentialOptional();

  // If source is api-key, no refresh is ever needed — static keys don't expire.
  if (credential?.source === "api-key") {
    return {
      refreshed: false,
      reason: "api-key-no-refresh-needed",
      credential: credential
        ? { token: credential.token, source: credential.source, expiresAt: credential.expiresAt }
        : null,
    };
  }

  // If no credential at all and required, fail immediately.
  if (!credential && required) {
    return { refreshed: false, reason: "no-credential-available" };
  }

  // Capture credential version before the lock to detect concurrent refreshes.
  const initialCredentialVersion = getSandboxCredentialVersion(meta);

  // Check TTL of the token last written to the sandbox — skip if it still has
  // sufficient remaining life. We use the persisted sandbox metadata as the
  // only TTL authority. Function-local OIDC tokens are never trusted for
  // freshness decisions because Vercel Functions always get a fresh 1-hour
  // token that would falsely pass even when the sandbox's on-disk token has
  // long expired.
  if (!force && hasSufficientSandboxCredentialTtl(meta, minRemainingMs)) {
    logInfo("sandbox.credential.ttl_sufficient", {
      sandboxId: meta.sandboxId,
      reason: "meta-ttl-sufficient",
      remainingMs: getSandboxCredentialRemainingMs(meta),
    });
    return {
      refreshed: false,
      reason: "meta-ttl-sufficient",
      credential: credential
        ? { token: credential.token, source: credential.source, expiresAt: credential.expiresAt }
        : null,
    };
  }

  // Circuit breaker check.
  const breakerResult = checkCircuitBreaker(meta);
  if (breakerResult) {
    return breakerResult;
  }

  // Acquire distributed lock before refreshing.
  return withTokenRefreshLock(sandboxId, reason, async (currentMeta) => {
    // Re-check after lock acquisition — another request may have refreshed
    // while we waited. Use persisted metadata as the only TTL authority.
    const currentCredentialVersion = getSandboxCredentialVersion(currentMeta);

    if (!force && hasSufficientSandboxCredentialTtl(currentMeta, minRemainingMs)) {
      const versionChanged = currentCredentialVersion !== initialCredentialVersion;
      const afterLockReason = versionChanged
        ? "refreshed-by-another-request"
        : "meta-ttl-sufficient-after-lock";
      logInfo("sandbox.credential.ttl_sufficient_after_lock", {
        sandboxId: currentMeta.sandboxId,
        reason: afterLockReason,
        versionChanged,
        remainingMs: getSandboxCredentialRemainingMs(currentMeta),
      });
      const liveCred = await resolveAiGatewayCredentialOptional();
      return {
        refreshed: false,
        reason: afterLockReason,
        credential: liveCred
          ? { token: liveCred.token, source: liveCred.source, expiresAt: liveCred.expiresAt }
          : null,
      };
    }

    // api-key check after lock (another request may have switched to api-key).
    if (!force && currentMeta.lastTokenSource === "api-key") {
      return {
        refreshed: false,
        reason: "api-key-no-refresh-needed",
        credential: null,
      };
    }

    // Verify sandboxId has not changed while we waited for the lock.
    if (
      currentMeta.status !== "running"
      || currentMeta.sandboxId !== sandboxId
      || (currentMeta.lifecycleAttemptId ?? null) !== lifecycleAttemptId
      || !await ownsCredentialMutation()
    ) {
      return { refreshed: false, reason: "sandbox-changed" };
    }

    await assertOwned();
    const sandbox = await getSandboxController().get({
      sandboxId,
      resume: false,
    });
    await assertOwned();
    if (sandbox.status !== "running" || !await ownsCredentialMutation()) {
      return { refreshed: false, reason: "sandbox-changed" };
    }
    try {
      const refreshedOwnedGeneration = await refreshAiGatewayToken(
        sandbox,
        {
          sandboxId,
          lifecycleAttemptId,
        },
        assertOwned,
        opts?.controlPlaneOrigin,
      );
      if (!refreshedOwnedGeneration || !await ownsCredentialMutation()) {
        return { refreshed: false, reason: "sandbox-changed" };
      }

      // Success — reset breaker state.
      const succeeded = await mutateMeta((m) => {
        if (
          m.status !== "running"
          || m.sandboxId !== sandboxId
          || (m.lifecycleAttemptId ?? null) !== lifecycleAttemptId
        ) return;
        m.consecutiveTokenRefreshFailures = 0;
        m.lastTokenRefreshError = null;
        m.breakerOpenUntil = null;
      });
      if (
        succeeded.sandboxId !== sandboxId
        || (succeeded.lifecycleAttemptId ?? null) !== lifecycleAttemptId
      ) return { refreshed: false, reason: "sandbox-changed" };

      const postRefreshCred = await resolveAiGatewayCredentialOptional();
      return {
        refreshed: true,
        reason: "refreshed",
        credential: postRefreshCred
          ? { token: postRefreshCred.token, source: postRefreshCred.source, expiresAt: postRefreshCred.expiresAt }
          : null,
      };
    } catch (err) {
      if (err instanceof LifecycleLockOwnershipLostError) throw err;
      if (!await ownsCredentialMutation()) {
        return { refreshed: false, reason: "sandbox-changed" };
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      logWarn("sandbox.token_refresh_failed", {
        sandboxId: currentMeta.sandboxId,
        error: errorMsg,
        reason,
      });

      // Record failure for circuit breaker.
      const updated = await mutateMeta((m) => {
        if (
          m.status !== "running"
          || m.sandboxId !== sandboxId
          || (m.lifecycleAttemptId ?? null) !== lifecycleAttemptId
        ) return;
        m.consecutiveTokenRefreshFailures = (m.consecutiveTokenRefreshFailures ?? 0) + 1;
        m.lastTokenRefreshError = errorMsg;

        // Open breaker after threshold consecutive failures.
        if ((m.consecutiveTokenRefreshFailures ?? 0) >= BREAKER_FAILURE_THRESHOLD) {
          m.breakerOpenUntil = Date.now() + BREAKER_OPEN_DURATION_MS;
          logWarn("sandbox.token_refresh.breaker_opened", {
            failures: m.consecutiveTokenRefreshFailures,
            breakerOpenUntil: m.breakerOpenUntil,
          });
        }
      });
      if (
        updated.status !== "running"
        || updated.sandboxId !== sandboxId
        || (updated.lifecycleAttemptId ?? null) !== lifecycleAttemptId
      ) {
        return { refreshed: false, reason: "sandbox-changed" };
      }

      return {
        refreshed: false,
        reason: `refresh-failed: ${errorMsg}`,
        retryAfterMs: updated.breakerOpenUntil
          ? Math.max(0, updated.breakerOpenUntil - Date.now())
          : undefined,
      };
    }
  });
}

/**
 * Legacy entry point — now delegates to ensureUsableAiGatewayCredential.
 *
 * Returns a structured TokenRefreshResult instead of void. Callers that
 * previously ignored the return value continue to work since the signature
 * is a superset of the old void return.
 */
export async function ensureFreshGatewayToken(options?: {
  force?: boolean;
  controlPlaneOrigin?: string;
}): Promise<TokenRefreshResult> {
  return ensureUsableAiGatewayCredential({
    force: options?.force,
    reason: "ensureFreshGatewayToken",
    controlPlaneOrigin: options?.controlPlaneOrigin,
  });
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

function checkCircuitBreaker(meta: SingleMeta): TokenRefreshResult | null {
  const breakerOpenUntil = meta.breakerOpenUntil ?? 0;
  if (breakerOpenUntil > 0 && Date.now() < breakerOpenUntil) {
    const retryAfterMs = breakerOpenUntil - Date.now();
    logInfo("sandbox.token_refresh.circuit_breaker_open", {
      breakerOpenUntil,
      retryAfterMs,
      consecutiveFailures: meta.consecutiveTokenRefreshFailures ?? 0,
    });
    return {
      refreshed: false,
      reason: "circuit-breaker-open",
      retryAfterMs,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Distributed token refresh lock
// ---------------------------------------------------------------------------

async function withTokenRefreshLock(
  sandboxId: string,
  reason: string,
  fn: (meta: SingleMeta) => Promise<TokenRefreshResult>,
): Promise<TokenRefreshResult> {
  const store = getStore();
  let lockToken = await store.acquireLock(
    tokenRefreshLockKey(),
    TOKEN_REFRESH_LOCK_TTL_SECONDS,
  );

  if (!lockToken) {
    // Lock is contended — wait a bounded time, then re-read state.
    const waitStart = Date.now();
    while (Date.now() - waitStart < TOKEN_REFRESH_LOCK_WAIT_MS) {
      await wait(TOKEN_REFRESH_LOCK_POLL_MS);
      lockToken = await store.acquireLock(
        tokenRefreshLockKey(),
        TOKEN_REFRESH_LOCK_TTL_SECONDS,
      );
      if (lockToken) break;
    }

    if (!lockToken) {
      // Still contended — check if another request completed the refresh.
      const freshMeta = await getInitializedMeta();
      if (freshMeta.sandboxId !== sandboxId) {
        return { refreshed: false, reason: "sandbox-changed-during-lock-wait" };
      }

      // Return without refreshing — the lock holder is doing it.
      logInfo("sandbox.token_refresh.lock_contended", { sandboxId, reason });
      return {
        refreshed: false,
        reason: "lock-contended",
      };
    }
  }

  try {
    const currentMeta = await getInitializedMeta();
    return await fn(currentMeta);
  } finally {
    await store.releaseLock(tokenRefreshLockKey(), lockToken).catch((error) => {
      logWarn("sandbox.token_refresh.lock_release_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Core credential write for restore scripts. AI Gateway auth is primarily
// injected via network policy transform; bootstrap env may still carry a
// compatibility token until that fallback is removed.
// ---------------------------------------------------------------------------

const WRITE_RESTORE_CREDENTIAL_FILES_SCRIPT = [
  `install -d -m 700 ${OPENCLAW_STATE_DIR}`,
  `printf '%s' "$1" > ${OPENCLAW_GATEWAY_TOKEN_PATH}`,
  `chmod 600 ${OPENCLAW_GATEWAY_TOKEN_PATH}`,
].join("\n");

export async function writeRestoreCredentialFiles(
  sandbox: SandboxHandle,
  options: { gatewayToken: string },
): Promise<void> {
  logInfo("sandbox.restore.write_credentials", {
    sandboxId: sandbox.sandboxId,
  });

  const result = await sandbox.runCommand("sh", [
    "-c",
    WRITE_RESTORE_CREDENTIAL_FILES_SCRIPT,
    "--",
    options.gatewayToken,
  ]);

  if (result.exitCode !== 0) {
    const output = await result.output("both");
    throw new CommandFailedError({
      command: "write-restore-credential-files",
      exitCode: result.exitCode,
      output,
    });
  }
}

// Token refresh via network policy update — the AI Gateway credential is
// injected as an Authorization header transform at the firewall layer, so
// refreshing it is a single SDK call with no gateway restart required.

function requiredControlPlaneDomains(
  meta: SingleMeta,
  origin?: string,
): string[] {
  if (meta.firewall.mode !== "enforcing") return [];
  try {
    return controlPlaneDomains(origin ?? getPublicOrigin());
  } catch {
    // Background operations in local deployments may have neither a request
    // origin nor a configured canonical hostname.
    return [];
  }
}

async function refreshAiGatewayToken(
  sandbox: SandboxHandle,
  generation: {
    sandboxId: string;
    lifecycleAttemptId: string | null;
  },
  assertOwned: () => Promise<void>,
  controlPlaneOrigin?: string,
): Promise<boolean> {
  const { sandboxId, lifecycleAttemptId } = generation;
  const readOwnedMeta = async (): Promise<SingleMeta | null> => {
    const [meta, suspension] = await Promise.all([
      getInitializedMeta(),
      readHostSuspensionState(),
    ]);
    return meta.status === "running"
      && meta.sandboxId === sandboxId
      && (meta.lifecycleAttemptId ?? null) === lifecycleAttemptId
      && !suspension?.ingressFenced
      ? meta
      : null;
  };
  const credential = await resolveAiGatewayCredentialOptional();

  // If source is api-key, skip refresh entirely — static keys don't expire.
  if (credential?.source === "api-key") {
    logInfo("sandbox.token_refresh.skipped_api_key", { sandboxId });
    const updated = await mutateMeta((next) => {
      if (
        next.status !== "running"
        || next.sandboxId !== sandboxId
        || (next.lifecycleAttemptId ?? null) !== lifecycleAttemptId
      ) return;
      next.lastTokenRefreshAt = Date.now();
      next.lastTokenSource = "api-key";
      next.lastTokenExpiresAt = null;
    });
    return updated.status === "running"
      && updated.sandboxId === sandboxId
      && (updated.lifecycleAttemptId ?? null) === lifecycleAttemptId;
  }

  const freshToken = credential?.token;
  if (!freshToken) {
    logWarn("sandbox.token_refresh.no_oidc_token", { sandboxId });
    throw new Error("No OIDC token available for refresh");
  }

  logInfo("sandbox.token_refresh.start", { sandboxId });

  // Update the network policy with the fresh token — the firewall layer
  // injects the Authorization header on outbound requests to ai-gateway.
  // No file writes or gateway restarts needed.
  let appliedMeta: SingleMeta | null = null;
  for (let policyAttempt = 0; policyAttempt < 4; policyAttempt += 1) {
    await assertOwned();
    const meta = await readOwnedMeta();
    if (!meta) return false;
    const requiredDomains = requiredControlPlaneDomains(meta, controlPlaneOrigin);
    const appliedHash = computePolicyHash(
      meta.firewall.mode,
      meta.firewall.allowlist,
      requiredDomains,
    );
    await applyFirewallPolicyToSandbox(
      sandbox,
      meta,
      freshToken,
      requiredDomains,
    );
    await assertOwned();
    const latest = await readOwnedMeta();
    if (!latest) return false;
    const latestHash = computePolicyHash(
      latest.firewall.mode,
      latest.firewall.allowlist,
      requiredControlPlaneDomains(latest, controlPlaneOrigin),
    );
    if (latestHash === appliedHash) {
      appliedMeta = latest;
      break;
    }
  }
  if (!appliedMeta) {
    throw new Error("Firewall policy changed repeatedly during token refresh.");
  }

  logInfo("sandbox.token_refresh.policy_updated", { sandboxId });

  const updated = await mutateMeta((next) => {
    if (
      next.status !== "running"
      || next.sandboxId !== sandboxId
      || (next.lifecycleAttemptId ?? null) !== lifecycleAttemptId
    ) return;
    next.lastTokenRefreshAt = Date.now();
    next.lastTokenSource = credential.source;
    next.lastTokenExpiresAt = credential.expiresAt ?? null;
  });
  if (
    updated.status !== "running"
    || updated.sandboxId !== sandboxId
    || (updated.lifecycleAttemptId ?? null) !== lifecycleAttemptId
  ) return false;

  logInfo("sandbox.token_refresh.complete", {
    sandboxId,
    source: credential.source,
    expiresAt: credential.expiresAt ?? null,
    refreshedAt: Date.now(),
  });
  return true;
}

// ---------------------------------------------------------------------------
// Gateway readiness probes
// ---------------------------------------------------------------------------

export type ProbeResult = {
  ready: boolean;
  statusCode?: number;
  markerFound?: boolean;
  error?: string;
};

export async function probeGatewayReady(
  options?: { timeoutMs?: number; resume?: boolean; thaw?: boolean },
): Promise<ProbeResult> {
  const meta = await getInitializedMeta();
  if (!meta.sandboxId || !["running", "setup", "booting"].includes(meta.status)) {
    return { ready: false };
  }
  const sandboxId = meta.sandboxId;
  const lifecycleAttemptId = meta.lifecycleAttemptId ?? null;

  try {
    const sandbox = await getSandboxController().get({
      sandboxId,
      resume: options?.resume ?? true,
    });
    if (options?.resume === false && sandbox.status !== "running") {
      return {
        ready: false,
        error: `Sandbox is ${sandbox.status}; read-only readiness did not resume it.`,
      };
    }
    const routeUrl = meta.portUrls?.[String(OPENCLAW_PORT)] ?? sandbox.domain(OPENCLAW_PORT);
    const headers = {
      Accept: "text/html",
      Authorization: `Bearer ${meta.gatewayToken}`,
      "x-openclaw-scopes": OPENCLAW_OPERATOR_SCOPES,
    };
    const response = await fetch(routeUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(options?.timeoutMs ?? 5_000),
    });
    const body = await response.text();
    const markerFound = body.includes("openclaw-app");
    let ready = response.ok && markerFound;

    if (ready && options?.thaw !== false) {
      ready = await thawHostSuspensionIfNeeded({
        sandbox,
        lifecycleAttemptId,
      });
      if (!ready) {
        return {
          ready: false,
          statusCode: response.status,
          markerFound,
          error: "Gateway is reachable but the durable host suspension has not thawed.",
        };
      }
    }

    let statusCode = response.status;
    if (ready) {
      const readinessUrl = new URL("/readyz", routeUrl).toString();
      const readiness = await fetch(readinessUrl, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(options?.timeoutMs ?? 5_000),
      });
      statusCode = readiness.status;
      ready = readiness.ok;
      if (!ready) {
        return {
          ready: false,
          statusCode,
          markerFound,
          error: "Gateway liveness is reachable but work admission is not ready.",
        };
      }
    }

    if (ready && options?.thaw !== false && meta.status !== "running") {
      await mutateMeta((next) => {
        if (
          next.sandboxId !== sandboxId
          || (next.lifecycleAttemptId ?? null) !== lifecycleAttemptId
        ) return;
        next.status = "running";
        next.lastError = null;
      });
    }

    return { ready, statusCode, markerFound };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn("sandbox.probe_failed", { error: message });
    return { ready: false, error: message };
  }
}

export async function waitForPublicGatewayReady(options?: {
  maxAttempts?: number;
  delayMs?: number;
  timeoutMs?: number;
  probe?: (timeoutMs: number) => Promise<ProbeResult>;
}): Promise<void> {
  const maxAttempts = options?.maxAttempts ?? 20;
  const delayMs = options?.delayMs ?? 250;
  const timeoutMs = options?.timeoutMs ?? 1_000;
  const probe =
    options?.probe ??
    ((budgetMs: number) => probeGatewayReady({ timeoutMs: budgetMs }));

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await probe(timeoutMs);
    if (result.ready) {
      logInfo("sandbox.public_gateway_ready", { attempt, timeoutMs });
      return;
    }
    if (attempt < maxAttempts - 1) {
      await wait(delayMs);
    }
  }

  throw new Error(
    `Gateway became locally ready but never became publicly reachable within ${maxAttempts} attempts.`,
  );
}

// ---------------------------------------------------------------------------
// Health reconciliation
// ---------------------------------------------------------------------------

export type SandboxHealthStatus = "ready" | "recovering" | "unreachable";

export type SandboxHealthResult = {
  status: SandboxHealthStatus;
  meta: SingleMeta;
  repaired: boolean;
  error?: string;
};

/**
 * Single authority for sandbox health reconciliation.
 *
 * When metadata says "running", probes the actual gateway.  If the probe
 * fails the sandbox is marked unavailable and recovery is scheduled — the
 * same repair path used everywhere else.  Non-running states delegate to
 * `ensureSandboxRunning` so callers never have to choose between "check"
 * and "ensure".
 */
export async function reconcileSandboxHealth(options: {
  origin: string;
  reason: string;
  schedule?: BackgroundScheduler;
  lifecycleGuard?: SandboxLifecycleGuard;
  op?: OperationContext;
}): Promise<SandboxHealthResult> {
  const meta = await getInitializedMeta();

  // Not supposed to be running — just ensure.
  if (meta.status !== "running" || !meta.sandboxId) {
    if (options.op) {
      logInfo("sandbox.reconcile.not_running", withOperationContext(options.op, {
        status: meta.status,
        action: "ensure",
      }));
    }
    const result = await ensureSandboxRunning(options);
    return {
      status: result.state === "running" ? "ready" : "recovering",
      meta: result.meta,
      repaired: false,
    };
  }

  // Metadata says running — verify with a real probe.
  const sandboxId = meta.sandboxId;
  const lifecycleAttemptId = meta.lifecycleAttemptId ?? null;
  const probe = await probeGatewayReady();

  logInfo("sandbox.health_reconcile.probe_result", {
    sandboxId,
    ready: probe.ready,
    statusCode: probe.statusCode,
    markerFound: probe.markerFound,
    error: probe.error,
    reason: options.reason,
  });

  if (probe.ready) {
    // Refresh lastAccessedAt so the UI doesn't derive "asleep" from stale timestamps
    const freshMeta = await mutateMeta((m) => {
      if (
        m.status !== "running"
        || m.sandboxId !== sandboxId
        || (m.lifecycleAttemptId ?? null) !== lifecycleAttemptId
      ) return;
      m.lastAccessedAt = Date.now();
    });
    if (
      freshMeta.status !== "running"
      || freshMeta.sandboxId !== sandboxId
      || (freshMeta.lifecycleAttemptId ?? null) !== lifecycleAttemptId
    ) {
      return { status: "recovering", meta: freshMeta, repaired: false };
    }
    // Force-refresh the OIDC token on the network policy. After a timeout
    // the platform may have auto-resumed the sandbox with a stale token,
    // causing AI Gateway 401s even though the gateway process is alive.
    await ensureFreshGatewayToken({
      force: true,
      controlPlaneOrigin: options.origin,
    });
    return { status: "ready", meta: freshMeta, repaired: false };
  }

  // Stale running state detected — repair.
  const reconcileCtx = options.op
    ? withOperationContext(options.op, {
        probeError: probe.error,
        statusCode: probe.statusCode,
        sandboxId,
      })
    : {
        reason: options.reason,
        probeError: probe.error,
        statusCode: probe.statusCode,
        sandboxId,
      };
  logWarn("sandbox.health_reconcile", reconcileCtx);
  await markSandboxUnavailable(
    `Health reconciliation: gateway unreachable (${options.reason})`,
    sandboxId,
    lifecycleAttemptId,
  );
  const ensureResult = await ensureSandboxRunning(options);
  const recoveryCtx = options.op
    ? withOperationContext(options.op, {
        newStatus: ensureResult.meta.status,
        repaired: true,
      })
    : {
        reason: options.reason,
        newStatus: ensureResult.meta.status,
        repaired: true,
      };
  logInfo("sandbox.health_reconcile_recovery_scheduled", recoveryCtx);

  return {
    status: "recovering",
    meta: ensureResult.meta,
    repaired: true,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle work scheduling
// ---------------------------------------------------------------------------

async function scheduleLifecycleWork(options: {
  origin: string;
  reason: string;
  meta: SingleMeta;
  schedule?: BackgroundScheduler;
  lifecycleGuard?: SandboxLifecycleGuard;
  op?: OperationContext;
}): Promise<void> {
  const store = getStore();
  const startToken = await store.acquireLock(startLockKey(), START_LOCK_TTL_SECONDS);
  if (!startToken) {
    const lockCtx = options.op
      ? withOperationContext(options.op, { lock: "start", contention: true })
      : { reason: options.reason };
    logInfo("sandbox.start_lock_contended", lockCtx);
    return;
  }

  const latest = await getInitializedMeta();
  if (latest.status === "running" && latest.sandboxId) {
    await store.releaseLock(startLockKey(), startToken);
    return;
  }

  if (latest.status === "error" && terminalBundleReadyFailure(latest.lastError)) {
    await store.releaseLock(startLockKey(), startToken);
    return;
  }

  if (isBusyStatus(latest.status) && !isOperationStale(latest)) {
    await store.releaseLock(startLockKey(), startToken);
    return;
  }

  const nextStatus = latest.snapshotId ? "restoring" : "creating";

  if (options.op) {
    logInfo("sandbox.lifecycle.action_chosen", withOperationContext(options.op, {
      action: nextStatus,
      statusBefore: latest.status,
      sandboxId: latest.sandboxId,
      snapshotId: latest.snapshotId,
    }));
  }

  await mutateMeta((meta) => {
    if (meta.status === "running" && meta.sandboxId) {
      return;
    }
    meta.status = nextStatus;
    meta.lastError = null;
  });

  const run = async (): Promise<void> => {
    await withAutoRenewedLock(
      {
        key: startLockKey(),
        token: startToken,
        ttlSeconds: START_LOCK_TTL_SECONDS,
        label: "sandbox.start",
      },
      async () => {
        try {
          await createAndBootstrapSandbox(options.origin, {
            lifecycleGuard: options.lifecycleGuard,
            op: options.op,
          });
        } catch (error) {
          if (error instanceof SandboxLifecycleGuardRejectedError) {
            logInfo("sandbox.lifecycle_guard_rejected", {
              reason: options.reason,
            });
            await mutateMeta((meta) => {
              if (meta.status === nextStatus && meta.lifecycleAttemptId === null) {
                meta.status = meta.snapshotId ? "stopped" : "uninitialized";
                meta.lastError = null;
              }
            });
            throw error;
          }
          if (error instanceof LifecycleLockOwnershipLostError) {
            logWarn("sandbox.lifecycle_lock_ownership_lost", options.op
              ? withOperationContext(options.op, { lock: "lifecycle" })
              : { reason: options.reason });
            return;
          }
          if (error instanceof LifecycleLockUnavailableError) {
            const lockCtx = options.op
              ? withOperationContext(options.op, { lock: "lifecycle", contention: true })
              : { reason: options.reason };
            logInfo("sandbox.lifecycle_lock_contended", lockCtx);
            await mutateMeta((meta) => {
              if (meta.status === nextStatus) {
                meta.status = meta.snapshotId ? "stopped" : "uninitialized";
                meta.lastError = "Lifecycle lock contention prevented sandbox startup.";
              }
            });
            return;
          }

          const lifecycleAttemptId = error instanceof LifecycleAttemptFailedError
            ? error.attemptId
            : null;
          const failure = error instanceof LifecycleAttemptFailedError
            ? error.failure
            : error;
          const errMsg =
            failure instanceof ApiError
              ? `${failure.code}: ${failure.message}`
              : failure instanceof Error
                ? failure.message
                : String(failure);
          // Capture full API error details when available (e.g. @vercel/sandbox APIError)
          const apiErrorJson = (failure as { json?: unknown }).json;
          const apiErrorText = (failure as { text?: unknown }).text;
          const errCtx = options.op
            ? withOperationContext(options.op, { error: errMsg, ...(apiErrorJson ? { apiErrorJson } : {}), ...(apiErrorText ? { apiErrorText } : {}) })
            : { reason: options.reason, error: errMsg, ...(apiErrorJson ? { apiErrorJson } : {}), ...(apiErrorText ? { apiErrorText } : {}) };
          logError("sandbox.lifecycle_failed", errCtx);
          await mutateMeta((meta) => {
            if (
              lifecycleAttemptId !== null
              && meta.lifecycleAttemptId !== lifecycleAttemptId
            ) return;
            meta.status = "error";
            meta.lastError = errMsg;
          });
        }
      },
    );
  };

  if (options.schedule) {
    options.schedule(run);
  } else if (options.lifecycleGuard) {
    // Guarded wake work must surface a rejected authorization to its caller;
    // backgrounding here would otherwise turn a stale wake into a timeout.
    await run();
  } else {
    void run();
  }
}

// ---------------------------------------------------------------------------
// Sandbox create and restore
// ---------------------------------------------------------------------------

async function createAndBootstrapSandbox(
  origin: string,
  options?: {
    lifecycleGuard?: SandboxLifecycleGuard;
    op?: OperationContext;
  },
): Promise<SingleMeta> {
  return withLifecycleLock((lease) =>
    createAndBootstrapSandboxWithinLifecycleLock(origin, {
      ...options,
      lease,
    }));
}

async function createAndBootstrapSandboxWithinLifecycleLock(
  origin: string,
  options?: {
    lifecycleGuard?: SandboxLifecycleGuard;
    op?: OperationContext;
    lease?: AutoRenewedLockLease;
  },
): Promise<SingleMeta> {
  await assertLifecycleGuardCurrent(options?.lifecycleGuard);
  const current = await getInitializedMeta();
  await normalizeResetCronProjectionGeneration({
    gatewayGeneration: createHash("sha256")
      .update(current.gatewayToken)
      .digest("hex")
      .slice(0, 32),
  });
  if (current.status === "running" && current.sandboxId) {
    return current;
  }

  /** Merge operation context (when available) with extra fields for structured logs. */
  const ctx = (extra?: Record<string, unknown>) =>
    options?.op ? withOperationContext(options.op, extra) : (extra ?? {});
  const attemptId = randomUUID();
  const instanceId = current.id;
  // Snapshot metadata is the durable restore authority. Guarded cron wakes
  // enter here without the background scheduler's status transition.
  const isRestoreAttempt = Boolean(current.snapshotId);

  // Auth-required boot: on Vercel, require a usable AI Gateway credential.
  const credential = await resolveAiGatewayCredentialOptional();
  await assertLifecycleGuardCurrent(options?.lifecycleGuard);
  if (isVercelDeployment() && !credential) {
    logError("sandbox.create.no_ai_gateway_credential", ctx({
      message: "Cannot create sandbox on Vercel without AI Gateway credential. OIDC may be temporarily unavailable.",
    }));
    await mutateMeta((meta) => {
      meta.status = "error";
      meta.lastError =
        "AI Gateway credential unavailable during sandbox create. " +
        "OIDC may be temporarily unavailable — retry will be attempted automatically.";
    });
    return getInitializedMeta();
  }

  await options?.lease?.assertOwned();
  await clearSetupProgress(instanceId);
  const initialProgress = await beginSetupProgress({
    attemptId,
    instanceId,
    phase: isRestoreAttempt ? "resuming-sandbox" : "creating-sandbox",
  });
  const progress = new SetupProgressWriter(initialProgress, instanceId);
  progress.setPreview(
    isRestoreAttempt ? "Restoring persistent sandbox" : "Allocating sandbox",
  );
  const bundleMode = Boolean(process.env.OPENCLAW_BUNDLE_URL?.trim());
  const persistedRuntimeModeMismatch = !bundleMode && current.bundleIdentity !== null;
  let storedBundleIdentityAdmitted: Awaited<
    ReturnType<typeof hydrateVerifiedBundleIdentity>
  > = null;
  let sandbox: SandboxHandle | undefined;
  let activeBundleCandidate = current.bundleCandidate;
  let sandboxIsBundleCandidate = false;
  let sandboxNeedsCandidateReplacement = false;
  let bundleCandidateCommitted = false;

  const candidateMatchesHandle = (
    candidate: SingleMeta["bundleCandidate"],
    lookupId: string,
    handle: SandboxHandle,
  ): boolean =>
    candidate?.lookupId === lookupId
    && (candidate.sandboxId === null || candidate.sandboxId === handle.sandboxId)
    && handle.tags?.[BUNDLE_CANDIDATE_OWNERSHIP_TAG]
      === candidate.ownershipToken;

  const candidateReplacesHandle = (
    candidate: SingleMeta["bundleCandidate"],
    lookupId: string,
    handle: SandboxHandle,
  ): boolean =>
    candidate?.lookupId === lookupId
    && candidate.replacesOwnershipToken !== null
    && handle.tags?.[BUNDLE_CANDIDATE_OWNERSHIP_TAG]
      === candidate.replacesOwnershipToken;

  const candidateAuthorizesCleanup = (
    candidate: SingleMeta["bundleCandidate"],
    lookupId: string,
    handle: SandboxHandle,
  ): boolean =>
    candidateMatchesHandle(candidate, lookupId, handle)
    || candidateReplacesHandle(candidate, lookupId, handle);

  const sameBundleCandidate = (
    left: SingleMeta["bundleCandidate"],
    right: SingleMeta["bundleCandidate"],
  ): boolean =>
    left?.lookupId === right?.lookupId
    && left?.sandboxId === right?.sandboxId
    && left?.ownershipToken === right?.ownershipToken
    && left?.replacesOwnershipToken === right?.replacesOwnershipToken
    && left?.lifecycleAttemptId === right?.lifecycleAttemptId;

  const assertCandidateDeleteOwnership = async (
    lookupId: string,
    handle: SandboxHandle,
  ): Promise<void> => {
    await options?.lease?.assertOwned();
    const latest = await getInitializedMeta();
    if (
      latest.lifecycleAttemptId !== attemptId
      || !sameBundleCandidate(latest.bundleCandidate, activeBundleCandidate)
      || !candidateAuthorizesCleanup(latest.bundleCandidate, lookupId, handle)
    ) {
      throw new LifecycleLockOwnershipLostError();
    }
  };

  const assertCandidateIntentOwnership = async (): Promise<void> => {
    await options?.lease?.assertOwned();
    const latest = await getInitializedMeta();
    if (
      latest.lifecycleAttemptId !== attemptId
      || !sameBundleCandidate(latest.bundleCandidate, activeBundleCandidate)
    ) {
      throw new LifecycleLockOwnershipLostError();
    }
  };

  try {
    logInfo("sandbox.status_transition", ctx({
      from: current.status,
      to: isRestoreAttempt ? "restoring" : "creating",
    }));
    await options?.lease?.assertOwned();
    const startedMeta = await mutateMeta((meta) => {
      if (meta.lifecycleAttemptId !== current.lifecycleAttemptId) return;
      meta.status = isRestoreAttempt ? "restoring" : "creating";
      meta.lastError = null;
      meta.lifecycleAttemptId = attemptId;
      meta.activePersistentStop = null;

      if (!isRestoreAttempt) {
        // Creating a brand-new sandbox invalidates any previously prepared restore target.
        meta.snapshotId = null;
        meta.snapshotConfigHash = null;
        meta.snapshotDynamicConfigHash = null;
        meta.snapshotAssetSha256 = null;
        meta.persistedStateDynamicConfigHash = null;
        meta.persistedStateAssetSha256 = null;
        meta.persistedStateSavedAt = null;
        meta.persistedStateSource = null;
        meta.restorePreparedStatus = "dirty";
        meta.restorePreparedReason = "snapshot-missing";
        meta.restorePreparedAt = null;
      }
    });
    if (startedMeta.lifecycleAttemptId !== attemptId) {
      throw new LifecycleLockOwnershipLostError();
    }
    if (bundleMode) {
      storedBundleIdentityAdmitted = await hydrateVerifiedBundleIdentity(
        current.bundleIdentity,
      );
    }

    const vcpus = getSandboxVcpus();
    const desiredIdleMs = getSandboxSleepAfterMs();
    const sleepAfterMs = getSandboxPlatformTimeoutMs();
    // Sandbox names must be lowercase alphanumeric + hyphens.
    const sandboxName = `oc-${current.id.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`;
    logInfo("sandbox.create.params", ctx({
      sandboxName,
      instanceId: current.id,
      persistent: true,
      vcpus,
      sleepAfterMs,
      desiredIdleMs,
    }));

    // Hot-spare fast path: try to promote a pre-created candidate sandbox.
    // If promotion succeeds, skip the normal get/create flow entirely.
    // Gated — no-op when OPENCLAW_HOT_SPARE_ENABLED is not "true".
    const unhealthyResumeStatuses = new Set<string>([
      "failed",
      "error",
      "aborted",
      "stopped",
    ]);
    const metaOwnsBundleCandidate = (
      meta: SingleMeta,
      handle: SandboxHandle,
    ): boolean =>
      sameBundleCandidate(meta.bundleCandidate, activeBundleCandidate)
      && activeBundleCandidate !== null
      && candidateMatchesHandle(
        meta.bundleCandidate,
        activeBundleCandidate.lookupId,
        handle,
      );

    const assertAcquiredSandboxOwnership = async (
      handle: SandboxHandle,
    ): Promise<void> => {
      await options?.lease?.assertOwned();
      const latest = await getInitializedMeta();
      if (
        latest.lifecycleAttemptId !== attemptId
        || (
          bundleMode
          && sandboxIsBundleCandidate
          && !metaOwnsBundleCandidate(latest, handle)
        )
      ) {
        throw new LifecycleLockOwnershipLostError();
      }
    };

    const assertSandboxGenerationOwnership = async (
      handle: SandboxHandle,
      requireBundleCandidate: boolean,
    ): Promise<void> => {
      await options?.lease?.assertOwned();
      const latest = await getInitializedMeta();
      const candidateOwned = !requireBundleCandidate
        || metaOwnsBundleCandidate(latest, handle);
      if (
        latest.lifecycleAttemptId !== attemptId
        || latest.sandboxId !== handle.sandboxId
        || !candidateOwned
      ) {
        throw new LifecycleLockOwnershipLostError();
      }
    };

    const persistBundleCandidateHandle = async (
      lookupId: string,
      handle: SandboxHandle,
    ): Promise<void> => {
      const candidateOwner = activeBundleCandidate?.ownershipToken;
      if (
        !candidateOwner
        || handle.tags?.[BUNDLE_CANDIDATE_OWNERSHIP_TAG] !== candidateOwner
      ) {
        throw new Error("Created sandbox did not preserve its bundle ownership tag.");
      }
      const next = await mutateMeta((meta) => {
        if (meta.lifecycleAttemptId !== attemptId) return;
        meta.bundleCandidate = {
          lookupId,
          sandboxId: handle.sandboxId,
          ownershipToken: candidateOwner,
          replacesOwnershipToken: null,
          lifecycleAttemptId: attemptId,
          createdAt: meta.bundleCandidate?.createdAt ?? Date.now(),
        };
      });
      if (
        next.bundleCandidate?.lifecycleAttemptId !== attemptId
        || !candidateMatchesHandle(next.bundleCandidate, lookupId, handle)
      ) {
        throw new LifecycleLockOwnershipLostError();
      }
      activeBundleCandidate = next.bundleCandidate;
    };

    const createPersistentSandbox = async (
      conflictMode: "resume" | "replace",
      rotateOwnership = false,
    ): Promise<{
      handle: SandboxHandle;
      bundleCandidate: boolean;
      created: boolean;
      replaceBeforeBootstrap: boolean;
    }> => {
      const persistBundleCandidateIntent = async (
        replaceCurrentOwnership: boolean,
      ): Promise<void> => {
        const intent = await mutateMeta((meta) => {
          if (meta.lifecycleAttemptId !== attemptId) return;
          const replacedOwner = replaceCurrentOwnership
            && meta.bundleCandidate?.lookupId === sandboxName
            ? meta.bundleCandidate.ownershipToken
            : null;
          meta.bundleCandidate = {
            lookupId: sandboxName,
            sandboxId: null,
            ownershipToken: randomUUID(),
            replacesOwnershipToken: replacedOwner,
            lifecycleAttemptId: attemptId,
            createdAt: Date.now(),
          };
        });
        if (intent.bundleCandidate?.lifecycleAttemptId !== attemptId) {
          throw new LifecycleLockOwnershipLostError();
        }
        activeBundleCandidate = intent.bundleCandidate;
      };

      if (
        bundleMode
        && (
          activeBundleCandidate?.lookupId !== sandboxName
          || rotateOwnership
        )
      ) {
        await persistBundleCandidateIntent(rotateOwnership);
      }

      const create = async (): Promise<SandboxHandle> => {
        const candidateOwner = activeBundleCandidate?.ownershipToken;
        if (bundleMode && !candidateOwner) {
          throw new Error("Bundle candidate ownership intent is missing.");
        }
        const runtimeEnv = await buildRuntimeEnv();
        if (bundleMode) {
          await assertCandidateIntentOwnership();
        } else {
          await options?.lease?.assertOwned();
        }
        await assertLifecycleGuardCurrent(options?.lifecycleGuard);
        const handle = await getSandboxController().create({
          name: sandboxName,
          persistent: true,
          ports: SANDBOX_PORTS,
          timeout: sleepAfterMs,
          resources: { vcpus },
          networkPolicy: toNetworkPolicy(
            current.firewall.mode,
            current.firewall.allowlist,
            credential?.token,
            requiredControlPlaneDomains(current, origin),
          ),
          ...runtimeEnv,
          ...(candidateOwner
            ? { tags: { [BUNDLE_CANDIDATE_OWNERSHIP_TAG]: candidateOwner } }
            : {}),
        });
        if (bundleMode) {
          await persistBundleCandidateHandle(sandboxName, handle);
        }
        return handle;
      };

      try {
        return {
          handle: await create(),
          bundleCandidate: bundleMode,
          created: true,
          replaceBeforeBootstrap: false,
        };
      } catch (createErr) {
        const apiJson = (createErr as { json?: unknown }).json;
        const status = sandboxApiStatus(createErr);
        if (status !== 409) {
          logError("sandbox.create.failed", ctx({
            sandboxName,
            error: createErr instanceof Error ? createErr.message : String(createErr),
            ...(apiJson ? { apiJson } : {}),
          }));
          progress.appendLine(
            "system",
            `Create failed: ${createErr instanceof Error ? createErr.message : String(createErr)}`,
          );
          throw createErr;
        }

        logWarn("sandbox.create.name_conflict_recovery", ctx({
          sandboxName,
          error: createErr instanceof Error ? createErr.message : String(createErr),
          ...(apiJson ? { apiJson } : {}),
        }));
        progress.appendLine(
          "system",
          `Create 409 — recovering ${sandboxName}`,
        );

        if (conflictMode === "resume") {
          try {
            await assertLifecycleGuardCurrent(options?.lifecycleGuard);
            const recovered = await getSandboxController().get({
              sandboxId: sandboxName,
              resume: false,
            });
            const interruptedBundleCandidate = bundleMode
              && candidateAuthorizesCleanup(
                activeBundleCandidate,
                sandboxName,
                recovered,
              );
            if (
              !bundleMode
              &&
              !interruptedBundleCandidate
              && unhealthyResumeStatuses.has(recovered.status)
            ) {
              throw new Error(
                `name_conflict_resume_unhealthy_handle:${recovered.status}:${recovered.sandboxId}`,
              );
            }
            progress.appendLine(
              "system",
              `Recovered: ${recovered.sandboxId} status=${recovered.status}`,
            );
            return {
              handle: recovered,
              bundleCandidate: interruptedBundleCandidate,
              created: false,
              replaceBeforeBootstrap: interruptedBundleCandidate,
            };
          } catch (getErr) {
            if (getErr instanceof SandboxLifecycleGuardRejectedError) {
              throw getErr;
            }
            logError("sandbox.create.name_conflict_get_fallback_failed", ctx({
              sandboxName,
              error: getErr instanceof Error ? getErr.message : String(getErr),
            }));
            progress.appendLine(
              "system",
              `Get fallback failed: ${getErr instanceof Error ? getErr.message : String(getErr)}`,
            );
            throw createErr;
          }
        }

        // Replacement is authorized only by the durable candidate record.
        // Keep that record until a fresh create returns and atomically swaps it.
        let conflicting: SandboxHandle | null = null;
        try {
          conflicting = await getSandboxController().get({
            sandboxId: sandboxName,
            resume: false,
          });
        } catch (getOrDeleteErr) {
          if (isSandboxGoneError(getOrDeleteErr)) {
            conflicting = null;
          } else {
            logWarn("sandbox.create.name_conflict_replacement_lookup_failed", ctx({
              sandboxName,
              error:
                getOrDeleteErr instanceof Error
                  ? getOrDeleteErr.message
                  : String(getOrDeleteErr),
            }));
            throw createErr;
          }
        }

        if (conflicting) {
          const conflictHandle = conflicting;
          const ownsConflict = bundleMode
            && candidateAuthorizesCleanup(
              activeBundleCandidate,
              sandboxName,
              conflicting,
            );
          if (!ownsConflict) {
            return {
              handle: conflicting,
              bundleCandidate: false,
              created: false,
              replaceBeforeBootstrap: false,
            };
          }
          const deletesCurrentOwnership = candidateMatchesHandle(
            activeBundleCandidate,
            sandboxName,
            conflicting,
          );
          try {
            await assertCandidateDeleteOwnership(sandboxName, conflicting);
            await conflicting.delete();
          } catch (getOrDeleteErr) {
            if (isSandboxGoneError(getOrDeleteErr)) {
              conflicting = null;
            } else {
              logWarn("sandbox.create.name_conflict_replacement_cleanup_failed", ctx({
                sandboxName,
                error:
                  getOrDeleteErr instanceof Error
                    ? getOrDeleteErr.message
                    : String(getOrDeleteErr),
              }));
              throw getOrDeleteErr;
            }
          }
          await assertCandidateDeleteOwnership(sandboxName, conflictHandle);
          if (deletesCurrentOwnership) {
            await persistBundleCandidateIntent(true);
          }
        }

        try {
          return {
            handle: await create(),
            bundleCandidate: bundleMode,
            created: true,
            replaceBeforeBootstrap: false,
          };
        } catch (retryErr) {
          logError("sandbox.create.name_conflict_replacement_failed", ctx({
            sandboxName,
            error: retryErr instanceof Error ? retryErr.message : String(retryErr),
          }));
          progress.appendLine(
            "system",
            `Replacement create failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
          );
          throw retryErr;
        }
      }
    };

    // Recover a prior uncommitted candidate before consulting any other
    // sandbox. Its lookup ID survives a lost create response or hot-spare
    // promotion, while the optional actual ID prevents adopting a replacement.
    if (bundleMode && activeBundleCandidate) {
      try {
        const recoveredCandidate = await getSandboxController().get({
          sandboxId: activeBundleCandidate.lookupId,
          resume: false,
        });
        sandbox = recoveredCandidate;
        sandboxIsBundleCandidate = candidateAuthorizesCleanup(
          activeBundleCandidate,
          activeBundleCandidate.lookupId,
          recoveredCandidate,
        );
        sandboxNeedsCandidateReplacement = sandboxIsBundleCandidate;
      } catch (error) {
        if (!isSandboxGoneError(error)) throw error;
        // A named create can be visible after a transient 404. Keep its
        // durable intent until the replacement POST retargets or commits it.
        logInfo("sandbox.create.bundle_candidate_temporarily_missing", ctx({
          lookupId: activeBundleCandidate.lookupId,
        }));
      }
    }

    if (!sandbox && bundleMode && isHotSpareEnabled()) {
      logWarn("sandbox.create.hot_spare_bundle_disabled", ctx({
        reason: "persistent-name-and-bundle-identity-not-preserved",
      }));
    }
    if (!sandbox && !bundleMode && isHotSpareEnabled()) {
      try {
        await assertLifecycleGuardCurrent(options?.lifecycleGuard);
        const promoteResult = await promoteHotSpare(current, {
          get: (opts) => getSandboxController().get(opts),
        });
        if (promoteResult.status === "promoted" && promoteResult.promotedSandboxId) {
          const promotedLookupId = promoteResult.promotedSandboxId;
          const promoted = await getSandboxController().get({
            sandboxId: promotedLookupId,
          });
          await assertLifecycleGuardCurrent(options?.lifecycleGuard);
          await mutateMeta((meta) => applyPromoteToMeta(meta, promoteResult));
          sandbox = promoted;
          sandboxIsBundleCandidate = false;
          sandboxNeedsCandidateReplacement = false;
          progress.appendLine("system", `Hot-spare promoted: ${promoted.sandboxId}`);
          logInfo("sandbox.create.hot_spare_promoted", ctx({
            promotedSandboxId: promoted.sandboxId,
          }));
        } else if (promoteResult.status === "failed") {
          // Promotion failed — clear stale hot-spare state and fall through.
          await mutateMeta((m) => clearHotSpareState(m));
          logInfo("sandbox.create.hot_spare_fallback", ctx({
            error: promoteResult.error,
          }));
        }
      } catch (err) {
        if (err instanceof SandboxLifecycleGuardRejectedError) {
          throw err;
        }
        logWarn("sandbox.create.hot_spare_promote_error", ctx({
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    }

    // Normal path: get() retrieves and resumes the persistent sandbox handle.
    // Fall back to create() only if the sandbox doesn't exist yet, or if the
    // platform returns a handle that cannot be used for immediate commands.
    if (!sandbox) {
    try {
      progress.appendLine("system", `Resuming persistent sandbox: ${sandboxName}`);
      await assertLifecycleGuardCurrent(options?.lifecycleGuard);
      const resumedHandle = await getSandboxController().get({
        sandboxId: sandboxName,
        resume: !bundleMode && !persistedRuntimeModeMismatch,
      });
      await assertLifecycleGuardCurrent(options?.lifecycleGuard);
      const resumedBundleCandidate = bundleMode
        && candidateAuthorizesCleanup(
          activeBundleCandidate,
          sandboxName,
          resumedHandle,
        );
      sandbox = resumedHandle;
      sandboxIsBundleCandidate = resumedBundleCandidate;
      sandboxNeedsCandidateReplacement = resumedBundleCandidate;
      // Reject unhealthy statuses that @vercel/sandbox will happily return
      // from get(). The SDK wraps any existing sandbox — including ones that
      // failed to boot, were aborted, or remain stopped after an explicit
      // resume request — and returning that handle to the resume flow causes
      // every subsequent runCommand to hang or error out, which the caller
      // sees as a 120s "sandbox did not become ready" timeout. Treat these as
      // "no existing sandbox" so the catch branch creates a fresh one.
      // Best-effort delete first to release the
      // persistent name; ignore failures (the name is already bound to a
      // dead handle and create-by-name will 409 and get()-fallback if the
      // delete didn't take).
      if (
        !bundleMode
        &&
        !resumedBundleCandidate
        && unhealthyResumeStatuses.has(resumedHandle.status)
      ) {
        logWarn("sandbox.create.resume_unhealthy_handle", ctx({
          sandboxId: resumedHandle.sandboxId,
          sandboxStatus: resumedHandle.status,
          sandboxName,
        }));
        progress.appendLine(
          "system",
          `Discarding unhealthy sandbox ${resumedHandle.sandboxId} (status=${resumedHandle.status}) — forcing fresh create`,
        );
        try {
          await assertLifecycleGuardCurrent(options?.lifecycleGuard);
          await resumedHandle.delete();
        } catch (deleteErr) {
          logWarn("sandbox.create.resume_unhealthy_delete_failed", ctx({
            sandboxId: resumedHandle.sandboxId,
            error: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
          }));
        }
        throw new Error(
          `resume_unhealthy_handle:${resumedHandle.status}:${resumedHandle.sandboxId}`,
        );
      }
      progress.appendLine(
        "system",
        `Resumed: ${resumedHandle.sandboxId} status=${resumedHandle.status}`,
      );
    } catch (resumeError) {
      if (
        resumeError instanceof SandboxLifecycleGuardRejectedError
        ||
        resumeError instanceof SandboxBundleMigrationRequiredError
        || resumeError instanceof ApiError
      ) {
        throw resumeError;
      }
      // Only a definitive platform absence authorizes a named create. A
      // transient lookup failure could hide existing user state; stamping an
      // intent then would falsely make that state deletable on the next retry.
      if (bundleMode && !isSandboxGoneError(resumeError)) {
        throw resumeError;
      }
      if (isRestoreAttempt) {
        progress.setPhase("creating-sandbox", "Creating sandbox");
        progress.setPreview("Allocating sandbox");
        await mutateMeta((meta) => {
          meta.status = "creating";
          meta.snapshotId = null;
          meta.snapshotConfigHash = null;
          meta.snapshotDynamicConfigHash = null;
          meta.snapshotAssetSha256 = null;
          meta.persistedStateDynamicConfigHash = null;
          meta.persistedStateAssetSha256 = null;
          meta.persistedStateSavedAt = null;
          meta.persistedStateSource = null;
          meta.restorePreparedStatus = "dirty";
          meta.restorePreparedReason = "snapshot-missing";
          meta.restorePreparedAt = null;
        });
      }
      progress.appendLine("system", `No existing sandbox — creating: ${sandboxName}`);
      const createResult = await createPersistentSandbox("resume");
      sandbox = createResult.handle;
      sandboxIsBundleCandidate = createResult.bundleCandidate;
      sandboxNeedsCandidateReplacement = createResult.replaceBeforeBootstrap;
      await assertLifecycleGuardCurrent(options?.lifecycleGuard);
      if (createResult.created) {
        progress.appendLine("system", `Created: ${sandbox.sandboxId}`);
      }
    }
    } // end if (!sandbox)

    if (
      bundleMode
      && sandboxNeedsCandidateReplacement
      && sandbox
    ) {
      // The previous attempt never committed a verified receipt to host
      // metadata. Delete its candidate instead of misclassifying it as
      // user state that needs an explicit migration.
      const interruptedSandboxId = sandbox.sandboxId;
      const interruptedLookupId = activeBundleCandidate?.lookupId;
      if (!interruptedLookupId) {
        throw new LifecycleLockOwnershipLostError();
      }
      try {
        await assertCandidateDeleteOwnership(interruptedLookupId, sandbox);
        await sandbox.delete();
      } catch (error) {
        if (!isSandboxGoneError(error)) {
          throw new ApiError(
            502,
            "OPENCLAW_BUNDLE_CANDIDATE_CLEANUP_FAILED",
            `Failed to delete interrupted bundle candidate ${interruptedSandboxId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      await assertCandidateDeleteOwnership(interruptedLookupId, sandbox);
      sandbox = undefined;
      sandboxIsBundleCandidate = false;
      sandboxNeedsCandidateReplacement = false;
      const replacement = await createPersistentSandbox("replace", true);
      sandbox = replacement.handle;
      sandboxIsBundleCandidate = replacement.bundleCandidate;
      sandboxNeedsCandidateReplacement = replacement.replaceBeforeBootstrap;
      progress.appendLine("system", `Replaced interrupted candidate: ${sandbox.sandboxId}`);
    }

    if (!sandbox) {
      throw new Error("Sandbox acquisition completed without a handle.");
    }
    if (
      !sandboxIsBundleCandidate
      && (bundleMode || persistedRuntimeModeMismatch)
    ) {
      const persistedSandbox = sandbox;
      if (!bundleMode || !storedBundleIdentityAdmitted) {
        const migrationOwner = await mutateMeta((meta) => {
          if (meta.lifecycleAttemptId !== attemptId) return;
          meta.sandboxId = persistedSandbox.sandboxId;
          meta.portUrls = null;
        });
        if (
          migrationOwner.lifecycleAttemptId !== attemptId
          || migrationOwner.sandboxId !== persistedSandbox.sandboxId
        ) throw new LifecycleLockOwnershipLostError();

        if (persistedSandbox.status !== "running") {
          const migrationMeta = await mutateMeta((meta) => {
            if (
              meta.lifecycleAttemptId !== attemptId
              || meta.sandboxId !== persistedSandbox.sandboxId
            ) return;
            meta.status = "error";
            meta.lastError = BUNDLE_MIGRATION_REQUIRED_LAST_ERROR;
            meta.lastGatewayProbeReady = false;
          });
          if (
            migrationMeta.status !== "error"
            || !stableBundleReadyFailure(migrationMeta.lastError)
          ) throw new LifecycleLockOwnershipLostError();
          throw new SandboxBundleMigrationRequiredError();
        }

        const quiesced = await quiesceSandboxForBundleMigration({
          sandbox: persistedSandbox,
          lifecycleAttemptId: attemptId,
          lease: options?.lease,
        });
        if (!quiesced) {
          progress.appendLine(
            "system",
            "Bundle migration stop is still reconciling in the background",
          );
          return getInitializedMeta();
        }
        throw new SandboxBundleMigrationRequiredError();
      }

      if (persistedSandbox.status === "stopped") {
        await assertAcquiredSandboxOwnership(persistedSandbox);
        await assertLifecycleGuardCurrent(options?.lifecycleGuard);
        const resumed = await getSandboxController().get({
          sandboxId: persistedSandbox.sandboxId,
          resume: true,
        });
        await assertAcquiredSandboxOwnership(resumed);
        await assertLifecycleGuardCurrent(options?.lifecycleGuard);
        if (resumed.status !== "running") {
          throw new ApiError(
            503,
            "SANDBOX_RESUME_NOT_RUNNING",
            `Sandbox resume returned status ${resumed.status}.`,
          );
        }
        sandbox = resumed;
      } else if (persistedSandbox.status !== "running") {
        const migrationMeta = await mutateMeta((meta) => {
          if (meta.lifecycleAttemptId !== attemptId) return;
          meta.status = "error";
          meta.sandboxId = persistedSandbox.sandboxId;
          meta.portUrls = null;
          meta.lastError = BUNDLE_MIGRATION_REQUIRED_LAST_ERROR;
          meta.lastGatewayProbeReady = false;
        });
        if (
          migrationMeta.status !== "error"
          || !stableBundleReadyFailure(migrationMeta.lastError)
        ) throw new LifecycleLockOwnershipLostError();
        throw new SandboxBundleMigrationRequiredError();
      }
    }
    const initialSandbox = sandbox;
    // A persisted sandbox may have been created before the durable stop
    // coordinator added its safety runway. Establish the current platform
    // deadline before running restore/setup commands.
    const currentRemainingMs = initialSandbox.timeoutRemaining;
    const timeoutExtensionMs = getSandboxTimeoutExtensionMs({
      currentTotalMs: initialSandbox.timeout,
      currentRemainingMs,
      targetRemainingMs: sleepAfterMs,
    });
    if (timeoutExtensionMs > 0) {
      await assertAcquiredSandboxOwnership(initialSandbox);
      await initialSandbox.extendTimeout(timeoutExtensionMs);
    }

    logInfo("sandbox.status_transition", ctx({ from: "creating", to: "setup", sandboxId: initialSandbox.sandboxId, sandboxStatus: initialSandbox.status, vcpus, sleepAfterMs }));
    await assertAcquiredSandboxOwnership(initialSandbox);
    const setupMeta = await mutateMeta((meta) => {
      if (
        meta.lifecycleAttemptId !== attemptId
        || (
          bundleMode
          && sandboxIsBundleCandidate
          && !metaOwnsBundleCandidate(meta, initialSandbox)
        )
      ) return;
      meta.status = "setup";
      meta.sandboxId = initialSandbox.sandboxId;
      meta.portUrls = resolvePortUrls(initialSandbox);
      meta.lastAccessedAt = Date.now();
    });
    if (
      setupMeta.lifecycleAttemptId !== attemptId
      || setupMeta.sandboxId !== initialSandbox.sandboxId
      || setupMeta.status !== "setup"
    ) {
      throw new LifecycleLockOwnershipLostError();
    }

    let isResumed: boolean;
    let verifiedBundleCapabilities: readonly string[] = [];
    if (process.env.OPENCLAW_BUNDLE_URL?.trim()) {
      const latest = await getInitializedMeta();
      const currentIdentity = matchesConfiguredBundleIdentity(
        latest.bundleIdentity,
      )
        ? latest.bundleIdentity
        : null;
      verifiedBundleCapabilities = currentIdentity?.capabilities ?? [];
      let markerIdentity: unknown = null;
      let markerPresent = false;
      try {
        const markerResult = await sandbox.runCommand("bash", [
          "-c",
          `test -f ${JSON.stringify(OPENCLAW_BUNDLE_IDENTITY_PATH)} && cat ${JSON.stringify(OPENCLAW_BUNDLE_IDENTITY_PATH)}`,
        ]);
        if (markerResult.exitCode === 0) {
          markerIdentity = JSON.parse(await markerResult.output("stdout"));
          markerPresent = true;
        }
      } catch {
        // An unreadable marker cannot authorize reuse. Replace this sandbox
        // below rather than retrying against unknown partial bundle state.
      }
      isResumed = Boolean(
        currentIdentity &&
        isVerifiedBundleIdentity(markerIdentity) &&
        verifiedBundleIdentitiesEqual(markerIdentity, currentIdentity),
      );

      if (isResumed && currentIdentity) {
        const admission = await admitConfiguredOpenClawBundle();
        if (
          !admission
          || !verifiedBundleIdentitiesEqual(admission.identity, currentIdentity)
        ) {
          throw new Error(
            "Configured bundle admission changed during persistent resume.",
          );
        }
        progress.setPhase(
          "resuming-sandbox",
          "Verifying persisted OpenClaw bundle bytes",
        );
        await assertSandboxGenerationOwnership(sandbox, false);
        await verifyPersistedVerifiedBundleRuntime(
          sandbox,
          admission,
          progress,
        );
        await assertSandboxGenerationOwnership(sandbox, false);
      }

      // The receipt is written last, after digest checks, external plugin
      // installation, and exact runtime version admission. Existing state
      // without that identity must be migrated or explicitly reset.
      if (!isResumed && !sandboxIsBundleCandidate) {
        const mismatchedSandbox = sandbox;
        logWarn("sandbox.create.bundle_identity_mismatch", ctx({
          sandboxId: mismatchedSandbox.sandboxId,
          markerPresent,
          persistedIdentityPresent: latest.bundleIdentity !== null,
        }));
        progress.appendLine(
          "system",
          "Bundle identity missing or stale — explicit migration or reset required",
        );
        await assertSandboxGenerationOwnership(mismatchedSandbox, false);
        const quiesced = await quiesceSandboxForBundleMigration({
          sandbox: mismatchedSandbox,
          lifecycleAttemptId: attemptId,
          lease: options?.lease,
        });
        if (!quiesced) {
          progress.appendLine(
            "system",
            "Bundle migration stop is still reconciling in the background",
          );
          return getInitializedMeta();
        }
        await assertSandboxGenerationOwnership(mismatchedSandbox, false);
        const migrationMeta = await mutateMeta((meta) => {
          if (meta.lifecycleAttemptId !== attemptId) return;
          meta.status = "error";
          meta.sandboxId = mismatchedSandbox.sandboxId;
          meta.portUrls = null;
          meta.lastAccessedAt = current.lastAccessedAt;
          meta.lastError = BUNDLE_MIGRATION_REQUIRED_LAST_ERROR;
          meta.lifecycleAttemptId = current.lifecycleAttemptId;
          meta.bundleIdentity = current.bundleIdentity;
          meta.bundleCandidate = activeBundleCandidate;
        });
        if (
          migrationMeta.status !== "error"
          || migrationMeta.sandboxId !== mismatchedSandbox.sandboxId
          || !stableBundleReadyFailure(migrationMeta.lastError)
        ) {
          throw new LifecycleLockOwnershipLostError();
        }
        throw new SandboxBundleMigrationRequiredError();
      }
    } else {
      // NOTE: This command is the implicit resume trigger for stopped npm
      // sandboxes. Bundle mode deliberately uses the receipt path above.
      const whichCheck = await sandbox.runCommand("bash", [
        "-c",
        `test -x "$(command -v ${OPENCLAW_BIN} 2>/dev/null)" && echo yes || echo no`,
      ]);
      isResumed = (await whichCheck.output("stdout")).trim() === "yes";
    }
    progress.appendLine("system", isResumed ? "Persistent sandbox resumed" : "Fresh sandbox");

    if (isResumed) {
      // Resumed persistent sandbox — run fast restore (update config/tokens, restart gateway)
      const resumeStart = Date.now();
      logInfo("sandbox.create.persistent_resume", ctx({ sandboxId: sandbox.sandboxId }));
      progress.setPhase("resuming-sandbox", "Resuming persistent sandbox");
      progress.appendLine("system", "Resumed persistent sandbox — running fast restore");

      const latest = await getInitializedMeta();
      const freshApiKey = credential?.token;

      const restoreEnv = buildRestoreRuntimeEnv({
        gatewayToken: latest.gatewayToken,
        apiKey: freshApiKey,
      });

      // A resumed scheduler can observe past-due jobs as soon as Gateway
      // starts. Install the fresh credential transform before that boundary.
      const firewallStart = Date.now();
      try {
        await assertSandboxGenerationOwnership(
          initialSandbox,
          bundleMode && sandboxIsBundleCandidate,
        );
        progress.setPhase(
          "applying-firewall",
          `Applying ${latest.firewall.mode} firewall policy`,
        );
        await applyFirewallPolicyToSandbox(
          sandbox,
          latest,
          freshApiKey,
          requiredControlPlaneDomains(latest, origin),
        );
        await assertSandboxGenerationOwnership(
          initialSandbox,
          bundleMode && sandboxIsBundleCandidate,
        );
      } catch (err) {
        const firewallError = err instanceof Error ? err.message : String(err);
        logWarn("sandbox.create.persistent_resume.firewall_sync_failed", ctx({
          sandboxId: sandbox.sandboxId,
          mode: latest.firewall.mode,
          error: firewallError,
        }));
        if (latest.firewall.mode === "enforcing") {
          throw new Error(
            `Firewall sync failed during persistent resume: ${firewallError}`,
          );
        }
      }
      const firewallSyncMs = Date.now() - firewallStart;

      const assetSyncStart = Date.now();
      const slackConfig = latest.channels.slack;
      const tg = latest.channels.telegram;
      const validatedSlackCreds = await validateSlackCredentialsForRestore(slackConfig);
      await syncRestoreAssetsIfNeeded(sandbox, {
        origin,
        telegramBotToken: tg?.botToken,
        telegramWebhookSecret: tg?.webhookSecret,
        slackCredentials: validatedSlackCreds ?? undefined,
        bundleCapabilities: verifiedBundleCapabilities,
      });
      const assetSyncMs = Date.now() - assetSyncStart;

      progress.setPhase("starting-gateway", "Running fast restore script");
      const READINESS_TIMEOUT_SECONDS = 30;

      // Defensive pre-step: clear gateway lockfiles whose owner PID is dead.
      // The bundle's fast-restore.sh acquires a lock that can be left over
      // from a previous VM after snapshot/warm-restore. The PID inside is
      // dead in the new sandbox, but the lock-acquisition still waits ~5s
      // for that "owner" before giving up — leaving the gateway un-started
      // and the Slack workflow showing "Verifying config…" until it hits
      // its 120s readiness timeout. Best-effort; never fails the restore.
      try {
        await sandbox.runCommand("bash", [
          "-c",
          `set +e\n${buildClearStaleGatewayLockShell()}\nexit 0`,
        ]);
      } catch (lockClearError) {
        logWarn("sandbox.restore.stale_lock_pre_clear_failed", {
          error:
            lockClearError instanceof Error
              ? lockClearError.message
              : String(lockClearError),
        });
      }

      const fastRestoreStart = Date.now();
      await assertLifecycleGuardCurrent(options?.lifecycleGuard);
      await assertSandboxGenerationOwnership(
        initialSandbox,
        bundleMode && sandboxIsBundleCandidate,
      );
      const runFastRestore = (phase: "all" | "kill" | "start") =>
        initialSandbox.runCommand({
          cmd: "bash",
          args: [
            OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
            String(READINESS_TIMEOUT_SECONDS),
            phase,
          ],
          env: restoreEnv,
        });
      const replacementSuspension = await readHostSuspensionState();
      const replacesSuspendedGateway = Boolean(
        replacementSuspension?.ingressFenced
        && replacementSuspension.sandboxId === initialSandbox.sandboxId
        && (
          replacementSuspension.phase === "stopped"
          || replacementSuspension.phase === "rollback-pending"
        )
      );
      let retiredGatewaySuspension = false;
      const restoreResult = await (async () => {
        if (!replacesSuspendedGateway || !replacementSuspension) {
          return runFastRestore("all");
        }
        const killResult = await runFastRestore("kill");
        if (killResult.exitCode !== 0) {
          const output = await killResult.output("both");
          throw new CommandFailedError({
            command: "fast-restore-kill",
            exitCode: killResult.exitCode,
            output,
          });
        }
        await assertLifecycleGuardCurrent(options?.lifecycleGuard);
        await assertSandboxGenerationOwnership(
          initialSandbox,
          bundleMode && sandboxIsBundleCandidate,
        );
        retiredGatewaySuspension = await clearHostSuspensionAfterGatewayReplacement({
          expected: replacementSuspension,
          sandboxId: initialSandbox.sandboxId,
          lifecycleAttemptId: attemptId,
        });
        if (!retiredGatewaySuspension) {
          throw new LifecycleLockOwnershipLostError();
        }
        await options?.lease?.assertOwned();
        await assertLifecycleGuardCurrent(options?.lifecycleGuard);
        await assertSandboxGenerationOwnership(
          initialSandbox,
          bundleMode && sandboxIsBundleCandidate,
        );
        return runFastRestore("start");
      })();
      await assertLifecycleGuardCurrent(options?.lifecycleGuard);
      const startupScriptMs = Date.now() - fastRestoreStart;

      if (restoreResult.exitCode !== 0) {
        const output = await restoreResult.output("both");
        throw new CommandFailedError({
          command: "fast-restore-script",
          exitCode: restoreResult.exitCode,
          output,
        });
      }

      // Parse readiness timing from fast-restore script stdout.
      let localReadyMs = startupScriptMs;
      let telegramExpected = false;
      let telegramConfigPresent = false;
      let telegramListenerReady = false;
      let telegramListenerStatus: number | null = null;
      let telegramListenerWaitMs: number | null = null;
      let telegramListenerError: string | null = null;
      const telegramReconcileMs: number | null = null;
      const telegramSecretSyncMs: number | null = null;
      const telegramReconcileBlocking = false;
      const telegramSecretSyncBlocking = false;
      try {
        const stdout = await restoreResult.output("stdout");
        const parsed = JSON.parse(stdout.trim()) as {
          readyMs?: number;
          telegramExpected?: boolean;
          telegramConfigPresent?: boolean;
          telegramReady?: boolean;
          telegramStatus?: number | null;
          telegramWaitMs?: number | null;
          telegramError?: string | null;
        };
        if (typeof parsed.readyMs === "number") localReadyMs = parsed.readyMs;
        telegramExpected = parsed.telegramExpected === true;
        telegramConfigPresent = parsed.telegramConfigPresent === true;
        telegramListenerReady = parsed.telegramReady === true;
        telegramListenerStatus =
          typeof parsed.telegramStatus === "number" ? parsed.telegramStatus : null;
        telegramListenerWaitMs =
          typeof parsed.telegramWaitMs === "number" ? parsed.telegramWaitMs : null;
        telegramListenerError =
          typeof parsed.telegramError === "string" ? parsed.telegramError : null;
      } catch { /* best effort */ }

      const sandboxResumeMs = Date.now() - resumeStart - assetSyncMs - startupScriptMs - firewallSyncMs;
      const totalMs = Date.now() - resumeStart;
      const postLocalReadyBlockingMs =
        localReadyMs > 0 ? Math.max(0, totalMs - localReadyMs) : totalMs;

      const metrics: RestorePhaseMetrics = {
        sandboxCreateMs: sandboxResumeMs,
        tokenWriteMs: 0,
        assetSyncMs,
        startupScriptMs,
        forcePairMs: 0,
        firewallSyncMs,
        localReadyMs,
        postLocalReadyBlockingMs,
        publicReadyMs: 0,
        totalMs,
        skippedStaticAssetSync: false,
        assetSha256: null,
        vcpus,
        recordedAt: Date.now(),
        skippedPublicReady: true,
        telegramExpected,
        telegramConfigPresent,
        telegramListenerReady,
        telegramListenerStatus,
        telegramListenerWaitMs,
        telegramListenerError,
        telegramReconcileBlocking,
        telegramReconcileMs,
        telegramSecretSyncBlocking,
        telegramSecretSyncMs,
      };

      // Gateway admission must resume before host ingress sees this restored
      // sandbox as running. A replacement sandbox clears the old process-local
      // suspension; a resumed sandbox releases the persisted lease explicitly.
      await assertSandboxGenerationOwnership(
        initialSandbox,
        bundleMode && sandboxIsBundleCandidate,
      );
      if (
        !retiredGatewaySuspension
        && !await thawHostSuspensionIfNeeded({
          sandbox,
          lifecycleAttemptId: attemptId,
        })
      ) {
        throw new Error("Restored sandbox Gateway admission could not be resumed.");
      }
      await assertSandboxGenerationOwnership(
        initialSandbox,
        bundleMode && sandboxIsBundleCandidate,
      );

      // Record token metadata and restore metrics.
      await assertLifecycleGuardCurrent(options?.lifecycleGuard);
      await assertSandboxGenerationOwnership(
        initialSandbox,
        bundleMode && sandboxIsBundleCandidate,
      );
      const resumedMeta = await mutateMeta((meta) => {
        if (
          meta.lifecycleAttemptId !== attemptId
          || meta.sandboxId !== initialSandbox.sandboxId
          || (
            bundleMode
            && sandboxIsBundleCandidate
            && !metaOwnsBundleCandidate(meta, initialSandbox)
          )
        ) return;
        meta.status = "running";
        meta.sandboxId = initialSandbox.sandboxId;
        meta.portUrls = resolvePortUrls(initialSandbox);
        meta.bundleCandidate = null;
        meta.lastAccessedAt = Date.now();
        meta.lastError = null;
        meta.lastRestoreMetrics = metrics;
        if (!meta.restoreHistory) meta.restoreHistory = [];
        meta.restoreHistory = [
          metrics,
          ...meta.restoreHistory.slice(0, 19),
        ];
        if (credential) {
          meta.lastTokenRefreshAt = Date.now();
          meta.lastTokenSource = credential.source;
          meta.lastTokenExpiresAt = credential.expiresAt ?? null;
        }
      });
      if (
        resumedMeta.lifecycleAttemptId !== attemptId
        || resumedMeta.sandboxId !== initialSandbox.sandboxId
        || resumedMeta.status !== "running"
        || (bundleMode && resumedMeta.bundleCandidate !== null)
      ) {
        throw new LifecycleLockOwnershipLostError();
      }
      // The verified sandbox receipt and host identity are committed by the
      // running-state CAS. Later deadline/progress failures must not delete it.
      bundleCandidateCommitted = !bundleMode || resumedMeta.bundleIdentity !== null;
      await armSandboxDeadline(resumedMeta, undefined, {
        nativeTimeoutRemainingMs: sandbox.timeoutRemaining,
      });
      await progress.completeSetupProgress("Sandbox resumed");

      logInfo("sandbox.create.persistent_resume.complete", ctx({
        sandboxId: initialSandbox.sandboxId,
        totalMs,
        assetSyncMs,
        startupScriptMs,
        firewallSyncMs,
        localReadyMs,
        telegramExpected,
        telegramConfigPresent,
        telegramListenerReady,
        telegramListenerStatus,
        telegramListenerWaitMs,
        telegramListenerError,
      }));
      return getInitializedMeta();
    }

    // Fresh sandbox — run full bootstrap
    const latest = await getInitializedMeta();
    if (
      process.env.OPENCLAW_BUNDLE_URL?.trim() &&
      (await getStore().hasValue(cronJobsKey()))
    ) {
      // The old host backup may be the last recoverable cron authority after
      // a missing/unhealthy npm sandbox. Do not let an empty bundle baseline
      // erase it before OpenClaw owns and verifies an explicit migration.
      throw new SandboxBundleMigrationRequiredError();
    }
    // Reuse the already-resolved credential for firewall policy transforms.
    const apiKey = credential?.token;
    const slackCfg = await validateSlackCredentialsForRestore(latest.channels.slack);
    let startupFirewallMode = latest.firewall.mode;
    let startupFirewallAllowlist = [...latest.firewall.allowlist];
    let startupFirewallControlPlaneDomains = requiredControlPlaneDomains(latest, origin);
    let startupFirewallAppliedAtBoundary = false;
    let firewallApplied = false;
    let firewallError: string | null = null;
    let firewallStartedAt = 0;
    let firewallCompletedAt = 0;
    await assertLifecycleGuardCurrent(options?.lifecycleGuard);
    const setupResult = await setupOpenClaw(initialSandbox, {
      gatewayToken: latest.gatewayToken,
      apiKey,
      proxyOrigin: origin,
      telegramBotToken: latest.channels.telegram?.botToken,
      telegramWebhookSecret: latest.channels.telegram?.webhookSecret,
      slackCredentials: slackCfg ?? undefined,
      progress,
      beforeGatewayStart: async () => {
        await assertLifecycleGuardCurrent(options?.lifecycleGuard);
        await assertSandboxGenerationOwnership(
          initialSandbox,
          bundleMode && sandboxIsBundleCandidate,
        );
        firewallStartedAt = Date.now();
        let policyMeta = await getInitializedMeta();
        for (let policyAttempt = 0; policyAttempt < 4; policyAttempt += 1) {
          startupFirewallMode = policyMeta.firewall.mode;
          startupFirewallAllowlist = [...policyMeta.firewall.allowlist];
          startupFirewallControlPlaneDomains = requiredControlPlaneDomains(
            policyMeta,
            origin,
          );
          firewallApplied = false;
          firewallError = null;
          try {
            progress.setPhase(
              "applying-firewall",
              `Applying ${policyMeta.firewall.mode} firewall policy`,
            );
            await applyFirewallPolicyToSandbox(
              initialSandbox,
              policyMeta,
              apiKey,
              startupFirewallControlPlaneDomains,
            );
            firewallApplied = true;
          } catch (error) {
            firewallError = error instanceof Error ? error.message : String(error);
            logWarn("sandbox.create.firewall_sync_failed", ctx({
              sandboxId: initialSandbox.sandboxId,
              mode: policyMeta.firewall.mode,
              error: firewallError,
            }));
            if (policyMeta.firewall.mode === "enforcing") {
              await assertSandboxGenerationOwnership(
              initialSandbox,
              bundleMode && sandboxIsBundleCandidate,
            );
            await initialSandbox.stop({ blocking: true });
            await assertSandboxGenerationOwnership(
              initialSandbox,
              bundleMode && sandboxIsBundleCandidate,
            );
            const failedAt = Date.now();
            const policyHash = computePolicyHash(
              policyMeta.firewall.mode,
              policyMeta.firewall.allowlist,
              requiredControlPlaneDomains(policyMeta, origin),
            );
            await mutateMeta((meta) => {
              if (
                meta.lifecycleAttemptId !== attemptId
                || meta.sandboxId !== initialSandbox.sandboxId
              ) return;
              meta.firewall.lastSyncReason = "create-policy-failed";
              meta.firewall.lastSyncOutcome = {
                timestamp: failedAt,
                durationMs: failedAt - firewallStartedAt,
                allowlistCount: policyMeta.firewall.allowlist.length,
                policyHash,
                applied: false,
                reason: "create-policy-failed",
              };
              meta.firewall.lastSyncFailedAt = failedAt;
              meta.status = "error";
              meta.lastError = `Firewall sync failed during create: ${firewallError}`;
              meta.sandboxId = null;
              meta.portUrls = null;
            });
            throw new Error(
              `Firewall sync failed during create: ${firewallError}`,
              { cause: error },
            );
            }
          }
          await assertSandboxGenerationOwnership(
            initialSandbox,
            bundleMode && sandboxIsBundleCandidate,
          );
          const latestPolicyMeta = await getInitializedMeta();
          const latestControlPlaneDomains = requiredControlPlaneDomains(
            latestPolicyMeta,
            origin,
          );
          const appliedHash = computePolicyHash(
            startupFirewallMode,
            startupFirewallAllowlist,
            startupFirewallControlPlaneDomains,
          );
          const latestHash = computePolicyHash(
            latestPolicyMeta.firewall.mode,
            latestPolicyMeta.firewall.allowlist,
            latestControlPlaneDomains,
          );
          if (appliedHash === latestHash) {
            startupFirewallAppliedAtBoundary = true;
            break;
          }
          if (policyAttempt === 3) {
            throw new Error("Firewall policy changed repeatedly during Gateway startup.");
          }
          policyMeta = latestPolicyMeta;
        }
        firewallCompletedAt = Date.now();
        // No Gateway process may be launched after lifecycle ownership moves.
        await assertSandboxGenerationOwnership(
          initialSandbox,
          bundleMode && sandboxIsBundleCandidate,
        );
      },
    });
    await assertLifecycleGuardCurrent(options?.lifecycleGuard);

    await assertSandboxGenerationOwnership(
      initialSandbox,
      bundleMode && sandboxIsBundleCandidate,
    );
    const pending = await mutateMeta((meta) => {
      if (
        meta.lifecycleAttemptId !== attemptId
        || meta.sandboxId !== initialSandbox.sandboxId
        || (
          bundleMode
          && sandboxIsBundleCandidate
          && !metaOwnsBundleCandidate(meta, initialSandbox)
        )
      ) return;
      meta.status = "setup";
      meta.sandboxId = initialSandbox.sandboxId;
      meta.portUrls = resolvePortUrls(initialSandbox);
      meta.lastAccessedAt = Date.now();
      meta.startupScript = setupResult.startupScript;
      meta.openclawVersion = setupResult.openclawVersion;
      meta.bundleIdentity = setupResult.bundleIdentity;
      meta.bundleCandidate = null;
      meta.lastError = null;
      // Record token metadata from the credential used during boot.
      if (credential) {
        meta.lastTokenRefreshAt = Date.now();
        meta.lastTokenSource = credential.source;
        meta.lastTokenExpiresAt = credential.expiresAt ?? null;
      }
    });
    if (
      pending.lifecycleAttemptId !== attemptId
      || pending.sandboxId !== initialSandbox.sandboxId
      || (bundleMode && (
        pending.bundleCandidate !== null
        || setupResult.bundleIdentity === null
        || pending.bundleIdentity === null
        || !verifiedBundleIdentitiesEqual(
          pending.bundleIdentity,
          setupResult.bundleIdentity,
        )
      ))
    ) {
      throw new LifecycleLockOwnershipLostError();
    }
    bundleCandidateCommitted = !bundleMode || setupResult.bundleIdentity !== null;

    const metaOwnsCommittedSandbox = (meta: SingleMeta): boolean =>
      meta.lifecycleAttemptId === attemptId
      && meta.sandboxId === initialSandbox.sandboxId
      && (
        !bundleMode
        || (
          meta.bundleCandidate === null
          && pending.bundleIdentity !== null
          && meta.bundleIdentity !== null
          && verifiedBundleIdentitiesEqual(
            meta.bundleIdentity,
            pending.bundleIdentity,
          )
        )
      );
    const assertCommittedSandboxOwnership = async (): Promise<void> => {
      await options?.lease?.assertOwned();
      if (!metaOwnsCommittedSandbox(await getInitializedMeta())) {
        throw new LifecycleLockOwnershipLostError();
      }
    };

    if (!startupFirewallAppliedAtBoundary) {
      throw new Error("Gateway startup did not apply its firewall policy.");
    }
    // The exact policy above was installed at the Gateway launch boundary.
    const firewallPolicyHash = computePolicyHash(
      startupFirewallMode,
      startupFirewallAllowlist,
      startupFirewallControlPlaneDomains,
    );
    const firewallDurationMs = firewallCompletedAt - firewallStartedAt;

    // Record firewall sync outcome in metadata.
    await assertCommittedSandboxOwnership();
    const firewallMeta = await mutateMeta((meta) => {
      if (!metaOwnsCommittedSandbox(meta)) return;
      const outcome: import("@/shared/types").FirewallSyncOutcome = {
        timestamp: firewallCompletedAt,
        durationMs: firewallDurationMs,
        allowlistCount: startupFirewallAllowlist.length,
        policyHash: firewallPolicyHash,
        applied: firewallApplied,
        reason: firewallApplied ? "create-policy-applied" : "create-policy-failed",
      };
      meta.firewall.lastSyncReason = outcome.reason;
      meta.firewall.lastSyncOutcome = outcome;
      if (firewallApplied) {
        meta.firewall.lastSyncAppliedAt = firewallCompletedAt;
      } else {
        meta.firewall.lastSyncFailedAt = firewallCompletedAt;
      }
    });
    if (!metaOwnsCommittedSandbox(firewallMeta)) {
      throw new LifecycleLockOwnershipLostError();
    }

    // In enforcing mode, firewall sync failure is a hard blocker — the
    // sandbox must not become available without its network policy applied.
    if (!firewallApplied && startupFirewallMode === "enforcing") {
      logError("sandbox.create.firewall_sync_blocked_create", ctx({
        sandboxId: sandbox.sandboxId,
        error: firewallError,
      }));

      try {
        await assertCommittedSandboxOwnership();
        await sandbox.stop({ blocking: true });
        await assertCommittedSandboxOwnership();
      } catch (stopError) {
        if (stopError instanceof LifecycleLockOwnershipLostError) {
          throw stopError;
        }
        logWarn("sandbox.create.firewall_sync_cleanup_failed", ctx({
          sandboxId: sandbox.sandboxId,
          error: stopError instanceof Error ? stopError.message : String(stopError),
        }));
      }

      const failedMeta = await mutateMeta((meta) => {
        if (!metaOwnsCommittedSandbox(meta)) return;
        meta.status = "error";
        meta.lastError = `Firewall sync failed during create: ${firewallError}`;
        meta.sandboxId = null;
        meta.portUrls = null;
      });
      if (
        failedMeta.lifecycleAttemptId !== attemptId
        || failedMeta.status !== "error"
        || failedMeta.sandboxId !== null
      ) {
        throw new LifecycleLockOwnershipLostError();
      }
      await progress.failSetupProgress(`Firewall sync failed during create: ${firewallError}`);

      return getInitializedMeta();
    }

    // A restore can fall back to a fresh replacement sandbox. Clear the old
    // process-local suspension only after the replacement Gateway is ready,
    // before publishing the replacement as running to ingress.
    await assertCommittedSandboxOwnership();
    if (!await thawHostSuspensionIfNeeded({
      sandbox,
      lifecycleAttemptId: attemptId,
    })) {
      throw new Error("Replacement sandbox Gateway admission could not be resumed.");
    }
    await assertCommittedSandboxOwnership();

    logInfo("sandbox.status_transition", ctx({
      from: "setup",
      to: "running",
      sandboxId: sandbox.sandboxId,
    }));

    await assertLifecycleGuardCurrent(options?.lifecycleGuard);
    const runningMeta = await mutateMeta((meta) => {
      if (!metaOwnsCommittedSandbox(meta)) return;
      meta.status = "running";
      meta.lastError = null;
    });
    if (
      !metaOwnsCommittedSandbox(runningMeta)
      || runningMeta.status !== "running"
    ) {
      throw new LifecycleLockOwnershipLostError();
    }
    await armSandboxDeadline(runningMeta, undefined, {
      nativeTimeoutRemainingMs: sandbox.timeoutRemaining,
    });
    await progress.completeSetupProgress("Sandbox ready");

    logInfo("sandbox.create.complete", ctx({
      sandboxId: sandbox.sandboxId,
      openclawVersion: setupResult.openclawVersion,
      firewallApplied,
    }));
    return getInitializedMeta();
  } catch (error) {
    if (error instanceof LifecycleLockOwnershipLostError) {
      throw error;
    }
    let terminalError: unknown = error;
    if (
      bundleMode
      && sandboxIsBundleCandidate
      && !bundleCandidateCommitted
      && sandbox
    ) {
      let cleanupError: unknown = null;
      const candidateLookupId = activeBundleCandidate?.lookupId;
      if (!candidateLookupId) {
        throw new LifecycleLockOwnershipLostError();
      }
      try {
        await assertCandidateDeleteOwnership(candidateLookupId, sandbox);
        await sandbox.delete();
      } catch (candidateDeleteError) {
        if (candidateDeleteError instanceof LifecycleLockOwnershipLostError) {
          throw candidateDeleteError;
        }
        if (!isSandboxGoneError(candidateDeleteError)) {
          cleanupError = candidateDeleteError;
        }
      }
      await assertCandidateDeleteOwnership(candidateLookupId, sandbox);
      const cleanupMessage = cleanupError instanceof Error
        ? cleanupError.message
        : cleanupError === null
          ? null
          : String(cleanupError);
      const cleanedMeta = await mutateMeta((meta) => {
        if (
          meta.lifecycleAttemptId !== attemptId
          || !sameBundleCandidate(meta.bundleCandidate, activeBundleCandidate)
        ) return;
        const guardRejected = error instanceof SandboxLifecycleGuardRejectedError;
        meta.status = guardRejected && cleanupMessage === null
          ? current.status
          : "error";
        meta.portUrls = null;
        if (cleanupMessage === null) {
          meta.sandboxId = guardRejected ? current.sandboxId : null;
          meta.bundleIdentity = guardRejected ? current.bundleIdentity : null;
          meta.bundleCandidate = guardRejected ? current.bundleCandidate : null;
          meta.lifecycleAttemptId = guardRejected
            ? current.lifecycleAttemptId
            : null;
        }
        meta.lastError = guardRejected && cleanupMessage === null
          ? null
          : cleanupMessage === null
            ? error instanceof Error ? error.message : String(error)
          : `OPENCLAW_BUNDLE_CANDIDATE_CLEANUP_FAILED: ${cleanupMessage}`;
      });
      if (
        cleanupMessage === null
        && (
          cleanedMeta.sandboxId !== null
          || cleanedMeta.bundleCandidate !== null
        )
      ) {
        throw new LifecycleLockOwnershipLostError();
      }
      if (cleanupMessage !== null) {
        terminalError = new ApiError(
          502,
          "OPENCLAW_BUNDLE_CANDIDATE_CLEANUP_FAILED",
          `Failed to delete unverified bundle candidate ${sandbox.sandboxId}: ${cleanupMessage}`,
        );
      }
    }

    const errMsg = terminalError instanceof ApiError
      ? `${terminalError.code}: ${terminalError.message}`
      : terminalError instanceof Error
        ? terminalError.message
        : String(terminalError);
    try {
      await progress.failSetupProgress(errMsg);
    } catch (progressError) {
      logWarn("sandbox.lifecycle_progress_failure_write_failed", {
        error: progressError instanceof Error
          ? progressError.message
          : String(progressError),
      });
    }
    if (terminalError instanceof SandboxLifecycleGuardRejectedError) {
      throw terminalError;
    }
    throw new LifecycleAttemptFailedError(attemptId, terminalError);
  }
}


// ---------------------------------------------------------------------------
// Restore asset sync
// ---------------------------------------------------------------------------

async function syncRestoreAssetsIfNeeded(
  sandbox: SandboxHandle,
  options: {
    origin: string;
    telegramBotToken?: string;
    telegramWebhookSecret?: string;
    slackCredentials?: { botToken: string; signingSecret: string };
    bundleCapabilities?: readonly string[];
  },
): Promise<{ skippedStaticAssetSync: boolean; assetSha256: string }> {
  const manifest = buildRestoreAssetManifest();
  const existing = await sandbox.readFileToBuffer({
    path: OPENCLAW_RESTORE_ASSET_MANIFEST_PATH,
  });

  let existingSha: string | null = null;
  if (existing) {
    try {
      existingSha = (JSON.parse(existing.toString("utf8")) as RestoreAssetManifest).sha256;
    } catch {
      existingSha = null;
    }
  }

  const files = buildDynamicRestoreFiles({
    proxyOrigin: options.origin,
    telegramBotToken: options.telegramBotToken,
    telegramWebhookSecret: options.telegramWebhookSecret,
    slackCredentials: options.slackCredentials,
    bundleCapabilities: options.bundleCapabilities,
  });

  const skippedStaticAssetSync = existingSha === manifest.sha256;

  if (!skippedStaticAssetSync) {
    files.push(...buildStaticRestoreFiles());
    files.push({
      path: OPENCLAW_RESTORE_ASSET_MANIFEST_PATH,
      content: Buffer.from(JSON.stringify(manifest) + "\n"),
    });
  }

  await sandbox.writeFiles(files);

  return {
    skippedStaticAssetSync,
    assetSha256: manifest.sha256,
  };
}

// ---------------------------------------------------------------------------
// Snapshot metadata
// ---------------------------------------------------------------------------

function _recordSnapshotMetadata(
  meta: SingleMeta,
  snapshotId: string,
  reason: string,
  configHash?: string,
  assetSha256?: string,
): void {
  const timestamp = Date.now();
  meta.snapshotId = snapshotId;
  if (configHash) {
    meta.snapshotConfigHash = configHash;
    // Manual snapshot truth: this hash describes the config in the snapshot checkpoint.
    meta.snapshotDynamicConfigHash = configHash;
  }
  if (assetSha256) {
    meta.snapshotAssetSha256 = assetSha256;
  }
  // A new snapshot means the restore target is now ready.
  meta.restorePreparedStatus = "ready";
  meta.restorePreparedReason = "prepared";
  meta.restorePreparedAt = timestamp;

  // Seal oracle state — the snapshot is verified-ready.
  meta.restoreOracle.status = "ready";
  meta.restoreOracle.pendingReason = null;
  meta.restoreOracle.lastCompletedAt = timestamp;
  meta.restoreOracle.lastBlockedReason = null;
  meta.restoreOracle.lastError = null;
  meta.restoreOracle.consecutiveFailures = 0;
  meta.restoreOracle.lastResult = "prepared";

  meta.snapshotHistory = [
    {
      id: randomUUID(),
      snapshotId,
      timestamp,
      reason,
    },
    ...meta.snapshotHistory,
  ].slice(0, 50);
}

function collectTrackedSnapshotIds(
  meta: Pick<SingleMeta, "snapshotId" | "snapshotHistory">,
): string[] {
  return [...new Set([
    meta.snapshotId,
    ...meta.snapshotHistory.map((record) => record.snapshotId),
  ].filter((snapshotId): snapshotId is string => Boolean(snapshotId)))];
}

async function destroyCurrentSandboxWithoutSnapshot(
  meta: SingleMeta,
  ctx: (extra?: Record<string, unknown>) => Record<string, unknown>,
  options: {
    lease: AutoRenewedLockLease;
    onSandboxResolved: (sandboxId: string) => void;
    onSandboxDestroyed: (sandboxId: string, operationId: string | null) => void;
  },
): Promise<void> {
  let initialSuspension: HostSuspensionState | null = null;
  try {
    initialSuspension = await readHostSuspensionState();
  } catch (error) {
    if (!(error instanceof HostSuspensionStateCorruptError)) throw error;
  }
  const lookupSandboxId = meta.sandboxId
    ?? initialSuspension?.sandboxId
    ?? `oc-${meta.id.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`;

  try {
    await options.lease.assertOwned();
    const sandbox = await getSandboxController().get({
      sandboxId: lookupSandboxId,
      resume: false,
    });
    if (meta.sandboxId && sandbox.sandboxId !== meta.sandboxId) {
      const canonicalMeta = await mutateMeta((next) => {
        if (
          next.sandboxId !== meta.sandboxId
          || (next.lifecycleAttemptId ?? null) !== (meta.lifecycleAttemptId ?? null)
        ) return;
        next.sandboxId = sandbox.sandboxId;
        next.portUrls = null;
      });
      if (
        canonicalMeta.sandboxId !== sandbox.sandboxId
        || (canonicalMeta.lifecycleAttemptId ?? null)
          !== (meta.lifecycleAttemptId ?? null)
      ) throw new LifecycleLockOwnershipLostError();
      meta.sandboxId = sandbox.sandboxId;
    }
    options.onSandboxResolved(sandbox.sandboxId);
    await options.lease.assertOwned();
    let suspension: HostSuspensionState | null = null;
    let cleanupOperationId: string | null = null;
    let sandboxDestroyed = false;
    try {
      if (initialSuspension?.sandboxId === sandbox.sandboxId) {
        cleanupOperationId = initialSuspension.operationId;
      }
      // Only a ready running Gateway can own admitted user work. Setup/error/
      // already-stopped sandboxes have no Gateway suspension surface to call.
      if (sandbox.status === "running") {
        try {
          suspension = await prepareDedicatedHostSuspension({
            sandbox,
            lifecycleAttemptId:
              meta.lifecycleAttemptId
              ?? initialSuspension?.lifecycleAttemptId
              ?? null,
            intent: "reset",
            reason: "sandbox.reset",
          });
          cleanupOperationId = suspension?.operationId ?? cleanupOperationId;
        } catch (error) {
          if (isGatewaySuspensionCapabilityUnavailable(error)) {
            await clearInactiveHostSuspension({ sandboxId: sandbox.sandboxId });
            logWarn("sandbox.host_suspension.capability_unavailable", ctx({
              sandboxId: meta.sandboxId,
              code: error.code,
              action: "legacy-platform-delete",
            }));
          } else if (!(error instanceof HostSuspensionStateCorruptError)) {
            throw error;
          } else {
            // Destructive reset is the sole recovery owner for corrupt durable
            // suspension state. Delete the sandbox before clearing the record so
            // no potentially suspended Gateway can survive a fail-open repair.
            await options.lease.assertOwned();
            await sandbox.delete();
            await options.lease.assertOwned();
            sandboxDestroyed = true;
            options.onSandboxDestroyed(sandbox.sandboxId, cleanupOperationId);
            await clearHostSuspensionAfterDelete({
              sandboxId: sandbox.sandboxId,
              recoverCorruptState: true,
            });
            await clearSandboxDeadline(sandbox.sandboxId, {
              lifecycleAttemptId:
                meta.lifecycleAttemptId
                ?? initialSuspension?.lifecycleAttemptId
                ?? null,
            });
            logWarn("sandbox.reset.corrupt_suspension_recovered", ctx({
              sandboxId: meta.sandboxId,
            }));
            return;
          }
        }
        if (suspension) {
          await options.lease.assertOwned();
          suspension = await renewHostSuspension({
            state: suspension,
            sandbox,
          });
          if (suspension.phase !== "stopping") {
            suspension = await markHostSuspensionStopping(suspension);
          }
        }
      }

      // Delete directly after OpenClaw proves idle and closes admission. A
      // preliminary persistent stop would add another asynchronous snapshot
      // race even though reset intentionally discards the restore target.
      await options.lease.assertOwned();
      await sandbox.delete();
      await options.lease.assertOwned();
      sandboxDestroyed = true;
      options.onSandboxDestroyed(sandbox.sandboxId, cleanupOperationId);
      await clearSandboxDeadline(sandbox.sandboxId, {
        lifecycleAttemptId:
          meta.lifecycleAttemptId
          ?? initialSuspension?.lifecycleAttemptId
          ?? null,
      });
      logInfo("sandbox.reset.destroyed", ctx({ sandboxId: sandbox.sandboxId }));
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isSandboxGoneError(error)) {
        sandboxDestroyed = true;
        options.onSandboxDestroyed(sandbox.sandboxId, cleanupOperationId);
        await clearSandboxDeadline(sandbox.sandboxId, {
          lifecycleAttemptId:
            meta.lifecycleAttemptId
            ?? initialSuspension?.lifecycleAttemptId
            ?? null,
        });
        logWarn("sandbox.reset.sandbox_already_gone", ctx({
          sandboxId: meta.sandboxId,
          error: message,
        }));
        return;
      }
      if (suspension && !sandboxDestroyed) {
        await rollbackHostSuspension({
          state: suspension,
          sandbox,
          error,
        });
      }
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isSandboxGoneError(error)) {
      const operationId = initialSuspension?.sandboxId === lookupSandboxId
        ? initialSuspension.operationId
        : null;
      options.onSandboxDestroyed(lookupSandboxId, operationId);
      await clearSandboxDeadline(lookupSandboxId, {
        lifecycleAttemptId:
          meta.lifecycleAttemptId
          ?? initialSuspension?.lifecycleAttemptId
          ?? null,
      });
      logWarn("sandbox.reset.sandbox_already_gone", ctx({
        sandboxId: lookupSandboxId,
        error: message,
      }));
      return;
    }
    if (error instanceof ApiError) throw error;

    throw new Error(
      `Failed to destroy sandbox ${meta.sandboxId} during reset: ${message}`,
    );
  }
}

async function clearResetHostSuspensionAfterCommit(
  sandboxId: string | null,
  operationId: string | null = null,
): Promise<void> {
  if (!sandboxId || !operationId) return;
  await clearHostSuspensionAfterDelete({
    sandboxId,
    operationId,
  });
}

async function deleteTrackedSnapshotsForReset(
  snapshotIds: string[],
  deleteSnapshot: (snapshotId: string) => Promise<void>,
  ctx: (extra?: Record<string, unknown>) => Record<string, unknown>,
  assertResetGeneration: () => Promise<void>,
): Promise<string[]> {
  const failedSnapshotIds: string[] = [];

  for (const snapshotId of snapshotIds) {
    try {
      await assertResetGeneration();
      await deleteSnapshot(snapshotId);
      await assertResetGeneration();
      logInfo("sandbox.reset.snapshot_deleted", ctx({ snapshotId }));
    } catch (error) {
      if (error instanceof LifecycleLockOwnershipLostError) throw error;
      if (isSnapshotNotFoundError(error)) {
        logInfo("sandbox.reset.snapshot_missing", ctx({ snapshotId }));
        continue;
      }

      failedSnapshotIds.push(snapshotId);
      logError("sandbox.reset.snapshot_delete_error", ctx({
        snapshotId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  return failedSnapshotIds;
}

async function clearResetCronState(
  ctx: (extra?: Record<string, unknown>) => Record<string, unknown>,
  options: {
    lease: AutoRenewedLockLease;
    expected: Pick<
      SingleMeta,
      "sandboxId" | "lifecycleAttemptId" | "gatewayToken"
    >;
  },
): Promise<void> {
  const assertCurrent = async (gatewayToken: string): Promise<SingleMeta> => {
    await options.lease.assertOwned();
    const current = await getInitializedMeta();
    if (
      current.sandboxId !== options.expected.sandboxId
      || (current.lifecycleAttemptId ?? null)
        !== (options.expected.lifecycleAttemptId ?? null)
      || current.gatewayToken !== gatewayToken
    ) {
      throw new LifecycleLockOwnershipLostError();
    }
    return current;
  };
  const current = await assertCurrent(options.expected.gatewayToken);
  let transition = current.resetCronTransition;
  let nextGatewayValue = current.gatewayToken;
  if (transition) {
    const currentGeneration = createHash("sha256")
      .update(current.gatewayToken)
      .digest("hex")
      .slice(0, 32);
    if (
      transition.sandboxId !== options.expected.sandboxId
      || transition.lifecycleAttemptId
        !== (options.expected.lifecycleAttemptId ?? null)
      || transition.nextGatewayGeneration !== currentGeneration
    ) {
      throw new LifecycleLockOwnershipLostError();
    }
  } else {
    nextGatewayValue = randomUUID();
    transition = {
      sandboxId: options.expected.sandboxId,
      lifecycleAttemptId: options.expected.lifecycleAttemptId ?? null,
      previousGatewayGeneration: createHash("sha256")
        .update(current.gatewayToken)
        .digest("hex")
        .slice(0, 32),
      nextGatewayGeneration: createHash("sha256")
        .update(nextGatewayValue)
        .digest("hex")
        .slice(0, 32),
      startedAt: Date.now(),
    };
    const committed = await mutateMeta((meta) => {
      if (
        meta.sandboxId !== options.expected.sandboxId
        || (meta.lifecycleAttemptId ?? null)
          !== (options.expected.lifecycleAttemptId ?? null)
        || meta.gatewayToken !== current.gatewayToken
        || meta.resetCronTransition !== null
      ) {
        throw new Error("sandbox_reset_gateway_token_changed");
      }
      meta.gatewayToken = nextGatewayValue;
      meta.resetCronTransition = transition;
    });
    if (
      committed.gatewayToken !== nextGatewayValue
      || committed.resetCronTransition?.nextGatewayGeneration
        !== transition.nextGatewayGeneration
    ) throw new LifecycleLockOwnershipLostError();
  }
  await assertCurrent(nextGatewayValue);
  const fenced = await fenceCronProjectionStateForReset({
    gatewayGeneration: transition.nextGatewayGeneration,
    expectedGatewayGeneration: transition.previousGatewayGeneration,
  });
  await assertCurrent(nextGatewayValue);
  const legacyCleared = await clearLegacyCronStateForReset({
    gatewayGeneration: fenced.record.gatewayGeneration!,
    projectionRevision: fenced.record.projectionRevision,
  });
  if (!legacyCleared) {
    throw new LifecycleLockOwnershipLostError();
  }
  await assertCurrent(nextGatewayValue);
  await cancelSupersededCronWake(fenced.supersededWorkflowRunId);
  await assertCurrent(nextGatewayValue);
  const completed = await mutateMeta((meta) => {
    if (
      meta.sandboxId !== options.expected.sandboxId
      || (meta.lifecycleAttemptId ?? null)
        !== (options.expected.lifecycleAttemptId ?? null)
      || meta.gatewayToken !== nextGatewayValue
      || meta.resetCronTransition?.nextGatewayGeneration
        !== transition.nextGatewayGeneration
    ) return;
    meta.resetCronTransition = null;
  });
  if (completed.resetCronTransition !== null) {
    throw new LifecycleLockOwnershipLostError();
  }
  logInfo("sandbox.reset.cron_state_fenced", ctx());
}

function clearSandboxRuntimeStateForReset(meta: SingleMeta): void {
  meta.sandboxId = null;
  meta.portUrls = null;
  meta.snapshotId = null;
  meta.snapshotConfigHash = null;
  meta.snapshotDynamicConfigHash = null;
  meta.runtimeDynamicConfigHash = null;
  meta.snapshotAssetSha256 = null;
  meta.runtimeAssetSha256 = null;
  meta.persistedStateDynamicConfigHash = null;
  meta.persistedStateAssetSha256 = null;
  meta.persistedStateSavedAt = null;
  meta.persistedStateSource = null;
  meta.pendingPersistentAutoSave = null;
  meta.activePersistentStop = null;
  meta.resetCronTransition = null;
  meta.currentSnapshotId = null;
  meta.restorePreparedStatus = "unknown";
  meta.restorePreparedReason = null;
  meta.restorePreparedAt = null;
  meta.snapshotHistory = [];
  meta.lastRestoreMetrics = null;
  meta.restoreHistory = [];
  meta.lastAccessedAt = null;
  meta.startupScript = null;
  meta.openclawVersion = null;
  meta.bundleIdentity = null;
  meta.bundleCandidate = null;
  meta.lastError = null;
  meta.lifecycleAttemptId = null;

  meta.lastTokenRefreshAt = null;
  meta.lastTokenExpiresAt = null;
  meta.lastTokenSource = null;
  meta.lastTokenRefreshError = null;
  meta.consecutiveTokenRefreshFailures = 0;
  meta.breakerOpenUntil = null;

  // Reset oracle to default idle state.
  meta.restoreOracle = {
    status: "idle",
    pendingReason: null,
    lastEvaluatedAt: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastBlockedReason: null,
    lastError: null,
    consecutiveFailures: 0,
    lastResult: null,
  };
}

// ---------------------------------------------------------------------------
// Locking helpers
// ---------------------------------------------------------------------------

async function withLifecycleLock<T>(
  fn: (lease: AutoRenewedLockLease) => Promise<T>,
): Promise<T> {
  const store = getStore();
  const token = await store.acquireLock(lifecycleLockKey(), LIFECYCLE_LOCK_TTL_SECONDS);
  if (!token) {
    throw new LifecycleLockUnavailableError();
  }

  return withAutoRenewedLock(
    {
      key: lifecycleLockKey(),
      token,
      ttlSeconds: LIFECYCLE_LOCK_TTL_SECONDS,
      label: "sandbox.lifecycle",
    },
    fn,
  );
}

/** Serialize external runtime mutations with Gateway start/stop boundaries. */
export async function withSandboxLifecycleMutationLock<T>(
  action: (assertOwned: () => Promise<void>) => Promise<T>,
): Promise<T> {
  try {
    return await withLifecycleLock(async (lease) => {
      await lease.assertOwned();
      const result = await action(() => lease.assertOwned());
      await lease.assertOwned();
      return result;
    });
  } catch (error) {
    if (error instanceof LifecycleLockUnavailableError) {
      throw new SandboxLifecycleLockContendedError();
    }
    throw error;
  }
}

/** Short fail-close handoff after a renewable lifecycle lease was lost. */
export async function withSandboxLifecycleRecoveryLock<T>(
  action: () => Promise<T>,
): Promise<T> {
  const store = getStore();
  const token = await store.acquireLock(
    lifecycleLockKey(),
    LIFECYCLE_LOCK_TTL_SECONDS,
  );
  if (!token) throw new SandboxLifecycleLockContendedError();
  try {
    return await action();
  } finally {
    await store.releaseLock(lifecycleLockKey(), token);
  }
}

async function withAutoRenewedLock<T>(
  options: AutoRenewedLockOptions,
  fn: (lease: AutoRenewedLockLease) => Promise<T>,
): Promise<T> {
  const store = getStore();
  let stopRenewal = false;
  let ownershipLost = false;
  const intervalMs = Math.max(
    1_000,
    Math.min(LOCK_RENEW_INTERVAL_MS, Math.floor((options.ttlSeconds * 1000) / 2)),
  );

  const interval = setInterval(() => {
    if (stopRenewal) {
      return;
    }

    void store
      .renewLock(options.key, options.token, options.ttlSeconds)
      .then((renewed) => {
        if (!renewed) {
          stopRenewal = true;
          ownershipLost = true;
          logWarn("sandbox.lock_renewal_lost", {
            key: options.key,
            label: options.label,
          });
        }
      })
      .catch((error) => {
        ownershipLost = true;
        stopRenewal = true;
        logWarn("sandbox.lock_renewal_failed", {
          key: options.key,
          label: options.label,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, intervalMs);

  const maybeUnref = interval as unknown as { unref?: () => void };
  maybeUnref.unref?.();

  const lease: AutoRenewedLockLease = {
    async assertOwned() {
      if (ownershipLost) throw new LifecycleLockOwnershipLostError();
      let renewed = false;
      try {
        renewed = await store.renewLock(
          options.key,
          options.token,
          options.ttlSeconds,
        );
      } catch {
        ownershipLost = true;
        stopRenewal = true;
        throw new LifecycleLockOwnershipLostError();
      }
      if (!renewed) {
        ownershipLost = true;
        stopRenewal = true;
        throw new LifecycleLockOwnershipLostError();
      }
    },
  };

  try {
    return await fn(lease);
  } finally {
    stopRenewal = true;
    clearInterval(interval);
    await store.releaseLock(options.key, options.token).catch((error) => {
      logWarn("sandbox.lock_release_failed", {
        key: options.key,
        label: options.label,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function resolvePortUrls(sandbox: SandboxHandle): Record<string, string> {
  const urls: Record<string, string> = {};
  for (const port of SANDBOX_PORTS) {
    try {
      urls[String(port)] = sandbox.domain(port);
    } catch {
      // Ignore missing routes.
    }
  }
  return urls;
}

export function isBusyStatus(status: SingleMeta["status"]): boolean {
  return (
    status === "creating" ||
    status === "setup" ||
    status === "restoring" ||
    status === "booting" ||
    status === "snapshotting"
  );
}

function isOperationStale(meta: SingleMeta): boolean {
  return Date.now() - meta.updatedAt > STALE_OPERATION_MS;
}

async function buildRuntimeEnv(): Promise<{ env?: Record<string, string> }> {
  // OpenClaw validates API keys internally (via auth-profiles.json) before
  // sending any HTTP request.  The env vars are needed so OpenClaw can
  // populate its auth store at startup.  The network policy header transform
  // provides defense-in-depth by overwriting the Authorization header at the
  // firewall layer — even if OpenClaw sends a stale token, the transform
  // injects the fresh one.
  const token = await getAiGatewayBearerTokenOptional();
  if (!token) {
    return {
      env: {
        OPENAI_BASE_URL: "https://ai-gateway.vercel.sh/v1",
      },
    };
  }

  return {
    env: {
      AI_GATEWAY_API_KEY: token,
      OPENAI_API_KEY: token,
      OPENAI_BASE_URL: "https://ai-gateway.vercel.sh/v1",
    },
  };
}
