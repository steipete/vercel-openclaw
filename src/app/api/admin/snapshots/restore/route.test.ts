/**
 * Tests for POST /api/admin/snapshots/restore.
 *
 * Covers: auth enforcement (403 without CSRF), missing snapshotId (400),
 * unknown snapshot (404), happy path restore from stopped state.
 *
 * Run: npm test src/app/api/admin/snapshots/restore/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { _setSnapshotValidationOverrideForTesting } from "@/server/sandbox/snapshot-delete";
import { withHarness } from "@/test-utils/harness";
import {
  callRoute,
  buildPostRequest,
  callAdminPost,
  getAdminRestoreRoute,
  drainAfterCallbacks,
} from "@/test-utils/route-caller";

// ===========================================================================
// Auth enforcement
// ===========================================================================

test("admin/snapshots/restore POST: without auth returns 401", async () => {
  await withHarness(async () => {
    const route = getAdminRestoreRoute();
    const req = buildPostRequest(
      "/api/admin/snapshots/restore",
      JSON.stringify({ snapshotId: "snap-123" }),
    );
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 401);
  });
});

// ===========================================================================
// Validation
// ===========================================================================

test("admin/snapshots/restore POST: missing snapshotId returns 400", async () => {
  await withHarness(async () => {
    const route = getAdminRestoreRoute();
    const result = await callAdminPost(route.POST, "/api/admin/snapshots/restore", "{}");
    assert.equal(result.status, 400);
  });
});

test("admin/snapshots/restore POST: empty snapshotId returns 400", async () => {
  await withHarness(async () => {
    const route = getAdminRestoreRoute();
    const result = await callAdminPost(
      route.POST,
      "/api/admin/snapshots/restore",
      JSON.stringify({ snapshotId: "  " }),
    );
    assert.equal(result.status, 400);
  });
});

test("admin/snapshots/restore POST: invalid JSON returns 400", async () => {
  await withHarness(async () => {
    const route = getAdminRestoreRoute();
    const req = buildPostRequest("/api/admin/snapshots/restore", "not-json", {
      authorization: "Bearer test-admin-secret-for-scenarios",
      origin: "http://localhost:3000",
      "x-requested-with": "XMLHttpRequest",
    });
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 400);
    const body = result.json as { error: string };
    assert.equal(body.error, "INVALID_JSON");
  });
});

test("admin/snapshots/restore POST: unknown snapshotId returns 404", async () => {
  await withHarness(async () => {
    const route = getAdminRestoreRoute();
    const result = await callAdminPost(
      route.POST,
      "/api/admin/snapshots/restore",
      JSON.stringify({ snapshotId: "snap-nonexistent" }),
    );
    assert.equal(result.status, 404);
  });
});

// ===========================================================================
// Happy path: restore a known snapshot
// ===========================================================================

test("admin/snapshots/restore POST: restores known snapshot", async () => {
  await withHarness(async (h) => {
    // Drive to running, then stop
    await h.driveToRunning();
    const snapshotId = await h.stopToSnapshot();

    const route = getAdminRestoreRoute();
    const result = await callAdminPost(
      route.POST,
      "/api/admin/snapshots/restore",
      JSON.stringify({ snapshotId }),
    );

    // v2 persistent: restore sets the snapshotId and triggers ensure
    assert.ok(result.status === 200 || result.status === 202);
    await drainAfterCallbacks();
    // Allow any remaining background lifecycle work to settle
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});

test("admin/snapshots/restore POST: rejects historical snapshots without mutating", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-current";
      meta.snapshotHistory = [
        {
          id: "hist-1",
          snapshotId: "snap-from-history",
          timestamp: Date.now() - 1_000,
          reason: "scheduled",
        },
      ];
    });

    const route = getAdminRestoreRoute();
    const result = await callAdminPost(
      route.POST,
      "/api/admin/snapshots/restore",
      JSON.stringify({ snapshotId: "snap-from-history" }),
    );

    assert.equal(result.status, 409);
    assert.equal(
      (result.json as { error: string }).error,
      "HISTORICAL_SNAPSHOT_RESTORE_UNSUPPORTED",
    );
    const after = await h.getMeta();
    assert.equal(after.snapshotId, "snap-current");
    assert.equal(after.status, "stopped");
  });
});

test("admin/snapshots/restore POST: preserves a running generation for historical requests", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();
    const running = await h.getMeta();
    assert.ok(running.sandboxId);
    const runningHandle = h.controller.getHandle(running.sandboxId);
    assert.ok(runningHandle);

    await h.mutateMeta((meta) => {
      meta.snapshotId = "snap-current";
      meta.snapshotHistory = [
        {
          id: "hist-old",
          snapshotId: "snap-old",
          timestamp: Date.now() - 1_000,
          reason: "scheduled",
        },
      ];
    });

    const route = getAdminRestoreRoute();
    const result = await callAdminPost(
      route.POST,
      "/api/admin/snapshots/restore",
      JSON.stringify({ snapshotId: "snap-old" }),
    );

    assert.equal(result.status, 409);
    assert.equal(
      runningHandle.deleteCalled,
      false,
      "unsupported restore must not delete the snapshot-owning sandbox",
    );
    const after = await h.getMeta();
    assert.equal(after.sandboxId, running.sandboxId);
    assert.equal(after.snapshotId, "snap-current");
  });
});

test("admin/snapshots/restore POST: preserves an orphaned named sandbox for historical requests", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();
    const running = await h.getMeta();
    assert.ok(running.sandboxId);
    const runningHandle = h.controller.getHandle(running.sandboxId);
    assert.ok(runningHandle);
    h.controller.handlesByIds.set("oc-openclaw-single", runningHandle);
    await h.mutateMeta((meta) => {
      meta.sandboxId = null;
      meta.portUrls = null;
      meta.status = "stopped";
      meta.snapshotId = "snap-current";
      meta.snapshotHistory = [
        {
          id: "hist-orphaned",
          snapshotId: "snap-orphaned-restore",
          timestamp: Date.now() - 1_000,
          reason: "scheduled",
        },
      ];
    });

    const result = await callAdminPost(
      getAdminRestoreRoute().POST,
      "/api/admin/snapshots/restore",
      JSON.stringify({ snapshotId: "snap-orphaned-restore" }),
    );

    assert.equal(result.status, 409);
    assert.equal(runningHandle.deleteCalled, false);
    assert.equal((await h.getMeta()).snapshotId, "snap-current");
  });
});

test("admin/snapshots/restore POST: fails closed before provider access", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();
    const running = await h.getMeta();
    assert.ok(running.sandboxId);
    const runningHandle = h.controller.getHandle(running.sandboxId);
    assert.ok(runningHandle);
    await h.mutateMeta((meta) => {
      meta.snapshotHistory = [
        {
          id: "expired-history",
          snapshotId: "snap-expired",
          timestamp: Date.now() - 1_000,
          reason: "scheduled",
        },
      ];
    });
    let providerReads = 0;
    _setSnapshotValidationOverrideForTesting(async () => {
      providerReads += 1;
      throw new Error("provider must not be called");
    });

    try {
      const result = await callAdminPost(
        getAdminRestoreRoute().POST,
        "/api/admin/snapshots/restore",
        JSON.stringify({ snapshotId: "snap-expired" }),
      );
      assert.equal(result.status, 409);
      assert.equal(
        (result.json as { error: string }).error,
        "HISTORICAL_SNAPSHOT_RESTORE_UNSUPPORTED",
      );
      assert.equal(providerReads, 0);
      assert.equal(runningHandle.deleteCalled, false);
      assert.equal((await h.getMeta()).sandboxId, running.sandboxId);
    } finally {
      _setSnapshotValidationOverrideForTesting(null);
    }
  });
});
