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

test("a silent projection source yields its bounded lease without clock or UUID ordering", async () => {
  const store = new MemoryStore();
  const first = input(1, [{ jobId: "first", runAtMs: 100 }]);
  first.sourceId = "gateway-source-old";
  first.sourceStartedAtMs = 2_000;
  await acceptCronProjection(first, { store, now: () => 1_000 });

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
    { ...first, sourceRevision: 2 },
    { store, now: () => 1_001 + CRON_PROJECTION_SOURCE_LEASE_MS },
  );
  assert.equal(oldRetry.status, "stale");
  assert.ok(
    oldRetry.status === "stale" &&
      oldRetry.retryAfterMs !== null &&
      oldRetry.retryAfterMs > 0,
  );
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
      scheduledAtMs: 1_600,
    };
    return record;
  }, store);

  const fenced = await fenceCronProjectionStateForReset({
    gatewayGeneration: "2".repeat(32),
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
      claimedAtMs: 1_600,
    };
    return record;
  }, store);

  const fenced = await fenceCronProjectionStateForReset({
    gatewayGeneration: "2".repeat(32),
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
    store,
    now: () => 2_000,
  });

  assert.equal(await store.hasValue(cronNextWakeKey()), true);
  assert.equal(await store.hasValue(cronJobsKey()), true);
  await clearLegacyCronStateForReset(store);
  assert.equal(await store.hasValue(cronNextWakeKey()), false);
  assert.equal(await store.hasValue(cronJobsKey()), false);
});

test("reset atomically replaces the exact corrupt value without deleting a concurrent projection", async () => {
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

  const fenced = await fenceCronProjectionStateForReset({
    gatewayGeneration: "2".repeat(32),
    store,
    now: () => 2_000,
  });
  assert.equal(fenced.record.projectionRevision, 2);
  assert.equal(fenced.record.revision, replacement.record.revision + 1);
});

test("sandbox startup repairs a reset fence after gateway-token commit failure", async () => {
  const store = new MemoryStore();
  await fenceCronProjectionStateForReset({
    gatewayGeneration: "a".repeat(32),
    store,
    now: () => 1_000,
  });

  await normalizeResetCronProjectionGeneration({
    gatewayGeneration: "b".repeat(32),
    store,
  });

  const record = await readCronProjection(store);
  assert.equal(record?.gatewayGeneration, "b".repeat(32));
  assert.equal(record?.source, null);
  assert.equal(record?.dispatch.status, "none");
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
