import { randomUUID } from "node:crypto";

import type { CronWakeWorkflowEnvelopeV1 } from "@/server/cron/workflow-contract";
import { logInfo, logWarn } from "@/server/log";
import {
  clearLegacyCronStateAfterBaseline,
  migrateLegacyCronWake,
  mutateCronProjection,
  readCronProjection,
  type CronDispatchState,
  type CronProjectionRecordV1,
} from "@/server/cron/projection";
import { cronProjectionKey } from "@/server/store/keyspace";
import { getStore } from "@/server/store/store";

const DISPATCH_START_LEASE_MS = 60_000;
const DISPATCH_ACTIVE_HARD_CEILING_MS = 2 * 60 * 60_000;
const DISPATCH_RETRY_MS = 60_000;
export const CRON_PREWAKE_MAX_LEAD_MS = 5 * 60_000;

export type StartCronWakeWorkflow = (
  envelope: CronWakeWorkflowEnvelopeV1,
) => Promise<{ runId: string }>;

export type CronWorkflowRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "missing";

export type CronProjectionReconcileResult = {
  status:
    | "empty"
    | "unsupported"
    | "idle"
    | "starting"
    | "scheduled"
    | "started"
    | "failed";
  projectionRevision: number | null;
  nextRunAtMs: number | null;
  workflowRunId: string | null;
  repaired: boolean;
};

export type CronWakeHandoffState = "ready" | "already" | "stale";
export type CronWakeHandoffResult =
  | "installed"
  | "owned"
  | "occupied"
  | "stale";

export const cronDispatchWorkflowRuntime = {
  async cancel(runId: string): Promise<void> {
    const { getRun } = await import("workflow/api");
    await getRun(runId).cancel();
  },
};

export async function cancelSupersededCronWake(
  workflowRunId: string | null,
): Promise<void> {
  if (!workflowRunId) return;
  try {
    await cronDispatchWorkflowRuntime.cancel(workflowRunId);
    logInfo("cron.projection_workflow_cancelled", { workflowRunId });
  } catch (error) {
    // The projection token is authoritative; cancellation only releases an
    // obsolete sleeping Workflow early.
    logWarn("cron.projection_workflow_cancel_failed", {
      workflowRunId,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

function dispatchIdentity(dispatch: CronDispatchState) {
  if (dispatch.status === "none") return null;
  return {
    token: dispatch.token,
    runAtMs: dispatch.runAtMs,
    wakeAtMs: dispatch.wakeAtMs,
    attempt: dispatch.attempt,
  };
}

type WorkflowRunLossEvidence = {
  runId: string;
  status: "pending" | "running" | "lost";
} | null;

function resolveCronWakeAtMs(runAtMs: number, now: number): number {
  return Math.max(now, runAtMs - CRON_PREWAKE_MAX_LEAD_MS);
}

function shouldRearm(
  dispatch: CronDispatchState,
  now: number,
  workflowRunLoss: WorkflowRunLossEvidence = null,
): boolean {
  const matchingRun =
    workflowRunLoss !== null &&
    (dispatch.status === "scheduled" || dispatch.status === "running") &&
    dispatch.workflowRunId === workflowRunLoss.runId;
  const matchingRunLost = matchingRun && workflowRunLoss.status === "lost";
  switch (dispatch.status) {
    case "failed":
      return dispatch.retryAtMs <= now;
    case "starting":
      return dispatch.startLeaseExpiresAtMs <= now;
    case "scheduled":
      return (
        matchingRunLost ||
        dispatch.scheduledAtMs + DISPATCH_ACTIVE_HARD_CEILING_MS <=
          now
      );
    case "running":
      return (
        matchingRunLost ||
        dispatch.claimedAtMs + DISPATCH_ACTIVE_HARD_CEILING_MS <= now
      );
    case "completed":
      // A completed projection contains only the old due time. Wait for the
      // scheduler's next authoritative snapshot; replaying it loops forever.
      return false;
    default:
      return false;
  }
}

async function rearmStaleDispatch(
  record: CronProjectionRecordV1,
  now: number,
  workflowRunLoss: WorkflowRunLossEvidence = null,
): Promise<CronProjectionRecordV1> {
  const identity = dispatchIdentity(record.dispatch);
  if (!identity || !shouldRearm(record.dispatch, now, workflowRunLoss)) {
    return record;
  }
  const supersededWorkflowRunId =
    record.dispatch.status === "scheduled" || record.dispatch.status === "running"
      ? record.dispatch.workflowRunId
      : null;
  const rearmed =
    (await mutateCronProjection((latest) => {
      const latestIdentity = dispatchIdentity(latest.dispatch);
      if (
        !latestIdentity ||
        latest.projectionRevision !== record.projectionRevision ||
        latestIdentity.token !== identity.token ||
        !shouldRearm(latest.dispatch, now, workflowRunLoss)
      ) {
        return null;
      }
      latest.dispatch = {
        status: "pending",
        token: randomUUID(),
        runAtMs: latest.nextRunAtMs ?? identity.runAtMs,
        wakeAtMs: latest.nextRunAtMs ?? identity.runAtMs,
        attempt: identity.attempt + 1,
      };
      return latest;
    })) ?? record;
  const replaced =
    rearmed.projectionRevision === record.projectionRevision &&
    rearmed.dispatch.status === "pending" &&
    rearmed.dispatch.token !== identity.token;
  if (replaced) {
    await cancelSupersededCronWake(supersededWorkflowRunId);
  }
  return rearmed;
}

async function claimDispatchStart(
  record: CronProjectionRecordV1,
  now: number,
): Promise<CronProjectionRecordV1 | null> {
  if (record.dispatch.status !== "pending") return null;
  const store = getStore();
  const dispatchClaim = record.dispatch.token;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const latest = await readCronProjection(store);
    if (!latest) return null;
    if (
      latest.projectionRevision !== record.projectionRevision ||
      latest.dispatch.status !== "pending" ||
      latest.dispatch.token !== dispatchClaim
    ) {
      return null;
    }
    const next: CronProjectionRecordV1 = {
      ...latest,
      revision: latest.revision + 1,
      dispatch: {
        ...latest.dispatch,
        status: "starting",
        wakeAtMs: resolveCronWakeAtMs(latest.dispatch.runAtMs, now),
        startLeaseExpiresAtMs: now + DISPATCH_START_LEASE_MS,
      },
    };
    if (
      await store.compareAndSetValue(
        cronProjectionKey(),
        latest.revision,
        next,
      )
    ) {
      return next;
    }
  }
  throw new Error("cron_projection_start_claim_cas_exhausted");
}

export async function startCronProjectionDispatch(options: {
  origin: string;
  startWorkflow: StartCronWakeWorkflow;
  getWorkflowRunStatus?: (runId: string) => Promise<CronWorkflowRunStatus>;
  now?: () => number;
}): Promise<CronProjectionReconcileResult> {
  const now = options.now?.() ?? Date.now();
  let record = await readCronProjection();
  if (!record) {
    return {
      status: "empty",
      projectionRevision: null,
      nextRunAtMs: null,
      workflowRunId: null,
      repaired: false,
    };
  }
  let workflowRunLoss: WorkflowRunLossEvidence = null;
  if (
    (record.dispatch.status === "scheduled" ||
      record.dispatch.status === "running") &&
    options.getWorkflowRunStatus
  ) {
    try {
      const runId = record.dispatch.workflowRunId;
      const runStatus = await options.getWorkflowRunStatus(runId);
      workflowRunLoss = {
        runId,
        status:
          runStatus === "missing" ||
          runStatus === "completed" ||
          runStatus === "failed" ||
            runStatus === "cancelled"
            ? "lost"
            : runStatus,
      };
    } catch {
      workflowRunLoss = null;
    }
  }
  if (shouldRearm(record.dispatch, now, workflowRunLoss)) {
    record = await rearmStaleDispatch(record, now, workflowRunLoss);
  }
  if (record.dispatch.status === "none" || record.dispatch.status === "completed") {
    return {
      status: "idle",
      projectionRevision: record.projectionRevision,
      nextRunAtMs: record.nextRunAtMs,
      workflowRunId: null,
      repaired: false,
    };
  }
  if (record.dispatch.status !== "pending") {
    const dispatchStatus =
      record.dispatch.status === "failed"
        ? "failed"
        : record.dispatch.status === "starting"
          ? "starting"
          : "scheduled";
    return {
      status: dispatchStatus,
      projectionRevision: record.projectionRevision,
      nextRunAtMs: record.nextRunAtMs,
      workflowRunId:
        record.dispatch.status === "scheduled" ||
        record.dispatch.status === "running"
          ? record.dispatch.workflowRunId
          : null,
      repaired: false,
    };
  }

  const claimed = await claimDispatchStart(record, now);
  if (!claimed || claimed.dispatch.status !== "starting") {
    return {
      status: "starting",
      projectionRevision: record.projectionRevision,
      nextRunAtMs: record.nextRunAtMs,
      workflowRunId: null,
      repaired: false,
    };
  }

  const dispatchClaim = claimed.dispatch.token;
  const envelope: CronWakeWorkflowEnvelopeV1 = {
    version: 1,
    projectionRevision: claimed.projectionRevision,
    token: dispatchClaim,
    runAtMs: claimed.dispatch.runAtMs,
    wakeAtMs: claimed.dispatch.wakeAtMs,
    origin: options.origin,
  };
  let startedRunId: string | null = null;
  try {
    const workflow = await options.startWorkflow(envelope);
    startedRunId = workflow.runId;
    const scheduled = await mutateCronProjection((latest) => {
      if (
        latest.projectionRevision !== envelope.projectionRevision ||
        latest.dispatch.status !== "starting" ||
        latest.dispatch.token !== envelope.token
      ) {
        return null;
      }
      latest.dispatch = {
        status: "scheduled",
        token: envelope.token,
        runAtMs: envelope.runAtMs,
        wakeAtMs: envelope.wakeAtMs,
        attempt: latest.dispatch.attempt,
        workflowRunId: workflow.runId,
        scheduledAtMs: now,
      };
      return latest;
    });
    const installed =
      scheduled?.projectionRevision === envelope.projectionRevision &&
      scheduled.dispatch.status === "scheduled" &&
      scheduled.dispatch.token === envelope.token &&
      scheduled.dispatch.workflowRunId === workflow.runId;
    if (!installed) {
      const current = await readCronProjection();
      const handedOff = Boolean(
        current?.projectionRevision === envelope.projectionRevision &&
          ((current.dispatch.status === "completed" &&
            current.dispatch.token === envelope.token) ||
            ((current.dispatch.status === "scheduled" ||
              current.dispatch.status === "running") &&
              current.dispatch.token === envelope.token &&
              current.dispatch.workflowRunId !== workflow.runId)),
      );
      if (!handedOff) {
        await cancelSupersededCronWake(workflow.runId);
      }
      startedRunId = null;
      if (!current) {
        return {
          status: "empty",
          projectionRevision: null,
          nextRunAtMs: null,
          workflowRunId: null,
          repaired: false,
        };
      }
      const currentDispatch = current.dispatch;
      const status =
        currentDispatch.status === "none" || currentDispatch.status === "completed"
          ? "idle"
          : currentDispatch.status === "failed"
            ? "failed"
            : currentDispatch.status === "scheduled" ||
                currentDispatch.status === "running"
              ? "scheduled"
              : "starting";
      return {
        status,
        projectionRevision: current.projectionRevision,
        nextRunAtMs: current.nextRunAtMs,
        workflowRunId:
          currentDispatch.status === "scheduled" ||
          currentDispatch.status === "running"
            ? currentDispatch.workflowRunId
            : null,
        repaired: false,
      };
    }
    startedRunId = null;
    logInfo("cron.projection_workflow_started", {
      projectionRevision: envelope.projectionRevision,
      runAtMs: envelope.runAtMs,
      workflowRunId: workflow.runId,
    });
    return {
      status: "started",
      projectionRevision: envelope.projectionRevision,
      nextRunAtMs: envelope.runAtMs,
      workflowRunId: workflow.runId,
      repaired: claimed.dispatch.attempt > 0,
    };
  } catch (error) {
    let durableDispatch: CronProjectionRecordV1 | null | undefined;
    if (startedRunId) {
      try {
        const current = await readCronProjection();
        const ownsCurrentDispatch = Boolean(
          current?.projectionRevision === envelope.projectionRevision &&
            ((current.dispatch.status === "completed" &&
              current.dispatch.token === envelope.token) ||
              ((current.dispatch.status === "scheduled" ||
                current.dispatch.status === "running") &&
                current.dispatch.token === envelope.token)),
        );
        if (ownsCurrentDispatch) {
          durableDispatch = current;
        } else {
          await cancelSupersededCronWake(startedRunId);
          durableDispatch = null;
        }
      } catch {
        // A lost Redis acknowledgement is ambiguous. Leave the token-safe
        // Workflow alive; a later CAS/reconciler decides its ownership.
        durableDispatch = undefined;
      }
    }
    if (durableDispatch) {
      const workflowRunId =
        durableDispatch.dispatch.status === "scheduled" ||
        durableDispatch.dispatch.status === "running"
          ? durableDispatch.dispatch.workflowRunId
          : null;
      return {
        status: "started",
        projectionRevision: durableDispatch.projectionRevision,
        nextRunAtMs: durableDispatch.nextRunAtMs,
        workflowRunId,
        repaired: claimed.dispatch.attempt > 0,
      };
    }
    await mutateCronProjection((latest) => {
      if (
        latest.projectionRevision !== envelope.projectionRevision ||
        latest.dispatch.status !== "starting" ||
        latest.dispatch.token !== envelope.token
      ) {
        return null;
      }
      latest.dispatch = {
        status: "failed",
        token: envelope.token,
        runAtMs: envelope.runAtMs,
        wakeAtMs: envelope.wakeAtMs,
        attempt: latest.dispatch.attempt,
        failedAtMs: now,
        retryAtMs: now + DISPATCH_RETRY_MS,
        errorCode: "workflow-start-failed",
      };
      return latest;
    });
    logWarn("cron.projection_workflow_start_failed", {
      projectionRevision: envelope.projectionRevision,
      runAtMs: envelope.runAtMs,
      error: error instanceof Error ? error.name : "unknown",
    });
    return {
      status: "failed",
      projectionRevision: envelope.projectionRevision,
      nextRunAtMs: envelope.runAtMs,
      workflowRunId: null,
      repaired: false,
    };
  }
}

export async function reconcileCronProjection(options: {
  origin: string;
  startWorkflow: StartCronWakeWorkflow;
  getWorkflowRunStatus?: (runId: string) => Promise<CronWorkflowRunStatus>;
  now?: () => number;
  enabled: boolean;
  bootstrapFromLegacyJobs?: boolean;
}): Promise<CronProjectionReconcileResult> {
  const now = options.now ?? Date.now;
  if (!options.enabled) {
    const record = await readCronProjection();
    return {
      status: "unsupported",
      projectionRevision: record?.projectionRevision ?? null,
      nextRunAtMs: record?.nextRunAtMs ?? null,
      workflowRunId: null,
      repaired: false,
    };
  }
  const record = await migrateLegacyCronWake({
    now,
    enabled: options.enabled,
    bootstrapFromLegacyJobs: options.bootstrapFromLegacyJobs,
  });
  if (record?.source) {
    await clearLegacyCronStateAfterBaseline({ now });
  }
  return startCronProjectionDispatch(options);
}

export async function claimCronWake(
  envelope: CronWakeWorkflowEnvelopeV1,
  workflowRunId: string,
  now: number,
  enabled: boolean,
  parentWorkflowRunId: string | null = null,
): Promise<boolean> {
  if (!enabled) return false;
  const store = getStore();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const latest = await readCronProjection(store);
    if (!latest || latest.projectionRevision !== envelope.projectionRevision) {
      return false;
    }
    if (
      latest.dispatch.status === "running" &&
      latest.dispatch.token === envelope.token
    ) {
      return latest.dispatch.workflowRunId === workflowRunId;
    }
    if (
      latest.dispatch.status === "none" ||
      latest.dispatch.status === "completed" ||
      latest.dispatch.status === "failed" ||
      latest.dispatch.token !== envelope.token ||
      latest.dispatch.runAtMs !== envelope.runAtMs ||
      latest.dispatch.wakeAtMs !== envelope.wakeAtMs ||
      now + 1_000 < envelope.wakeAtMs
    ) {
      return false;
    }
    if (
      latest.dispatch.status === "scheduled" &&
      latest.dispatch.workflowRunId !== workflowRunId &&
      latest.dispatch.workflowRunId !== parentWorkflowRunId
    ) {
      // Before handoff persistence, the timer parent is authoritative. After
      // handoff, only its recorded child may claim this wake.
      return false;
    }
    const next: CronProjectionRecordV1 = {
      ...latest,
      revision: latest.revision + 1,
      dispatch: {
        status: "running",
        token: envelope.token,
        runAtMs: envelope.runAtMs,
        wakeAtMs: envelope.wakeAtMs,
        attempt: latest.dispatch.attempt,
        claimedAtMs: now,
        workflowRunId,
      },
    };
    if (
      await store.compareAndSetValue(
        cronProjectionKey(),
        latest.revision,
        next,
      )
    ) {
      return true;
    }
  }
  throw new Error("cron_projection_claim_cas_exhausted");
}

export async function isCronWakeClaimCurrent(
  envelope: CronWakeWorkflowEnvelopeV1,
  workflowRunId: string,
  enabled: boolean,
): Promise<boolean> {
  if (!enabled) return false;
  const latest = await readCronProjection();
  return (
    latest?.projectionRevision === envelope.projectionRevision &&
    latest.dispatch.status === "running" &&
    latest.dispatch.token === envelope.token &&
    latest.dispatch.runAtMs === envelope.runAtMs &&
    latest.dispatch.wakeAtMs === envelope.wakeAtMs &&
    latest.dispatch.workflowRunId === workflowRunId
  );
}

export async function isCronWakeDispatchCurrent(
  envelope: CronWakeWorkflowEnvelopeV1,
  enabled: boolean,
): Promise<boolean> {
  if (!enabled) return false;
  const latest = await readCronProjection();
  return Boolean(
    latest?.projectionRevision === envelope.projectionRevision &&
      latest.dispatch.status !== "none" &&
      latest.dispatch.token === envelope.token &&
      latest.dispatch.runAtMs === envelope.runAtMs &&
      latest.dispatch.wakeAtMs === envelope.wakeAtMs,
  );
}

export async function completeCronWake(
  envelope: CronWakeWorkflowEnvelopeV1,
  workflowRunId: string,
  now = Date.now(),
): Promise<boolean> {
  const completed = await mutateCronProjection((latest) => {
    if (
      latest.projectionRevision !== envelope.projectionRevision ||
      latest.dispatch.status !== "running" ||
      latest.dispatch.token !== envelope.token ||
      latest.dispatch.workflowRunId !== workflowRunId
    ) {
      return null;
    }
    latest.dispatch = {
      status: "completed",
      token: envelope.token,
      runAtMs: envelope.runAtMs,
      wakeAtMs: envelope.wakeAtMs,
      attempt: latest.dispatch.attempt,
      completedAtMs: now,
      workflowRunId,
    };
    return latest;
  });
  return Boolean(
    completed?.projectionRevision === envelope.projectionRevision &&
      completed.dispatch.status === "completed" &&
      completed.dispatch.token === envelope.token,
  );
}

export async function recordCronWakeHandoff(
  envelope: CronWakeWorkflowEnvelopeV1,
  workflowRunId: string,
  parentWorkflowRunId: string,
  now = Date.now(),
): Promise<CronWakeHandoffResult> {
  const recorded = await mutateCronProjection((latest) => {
    if (
      latest.projectionRevision !== envelope.projectionRevision ||
      (latest.dispatch.status !== "starting" &&
        latest.dispatch.status !== "scheduled") ||
      latest.dispatch.token !== envelope.token ||
      latest.dispatch.runAtMs !== envelope.runAtMs ||
      latest.dispatch.wakeAtMs !== envelope.wakeAtMs ||
      (latest.dispatch.status === "scheduled" &&
        latest.dispatch.workflowRunId !== parentWorkflowRunId &&
        latest.dispatch.workflowRunId !== workflowRunId)
    ) {
      return null;
    }
    latest.dispatch = {
      status: "scheduled",
      token: envelope.token,
      runAtMs: envelope.runAtMs,
      wakeAtMs: envelope.wakeAtMs,
      attempt: latest.dispatch.attempt,
      workflowRunId,
      scheduledAtMs: now,
    };
    return latest;
  });
  if (
    recorded?.projectionRevision === envelope.projectionRevision &&
    (recorded.dispatch.status === "scheduled" ||
      recorded.dispatch.status === "running") &&
    recorded.dispatch.token === envelope.token &&
    recorded.dispatch.workflowRunId === workflowRunId
  ) {
    return "installed";
  }
  if (
    recorded?.projectionRevision === envelope.projectionRevision &&
    recorded.dispatch.status === "completed" &&
    recorded.dispatch.token === envelope.token &&
    recorded.dispatch.workflowRunId === workflowRunId
  ) {
    return "owned";
  }
  if (
    recorded?.projectionRevision === envelope.projectionRevision &&
    (recorded.dispatch.status === "scheduled" ||
      recorded.dispatch.status === "running" ||
      recorded.dispatch.status === "completed") &&
    recorded.dispatch.token === envelope.token &&
    recorded.dispatch.workflowRunId !== parentWorkflowRunId
  ) {
    return "occupied";
  }
  return "stale";
}

export async function getCronWakeHandoffState(
  envelope: CronWakeWorkflowEnvelopeV1,
  parentWorkflowRunId: string,
): Promise<CronWakeHandoffState> {
  const latest = await readCronProjection();
  if (
    latest?.projectionRevision !== envelope.projectionRevision ||
    latest.dispatch.status === "none" ||
    latest.dispatch.token !== envelope.token ||
    latest.dispatch.runAtMs !== envelope.runAtMs ||
    latest.dispatch.wakeAtMs !== envelope.wakeAtMs
  ) {
    return "stale";
  }
  if (latest.dispatch.status === "starting") return "ready";
  if (latest.dispatch.status === "scheduled") {
    return latest.dispatch.workflowRunId === parentWorkflowRunId
      ? "ready"
      : "already";
  }
  return latest.dispatch.status === "running" ||
    latest.dispatch.status === "completed"
    ? "already"
    : "stale";
}
