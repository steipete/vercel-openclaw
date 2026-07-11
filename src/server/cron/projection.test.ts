import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  acceptCronProjection,
  clearLegacyCronStateAfterBaseline,
  clearLegacyCronStateForReset,
  CRON_PROJECTION_MAX_BODY_BYTES,
  CRON_PROJECTION_MAX_WAKES,
  CRON_PROJECTION_SOURCE_LEASE_MS,
  fenceCronProjectionStateForReset,
  getCronProjectionDiagnostics,
  isCronProjectionRecord,
  migrateLegacyCronWake,
  mutateCronProjection,
  normalizeResetCronProjectionGeneration,
  parseCronProjectionInput,
  readCronProjection,
  readCronProjectionState,
} from "@/server/cron/projection";
import {
  cronJobsKey,
  cronNextWakeKey,
  cronProjectionKey,
} from "@/server/store/keyspace";
import { MemoryStore } from "@/server/store/memory-store";

function input(
  revision: number,
  wakes: Array<{ jobId: string; runAtMs: number }>,
) {
  return {
    schemaVersion: 1 as const,
    gatewayGeneration: "1".repeat(32),
    sourceId: "gateway-source-1",
    sourceLeaseToken: null,
    sourceStartedAtMs: 1_800_000_000_000,
    sourceRevision: revision,
    reason: revision === 1 ? ("startup" as const) : ("changed" as const),
    projectedAtMs: 1_800_000_000_000 + revision,
    wakes: wakes.map((wake) => ({
      jobKey: createHash("sha256")
        .update(wake.jobId)
        .digest("hex")
        .slice(0, 32),
      runAtMs: wake.runAtMs,
    })),
  };
}

test("cron projection validates the bounded earliest-wake snapshot shape", () => {
  const options = { now: () => 1_800_000_000_000 };
  assert.equal(parseCronProjectionInput(input(1, []), options).ok, true);
  const legacyInput: Record<string, unknown> = { ...input(1, []) };
  delete legacyInput.sourceLeaseToken;
  const parsedLegacy = parseCronProjectionInput(legacyInput, options);
  assert.equal(parsedLegacy.ok, true);
  if (parsedLegacy.ok) {
    assert.equal(parsedLegacy.value.sourceLeaseTokenProvided, false);
  }
  assert.deepEqual(parseCronProjectionInput({ schemaVersion: 2 }), {
    ok: false,
    message: "schemaVersion must be 1",
  });
  assert.equal(
    parseCronProjectionInput(
      input(1, [
        { jobId: "same", runAtMs: 10 },
        { jobId: "same", runAtMs: 20 },
      ]),
      options,
    ).ok,
    false,
  );
  assert.equal(
    parseCronProjectionInput(
      input(1, [{ jobId: "invalid-date", runAtMs: Number.MAX_SAFE_INTEGER }]),
      options,
    ).ok,
    false,
  );
  assert.equal(
    parseCronProjectionInput(
      { ...input(1, []), sourceStartedAtMs: Number.MAX_SAFE_INTEGER },
      options,
    ).ok,
    false,
  );
});

test("maximum legal projection fits the authenticated route body cap", () => {
  const wakes = Array.from({ length: CRON_PROJECTION_MAX_WAKES }, (_, index) => ({
    jobKey: index.toString(16).padStart(32, "0"),
    runAtMs: 1_800_000_000_000 + index,
  }));
  const payload = { ...input(1, []), wakes };
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= CRON_PROJECTION_MAX_BODY_BYTES);
  assert.equal(
    parseCronProjectionInput(payload, { now: () => 1_800_000_000_000 }).ok,
    true,
  );
});

test("cron projection stores only hashed job keys and ordered wake times", async () => {
  const store = new MemoryStore();
  const accepted = await acceptCronProjection(
    input(1, [
      { jobId: "private-nightly-report", runAtMs: 200 },
      { jobId: "private-daily-brief", runAtMs: 100 },
    ]),
    { store, now: () => 50 },
  );
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.record.nextRunAtMs, 100);
  assert.deepEqual(accepted.record.wakes.map((wake) => wake.runAtMs), [100, 200]);
  assert.equal(JSON.stringify(accepted.record).includes("private-"), false);
  assert.equal(JSON.stringify(accepted.record).includes("gateway-source-1"), false);
  assert.equal(accepted.record.dispatch.status, "pending");
});

test("cron projection rejects malformed persisted records", async () => {
  const store = new MemoryStore();
  const accepted = await acceptCronProjection(
    input(1, [{ jobId: "private-job", runAtMs: 100 }]),
    { store, now: () => 50 },
  );
  assert.equal(isCronProjectionRecord(accepted.record), true);
  assert.equal(
    isCronProjectionRecord({
      ...accepted.record,
      nextRunAtMs: 101,
    }),
    false,
  );
  assert.equal(
    isCronProjectionRecord({ ...accepted.record, digest: "0".repeat(64) }),
    false,
  );
  assert.equal(
    isCronProjectionRecord({
      ...accepted.record,
      dispatch: { status: "pending", token: "short", runAtMs: 100, attempt: 0 },
    }),
    false,
  );
  assert.equal(
    isCronProjectionRecord({
      ...accepted.record,
      source: { ...accepted.record.source, key: "raw-source-id" },
    }),
    false,
  );
});

test("corrupt projection state is explicit rather than treated as absent", async () => {
  const store = new MemoryStore();
  await store.setValue(cronProjectionKey(), { schemaVersion: 1, revision: 1 });
  assert.equal((await readCronProjectionState(store)).status, "corrupt");
  await assert.rejects(readCronProjection(store), /cron_projection_state_corrupt/);
});

test("schema-v1 records atomically migrate newly required ownership fields", async () => {
  const store = new MemoryStore();
  const accepted = await acceptCronProjection(
    input(1, [{ jobId: "legacy", runAtMs: 100 }]),
    { store },
  );
  assert.ok(accepted.record.source);
  const legacySource: Record<string, unknown> = {
    ...accepted.record.source,
  };
  delete legacySource.epoch;
  delete legacySource.leaseToken;
  await store.setValue(cronProjectionKey(), {
    ...accepted.record,
    source: legacySource,
    dispatch: {
      ...accepted.record.dispatch,
      status: "scheduled",
      workflowRunId: "wrun-legacy-parent",
      scheduledAtMs: 200,
    },
  });

  const migrated = await readCronProjectionState(store);
  assert.equal(migrated.status, "valid");
  if (migrated.status !== "valid") return;
  assert.equal(migrated.record.source?.epoch, 1);
  assert.ok(migrated.record.source?.leaseToken);
  assert.equal(migrated.record.revision, accepted.record.revision + 1);
  assert.equal(migrated.record.dispatch.status, "scheduled");
  if (migrated.record.dispatch.status === "scheduled") {
    assert.equal(migrated.record.dispatch.executionWorkflowRunId, null);
    assert.equal(migrated.record.dispatch.legacyWorkflowOwner, true);
  }
  assert.equal(
    await store.compareAndSetValue(
      cronProjectionKey(),
      accepted.record.revision,
      { ...migrated.record, revision: migrated.record.revision + 1 },
    ),
    false,
  );
});

test("schema-v1 migration rearms ownerless starts and preserves old execution ids", async () => {
  const store = new MemoryStore();
  const accepted = await acceptCronProjection(
    input(1, [{ jobId: "legacy", runAtMs: 100 }]),
    { store },
  );
  assert.notEqual(accepted.record.dispatch.status, "none");
  if (accepted.record.dispatch.status === "none") return;
  const oldToken = accepted.record.dispatch.token;
  await store.setValue(cronProjectionKey(), {
    ...accepted.record,
    dispatch: {
      ...accepted.record.dispatch,
      status: "starting",
      startLeaseExpiresAtMs: 200,
    },
  });
  const rearmed = await readCronProjection(store);
  assert.equal(rearmed?.dispatch.status, "pending");
  assert.notEqual(
    rearmed?.dispatch.status === "pending" ? rearmed.dispatch.token : null,
    oldToken,
  );

  for (const status of ["running", "completed"] as const) {
    const timestamp = status === "running"
      ? { claimedAtMs: 300 }
      : { completedAtMs: 300 };
    await store.setValue(cronProjectionKey(), {
      ...accepted.record,
      dispatch: {
        ...accepted.record.dispatch,
        status,
        workflowRunId: `wrun-legacy-${status}`,
        ...timestamp,
      },
    });
    const migrated = await readCronProjection(store);
    assert.equal(migrated?.dispatch.status, status);
    if (
      migrated?.dispatch.status === "running" ||
      migrated?.dispatch.status === "completed"
    ) {
      assert.equal(
        migrated.dispatch.executionWorkflowRunId,
        `wrun-legacy-${status}`,
      );
      assert.equal(migrated.dispatch.legacyWorkflowOwner, true);
    }
  }
});

test("a silent projection source yields its bounded lease without clock or UUID ordering", async () => {
  const store = new MemoryStore();
  const first = {
    ...input(1, [{ jobId: "first", runAtMs: 100 }]),
    sourceLeaseTokenProvided: false,
  };
  first.sourceId = "gateway-source-old";
  first.sourceStartedAtMs = 2_000;
  await acceptCronProjection(first, {
    store,
    now: () => 1_000,
  });

  const replacement = input(1, [{ jobId: "replacement", runAtMs: 200 }]);
  replacement.sourceId = "gateway-source-new";
  replacement.sourceStartedAtMs = 1_000;
  const leased = await acceptCronProjection(replacement, {
    store,
    now: () => 1_001,
  });
  assert.equal(leased.status, "stale");
  assert.equal(
    leased.status === "stale" ? leased.retryAfterMs : null,
    CRON_PROJECTION_SOURCE_LEASE_MS - 1,
  );

  const adopted = await acceptCronProjection(replacement, {
    store,
    now: () => 1_000 + CRON_PROJECTION_SOURCE_LEASE_MS,
  });
  assert.equal(adopted.status, "accepted");
  assert.equal(adopted.record.nextRunAtMs, 200);

  const oldRetry = await acceptCronProjection(
    {
      ...first,
      sourceLeaseToken: null,
      sourceLeaseTokenProvided: false,
      sourceRevision: 2,
    },
    { store, now: () => 1_000 + 10 * CRON_PROJECTION_SOURCE_LEASE_MS },
  );
  assert.equal(oldRetry.status, "stale");
  assert.equal(oldRetry.status === "stale" ? oldRetry.retryAfterMs : 0, null);
});

test("host clock rollback expires source ownership instead of wedging takeover", async () => {
  const store = new MemoryStore();
  await acceptCronProjection(input(1, [{ jobId: "old", runAtMs: 100 }]), {
    store,
    now: () => 10_000,
  });
  const replacement = input(1, [{ jobId: "new", runAtMs: 200 }]);
  replacement.sourceId = "gateway-source-after-rollback";
  const adopted = await acceptCronProjection(replacement, {
    store,
    now: () => 5_000,
  });
  assert.equal(adopted.status, "accepted");
  assert.equal(adopted.record.nextRunAtMs, 200);
});

test("cron projection is idempotent, rejects stale revisions, and atomically replaces all", async () => {
  const store = new MemoryStore();
  const first = await acceptCronProjection(input(1, [{ jobId: "a", runAtMs: 100 }]), {
    store,
  });
  const repeated = await acceptCronProjection(input(1, [{ jobId: "a", runAtMs: 100 }]), {
    store,
  });
  const second = await acceptCronProjection(input(2, [{ jobId: "b", runAtMs: 300 }]), {
    store,
  });
  const stale = await acceptCronProjection(input(1, [{ jobId: "a", runAtMs: 50 }]), {
    store,
  });
  const cleared = await acceptCronProjection(input(3, []), { store });

  assert.equal(first.status, "accepted");
  assert.equal(repeated.status, "idempotent");
  assert.equal(second.status, "accepted");
  assert.equal(second.record.projectionRevision, 2);
  assert.equal(stale.status, "stale");
  assert.equal(cleared.status, "accepted");
  assert.equal(cleared.record.nextRunAtMs, null);
  assert.deepEqual(cleared.record.wakes, []);
  assert.deepEqual(cleared.record.dispatch, { status: "none" });
});

test("newer identical snapshots advance the source cursor without replacing dispatch", async () => {
  const store = new MemoryStore();
  const first = await acceptCronProjection(
    input(1, [{ jobId: "same-job", runAtMs: 100 }]),
    { store, now: () => 50 },
  );
  assert.notEqual(first.record.dispatch.status, "none");
  const dispatchClaim = first.record.dispatch.status === "none"
    ? ""
    : first.record.dispatch.token;

  const newer = await acceptCronProjection(
    input(2, [{ jobId: "same-job", runAtMs: 100 }]),
    { store, now: () => 60 },
  );
  assert.equal(newer.status, "idempotent");
  assert.equal(newer.record.projectionRevision, first.record.projectionRevision);
  assert.equal(newer.record.source?.revision, 2);
  assert.equal(newer.record.acceptedAtMs, 60);
  assert.equal(
    newer.record.dispatch.status === "none" ? "" : newer.record.dispatch.token,
    dispatchClaim,
  );

  const stale = await acceptCronProjection(
    input(1, [{ jobId: "same-job", runAtMs: 100 }]),
    { store, now: () => 70 },
  );
  assert.equal(stale.status, "stale");
  assert.equal(stale.record.source?.revision, 2);
});

test("legacy migration imports only the wake and retains the jobs backup after baseline", async () => {
  const store = new MemoryStore();
  await store.setValue(cronNextWakeKey(), 1234);
  await store.setValue(cronJobsKey(), {
    jobs: [{ id: "secret-job", payload: { text: "do not persist" } }],
  });

  assert.equal(
    await migrateLegacyCronWake({ store, enabled: false }),
    null,
    "old OpenClaw pins must not adopt the new projection migration",
  );
  const migrated = await migrateLegacyCronWake({
    store,
    enabled: true,
    now: () => 1000,
  });
  assert.equal(migrated?.source, null);
  assert.equal(migrated?.nextRunAtMs, 1234);
  assert.deepEqual(migrated?.wakes, []);
  assert.equal(JSON.stringify(migrated).includes("secret-job"), false);

  await acceptCronProjection(input(1, [{ jobId: "current", runAtMs: 2000 }]), {
    store,
    now: () => 1500,
  });
  await clearLegacyCronStateAfterBaseline({ store, now: () => 1600 });
  assert.equal(await store.getValue(cronNextWakeKey()), null);
  assert.equal(await store.hasValue(cronJobsKey()), true);
  assert.equal(
    (await readCronProjection(store))?.migration.legacyWakeClearedAtMs,
    1600,
  );
});

test("legacy jobs presence can arm one migration bootstrap wake without reading payload", async () => {
  const store = new MemoryStore();
  await store.setValue(cronJobsKey(), {
    jobs: [{ id: "private-job", payload: { text: "must-not-import" } }],
  });
  const migrated = await migrateLegacyCronWake({
    store,
    enabled: true,
    bootstrapFromLegacyJobs: true,
    now: () => 2_000,
  });
  assert.equal(migrated?.nextRunAtMs, 2_000);
  assert.equal(migrated?.migration.legacyWakeImportedAtMs, null);
  assert.equal(migrated?.migration.legacyBootstrapWakeAtMs, 2_000);
  assert.equal(JSON.stringify(migrated).includes("private-job"), false);
  assert.equal(await store.hasValue(cronJobsKey()), true);
});

test("authoritative baselines repeatedly scrub only the legacy wake key", async () => {
  const store = new MemoryStore();
  await acceptCronProjection(input(1, []), { store, now: () => 1_500 });
  await clearLegacyCronStateAfterBaseline({ store, now: () => 1_600 });

  await store.setValue(cronNextWakeKey(), 2_000);
  await store.setValue(cronJobsKey(), { private: "must-be-preserved" });
  await clearLegacyCronStateAfterBaseline({ store, now: () => 1_700 });

  assert.equal(await store.hasValue(cronNextWakeKey()), false);
  assert.equal(await store.hasValue(cronJobsKey()), true);
  assert.equal(
    (await readCronProjection(store))?.migration.legacyWakeClearedAtMs,
    1_600,
  );
});

test("reset generation rejects old sources across clock skew", async () => {
  const store = new MemoryStore();
  const old = input(1, [{ jobId: "old", runAtMs: 5_000 }]);
  old.sourceStartedAtMs = 5_000;
  old.projectedAtMs = 5_500;
  await acceptCronProjection(old, { store, now: () => 1_500 });
  const fenced = await fenceCronProjectionStateForReset({
    gatewayGeneration: "2".repeat(32),
    expectedGatewayGeneration: "1".repeat(32),
    store,
    now: () => 2_000,
  });
  const fence = fenced.record;
  assert.equal(fence.resetAtMs, 2_000);
  assert.equal(fence.dispatch.status, "none");
  assert.equal((await acceptCronProjection(old, { store })).status, "stale");

  const replacement = input(1, [{ jobId: "new", runAtMs: 6_000 }]);
  replacement.gatewayGeneration = "2".repeat(32);
  replacement.sourceStartedAtMs = 1_000;
  replacement.projectedAtMs = 3_000;
  assert.equal(
    (await acceptCronProjection(replacement, { store, now: () => 3_000 })).status,
    "accepted",
  );
});

test("reset fence resumes idempotently after token-transition worker loss", async () => {
  const store = new MemoryStore();
  await acceptCronProjection(
    input(1, [{ jobId: "old", runAtMs: 5_000 }]),
    { store, now: () => 1_500 },
  );
  const first = await fenceCronProjectionStateForReset({
    gatewayGeneration: "2".repeat(32),
    expectedGatewayGeneration: "1".repeat(32),
    store,
    now: () => 2_000,
  });

  const resumed = await fenceCronProjectionStateForReset({
    gatewayGeneration: "2".repeat(32),
    expectedGatewayGeneration: "1".repeat(32),
    store,
    now: () => 3_000,
  });

  assert.deepEqual(resumed.record, first.record);
  assert.equal(resumed.supersededWorkflowRunId, null);
});

test("reset fence returns the obsolete sleeping Workflow for cancellation", async () => {
  const store = new MemoryStore();
  await acceptCronProjection(
    input(1, [{ jobId: "old", runAtMs: 5_000 }]),
    { store, now: () => 1_500 },
  );
  await mutateCronProjection((record) => {
    assert.equal(record.dispatch.status, "pending");
    if (record.dispatch.status !== "pending") return null;
    record.dispatch = {
      ...record.dispatch,
      status: "scheduled",
      workflowRunId: "wrun-reset",
      executionWorkflowRunId: null,
      scheduledAtMs: 1_600,
    };
    return record;
  }, store);

  const fenced = await fenceCronProjectionStateForReset({
    gatewayGeneration: "2".repeat(32),
    expectedGatewayGeneration: "1".repeat(32),
    store,
    now: () => 2_000,
  });
  assert.equal(fenced.supersededWorkflowRunId, "wrun-reset");
  assert.equal(fenced.record.dispatch.status, "none");
});

test("reset fence returns the active wake Workflow for cancellation", async () => {
  const store = new MemoryStore();
  await acceptCronProjection(
    input(1, [{ jobId: "running", runAtMs: 5_000 }]),
    { store, now: () => 1_500 },
  );
  await mutateCronProjection((record) => {
    assert.equal(record.dispatch.status, "pending");
    if (record.dispatch.status !== "pending") return null;
    record.dispatch = {
      ...record.dispatch,
      status: "running",
      workflowRunId: "wrun-running-reset",
      executionWorkflowRunId: "wrun-running-execution-reset",
      claimedAtMs: 1_600,
    };
    return record;
  }, store);

  const fenced = await fenceCronProjectionStateForReset({
    gatewayGeneration: "2".repeat(32),
    expectedGatewayGeneration: "1".repeat(32),
    store,
    now: () => 2_000,
  });
  assert.equal(fenced.supersededWorkflowRunId, "wrun-running-reset");
  assert.equal(fenced.record.dispatch.status, "none");
});

test("reset fence leaves legacy cleanup to the post-destroy commit", async () => {
  const store = new MemoryStore();
  await store.setValue(cronNextWakeKey(), 5_000);
  await store.setValue(cronJobsKey(), { jobs: ["private"] });

  await fenceCronProjectionStateForReset({
    gatewayGeneration: "2".repeat(32),
    expectedGatewayGeneration: null,
    store,
    now: () => 2_000,
  });

  assert.equal(await store.hasValue(cronNextWakeKey()), true);
  assert.equal(await store.hasValue(cronJobsKey()), true);
  const fence = await readCronProjection(store);
  assert.ok(fence?.gatewayGeneration);
  assert.equal(
    await clearLegacyCronStateForReset({
      gatewayGeneration: fence.gatewayGeneration,
      projectionRevision: fence.projectionRevision,
      store,
    }),
    true,
  );
  assert.equal(await store.hasValue(cronNextWakeKey()), false);
  assert.equal(await store.hasValue(cronJobsKey()), false);
});

test("legacy reset cleanup refuses a successor projection", async () => {
  const store = new MemoryStore();
  await store.setValue(cronJobsKey(), { jobs: ["private"] });
  const fenced = await fenceCronProjectionStateForReset({
    gatewayGeneration: "2".repeat(32),
    expectedGatewayGeneration: null,
    store,
    now: () => 2_000,
  });
  const successor = input(1, []);
  successor.gatewayGeneration = "2".repeat(32);
  successor.sourceId = "gateway-successor";
  await acceptCronProjection(successor, { store, now: () => 2_001 });

  assert.equal(
    await clearLegacyCronStateForReset({
      gatewayGeneration: fenced.record.gatewayGeneration!,
      projectionRevision: fenced.record.projectionRevision,
      store,
    }),
    false,
  );
  assert.equal(await store.hasValue(cronJobsKey()), true);
});

test("reset refuses a concurrent replacement after corrupt-state CAS loss", async () => {
  const store = new MemoryStore();
  await store.setValue(cronProjectionKey(), { schemaVersion: 1, revision: 1 });
  const replacementStore = new MemoryStore();
  const replacement = await acceptCronProjection(
    input(1, [{ jobId: "concurrent", runAtMs: 5_000 }]),
    { store: replacementStore, now: () => 1_500 },
  );
  const compareToken = store.compareAndSetValueToken.bind(store);
  let injected = false;
  store.compareAndSetValueToken = async (key, token, next) => {
    if (!injected) {
      injected = true;
      await store.setValue(key, replacement.record);
    }
    return compareToken(key, token, next);
  };

  await assert.rejects(
    fenceCronProjectionStateForReset({
      gatewayGeneration: "2".repeat(32),
      expectedGatewayGeneration: null,
      store,
      now: () => 2_000,
    }),
    /cron_projection_reset_generation_superseded/,
  );
  assert.deepEqual(await readCronProjection(store), replacement.record);
});

test("sandbox startup repairs a reset fence after gateway-token commit failure", async () => {
  const store = new MemoryStore();
  await fenceCronProjectionStateForReset({
    gatewayGeneration: "a".repeat(32),
    expectedGatewayGeneration: null,
    store,
    now: () => 1_000,
  });

  await normalizeResetCronProjectionGeneration({
    gatewayGeneration: "b".repeat(32),
    expectedGatewayGeneration: "a".repeat(32),
    store,
  });

  const record = await readCronProjection(store);
  assert.equal(record?.gatewayGeneration, "b".repeat(32));
  assert.equal(record?.source, null);
  assert.equal(record?.dispatch.status, "none");
});

test("sandbox startup normalization refuses a stale expected generation", async () => {
  const store = new MemoryStore();
  await fenceCronProjectionStateForReset({
    gatewayGeneration: "a".repeat(32),
    expectedGatewayGeneration: null,
    store,
    now: () => 1_000,
  });

  const unchanged = await normalizeResetCronProjectionGeneration({
    gatewayGeneration: "c".repeat(32),
    expectedGatewayGeneration: "b".repeat(32),
    store,
  });

  assert.equal(unchanged?.gatewayGeneration, "a".repeat(32));
  assert.equal((await readCronProjection(store))?.gatewayGeneration, "a".repeat(32));
});

test("sandbox startup normalization loses CAS to a successor generation", async () => {
  const store = new MemoryStore();
  const initial = await fenceCronProjectionStateForReset({
    gatewayGeneration: "a".repeat(32),
    expectedGatewayGeneration: null,
    store,
    now: () => 1_000,
  });
  const compare = store.compareAndSetValue.bind(store);
  let injected = false;
  store.compareAndSetValue = async (key, revision, next) => {
    if (!injected) {
      injected = true;
      await store.setValue(key, {
        ...initial.record,
        gatewayGeneration: "c".repeat(32),
        revision: initial.record.revision + 1,
      });
    }
    return compare(key, revision, next);
  };

  const result = await normalizeResetCronProjectionGeneration({
    gatewayGeneration: "b".repeat(32),
    expectedGatewayGeneration: "a".repeat(32),
    store,
  });

  assert.equal(result?.gatewayGeneration, "c".repeat(32));
  assert.equal((await readCronProjection(store))?.gatewayGeneration, "c".repeat(32));
});

test("cron projection diagnostics hash dispatch tokens and omit source identities", async () => {
  const store = new MemoryStore();
  const accepted = await acceptCronProjection(
    input(1, [{ jobId: "private-job", runAtMs: 100 }]),
    { store },
  );
  assert.notEqual(accepted.record.dispatch.status, "none");
  const dispatchClaim = accepted.record.dispatch.status === "none"
    ? ""
    : accepted.record.dispatch.token;
  const diagnostics = await getCronProjectionDiagnostics(store);
  assert.equal(diagnostics?.wakeCount, 1);
  assert.equal(diagnostics?.sourceRevision, 1);
  assert.equal(diagnostics?.sourceProjectedAtMs, 1_800_000_000_001);
  assert.ok(diagnostics?.acceptedAtMs);
  assert.equal(JSON.stringify(diagnostics).includes("gateway-source-1"), false);
  assert.equal(JSON.stringify(diagnostics).includes(dispatchClaim), false);
  assert.equal(diagnostics?.dispatchTokenHash?.length, 16);
});
