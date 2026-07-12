import assert from "node:assert/strict";
import test from "node:test";

import { buildAuthPostRequest, buildPostRequest, callRoute, patchNextServerAfter, resetAfterCallbacks } from "@/test-utils/route-caller";
import { withHarness } from "@/test-utils/harness";
import { loginWithAdminSecret } from "@/server/auth/admin-auth";
import { _setSnapshotDeletionOverrideForTesting } from "@/server/sandbox/snapshot-delete";

patchNextServerAfter();

type ResetRouteModule = {
  POST: (request: Request) => Promise<Response>;
};

function getAdminResetRoute(): ResetRouteModule {
  const routePath = require.resolve("@/app/api/admin/reset/route");
  delete require.cache[routePath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(routePath) as ResetRouteModule;
}

test.afterEach(() => {
  _setSnapshotDeletionOverrideForTesting(null);
  resetAfterCallbacks();
});

test("admin/reset POST: without auth returns 401", async () => {
  await withHarness(async () => {
    const route = getAdminResetRoute();
    const result = await callRoute(route.POST, buildPostRequest("/api/admin/reset", "{}"));
    assert.equal(result.status, 401);
    const body = result.json as { error: string };
    assert.equal(body.error, "UNAUTHORIZED");
  });
});

// ---------------------------------------------------------------------------
// CSRF regression tests
// ---------------------------------------------------------------------------

test("admin/reset POST: cookie-auth without Origin or X-Requested-With returns 403 CSRF_HEADER_MISSING", async () => {
  await withHarness(async () => {
    const route = getAdminResetRoute();
    const login = await loginWithAdminSecret("test-admin-secret-for-scenarios", false);
    assert.ok(login, "expected admin cookie session");

    const request = buildPostRequest("/api/admin/reset", "{}", {
      cookie: login.setCookieHeader.split(";")[0],
    });
    const result = await callRoute(route.POST, request);

    assert.equal(result.status, 403);
    assert.deepEqual(result.json, {
      error: "CSRF_HEADER_MISSING",
      message: "Missing Origin or X-Requested-With header.",
    });
  });
});

test("admin/reset POST: cookie-auth with cross-origin Origin returns 403 CSRF_ORIGIN_MISMATCH", async () => {
  await withHarness(async () => {
    const route = getAdminResetRoute();
    const login = await loginWithAdminSecret("test-admin-secret-for-scenarios", false);
    assert.ok(login, "expected admin cookie session");

    const request = buildPostRequest("/api/admin/reset", "{}", {
      cookie: login.setCookieHeader.split(";")[0],
      origin: "https://evil.example",
    });
    const result = await callRoute(route.POST, request);

    assert.equal(result.status, 403);
    assert.deepEqual(result.json, {
      error: "CSRF_ORIGIN_MISMATCH",
      message: "Cross-origin request blocked.",
    });
  });
});

test("admin/reset POST: cookie-auth with same-origin Origin returns 200", async () => {
  await withHarness(async () => {
    const route = getAdminResetRoute();
    const login = await loginWithAdminSecret("test-admin-secret-for-scenarios", false);
    assert.ok(login, "expected admin cookie session");

    const request = buildPostRequest("/api/admin/reset", "{}", {
      cookie: login.setCookieHeader.split(";")[0],
      origin: "http://localhost:3000",
    });
    const result = await callRoute(route.POST, request);

    assert.equal(result.status, 200);
    assert.deepEqual(result.json, {
      ok: true,
      message: "Sandbox reset completed",
      status: "uninitialized",
    });
  });
});

test("admin/reset POST: bearer-auth succeeds without CSRF headers", async () => {
  await withHarness(async () => {
    const route = getAdminResetRoute();
    const request = buildPostRequest("/api/admin/reset", "{}", {
      authorization: "Bearer test-admin-secret-for-scenarios",
    });
    const result = await callRoute(route.POST, request);

    assert.equal(result.status, 200);
    assert.deepEqual(result.json, {
      ok: true,
      message: "Sandbox reset completed",
      status: "uninitialized",
    });
  });
});

test("admin/reset POST: confirms the durable reset before responding", async () => {
  await withHarness(async (h) => {
    const route = getAdminResetRoute();
    await h.driveToRunning();

    const beforeMeta = await h.getMeta();
    const originalSandboxId = beforeMeta.sandboxId;
    assert.ok(originalSandboxId, "sandbox should be running before reset");

    await h.mutateMeta((meta) => {
      meta.snapshotConfigHash = "cfg-old";
      meta.snapshotHistory = [];
      meta.lastError = "stale";
    });

    const result = await callRoute(route.POST, buildAuthPostRequest("/api/admin/reset", "{}"));

    assert.equal(result.status, 200);
    assert.deepEqual(result.json, {
      ok: true,
      message: "Sandbox reset completed",
      status: "uninitialized",
    });

    const afterMeta = await h.getMeta();
    assert.equal(afterMeta.status, "uninitialized");
    assert.equal(afterMeta.sandboxId, null);
    assert.equal(afterMeta.snapshotId, null);
    assert.equal(afterMeta.snapshotConfigHash, null);
    assert.deepEqual(afterMeta.snapshotHistory, []);
    assert.equal(afterMeta.lastError, null);

    const stoppedHandle = h.controller.getHandle(originalSandboxId);
    assert.ok(stoppedHandle?.deleteCalled, "reset should delete the original sandbox");
    assert.equal(stoppedHandle?.snapshotCalled, false, "reset should not snapshot before deleting");
  });
});

test("admin/reset POST: reports incomplete snapshot deletion as non-success", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();
    await h.mutateMeta((meta) => {
      meta.snapshotId = "snap-reset-route-failure";
      meta.snapshotHistory = [{
        id: "history-reset-route-failure",
        snapshotId: "snap-reset-route-failure",
        timestamp: Date.now(),
        reason: "manual",
      }];
    });
    _setSnapshotDeletionOverrideForTesting(async () => {
      throw new Error("provider deletion unavailable");
    });

    const result = await callRoute(
      getAdminResetRoute().POST,
      buildAuthPostRequest("/api/admin/reset", "{}"),
    );

    assert.equal(result.status, 502);
    assert.equal(
      (result.json as { error: string }).error,
      "SANDBOX_RESET_INCOMPLETE",
    );
    const after = await h.getMeta();
    assert.equal(after.status, "error");
    assert.equal(after.sandboxId, null);
    assert.equal(after.snapshotId, "snap-reset-route-failure");
  });
});
