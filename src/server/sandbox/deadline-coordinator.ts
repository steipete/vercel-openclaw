import { randomUUID } from "node:crypto";

import { logInfo, logWarn } from "@/server/log";
import { getSandboxController } from "@/server/sandbox/controller";
import { HostSuspensionBusyError } from "@/server/sandbox/host-suspension";
import {
  sandboxDeadlineKey,
  sandboxDeadlineLockKey,
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
const MIN_BUSY_RETRY_MS = 15_000;
const TRANSITIONAL_RETRY_MS = 5_000;
const DEFAULT_ERROR_RETRY_MS = 30_000;

export type SandboxDeadlineState = {
  version: 1;
  generationId: string;
  lifecycleAttemptId: string | null;
  sandboxId: string;
  deadlineAtMs: number;
  /** Absolute latest idle-stop deadline derived from native session expiry. */
  nativeStopDeadlineAtMs: number | null;
  desiredIdleMs: number;
  platformTimeoutMs: number;
  workflowRunId: string | null;
  workflowStartedAtMs: number | null;
  /** Deadline the attached Workflow may currently be sleeping toward. */
  workflowScheduledDeadlineAtMs: number | null;
  updatedAtMs: number;
  lastAttemptAtMs: number | null;
  lastOutcome: "armed" | "busy" | "error" | null;
  lastErrorCode: string | null;
  lastErrorClass: string | null;
};

export type DeadlineCoordinatorDeps = {
  read: () => Promise<SandboxDeadlineState | null>;
  write: (state: SandboxDeadlineState) => Promise<void>;
  clear: () => Promise<void>;
  getMeta: () => Promise<SingleMeta>;
  recordActivity: (input: {
    sandboxId: string;
    lifecycleAttemptId: string | null;
    activityAtMs: number;
  }) => Promise<SingleMeta>;
  acquireLock: () => Promise<string | null>;
  releaseLock: (token: string) => Promise<void>;
  startWorkflow: (generationId: string) => Promise<string>;
  getWorkflowStatus: (
    runId: string,
  ) => Promise<"pending" | "running" | "completed" | "failed" | "cancelled" | "missing" | "unknown">;
  now: () => number;
  randomId: () => string;
};

const defaultDeps: DeadlineCoordinatorDeps = {
  read: () => getStore().getValue<SandboxDeadlineState>(sandboxDeadlineKey()),
  write: (state) => getStore().setValue(sandboxDeadlineKey(), state),
  clear: () => getStore().deleteValue(sandboxDeadlineKey()),
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
  releaseLock: (token) => getStore().releaseLock(sandboxDeadlineLockKey(), token),
  startWorkflow: async (generationId) => {
    const { startSandboxDeadlineWorkflow } = await import(
      "@/server/workflows/sandbox/deadline-runtime"
    );
    return startSandboxDeadlineWorkflow(generationId);
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
  | { kind: "start"; generationId: string };

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

async function startAttachedDeadlineWorkflow(
  state: SandboxDeadlineState,
  deps: DeadlineCoordinatorDeps,
): Promise<SandboxDeadlineState> {
  // Keep the coordinator lock across Workflow creation, then persist the run
  // ID with the deadline. A process death can leave an orphan Workflow, which
  // exits on the generation check, but never a deadline with no repair owner.
  const workflowRunId = await deps.startWorkflow(state.generationId);
  const startedAtMs = deps.now();
  return {
    ...state,
    workflowRunId,
    workflowStartedAtMs: startedAtMs,
    workflowScheduledDeadlineAtMs: state.deadlineAtMs,
    updatedAtMs: startedAtMs,
    lastOutcome: "armed",
    lastErrorCode: null,
    lastErrorClass: null,
  };
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
    const existing = await deps.read();
    const current = sameGeneration(existing, latestMeta) ? existing : null;
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
          workflowScheduledDeadlineAtMs: current.workflowRunId
            ? current.workflowScheduledDeadlineAtMs ?? current.deadlineAtMs
            : null,
          updatedAtMs: now,
          lastOutcome: "armed",
          lastErrorCode: null,
          lastErrorClass: null,
        }
      : {
          version: 1,
          generationId: deps.randomId(),
          lifecycleAttemptId: latestMeta.lifecycleAttemptId ?? null,
          sandboxId: latestMeta.sandboxId,
          deadlineAtMs: refreshedDeadlineAtMs,
          nativeStopDeadlineAtMs,
          desiredIdleMs,
          platformTimeoutMs,
          workflowRunId: null,
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
    if (state.workflowRunId === null) {
      workflowPlan = {
        kind: "start",
        generationId: state.generationId,
      };
    } else if (deadlineMovedEarlier) {
      state.workflowRunId = null;
      state.workflowStartedAtMs = null;
      state.workflowScheduledDeadlineAtMs = null;
      workflowPlan = {
        kind: "start",
        generationId: state.generationId,
      };
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
    if (workflowPlan.kind === "start") {
      state = await startAttachedDeadlineWorkflow(state, deps);
      workflowPlan = { kind: "none" };
    }
    await deps.write(state);
    armedState = state;
  } finally {
    await deps.releaseLock(token);
  }

  if (!armedState) return null;

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
      let repairedState: SandboxDeadlineState = {
        ...current,
        workflowRunId: null,
        workflowStartedAtMs: null,
        workflowScheduledDeadlineAtMs: null,
        updatedAtMs: now,
      };
      repairedState = await startAttachedDeadlineWorkflow(repairedState, deps);
      await deps.write(repairedState);
      armedState = repairedState;
      workflowPlan = { kind: "none" };
    } finally {
      await deps.releaseLock(repairToken);
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

export type DeadlineStepDeps = {
  read: () => Promise<SandboxDeadlineState | null>;
  write: (state: SandboxDeadlineState) => Promise<void>;
  clear: () => Promise<void>;
  acquireLock: () => Promise<string | null>;
  releaseLock: (token: string) => Promise<void>;
  getMeta: () => Promise<SingleMeta>;
  getSandbox: (sandboxId: string) => ReturnType<ReturnType<typeof getSandboxController>["get"]>;
  reconcile: (input: {
    sandboxId: string;
    lifecycleAttemptId: string | null;
    metaStatus: "uninitialized" | "stopped" | "error";
    lastError: string | null;
  }) => Promise<SingleMeta>;
  stop: () => Promise<SingleMeta>;
  now: () => number;
};

const defaultStepDeps: DeadlineStepDeps = {
  read: defaultDeps.read,
  write: defaultDeps.write,
  clear: defaultDeps.clear,
  acquireLock: () => getStore().acquireLock(
    sandboxDeadlineLockKey(),
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
  stop: async () => {
    const { stopSandbox } = await import("@/server/sandbox/lifecycle");
    return stopSandbox();
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

async function reconcileDeadlinePlatformDeparture(
  state: SandboxDeadlineState,
  reason: string,
  outcome: {
    metaStatus: "uninitialized" | "stopped" | "error";
    lastError: string | null;
  },
  deps: DeadlineStepDeps,
): Promise<DeadlineStepResult> {
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
  if (!current || current.generationId !== state.generationId) {
    return { status: "done", reason: "generation-replaced-or-cleared" };
  }
  await deps.clear();
  return { status: "done", reason: `${reason}-reconciled` };
}

export async function processSandboxDeadlineStep(
  generationId: string,
  deps: DeadlineStepDeps = defaultStepDeps,
): Promise<DeadlineStepResult> {
  const token = await deps.acquireLock();
  if (!token) {
    const current = await deps.read();
    if (!current || current.generationId !== generationId) {
      return { status: "done", reason: "generation-replaced-or-cleared" };
    }
    return {
      status: "sleep",
      // The lock owner may be moving the durable deadline. Poll promptly
      // instead of sleeping toward a target this worker cannot publish.
      deadlineAtMs: deps.now() + 1_000,
    };
  }

  try {
    const state = await deps.read();
    if (!state || state.generationId !== generationId) {
      return { status: "done", reason: "generation-replaced-or-cleared" };
    }

    const meta = await deps.getMeta();
    if (
      meta.status !== "running"
      || meta.sandboxId !== state.sandboxId
      || (meta.lifecycleAttemptId ?? null) !== state.lifecycleAttemptId
    ) {
      await deps.clear();
      return { status: "done", reason: `sandbox-${meta.status}` };
    }

    const now = deps.now();
    if (now < state.deadlineAtMs) {
      if (state.workflowScheduledDeadlineAtMs !== state.deadlineAtMs) {
        await deps.write({
          ...state,
          workflowScheduledDeadlineAtMs: state.deadlineAtMs,
          updatedAtMs: now,
        });
      }
      return { status: "sleep", deadlineAtMs: state.deadlineAtMs };
    }

    const claimedAtMs = deps.now();
    const claimedState: SandboxDeadlineState = {
      ...state,
      lastAttemptAtMs: claimedAtMs,
      updatedAtMs: claimedAtMs,
    };
    await deps.write(claimedState);

    let sandbox;
    try {
      sandbox = await deps.getSandbox(state.sandboxId);
    } catch (error) {
      if (!deadlineSandboxIsGone(error)) throw error;
      return await reconcileDeadlinePlatformDeparture(
        state,
        "platform-not-found",
        { metaStatus: "uninitialized", lastError: null },
        deps,
      );
    }
    if (sandbox.status === "stopped") {
      return await reconcileDeadlinePlatformDeparture(
        state,
        "platform-stopped",
        { metaStatus: "stopped", lastError: null },
        deps,
      );
    }
    if (sandbox.status === "failed" || sandbox.status === "aborted") {
      return await reconcileDeadlinePlatformDeparture(
        state,
        `platform-${sandbox.status}`,
        {
          metaStatus: "error",
          lastError: `sandbox ${sandbox.status}`,
        },
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
      state.platformTimeoutMs - state.desiredIdleMs,
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
    if (!latest || latest.generationId !== generationId) {
      return { status: "done", reason: "generation-replaced-or-cleared" };
    }
    if (
      latestMeta.status !== "running"
      || latestMeta.sandboxId !== latest.sandboxId
      || (latestMeta.lifecycleAttemptId ?? null) !== latest.lifecycleAttemptId
    ) {
      await deps.clear();
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
      await deps.write(refreshed);
      return { status: "sleep", deadlineAtMs: refreshed.deadlineAtMs };
    }
    if (
      latest.deadlineAtMs > deps.now()
      || latest.lastAttemptAtMs !== claimedAtMs
    ) {
      if (latest.workflowScheduledDeadlineAtMs !== latest.deadlineAtMs) {
        await deps.write({
          ...latest,
          workflowScheduledDeadlineAtMs: latest.deadlineAtMs,
          updatedAtMs: deps.now(),
        });
      }
      return { status: "sleep", deadlineAtMs: latest.deadlineAtMs };
    }

    const stopped = await deps.stop();
    if (stopped.status === "snapshotting" || stopped.status === "stopped") {
      await deps.clear();
      return { status: "done", reason: `stop-${stopped.status}` };
    }
    throw new Error(`Unexpected stop status: ${stopped.status}`);
  } catch (error) {
    const retryAfterMs = deadlineRetryAfterMs(error);
    const identity = errorIdentity(error);
    const retryCurrent = await deps.read();
    if (!retryCurrent || retryCurrent.generationId !== generationId) {
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
    await deps.write(retryState);
    logWarn("sandbox.deadline.stop_deferred", {
      generationId,
      sandboxId: retryCurrent.sandboxId,
      retryAfterMs,
      errorCode: identity.code,
      errorClass: identity.className,
    });
    return { status: "sleep", deadlineAtMs: retryState.deadlineAtMs };
  } finally {
    await deps.releaseLock(token);
  }
}
