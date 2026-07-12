/**
 * Tests for POST /api/admin/snapshots/delete.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { SnapshotRecord } from "@/shared/types";
import {
  postAdminSnapshotsDelete,
} from "@/app/api/admin/snapshots/delete/route";
import {
  _resetStoreForTesting,
  getInitializedMeta,
  getStore,
  mutateMeta,
} from "@/server/store/store";
import {
  hostSuspensionOperationKey,
  lifecycleLockKey,
} from "@/server/store/keyspace";
import {
  callRoute,
  buildPostRequest,
  buildAuthPostRequest,
  patchNextServerAfter,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";

patchNextServerAfter();

function getAdminSnapshotsDeleteRoute(): {
  POST: (request: Request) => Promise<Response>;
} {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/app/api/admin/snapshots/delete/route") as {
    POST: (request: Request) => Promise<Response>;
  };
}

async function withTestEnv(fn: () => Promise<void>): Promise<void> {
  const keys = [
    "NODE_ENV",
    "VERCEL",
    "VERCEL_AUTH_MODE",
    "REDIS_URL",
    "KV_URL",
    "ADMIN_SECRET",
    "SESSION_SECRET",
  ];
  const originals: Record<string, string | undefined> = {};

  for (const key of keys) {
    originals[key] = process.env[key];
  }

  (process.env as Record<string, string | undefined>)["NODE_ENV"] = "test";
  delete process.env.VERCEL;
  delete process.env.VERCEL_AUTH_MODE;
  delete process.env.REDIS_URL;
  delete process.env.KV_URL;
  process.env.ADMIN_SECRET = "test-admin-secret-for-scenarios";
  process.env.SESSION_SECRET = "test-session-secret-for-smoke-tests";

  _resetStoreForTesting();

  try {
    await fn();
  } finally {
    for (const key of keys) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
    _resetStoreForTesting();
    resetAfterCallbacks();
  }
}

test("POST /api/admin/snapshots/delete: without auth returns 401", async () => {
  await withTestEnv(async () => {
    const route = getAdminSnapshotsDeleteRoute();
    const request = buildPostRequest(
      "/api/admin/snapshots/delete",
      JSON.stringify({ snapshotId: "snap-x" }),
    );
    const result = await callRoute(route.POST, request);
    assert.equal(result.status, 401);
  });
});

test("POST /api/admin/snapshots/delete: 404 when snapshot not in history", async () => {
  await withTestEnv(async () => {
    const request = buildAuthPostRequest(
      "/api/admin/snapshots/delete",
      JSON.stringify({ snapshotId: "snap-unknown" }),
    );
    const result = await callRoute(
      (req) => postAdminSnapshotsDelete(req),
      request,
    );
    assert.equal(result.status, 404);
    const body = result.json as { error: string };
    assert.equal(body.error, "SNAPSHOT_NOT_FOUND");
  });
});

test("POST /api/admin/snapshots/delete: 409 when deleting current snapshot", async () => {
  await withTestEnv(async () => {
    const current: SnapshotRecord = {
      id: "id-1",
      snapshotId: "snap-current",
      timestamp: Date.now(),
      reason: "manual",
    };
    const other: SnapshotRecord = {
      id: "id-2",
      snapshotId: "snap-old",
      timestamp: Date.now() - 1000,
      reason: "manual",
    };

    await mutateMeta((meta) => {
      meta.snapshotId = "snap-current";
      meta.snapshotHistory = [current, other];
    });

    const request = buildAuthPostRequest(
      "/api/admin/snapshots/delete",
      JSON.stringify({ snapshotId: "snap-current" }),
    );
    const result = await callRoute(
      (req) => postAdminSnapshotsDelete(req),
      request,
    );
    assert.equal(result.status, 409);
    const body = result.json as { error: string };
    assert.equal(body.error, "CANNOT_DELETE_CURRENT_SNAPSHOT");
  });
});

test("POST /api/admin/snapshots/delete: removes non-current snapshot from history", async () => {
  await withTestEnv(async () => {
    const current: SnapshotRecord = {
      id: "id-1",
      snapshotId: "snap-current",
      timestamp: Date.now(),
      reason: "manual",
    };
    const old: SnapshotRecord = {
      id: "id-2",
      snapshotId: "snap-old",
      timestamp: Date.now() - 1000,
      reason: "manual",
    };

    await mutateMeta((meta) => {
      meta.snapshotId = "snap-current";
      meta.snapshotHistory = [current, old];
    });

    const request = buildAuthPostRequest(
      "/api/admin/snapshots/delete",
      JSON.stringify({ snapshotId: "snap-old" }),
    );
    const noopDelete = async () => {};
    const result = await callRoute(
      (req) => postAdminSnapshotsDelete(req, { deleteSnapshot: noopDelete }),
      request,
    );
    assert.equal(result.status, 200);
    const body = result.json as {
      ok: boolean;
      snapshots: SnapshotRecord[];
    };
    assert.equal(body.ok, true);
    assert.equal(body.snapshots.length, 1);
    assert.equal(body.snapshots[0].snapshotId, "snap-current");
  });
});

test("POST /api/admin/snapshots/delete: rejects a superseded lifecycle generation", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-delete-old";
      meta.lifecycleAttemptId = "attempt-delete-old";
      meta.snapshotId = "snap-current";
      meta.snapshotHistory = [
        {
          id: "id-current",
          snapshotId: "snap-current",
          timestamp: Date.now(),
          reason: "manual",
        },
        {
          id: "id-old",
          snapshotId: "snap-old",
          timestamp: Date.now() - 1_000,
          reason: "manual",
        },
      ];
    });

    const result = await callRoute(
      (request) => postAdminSnapshotsDelete(request, {
        deleteSnapshot: async () => {
          await mutateMeta((meta) => {
            meta.sandboxId = "sbx-delete-replacement";
            meta.lifecycleAttemptId = "attempt-delete-replacement";
          });
        },
      }),
      buildAuthPostRequest(
        "/api/admin/snapshots/delete",
        JSON.stringify({ snapshotId: "snap-old" }),
      ),
    );

    assert.equal(result.status, 409);
    assert.equal(
      (result.json as { error: string }).error,
      "SNAPSHOT_DELETE_SUPERSEDED",
    );
  });
});

test("POST /api/admin/snapshots/delete: rejects a fence published while waiting for lifecycle ownership", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-delete-fence-race";
      meta.lifecycleAttemptId = "attempt-delete-fence-race";
      meta.snapshotId = "snap-current";
      meta.snapshotHistory = [
        {
          id: "id-current",
          snapshotId: "snap-current",
          timestamp: Date.now(),
          reason: "manual",
        },
        {
          id: "id-old",
          snapshotId: "snap-old",
          timestamp: Date.now() - 1_000,
          reason: "manual",
        },
      ];
    });

    const store = getStore();
    const acquireLock = store.acquireLock.bind(store);
    let releaseLifecycleWait!: () => void;
    const lifecycleWait = new Promise<void>((resolve) => {
      releaseLifecycleWait = resolve;
    });
    let signalLifecycleWait!: () => void;
    const lifecycleAcquireStarted = new Promise<void>((resolve) => {
      signalLifecycleWait = resolve;
    });
    let gateLifecycleAcquire = true;
    store.acquireLock = async (key, ttlSeconds) => {
      if (key === lifecycleLockKey() && gateLifecycleAcquire) {
        gateLifecycleAcquire = false;
        signalLifecycleWait();
        await lifecycleWait;
      }
      return acquireLock(key, ttlSeconds);
    };

    let deleteCalls = 0;
    try {
      const resultPromise = callRoute(
        (request) => postAdminSnapshotsDelete(request, {
          deleteSnapshot: async () => {
            deleteCalls += 1;
          },
        }),
        buildAuthPostRequest(
          "/api/admin/snapshots/delete",
          JSON.stringify({ snapshotId: "snap-old" }),
        ),
      );
      await lifecycleAcquireStarted;

      const now = Date.now();
      await store.setValue(hostSuspensionOperationKey(), {
        version: 1,
        operationId: "operation-delete-fence-race",
        requestId: "request-delete-fence-race",
        sandboxId: "sbx-delete-fence-race",
        lifecycleAttemptId: "attempt-delete-fence-race",
        intent: "stop",
        reason: "test-stop-won-race",
        phase: "stopping",
        ingressFenced: true,
        suspensionId: "suspension-delete-fence-race",
        leaseExpiresAtMs: now + 60_000,
        stopRequestDeadlineAtMs: null,
        monitorHeartbeatAtMs: now,
        startedAtMs: now - 1_000,
        updatedAtMs: now,
        stoppedAtMs: null,
        resumedAtMs: null,
        lastError: null,
        lastErrorCode: null,
        lastErrorClass: null,
      });
      releaseLifecycleWait();

      const result = await resultPromise;
      assert.equal(result.status, 503);
      assert.equal(
        (result.json as { error: string }).error,
        "HOST_INGRESS_FENCED",
      );
      assert.equal(deleteCalls, 0);
      assert.deepEqual(
        (await getInitializedMeta()).snapshotHistory.map(
          (snapshot) => snapshot.snapshotId,
        ),
        ["snap-current", "snap-old"],
      );
    } finally {
      releaseLifecycleWait();
      store.acquireLock = acquireLock;
    }
  });
});
