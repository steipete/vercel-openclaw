import assert from "node:assert/strict";
import test from "node:test";

import { GatewayAdminRpcError } from "@/server/openclaw/admin-rpc";
import type { SandboxHandle } from "@/server/sandbox/controller";
import {
  HostSuspensionBusyError,
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

function fakeSandbox(): SandboxHandle {
  return { sandboxId: "sbx-host-suspension" } as SandboxHandle;
}

function harness(
  rpc: HostSuspensionDeps["callRpc"],
): {
  deps: HostSuspensionDeps;
  readState: () => HostSuspensionState | null;
  monitorStarts: string[];
} {
  let state: HostSuspensionState | null = null;
  let now = 1_000;
  let stateLockToken: string | null = null;
  let stateLockSequence = 0;
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

test("a fenced request repairs a stale durable stop monitor handoff", async () => {
  const h = harness(async <T>() => ({
    status: "ready",
    suspensionId: "suspension-1",
    expiresAtMs: 10_000,
  }) as T);
  const prepared = await prepareHostSuspension({
    sandbox: fakeSandbox(),
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
    reason: "replacement-test",
  }, h.deps);
  await markHostSuspensionStopped(prepared.operationId, h.deps);

  assert.equal(
    await thawHostSuspensionIfNeeded({
      sandbox: { sandboxId: "sbx-replacement" } as SandboxHandle,
    }, h.deps),
    true,
  );
  assert.equal(h.readState(), null);
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
      reason: "test-stop",
    }, h.deps),
    /plugin missing/,
  );
  assert.equal(h.readState()?.phase, "failed");
  assert.equal(h.readState()?.ingressFenced, false);
});

test("ambiguous prepare failure keeps host ingress fenced", async () => {
  const h = harness(async <_T>() => {
    throw new Error("prepare response timed out");
  });

  await assert.rejects(
    prepareHostSuspension({
      sandbox: fakeSandbox(),
      reason: "ambiguous-prepare-test",
    }, h.deps),
    /prepare response timed out/,
  );

  assert.equal(h.readState()?.phase, "failed");
  assert.equal(h.readState()?.ingressFenced, true);
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
    reason: "validation-test",
  }, h.deps);
  const malformedStates: unknown[] = [
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
