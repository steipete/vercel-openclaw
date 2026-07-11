import { sleep } from "workflow";

import {
  CRON_DISPATCH_SETTLEMENT_GRACE_MS,
  type CronWakeWorkflowEnvelopeV1,
} from "@/server/cron/workflow-contract";
import {
  claimCronWake,
  cancelSupersededCronWake,
  completeCronWake,
  getCronWakeHandoffState,
  isCronWakeClaimCurrent,
  isCronWakeDispatchCurrent,
  reconcileCronProjection,
  recordCronWakeHandoff,
} from "@/server/cron/dispatch";
import { supportsCronProjectionBundleIdentity } from "@/server/cron/compatibility";
import { logInfo, logWarn } from "@/server/log";
import { matchesConfiguredBundleIdentity } from "@/server/openclaw/bundle-identity";
import { getPublicOriginFromHint } from "@/server/public-url";
import { readCronProjection } from "@/server/cron/projection";
import {
  ensureSandboxReadyForCron,
  SandboxLifecycleGuardRejectedError,
  type TokenRefreshResult,
} from "@/server/sandbox/lifecycle";
import { getInitializedMeta } from "@/server/store/store";

const CRON_WAKE_MAX_STEP_ATTEMPTS = 5;
const CRON_WAKE_DEFAULT_RETRY_MS = 60_000;
const CRON_WAKE_MAX_DURABLE_RETRY_MS = 15 * 60_000;
const CRON_WAKE_MONITOR_INTERVAL_MS = 60_000;
const CRON_SETTLEMENT_RECOVERY_INTERVAL_MS = 15 * 60_000;
export const CRON_WAKE_POST_DUE_SAFETY_MS = 15 * 60_000;

export type CronWakeHandoffOutcome =
  | { status: "settled" }
  | { status: "retry"; retryAfterMs: number };

export type CronWakeProcessOutcome =
  | { status: "settled" }
  | { status: "completed" }
  | { status: "retry"; retryAfterMs: number };

export function shouldCancelCronWakeHandoff(
  result: Awaited<ReturnType<typeof recordCronWakeHandoff>>,
): boolean {
  return result === "occupied" || result === "stale";
}

class CronWakeCredentialUnavailableError extends Error {
  constructor(
    reason: string,
    readonly retryAfterMs: number,
  ) {
    super(`cron wake credential unavailable: ${reason}`);
    this.name = "CronWakeCredentialUnavailableError";
  }
}

export function getCronWakeCredentialRetry(
  result: TokenRefreshResult,
): { usable: true } | { usable: false; retryAfterMs: number } {
  if (result.credential?.token) return { usable: true };
  return {
    usable: false,
    retryAfterMs: Math.max(1_000, result.retryAfterMs ?? CRON_WAKE_DEFAULT_RETRY_MS),
  };
}

export function getCronWakeDurableRetryMs(
  recoveryCycle: number,
  requestedRetryMs = CRON_WAKE_DEFAULT_RETRY_MS,
): number {
  const cycle = Math.max(0, Math.min(4, Math.trunc(recoveryCycle)));
  const requested = Math.max(1_000, requestedRetryMs);
  return Math.min(
    CRON_WAKE_MAX_DURABLE_RETRY_MS,
    requested * 2 ** cycle,
  );
}

export async function cronWakeWorkflow(
  envelope: CronWakeWorkflowEnvelopeV1,
): Promise<void> {
  "use workflow";

  if (envelope.version !== 1) {
    throw new Error("unsupported_cron_wake_workflow_envelope");
  }
  await sleep(new Date(envelope.wakeAtMs));
  let recoveryCycle = 0;
  while (true) {
    const outcome = await handoffCronWakeStep(envelope);
    if (outcome.status === "settled") return;
    await sleep(
      getCronWakeDurableRetryMs(recoveryCycle, outcome.retryAfterMs),
    );
    recoveryCycle += 1;
  }
}

export async function cronWakeExecutionWorkflow(
  envelope: CronWakeWorkflowEnvelopeV1,
  parentWorkflowRunId: string,
): Promise<void> {
  "use workflow";

  // Timer runs stay deployment-pinned. This stable v1 entry point lets the
  // timer resolve the current deployment only when the wake actually fires.
  if (envelope.version !== 1) {
    throw new Error("unsupported_cron_wake_workflow_envelope");
  }
  let recoveryCycle = 0;
  while (true) {
    const outcome = await processCronWakeStep(envelope, parentWorkflowRunId);
    if (outcome.status === "settled") return;
    if (outcome.status === "completed") {
      await sleep(
        new Date(envelope.runAtMs + CRON_DISPATCH_SETTLEMENT_GRACE_MS),
      );
      while (true) {
        const settlement = await settleCronWakeStep(envelope);
        if (settlement.status === "settled") return;
        await sleep(settlement.retryAfterMs);
      }
    }
    await sleep(
      getCronWakeDurableRetryMs(recoveryCycle, outcome.retryAfterMs),
    );
    recoveryCycle += 1;
  }
}

export async function handoffCronWakeStep(
  envelope: CronWakeWorkflowEnvelopeV1,
): Promise<CronWakeHandoffOutcome> {
  "use step";

  const { RetryableError, getStepMetadata, getWorkflowMetadata } =
    await import("workflow");
  const { start } = await import("workflow/api");
  const parentWorkflowRunId = getWorkflowMetadata().workflowRunId;
  try {
    const handoffState = await getCronWakeHandoffState(
      envelope,
      parentWorkflowRunId,
    );
    if (handoffState === "stale") return { status: "settled" };
    if (handoffState === "already") return { status: "settled" };
    const run = await start(
      cronWakeExecutionWorkflow,
      [envelope, parentWorkflowRunId],
      { deploymentId: "latest" },
    );
    const recorded = await recordCronWakeHandoff(
      envelope,
      run.runId,
      parentWorkflowRunId,
    );
    if (shouldCancelCronWakeHandoff(recorded)) {
      await cancelSupersededCronWake(run.runId);
    }
    return { status: "settled" };
  } catch {
    const attempt = getStepMetadata().attempt;
    if (attempt < CRON_WAKE_MAX_STEP_ATTEMPTS) {
      throw new RetryableError("cron wake handoff failed", {
        retryAfter: CRON_WAKE_DEFAULT_RETRY_MS,
      });
    }
    return {
      status: "retry",
      retryAfterMs: CRON_WAKE_DEFAULT_RETRY_MS,
    };
  }
}

export async function processCronWakeStep(
  envelope: CronWakeWorkflowEnvelopeV1,
  parentWorkflowRunId: string,
): Promise<CronWakeProcessOutcome> {
  "use step";

  const { RetryableError, getStepMetadata, getWorkflowMetadata } =
    await import("workflow");
  const workflowRunId = getWorkflowMetadata().workflowRunId;

  try {
    const meta = await getInitializedMeta();
    const identity = matchesConfiguredBundleIdentity(meta.bundleIdentity)
      ? meta.bundleIdentity
      : null;
    const enabled = supportsCronProjectionBundleIdentity(
      identity,
    );
    const claimed = await claimCronWake(
      envelope,
      workflowRunId,
      Date.now(),
      enabled,
      parentWorkflowRunId,
    );
    if (!claimed) {
      logInfo("cron.projection_wake_stale", {
        projectionRevision: envelope.projectionRevision,
        runAtMs: envelope.runAtMs,
        workflowRunId,
      });
      return { status: "settled" };
    }
    const ready = await ensureSandboxReadyForCron({
      origin: getPublicOriginFromHint(envelope.origin),
      reason: "cron-projection:wake",
      aliveThroughMs: Math.max(
        envelope.runAtMs + CRON_WAKE_POST_DUE_SAFETY_MS,
        Date.now() + CRON_WAKE_POST_DUE_SAFETY_MS,
      ),
      lifecycleGuard: () =>
        isCronWakeClaimCurrent(envelope, workflowRunId, enabled),
    });
    const credentialState = getCronWakeCredentialRetry(ready.credential);
    if (!credentialState.usable) {
      throw new CronWakeCredentialUnavailableError(
        ready.credential.reason,
        credentialState.retryAfterMs,
      );
    }
    const completed = await completeCronWake(envelope, workflowRunId);
    logInfo("cron.projection_wake_completed", {
      projectionRevision: envelope.projectionRevision,
      runAtMs: envelope.runAtMs,
      workflowRunId,
    });
    return { status: completed ? "completed" : "settled" };
  } catch (error) {
    if (error instanceof SandboxLifecycleGuardRejectedError) {
      logInfo("cron.projection_wake_revoked", {
        projectionRevision: envelope.projectionRevision,
        runAtMs: envelope.runAtMs,
        workflowRunId,
      });
      return { status: "settled" };
    }
    const attempt = getStepMetadata().attempt;
    logWarn("cron.projection_wake_failed", {
      projectionRevision: envelope.projectionRevision,
      runAtMs: envelope.runAtMs,
      workflowRunId,
      attempt,
      error: error instanceof Error ? error.name : "unknown",
    });
    const retryAfterMs =
      error instanceof CronWakeCredentialUnavailableError
        ? error.retryAfterMs
        : CRON_WAKE_DEFAULT_RETRY_MS;
    if (attempt < CRON_WAKE_MAX_STEP_ATTEMPTS) {
      throw new RetryableError("cron projection wake failed", {
        retryAfter: retryAfterMs,
      });
    }
    return { status: "retry", retryAfterMs };
  }
}

export async function settleCronWakeStep(
  envelope: CronWakeWorkflowEnvelopeV1,
): Promise<{ status: "settled" } | { status: "retry"; retryAfterMs: number }> {
  "use step";

  const { RetryableError, getStepMetadata } = await import("workflow");
  try {
    const meta = await getInitializedMeta();
    const identity = matchesConfiguredBundleIdentity(meta.bundleIdentity)
      ? meta.bundleIdentity
      : null;
    const enabled = supportsCronProjectionBundleIdentity(
      identity,
    );
    if (!enabled) return { status: "settled" };
    await reconcileCronProjection({
      enabled,
      origin: getPublicOriginFromHint(envelope.origin),
      getWorkflowRunStatus: async (runId) => {
        const { getRun } = await import("workflow/api");
        const run = getRun(runId);
        if (!(await run.exists)) return "missing";
        return run.status;
      },
      startWorkflow: async (nextEnvelope) => {
        const { start } = await import("workflow/api");
        const run = await start(cronWakeWorkflow, [nextEnvelope], {
          deploymentId: "latest",
        });
        return { runId: run.runId };
      },
    });
    const latest = await readCronProjection();
    const stillOwned =
      latest?.projectionRevision === envelope.projectionRevision &&
      latest.dispatch.status !== "none" &&
      latest.dispatch.token === envelope.token;
    if (!stillOwned) return { status: "settled" };
    if (latest.dispatch.status === "completed") {
      const settlementAtMs =
        envelope.runAtMs + CRON_DISPATCH_SETTLEMENT_GRACE_MS;
      const now = Date.now();
      if (now >= settlementAtMs) {
        const isCurrent = () =>
          isCronWakeDispatchCurrent(envelope, enabled);
        const ready = await ensureSandboxReadyForCron({
          origin: getPublicOriginFromHint(envelope.origin),
          reason: "cron-projection:settlement-recovery",
          aliveThroughMs: Date.now() + CRON_WAKE_POST_DUE_SAFETY_MS,
          lifecycleGuard: isCurrent,
        });
        const credentialState = getCronWakeCredentialRetry(ready.credential);
        if (!credentialState.usable) {
          throw new CronWakeCredentialUnavailableError(
            ready.credential.reason,
            credentialState.retryAfterMs,
          );
        }
      }
      return {
        status: "retry",
        retryAfterMs:
          now < settlementAtMs
            ? Math.max(1_000, settlementAtMs - now)
            : CRON_SETTLEMENT_RECOVERY_INTERVAL_MS,
      };
    }
    return {
      status: "retry",
      retryAfterMs: CRON_WAKE_MONITOR_INTERVAL_MS,
    };
  } catch (error) {
    const attempt = getStepMetadata().attempt;
    logWarn("cron.projection_monitor_failed", {
      projectionRevision: envelope.projectionRevision,
      runAtMs: envelope.runAtMs,
      attempt,
      error: error instanceof Error ? error.name : "unknown",
    });
    const retryAfterMs =
      error instanceof CronWakeCredentialUnavailableError
        ? error.retryAfterMs
        : CRON_WAKE_DEFAULT_RETRY_MS;
    if (attempt < CRON_WAKE_MAX_STEP_ATTEMPTS) {
      throw new RetryableError("cron projection monitor failed", {
        retryAfter: retryAfterMs,
      });
    }
    return {
      status: "retry",
      retryAfterMs,
    };
  }
}

processCronWakeStep.maxRetries = CRON_WAKE_MAX_STEP_ATTEMPTS - 1;
handoffCronWakeStep.maxRetries = CRON_WAKE_MAX_STEP_ATTEMPTS - 1;
settleCronWakeStep.maxRetries = CRON_WAKE_MAX_STEP_ATTEMPTS - 1;
