import assert from "node:assert/strict";
import { test } from "node:test";

import type { RestoreOracleCycleResult } from "@/server/sandbox/restore-oracle";
import type { RestoreDecision } from "@/shared/restore-decision";
import type { SingleMeta } from "@/shared/types";
import type { WatchdogReport } from "@/shared/watchdog";
import { runSandboxWatchdog, type WatchdogDeps } from "@/server/watchdog/run";

function stubDecision(overrides: Partial<RestoreDecision> = {}): RestoreDecision {
  return {
    schemaVersion: 1,
    source: "oracle",
    destructive: true,
    reusable: false,
    needsPrepare: true,
    blocking: true,
    reasons: [],
    requiredActions: [],
    nextAction: null,
    status: "running",
    sandboxId: "sbx_123",
    snapshotId: null,
    restorePreparedStatus: "unknown",
    restorePreparedReason: null,
    oracleStatus: "idle",
    idleMs: null,
    minIdleMs: null,
    probeReady: null,
    desiredDynamicConfigHash: "stub",
    persistedStateDynamicConfigHash: null,
    snapshotDynamicConfigHash: null,
    runtimeDynamicConfigHash: null,
    desiredAssetSha256: "stub",
    persistedStateAssetSha256: null,
    persistedStateSavedAt: null,
    persistedStateSource: null,
    snapshotAssetSha256: null,
    runtimeAssetSha256: null,
    ...overrides,
  };
}

/** Build a partial oracle result — only the fields the watchdog actually reads. */
function oracleResult(partial: Record<string, unknown>): RestoreOracleCycleResult {
  return partial as unknown as RestoreOracleCycleResult;
}

const PREVIOUS: WatchdogReport = {
  deploymentId: "dpl_test",
  ranAt: "2026-03-16T07:40:00.000Z",
  status: "ok",
  sandboxStatus: "running",
  triggeredRepair: false,
  consecutiveFailures: 2,
  lastError: null,
  checks: [],
};

function findCheck(report: WatchdogReport, id: WatchdogReport["checks"][number]["id"]) {
  return report.checks.find((check) => check.id === id);
}

function makeDeps(overrides: Partial<WatchdogDeps> = {}): WatchdogDeps {
  return {
    buildContract: async () => ({
      ok: true,
      authMode: "admin-secret" as const,
      storeBackend: "redis" as const,
      aiGatewayAuth: "oidc" as const,
      openclawPackageSpec: "openclaw@1.2.3",
      openclawPackageSpecSource: "explicit" as const,
      requirements: [],
    }),
    getMeta: async () =>
      ({ status: "running", sandboxId: "sbx_123" }) as SingleMeta,
    probe: async () => ({ ready: true }),
    reconcileStale: async () =>
      ({ status: "running", sandboxId: "sbx_123" }) as SingleMeta,
    reconcile: async () => ({
      status: "recovering" as const,
      repaired: true,
      meta: { status: "booting" } as SingleMeta,
    }),
    readPrevious: async () => PREVIOUS,
    writeReport: async (next: WatchdogReport) => next,
    reconcileCronProjection: async () => ({
      status: "empty",
      projectionRevision: null,
      nextRunAtMs: null,
      workflowRunId: null,
      repaired: false,
    }),
    getCronProjectionDiagnostics: async () => null,
    refreshGatewayToken: async () => ({
      refreshed: false,
      reason: "meta-ttl-sufficient",
      credential: { token: "redacted", source: "oidc", expiresAt: 1778250156 },
    }),
    runRestoreOracle: async () => oracleResult({
      executed: false,
      blockedReason: "already-ready",
      idleMs: null,
      minIdleMs: 300_000,
      attestation: { reusable: true, needsPrepare: false, reasons: [] },
      plan: { schemaVersion: 1, status: "ready", blocking: false, reasons: [], actions: [] },
      prepare: null,
      decision: stubDecision({ reusable: true, needsPrepare: false, blocking: false }),
    }),
    prepareHotSpare: async () => ({
      ok: true,
      reason: "skipped" as const,
      candidateSandboxId: null,
    }),
    armDeadline: async () => null,
    now: (() => {
      let current = 0;
      return () => (current += 10);
    })(),
    ...overrides,
  };
}

test("running sandbox with healthy probe reports ok", async () => {
  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps(),
  );

  assert.equal(report.status, "ok");
  assert.equal(report.triggeredRepair, false);
  assert.equal(report.consecutiveFailures, 0);
  assert.equal(findCheck(report, "cron.wake")?.status, "skip");
});

test("running sandbox with healthy probe refreshes AI Gateway token", async () => {
  const calls: Array<{ force?: boolean; reason: string }> = [];

  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      refreshGatewayToken: async (input) => {
        calls.push(input);
        return { refreshed: false, reason: "meta-ttl-sufficient" };
      },
    }),
  );

  assert.equal(report.status, "ok");
  assert.deepEqual(calls, [{ force: false, reason: "watchdog:healthy-running" }]);
  assert.equal(findCheck(report, "token.refresh")?.status, "pass");
});

test("watchdog reports sanitized cron projection diagnostics", async () => {
  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      reconcileCronProjection: async () => ({
        status: "scheduled",
        projectionRevision: 3,
        nextRunAtMs: 1234,
        workflowRunId: "wrun-3",
        repaired: false,
      }),
      getCronProjectionDiagnostics: async () => ({
        schemaVersion: 1,
        revision: 7,
        projectionRevision: 3,
        sourceRevision: 4,
        sourceReason: "changed",
        sourceProjectedAtMs: 1_200,
        acceptedAtMs: 1_201,
        digest: "abc123",
        wakeCount: 2,
        nextRunAtMs: 1234,
        dispatchStatus: "scheduled",
        dispatchTokenHash: "deadbeefdeadbeef",
        dispatchRunAtMs: 1234,
        dispatchWakeAtMs: 1200,
        dispatchAttempt: 0,
        dispatchStartLeaseExpiresAtMs: null,
        dispatchScheduledAtMs: 1_202,
        dispatchClaimedAtMs: null,
        dispatchCompletedAtMs: null,
        dispatchFailedAtMs: null,
        dispatchRetryAtMs: null,
        workflowRunId: "wrun-3",
      }),
    }),
  );
  const check = findCheck(report, "cron.wake");
  assert.equal(check?.status, "pass");
  assert.equal(check?.data?.projectionRevision, 3);
  assert.equal(check?.data?.dispatchTokenHash, "deadbeefdeadbeef");
});

test("watchdog reports unverified cron capability as skipped", async () => {
  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      reconcileCronProjection: async () => ({
        status: "unsupported",
        projectionRevision: 3,
        nextRunAtMs: 1234,
        workflowRunId: null,
        repaired: false,
      }),
    }),
  );
  const check = findCheck(report, "cron.wake");
  assert.equal(check?.status, "skip");
  assert.match(check?.message ?? "", /bundle capability is not verified/);
});

test("watchdog marks stale cron dispatch repair as active repair", async () => {
  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      reconcileCronProjection: async () => ({
        status: "started",
        projectionRevision: 3,
        nextRunAtMs: 1234,
        workflowRunId: "wrun-repaired",
        repaired: true,
      }),
    }),
  );
  assert.equal(report.triggeredRepair, true);
  assert.equal(report.status, "repairing");
  assert.equal(findCheck(report, "cron.wake")?.status, "pass");
});

test("watchdog reports token refresh failure", async () => {
  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      refreshGatewayToken: async () => ({
        refreshed: false,
        reason: "refresh-failed: expired oidc token",
        retryAfterMs: 30_000,
      }),
    }),
  );

  assert.equal(report.status, "failed");
  assert.equal(report.lastError, "AI Gateway token refresh failed: refresh-failed: expired oidc token");
  const check = findCheck(report, "token.refresh");
  assert.equal(check?.status, "fail");
  assert.equal(check?.data?.retryAfterMs, 30_000);
});

test("running sandbox with failed probe schedules repair", async () => {
  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      probe: async () => ({ ready: false, error: "ECONNREFUSED" }),
    }),
  );

  assert.equal(report.status, "repairing");
  assert.equal(report.triggeredRepair, true);
  assert.equal(report.consecutiveFailures, 0);
  assert.equal(findCheck(report, "reconcile")?.status, "pass");
});

test("stopped sandbox stays idle and skips repair", async () => {
  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      getMeta: async () =>
        ({ status: "stopped", sandboxId: null }) as SingleMeta,
    }),
  );

  assert.equal(report.status, "idle");
  assert.equal(report.triggeredRepair, false);
  assert.equal(findCheck(report, "probe")?.status, "skip");
  assert.equal(findCheck(report, "cron.wake")?.status, "skip");
});

test("failed probe with repair disabled reports failed", async () => {
  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog"), repair: false },
    makeDeps({
      probe: async () => ({ ready: false, error: "timeout" }),
    }),
  );

  assert.equal(report.status, "failed");
  assert.equal(report.triggeredRepair, false);
  assert.equal(report.consecutiveFailures, 3);
});

test("consecutive failures increment on failure and reset on success", async () => {
  const failReport = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog"), repair: false },
    makeDeps({
      probe: async () => ({ ready: false, error: "timeout" }),
    }),
  );
  assert.equal(failReport.consecutiveFailures, 3);

  const okReport = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps(),
  );
  assert.equal(okReport.consecutiveFailures, 0);
});

test("stuck-busy recovery passes schedule callback to reconcile", async () => {
  let receivedSchedule: unknown = undefined;
  const fakeSchedule = () => {};
  const baseTime = Date.now();

  const report = await runSandboxWatchdog(
    {
      request: new Request("https://app.test/api/cron/watchdog"),
      schedule: fakeSchedule,
    },
    makeDeps({
      now: () => baseTime,
      getMeta: async () =>
        ({
          status: "restoring",
          sandboxId: null,
          updatedAt: baseTime - 120_000, // 2 minutes ago — past the 90s threshold
        }) as SingleMeta,
      reconcile: async (options) => {
        receivedSchedule = options.schedule;
        return {
          status: "recovering" as const,
          repaired: false,
          meta: { status: "restoring" } as SingleMeta,
        };
      },
    }),
  );

  assert.equal(receivedSchedule, fakeSchedule, "schedule callback must be forwarded to reconcile");
  assert.equal(report.status, "repairing");
  assert.equal(findCheck(report, "reconcile")?.status, "pass");
});

test("auto-slept sandbox reconciled to stopped without repair", async () => {
  let probeCalled = false;
  let reconcileCalled = false;

  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      // SDK reports sandbox is no longer running (auto-slept)
      reconcileStale: async () =>
        ({ status: "stopped", sandboxId: null }) as SingleMeta,
      probe: async () => {
        probeCalled = true;
        return { ready: false, error: "should not be called" };
      },
      reconcile: async () => {
        reconcileCalled = true;
        return {
          status: "recovering" as const,
          repaired: true,
          meta: { status: "booting" } as SingleMeta,
        };
      },
    }),
  );

  assert.equal(probeCalled, false, "Gateway probe must not be called when SDK says sandbox stopped");
  assert.equal(reconcileCalled, false, "Repair must not be triggered for naturally slept sandbox");
  assert.equal(report.status, "idle");
  assert.equal(report.sandboxStatus, "stopped");
  assert.equal(report.triggeredRepair, false);
  assert.equal(findCheck(report, "probe")?.status, "skip");
  assert.ok(findCheck(report, "probe")?.message?.includes("SDK reports sandbox is stopped"));
  assert.equal(findCheck(report, "reconcile")?.status, "skip");
});

test("probe-failed recovery passes schedule callback to reconcile", async () => {
  let receivedSchedule: unknown = undefined;
  const fakeSchedule = () => {};

  const report = await runSandboxWatchdog(
    {
      request: new Request("https://app.test/api/cron/watchdog"),
      schedule: fakeSchedule,
    },
    makeDeps({
      probe: async () => ({ ready: false, error: "ECONNREFUSED" }),
      reconcile: async (options) => {
        receivedSchedule = options.schedule;
        return {
          status: "recovering" as const,
          repaired: true,
          meta: { status: "booting" } as SingleMeta,
        };
      },
    }),
  );

  assert.equal(receivedSchedule, fakeSchedule, "schedule callback must be forwarded to reconcile");
  assert.equal(report.status, "repairing");
});

// ===========================================================================
// Restore oracle integration (restore.prepare check)
// ===========================================================================

test("restore.prepare: skip when oracle reports already-ready", async () => {
  const decision = stubDecision({ reusable: true, needsPrepare: false, blocking: false });
  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      runRestoreOracle: async () => oracleResult({
        executed: false,
        blockedReason: "already-ready",
        idleMs: 600_000,
        minIdleMs: 300_000,
        attestation: { reusable: true, needsPrepare: false, reasons: [] },
        plan: { schemaVersion: 1, status: "ready", blocking: false, reasons: [], actions: [] },
        prepare: null,
        decision,
      }),
    }),
  );

  assert.equal(report.status, "ok");
  const check = findCheck(report, "restore.prepare");
  assert.ok(check, "should have restore.prepare check");
  assert.equal(check.status, "skip");
  assert.ok(check.message.includes("already reusable"));

  // Structured data includes decision
  assert.ok(check.data, "check should have structured data");
  assert.equal(check.data.blockedReason, "already-ready");
  assert.equal((check.data.decision as RestoreDecision).reusable, true);
});

test("restore.prepare: skip when sandbox recently active", async () => {
  const decision = stubDecision({
    reusable: false,
    reasons: ["snapshot-config-stale", "sandbox-recently-active"],
    requiredActions: ["prepare-destructive"],
    nextAction: "prepare-destructive",
  });
  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      runRestoreOracle: async () => oracleResult({
        executed: false,
        blockedReason: "sandbox-recently-active",
        idleMs: 60_000,
        minIdleMs: 300_000,
        attestation: { reusable: false, needsPrepare: true, reasons: ["snapshot-config-stale"] },
        plan: { schemaVersion: 1, status: "needs-prepare", blocking: true, reasons: [], actions: [] },
        prepare: null,
        decision,
      }),
    }),
  );

  assert.equal(report.status, "ok");
  const check = findCheck(report, "restore.prepare");
  assert.ok(check, "should have restore.prepare check");
  assert.equal(check.status, "skip");
  assert.ok(check.message.includes("sandbox-recently-active"));

  // Structured data includes decision with reasons and required actions
  assert.ok(check.data, "check should have structured data");
  assert.deepEqual(
    (check.data.decision as RestoreDecision).requiredActions,
    ["prepare-destructive"],
  );
  assert.ok((check.data.decision as RestoreDecision).reasons.includes("snapshot-config-stale"));
});

test("restore.prepare: pass when oracle executes and prepares successfully", async () => {
  const decision = stubDecision({
    reusable: false,
    reasons: ["snapshot-config-stale"],
    requiredActions: ["prepare-destructive"],
    nextAction: "prepare-destructive",
  });
  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      runRestoreOracle: async () => oracleResult({
        executed: true,
        blockedReason: null,
        idleMs: 600_000,
        minIdleMs: 300_000,
        attestation: { reusable: false, needsPrepare: true, reasons: ["snapshot-config-stale"] },
        plan: { schemaVersion: 1, status: "needs-prepare", blocking: true, reasons: [], actions: [] },
        prepare: {
          ok: true,
          destructive: true,
          state: "ready",
          reason: "prepared",
          snapshotId: "snap_fresh",
          snapshotDynamicConfigHash: "hash",
          runtimeDynamicConfigHash: "hash",
          snapshotAssetSha256: "sha",
          runtimeAssetSha256: "sha",
          preparedAt: Date.now(),
          actions: [],
        },
        decision,
      }),
    }),
  );

  assert.equal(report.status, "repairing");
  assert.equal(report.triggeredRepair, true);
  const check = findCheck(report, "restore.prepare");
  assert.ok(check, "should have restore.prepare check");
  assert.equal(check.status, "pass");
  assert.ok(check.message.includes("snap_fresh"));

  // Structured data present on pass
  assert.ok(check.data, "check should have structured data");
  assert.equal(check.data.blockedReason, null);
  assert.ok((check.data.decision as RestoreDecision).reasons.includes("snapshot-config-stale"));

  // Hot-spare fields populated from default (skipped) prepareHotSpare
  assert.equal(check.data.hotSpareReason, "skipped");
  assert.equal(check.data.hotSpareCandidateSandboxId, null);
});

test("restore.prepare: pass with hot-spare created after oracle prepare", async () => {
  const decision = stubDecision({
    reusable: false,
    reasons: ["snapshot-config-stale"],
    requiredActions: ["prepare-destructive"],
    nextAction: "prepare-destructive",
  });
  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      runRestoreOracle: async () => oracleResult({
        executed: true,
        blockedReason: null,
        idleMs: 600_000,
        minIdleMs: 300_000,
        attestation: { reusable: false, needsPrepare: true, reasons: ["snapshot-config-stale"] },
        plan: { schemaVersion: 1, status: "needs-prepare", blocking: true, reasons: [], actions: [] },
        prepare: {
          ok: true,
          destructive: true,
          state: "ready",
          reason: "prepared",
          snapshotId: "snap_fresh",
          snapshotDynamicConfigHash: "hash",
          runtimeDynamicConfigHash: "hash",
          snapshotAssetSha256: "sha",
          runtimeAssetSha256: "sha",
          preparedAt: Date.now(),
          actions: [],
        },
        decision,
      }),
      prepareHotSpare: async () => ({
        ok: true,
        reason: "created" as const,
        candidateSandboxId: "oc-spare-single-abc",
      }),
    }),
  );

  assert.equal(report.status, "repairing");
  assert.equal(report.triggeredRepair, true);
  const check = findCheck(report, "restore.prepare");
  assert.ok(check, "should have restore.prepare check");
  assert.equal(check.status, "pass");

  // Hot-spare result fields present in structured data
  assert.ok(check.data, "check should have structured data");
  assert.equal(check.data.hotSpareCandidateSandboxId, "oc-spare-single-abc");
  assert.equal(check.data.hotSpareReason, "created");
});

test("restore.prepare: fail when oracle executes but prepare fails", async () => {
  const decision = stubDecision({
    reusable: false,
    reasons: ["snapshot-config-stale"],
    requiredActions: ["prepare-destructive"],
    nextAction: "prepare-destructive",
  });
  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      runRestoreOracle: async () => oracleResult({
        executed: true,
        blockedReason: null,
        idleMs: 600_000,
        minIdleMs: 300_000,
        attestation: { reusable: false, needsPrepare: true, reasons: ["snapshot-config-stale"] },
        plan: { schemaVersion: 1, status: "needs-prepare", blocking: true, reasons: [], actions: [] },
        prepare: {
          ok: false,
          destructive: true,
          state: "failed",
          reason: "prepare-failed",
          snapshotId: null,
          snapshotDynamicConfigHash: null,
          runtimeDynamicConfigHash: null,
          snapshotAssetSha256: null,
          runtimeAssetSha256: null,
          preparedAt: null,
          actions: [{ id: "snapshot", status: "failed", message: "Snapshot timed out." }],
        },
        decision,
      }),
    }),
  );

  assert.equal(report.status, "failed");
  const check = findCheck(report, "restore.prepare");
  assert.ok(check, "should have restore.prepare check");
  assert.equal(check.status, "fail");
  assert.ok(check.message.includes("Snapshot timed out"));

  // Structured data present on failure
  assert.ok(check.data, "check should have structured data");
  assert.deepEqual(
    (check.data.decision as RestoreDecision).requiredActions,
    ["prepare-destructive"],
  );
});

test("restore.prepare: fail when oracle throws", async () => {
  const report = await runSandboxWatchdog(
    { request: new Request("https://app.test/api/cron/watchdog") },
    makeDeps({
      runRestoreOracle: async () => {
        throw new Error("Sandbox API unreachable");
      },
    }),
  );

  assert.equal(report.status, "failed");
  const check = findCheck(report, "restore.prepare");
  assert.ok(check, "should have restore.prepare check");
  assert.equal(check.status, "fail");
  assert.ok(check.message.includes("Sandbox API unreachable"));
});
