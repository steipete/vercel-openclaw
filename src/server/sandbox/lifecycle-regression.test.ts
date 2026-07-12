import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureSandboxRunning,
  reconcileSnapshottingStatus,
  resetSandbox,
  stopSandbox,
  touchRunningSandbox,
} from "@/server/sandbox/lifecycle";
import type { HostSuspensionState } from "@/server/sandbox/host-suspension";
import { _setSandboxControllerForTesting } from "@/server/sandbox/controller";
import { hostSuspensionOperationKey } from "@/server/store/keyspace";
import {
  _resetStoreForTesting,
  getInitializedMeta,
  getStore,
  mutateMeta,
} from "@/server/store/store";
import { FakeSandboxController, FakeSandboxHandle } from "@/test-utils/fake-sandbox-controller";

const ENV_KEYS = [
  "NODE_ENV",
  "VERCEL",
  "REDIS_URL",
  "KV_URL",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
] as const;

async function withLifecycleEnv(
  fake: FakeSandboxController,
  fn: () => Promise<void>,
): Promise<void> {
  const originals: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) originals[key] = process.env[key];
  (process.env as Record<string, string | undefined>).NODE_ENV = "test";
  delete process.env.VERCEL;
  delete process.env.REDIS_URL;
  delete process.env.KV_URL;
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.VERCEL_OIDC_TOKEN;
  _resetStoreForTesting();
  _setSandboxControllerForTesting(fake);
  try {
    await fn();
  } finally {
    _setSandboxControllerForTesting(null);
    _resetStoreForTesting();
    for (const key of ENV_KEYS) {
      if (originals[key] === undefined) delete process.env[key];
      else (process.env as Record<string, string | undefined>)[key] = originals[key];
    }
  }
}

test("LC-03 reconcileSnapshottingStatus observes with resume:false and preserves sandboxId", async () => {
  const fake = new FakeSandboxController();
  await withLifecycleEnv(fake, async () => {
    const handle = new FakeSandboxHandle("sbx-snapshotting", fake.events);
    handle.setStatus("stopped");
    fake.handlesByIds.set("sbx-snapshotting", handle);
    await mutateMeta((meta) => {
      meta.status = "snapshotting";
      meta.sandboxId = "sbx-snapshotting";
      meta.portUrls = null;
    });

    const result = await reconcileSnapshottingStatus();

    assert.equal(result.status, "stopped");
    assert.equal(result.sandboxId, "sbx-snapshotting");
    assert.deepEqual(fake.getCalls.at(-1), {
      sandboxId: "sbx-snapshotting",
      resume: false,
    });
  });
});

test("WK-04 ensureSandboxRunning observes snapshotting before wake without resume:true", async () => {
  const fake = new FakeSandboxController();
  await withLifecycleEnv(fake, async () => {
    const handle = new FakeSandboxHandle("sbx-observe", fake.events);
    handle.setStatus("snapshotting");
    fake.handlesByIds.set("sbx-observe", handle);
    await mutateMeta((meta) => {
      meta.status = "snapshotting";
      meta.sandboxId = "sbx-observe";
      meta.updatedAt = Date.now();
    });

    const result = await ensureSandboxRunning({
      origin: "https://app.example.test",
      reason: "regression-observe",
    });

    assert.equal(result.state, "waiting");
    assert.deepEqual(fake.getCalls, [{ sandboxId: "sbx-observe", resume: false }]);
  });
});

test("LC-04 explicit wake path resumes persistent sandbox with resume:true", async () => {
  const fake = new FakeSandboxController();
  await withLifecycleEnv(fake, async () => {
    const meta = await getInitializedMeta();
    const persistentSandboxName = `oc-${meta.id.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`;
    const handle = new FakeSandboxHandle(persistentSandboxName, fake.events);
    handle.setStatus("stopped");
    fake.handlesByIds.set(persistentSandboxName, handle);

    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = persistentSandboxName;
      meta.snapshotId = null;
      meta.persistedStateSavedAt = Date.now();
      meta.persistedStateSource = "persistent-auto-save";
    });
    const now = Date.now();
    const stoppedSuspension: HostSuspensionState = {
      version: 1,
      operationId: "lc-04-stop",
      requestId: "lc-04-stop",
      sandboxId: persistentSandboxName,
      lifecycleAttemptId: null,
      intent: "stop",
      reason: "lc-04-fixture",
      phase: "stopped",
      ingressFenced: true,
      suspensionId: "lc-04-suspension",
      leaseExpiresAtMs: now + 120_000,
      stopRequestDeadlineAtMs: null,
      monitorHeartbeatAtMs: now,
      startedAtMs: now - 1_000,
      updatedAtMs: now,
      stoppedAtMs: now,
      resumedAtMs: null,
      lastError: null,
      lastErrorCode: null,
      lastErrorClass: null,
    };
    await getStore().setValue(
      hostSuspensionOperationKey(),
      stoppedSuspension,
    );
    const originalGet = fake.get.bind(fake);
    fake.get = async (params) => {
      const found = await originalGet(params);
      if (params.resume === true) handle.setStatus("running");
      return found;
    };

    await ensureSandboxRunning({
      origin: "https://app.example.test",
      reason: "regression-wake",
      schedule: (callback) => {
        void callback();
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(fake.getCalls.slice(0, 2), [
      { sandboxId: persistentSandboxName, resume: false },
      { sandboxId: persistentSandboxName, resume: true },
    ]);
  });
});

test("LC-01 stopSandbox parks metadata at snapshotting and heartbeat preserves sandboxId", async () => {
  const fake = new FakeSandboxController();
  await withLifecycleEnv(fake, async () => {
    const handle = new FakeSandboxHandle("sbx-stop-regression", fake.events);
    fake.handlesByIds.set("sbx-stop-regression", handle);
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-stop-regression";
      meta.portUrls = { "3000": "https://sbx-stop-regression-3000.fake.vercel.run" };
    });

    const stopped = await stopSandbox();
    const heartbeat = await touchRunningSandbox();

    assert.equal(stopped.status, "snapshotting");
    assert.equal(stopped.sandboxId, "sbx-stop-regression");
    assert.equal(heartbeat.status, "snapshotting");
    assert.equal(heartbeat.sandboxId, "sbx-stop-regression");
    assert.equal(handle.lastStopOptions?.blocking, false);
  });
});

test("LC-02 reconcile keeps sandboxId when SDK reports stopped", async () => {
  const fake = new FakeSandboxController();
  await withLifecycleEnv(fake, async () => {
    const handle = new FakeSandboxHandle("sbx-stopped-regression", fake.events);
    handle.setStatus("stopped");
    fake.handlesByIds.set("sbx-stopped-regression", handle);
    await mutateMeta((meta) => {
      meta.status = "snapshotting";
      meta.sandboxId = "sbx-stopped-regression";
    });

    await reconcileSnapshottingStatus();
    const meta = await getInitializedMeta();

    assert.equal(meta.status, "stopped");
    assert.equal(meta.sandboxId, "sbx-stopped-regression");
  });
});

test("resetSandbox clears wedged lifecycle metadata", async () => {
  const fake = new FakeSandboxController();
  await withLifecycleEnv(fake, async () => {
    const handle = new FakeSandboxHandle("sbx-wedged", fake.events);
    fake.handlesByIds.set("sbx-wedged", handle);
    await mutateMeta((meta) => {
      meta.status = "snapshotting";
      meta.sandboxId = "sbx-wedged";
      meta.snapshotId = "snap-wedged";
      meta.lastError = "wedged";
      meta.portUrls = { "3000": "https://wedged.example.test" };
    });

    const reset = await resetSandbox(
      { origin: "https://app.example.test", reason: "regression-reset" },
      { deleteSnapshot: async () => undefined },
    );

    assert.equal(reset.status, "uninitialized");
    assert.equal(reset.sandboxId, null);
    assert.equal(reset.snapshotId, null);
    assert.equal(reset.portUrls, null);
    assert.equal(reset.lastError, null);
  });
});
