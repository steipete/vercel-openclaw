import assert from "node:assert/strict";
import test from "node:test";

import {
  processHostStopMonitorStep,
  type HostStopMonitorDeps,
} from "@/server/workflows/sandbox/host-stop-workflow";
import type { HostSuspensionState } from "@/server/sandbox/host-suspension";
import type { SingleMeta } from "@/shared/types";

function state(overrides: Partial<HostSuspensionState> = {}): HostSuspensionState {
  return {
    version: 1,
    operationId: "operation-1",
    requestId: "operation-1",
    sandboxId: "sbx-1",
    lifecycleAttemptId: "attempt-1",
    intent: "stop",
    reason: "test",
    phase: "stopping",
    ingressFenced: true,
    suspensionId: "suspension-1",
    leaseExpiresAtMs: 100_000,
    stopRequestDeadlineAtMs: null,
    monitorHeartbeatAtMs: 1,
    startedAtMs: 1,
    updatedAtMs: 2,
    stoppedAtMs: null,
    resumedAtMs: null,
    lastError: null,
    lastErrorCode: null,
    lastErrorClass: null,
    ...overrides,
  };
}

function deps(input: {
  states: Array<HostSuspensionState | null>;
  meta: SingleMeta;
  reconciled?: SingleMeta;
}): HostStopMonitorDeps {
  let readIndex = 0;
  return {
    readSuspension: async () => input.states[Math.min(readIndex++, input.states.length - 1)] ?? null,
    getMeta: async () => input.meta,
    reconcile: async () => input.reconciled ?? input.meta,
    resumeReset: async () => input.reconciled ?? input.meta,
    heartbeat: async () => {},
  };
}

test("host stop monitor exits when the operation was replaced", async () => {
  const result = await processHostStopMonitorStep("operation-1", deps({
    states: [state({ operationId: "other" })],
    meta: { status: "snapshotting" } as SingleMeta,
  }));
  assert.deepEqual(result, { status: "done", reason: "operation-replaced-or-cleared" });
});

test("host stop monitor reconciles snapshotting and exits at stopped", async () => {
  let reconcileCalls = 0;
  const stopped = state({ phase: "stopped" });
  const testDeps = deps({
    states: [state(), stopped],
    meta: { status: "snapshotting" } as SingleMeta,
    reconciled: { status: "stopped" } as SingleMeta,
  });
  const originalReconcile = testDeps.reconcile;
  testDeps.reconcile = async () => {
    reconcileCalls += 1;
    return originalReconcile();
  };

  const result = await processHostStopMonitorStep("operation-1", testDeps);
  assert.equal(reconcileCalls, 1);
  assert.deepEqual(result, { status: "done", reason: "terminal-stopped" });
});

test("host stop monitor reconciles snapshotting before accepting rollback terminal state", async () => {
  let reconcileCalls = 0;
  const failed = state({ phase: "failed", ingressFenced: false });
  const testDeps = deps({
    states: [failed, failed],
    meta: { status: "snapshotting" } as SingleMeta,
    reconciled: { status: "running" } as SingleMeta,
  });
  const originalReconcile = testDeps.reconcile;
  testDeps.reconcile = async () => {
    reconcileCalls += 1;
    return originalReconcile();
  };

  const result = await processHostStopMonitorStep("operation-1", testDeps);

  assert.equal(reconcileCalls, 1);
  assert.deepEqual(result, { status: "done", reason: "terminal-failed" });
});

test("host stop monitor keeps polling a fenced in-flight operation", async () => {
  const result = await processHostStopMonitorStep("operation-1", deps({
    states: [state(), state()],
    meta: { status: "snapshotting" } as SingleMeta,
  }));
  assert.deepEqual(result, {
    status: "poll",
    phase: "stopping",
    sandboxStatus: "snapshotting",
  });
});

test("host stop monitor reconciles a prepared operation before metadata parking", async () => {
  let reconcileCalls = 0;
  const testDeps = deps({
    states: [
      state({ phase: "prepared" }),
      state({ phase: "failed", ingressFenced: false }),
    ],
    meta: { status: "running" } as SingleMeta,
    reconciled: { status: "running" } as SingleMeta,
  });
  const originalReconcile = testDeps.reconcile;
  testDeps.reconcile = async () => {
    reconcileCalls += 1;
    return originalReconcile();
  };

  const result = await processHostStopMonitorStep("operation-1", testDeps);
  assert.equal(reconcileCalls, 1);
  assert.deepEqual(result, { status: "done", reason: "terminal-failed" });
});

test("host stop monitor retries an interrupted thaw before accepting terminal state", async () => {
  let reconcileCalls = 0;
  const testDeps = deps({
    states: [
      state({ phase: "thawing" }),
      state({ phase: "running", ingressFenced: false }),
    ],
    meta: { status: "error", sandboxId: "sbx-1" } as SingleMeta,
    reconciled: { status: "running", sandboxId: "sbx-1" } as SingleMeta,
  });
  const originalReconcile = testDeps.reconcile;
  testDeps.reconcile = async () => {
    reconcileCalls += 1;
    return originalReconcile();
  };

  const result = await processHostStopMonitorStep("operation-1", testDeps);

  assert.equal(reconcileCalls, 1);
  assert.deepEqual(result, { status: "done", reason: "terminal-running" });
});

test("host stop monitor adopts an interrupted reset delete", async () => {
  let resetCalls = 0;
  const testDeps = deps({
    states: [
      state({ intent: "reset", reason: "sandbox.reset", phase: "stopping" }),
      null,
    ],
    meta: { status: "running", sandboxId: "sbx-1" } as SingleMeta,
    reconciled: { status: "uninitialized", sandboxId: null } as SingleMeta,
  });
  const resumeReset = testDeps.resumeReset;
  testDeps.resumeReset = async (expected) => {
    resetCalls += 1;
    assert.equal(expected.lifecycleAttemptId, "attempt-1");
    return resumeReset(expected);
  };

  const result = await processHostStopMonitorStep("operation-1", testDeps);

  assert.equal(resetCalls, 1);
  assert.deepEqual(result, {
    status: "done",
    reason: "operation-replaced-or-cleared",
  });
});
