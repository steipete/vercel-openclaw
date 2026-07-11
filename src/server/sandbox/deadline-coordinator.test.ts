import assert from "node:assert/strict";
import test from "node:test";

import type { SandboxHandle } from "@/server/sandbox/controller";
import {
  armSandboxDeadline,
  claimSandboxDeadlineStop,
  clearSandboxDeadline,
  processSandboxDeadlineStep,
  readSandboxDeadlineRemainingMs,
  type DeadlineCoordinatorDeps,
  type DeadlineStepDeps,
  type SandboxDeadlineState,
} from "@/server/sandbox/deadline-coordinator";
import { HostSuspensionBusyError } from "@/server/sandbox/host-suspension";
import {
  MAX_PORTABLE_SANDBOX_SLEEP_AFTER_MS,
  SANDBOX_TIMEOUT_SAFETY_RUNWAY_MS,
} from "@/server/sandbox/timeout";
import { ApiError } from "@/shared/http";
import type { SingleMeta } from "@/shared/types";

function runningMeta(): SingleMeta {
  return {
    status: "running",
    sandboxId: "sbx-deadline",
    lifecycleAttemptId: "attempt-1",
  } as SingleMeta;
}

function coordinatorHarness(): {
  deps: DeadlineCoordinatorDeps;
  read: () => SandboxDeadlineState | null;
  setNow: (value: number) => void;
  starts: string[];
  setWorkflowStatus: (
    value: "pending" | "running" | "completed" | "failed" | "cancelled" | "missing" | "unknown",
  ) => void;
} {
  let state: SandboxDeadlineState | null = null;
  let meta = runningMeta();
  let now = 1_000;
  const starts: string[] = [];
  let workflowStatus: "pending" | "running" | "completed" | "failed" | "cancelled" | "missing" | "unknown" = "running";
  return {
    deps: {
      read: async () => structuredClone(state),
      write: async (next) => {
        state = structuredClone(next);
      },
      clear: async () => {
        state = null;
      },
      getMeta: async () => structuredClone(meta),
      recordActivity: async (input) => {
        if (
          meta.status === "running"
          && meta.sandboxId === input.sandboxId
          && (meta.lifecycleAttemptId ?? null) === input.lifecycleAttemptId
        ) {
          meta = {
            ...meta,
            lastAccessedAt: Math.max(
              meta.lastAccessedAt ?? input.activityAtMs,
              input.activityAtMs,
            ),
          };
        }
        return structuredClone(meta);
      },
      acquireLock: async () => "lock-token",
      releaseLock: async () => {},
      startWorkflow: async (generationId) => {
        starts.push(generationId);
        return `run-${starts.length}`;
      },
      getWorkflowStatus: async () => workflowStatus,
      now: () => now,
      randomId: () => "generation-1",
    },
    read: () => structuredClone(state),
    setNow: (value) => {
      now = value;
    },
    starts,
    setWorkflowStatus: (value) => {
      workflowStatus = value;
    },
  };
}

test("armSandboxDeadline reuses one workflow and moves only the deadline", async () => {
  const h = coordinatorHarness();
  const first = await armSandboxDeadline(runningMeta(), h.deps);
  assert.equal(first?.generationId, "generation-1");
  assert.deepEqual(h.starts, ["generation-1"]);

  h.setNow(2_000);
  const second = await armSandboxDeadline(runningMeta(), h.deps);
  assert.equal(second?.generationId, "generation-1");
  assert.deepEqual(h.starts, ["generation-1"]);
  assert.ok((second?.deadlineAtMs ?? 0) > (first?.deadlineAtMs ?? 0));

  h.setNow(3_000);
  const antiEntropy = await armSandboxDeadline(
    runningMeta(),
    h.deps,
    { refreshDeadline: false, forceWorkflowStart: true },
  );
  assert.equal(antiEntropy?.deadlineAtMs, second?.deadlineAtMs);
  assert.deepEqual(h.starts, ["generation-1"]);

  h.setWorkflowStatus("failed");
  const repaired = await armSandboxDeadline(
    runningMeta(),
    h.deps,
    { refreshDeadline: false, forceWorkflowStart: true },
  );
  assert.equal(repaired?.workflowRunId, "run-2");
  assert.deepEqual(h.starts, ["generation-1", "generation-1"]);
});

test("armSandboxDeadline stops before native expiry when session headroom is exhausted", async () => {
  const h = coordinatorHarness();

  const armed = await armSandboxDeadline(runningMeta(), h.deps, {
    nativeTimeoutRemainingMs: SANDBOX_TIMEOUT_SAFETY_RUNWAY_MS + 10_000,
  });

  assert.equal(armed?.deadlineAtMs, 11_000);
  assert.equal(armed?.nativeStopDeadlineAtMs, 11_000);
});

test("moving a deadline earlier starts a same-generation replacement workflow", async () => {
  const h = coordinatorHarness();
  const first = await armSandboxDeadline(runningMeta(), h.deps);
  h.setNow(2_000);

  const shortened = await armSandboxDeadline(runningMeta(), h.deps, {
    refreshDeadline: false,
    nativeTimeoutRemainingMs: SANDBOX_TIMEOUT_SAFETY_RUNWAY_MS + 5_000,
  });

  assert.equal(shortened?.generationId, first?.generationId);
  assert.equal(shortened?.deadlineAtMs, 7_000);
  assert.equal(shortened?.workflowScheduledDeadlineAtMs, 7_000);
  assert.equal(shortened?.workflowRunId, "run-2");
  assert.deepEqual(h.starts, ["generation-1", "generation-1"]);
});

test("lifecycle stop claim seals the deadline against concurrent activity", async () => {
  const h = coordinatorHarness();
  const armed = await armSandboxDeadline(runningMeta(), h.deps);
  assert.ok(armed);
  h.setNow(2_000_000);
  await h.deps.write({
    ...armed,
    deadlineAtMs: 1_900_000,
    lastAttemptAtMs: 2_000_000,
  });

  assert.equal(await claimSandboxDeadlineStop({
    generationId: armed.generationId,
    claimedAtMs: 2_000_000,
  }, h.deps), true);
  assert.equal(h.read()?.lastOutcome, "stopping");
  assert.equal(await armSandboxDeadline(runningMeta(), h.deps, {
    activityAtMs: 2_000_001,
  }), null);
});

test("armSandboxDeadline retries ordinary coordinator lock contention", async () => {
  const h = coordinatorHarness();
  let attempts = 0;
  h.deps.acquireLock = async () => {
    attempts += 1;
    return attempts < 3 ? null : "lock-token";
  };

  const armed = await armSandboxDeadline(runningMeta(), h.deps);

  assert.equal(armed?.generationId, "generation-1");
  // Workflow creation and run-ID persistence share the acquired lock.
  assert.equal(attempts, 3);
});

test("activity publication and deadline refresh share the coordinator lock", async () => {
  const h = coordinatorHarness();
  let lockHeld = false;
  h.deps.acquireLock = async () => {
    assert.equal(lockHeld, false);
    lockHeld = true;
    return "lock-token";
  };
  h.deps.releaseLock = async () => {
    lockHeld = false;
  };
  const recordActivity = h.deps.recordActivity;
  h.deps.recordActivity = async (input) => {
    assert.equal(lockHeld, true);
    return recordActivity(input);
  };

  await armSandboxDeadline(runningMeta(), h.deps, { activityAtMs: 5_000 });

  assert.equal(lockHeld, false);
  assert.equal((await h.deps.getMeta()).lastAccessedAt, 5_000);
});

test("out-of-order activity cannot move the committed idle deadline backward", async () => {
  const h = coordinatorHarness();
  const newest = await armSandboxDeadline(runningMeta(), h.deps, {
    activityAtMs: 5_000,
  });
  const stale = await armSandboxDeadline(runningMeta(), h.deps, {
    activityAtMs: 4_000,
  });

  assert.equal((await h.deps.getMeta()).lastAccessedAt, 5_000);
  assert.equal(stale?.deadlineAtMs, newest?.deadlineAtMs);
});

test("workflow start and run-ID persistence share the coordinator lock", async () => {
  const h = coordinatorHarness();
  let lockHeld = false;
  h.deps.acquireLock = async () => {
    assert.equal(lockHeld, false);
    lockHeld = true;
    return "lock-token";
  };
  h.deps.releaseLock = async () => {
    lockHeld = false;
  };

  h.deps.startWorkflow = async () => {
    assert.equal(lockHeld, true);
    return "run-attached";
  };

  const attached = await armSandboxDeadline(runningMeta(), h.deps, {
    activityAtMs: 1_000,
  });

  assert.equal(lockHeld, false);
  assert.equal(attached?.workflowRunId, "run-attached");
  assert.equal(h.read()?.workflowRunId, "run-attached");
});

test("workflow start failure never persists an ownerless deadline", async () => {
  const h = coordinatorHarness();
  h.deps.startWorkflow = async () => {
    throw new Error("start unavailable");
  };

  await assert.rejects(
    armSandboxDeadline(runningMeta(), h.deps),
    /start unavailable/,
  );
  assert.equal(h.read(), null);
});

test("workflow status runs outside the lock before a replacement start", async () => {
  const h = coordinatorHarness();
  await armSandboxDeadline(runningMeta(), h.deps);

  let lockHeld = false;
  h.deps.acquireLock = async () => {
    assert.equal(lockHeld, false);
    lockHeld = true;
    return "lock-token";
  };
  h.deps.releaseLock = async () => {
    lockHeld = false;
  };
  h.deps.getWorkflowStatus = async () => {
    assert.equal(lockHeld, false);
    return "failed";
  };
  h.deps.startWorkflow = async () => {
    assert.equal(lockHeld, true);
    return "run-repaired";
  };

  const repaired = await armSandboxDeadline(
    runningMeta(),
    h.deps,
    { refreshDeadline: false, forceWorkflowStart: true },
  );

  assert.equal(repaired?.workflowRunId, "run-repaired");
});

test("force repair replaces a running workflow that missed its deadline and grace", async () => {
  const h = coordinatorHarness();
  await armSandboxDeadline(runningMeta(), h.deps);
  await h.deps.write({
    ...h.read()!,
    deadlineAtMs: 1_000,
    workflowScheduledDeadlineAtMs: 1_000,
    lastAttemptAtMs: null,
  });
  h.setNow(400_000);
  h.setWorkflowStatus("running");

  const repaired = await armSandboxDeadline(
    runningMeta(),
    h.deps,
    { refreshDeadline: false, forceWorkflowStart: true },
  );

  assert.equal(repaired?.workflowRunId, "run-2");
  assert.deepEqual(h.starts, ["generation-1", "generation-1"]);
});

test("replacement workflow start failure leaves an ordinary arm retryable", async () => {
  const h = coordinatorHarness();
  await armSandboxDeadline(runningMeta(), h.deps);
  h.setWorkflowStatus("failed");
  h.deps.startWorkflow = async () => {
    throw new Error("start unavailable");
  };

  await assert.rejects(
    armSandboxDeadline(
      runningMeta(),
      h.deps,
      { refreshDeadline: false, forceWorkflowStart: true },
    ),
    /start unavailable/,
  );
  assert.equal(h.read()?.workflowRunId, "run-1");
  h.deps.startWorkflow = async () => "run-retried";
  const retried = await armSandboxDeadline(
    runningMeta(),
    h.deps,
    { refreshDeadline: false, forceWorkflowStart: true },
  );
  assert.equal(retried?.workflowRunId, "run-retried");
});

test("clearSandboxDeadline rechecks generation after acquiring the lock", async () => {
  const h = coordinatorHarness();
  await armSandboxDeadline(runningMeta(), h.deps);
  const replacement = {
    ...h.read()!,
    generationId: "generation-2",
  };
  h.deps.acquireLock = async () => {
    await h.deps.write(replacement);
    return "lock-token";
  };

  await clearSandboxDeadline(
    "sbx-deadline",
    { lifecycleAttemptId: "attempt-1" },
    h.deps,
  );

  assert.equal(h.read()?.generationId, "generation-2");
  assert.equal(h.read()?.lifecycleAttemptId, "attempt-1");
});

test("readSandboxDeadlineRemainingMs reports only the expected generation", async () => {
  const h = coordinatorHarness();
  const armed = await armSandboxDeadline(runningMeta(), h.deps);

  assert.equal(
    await readSandboxDeadlineRemainingMs(runningMeta(), h.deps),
    (armed?.deadlineAtMs ?? 1_000) - 1_000,
  );
  assert.equal(
    await readSandboxDeadlineRemainingMs(
      { ...runningMeta(), lifecycleAttemptId: "attempt-2" },
      h.deps,
    ),
    null,
  );

  await h.deps.write({
    ...h.read()!,
    lifecycleAttemptId: "attempt-2",
  });
  assert.equal(
    await readSandboxDeadlineRemainingMs(runningMeta(), h.deps),
    null,
  );
});

test("lock contention never acknowledges unpublished activity", async () => {
  const h = coordinatorHarness();
  await armSandboxDeadline(runningMeta(), h.deps);
  let recorded = false;
  h.deps.acquireLock = async () => null;
  h.deps.recordActivity = async () => {
    recorded = true;
    return runningMeta();
  };

  await assert.rejects(
    armSandboxDeadline(runningMeta(), h.deps, { activityAtMs: 5_000 }),
    (error: unknown) =>
      error instanceof ApiError
      && error.status === 503
      && error.code === "SANDBOX_DEADLINE_TRANSITION",
  );
  assert.equal(recorded, false);
});

function deadlineState(overrides: Partial<SandboxDeadlineState> = {}): SandboxDeadlineState {
  return {
    version: 1,
    generationId: "generation-1",
    lifecycleAttemptId: "attempt-1",
    sandboxId: "sbx-deadline",
    deadlineAtMs: 1_000,
    nativeStopDeadlineAtMs: null,
    desiredIdleMs: 60_000,
    platformTimeoutMs: 60_000 + SANDBOX_TIMEOUT_SAFETY_RUNWAY_MS,
    workflowRunId: "run-1",
    workflowStartedAtMs: 1,
    workflowScheduledDeadlineAtMs: 1_000,
    updatedAtMs: 1,
    lastAttemptAtMs: null,
    lastOutcome: "armed",
    lastErrorCode: null,
    lastErrorClass: null,
    ...overrides,
  };
}

function stepHarness(input: {
  stop: DeadlineStepDeps["stop"];
  timeout?: number;
  totalTimeout?: number;
  activityAtMsDuringExtend?: number;
  platformStatus?: SandboxHandle["status"];
  getSandboxError?: unknown;
  reconcile?: (
    meta: SingleMeta,
    input: Parameters<DeadlineStepDeps["reconcile"]>[0],
  ) => Promise<SingleMeta> | SingleMeta;
}): {
  deps: DeadlineStepDeps;
  extensions: number[];
  read: () => SandboxDeadlineState | null;
  getMeta: () => SingleMeta;
  reconciliations: () => number;
} {
  let state: SandboxDeadlineState | null = deadlineState();
  let meta = runningMeta();
  meta.lastAccessedAt = null;
  const extensions: number[] = [];
  let reconciliations = 0;
  const sandbox = {
    sandboxId: "sbx-deadline",
    status: input.platformStatus ?? "running",
    timeout: input.totalTimeout ?? 60_000 + SANDBOX_TIMEOUT_SAFETY_RUNWAY_MS,
    timeoutRemaining: input.timeout ?? 1,
    extendTimeout: async (duration: number) => {
      extensions.push(duration);
      if (input.activityAtMsDuringExtend !== undefined) {
        meta.lastAccessedAt = input.activityAtMsDuringExtend;
      }
    },
  } as SandboxHandle;
  return {
    deps: {
      read: async () => structuredClone(state),
      write: async (next) => {
        state = structuredClone(next);
      },
      clear: async () => {
        state = null;
      },
      acquireLock: async () => "lock-token",
      releaseLock: async () => {},
      getMeta: async () => structuredClone(meta),
      getSandbox: async () => {
        if (input.getSandboxError !== undefined) throw input.getSandboxError;
        return sandbox;
      },
      reconcile: async (reconcileInput) => {
        reconciliations += 1;
        const reconciled = input.reconcile
          ? await input.reconcile(structuredClone(meta), reconcileInput)
          : {
              ...meta,
              status: reconcileInput.metaStatus,
              lastError: reconcileInput.lastError,
              ...(reconcileInput.metaStatus === "uninitialized"
                ? {
                    sandboxId: null,
                    portUrls: null,
                    pendingPersistentAutoSave: null,
                    activePersistentStop: null,
                  }
                : {}),
            };
        meta = structuredClone(reconciled);
        return structuredClone(meta);
      },
      stop: input.stop,
      now: () => 2_000,
    },
    extensions,
    read: () => structuredClone(state),
    getMeta: () => structuredClone(meta),
    reconciliations: () => reconciliations,
  };
}

test("deadline step extends native runway before explicit cooperative stop", async () => {
  const h = stepHarness({
    stop: async () => ({ status: "snapshotting" }) as SingleMeta,
  });
  const result = await processSandboxDeadlineStep("generation-1", h.deps);
  assert.deepEqual(result, { status: "done", reason: "stop-snapshotting" });
  assert.equal(h.extensions.length, 1);
  assert.ok(h.extensions[0] > 0);
  assert.equal(h.read(), null);
});

test("deadline step releases its lock before entering lifecycle stop", async () => {
  let deadlineLockHeld = false;
  const h = stepHarness({
    stop: async () => {
      assert.equal(deadlineLockHeld, false);
      return { status: "snapshotting" } as SingleMeta;
    },
  });
  h.deps.acquireLock = async () => {
    if (deadlineLockHeld) return null;
    deadlineLockHeld = true;
    return "deadline-lock";
  };
  h.deps.releaseLock = async () => {
    deadlineLockHeld = false;
  };

  const result = await processSandboxDeadlineStep("generation-1", h.deps);

  assert.deepEqual(result, { status: "done", reason: "stop-snapshotting" });
  assert.equal(deadlineLockHeld, false);
});

test("revoked lifecycle claim preserves a concurrently refreshed deadline", async () => {
  const revoked = Object.assign(new Error("deadline claim revoked"), {
    code: "SANDBOX_LIFECYCLE_GUARD_REJECTED",
  });
  const stateAccess: {
    read: ReturnType<typeof stepHarness>["read"] | null;
    write: ReturnType<typeof stepHarness>["deps"]["write"] | null;
  } = { read: null, write: null };
  const h = stepHarness({
    stop: async () => {
      assert.ok(stateAccess.read);
      assert.ok(stateAccess.write);
      const current = stateAccess.read();
      assert.ok(current);
      await stateAccess.write({
        ...current,
        deadlineAtMs: 20_000,
        lastAttemptAtMs: null,
        lastOutcome: "armed",
      });
      throw revoked;
    },
  });
  stateAccess.read = h.read;
  stateAccess.write = h.deps.write;

  const result = await processSandboxDeadlineStep("generation-1", h.deps);

  assert.deepEqual(result, { status: "sleep", deadlineAtMs: 20_000 });
  assert.equal(h.read()?.lastOutcome, "armed");
});

test("deadline step never extends past the portable total timeout", async () => {
  const h = stepHarness({
    totalTimeout: MAX_PORTABLE_SANDBOX_SLEEP_AFTER_MS - 30_000,
    stop: async () => ({ status: "snapshotting" }) as SingleMeta,
  });

  await processSandboxDeadlineStep("generation-1", h.deps);

  assert.deepEqual(h.extensions, [30_000]);
});

test("platform stop reconciles lifecycle metadata before clearing the deadline", async () => {
  const h = stepHarness({
    platformStatus: "stopped",
    reconcile: async (meta) => ({ ...meta, status: "stopped" }),
    stop: async () => {
      throw new Error("must not run");
    },
  });

  const result = await processSandboxDeadlineStep("generation-1", h.deps);

  assert.deepEqual(result, {
    status: "done",
    reason: "platform-stopped-reconciled",
  });
  assert.equal(h.reconciliations(), 1);
  assert.equal(h.read(), null);
});

test("platform stop retains the deadline while metadata still says running", async () => {
  const h = stepHarness({
    platformStatus: "stopped",
    reconcile: async (meta) => meta,
    stop: async () => {
      throw new Error("must not run");
    },
  });

  const result = await processSandboxDeadlineStep("generation-1", h.deps);

  assert.deepEqual(result, { status: "sleep", deadlineAtMs: 32_000 });
  assert.equal(h.read()?.generationId, "generation-1");
  assert.equal(
    h.read()?.lastErrorCode,
    "DEADLINE_PLATFORM_RECONCILE_PENDING",
  );
});

test("platform 404 reconciles lifecycle metadata before clearing the deadline", async () => {
  const notFound = Object.assign(new Error("sandbox unavailable"), {
    response: { status: 404 },
  });
  const h = stepHarness({
    getSandboxError: notFound,
    stop: async () => {
      throw new Error("must not run");
    },
  });

  const result = await processSandboxDeadlineStep("generation-1", h.deps);

  assert.deepEqual(result, {
    status: "done",
    reason: "platform-not-found-reconciled",
  });
  assert.equal(h.reconciliations(), 1);
  assert.equal(h.getMeta().status, "uninitialized");
  assert.equal(h.getMeta().sandboxId, null);
  assert.equal(h.read(), null);
});

test("expired deadline lock contention always sleeps to a future poll", async () => {
  const h = stepHarness({
    stop: async () => {
      throw new Error("must not run");
    },
  });
  h.deps.acquireLock = async () => null;

  const result = await processSandboxDeadlineStep("generation-1", h.deps);

  assert.deepEqual(result, { status: "sleep", deadlineAtMs: 3_000 });
});

test("transitional platform status retains the deadline for another poll", async () => {
  const h = stepHarness({
    platformStatus: "snapshotting",
    stop: async () => {
      throw new Error("must not run");
    },
  });

  const result = await processSandboxDeadlineStep("generation-1", h.deps);

  assert.deepEqual(result, { status: "sleep", deadlineAtMs: 7_000 });
  assert.equal(h.reconciliations(), 0);
  assert.equal(h.read()?.lastErrorCode, "DEADLINE_PLATFORM_TRANSITIONAL");
});

test("failed platform status reconciles metadata to error", async () => {
  const reconciledMetas: SingleMeta[] = [];
  const h = stepHarness({
    platformStatus: "failed",
    reconcile: async (meta, input) => {
      const reconciledMeta = {
        ...meta,
        status: input.metaStatus,
        lastError: input.lastError,
      };
      reconciledMetas.push(reconciledMeta);
      return reconciledMeta;
    },
    stop: async () => {
      throw new Error("must not run");
    },
  });

  const result = await processSandboxDeadlineStep("generation-1", h.deps);

  assert.deepEqual(result, {
    status: "done",
    reason: "platform-failed-reconciled",
  });
  assert.equal(reconciledMetas[0]?.status, "error");
  assert.equal(reconciledMetas[0]?.lastError, "sandbox failed");
});

test("busy deadline stop retains generation and reschedules inside runway", async () => {
  const h = stepHarness({
    stop: async () => {
      throw new HostSuspensionBusyError({
        status: "busy",
        reason: "active run",
        retryAfterMs: 750,
        activeCount: 1,
        blockers: [{ kind: "agent-runs", count: 1 }],
      });
    },
  });
  const result = await processSandboxDeadlineStep("generation-1", h.deps);
  assert.deepEqual(result, { status: "sleep", deadlineAtMs: 17_000 });
  assert.equal(h.read()?.generationId, "generation-1");
  assert.equal(h.read()?.lastOutcome, "busy");
  assert.equal(h.read()?.lastErrorCode, "GATEWAY_SUSPEND_BUSY");
});

test("old deadline generation cannot stop a replacement sandbox", async () => {
  const h = stepHarness({
    stop: async () => {
      throw new Error("must not run");
    },
  });
  const result = await processSandboxDeadlineStep("old-generation", h.deps);
  assert.deepEqual(result, {
    status: "done",
    reason: "generation-replaced-or-cleared",
  });
  assert.equal(h.extensions.length, 0);
});

test("activity-refreshed deadline is revalidated before stop", async () => {
  const h = stepHarness({
    stop: async () => {
      throw new Error("must not run");
    },
  });
  await h.deps.write({
    ...deadlineState(),
    deadlineAtMs: 10_000,
    updatedAtMs: 2_000,
    lastAttemptAtMs: null,
  });

  const result = await processSandboxDeadlineStep("generation-1", h.deps);

  assert.deepEqual(result, { status: "sleep", deadlineAtMs: 10_000 });
  assert.equal(h.extensions.length, 0);
});

test("deadline step publishes the later target it returns to Workflow sleep", async () => {
  const h = stepHarness({
    stop: async () => {
      throw new Error("must not run");
    },
  });
  await h.deps.write({
    ...deadlineState(),
    deadlineAtMs: 10_000,
    workflowScheduledDeadlineAtMs: 1_000,
  });

  const result = await processSandboxDeadlineStep("generation-1", h.deps);

  assert.deepEqual(result, { status: "sleep", deadlineAtMs: 10_000 });
  assert.equal(h.read()?.workflowScheduledDeadlineAtMs, 10_000);
});

test("activity metadata updated during a deadline claim reschedules stop", async () => {
  const h = stepHarness({
    activityAtMsDuringExtend: 2_000,
    stop: async () => {
      throw new Error("must not run");
    },
  });

  const result = await processSandboxDeadlineStep("generation-1", h.deps);

  assert.deepEqual(result, { status: "sleep", deadlineAtMs: 62_000 });
  assert.equal(h.read()?.lastAttemptAtMs, null);
  assert.equal(h.read()?.lastOutcome, "armed");
});

test("activity revalidation cannot move stop past native expiry cap", async () => {
  let stopped = false;
  const h = stepHarness({
    activityAtMsDuringExtend: 2_000,
    stop: async () => {
      stopped = true;
      return { status: "snapshotting" } as SingleMeta;
    },
  });
  await h.deps.write({
    ...deadlineState(),
    nativeStopDeadlineAtMs: 2_000,
  });

  const result = await processSandboxDeadlineStep("generation-1", h.deps);

  assert.deepEqual(result, { status: "done", reason: "stop-snapshotting" });
  assert.equal(stopped, true);
  assert.equal(h.read(), null);
});
