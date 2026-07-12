import assert from "node:assert/strict";
import test, { beforeEach, mock } from "node:test";

import {
  beginChannelWorkflowDispatch,
  CHANNEL_FAST_PATH_DISPATCH_STALE_MS,
  classifyFastPathDispatch,
  claimChannelHandoff,
  markChannelDeliveryTerminal,
  markChannelFastPathDispatching,
  markChannelHandoffHandedOff,
  markChannelHandoffStartFailed,
  markChannelHandoffStarting,
  markChannelWorkflowNativeAccepted,
  prepareChannelHandoff,
  readChannelHandoff,
  renewChannelFastPathDispatch,
  resetChannelWorkflowDispatch,
} from "@/server/channels/handoff-ledger";
import { _resetStoreForTesting } from "@/server/store/store";

beforeEach(() => {
  (process.env as Record<string, string>).NODE_ENV = "test";
  _resetStoreForTesting();
});

test("handoff ledger acknowledges only a durable handoff", async () => {
  const first = await prepareChannelHandoff({
    channel: "slack",
    deliveryId: "slack:event-1",
    envelope: { version: 1 },
  });
  assert.equal(first.action, "start");
  if (first.action !== "start") return;

  const duplicateBeforeStart = await prepareChannelHandoff({
    channel: "slack",
    deliveryId: "slack:event-1",
    envelope: { version: 1 },
  });
  assert.equal(duplicateBeforeStart.action, "retry");

  await markChannelHandoffStarting({
    channel: "slack",
    deliveryId: "slack:event-1",
    attemptId: first.attemptId,
  });
  await markChannelHandoffHandedOff({
    channel: "slack",
    deliveryId: "slack:event-1",
    attemptId: first.attemptId,
    runId: "run-1",
  });
  const duplicateAfterStart = await prepareChannelHandoff({
    channel: "slack",
    deliveryId: "slack:event-1",
    envelope: { version: 1 },
  });
  assert.deepEqual(duplicateAfterStart, {
    action: "ack",
    state: "handed-off",
  });
});

test("direct fast-path settlement durably acknowledges later duplicates", async () => {
  await markChannelDeliveryTerminal({
    channel: "telegram",
    deliveryId: "telegram:bot:123:42",
  });

  const duplicate = await prepareChannelHandoff({
    channel: "telegram",
    deliveryId: "telegram:bot:123:42",
    envelope: { version: 1 },
  });
  assert.deepEqual(duplicate, { action: "ack", state: "terminal" });
});

test("fast-path dispatch intent survives for retry-side unknown settlement", async () => {
  const dispatch = await markChannelFastPathDispatching({
    channel: "slack",
    deliveryId: "slack:event-dispatching",
  });
  assert.equal(dispatch.action, "dispatch");
  assert.equal(
    (await readChannelHandoff("slack", "slack:event-dispatching"))?.state,
    "fast-path-dispatching",
  );
});

test("fast-path dispatch ownership stays active until its native timeout elapses", async () => {
  const dispatch = await markChannelFastPathDispatching({
    channel: "telegram",
    deliveryId: "telegram:active-dispatch",
  });
  assert.equal(dispatch.action, "dispatch");
  if (dispatch.action !== "dispatch") return;
  const record = await readChannelHandoff(
    "telegram",
    "telegram:active-dispatch",
  );
  assert.ok(record);

  assert.equal(
    classifyFastPathDispatch(
      record,
      record.updatedAt + CHANNEL_FAST_PATH_DISPATCH_STALE_MS - 1,
    ).action,
    "retry",
  );
  assert.equal(
    classifyFastPathDispatch(
      record,
      record.updatedAt + CHANNEL_FAST_PATH_DISPATCH_STALE_MS,
    ).action,
    "settle-unknown",
  );

  assert.equal(
    await markChannelDeliveryTerminal({
      channel: "telegram",
      deliveryId: "telegram:active-dispatch",
      expectedAttemptId: "fast:other-owner",
    }),
    false,
  );
  assert.equal(
    (await readChannelHandoff("telegram", "telegram:active-dispatch"))?.state,
    "fast-path-dispatching",
  );
  assert.equal(
    await markChannelDeliveryTerminal({
      channel: "telegram",
      deliveryId: "telegram:active-dispatch",
      expectedAttemptId: dispatch.attemptId,
    }),
    true,
  );
});

test("fast-path repair renews only the exact active dispatch owner", async () => {
  const dispatch = await markChannelFastPathDispatching({
    channel: "slack",
    deliveryId: "slack:repair-dispatch",
  });
  assert.equal(dispatch.action, "dispatch");
  if (dispatch.action !== "dispatch") return;
  const initial = await readChannelHandoff("slack", "slack:repair-dispatch");
  assert.ok(initial);
  const renewedAt = initial.updatedAt + CHANNEL_FAST_PATH_DISPATCH_STALE_MS - 1;
  const dateMock = mock.method(Date, "now", () => renewedAt);
  try {
    assert.equal(
      await renewChannelFastPathDispatch({
        channel: "slack",
        deliveryId: "slack:repair-dispatch",
        attemptId: "fast:wrong-owner",
      }),
      false,
    );
    assert.equal(
      await renewChannelFastPathDispatch({
        channel: "slack",
        deliveryId: "slack:repair-dispatch",
        attemptId: dispatch.attemptId,
      }),
      true,
    );
  } finally {
    dateMock.mock.restore();
  }
  const renewed = await readChannelHandoff("slack", "slack:repair-dispatch");
  assert.ok(renewed);
  assert.equal(renewed.updatedAt, renewedAt);
  assert.equal(
    classifyFastPathDispatch(
      renewed,
      renewedAt + CHANNEL_FAST_PATH_DISPATCH_STALE_MS - 1,
    ).action,
    "retry",
  );
});

test("start-failed handoff is taken over with a new attempt", async () => {
  const first = await prepareChannelHandoff({
    channel: "telegram",
    deliveryId: "telegram:1",
    envelope: { version: 1 },
  });
  assert.equal(first.action, "start");
  if (first.action !== "start") return;
  await markChannelHandoffStartFailed({
    channel: "telegram",
    deliveryId: "telegram:1",
    attemptId: first.attemptId,
    error: new Error("ambiguous start"),
  });

  const retry = await prepareChannelHandoff({
    channel: "telegram",
    deliveryId: "telegram:1",
    envelope: { version: 1 },
  });
  assert.equal(retry.action, "start");
  if (retry.action === "start") {
    assert.notEqual(retry.attemptId, first.attemptId);
  }
});

test("only one ambiguous workflow run claims delivery side effects", async () => {
  const prepared = await prepareChannelHandoff({
    channel: "slack",
    deliveryId: "slack:event-2",
    envelope: { version: 1 },
  });
  assert.equal(prepared.action, "start");
  if (prepared.action !== "start") return;

  const [first, second] = await Promise.all([
    claimChannelHandoff({
      channel: "slack",
      deliveryId: "slack:event-2",
      attemptId: prepared.attemptId,
      runId: "run-a",
    }),
    claimChannelHandoff({
      channel: "slack",
      deliveryId: "slack:event-2",
      attemptId: prepared.attemptId,
      runId: "run-b",
    }),
  ]);
  assert.equal(Number(first) + Number(second), 1);
  assert.equal((await readChannelHandoff("slack", "slack:event-2"))?.state, "processing");
});

test("late route handoff cannot overwrite workflow processing ownership", async () => {
  const prepared = await prepareChannelHandoff({
    channel: "telegram",
    deliveryId: "telegram:2",
    envelope: { version: 1 },
  });
  assert.equal(prepared.action, "start");
  if (prepared.action !== "start") return;
  await claimChannelHandoff({
    channel: "telegram",
    deliveryId: "telegram:2",
    attemptId: prepared.attemptId,
    runId: "run-fast",
  });
  await markChannelHandoffHandedOff({
    channel: "telegram",
    deliveryId: "telegram:2",
    attemptId: prepared.attemptId,
    runId: "run-late",
  });
  const record = await readChannelHandoff("telegram", "telegram:2");
  assert.equal(record?.state, "processing");
  assert.equal(record?.runId, "run-fast");
});

test("workflow dispatch fence prevents replay and preserves native acceptance", async () => {
  const prepared = await prepareChannelHandoff({
    channel: "slack",
    deliveryId: "slack:user-message:C1:1.0",
    envelope: { version: 1 },
  });
  assert.equal(prepared.action, "start");
  if (prepared.action !== "start") return;
  assert.equal(
    await claimChannelHandoff({
      channel: "slack",
      deliveryId: "slack:user-message:C1:1.0",
      attemptId: prepared.attemptId,
      runId: "run-fenced",
    }),
    true,
  );
  assert.deepEqual(
    await beginChannelWorkflowDispatch({
      channel: "slack",
      deliveryId: "slack:user-message:C1:1.0",
      attemptId: prepared.attemptId,
      runId: "run-fenced",
    }),
    { action: "dispatch" },
  );
  assert.deepEqual(
    await beginChannelWorkflowDispatch({
      channel: "slack",
      deliveryId: "slack:user-message:C1:1.0",
      attemptId: prepared.attemptId,
      runId: "run-fenced",
    }),
    { action: "settle-unknown" },
  );
  assert.equal(
    await markChannelWorkflowNativeAccepted({
      channel: "slack",
      deliveryId: "slack:user-message:C1:1.0",
      attemptId: prepared.attemptId,
      runId: "run-fenced",
    }),
    true,
  );
  assert.deepEqual(
    await prepareChannelHandoff({
      channel: "slack",
      deliveryId: "slack:user-message:C1:1.0",
      envelope: { version: 1 },
    }),
    { action: "ack", state: "native-accepted" },
  );
  assert.equal(
    await claimChannelHandoff({
      channel: "slack",
      deliveryId: "slack:user-message:C1:1.0",
      attemptId: prepared.attemptId,
      runId: "run-fenced",
    }),
    true,
  );
  assert.deepEqual(
    await beginChannelWorkflowDispatch({
      channel: "slack",
      deliveryId: "slack:user-message:C1:1.0",
      attemptId: prepared.attemptId,
      runId: "run-fenced",
    }),
    { action: "resume-accepted" },
  );
  assert.equal(
    await markChannelDeliveryTerminal({
      channel: "slack",
      deliveryId: "slack:user-message:C1:1.0",
    }),
    false,
  );
});

test("definite workflow rejection reopens only the exact dispatch owner", async () => {
  const prepared = await prepareChannelHandoff({
    channel: "slack",
    deliveryId: "slack:event-rejected",
    envelope: { version: 1 },
  });
  assert.equal(prepared.action, "start");
  if (prepared.action !== "start") return;
  await claimChannelHandoff({
    channel: "slack",
    deliveryId: "slack:event-rejected",
    attemptId: prepared.attemptId,
    runId: "run-rejected",
  });
  await beginChannelWorkflowDispatch({
    channel: "slack",
    deliveryId: "slack:event-rejected",
    attemptId: prepared.attemptId,
    runId: "run-rejected",
  });
  assert.equal(
    await resetChannelWorkflowDispatch({
      channel: "slack",
      deliveryId: "slack:event-rejected",
      attemptId: prepared.attemptId,
      runId: "wrong-run",
    }),
    false,
  );
  assert.equal(
    await resetChannelWorkflowDispatch({
      channel: "slack",
      deliveryId: "slack:event-rejected",
      attemptId: prepared.attemptId,
      runId: "run-rejected",
    }),
    true,
  );
  assert.deepEqual(
    await beginChannelWorkflowDispatch({
      channel: "slack",
      deliveryId: "slack:event-rejected",
      attemptId: prepared.attemptId,
      runId: "run-rejected",
    }),
    { action: "dispatch" },
  );
});
