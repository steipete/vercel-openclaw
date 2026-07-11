import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANNEL_DLQ_RECORD_TTL_SECONDS,
  CHANNEL_DLQ_RESOLUTION_FENCE_TTL_SECONDS,
  getChannelDlqRecord,
  getChannelDlqSummary,
  recordChannelDlqFailure,
  resolveChannelDlqFailure,
  type ChannelDlqIndexEntry,
  type ChannelDlqRecord,
} from "@/server/channels/dlq";
import { _resetLogBuffer, getServerLogs } from "@/server/log";
import {
  channelFailedIndexKey,
  channelFailedIndexLockKey,
  channelFailedKey,
  channelFailedRecordLockKey,
  channelFailedResolvedKey,
  channelFailedUnknownKey,
} from "@/server/store/keyspace";
import { _resetStoreForTesting, getStore } from "@/server/store/store";

const TEST_ENV: Record<string, string | undefined> = {
  NODE_ENV: "test",
  VERCEL: undefined,
  REDIS_URL: undefined,
  KV_URL: undefined,
  SESSION_SECRET: undefined,
};

async function withEnv<T>(fn: () => T | Promise<T>): Promise<T> {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(TEST_ENV)) {
    originals[key] = process.env[key];
    if (TEST_ENV[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = TEST_ENV[key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
    _resetStoreForTesting();
    _resetLogBuffer();
  }
}

test("dlq: upsert preserves firstFailedAt and increments failureCount", async () => {
  await withEnv(async () => {
    const first = await recordChannelDlqFailure({
      channel: "slack",
      deliveryId: "slack:evt-upsert-1",
      phase: "workflow-step-failed",
      terminal: false,
      retryable: true,
      requestId: "req-1",
      receivedAtMs: Date.now() - 1000,
      error: new Error("first failure"),
    });
    assert.ok(first);
    assert.equal(first.failureCount, 1);
    const firstAt = first.firstFailedAt;

    // Wait 5ms so timestamps differ.
    await new Promise((r) => setTimeout(r, 5));

    const second = await recordChannelDlqFailure({
      channel: "slack",
      deliveryId: "slack:evt-upsert-1",
      phase: "workflow-step-failed",
      terminal: false,
      retryable: true,
      requestId: "req-2",
      receivedAtMs: Date.now() - 1000,
      error: new Error("second failure"),
    });
    assert.ok(second);
    assert.equal(second.failureCount, 2, "second upsert increments count");
    assert.equal(
      second.firstFailedAt,
      firstAt,
      "firstFailedAt must be preserved across upserts",
    );
    assert.ok(second.failedAt >= firstAt);
    assert.equal(second.errorMessage, "second failure");
  });
});

test("dlq: index lists newest first and deduplicates repeated keys", async () => {
  await withEnv(async () => {
    await recordChannelDlqFailure({
      channel: "telegram",
      deliveryId: "telegram:42",
      phase: "workflow-start-failed",
      terminal: false,
      retryable: true,
      requestId: null,
      receivedAtMs: Date.now(),
      error: new Error("first"),
    });
    await recordChannelDlqFailure({
      channel: "discord",
      deliveryId: "discord:xyz",
      phase: "workflow-start-failed",
      terminal: false,
      retryable: true,
      deliveryOutcome: "unknown",
      requestId: null,
      receivedAtMs: Date.now(),
      error: new Error("second"),
    });
    await recordChannelDlqFailure({
      channel: "telegram",
      deliveryId: "telegram:42",
      phase: "workflow-step-failed",
      terminal: true,
      retryable: false,
      requestId: null,
      receivedAtMs: Date.now(),
      error: new Error("third, same delivery"),
    });

    const index = await getStore().getValue<unknown[]>(
      channelFailedIndexKey(),
    );
    assert.ok(Array.isArray(index));
    assert.equal(index.length, 2, "same deliveryId must not duplicate in index");
    const entries = index as Array<{ channel: string; deliveryId: string }>;
    assert.equal(
      entries[0].deliveryId,
      "telegram:42",
      "most-recent entry is first",
    );
    assert.equal(entries[1].deliveryId, "discord:xyz");
  });
});

test("dlq: unknown delivery outcome blocks automatic recovery", async () => {
  await withEnv(async () => {
    const deliveryId = "telegram:unknown";
    await recordChannelDlqFailure({
      channel: "telegram",
      deliveryId,
      phase: "workflow-step-failed",
      terminal: true,
      retryable: false,
      deliveryOutcome: "not-accepted",
      requestId: "req-before-unknown",
      receivedAtMs: 1000,
      error: new Error("definite rejection"),
    });

    const record = await recordChannelDlqFailure({
      channel: "telegram",
      deliveryId,
      phase: "workflow-step-failed",
      terminal: true,
      retryable: false,
      deliveryOutcome: "unknown",
      requestId: "req-unknown",
      receivedAtMs: 1000,
      error: new Error("response lost after send"),
    });

    assert.ok(record);
    assert.equal(record.deliveryOutcome, "unknown");
    assert.equal(record.terminal, true);
    assert.equal(record.retryable, false);
    assert.equal(record.recoveryState, "blocked");
  });
});

test("dlq: unknown remains dominant over a later definite rejection", async () => {
  await withEnv(async () => {
    const deliveryId = "telegram:unknown-first";
    await recordChannelDlqFailure({
      channel: "telegram",
      deliveryId,
      phase: "workflow-step-failed",
      terminal: true,
      retryable: false,
      deliveryOutcome: "unknown",
      requestId: "req-unknown",
      receivedAtMs: 1000,
      error: new Error("response lost after send"),
    });

    const record = await recordChannelDlqFailure({
      channel: "telegram",
      deliveryId,
      phase: "workflow-step-failed",
      terminal: true,
      retryable: false,
      deliveryOutcome: "not-accepted",
      requestId: "req-rejected",
      receivedAtMs: 1000,
      error: new Error("later rejection"),
    });

    assert.ok(record);
    assert.equal(record.deliveryOutcome, "unknown");
    assert.equal(record.recoveryState, "blocked");
  });
});

test("dlq: workflow-start failure defaults to retryable not-accepted", async () => {
  await withEnv(async () => {
    const record = await recordChannelDlqFailure({
      channel: "telegram",
      deliveryId: "telegram:workflow-start",
      phase: "workflow-start-failed",
      terminal: false,
      retryable: true,
      requestId: null,
      receivedAtMs: 1000,
      error: new Error("workflow start result unknown"),
    });

    assert.ok(record);
    assert.equal(record.deliveryOutcome, "not-accepted");
    assert.equal(record.terminal, false);
    assert.equal(record.retryable, true);
    assert.equal(record.recoveryState, "automatic-retry");
  });
});

test("dlq: unknown fence dominates during extended record-lock contention", async () => {
  await withEnv(async () => {
    const channel = "telegram" as const;
    const deliveryId = "telegram:extended-contention";
    const initial = await recordChannelDlqFailure({
      channel,
      deliveryId,
      phase: "workflow-step-failed",
      terminal: true,
      retryable: false,
      deliveryOutcome: "not-accepted",
      requestId: null,
      receivedAtMs: 1000,
      error: new Error("rejected"),
    });
    assert.ok(initial);

    const store = getStore();
    const lockKey = channelFailedRecordLockKey(channel, deliveryId);
    const lockToken = await store.acquireLock(lockKey, 60);
    assert.ok(lockToken);
    const unknownWrite = recordChannelDlqFailure({
      channel,
      deliveryId,
      phase: "workflow-start-failed",
      terminal: false,
      retryable: true,
      deliveryOutcome: "unknown",
      requestId: null,
      receivedAtMs: 1000,
      error: new Error("unknown while contended"),
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(
      await store.getValue(channelFailedUnknownKey(channel, deliveryId)),
    );
    assert.equal(
      (await getChannelDlqRecord(channel, deliveryId))?.deliveryOutcome,
      "unknown",
    );

    await store.releaseLock(lockKey, lockToken);
    const record = await unknownWrite;
    assert.equal(record?.deliveryOutcome, "unknown");
  });
});

test("dlq: fence read failures surface record projection unavailability", async () => {
  await withEnv(async () => {
    const channel = "telegram" as const;
    const deliveryId = "telegram:fence-read-error";
    const record = await recordChannelDlqFailure({
      channel,
      deliveryId,
      phase: "workflow-step-failed",
      terminal: true,
      retryable: false,
      deliveryOutcome: "not-accepted",
      requestId: null,
      receivedAtMs: 1000,
      error: new Error("rejected"),
    });
    assert.ok(record);

    const store = getStore();
    const originalGetValue = store.getValue.bind(store);
    const fenceKeys = new Set([
      channelFailedResolvedKey(channel, deliveryId),
      channelFailedUnknownKey(channel, deliveryId),
    ]);
    store.getValue = async <T>(key: string): Promise<T | null> => {
      if (fenceKeys.has(key)) throw new Error("fence read failed");
      return await originalGetValue<T>(key);
    };
    try {
      await assert.rejects(
        getChannelDlqRecord(channel, deliveryId),
        /fence unavailable/i,
      );
    } finally {
      store.getValue = originalGetValue;
    }
  });
});

test("dlq: concurrent evidence converges on unknown", async () => {
  await withEnv(async () => {
    const deliveryId = "telegram:concurrent-unknown";
    const base = {
      channel: "telegram" as const,
      deliveryId,
      phase: "workflow-step-failed" as const,
      terminal: true,
      retryable: false,
      requestId: null,
      receivedAtMs: 1000,
    };
    await Promise.all([
      recordChannelDlqFailure({
        ...base,
        deliveryOutcome: "not-accepted",
        error: new Error("rejected"),
      }),
      recordChannelDlqFailure({
        ...base,
        deliveryOutcome: "unknown",
        error: new Error("unknown"),
      }),
    ]);

    const record = await getChannelDlqRecord("telegram", deliveryId);
    assert.ok(record);
    assert.equal(record.deliveryOutcome, "unknown");
  });
});

test("dlq: resolution removes record and index entry", async () => {
  await withEnv(async () => {
    await recordChannelDlqFailure({
      channel: "telegram",
      deliveryId: "telegram:resolved",
      phase: "workflow-step-failed",
      terminal: false,
      retryable: true,
      requestId: null,
      receivedAtMs: Date.now(),
      error: new Error("transient"),
    });

    await resolveChannelDlqFailure("telegram", "telegram:resolved");

    assert.equal(
      await getChannelDlqRecord("telegram", "telegram:resolved"),
      null,
    );
    assert.deepEqual(
      await getStore().getValue(channelFailedIndexKey()),
      [],
    );
  });
});

test("dlq: ordinary accepted delivery uses only a short fence and no global index lock", async () => {
  await withEnv(async () => {
    const store = getStore();
    const channel = "telegram" as const;
    const deliveryId = "telegram:accepted-without-failure";
    const resolvedKey = channelFailedResolvedKey(channel, deliveryId);
    const resolvedTtls: number[] = [];
    const acquiredLocks: string[] = [];
    const originalSetValue = store.setValue.bind(store);
    const originalAcquireLock = store.acquireLock.bind(store);
    store.setValue = async <T>(
      key: string,
      value: T,
      ttlSeconds?: number,
    ): Promise<void> => {
      if (key === resolvedKey && typeof ttlSeconds === "number") {
        resolvedTtls.push(ttlSeconds);
      }
      await originalSetValue(key, value, ttlSeconds);
    };
    store.acquireLock = async (key, ttlSeconds) => {
      acquiredLocks.push(key);
      return await originalAcquireLock(key, ttlSeconds);
    };
    try {
      await resolveChannelDlqFailure(channel, deliveryId);
    } finally {
      store.setValue = originalSetValue;
      store.acquireLock = originalAcquireLock;
    }

    assert.deepEqual(resolvedTtls, [CHANNEL_DLQ_RESOLUTION_FENCE_TTL_SECONDS]);
    assert.equal(acquiredLocks.includes(channelFailedIndexLockKey()), false);
    assert.equal(await store.getValue(channelFailedIndexKey()), null);
  });
});

test("dlq: resolution waits for brief index lock contention", async () => {
  await withEnv(async () => {
    const channel = "telegram" as const;
    const deliveryId = "telegram:lock-contended";
    await recordChannelDlqFailure({
      channel,
      deliveryId,
      phase: "workflow-step-failed",
      terminal: false,
      retryable: true,
      requestId: null,
      receivedAtMs: Date.now(),
      error: new Error("transient"),
    });

    const store = getStore();
    const lockToken = await store.acquireLock(
      channelFailedIndexLockKey(),
      60,
    );
    assert.ok(lockToken);
    setTimeout(() => {
      void store.releaseLock(channelFailedIndexLockKey(), lockToken);
    }, 25);
    await resolveChannelDlqFailure(channel, deliveryId);
    assert.equal(await getChannelDlqRecord(channel, deliveryId), null);
    const index = await store.getValue<Array<{ deliveryId: string }>>(
      channelFailedIndexKey(),
    );
    assert.equal(index?.some((entry) => entry.deliveryId === deliveryId), false);
  });
});

test("dlq: accepted resolution prevents record resurrection", async () => {
  await withEnv(async () => {
    const channel = "telegram" as const;
    const deliveryId = "telegram:accepted";
    const staleRecord = await recordChannelDlqFailure({
      channel,
      deliveryId,
      phase: "workflow-step-failed",
      terminal: true,
      retryable: false,
      deliveryOutcome: "not-accepted",
      requestId: null,
      receivedAtMs: 1000,
      error: new Error("rejected"),
    });
    assert.ok(staleRecord);

    await resolveChannelDlqFailure(channel, deliveryId);
    const recreated = await recordChannelDlqFailure({
      channel,
      deliveryId,
      phase: "workflow-step-failed",
      terminal: true,
      retryable: false,
      deliveryOutcome: "not-accepted",
      requestId: null,
      receivedAtMs: 1000,
      error: new Error("late workflow failure"),
    });

    assert.equal(recreated, null);
    assert.equal(await getChannelDlqRecord(channel, deliveryId), null);
    assert.ok(
      await getStore().getValue(channelFailedResolvedKey(channel, deliveryId)),
    );
  });
});

test("dlq: index read failure preserves the existing index", async () => {
  await withEnv(async () => {
    const store = getStore();
    const existingIndex = [
      {
        channel: "slack" as const,
        deliveryId: "slack:existing",
        key: channelFailedKey("slack", "slack:existing"),
        failedAt: 1,
        phase: "workflow-step-failed" as const,
        terminal: true,
      },
    ];
    await store.setValue(
      channelFailedIndexKey(),
      existingIndex,
      CHANNEL_DLQ_RECORD_TTL_SECONDS,
    );

    const originalGetValue = store.getValue.bind(store);
    store.getValue = async <T>(key: string): Promise<T | null> => {
      if (key === channelFailedIndexKey()) {
        throw new Error("index read failed");
      }
      return await originalGetValue<T>(key);
    };
    try {
      const record = await recordChannelDlqFailure({
        channel: "telegram",
        deliveryId: "telegram:index-read-failed",
        phase: "workflow-step-failed",
        terminal: false,
        retryable: true,
        requestId: null,
        receivedAtMs: Date.now(),
        error: new Error("transient"),
      });
      assert.ok(record, "primary DLQ record remains best-effort durable");
    } finally {
      store.getValue = originalGetValue;
    }

    assert.deepEqual(
      await store.getValue(channelFailedIndexKey()),
      existingIndex,
    );
  });
});

test("dlq: poison alert fires exactly once at threshold within window", async () => {
  await withEnv(async () => {
    const deliveryId = "slack:poison-evt";
    const poisonCount = () =>
      getServerLogs().filter(
        (entry) => entry.message === "channels.dlq_poison_payload_detected",
      ).length;

    // Fail 4 times — no alert yet.
    for (let i = 0; i < 4; i++) {
      await recordChannelDlqFailure({
        channel: "slack",
        deliveryId,
        phase: "workflow-step-failed",
        terminal: true,
        retryable: false,
        requestId: null,
        receivedAtMs: Date.now(),
        error: new Error(`failure ${i + 1}`),
      });
    }
    assert.equal(poisonCount(), 0, "no alert below threshold");

    // 5th failure crosses the threshold.
    const fifth = await recordChannelDlqFailure({
      channel: "slack",
      deliveryId,
      phase: "workflow-step-failed",
      terminal: true,
      retryable: false,
      requestId: null,
      receivedAtMs: Date.now(),
      error: new Error("failure 5"),
    });
    assert.ok(fifth);
    assert.equal(fifth.failureCount, 5);
    assert.ok(
      typeof fifth.poisonAlertedAt === "number",
      "poisonAlertedAt is stamped on the threshold crossing",
    );
    assert.equal(poisonCount(), 1, "exactly one alert at threshold");

    // 6th failure must NOT re-alert.
    await recordChannelDlqFailure({
      channel: "slack",
      deliveryId,
      phase: "workflow-step-failed",
      terminal: true,
      retryable: false,
      requestId: null,
      receivedAtMs: Date.now(),
      error: new Error("failure 6"),
    });
    assert.equal(poisonCount(), 1, "alert is one-shot per deliveryId");
  });
});

test("dlq: summary aggregates channel counts, terminal count, oldest/newest", async () => {
  await withEnv(async () => {
    const base = Date.now() - 60_000;
    // Seed two DLQ records directly to control failedAt timestamps.
    await getStore().setValue(
      channelFailedKey("slack", "slack:a"),
      {
        channel: "slack",
        deliveryId: "slack:a",
        failedAt: base + 1000,
        firstFailedAt: base,
        failureCount: 3,
        terminal: true,
        retryable: false,
        phase: "workflow-step-failed",
      } satisfies Partial<ChannelDlqRecord>,
      CHANNEL_DLQ_RECORD_TTL_SECONDS,
    );
    await getStore().setValue(
      channelFailedKey("telegram", "telegram:b"),
      {
        channel: "telegram",
        deliveryId: "telegram:b",
        failedAt: base + 2000,
        firstFailedAt: base + 2000,
        failureCount: 1,
        terminal: false,
        retryable: true,
        phase: "workflow-start-failed",
      } satisfies Partial<ChannelDlqRecord>,
      CHANNEL_DLQ_RECORD_TTL_SECONDS,
    );
    await getStore().setValue(
      channelFailedIndexKey(),
      [
        {
          channel: "slack",
          deliveryId: "slack:a",
          key: channelFailedKey("slack", "slack:a"),
          failedAt: base + 1000,
          phase: "workflow-step-failed",
          terminal: true,
        },
        {
          channel: "telegram",
          deliveryId: "telegram:b",
          key: channelFailedKey("telegram", "telegram:b"),
          failedAt: base + 2000,
          phase: "workflow-start-failed",
          terminal: false,
        },
      ],
      CHANNEL_DLQ_RECORD_TTL_SECONDS,
    );

    const summary = await getChannelDlqSummary();
    assert.equal(summary.indexSize, 2);
    assert.equal(summary.channelCounts.slack, 1);
    assert.equal(summary.channelCounts.telegram, 1);
    assert.equal(summary.channelCounts.whatsapp, 0);
    assert.equal(summary.channelCounts.discord, 0);
    assert.equal(summary.terminalCount, 1);
    assert.equal(summary.oldestFailedAt, base + 1000);
    assert.equal(summary.newestFailedAt, base + 2000);
    assert.notEqual(summary.unavailable, true);
  });
});

test("dlq: accepted tombstones hide stale index resurrection", async () => {
  await withEnv(async () => {
    const channel = "telegram" as const;
    const deliveryId = "telegram:stale-index";
    const record = await recordChannelDlqFailure({
      channel,
      deliveryId,
      phase: "workflow-step-failed",
      terminal: true,
      retryable: false,
      deliveryOutcome: "not-accepted",
      requestId: null,
      receivedAtMs: 1000,
      error: new Error("rejected"),
    });
    assert.ok(record);
    await resolveChannelDlqFailure(channel, deliveryId);

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
      ],
      CHANNEL_DLQ_RECORD_TTL_SECONDS,
    );

    const summary = await getChannelDlqSummary();
    assert.equal(summary.indexSize, 0);
    assert.equal(summary.channelCounts.telegram, 0);
    assert.equal(summary.terminalCount, 0);
  });
});

test("dlq: stale index rows cannot evict older live failures at the cap", async () => {
  await withEnv(async () => {
    const store = getStore();
    const olderDeliveryId = "telegram:older-live";
    const older = await recordChannelDlqFailure({
      channel: "telegram",
      deliveryId: olderDeliveryId,
      phase: "workflow-step-failed",
      terminal: true,
      retryable: false,
      deliveryOutcome: "not-accepted",
      requestId: null,
      receivedAtMs: 1000,
      error: new Error("older rejected"),
    });
    assert.ok(older);
    const staleEntries = Array.from({ length: 499 }, (_, index) => {
      const deliveryId = `telegram:stale-${index}`;
      return {
        channel: "telegram" as const,
        deliveryId,
        key: channelFailedKey("telegram", deliveryId),
        failedAt: older.failedAt + index + 1,
        phase: "workflow-step-failed" as const,
        terminal: true,
      };
    });
    await store.setValue(
      channelFailedIndexKey(),
      [
        ...staleEntries,
        {
          channel: older.channel,
          deliveryId: older.deliveryId,
          key: channelFailedKey(older.channel, older.deliveryId),
          failedAt: older.failedAt,
          phase: older.phase,
          terminal: older.terminal,
        },
      ],
      CHANNEL_DLQ_RECORD_TTL_SECONDS,
    );

    const newer = await recordChannelDlqFailure({
      channel: "telegram",
      deliveryId: "telegram:newer-live",
      phase: "workflow-step-failed",
      terminal: true,
      retryable: false,
      deliveryOutcome: "not-accepted",
      requestId: null,
      receivedAtMs: 1000,
      error: new Error("newer rejected"),
    });
    assert.ok(newer);

    const index = await store.getValue<ChannelDlqIndexEntry[]>(
      channelFailedIndexKey(),
    );
    assert.deepEqual(
      index?.map((entry) => entry.deliveryId),
      [newer.deliveryId, older.deliveryId],
    );
  });
});

test("dlq: summary returns unavailable on store read failure", async () => {
  await withEnv(async () => {
    const store = getStore();
    const originalGetValue = store.getValue.bind(store);
    store.getValue = async () => {
      throw new Error("redis unreachable");
    };
    try {
      const summary = await getChannelDlqSummary();
      assert.equal(summary.unavailable, true);
      assert.equal(summary.indexSize, 0);
      assert.equal(summary.channelCounts.slack, 0);
    } finally {
      store.getValue = originalGetValue;
    }
  });
});
