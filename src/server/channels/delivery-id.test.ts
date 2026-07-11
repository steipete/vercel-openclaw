import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveChannelDeliveryId,
  extractChannelPlatformDeliveryId,
} from "@/server/channels/delivery-id";

test("channel delivery id: extracts platform-owned correlation ids", () => {
  assert.equal(
    extractChannelPlatformDeliveryId("telegram", { update_id: 42 }),
    "telegram:42",
  );
  assert.equal(
    extractChannelPlatformDeliveryId("slack", { event_id: "Ev42" }),
    "slack:Ev42",
  );
  assert.equal(
    extractChannelPlatformDeliveryId("discord", { id: "Ix42" }),
    "discord:Ix42",
  );
});

test("channel delivery id: fallback is deterministic for one workflow envelope", () => {
  const input = {
    channel: "slack",
    payload: { event: { type: "app_mention" } },
    requestId: "req-42",
    receivedAtMs: 1000,
  };

  assert.equal(deriveChannelDeliveryId(input), deriveChannelDeliveryId(input));
  assert.match(deriveChannelDeliveryId(input), /^slack:[0-9a-f]{32}$/);
});

test("channel delivery id: Telegram update ids are scoped to config generation", () => {
  const shared = {
    channel: "telegram",
    payload: { update_id: 42 },
    requestId: "req-42",
    receivedAtMs: 1000,
  };
  const first = deriveChannelDeliveryId({
    ...shared,
    telegramConfig: { botUsername: "first_bot", configuredAt: 100 },
  });
  const second = deriveChannelDeliveryId({
    ...shared,
    telegramConfig: { botUsername: "second_bot", configuredAt: 200 },
  });

  assert.equal(first, "telegram:first_bot:100:42");
  assert.equal(second, "telegram:second_bot:200:42");
  assert.notEqual(first, second);
});
