import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock, test } from "node:test";

import {
  claimCronWake,
  cancelSupersededCronWake,
  completeCronWake,
  cronDispatchWorkflowRuntime,
  isCronWakeClaimCurrent,
  recordCronWakeHandoff,
  reconcileCronProjection,
  startCronProjectionDispatch,
} from "@/server/cron/dispatch";
import type { CronWakeWorkflowEnvelopeV1 } from "@/server/cron/workflow-contract";
import {
  acceptCronProjection,
  mutateCronProjection,
  readCronProjection,
} from "@/server/cron/projection";
import { _resetStoreForTesting, getStore } from "@/server/store/store";

const now = 1_800_000_000_000;

function projection(revision: number, runAtMs = now + 60_000) {
  return {
    schemaVersion: 1 as const,
    gatewayGeneration: "1".repeat(32),
    sourceId: "gateway-source-1",
    sourceLeaseToken: null,
    sourceStartedAtMs: now,
    sourceRevision: revision,
    reason: revision === 1 ? ("startup" as const) : ("changed" as const),
    projectedAtMs: now,
    wakes: [{
      jobKey: createHash("sha256").update("job-1").digest("hex").slice(0, 32),
      runAtMs,
    }],
  };
}

test.beforeEach(() => {
  (process.env as Record<string, string | undefined>).NODE_ENV = "test";
  _resetStoreForTesting();
  mock.method(cronDispatchWorkflowRuntime, "startRepair", async () => ({
    runId: "wrun-repair",
  }));
});

test.afterEach(() => {
  mock.restoreAll();
  _resetStoreForTesting();
});

test("superseded Workflow cancellation remains best-effort", async () => {
  mock.method(cronDispatchWorkflowRuntime, "cancel", async () => {
    throw new Error("workflow unavailable");
  });
  await cancelSupersededCronWake("wrun-obsolete");
  await cancelSupersededCronWake(null);
});

test("cron dispatch starts once and records the Workflow run", async () => {
  await acceptCronProjection(projection(1));
  const envelopes: CronWakeWorkflowEnvelopeV1[] = [];
  const startWorkflow = async (envelope: CronWakeWorkflowEnvelopeV1) => {
    envelopes.push(envelope);
    return { runId: "wrun-1" };
  };

  const first = await startCronProjectionDispatch({
    origin: "https://app.test",
    startWorkflow,
    now: () => now,
  });
  const second = await startCronProjectionDispatch({
    origin: "https://app.test",
    startWorkflow,
    now: () => now,
  });

  assert.equal(first.status, "started");
  assert.equal(second.status, "scheduled");
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0]?.origin, "https://app.test");
  assert.equal(envelopes[0]?.wakeAtMs, now);
  assert.equal((await readCronProjection())?.dispatch.status, "scheduled");
});

test("a durable repair Workflow owns the start lease before the timer starts", async () => {
  await acceptCronProjection(projection(1, now));
  let repairEnvelope: CronWakeWorkflowEnvelopeV1 | undefined;
  const cancelled: string[] = [];
  mock.method(cronDispatchWorkflowRuntime, "cancel", async (runId: string) => {
    cancelled.push(runId);
  });
  const first = await startCronProjectionDispatch({
    origin: "https://app.test",
    startRepairWorkflow: async (envelope, repairAtMs) => {
      repairEnvelope = envelope;
      assert.equal(repairAtMs, now + 60_000);
      assert.equal((await readCronProjection())?.dispatch.status, "pending");
      return { runId: "wrun-durable-repair" };
    },
    startWorkflow: async () => {
      const record = await readCronProjection();
      assert.equal(record?.dispatch.status, "starting");
      if (record?.dispatch.status === "starting") {
        assert.equal(record.dispatch.repairWorkflowRunId, "wrun-durable-repair");
      }
      throw new Error("timer start failed");
    },
    now: () => now,
  });
  assert.ok(repairEnvelope);
  assert.equal(first.status, "failed");
  assert.deepEqual(cancelled, []);

  const repaired = await reconcileCronProjection({
    enabled: true,
    origin: "https://app.test",
    startRepairWorkflow: async () => ({ runId: "wrun-retry-repair" }),
    startWorkflow: async () => ({ runId: "wrun-recovered-parent" }),
    now: () => now + 60_000,
  });
  assert.equal(repaired.status, "started");
  assert.equal(repaired.repaired, true);
});

test("concurrent dispatch reconcilers start only one Workflow", async () => {
  await acceptCronProjection(projection(1));
  let starts = 0;
  const startWorkflow = async () => {
    starts += 1;
    return { runId: `wrun-${starts}` };
  };
  const results = await Promise.all([
    startCronProjectionDispatch({
      origin: "https://app.test",
      startWorkflow,
      now: () => now,
    }),
    startCronProjectionDispatch({
      origin: "https://app.test",
      startWorkflow,
      now: () => now,
    }),
  ]);
  assert.equal(starts, 1);
  assert.equal(results.filter((result) => result.status === "started").length, 1);
});

test("cron dispatch prewakes before a distant due time", async () => {
  await acceptCronProjection(projection(1, now + 10 * 60_000));
  let envelope: CronWakeWorkflowEnvelopeV1 | undefined;
  await startCronProjectionDispatch({
    origin: "https://app.test",
    startWorkflow: async (value) => {
      envelope = value;
      return { runId: "wrun-prewake" };
    },
    now: () => now,
  });
  assert.ok(envelope);
  assert.equal(envelope.wakeAtMs, now + 5 * 60_000);
  assert.equal(envelope.runAtMs, now + 10 * 60_000);
});

test("duplicate Workflow runs revalidate the token and only one claims the wake", async () => {
  await acceptCronProjection(projection(1, now));
  let envelope: CronWakeWorkflowEnvelopeV1 | undefined;
  await startCronProjectionDispatch({
    origin: "https://app.test",
    startWorkflow: async (value) => {
      envelope = value;
      return { runId: "wrun-original" };
    },
    now: () => now,
  });
  assert.ok(envelope);
  assert.equal(
    await claimCronWake(envelope, "wrun-original", now, false, "wrun-original"),
    false,
    "queued Workflows must fail closed when bundle capability is unavailable",
  );
  assert.equal(
    await claimCronWake(envelope, "wrun-original", now, true, "wrun-original"),
    true,
  );
  assert.equal(
    await isCronWakeClaimCurrent(envelope, "wrun-original", true),
    true,
  );
  assert.equal(
    await claimCronWake(envelope, "wrun-duplicate", now, true, "wrun-duplicate"),
    false,
  );
  assert.equal(
    await claimCronWake(
      envelope,
      "wrun-original",
      now + 1,
      true,
      "wrun-original",
    ),
    true,
    "a retried step in the owning Workflow remains idempotent",
  );
  await completeCronWake(envelope, "wrun-original", now + 2);
  assert.equal(
    await isCronWakeClaimCurrent(envelope, "wrun-original", true),
    false,
  );
  assert.equal((await readCronProjection())?.dispatch.status, "completed");
});

test("anti-entropy does not dispatch without verified bundle capability", async () => {
  await acceptCronProjection(projection(1, now));
  let starts = 0;
  const result = await reconcileCronProjection({
    origin: "https://app.test",
    enabled: false,
    startWorkflow: async () => {
      starts += 1;
      return { runId: "must-not-start" };
    },
    now: () => now,
  });
  assert.equal(result.status, "unsupported");
  assert.equal(starts, 0);
});

test("rescheduling supersedes an already queued Workflow token", async () => {
  await acceptCronProjection(projection(1, now));
  let staleEnvelope: CronWakeWorkflowEnvelopeV1 | undefined;
  await startCronProjectionDispatch({
    origin: "https://app.test",
    startWorkflow: async (value) => {
      staleEnvelope = value;
      return { runId: "wrun-stale" };
    },
    now: () => now,
  });
  await acceptCronProjection(projection(2, now + 120_000));
  assert.ok(staleEnvelope);
  assert.equal(await claimCronWake(staleEnvelope, "wrun-stale", now, true), false);
});

test("projection change during Workflow start cancels the orphaned timer", async () => {
  await acceptCronProjection(projection(1, now));
  const cancelled: string[] = [];
  mock.method(cronDispatchWorkflowRuntime, "cancel", async (runId: string) => {
    cancelled.push(runId);
  });
  const result = await startCronProjectionDispatch({
    origin: "https://app.test",
    startWorkflow: async () => {
      await acceptCronProjection(projection(2, now + 120_000));
      return { runId: "wrun-orphan" };
    },
    now: () => now,
  });
  assert.equal(result.status, "starting");
  assert.deepEqual(cancelled.filter((runId) => runId !== "wrun-repair"), ["wrun-orphan"]);
  const record = await readCronProjection();
  assert.equal(record?.projectionRevision, 2);
  assert.equal(record?.dispatch.status, "pending");
});

test("schedule persistence failure cancels the already-started Workflow", async () => {
  await acceptCronProjection(projection(1, now));
  const cancelled: string[] = [];
  mock.method(cronDispatchWorkflowRuntime, "cancel", async (runId: string) => {
    cancelled.push(runId);
  });
  const store = getStore();
  const compareAndSet = store.compareAndSetValue.bind(store);
  let failScheduleWrite = false;
  mock.method(
    store,
    "compareAndSetValue",
    async <T extends { revision: number }>(
      key: string,
      expectedRevision: number | null,
      value: T,
    ) => {
      if (failScheduleWrite) {
        failScheduleWrite = false;
        throw new Error("redis unavailable");
      }
      return compareAndSet(key, expectedRevision, value);
    },
  );
  const result = await startCronProjectionDispatch({
    origin: "https://app.test",
    startWorkflow: async () => {
      failScheduleWrite = true;
      return { runId: "wrun-persist-failed" };
    },
    now: () => now,
  });
  assert.equal(result.status, "failed");
  assert.deepEqual(cancelled.filter((runId) => runId !== "wrun-repair"), ["wrun-persist-failed"]);
  assert.equal((await readCronProjection())?.dispatch.status, "failed");
});

test("lost schedule CAS acknowledgement preserves the authoritative Workflow", async () => {
  await acceptCronProjection(projection(1, now));
  const cancelled: string[] = [];
  mock.method(cronDispatchWorkflowRuntime, "cancel", async (runId: string) => {
    cancelled.push(runId);
  });
  const store = getStore();
  const compareAndSet = store.compareAndSetValue.bind(store);
  let loseAcknowledgement = false;
  mock.method(
    store,
    "compareAndSetValue",
    async <T extends { revision: number }>(
      key: string,
      expectedRevision: number | null,
      value: T,
    ) => {
      const committed = await compareAndSet(key, expectedRevision, value);
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error("redis acknowledgement lost");
      }
      return committed;
    },
  );
  const result = await startCronProjectionDispatch({
    origin: "https://app.test",
    startWorkflow: async () => {
      loseAcknowledgement = true;
      return { runId: "wrun-authoritative" };
    },
    now: () => now,
  });

  assert.equal(result.status, "started");
  assert.equal(result.workflowRunId, "wrun-authoritative");
  assert.deepEqual(cancelled.filter((runId) => runId !== "wrun-repair"), []);
  const record = await readCronProjection();
  assert.equal(record?.dispatch.status, "scheduled");
  if (record?.dispatch.status === "scheduled") {
    assert.equal(record.dispatch.workflowRunId, "wrun-authoritative");
  }
});

test("anti-entropy rearms a failed Workflow start after its retry deadline", async () => {
  await acceptCronProjection(projection(1, now));
  const failed = await startCronProjectionDispatch({
    origin: "https://app.test",
    startWorkflow: async () => {
      throw new Error("workflow unavailable");
    },
    now: () => now,
  });
  assert.equal(failed.status, "failed");
  let starts = 0;
  const repaired = await reconcileCronProjection({
    origin: "https://app.test",
    enabled: true,
    startWorkflow: async () => {
      starts += 1;
      return { runId: "wrun-repaired" };
    },
    now: () => now + 60_000,
  });
  assert.equal(repaired.status, "started");
  assert.equal(repaired.repaired, true);
  assert.equal(starts, 1);
});

test("anti-entropy replaces a missing or terminal scheduled Workflow", async () => {
  await acceptCronProjection(projection(1, now + 10 * 60_000));
  await startCronProjectionDispatch({
    origin: "https://app.test",
    startWorkflow: async () => ({ runId: "wrun-lost" }),
    now: () => now,
  });
  let starts = 0;
  const cancelled: string[] = [];
  mock.method(cronDispatchWorkflowRuntime, "cancel", async (runId: string) => {
    cancelled.push(runId);
  });
  const repaired = await reconcileCronProjection({
    origin: "https://app.test",
    enabled: true,
    getWorkflowRunStatus: async () => "failed",
    startWorkflow: async () => {
      starts += 1;
      return { runId: "wrun-replacement" };
    },
    now: () => now + 1,
  });
  assert.equal(repaired.status, "started");
  assert.equal(repaired.repaired, true);
  assert.equal(starts, 1);
  assert.deepEqual(cancelled.filter((runId) => runId !== "wrun-repair"), ["wrun-lost"]);
});

test("anti-entropy keeps a pending scheduled Workflow before its stale deadline", async () => {
  await acceptCronProjection(projection(1, now));
  await startCronProjectionDispatch({
    origin: "https://app.test",
    startWorkflow: async () => ({ runId: "wrun-pending" }),
    now: () => now,
  });
  let starts = 0;
  const result = await reconcileCronProjection({
    origin: "https://app.test",
    enabled: true,
    getWorkflowRunStatus: async () => "pending",
    startWorkflow: async () => {
      starts += 1;
      return { runId: "must-not-start" };
    },
    now: () => now + 4 * 60_000,
  });

  assert.equal(result.status, "scheduled");
  assert.equal(result.workflowRunId, "wrun-pending");
  assert.equal(starts, 0);
});

test("anti-entropy never replaces an exactly live pending Workflow", async () => {
  await acceptCronProjection(projection(1, now));
  await startCronProjectionDispatch({
    origin: "https://app.test",
    startWorkflow: async () => ({ runId: "wrun-pending-stale" }),
    now: () => now,
  });
  const cancelled: string[] = [];
  mock.method(cronDispatchWorkflowRuntime, "cancel", async (runId: string) => {
    cancelled.push(runId);
  });
  let starts = 0;
  const result = await reconcileCronProjection({
    origin: "https://app.test",
    enabled: true,
    getWorkflowRunStatus: async () => "pending",
    startWorkflow: async () => {
      starts += 1;
      return { runId: "wrun-pending-replacement" };
    },
    now: () => now + 6 * 60_000,
  });

  assert.equal(result.status, "scheduled");
  assert.equal(result.repaired, false);
  assert.equal(starts, 0);
  assert.deepEqual(cancelled.filter((runId) => runId !== "wrun-repair"), []);

  const stillLive = await reconcileCronProjection({
    origin: "https://app.test",
    enabled: true,
    getWorkflowRunStatus: async () => "pending",
    startWorkflow: async () => {
      starts += 1;
      return { runId: "wrun-pending-replacement" };
    },
    now: () => now + 3 * 60 * 60_000,
  });
  assert.equal(stillLive.status, "scheduled");
  assert.equal(stillLive.repaired, false);
  assert.equal(starts, 0);
  assert.deepEqual(cancelled.filter((runId) => runId !== "wrun-repair"), []);
});

test("unknown Workflow status defers replacement until the hard ceiling", async () => {
  await acceptCronProjection(projection(1, now));
  await startCronProjectionDispatch({
    origin: "https://app.test",
    startWorkflow: async () => ({ runId: "wrun-status-unknown" }),
    now: () => now,
  });
  let starts = 0;
  const reconcile = (at: number) =>
    reconcileCronProjection({
      origin: "https://app.test",
      enabled: true,
      getWorkflowRunStatus: async () => {
        throw new Error("workflow status unavailable");
      },
      startWorkflow: async () => {
        starts += 1;
        return { runId: "wrun-unknown-replacement" };
      },
      now: () => at,
    });

  assert.equal((await reconcile(now + 30 * 60_000)).status, "scheduled");
  assert.equal(starts, 0);
  const repaired = await reconcile(now + 3 * 60 * 60_000);
  assert.equal(repaired.status, "started");
  assert.equal(repaired.repaired, true);
  assert.equal(starts, 1);
});

test("clock rollback cannot wedge a starting dispatch lease", async () => {
  await acceptCronProjection(projection(1, now));
  await mutateCronProjection((record) => {
    assert.notEqual(record.dispatch.status, "none");
    if (record.dispatch.status === "none") return null;
    record.dispatch = {
      ...record.dispatch,
      status: "starting",
      startLeaseExpiresAtMs: now + 10 * 60_000,
      repairWorkflowRunId: "wrun-future-repair",
    };
    return record;
  });
  const result = await reconcileCronProjection({
    enabled: true,
    origin: "https://app.test",
    startWorkflow: async () => ({ runId: "wrun-rollback-replacement" }),
    now: () => now,
  });
  assert.equal(result.status, "started");
  assert.equal(result.repaired, true);
});

test("clock rollback cannot wedge scheduled or running dispatch", async () => {
  for (const status of ["scheduled", "running"] as const) {
    _resetStoreForTesting();
    await acceptCronProjection(projection(1, now));
    let envelope: CronWakeWorkflowEnvelopeV1 | undefined;
    await startCronProjectionDispatch({
      origin: "https://app.test",
      startWorkflow: async (value) => {
        envelope = value;
        return { runId: `wrun-${status}-parent` };
      },
      now: () => now,
    });
    assert.ok(envelope);
    if (status === "running") {
      assert.equal(
        await claimCronWake(
          envelope,
          `wrun-${status}-execution`,
          now,
          true,
          `wrun-${status}-parent`,
        ),
        true,
      );
    }
    await mutateCronProjection((record) => {
      if (record.dispatch.status !== status) return null;
      const futureMs = now + 10 * 60_000;
      if (record.dispatch.status === "scheduled") {
        record.dispatch.scheduledAtMs = futureMs;
      } else if (record.dispatch.status === "running") {
        record.dispatch.claimedAtMs = futureMs;
      }
      return record;
    });
    const result = await reconcileCronProjection({
      enabled: true,
      origin: "https://app.test",
      getWorkflowRunStatus: async () => "running",
      startWorkflow: async () => ({
        runId: `wrun-${status}-rollback-replacement`,
      }),
      now: () => now,
    });
    assert.equal(result.status, "started", status);
    assert.equal(result.repaired, true, status);
  }
});

test("anti-entropy immediately replaces a terminal running Workflow", async () => {
  await acceptCronProjection(projection(1, now));
  let envelope: CronWakeWorkflowEnvelopeV1 | undefined;
  await startCronProjectionDispatch({
    origin: "https://app.test",
    startWorkflow: async (value) => {
      envelope = value;
      return { runId: "wrun-parent" };
    },
    now: () => now,
  });
  assert.ok(envelope);
  assert.equal(
    await claimCronWake(
      envelope,
      "wrun-child",
      now,
      true,
      "wrun-parent",
    ),
    true,
  );
  const cancelled: string[] = [];
  mock.method(cronDispatchWorkflowRuntime, "cancel", async (runId: string) => {
    cancelled.push(runId);
  });

  let starts = 0;
  const result = await reconcileCronProjection({
    origin: "https://app.test",
    enabled: true,
    getWorkflowRunStatus: async () => "failed",
    startWorkflow: async () => {
      starts += 1;
      return { runId: "wrun-replacement" };
    },
    now: () => now + 1,
  });

  assert.equal(result.status, "started");
  assert.equal(result.repaired, true);
  assert.equal(starts, 1);
  assert.deepEqual(cancelled.filter((runId) => runId !== "wrun-repair"), ["wrun-parent"]);
});

test("anti-entropy never replaces an exactly live running Workflow", async () => {
  await acceptCronProjection(projection(1, now));
  let envelope: CronWakeWorkflowEnvelopeV1 | undefined;
  await startCronProjectionDispatch({
    origin: "https://app.test",
    startWorkflow: async (value) => {
      envelope = value;
      return { runId: "wrun-parent" };
    },
    now: () => now,
  });
  assert.ok(envelope);
  assert.equal(
    await claimCronWake(
      envelope,
      "wrun-child",
      now,
      true,
      "wrun-parent",
    ),
    true,
  );
  let starts = 0;
  const result = await reconcileCronProjection({
    origin: "https://app.test",
    enabled: true,
    getWorkflowRunStatus: async () => "running",
    startWorkflow: async () => {
      starts += 1;
      return { runId: "must-not-start" };
    },
    now: () => now + 60 * 60_000,
  });

  assert.equal(result.status, "scheduled");
  assert.equal(result.workflowRunId, "wrun-parent");
  assert.equal(starts, 0);

  const stillLive = await reconcileCronProjection({
    origin: "https://app.test",
    enabled: true,
    getWorkflowRunStatus: async () => "running",
    startWorkflow: async () => {
      starts += 1;
      return { runId: "wrun-hard-ceiling-replacement" };
    },
    now: () => now + 3 * 60 * 60_000,
  });
  assert.equal(stillLive.status, "scheduled");
  assert.equal(stillLive.repaired, false);
  assert.equal(starts, 0);
});

test("handoff records the current-deployment child before watchdog probes", async () => {
  await acceptCronProjection(projection(1, now + 10 * 60_000));
  let envelope: CronWakeWorkflowEnvelopeV1 | undefined;
  await startCronProjectionDispatch({
    origin: "https://app.test",
    startWorkflow: async (value) => {
      envelope = value;
      return { runId: "wrun-parent-timer" };
    },
    now: () => now,
  });
  assert.ok(envelope);
  await recordCronWakeHandoff(
    envelope,
    "wrun-current-child",
    "wrun-parent-timer",
    now + 1,
  );

  const probed: string[] = [];
  let starts = 0;
  const result = await reconcileCronProjection({
    origin: "https://app.test",
    enabled: true,
    getWorkflowRunStatus: async (runId) => {
      probed.push(runId);
      return "running";
    },
    startWorkflow: async () => {
      starts += 1;
      return { runId: "must-not-start" };
    },
    now: () => now + 2,
  });
  assert.equal(result.status, "scheduled");
  assert.deepEqual(probed, ["wrun-parent-timer"]);
  assert.equal(starts, 0);
});

test("terminal parent probe rearms a concurrently installed unmonitored child", async () => {
  await acceptCronProjection(projection(1, now + 10 * 60_000));
  let envelope: CronWakeWorkflowEnvelopeV1 | undefined;
  await startCronProjectionDispatch({
    origin: "https://app.test",
    startWorkflow: async (value) => {
      envelope = value;
      return { runId: "wrun-parent-timer" };
    },
    now: () => now,
  });
  assert.ok(envelope);
  let starts = 0;
  const result = await reconcileCronProjection({
    origin: "https://app.test",
    enabled: true,
    getWorkflowRunStatus: async () => {
      await recordCronWakeHandoff(
        envelope!,
        "wrun-current-child",
        "wrun-parent-timer",
        now + 1,
      );
      return "completed";
    },
    startWorkflow: async () => {
      starts += 1;
      return { runId: "wrun-replacement-parent" };
    },
    now: () => now + 2,
  });

  assert.equal(result.status, "started");
  assert.equal(result.workflowRunId, "wrun-replacement-parent");
  assert.equal(result.repaired, true);
  assert.equal(starts, 1);
});

test("late timer handoff gives its fresh child a full claim window", async () => {
  await acceptCronProjection(projection(1, now));
  let envelope: CronWakeWorkflowEnvelopeV1 | undefined;
  await startCronProjectionDispatch({
    origin: "https://app.test",
    startWorkflow: async (value) => {
      envelope = value;
      return { runId: "wrun-late-parent" };
    },
    now: () => now - 10 * 60_000,
  });
  assert.ok(envelope);
  await recordCronWakeHandoff(
    envelope,
    "wrun-fresh-child",
    "wrun-late-parent",
    now,
  );
  let starts = 0;
  const result = await reconcileCronProjection({
    origin: "https://app.test",
    enabled: true,
    getWorkflowRunStatus: async () => "running",
    startWorkflow: async () => {
      starts += 1;
      return { runId: "must-not-start" };
    },
    now: () => now + 1,
  });

  assert.equal(result.status, "scheduled");
  assert.equal(result.workflowRunId, "wrun-late-parent");
  assert.equal(starts, 0);
});

test("due timer handoff wins the race with parent Workflow persistence", async () => {
  await acceptCronProjection(projection(1, now));
  const cancelled: string[] = [];
  mock.method(cronDispatchWorkflowRuntime, "cancel", async (runId: string) => {
    cancelled.push(runId);
  });
  const result = await startCronProjectionDispatch({
    origin: "https://app.test",
    startWorkflow: async (envelope) => {
      await recordCronWakeHandoff(
        envelope,
        "wrun-current-child",
        "wrun-parent-timer",
        now + 1,
      );
      return { runId: "wrun-parent-timer" };
    },
    now: () => now,
  });

  assert.equal(result.status, "started");
  assert.equal(result.workflowRunId, "wrun-parent-timer");
  assert.deepEqual(cancelled.filter((runId) => runId !== "wrun-repair"), []);
  const record = await readCronProjection();
  assert.equal(record?.dispatch.status, "scheduled");
  if (record?.dispatch.status === "scheduled") {
    assert.equal(record.dispatch.workflowRunId, "wrun-parent-timer");
    assert.equal(record.dispatch.executionWorkflowRunId, "wrun-current-child");
  }
});

test("handoff redelivery preserves the first authoritative child", async () => {
  await acceptCronProjection(projection(1, now));
  let envelope: CronWakeWorkflowEnvelopeV1 | undefined;
  await startCronProjectionDispatch({
    origin: "https://app.test",
    startWorkflow: async (value) => {
      envelope = value;
      return { runId: "wrun-parent-timer" };
    },
    now: () => now,
  });
  assert.ok(envelope);

  assert.equal(
    await recordCronWakeHandoff(
      envelope,
      "wrun-first-child",
      "wrun-parent-timer",
      now + 1,
    ),
    "installed",
  );
  assert.equal(
    await recordCronWakeHandoff(
      envelope,
      "wrun-redelivered-child",
      "wrun-parent-timer",
      now + 2,
    ),
    "occupied",
  );
  assert.equal(
    await claimCronWake(
      envelope,
      "wrun-redelivered-child",
      now + 3,
      true,
      "wrun-parent-timer",
    ),
    false,
  );
  const record = await readCronProjection();
  assert.equal(record?.dispatch.status, "scheduled");
  if (record?.dispatch.status === "scheduled") {
    assert.equal(record.dispatch.workflowRunId, "wrun-parent-timer");
    assert.equal(record.dispatch.executionWorkflowRunId, "wrun-first-child");
  }
});

test("handoff never cancels a child that claimed before its record CAS", async () => {
  await acceptCronProjection(projection(1, now));
  let envelope: CronWakeWorkflowEnvelopeV1 | undefined;
  await startCronProjectionDispatch({
    origin: "https://app.test",
    startWorkflow: async (value) => {
      envelope = value;
      return { runId: "wrun-parent-timer" };
    },
    now: () => now,
  });
  assert.ok(envelope);
  assert.equal(
    await claimCronWake(
      envelope,
      "wrun-fast-child",
      now,
      true,
      "wrun-parent-timer",
    ),
    true,
  );
  assert.equal(
    await recordCronWakeHandoff(
      envelope,
      "wrun-fast-child",
      "wrun-parent-timer",
      now + 1,
    ),
    "installed",
  );
  const record = await readCronProjection();
  assert.equal(record?.dispatch.status, "running");
  if (record?.dispatch.status === "running") {
    assert.equal(record.dispatch.workflowRunId, "wrun-parent-timer");
    assert.equal(record.dispatch.executionWorkflowRunId, "wrun-fast-child");
  }
});

test("handoff accepts a child that completed before its record CAS", async () => {
  await acceptCronProjection(projection(1, now));
  let envelope: CronWakeWorkflowEnvelopeV1 | undefined;
  await startCronProjectionDispatch({
    origin: "https://app.test",
    startWorkflow: async (value) => {
      envelope = value;
      return { runId: "wrun-parent-timer" };
    },
    now: () => now,
  });
  assert.ok(envelope);
  assert.equal(
    await claimCronWake(
      envelope,
      "wrun-fast-child",
      now,
      true,
      "wrun-parent-timer",
    ),
    true,
  );
  await completeCronWake(envelope, "wrun-fast-child", now + 1);

  assert.equal(
    await recordCronWakeHandoff(
      envelope,
      "wrun-fast-child",
      "wrun-parent-timer",
      now + 2,
    ),
    "owned",
  );
  assert.equal((await readCronProjection())?.dispatch.status, "completed");
});

test("completed child wins the race with parent Workflow persistence", async () => {
  await acceptCronProjection(projection(1, now));
  const cancelled: string[] = [];
  mock.method(cronDispatchWorkflowRuntime, "cancel", async (runId: string) => {
    cancelled.push(runId);
  });
  const result = await startCronProjectionDispatch({
    origin: "https://app.test",
    startWorkflow: async (envelope) => {
      await recordCronWakeHandoff(
        envelope,
        "wrun-fast-child",
        "wrun-parent-timer",
        now + 1,
      );
      assert.equal(
        await claimCronWake(
          envelope,
          "wrun-fast-child",
          now + 2,
          true,
          "wrun-parent-timer",
        ),
        true,
      );
      await completeCronWake(envelope, "wrun-fast-child", now + 3);
      return { runId: "wrun-parent-timer" };
    },
    now: () => now,
  });

  assert.equal(result.status, "idle");
  assert.equal(result.workflowRunId, null);
  assert.deepEqual(cancelled.filter((runId) => runId !== "wrun-repair"), []);
  assert.equal((await readCronProjection())?.dispatch.status, "completed");
});

test("completed projection never recursively dispatches its old due time", async () => {
  await acceptCronProjection(projection(1, now));
  let envelope: CronWakeWorkflowEnvelopeV1 | undefined;
  await startCronProjectionDispatch({
    origin: "https://app.test",
    startWorkflow: async (value) => {
      envelope = value;
      return { runId: "wrun-completed" };
    },
    now: () => now,
  });
  assert.ok(envelope);
  await claimCronWake(
    envelope,
    "wrun-execution",
    now,
    true,
    "wrun-completed",
  );
  await completeCronWake(envelope, "wrun-execution", now + 1);

  let starts = 0;
  const repaired = await reconcileCronProjection({
    origin: "https://app.test",
    enabled: true,
    startWorkflow: async () => {
      starts += 1;
      return { runId: "wrun-settlement-retry" };
    },
    now: () => now + 5 * 60_000,
  });
  assert.equal(repaired.status, "idle");
  assert.equal(repaired.repaired, false);
  assert.equal(starts, 0);

  const healthyParent = await reconcileCronProjection({
    origin: "https://app.test",
    enabled: true,
    getWorkflowRunStatus: async () => "running",
    startWorkflow: async () => {
      starts += 1;
      return { runId: "must-not-replay-completed" };
    },
    now: () => now + 3 * 60 * 60_000,
  });
  assert.equal(healthyParent.status, "idle");
  assert.equal(starts, 0);

  const exhausted = await reconcileCronProjection({
    origin: "https://app.test",
    enabled: true,
    getWorkflowRunStatus: async () => "completed",
    startWorkflow: async () => {
      starts += 1;
      return { runId: "must-not-replay-exhausted-settlement" };
    },
    now: () => now + 3 * 60 * 60_000,
  });
  assert.equal(exhausted.status, "settlement-blocked");
  assert.equal(exhausted.workflowRunId, "wrun-completed");
  assert.equal(starts, 0);

  await mutateCronProjection((record) => {
    if (record.dispatch.status !== "completed") return null;
    record.dispatch.legacyWorkflowOwner = true;
    return record;
  });
  const legacyCompleted = await reconcileCronProjection({
    origin: "https://app.test",
    enabled: true,
    getWorkflowRunStatus: async () => "completed",
    startWorkflow: async () => {
      starts += 1;
      return { runId: "must-not-replay-legacy-completed" };
    },
    now: () => now + 4 * 60 * 60_000,
  });
  assert.equal(legacyCompleted.status, "settlement-blocked");
  assert.equal(starts, 0);
});
