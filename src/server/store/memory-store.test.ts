/**
 * Tests for MemoryStore — the in-memory store backend.
 *
 * Covers: meta CRUD, key-value get/set with TTL,
 * lock acquisition/renewal/release, and garbage collection.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultMeta } from "@/shared/types";
import { _setInstanceIdOverrideForTesting } from "@/server/env";
import { MemoryStore } from "@/server/store/memory-store";

function makeStore(): MemoryStore {
  return new MemoryStore();
}

function withInstanceId<T>(
  instanceId: string | null,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  _setInstanceIdOverrideForTesting(instanceId);

  const restore = () => {
    _setInstanceIdOverrideForTesting(null);
  };

  let result: T | Promise<T>;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }

  if (result instanceof Promise) {
    return result.finally(restore);
  }

  restore();
  return result;
}

function makeMeta(version = 1, instanceId?: string) {
  const meta = createDefaultMeta(Date.now(), "test-token", instanceId);
  meta.version = version;
  return meta;
}

// ---------------------------------------------------------------------------
// Meta operations
// ---------------------------------------------------------------------------

test("memory-store: getMeta returns null initially", async () => {
  const store = makeStore();
  assert.equal(await store.getMeta(), null);
});

test("memory-store: setMeta + getMeta round-trips", async () => {
  const store = makeStore();
  const meta = makeMeta();
  await store.setMeta(meta);
  const retrieved = await store.getMeta();
  assert.deepEqual(retrieved, meta);
});

test("memory-store: getMeta returns a clone", async () => {
  const store = makeStore();
  const meta = makeMeta();
  await store.setMeta(meta);
  const a = await store.getMeta();
  const b = await store.getMeta();
  assert.notStrictEqual(a, b, "should return distinct objects");
  assert.deepEqual(a, b);
});

test("memory-store: createMetaIfAbsent creates when absent", async () => {
  const store = makeStore();
  const meta = makeMeta();
  const created = await store.createMetaIfAbsent(meta);
  assert.equal(created, true);
  assert.deepEqual(await store.getMeta(), meta);
});

test("memory-store: createMetaIfAbsent does not overwrite when present", async () => {
  const store = makeStore();
  const first = makeMeta(1);
  const second = makeMeta(2);
  await store.setMeta(first);
  const created = await store.createMetaIfAbsent(second);
  assert.equal(created, false);
  const retrieved = await store.getMeta();
  assert.equal(retrieved!.version, 1);
});

test("memory-store: compareAndSetMeta succeeds with matching version", async () => {
  const store = makeStore();
  const meta = makeMeta(1);
  await store.setMeta(meta);
  const next = makeMeta(2);
  const ok = await store.compareAndSetMeta(1, next);
  assert.equal(ok, true);
  assert.equal((await store.getMeta())!.version, 2);
});

test("memory-store: compareAndSetMeta fails with mismatched version", async () => {
  const store = makeStore();
  await store.setMeta(makeMeta(1));
  const ok = await store.compareAndSetMeta(99, makeMeta(2));
  assert.equal(ok, false);
  assert.equal((await store.getMeta())!.version, 1);
});

test("memory-store: compareAndSetMeta fails when no meta exists", async () => {
  const store = makeStore();
  const ok = await store.compareAndSetMeta(1, makeMeta());
  assert.equal(ok, false);
});

test("memory-store: default meta key follows instance id lazily", async () => {
  await withInstanceId("fork-a", async () => {
    const store = makeStore();
    await store.setMeta(makeMeta(1));

    const forkAMeta = await store.getMeta();
    assert.equal(forkAMeta?.id, "fork-a");

    _setInstanceIdOverrideForTesting("fork-b");
    assert.equal(await store.getMeta(), null);

    await store.setMeta(makeMeta(1));
    const forkBMeta = await store.getMeta();
    assert.equal(forkBMeta?.id, "fork-b");

    _setInstanceIdOverrideForTesting("fork-a");
    const restoredForkAMeta = await store.getMeta();
    assert.equal(restoredForkAMeta?.id, "fork-a");
  });
});

test("memory-store: configured meta key stays pinned across instance changes", async () => {
  await withInstanceId("fork-a", async () => {
    const store = new MemoryStore("pinned:meta");
    const meta = makeMeta(1, "pinned");
    await store.setMeta(meta);

    _setInstanceIdOverrideForTesting("fork-b");
    const retrieved = await store.getMeta();
    assert.equal(retrieved?.id, "pinned");
  });
});

// ---------------------------------------------------------------------------
// Key-value operations
// ---------------------------------------------------------------------------

test("memory-store: getValue returns null for missing key", async () => {
  const store = makeStore();
  assert.equal(await store.getValue("missing"), null);
});

test("memory-store: setValue + getValue round-trips", async () => {
  const store = makeStore();
  await store.setValue("key1", { hello: "world" });
  const value = await store.getValue<{ hello: string }>("key1");
  assert.deepEqual(value, { hello: "world" });
});

test("memory-store: hasValue checks presence without decoding payload", async () => {
  const store = new MemoryStore();
  assert.equal(await store.hasValue("presence"), false);
  await store.setValue("presence", { private: "payload" });
  assert.equal(await store.hasValue("presence"), true);
  await store.deleteValue("presence");
  assert.equal(await store.hasValue("presence"), false);
});

test("memory-store: unscoped keys remain allowed for local development", async () => {
  const store = makeStore();
  await store.setValue("plain-key", "value");
  assert.equal(await store.getValue("plain-key"), "value");
});

test("memory-store: setValue overwrites existing", async () => {
  const store = makeStore();
  await store.setValue("key1", "first");
  await store.setValue("key1", "second");
  assert.equal(await store.getValue("key1"), "second");
});

test("memory-store: compareAndSetValue creates and advances matching revisions", async () => {
  const store = makeStore();
  assert.equal(
    await store.compareAndSetValue("projection", null, { revision: 1, value: "a" }),
    true,
  );
  assert.equal(
    await store.compareAndSetValue("projection", null, { revision: 1, value: "race" }),
    false,
  );
  assert.equal(
    await store.compareAndSetValue("projection", 9, { revision: 10, value: "wrong" }),
    false,
  );
  assert.equal(
    await store.compareAndSetValue("projection", 1, { revision: 2, value: "b" }),
    true,
  );
  assert.deepEqual(await store.getValue("projection"), { revision: 2, value: "b" });
});

test("memory-store: deleteValue removes key", async () => {
  const store = makeStore();
  await store.setValue("key1", "value");
  await store.deleteValue("key1");
  assert.equal(await store.getValue("key1"), null);
});

test("memory-store: TTL expires values", async () => {
  const store = makeStore();
  // Set with 0 TTL (expires immediately in next gc cycle)
  await store.setValue("ephemeral", "gone", 0);
  // Wait for gc to pick it up — gc runs on next operation
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await store.getValue("ephemeral"), null);
});

test("memory-store: non-TTL values persist", async () => {
  const store = makeStore();
  await store.setValue("persistent", "stays");
  // Trigger gc via another operation
  await store.getValue("other");
  assert.equal(await store.getValue("persistent"), "stays");
});

// ---------------------------------------------------------------------------
// Lock operations
// ---------------------------------------------------------------------------

test("memory-store: acquireLock returns token on success", async () => {
  const store = makeStore();
  const token = await store.acquireLock("lock1", 60);
  assert.ok(token, "should return a token string");
  assert.equal(typeof token, "string");
});

test("memory-store: acquireLock returns null if already locked", async () => {
  const store = makeStore();
  await store.acquireLock("lock1", 60);
  const second = await store.acquireLock("lock1", 60);
  assert.equal(second, null);
});

test("memory-store: acquireLock succeeds after TTL expires", async () => {
  const store = makeStore();
  await store.acquireLock("lock1", 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const token = await store.acquireLock("lock1", 60);
  assert.ok(token, "should acquire after expiry");
});

test("memory-store: renewLock extends TTL with matching token", async () => {
  const store = makeStore();
  const token = await store.acquireLock("lock1", 1);
  assert.ok(token);
  const renewed = await store.renewLock("lock1", token!, 60);
  assert.equal(renewed, true);
});

test("memory-store: renewLock fails with wrong token", async () => {
  const store = makeStore();
  await store.acquireLock("lock1", 60);
  const renewed = await store.renewLock("lock1", "wrong-token", 60);
  assert.equal(renewed, false);
});

test("memory-store: lock-owned value writes reject stale tokens", async () => {
  const store = makeStore();
  const token = await store.acquireLock("lock1", 60);
  assert.ok(token);

  assert.equal(
    await store.setValueIfLockHeld("lock1", token, "value1", "current", 60),
    true,
  );
  assert.equal(
    await store.setValueIfLockHeld("lock1", "stale", "value1", "stale", 60),
    false,
  );
  assert.equal(await store.getValue("value1"), "current");
});

test("memory-store: releaseLock frees the lock", async () => {
  const store = makeStore();
  const token = await store.acquireLock("lock1", 60);
  assert.ok(token);
  await store.releaseLock("lock1", token!);
  // Should be able to acquire again
  const newToken = await store.acquireLock("lock1", 60);
  assert.ok(newToken, "should acquire after release");
});

test("memory-store: releaseLock is no-op with wrong token", async () => {
  const store = makeStore();
  const token = await store.acquireLock("lock1", 60);
  assert.ok(token);
  await store.releaseLock("lock1", "wrong-token");
  // Lock should still be held
  const second = await store.acquireLock("lock1", 60);
  assert.equal(second, null, "lock should still be held");
});

// ---------------------------------------------------------------------------
// Store name
// ---------------------------------------------------------------------------

test("memory-store: name is 'memory'", () => {
  const store = makeStore();
  assert.equal(store.name, "memory");
});
