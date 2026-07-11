import assert from "node:assert/strict";
import test from "node:test";

import { GatewayAdminRpcError } from "@/server/openclaw/admin-rpc";
import type { SandboxHandle } from "@/server/sandbox/controller";
import {
  HostSuspensionBusyError,
  clearHostSuspensionAfterDelete,
  getHostIngressFence,
  getHostMutationFence,
  heartbeatHostStopMonitor,
  markHostSuspensionStopped,
  markHostSuspensionStopping,
  prepareHostSuspension,
  readHostSuspensionState,
  renewHostSuspension,
  rollbackHostSuspension,
  thawHostSuspensionIfNeeded,
  type HostSuspensionDeps,
  type HostSuspensionState,
} from "@/server/sandbox/host-suspension";

const LIFECYCLE_ATTEMPT_ID = "lifecycle-attempt-1";

function fakeSandbox(): SandboxHandle {
  return { sandboxId: "sbx-host-suspension" } as SandboxHandle;
}

function harness(
  rpc: HostSuspensionDeps["callRpc"],
): {
  deps: HostSuspensionDeps;
  readState: () => HostSuspensionState | null;
  monitorStarts: string[];
  setCurrentGeneration: (input: {
    sandboxId: string | null;
    lifecycleAttemptId: string | null;
  }) => void;
} {
  let state: HostSuspensionState | null = null;
  let now = 1_000;
  let stateLockToken: string | null = null;
  let stateLockSequence = 0;
  let currentGeneration: {
    sandboxId: string | null;
    lifecycleAttemptId: string | null;
  } = {
    sandboxId: fakeSandbox().sandboxId,
    lifecycleAttemptId: LIFECYCLE_ATTEMPT_ID,
  };
  const monitorStarts: string[] = [];
  return {
    deps: {
      read: async () => structuredClone(state),
      write: async (next) => {
        state = structuredClone(next);
      },
      clear: async () => {
        state = null;
      },
      getCurrentGeneration: async () => structuredClone(currentGeneration),
      acquireStateLock: async () => {
        if (stateLockToken) return null;
        stateLockSequence += 1;
        stateLockToken = `state-lock-${stateLockSequence}`;
        return stateLockToken;
      },
      releaseStateLock: async (token) => {
        if (token === stateLockToken) stateLockToken = null;
      },
      callRpc: rpc,
      now: () => ++now,
      randomId: () => "operation-stable",
      startMonitor: async (operationId) => {
        monitorStarts.push(operationId);
      },
    },
    readState: () => structuredClone(state),
    monitorStarts,
    setCurrentGeneration(input) {
      currentGeneration = structuredClone(input);
    },
  };
}

test("prepare and renew reuse one stable request id", async () => {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const h = harness(async <T>(input: { method: string; params?: unknown }) => {
    calls.push(input);
    return {
      status: "ready",
      suspensionId: "suspension-1",
      expiresAtMs: 10_000 + calls.length,
      activeCount: 0,
      blockers: [],
    } as T;
  });

  const prepared = await prepareHostSuspension({
    sandbox: fakeSandbox(),
    lifecycleAttemptId: LIFECYCLE_ATTEMPT_ID,
    reason: "test-stop",
  }, h.deps);
  const renewed = await renewHostSuspension({
    state: prepared,
    sandbox: fakeSandbox(),
  }, h.deps);

  assert.equal(prepared.requestId, "operation-stable");
  assert.equal(renewed.requestId, "operation-stable");
  assert.equal(renewed.leaseExpiresAtMs, 10_002);
  assert.deepEqual(calls.map((call) => call.method), [
    "gateway.suspend.prepare",
    "gateway.suspend.prepare",
  ]);
  assert.deepEqual(calls.map((call) => call.params), [
    { requestId: "operation-stable" },
    { requestId: "operation-stable" },
  ]);
  assert.deepEqual(h.monitorStarts, ["operation-stable"]);
});

test("a fenced operation stays bound to its lifecycle generation", async () => {
  const h = harness(async <T>() => ({
    status: "ready",
    suspensionId: "suspension-1",
    expiresAtMs: 10_000,
  }) as T);
  const prepared = await prepareHostSuspension({
    sandbox: fakeSandbox(),
    lifecycleAttemptId: LIFECYCLE_ATTEMPT_ID,
    reason: "generation-binding-test",
  }, h.deps);

  await assert.rejects(
    prepareHostSuspension({
      sandbox: fakeSandbox(),
      lifecycleAttemptId: "lifecycle-attempt-2",
      reason: "generation-binding-test",
    }, h.deps),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "HOST_SUSPENSION_CONFLICT");
      return true;
    },
  );

  assert.equal(prepared.lifecycleAttemptId, LIFECYCLE_ATTEMPT_ID);
  assert.equal(h.readState()?.lifecycleAttemptId, LIFECYCLE_ATTEMPT_ID);
});

test("monitor handoff failure before Gateway prepare reopens host ingress", async () => {
  let rpcCalls = 0;
  const h = harness(async <T>() => {
    rpcCalls += 1;
    return {} as T;
  });
  h.deps.startMonitor = async () => {
    throw new Error("workflow unavailable");
  };

  await assert.rejects(
    prepareHostSuspension({
      sandbox: fakeSandbox(),
      lifecycleAttemptId: LIFECYCLE_ATTEMPT_ID,
      reason: "monitor-start-failure-test",
    }, h.deps),
    /workflow unavailable/,
  );

  assert.equal(rpcCalls, 0);
  assert.equal(h.readState()?.phase, "failed");
  assert.equal(h.readState()?.ingressFenced, false);
});

test("a fenced request repairs a stale durable stop monitor handoff", async () => {
  const h = harness(async <T>() => ({
    status: "ready",
    suspensionId: "suspension-1",
    expiresAtMs: 10_000,
  }) as T);
  const prepared = await prepareHostSuspension({
    sandbox: fakeSandbox(),
    lifecycleAttemptId: LIFECYCLE_ATTEMPT_ID,
    reason: "monitor-repair-test",
  }, h.deps);
  await h.deps.write({
    ...prepared,
    monitorHeartbeatAtMs: -100_000,
  });

  assert.ok(await getHostIngressFence(h.deps));
  assert.deepEqual(h.monitorStarts, ["operation-stable", "operation-stable"]);
});

test("monitor heartbeats preserve the phase transition clock", async () => {
  const h = harness(async <T>() => ({
    status: "ready",
    suspensionId: "suspension-1",
    expiresAtMs: 10_000,
  }) as T);
  const prepared = await prepareHostSuspension({
    sandbox: fakeSandbox(),
    lifecycleAttemptId: LIFECYCLE_ATTEMPT_ID,
    reason: "monitor-heartbeat-test",
  }, h.deps);
  const phaseUpdatedAtMs = prepared.updatedAtMs;

  await heartbeatHostStopMonitor(prepared.operationId, h.deps);

  assert.equal(h.readState()?.updatedAtMs, phaseUpdatedAtMs);
  assert.ok((h.readState()?.monitorHeartbeatAtMs ?? 0) > phaseUpdatedAtMs);
});

test("monitor heartbeat cannot overwrite a concurrent terminal phase", async () => {
  const h = harness(async <T>() => ({
    status: "ready",
    suspensionId: "suspension-1",
    expiresAtMs: 10_000,
  }) as T);
  const prepared = await prepareHostSuspension({
    sandbox: fakeSandbox(),
    lifecycleAttemptId: LIFECYCLE_ATTEMPT_ID,
    reason: "monitor-terminal-race-test",
  }, h.deps);
  const stopping = await markHostSuspensionStopping(prepared, h.deps);

  const originalWrite = h.deps.write;
  let releaseHeartbeatWrite!: () => void;
  const heartbeatWriteBlocked = new Promise<void>((resolve) => {
    h.deps.write = async (next) => {
      const isHeartbeatWrite = next.phase === "stopping"
        && next.updatedAtMs === stopping.updatedAtMs
        && next.monitorHeartbeatAtMs !== stopping.monitorHeartbeatAtMs;
      if (isHeartbeatWrite) {
        await new Promise<void>((release) => {
          releaseHeartbeatWrite = release;
          resolve();
        });
      }
      await originalWrite(next);
    };
  });

  const heartbeat = heartbeatHostStopMonitor(stopping.operationId, h.deps);
  await heartbeatWriteBlocked;
  const terminal = markHostSuspensionStopped(stopping.operationId, h.deps);
  releaseHeartbeatWrite();
  await Promise.all([heartbeat, terminal]);

  assert.equal(h.readState()?.phase, "stopped");
  assert.equal(h.readState()?.ingressFenced, true);
});

test("busy prepare refuses stop and reopens app-owned ingress", async () => {
  const h = harness(async <T>() => ({
    status: "busy",
    reason: "active work",
    retryAfterMs: 500,
    activeCount: 2,
    blockers: [{ kind: "agent-runs", count: 2 }],
  }) as T);

  await assert.rejects(
    prepareHostSuspension({
      sandbox: fakeSandbox(),
      lifecycleAttemptId: LIFECYCLE_ATTEMPT_ID,
      reason: "test-stop",
    }, h.deps),
    (error: unknown) => {
      assert.ok(error instanceof HostSuspensionBusyError);
      assert.equal(error.activeCount, 2);
      assert.equal(error.retryAfterMs, 500);
      return true;
    },
  );

  assert.equal(h.readState()?.phase, "failed");
  assert.equal(h.readState()?.ingressFenced, false);
  assert.equal(await getHostIngressFence(h.deps), null);
});

test("persisted stop stays fenced until status and resume confirm running", async () => {
  const calls: string[] = [];
  const h = harness(async <T>(input: { method: string }) => {
    calls.push(input.method);
    if (input.method === "gateway.suspend.prepare") {
      return {
        status: "ready",
        suspensionId: "suspension-1",
        expiresAtMs: 10_000,
      } as T;
    }
    if (input.method === "gateway.suspend.status") {
      return {
        status: "ready",
        suspensionId: "suspension-1",
        expiresAtMs: 10_000,
      } as T;
    }
    return { ok: true, status: "running", resumed: true } as T;
  });

  const prepared = await prepareHostSuspension({
    sandbox: fakeSandbox(),
    lifecycleAttemptId: LIFECYCLE_ATTEMPT_ID,
    reason: "test-stop",
  }, h.deps);
  const stopping = await markHostSuspensionStopping(prepared, h.deps);
  await markHostSuspensionStopped(stopping.operationId, h.deps);

  assert.equal(await getHostIngressFence(h.deps), null, "stopped ingress may trigger wake");
  assert.equal(h.readState()?.ingressFenced, true);
  assert.equal(
    await thawHostSuspensionIfNeeded({
      sandbox: fakeSandbox(),
    }, h.deps),
    true,
  );
  assert.deepEqual(calls, [
    "gateway.suspend.prepare",
    "gateway.suspend.status",
    "gateway.suspend.resume",
  ]);
  assert.equal(h.readState()?.phase, "running");
  assert.equal(h.readState()?.ingressFenced, false);
});

test("replacement sandbox retires a stopped fence from the prior process", async () => {
  const h = harness(async <T>() => ({
    status: "ready",
    suspensionId: "suspension-1",
    expiresAtMs: 10_000,
  }) as T);
  const prepared = await prepareHostSuspension({
    sandbox: fakeSandbox(),
    lifecycleAttemptId: LIFECYCLE_ATTEMPT_ID,
    reason: "replacement-test",
  }, h.deps);
  await markHostSuspensionStopped(prepared.operationId, h.deps);
  h.setCurrentGeneration({
    sandboxId: "sbx-replacement",
    lifecycleAttemptId: "replacement-attempt",
  });

  assert.equal(
    await thawHostSuspensionIfNeeded({
      sandbox: { sandboxId: "sbx-replacement" } as SandboxHandle,
      lifecycleAttemptId: "replacement-attempt",
    }, h.deps),
    true,
  );
  assert.equal(h.readState(), null);
});

test("same-name persistent resume adopts a stopped fence into the new lifecycle attempt", async () => {
  const calls: string[] = [];
  const h = harness(async <T>(input: { method: string }) => {
    calls.push(input.method);
    if (input.method === "gateway.suspend.prepare") {
      return {
        status: "ready",
        suspensionId: "suspension-stable-name",
        expiresAtMs: 10_000,
      } as T;
    }
    if (input.method === "gateway.suspend.status") {
      return { status: "ready", expiresAtMs: 10_000 } as T;
    }
    return { ok: true, status: "running", resumed: true } as T;
  });
  const prepared = await prepareHostSuspension({
    sandbox: fakeSandbox(),
    lifecycleAttemptId: LIFECYCLE_ATTEMPT_ID,
    reason: "stable-name-resume-test",
  }, h.deps);
  await markHostSuspensionStopped(prepared.operationId, h.deps);
  h.setCurrentGeneration({
    sandboxId: fakeSandbox().sandboxId,
    lifecycleAttemptId: "lifecycle-attempt-2",
  });

  assert.equal(await thawHostSuspensionIfNeeded({
    sandbox: fakeSandbox(),
    lifecycleAttemptId: "lifecycle-attempt-2",
  }, h.deps), true);
  assert.equal(h.readState()?.lifecycleAttemptId, "lifecycle-attempt-2");
  assert.equal(h.readState()?.phase, "running");
  assert.equal(h.readState()?.ingressFenced, false);
  assert.deepEqual(calls, [
    "gateway.suspend.prepare",
    "gateway.suspend.status",
    "gateway.suspend.status",
    "gateway.suspend.resume",
  ]);
});

test("same-name replacement clears an old stopped fence when the lease is absent", async () => {
  const h = harness(async <T>(input: { method: string }) => {
    if (input.method === "gateway.suspend.prepare") {
      return {
        status: "ready",
        suspensionId: "suspension-old-process",
        expiresAtMs: 10_000,
      } as T;
    }
    return { status: "running" } as T;
  });
  const prepared = await prepareHostSuspension({
    sandbox: fakeSandbox(),
    lifecycleAttemptId: LIFECYCLE_ATTEMPT_ID,
    reason: "same-name-replacement-test",
  }, h.deps);
  await markHostSuspensionStopped(prepared.operationId, h.deps);
  h.setCurrentGeneration({
    sandboxId: fakeSandbox().sandboxId,
    lifecycleAttemptId: "replacement-attempt",
  });

  assert.equal(await thawHostSuspensionIfNeeded({
    sandbox: fakeSandbox(),
    lifecycleAttemptId: "replacement-attempt",
  }, h.deps), true);
  assert.equal(h.readState(), null);
});

test("stale replacement caller cannot clear the current generation fence", async () => {
  const h = harness(async <T>() => ({
    status: "ready",
    suspensionId: "suspension-current",
    expiresAtMs: 10_000,
  }) as T);
  const prepared = await prepareHostSuspension({
    sandbox: fakeSandbox(),
    lifecycleAttemptId: LIFECYCLE_ATTEMPT_ID,
    reason: "stale-replacement-test",
  }, h.deps);
  const currentFence = {
    ...prepared,
    operationId: "operation-current",
    requestId: "operation-current",
    sandboxId: "sbx-current",
    lifecycleAttemptId: "attempt-current",
    phase: "stopped" as const,
    stoppedAtMs: 2_000,
  };
  await h.deps.write(currentFence);
  h.setCurrentGeneration({
    sandboxId: "sbx-current",
    lifecycleAttemptId: "attempt-current",
  });

  assert.equal(
    await thawHostSuspensionIfNeeded({
      sandbox: { sandboxId: "sbx-stale" } as SandboxHandle,
      lifecycleAttemptId: "attempt-stale",
    }, h.deps),
    false,
  );
  assert.deepEqual(h.readState(), currentFence);
});

test("failed platform stop resumes Gateway before reopening ingress", async () => {
  const calls: string[] = [];
  const h = harness(async <T>(input: { method: string }) => {
    calls.push(input.method);
    if (input.method === "gateway.suspend.prepare") {
      return {
        status: "ready",
        suspensionId: "suspension-1",
        expiresAtMs: 10_000,
      } as T;
    }
    if (input.method === "gateway.suspend.status") {
      return {
        status: "ready",
        suspensionId: "suspension-1",
        expiresAtMs: 10_000,
      } as T;
    }
    return { ok: true, status: "running", resumed: true } as T;
  });
  const prepared = await prepareHostSuspension({
    sandbox: fakeSandbox(),
    lifecycleAttemptId: LIFECYCLE_ATTEMPT_ID,
    reason: "test-stop",
  }, h.deps);

  await rollbackHostSuspension({
    state: prepared,
    sandbox: fakeSandbox(),
    error: new Error("platform stop failed"),
  }, h.deps);

  assert.deepEqual(calls, [
    "gateway.suspend.prepare",
    "gateway.suspend.status",
    "gateway.suspend.resume",
  ]);
  assert.equal(h.readState()?.ingressFenced, false);
  assert.match(h.readState()?.lastError ?? "", /platform stop failed/);
});

test("transient thaw failure stays retryable until Gateway admission resumes", async () => {
  let statusCalls = 0;
  const h = harness(async <T>(input: { method: string }) => {
    if (input.method === "gateway.suspend.prepare") {
      return {
        status: "ready",
        suspensionId: "suspension-1",
        expiresAtMs: 10_000,
      } as T;
    }
    if (input.method === "gateway.suspend.status") {
      statusCalls += 1;
      if (statusCalls === 1) throw new Error("control plane unavailable");
      return { status: "ready", expiresAtMs: 10_000 } as T;
    }
    return { ok: true, status: "running", resumed: true } as T;
  });
  const prepared = await prepareHostSuspension({
    sandbox: fakeSandbox(),
    lifecycleAttemptId: LIFECYCLE_ATTEMPT_ID,
    reason: "retry-thaw-test",
  }, h.deps);
  await markHostSuspensionStopped(prepared.operationId, h.deps);

  assert.equal(await thawHostSuspensionIfNeeded({
    sandbox: fakeSandbox(),
    lifecycleAttemptId: LIFECYCLE_ATTEMPT_ID,
  }, h.deps), false);
  assert.equal(h.readState()?.phase, "rollback-pending");
  assert.equal(h.readState()?.ingressFenced, true);

  assert.equal(await thawHostSuspensionIfNeeded({
    sandbox: fakeSandbox(),
    lifecycleAttemptId: LIFECYCLE_ATTEMPT_ID,
  }, h.deps), true);
  assert.equal(h.readState()?.phase, "running");
  assert.equal(h.readState()?.ingressFenced, false);
});

test("missing admin-http-rpc plugin fails closed for stop without wedging ingress", async () => {
  const h = harness(async <_T>() => {
    throw new GatewayAdminRpcError({
      code: "ADMIN_RPC_NOT_INSTALLED",
      message: "plugin missing",
      status: 404,
    });
  });

  await assert.rejects(
    prepareHostSuspension({
      sandbox: fakeSandbox(),
      lifecycleAttemptId: LIFECYCLE_ATTEMPT_ID,
      reason: "test-stop",
    }, h.deps),
    /plugin missing/,
  );
  assert.equal(h.readState()?.phase, "failed");
  assert.equal(h.readState()?.ingressFenced, false);
});

test("ambiguous prepare failure stays fenced in a monitor-recoverable phase", async () => {
  const h = harness(async <_T>() => {
    throw new Error("prepare response timed out");
  });

  await assert.rejects(
    prepareHostSuspension({
      sandbox: fakeSandbox(),
      lifecycleAttemptId: LIFECYCLE_ATTEMPT_ID,
      reason: "ambiguous-prepare-test",
    }, h.deps),
    /prepare response timed out/,
  );

  const ambiguous = h.readState();
  assert.ok(ambiguous);
  assert.equal(ambiguous.phase, "preparing");
  assert.equal(ambiguous.ingressFenced, true);
  assert.match(ambiguous.lastError ?? "", /prepare response timed out/);
  assert.deepEqual(h.monitorStarts, ["operation-stable"]);

  await h.deps.write({
    ...ambiguous,
    monitorHeartbeatAtMs: -100_000,
  });
  assert.deepEqual(await getHostIngressFence(h.deps), {
    operationId: "operation-stable",
    phase: "preparing",
    retryAfterMs: 2_000,
  });
  assert.deepEqual(h.monitorStarts, ["operation-stable", "operation-stable"]);
});

test("corrupt-state delete cleanup preserves a valid concurrent replacement", async () => {
  const h = harness(async <T>() => ({
    status: "ready",
    suspensionId: "suspension-1",
    expiresAtMs: 10_000,
  }) as T);
  const prepared = await prepareHostSuspension({
    sandbox: fakeSandbox(),
    lifecycleAttemptId: LIFECYCLE_ATTEMPT_ID,
    reason: "corrupt-replacement-test",
  }, h.deps);
  const replacement: HostSuspensionState = {
    ...prepared,
    operationId: "operation-replacement",
    requestId: "operation-replacement",
    sandboxId: "sbx-replacement",
    lifecycleAttemptId: "lifecycle-attempt-replacement",
  };
  await h.deps.write({ version: 99 } as unknown as HostSuspensionState);

  const acquireStateLock = h.deps.acquireStateLock;
  let installReplacement = true;
  h.deps.acquireStateLock = async () => {
    const token = await acquireStateLock();
    if (token && installReplacement) {
      installReplacement = false;
      await h.deps.write(replacement);
    }
    return token;
  };

  await clearHostSuspensionAfterDelete({
    sandboxId: fakeSandbox().sandboxId,
    recoverCorruptState: true,
  }, h.deps);

  assert.deepEqual(h.readState(), replacement);
});

test("corrupt-state delete cleanup clears a record still corrupt under lock", async () => {
  const h = harness(async <T>() => ({}) as T);
  await h.deps.write({ version: 99 } as unknown as HostSuspensionState);

  await clearHostSuspensionAfterDelete({
    sandboxId: fakeSandbox().sandboxId,
    recoverCorruptState: true,
  }, h.deps);

  assert.equal(h.readState(), null);
});

test("stale delete cleanup cannot clear a same-name replacement operation", async () => {
  const h = harness(async <T>() => ({
    status: "ready",
    suspensionId: "suspension-old",
    expiresAtMs: 10_000,
  }) as T);
  const original = await prepareHostSuspension({
    sandbox: fakeSandbox(),
    lifecycleAttemptId: LIFECYCLE_ATTEMPT_ID,
    reason: "reset-old",
  }, h.deps);
  const replacement: HostSuspensionState = {
    ...original,
    operationId: "operation-replacement",
    requestId: "operation-replacement",
    lifecycleAttemptId: "attempt-replacement",
  };
  await h.deps.write(replacement);

  await clearHostSuspensionAfterDelete({
    sandboxId: replacement.sandboxId,
    operationId: original.operationId,
  }, h.deps);

  assert.deepEqual(h.readState(), replacement);
});

test("exact-operation delete cleanup cannot clear corrupt state", async () => {
  const h = harness(async <T>() => ({}) as T);
  const corrupt = { version: 99 } as unknown as HostSuspensionState;
  await h.deps.write(corrupt);

  await assert.rejects(
    clearHostSuspensionAfterDelete({
      sandboxId: fakeSandbox().sandboxId,
      operationId: "operation-stale",
    }, h.deps),
    (error: unknown) => {
      assert.equal(
        (error as { code?: unknown }).code,
        "HOST_SUSPENSION_STATE_CORRUPT",
      );
      return true;
    },
  );
  assert.deepEqual(h.readState(), corrupt);
});

test("invalid durable state fails closed for ingress and mutations", async () => {
  const badDeps = {
    ...harness(async <T>() => ({}) as T).deps,
    read: async () => ({ version: 99 }) as unknown as HostSuspensionState,
  };

  assert.deepEqual(await getHostIngressFence(badDeps), {
    operationId: "state-corrupt",
    phase: "failed",
    retryAfterMs: 2_000,
  });
  assert.deepEqual(await getHostMutationFence(badDeps), {
    operationId: "state-corrupt",
    phase: "failed",
    retryAfterMs: 2_000,
  });
  await assert.rejects(
    prepareHostSuspension({
      sandbox: fakeSandbox(),
      lifecycleAttemptId: LIFECYCLE_ATTEMPT_ID,
      reason: "test-stop",
    }, badDeps),
    (error: unknown) => {
      assert.equal(
        (error as { code?: unknown }).code,
        "HOST_SUSPENSION_STATE_CORRUPT",
      );
      return true;
    },
  );
});

test("durable state validation rejects malformed optional fields and unknown keys", async () => {
  const h = harness(async <T>() => ({
    status: "ready",
    suspensionId: "suspension-1",
    expiresAtMs: 10_000,
  }) as T);
  const prepared = await prepareHostSuspension({
    sandbox: fakeSandbox(),
    lifecycleAttemptId: LIFECYCLE_ATTEMPT_ID,
    reason: "validation-test",
  }, h.deps);
  const malformedStates: unknown[] = [
    { ...prepared, lifecycleAttemptId: "" },
    { ...prepared, lifecycleAttemptId: 42 },
    { ...prepared, leaseExpiresAtMs: "soon" },
    { ...prepared, stoppedAtMs: Number.NaN },
    { ...prepared, lastErrorCode: 503 },
    { ...prepared, unexpected: true },
    { ...prepared, phase: "stop-requesting", stopRequestDeadlineAtMs: null },
  ];

  for (const malformed of malformedStates) {
    await assert.rejects(
      readHostSuspensionState({
        ...h.deps,
        read: async () => malformed as HostSuspensionState,
      }),
      (error: unknown) => {
        assert.equal(
          (error as { code?: unknown }).code,
          "HOST_SUSPENSION_STATE_CORRUPT",
        );
        return true;
      },
    );
  }
});
