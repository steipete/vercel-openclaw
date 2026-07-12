import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { ApiError } from "@/shared/http";
import {
  createDefaultHotSpareState,
  FIREWALL_FAIL_CLOSED_LAST_ERROR,
  type SingleMeta,
} from "@/shared/types";
import { firewallFailClosedReason } from "@/server/firewall/fail-close";
import { setFirewallMode } from "@/server/firewall/state";
import {
  OPENCLAW_BUNDLE_IDENTITY_PATH,
  OPENCLAW_BUNDLE_SEALED_ARCHIVE_PATH,
} from "@/server/openclaw/bootstrap";
import {
  _resetBundleIdentityForTesting,
  _setBundleAdmissionForTesting,
  REQUIRED_OPENCLAW_BUNDLE_ASSETS,
  type VerifiedBundleAdmission,
} from "@/server/openclaw/bundle-identity";
import { readCronProjection } from "@/server/cron/projection";

import {
  ensureFreshGatewayToken,
  ensureUsableAiGatewayCredential,
  ensureSandboxRunning,
  ensureSandboxReady,
  waitForSandboxReady,
  ensureSandboxReadyForCron,
  ensureSandboxAliveThrough,
  ensureRunningSandboxDynamicConfigFresh,
  syncGatewayConfigToSandbox,
  getRunningSandboxTimeoutRemainingMs,
  isPreparedRestoreReusable,
  markRestoreTargetDirty,
  prepareRestoreTarget,
  probeGatewayReady,
  reconcileSandboxHealth,
  stopSandbox,
  snapshotSandbox,
  getSandboxDomain,
  touchRunningSandbox,
  markSandboxUnavailable,
  _resetReconcileStaleRunningDebounceForTesting,
  reconcileStaleRunningStatus,
  reconcileSnapshottingStatus,
  resetSandbox,
  SandboxLifecycleGuardRejectedError,
} from "@/server/sandbox/lifecycle";
import {
  _resetSandboxSleepConfigCacheForTesting,
} from "@/server/sandbox/timeout";
import {
  _setSandboxControllerForTesting,
} from "@/server/sandbox/controller";
import {
  _resetStoreForTesting,
  getInitializedMeta,
  getStore,
  mutateMeta,
} from "@/server/store/store";
import {
  hostSuspensionOperationKey,
  firewallPolicyApplyLockKey,
  lifecycleLockKey,
  sandboxDeadlineLockKey,
  sandboxDeadlineV2Key,
} from "@/server/store/keyspace";
import {
  HOST_STOP_REQUEST_MAX_MS,
  PLATFORM_STOP_CONFIRMED_REASON,
  readHostSuspensionState,
  type HostSuspensionState,
} from "@/server/sandbox/host-suspension";
import {
  _setHostStopWorkflowStarterForTesting,
} from "@/server/workflows/sandbox/host-stop-runtime";
import { _setAiGatewayTokenOverrideForTesting } from "@/server/env";
import { getServerLogs, _resetLogBuffer } from "@/server/log";
import {
  createOperationContext,
} from "@/server/observability/operation-context";
import {
  OPENCLAW_BIN,
  OPENCLAW_BUNDLE_PATH,
  OPENCLAW_CONFIG_PATH,
  OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
  OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH,
  OPENCLAW_GATEWAY_TOKEN_PATH,
  OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
  OPENCLAW_IMAGE_GEN_SKILL_PATH,
  OPENCLAW_IMAGE_GEN_SCRIPT_PATH,
  OPENCLAW_BUILTIN_IMAGE_GEN_SKILL_PATH,
  OPENCLAW_BUILTIN_IMAGE_GEN_SCRIPT_PATH,
  OPENCLAW_STARTUP_SCRIPT_PATH,
  OPENCLAW_TELEGRAM_WEBHOOK_PORT,
  computeGatewayConfigHash,
} from "@/server/openclaw/config";
import {
  FakeSandboxController,
  FakeSandboxHandle,
  type SandboxEvent,
} from "@/test-utils/fake-sandbox-controller";
import {
  withHarness,
} from "@/test-utils/harness";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENV_OVERRIDES: Record<string, string | undefined> = {
  NODE_ENV: "test",
  VERCEL: undefined,
  REDIS_URL: undefined,
  KV_URL: undefined,
  AI_GATEWAY_API_KEY: undefined,
  VERCEL_OIDC_TOKEN: undefined,
  NEXT_PUBLIC_APP_URL: undefined,
  NEXT_PUBLIC_BASE_DOMAIN: undefined,
  BASE_DOMAIN: undefined,
  VERCEL_PROJECT_PRODUCTION_URL: undefined,
  VERCEL_BRANCH_URL: undefined,
  VERCEL_URL: undefined,
  OPENCLAW_SANDBOX_SLEEP_AFTER_MS: undefined,
  OPENCLAW_PACKAGE_SPEC: undefined,
  OPENCLAW_BUNDLE_URL: undefined,
  OPENCLAW_BUNDLE_UI_URL: undefined,
  OPENCLAW_BUNDLE_MANIFEST_URL: undefined,
  OPENCLAW_BUNDLE_SOURCE_SHA: undefined,
  OPENCLAW_BUNDLE_SHA256: undefined,
  OPENCLAW_HOT_SPARE_ENABLED: undefined,
};

const FIREWALL_POLICY_REVISION = {
  revisionId: "firewall-revision-test",
  policyHash: "a".repeat(64),
};
const FIREWALL_FAIL_CLOSED_REASON = firewallFailClosedReason(
  FIREWALL_POLICY_REVISION,
);

async function withTestEnv(
  fake: FakeSandboxController,
  fn: () => Promise<void>,
): Promise<void> {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(ENV_OVERRIDES)) {
    originals[key] = process.env[key];
    if (ENV_OVERRIDES[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = ENV_OVERRIDES[key];
    }
  }

  _setSandboxControllerForTesting(fake);
  _resetSandboxSleepConfigCacheForTesting();
  _resetBundleIdentityForTesting();

  try {
    await fn();
  } finally {
    _setSandboxControllerForTesting(null);
    _resetStoreForTesting();
    _resetSandboxSleepConfigCacheForTesting();
    _resetBundleIdentityForTesting();
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
  }
}

const PRE_SNAPSHOT_CLEANUP_MARKERS = [
  "rm -rf /tmp/openclaw || true",
  "rm -rf /home/vercel-sandbox/.npm || true",
  "rm -rf /root/.npm || true",
  "rm -rf /tmp/openclaw-npm-cache || true",
];

function isPreSnapshotCleanupCommand(command: {
  cmd: string;
  args?: string[];
}): boolean {
  return (
    command.cmd === "bash"
    && command.args?.[0] === "-lc"
    && PRE_SNAPSHOT_CLEANUP_MARKERS.every((marker) =>
      command.args?.[1]?.includes(marker),
    )
  );
}

function findPreSnapshotCleanupCommand(handle: FakeSandboxHandle) {
  return handle.commands.find(isPreSnapshotCleanupCommand);
}

function hostSuspensionState(
  sandboxId: string,
  overrides: Partial<HostSuspensionState> = {},
): HostSuspensionState {
  const now = Date.now();
  return {
    version: 1,
    operationId: "operation-test",
    requestId: "operation-test",
    sandboxId,
    lifecycleAttemptId: null,
    intent: "stop",
    reason: "test-stop",
    phase: "stop-requesting",
    ingressFenced: true,
    suspensionId: `suspension-${sandboxId}`,
    leaseExpiresAtMs: now + 120_000,
    stopRequestDeadlineAtMs: now + 60_000,
    monitorHeartbeatAtMs: now,
    startedAtMs: now - 1_000,
    updatedAtMs: now,
    stoppedAtMs: null,
    resumedAtMs: null,
    lastError: null,
    lastErrorCode: null,
    lastErrorClass: null,
    ...overrides,
  };
}

function sandboxDeadlineState(
  sandboxId: string,
  lifecycleAttemptId: string | null = null,
) {
  const now = Date.now();
  return {
    version: 2 as const,
    revision: 1,
    generationId: `deadline-${sandboxId}`,
    lifecycleAttemptId,
    sandboxId,
    deadlineAtMs: now + 60_000,
    nativeStopDeadlineAtMs: null,
    desiredIdleMs: 60_000,
    platformTimeoutMs: 120_000,
    workflowRunId: null,
    workflowAttemptId: null,
    workflowStartLeaseExpiresAtMs: null,
    workflowStartedAtMs: null,
    workflowScheduledDeadlineAtMs: null,
    updatedAtMs: now,
    lastAttemptAtMs: null,
    lastOutcome: "armed" as const,
    lastErrorCode: null,
    lastErrorClass: null,
  };
}

function isPreSnapshotCleanupEvent(
  event: SandboxEvent,
  sandboxId: string,
): boolean {
  if (event.kind !== "command" || event.sandboxId !== sandboxId) {
    return false;
  }

  const detail = event.detail as { command?: string; args?: string[] } | undefined;
  return (
    detail?.command === "bash"
    && detail.args?.[0] === "-lc"
    && PRE_SNAPSHOT_CLEANUP_MARKERS.every((marker) =>
      detail.args?.[1]?.includes(marker),
    )
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("FakeSandboxController implements the SandboxController interface", async () => {
  const fake = new FakeSandboxController();
  const handle = await fake.create({ ports: [3000], timeout: 60_000 });

  assert.ok(handle.sandboxId.startsWith("sbx-fake-"));

  const cmdResult = await handle.runCommand("echo", ["hello"]);
  assert.equal(cmdResult.exitCode, 0);

  await handle.writeFiles([{ path: "test.txt", content: Buffer.from("hi") }]);
  assert.equal((handle as FakeSandboxHandle).writtenFiles.length, 1);

  const domain = handle.domain(3000);
  assert.ok(domain.includes("3000"));

  const snap = await handle.snapshot();
  assert.ok(snap.snapshotId.startsWith("snap-"));

  await handle.extendTimeout(5000);
  assert.deepEqual((handle as FakeSandboxHandle).extendedTimeouts, [5000]);

  const policy = await handle.updateNetworkPolicy("allow-all");
  assert.equal(policy, "allow-all");
});

test("stopSandbox transitions to snapshotting and preserves sandboxId", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    // Set up a "running" sandbox in meta
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-running-1";
      meta.portUrls = { "3000": "https://sbx-running-1-3000.fake.vercel.run" };
    });

    const result = await stopSandbox();

    // v2 non-blocking stop: API returns with status "snapshotting" while the
    // platform finishes the auto-save.  The reconciler flips it to
    // "stopped" on the next status read.
    assert.equal(result.status, "snapshotting");
    // sandboxId is preserved (persistent sandbox identity persists across stop/resume)
    assert.equal(result.sandboxId, "sbx-running-1");
    assert.equal(result.portUrls, null);

    // Verify the fake was called with blocking:false
    assert.equal(fake.retrieved.length, 1);
    assert.equal(fake.retrieved[0], "sbx-running-1");
    const handle = fake.getHandle("sbx-running-1");
    assert.ok(handle, "handle should exist");
    assert.equal(handle.stopCalled, true);
    assert.equal(handle.lastStopOptions?.blocking, false);
  });
});

test("stopSandbox preserves the released runtime path when suspend RPC is unavailable", async () => {
  const fake = new FakeSandboxController();
  const handle = new FakeSandboxHandle("sbx-legacy-stop", fake.events);
  handle.responders.push((cmd, args) => {
    if (
      cmd !== "node"
      || !args?.some((value) => value.includes("/api/v1/admin/rpc"))
    ) return undefined;
    const stdout = JSON.stringify({ status: 404, body: "Not Found" });
    return { exitCode: 0, output: async () => stdout };
  });
  fake.handlesByIds.set(handle.sandboxId, handle);

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = handle.sandboxId;
    });

    const result = await stopSandbox();

    assert.equal(result.status, "snapshotting");
    assert.equal(handle.stopCalled, true);
    assert.equal(
      await getStore().getValue(hostSuspensionOperationKey()),
      null,
      "the failed capability probe must not become a synthetic stopped fence",
    );
    handle.setStatus("running");
    const laggingStatus = await reconcileSnapshottingStatus();
    assert.equal(
      laggingStatus.status,
      "snapshotting",
      "an accepted legacy stop gets the same SDK-status propagation grace",
    );
  });
});

test("stopSandbox parks meta before the SDK stop resolves", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-stop-race";
      meta.portUrls = { "3000": "https://sbx-stop-race-3000.fake.vercel.run" };
    });

    const handle = new FakeSandboxHandle("sbx-stop-race", fake.events);
    fake.handlesByIds.set("sbx-stop-race", handle);

    let resolveStop!: () => void;
    const stopStarted = new Promise<void>((resolve) => {
      handle.stop = async (options?: { blocking?: boolean }) => {
        handle.stopCalled = true;
        handle.lastStopOptions = options;
        resolve();
        await new Promise<void>((innerResolve) => {
          resolveStop = innerResolve;
        });
        handle.setStatus("snapshotting");
      };
    });

    const stopPromise = stopSandbox();
    await stopStarted;

    const duringStop = await getInitializedMeta();
    assert.equal(
      duringStop.status,
      "snapshotting",
      "metadata must leave running before the SDK stop call can race heartbeats",
    );

    const callsBeforeHeartbeat = fake.getCalls.length;
    const heartbeatMeta = await touchRunningSandbox();
    assert.equal(heartbeatMeta.status, "snapshotting");
    assert.equal(
      fake.getCalls.length,
      callsBeforeHeartbeat,
      "heartbeat must not look up or resume a sandbox once stop has parked snapshotting",
    );

    resolveStop();
    const result = await stopPromise;
    assert.equal(result.status, "snapshotting");
    assert.equal(handle.lastStopOptions?.blocking, false);
  });
});

test("stopSandbox runs best-effort pre-snapshot cleanup commands with per-command fallback", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-cleanup-best-effort";
      meta.portUrls = { "3000": "https://sbx-cleanup-best-effort-3000.fake.vercel.run" };
      meta.firewall.mode = "enforcing";
    });

    await stopSandbox();

    const handle = fake.getHandle("sbx-cleanup-best-effort");
    assert.ok(handle, "sandbox handle should exist");
    const cleanupCommand = findPreSnapshotCleanupCommand(handle);

    assert.ok(cleanupCommand, "pre-snapshot cleanup command should run");
    assert.equal(
      cleanupCommand.args?.[1],
      [
        "rm -f /tmp/openclaw.log || true",
        "rm -rf /tmp/openclaw || true",
        "rm -rf /home/vercel-sandbox/.npm || true",
        "rm -rf /root/.npm || true",
        "rm -rf /tmp/openclaw-npm-cache || true",
        "rm -f /tmp/shell-commands-for-learning.log || true",
      ].join("\n"),
    );
    assert.ok(
      !cleanupCommand.args?.[1]?.includes("/home/vercel-sandbox/.npm/_logs"),
      "cleanup command should not redundantly remove nested npm log path",
    );
  });
});

test("stopSandbox runs pre-snapshot cleanup before stop", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    const runningMeta = await h.getMeta();
    const sandboxId = runningMeta.sandboxId;
    assert.ok(sandboxId, "sandboxId should be set after driveToRunning");

    await stopSandbox();

    const handle = h.controller.getHandle(sandboxId);
    assert.ok(handle, "sandbox handle should exist");

    const cleanupCommand = findPreSnapshotCleanupCommand(handle);

    assert.ok(cleanupCommand, "pre-snapshot cleanup command should run");
    // v2: persistent sandboxes auto-save on stop — stop() is called, not snapshot()
    assert.equal(handle.stopCalled, true, "stop should be called after cleanup");

    const cleanupEventIndex = h.controller.events.findIndex((event) =>
      isPreSnapshotCleanupEvent(event, sandboxId),
    );
    const stopEventIndex = h.controller.events.findIndex(
      (event) => event.kind === "stop" && event.sandboxId === sandboxId,
    );

    assert.ok(cleanupEventIndex >= 0, "cleanup command event should be recorded");
    assert.ok(stopEventIndex > cleanupEventIndex, "cleanup should run before stop");
  });
});

test("pre-snapshot cleanup preserves learning log in learning mode", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.firewall.mode = "learning";
    });
    await h.driveToRunning();

    const runningMeta = await h.getMeta();
    const sandboxId = runningMeta.sandboxId;
    assert.ok(sandboxId, "sandboxId should be set after driveToRunning");

    await stopSandbox();

    const handle = h.controller.getHandle(sandboxId);
    assert.ok(handle, "sandbox handle should exist");

    const cleanupCommand = findPreSnapshotCleanupCommand(handle);

    assert.ok(cleanupCommand, "pre-snapshot cleanup command should run");
    assert.ok(
      !cleanupCommand.args?.[1]?.includes("shell-commands-for-learning.log"),
      "learning log should be preserved in learning mode",
    );
  });
});

test("pre-snapshot cleanup removes learning log in enforcing mode", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.firewall.mode = "enforcing";
    });
    await h.driveToRunning();

    const runningMeta = await h.getMeta();
    const sandboxId = runningMeta.sandboxId;
    assert.ok(sandboxId, "sandboxId should be set after driveToRunning");

    await stopSandbox();

    const handle = h.controller.getHandle(sandboxId);
    assert.ok(handle, "sandbox handle should exist");

    const cleanupCommand = findPreSnapshotCleanupCommand(handle);

    assert.ok(cleanupCommand, "pre-snapshot cleanup command should run");
    assert.ok(
      cleanupCommand.args?.[1]?.includes("rm -f /tmp/shell-commands-for-learning.log || true"),
      "learning log should be removed in enforcing mode",
    );
  });
});

test("pre-snapshot cleanup failure does not prevent stop", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    const runningMeta = await h.getMeta();
    const sandboxId = runningMeta.sandboxId;
    assert.ok(sandboxId, "sandboxId should be set after driveToRunning");

    const handle = h.controller.getHandle(sandboxId);
    assert.ok(handle, "sandbox handle should exist");

    handle.responders.push((cmd, args) => {
      if (
        isPreSnapshotCleanupCommand({ cmd, args })
      ) {
        return { exitCode: 1, output: async () => "cleanup command failed" };
      }
      return undefined;
    });

    const result = await stopSandbox();

    assert.equal(result.status, "snapshotting");
    // v2: persistent sandboxes auto-save on stop — stop() is called, not snapshot()
    assert.equal(handle.stopCalled, true, "stop should still run after cleanup failure");
  });
});

test("stopSandbox logs warning and continues when pre-snapshot cleanup fails", async () => {
  const fake = new FakeSandboxController();
  const handle = new FakeSandboxHandle("sbx-cleanup-warning", fake.events);
  handle.responders.push((cmd, args) => {
    if (
      cmd === "bash"
      && args?.[0] === "-lc"
      && args?.[1]?.includes("rm -f /tmp/openclaw.log || true")
    ) {
      return { exitCode: 1, output: async () => "permission denied" };
    }
    return undefined;
  });
  fake.handlesByIds.set("sbx-cleanup-warning", handle);

  await withTestEnv(fake, async () => {
    _resetLogBuffer();

    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-cleanup-warning";
      meta.portUrls = { "3000": "https://sbx-cleanup-warning-3000.fake.vercel.run" };
      meta.firewall.mode = "learning";
    });

    const result = await stopSandbox();

    assert.equal(result.status, "snapshotting");
    // v2: persistent sandboxes auto-save on stop — snapshotId not set from snapshot()

    const warningLog = getServerLogs().find(
      (entry) =>
        entry.level === "warn"
        && entry.message === "openclaw.pre_snapshot_cleanup_failed"
        && entry.data?.sandboxId === "sbx-cleanup-warning",
    );

    assert.ok(warningLog, "cleanup failure should be logged as a warning");
    assert.match(String(warningLog.data?.error), /cleanup-before-snapshot/);
    assert.match(String(warningLog.data?.error), /permission denied/);
  });
});

test("snapshotSandbox delegates to stopSandbox", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-running-2";
      meta.portUrls = { "3000": "https://sbx-running-2-3000.fake.vercel.run" };
    });

    const result = await snapshotSandbox();

    assert.equal(result.status, "snapshotting");
    // v2: persistent sandboxes auto-save on stop — sandboxId is preserved
    assert.equal(result.sandboxId, "sbx-running-2");
  });
});

test("stopSandbox returns current meta if already stopped with snapshot", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = null;
      meta.snapshotId = "snap-existing";
    });

    const result = await stopSandbox();

    assert.equal(result.status, "stopped");
    assert.equal(result.snapshotId, "snap-existing");
    // Should not have called get since it short-circuited
    assert.equal(fake.retrieved.length, 0);
  });
});

test("reconcileSnapshottingStatus transitions to stopped when SDK reports stopped", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    // Pre-create the handle so get() finds it in the "stopped" state.
    const handle = (await fake.create({ ports: [3000], timeout: 300_000 })) as FakeSandboxHandle;
    handle.setStatus("stopped");

    await mutateMeta((meta) => {
      meta.status = "snapshotting";
      meta.sandboxId = handle.sandboxId;
      meta.lastAccessedAt = Date.now();
    });

    const reconciled = await reconcileSnapshottingStatus();
    assert.equal(reconciled.status, "stopped");
    assert.equal(reconciled.sandboxId, handle.sandboxId);
  });
});

test("reconcileSnapshottingStatus transitions to error when SDK reports failed", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const handle = (await fake.create({ ports: [3000], timeout: 300_000 })) as FakeSandboxHandle;
    handle.setStatus("failed");

    await mutateMeta((meta) => {
      meta.status = "snapshotting";
      meta.sandboxId = handle.sandboxId;
      meta.lastAccessedAt = Date.now();
    });

    const reconciled = await reconcileSnapshottingStatus();
    assert.equal(reconciled.status, "error");
    assert.match(String(reconciled.lastError), /snapshot failed/);
  });
});

test("reconcileSnapshottingStatus leaves meta unchanged while SDK still snapshotting", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const handle = (await fake.create({ ports: [3000], timeout: 300_000 })) as FakeSandboxHandle;
    handle.setStatus("snapshotting");

    await mutateMeta((meta) => {
      meta.status = "snapshotting";
      meta.sandboxId = handle.sandboxId;
      meta.lastAccessedAt = Date.now();
    });

    const reconciled = await reconcileSnapshottingStatus();
    assert.equal(reconciled.status, "snapshotting");
    assert.deepEqual(fake.getCalls.at(-1), {
      sandboxId: handle.sandboxId,
      resume: false,
    });
  });
});

test("reconcileSnapshottingStatus no-ops when status is not snapshotting", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-not-snapshotting";
    });

    const reconciled = await reconcileSnapshottingStatus();
    assert.equal(reconciled.status, "running");
    // get() must NOT have been called because meta wasn't snapshotting
    assert.equal(fake.retrieved.length, 0);
  });
});

test("ensureSandboxRunning returns waiting state during snapshotting", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const handle = (await fake.create({ ports: [3000], timeout: 300_000 })) as FakeSandboxHandle;
    // SDK still reports "snapshotting" so the reconciler won't advance it.
    handle.setStatus("snapshotting");

    await mutateMeta((meta) => {
      meta.status = "snapshotting";
      meta.sandboxId = handle.sandboxId;
      meta.lastAccessedAt = Date.now();
    });

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "test",
    });

    // Busy path: isBusyStatus("snapshotting") is true, so ensureSandboxRunning
    // returns waiting rather than attempting a resume mid-snapshot.
    assert.equal(result.state, "waiting");
    assert.equal(result.meta.status, "snapshotting");
  });
});

test("ensureSandboxRunning returns running state when already running", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-already-running";
    });

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "test",
    });

    assert.equal(result.state, "running");
    assert.equal(result.meta.status, "running");
    // No sandbox creation should have happened
    assert.equal(fake.created.length, 0);
  });
});

test("ensureSandboxRunning schedules create for uninitialized sandbox", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    let scheduledCallback: (() => Promise<void> | void) | null = null;

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "test",
      schedule(cb) {
        scheduledCallback = cb;
      },
    });

    assert.equal(result.state, "waiting");
    assert.ok(scheduledCallback, "Background work should have been scheduled");

    // Meta should now be "creating"
    const meta = await getInitializedMeta();
    assert.equal(meta.status, "creating");
  });
});

test("ensureSandboxRunning schedules restore when snapshot exists", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-to-restore";
    });

    let scheduledCallback: (() => Promise<void> | void) | null = null;

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "test",
      schedule(cb) {
        scheduledCallback = cb;
      },
    });

    assert.equal(result.state, "waiting");
    assert.ok(scheduledCallback, "Background work should have been scheduled");

    // Restore scheduling should immediately surface "restoring" for snapshot wake flows.
    const meta = await getInitializedMeta();
    assert.equal(meta.status, "restoring");
  });
});

test("missing persistent sandbox restores from the selected snapshot without blank fallback", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = null;
      meta.snapshotId = "snap-selected-history";
    });

    const scheduledCallbacks: Array<() => Promise<void> | void> = [];
    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "selected-history-restore-test",
      schedule(callback) {
        scheduledCallbacks.push(callback);
      },
    });
    assert.equal(scheduledCallbacks.length, 1);

    await scheduledCallbacks[0]!();

    assert.equal(fake.createCalls.length, 1);
    assert.deepEqual(fake.createCalls[0]?.source, {
      type: "snapshot",
      snapshotId: "snap-selected-history",
    });
    assert.equal((await getInitializedMeta()).snapshotId, "snap-selected-history");
  });
});

test("getSandboxDomain returns cached URL when available", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-domain-test";
      meta.portUrls = { "3000": "https://cached-domain.fake.vercel.run" };
    });

    const domain = await getSandboxDomain();
    assert.equal(domain, "https://cached-domain.fake.vercel.run");
    // Should not have called controller.get since URL was cached
    assert.equal(fake.retrieved.length, 0);
  });
});

test("getSandboxDomain fetches from controller when not cached", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-domain-test-2";
      meta.portUrls = null;
    });

    const domain = await getSandboxDomain();
    assert.ok(domain.includes("sbx-domain-test-2"));
    assert.equal(fake.retrieved.length, 1);
  });
});

test("touchRunningSandbox extends timeout on running sandbox", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-touch-test";
      meta.lastAccessedAt = null; // Ensure no throttle
    });

    const result = await touchRunningSandbox();
    assert.equal(result.status, "running");
    assert.ok(result.lastAccessedAt);
    assert.equal(fake.retrieved.length, 1);
  });
});

test("touchRunningSandbox is a no-op when not running", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = null;
    });

    const result = await touchRunningSandbox();
    assert.equal(result.status, "stopped");
    assert.equal(fake.retrieved.length, 0);
  });
});

test("touchRunningSandbox throttles when recently accessed", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-throttle-test";
      meta.lastAccessedAt = Date.now(); // Just now
    });

    const result = await touchRunningSandbox();
    assert.equal(result.status, "running");
    // Should have been throttled — no controller call
    assert.equal(fake.retrieved.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Stale-running recovery tests
// ---------------------------------------------------------------------------

test("ensureSandboxRunning re-schedules when status=creating and updatedAt is stale", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    // Set up a "creating" sandbox
    await mutateMeta((meta) => {
      meta.status = "creating";
      meta.sandboxId = null;
    });

    // Mock Date.now to make the operation appear stale (>5min old)
    const realNow = Date.now;
    const frozenNow = realNow.call(Date);
    Date.now = () => frozenNow + 6 * 60 * 1000; // 6 minutes in the future

    let scheduledCallback: (() => Promise<void> | void) | null = null;

    try {
      const result = await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "stale-creating-test",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      // Should still return "waiting" but should have re-scheduled work
      assert.equal(result.state, "waiting");
      assert.ok(scheduledCallback, "Background work should have been re-scheduled for stale creating");
    } finally {
      Date.now = realNow;
    }
  });
});

test("ensureSandboxRunning re-schedules when status=restoring and updatedAt is stale", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "restoring";
      meta.sandboxId = null;
      meta.snapshotId = "snap-stale-restore";
    });

    const realNow = Date.now;
    const frozenNow = realNow.call(Date);
    Date.now = () => frozenNow + 6 * 60 * 1000;

    let scheduledCallback: (() => Promise<void> | void) | null = null;

    try {
      const result = await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "stale-restoring-test",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      assert.equal(result.state, "waiting");
      assert.ok(scheduledCallback, "Background work should have been re-scheduled for stale restoring");
    } finally {
      Date.now = realNow;
    }
  });
});

test("ensureSandboxRunning does NOT re-schedule when status=creating and updatedAt is recent", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "creating";
      meta.sandboxId = null;
    });
    // updatedAt was just set by the mutation above — it's fresh

    let scheduledCallback: (() => Promise<void> | void) | null = null;

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "recent-creating-test",
      schedule(cb) {
        scheduledCallback = cb;
      },
    });

    assert.equal(result.state, "waiting");
    // Should NOT have re-scheduled since the operation is recent
    assert.equal(scheduledCallback, null, "Should not re-schedule when creating is recent");
  });
});

test("scheduled lifecycle work clears busy state when lifecycle lock is contended", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    let scheduledCallback: (() => Promise<void> | void) | null = null;

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "lifecycle-lock-contention-create",
      schedule(cb) {
        scheduledCallback = cb;
      },
    });

    assert.equal(result.state, "waiting");
    assert.ok(scheduledCallback, "Background work should have been scheduled");

    const lifecycleToken = await getStore().acquireLock(lifecycleLockKey(), 60);
    assert.ok(lifecycleToken, "Test should acquire the lifecycle lock");

    await (scheduledCallback as () => Promise<void>)();

    const meta = await getInitializedMeta();
    assert.equal(meta.status, "uninitialized");
    assert.equal(meta.lastError, "Lifecycle lock contention prevented sandbox startup.");
  });
});

// ---------------------------------------------------------------------------
// ensureSandboxReady timeout test
// ---------------------------------------------------------------------------

test("ensureSandboxReady times out with ApiError 504 when sandbox never reaches running", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "booting";
      meta.sandboxId = "sbx-never-ready";
      meta.portUrls = { "3000": "https://sbx-never-ready-3000.fake.vercel.run" };
      meta.gatewayToken = "test-token";
    });

    // Mock fetch to always return a non-ready response
    globalThis.fetch = async () =>
      new Response("<html>loading...</html>", { status: 200 });

    try {
      await assert.rejects(
        () =>
          ensureSandboxReady({
            origin: "https://test.example.com",
            reason: "timeout-test",
            timeoutMs: 200, // Very short timeout for testing
            pollIntervalMs: 50,
          }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok("status" in error);
          assert.equal((error as { status: number }).status, 504);
          assert.ok(error.message.includes("did not become ready"));
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// probeGatewayReady tests
// ---------------------------------------------------------------------------

test("probeGatewayReady returns ready=false when fetch throws (simulating gone sandbox)", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-gone";
      meta.portUrls = { "3000": "https://sbx-gone-3000.fake.vercel.run" };
      meta.gatewayToken = "test-token";
    });

    // Mock fetch to throw (simulating a sandbox that no longer exists)
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED: sandbox is gone");
    };

    try {
      const result = await probeGatewayReady();
      assert.equal(result.ready, false);
      assert.ok(result.error);
      assert.ok(result.error.includes("ECONNREFUSED"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("probeGatewayReady thaws admission and requires /readyz before reporting ready", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    const sandboxId = "sbx-admission-probe";
    const handle = new FakeSandboxHandle(sandboxId, fake.events);
    fake.handlesByIds.set(sandboxId, handle);
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = sandboxId;
      meta.portUrls = { "3000": `https://${sandboxId}.example` };
      meta.gatewayToken = "test-token";
    });
    await getStore().setValue(
      hostSuspensionOperationKey(),
      hostSuspensionState(sandboxId, {
        phase: "stopped",
        stopRequestDeadlineAtMs: null,
      }),
    );
    const requestedUrls: string[] = [];
    let forceAdmissionUnavailable = false;
    globalThis.fetch = async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.endsWith("/readyz")) {
        const suspension = await getStore().getValue<HostSuspensionState>(
          hostSuspensionOperationKey(),
        );
        const unavailable = forceAdmissionUnavailable
          || suspension?.ingressFenced === true;
        return Response.json(
          { ready: !unavailable },
          { status: unavailable ? 503 : 200 },
        );
      }
      return new Response('<div id="openclaw-app"></div>', { status: 200 });
    };

    try {
      const result = await probeGatewayReady();
      assert.equal(result.ready, true);
      assert.deepEqual(requestedUrls, [
        `https://${sandboxId}.example`,
        `https://${sandboxId}.example/readyz`,
      ]);
      const suspension = await getStore().getValue<HostSuspensionState>(
        hostSuspensionOperationKey(),
      );
      assert.equal(suspension?.phase, "running");
      assert.equal(suspension?.ingressFenced, false);

      forceAdmissionUnavailable = true;
      const blocked = await probeGatewayReady();
      assert.equal(blocked.ready, false);
      assert.equal(blocked.statusCode, 503);
      assert.match(blocked.error ?? "", /work admission is not ready/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("stale readiness probe cannot promote a replacement same-name generation", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    const sandboxId = "sbx-same-name";
    fake.handlesByIds.set(sandboxId, new FakeSandboxHandle(sandboxId, fake.events));
    await mutateMeta((meta) => {
      meta.status = "booting";
      meta.sandboxId = sandboxId;
      meta.lifecycleAttemptId = "attempt-old";
      meta.gatewayToken = "test-token";
      meta.portUrls = { "3000": `https://${sandboxId}.example` };
    });
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let signalFetch!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      signalFetch = resolve;
    });
    globalThis.fetch = async () => {
      signalFetch();
      await fetchGate;
      return new Response('<div id="openclaw-app"></div>', { status: 200 });
    };

    try {
      const staleProbe = probeGatewayReady();
      await fetchStarted;
      await mutateMeta((meta) => {
        meta.status = "booting";
        meta.sandboxId = sandboxId;
        meta.lifecycleAttemptId = "attempt-new";
      });
      releaseFetch();
      assert.equal((await staleProbe).ready, true);
      const replacement = await getInitializedMeta();
      assert.equal(replacement.status, "booting");
      assert.equal(replacement.lifecycleAttemptId, "attempt-new");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Restore-path file-write parity tests
// ---------------------------------------------------------------------------

/**
 * The sandbox name derived by the lifecycle from the default instance ID.
 * Used by triggerRestore to pre-register a "resumed" handle so get() succeeds.
 */
const LIFECYCLE_SANDBOX_NAME = "oc-openclaw-single";
const BUNDLE_CANDIDATE_TAG = "openclaw-bundle-candidate";
const BUNDLE_VERSION = "2026.7.2";
const BUNDLE_FORK_SHA = "1".repeat(40);
const BUNDLE_CANONICAL_SHA = "3".repeat(64);
const BUNDLE_RELEASE_URL =
  "https://github.com/vercel-labs/openclaw/releases/download/v2026.7.2";
const BUNDLE_ADMISSION: VerifiedBundleAdmission = {
  identity: {
    packageSpec: `openclaw@${BUNDLE_VERSION}`,
    version: BUNDLE_VERSION,
    forkSha: BUNDLE_FORK_SHA,
    upstreamSha: "2".repeat(40),
    canonicalSha256: BUNDLE_CANONICAL_SHA,
    capabilities: [
      "admin-http-rpc-v1",
      "cron-projection-v1",
      "gateway-suspend-v1",
      "telegram-durable-ack-v1",
    ],
    verified: true,
  },
  canonicalTarball: `openclaw-sandbox-bundle-v${BUNDLE_VERSION}-1111111.tar.gz`,
  canonicalTarballUrl:
    `${BUNDLE_RELEASE_URL}/openclaw-sandbox-bundle-v${BUNDLE_VERSION}-1111111.tar.gz`,
  assets: Object.fromEntries(
    [
      ...REQUIRED_OPENCLAW_BUNDLE_ASSETS,
      `openclaw-sandbox-bundle-v${BUNDLE_VERSION}-1111111.tar.gz`,
    ].map((name, index) => [
      name,
      {
        role: name,
        bytes: index + 1,
        sha256:
          name.startsWith("openclaw-sandbox-bundle-")
            ? BUNDLE_CANONICAL_SHA
            : index.toString(16).padStart(64, "0"),
      },
    ]),
  ),
  externalPlugins: [
    {
      id: "slack",
      packageName: "@openclaw/slack",
      version: BUNDLE_VERSION,
      spec: `@openclaw/slack@${BUNDLE_VERSION}`,
      artifact: "external-plugin-slack.tgz",
      integrity: "sha512-AAAA",
      shasum: "4".repeat(40),
      sha256: "5".repeat(64),
    },
  ],
};

function bundleCandidate(
  ownershipToken: string,
  overrides: Partial<NonNullable<SingleMeta["bundleCandidate"]>> = {},
): NonNullable<SingleMeta["bundleCandidate"]> {
  return {
    lookupId: LIFECYCLE_SANDBOX_NAME,
    sandboxId: LIFECYCLE_SANDBOX_NAME,
    ownershipToken,
    replacesOwnershipToken: null,
    lifecycleAttemptId: "interrupted-attempt",
    createdAt: Date.now() - 1_000,
    ...overrides,
  };
}

function tagBundleCandidate(
  handle: FakeSandboxHandle,
  ownershipToken: string,
): void {
  handle.tags = { [BUNDLE_CANDIDATE_TAG]: ownershipToken };
}

function configureBundleLifecycleTest(): void {
  process.env.OPENCLAW_PACKAGE_SPEC = `openclaw@${BUNDLE_VERSION}`;
  process.env.OPENCLAW_BUNDLE_URL = `${BUNDLE_RELEASE_URL}/openclaw.bundle.mjs`;
  process.env.OPENCLAW_BUNDLE_UI_URL = `${BUNDLE_RELEASE_URL}/control-ui.tar.gz`;
  process.env.OPENCLAW_BUNDLE_MANIFEST_URL =
    `${BUNDLE_RELEASE_URL}/asset-manifest.json`;
  process.env.OPENCLAW_BUNDLE_SOURCE_SHA = BUNDLE_FORK_SHA;
  process.env.OPENCLAW_BUNDLE_SHA256 = BUNDLE_CANONICAL_SHA;
  _setBundleAdmissionForTesting(BUNDLE_ADMISSION);
}

async function runScheduledEnsure(reason: string): Promise<void> {
  let scheduled: (() => Promise<void> | void) | null = null;
  await ensureSandboxRunning({
    origin: "https://test.example.com",
    reason,
    schedule(callback) {
      scheduled = callback;
    },
  });
  assert.ok(scheduled, `Expected scheduled lifecycle work for ${reason}`);
  await (scheduled as () => Promise<void> | void)();
}

/**
 * Pre-register a handle for the lifecycle's derived sandbox name.
 * The handle simulates a previously bootstrapped persistent sandbox
 * so the fast-restore resume path is taken (isResumed=true).
 */
function preRegisterResumeHandle(fake: FakeSandboxController): FakeSandboxHandle {
  const handle = new FakeSandboxHandle(LIFECYCLE_SANDBOX_NAME, fake.events);
  handle.responders.push(...fake.defaultResponders);
  if (fake.onWriteFiles) {
    handle.writeFilesHook = fake.onWriteFiles;
  }
  if (fake.onNetworkPolicy) {
    handle.networkPolicyHandler = fake.onNetworkPolicy;
  }
  // Simulate openclaw binary installed — makes isResumed=true in lifecycle
  handle.responders.push((cmd, args) => {
    if (
      cmd === "bash" &&
      args?.[0] === "-c" &&
      args[1]?.includes("command -v") &&
      args[1]?.includes(OPENCLAW_BIN)
    ) {
      return {
        exitCode: 0,
        output: async (stream?: "stdout" | "stderr" | "both") => {
          if (stream === "stdout") return "yes\n";
          if (stream === "stderr") return "";
          return "yes\n";
        },
      };
    }
    return undefined;
  });
  fake.handlesByIds.set(LIFECYCLE_SANDBOX_NAME, handle);
  return handle;
}

/**
 * Helper: exercises the persistent-resume restore path via
 * `ensureSandboxRunning` with a stopped+snapshotId meta, captures the
 * scheduled callback, and runs it.
 *
 * v2: Pre-registers a "resumed" handle so the lifecycle's get() call succeeds
 * and the fast-restore path is taken (matching real persistent sandbox behavior).
 */
async function triggerRestore(
  fake: FakeSandboxController,
  opts?: { tokenOverride?: string | undefined },
): Promise<{ handle: FakeSandboxHandle; meta: SingleMeta }> {
  _setAiGatewayTokenOverrideForTesting(opts?.tokenOverride ?? undefined);

  // Pre-register a "resumed" persistent sandbox handle so get() finds it.
  const resumeHandle = preRegisterResumeHandle(fake);

  try {
    let scheduledCallback: (() => Promise<void> | void) | null = null;

    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "restore-test",
      schedule(cb) {
        scheduledCallback = cb;
      },
    });

    assert.ok(scheduledCallback, "Background restore work should have been scheduled");
    await (scheduledCallback as () => Promise<void>)();

    const meta = await getInitializedMeta();
    // v2: lifecycle retrieves the pre-registered handle via get(),
    // takes the fast-restore resume path.
    const handle = meta.sandboxId ? (fake.getHandle(meta.sandboxId) ?? resumeHandle) : resumeHandle;
    assert.ok(handle, "A sandbox should have been created or resumed");
    return { handle, meta };
  } finally {
    _setAiGatewayTokenOverrideForTesting(null);
  }
}

test("persistent resume requests explicit SDK resume", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-explicit-resume";
      meta.gatewayToken = "test-gw-token";
    });

    const handle = preRegisterResumeHandle(fake);
    handle.setStatus("stopped");
    await getStore().setValue(
      hostSuspensionOperationKey(),
      hostSuspensionState(LIFECYCLE_SANDBOX_NAME, {
        phase: "stopped",
        stopRequestDeadlineAtMs: null,
        stoppedAtMs: Date.now(),
      }),
    );
    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      _setAiGatewayTokenOverrideForTesting("test-ai-key");
      await runScheduledEnsure("explicit-resume-proof");

      assert.deepEqual(fake.getCalls.slice(0, 2), [
        { sandboxId: LIFECYCLE_SANDBOX_NAME, resume: false },
        { sandboxId: LIFECYCLE_SANDBOX_NAME, resume: true },
      ]);
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

test("persistent resume backfills a fence without restoring an older snapshot", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-unfenced-resume";
      meta.gatewayToken = "test-gw-token";
    });
    const handle = preRegisterResumeHandle(fake);
    handle.setStatus("stopped");
    const originalGet = fake.get.bind(fake);
    fake.get = async (input) => {
      const result = await originalGet(input);
      if (input.resume === true) handle.setStatus("running");
      return result;
    };

    try {
      _setAiGatewayTokenOverrideForTesting("test-ai-key");
      await runScheduledEnsure("unfenced-resume");

      assert.deepEqual(fake.getCalls.slice(0, 2), [
        { sandboxId: LIFECYCLE_SANDBOX_NAME, resume: false },
        { sandboxId: LIFECYCLE_SANDBOX_NAME, resume: true },
      ]);
      assert.equal(handle.deleteCalled, false);
      assert.equal(fake.createCalls.length, 0);
      const meta = await getInitializedMeta();
      assert.equal(meta.status, "running");
      assert.equal(meta.snapshotId, "snap-unfenced-resume");
      assert.equal(await readHostSuspensionState(), null);
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("persistent resume backfills a fence without a snapshot source", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = null;
      meta.gatewayToken = "test-gw-token";
    });
    const handle = preRegisterResumeHandle(fake);
    handle.setStatus("stopped");
    const originalGet = fake.get.bind(fake);
    fake.get = async (input) => {
      const result = await originalGet(input);
      if (input.resume === true) handle.setStatus("running");
      return result;
    };

    try {
      _setAiGatewayTokenOverrideForTesting("test-ai-key");
      await runScheduledEnsure("unfenced-no-snapshot");

      assert.deepEqual(fake.getCalls.slice(0, 2), [
        { sandboxId: LIFECYCLE_SANDBOX_NAME, resume: false },
        { sandboxId: LIFECYCLE_SANDBOX_NAME, resume: true },
      ]);
      assert.equal(handle.deleteCalled, false);
      assert.equal(fake.createCalls.length, 0);
      const meta = await getInitializedMeta();
      assert.equal(meta.status, "running");
      assert.equal(meta.snapshotId, null);
      assert.equal(await readHostSuspensionState(), null);
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("ensureSandboxRunning retries the exact rollback-pending operation without fast restore", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const sandboxId = "sbx-rollback-recovery";
    const lifecycleAttemptId = "attempt-rollback-recovery";
    const handle = new FakeSandboxHandle(sandboxId, fake.events);
    fake.handlesByIds.set(sandboxId, handle);
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = sandboxId;
      meta.lifecycleAttemptId = lifecycleAttemptId;
      meta.lastError = "transient thaw failed";
    });
    await getStore().setValue(
      hostSuspensionOperationKey(),
      hostSuspensionState(sandboxId, {
        lifecycleAttemptId,
        phase: "rollback-pending",
        stopRequestDeadlineAtMs: null,
      }),
    );

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "rollback-recovery-test",
    });

    assert.equal(result.state, "running");
    assert.equal(result.meta.sandboxId, sandboxId);
    assert.equal(result.meta.lifecycleAttemptId, lifecycleAttemptId);
    assert.equal(result.meta.lastError, null);
    assert.deepEqual(fake.getCalls.at(-1), { sandboxId, resume: false });
    assert.equal(
      handle.commands.some(
        (command) => command.args?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
      ),
      false,
    );
    const suspension = await readHostSuspensionState();
    assert.equal(suspension?.phase, "running");
    assert.equal(suspension?.ingressFenced, false);
  });
});

test("reconcileSnapshottingStatus completes an exact interrupted thaw from error metadata", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const sandboxId = "sbx-thaw-crash-recovery";
    const lifecycleAttemptId = "attempt-thaw-crash-recovery";
    const handle = new FakeSandboxHandle(sandboxId, fake.events);
    fake.handlesByIds.set(sandboxId, handle);
    await mutateMeta((meta) => {
      meta.status = "error";
      meta.sandboxId = sandboxId;
      meta.lifecycleAttemptId = lifecycleAttemptId;
      meta.lastError = "worker exited after persisting thawing";
    });
    await getStore().setValue(
      hostSuspensionOperationKey(),
      hostSuspensionState(sandboxId, {
        lifecycleAttemptId,
        phase: "thawing",
        suspensionId: null,
        stopRequestDeadlineAtMs: null,
      }),
    );

    const result = await reconcileSnapshottingStatus();
    const suspension = await readHostSuspensionState();

    assert.equal(result.status, "running");
    assert.equal(result.sandboxId, sandboxId);
    assert.equal(result.lifecycleAttemptId, lifecycleAttemptId);
    assert.equal(result.lastError, null);
    assert.equal(suspension?.phase, "running");
    assert.equal(suspension?.ingressFenced, false);
  });
});

test("snapshotting rollback recovery settles persistent stop metadata before returning to running", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const sandboxId = "sbx-snapshotting-rollback-recovery";
    const lifecycleAttemptId = "attempt-snapshotting-rollback-recovery";
    const operationId = "operation-snapshotting-rollback-recovery";
    const handle = new FakeSandboxHandle(sandboxId, fake.events);
    handle.setStatus("running");
    fake.handlesByIds.set(sandboxId, handle);
    await mutateMeta((meta) => {
      meta.status = "snapshotting";
      meta.sandboxId = sandboxId;
      meta.lifecycleAttemptId = lifecycleAttemptId;
      meta.activePersistentStop = {
        stopAttemptId: "stop-snapshotting-rollback-recovery",
        sandboxId,
        lifecycleAttemptId,
        operationId,
        reason: "sandbox.stop",
        startedAt: Date.now() - 60_000,
      };
      meta.pendingPersistentAutoSave = {
        sandboxId,
        lifecycleAttemptId,
        operationId,
        dynamicConfigHash: "config-snapshotting-rollback-recovery",
        assetSha256: "assets-snapshotting-rollback-recovery",
        createdAt: Date.now() - 60_000,
      };
    });
    await getStore().setValue(
      hostSuspensionOperationKey(),
      hostSuspensionState(sandboxId, {
        lifecycleAttemptId,
        operationId,
        requestId: operationId,
        phase: "rollback-pending",
        stopRequestDeadlineAtMs: null,
        updatedAtMs: Date.now() - 60_000,
      }),
    );

    const result = await reconcileSnapshottingStatus();

    assert.equal(result.status, "running");
    assert.equal(result.activePersistentStop, null);
    assert.equal(result.pendingPersistentAutoSave, null);
    assert.match(result.lastError ?? "", /Gateway admission resumed/);
    const suspension = await readHostSuspensionState();
    assert.equal(suspension?.phase, "failed");
    assert.equal(suspension?.ingressFenced, false);
  });
});

test("rollback-pending recovery retires a deleted generation before scheduling replacement", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const sandboxId = "sbx-rollback-deleted";
    const lifecycleAttemptId = "attempt-rollback-deleted";
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = sandboxId;
      meta.lifecycleAttemptId = lifecycleAttemptId;
      meta.lastError = "transient thaw failed";
    });
    await getStore().setValue(
      hostSuspensionOperationKey(),
      hostSuspensionState(sandboxId, {
        lifecycleAttemptId,
        phase: "rollback-pending",
        stopRequestDeadlineAtMs: null,
      }),
    );
    let lookup: { sandboxId: string; resume?: boolean } | undefined;
    fake.get = async (input) => {
      lookup = input;
      throw new Error("404 sandbox not found");
    };
    let scheduled = false;

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "rollback-deleted-test",
      schedule() {
        scheduled = true;
      },
    });

    assert.deepEqual(lookup, { sandboxId, resume: false });
    assert.equal(result.state, "waiting");
    assert.equal(result.meta.status, "creating");
    assert.equal(result.meta.sandboxId, null);
    assert.equal(scheduled, true);
    assert.equal(await getStore().getValue(hostSuspensionOperationKey()), null);
  });
});

test("suspended persistent resume retires the durable lease before starting a replacement Gateway", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-suspended-resume";
      meta.gatewayToken = "test-gw-token";
    });
    await getStore().setValue(
      hostSuspensionOperationKey(),
      hostSuspensionState(LIFECYCLE_SANDBOX_NAME, {
        phase: "stopped",
        stopRequestDeadlineAtMs: null,
        stoppedAtMs: Date.now(),
      }),
    );
    const handle = preRegisterResumeHandle(fake);
    const originalRunCommand = handle.runCommand.bind(handle);
    handle.runCommand = async (commandOrOpts, args, opts) => {
      const commandArgs = typeof commandOrOpts === "string"
        ? args
        : commandOrOpts.args;
      if (
        (typeof commandOrOpts === "string" ? commandOrOpts : commandOrOpts.cmd) === "bash"
        && commandArgs?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH
        && commandArgs[2] === "start"
      ) {
        assert.equal(
          await getStore().getValue(hostSuspensionOperationKey()),
          null,
          "the old process lease must be durably retired before replacement start",
        );
      }
      return originalRunCommand(commandOrOpts as never, args, opts);
    };
    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      _setAiGatewayTokenOverrideForTesting("test-ai-key");
      await runScheduledEnsure("suspended-resume-ordering");
      const phases = handle.commands
        .filter((command) => command.args?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH)
        .map((command) => command.args?.[2]);
      assert.deepEqual(phases, ["kill", "start"]);
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

test("persistent resume does not launch Gateway after lifecycle lease loss during kill", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-resume-lease-loss";
      meta.gatewayToken = "test-gw-token";
    });
    const handle = preRegisterResumeHandle(fake);
    const store = getStore();
    const renewLock = store.renewLock.bind(store);
    let loseLifecycleLease = false;
    store.renewLock = async (key, token, ttlSeconds) =>
      key === lifecycleLockKey() && loseLifecycleLease
        ? false
        : renewLock(key, token, ttlSeconds);
    const originalRunCommand = handle.runCommand.bind(handle);
    handle.runCommand = async (commandOrOpts, args, opts) => {
      const commandArgs = typeof commandOrOpts === "string"
        ? args
        : commandOrOpts.args;
      const result = await originalRunCommand(commandOrOpts as never, args, opts);
      if (
        (typeof commandOrOpts === "string" ? commandOrOpts : commandOrOpts.cmd) === "bash"
        && commandArgs?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH
        && commandArgs[2] === "kill"
      ) {
        loseLifecycleLease = true;
      }
      return result;
    };
    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      _setAiGatewayTokenOverrideForTesting("test-ai-key");
      await runScheduledEnsure("resume-lease-loss-after-kill");
      const phases = handle.commands
        .filter((command) => command.args?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH)
        .map((command) => command.args?.[2]);
      assert.deepEqual(phases, ["kill"]);
    } finally {
      store.renewLock = renewLock;
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

test("persistent resume does not kill Gateway after lifecycle lease loss during suspension read", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-resume-read-lease-loss";
      meta.gatewayToken = "test-gw-token";
    });
    const handle = preRegisterResumeHandle(fake);
    const store = getStore();
    const renewLock = store.renewLock.bind(store);
    const getValue = store.getValue.bind(store);
    const originalRunCommand = handle.runCommand.bind(handle);
    let loseLifecycleLease = false;
    let armSuspensionRead = false;

    store.renewLock = async (key, token, ttlSeconds) =>
      key === lifecycleLockKey() && loseLifecycleLease
        ? false
        : renewLock(key, token, ttlSeconds);
    store.getValue = async <T>(key: string): Promise<T | null> => {
      const value = await getValue<T>(key);
      if (key === hostSuspensionOperationKey() && armSuspensionRead) {
        armSuspensionRead = false;
        loseLifecycleLease = true;
      }
      return value;
    };
    handle.runCommand = async (commandOrOpts, args, opts) => {
      const commandArgs = typeof commandOrOpts === "string"
        ? args
        : commandOrOpts.args;
      const result = await originalRunCommand(commandOrOpts as never, args, opts);
      if (
        (typeof commandOrOpts === "string" ? commandOrOpts : commandOrOpts.cmd)
          === "bash"
        && commandArgs?.[0] === "-c"
        && commandArgs[1]?.includes("gateway_lock.cleared_stale")
      ) {
        armSuspensionRead = true;
      }
      return result;
    };
    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      _setAiGatewayTokenOverrideForTesting("test-ai-key");
      await runScheduledEnsure("resume-lease-loss-during-suspension-read");
      const phases = handle.commands
        .filter((command) => command.args?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH)
        .map((command) => command.args?.[2]);
      assert.deepEqual(phases, []);
    } finally {
      store.renewLock = renewLock;
      store.getValue = getValue;
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

test("persistent resume never starts a replacement Gateway when the lease CAS fails after kill", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-suspended-cas-failure";
      meta.gatewayToken = "test-gw-token";
    });
    await getStore().setValue(
      hostSuspensionOperationKey(),
      hostSuspensionState(LIFECYCLE_SANDBOX_NAME, {
        phase: "stopped",
        stopRequestDeadlineAtMs: null,
        stoppedAtMs: Date.now(),
      }),
    );
    const handle = preRegisterResumeHandle(fake);
    const originalRunCommand = handle.runCommand.bind(handle);
    handle.runCommand = async (commandOrOpts, args, opts) => {
      const commandArgs = typeof commandOrOpts === "string"
        ? args
        : commandOrOpts.args;
      const result = await originalRunCommand(commandOrOpts as never, args, opts);
      if (
        (typeof commandOrOpts === "string" ? commandOrOpts : commandOrOpts.cmd) === "bash"
        && commandArgs?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH
        && commandArgs[2] === "kill"
      ) {
        await getStore().setValue(
          hostSuspensionOperationKey(),
          hostSuspensionState(LIFECYCLE_SANDBOX_NAME, {
            operationId: "replacement-operation",
            requestId: "replacement-operation",
            phase: "stopped",
            stopRequestDeadlineAtMs: null,
            stoppedAtMs: Date.now(),
          }),
        );
      }
      return result;
    };
    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      _setAiGatewayTokenOverrideForTesting("test-ai-key");
      await runScheduledEnsure("suspended-resume-cas-failure");
      const phases = handle.commands
        .filter((command) => command.args?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH)
        .map((command) => command.args?.[2]);
      assert.deepEqual(phases, ["kill"]);
      assert.equal((await getInitializedMeta()).status, "setup");
      assert.equal(
        (await readHostSuspensionState())?.operationId,
        "replacement-operation",
      );
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

test("guarded cron readiness preserves a stopped snapshot restore", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    const handle = preRegisterResumeHandle(fake);
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-cron-restore";
      meta.snapshotConfigHash = "snapshot-config";
      meta.gatewayToken = "gw-cron";
    });
    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });
    _setAiGatewayTokenOverrideForTesting("test-ai-key");

    try {
      const result = await ensureSandboxReadyForCron({
        origin: "https://test.example.com",
        reason: "cron-snapshot-restore-test",
        aliveThroughMs: Date.now() + 60_000,
        lifecycleGuard: async () => true,
      });

      assert.equal(result.meta.status, "running");
      assert.equal(result.meta.snapshotId, "snap-cron-restore");
      assert.equal(result.meta.snapshotConfigHash, "snapshot-config");
      assert.ok(
        handle.commands.some(
          (command) =>
            command.cmd === "bash" &&
            command.args?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
        ),
        "guarded readiness should use the restore path",
      );
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

test("restoreSandboxFromSnapshot writes all files + manifest on first restore (no existing manifest)", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-restore-files";
      meta.gatewayToken = "test-gw-token";
    });

    // Mock fetch for probeGatewayReady at end of restore
    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { handle } = await triggerRestore(fake, {
        tokenOverride: "test-ai-key",
      });

      const writtenPaths = handle.writtenFiles.map((f) => f.path);
      assert.ok(writtenPaths.includes(OPENCLAW_CONFIG_PATH), "Should write config");
      assert.ok(writtenPaths.includes(OPENCLAW_FORCE_PAIR_SCRIPT_PATH), "Should write force-pair script");
      assert.ok(writtenPaths.includes(OPENCLAW_STARTUP_SCRIPT_PATH), "Should write startup script");
      assert.ok(writtenPaths.includes(OPENCLAW_FAST_RESTORE_SCRIPT_PATH), "Should write fast-restore script");
      assert.ok(writtenPaths.includes(OPENCLAW_IMAGE_GEN_SKILL_PATH), "Should write image-gen skill");
      assert.ok(writtenPaths.includes(OPENCLAW_IMAGE_GEN_SCRIPT_PATH), "Should write image-gen script");
      assert.ok(writtenPaths.includes(OPENCLAW_BUILTIN_IMAGE_GEN_SKILL_PATH), "Should write builtin image-gen skill");
      assert.ok(writtenPaths.includes(OPENCLAW_BUILTIN_IMAGE_GEN_SCRIPT_PATH), "Should write builtin image-gen script");
      // Config + credentials are passed via env (no hot-path writeFiles).
      // Static assets are synced in background.  Verify the background
      // sync wrote the expected files.
      assert.ok(handle.writtenFiles.length > 0, "Background asset sync should write files");

      // Verify manifest was written
      const manifestPath = writtenPaths.find((p) => p.includes(".restore-assets-manifest.json"));
      assert.ok(manifestPath, "Should write restore-assets manifest");

      // v2: resume path records restore metrics but without the old restore-specific
      // dynamicConfigReason/dynamicConfigHash fields.
      const meta = await getInitializedMeta();
      assert.ok(meta.lastRestoreMetrics, "Should have restore metrics");
      assert.ok(meta.lastRestoreMetrics.totalMs >= 0, "Should have totalMs");
      assert.ok(meta.lastRestoreMetrics.recordedAt > 0, "Should have recordedAt");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("persistent resume skips static files when manifest hash matches on disk", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-restore-first";
      meta.gatewayToken = "test-gw-token";
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      // First resume — writes all files (no manifest on disk)
      const { handle: firstHandle } = await triggerRestore(fake, {
        tokenOverride: "test-ai-key",
      });
      assert.ok(firstHandle.writtenFiles.length > 0, "First resume should write files");

      // Find the manifest file that was written
      const manifestFile = firstHandle.writtenFiles.find((f) =>
        f.path.includes(".restore-assets-manifest.json"),
      );
      assert.ok(manifestFile, "Manifest should exist from first resume");

      // Now test the skip path: create a new controller with a pre-registered
      // handle that already has the manifest on disk (simulating persistent sandbox).
      const seededFake = new FakeSandboxController();
      _setSandboxControllerForTesting(seededFake);

      // Pre-register a resume handle with the manifest already on disk
      const seededHandle = preRegisterResumeHandle(seededFake);
      seededHandle.writtenFiles.push(manifestFile);

      await mutateMeta((meta) => {
        meta.status = "stopped";
        meta.sandboxId = null;
        meta.portUrls = null;
      });

      _setAiGatewayTokenOverrideForTesting("test-ai-key");

      let scheduledCallback: (() => Promise<void> | void) | null = null;
      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "restore-test",
        schedule(cb) { scheduledCallback = cb; },
      });

      assert.ok(scheduledCallback);
      await (scheduledCallback as () => Promise<void>)();

      _setAiGatewayTokenOverrideForTesting(null);

      // With matching manifest, syncRestoreAssetsIfNeeded skips static files.
      // Count only writes that happened AFTER the pre-seeded manifest.
      const writesAfterSeed = seededHandle.writtenFiles.slice(1); // skip pre-seeded manifest
      const staticWrites = writesAfterSeed.filter((f) =>
        f.path.includes(".restore-assets-manifest.json"),
      );
      assert.equal(staticWrites.length, 0, "Should not re-write manifest when hash matches");

      // Credentials should not be in writtenFiles (passed via env)
      const credentialWrites = seededHandle.writtenFiles.filter(
        (f) => f.path === OPENCLAW_GATEWAY_TOKEN_PATH || f.path.endsWith(".ai-gateway-api-key"),
      );
      assert.equal(credentialWrites.length, 0, "Credentials should not be in writtenFiles");
    } finally {
      globalThis.fetch = originalFetch;
      _setSandboxControllerForTesting(null);
    }
  });
});

test("restoreSandboxFromSnapshot resume always syncs config via asset sync", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-hash-match";
      meta.gatewayToken = "test-gw-token";
      meta.snapshotDynamicConfigHash = computeGatewayConfigHash({});
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { handle } = await triggerRestore(fake, { tokenOverride: "test-ai-key" });

      // v2: resume path always syncs config via syncRestoreAssetsIfNeeded.
      const configWrites = handle.writtenFiles.filter((f) => f.path === OPENCLAW_CONFIG_PATH);
      assert.ok(configWrites.length >= 1, "Should write config at least once");

      const meta = await getInitializedMeta();
      assert.ok(meta.lastRestoreMetrics, "Should have restore metrics");
      assert.ok(meta.lastRestoreMetrics.totalMs >= 0, "Should have totalMs");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("restoreSandboxFromSnapshot resume syncs config regardless of stale snapshot hash", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-hash-miss";
      meta.gatewayToken = "test-gw-token";
      meta.snapshotDynamicConfigHash = "stale-hash-from-previous-snapshot";
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { handle } = await triggerRestore(fake, { tokenOverride: "test-ai-key" });

      // v2: resume path always syncs config via syncRestoreAssetsIfNeeded.
      const configWrites = handle.writtenFiles.filter((f) => f.path === OPENCLAW_CONFIG_PATH);
      assert.ok(configWrites.length >= 1, "Should write config at least once");

      const meta = await getInitializedMeta();
      assert.ok(meta.lastRestoreMetrics, "Should have restore metrics");
      assert.ok(meta.lastRestoreMetrics.totalMs >= 0, "Should have totalMs");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("persistent bundle resume without snapshotId takes fast-restore path", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    configureBundleLifecycleTest();
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = null;
      meta.sandboxId = LIFECYCLE_SANDBOX_NAME;
      meta.gatewayToken = "test-gw-token";
      meta.bundleIdentity = structuredClone(BUNDLE_ADMISSION.identity);
    });

    const handle = new FakeSandboxHandle(LIFECYCLE_SANDBOX_NAME, fake.events);
    handle.setStatus("stopped");
    handle.responders.push(...fake.defaultResponders);
    handle.responders.push((cmd, args) => {
      if (
        cmd === "bash" &&
        args?.[0] === "-c" &&
        args[1]?.includes(OPENCLAW_BUNDLE_IDENTITY_PATH)
      ) {
        return {
          exitCode: 0,
          output: async (stream?: "stdout" | "stderr" | "both") => {
            if (stream === "stderr") return "";
            return `${JSON.stringify(BUNDLE_ADMISSION.identity)}\n`;
          },
        };
      }
      return undefined;
    });
    fake.handlesByIds.set(LIFECYCLE_SANDBOX_NAME, handle);
    await getStore().setValue(
      hostSuspensionOperationKey(),
      hostSuspensionState(LIFECYCLE_SANDBOX_NAME, {
        phase: "stopped",
        stopRequestDeadlineAtMs: null,
        stoppedAtMs: Date.now(),
      }),
    );
    const originalGet = fake.get.bind(fake);
    fake.get = async (params) => {
      const found = await originalGet(params);
      if (params.resume === true) handle.setStatus("running");
      return found;
    };

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      _setAiGatewayTokenOverrideForTesting("test-ai-key");
      let scheduledCallback: (() => Promise<void> | void) | null = null;

      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "bundle-resume-test",
        schedule(cb) { scheduledCallback = cb; },
      });

      assert.ok(scheduledCallback, "Background resume work should have been scheduled");
      await (scheduledCallback as () => Promise<void>)();

      const fastRestoreCommand = handle.commands.find(
        (c) => c.cmd === "bash" && c.args?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
      );
      assert.ok(fastRestoreCommand, "bundle runtime marker should route to fast restore");
      const verificationIndex = handle.commands.findIndex(
        (command) =>
          command.cmd === "bash"
          && command.args?.[0] === "-c"
          && command.args[1]?.includes(OPENCLAW_BUNDLE_SEALED_ARCHIVE_PATH),
      );
      const fastRestoreIndex = handle.commands.indexOf(fastRestoreCommand);
      assert.ok(verificationIndex >= 0, "resume must verify persisted bundle bytes");
      assert.ok(
        fastRestoreIndex > verificationIndex,
        "persisted bundle verification must finish before fast restore launches Gateway",
      );
      assert.deepEqual(
        fake.getCalls.slice(0, 2).map((call) => call.resume),
        [false, true],
        "bundle discovery must observe before explicitly resuming an admitted identity",
      );

      const fullBootstrapCommand = handle.commands.find(
        (c) =>
          c.cmd === "bash"
          && c.args?.[1]?.includes("/tmp/openclaw-bundle-assets"),
      );
      assert.equal(
        fullBootstrapCommand,
        undefined,
        "resume must not run the full bundle installation path",
      );

      const meta = await getInitializedMeta();
      assert.equal(meta.status, "running");
      assert.ok(meta.lastRestoreMetrics, "fast restore metrics should be recorded");
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

test("persistent bundle corruption fails before fast restore launches Gateway", async () => {
  const fake = new FakeSandboxController();

  await withTestEnv(fake, async () => {
    configureBundleLifecycleTest();
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = LIFECYCLE_SANDBOX_NAME;
      meta.gatewayToken = "test-gw-token";
      meta.bundleIdentity = structuredClone(BUNDLE_ADMISSION.identity);
    });

    const handle = new FakeSandboxHandle(LIFECYCLE_SANDBOX_NAME, fake.events);
    handle.setStatus("stopped");
    handle.responders.push(...fake.defaultResponders);
    handle.responders.push((cmd, args) => {
      if (
        cmd === "bash"
        && args?.[0] === "-c"
        && args[1]?.includes(OPENCLAW_BUNDLE_IDENTITY_PATH)
      ) {
        return {
          exitCode: 0,
          output: async (stream?: "stdout" | "stderr" | "both") =>
            stream === "stderr"
              ? ""
              : `${JSON.stringify(BUNDLE_ADMISSION.identity)}\n`,
        };
      }
      if (
        cmd === "bash"
        && args?.[0] === "-c"
        && args[1]?.includes(OPENCLAW_BUNDLE_SEALED_ARCHIVE_PATH)
      ) {
        return {
          exitCode: 1,
          output: async () =>
            "verified bundle runtime tree mismatch: external-plugin:slack",
        };
      }
      return undefined;
    });
    fake.handlesByIds.set(LIFECYCLE_SANDBOX_NAME, handle);
    await getStore().setValue(
      hostSuspensionOperationKey(),
      hostSuspensionState(LIFECYCLE_SANDBOX_NAME, {
        phase: "stopped",
        stopRequestDeadlineAtMs: null,
        stoppedAtMs: Date.now(),
      }),
    );
    const originalGet = fake.get.bind(fake);
    fake.get = async (params) => {
      const found = await originalGet(params);
      if (params.resume === true) handle.setStatus("running");
      return found;
    };

    _setAiGatewayTokenOverrideForTesting("test-ai-key");
    try {
      await runScheduledEnsure("bundle-corruption-no-launch");
      assert.match(
        (await getInitializedMeta()).lastError ?? "",
        /verify persisted bundle runtime/,
      );
      assert.equal(
        handle.commands.some(
          (command) =>
            command.cmd === "bash"
            && command.args?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
        ),
        false,
        "corrupt persisted bytes must never reach Gateway launch",
      );
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("bundle identity drift never wakes a stopped persistent sandbox", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    configureBundleLifecycleTest();
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = LIFECYCLE_SANDBOX_NAME;
      meta.bundleIdentity = {
        ...structuredClone(BUNDLE_ADMISSION.identity),
        canonicalSha256: "9".repeat(64),
      };
    });
    const stale = new FakeSandboxHandle(LIFECYCLE_SANDBOX_NAME, fake.events);
    stale.setStatus("stopped");
    fake.handlesByIds.set(LIFECYCLE_SANDBOX_NAME, stale);

    _setAiGatewayTokenOverrideForTesting("test-ai-key");
    try {
      await runScheduledEnsure("bundle-drift-no-wake");
      const meta = await getInitializedMeta();
      assert.equal(meta.status, "error");
      assert.match(meta.lastError ?? "", /^OPENCLAW_BUNDLE_MIGRATION_REQUIRED:/);
      assert.ok(fake.getCalls.length > 0);
      assert.equal(
        fake.getCalls.every((call) => call.resume === false),
        true,
      );
      assert.equal(stale.commands.length, 0);
      assert.equal(stale.stopCalled, false);
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("invalid desired bundle admission never quiesces a healthy running sandbox", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();
    const before = await h.getMeta();
    const handle = h.controller.getHandle(before.sandboxId!);
    assert.ok(handle);
    const commandCount = handle.commands.length;
    process.env.OPENCLAW_BUNDLE_URL = `${BUNDLE_RELEASE_URL}/openclaw.bundle.mjs`;

    await assert.rejects(
      ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "invalid-bundle-admission",
      }),
      (error: unknown) =>
        error instanceof ApiError
        && error.code === "OPENCLAW_BUNDLE_ADMISSION_FAILED",
    );

    assert.equal(handle.stopCalled, false);
    assert.equal(handle.commands.length, commandCount);
    assert.equal((await h.getMeta()).status, "running");
  });
});

test("admitted bundle drift fences a running npm sandbox before reuse", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();
    const before = await h.getMeta();
    const handle = h.controller.getHandle(before.sandboxId!);
    assert.ok(handle);
    configureBundleLifecycleTest();

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "running-mode-drift",
    });

    assert.equal(result.state, "waiting");
    assert.equal(handle.stopCalled, true);
    assert.equal(result.meta.status, "error");
    assert.match(result.meta.lastError ?? "", /^OPENCLAW_BUNDLE_MIGRATION_REQUIRED:/);
  });
});

test("removing bundle mode fences the running bundle generation", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();
    const before = await h.getMeta();
    const handle = h.controller.getHandle(before.sandboxId!);
    assert.ok(handle);
    await h.mutateMeta((meta) => {
      meta.bundleIdentity = structuredClone(BUNDLE_ADMISSION.identity);
    });

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "bundle-mode-removed",
    });

    assert.equal(result.state, "waiting");
    assert.equal(handle.stopCalled, true);
    assert.match(result.meta.lastError ?? "", /^OPENCLAW_BUNDLE_MIGRATION_REQUIRED:/);
  });
});

test("bundle lifecycle never promotes the alternate-name hot-spare prototype", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    configureBundleLifecycleTest();
    process.env.OPENCLAW_HOT_SPARE_ENABLED = "true";
    const hotSpareId = "oc-spare-openclaw-single";
    await mutateMeta((meta) => {
      meta.hotSpare = {
        ...createDefaultHotSpareState(),
        status: "ready",
        candidateSandboxId: hotSpareId,
        createdAt: Date.now(),
        preparedAt: Date.now(),
        updatedAt: Date.now(),
      };
    });
    fake.handlesByIds.set(
      hotSpareId,
      new FakeSandboxHandle(hotSpareId, fake.events),
    );
    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      _setAiGatewayTokenOverrideForTesting("test-ai-key");
      await runScheduledEnsure("bundle-hot-spare-disabled");
      assert.equal(fake.retrieved.includes(hotSpareId), false);
      assert.equal((await getInitializedMeta()).status, "running");
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

test("persistent bundle identity mismatch quiesces and requires explicit migration", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    configureBundleLifecycleTest();
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = null;
      meta.sandboxId = LIFECYCLE_SANDBOX_NAME;
      meta.gatewayToken = "gw-test";
      meta.bundleIdentity = structuredClone(BUNDLE_ADMISSION.identity);
    });
    const staleHandle = new FakeSandboxHandle(LIFECYCLE_SANDBOX_NAME, fake.events);
    staleHandle.responders.push(...fake.defaultResponders);
    staleHandle.responders.push((cmd, args) => {
      if (
        cmd === "bash" &&
        args?.[0] === "-c" &&
        args[1]?.includes(OPENCLAW_BUNDLE_IDENTITY_PATH)
      ) {
        return {
          exitCode: 0,
          output: async (stream?: "stdout" | "stderr" | "both") => {
            if (stream === "stderr") return "";
            return `${JSON.stringify({
              ...BUNDLE_ADMISSION.identity,
              canonicalSha256: "9".repeat(64),
            })}\n`;
          },
        };
      }
      return undefined;
    });
    fake.handlesByIds.set(LIFECYCLE_SANDBOX_NAME, staleHandle);
    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      _setAiGatewayTokenOverrideForTesting("test-ai-key");
      let scheduledCallback: (() => Promise<void> | void) | null = null;
      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "bundle-mismatch-test",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });
      assert.ok(scheduledCallback, "Background migration check should have been scheduled");
      await (scheduledCallback as () => Promise<void>)();

      assert.equal(staleHandle.deleteCalled, false, "existing state must never be deleted");
      assert.equal(staleHandle.stopCalled, true, "existing runtime must be quiesced");
      assert.equal(
        staleHandle.commands.some(
          (command) =>
            command.cmd === "bash" &&
            command.args?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
        ),
        false,
        "stale bundle sandbox must never run fast restore",
      );
      assert.equal(fake.created.length, 0);

      const meta = await getInitializedMeta();
      assert.equal(meta.status, "error");
      assert.match(meta.lastError ?? "", /^OPENCLAW_BUNDLE_MIGRATION_REQUIRED:/);
      assert.equal(meta.sandboxId, LIFECYCLE_SANDBOX_NAME);
      assert.deepEqual(meta.bundleIdentity, BUNDLE_ADMISSION.identity);
      await assert.rejects(
        waitForSandboxReady({
          origin: "https://test.example.com",
          reason: "bundle-mismatch-public-wait",
        }),
        (error: unknown) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.code, "OPENCLAW_BUNDLE_MIGRATION_REQUIRED");
          return true;
        },
      );
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

test("bundle migration retains the discovered sandbox ID for reset", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;
  const discoveredSandboxId = "sbx-discovered-existing";

  await withTestEnv(fake, async () => {
    configureBundleLifecycleTest();
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = null;
      meta.gatewayToken = "gw-token";
      meta.bundleIdentity = structuredClone(BUNDLE_ADMISSION.identity);
    });
    const staleHandle = new FakeSandboxHandle(discoveredSandboxId, fake.events);
    staleHandle.responders.push(...fake.defaultResponders);
    staleHandle.responders.push((cmd, args) => {
      if (
        cmd === "bash"
        && args?.[0] === "-c"
        && args[1]?.includes(OPENCLAW_BUNDLE_IDENTITY_PATH)
      ) {
        return {
          exitCode: 0,
          output: async (stream?: "stdout" | "stderr" | "both") =>
            stream === "stderr"
              ? ""
              : `${JSON.stringify({
                  ...BUNDLE_ADMISSION.identity,
                  canonicalSha256: "9".repeat(64),
                })}\n`,
        };
      }
      return undefined;
    });
    fake.handlesByIds.set(LIFECYCLE_SANDBOX_NAME, staleHandle);
    fake.handlesByIds.set(discoveredSandboxId, staleHandle);
    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      _setAiGatewayTokenOverrideForTesting("test-ai-key");
      await runScheduledEnsure("bundle-discovered-id-mismatch");
      const failed = await getInitializedMeta();
      assert.equal(failed.status, "error");
      assert.equal(failed.sandboxId, discoveredSandboxId);

      await resetSandbox({
        origin: "https://test.example.com",
        reason: "bundle-discovered-id-reset",
      });
      assert.equal(staleHandle.deleteCalled, true);
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

test("bundle migration parks durable stop state before the platform request", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    configureBundleLifecycleTest();
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = LIFECYCLE_SANDBOX_NAME;
      meta.gatewayToken = "gw-token";
      meta.bundleIdentity = structuredClone(BUNDLE_ADMISSION.identity);
    });

    const staleHandle = new FakeSandboxHandle(LIFECYCLE_SANDBOX_NAME, fake.events);
    staleHandle.responders.push(...fake.defaultResponders);
    staleHandle.responders.push((cmd, args) => {
      if (
        cmd === "bash"
        && args?.[0] === "-c"
        && args[1]?.includes(OPENCLAW_BUNDLE_IDENTITY_PATH)
      ) {
        return {
          exitCode: 0,
          output: async (stream?: "stdout" | "stderr" | "both") =>
            stream === "stderr"
              ? ""
              : `${JSON.stringify({
                  ...BUNDLE_ADMISSION.identity,
                  canonicalSha256: "9".repeat(64),
                })}\n`,
        };
      }
      return undefined;
    });
    let signalStopEntered!: () => void;
    const stopEntered = new Promise<void>((resolve) => {
      signalStopEntered = resolve;
    });
    let releaseStop!: () => void;
    const stopRelease = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    staleHandle.stop = async (options) => {
      staleHandle.stopCalled = true;
      staleHandle.lastStopOptions = options;
      signalStopEntered();
      await stopRelease;
      staleHandle.setStatus("stopped");
      throw new Error("connection lost after stop acceptance");
    };
    fake.handlesByIds.set(LIFECYCLE_SANDBOX_NAME, staleHandle);
    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      _setAiGatewayTokenOverrideForTesting("test-ai-key");
      let scheduled: (() => Promise<void> | void) | null = null;
      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "bundle-migration-durable-stop",
        schedule(callback) {
          scheduled = callback;
        },
      });
      assert.ok(scheduled);
      const lifecycle = (scheduled as () => Promise<void>)();
      await stopEntered;

      const parked = await getInitializedMeta();
      assert.equal(parked.status, "snapshotting");
      assert.equal(parked.sandboxId, LIFECYCLE_SANDBOX_NAME);
      assert.deepEqual(staleHandle.lastStopOptions, { blocking: false });
      const suspension = await readHostSuspensionState();
      assert.equal(suspension?.phase, "stop-requesting");
      assert.equal(suspension?.ingressFenced, true);

      releaseStop();
      await lifecycle;
      const migrated = await getInitializedMeta();
      assert.equal(migrated.status, "error");
      assert.match(migrated.lastError ?? "", /^OPENCLAW_BUNDLE_MIGRATION_REQUIRED:/);
    } finally {
      releaseStop();
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

test("bundle migration monitor finalizes the durable terminal error", async () => {
  const fake = new FakeSandboxController();

  await withTestEnv(fake, async () => {
    const sandboxId = "sbx-bundle-migration-monitor";
    await mutateMeta((meta) => {
      meta.status = "snapshotting";
      meta.sandboxId = sandboxId;
      meta.portUrls = null;
      meta.lifecycleAttemptId = "bundle-migration-attempt";
    });
    await getStore().setValue(
      hostSuspensionOperationKey(),
      hostSuspensionState(sandboxId, {
        operationId: "bundle-migration-operation",
        requestId: "bundle-migration-operation",
        reason: "sandbox.bundle_migration_required",
        lifecycleAttemptId: "bundle-migration-attempt",
        phase: "stopping",
        stopRequestDeadlineAtMs: null,
      }),
    );
    const stopped = new FakeSandboxHandle(sandboxId, fake.events);
    stopped.setStatus("stopped");
    fake.handlesByIds.set(sandboxId, stopped);

    const reconciled = await reconcileSnapshottingStatus();
    assert.equal(reconciled.status, "error");
    assert.equal(reconciled.sandboxId, sandboxId);
    assert.match(
      reconciled.lastError ?? "",
      /^OPENCLAW_BUNDLE_MIGRATION_REQUIRED:/,
    );

    let scheduled = false;
    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "bundle-migration-terminal-retry",
      schedule() {
        scheduled = true;
      },
    });
    assert.equal(scheduled, false);
  });
});

test("failed external plugin install deletes its bundle candidate before retry", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    configureBundleLifecycleTest();
    let pluginFailuresRemaining = 1;
    fake.defaultResponders.push((cmd, args) => {
      if (
        pluginFailuresRemaining > 0
        && cmd === "node"
        && args?.[0]?.includes("openclaw.bundle.mjs")
        && args[1] === "plugins"
        && args[2] === "install"
      ) {
        pluginFailuresRemaining -= 1;
        return {
          exitCode: 1,
          output: async (stream?: "stdout" | "stderr" | "both") =>
            stream === "stdout" ? "" : "injected external plugin failure",
        };
      }
      return undefined;
    });
    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      _setAiGatewayTokenOverrideForTesting("test-ai-key");
      let scheduled: (() => Promise<void> | void) | null = null;
      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "bundle-plugin-failure",
        schedule(callback) {
          scheduled = callback;
        },
      });
      assert.ok(scheduled);
      await (scheduled as () => Promise<void>)();

      const failedCandidate = fake.created[0];
      assert.ok(failedCandidate);
      assert.equal(failedCandidate.deleteCalled, true);
      let meta = await getInitializedMeta();
      assert.equal(meta.status, "error");
      assert.equal(meta.sandboxId, null);
      assert.equal(meta.bundleCandidate, null);
      assert.equal(meta.bundleIdentity, null);

      scheduled = null;
      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "bundle-plugin-retry",
        schedule(callback) {
          scheduled = callback;
        },
      });
      assert.ok(scheduled);
      await (scheduled as () => Promise<void>)();

      assert.equal(fake.created.length, 2);
      assert.notEqual(fake.created[1]?.sandboxId, failedCandidate.sandboxId);
      meta = await getInitializedMeta();
      assert.equal(meta.status, "running");
      assert.equal(meta.bundleCandidate, null);
      assert.deepEqual(meta.bundleIdentity, BUNDLE_ADMISSION.identity);
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

test("retry replaces a durably marked interrupted bundle candidate", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;
  const candidateOwner = "interrupted-candidate-token";

  await withTestEnv(fake, async () => {
    configureBundleLifecycleTest();
    await mutateMeta((meta) => {
      meta.status = "error";
      meta.sandboxId = LIFECYCLE_SANDBOX_NAME;
      meta.gatewayToken = "gw-token";
      meta.lifecycleAttemptId = "interrupted-attempt";
      meta.bundleCandidate = bundleCandidate(candidateOwner);
    });
    const interrupted = new FakeSandboxHandle(
      LIFECYCLE_SANDBOX_NAME,
      fake.events,
    );
    tagBundleCandidate(interrupted, candidateOwner);
    fake.handlesByIds.set(LIFECYCLE_SANDBOX_NAME, interrupted);
    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      _setAiGatewayTokenOverrideForTesting("test-ai-key");
      let scheduled: (() => Promise<void> | void) | null = null;
      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "interrupted-bundle-candidate",
        schedule(callback) {
          scheduled = callback;
        },
      });
      assert.ok(scheduled);
      await (scheduled as () => Promise<void>)();

      assert.equal(interrupted.deleteCalled, true);
      assert.equal(fake.created.length, 1);
      const meta = await getInitializedMeta();
      assert.equal(meta.status, "running");
      assert.equal(meta.bundleCandidate, null);
      assert.deepEqual(meta.bundleIdentity, BUNDLE_ADMISSION.identity);
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

test("lost create response keeps tagged intent and retry rebuilds the candidate", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    configureBundleLifecycleTest();
    const originalCreate = fake.create.bind(fake);
    let loseResponse = true;
    let firstOwner: string | null = null;
    fake.create = async (params) => {
      if (!loseResponse) return originalCreate(params);
      const intent = (await getInitializedMeta()).bundleCandidate;
      assert.ok(intent, "candidate intent must precede the create POST");
      assert.equal(intent.lookupId, LIFECYCLE_SANDBOX_NAME);
      assert.equal(intent.sandboxId, null);
      firstOwner = intent.ownershipToken;
      const remotelyCreated = await originalCreate(params);
      fake.handlesByIds.set(LIFECYCLE_SANDBOX_NAME, remotelyCreated as FakeSandboxHandle);
      loseResponse = false;
      throw new Error("connection lost after sandbox create");
    };
    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      _setAiGatewayTokenOverrideForTesting("test-ai-key");
      await runScheduledEnsure("bundle-lost-create-response");

      let meta = await getInitializedMeta();
      assert.equal(meta.status, "error");
      assert.equal(meta.bundleCandidate?.sandboxId, null);
      assert.equal(meta.bundleCandidate?.ownershipToken, firstOwner);
      const interrupted = fake.created[0];
      assert.ok(interrupted);
      assert.equal(interrupted.deleteCalled, false);

      await runScheduledEnsure("bundle-lost-create-response-retry");

      assert.equal(interrupted.deleteCalled, true);
      assert.equal(fake.created.length, 2);
      assert.notEqual(
        fake.created[1]?.tags?.[BUNDLE_CANDIDATE_TAG],
        firstOwner,
        "confirmed delete must rotate candidate ownership",
      );
      meta = await getInitializedMeta();
      assert.equal(meta.status, "running");
      assert.equal(meta.bundleCandidate, null);
      assert.deepEqual(meta.bundleIdentity, BUNDLE_ADMISSION.identity);
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

test("production-shaped create 409 preserves replacement provenance across retry", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;
  const originalOwner = "candidate-before-delayed-release";

  await withTestEnv(fake, async () => {
    configureBundleLifecycleTest();
    await mutateMeta((meta) => {
      meta.status = "error";
      meta.sandboxId = LIFECYCLE_SANDBOX_NAME;
      meta.gatewayToken = "gw-token";
      meta.lifecycleAttemptId = "interrupted-attempt";
      meta.bundleCandidate = bundleCandidate(originalOwner);
    });
    const interrupted = new FakeSandboxHandle(
      LIFECYCLE_SANDBOX_NAME,
      fake.events,
    );
    tagBundleCandidate(interrupted, originalOwner);
    fake.handlesByIds.set(LIFECYCLE_SANDBOX_NAME, interrupted);

    const originalCreate = fake.create.bind(fake);
    let conflictsRemaining = 2;
    fake.create = async (params) => {
      if (conflictsRemaining > 0) {
        conflictsRemaining -= 1;
        throw Object.assign(new Error("create conflict"), {
          response: { status: 409 },
        });
      }
      return originalCreate(params);
    };
    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      _setAiGatewayTokenOverrideForTesting("test-ai-key");
      await runScheduledEnsure("bundle-delayed-name-release");

      let meta = await getInitializedMeta();
      assert.equal(meta.status, "error");
      assert.ok(meta.bundleCandidate);
      assert.notEqual(meta.bundleCandidate.ownershipToken, originalOwner);
      assert.equal(
        meta.bundleCandidate.replacesOwnershipToken,
        originalOwner,
      );

      await runScheduledEnsure("bundle-delayed-name-release-retry");

      assert.equal(fake.created.length, 1);
      meta = await getInitializedMeta();
      assert.equal(meta.status, "running");
      assert.equal(meta.bundleCandidate, null);
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

test("transient bundle lookup failure never creates delete provenance", async () => {
  const fake = new FakeSandboxController();

  await withTestEnv(fake, async () => {
    configureBundleLifecycleTest();
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = LIFECYCLE_SANDBOX_NAME;
      meta.bundleIdentity = structuredClone(BUNDLE_ADMISSION.identity);
    });
    const existing = new FakeSandboxHandle(LIFECYCLE_SANDBOX_NAME, fake.events);
    fake.handlesByIds.set(LIFECYCLE_SANDBOX_NAME, existing);
    const originalGet = fake.get.bind(fake);
    let failLookup = true;
    fake.get = async (params) => {
      if (failLookup) {
        failLookup = false;
        throw new Error("temporary sandbox control-plane outage");
      }
      return originalGet(params);
    };

    _setAiGatewayTokenOverrideForTesting("test-ai-key");
    try {
      await runScheduledEnsure("bundle-transient-get");
      const meta = await getInitializedMeta();
      assert.equal(meta.status, "error");
      assert.equal(meta.bundleCandidate, null);
      assert.equal(fake.createCalls.length, 0);
      assert.equal(existing.deleteCalled, false);
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("candidate visible after an initial 404 is still replaced, not migrated", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;
  const candidateOwner = "eventually-visible-candidate";

  await withTestEnv(fake, async () => {
    configureBundleLifecycleTest();
    await mutateMeta((meta) => {
      meta.status = "error";
      meta.sandboxId = LIFECYCLE_SANDBOX_NAME;
      meta.lifecycleAttemptId = "interrupted-attempt";
      meta.bundleCandidate = bundleCandidate(candidateOwner);
    });
    const interrupted = new FakeSandboxHandle(
      LIFECYCLE_SANDBOX_NAME,
      fake.events,
    );
    tagBundleCandidate(interrupted, candidateOwner);
    fake.handlesByIds.set(LIFECYCLE_SANDBOX_NAME, interrupted);
    const originalGet = fake.get.bind(fake);
    let firstLookup = true;
    fake.get = async (params) => {
      if (firstLookup) {
        firstLookup = false;
        throw Object.assign(new Error("not visible yet"), {
          response: { status: 404 },
        });
      }
      return originalGet(params);
    };
    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      _setAiGatewayTokenOverrideForTesting("test-ai-key");
      await runScheduledEnsure("bundle-eventual-candidate");
      assert.equal(interrupted.deleteCalled, true);
      const meta = await getInitializedMeta();
      assert.equal(meta.status, "running");
      assert.doesNotMatch(
        meta.lastError ?? "",
        /OPENCLAW_BUNDLE_MIGRATION_REQUIRED/,
      );
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

test("candidate tag mismatch preserves the existing sandbox for migration", async () => {
  const fake = new FakeSandboxController();
  const expectedOwner = "expected-candidate-owner";

  await withTestEnv(fake, async () => {
    configureBundleLifecycleTest();
    await mutateMeta((meta) => {
      meta.status = "error";
      meta.sandboxId = LIFECYCLE_SANDBOX_NAME;
      meta.lifecycleAttemptId = "interrupted-attempt";
      meta.bundleCandidate = bundleCandidate(expectedOwner);
    });
    const unknown = new FakeSandboxHandle(LIFECYCLE_SANDBOX_NAME, fake.events);
    tagBundleCandidate(unknown, "different-owner");
    fake.handlesByIds.set(LIFECYCLE_SANDBOX_NAME, unknown);

    _setAiGatewayTokenOverrideForTesting("test-ai-key");
    try {
      await runScheduledEnsure("bundle-candidate-tag-mismatch");
      const meta = await getInitializedMeta();
      assert.equal(unknown.deleteCalled, false);
      assert.equal(meta.status, "error");
      assert.match(meta.lastError ?? "", /^OPENCLAW_BUNDLE_MIGRATION_REQUIRED:/);
      assert.equal(meta.bundleCandidate?.ownershipToken, expectedOwner);
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("candidate delete takeover cannot overwrite the newer lifecycle generation", async () => {
  const fake = new FakeSandboxController();
  const staleOwner = "stale-delete-owner";
  const newerOwner = "new-generation-owner";

  await withTestEnv(fake, async () => {
    configureBundleLifecycleTest();
    await mutateMeta((meta) => {
      meta.status = "error";
      meta.sandboxId = LIFECYCLE_SANDBOX_NAME;
      meta.lifecycleAttemptId = "interrupted-attempt";
      meta.bundleCandidate = bundleCandidate(staleOwner);
    });
    const interrupted = new FakeSandboxHandle(
      LIFECYCLE_SANDBOX_NAME,
      fake.events,
    );
    tagBundleCandidate(interrupted, staleOwner);
    interrupted.deleteHook = async () => {
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = LIFECYCLE_SANDBOX_NAME;
        meta.lifecycleAttemptId = "new-lifecycle-attempt";
        meta.bundleCandidate = bundleCandidate(newerOwner, {
          lifecycleAttemptId: "new-lifecycle-attempt",
        });
      });
    };
    fake.handlesByIds.set(LIFECYCLE_SANDBOX_NAME, interrupted);

    _setAiGatewayTokenOverrideForTesting("test-ai-key");
    try {
      await runScheduledEnsure("bundle-delete-takeover");
      const meta = await getInitializedMeta();
      assert.equal(meta.status, "running");
      assert.equal(meta.lifecycleAttemptId, "new-lifecycle-attempt");
      assert.equal(meta.bundleCandidate?.ownershipToken, newerOwner);
      assert.equal(fake.createCalls.length, 0);
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("post-receipt takeover cannot be overwritten or delete the verified sandbox", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;
  let takeoverApplied = false;

  await withTestEnv(fake, async () => {
    configureBundleLifecycleTest();
    fake.onNetworkPolicy = async (policy) => {
      // Fresh bootstrap applies the final firewall only after the bundle
      // receipt is installed, but before publishing that receipt to host meta.
      if (!takeoverApplied) {
        takeoverApplied = true;
        await mutateMeta((meta) => {
          meta.status = "running";
          meta.sandboxId = "sbx-new-generation";
          meta.portUrls = { "3000": "https://sbx-new-generation.example" };
          meta.lifecycleAttemptId = "new-lifecycle-attempt";
          meta.bundleCandidate = null;
          meta.bundleIdentity = structuredClone(BUNDLE_ADMISSION.identity);
        });
      }
      return policy;
    };
    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      _setAiGatewayTokenOverrideForTesting("test-ai-key");
      await runScheduledEnsure("bundle-post-receipt-takeover");
      assert.equal(takeoverApplied, true);
      assert.equal(fake.created[0]?.deleteCalled, false);
      const meta = await getInitializedMeta();
      assert.equal(meta.status, "running");
      assert.equal(meta.sandboxId, "sbx-new-generation");
      assert.equal(meta.lifecycleAttemptId, "new-lifecycle-attempt");
      assert.deepEqual(meta.bundleIdentity, BUNDLE_ADMISSION.identity);
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

test("waitForSandboxReady preserves stable bundle lifecycle errors", async () => {
  const fake = new FakeSandboxController();

  await withTestEnv(fake, async () => {
    for (const expected of [
      { code: "OPENCLAW_BUNDLE_MIGRATION_REQUIRED", status: 409 },
      { code: "OPENCLAW_BUNDLE_QUIESCE_FAILED", status: 502 },
    ]) {
      await mutateMeta((meta) => {
        meta.status = "error";
        meta.lastError = `${expected.code}: stable detail`;
      });

      await assert.rejects(
        waitForSandboxReady({
          origin: "https://test.example.com",
          reason: "stable-bundle-error-test",
        }),
        (error: unknown) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.code, expected.code);
          assert.equal(error.status, expected.status);
          assert.equal(error.message, "stable detail");
          return true;
        },
      );
    }
  });
});

test("terminal bundle errors stay parked while cleanup failures can retry", async () => {
  const fake = new FakeSandboxController();

  await withTestEnv(fake, async () => {
    let scheduled: (() => Promise<void> | void) | null = null;
    await mutateMeta((meta) => {
      meta.status = "error";
      meta.lastError = "OPENCLAW_BUNDLE_MIGRATION_REQUIRED: migrate first";
    });
    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "terminal-bundle-error",
      schedule(callback) {
        scheduled = callback;
      },
    });
    assert.equal(scheduled, null);

    await mutateMeta((meta) => {
      meta.status = "error";
      meta.lastError =
        "OPENCLAW_BUNDLE_CANDIDATE_CLEANUP_FAILED: transient delete failure";
    });
    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "retry-bundle-cleanup",
      schedule(callback) {
        scheduled = callback;
      },
    });
    assert.ok(scheduled, "cleanup failures should be retried by lifecycle work");
  });
});

test("in-flight waiter rehydrates stable bundle errors at its timeout boundary", async () => {
  const fake = new FakeSandboxController();

  await withTestEnv(fake, async () => {
    for (const expected of [
      { code: "OPENCLAW_BUNDLE_MIGRATION_REQUIRED", status: 409 },
      { code: "OPENCLAW_BUNDLE_QUIESCE_FAILED", status: 502 },
    ]) {
      await mutateMeta((meta) => {
        meta.status = "creating";
        meta.sandboxId = null;
        meta.lastError = null;
      });
      const waiter = waitForSandboxReady({
        origin: "https://test.example.com",
        reason: "in-flight-stable-bundle-error",
        timeoutMs: 40,
        pollIntervalMs: 100,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await mutateMeta((meta) => {
        meta.status = "error";
        meta.lastError = `${expected.code}: transitioned while waiting`;
      });

      await assert.rejects(waiter, (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, expected.code);
        assert.equal(error.status, expected.status);
        return true;
      });
    }
  });
});

test("restoreSandboxFromSnapshot appends to restoreHistory capped at MAX_RESTORE_HISTORY", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-history-test";
      meta.gatewayToken = "test-gw-token";
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      // First restore
      await triggerRestore(fake, { tokenOverride: "test-ai-key" });
      let meta = await getInitializedMeta();
      assert.ok(meta.lastRestoreMetrics, "Should have restore metrics after first restore");
      assert.equal(meta.restoreHistory.length, 1, "restoreHistory should have 1 entry");
      assert.deepStrictEqual(
        meta.restoreHistory[0],
        meta.lastRestoreMetrics,
        "First history entry should match lastRestoreMetrics",
      );

      // Reset to stopped for second restore
      await mutateMeta((m) => {
        m.status = "stopped";
        m.snapshotId = "snap-history-test-2";
        m.sandboxId = null;
        m.portUrls = null;
      });

      // Second restore
      await triggerRestore(fake, { tokenOverride: "test-ai-key" });
      meta = await getInitializedMeta();
      assert.equal(meta.restoreHistory.length, 2, "restoreHistory should have 2 entries");
      assert.deepStrictEqual(
        meta.restoreHistory[0],
        meta.lastRestoreMetrics,
        "Most recent entry should be first (newest first ordering)",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("restoreSandboxFromSnapshot resume skips public ready and records metrics", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-overlap-test";
      meta.gatewayToken = "test-gw-token";
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["api.openai.com", "registry.npmjs.org"];
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { meta } = await triggerRestore(fake, {
        tokenOverride: "test-ai-key",
      });

      // v2: resume path records restore metrics
      assert.ok(meta.lastRestoreMetrics, "Should have restore metrics");
      assert.equal(
        meta.lastRestoreMetrics.skippedPublicReady,
        true,
        "Resume should skip public readiness",
      );
      assert.equal(
        meta.lastRestoreMetrics.publicReadyMs,
        0,
        "publicReadyMs should be 0 when skipped",
      );
      const m = meta.lastRestoreMetrics;
      assert.ok(typeof m.firewallSyncMs === "number", "firewallSyncMs should be a number");
      assert.ok(
        typeof m.localReadyMs === "number" && m.localReadyMs >= 0,
        "localReadyMs should be a non-negative number",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("restoreSandboxFromSnapshot records successful firewall sync before running", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-firewall-success";
      meta.gatewayToken = "test-gw-token";
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["api.openai.com", "registry.npmjs.org"];
    });

    // networkPolicyHandler returns success after a small delay so firewallSyncMs > 0
    fake.onNetworkPolicy = async (policy) => {
      await new Promise((r) => setTimeout(r, 2));
      return policy;
    };

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { handle, meta } = await triggerRestore(fake, {
        tokenOverride: "test-ai-key",
      });

      assert.equal(meta.status, "running");
      assert.equal(handle.networkPolicies.length, 1);
      // With a token, the policy uses the record form with ai-gateway transform
      const policy = handle.networkPolicies[0] as { allow: Record<string, unknown[]> };
      assert.ok(policy.allow, "should have allow record");
      assert.ok(policy.allow["api.openai.com"], "should include api.openai.com");
      assert.ok(policy.allow["registry.npmjs.org"], "should include registry.npmjs.org");
      assert.ok(policy.allow["ai-gateway.vercel.sh"], "should include ai-gateway with transform");
      assert.ok(
        policy.allow["test.example.com"],
        "should include the cron projection control plane",
      );
      // v2: resume path applies firewall but doesn't record detailed sync outcome
      assert.ok(
        (meta.lastRestoreMetrics?.firewallSyncMs ?? 0) >= 0,
        "firewallSyncMs should be recorded",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("restoreSandboxFromSnapshot fails closed when enforcing firewall sync fails", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-firewall-fail";
      meta.gatewayToken = "test-gw-token";
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["api.openai.com"];
    });

    fake.onNetworkPolicy = async () => {
      throw new Error("simulated network policy failure");
    };

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { handle: _handle, meta } = await triggerRestore(fake, {
        tokenOverride: "test-ai-key",
      });

      assert.equal(meta.status, "error");
      // v2: resume path error message says "persistent resume", not "restore"
      assert.ok(
        meta.lastError?.includes("Firewall sync failed"),
        `expected firewall error, got: ${meta.lastError}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Create-path firewall sync tests
// ---------------------------------------------------------------------------

/**
 * Helper: triggers createAndBootstrapSandbox by calling ensureSandboxRunning
 * with an uninitialized meta, captures the scheduled callback,
 * and runs it.
 */
async function runCreatePath(): Promise<SingleMeta> {
  let scheduledCallback: (() => Promise<void> | void) | null = null;

  await ensureSandboxRunning({
    origin: "https://test.example.com",
    reason: "create-firewall-test",
    schedule(cb) {
      scheduledCallback = cb;
    },
  });

  assert.ok(scheduledCallback, "expected lifecycle callback");
  await (scheduledCallback as () => Promise<void>)();
  return getInitializedMeta();
}

test("createAndBootstrapSandbox records successful firewall sync before running", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "uninitialized";
      meta.snapshotId = null;
      meta.gatewayToken = "test-gw-token";
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["api.openai.com", "registry.npmjs.org"];
    });

    fake.onNetworkPolicy = async (policy) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return policy;
    };

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const meta = await runCreatePath();
      assert.equal(meta.status, "running");
      const handle = fake.created.at(-1);
      assert.ok(handle);
      const createPolicy = handle.createTimeNetworkPolicy as {
        allow: string[] | Record<string, unknown[]>;
      };
      const createDomains = Array.isArray(createPolicy.allow)
        ? createPolicy.allow
        : Object.keys(createPolicy.allow);
      assert.ok(
        createDomains.includes("test.example.com"),
        "create policy must admit the cron projection control plane before Gateway starts",
      );
      assert.equal(meta.firewall.lastSyncOutcome?.applied, true);
      assert.equal(meta.firewall.lastSyncReason, "create-policy-applied");
      assert.ok(meta.firewall.lastSyncAppliedAt);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("fresh Gateway startup reapplies a firewall policy changed during bootstrap", async () => {
  const fake = new FakeSandboxController();
  let updates = 0;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "uninitialized";
      meta.snapshotId = null;
      meta.gatewayToken = "test-gw-token";
      meta.firewall.mode = "disabled";
      meta.firewall.allowlist = [];
    });
    fake.onNetworkPolicy = async (policy) => {
      updates += 1;
      if (updates === 1) {
        await mutateMeta((meta) => {
          meta.firewall.mode = "enforcing";
          meta.firewall.allowlist = ["api.openai.com"];
        });
      }
      return policy;
    };

    const meta = await runCreatePath();

    assert.equal(meta.status, "running");
    const handle = fake.created.at(-1);
    assert.ok(handle);
    assert.equal(handle.networkPolicies.length, 2);
    const finalPolicy = handle.networkPolicies.at(-1) as {
      allow: string[] | Record<string, unknown[]>;
    };
    const finalDomains = Array.isArray(finalPolicy.allow)
      ? finalPolicy.allow
      : Object.keys(finalPolicy.allow);
    assert.ok(finalDomains.includes("api.openai.com"));
  });
});

test("createAndBootstrapSandbox fails closed when enforcing firewall sync fails", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "uninitialized";
      meta.snapshotId = null;
      meta.gatewayToken = "test-gw-token";
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["api.openai.com"];
    });

    fake.onNetworkPolicy = async () => {
      throw new Error("simulated network policy failure");
    };

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const meta = await runCreatePath();
      assert.equal(meta.status, "error");
      assert.equal(meta.sandboxId, null);
      assert.equal(meta.portUrls, null);
      assert.ok(
        meta.lastError?.includes("Firewall sync failed during create"),
        `expected create firewall error, got: ${meta.lastError}`,
      );
      assert.equal(meta.firewall.lastSyncOutcome?.applied, false);
      assert.equal(meta.firewall.lastSyncReason, "create-policy-failed");
      assert.ok(meta.firewall.lastSyncFailedAt);
      // Verify sandbox was stopped for cleanup
      const handle = fake.created[fake.created.length - 1];
      assert.equal(handle.stopCalled, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("createAndBootstrapSandbox does not fail closed in learning mode when firewall sync fails", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "uninitialized";
      meta.snapshotId = null;
      meta.gatewayToken = "test-gw-token";
      meta.firewall.mode = "learning";
      meta.firewall.allowlist = ["api.openai.com"];
    });

    fake.onNetworkPolicy = async () => {
      throw new Error("simulated network policy failure");
    };

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const meta = await runCreatePath();
      // Learning mode should still reach running despite firewall failure
      assert.equal(meta.status, "running");
      assert.equal(meta.firewall.lastSyncOutcome?.applied, false);
      assert.equal(meta.firewall.lastSyncReason, "create-policy-failed");
      assert.ok(meta.firewall.lastSyncFailedAt);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("restoreSandboxFromSnapshot passes credentials and config via env to fast-restore script", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-restore-token";
      meta.gatewayToken = "test-gw-token";
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { handle } = await triggerRestore(fake, {
        tokenOverride: "my-gateway-key",
      });

      // Credentials + config are passed via create-time env (not per-command).
      // The fast-restore script reads from sandbox env vars.
      const bashCmd = handle.commands.find(
        (c) => c.cmd === "bash" && c.args?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
      );
      assert.ok(bashCmd, "Should run fast-restore script");
      // No writeFiles for credentials (passed via env at create time)
      const credentialWrites = handle.writtenFiles.filter(
        (f) => f.path === OPENCLAW_GATEWAY_TOKEN_PATH || f.path.endsWith(".ai-gateway-api-key"),
      );
      assert.equal(credentialWrites.length, 0, "Credentials should not be in writtenFiles");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("persistent resume passes restore env to fast-restore script", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = "sbx-persistent";
      meta.gatewayToken = "test-gw-token";
    });

    // Pre-register a resumed handle so the fast-restore path is taken
    const _resumeHandle = preRegisterResumeHandle(fake);

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { handle } = await triggerRestore(fake);
      assert.equal((await getInitializedMeta()).status, "running");

      const bashCmd = handle.commands.find(
        (c) => c.cmd === "bash" && c.args?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
      );
      assert.ok(bashCmd, "Should run fast-restore script for persistent resume");
      assert.equal(bashCmd.env?.OPENCLAW_GATEWAY_TOKEN, "test-gw-token");
      assert.ok(bashCmd.env?.AI_GATEWAY_API_KEY?.includes("placeholder"), "Should use placeholder AI key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});


test("restoreSandboxFromSnapshot passes gateway token via env even without API key", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-restore-no-token";
      meta.gatewayToken = "test-gw-token";
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { handle } = await triggerRestore(fake);

      // Credentials passed via env to fast-restore script, not via writeFiles
      const bashCmd = handle.commands.find(
        (c) => c.cmd === "bash" && c.args?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
      );
      assert.ok(bashCmd, "Should run fast-restore script even without API key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("restoreSandboxFromSnapshot writes config via writeFiles, not env", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-restore-origin";
      meta.gatewayToken = "test-gw-token";
      // Use null snapshotDynamicConfigHash to force a config write
      meta.snapshotDynamicConfigHash = null;
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { handle } = await triggerRestore(fake, {
        tokenOverride: "my-gateway-key",
      });

      // v2: resume path writes config via syncRestoreAssetsIfNeeded (writeFiles)
      const configFile = handle.writtenFiles.find(
        (f) => f.path === OPENCLAW_CONFIG_PATH,
      );
      assert.ok(configFile, "Config should be written via writeFiles");
      const config = JSON.parse(configFile.content.toString("utf8")) as {
        gateway?: { controlUi?: { allowedOrigins?: string[] } };
      };
      assert.deepStrictEqual(
        config.gateway?.controlUi?.allowedOrigins,
        ["https://test.example.com"],
        "Written config should use the current origin passed to ensureSandboxRunning",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("restoreSandboxFromSnapshot runs bash fast-restore-script and checks exit code", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-restore-startup";
      meta.gatewayToken = "test-gw-token";
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { handle } = await triggerRestore(fake, {
        tokenOverride: "test-key",
      });

      // Should have a "bash" command with the fast-restore script path + timeout arg
      const bashCmd = handle.commands.find(
        (c) => c.cmd === "bash" && c.args?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
      );
      assert.ok(bashCmd, "Should run bash with fast-restore script path");
      assert.ok(bashCmd?.args?.[1], "Should pass readiness timeout argument");

      // Should NOT have a separate force-pair step — it's inlined
      const forcePairCmd = handle.commands.find(
        (c) => c.cmd === "node" && c.args?.[0] === OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
      );
      assert.equal(forcePairCmd, undefined, "Should not run separate force-pair (inlined in fast-restore)");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("restoreSandboxFromSnapshot with fast-restore script exit code != 0 throws error", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  // Make the fast-restore script command fail
  fake.defaultResponders.push((cmd, args) => {
    if (
      cmd === "bash"
      && args?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH
      && args[2] === "start"
    ) {
      return { exitCode: 1, output: async () => "fast-restore script failed: missing config" };
    }
    return undefined;
  });

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-restore-fail";
      meta.gatewayToken = "test-gw-token";
    });

    // Pre-register a resumed handle so get() succeeds and resume path is taken
    preRegisterResumeHandle(fake);

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    _setAiGatewayTokenOverrideForTesting("test-key");
    try {
      // The restore should fail and set status to "error"
      let scheduledCallback: (() => Promise<void> | void) | null = null;

      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "restore-fail-test",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      assert.ok(scheduledCallback);
      await (scheduledCallback as () => Promise<void>)();

      const meta = await getInitializedMeta();
      assert.equal(meta.status, "error", "Status should be error after fast-restore script failure");
      assert.ok(meta.lastError?.includes("fast-restore-script"), "lastError should mention fast-restore script failure");
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Concurrency: concurrent ensureSandboxRunning() calls produce exactly one create
// ---------------------------------------------------------------------------

test("concurrent ensureSandboxRunning() calls from uninitialized produce exactly one sandbox create", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    // Status is "uninitialized" by default after reset

    const callbacks: Array<() => Promise<void> | void> = [];

    // Fire 5 concurrent calls
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        ensureSandboxRunning({
          origin: "https://test.example.com",
          reason: `concurrent-${i}`,
          schedule(cb) {
            callbacks.push(cb);
          },
        }),
      ),
    );

    // All should return waiting
    for (const r of results) {
      assert.equal(r.state, "waiting");
    }

    // Only one callback should have been scheduled (start lock dedup)
    assert.equal(
      callbacks.length,
      1,
      `Expected exactly 1 scheduled callback, got ${callbacks.length} — start lock should deduplicate`,
    );

    // Meta should be "creating" (set once by the winner)
    const meta = await getInitializedMeta();
    assert.equal(meta.status, "creating");
  });
});

test("concurrent ensureSandboxRunning() calls from stopped produce exactly one restore", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-concurrent-restore";
    });

    const callbacks: Array<() => Promise<void> | void> = [];

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        ensureSandboxRunning({
          origin: "https://test.example.com",
          reason: `concurrent-restore-${i}`,
          schedule(cb) {
            callbacks.push(cb);
          },
        }),
      ),
    );

    for (const r of results) {
      assert.equal(r.state, "waiting");
    }

    assert.equal(
      callbacks.length,
      1,
      `Expected exactly 1 scheduled callback for restore, got ${callbacks.length}`,
    );

    // Restore scheduling should immediately surface "restoring" for snapshot wake flows.
    const meta = await getInitializedMeta();
    assert.equal(meta.status, "restoring");
  });
});

// ---------------------------------------------------------------------------
// Error recovery: error status transitions to creating on next ensure call
// ---------------------------------------------------------------------------

test("ensureSandboxRunning recovers from error status by scheduling create", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "error";
      meta.lastError = "previous failure";
      meta.sandboxId = null;
      meta.snapshotId = null;
    });

    let scheduledCallback: (() => Promise<void> | void) | null = null;

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "error-recovery-test",
      schedule(cb) {
        scheduledCallback = cb;
      },
    });

    assert.equal(result.state, "waiting");
    assert.ok(scheduledCallback, "Should schedule create work from error state");

    const meta = await getInitializedMeta();
    assert.equal(meta.status, "creating", "Should transition from error to creating");
    assert.equal(meta.lastError, null, "lastError should be cleared");
  });
});

test("ensureSandboxRunning recovers from error status by scheduling restore when snapshot exists", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "error";
      meta.lastError = "previous failure";
      meta.sandboxId = null;
      meta.snapshotId = "snap-error-recovery";
    });

    let scheduledCallback: (() => Promise<void> | void) | null = null;

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "error-recovery-restore-test",
      schedule(cb) {
        scheduledCallback = cb;
      },
    });

    assert.equal(result.state, "waiting");
    assert.ok(scheduledCallback, "Should schedule restore work from error state with snapshot");

    const meta = await getInitializedMeta();
    assert.equal(meta.status, "restoring", "Should transition from error to restoring when snapshot exists");
  });
});

test("ensureSandboxRunning full error recovery: error → create → running", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "error";
      meta.lastError = "sandbox crashed";
      meta.sandboxId = null;
      meta.snapshotId = null;
    });

    // Mock fetch for probeGatewayReady
    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      let scheduledCallback: (() => Promise<void> | void) | null = null;

      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "full-error-recovery",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      assert.ok(scheduledCallback);
      await (scheduledCallback as () => Promise<void>)();

      const meta = await getInitializedMeta();
      assert.equal(meta.status, "running", "Should reach running after error recovery");
      assert.equal(meta.lastError, null, "lastError should be cleared");
      assert.ok(meta.sandboxId, "sandboxId should be set");
      assert.equal(fake.created.length, 1, "Should have created exactly one sandbox");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("ensureSandboxRunning create path stores openclaw version (no auto-save)", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  fake.defaultResponders.push((cmd, args) => {
    if (cmd === OPENCLAW_BIN && args?.[0] === "--version") {
      return { exitCode: 0, output: async () => "openclaw 9.9.9" };
    }
    return undefined;
  });

  await withTestEnv(fake, async () => {
    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      let scheduledCallback: (() => Promise<void> | void) | null = null;

      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "bootstrap-snapshot-test",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      assert.ok(scheduledCallback, "Background work should have been scheduled");
      await (scheduledCallback as () => Promise<void>)();

      const meta = await getInitializedMeta();
      const handle = fake.created[0];
      assert.ok(handle, "sandbox handle should be tracked");

      assert.equal(meta.status, "running");
      assert.equal(meta.openclawVersion, "openclaw 9.9.9");
      assert.equal(meta.snapshotId, null, "no auto-save after bootstrap");
      assert.equal(handle.snapshotCalled, false, "snapshot should not be called after bootstrap");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Stale sandbox detection: running but gateway probe fails
// ---------------------------------------------------------------------------

test("probeGatewayReady returns not ready when gateway returns non-200", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-stale-1";
      meta.portUrls = { "3000": "https://sbx-stale-1-3000.fake.vercel.run" };
      meta.gatewayToken = "test-token";
    });

    globalThis.fetch = async () =>
      new Response("Bad Gateway", { status: 502 });

    try {
      const result = await probeGatewayReady();
      assert.equal(result.ready, false);
      assert.equal(result.statusCode, 502);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("probeGatewayReady returns not ready when response body lacks openclaw-app marker", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-stale-2";
      meta.portUrls = { "3000": "https://sbx-stale-2-3000.fake.vercel.run" };
      meta.gatewayToken = "test-token";
    });

    // Returns 200 but without the marker
    globalThis.fetch = async () =>
      new Response("<html><body>something else</body></html>", { status: 200 });

    try {
      const result = await probeGatewayReady();
      assert.equal(result.ready, false);
      assert.equal(result.markerFound, false);
      assert.equal(result.statusCode, 200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("probeGatewayReady returns not ready for non-running statuses (stopped, uninitialized)", async () => {
  const fake = new FakeSandboxController();

  await withTestEnv(fake, async () => {
    // Stopped with no sandboxId
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = null;
    });

    let result = await probeGatewayReady();
    assert.equal(result.ready, false);

    // Uninitialized
    await mutateMeta((meta) => {
      meta.status = "uninitialized";
      meta.sandboxId = null;
    });

    result = await probeGatewayReady();
    assert.equal(result.ready, false);
  });
});

// ---------------------------------------------------------------------------
// Restoring status: ensure returns waiting without duplicate restore
// ---------------------------------------------------------------------------

test("ensureSandboxRunning during restoring status returns waiting without scheduling new work", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "restoring";
      meta.sandboxId = null;
      meta.snapshotId = "snap-in-progress";
    });

    let scheduledCallback: (() => Promise<void> | void) | null = null;

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "during-restoring-test",
      schedule(cb) {
        scheduledCallback = cb;
      },
    });

    assert.equal(result.state, "waiting");
    assert.equal(scheduledCallback, null, "Should NOT schedule new work while restoring is in progress");
    assert.equal(fake.created.length, 0, "Should not create any sandbox");
  });
});

test("ensureSandboxRunning during booting status returns waiting without scheduling new work", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "booting";
      meta.sandboxId = "sbx-booting";
    });

    let scheduledCallback: (() => Promise<void> | void) | null = null;

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "during-booting-test",
      schedule(cb) {
        scheduledCallback = cb;
      },
    });

    assert.equal(result.state, "waiting");
    assert.equal(scheduledCallback, null, "Should NOT schedule new work while booting");
  });
});

test("ensureSandboxRunning during setup status returns waiting without scheduling new work", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "setup";
      meta.sandboxId = "sbx-setup";
    });

    let scheduledCallback: (() => Promise<void> | void) | null = null;

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "during-setup-test",
      schedule(cb) {
        scheduledCallback = cb;
      },
    });

    assert.equal(result.state, "waiting");
    assert.equal(scheduledCallback, null, "Should NOT schedule new work while in setup");
  });
});

// ---------------------------------------------------------------------------
// touchRunningSandbox edge cases
// ---------------------------------------------------------------------------

test("touchRunningSandbox is a no-op when status is creating", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "creating";
      meta.sandboxId = null;
    });

    const result = await touchRunningSandbox();
    assert.equal(result.status, "creating");
    assert.equal(fake.retrieved.length, 0, "Should not call controller.get");
  });
});

test("touchRunningSandbox is a no-op when status is error", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "error";
      meta.sandboxId = null;
      meta.lastError = "some error";
    });

    const result = await touchRunningSandbox();
    assert.equal(result.status, "error");
    assert.equal(fake.retrieved.length, 0, "Should not call controller.get");
  });
});

test("touchRunningSandbox is a no-op when sandboxId is set but status is not running", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "booting";
      meta.sandboxId = "sbx-booting-touch";
    });

    const result = await touchRunningSandbox();
    assert.equal(result.status, "booting");
    assert.equal(fake.retrieved.length, 0, "Should not call controller.get for non-running status");
  });
});

// ---------------------------------------------------------------------------
// markSandboxUnavailable tests
// ---------------------------------------------------------------------------

test("restoreSandboxFromSnapshot falls back to createAndBootstrapSandbox when snapshotId is null", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    // Set status to stopped but with NO snapshotId — should fall back to create
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = null;
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    _setAiGatewayTokenOverrideForTesting("test-key");
    try {
      let scheduledCallback: (() => Promise<void> | void) | null = null;

      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "fallback-test",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      // Without snapshotId AND with status "stopped" (not "uninitialized"),
      // scheduleLifecycleWork picks "creating" path since snapshotId is null
      const metaBefore = await getInitializedMeta();
      assert.equal(metaBefore.status, "creating", "Should pick 'creating' when no persistent sandbox exists");

      assert.ok(scheduledCallback);
      await (scheduledCallback as () => Promise<void>)();

      // The create path runs setupOpenClaw which does npm install + writeFiles (9 files)
      assert.ok(fake.created.length >= 1, "Should have created a sandbox");
      const handle = fake.created[0];

      // Create path runs npm install as first command
      const npmCmd = handle.commands.find(
        (c) => c.cmd === "npm" && c.args?.[0] === "install",
      );
      assert.ok(npmCmd, "Create path should run npm install (bootstrap)");
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: markSandboxUnavailable
// ---------------------------------------------------------------------------

test("[lifecycle] markSandboxUnavailable with snapshotId -> transitions to stopped", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-mark-unavail";
      meta.snapshotId = "snap-existing";
    });

    const result = await markSandboxUnavailable("sandbox crashed");
    assert.equal(result.status, "stopped");
    assert.equal(result.sandboxId, null);
    assert.equal(result.portUrls, null);
    assert.equal(result.lastError, "sandbox crashed");
    // snapshotId should be preserved
    assert.equal(result.snapshotId, "snap-existing");
  });
});

test("[lifecycle] markSandboxUnavailable without snapshotId -> transitions to error", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-mark-unavail-2";
      meta.snapshotId = null;
    });

    const result = await markSandboxUnavailable("fatal issue");
    assert.equal(result.status, "error");
    assert.equal(result.sandboxId, null);
    assert.equal(result.lastError, "fatal issue");
  });
});

test("[lifecycle] markSandboxUnavailable skips stale sandbox invalidation when sandboxId changed", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-fresh";
      meta.snapshotId = "snap-existing";
      meta.portUrls = { "3000": "https://sbx-fresh-3000.fake.vercel.run" };
      meta.lastError = null;
    });

    _resetLogBuffer();

    const result = await markSandboxUnavailable(
      "sandbox crashed",
      "sbx-stale",
    );

    assert.equal(result.status, "running");
    assert.equal(result.sandboxId, "sbx-fresh");
    assert.deepEqual(result.portUrls, {
      "3000": "https://sbx-fresh-3000.fake.vercel.run",
    });
    assert.equal(result.lastError, null);

    const staleLog = getServerLogs().find(
      (entry) => entry.message === "sandbox.mark_unavailable_skipped_stale",
    );
    assert.ok(staleLog, "Should emit sandbox.mark_unavailable_skipped_stale");
    assert.equal(staleLog.data?.expectedSandboxId, "sbx-stale");
    assert.equal(staleLog.data?.actualSandboxId, "sbx-fresh");
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: stopSandbox 409 with no sandboxId
// ---------------------------------------------------------------------------

test("[lifecycle] stopSandbox with no sandboxId -> throws 409 ApiError", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "error";
      meta.sandboxId = null;
      meta.snapshotId = null;
    });

    await assert.rejects(
      () => stopSandbox(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok("status" in error);
        assert.equal((error as { status: number }).status, 409);
        assert.ok(error.message.includes("not running"));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: probeGatewayReady success transition (booting -> running)
// ---------------------------------------------------------------------------

test("[lifecycle] probeGatewayReady booting + ready -> transitions to running", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "booting";
      meta.sandboxId = "sbx-probe-boot";
      meta.portUrls = { "3000": "https://sbx-probe-boot-3000.fake.vercel.run" };
      meta.gatewayToken = "test-token";
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const result = await probeGatewayReady();
      assert.equal(result.ready, true);
      assert.equal(result.markerFound, true);
      assert.equal(result.statusCode, 200);

      // Should have transitioned to running
      const meta = await getInitializedMeta();
      assert.equal(meta.status, "running");
      assert.equal(meta.lastError, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("[lifecycle] probeGatewayReady setup + ready -> transitions to running", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "setup";
      meta.sandboxId = "sbx-probe-setup";
      meta.portUrls = { "3000": "https://sbx-probe-setup-3000.fake.vercel.run" };
      meta.gatewayToken = "test-token";
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const result = await probeGatewayReady();
      assert.equal(result.ready, true);

      const meta = await getInitializedMeta();
      assert.equal(meta.status, "running");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: touchRunningSandbox extend timeout error handling
// ---------------------------------------------------------------------------

test("[lifecycle] cron alive-through force-extends timeout despite touch throttle", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const now = Date.now();
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-cron-alive-through";
      meta.lastAccessedAt = now;
    });
    const handle = new FakeSandboxHandle(
      "sbx-cron-alive-through",
      fake.events,
      30_000,
    );
    fake.handlesByIds.set("sbx-cron-alive-through", handle);

    const deadlineMs = now + 4 * 60_000;
    const result = await ensureSandboxAliveThrough(deadlineMs);
    assert.equal(result.status, "running");
    assert.ok(handle.timeoutRemaining >= deadlineMs - Date.now() - 1_000);
    assert.equal(fake.getCalls.at(-1)?.resume, false);
  });
});

test("[lifecycle] cron alive-through uses aged session remaining time, not default timeout", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const now = Date.now();
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-cron-aged-session";
      meta.lastAccessedAt = now;
    });
    const handle = new FakeSandboxHandle(
      "sbx-cron-aged-session",
      fake.events,
      30 * 60_000,
    );
    handle.setSessionAgeMsForTesting(29 * 60_000);
    fake.handlesByIds.set("sbx-cron-aged-session", handle);

    const deadlineMs = now + 10 * 60_000;
    await ensureSandboxAliveThrough(deadlineMs);
    assert.ok(handle.extendedTimeouts[0]! >= 8 * 60_000);
    assert.ok(handle.timeoutRemaining >= deadlineMs - Date.now() - 1_000);
  });
});

test("[lifecycle] cron alive-through accounts for extension request latency", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const now = Date.now();
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-cron-delayed-extension";
      meta.lastAccessedAt = now;
    });
    const handle = new FakeSandboxHandle(
      "sbx-cron-delayed-extension",
      fake.events,
      30_000,
    );
    const extendTimeout = handle.extendTimeout.bind(handle);
    handle.extendTimeout = async (duration) => {
      await extendTimeout(duration);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    };
    fake.handlesByIds.set("sbx-cron-delayed-extension", handle);

    const deadlineMs = now + 4 * 60_000;
    const result = await ensureSandboxAliveThrough(deadlineMs);
    assert.equal(result.status, "running");
    assert.ok(handle.timeoutRemaining >= deadlineMs - Date.now() - 1_000);
  });
});

test("[lifecycle] touchRunningSandbox extend timeout throws -> marks sandbox unavailable", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-extend-error";
      meta.lastAccessedAt = null;
    });

    // Make the extendTimeout throw — use a low timeout so the top-up logic
    // actually attempts an extension (target - remaining > 0).
    const handle = new FakeSandboxHandle("sbx-extend-error", fake.events, 60_000);
    handle.extendTimeout = async () => {
      throw new Error("some network error");
    };
    fake.handlesByIds.set("sbx-extend-error", handle);

    const result = await touchRunningSandbox();
    // Non-sandbox_timeout_invalid errors now mark the sandbox as unavailable
    // (status transitions according to whether manual checkpoint metadata exists)
    assert.ok(
      result.status === "error" || result.status === "stopped",
      `Expected error or stopped status, got: ${result.status}`,
    );
    assert.ok(result.lastError, "lastError should be set");
    assert.ok(result.lastError!.includes("extend timeout failed"), "lastError should reference extend timeout");
  });
});

test("[lifecycle] touchRunningSandbox sandbox_timeout_invalid error -> silently ignored", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-timeout-invalid";
      meta.lastAccessedAt = null;
    });

    const handle = new FakeSandboxHandle("sbx-timeout-invalid", fake.events, 60_000);
    handle.extendTimeout = async () => {
      throw new Error("sandbox_timeout_invalid");
    };
    fake.handlesByIds.set("sbx-timeout-invalid", handle);

    const result = await touchRunningSandbox();
    assert.equal(result.status, "running");
    assert.ok(result.lastAccessedAt);
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: touchRunningSandbox token refresh paths
// ---------------------------------------------------------------------------

test("[lifecycle] ensureFreshGatewayToken: skips refresh when meta TTL is sufficient", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-token-skip";
      meta.lastAccessedAt = null;
      meta.lastTokenRefreshAt = Date.now();
      // Token expires 30 minutes from now — well above the 10-minute default threshold.
      meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) + 30 * 60;
      meta.lastTokenSource = "oidc";
    });

    const result = await ensureFreshGatewayToken();
    assert.equal(result.reason, "meta-ttl-sufficient", "Should short-circuit on persisted meta TTL");
    assert.equal(result.refreshed, false);

    // No shell commands should have been issued.
    const handle = fake.handlesByIds.get("sbx-token-skip");
    if (handle) {
      const shCmd = (handle as FakeSandboxHandle).commands.find(
        (c) => c.cmd === "sh" && c.args?.[0] === "-c",
      );
      assert.equal(shCmd, undefined, "Should not attempt token refresh when meta TTL sufficient");
    }
  });
});

test("[lifecycle] ensureFreshGatewayToken: triggers refresh when meta TTL expired", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    _setAiGatewayTokenOverrideForTesting("fresh-token-val");

    try {
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-token-refresh";
        meta.lastAccessedAt = null;
        meta.lastTokenRefreshAt = Date.now() - 15 * 60 * 1000;
        // Token expired 5 minutes ago — below the 10-minute threshold.
        meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) - 5 * 60;
        meta.lastTokenSource = "oidc";
      });

      await ensureFreshGatewayToken();

      const handle = fake.handlesByIds.get("sbx-token-refresh") as FakeSandboxHandle | undefined;
      if (handle) {
        assert.ok(
          handle.networkPolicies.length >= 1,
          "Should attempt token refresh via network policy update when meta TTL expired",
        );
      }
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("[lifecycle] ensureFreshGatewayToken: updates network policy with fresh token (no disk write or restart)", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    _setAiGatewayTokenOverrideForTesting("fresh-oidc-token");

    try {
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-refresh-script";
        meta.lastAccessedAt = null;
        meta.lastTokenRefreshAt = Date.now() - 15 * 60 * 1000;
        meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) - 5 * 60;
        meta.lastTokenSource = "oidc";
      });

      await ensureFreshGatewayToken();

      const handle = fake.handlesByIds.get("sbx-refresh-script") as FakeSandboxHandle | undefined;
      assert.ok(handle, "Handle should exist");

      // Token refresh now updates the network policy instead of writing to disk
      assert.ok(
        handle.networkPolicies.length >= 1,
        "Should update network policy with fresh token",
      );

      // No disk write or gateway restart needed
      const writeCmd = handle.commands.find(
        (c) => c.cmd === "sh" && c.args?.[0] === "-c",
      );
      assert.equal(writeCmd, undefined, "Should not write token to disk");

      const restartCmd = handle.commands.find(
        (c) => c.cmd === "bash" && c.args?.[0] === OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH,
      );
      assert.equal(restartCmd, undefined, "Should not restart gateway");

      // Metadata updated
      const meta = await getInitializedMeta();
      assert.ok(
        meta.lastTokenRefreshAt !== null && meta.lastTokenRefreshAt > Date.now() - 5000,
        "lastTokenRefreshAt should be updated to recent time",
      );
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("[lifecycle] token refresh preserves an explicit control-plane origin", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    _setAiGatewayTokenOverrideForTesting("fresh-token");
    const handle = new FakeSandboxHandle("sbx-origin-refresh", fake.events);
    fake.handlesByIds.set(handle.sandboxId, handle);

    try {
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = handle.sandboxId;
        meta.firewall.mode = "enforcing";
        meta.firewall.allowlist = ["registry.npmjs.org"];
        meta.lastTokenRefreshAt = Date.now() - 15 * 60_000;
        meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) - 5 * 60;
        meta.lastTokenSource = "oidc";
      });

      await ensureFreshGatewayToken({
        force: true,
        controlPlaneOrigin: "https://wake.example.com",
      });

      const policy = handle.networkPolicies.at(-1) as {
        allow: Record<string, unknown[]>;
      };
      assert.deepEqual(Object.keys(policy.allow).sort(), [
        "ai-gateway.vercel.sh",
        "registry.npmjs.org",
        "wake.example.com",
      ]);
      assert.deepEqual(
        (await getInitializedMeta()).firewall.allowlist,
        ["registry.npmjs.org"],
      );
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("[lifecycle] ensureFreshGatewayToken: no OIDC token available -> skips silently", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    // Set override to undefined = "return undefined from getAiGatewayBearerTokenOptional"
    // (null means "no override, use real logic")
    _setAiGatewayTokenOverrideForTesting(undefined);

    try {
      const staleRefreshTime = Date.now() - 15 * 60 * 1000;
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-no-oidc";
        meta.lastAccessedAt = null;
        meta.lastTokenRefreshAt = staleRefreshTime;
        meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) - 5 * 60;
        meta.lastTokenSource = "oidc";
      });

      await ensureFreshGatewayToken();

      const handle = fake.handlesByIds.get("sbx-no-oidc") as FakeSandboxHandle | undefined;
      if (handle) {
        const shCmd = handle.commands.find(
          (c) => c.cmd === "sh" && c.args?.[0] === "-c",
        );
        assert.equal(shCmd, undefined, "Should not write token when OIDC unavailable");
      }

      const meta = await getInitializedMeta();
      assert.equal(
        meta.lastTokenRefreshAt,
        staleRefreshTime,
        "lastTokenRefreshAt should not be updated when token unavailable",
      );
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("[lifecycle] ensureFreshGatewayToken: policy update failure fences and stops the sandbox", async () => {
  const fake = new FakeSandboxController();

  await withTestEnv(fake, async () => {
    _setAiGatewayTokenOverrideForTesting("fresh-token");

    try {
      const refreshTime = Date.now() - 15 * 60 * 1000;
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-policy-fail";
        meta.lastAccessedAt = null;
        meta.lastTokenRefreshAt = refreshTime;
        meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) - 5 * 60;
        meta.lastTokenSource = "oidc";
      });

      // Pre-create the handle with a failing network policy update
      const handle = new FakeSandboxHandle("sbx-policy-fail", fake.events);
      handle.networkPolicyHandler = async () => {
        throw new Error("network policy update failed");
      };
      fake.handlesByIds.set("sbx-policy-fail", handle);

      const result = await ensureFreshGatewayToken();

      assert.equal(result.refreshed, false);
      assert.equal(result.reason, "sandbox-changed");
      const meta = await getInitializedMeta();
      assert.equal(meta.status, "error");
      assert.equal(meta.lastError, FIREWALL_FAIL_CLOSED_LAST_ERROR);
      assert.equal(
        meta.lastTokenRefreshAt,
        refreshTime,
        "lastTokenRefreshAt should not be updated on failure",
      );
      assert.equal(handle.stopCalled, true);
      assert.equal((await readHostSuspensionState())?.phase, "stopped");
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("[lifecycle] ensureFreshGatewayToken: does NOT force-pair after restart", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    _setAiGatewayTokenOverrideForTesting("check-pair-token");

    try {
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-check-pair";
        meta.lastAccessedAt = null;
        meta.lastTokenRefreshAt = Date.now() - 15 * 60 * 1000;
        meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) - 5 * 60;
        meta.lastTokenSource = "oidc";
      });

      await ensureFreshGatewayToken();

      const handle = fake.handlesByIds.get("sbx-check-pair") as FakeSandboxHandle | undefined;
      assert.ok(handle, "Handle should exist");

      // Token refresh uses the detached restart path which does not
      // touch pairing state — verify force-pair is NOT invoked.
      const pairCmd = handle.commands.find(
        (c) => c.cmd === "node" && c.args?.[0] === OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
      );
      assert.equal(pairCmd, undefined, "Token refresh should not force-pair after gateway restart");
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

// ---------------------------------------------------------------------------
test("[lifecycle] ensureFreshGatewayToken: force=true bypasses throttle", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    _setAiGatewayTokenOverrideForTesting("forced-token");

    try {
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-force-refresh";
        meta.lastAccessedAt = null;
        meta.lastTokenRefreshAt = Date.now();
        // Token expires 30 minutes from now — sufficient TTL.
        meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) + 30 * 60;
        meta.lastTokenSource = "oidc";
      });

      // Without force, should skip
      await ensureFreshGatewayToken();
      let handle = fake.handlesByIds.get("sbx-force-refresh") as FakeSandboxHandle | undefined;
      const policyCountBefore = handle?.networkPolicies.length ?? 0;

      // With force, should refresh even though interval not elapsed
      await ensureFreshGatewayToken({ force: true });
      handle = fake.handlesByIds.get("sbx-force-refresh") as FakeSandboxHandle | undefined;
      assert.ok(handle, "Handle should exist");

      assert.ok(
        handle.networkPolicies.length > policyCountBefore,
        "Should update network policy when force=true",
      );
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("[lifecycle] ensureFreshGatewayToken: updates network policy and metadata on refresh", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    _setAiGatewayTokenOverrideForTesting("same-token");

    try {
      const handle = new FakeSandboxHandle("sbx-same-token", fake.events);
      fake.handlesByIds.set("sbx-same-token", handle);

      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-same-token";
        meta.lastAccessedAt = null;
        meta.lastTokenRefreshAt = Date.now() - 15 * 60 * 1000;
        meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) - 5 * 60;
        meta.lastTokenSource = "oidc";
      });

      await ensureFreshGatewayToken();

      // Network policy updated with the fresh token transform
      assert.ok(
        handle.networkPolicies.length >= 1,
        "Should update network policy on token refresh",
      );

      // No gateway restart or disk writes
      const restartCmd = handle.commands.find(
        (c) => c.cmd === "bash" && c.args?.[0] === OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH,
      );
      assert.equal(restartCmd, undefined, "Should not restart gateway");

      // lastTokenRefreshAt should be updated
      const meta = await getInitializedMeta();
      assert.ok(
        meta.lastTokenRefreshAt !== null && meta.lastTokenRefreshAt > Date.now() - 5000,
        "lastTokenRefreshAt should be updated",
      );
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

// ---------------------------------------------------------------------------
// ensureUsableAiGatewayCredential: meta-only TTL authority
// ---------------------------------------------------------------------------

test("[lifecycle] ensureUsableAiGatewayCredential: returns meta-ttl-sufficient when lastTokenExpiresAt is fresh", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-ttl-fresh";
      meta.lastTokenRefreshAt = Date.now();
      meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) + 30 * 60;
      meta.lastTokenSource = "oidc";
    });

    const result = await ensureUsableAiGatewayCredential();
    assert.equal(result.refreshed, false);
    assert.equal(result.reason, "meta-ttl-sufficient");
  });
});

test("[lifecycle] ensureUsableAiGatewayCredential: proceeds to refresh when meta TTL stale despite fresh OIDC token", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    // Function has a fresh OIDC token, but persisted meta says token is expired.
    _setAiGatewayTokenOverrideForTesting("fresh-oidc-token");

    try {
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-stale-meta";
        meta.lastTokenRefreshAt = Date.now() - 60 * 60 * 1000;
        meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) - 5 * 60;
        meta.lastTokenSource = "oidc";
      });

      const result = await ensureUsableAiGatewayCredential();
      // Should have attempted a refresh (not short-circuited).
      assert.equal(result.refreshed, true);
      assert.equal(result.reason, "refreshed");
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("[lifecycle] ensureUsableAiGatewayCredential: null lastTokenExpiresAt proceeds to refresh", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    _setAiGatewayTokenOverrideForTesting("fresh-oidc-token");

    try {
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-null-expiry";
        meta.lastTokenRefreshAt = Date.now();
        meta.lastTokenExpiresAt = null;
        meta.lastTokenSource = "oidc";
      });

      const result = await ensureUsableAiGatewayCredential();
      // null expiresAt means TTL unknown — should proceed to refresh.
      assert.equal(result.refreshed, true);
      assert.equal(result.reason, "refreshed");
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("[lifecycle] token refresh cannot mutate a replaced lifecycle generation", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const oldSandboxId = "sbx-token-old";
    const replacementSandboxId = "sbx-token-replacement";
    const oldHandle = new FakeSandboxHandle(oldSandboxId, fake.events);
    fake.handlesByIds.set(oldSandboxId, oldHandle);
    _setAiGatewayTokenOverrideForTesting("fresh-oidc-token");
    try {
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = oldSandboxId;
        meta.lifecycleAttemptId = "attempt-token-old";
        meta.lastTokenRefreshAt = null;
        meta.lastTokenExpiresAt = null;
        meta.lastTokenSource = null;
      });
      let lookup: { sandboxId: string; resume?: boolean } | undefined;
      fake.get = async (input) => {
        lookup = input;
        await mutateMeta((meta) => {
          meta.status = "running";
          meta.sandboxId = replacementSandboxId;
          meta.lifecycleAttemptId = "attempt-token-replacement";
          meta.lastTokenRefreshAt = 123;
          meta.lastTokenExpiresAt = 456;
          meta.lastTokenSource = "oidc";
        });
        return oldHandle;
      };

      const result = await ensureUsableAiGatewayCredential({ force: true });
      const meta = await getInitializedMeta();

      assert.deepEqual(lookup, { sandboxId: oldSandboxId, resume: false });
      assert.equal(result.refreshed, false);
      assert.equal(result.reason, "sandbox-changed");
      assert.deepEqual(oldHandle.networkPolicies, []);
      assert.equal(meta.sandboxId, replacementSandboxId);
      assert.equal(meta.lifecycleAttemptId, "attempt-token-replacement");
      assert.equal(meta.lastTokenRefreshAt, 123);
      assert.equal(meta.lastTokenExpiresAt, 456);
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("[lifecycle] token refresh holds the firewall apply lock after lifecycle lease loss", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const sandboxId = "sbx-token-apply-lock";
    const handle = new FakeSandboxHandle(sandboxId, fake.events);
    fake.handlesByIds.set(sandboxId, handle);
    _setAiGatewayTokenOverrideForTesting("fresh-oidc-token");
    const store = getStore();
    const originalAcquireLock = store.acquireLock.bind(store);
    let lifecycleToken: string | null = null;
    const acquiredKeys: string[] = [];
    store.acquireLock = async (key, ttlSeconds) => {
      const token = await originalAcquireLock(key, ttlSeconds);
      acquiredKeys.push(key);
      if (key === lifecycleLockKey() && token && !lifecycleToken) {
        lifecycleToken = token;
      }
      return token;
    };
    let signalApplyStarted!: () => void;
    let releaseApply!: () => void;
    const applyStarted = new Promise<void>((resolve) => {
      signalApplyStarted = resolve;
    });
    const applyGate = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    handle.networkPolicyHandler = async (policy) => {
      signalApplyStarted();
      await applyGate;
      return policy;
    };

    try {
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = sandboxId;
        meta.lifecycleAttemptId = "attempt-token-apply-lock";
        meta.firewall.mode = "learning";
        meta.firewall.allowlist = ["registry.npmjs.org"];
        meta.lastTokenRefreshAt = null;
        meta.lastTokenExpiresAt = null;
        meta.lastTokenSource = "oidc";
      });

      const refresh = ensureUsableAiGatewayCredential({ force: true });
      await applyStarted;
      assert.ok(lifecycleToken);
      await store.releaseLock(lifecycleLockKey(), lifecycleToken);

      await assert.rejects(
        setFirewallMode("enforcing"),
        (error: unknown) => {
          assert.equal(
            (error as { code?: unknown }).code,
            "FIREWALL_POLICY_APPLY_IN_PROGRESS",
          );
          return true;
        },
      );
      releaseApply();
      await assert.rejects(
        refresh,
        /Sandbox lifecycle lock ownership was lost/,
      );
      assert.ok(acquiredKeys.includes(firewallPolicyApplyLockKey()));
      assert.equal(handle.networkPolicies.length, 1);
      assert.equal((await getInitializedMeta()).firewall.mode, "learning");
    } finally {
      releaseApply();
      store.acquireLock = originalAcquireLock;
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("[lifecycle] ensureUsableAiGatewayCredential: api-key source returns no-refresh-needed", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    // Set AI_GATEWAY_API_KEY env var to simulate api-key source
    process.env.AI_GATEWAY_API_KEY = "test-api-key";
    try {
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-api-key";
      });

      const result = await ensureUsableAiGatewayCredential();
      assert.equal(result.refreshed, false);
      assert.equal(result.reason, "api-key-no-refresh-needed");
    } finally {
      delete process.env.AI_GATEWAY_API_KEY;
    }
  });
});

// ---------------------------------------------------------------------------
// Q17: Circuit breaker opens after 3 consecutive failures, closes after timeout
// ---------------------------------------------------------------------------

test("[lifecycle] Q17: circuit breaker opens after 3 consecutive token refresh failures", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    // No OIDC token, no api-key — refreshAiGatewayToken throws.
    _setAiGatewayTokenOverrideForTesting(null);
    delete process.env.AI_GATEWAY_API_KEY;

    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-breaker";
      meta.lastTokenRefreshAt = Date.now() - 60 * 60 * 1000;
      meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) - 300; // expired
      meta.lastTokenSource = "oidc";
      meta.consecutiveTokenRefreshFailures = 0;
      meta.breakerOpenUntil = null;
    });

    // Three consecutive failures. Each triggers a real refresh attempt
    // because `force: true` and TTL is expired.
    for (let i = 1; i <= 3; i++) {
      const result = await ensureUsableAiGatewayCredential({ force: true, reason: "q17-test" });
      assert.equal(result.refreshed, false);
      assert.ok(
        typeof result.reason === "string" && result.reason.startsWith("refresh-failed"),
        `Attempt ${i} should have reason starting with "refresh-failed", got "${result.reason}"`,
      );
    }

    const afterThree = await getInitializedMeta();
    assert.equal(afterThree.consecutiveTokenRefreshFailures, 3);
    assert.ok(
      afterThree.breakerOpenUntil && afterThree.breakerOpenUntil > Date.now(),
      "Breaker should be open after 3 failures",
    );

    // 4th call with breaker open — must short-circuit to circuit-breaker-open.
    const breakerResult = await ensureUsableAiGatewayCredential({ force: true, reason: "q17-test" });
    assert.equal(breakerResult.refreshed, false);
    assert.equal(breakerResult.reason, "circuit-breaker-open");
    assert.ok(typeof breakerResult.retryAfterMs === "number" && breakerResult.retryAfterMs > 0);

    // Simulate breaker timeout expiring by clearing breakerOpenUntil.
    await mutateMeta((meta) => {
      meta.breakerOpenUntil = 1; // in the past
    });

    // Next call should attempt a refresh again (breaker closed), fail, and
    // keep the failure counter bumping.
    const afterTimeout = await ensureUsableAiGatewayCredential({ force: true, reason: "q17-test" });
    assert.equal(afterTimeout.refreshed, false);
    assert.ok(
      typeof afterTimeout.reason === "string" && afterTimeout.reason.startsWith("refresh-failed"),
      `After timeout, expected a new refresh attempt, got "${afterTimeout.reason}"`,
    );
  });
});

// ---------------------------------------------------------------------------
// Q18: Token TTL / breaker fields persist across resetSandbox
// ---------------------------------------------------------------------------

test("[lifecycle] Q18: clearSandboxRuntimeStateForReset clears token TTL fields", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    // Populate TTL fields and breaker state as if we had a live token.
    const expiresAtSec = Math.floor(Date.now() / 1000) + 1800;
    const lastRefresh = Date.now() - 60_000;
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = "sbx-ttl-reset";
      meta.snapshotId = null; // no snapshot — avoid deleteSnapshot API call
      meta.lastTokenRefreshAt = lastRefresh;
      meta.lastTokenExpiresAt = expiresAtSec;
      meta.lastTokenSource = "oidc";
      meta.lastTokenRefreshError = "prior error";
      meta.consecutiveTokenRefreshFailures = 2;
      meta.breakerOpenUntil = Date.now() + 30_000;
    });

    await resetSandbox(
      { origin: "http://localhost", reason: "q18-test" },
      { deleteSnapshot: async () => {} }, // stub: always succeeds
    );

    const afterReset = await getInitializedMeta();

    // Sandbox runtime fields DO get cleared.
    assert.equal(afterReset.sandboxId, null);
    assert.equal(afterReset.snapshotId, null);
    assert.equal(afterReset.status, "uninitialized");

    // Token TTL / breaker fields are now cleared on reset so that a fresh
    // sandbox does not inherit stale expiry / breaker state from the
    // destroyed one.
    assert.ok(
      afterReset.lastTokenRefreshAt === null || afterReset.lastTokenRefreshAt === undefined,
      "lastTokenRefreshAt cleared on reset",
    );
    assert.ok(
      afterReset.lastTokenExpiresAt === null || afterReset.lastTokenExpiresAt === undefined,
      "lastTokenExpiresAt cleared on reset",
    );
    assert.ok(
      afterReset.lastTokenSource === null || afterReset.lastTokenSource === undefined,
      "lastTokenSource cleared on reset",
    );
    assert.ok(
      afterReset.lastTokenRefreshError === null || afterReset.lastTokenRefreshError === undefined,
      "lastTokenRefreshError cleared on reset",
    );
    assert.equal(afterReset.consecutiveTokenRefreshFailures, 0, "consecutiveTokenRefreshFailures reset to 0");
    assert.ok(
      afterReset.breakerOpenUntil === null || afterReset.breakerOpenUntil === undefined,
      "breakerOpenUntil cleared on reset",
    );
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: stale booting/setup re-schedule
// ---------------------------------------------------------------------------

test("[lifecycle] ensureSandboxRunning re-schedules when status=booting and updatedAt is stale", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "booting";
      meta.sandboxId = "sbx-stale-boot";
    });

    const realNow = Date.now;
    const frozenNow = realNow.call(Date);
    Date.now = () => frozenNow + 6 * 60 * 1000;

    let scheduledCallback: (() => Promise<void> | void) | null = null;

    try {
      const result = await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "stale-booting-test",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      assert.equal(result.state, "waiting");
      assert.ok(scheduledCallback, "Background work should have been re-scheduled for stale booting");
    } finally {
      Date.now = realNow;
    }
  });
});

test("[lifecycle] ensureSandboxRunning re-schedules when status=setup and updatedAt is stale", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "setup";
      meta.sandboxId = "sbx-stale-setup";
    });

    const realNow = Date.now;
    const frozenNow = realNow.call(Date);
    Date.now = () => frozenNow + 6 * 60 * 1000;

    let scheduledCallback: (() => Promise<void> | void) | null = null;

    try {
      const result = await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "stale-setup-test",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      assert.equal(result.state, "waiting");
      assert.ok(scheduledCallback, "Background work should have been re-scheduled for stale setup");
    } finally {
      Date.now = realNow;
    }
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: getSandboxDomain throws when not running
// ---------------------------------------------------------------------------

test("[lifecycle] getSandboxDomain stopped -> throws 409", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = null;
    });

    await assert.rejects(
      () => getSandboxDomain(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok("status" in error);
        assert.equal((error as { status: number }).status, 409);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Failure-path tests
// ---------------------------------------------------------------------------

test("[failure] create failure sets status to error", async () => {
  const fake = new FakeSandboxController();

  // v2: lifecycle tries get() first, then falls back to create().
  // Override both to simulate a truly unavailable sandbox.
  fake.get = async () => {
    throw new Error("sandbox not found");
  };
  fake.create = async () => {
    throw new Error("sandbox creation exploded");
  };

  await withTestEnv(fake, async () => {
    // Status starts as "uninitialized" by default after reset
    let scheduledCallback: (() => Promise<void> | void) | null = null;

    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "create-failure-test",
      schedule(cb) {
        scheduledCallback = cb;
      },
    });

    assert.ok(scheduledCallback, "Background work should have been scheduled");
    await (scheduledCallback as () => Promise<void>)();

    const meta = await getInitializedMeta();
    assert.equal(meta.status, "error", "Status should be error after create failure");
    assert.ok(meta.lastError?.includes("sandbox creation exploded"), "lastError should contain the error message");
  });
});

test("[failure] bootstrap (setupOpenClaw) failure sets status to error", async () => {
  const fake = new FakeSandboxController();

  // v2: lifecycle tries get() first; override to fall through to create()
  fake.get = async () => {
    throw new Error("sandbox not found");
  };

  // Make npm install fail (simulating bootstrap failure)
  fake.defaultResponders.push((cmd) => {
    if (cmd === "npm") {
      throw new Error("npm install crashed");
    }
    return undefined;
  });

  await withTestEnv(fake, async () => {
    let scheduledCallback: (() => Promise<void> | void) | null = null;

    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "bootstrap-failure-test",
      schedule(cb) {
        scheduledCallback = cb;
      },
    });

    assert.ok(scheduledCallback, "Background work should have been scheduled");
    await (scheduledCallback as () => Promise<void>)();

    const meta = await getInitializedMeta();
    assert.equal(meta.status, "error", "Status should be error after bootstrap failure");
    assert.ok(meta.lastError, "lastError should be set after bootstrap failure");
  });
});

test("fresh bootstrap does not launch Gateway after lifecycle lease loss at firewall boundary", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const store = getStore();
    const renewLock = store.renewLock.bind(store);
    let loseLifecycleLease = false;
    store.renewLock = async (key, token, ttlSeconds) =>
      key === lifecycleLockKey() && loseLifecycleLease
        ? false
        : renewLock(key, token, ttlSeconds);
    const create = fake.create.bind(fake);
    fake.create = async (params) => {
      const handle = await create(params) as FakeSandboxHandle;
      handle.networkPolicyHandler = async (policy) => {
        loseLifecycleLease = true;
        return policy;
      };
      return handle;
    };

    try {
      _setAiGatewayTokenOverrideForTesting("test-ai-key");
      await runScheduledEnsure("fresh-bootstrap-lease-loss");
      const handle = [...fake.handlesByIds.values()][0];
      assert.ok(handle, "fresh sandbox should be created");
      assert.equal(
        handle.commands.some(
          (command) =>
            command.cmd === "bash"
            && command.args?.[0] === OPENCLAW_STARTUP_SCRIPT_PATH,
        ),
        false,
        "Gateway startup must not run after lifecycle ownership is lost",
      );
    } finally {
      store.renewLock = renewLock;
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("[failure] ambiguous stop failure remains snapshotting and fenced", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-snap-fail";
      meta.portUrls = { "3000": "https://sbx-snap-fail-3000.fake.vercel.run" };
    });

    // v2: stopSandbox calls stop(), not snapshot() — override stop() to throw
    const handle = new FakeSandboxHandle("sbx-snap-fail", fake.events);
    handle.stop = async () => {
      throw new Error("stop failed unexpectedly");
    };
    fake.handlesByIds.set("sbx-snap-fail", handle);

    const result = await stopSandbox();
    assert.equal(result.status, "snapshotting");
    const suspension = await getStore().getValue<HostSuspensionState>(
      hostSuspensionOperationKey(),
    );
    assert.equal(suspension?.phase, "stop-requesting");
    assert.equal(suspension?.ingressFenced, true);
  });
});

test("[failure] admitted bundle refuses platform stop when admin RPC is missing", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    configureBundleLifecycleTest();
    const sandboxId = "sbx-bundle-admin-rpc-missing";
    const lifecycleAttemptId = "attempt-bundle-admin-rpc-missing";
    const handle = new FakeSandboxHandle(sandboxId, fake.events);
    handle.responders.unshift((cmd, args) => {
      if (cmd !== "node" || !args?.includes("--input-type=module")) return undefined;
      return {
        exitCode: 0,
        output: async () => JSON.stringify({ status: 404, body: "Not Found" }),
      };
    });
    fake.handlesByIds.set(sandboxId, handle);
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = sandboxId;
      meta.lifecycleAttemptId = lifecycleAttemptId;
      meta.bundleIdentity = structuredClone(BUNDLE_ADMISSION.identity);
    });

    await assert.rejects(stopSandbox(), /admin-http-rpc plugin is not enabled/);

    const suspension = await readHostSuspensionState();
    assert.equal(handle.stopCalled, false, "required suspension failure must refuse platform stop");
    assert.equal(suspension?.sandboxId, sandboxId);
    assert.equal(suspension?.lifecycleAttemptId, lifecycleAttemptId);
    assert.equal(suspension?.phase, "preparing");
    assert.equal(suspension?.ingressFenced, true);
    assert.equal(suspension?.lastErrorCode, "ADMIN_RPC_NOT_INSTALLED");
  });
});

test("[failure] abandoned prepared suspension resumes admission after caller deadline", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const sandboxId = "sbx-abandoned-prepare";
    const handle = new FakeSandboxHandle(sandboxId, fake.events);
    fake.handlesByIds.set(sandboxId, handle);
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = sandboxId;
    });
    await getStore().setValue(
      hostSuspensionOperationKey(),
      hostSuspensionState(sandboxId, {
        phase: "prepared",
        stopRequestDeadlineAtMs: null,
        updatedAtMs: Date.now() - HOST_STOP_REQUEST_MAX_MS - 1,
      }),
    );

    const result = await reconcileSnapshottingStatus();
    const suspension = await getStore().getValue<HostSuspensionState>(
      hostSuspensionOperationKey(),
    );
    assert.equal(result.status, "running");
    assert.match(result.lastError ?? "", /admission resumed/i);
    assert.equal(suspension?.phase, "failed");
    assert.equal(suspension?.ingressFenced, false);
  });
});

test("[failure] gone sandbox clears orphaned suspension and deadline state", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const sandboxId = "sbx-gone-during-stop";
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = sandboxId;
      meta.portUrls = { "3000": `https://${sandboxId}-3000.fake.vercel.run` };
    });
    await getStore().setValue(
      hostSuspensionOperationKey(),
      hostSuspensionState(sandboxId, {
        phase: "stopped",
        stopRequestDeadlineAtMs: null,
        stoppedAtMs: Date.now(),
      }),
    );
    await getStore().setValue(
      sandboxDeadlineV2Key(),
      sandboxDeadlineState(sandboxId),
    );
    fake.get = async () => {
      throw new Error("404 sandbox not found");
    };

    const result = await stopSandbox();
    assert.equal(result.status, "uninitialized");
    assert.equal(result.sandboxId, null);
    assert.equal(
      await getStore().getValue(hostSuspensionOperationKey()),
      null,
    );
    assert.equal(await getStore().getValue(sandboxDeadlineV2Key()), null);
  });
});

test("[failure] unrelated lookup error containing 404 does not project stopped", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const sandboxId = "sbx-transient-lookup";
    await mutateMeta((meta) => {
      meta.status = "snapshotting";
      meta.sandboxId = sandboxId;
    });
    fake.get = async () => {
      throw new Error("transient lookup failed after reading 404 records");
    };

    const result = await reconcileSnapshottingStatus();
    assert.equal(result.status, "snapshotting");
    assert.equal(result.sandboxId, sandboxId);
  });
});

test("[failure] restore failure from stopped state (fast-restore script fails)", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  // Make bash fast-restore-script command return non-zero exit code
  fake.defaultResponders.push((cmd, args) => {
    if (
      cmd === "bash"
      && args?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH
      && args[2] === "start"
    ) {
      return { exitCode: 1, output: async () => "fast-restore script failed" };
    }
    return undefined;
  });

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-restore-startup-fail";
      meta.gatewayToken = "test-gw-token";
    });

    // Pre-register a resumed handle so the fast-restore path is taken
    preRegisterResumeHandle(fake);

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      let scheduledCallback: (() => Promise<void> | void) | null = null;

      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "restore-startup-fail-test",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      assert.ok(scheduledCallback);
      await (scheduledCallback as () => Promise<void>)();

      const meta = await getInitializedMeta();
      assert.equal(meta.status, "error", "Status should be error after fast-restore script failure");
      assert.ok(meta.lastError?.includes("fast-restore-script"), "lastError should mention fast-restore failure");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("[failure] credential writeFiles failure does not block restore (env-based tokens)", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  // Make writeFiles throw on credential file paths — this should be
  // non-fatal because the gateway reads tokens from env vars passed at
  // sandbox create time.
  let writeFilesCallCount = 0;
  fake.onWriteFiles = (files) => {
    writeFilesCallCount++;
    if (writeFilesCallCount === 1 && files.some((f) => f.path.includes(".gateway-token"))) {
      throw new Error("writeFiles failed: permission denied");
    }
  };

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-restore-token-fail";
      meta.gatewayToken = "test-gw-token";
    });

    // Pre-register a resumed handle so the fast-restore path is taken
    preRegisterResumeHandle(fake);

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    _setAiGatewayTokenOverrideForTesting("test-key");
    try {
      let scheduledCallback: (() => Promise<void> | void) | null = null;

      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "restore-token-write-fail-test",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      assert.ok(scheduledCallback);
      await (scheduledCallback as () => Promise<void>)();

      const meta = await getInitializedMeta();
      // Restore should succeed despite credential file write failure —
      // the gateway uses env-provided tokens.
      assert.equal(meta.status, "running", "Status should be running (env tokens used)");
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
      fake.onWriteFiles = undefined;
    }
  });
});

test("[failure] concurrent ensureSandboxRunning from error status creates only one sandbox", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "error";
      meta.lastError = "previous failure";
      meta.sandboxId = null;
      meta.snapshotId = "snap-error-concurrent";
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const callbacks: Array<() => Promise<void> | void> = [];

      // Fire 2 concurrent calls
      await Promise.all(
        Array.from({ length: 2 }, (_, i) =>
          ensureSandboxRunning({
            origin: "https://test.example.com",
            reason: `error-concurrent-${i}`,
            schedule(cb) {
              callbacks.push(cb);
            },
          }),
        ),
      );

      // Only one callback should have been scheduled (start lock dedup)
      assert.equal(
        callbacks.length,
        1,
        `Expected exactly 1 scheduled callback from error state, got ${callbacks.length}`,
      );

      // Run the scheduled callback
      await Promise.all(callbacks.map((cb) => cb()));

      // v2: lifecycle tries get() first (resume), falls back to create().
      // Only one sandbox should have been used (via get or create).
      const totalHandles = fake.created.length + fake.retrieved.length;
      assert.ok(totalHandles >= 1, `Should have used at least one sandbox, got ${totalHandles} (created=${fake.created.length}, retrieved=${fake.retrieved.length})`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("[failure] ensureSandboxReady times out with 504 when gateway never shows openclaw-app marker", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-probe-timeout";
      meta.portUrls = { "3000": "https://sbx-probe-timeout-3000.fake.vercel.run" };
      meta.gatewayToken = "test-token";
    });

    // Always return HTML without the openclaw-app marker
    globalThis.fetch = async () =>
      new Response("<html><body>not ready yet</body></html>", { status: 200 });

    try {
      await assert.rejects(
        () =>
          ensureSandboxReady({
            origin: "https://test.example.com",
            reason: "probe-timeout-test",
            timeoutMs: 100,
            pollIntervalMs: 10,
          }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok("status" in error);
          assert.equal((error as { status: number }).status, 504);
          assert.ok(error.message.includes("did not become ready"));
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// reconcileSandboxHealth
// ---------------------------------------------------------------------------

test("reconcileSandboxHealth returns ready when gateway is reachable", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-healthy";
      meta.portUrls = { "3000": "https://sbx-healthy-3000.fake.vercel.run" };
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('<html><div id="openclaw-app"></div></html>', {
        status: 200,
      });

    try {
      const result = await reconcileSandboxHealth({
        origin: "https://test.example.com",
        reason: "test-healthy",
      });

      assert.equal(result.status, "ready");
      assert.equal(result.repaired, false);
      assert.equal(result.meta.status, "running");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("reconcileSandboxHealth returns recovering when token refresh fail-closes", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const sandboxId = "sbx-health-refresh-fail";
    const handle = new FakeSandboxHandle(sandboxId, fake.events);
    handle.networkPolicyHandler = async () => {
      throw new Error("policy update failed");
    };
    fake.handlesByIds.set(sandboxId, handle);
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = sandboxId;
      meta.lifecycleAttemptId = "attempt-health-refresh-fail";
      meta.portUrls = { "3000": handle.domain(3000) };
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('<html><div id="openclaw-app"></div></html>', {
        status: 200,
      });
    _setAiGatewayTokenOverrideForTesting("test-ai-key");

    try {
      const result = await reconcileSandboxHealth({
        origin: "https://test.example.com",
        reason: "refresh-fail-close",
      });
      assert.equal(result.status, "recovering");
      assert.equal(result.repaired, true);
      assert.notEqual(result.meta.status, "running");
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

test("reconcileSandboxHealth detects stale running and triggers recovery", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-stale";
      meta.snapshotId = "snap-for-recovery";
      meta.portUrls = { "3000": "https://sbx-stale-3000.fake.vercel.run" };
    });

    // Gateway probe fails — sandbox is gone
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };

    let scheduledWork: (() => Promise<void> | void) | null = null;

    try {
      const result = await reconcileSandboxHealth({
        origin: "https://test.example.com",
        reason: "test-stale-running",
        schedule(cb) {
          scheduledWork = cb;
        },
      });

      assert.equal(result.status, "recovering");
      assert.equal(result.repaired, true);
      // Meta should no longer say running (marked unavailable)
      const meta = await getInitializedMeta();
      assert.notEqual(meta.status, "running");
      // Recovery should have been scheduled
      assert.ok(scheduledWork, "Background recovery should have been scheduled");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("reconcileSandboxHealth delegates to ensureSandboxRunning when not running", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = null;
      meta.snapshotId = "snap-stopped";
    });

    let scheduledWork: (() => Promise<void> | void) | null = null;

    const result = await reconcileSandboxHealth({
      origin: "https://test.example.com",
      reason: "test-not-running",
      schedule(cb) {
        scheduledWork = cb;
      },
    });

    assert.equal(result.status, "recovering");
    assert.equal(result.repaired, false);
    assert.ok(scheduledWork, "Recovery should have been scheduled via ensureSandboxRunning");
    // Restore scheduling should immediately surface "restoring" when a snapshot exists.
    const meta = await getInitializedMeta();
    assert.equal(meta.status, "restoring");
  });
});

test("reconcileSandboxHealth concurrent calls are deduplicated by start lock", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = null;
      meta.snapshotId = "snap-concurrent";
    });

    const scheduled: Array<() => Promise<void> | void> = [];
    const schedule = (cb: () => Promise<void> | void) => {
      scheduled.push(cb);
    };

    // Fire two concurrent reconcile calls
    const [r1, r2] = await Promise.all([
      reconcileSandboxHealth({
        origin: "https://test.example.com",
        reason: "concurrent-1",
        schedule,
      }),
      reconcileSandboxHealth({
        origin: "https://test.example.com",
        reason: "concurrent-2",
        schedule,
      }),
    ]);

    // Both should return recovering
    assert.equal(r1.status, "recovering");
    assert.equal(r2.status, "recovering");

    // Only one background task should have been scheduled (start lock dedup)
    assert.equal(scheduled.length, 1, "Concurrent ensures should be deduplicated by the start lock");
  });
});

test("reconcileSandboxHealth with 410-style unreachable sandbox repairs correctly", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-410";
      meta.snapshotId = "snap-410-recovery";
      meta.portUrls = { "3000": "https://sbx-410-3000.fake.vercel.run" };
    });

    // Simulate a 410 Gone response from gateway probe
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("Gone", { status: 410 });

    let scheduledWork: (() => Promise<void> | void) | null = null;

    try {
      const result = await reconcileSandboxHealth({
        origin: "https://test.example.com",
        reason: "gateway.410",
        schedule(cb) {
          scheduledWork = cb;
        },
      });

      assert.equal(result.status, "recovering");
      assert.equal(result.repaired, true);
      assert.ok(scheduledWork, "Recovery should have been scheduled");

      // Verify meta was cleared and recovery is now surfaced as restoring.
      const meta = await getInitializedMeta();
      assert.equal(meta.sandboxId, null);
      assert.equal(meta.status, "restoring");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("reconcileSandboxHealth skips stale invalidation when sandbox was already replaced", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-stale";
      meta.snapshotId = "snap-replaced";
      meta.portUrls = { "3000": "https://sbx-stale-3000.fake.vercel.run" };
    });

    const originalFetch = globalThis.fetch;
    let scheduledWork: (() => Promise<void> | void) | null = null;

    globalThis.fetch = async () => {
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = "sbx-fresh";
        meta.portUrls = { "3000": "https://sbx-fresh-3000.fake.vercel.run" };
        meta.lastError = null;
      });
      throw new Error("ECONNREFUSED");
    };

    _resetLogBuffer();

    try {
      const result = await reconcileSandboxHealth({
        origin: "https://test.example.com",
        reason: "test-stale-replaced",
        schedule(cb) {
          scheduledWork = cb;
        },
      });

      assert.equal(result.status, "recovering");
      assert.equal(result.repaired, true);
      assert.equal(
        scheduledWork,
        null,
        "Late callers should not schedule a second recovery after another worker replaced the sandbox",
      );
      assert.equal(result.meta.sandboxId, "sbx-fresh");
      assert.equal(result.meta.status, "running");

      const meta = await getInitializedMeta();
      assert.equal(meta.sandboxId, "sbx-fresh");
      assert.equal(meta.status, "running");
      assert.deepEqual(meta.portUrls, {
        "3000": "https://sbx-fresh-3000.fake.vercel.run",
      });

      const staleLog = getServerLogs().find(
        (entry) => entry.message === "sandbox.mark_unavailable_skipped_stale",
      );
      assert.ok(staleLog, "Should emit sandbox.mark_unavailable_skipped_stale");
      assert.equal(staleLog.data?.expectedSandboxId, "sbx-stale");
      assert.equal(staleLog.data?.actualSandboxId, "sbx-fresh");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Lifecycle top-up timeout semantics (acceptance criteria)
// ---------------------------------------------------------------------------

test("touchRunningSandbox tops up to desired idle plus safety runway", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    process.env.OPENCLAW_SANDBOX_SLEEP_AFTER_MS = "300000";
    _resetSandboxSleepConfigCacheForTesting();

    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-topup-math";
      meta.lastAccessedAt = null;
    });

    // Pre-create handle with 120000ms remaining
    const handle = new FakeSandboxHandle("sbx-topup-math", fake.events, 120_000);
    Object.defineProperty(handle, "timeoutRemaining", {
      configurable: true,
      get: () => 120_000,
    });
    fake.handlesByIds.set("sbx-topup-math", handle);

    const result = await touchRunningSandbox();
    assert.equal(result.status, "running");
    assert.equal(handle.extendedTimeouts.length, 1, "Should extend timeout exactly once");
    assert.equal(handle.extendedTimeouts[0], 480_000, "Should extend by 600000 - 120000 = 480000");
    assert.deepEqual(handle.extendedTimeoutsWithoutResume, [480_000]);
  });
});

test("touchRunningSandbox returns current lifecycle state when deadline stop wins", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const sandboxId = "sbx-touch-deadline-race";
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = sandboxId;
      meta.lastAccessedAt = null;
    });
    fake.handlesByIds.set(
      sandboxId,
      new FakeSandboxHandle(sandboxId, fake.events, 600_000),
    );
    const store = getStore();
    const deadlineToken = await store.acquireLock(sandboxDeadlineLockKey(), 30);
    assert.ok(deadlineToken);

    const touch = touchRunningSandbox();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await mutateMeta((meta) => {
      meta.status = "snapshotting";
      meta.portUrls = null;
    });
    await store.releaseLock(sandboxDeadlineLockKey(), deadlineToken);

    const result = await touch;
    assert.equal(result.status, "snapshotting");
    assert.equal(result.sandboxId, sandboxId);
  });
});

test("touchRunningSandbox cannot extend or retire a replaced lifecycle generation", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const oldSandboxId = "sbx-touch-old";
    const replacementSandboxId = "sbx-touch-replacement";
    const oldHandle = new FakeSandboxHandle(oldSandboxId, fake.events, 120_000);
    fake.handlesByIds.set(oldSandboxId, oldHandle);
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = oldSandboxId;
      meta.lifecycleAttemptId = "attempt-touch-old";
      meta.lastAccessedAt = null;
    });
    let lookup: { sandboxId: string; resume?: boolean } | undefined;
    fake.get = async (input) => {
      lookup = input;
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = replacementSandboxId;
        meta.lifecycleAttemptId = "attempt-touch-replacement";
      });
      return oldHandle;
    };

    const result = await touchRunningSandbox();

    assert.deepEqual(lookup, { sandboxId: oldSandboxId, resume: false });
    assert.equal(result.status, "running");
    assert.equal(result.sandboxId, replacementSandboxId);
    assert.equal(result.lifecycleAttemptId, "attempt-touch-replacement");
    assert.deepEqual(oldHandle.extendedTimeouts, []);
  });
});

test("touchRunningSandbox does not extend when remaining exceeds the platform target", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    process.env.OPENCLAW_SANDBOX_SLEEP_AFTER_MS = "300000";
    _resetSandboxSleepConfigCacheForTesting();

    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-topup-skip";
      meta.lastAccessedAt = null;
    });

    // Desired idle is 300000ms and the stop runway is another 300000ms.
    const handle = new FakeSandboxHandle("sbx-topup-skip", fake.events, 720_000);
    fake.handlesByIds.set("sbx-topup-skip", handle);

    const result = await touchRunningSandbox();
    assert.equal(result.status, "running");
    assert.equal(handle.extendedTimeouts.length, 0, "Should NOT extend timeout when remaining >= target");
  });
});

test("touchRunningSandbox does not extend at the platform target exactly", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    process.env.OPENCLAW_SANDBOX_SLEEP_AFTER_MS = "300000";
    _resetSandboxSleepConfigCacheForTesting();

    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-topup-exact";
      meta.lastAccessedAt = null;
    });

    const handle = new FakeSandboxHandle("sbx-topup-exact", fake.events, 600_000);
    Object.defineProperty(handle, "timeoutRemaining", {
      configurable: true,
      get: () => 600_000,
    });
    fake.handlesByIds.set("sbx-topup-exact", handle);

    const result = await touchRunningSandbox();
    assert.equal(result.status, "running");
    assert.equal(handle.extendedTimeouts.length, 0, "Should NOT extend when remaining == target");
  });
});

test("touchRunningSandbox marks sandbox unavailable when controller.get() fails", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-lookup-fail";
      meta.lastAccessedAt = null;
      meta.snapshotId = "snap-for-recovery";
    });

    // Override get() to throw
    fake.get = async () => {
      throw new Error("sandbox not found");
    };

    const result = await touchRunningSandbox();
    assert.equal(result.status, "stopped", "Should transition to stopped with manual checkpoint metadata");
    assert.ok(result.lastError?.includes("sandbox lookup failed"), "lastError should mention lookup failure");
    assert.equal(result.sandboxId, null, "sandboxId should be cleared");
  });
});

test("create flow passes configured sleepAfterMs as timeout to controller.create()", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    process.env.OPENCLAW_SANDBOX_SLEEP_AFTER_MS = "300000";
    _resetSandboxSleepConfigCacheForTesting();

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      let scheduledCallback: (() => Promise<void> | void) | null = null;

      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "create-timeout-test",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      assert.ok(scheduledCallback);
      await (scheduledCallback as () => Promise<void>)();

      const handle = fake.created[0];
      assert.ok(handle, "Should have created a sandbox");
      // Native timeout includes the durable stop coordinator's safety runway.
      // (FakeSandboxHandle stores the timeout passed via params.timeout)
      // After create + bootstrap the handle may have had extendTimeout called,
      // so check the initial timeout via the created params instead.
      const totalTimeout = handle.timeout;
      const totalExtended = handle.extendedTimeouts.reduce((a, b) => a + b, 0);
      const initialTimeout = totalTimeout - totalExtended;
      assert.equal(initialTimeout, 600_000, "Create should include the 300000ms stop runway");
      assert.ok(
        Object.prototype.hasOwnProperty.call((await getInitializedMeta()).portUrls ?? {}, String(OPENCLAW_TELEGRAM_WEBHOOK_PORT)),
        `Create should expose port ${OPENCLAW_TELEGRAM_WEBHOOK_PORT} in portUrls`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("restore flow tops up a legacy persisted sandbox with the stop runway", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    process.env.OPENCLAW_SANDBOX_SLEEP_AFTER_MS = "300000";
    _resetSandboxSleepConfigCacheForTesting();

    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-timeout-test";
      meta.gatewayToken = "test-gw-token";
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { handle } = await triggerRestore(fake, {
        tokenOverride: "test-ai-key",
      });

      assert.ok(handle.timeout >= 600_000 && handle.timeout < 601_000);
      assert.equal(handle.extendedTimeouts.length, 1);
      assert.ok(
        handle.extendedTimeouts[0] >= 300_000
        && handle.extendedTimeouts[0] < 301_000,
      );
      const meta = await getInitializedMeta();
      assert.ok(
        Object.prototype.hasOwnProperty.call(meta.portUrls ?? {}, String(OPENCLAW_TELEGRAM_WEBHOOK_PORT)),
        `Restore should expose port ${OPENCLAW_TELEGRAM_WEBHOOK_PORT} in portUrls`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("getRunningSandboxTimeoutRemainingMs returns remaining ms for running sandbox", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-remaining";
    });

    const handle = new FakeSandboxHandle("sbx-remaining", fake.events, 250_000);
    fake.handlesByIds.set("sbx-remaining", handle);

    const remaining = await getRunningSandboxTimeoutRemainingMs();
    assert.ok(
      remaining !== null && remaining <= 250_000 && remaining > 249_000,
      `expected live remaining timeout near 250000ms, got ${remaining}`,
    );
  });
});

test("getRunningSandboxTimeoutRemainingMs returns null when not running", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = null;
    });

    const remaining = await getRunningSandboxTimeoutRemainingMs();
    assert.equal(remaining, null);
  });
});

// ---------------------------------------------------------------------------
// Correlated opId: concurrent wakes produce one restore with shared opId
// ---------------------------------------------------------------------------

test("concurrent ensureSandboxRunning with op context: exactly one restore, restore-phase logs share the winning opId", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-opid-concurrency";
    });

    _resetLogBuffer();

    const ops = Array.from({ length: 3 }, (_, i) =>
      createOperationContext({
        trigger: "channel.queue.consumer",
        reason: `concurrent-wake-${i}`,
        channel: i === 0 ? "slack" : i === 1 ? "telegram" : "discord",
      }),
    );

    const callbacks: Array<() => Promise<void> | void> = [];

    const results = await Promise.all(
      ops.map((op) =>
        ensureSandboxRunning({
          origin: "https://test.example.com",
          reason: op.reason,
          op,
          schedule(cb) {
            callbacks.push(cb);
          },
        }),
      ),
    );

    // All should return waiting
    for (const r of results) {
      assert.equal(r.state, "waiting");
    }

    // Exactly one scheduled callback (deduplicated by start lock)
    assert.equal(
      callbacks.length,
      1,
      `Expected exactly 1 scheduled callback, got ${callbacks.length}`,
    );

    // Execute the resume
    // Pre-register a handle for the persistent sandbox name so get() succeeds
    preRegisterResumeHandle(fake);
    await callbacks[0]();

    const meta = await getInitializedMeta();
    assert.equal(meta.status, "running", "Sandbox should be running after resume");

    // v2: persistent resume uses get() not create(source: snapshot),
    // so there are no "restore" events — verify via resume completion log instead.
    const logs = getServerLogs();
    const resumeLogs = logs.filter((l) =>
      l.message === "sandbox.create.persistent_resume.complete",
    );
    assert.equal(resumeLogs.length, 1, "Should produce exactly one persistent resume");

    // Verify resume logs contain opId from the winning operation
    const logsWithOpId = logs.filter((l) =>
      (l.message === "sandbox.create.persistent_resume" ||
       l.message === "sandbox.create.persistent_resume.complete" ||
       l.message === "sandbox.lifecycle.action_chosen") &&
      l.data?.opId,
    );
    assert.ok(
      logsWithOpId.length >= 1,
      `Expected at least 1 resume log with opId, got ${logsWithOpId.length}`,
    );

    // All resume logs with opId should share the same opId
    const opIds = [...new Set(logsWithOpId.map((l) => l.data?.opId as string))];
    assert.equal(
      opIds.length,
      1,
      `All resume logs should share one opId, got ${opIds.length}: ${JSON.stringify(opIds)}`,
    );

    // The winning opId should belong to one of our original operations
    const winningOpId = opIds[0];
    assert.ok(
      winningOpId.startsWith("op_"),
      `opId should have op_ prefix, got ${winningOpId}`,
    );

    // Verify the lifecycle.action_chosen log was emitted
    const actionLog = logs.find((l) => l.message === "sandbox.lifecycle.action_chosen");
    assert.ok(actionLog, "Should emit sandbox.lifecycle.action_chosen");
    assert.equal(actionLog.data?.action, "restoring");
    assert.ok(actionLog.data?.opId, "action_chosen should include opId");
  });
});

test("ensureSandboxRunning with op context includes opId in ensure_running log", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-opid-test";
    });

    fake.handlesByIds.set("sbx-opid-test", new FakeSandboxHandle("sbx-opid-test", fake.events));

    _resetLogBuffer();

    const op = createOperationContext({
      trigger: "channel.queue.consumer",
      reason: "channel:slack",
      channel: "slack",
    });

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "channel:slack",
      op,
    });

    assert.equal(result.state, "running");

    const logs = getServerLogs();
    const ensureLog = logs.find((l) => l.message === "sandbox.ensure_running");
    assert.ok(ensureLog, "Should emit sandbox.ensure_running");
    assert.equal(ensureLog.data?.opId, op.opId, "ensure_running should include the passed opId");
    assert.equal(ensureLog.data?.channel, "slack");
    assert.equal(ensureLog.data?.status, "running");
  });
});

// ---------------------------------------------------------------------------
// Fast-restore structured log tests
// ---------------------------------------------------------------------------

test("successful restore emits sandbox.create.persistent_resume.complete with structured context", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-log-result";
      meta.gatewayToken = "test-gw-token";
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    _setAiGatewayTokenOverrideForTesting("test-key");
    _resetLogBuffer();

    try {
      const { meta } = await triggerRestore(fake, { tokenOverride: "test-key" });
      assert.equal(meta.status, "running");

      const logs = getServerLogs();
      // v2: persistent resume logs completion instead of fast_restore_result
      const resultLog = logs.find(
        (l) => l.message === "sandbox.create.persistent_resume.complete",
      );
      assert.ok(resultLog, "Should emit sandbox.create.persistent_resume.complete");
      assert.equal(resultLog.level, "info");
      assert.ok(
        typeof resultLog.data?.totalMs === "number",
        "totalMs should be a number",
      );
      assert.ok(
        typeof resultLog.data?.startupScriptMs === "number",
        "startupScriptMs should be a number",
      );
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

test("successful restore records localReadyMs from fast-restore script stdout in metrics", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-log-ready";
      meta.gatewayToken = "test-gw-token";
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    _setAiGatewayTokenOverrideForTesting("test-key");
    _resetLogBuffer();

    try {
      const { meta } = await triggerRestore(fake, { tokenOverride: "test-key" });

      // v2: persistent resume records localReadyMs in metrics from fast-restore stdout
      assert.ok(meta.lastRestoreMetrics, "Should have restore metrics");
      // The fake fast-restore script returns {"ready":true,"attempts":3,"readyMs":150}
      assert.equal(meta.lastRestoreMetrics.localReadyMs, 150, "localReadyMs should be parsed from stdout");
      assert.ok(
        (meta.lastRestoreMetrics.postLocalReadyBlockingMs ?? -1) >= 0,
        "postLocalReadyBlockingMs should be recorded",
      );

      // Also verify the completion log was emitted
      const logs = getServerLogs();
      const completionLog = logs.find(
        (l) => l.message === "sandbox.create.persistent_resume.complete",
      );
      assert.ok(completionLog, "Should emit persistent_resume.complete");
      assert.equal(completionLog.data?.localReadyMs, 150);
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

test("successful restore records telegram listener readiness from fast-restore stdout in metrics", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  fake.defaultResponders.push((cmd, args) => {
    if (cmd === "bash" && args?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH) {
      const stdoutJson = JSON.stringify({
        ready: true,
        attempts: 4,
        readyMs: 220,
        telegramExpected: true,
        telegramConfigPresent: true,
        telegramReady: true,
        telegramStatus: 401,
        telegramWaitMs: 1800,
        telegramError: null,
      });
      return {
        exitCode: 0,
        output: async (stream?: "stdout" | "stderr" | "both") => {
          if (stream === "stdout") return stdoutJson;
          if (stream === "stderr") return '{"event":"fast_restore.telegram_probe"}';
          return `${stdoutJson}\n{"event":"fast_restore.telegram_probe"}`;
        },
      };
    }
    return undefined;
  });

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-tg-ready";
      meta.gatewayToken = "test-gw-token";
      meta.channels.telegram = {
        botToken: "tg-token",
        webhookSecret: "tg-secret",
        webhookUrl: "https://app.example.com/api/channels/telegram/webhook",
        botUsername: "test_bot",
        configuredAt: Date.now(),
      };
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });
    _resetLogBuffer();

    try {
      const { meta } = await triggerRestore(fake, { tokenOverride: "test-key" });

      assert.ok(meta.lastRestoreMetrics, "Should have restore metrics");
      assert.equal(meta.lastRestoreMetrics.telegramExpected, true);
      assert.equal(meta.lastRestoreMetrics.telegramConfigPresent, true);
      assert.equal(meta.lastRestoreMetrics.telegramListenerReady, true);
      assert.equal(meta.lastRestoreMetrics.telegramListenerStatus, 401);
      assert.equal(meta.lastRestoreMetrics.telegramListenerWaitMs, 1800);
      assert.equal(meta.lastRestoreMetrics.telegramListenerError, null);
      assert.equal(meta.lastRestoreMetrics.telegramReconcileBlocking, false);
      assert.equal(meta.lastRestoreMetrics.telegramSecretSyncBlocking, false);
      assert.equal(meta.lastRestoreMetrics.telegramReconcileMs, null);
      assert.equal(meta.lastRestoreMetrics.telegramSecretSyncMs, null);
      assert.ok(
        (meta.lastRestoreMetrics.postLocalReadyBlockingMs ?? -1) >= 0,
        "postLocalReadyBlockingMs should be recorded",
      );

      const logs = getServerLogs();
      const completionLog = [...logs].reverse().find(
        (entry) =>
          entry.message === "sandbox.create.persistent_resume.complete"
          && entry.data?.sandboxId === meta.sandboxId,
      );
      assert.ok(completionLog, "persistent resume completion should be logged");
      assert.equal(completionLog.data?.sandboxId, meta.sandboxId);
      assert.equal(typeof completionLog.data?.localReadyMs, "number");
      assert.equal(completionLog.data?.telegramExpected, true);
      assert.equal(completionLog.data?.telegramConfigPresent, true);
      assert.equal(completionLog.data?.telegramListenerReady, true);
      assert.equal(completionLog.data?.telegramListenerStatus, 401);
      assert.equal(completionLog.data?.telegramListenerWaitMs, 1800);
      assert.equal(completionLog.data?.telegramListenerError, null);
      assert.equal(completionLog.data?.startupScriptMs, meta.lastRestoreMetrics.startupScriptMs);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("non-zero fast-restore exit causes error status via lifecycle_failed", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  fake.defaultResponders.push((cmd, args) => {
    if (cmd === "bash" && args?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH) {
      return {
        exitCode: 1,
        output: async (stream?: "stdout" | "stderr" | "both") => {
          if (stream === "stdout") return "error output from script";
          if (stream === "stderr") return "stderr details";
          return "error output from script\nstderr details";
        },
      };
    }
    return undefined;
  });

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-log-fail";
      meta.gatewayToken = "test-gw-token";
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    _setAiGatewayTokenOverrideForTesting("test-key");
    _resetLogBuffer();

    try {
      let scheduledCallback: (() => Promise<void> | void) | null = null;

      // Pre-register the resume handle so get() succeeds
      preRegisterResumeHandle(fake);

      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "restore-fail-log-test",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      assert.ok(scheduledCallback);
      await (scheduledCallback as () => Promise<void>)();

      // v2: fast-restore failure bubbles up as lifecycle_failed
      const logs = getServerLogs();
      const failedLog = logs.find(
        (l) => l.message === "sandbox.lifecycle_failed",
      );
      assert.ok(failedLog, "Should emit sandbox.lifecycle_failed");
      assert.equal(failedLog.level, "error");
      assert.ok(
        typeof failedLog.data?.error === "string",
        "error should be present",
      );

      const meta = await getInitializedMeta();
      assert.equal(meta.status, "error");
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Restore metrics: background asset sync must not rewrite history
// ---------------------------------------------------------------------------

test("persistent resume records skippedStaticAssetSync=false and assetSha256=null in metrics", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-needs-background-assets";
      meta.gatewayToken = "test-gw-token";
      meta.snapshotDynamicConfigHash = null;
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      await triggerRestore(fake, { tokenOverride: "test-ai-key" });

      const meta = await getInitializedMeta();
      // v2: persistent resume path always records these fixed values
      assert.equal(
        meta.lastRestoreMetrics?.skippedStaticAssetSync,
        false,
        "persistent resume always reports skippedStaticAssetSync=false",
      );
      assert.equal(
        meta.lastRestoreMetrics?.assetSha256,
        null,
        "persistent resume records assetSha256=null (asset sync is inline, not tracked in metrics)",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// ensureRunningSandboxDynamicConfigFresh
// ---------------------------------------------------------------------------

test("ensureRunningSandboxDynamicConfigFresh returns already-fresh when hash matches", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    // Compute the expected hash from current (empty) channel state and set it.
    // Runtime reconcile compares against runtimeDynamicConfigHash.
    const expectedHash = computeGatewayConfigHash({});
    await h.mutateMeta((meta) => {
      meta.runtimeDynamicConfigHash = expectedHash;
    });

    const result = await ensureRunningSandboxDynamicConfigFresh({
      origin: "https://test.example.com",
    });

    assert.equal(result.verified, true, "Should be verified");
    assert.equal(result.changed, false, "Should not have changed anything");
    assert.equal(result.reason, "already-fresh");

    // No gateway restart should have happened.
    const meta = await h.getMeta();
    const handle = h.controller.created.find(
      (c) => c.sandboxId === meta.sandboxId,
    ) as FakeSandboxHandle | undefined;
    assert.equal(
      handle?.commands.filter(
        (c) => c.cmd === "bash" && c.args?.[0] === OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH,
      ).length ?? 0,
      0,
      "No gateway restart should happen on hash match",
    );
  });
});

test("syncGatewayConfigToSandbox waits for Slack route registration after restart", async () => {
  await withHarness(async (h) => {
    process.env.NEXT_PUBLIC_BASE_DOMAIN = "test.example.com";
    await h.driveToRunning();
    await h.mutateMeta((meta) => {
      meta.channels.slack = {
        signingSecret: "test-slack-signing-secret",
        botToken: "xoxb-test-slack-bot-token",
        configuredAt: Date.now(),
      };
    });

    const meta = await h.getMeta();
    assert.ok(meta.sandboxId, "sandbox should be running");
    const handle = h.controller.getHandle(meta.sandboxId);
    assert.ok(handle, "sandbox handle should exist");

    let slackRouteProbeCount = 0;
    handle.responders.push((cmd, args) => {
      if (cmd !== "bash" || args?.[0] !== "-c") {
        return undefined;
      }
      const script = args[1] ?? "";
      if (script.includes(`http://localhost:3000/`) && script.includes("openclaw-app")) {
        return { exitCode: 0, output: async () => "ok" };
      }
      if (script.includes("/slack/events")) {
        slackRouteProbeCount += 1;
        const status = slackRouteProbeCount >= 3 ? "401" : "404";
        return { exitCode: 0, output: async () => status };
      }
      return undefined;
    });

    const result = await syncGatewayConfigToSandbox();

    assert.equal(result.outcome, "applied");
    assert.equal(result.reason, "config_written_and_restarted");
    assert.equal(slackRouteProbeCount, 3);
    assert.ok(
      handle.commands.some(
        (c) => c.cmd === "bash" && c.args?.[0] === OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH,
      ),
      "Gateway should be restarted before Slack route readiness is checked",
    );
  });
});

test("syncGatewayConfigToSandbox waits for Telegram listener registration after restart", async () => {
  await withHarness(async (h) => {
    process.env.NEXT_PUBLIC_BASE_DOMAIN = "test.example.com";
    await h.driveToRunning();
    await h.mutateMeta((meta) => {
      meta.channels.telegram = {
        botToken: "tg-token",
        webhookSecret: "tg-secret",
        webhookUrl: "https://app.example.com/api/channels/telegram/webhook",
        botUsername: "test_bot",
        configuredAt: Date.now(),
      };
    });

    const meta = await h.getMeta();
    assert.ok(meta.sandboxId, "sandbox should be running");
    const handle = h.controller.getHandle(meta.sandboxId);
    assert.ok(handle, "sandbox handle should exist");

    let telegramRouteProbeCount = 0;
    handle.responders.push((cmd, args) => {
      if (cmd !== "bash" || args?.[0] !== "-c") {
        return undefined;
      }
      const script = args[1] ?? "";
      if (script.includes(`http://localhost:3000/`) && script.includes("openclaw-app")) {
        return { exitCode: 0, output: async () => "ok" };
      }
      if (script.includes("/telegram-webhook")) {
        telegramRouteProbeCount += 1;
        const status = telegramRouteProbeCount >= 2 ? "401" : "000";
        return { exitCode: 0, output: async () => status };
      }
      return undefined;
    });

    const result = await syncGatewayConfigToSandbox();

    assert.equal(result.outcome, "applied");
    assert.equal(telegramRouteProbeCount, 2);
    const updated = await h.getMeta();
    assert.equal(updated.lastRestoreMetrics?.telegramListenerReady, true);
    assert.equal(updated.lastRestoreMetrics?.telegramListenerStatus, 401);
  });
});

test("syncGatewayConfigToSandbox degrades when Slack route stays unregistered", async () => {
  await withHarness(async (h) => {
    process.env.NEXT_PUBLIC_BASE_DOMAIN = "test.example.com";
    await h.driveToRunning();
    await h.mutateMeta((meta) => {
      meta.channels.slack = {
        signingSecret: "test-slack-signing-secret",
        botToken: "xoxb-test-slack-bot-token",
        configuredAt: Date.now(),
      };
    });

    const meta = await h.getMeta();
    assert.ok(meta.sandboxId, "sandbox should be running");
    const handle = h.controller.getHandle(meta.sandboxId);
    assert.ok(handle, "sandbox handle should exist");

    handle.responders.push((cmd, args) => {
      if (cmd !== "bash" || args?.[0] !== "-c") {
        return undefined;
      }
      const script = args[1] ?? "";
      if (script.includes(`http://localhost:3000/`) && script.includes("openclaw-app")) {
        return { exitCode: 0, output: async () => "ok" };
      }
      if (script.includes("/slack/events")) {
        return { exitCode: 0, output: async () => "404" };
      }
      return undefined;
    });

    const result = await syncGatewayConfigToSandbox();

    assert.equal(result.outcome, "failed");
    assert.equal(result.liveConfigFresh, false);
    assert.match(result.reason, /slack route never returned ready status/);
  });
});

test("ensureRunningSandboxDynamicConfigFresh rewrites and restarts on hash miss", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    // Set a stale runtime hash so reconcile detects a miss.
    await h.mutateMeta((meta) => {
      meta.runtimeDynamicConfigHash = "stale-hash-from-previous-deploy";
    });

    const result = await ensureRunningSandboxDynamicConfigFresh({
      origin: "https://test.example.com",
    });

    assert.equal(result.verified, true, "Should be verified after reconcile");
    assert.equal(result.changed, true, "Should have changed config");
    assert.equal(result.reason, "rewritten-and-restarted");

    // Verify runtimeDynamicConfigHash was updated (not snapshotConfigHash).
    const meta = await h.getMeta();
    const expectedHash = computeGatewayConfigHash({});
    assert.equal(meta.runtimeDynamicConfigHash, expectedHash, "Runtime hash should be updated in metadata");
    // snapshotDynamicConfigHash must NOT be touched by runtime reconcile.
    assert.equal(meta.snapshotDynamicConfigHash, null, "Snapshot hash must not be updated by runtime reconcile");

    // Verify the running sandbox invoked the restart script after rewriting config.
    const handle = h.controller.created.find(
      (c) => c.sandboxId === meta.sandboxId,
    ) as FakeSandboxHandle | undefined;
    assert.ok(
      handle,
      "Should have a sandbox handle for the running sandbox",
    );
    assert.ok(
      handle.commands.some(
        (c) => c.cmd === "bash" && c.args?.[0] === OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH,
      ),
      "Gateway should be restarted via the restart script",
    );
  });
});

test("ensureRunningSandboxDynamicConfigFresh returns rewrite-failed on writeFiles error", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    await h.mutateMeta((meta) => {
      meta.runtimeDynamicConfigHash = "stale-hash";
    });

    // Install a hook that throws on writeFiles to simulate failure.
    const meta = await h.getMeta();
    const handle = h.controller.created.find(
      (c) => c.sandboxId === meta.sandboxId,
    ) as FakeSandboxHandle | undefined;
    assert.ok(handle, "Should have a sandbox handle");

    handle.writeFilesHook = () => {
      throw new Error("Simulated writeFiles failure");
    };

    const result = await ensureRunningSandboxDynamicConfigFresh({
      origin: "https://test.example.com",
    });

    assert.equal(result.verified, false);
    assert.equal(result.changed, false);
    assert.equal(result.reason, "rewrite-failed");
  });
});

test("ensureRunningSandboxDynamicConfigFresh returns restart-failed on nonzero exit", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    await h.mutateMeta((meta) => {
      meta.runtimeDynamicConfigHash = "stale-hash";
    });

    // Install a command responder that fails the restart script.
    const meta = await h.getMeta();
    const handle = h.controller.created.find(
      (c) => c.sandboxId === meta.sandboxId,
    ) as FakeSandboxHandle | undefined;
    assert.ok(handle, "Should have a sandbox handle");

    handle.responders.push((cmd, args) => {
      if (cmd === "bash" && args?.[0] === OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH) {
        return { exitCode: 1, output: async () => "restart failed" };
      }
      return undefined;
    });

    const result = await ensureRunningSandboxDynamicConfigFresh({
      origin: "https://test.example.com",
    });

    assert.equal(result.verified, false);
    assert.equal(result.changed, true, "Files were written before restart failed");
    assert.equal(result.reason, "restart-failed");
  });
});

test("ensureRunningSandboxDynamicConfigFresh returns sandbox-unavailable when not running", async () => {
  await withHarness(async () => {
    // Do not drive to running — stay in uninitialized state.
    const result = await ensureRunningSandboxDynamicConfigFresh({
      origin: "https://test.example.com",
    });

    assert.equal(result.verified, false);
    assert.equal(result.changed, false);
    assert.equal(result.reason, "sandbox-unavailable");
  });
});

// ---------------------------------------------------------------------------
// Restore target truth split
// ---------------------------------------------------------------------------

test("destructive restore preparation never stamps ready after persistent stop failure", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();
    const before = await h.getMeta();
    const handle = h.controller.created.find(
      (candidate) => candidate.sandboxId === before.sandboxId,
    ) as FakeSandboxHandle | undefined;
    assert.ok(handle);
    handle.stop = async () => {
      handle.stopCalled = true;
      handle.setStatus("failed");
    };

    const result = await prepareRestoreTarget({
      origin: "https://test.example.com",
      reason: "persistent-stop-failure-test",
      destructive: true,
    });

    assert.equal(result.ok, false);
    assert.equal(result.state, "failed");
    assert.equal(result.reason, "prepare-failed");
    assert.equal(
      result.actions.find((action) => action.id === "snapshot")?.status,
      "failed",
    );
    const after = await h.getMeta();
    assert.equal(after.restorePreparedStatus, "failed");
    assert.notEqual(after.persistedStateSource, "persistent-auto-save");
    assert.equal(after.pendingPersistentAutoSave, null);
    assert.equal(after.activePersistentStop, null);
  });
});

test("restore preparation never attests config changed after runtime sync", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();
    const before = await h.getMeta();
    const handle = h.controller.getHandle(before.sandboxId!);
    assert.ok(handle);
    const originalFetch = globalThis.fetch;
    let mutated = false;
    globalThis.fetch = async (input) => {
      if (!String(input).endsWith("/readyz") && !mutated) {
        mutated = true;
        await h.mutateMeta((meta) => {
          meta.channels.slack = {
            signingSecret: "new-signing-secret",
            botToken: "xoxb-new-token",
            configuredAt: Date.now(),
          };
        });
      }
      return String(input).endsWith("/readyz")
        ? Response.json({ ready: true })
        : new Response('<div id="openclaw-app"></div>', { status: 200 });
    };

    try {
      const result = await prepareRestoreTarget({
        origin: "https://test.example.com",
        reason: "config-interleave-test",
        destructive: true,
      });

      assert.equal(result.ok, false);
      assert.equal(handle.stopCalled, false);
      const after = await h.getMeta();
      assert.equal(after.restorePreparedStatus, "failed");
      assert.equal(after.persistedStateSource, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("restore preparation deadline leaves durable completion to reconciliation", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();
    const before = await h.getMeta();
    const handle = h.controller.created.find(
      (candidate) => candidate.sandboxId === before.sandboxId,
    ) as FakeSandboxHandle | undefined;
    assert.ok(handle);

    const originalNow = Date.now;
    let clockOffsetMs = 0;
    Date.now = () => originalNow() + clockOffsetMs;
    handle.stop = async (options) => {
      handle.stopCalled = true;
      handle.lastStopOptions = options;
      handle.setStatus("stopping");
      // Consume nearly the entire function budget before confirmation starts.
      clockOffsetMs = 270_001;
    };

    try {
      const startedAt = originalNow();
      const result = await prepareRestoreTarget({
        origin: "https://test.example.com",
        reason: "persistent-stop-deadline-test",
        destructive: true,
      });
      assert.ok(originalNow() - startedAt < 2_000, "poll must honor the absolute budget");
      assert.equal(result.ok, false);
      assert.equal(result.state, "preparing");

      let pending = await h.getMeta();
      assert.equal(pending.status, "snapshotting");
      assert.equal(pending.restorePreparedStatus, "preparing");
      assert.equal(pending.persistedStateDynamicConfigHash, null);
      assert.equal(pending.persistedStateAssetSha256, null);
      assert.equal(pending.persistedStateSavedAt, null);
      assert.equal(pending.pendingPersistentAutoSave?.sandboxId, before.sandboxId);
      assert.equal(
        pending.pendingPersistentAutoSave?.lifecycleAttemptId,
        before.lifecycleAttemptId,
      );
      assert.equal(
        pending.pendingPersistentAutoSave?.operationId,
        pending.activePersistentStop?.operationId,
      );
      assert.ok(pending.pendingPersistentAutoSave?.dynamicConfigHash);
      assert.ok(pending.pendingPersistentAutoSave?.assetSha256);
      assert.ok(pending.activePersistentStop?.stopAttemptId);

      handle.setStatus("stopped");
      pending = await reconcileSnapshottingStatus();
      assert.equal(pending.status, "stopped");
      assert.equal(pending.restorePreparedStatus, "ready");
      assert.equal(pending.persistedStateSource, "persistent-auto-save");
      assert.ok(pending.persistedStateSavedAt);
      assert.equal(pending.restoreOracle.status, "ready");
      assert.equal(pending.pendingPersistentAutoSave, null);
      assert.equal(pending.activePersistentStop, null);
    } finally {
      Date.now = originalNow;
    }
  });
});

test("restore preparation never stops a replacement sandbox generation", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();
    const original = await h.getMeta();
    const originalHandle = h.controller.getHandle(original.sandboxId!);
    assert.ok(originalHandle);
    const replacement = new FakeSandboxHandle("sbx-prepare-replacement", h.controller.events);
    replacement.responders.push(...h.controller.defaultResponders);
    h.controller.handlesByIds.set(replacement.sandboxId, replacement);

    const store = getStore();
    const acquireLock = store.acquireLock.bind(store);
    let replaced = false;
    store.acquireLock = async (key, ttlSeconds) => {
      if (key === lifecycleLockKey() && !replaced) {
        replaced = true;
        await mutateMeta((meta) => {
          meta.status = "running";
          meta.sandboxId = replacement.sandboxId;
          meta.lifecycleAttemptId = "replacement-attempt";
          meta.portUrls = { "3000": "https://replacement.example.com" };
          meta.restorePreparedStatus = "dirty";
          meta.pendingPersistentAutoSave = null;
          meta.activePersistentStop = null;
        });
      }
      return acquireLock(key, ttlSeconds);
    };

    try {
      const result = await prepareRestoreTarget({
        origin: "https://test.example.com",
        reason: "replacement-generation-test",
        destructive: true,
      });
      assert.equal(result.ok, false);
      assert.equal(replaced, true);
      assert.equal(originalHandle.stopCalled, false);
      assert.equal(replacement.stopCalled, false);
      const current = await h.getMeta();
      assert.equal(current.sandboxId, replacement.sandboxId);
      assert.equal(current.lifecycleAttemptId, "replacement-attempt");
      assert.equal(current.status, "running");
      assert.equal(current.pendingPersistentAutoSave, null);
    } finally {
      store.acquireLock = acquireLock;
    }
  });
});

test("runtime reconcile updates runtimeDynamicConfigHash but not snapshotDynamicConfigHash", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    // Seed prepared-state truth from a prior snapshot.
    await h.mutateMeta((meta) => {
      meta.snapshotDynamicConfigHash = "old-snapshot-hash";
      meta.runtimeDynamicConfigHash = "stale-runtime-hash";
    });

    const result = await ensureRunningSandboxDynamicConfigFresh({
      origin: "https://test.example.com",
    });

    assert.equal(result.verified, true);
    assert.equal(result.changed, true);

    const meta = await h.getMeta();
    const expectedHash = computeGatewayConfigHash({});
    assert.equal(meta.runtimeDynamicConfigHash, expectedHash);
    assert.equal(meta.snapshotDynamicConfigHash, "old-snapshot-hash",
      "Prepared-state truth must not be altered by runtime reconcile");
    assert.equal(meta.restorePreparedStatus, "dirty",
      "Runtime reconcile should mark restore target dirty");
  });
});

test("v2 persistent resume preserves legacy snapshot fields while using persisted state truth", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-asset-truth-split";
      meta.gatewayToken = "test-gw-token";
      meta.snapshotDynamicConfigHash = null;
      meta.snapshotAssetSha256 = "old-snapshot-asset-hash";
      meta.persistedStateDynamicConfigHash = null;
      meta.persistedStateAssetSha256 = null;
      meta.persistedStateSource = null;
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      await triggerRestore(fake, { tokenOverride: "test-ai-key" });

      const meta = await getInitializedMeta();
      // v2: legacy snapshot fields remain compatibility metadata; persistedState* is the normal truth.
      assert.equal(
        meta.snapshotAssetSha256,
        "old-snapshot-asset-hash",
        "legacy snapshotAssetSha256 should remain compatibility metadata",
      );
      assert.equal(
        meta.persistedStateAssetSha256,
        "old-snapshot-asset-hash",
        "persistedStateAssetSha256 hydrates from legacy snapshot truth",
      );
      assert.equal(meta.persistedStateSource, "manual-snapshot");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("restore after runtime-only reconcile still performs hot-path config write", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    const currentHash = computeGatewayConfigHash({});

    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-stale-snapshot-hash";
      meta.gatewayToken = "test-gw-token";
      // Simulate: runtime was reconciled (runtimeDynamicConfigHash is fresh)
      // but prepared-state truth is stale (snapshotDynamicConfigHash differs).
      meta.snapshotDynamicConfigHash = "stale-snapshot-hash";
      meta.runtimeDynamicConfigHash = currentHash;
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    try {
      const { handle } = await triggerRestore(fake, { tokenOverride: "test-ai-key" });

      // v2: persistent resume always writes config via syncRestoreAssetsIfNeeded.
      // At least 1 config write should happen (dynamic files always written).
      const configWrites = handle.writtenFiles.filter((f) => f.path === OPENCLAW_CONFIG_PATH);
      assert.ok(
        configWrites.length >= 1,
        "Persistent resume should write config via asset sync",
      );

      const meta = await getInitializedMeta();
      // v2: persistent resume metrics don't track dynamicConfigReason
      assert.ok(meta.lastRestoreMetrics, "Should have restore metrics");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("stopSandbox transitions to snapshotting and preserves sandboxId (harness)", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    const meta = await stopSandbox();

    // v2 non-blocking stop surfaces "snapshotting" immediately; the reconciler
    // flips it to "stopped" once the SDK reports the persistent sandbox is done.
    assert.equal(meta.status, "snapshotting");
    // v2: persistent sandbox preserves sandboxId across stop/resume
    assert.ok(meta.sandboxId, "sandboxId should be preserved after stop");
    assert.equal(meta.portUrls, null, "portUrls should be cleared on stop");
  });
});

test("markRestoreTargetDirty sets status to dirty", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    // Manually set restorePreparedStatus to "ready" to test dirty transition
    await mutateMeta((m) => {
      m.restorePreparedStatus = "ready";
      m.restorePreparedReason = "prepared";
    });

    const meta = await markRestoreTargetDirty({ reason: "dynamic-config-changed" });

    assert.equal(meta.restorePreparedStatus, "dirty");
    assert.equal(meta.restorePreparedReason, "dynamic-config-changed");
  });
});

test("isPreparedRestoreReusable returns true only when all hashes match and status is ready", () => {
  assert.equal(
    isPreparedRestoreReusable({
      meta: {
        persistedStateDynamicConfigHash: "cfg-hash",
        persistedStateAssetSha256: "asset-hash",
        snapshotDynamicConfigHash: "cfg-hash",
        snapshotAssetSha256: "asset-hash",
        restorePreparedStatus: "ready",
      },
      desiredDynamicConfigHash: "cfg-hash",
      desiredAssetSha256: "asset-hash",
    }),
    true,
    "Should be reusable when all match",
  );

  assert.equal(
    isPreparedRestoreReusable({
      meta: {
        persistedStateDynamicConfigHash: "cfg-hash",
        persistedStateAssetSha256: "asset-hash",
        snapshotDynamicConfigHash: "cfg-hash",
        snapshotAssetSha256: "asset-hash",
        restorePreparedStatus: "dirty",
      },
      desiredDynamicConfigHash: "cfg-hash",
      desiredAssetSha256: "asset-hash",
    }),
    false,
    "Should not be reusable when status is dirty",
  );

  assert.equal(
    isPreparedRestoreReusable({
      meta: {
        persistedStateDynamicConfigHash: "old-cfg-hash",
        persistedStateAssetSha256: "asset-hash",
        snapshotDynamicConfigHash: "old-cfg-hash",
        snapshotAssetSha256: "asset-hash",
        restorePreparedStatus: "ready",
      },
      desiredDynamicConfigHash: "cfg-hash",
      desiredAssetSha256: "asset-hash",
    }),
    false,
    "Should not be reusable when config hash differs",
  );
});

test("resetSandbox clears restoreOracle to idle defaults", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    // Manually set oracle to a non-idle state to test reset behavior
    await mutateMeta((m) => {
      m.restoreOracle.status = "pending";
      m.restoreOracle.pendingReason = "dynamic-config-changed";
    });

    let meta = await getInitializedMeta();
    assert.equal(meta.restoreOracle.status, "pending");
    const priorGatewayValue = meta.gatewayToken;

    // Reset should restore idle defaults and delete the sandbox
    const beforeSandboxId = meta.sandboxId;
    meta = await resetSandbox({ origin: "https://app.example.com", reason: "test-reset" });

    // Verify sandbox was deleted (not just stopped)
    const handle = h.controller.getHandle(beforeSandboxId!);
    assert.ok(handle?.deleteCalled, "reset should delete the persistent sandbox");

    assert.equal(meta.restoreOracle.status, "idle", "Oracle status should be idle after reset");
    assert.equal(meta.restoreOracle.pendingReason, null, "Oracle pendingReason should be null after reset");
    assert.equal(meta.restoreOracle.lastEvaluatedAt, null, "Oracle timestamps should clear after reset");
    assert.equal(meta.restoreOracle.lastStartedAt, null);
    assert.equal(meta.restoreOracle.lastCompletedAt, null);
    assert.equal(meta.restoreOracle.lastBlockedReason, null);
    assert.equal(meta.restoreOracle.lastError, null);
    assert.equal(meta.restoreOracle.consecutiveFailures, 0);
    assert.equal(meta.restoreOracle.lastResult, null);
    assert.notEqual(meta.gatewayToken, priorGatewayValue);
  });
});

test("resetSandbox deletes first and clears corrupt durable suspension state", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();
    const before = await getInitializedMeta();
    assert.ok(before.sandboxId);
    await getStore().setValue(
      hostSuspensionOperationKey(),
      { version: 99, corrupt: true },
    );

    const reset = await resetSandbox({
      origin: "https://app.example.com",
      reason: "corrupt-suspension-recovery-test",
    });

    assert.ok(
      h.controller.getHandle(before.sandboxId)?.deleteCalled,
      "destructive recovery must delete the sandbox",
    );
    assert.equal(
      await getStore().getValue(hostSuspensionOperationKey()),
      null,
    );
    assert.equal(reset.status, "uninitialized");
    assert.equal(reset.sandboxId, null);
  });
});

test("resetSandbox rotates cron generation when metadata has no sandbox", async () => {
  await withHarness(async () => {
    const before = await getInitializedMeta();
    assert.equal(before.status, "uninitialized");
    assert.equal(before.sandboxId, null);

    const reset = await resetSandbox({
      origin: "https://app.example.com",
      reason: "uninitialized-reset-test",
    });

    assert.equal(reset.status, "uninitialized");
    assert.equal(reset.sandboxId, null);
    assert.notEqual(reset.gatewayToken, before.gatewayToken);
    assert.equal(reset.resetCronTransition, null);
  });
});

test("reset cron transition survives cleanup failure and recovers before create", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();
    const before = await getInitializedMeta();
    const store = getStore();
    const deleteOwned = store.deleteValuesIfValueToken.bind(store);
    store.deleteValuesIfValueToken = async () => false;

    try {
      await assert.rejects(
        resetSandbox({
          origin: "https://app.example.com",
          reason: "reset-cron-cleanup-failure-test",
        }),
      );
    } finally {
      store.deleteValuesIfValueToken = deleteOwned;
    }

    const interrupted = await getInitializedMeta();
    assert.equal(interrupted.status, "error");
    assert.equal(interrupted.sandboxId, null);
    assert.ok(interrupted.resetCronTransition);
    assert.notEqual(interrupted.gatewayToken, before.gatewayToken);

    const ready = await ensureSandboxReady({
      origin: "https://app.example.com",
      reason: "reset-cron-transition-recovery-test",
    });
    assert.equal(ready.status, "running");
    assert.equal(ready.resetCronTransition, null);
    assert.equal(
      (await readCronProjection())?.gatewayGeneration,
      createHash("sha256")
        .update(ready.gatewayToken)
        .digest("hex")
        .slice(0, 32),
    );
  });
});

test("resetSandbox preserves the released runtime path when suspend RPC is unavailable", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();
    const before = await getInitializedMeta();
    assert.ok(before.sandboxId);
    const handle = h.controller.getHandle(before.sandboxId);
    assert.ok(handle);
    handle.responders.unshift((cmd, args) => {
      if (
        cmd !== "node"
        || !args?.some((value) => value.includes("/api/v1/admin/rpc"))
      ) return undefined;
      const stdout = JSON.stringify({ status: 404, body: "Not Found" });
      return { exitCode: 0, output: async () => stdout };
    });

    const reset = await resetSandbox({
      origin: "https://app.example.com",
      reason: "legacy-reset-test",
    });

    assert.equal(handle.deleteCalled, true);
    assert.equal(reset.status, "uninitialized");
    assert.equal(reset.sandboxId, null);
    assert.equal(await getStore().getValue(hostSuspensionOperationKey()), null);
  });
});

test("resetSandbox clears metadata and suspension when deadline cleanup fails after delete", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();
    const before = await getInitializedMeta();
    assert.ok(before.sandboxId);
    const handle = h.controller.getHandle(before.sandboxId);
    assert.ok(handle);
    const store = getStore();
    const deleteValue = store.deleteValue.bind(store);
    let injected = false;
    store.deleteValue = async (key) => {
      if (key === sandboxDeadlineV2Key() && !injected) {
        injected = true;
        throw new Error("deadline cleanup unavailable");
      }
      return deleteValue(key);
    };

    try {
      await assert.rejects(
        resetSandbox({
          origin: "https://app.example.com",
          reason: "post-delete-cleanup-failure-test",
        }),
        /deadline cleanup unavailable/,
      );
    } finally {
      store.deleteValue = deleteValue;
    }

    const after = await getInitializedMeta();
    assert.equal(handle.deleteCalled, true);
    assert.equal(after.sandboxId, null);
    assert.equal(after.status, "error");
    assert.match(after.lastError ?? "", /deadline cleanup unavailable/);
    assert.equal(await store.getValue(hostSuspensionOperationKey()), null);
  });
});

test("resetSandbox preserves a live sandbox when Gateway suspension is busy", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();
    const before = await getInitializedMeta();
    assert.ok(before.sandboxId);
    const handle = h.controller.getHandle(before.sandboxId);
    assert.ok(handle);
    handle.responders.unshift((cmd, args) => {
      if (cmd !== "node" || !args?.some((value) => value.includes("/api/v1/admin/rpc"))) {
        return undefined;
      }
      const response = JSON.stringify({
        status: 200,
        body: JSON.stringify({
          ok: true,
          payload: {
            status: "busy",
            reason: "active agent run",
            activeCount: 1,
            blockers: [],
            retryAfterMs: 500,
          },
        }),
      });
      return {
        exitCode: 0,
        output: async (stream) => stream === "stderr" ? "" : response,
      };
    });

    await assert.rejects(
      resetSandbox({
        origin: "https://app.example.com",
        reason: "busy-suspension-test",
      }),
      (error: unknown) =>
        error instanceof ApiError
        && error.status === 409
        && error.code === "GATEWAY_SUSPEND_BUSY",
    );

    const after = await getInitializedMeta();
    assert.equal(handle.deleteCalled, false);
    assert.equal(after.status, "running");
    assert.equal(after.sandboxId, before.sandboxId);
    assert.equal(after.lifecycleAttemptId, before.lifecycleAttemptId);
    assert.match(after.lastError ?? "", /active agent run/);
  });
});

test("resetSandbox adopts a durable reset interrupted before delete", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();
    const before = await getInitializedMeta();
    assert.ok(before.sandboxId);
    await getStore().setValue(
      hostSuspensionOperationKey(),
      hostSuspensionState(before.sandboxId, {
        intent: "reset",
        lifecycleAttemptId: before.lifecycleAttemptId ?? null,
        reason: "sandbox.reset",
        phase: "stopping",
        stopRequestDeadlineAtMs: null,
      }),
    );

    const reset = await resetSandbox({
      origin: "https://app.example.com",
      reason: "interrupted-reset-adoption-test",
    });

    assert.equal(h.controller.getHandle(before.sandboxId)?.deleteCalled, true);
    assert.equal(reset.status, "uninitialized");
    assert.equal(reset.sandboxId, null);
    assert.equal(
      await getStore().getValue(hostSuspensionOperationKey()),
      null,
    );
  });
});

test("ensureSandboxReady fails closed when its lifecycle guard is already revoked", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await assert.rejects(
      ensureSandboxReady({
        origin: "https://app.example.com",
        reason: "cron-projection:wake",
        lifecycleGuard: async () => false,
      }),
      SandboxLifecycleGuardRejectedError,
    );
    assert.equal(fake.createCalls.length, 0);
    assert.equal((await getInitializedMeta()).status, "uninitialized");
  });
});

test("mid-bootstrap guard revocation removes the bundle candidate", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    configureBundleLifecycleTest();
    let authorized = true;
    let revokeOnce = true;
    fake.defaultResponders.push((cmd, args) => {
      if (
        cmd === "node"
        && args?.[0] === OPENCLAW_BUNDLE_PATH
        && args[1] === "--version"
      ) {
        if (revokeOnce) {
          revokeOnce = false;
          authorized = false;
        }
        return {
          exitCode: 0,
          output: async (stream?: "stdout" | "stderr" | "both") =>
            stream === "stderr" ? "" : `openclaw ${BUNDLE_VERSION}\n`,
        };
      }
      return undefined;
    });

    try {
      _setAiGatewayTokenOverrideForTesting("test-ai-key");
      await assert.rejects(
        ensureSandboxReady({
          origin: "https://app.example.com",
          reason: "cron-projection:wake",
          lifecycleGuard: async () => authorized,
        }),
        SandboxLifecycleGuardRejectedError,
      );

      const rejected = fake.created[0];
      assert.ok(rejected);
      assert.equal(rejected.deleteCalled, true);
      assert.equal(
        rejected.commands.some(
          (command) =>
            command.cmd === "bash"
            && command.args?.[0] === OPENCLAW_STARTUP_SCRIPT_PATH,
        ),
        false,
      );
      assert.equal((await getInitializedMeta()).status, "uninitialized");
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
    }
  });
});

test("markRestoreTargetDirty preserves running oracle status", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    // Manually set oracle to running to simulate mid-cycle
    const { mutateMeta } = await import("@/server/store/store");
    await mutateMeta((m) => {
      m.restoreOracle.status = "running";
      m.restoreOracle.lastStartedAt = Date.now();
    });

    const meta = await markRestoreTargetDirty({ reason: "static-assets-changed" });

    assert.equal(meta.restorePreparedStatus, "dirty");
    assert.equal(meta.restoreOracle.status, "running", "Should not overwrite running oracle status");
    assert.equal(meta.restoreOracle.pendingReason, "static-assets-changed", "Should still set pending reason");
  });
});

// ---------------------------------------------------------------------------
// Q2: Gateway liveness failure asymmetry in touchRunningSandbox
// ---------------------------------------------------------------------------
//
// The internal curl liveness probe is gated by `NODE_ENV !== "test"` in
// lifecycle.ts. To exercise that branch under node:test, the tests below
// temporarily flip NODE_ENV to "development" around the touchRunningSandbox
// call so the liveness check actually runs against the FakeSandboxHandle.

test("[lifecycle] touchRunningSandbox liveness curl non-zero exit -> marks sandbox unavailable", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-liveness-fail";
      meta.snapshotId = "snap-existing";
      meta.lastAccessedAt = null;
    });

    // Target: exercise the `if (process.env.NODE_ENV !== "test")` liveness
    // branch in touchRunningSandbox. `getSandboxController()` ALSO checks
    // NODE_ENV === "test" synchronously, so we cannot flip the env var
    // upfront. Instead, wrap runCommand so the flip happens lazily on the
    // first command invocation (extendTimeout is a method, not a command).
    // `lastAccessedAt = null` forces the extend path; we also pre-set the
    // handle timeout above target so extendTimeout skips work.
    // Handle timeout below the target sleep so extendTimeout() fires — we
    // use that hook to flip NODE_ENV between the controller.get() lookup
    // and the liveness curl probe.
    const handle = new FakeSandboxHandle(
      "sbx-liveness-fail",
      fake.events,
      60_000,
    );
    let nodeEnvBackup: string | undefined;
    const origExtend = handle.extendTimeout.bind(handle);
    handle.extendTimeout = async (duration: number) => {
      if (nodeEnvBackup === undefined) {
        nodeEnvBackup = process.env.NODE_ENV;
        (process.env as Record<string, string>).NODE_ENV = "development";
      }
      return origExtend(duration);
    };
    handle.responders.push((cmd, args) => {
      if (
        cmd === "sh"
        && args?.[0] === "-c"
        && args[1]?.includes("curl")
        && args[1]?.includes("localhost:3000")
      ) {
        return {
          exitCode: 1,
          output: async () => "",
        };
      }
      return undefined;
    });
    fake.handlesByIds.set("sbx-liveness-fail", handle);

    try {
      const result = await touchRunningSandbox();
      assert.equal(
        result.status,
        "stopped",
        `Expected stopped (snapshotId set), got ${result.status} lastError=${result.lastError}`,
      );
      assert.ok(
        result.lastError?.includes("heartbeat gateway liveness failed"),
        `lastError should mention liveness failure, got: ${result.lastError}`,
      );
      assert.equal(result.sandboxId, null);
    } finally {
      if (nodeEnvBackup !== undefined) {
        (process.env as Record<string, string | undefined>).NODE_ENV = nodeEnvBackup;
      }
    }
  });
});

test("[lifecycle] touchRunningSandbox liveness runCommand throws -> NOT marked unavailable", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-liveness-throw";
      meta.snapshotId = "snap-existing";
      meta.lastAccessedAt = null;
    });

    const handle = new FakeSandboxHandle(
      "sbx-liveness-throw",
      fake.events,
      60_000,
    );
    let nodeEnvBackup: string | undefined;
    const origExtend = handle.extendTimeout.bind(handle);
    handle.extendTimeout = async (duration: number) => {
      if (nodeEnvBackup === undefined) {
        nodeEnvBackup = process.env.NODE_ENV;
        (process.env as Record<string, string>).NODE_ENV = "development";
      }
      return origExtend(duration);
    };
    handle.responders.push((cmd, args) => {
      if (
        cmd === "sh"
        && args?.[0] === "-c"
        && args[1]?.includes("curl")
        && args[1]?.includes("localhost:3000")
      ) {
        throw new Error("transient network error");
      }
      return undefined;
    });
    fake.handlesByIds.set("sbx-liveness-throw", handle);

    try {
      const result = await touchRunningSandbox();
      assert.equal(
        result.status,
        "running",
        `runCommand throw should NOT mark unavailable, got status ${result.status} lastError=${result.lastError}`,
      );
      assert.equal(result.sandboxId, "sbx-liveness-throw");
      assert.ok(
        !result.lastError || !result.lastError.includes("heartbeat gateway liveness failed"),
        `lastError should not mention liveness failure, got: ${result.lastError}`,
      );
    } finally {
      if (nodeEnvBackup !== undefined) {
        (process.env as Record<string, string | undefined>).NODE_ENV = nodeEnvBackup;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Q4: Resume failure via unhealthy handle falls back to create and clears snapshot
// ---------------------------------------------------------------------------

test("[lifecycle] ensureSandboxRunning resume unhealthy handle restores its selected snapshot", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    // Pre-register an "oc-*" handle that reports an unhealthy status so the
    // resume path at createAndBootstrapSandboxWithinLifecycleLock treats it
    // as dead and falls through to create().
    const sandboxName = `oc-${"openclaw-single".replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`;
    const unhealthy = new FakeSandboxHandle(sandboxName, fake.events, 60_000);
    unhealthy.setStatus("failed");
    fake.handlesByIds.set(sandboxName, unhealthy);

    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-resume-fail";
      meta.snapshotConfigHash = "hash-existing";
      meta.snapshotDynamicConfigHash = "dynhash-existing";
      meta.snapshotAssetSha256 = "assetsha-existing";
      meta.restorePreparedStatus = "ready";
      meta.restorePreparedReason = null;
      meta.restorePreparedAt = Date.now();
      meta.snapshotHistory = [
        {
          id: "r-1",
          snapshotId: "snap-resume-fail",
          timestamp: Date.now(),
          reason: "stop",
        },
        {
          id: "r-2",
          snapshotId: "snap-older",
          timestamp: Date.now() - 10_000,
          reason: "stop",
        },
      ];
    });

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    _setAiGatewayTokenOverrideForTesting("test-key");
    try {
      let scheduledCallback: (() => Promise<void> | void) | null = null;
      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "resume-unhealthy-fallback",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      assert.ok(scheduledCallback);
      await (scheduledCallback as () => Promise<void>)();

      const meta = await getInitializedMeta();
      assert.equal(meta.status, "running", "Should reach running after fallback");
      assert.equal(meta.snapshotId, "snap-resume-fail");
      assert.equal(meta.snapshotConfigHash, "hash-existing");
      assert.equal(meta.snapshotDynamicConfigHash, "dynhash-existing");
      assert.equal(meta.snapshotAssetSha256, "assetsha-existing");
      assert.equal(meta.restorePreparedStatus, "ready");
      assert.equal(meta.restorePreparedReason, null);
      assert.deepEqual(fake.createCalls.at(-1)?.source, {
        type: "snapshot",
        snapshotId: "snap-resume-fail",
      });
      // snapshotHistory is NOT wiped by the fallback path — it remains for
      // diagnostics / future prepare cycles. Asserted so the invariant is
      // explicit and any future behavior change is caught.
      assert.ok(
        meta.snapshotHistory.length >= 2,
        `snapshotHistory should be retained on fallback, got length=${meta.snapshotHistory.length}`,
      );
      assert.ok(
        unhealthy.deleteCalled,
        "Unhealthy handle should have been deleted before create fallback",
      );
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

test("[lifecycle] ensureSandboxRunning resume stopped handle after explicit resume -> falls back to create", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    const sandboxName = `oc-${"openclaw-single".replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`;
    const stopped = new FakeSandboxHandle(sandboxName, fake.events, 60_000);
    stopped.setStatus("stopped");
    fake.handlesByIds.set(sandboxName, stopped);

    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-resume-stopped";
      meta.snapshotConfigHash = "hash-existing";
      meta.snapshotDynamicConfigHash = "dynhash-existing";
      meta.snapshotAssetSha256 = "assetsha-existing";
      meta.restorePreparedStatus = "ready";
      meta.restorePreparedReason = null;
      meta.restorePreparedAt = Date.now();
    });
    await getStore().setValue(
      hostSuspensionOperationKey(),
      hostSuspensionState(sandboxName, {
        phase: "stopped",
        stopRequestDeadlineAtMs: null,
        stoppedAtMs: Date.now(),
      }),
    );

    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });

    _setAiGatewayTokenOverrideForTesting("test-key");
    try {
      let scheduledCallback: (() => Promise<void> | void) | null = null;
      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "resume-stopped-fallback",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      assert.ok(scheduledCallback);
      await (scheduledCallback as () => Promise<void>)();

      const meta = await getInitializedMeta();
      assert.equal(meta.status, "running", "Should reach running after fallback");
      assert.equal(meta.snapshotId, "snap-resume-stopped");
      assert.equal(meta.restorePreparedStatus, "ready");
      assert.equal(meta.restorePreparedReason, null);
      assert.deepEqual(fake.createCalls.at(-1)?.source, {
        type: "snapshot",
        snapshotId: "snap-resume-stopped",
      });
      assert.ok(stopped.deleteCalled, "Stopped handle should be deleted before create fallback");
      assert.deepEqual(fake.getCalls.slice(0, 2), [
        { sandboxId: sandboxName, resume: false },
        { sandboxId: sandboxName, resume: true },
      ]);
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Q19: touchRunningSandbox detecting sandbox gone via SDK status (not throw)
// ---------------------------------------------------------------------------

test("[lifecycle] touchRunningSandbox marks unavailable when SDK reports status!=running", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-sdk-stopped";
      meta.snapshotId = "snap-existing";
      meta.lastAccessedAt = null;
    });

    // Handle exists but reports stopped status (platform auto-timed-out the
    // sandbox). controller.get() does NOT throw — it returns a handle whose
    // status is "stopped". Verifies touchRunningSandbox() uses the SDK status
    // signal (lifecycle.ts:1626) rather than only reacting to get() throws.
    const handle = new FakeSandboxHandle("sbx-sdk-stopped", fake.events, 60_000);
    handle.setStatus("stopped");
    fake.handlesByIds.set("sbx-sdk-stopped", handle);

    const result = await touchRunningSandbox();
    assert.equal(
      result.status,
      "stopped",
      `Expected stopped (snapshotId present), got ${result.status}`,
    );
    assert.equal(result.sandboxId, null);
    assert.ok(
      result.lastError?.includes("heartbeat detected sandbox status"),
      `lastError should mention heartbeat detection, got: ${result.lastError}`,
    );
  });
});

test("[lifecycle] touchRunningSandbox marks error when SDK reports failed and no snapshot", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-sdk-failed";
      meta.snapshotId = null;
      meta.lastAccessedAt = null;
    });

    const handle = new FakeSandboxHandle("sbx-sdk-failed", fake.events, 60_000);
    handle.setStatus("failed");
    fake.handlesByIds.set("sbx-sdk-failed", handle);

    const result = await touchRunningSandbox();
    assert.equal(
      result.status,
      "error",
      `Expected error without manual checkpoint metadata, got ${result.status}`,
    );
    assert.equal(result.sandboxId, null);
  });
});

// ---------------------------------------------------------------------------
// Q21: ensureSandboxRunning when running but timeout expired -> reconciles
// ---------------------------------------------------------------------------

test("[lifecycle] ensureSandboxRunning running + expired timeout -> reconciles via reconcileSandboxHealth", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;

  await withTestEnv(fake, async () => {
    // Pre-register a handle reporting stopped so reconcile->probe fails and
    // the recovery path is exercised.
    const handle = new FakeSandboxHandle("sbx-running-expired", fake.events, 60_000);
    handle.setStatus("stopped");
    fake.handlesByIds.set("sbx-running-expired", handle);

    // Force sleep-after to 5 minutes, then pretend last access was 1 hour ago
    // so estimateSandboxTimeoutRemainingMs returns 0 (expired).
    process.env.OPENCLAW_SANDBOX_SLEEP_AFTER_MS = String(5 * 60 * 1000);
    _resetSandboxSleepConfigCacheForTesting();

    const longAgo = Date.now() - 60 * 60 * 1000; // 1 hour ago
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-running-expired";
      meta.snapshotId = "snap-expired";
      meta.lastAccessedAt = longAgo;
      meta.portUrls = { "3000": "https://sbx-running-expired-3000.fake.vercel.run" };
    });

    // probeGatewayReady will fetch upstream; return a 410 so probe.ready=false
    // and reconcileSandboxHealth runs the repair path (markSandboxUnavailable
    // then ensureSandboxRunning).
    globalThis.fetch = async () =>
      new Response("gone", { status: 410 });

    _resetLogBuffer();
    try {
      let scheduledCallback: (() => Promise<void> | void) | null = null;
      const result = await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "expired-timeout-reconcile",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      // Should be waiting — repair scheduled after markSandboxUnavailable.
      assert.equal(result.state, "waiting");

      const logMessages = getServerLogs().map((e) => e.message);
      assert.ok(
        logMessages.includes("sandbox.ensure_running.timeout_expired"),
        `Expected sandbox.ensure_running.timeout_expired log, got: ${logMessages.join(", ")}`,
      );

      const meta = await getInitializedMeta();
      // After repair: sandboxId is cleared by markSandboxUnavailable; status
      // moves to "restoring" (snapshot present) once scheduleLifecycleWork runs.
      assert.ok(
        meta.status === "restoring" || meta.status === "stopped",
        `Expected restoring/stopped after repair, got ${meta.status}`,
      );
      assert.ok(scheduledCallback, "Should have scheduled a background callback");
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.OPENCLAW_SANDBOX_SLEEP_AFTER_MS;
      _resetSandboxSleepConfigCacheForTesting();
    }
  });
});

// ---------------------------------------------------------------------------
// Q24: stale platform transitions stay fenced until the SDK is terminal
// ---------------------------------------------------------------------------

test("[lifecycle] reconcileSnapshottingStatus stale snapshotting stays fenced", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    // SDK still reports snapshotting (in-flight) but meta is stale.
    const handle = (await fake.create({ ports: [3000], timeout: 300_000 })) as FakeSandboxHandle;
    handle.setStatus("snapshotting");

    // updatedAt well beyond the 5-minute STALE_OPERATION_MS threshold.
    const longAgo = Date.now() - 10 * 60 * 1000;
    await mutateMeta((meta) => {
      meta.status = "snapshotting";
      meta.sandboxId = handle.sandboxId;
      meta.lastAccessedAt = longAgo;
    });

    // mutateMeta refreshes updatedAt on every write; force it back via setMeta.
    const store = getStore();
    const current = await store.getMeta();
    if (current) {
      await store.setMeta({ ...current, updatedAt: longAgo });
    }

    _resetLogBuffer();
    const reconciled = await reconcileSnapshottingStatus();
    assert.equal(
      reconciled.status,
      "snapshotting",
      `Expected SDK transitional state to remain authoritative, got ${reconciled.status}`,
    );

    const logs = getServerLogs();
    const staleLog = logs.find(
      (e) =>
        e.message === "sandbox.snapshotting_reconciled"
        && (e.data as { outcome?: string })?.outcome === "stale-still-transitional",
    );
    assert.ok(
      staleLog,
      "Should emit sandbox.snapshotting_reconciled with outcome=stale-still-transitional",
    );
  });
});

test("stale-running reconciliation preserves transitional platform states", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const handle = new FakeSandboxHandle("sbx-transitioning", fake.events);
    handle.setStatus("stopping");
    fake.handlesByIds.set(handle.sandboxId, handle);
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = handle.sandboxId;
      meta.lifecycleAttemptId = "attempt-transitioning";
    });
    _resetReconcileStaleRunningDebounceForTesting();

    const reconciled = await reconcileStaleRunningStatus();

    assert.equal(reconciled.status, "running");
    assert.equal(reconciled.sandboxId, handle.sandboxId);
    assert.equal(reconciled.lifecycleAttemptId, "attempt-transitioning");
  });
});

test("stale-running reconciliation fences and resumes a platform-stopped generation", async () => {
  const fake = new FakeSandboxController();
  const originalFetch = globalThis.fetch;
  await withTestEnv(fake, async () => {
    const handle = preRegisterResumeHandle(fake);
    handle.setStatus("stopped");
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = handle.sandboxId;
      meta.lifecycleAttemptId = "attempt-platform-timeout";
      meta.gatewayToken = "test-gw-token";
    });
    const originalGet = fake.get.bind(fake);
    fake.get = async (input) => {
      const result = await originalGet(input);
      if (input.resume === true) handle.setStatus("running");
      return result;
    };
    globalThis.fetch = async () =>
      new Response('<div id="openclaw-app"></div>', { status: 200 });
    _resetReconcileStaleRunningDebounceForTesting();

    try {
      const reconciled = await reconcileStaleRunningStatus();
      const stoppedFence = await readHostSuspensionState();
      assert.equal(reconciled.status, "stopped");
      assert.equal(stoppedFence?.phase, "stopped");
      assert.equal(stoppedFence?.sandboxId, handle.sandboxId);
      assert.equal(stoppedFence?.suspensionId, null);

      _setAiGatewayTokenOverrideForTesting("test-ai-key");
      await runScheduledEnsure("platform-timeout-resume");

      assert.equal((await getInitializedMeta()).status, "running");
      assert.equal(await readHostSuspensionState(), null);
      assert.ok(fake.getCalls.some((call) => call.resume === true));
    } finally {
      _setAiGatewayTokenOverrideForTesting(null);
      globalThis.fetch = originalFetch;
    }
  });
});

test("snapshotting reconciliation completes a committed platform-stop fence", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const sandboxId = "sbx-platform-stop-crash";
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = sandboxId;
      meta.lifecycleAttemptId = "attempt-platform-stop-crash";
      meta.portUrls = { "3000": "https://still-published.invalid" };
    });
    await getStore().setValue(
      hostSuspensionOperationKey(),
      hostSuspensionState(sandboxId, {
        lifecycleAttemptId: "attempt-platform-stop-crash",
        reason: PLATFORM_STOP_CONFIRMED_REASON,
        phase: "stopped",
        suspensionId: null,
        leaseExpiresAtMs: null,
        stopRequestDeadlineAtMs: null,
        stoppedAtMs: Date.now(),
      }),
    );

    const reconciled = await reconcileSnapshottingStatus();

    assert.equal(reconciled.status, "stopped");
    assert.equal(reconciled.portUrls, null);
    assert.equal((await readHostSuspensionState())?.ingressFenced, true);
  });
});

for (const platformState of ["stopped", "not-found"] as const) {
  test(`stale-running reconciliation preserves a matching ${platformState} fenced operation`, async () => {
    const fake = new FakeSandboxController();
    await withTestEnv(fake, async () => {
      const sandboxId = platformState === "not-found"
        ? "oc-fenced-not-found"
        : "sbx-fenced-stopped";
      if (platformState === "stopped") {
        const handle = new FakeSandboxHandle(sandboxId, fake.events);
        handle.setStatus("stopped");
        fake.handlesByIds.set(sandboxId, handle);
      }
      await mutateMeta((meta) => {
        meta.status = "running";
        meta.sandboxId = sandboxId;
        meta.lifecycleAttemptId = "attempt-fenced-reconcile";
      });
      const suspension = hostSuspensionState(sandboxId, {
        lifecycleAttemptId: "attempt-fenced-reconcile",
        phase: "prepared",
        stopRequestDeadlineAtMs: null,
      });
      await getStore().setValue(
        hostSuspensionOperationKey(),
        suspension,
      );
      _resetReconcileStaleRunningDebounceForTesting();

      const reconciled = await reconcileStaleRunningStatus();

      assert.equal(reconciled.status, "running");
      assert.equal(reconciled.sandboxId, sandboxId);
      assert.deepEqual(
        await getStore().getValue(hostSuspensionOperationKey()),
        suspension,
      );
    });
  });
}

test("stale-running reconciliation adopts a fence published during platform lookup", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const sandboxId = "sbx-fence-during-lookup";
    const handle = new FakeSandboxHandle(sandboxId, fake.events);
    handle.setStatus("stopped");
    fake.handlesByIds.set(sandboxId, handle);
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = sandboxId;
      meta.lifecycleAttemptId = "attempt-fence-during-lookup";
    });
    const suspension = hostSuspensionState(sandboxId, {
      lifecycleAttemptId: "attempt-fence-during-lookup",
      phase: "prepared",
      stopRequestDeadlineAtMs: null,
    });
    const originalGet = fake.get.bind(fake);
    fake.get = async (input) => {
      const result = await originalGet(input);
      await getStore().setValue(hostSuspensionOperationKey(), suspension);
      return result;
    };
    _resetReconcileStaleRunningDebounceForTesting();

    const reconciled = await reconcileStaleRunningStatus();

    assert.equal(reconciled.status, "running");
    assert.equal(reconciled.sandboxId, sandboxId);
    assert.deepEqual(
      await getStore().getValue(hostSuspensionOperationKey()),
      suspension,
    );
  });
});

test("stale stop reconciliation cannot overwrite a replacement sandbox", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const oldHandle = new FakeSandboxHandle("sbx-reconcile-old", fake.events);
    oldHandle.setStatus("stopped");
    fake.handlesByIds.set(oldHandle.sandboxId, oldHandle);
    await mutateMeta((meta) => {
      meta.status = "snapshotting";
      meta.sandboxId = oldHandle.sandboxId;
      meta.portUrls = null;
    });
    await getStore().setValue(
      hostSuspensionOperationKey(),
      hostSuspensionState(oldHandle.sandboxId, {
        operationId: "operation-old",
        requestId: "operation-old",
        phase: "stopping",
        stopRequestDeadlineAtMs: null,
      }),
    );

    const originalGet = fake.get.bind(fake);
    let releaseLookup!: () => void;
    let signalLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      signalLookupStarted = resolve;
    });
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    fake.get = async (params) => {
      const handle = await originalGet(params);
      signalLookupStarted();
      await lookupGate;
      return handle;
    };

    const reconcile = reconcileSnapshottingStatus();
    await lookupStarted;
    const replacementId = "sbx-reconcile-replacement";
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = replacementId;
      meta.portUrls = { "3000": `https://${replacementId}.example.com` };
    });
    await getStore().setValue(
      hostSuspensionOperationKey(),
      hostSuspensionState(replacementId, {
        operationId: "operation-replacement",
        requestId: "operation-replacement",
        phase: "preparing",
        stopRequestDeadlineAtMs: null,
      }),
    );
    releaseLookup();

    const reconciled = await reconcile;
    assert.equal(reconciled.status, "running");
    assert.equal(reconciled.sandboxId, replacementId);
    const suspension = await getStore().getValue<HostSuspensionState>(
      hostSuspensionOperationKey(),
    );
    assert.equal(suspension?.operationId, "operation-replacement");
    assert.equal(suspension?.phase, "preparing");
  });
});

test("old fenced operation cannot adopt a same-name replacement generation", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const sandboxId = "sbx-reused-name";
    const handle = new FakeSandboxHandle(sandboxId, fake.events);
    handle.setStatus("running");
    fake.handlesByIds.set(sandboxId, handle);
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = sandboxId;
      meta.lifecycleAttemptId = "attempt-new";
    });
    await getStore().setValue(
      hostSuspensionOperationKey(),
      hostSuspensionState(sandboxId, {
        lifecycleAttemptId: "attempt-old",
        phase: "stop-requesting",
        stopRequestDeadlineAtMs: Date.now() - 1,
      }),
    );

    const reconciled = await reconcileSnapshottingStatus();

    assert.equal(reconciled.status, "running");
    assert.equal(reconciled.lifecycleAttemptId, "attempt-new");
    assert.equal(handle.stopCalled, false);
  });
});

test("stale stop reconciliation cannot certify a replacement stop on the same generation", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const sandboxId = "sbx-same-generation-stop";
    const lifecycleAttemptId = "attempt-same-generation";
    const handle = new FakeSandboxHandle(sandboxId, fake.events);
    handle.setStatus("stopped");
    fake.handlesByIds.set(sandboxId, handle);
    await mutateMeta((meta) => {
      meta.status = "snapshotting";
      meta.sandboxId = sandboxId;
      meta.lifecycleAttemptId = lifecycleAttemptId;
      meta.restorePreparedStatus = "preparing";
      meta.activePersistentStop = {
        stopAttemptId: "stop-o1",
        sandboxId,
        lifecycleAttemptId,
        operationId: "operation-o1",
        reason: "sandbox.stop",
        startedAt: Date.now(),
      };
      meta.pendingPersistentAutoSave = {
        sandboxId,
        lifecycleAttemptId,
        operationId: "operation-o1",
        dynamicConfigHash: "config-o1",
        assetSha256: "assets-o1",
        createdAt: Date.now(),
      };
    });
    await getStore().setValue(
      hostSuspensionOperationKey(),
      hostSuspensionState(sandboxId, {
        lifecycleAttemptId,
        operationId: "operation-o1",
        requestId: "operation-o1",
        phase: "stopping",
        stopRequestDeadlineAtMs: null,
      }),
    );
    const originalGet = fake.get.bind(fake);
    fake.get = async (params) => {
      const found = await originalGet(params);
      await mutateMeta((meta) => {
        meta.activePersistentStop = {
          stopAttemptId: "stop-o2",
          sandboxId,
          lifecycleAttemptId,
          operationId: "operation-o2",
          reason: "sandbox.stop",
          startedAt: Date.now(),
        };
        meta.pendingPersistentAutoSave = {
          sandboxId,
          lifecycleAttemptId,
          operationId: "operation-o2",
          dynamicConfigHash: "config-o2",
          assetSha256: "assets-o2",
          createdAt: Date.now(),
        };
      });
      return found;
    };

    const reconciled = await reconcileSnapshottingStatus();

    assert.equal(reconciled.status, "snapshotting");
    assert.equal(reconciled.activePersistentStop?.stopAttemptId, "stop-o2");
    assert.equal(reconciled.pendingPersistentAutoSave?.dynamicConfigHash, "config-o2");
    assert.equal(reconciled.persistedStateDynamicConfigHash, null);
    assert.equal(reconciled.restorePreparedStatus, "preparing");
  });
});

test("reconcileSnapshottingStatus preserves metadata when suspension state is corrupt", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    await mutateMeta((meta) => {
      meta.status = "snapshotting";
      meta.sandboxId = "sbx-corrupt-suspension";
    });
    await getStore().setValue(hostSuspensionOperationKey(), {
      version: 99,
      corrupt: true,
    });

    const reconciled = await reconcileSnapshottingStatus();

    assert.equal(reconciled.status, "snapshotting");
    assert.equal(reconciled.sandboxId, "sbx-corrupt-suspension");
  });
});

test("terminal SDK status projects even when monitor repair is unavailable", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const handle = new FakeSandboxHandle("sbx-terminal-no-monitor", fake.events);
    handle.setStatus("stopped");
    fake.handlesByIds.set(handle.sandboxId, handle);
    await mutateMeta((meta) => {
      meta.status = "snapshotting";
      meta.sandboxId = handle.sandboxId;
      meta.portUrls = null;
    });
    await getStore().setValue(
      hostSuspensionOperationKey(),
      hostSuspensionState(handle.sandboxId, {
        phase: "stopping",
        stopRequestDeadlineAtMs: null,
        monitorHeartbeatAtMs: Date.now() - 60_000,
      }),
    );
    const failingStarter = (async () => {
      throw new Error("workflow unavailable");
    }) as NonNullable<Parameters<
      typeof _setHostStopWorkflowStarterForTesting
    >[0]>;
    _setHostStopWorkflowStarterForTesting(failingStarter);

    try {
      const reconciled = await reconcileSnapshottingStatus();
      assert.equal(reconciled.status, "stopped");
    } finally {
      _setHostStopWorkflowStarterForTesting(null);
    }
  });
});

test("firewall fail-closed monitor stops the exact fenced generation", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const handle = new FakeSandboxHandle("sbx-firewall-fail-closed", fake.events);
    fake.handlesByIds.set(handle.sandboxId, handle);
    await mutateMeta((meta) => {
      meta.status = "error";
      meta.sandboxId = handle.sandboxId;
      meta.lifecycleAttemptId = "firewall-attempt";
      meta.firewall.policyRevisionId = FIREWALL_POLICY_REVISION.revisionId;
      meta.firewall.lastPolicySdkCompletionRevisionId =
        FIREWALL_POLICY_REVISION.revisionId;
      meta.firewall.lastPolicySdkCompletionHash =
        FIREWALL_POLICY_REVISION.policyHash;
      meta.portUrls = { "3000": handle.domain(3000) };
      meta.lastGatewayProbeReady = true;
    });
    await getStore().setValue(
      hostSuspensionOperationKey(),
      hostSuspensionState(handle.sandboxId, {
        lifecycleAttemptId: "firewall-attempt",
        reason: FIREWALL_FAIL_CLOSED_REASON,
        suspensionId: null,
      }),
    );

    const reconciled = await reconcileSnapshottingStatus();

    assert.equal(reconciled.status, "stopped");
    assert.equal(reconciled.portUrls, null);
    assert.equal(reconciled.lastGatewayProbeReady, false);
    assert.equal(handle.stopCalled, true);
    assert.equal(handle.lastStopOptions?.blocking, true);
    assert.deepEqual(handle.networkPolicies, ["deny-all"]);
    assert.equal((await readHostSuspensionState())?.phase, "stopped");
  });
});

test("firewall fail-closed monitor ignores an older policy revision on the same generation", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const handle = new FakeSandboxHandle("sbx-firewall-new-policy", fake.events);
    fake.handlesByIds.set(handle.sandboxId, handle);
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = handle.sandboxId;
      meta.lifecycleAttemptId = "firewall-attempt";
      meta.firewall.policyRevisionId = "successor-policy-revision";
      meta.firewall.lastPolicySdkCompletionRevisionId =
        "successor-policy-revision";
      meta.firewall.lastPolicySdkCompletionHash = "b".repeat(64);
      meta.firewall.lastPolicySdkSuccessRevisionId =
        "successor-policy-revision";
      meta.firewall.lastPolicySdkSuccessHash = "b".repeat(64);
    });
    await getStore().setValue(
      hostSuspensionOperationKey(),
      hostSuspensionState(handle.sandboxId, {
        lifecycleAttemptId: "firewall-attempt",
        reason: FIREWALL_FAIL_CLOSED_REASON,
        suspensionId: null,
      }),
    );

    const reconciled = await reconcileSnapshottingStatus();

    assert.equal(reconciled.status, "running");
    assert.equal(handle.stopCalled, false);
    assert.deepEqual(handle.networkPolicies, []);
    assert.equal(await readHostSuspensionState(), null);
  });
});

test("firewall fail-closed monitor retains an older fence when the successor failed", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const handle = new FakeSandboxHandle("sbx-firewall-failed-successor", fake.events);
    fake.handlesByIds.set(handle.sandboxId, handle);
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = handle.sandboxId;
      meta.lifecycleAttemptId = "firewall-attempt";
      meta.firewall.policyRevisionId = "failed-successor-policy-revision";
      meta.firewall.lastPolicySdkCompletionRevisionId =
        "failed-successor-policy-revision";
      meta.firewall.lastPolicySdkCompletionHash = "c".repeat(64);
    });
    await getStore().setValue(
      hostSuspensionOperationKey(),
      hostSuspensionState(handle.sandboxId, {
        lifecycleAttemptId: "firewall-attempt",
        reason: FIREWALL_FAIL_CLOSED_REASON,
        suspensionId: null,
      }),
    );

    const reconciled = await reconcileSnapshottingStatus();

    assert.equal(reconciled.status, "running");
    assert.equal(handle.stopCalled, false);
    assert.equal((await readHostSuspensionState())?.ingressFenced, true);
  });
});

test("firewall fail-closed metadata repairs a missing durable stop handoff", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const handle = new FakeSandboxHandle("sbx-firewall-handoff-repair", fake.events);
    fake.handlesByIds.set(handle.sandboxId, handle);
    await mutateMeta((meta) => {
      meta.status = "error";
      meta.sandboxId = handle.sandboxId;
      meta.lifecycleAttemptId = "firewall-repair-attempt";
      meta.lastError = FIREWALL_FAIL_CLOSED_LAST_ERROR;
      meta.firewall.policyRevisionId = FIREWALL_POLICY_REVISION.revisionId;
      meta.firewall.failClosedPolicyRevisionId =
        FIREWALL_POLICY_REVISION.revisionId;
      meta.firewall.failClosedPolicyHash = FIREWALL_POLICY_REVISION.policyHash;
      meta.firewall.lastPolicySdkCompletionRevisionId =
        FIREWALL_POLICY_REVISION.revisionId;
      meta.firewall.lastPolicySdkCompletionHash =
        FIREWALL_POLICY_REVISION.policyHash;
    });
    const reconciled = await reconcileSnapshottingStatus();
    const suspension = await readHostSuspensionState();

    assert.equal(reconciled.status, "error");
    assert.equal(suspension?.sandboxId, handle.sandboxId);
    assert.equal(suspension?.lifecycleAttemptId, "firewall-repair-attempt");
    assert.equal(suspension?.reason, FIREWALL_FAIL_CLOSED_REASON);
    assert.equal(suspension?.phase, "stop-requesting");
  });
});

test("missing sandbox during stop is deleted state, not a reusable stop", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const sandboxId = "sbx-deleted-during-stop";
    await mutateMeta((meta) => {
      meta.status = "snapshotting";
      meta.sandboxId = sandboxId;
      meta.bundleIdentity = structuredClone(BUNDLE_ADMISSION.identity);
      meta.persistedStateSource = "persistent-auto-save";
      meta.restorePreparedStatus = "ready";
      meta.restorePreparedReason = "prepared";
    });
    await getStore().setValue(
      hostSuspensionOperationKey(),
      hostSuspensionState(sandboxId, {
        phase: "stopping",
        stopRequestDeadlineAtMs: null,
      }),
    );
    await getStore().setValue(
      sandboxDeadlineV2Key(),
      sandboxDeadlineState(sandboxId),
    );
    fake.get = async () => {
      throw new Error("404 sandbox not found");
    };

    const reconciled = await reconcileSnapshottingStatus();

    assert.equal(reconciled.status, "uninitialized");
    assert.equal(reconciled.sandboxId, null);
    assert.equal(reconciled.bundleIdentity, null);
    assert.equal(reconciled.persistedStateSource, null);
    assert.equal(reconciled.restorePreparedStatus, "failed");
    assert.equal(reconciled.restorePreparedReason, "prepare-failed");
    assert.equal(await getStore().getValue(hostSuspensionOperationKey()), null);
    assert.equal(await getStore().getValue(sandboxDeadlineV2Key()), null);
  });
});

test("reconcileSnapshottingStatus keeps an acknowledged stop fenced until terminal proof", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const handle = new FakeSandboxHandle("sbx-stop-not-applied", fake.events);
    handle.stop = async () => {
      handle.stopCalled = true;
      // Platform accepted the call but never left running.
    };
    fake.handlesByIds.set(handle.sandboxId, handle);
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = handle.sandboxId;
      meta.portUrls = { "3000": handle.domain(3000) };
    });

    const stoppingMeta = await stopSandbox();
    assert.equal(stoppingMeta.status, "snapshotting");

    const state = await getStore().getValue<HostSuspensionState>(
      hostSuspensionOperationKey(),
    );
    assert.ok(state);
    await getStore().setValue(hostSuspensionOperationKey(), {
      ...state,
      updatedAtMs: Date.now() - 20_000,
    });

    const stillStopping = await reconcileSnapshottingStatus();
    assert.equal(stillStopping.status, "snapshotting");
    assert.equal(stillStopping.portUrls, null);
    const fenced = await getStore().getValue<HostSuspensionState>(
      hostSuspensionOperationKey(),
    );
    assert.equal(fenced?.phase, "stopping");
    assert.equal(fenced?.ingressFenced, true);

    handle.setStatus("stopped");
    const terminal = await reconcileSnapshottingStatus();
    assert.equal(terminal.status, "stopped");
    assert.equal((await readHostSuspensionState())?.phase, "stopped");
  });
});

test("reconcileSnapshottingStatus keeps a running stop request fenced before its absolute deadline", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const handle = new FakeSandboxHandle("sbx-stop-request-pending", fake.events);
    fake.handlesByIds.set(handle.sandboxId, handle);
    await mutateMeta((meta) => {
      meta.status = "snapshotting";
      meta.sandboxId = handle.sandboxId;
      meta.portUrls = null;
    });
    await getStore().setValue(
      hostSuspensionOperationKey(),
      hostSuspensionState(handle.sandboxId),
    );

    const reconciled = await reconcileSnapshottingStatus();
    assert.equal(reconciled.status, "snapshotting");
    const state = await getStore().getValue<HostSuspensionState>(
      hostSuspensionOperationKey(),
    );
    assert.equal(state?.phase, "stop-requesting");
    assert.equal(state?.ingressFenced, true);
  });
});

test("reconcileSnapshottingStatus rolls back a running stop request after its absolute deadline", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const handle = new FakeSandboxHandle("sbx-stop-request-expired", fake.events);
    fake.handlesByIds.set(handle.sandboxId, handle);
    await mutateMeta((meta) => {
      meta.status = "snapshotting";
      meta.sandboxId = handle.sandboxId;
      meta.portUrls = null;
    });
    await getStore().setValue(
      hostSuspensionOperationKey(),
      hostSuspensionState(handle.sandboxId, {
        stopRequestDeadlineAtMs: Date.now() - 1,
        leaseExpiresAtMs: Date.now() + 1,
      }),
    );

    const reconciled = await reconcileSnapshottingStatus();
    assert.equal(reconciled.status, "running");
    assert.equal(reconciled.portUrls?.["3000"], handle.domain(3000));
    const state = await getStore().getValue<HostSuspensionState>(
      hostSuspensionOperationKey(),
    );
    assert.equal(state?.phase, "failed");
    assert.equal(state?.ingressFenced, false);
    assert.equal(state?.stopRequestDeadlineAtMs, null);
    assert.equal(
      handle.commands.filter((command) =>
        command.cmd === "node"
        && command.args?.some((value) => value.includes("/api/v1/admin/rpc"))
      ).length,
      1,
      "expired request should status-check Gateway without renewing the lease",
    );
  });
});

test("reconcileSnapshottingStatus renews a near-expiry lease while platform stop is transitional", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const handle = new FakeSandboxHandle("sbx-stop-lease-renew", fake.events);
    handle.stop = async () => {
      handle.stopCalled = true;
      handle.setStatus("snapshotting");
    };
    fake.handlesByIds.set(handle.sandboxId, handle);
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = handle.sandboxId;
      meta.portUrls = { "3000": handle.domain(3000) };
    });

    await stopSandbox();
    const state = await getStore().getValue<HostSuspensionState>(
      hostSuspensionOperationKey(),
    );
    assert.ok(state);
    await getStore().setValue(hostSuspensionOperationKey(), {
      ...state,
      leaseExpiresAtMs: Date.now() + 1,
    });

    const reconciled = await reconcileSnapshottingStatus();
    assert.equal(reconciled.status, "snapshotting");
    const renewed = await getStore().getValue<HostSuspensionState>(
      hostSuspensionOperationKey(),
    );
    assert.equal(renewed?.phase, "stopping");
    assert.ok((renewed?.leaseExpiresAtMs ?? 0) > Date.now() + 60_000);
  });
});

test("reconcileSnapshottingStatus keeps snapshotting and fenced when lease renewal fails", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const handle = new FakeSandboxHandle("sbx-stop-renew-fails", fake.events);
    handle.stop = async () => {
      handle.stopCalled = true;
      handle.setStatus("snapshotting");
    };
    fake.handlesByIds.set(handle.sandboxId, handle);
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = handle.sandboxId;
      meta.portUrls = { "3000": handle.domain(3000) };
    });

    await stopSandbox();
    const state = await getStore().getValue<HostSuspensionState>(
      hostSuspensionOperationKey(),
    );
    assert.ok(state);
    await getStore().setValue(hostSuspensionOperationKey(), {
      ...state,
      leaseExpiresAtMs: Date.now() + 1,
    });
    handle.responders.unshift((cmd, args) => {
      if (cmd === "node" && args?.some((value) => value.includes("/api/v1/admin/rpc"))) {
        return { exitCode: 1, output: async () => "control path unavailable" };
      }
      return undefined;
    });

    const reconciled = await reconcileSnapshottingStatus();
    assert.equal(reconciled.status, "snapshotting");
    const failedRenewal = await getStore().getValue<HostSuspensionState>(
      hostSuspensionOperationKey(),
    );
    assert.equal(failedRenewal?.ingressFenced, true);
    assert.notEqual(failedRenewal?.phase, "stopped");
  });
});

test("[lifecycle] reconcileSnapshottingStatus still-in-flight within window -> leaves meta snapshotting", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    const handle = (await fake.create({ ports: [3000], timeout: 300_000 })) as FakeSandboxHandle;
    handle.setStatus("snapshotting");

    await mutateMeta((meta) => {
      meta.status = "snapshotting";
      meta.sandboxId = handle.sandboxId;
      meta.lastAccessedAt = Date.now();
    });

    // Fresh updatedAt: guardrail should NOT trip.
    const reconciled = await reconcileSnapshottingStatus();
    assert.equal(reconciled.status, "snapshotting");
  });
});

// ---------------------------------------------------------------------------
// Q18 exploit proof: stale token TTL after reset causes skipped refresh
// ---------------------------------------------------------------------------

test("[lifecycle] Q18-fixed: reset clears lastTokenExpiresAt so ensureUsableAiGatewayCredential does not skip refresh on a fresh sandbox", async () => {
  const fake = new FakeSandboxController();
  await withTestEnv(fake, async () => {
    // 1. Set up a running sandbox with a "valid" OIDC token expiry 1 hour from now
    const handle = (await fake.create({ ports: [3000], timeout: 300_000 })) as FakeSandboxHandle;
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = handle.sandboxId;
      meta.lastAccessedAt = Date.now();
      // Token metadata says "token is valid for another hour"
      meta.lastTokenRefreshAt = Date.now();
      meta.lastTokenExpiresAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now (epoch seconds)
      meta.lastTokenSource = "oidc";
    });

    // 2. Reset the sandbox — destroys it, clears sandbox state AND token TTL fields
    await resetSandbox(
      { origin: "http://localhost", reason: "q18-fixed-test" },
      { deleteSnapshot: async () => {} },
    );

    // 3. Verify reset cleared sandbox state and token TTL fields
    const postReset = await getInitializedMeta();
    assert.equal(postReset.status, "uninitialized");
    assert.equal(postReset.sandboxId, null);

    // 4. THE FIX: token TTL fields no longer survive reset.
    assert.ok(
      postReset.lastTokenExpiresAt === null || postReset.lastTokenExpiresAt === undefined,
      "Fix confirmed: lastTokenExpiresAt cleared on reset",
    );

    // 5. Create a fresh sandbox (simulating the next lifecycle cycle)
    const freshHandle = (await fake.create({ ports: [3000], timeout: 300_000 })) as FakeSandboxHandle;
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = freshHandle.sandboxId;
      meta.lastAccessedAt = Date.now();
      // Fresh sandbox has no token installed; stale TTL has been cleared too.
    });

    // 6. Call ensureUsableAiGatewayCredential — without stale TTL it must not
    //    short-circuit with "meta-ttl-sufficient".
    const result = await ensureUsableAiGatewayCredential({ reason: "q18-fixed" });

    // 7. The exploit is gone: either a refresh is attempted or some other
    //    reason is returned, but it must not be the stale-TTL shortcut.
    assert.notEqual(
      result.reason,
      "meta-ttl-sufficient",
      `Fix confirmed: refresh no longer skipped via stale TTL; reason=${result.reason}`,
    );
  });
});
