import { randomUUID } from "node:crypto";

import { logInfo, logWarn } from "@/server/log";
import { getSandboxController } from "@/server/sandbox/controller";
import { HostSuspensionBusyError } from "@/server/sandbox/host-suspension";
import {
  sandboxDeadlineKey,
  sandboxDeadlineLockKey,
  sandboxDeadlineV2Key,
} from "@/server/store/keyspace";
import { getInitializedMeta, getStore, mutateMeta } from "@/server/store/store";
import {
  getSandboxPlatformTimeoutMs,
  getSandboxSleepAfterMs,
  getSandboxTimeoutExtensionMs,
  SANDBOX_TIMEOUT_SAFETY_RUNWAY_MS,
} from "@/server/sandbox/timeout";
import { ApiError } from "@/shared/http";
import type { SingleMeta } from "@/shared/types";

const DEADLINE_COORDINATOR_LOCK_TTL_SECONDS = 30;
const DEADLINE_STOP_LOCK_TTL_SECONDS = 330;
const DEADLINE_LOCK_RETRY_MS = 25;
const DEADLINE_LOCK_ATTEMPTS = 40;
const WORKFLOW_STALL_GRACE_MS = 60_000;
const WORKFLOW_START_LEASE_MS = 60_000;
const DEADLINE_CAS_ATTEMPTS = 10;
const MIN_BUSY_RETRY_MS = 15_000;
const TRANSITIONAL_RETRY_MS = 5_000;
const DEFAULT_ERROR_RETRY_MS = 30_000;

export type SandboxDeadlineState = {
  version: 2;
  revision: number;
  generationId: string;
  lifecycleAttemptId: string | null;
  sandboxId: string;
  deadlineAtMs: number;
  /** Absolute latest idle-stop deadline derived from native session expiry. */
  nativeStopDeadlineAtMs: number | null;
  desiredIdleMs: number;
  platformTimeoutMs: number;
  workflowRunId: string | null;
  /** Fences a single durable Workflow-start intent for this generation. */
  workflowAttemptId: string | null;
  workflowStartLeaseExpiresAtMs: number | null;
  workflowStartedAtMs: number | null;
  /** Deadline the attached Workflow may currently be sleeping toward. */
  workflowScheduledDeadlineAtMs: number | null;
  updatedAtMs: number;
  lastAttemptAtMs: number | null;
  lastOutcome: "armed" | "stopping" | "busy" | "error" | null;
  lastErrorCode: string | null;
  lastErrorClass: string | null;
};

export type DeadlineCoordinatorDeps = {
  read: () => Promise<SandboxDeadlineState | null>;
  readLegacy: () => Promise<SandboxDeadlineState | null>;
  write: (state: SandboxDeadlineState) => Promise<void>;
  compareAndSet: (
    expectedRevision: number | null,
    state: SandboxDeadlineState,
  ) => Promise<boolean>;
  createMigrated: (state: SandboxDeadlineState) => Promise<boolean>;
  clear: () => Promise<void>;
  getMeta: () => Promise<SingleMeta>;
  recordActivity: (input: {
    sandboxId: string;
    lifecycleAttemptId: string | null;
    activityAtMs: number;
  }) => Promise<SingleMeta>;
  acquireLock: () => Promise<string | null>;
  renewLock: (token: string) => Promise<boolean>;
  releaseLock: (token: string) => Promise<void>;
  startWorkflow: (
    generationId: string,
    workflowAttemptId: string,
  ) => Promise<string>;
  getWorkflowStatus: (
    runId: string,
  ) => Promise<"pending" | "running" | "completed" | "failed" | "cancelled" | "missing" | "unknown">;
  now: () => number;
  randomId: () => string;
};

const defaultDeps: DeadlineCoordinatorDeps = {
  read: () => getStore().getValue<SandboxDeadlineState>(sandboxDeadlineV2Key()),
  readLegacy: () => getStore().getValue<SandboxDeadlineState>(sandboxDeadlineKey()),
  write: (state) => getStore().setValue(sandboxDeadlineV2Key(), state),
  compareAndSet: (expectedRevision, state) => getStore().compareAndSetValue(
    sandboxDeadlineV2Key(),
    expectedRevision,
    state,
  ),
  createMigrated: (state) => getStore().compareAndSetValue(
    sandboxDeadlineV2Key(),
    null,
    state,
  ),
  clear: () => getStore().deleteValue(sandboxDeadlineV2Key()),
  getMeta: getInitializedMeta,
  recordActivity: (input) => mutateMeta((meta) => {
    if (
      meta.status !== "running"
      || meta.sandboxId !== input.sandboxId
      || (meta.lifecycleAttemptId ?? null) !== input.lifecycleAttemptId
    ) return;
    meta.lastAccessedAt = Math.max(
      meta.lastAccessedAt ?? input.activityAtMs,
      input.activityAtMs,
    );
  }),
  acquireLock: () => getStore().acquireLock(
    sandboxDeadlineLockKey(),
    DEADLINE_COORDINATOR_LOCK_TTL_SECONDS,
  ),
  renewLock: (token) => getStore().renewLock(
    sandboxDeadlineLockKey(),
    token,
    DEADLINE_COORDINATOR_LOCK_TTL_SECONDS,
  ),
  releaseLock: (token) => getStore().releaseLock(sandboxDeadlineLockKey(), token),
  startWorkflow: async (generationId, workflowAttemptId) => {
    const { startSandboxDeadlineWorkflow } = await import(
      "@/server/workflows/sandbox/deadline-runtime"
    );
    return startSandboxDeadlineWorkflow(generationId, workflowAttemptId);
  },
  getWorkflowStatus: async (runId) => {
    try {
      const { getRun } = await import("workflow/api");
      const run = getRun(runId);
      if (!(await run.exists)) return "missing";
      return await run.status;
    } catch (error) {
      logWarn("sandbox.deadline.workflow_status_failed", {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
      return "unknown";
    }
  },
  now: () => Date.now(),
  randomId: () => randomUUID(),
};

async function acquireDeadlineLockWithRetry(
  deps: Pick<DeadlineCoordinatorDeps, "acquireLock">,
): Promise<string | null> {
  for (let attempt = 0; attempt < DEADLINE_LOCK_ATTEMPTS; attempt += 1) {
    const token = await deps.acquireLock();
    if (token) return token;
    await new Promise((resolve) => setTimeout(resolve, DEADLINE_LOCK_RETRY_MS));
  }
  return null;
}

function sameGeneration(
  state: SandboxDeadlineState | null,
  meta: SingleMeta,
): state is SandboxDeadlineState {
  return state?.sandboxId === meta.sandboxId
    && state.lifecycleAttemptId === (meta.lifecycleAttemptId ?? null);
}

type WorkflowStartPlan =
  | { kind: "none" }
  | { kind: "check"; generationId: string; workflowRunId: string }
  | {
      kind: "start";
      generationId: string;
      workflowAttemptId: string;
    };

function workflowRunIsTerminal(
  status: Awaited<ReturnType<DeadlineCoordinatorDeps["getWorkflowStatus"]>>,
): boolean {
  return status === "completed"
    || status === "failed"
    || status === "cancelled"
    || status === "missing";
}

function workflowRunLooksStale(
  state: SandboxDeadlineState,
  now: number,
): boolean {
  if (now < state.deadlineAtMs + WORKFLOW_STALL_GRACE_MS) return false;
  return state.lastAttemptAtMs === null
    || now - state.lastAttemptAtMs >= WORKFLOW_STALL_GRACE_MS;
}

function logDeadlineArmed(state: SandboxDeadlineState): void {
  logInfo("sandbox.deadline.armed", {
    generationId: state.generationId,
    sandboxId: state.sandboxId,
    deadlineAtMs: state.deadlineAtMs,
    desiredIdleMs: state.desiredIdleMs,
    platformTimeoutMs: state.platformTimeoutMs,
  });
}

function prepareDeadlineWorkflowStart(
  state: SandboxDeadlineState,
  deps: DeadlineCoordinatorDeps,
): { state: SandboxDeadlineState; plan: Extract<WorkflowStartPlan, { kind: "start" }> } {
  const startedAtMs = deps.now();
  const workflowAttemptId = deps.randomId();
  return {
    state: {
      ...state,
      workflowRunId: null,
      workflowAttemptId,
      workflowStartLeaseExpiresAtMs: startedAtMs + WORKFLOW_START_LEASE_MS,
      workflowStartedAtMs: startedAtMs,
      workflowScheduledDeadlineAtMs: state.deadlineAtMs,
      updatedAtMs: startedAtMs,
      lastOutcome: "armed",
      lastErrorCode: null,
      lastErrorClass: null,
    },
    plan: {
      kind: "start",
      generationId: state.generationId,
      workflowAttemptId,
    },
  };
}

async function migrateLegacyDeadlineState(
  state: SandboxDeadlineState | null,
  lockToken: string,
  deps: DeadlineCoordinatorDeps,
): Promise<SandboxDeadlineState | null> {
  if (state) {
    const persisted = state as unknown as {
      version?: unknown;
      revision?: unknown;
    };
    if (persisted.version === 2 && Number.isInteger(persisted.revision)) {
      return state;
    }
    throw new ApiError(
      503,
      "SANDBOX_DEADLINE_TRANSITION",
      "Sandbox deadline v2 state is not a recognized durable schema.",
    );
  }

  const legacy = await deps.readLegacy();
  if (!legacy) return null;
  const persisted = legacy as unknown as {
    version?: unknown;
    revision?: unknown;
  };
  if (persisted.version !== 1 || Number.isInteger(persisted.revision)) {
    throw new ApiError(
      503,
      "SANDBOX_DEADLINE_TRANSITION",
      "Sandbox deadline v1 state is not a recognized durable schema.",
    );
  }
  if (!await deps.renewLock(lockToken)) {
    throw new ApiError(
      503,
      "SANDBOX_DEADLINE_TRANSITION",
      "Sandbox deadline migration ownership expired; retry this request.",
    );
  }

  // Rotate the generation so a Workflow pinned to the v1 deployment exits
  // instead of publishing the unrevisioned record again after migration.
  const migrated: SandboxDeadlineState = {
    ...legacy,
    version: 2,
    revision: 1,
    generationId: deps.randomId(),
    workflowRunId: null,
    workflowAttemptId: null,
    workflowStartLeaseExpiresAtMs: null,
    workflowStartedAtMs: null,
    workflowScheduledDeadlineAtMs: null,
    updatedAtMs: deps.now(),
    lastAttemptAtMs: null,
    lastOutcome: "armed",
    lastErrorCode: null,
    lastErrorClass: null,
  };
  if (await deps.createMigrated(migrated)) return migrated;
  const winner = await deps.read();
  if (winner?.version === 2 && Number.isInteger(winner.revision)) return winner;
  throw new ApiError(
    503,
    "SANDBOX_DEADLINE_TRANSITION",
    "Sandbox deadline state changed during schema migration; retry this request.",
  );
}

async function publishDeadlineState(
  expected: SandboxDeadlineState | null,
  state: SandboxDeadlineState,
  lockToken: string,
  deps: DeadlineCoordinatorDeps,
): Promise<SandboxDeadlineState> {
  let currentExpected = expected;
  let desired = state;
  for (let attempt = 0; attempt < DEADLINE_CAS_ATTEMPTS; attempt += 1) {
    if (!await deps.renewLock(lockToken)) {
      throw new ApiError(
        503,
        "SANDBOX_DEADLINE_TRANSITION",
        "Sandbox idle transition ownership expired; retry this request.",
      );
    }
    const revision = (currentExpected?.revision ?? 0) + 1;
    const published = { ...desired, revision };
    if (await deps.compareAndSet(currentExpected?.revision ?? null, published)) {
      return published;
    }

    const winner = await deps.read();
    const attachmentWon = currentExpected?.workflowRunId === null
      && currentExpected.workflowAttemptId !== null
      && winner?.generationId === currentExpected.generationId
      && winner.workflowAttemptId === currentExpected.workflowAttemptId
      && winner.workflowRunId !== null;
    if (!attachmentWon) break;
    currentExpected = winner;
    desired = {
      ...desired,
      workflowRunId: winner.workflowRunId,
      workflowAttemptId: winner.workflowAttemptId,
      workflowStartLeaseExpiresAtMs: null,
      workflowStartedAtMs: winner.workflowStartedAtMs,
      workflowScheduledDeadlineAtMs: winner.workflowScheduledDeadlineAtMs,
    };
  }
  throw new ApiError(
    503,
    "SANDBOX_DEADLINE_TRANSITION",
    "Sandbox idle transition changed concurrently; retry this request.",
  );
}

async function attachDeadlineWorkflowRun(
  generationId: string,
  workflowAttemptId: string,
  workflowRunId: string,
  deps: DeadlineCoordinatorDeps,
): Promise<SandboxDeadlineState | null> {
  for (let attempt = 0; attempt < DEADLINE_CAS_ATTEMPTS; attempt += 1) {
    const current = await deps.read();
    if (
      !current
      || current.generationId !== generationId
      || current.workflowAttemptId !== workflowAttemptId
    ) return null;
    if (current.workflowRunId === workflowRunId) return current;
    if (current.workflowRunId !== null) return null;

    const attached: SandboxDeadlineState = {
      ...current,
      revision: current.revision + 1,
      workflowRunId,
      workflowStartLeaseExpiresAtMs: null,
      workflowStartedAtMs: deps.now(),
      workflowScheduledDeadlineAtMs: current.deadlineAtMs,
      updatedAtMs: deps.now(),
      lastOutcome: "armed",
      lastErrorCode: null,
      lastErrorClass: null,
    };
    if (await deps.compareAndSet(current.revision, attached)) return attached;
  }
  throw new ApiError(
    503,
    "SANDBOX_DEADLINE_TRANSITION",
    "Sandbox deadline Workflow attachment changed concurrently; retry this step.",
  );
}

async function releaseFailedDeadlineWorkflowStart(
  generationId: string,
  workflowAttemptId: string,
  error: unknown,
  deps: DeadlineCoordinatorDeps,
): Promise<void> {
  for (let attempt = 0; attempt < DEADLINE_CAS_ATTEMPTS; attempt += 1) {
    const current = await deps.read();
    if (
      !current
      || current.generationId !== generationId
      || current.workflowAttemptId !== workflowAttemptId
      || current.workflowRunId !== null
    ) return;
    const identity = errorIdentity(error);
    const released: SandboxDeadlineState = {
      ...current,
      revision: current.revision + 1,
      workflowAttemptId: null,
      workflowStartLeaseExpiresAtMs: null,
      workflowStartedAtMs: null,
      updatedAtMs: deps.now(),
      lastOutcome: "error",
      lastErrorCode: identity.code,
      lastErrorClass: identity.className,
    };
    if (await deps.compareAndSet(current.revision, released)) return;
  }
}

/** Attach a started Workflow only while its durable start intent is canonical. */
export async function adoptSandboxDeadlineWorkflow(
  generationId: string,
  workflowAttemptId: string,
  workflowRunId: string,
  deps: DeadlineCoordinatorDeps = defaultDeps,
): Promise<boolean> {
  return await attachDeadlineWorkflowRun(
    generationId,
    workflowAttemptId,
    workflowRunId,
    deps,
  ) !== null;
}

async function executeDeadlineWorkflowStart(
  plan: Extract<WorkflowStartPlan, { kind: "start" }>,
  deps: DeadlineCoordinatorDeps,
): Promise<SandboxDeadlineState | null> {
  let workflowRunId: string;
  try {
    workflowRunId = await deps.startWorkflow(
      plan.generationId,
      plan.workflowAttemptId,
    );
  } catch (error) {
    await releaseFailedDeadlineWorkflowStart(
      plan.generationId,
      plan.workflowAttemptId,
      error,
      deps,
    );
    throw error;
  }
  return attachDeadlineWorkflowRun(
    plan.generationId,
    plan.workflowAttemptId,
    workflowRunId,
    deps,
  );
}

/** Arm or move one durable desired-idle deadline for the current sandbox generation. */
export async function armSandboxDeadline(
  meta: SingleMeta,
  deps: DeadlineCoordinatorDeps = defaultDeps,
  options: {
    refreshDeadline?: boolean;
    forceWorkflowStart?: boolean;
    activityAtMs?: number;
    nativeTimeoutRemainingMs?: number;
  } = {},
): Promise<SandboxDeadlineState | null> {
  if (meta.status !== "running" || !meta.sandboxId) return null;

  const token = await acquireDeadlineLockWithRetry(deps);
  if (!token) {
    const [winner, latestMeta] = await Promise.all([deps.read(), deps.getMeta()]);
    if (
      latestMeta.status !== "running"
      || latestMeta.sandboxId !== meta.sandboxId
      || (latestMeta.lifecycleAttemptId ?? null) !== (meta.lifecycleAttemptId ?? null)
    ) {
      return null;
    }
    if (
      options.activityAtMs === undefined
      && sameGeneration(winner, latestMeta)
      && winner.deadlineAtMs > deps.now()
    ) {
      return winner;
    }
    throw new ApiError(
      503,
      "SANDBOX_DEADLINE_TRANSITION",
      "Sandbox idle transition is in progress; retry this request.",
    );
  }

  let armedState: SandboxDeadlineState | null = null;
  let workflowPlan: WorkflowStartPlan = { kind: "none" };
  try {
    let latestMeta = await deps.getMeta();
    if (
      latestMeta.status !== "running"
      || latestMeta.sandboxId !== meta.sandboxId
      || (latestMeta.lifecycleAttemptId ?? null) !== (meta.lifecycleAttemptId ?? null)
    ) {
      return null;
    }
    if (options.activityAtMs !== undefined) {
      latestMeta = await deps.recordActivity({
        sandboxId: meta.sandboxId,
        lifecycleAttemptId: meta.lifecycleAttemptId ?? null,
        activityAtMs: options.activityAtMs,
      });
      if (
        latestMeta.status !== "running"
        || latestMeta.sandboxId !== meta.sandboxId
        || (latestMeta.lifecycleAttemptId ?? null) !== (meta.lifecycleAttemptId ?? null)
      ) {
        return null;
      }
    }
    const now = deps.now();
    const desiredIdleMs = getSandboxSleepAfterMs();
    const platformTimeoutMs = getSandboxPlatformTimeoutMs();
    const committedActivityAtMs = typeof latestMeta.lastAccessedAt === "number"
      ? latestMeta.lastAccessedAt
      : now;
    const desiredDeadlineAtMs = committedActivityAtMs + desiredIdleMs;
    const existing = await migrateLegacyDeadlineState(
      await deps.read(),
      token,
      deps,
    );
    const current = sameGeneration(existing, latestMeta) ? existing : null;
    // The lifecycle owner claimed this exact expired generation while holding
    // the lifecycle lock. Activity may not reopen it behind the admission
    // fence; the stop outcome will clear or re-arm the deadline.
    if (current?.lastOutcome === "stopping") return null;
    const existingNativeStopDeadlineAtMs = current?.nativeStopDeadlineAtMs ?? null;
    const nativeStopDeadlineAtMs = options.nativeTimeoutRemainingMs === undefined
      ? existingNativeStopDeadlineAtMs
      : now + Math.max(
          0,
          options.nativeTimeoutRemainingMs - SANDBOX_TIMEOUT_SAFETY_RUNWAY_MS,
        );
    const refreshedDeadlineAtMs = Math.min(
      desiredDeadlineAtMs,
      nativeStopDeadlineAtMs ?? desiredDeadlineAtMs,
    );
    const priorScheduledDeadlineAtMs = current?.workflowRunId
      ? current.workflowScheduledDeadlineAtMs ?? current.deadlineAtMs
      : null;
    let state: SandboxDeadlineState = current
      ? {
          ...current,
          deadlineAtMs: options.refreshDeadline === false
            ? Math.min(current.deadlineAtMs, refreshedDeadlineAtMs)
            : refreshedDeadlineAtMs,
          nativeStopDeadlineAtMs,
          desiredIdleMs,
          platformTimeoutMs,
          workflowRunId: current.workflowRunId ?? null,
          workflowAttemptId: current.workflowAttemptId ?? null,
          workflowStartLeaseExpiresAtMs:
            current.workflowStartLeaseExpiresAtMs ?? null,
          workflowScheduledDeadlineAtMs: current.workflowRunId
            ? current.workflowScheduledDeadlineAtMs ?? current.deadlineAtMs
            : current.workflowScheduledDeadlineAtMs ?? null,
          updatedAtMs: now,
          lastOutcome: "armed",
          lastErrorCode: null,
          lastErrorClass: null,
        }
      : {
          version: 2,
          revision: existing?.revision ?? 0,
          generationId: deps.randomId(),
          lifecycleAttemptId: latestMeta.lifecycleAttemptId ?? null,
          sandboxId: latestMeta.sandboxId,
          deadlineAtMs: refreshedDeadlineAtMs,
          nativeStopDeadlineAtMs,
          desiredIdleMs,
          platformTimeoutMs,
          workflowRunId: null,
          workflowAttemptId: null,
          workflowStartLeaseExpiresAtMs: null,
          workflowStartedAtMs: null,
          workflowScheduledDeadlineAtMs: null,
          updatedAtMs: now,
          lastAttemptAtMs: null,
          lastOutcome: "armed",
          lastErrorCode: null,
          lastErrorClass: null,
        };
    if (options.refreshDeadline !== false) {
      state.lastAttemptAtMs = null;
    }
    const deadlineMovedEarlier = state.workflowRunId !== null
      && priorScheduledDeadlineAtMs !== null
      && state.deadlineAtMs < priorScheduledDeadlineAtMs;
    const pendingStartIsLive = state.workflowRunId === null
      && state.workflowAttemptId !== null
      && (state.workflowStartLeaseExpiresAtMs ?? 0) > now;
    if (state.workflowRunId === null && !pendingStartIsLive) {
      const prepared = prepareDeadlineWorkflowStart(state, deps);
      state = prepared.state;
      workflowPlan = prepared.plan;
    } else if (deadlineMovedEarlier) {
      const prepared = prepareDeadlineWorkflowStart(state, deps);
      state = prepared.state;
      workflowPlan = prepared.plan;
    } else if (
      state.workflowRunId !== null
      && options.forceWorkflowStart === true
    ) {
      workflowPlan = {
        kind: "check",
        generationId: state.generationId,
        workflowRunId: state.workflowRunId,
      };
    }
    armedState = await publishDeadlineState(existing, state, token, deps);
    if (
      workflowPlan.kind === "none"
      && armedState.workflowRunId !== null
      && (armedState.workflowScheduledDeadlineAtMs ?? armedState.deadlineAtMs)
        > armedState.deadlineAtMs
    ) {
      const prepared = prepareDeadlineWorkflowStart(armedState, deps);
      armedState = await publishDeadlineState(
        armedState,
        prepared.state,
        token,
        deps,
      );
      workflowPlan = prepared.plan;
    }
  } finally {
    await deps.releaseLock(token);
  }

  if (!armedState) return null;

  if (workflowPlan.kind === "start") {
    const attached = await executeDeadlineWorkflowStart(workflowPlan, deps);
    if (attached) {
      armedState = attached;
      workflowPlan = { kind: "none" };
    } else {
      const current = await deps.read();
      if (current?.generationId !== workflowPlan.generationId) return null;
      armedState = current;
      workflowPlan = { kind: "none" };
    }
  }

  if (workflowPlan.kind === "check") {
    const workflowStatus = await deps.getWorkflowStatus(workflowPlan.workflowRunId);
    const terminalWorkflow = workflowRunIsTerminal(workflowStatus);
    if (!terminalWorkflow && !workflowRunLooksStale(armedState, deps.now())) {
      const current = await deps.read();
      if (current?.generationId !== workflowPlan.generationId) return null;
      logDeadlineArmed(current);
      return current;
    }

    const repairToken = await acquireDeadlineLockWithRetry(deps);
    if (!repairToken) {
      const current = await deps.read();
      if (current?.generationId !== workflowPlan.generationId) return null;
      logDeadlineArmed(current);
      return current;
    }
    try {
      const [current, currentMeta] = await Promise.all([
        deps.read(),
        deps.getMeta(),
      ]);
      if (
        !current
        || current.generationId !== workflowPlan.generationId
        || current.workflowRunId !== workflowPlan.workflowRunId
        || !sameGeneration(current, currentMeta)
      ) {
        return current?.generationId === workflowPlan.generationId ? current : null;
      }
      const now = deps.now();
      if (!terminalWorkflow && !workflowRunLooksStale(current, now)) {
        logDeadlineArmed(current);
        return current;
      }
      const repairCandidate: SandboxDeadlineState = {
        ...current,
        workflowRunId: null,
        workflowAttemptId: null,
        workflowStartLeaseExpiresAtMs: null,
        workflowStartedAtMs: null,
        workflowScheduledDeadlineAtMs: null,
        updatedAtMs: now,
      };
      const prepared = prepareDeadlineWorkflowStart(repairCandidate, deps);
      armedState = await publishDeadlineState(
        current,
        prepared.state,
        repairToken,
        deps,
      );
      workflowPlan = prepared.plan;
    } finally {
      await deps.releaseLock(repairToken);
    }
  }

  if (workflowPlan.kind === "start") {
    const attached = await executeDeadlineWorkflowStart(workflowPlan, deps);
    if (attached) armedState = attached;
    else {
      const current = await deps.read();
      if (current?.generationId !== workflowPlan.generationId) return null;
      armedState = current;
    }
  }

  logDeadlineArmed(armedState);
  return armedState;
}

type DeadlineReadDeps = Pick<
  DeadlineCoordinatorDeps,
  "read" | "getMeta" | "now"
>;

/** Read desired idle headroom only when state still owns the expected generation. */
export async function readSandboxDeadlineRemainingMs(
  expectedMeta?: SingleMeta,
  deps: DeadlineReadDeps = defaultDeps,
): Promise<number | null> {
  if (
    expectedMeta
    && (expectedMeta.status !== "running" || !expectedMeta.sandboxId)
  ) return null;

  const state = await deps.read();
  const latestMeta = await deps.getMeta();
  if (
    latestMeta.status !== "running"
    || !latestMeta.sandboxId
    || !sameGeneration(state, latestMeta)
  ) return null;
  if (
    expectedMeta
    && (
      expectedMeta.sandboxId !== latestMeta.sandboxId
      || (expectedMeta.lifecycleAttemptId ?? null)
        !== (latestMeta.lifecycleAttemptId ?? null)
    )
  ) return null;

  return Math.max(0, state.deadlineAtMs - deps.now());
}

export async function clearSandboxDeadline(
  sandboxId: string,
  options: { lifecycleAttemptId?: string | null } = {},
  deps: DeadlineCoordinatorDeps = defaultDeps,
): Promise<void> {
  const expected = await deps.read();
  if (
    expected?.sandboxId !== sandboxId
    || (
      options.lifecycleAttemptId !== undefined
      && (expected.lifecycleAttemptId ?? null) !== options.lifecycleAttemptId
    )
  ) return;

  const token = await acquireDeadlineLockWithRetry(deps);
  if (!token) return;
  try {
    // Re-read under the same lock used by arm. A completed old lifecycle must
    // never clear a deadline that a replacement generation just published.
    const state = await deps.read();
    if (
      state?.generationId === expected.generationId
      && state.sandboxId === sandboxId
      && (state.lifecycleAttemptId ?? null) === (expected.lifecycleAttemptId ?? null)
    ) await deps.clear();
  } finally {
    await deps.releaseLock(token);
  }
}

export type DeadlineStepResult =
  | { status: "done"; reason: string }
  | { status: "sleep"; deadlineAtMs: number };

/**
 * Seal an expired deadline after the caller owns the lifecycle lock. This
 * establishes the only cross-lock order: lifecycle, then deadline.
 */
export async function claimSandboxDeadlineStop(
  claim: { generationId: string; claimedAtMs: number },
  deps: DeadlineCoordinatorDeps = defaultDeps,
): Promise<boolean> {
  const token = await acquireDeadlineLockWithRetry(deps);
  if (!token) return false;
  try {
    const [state, meta] = await Promise.all([deps.read(), deps.getMeta()]);
    if (
      !state
      || state.generationId !== claim.generationId
      || state.lastAttemptAtMs !== claim.claimedAtMs
      || !sameGeneration(state, meta)
      || meta.status !== "running"
    ) return false;
    if (state.lastOutcome === "stopping") return true;
    const activityDeadlineAtMs = typeof meta.lastAccessedAt === "number"
      ? meta.lastAccessedAt + state.desiredIdleMs
      : state.deadlineAtMs;
    if (state.deadlineAtMs > deps.now() || activityDeadlineAtMs > deps.now()) {
      return false;
    }
    if (!await deps.renewLock(token)) return false;
    const stoppingState: SandboxDeadlineState = {
      ...state,
      revision: state.revision + 1,
      lastOutcome: "stopping",
      updatedAtMs: deps.now(),
    };
    return deps.compareAndSet(state.revision, stoppingState);
  } finally {
    await deps.releaseLock(token);
  }
}

export type DeadlineStepDeps = {
  read: () => Promise<SandboxDeadlineState | null>;
  write: (state: SandboxDeadlineState) => Promise<void>;
  compareAndSet: DeadlineCoordinatorDeps["compareAndSet"];
  clear: () => Promise<void>;
  acquireLock: () => Promise<string | null>;
  renewLock: (token: string) => Promise<boolean>;
  releaseLock: (token: string) => Promise<void>;
  getMeta: () => Promise<SingleMeta>;
  getSandbox: (sandboxId: string) => ReturnType<ReturnType<typeof getSandboxController>["get"]>;
  reconcile: (input: {
    sandboxId: string;
    lifecycleAttemptId: string | null;
    metaStatus: "uninitialized" | "stopped" | "error";
    lastError: string | null;
  }) => Promise<SingleMeta>;
  stop: (claim: {
    generationId: string;
    claimedAtMs: number;
  }) => Promise<SingleMeta>;
  now: () => number;
};

const defaultStepDeps: DeadlineStepDeps = {
  read: defaultDeps.read,
  write: defaultDeps.write,
  compareAndSet: defaultDeps.compareAndSet,
  clear: defaultDeps.clear,
  acquireLock: () => getStore().acquireLock(
    sandboxDeadlineLockKey(),
    DEADLINE_STOP_LOCK_TTL_SECONDS,
  ),
  renewLock: (token) => getStore().renewLock(
    sandboxDeadlineLockKey(),
    token,
    DEADLINE_STOP_LOCK_TTL_SECONDS,
  ),
  releaseLock: defaultDeps.releaseLock,
  getMeta: getInitializedMeta,
  getSandbox: (sandboxId) => getSandboxController().get({ sandboxId, resume: false }),
  reconcile: (input) => mutateMeta((meta) => {
    if (
      meta.status !== "running"
      || meta.sandboxId !== input.sandboxId
      || (meta.lifecycleAttemptId ?? null) !== input.lifecycleAttemptId
    ) return;
    if (input.metaStatus === "uninitialized") {
      meta.sandboxId = null;
      meta.portUrls = null;
      meta.pendingPersistentAutoSave = null;
      meta.activePersistentStop = null;
    }
    meta.status = input.metaStatus;
    meta.lastError = input.lastError;
    meta.lastGatewayProbeReady = false;
  }),
  stop: async (claim) => {
    const { stopSandboxForDeadline } = await import("@/server/sandbox/lifecycle");
    return stopSandboxForDeadline(claim);
  },
  now: () => Date.now(),
};

function errorIdentity(error: unknown): { code: string; className: string } {
  return {
    code: error instanceof Error && "code" in error
      ? String((error as { code: unknown }).code)
      : "DEADLINE_STOP_FAILED",
    className: error instanceof Error ? error.name : "UnknownError",
  };
}

function deadlineRetryAfterMs(error: unknown): number {
  if (error instanceof HostSuspensionBusyError) {
    return Math.max(MIN_BUSY_RETRY_MS, error.retryAfterMs ?? 0);
  }
  if (
    error instanceof Error
    && "code" in error
    && error.code === "DEADLINE_PLATFORM_TRANSITIONAL"
  ) return TRANSITIONAL_RETRY_MS;
  return DEFAULT_ERROR_RETRY_MS;
}

function deadlineSandboxIsGone(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const directStatus = "status" in error ? error.status : null;
    if (directStatus === 404 || directStatus === 410) return true;
    const response = "response" in error ? error.response : null;
    if (typeof response === "object" && response !== null && "status" in response) {
      if (response.status === 404 || response.status === 410) return true;
    }
  }
  return error instanceof Error
    && /^(?:HTTP\s+)?(?:404|410)(?:\b|:)/i.test(error.message.trim());
}

function deadlineStopClaimWasRevoked(error: unknown): boolean {
  return error instanceof Error
    && (
      error.name === "SandboxLifecycleGuardRejectedError"
      || error.name === "LifecycleLockOwnershipLostError"
      || ("code" in error && error.code === "SANDBOX_LIFECYCLE_GUARD_REJECTED")
    );
}

class DeadlineStepLeaseLostError extends Error {
  constructor() {
    super("Deadline step ownership changed concurrently.");
    this.name = "DeadlineStepLeaseLostError";
  }
}

async function publishDeadlineStepState(
  expected: SandboxDeadlineState,
  state: SandboxDeadlineState,
  lockToken: string,
  deps: DeadlineStepDeps,
): Promise<SandboxDeadlineState> {
  if (!await deps.renewLock(lockToken)) throw new DeadlineStepLeaseLostError();
  const published = { ...state, revision: expected.revision + 1 };
  if (!await deps.compareAndSet(expected.revision, published)) {
    throw new DeadlineStepLeaseLostError();
  }
  return published;
}

function deadlineStepLeaseLossResult(
  current: SandboxDeadlineState | null,
  generationId: string,
  workflowAttemptId: string,
  now: number,
): DeadlineStepResult {
  if (
    !current
    || current.generationId !== generationId
    || current.workflowAttemptId !== workflowAttemptId
  ) return { status: "done", reason: "generation-replaced-or-cleared" };
  return {
    status: "sleep",
    deadlineAtMs: Math.max(current.deadlineAtMs, now + 1_000),
  };
}

async function reconcileDeadlinePlatformDeparture(
  state: SandboxDeadlineState,
  reason: string,
  outcome: {
    metaStatus: "uninitialized" | "stopped" | "error";
    lastError: string | null;
  },
  lockToken: string,
  deps: DeadlineStepDeps,
): Promise<DeadlineStepResult> {
  const owned = await publishDeadlineStepState(
    state,
    { ...state, updatedAtMs: deps.now() },
    lockToken,
    deps,
  );
  await deps.reconcile({
    sandboxId: state.sandboxId,
    lifecycleAttemptId: state.lifecycleAttemptId,
    ...outcome,
  });
  const currentMeta = await deps.getMeta();
  if (
    currentMeta.status === "running"
    && currentMeta.sandboxId === state.sandboxId
    && (currentMeta.lifecycleAttemptId ?? null) === state.lifecycleAttemptId
  ) {
    const error = new Error(
      `Platform reported ${reason}, but lifecycle metadata still owns the running sandbox.`,
    );
    Object.assign(error, { code: "DEADLINE_PLATFORM_RECONCILE_PENDING" });
    throw error;
  }

  const current = await deps.read();
  if (
    !current
    || current.generationId !== owned.generationId
    || current.workflowAttemptId !== owned.workflowAttemptId
    || current.revision !== owned.revision
  ) {
    return { status: "done", reason: "generation-replaced-or-cleared" };
  }
  if (!await deps.renewLock(lockToken)) {
    return deadlineStepLeaseLossResult(
      await deps.read(),
      owned.generationId,
      owned.workflowAttemptId!,
      deps.now(),
    );
  }
  await deps.clear();
  return { status: "done", reason: `${reason}-reconciled` };
}

export async function processSandboxDeadlineStep(
  generationId: string,
  workflowAttemptId: string,
  deps: DeadlineStepDeps = defaultStepDeps,
): Promise<DeadlineStepResult> {
  const token = await deps.acquireLock();
  if (!token) {
    const current = await deps.read();
    if (
      !current
      || current.generationId !== generationId
      || current.workflowAttemptId !== workflowAttemptId
    ) {
      return { status: "done", reason: "generation-replaced-or-cleared" };
    }
    return {
      status: "sleep",
      // The lock owner may be moving the durable deadline. Poll promptly
      // instead of sleeping toward a target this worker cannot publish.
      deadlineAtMs: deps.now() + 1_000,
    };
  }

  let lockReleased = false;
  try {
    const state = await deps.read();
    if (
      !state
      || state.generationId !== generationId
      || state.workflowAttemptId !== workflowAttemptId
    ) {
      return { status: "done", reason: "generation-replaced-or-cleared" };
    }

    const meta = await deps.getMeta();
    if (
      meta.status !== "running"
      || meta.sandboxId !== state.sandboxId
      || (meta.lifecycleAttemptId ?? null) !== state.lifecycleAttemptId
    ) {
      if (!await deps.renewLock(token)) throw new DeadlineStepLeaseLostError();
      await deps.clear();
      return { status: "done", reason: `sandbox-${meta.status}` };
    }

    const now = deps.now();
    if (now < state.deadlineAtMs) {
      if (state.workflowScheduledDeadlineAtMs !== state.deadlineAtMs) {
        await publishDeadlineStepState(
          state,
          {
            ...state,
            workflowScheduledDeadlineAtMs: state.deadlineAtMs,
            updatedAtMs: now,
          },
          token,
          deps,
        );
      }
      return { status: "sleep", deadlineAtMs: state.deadlineAtMs };
    }

    const claimedAtMs = deps.now();
    const claimedState = await publishDeadlineStepState(
      state,
      {
        ...state,
        lastAttemptAtMs: claimedAtMs,
        updatedAtMs: claimedAtMs,
      },
      token,
      deps,
    );

    let sandbox;
    try {
      sandbox = await deps.getSandbox(claimedState.sandboxId);
    } catch (error) {
      if (!deadlineSandboxIsGone(error)) throw error;
      return await reconcileDeadlinePlatformDeparture(
        claimedState,
        "platform-not-found",
        { metaStatus: "uninitialized", lastError: null },
        token,
        deps,
      );
    }
    if (sandbox.status === "stopped") {
      return await reconcileDeadlinePlatformDeparture(
        claimedState,
        "platform-stopped",
        { metaStatus: "stopped", lastError: null },
        token,
        deps,
      );
    }
    if (sandbox.status === "failed" || sandbox.status === "aborted") {
      return await reconcileDeadlinePlatformDeparture(
        claimedState,
        `platform-${sandbox.status}`,
        {
          metaStatus: "error",
          lastError: `sandbox ${sandbox.status}`,
        },
        token,
        deps,
      );
    }
    // Pending stop/snapshot phases are not resumable terminal states. Keep the
    // deadline until the platform publishes a terminal outcome.
    if (sandbox.status !== "running") {
      const error = new Error(`Platform stop remains ${sandbox.status}.`);
      Object.assign(error, { code: "DEADLINE_PLATFORM_TRANSITIONAL" });
      throw error;
    }

    // Preserve only the reserved stop runway. extendTimeout adds to the total
    // session duration, so cap it at the portable plan ceiling.
    const remainingMs = sandbox.timeoutRemaining;
    const stopRunwayMs = Math.max(
      SANDBOX_TIMEOUT_SAFETY_RUNWAY_MS,
      claimedState.platformTimeoutMs - claimedState.desiredIdleMs,
    );
    const extendByMs = getSandboxTimeoutExtensionMs({
      currentTotalMs: sandbox.timeout,
      currentRemainingMs: remainingMs,
      targetRemainingMs: stopRunwayMs,
    });
    if (extendByMs > 0) await sandbox.extendTimeout(extendByMs);

    // Activity refresh uses this same lock. Re-read after the platform call
    // so only the still-current expired generation may cross into stop.
    const [latest, latestMeta] = await Promise.all([deps.read(), deps.getMeta()]);
    if (
      !latest
      || latest.generationId !== generationId
      || latest.workflowAttemptId !== workflowAttemptId
    ) {
      return { status: "done", reason: "generation-replaced-or-cleared" };
    }
    if (
      latestMeta.status !== "running"
      || latestMeta.sandboxId !== latest.sandboxId
      || (latestMeta.lifecycleAttemptId ?? null) !== latest.lifecycleAttemptId
    ) {
      return { status: "done", reason: `sandbox-${latestMeta.status}` };
    }
    const activityDeadlineAtMs = typeof latestMeta.lastAccessedAt === "number"
      ? latestMeta.lastAccessedAt + latest.desiredIdleMs
      : latest.deadlineAtMs;
    const refreshedActivityDeadlineAtMs = Math.min(
      Math.max(latest.deadlineAtMs, activityDeadlineAtMs),
      latest.nativeStopDeadlineAtMs ?? Number.POSITIVE_INFINITY,
    );
    if (
      activityDeadlineAtMs > deps.now()
      && refreshedActivityDeadlineAtMs > deps.now()
    ) {
      const refreshed: SandboxDeadlineState = {
        ...latest,
        deadlineAtMs: refreshedActivityDeadlineAtMs,
        workflowScheduledDeadlineAtMs: refreshedActivityDeadlineAtMs,
        updatedAtMs: deps.now(),
        lastAttemptAtMs: null,
        lastOutcome: "armed",
        lastErrorCode: null,
        lastErrorClass: null,
      };
      const published = await publishDeadlineStepState(
        latest,
        refreshed,
        token,
        deps,
      );
      return { status: "sleep", deadlineAtMs: published.deadlineAtMs };
    }
    if (
      latest.deadlineAtMs > deps.now()
      || latest.lastAttemptAtMs !== claimedAtMs
    ) {
      if (latest.workflowScheduledDeadlineAtMs !== latest.deadlineAtMs) {
        await publishDeadlineStepState(
          latest,
          {
            ...latest,
            workflowScheduledDeadlineAtMs: latest.deadlineAtMs,
            updatedAtMs: deps.now(),
          },
          token,
          deps,
        );
      }
      return { status: "sleep", deadlineAtMs: latest.deadlineAtMs };
    }

    // Never wait for the lifecycle lock while holding the deadline lock.
    // The lifecycle owner seals this claim under the deadline lock before it
    // begins suspension, preserving the canonical lifecycle -> deadline order.
    await deps.releaseLock(token);
    lockReleased = true;
    const stopped = await deps.stop({ generationId, claimedAtMs });
    if (stopped.status === "snapshotting" || stopped.status === "stopped") {
      const settleToken = await deps.acquireLock();
      if (settleToken) {
        try {
          const current = await deps.read();
          if (
            current?.generationId === generationId
            && current.workflowAttemptId === workflowAttemptId
          ) await deps.clear();
        } finally {
          await deps.releaseLock(settleToken);
        }
      }
      return { status: "done", reason: `stop-${stopped.status}` };
    }
    throw new Error(`Unexpected stop status: ${stopped.status}`);
  } catch (error) {
    if (error instanceof DeadlineStepLeaseLostError) {
      return deadlineStepLeaseLossResult(
        await deps.read(),
        generationId,
        workflowAttemptId,
        deps.now(),
      );
    }
    let retryToken: string | null = null;
    if (lockReleased) {
      retryToken = await deps.acquireLock();
      if (!retryToken) {
        return { status: "sleep", deadlineAtMs: deps.now() + 1_000 };
      }
    }
    try {
      if (deadlineStopClaimWasRevoked(error)) {
        const current = await deps.read();
        if (
          !current
          || current.generationId !== generationId
          || current.workflowAttemptId !== workflowAttemptId
        ) {
          return { status: "done", reason: "generation-replaced-or-cleared" };
        }
        return {
          status: "sleep",
          deadlineAtMs: Math.max(current.deadlineAtMs, deps.now() + 1_000),
        };
      }
      const retryAfterMs = deadlineRetryAfterMs(error);
      const identity = errorIdentity(error);
      const retryCurrent = await deps.read();
      if (
        !retryCurrent
        || retryCurrent.generationId !== generationId
        || retryCurrent.workflowAttemptId !== workflowAttemptId
      ) {
        return { status: "done", reason: "generation-replaced-or-cleared" };
      }
      const retryAtMs = deps.now();
      const retryDeadlineAtMs = retryAtMs + retryAfterMs;
      const retryState: SandboxDeadlineState = {
        ...retryCurrent,
        deadlineAtMs: retryDeadlineAtMs,
        workflowScheduledDeadlineAtMs: retryDeadlineAtMs,
        updatedAtMs: retryAtMs,
        lastAttemptAtMs: retryAtMs,
        lastOutcome: error instanceof HostSuspensionBusyError ? "busy" : "error",
        lastErrorCode: identity.code,
        lastErrorClass: identity.className,
      };
      const retryLockToken = retryToken ?? token;
      const publishedRetry = await publishDeadlineStepState(
        retryCurrent,
        retryState,
        retryLockToken,
        deps,
      );
      logWarn("sandbox.deadline.stop_deferred", {
        generationId,
        sandboxId: retryCurrent.sandboxId,
        retryAfterMs,
        errorCode: identity.code,
        errorClass: identity.className,
      });
      return { status: "sleep", deadlineAtMs: publishedRetry.deadlineAtMs };
    } finally {
      if (retryToken) await deps.releaseLock(retryToken);
    }
  } finally {
    if (!lockReleased) await deps.releaseLock(token);
  }
}
