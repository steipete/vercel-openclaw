import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock, test } from "node:test";

import {
  claimCronWake,
  cancelSupersededCronWake,
  completeCronWake,
  cronDispatchWorkflowRuntime,
  recordCronWakeHandoff,
  reconcileCronProjection,
  startCronProjectionDispatch,
  type CronWakeWorkflowEnvelopeV1,
} from "@/server/cron/dispatch";
import {
  acceptCronProjection,
  readCronProjection,
} from "@/server/cron/projection";
import { _resetStoreForTesting, getStore } from "@/server/store/store";

const now = 1_800_000_000_000;

function projection(revision: number, runAtMs = now + 60_000) {
  return {
    schemaVersion: 1 as const,
    gatewayGeneration: "1".repeat(32),
    sourceId: "gateway-source-1",
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
    await claimCronWake(envelope, "wrun-original", now),
    false,
    "queued Workflows must fail closed when bundle capability is unavailable",
  );
  assert.equal(await claimCronWake(envelope, "wrun-original", now, true), true);
  assert.equal(await claimCronWake(envelope, "wrun-duplicate", now, true), false);
  assert.equal(
    await claimCronWake(envelope, "wrun-original", now + 1, true),
    true,
    "a retried step in the owning Workflow remains idempotent",
  );
  await completeCronWake(envelope, "wrun-original", now + 2);
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
  assert.deepEqual(cancelled, ["wrun-orphan"]);
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
  assert.deepEqual(cancelled, ["wrun-persist-failed"]);
  assert.equal((await readCronProjection())?.dispatch.status, "failed");
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
  assert.deepEqual(cancelled, ["wrun-lost"]);
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
  await recordCronWakeHandoff(envelope, "wrun-current-child", now + 1);

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
  assert.deepEqual(probed, ["wrun-current-child"]);
  assert.equal(starts, 0);
});

test("anti-entropy rearms completed wake when no successor projection settles", async () => {
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
  await claimCronWake(envelope, "wrun-execution", now, true);
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
  assert.equal(repaired.status, "started");
  assert.equal(repaired.repaired, true);
  assert.equal(starts, 1);
});
