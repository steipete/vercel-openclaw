import { randomUUID } from "node:crypto";

import {
  GatewayAdminRpcError,
  callGatewayAdminRpc,
} from "@/server/openclaw/admin-rpc";
import type { SandboxHandle } from "@/server/sandbox/controller";
import {
  hostSuspensionOperationKey,
  hostSuspensionOperationLockKey,
} from "@/server/store/keyspace";
import { getStore } from "@/server/store/store";
import { ApiError } from "@/shared/http";
import { logInfo, logWarn } from "@/server/log";

export type HostSuspensionPhase =
  | "fencing"
  | "preparing"
  | "prepared"
  | "stop-requesting"
  | "stopping"
  | "stopped"
  | "thawing"
  | "running"
  | "failed";

export type HostSuspensionIntent = "stop" | "reset";

export type HostSuspensionState = {
  version: 1;
  operationId: string;
  requestId: string;
  sandboxId: string;
  intent: HostSuspensionIntent;
  reason: string;
  phase: HostSuspensionPhase;
  ingressFenced: boolean;
  suspensionId: string | null;
  leaseExpiresAtMs: number | null;
  stopRequestDeadlineAtMs: number | null;
  monitorHeartbeatAtMs: number | null;
  startedAtMs: number;
  updatedAtMs: number;
  stoppedAtMs: number | null;
  resumedAtMs: number | null;
  lastError: string | null;
  lastErrorCode: string | null;
  lastErrorClass: string | null;
};

// Vercel Functions/Workflow steps executing lifecycle calls are bounded below
// this window. Rollback is safe only after the caller that could still commit
// a late Sandbox.stop request can no longer be running.
export const HOST_STOP_REQUEST_MAX_MS = 6 * 60 * 1000;

type SuspendBlocker = {
  kind?: unknown;
  count?: unknown;
  tasks?: unknown;
};

type SuspendPrepareResult =
  | {
      status: "busy";
      reason?: string;
      retryAfterMs?: number;
      activeCount?: number;
      blockers?: SuspendBlocker[];
    }
  | {
      status: "ready";
      suspensionId: string;
      expiresAtMs: number;
      activeCount?: number;
      blockers?: SuspendBlocker[];
    };

type SuspendStatusResult =
  | { status: "running" }
  | {
      status: "ready";
      expiresAtMs: number;
    };

type SuspendResumeResult = {
  ok: boolean;
  status: "running";
  resumed: boolean;
};

export type HostSuspensionDeps = {
  read: () => Promise<HostSuspensionState | null>;
  write: (state: HostSuspensionState) => Promise<void>;
  clear: () => Promise<void>;
  acquireStateLock: () => Promise<string | null>;
  releaseStateLock: (token: string) => Promise<void>;
  callRpc: <T>(input: {
    sandbox: SandboxHandle;
    method: string;
    params?: unknown;
    requestId?: string;
  }) => Promise<T>;
  now: () => number;
  randomId: () => string;
  startMonitor: (operationId: string) => Promise<void>;
};

const defaultDeps: HostSuspensionDeps = {
  read: () => getStore().getValue<HostSuspensionState>(hostSuspensionOperationKey()),
  write: (state) => getStore().setValue(hostSuspensionOperationKey(), state),
  clear: () => getStore().deleteValue(hostSuspensionOperationKey()),
  acquireStateLock: () => getStore().acquireLock(
    hostSuspensionOperationLockKey(),
    30,
  ),
  releaseStateLock: (token) => getStore().releaseLock(
    hostSuspensionOperationLockKey(),
    token,
  ),
  callRpc: callGatewayAdminRpc,
  now: () => Date.now(),
  randomId: () => randomUUID(),
  startMonitor: async (operationId) => {
    const { startHostStopMonitor } = await import(
      "@/server/workflows/sandbox/host-stop-runtime"
    );
    await startHostStopMonitor(operationId);
  },
};

const HOST_SUSPENSION_LOCK_RETRY_MS = 20;
const HOST_SUSPENSION_LOCK_ATTEMPTS = 50;

async function withHostSuspensionStateLock<T>(
  deps: HostSuspensionDeps,
  run: () => Promise<T>,
): Promise<T> {
  let token: string | null = null;
  for (let attempt = 0; attempt < HOST_SUSPENSION_LOCK_ATTEMPTS; attempt += 1) {
    token = await deps.acquireStateLock();
    if (token) break;
    await new Promise((resolve) => setTimeout(resolve, HOST_SUSPENSION_LOCK_RETRY_MS));
  }
  if (!token) {
    throw new ApiError(
      503,
      "HOST_SUSPENSION_STATE_BUSY",
      "Durable host suspension state is being updated; retry this operation.",
    );
  }

  try {
    return await run();
  } finally {
    await deps.releaseStateLock(token);
  }
}

export class HostSuspensionBusyError extends ApiError {
  readonly retryAfterMs: number | null;
  readonly activeCount: number;
  readonly blockers: SuspendBlocker[];

  constructor(result: Extract<SuspendPrepareResult, { status: "busy" }>) {
    super(
      409,
      "GATEWAY_SUSPEND_BUSY",
      result.reason ?? "OpenClaw still has active work; sandbox stop was refused.",
    );
    this.name = "HostSuspensionBusyError";
    this.retryAfterMs = typeof result.retryAfterMs === "number"
      ? result.retryAfterMs
      : null;
    this.activeCount = typeof result.activeCount === "number"
      ? result.activeCount
      : 0;
    this.blockers = Array.isArray(result.blockers) ? result.blockers : [];
  }
}

export class HostSuspensionRollbackError extends ApiError {
  constructor(message: string) {
    super(503, "GATEWAY_SUSPEND_ROLLBACK_FAILED", message);
    this.name = "HostSuspensionRollbackError";
  }
}

export class HostSuspensionStateCorruptError extends ApiError {
  constructor() {
    super(
      503,
      "HOST_SUSPENSION_STATE_CORRUPT",
      "Durable host suspension state is invalid; sandbox ingress remains fail-closed.",
    );
    this.name = "HostSuspensionStateCorruptError";
  }
}

function isPhase(value: unknown): value is HostSuspensionPhase {
  return [
    "fencing",
    "preparing",
    "prepared",
    "stop-requesting",
    "stopping",
    "stopped",
    "thawing",
    "running",
    "failed",
  ].includes(String(value));
}

const HOST_SUSPENSION_STATE_KEYS = [
  "ingressFenced",
  "intent",
  "lastError",
  "lastErrorClass",
  "lastErrorCode",
  "leaseExpiresAtMs",
  "monitorHeartbeatAtMs",
  "operationId",
  "phase",
  "reason",
  "requestId",
  "resumedAtMs",
  "sandboxId",
  "startedAtMs",
  "stoppedAtMs",
  "stopRequestDeadlineAtMs",
  "suspensionId",
  "updatedAtMs",
  "version",
] as const;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isHostSuspensionState(value: unknown): value is HostSuspensionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<HostSuspensionState>;
  const keys = Object.keys(state);
  const deadlineShapeValid = state.phase === "stop-requesting"
    ? isFiniteNumber(state.stopRequestDeadlineAtMs)
    : state.stopRequestDeadlineAtMs === null;

  return keys.length === HOST_SUSPENSION_STATE_KEYS.length
    && HOST_SUSPENSION_STATE_KEYS.every((key) => Object.hasOwn(state, key))
    && state.version === 1
    && typeof state.operationId === "string"
    && state.operationId.length > 0
    && typeof state.requestId === "string"
    && state.requestId.length > 0
    && typeof state.sandboxId === "string"
    && state.sandboxId.length > 0
    && (state.intent === "stop" || state.intent === "reset")
    && typeof state.reason === "string"
    && state.reason.length > 0
    && isPhase(state.phase)
    && typeof state.ingressFenced === "boolean"
    && isNullableString(state.suspensionId)
    && isNullableFiniteNumber(state.leaseExpiresAtMs)
    && isNullableFiniteNumber(state.monitorHeartbeatAtMs)
    && deadlineShapeValid
    && isFiniteNumber(state.startedAtMs)
    && isFiniteNumber(state.updatedAtMs)
    && isNullableFiniteNumber(state.stoppedAtMs)
    && isNullableFiniteNumber(state.resumedAtMs)
    && isNullableString(state.lastError)
    && isNullableString(state.lastErrorCode)
    && isNullableString(state.lastErrorClass);
}

export async function readHostSuspensionState(
  deps: HostSuspensionDeps = defaultDeps,
): Promise<HostSuspensionState | null> {
  const value = await deps.read();
  if (value === null) return null;
  if (!isHostSuspensionState(value)) {
    logWarn("sandbox.host_suspension.invalid_state");
    throw new HostSuspensionStateCorruptError();
  }
  return value;
}

async function writePhase(
  state: HostSuspensionState,
  patch: Partial<HostSuspensionState>,
  deps: HostSuspensionDeps,
): Promise<HostSuspensionState> {
  const next = await withHostSuspensionStateLock(deps, async () => {
    const current = await readHostSuspensionState(deps);
    if (!current || current.operationId !== state.operationId) {
      throw new ApiError(
        409,
        "HOST_SUSPENSION_CONFLICT",
        "The durable host suspension operation changed concurrently.",
      );
    }
    if (
      patch.phase !== undefined
      && current.phase !== state.phase
      && patch.phase !== current.phase
    ) {
      throw new ApiError(
        409,
        "HOST_SUSPENSION_CONFLICT",
        `The durable host suspension advanced from ${state.phase} to ${current.phase}.`,
      );
    }

    const nextLeaseExpiresAtMs = typeof patch.leaseExpiresAtMs === "number"
      && typeof current.leaseExpiresAtMs === "number"
      ? Math.max(patch.leaseExpiresAtMs, current.leaseExpiresAtMs)
      : patch.leaseExpiresAtMs;
    const nextState: HostSuspensionState = {
      ...current,
      ...patch,
      ...(nextLeaseExpiresAtMs === undefined
        ? {}
        : { leaseExpiresAtMs: nextLeaseExpiresAtMs }),
      updatedAtMs: deps.now(),
    };
    await deps.write(nextState);
    return nextState;
  });
  logInfo("sandbox.host_suspension.phase", {
    operationId: next.operationId,
    sandboxId: next.sandboxId,
    phase: next.phase,
    ingressFenced: next.ingressFenced,
    leaseExpiresAtMs: next.leaseExpiresAtMs,
  });
  return next;
}

function createOperation(input: {
  sandboxId: string;
  intent: HostSuspensionIntent;
  reason: string;
}, deps: HostSuspensionDeps): HostSuspensionState {
  const now = deps.now();
  const operationId = deps.randomId();
  return {
    version: 1,
    operationId,
    requestId: operationId,
    sandboxId: input.sandboxId,
    intent: input.intent,
    reason: input.reason,
    phase: "fencing",
    ingressFenced: true,
    suspensionId: null,
    leaseExpiresAtMs: null,
    stopRequestDeadlineAtMs: null,
    monitorHeartbeatAtMs: null,
    startedAtMs: now,
    updatedAtMs: now,
    stoppedAtMs: null,
    resumedAtMs: null,
    lastError: null,
    lastErrorCode: null,
    lastErrorClass: null,
  };
}

const HOST_STOP_MONITOR_STALE_MS = 30_000;
const HOST_STOP_MONITOR_PHASES = new Set<HostSuspensionPhase>([
  "fencing",
  "preparing",
  "prepared",
  "stop-requesting",
  "stopping",
]);

/**
 * Idempotently hand an in-flight operation to Workflow. The heartbeat is an
 * outbox acknowledgement: if either side of the state/workflow handoff is
 * lost, the next fenced request or watchdog pass starts the same operation
 * again, and duplicate monitors converge on the operation id.
 */
export async function ensureHostStopMonitor(
  state: HostSuspensionState,
  deps: HostSuspensionDeps = defaultDeps,
): Promise<HostSuspensionState> {
  if (!state.ingressFenced || !HOST_STOP_MONITOR_PHASES.has(state.phase)) {
    return state;
  }
  const now = deps.now();
  if (
    state.monitorHeartbeatAtMs !== null
    && now - state.monitorHeartbeatAtMs < HOST_STOP_MONITOR_STALE_MS
  ) {
    return state;
  }

  await deps.startMonitor(state.operationId);
  return withHostSuspensionStateLock(deps, async () => {
    const latest = await readHostSuspensionState(deps);
    if (!latest || latest.operationId !== state.operationId) return state;
    if (!HOST_STOP_MONITOR_PHASES.has(latest.phase)) return latest;
    // updatedAtMs is the phase-transition clock used to reject a stop that
    // remains running; monitor liveness must not extend that grace window.
    const acknowledged = { ...latest, monitorHeartbeatAtMs: deps.now() };
    await deps.write(acknowledged);
    return acknowledged;
  });
}

export async function heartbeatHostStopMonitor(
  operationId: string,
  deps: HostSuspensionDeps = defaultDeps,
): Promise<void> {
  await withHostSuspensionStateLock(deps, async () => {
    const state = await readHostSuspensionState(deps);
    if (
      !state
      || state.operationId !== operationId
      || !HOST_STOP_MONITOR_PHASES.has(state.phase)
    ) {
      return;
    }
    // Preserve updatedAtMs for the same transition-grace invariant above.
    await deps.write({ ...state, monitorHeartbeatAtMs: deps.now() });
  });
}

function classifyError(error: unknown): {
  lastError: string;
  lastErrorCode: string;
  lastErrorClass: string;
} {
  if (error instanceof GatewayAdminRpcError) {
    return {
      lastError: error.message,
      lastErrorCode: error.code,
      lastErrorClass: error.name,
    };
  }
  if (error instanceof ApiError) {
    return {
      lastError: error.message,
      lastErrorCode: error.code,
      lastErrorClass: error.name,
    };
  }
  if (error instanceof Error) {
    return {
      lastError: error.message,
      lastErrorCode: "HOST_SUSPENSION_ERROR",
      lastErrorClass: error.name,
    };
  }
  return {
    lastError: String(error),
    lastErrorCode: "HOST_SUSPENSION_ERROR",
    lastErrorClass: "UnknownError",
  };
}

function assertReadyResult(
  result: SuspendPrepareResult,
): asserts result is Extract<SuspendPrepareResult, { status: "ready" }> {
  if (
    result.status !== "ready"
    || typeof result.suspensionId !== "string"
    || result.suspensionId.length === 0
    || typeof result.expiresAtMs !== "number"
  ) {
    throw new GatewayAdminRpcError({
      code: "ADMIN_RPC_INVALID_RESPONSE",
      message: "gateway.suspend.prepare returned an invalid ready result.",
    });
  }
}

function assertStatusResult(
  result: SuspendStatusResult,
): asserts result is SuspendStatusResult {
  if (
    result?.status === "running"
    || (result?.status === "ready" && isFiniteNumber(result.expiresAtMs))
  ) {
    return;
  }
  throw new GatewayAdminRpcError({
    code: "ADMIN_RPC_INVALID_RESPONSE",
    message: "gateway.suspend.status returned an invalid result.",
  });
}

async function requestPreparation(input: {
  state: HostSuspensionState;
  sandbox: SandboxHandle;
  busyKeepsFence?: boolean;
}, deps: HostSuspensionDeps): Promise<HostSuspensionState> {
  const renewal = input.busyKeepsFence === true;
  const preparing = await writePhase(input.state, {
    phase: renewal ? input.state.phase : "preparing",
    ingressFenced: true,
    lastError: null,
    lastErrorCode: null,
    lastErrorClass: null,
  }, deps);

  const result = await deps.callRpc<SuspendPrepareResult>({
    sandbox: input.sandbox,
    method: "gateway.suspend.prepare",
    params: { requestId: preparing.requestId },
    requestId: preparing.operationId,
  });

  if (result.status === "busy") {
    await writePhase(preparing, {
      phase: renewal ? input.state.phase : "failed",
      ingressFenced: renewal,
      lastError: result.reason ?? "gateway reported active work",
      lastErrorCode: "GATEWAY_SUSPEND_BUSY",
      lastErrorClass: "HostSuspensionBusyError",
    }, deps);
    throw new HostSuspensionBusyError(result);
  }

  assertReadyResult(result);
  return writePhase(preparing, {
    phase: renewal ? input.state.phase : "prepared",
    ingressFenced: true,
    suspensionId: result.suspensionId,
    leaseExpiresAtMs: result.expiresAtMs,
    lastError: null,
    lastErrorCode: null,
    lastErrorClass: null,
  }, deps);
}

/** Fence app-owned ingress, then atomically ask OpenClaw to refuse new work. */
export async function prepareHostSuspension(input: {
  sandbox: SandboxHandle;
  intent?: HostSuspensionIntent;
  reason: string;
}, deps: HostSuspensionDeps = defaultDeps): Promise<HostSuspensionState> {
  let state = await withHostSuspensionStateLock(deps, async () => {
    const existing = await readHostSuspensionState(deps);
    if (existing?.ingressFenced) {
      if (existing.sandboxId !== input.sandbox.sandboxId) {
        throw new ApiError(
          409,
          "HOST_SUSPENSION_CONFLICT",
          "A fenced lifecycle operation belongs to a different sandbox.",
        );
      }
      return existing;
    }

    const created = createOperation({
      sandboxId: input.sandbox.sandboxId,
      intent: input.intent ?? "stop",
      reason: input.reason,
    }, deps);
    await deps.write(created);
    return created;
  });
  if (
    state.phase === "stop-requesting"
    || state.phase === "stopping"
    || state.phase === "stopped"
  ) {
    return state;
  }

  try {
    state = await ensureHostStopMonitor(state, deps);
    return await requestPreparation({
      state,
      sandbox: input.sandbox,
    }, deps);
  } catch (error) {
    if (error instanceof HostSuspensionBusyError) throw error;
    const knownNotPrepared = (
      error instanceof GatewayAdminRpcError
      && ["ADMIN_RPC_NOT_INSTALLED", "INVALID_REQUEST"].includes(error.code)
    );
    try {
      const latest = await readHostSuspensionState(deps);
      const failureState = latest?.operationId === state.operationId ? latest : state;
      await writePhase(failureState, {
        phase: "failed",
        ingressFenced: !knownNotPrepared,
        ...classifyError(error),
      }, deps);
    } catch (stateError) {
      // Preserve the initiating control-plane error. A concurrent phase
      // advance remains fenced and its monitor owns subsequent reconciliation.
      logWarn("sandbox.host_suspension.failure_state_write_skipped", {
        operationId: state.operationId,
        error: stateError instanceof Error ? stateError.message : String(stateError),
      });
    }
    throw error;
  }
}

/** Renew the two-minute Gateway lease immediately before the platform stop. */
export async function renewHostSuspension(input: {
  state: HostSuspensionState;
  sandbox: SandboxHandle;
}, deps: HostSuspensionDeps = defaultDeps): Promise<HostSuspensionState> {
  return requestPreparation({ ...input, busyKeepsFence: true }, deps);
}

export async function markHostSuspensionStopping(
  state: HostSuspensionState,
  deps: HostSuspensionDeps = defaultDeps,
): Promise<HostSuspensionState> {
  return writePhase(state, {
    phase: "stopping",
    ingressFenced: true,
    stopRequestDeadlineAtMs: null,
  }, deps);
}

export async function markHostSuspensionStopRequesting(
  state: HostSuspensionState,
  deps: HostSuspensionDeps = defaultDeps,
): Promise<HostSuspensionState> {
  return writePhase(state, {
    phase: "stop-requesting",
    ingressFenced: true,
    stopRequestDeadlineAtMs:
      state.stopRequestDeadlineAtMs ?? deps.now() + HOST_STOP_REQUEST_MAX_MS,
  }, deps);
}

export async function markHostSuspensionStopped(
  operationId?: string,
  deps: HostSuspensionDeps = defaultDeps,
): Promise<HostSuspensionState | null> {
  const state = await readHostSuspensionState(deps);
  if (!state || (operationId && state.operationId !== operationId)) return state;
  return writePhase(state, {
    phase: "stopped",
    ingressFenced: true,
    stopRequestDeadlineAtMs: null,
    stoppedAtMs: deps.now(),
  }, deps);
}

async function resumePreparedGateway(input: {
  state: HostSuspensionState;
  sandbox: SandboxHandle;
}, deps: HostSuspensionDeps): Promise<void> {
  let state = input.state;
  let suspensionId = state.suspensionId;

  // If prepare may have committed but its response was lost, the stable
  // requestId retrieves/renews that same lease so rollback can still resume it.
  if (!suspensionId) {
    const recovered = await deps.callRpc<SuspendPrepareResult>({
      sandbox: input.sandbox,
      method: "gateway.suspend.prepare",
      params: { requestId: state.requestId },
      requestId: state.operationId,
    });
    if (recovered.status === "busy") return;
    assertReadyResult(recovered);
    suspensionId = recovered.suspensionId;
    state = await writePhase(state, {
      suspensionId,
      leaseExpiresAtMs: recovered.expiresAtMs,
    }, deps);
  }

  const status = await deps.callRpc<SuspendStatusResult>({
    sandbox: input.sandbox,
    method: "gateway.suspend.status",
    params: { suspensionId },
    requestId: state.operationId,
  });
  assertStatusResult(status);
  if (status.status === "running") return;

  const resumed = await deps.callRpc<SuspendResumeResult>({
    sandbox: input.sandbox,
    method: "gateway.suspend.resume",
    params: { suspensionId },
    requestId: state.operationId,
  });
  if (
    !resumed.ok
    || resumed.status !== "running"
    || typeof resumed.resumed !== "boolean"
  ) {
    throw new GatewayAdminRpcError({
      code: "ADMIN_RPC_INVALID_RESPONSE",
      message: "gateway.suspend.resume did not confirm a running Gateway.",
    });
  }
}

/** Resume Gateway admission before reopening app-owned ingress after a failed stop. */
export async function rollbackHostSuspension(input: {
  state: HostSuspensionState;
  sandbox: SandboxHandle;
  error: unknown;
}, deps: HostSuspensionDeps = defaultDeps): Promise<void> {
  try {
    await resumePreparedGateway(input, deps);
    await writePhase(input.state, {
      phase: "failed",
      ingressFenced: false,
      stopRequestDeadlineAtMs: null,
      resumedAtMs: deps.now(),
      ...classifyError(input.error),
    }, deps);
  } catch (rollbackError) {
    await writePhase(input.state, {
      phase: "failed",
      ingressFenced: true,
      stopRequestDeadlineAtMs: null,
      ...classifyError(rollbackError),
    }, deps);
    throw new HostSuspensionRollbackError(
      "Sandbox stop failed and Gateway admission could not be resumed; ingress remains fenced.",
    );
  }
}

/**
 * Complete a persisted stop after the sandbox wakes. A restarted Gateway may
 * already report running; a process-preserving thaw still holds the lease and
 * is resumed explicitly with the persisted suspensionId.
 */
export async function thawHostSuspensionIfNeeded(input: {
  sandbox: SandboxHandle;
}, deps: HostSuspensionDeps = defaultDeps): Promise<boolean> {
  const state = await readHostSuspensionState(deps);
  if (!state?.ingressFenced) return true;
  if (state.phase !== "stopped" && state.phase !== "thawing") return false;
  if (state.sandboxId !== input.sandbox.sandboxId) {
    // Snapshot restore may produce a replacement sandbox ID. Its fresh Gateway
    // cannot retain the old process-local suspension; reaching this thaw path
    // proves the replacement is the lifecycle-owned running target.
    const cleared = await withHostSuspensionStateLock(deps, async () => {
      const latest = await readHostSuspensionState(deps);
      if (
        !latest
        || latest.operationId !== state.operationId
        || (latest.phase !== "stopped" && latest.phase !== "thawing")
      ) {
        return false;
      }
      await deps.clear();
      return true;
    });
    if (!cleared) return false;
    logInfo("sandbox.host_suspension.replacement_thawed", {
      operationId: state.operationId,
      previousSandboxId: state.sandboxId,
      sandboxId: input.sandbox.sandboxId,
    });
    return true;
  }

  const thawing = await writePhase(state, {
    phase: "thawing",
    ingressFenced: true,
    stopRequestDeadlineAtMs: null,
  }, deps);
  try {
    await resumePreparedGateway({ ...input, state: thawing }, deps);
    await writePhase(thawing, {
      phase: "running",
      ingressFenced: false,
      resumedAtMs: deps.now(),
      lastError: null,
      lastErrorCode: null,
      lastErrorClass: null,
    }, deps);
    return true;
  } catch (error) {
    await writePhase(thawing, {
      phase: "failed",
      ingressFenced: true,
      ...classifyError(error),
    }, deps);
    return false;
  }
}

/** Successful destructive reset has no Gateway left to resume. */
export async function clearHostSuspensionAfterDelete(
  input: { sandboxId: string; operationId?: string },
  deps: HostSuspensionDeps = defaultDeps,
): Promise<void> {
  let state: HostSuspensionState | null;
  try {
    state = await readHostSuspensionState(deps);
  } catch (error) {
    if (!(error instanceof HostSuspensionStateCorruptError)) throw error;
    // A successful destructive delete is the explicit recovery owner for a
    // corrupt lifecycle record: no sandbox remains whose admission state must
    // be preserved.
    await withHostSuspensionStateLock(deps, () => deps.clear());
    return;
  }
  if (
    state?.sandboxId === input.sandboxId
    && (!input.operationId || state.operationId === input.operationId)
  ) {
    await withHostSuspensionStateLock(deps, async () => {
      const latest = await readHostSuspensionState(deps);
      if (
        latest?.sandboxId === input.sandboxId
        && (!input.operationId || latest.operationId === input.operationId)
      ) {
        await deps.clear();
      }
    });
  }
}

/** Retire a capability-probe failure before using the legacy platform path. */
export async function clearInactiveHostSuspension(input: {
  sandboxId: string;
}, deps: HostSuspensionDeps = defaultDeps): Promise<void> {
  await withHostSuspensionStateLock(deps, async () => {
    const state = await readHostSuspensionState(deps);
    if (
      state?.sandboxId === input.sandboxId
      && state.phase === "failed"
      && !state.ingressFenced
    ) {
      await deps.clear();
    }
  });
}

export type HostIngressFence = {
  operationId: string;
  phase: HostSuspensionPhase;
  retryAfterMs: number;
};

async function repairHostStopMonitorBestEffort(
  state: HostSuspensionState,
  deps: HostSuspensionDeps,
): Promise<void> {
  try {
    await ensureHostStopMonitor(state, deps);
  } catch (error) {
    logWarn("sandbox.host_stop_monitor.repair_failed", {
      operationId: state.operationId,
      phase: state.phase,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Only pre-stop phases reject new requests; stopped work may trigger wake. */
export async function getHostIngressFence(
  deps: HostSuspensionDeps = defaultDeps,
): Promise<HostIngressFence | null> {
  let state: HostSuspensionState | null;
  try {
    state = await readHostSuspensionState(deps);
  } catch (error) {
    if (!(error instanceof HostSuspensionStateCorruptError)) throw error;
    return {
      operationId: "state-corrupt",
      phase: "failed",
      retryAfterMs: 2_000,
    };
  }
  if (!state?.ingressFenced || state.phase === "stopped") return null;
  await repairHostStopMonitorBestEffort(state, deps);
  return {
    operationId: state.operationId,
    phase: state.phase,
    retryAfterMs: 2_000,
  };
}

/** Admin mutations stay blocked through the persisted stopped phase. */
export async function getHostMutationFence(
  deps: HostSuspensionDeps = defaultDeps,
): Promise<HostIngressFence | null> {
  let state: HostSuspensionState | null;
  try {
    state = await readHostSuspensionState(deps);
  } catch (error) {
    if (!(error instanceof HostSuspensionStateCorruptError)) throw error;
    return {
      operationId: "state-corrupt",
      phase: "failed",
      retryAfterMs: 2_000,
    };
  }
  if (!state?.ingressFenced) return null;
  await repairHostStopMonitorBestEffort(state, deps);
  return {
    operationId: state.operationId,
    phase: state.phase,
    retryAfterMs: 2_000,
  };
}

export function buildHostIngressFencedResponse(fence: HostIngressFence): Response {
  return Response.json({
    ok: false,
    error: "HOST_INGRESS_FENCED",
    message: "Sandbox lifecycle suspension is in progress. Retry this request.",
    suspension: {
      phase: fence.phase,
      retryAfterMs: fence.retryAfterMs,
    },
  }, {
    status: 503,
    headers: {
      "Cache-Control": "no-store",
      "Retry-After": String(Math.ceil(fence.retryAfterMs / 1000)),
    },
  });
}
