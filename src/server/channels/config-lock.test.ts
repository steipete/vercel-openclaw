import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireChannelConfigLease,
  withChannelConfigLease,
} from "@/server/channels/config-lock";
import { channelConfigLockKey } from "@/server/store/keyspace";
import { getInitializedMeta, getStore } from "@/server/store/store";
import { withHarness } from "@/test-utils/harness";

test("channel config lease renews ownership and fences competitors", async () => {
  await withHarness(async () => {
    const store = getStore();
    const renewLock = store.renewLock.bind(store);
    let renewCalls = 0;
    store.renewLock = async (...args) => {
      renewCalls += 1;
      return renewLock(...args);
    };

    const lease = await acquireChannelConfigLease("telegram", {
      ttlSeconds: 3,
      waitMs: 10,
    });
    try {
      await lease.assertOwned();
      assert.equal(renewCalls, 1);
      assert.equal(
        await store.acquireLock(channelConfigLockKey("telegram"), 3),
        null,
      );
      assert.equal(lease.signal.aborted, false);
    } finally {
      await lease.release();
      store.renewLock = renewLock;
    }
  });
});

test("channel config lease aborts and fails closed after ownership loss", async () => {
  await withHarness(async () => {
    const store = getStore();
    const renewLock = store.renewLock.bind(store);
    const lease = await acquireChannelConfigLease("slack", {
      ttlSeconds: 3,
      waitMs: 10,
    });
    store.renewLock = async () => false;

    try {
      await assert.rejects(lease.assertOwned(), /channel_config_lock_lost:slack/);
      assert.equal(lease.signal.aborted, true);
    } finally {
      store.renewLock = renewLock;
      await lease.release();
    }
  });
});

test("channel config operation verifies ownership again before committing success", async () => {
  await withHarness(async () => {
    const store = getStore();
    const renewLock = store.renewLock.bind(store);
    let renewCalls = 0;
    store.renewLock = async (...args) => {
      renewCalls += 1;
      if (renewCalls >= 2) return false;
      return renewLock(...args);
    };

    try {
      await assert.rejects(
        withChannelConfigLease("telegram", async () => "done"),
        /channel_config_lock_lost:telegram/,
      );
    } finally {
      store.renewLock = renewLock;
    }
  });
});

test("channel config lease renews automatically before TTL expiry", async () => {
  await withHarness(async () => {
    const store = getStore();
    const renewLock = store.renewLock.bind(store);
    let renewCalls = 0;
    store.renewLock = async (...args) => {
      renewCalls += 1;
      return renewLock(...args);
    };
    const lease = await acquireChannelConfigLease("telegram", {
      ttlSeconds: 3,
      waitMs: 10,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      assert.ok(renewCalls >= 1);
      assert.equal(lease.signal.aborted, false);
    } finally {
      store.renewLock = renewLock;
      await lease.release();
    }
  });
});

test("channel config metadata commit is atomically fenced by lease ownership", async () => {
  await withHarness(async () => {
    const lease = await acquireChannelConfigLease("slack", { waitMs: 10 });
    await lease.release();

    await assert.rejects(
      lease.mutateMeta((meta) => {
        meta.channels.slack = {
          signingSecret: "stale-secret",
          botToken: "stale-token",
          configuredAt: Date.now(),
        };
      }),
    );
    assert.equal((await getInitializedMeta()).channels.slack, null);
  });
});
