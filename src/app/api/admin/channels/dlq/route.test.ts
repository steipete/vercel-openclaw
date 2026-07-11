import assert from "node:assert/strict";
import test from "node:test";

import {
  GET,
  POST,
  jsonWithAuth,
} from "@/app/api/admin/channels/dlq/route";
import {
  CHANNEL_DLQ_RECORD_TTL_SECONDS,
  recordChannelDlqFailure,
  resolveChannelDlqFailure,
} from "@/server/channels/dlq";
import {
  channelFailedIndexKey,
  channelFailedKey,
  channelFailedResolvedKey,
} from "@/server/store/keyspace";
import { getStore } from "@/server/store/store";
import { withHarness } from "@/test-utils/harness";
import {
  buildAuthGetRequest,
  buildAuthPostRequest,
  callRoute,
} from "@/test-utils/route-caller";

async function seedTelegramDlq(input: {
  deliveryId: string;
  deliveryOutcome: "not-accepted" | "unknown";
}) {
  return await recordChannelDlqFailure({
    channel: "telegram",
    deliveryId: input.deliveryId,
    phase: "workflow-step-failed",
    terminal: true,
    retryable: false,
    deliveryOutcome: input.deliveryOutcome,
    requestId: "req-42",
    receivedAtMs: 1000,
    error: new Error("terminal native rejection"),
  });
}

test("channel DLQ: successful JSON preserves refreshed auth cookie", async () => {
  const response = jsonWithAuth(
    { ok: true },
    200,
    { setCookieHeader: "openclaw_session=refreshed; Path=/; HttpOnly" },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie") ?? "", /openclaw_session=refreshed/);
});

test("channel DLQ: automated redrive is explicitly unavailable", async () => {
  await withHarness(async () => {
    const result = await callRoute(
      POST,
      buildAuthPostRequest("/api/admin/channels/dlq", "{}"),
    );

    assert.equal(result.status, 405);
    assert.equal(
      (result.json as { error?: { code?: unknown } }).error?.code,
      "DLQ_REDRIVE_UNAVAILABLE",
    );
    assert.equal(
      (result.json as { recoveryMode?: unknown }).recoveryMode,
      "inspection-only",
    );
  });
});
test("channel DLQ: list exposes failure metadata without replay payload", async () => {
  await withHarness(async () => {
    await seedTelegramDlq({
      deliveryId: "telegram:list",
      deliveryOutcome: "not-accepted",
    });

    const result = await callRoute(
      GET,
      buildAuthGetRequest("/api/admin/channels/dlq"),
    );

    assert.equal(result.status, 200);
    assert.equal(result.text.includes("replayToken"), false);
    assert.equal(result.text.includes("hello"), false);
    const item = (result.json as { items?: Array<Record<string, unknown>> })
      .items?.[0];
    assert.equal(item?.replayAvailable, false);
    assert.equal(item?.automatedRedriveAvailable, false);
    assert.equal(item?.manualRecoveryRequired, false);
    assert.equal(item?.recoveryState, "blocked");
    assert.equal(item?.deliveryOutcome, "not-accepted");
  });
});

test("channel DLQ: unknown outcome blocks replay metadata", async () => {
  await withHarness(async () => {
    await seedTelegramDlq({
      deliveryId: "telegram:unknown",
      deliveryOutcome: "unknown",
    });

    const result = await callRoute(
      GET,
      buildAuthGetRequest("/api/admin/channels/dlq"),
    );
    const item = (result.json as { items?: Array<Record<string, unknown>> })
      .items?.[0];
    assert.equal(item?.replayAvailable, false);
    assert.equal(item?.manualRecoveryRequired, false);
    assert.equal(item?.recoveryState, "blocked");
  });
});

test("channel DLQ: stale tombstones do not consume the live item limit", async () => {
  await withHarness(async () => {
    const channel = "telegram" as const;
    const deliveryId = "telegram:resolved-stale-index";
    const record = await seedTelegramDlq({
      deliveryId,
      deliveryOutcome: "not-accepted",
    });
    assert.ok(record);
    await resolveChannelDlqFailure(channel, deliveryId);
    const liveDeliveryId = "telegram:live-behind-stale";
    const liveRecord = await seedTelegramDlq({
      deliveryId: liveDeliveryId,
      deliveryOutcome: "not-accepted",
    });
    assert.ok(liveRecord);
    await getStore().setValue(
      channelFailedIndexKey(),
      [
        {
          channel,
          deliveryId,
          key: channelFailedKey(channel, deliveryId),
          failedAt: record.failedAt,
          phase: record.phase,
          terminal: true,
        },
        {
          channel,
          deliveryId: liveDeliveryId,
          key: channelFailedKey(channel, liveDeliveryId),
          failedAt: liveRecord.failedAt,
          phase: liveRecord.phase,
          terminal: true,
        },
      ],
      CHANNEL_DLQ_RECORD_TTL_SECONDS,
    );

    const result = await callRoute(
      GET,
      buildAuthGetRequest("/api/admin/channels/dlq?limit=1"),
    );
    const body = result.json as {
      items?: unknown[];
      count?: number;
      indexSize?: number;
      staleIndexCount?: number;
    };
    assert.equal(
      (body.items?.[0] as { deliveryId?: string } | undefined)?.deliveryId,
      liveDeliveryId,
    );
    assert.equal(body.count, 1);
    assert.equal(body.indexSize, 2);
    assert.equal(body.staleIndexCount, 1);
  });
});

test("channel DLQ: store outages return unavailable instead of an empty list", async () => {
  await withHarness(async () => {
    const store = getStore();
    const originalGetValue = store.getValue.bind(store);
    store.getValue = async <T>(key: string): Promise<T | null> => {
      if (key === channelFailedIndexKey()) throw new Error("index unavailable");
      return await originalGetValue<T>(key);
    };
    try {
      const result = await callRoute(
        GET,
        buildAuthGetRequest("/api/admin/channels/dlq"),
      );
      assert.equal(result.status, 503);
      assert.equal(
        (result.json as { error?: { code?: string } }).error?.code,
        "DLQ_UNAVAILABLE",
      );
    } finally {
      store.getValue = originalGetValue;
    }
  });
});

test("channel DLQ: per-record projection outage returns unavailable", async () => {
  await withHarness(async () => {
    const deliveryId = "telegram:projection-outage";
    await seedTelegramDlq({ deliveryId, deliveryOutcome: "not-accepted" });
    const store = getStore();
    const originalGetValue = store.getValue.bind(store);
    store.getValue = async <T>(key: string): Promise<T | null> => {
      if (key === channelFailedResolvedKey("telegram", deliveryId)) {
        throw new Error("fence unavailable");
      }
      return await originalGetValue<T>(key);
    };
    try {
      const result = await callRoute(
        GET,
        buildAuthGetRequest("/api/admin/channels/dlq"),
      );
      assert.equal(result.status, 503);
    } finally {
      store.getValue = originalGetValue;
    }
  });
});

test("channel DLQ: scoped queries ignore unrelated channel projection outages", async () => {
  await withHarness(async () => {
    const telegramDeliveryId = "telegram:scoped-live";
    await seedTelegramDlq({
      deliveryId: telegramDeliveryId,
      deliveryOutcome: "not-accepted",
    });
    const slackDeliveryId = "slack:unrelated-outage";
    await recordChannelDlqFailure({
      channel: "slack",
      deliveryId: slackDeliveryId,
      phase: "workflow-step-failed",
      terminal: true,
      retryable: false,
      deliveryOutcome: "not-accepted",
      requestId: null,
      receivedAtMs: 1000,
      error: new Error("slack rejected"),
    });
    const store = getStore();
    const originalGetValue = store.getValue.bind(store);
    store.getValue = async <T>(key: string): Promise<T | null> => {
      if (key === channelFailedResolvedKey("slack", slackDeliveryId)) {
        throw new Error("unrelated Slack fence unavailable");
      }
      return await originalGetValue<T>(key);
    };
    try {
      const result = await callRoute(
        GET,
        buildAuthGetRequest("/api/admin/channels/dlq?channel=telegram"),
      );
      assert.equal(result.status, 200);
      const items = (result.json as { items?: Array<{ deliveryId?: string }> })
        .items;
      assert.deepEqual(items?.map((item) => item.deliveryId), [
        telegramDeliveryId,
      ]);
    } finally {
      store.getValue = originalGetValue;
    }
  });
});

test("channel DLQ: limit uses authoritative failure recency", async () => {
  await withHarness(async () => {
    const older = await seedTelegramDlq({
      deliveryId: "telegram:raw-index-first",
      deliveryOutcome: "not-accepted",
    });
    const newer = await seedTelegramDlq({
      deliveryId: "telegram:authoritative-newest",
      deliveryOutcome: "not-accepted",
    });
    assert.ok(older);
    assert.ok(newer);
    const store = getStore();
    await store.setValue(
      channelFailedKey(newer.channel, newer.deliveryId),
      { ...newer, failedAt: older.failedAt + 10_000 },
      CHANNEL_DLQ_RECORD_TTL_SECONDS,
    );
    await store.setValue(
      channelFailedIndexKey(),
      [
        {
          channel: older.channel,
          deliveryId: older.deliveryId,
          key: channelFailedKey(older.channel, older.deliveryId),
          failedAt: older.failedAt,
          phase: older.phase,
          terminal: older.terminal,
        },
        {
          channel: newer.channel,
          deliveryId: newer.deliveryId,
          key: channelFailedKey(newer.channel, newer.deliveryId),
          failedAt: newer.failedAt,
          phase: newer.phase,
          terminal: newer.terminal,
        },
      ],
      CHANNEL_DLQ_RECORD_TTL_SECONDS,
    );

    const result = await callRoute(
      GET,
      buildAuthGetRequest("/api/admin/channels/dlq?limit=1"),
    );
    const item = (result.json as { items?: Array<{ deliveryId?: string }> })
      .items?.[0];
    assert.equal(item?.deliveryId, newer.deliveryId);
  });
});
