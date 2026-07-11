import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  claimChannelHandoff,
  markChannelDeliveryTerminal,
  markChannelFastPathDispatching,
  markChannelHandoffHandedOff,
  markChannelHandoffStartFailed,
  markChannelHandoffStarting,
  prepareChannelHandoff,
  readChannelHandoff,
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
  await markChannelFastPathDispatching({
    channel: "slack",
    deliveryId: "slack:event-dispatching",
  });
  assert.equal(
    (await readChannelHandoff("slack", "slack:event-dispatching"))?.state,
    "fast-path-dispatching",
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
