import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock, test } from "node:test";

import {
  POST,
  cronProjectionRouteRuntime,
} from "@/app/api/internal/cron-projection/route";
import {
  CRON_PROJECTION_CAPABILITY,
} from "@/server/cron/compatibility";
import {
  _resetBundleIdentityForTesting,
  _setBundleAdmissionForTesting,
} from "@/server/openclaw/bundle-identity";
import { cronDispatchWorkflowRuntime } from "@/server/cron/dispatch";
import { readCronProjection } from "@/server/cron/projection";
import {
  _resetStoreForTesting,
  getInitializedMeta,
  getStore,
  mutateMeta,
} from "@/server/store/store";
import { cronProjectionKey } from "@/server/store/keyspace";

const gatewayValue = "cron-projection-test-gateway-value";
const bundleIdentity = {
  packageSpec: "openclaw@2026.7.2",
  version: "2026.7.2",
  forkSha: "a".repeat(40),
  upstreamSha: "b".repeat(40),
  canonicalSha256: "c".repeat(64),
  capabilities: [CRON_PROJECTION_CAPABILITY],
  verified: true as const,
};
const bundleReleaseUrl =
  "https://github.com/vercel-labs/openclaw/releases/download/v2026.7.2";

function configureBundleEnvironment(): void {
  process.env.OPENCLAW_BUNDLE_URL = `${bundleReleaseUrl}/openclaw.bundle.mjs`;
  process.env.OPENCLAW_BUNDLE_UI_URL = `${bundleReleaseUrl}/control-ui.tar.gz`;
  process.env.OPENCLAW_BUNDLE_MANIFEST_URL = `${bundleReleaseUrl}/asset-manifest.json`;
  process.env.OPENCLAW_BUNDLE_SOURCE_SHA = bundleIdentity.forkSha;
  process.env.OPENCLAW_BUNDLE_SHA256 = bundleIdentity.canonicalSha256;
}

function clearBundleEnvironment(): void {
  delete process.env.OPENCLAW_BUNDLE_URL;
  delete process.env.OPENCLAW_BUNDLE_UI_URL;
  delete process.env.OPENCLAW_BUNDLE_MANIFEST_URL;
  delete process.env.OPENCLAW_BUNDLE_SOURCE_SHA;
  delete process.env.OPENCLAW_BUNDLE_SHA256;
}

function projectionRequest(
  authorization: string,
  body: unknown,
): Request {
  return new Request(
    "https://app.test/api/internal/cron-projection?x-vercel-protection-bypass=secret-query",
    {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

function input(revision: number, wakes: Array<{ jobId: string; runAtMs: number }>) {
  const projectedAtMs = Date.now();
  return {
    schemaVersion: 1,
    gatewayGeneration: createHash("sha256")
      .update(gatewayValue)
      .digest("hex")
      .slice(0, 32),
    sourceId: "gateway-source-route",
    sourceStartedAtMs: projectedAtMs,
    sourceRevision: revision,
    reason: revision === 1 ? "startup" : "changed",
    projectedAtMs,
    wakes: wakes.map((wake) => ({
      jobKey: createHash("sha256")
        .update(wake.jobId)
        .digest("hex")
        .slice(0, 32),
      runAtMs: wake.runAtMs,
    })),
  };
}

test.beforeEach(async () => {
  (process.env as Record<string, string | undefined>).NODE_ENV = "test";
  delete process.env.OPENCLAW_PACKAGE_SPEC;
  configureBundleEnvironment();
  _resetBundleIdentityForTesting();
  _setBundleAdmissionForTesting({
    identity: bundleIdentity,
    canonicalTarball: "openclaw-sandbox-bundle.tar.gz",
    canonicalTarballUrl: "https://bundle.invalid/openclaw-sandbox-bundle.tar.gz",
    assets: {},
    externalPlugins: [],
  });
  _resetStoreForTesting();
  await getInitializedMeta();
  await mutateMeta((meta) => {
    meta.gatewayToken = gatewayValue;
    meta.bundleIdentity = bundleIdentity;
  });
});

test.afterEach(() => {
  mock.restoreAll();
  delete process.env.OPENCLAW_PACKAGE_SPEC;
  clearBundleEnvironment();
  _resetBundleIdentityForTesting();
  _resetStoreForTesting();
});

test("cron projection endpoint authenticates against the current gateway token", async () => {
  const response = await POST(
    projectionRequest("Bearer wrong", input(1, [])),
  );
  assert.equal(response.status, 401);
  assert.equal(await readCronProjection(), null);
});

test("cron projection endpoint binds the body to the authenticated gateway generation", async () => {
  const response = await POST(
    projectionRequest(`Bearer ${gatewayValue}`, {
      ...input(1, []),
      gatewayGeneration: "f".repeat(32),
    }),
  );
  assert.equal(response.status, 401);
  assert.equal(await readCronProjection(), null);
});

test("cron projection endpoint fails closed without verified bundle capability", async () => {
  delete process.env.OPENCLAW_BUNDLE_SOURCE_SHA;
  const response = await POST(
    projectionRequest(`Bearer ${gatewayValue}`, input(1, [])),
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "CRON_PROJECTION_UNVERIFIED_BUNDLE",
  });
  assert.equal(await readCronProjection(), null);
});

test("cron projection endpoint durably accepts a sanitized baseline and starts Workflow", async () => {
  const workflowEnvelopes: Array<Record<string, unknown>> = [];
  const workflowOptions: Array<Record<string, unknown>> = [];
  mock.method(
    cronProjectionRouteRuntime,
    "start",
    async (_workflow: unknown, args: unknown[], options: Record<string, unknown>) => {
      workflowEnvelopes.push(args[0] as Record<string, unknown>);
      workflowOptions.push(options);
      return { runId: "wrun-route" } as never;
    },
  );
  const response = await POST(
    projectionRequest(
      `Bearer ${gatewayValue}`,
      input(1, [{ jobId: "private-job-name", runAtMs: 1_900_000_000_000 }]),
    ),
  );
  assert.equal(response.status, 202);
  assert.equal((await response.json()).status, "accepted");
  assert.equal(workflowEnvelopes[0]?.origin, "https://app.test");
  assert.equal(JSON.stringify(workflowEnvelopes[0]).includes("secret-query"), false);
  assert.deepEqual(workflowOptions, [{ deploymentId: "latest" }]);

  const record = await readCronProjection();
  assert.equal(record?.wakes.length, 1);
  assert.equal(JSON.stringify(record).includes("private-job-name"), false);
  assert.equal(record?.dispatch.status, "scheduled");
});

test("identical lifecycle projections keep one sleeping Workflow", async () => {
  let starts = 0;
  mock.method(cronProjectionRouteRuntime, "start", async () => {
    starts += 1;
    return { runId: `wrun-${starts}` } as never;
  });
  const wake = [{ jobId: "private-job-name", runAtMs: 1_900_000_000_000 }];
  const first = await POST(
    projectionRequest(`Bearer ${gatewayValue}`, input(1, wake)),
  );
  const second = await POST(
    projectionRequest(`Bearer ${gatewayValue}`, input(2, wake)),
  );
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal((await second.json()).status, "idempotent");
  assert.equal(starts, 1);
  const record = await readCronProjection();
  assert.equal(record?.projectionRevision, 1);
  assert.equal(record?.source?.revision, 2);
  assert.equal(record?.dispatch.status, "scheduled");
  assert.equal(
    record?.dispatch.status === "scheduled"
      ? record.dispatch.workflowRunId
      : null,
    "wrun-1",
  );
});

test("rescheduling cancels the superseded timer after the new projection is durable", async () => {
  let starts = 0;
  const cancelled: string[] = [];
  mock.method(cronProjectionRouteRuntime, "start", async () => {
    starts += 1;
    return { runId: `wrun-${starts}` } as never;
  });
  mock.method(cronDispatchWorkflowRuntime, "cancel", async (runId: string) => {
    cancelled.push(runId);
    const record = await readCronProjection();
    assert.equal(record?.source?.revision, 2);
  });
  const first = await POST(
    projectionRequest(
      `Bearer ${gatewayValue}`,
      input(1, [{ jobId: "private-job", runAtMs: 1_900_000_000_000 }]),
    ),
  );
  const second = await POST(
    projectionRequest(
      `Bearer ${gatewayValue}`,
      input(2, [{ jobId: "private-job", runAtMs: 1_900_000_060_000 }]),
    ),
  );
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(starts, 2);
  assert.deepEqual(cancelled, ["wrun-1"]);
  const record = await readCronProjection();
  assert.equal(record?.dispatch.status, "scheduled");
  assert.equal(
    record?.dispatch.status === "scheduled"
      ? record.dispatch.workflowRunId
      : null,
    "wrun-2",
  );
});

test("cron projection endpoint stays retriable until Workflow dispatch is durable", async () => {
  mock.method(cronProjectionRouteRuntime, "start", async () => {
    throw new Error("workflow unavailable");
  });
  const response = await POST(
    projectionRequest(
      `Bearer ${gatewayValue}`,
      input(1, [{ jobId: "private-job-name", runAtMs: 1_900_000_000_000 }]),
    ),
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "CRON_PROJECTION_DISPATCH_PENDING",
    projectionRevision: 1,
    dispatch: "failed",
  });
  assert.equal((await readCronProjection())?.dispatch.status, "failed");
});

test("cron projection endpoint rejects malformed snapshots without changing state", async () => {
  const response = await POST(
    projectionRequest(`Bearer ${gatewayValue}`, {
      ...input(1, []),
      wakes: [{ jobKey: "a".repeat(32), runAtMs: -1 }],
    }),
  );
  assert.equal(response.status, 400);
  assert.equal(await readCronProjection(), null);
});

test("cron projection endpoint reports corrupt durable state without overwriting it", async () => {
  await getStore().setValue(cronProjectionKey(), {
    schemaVersion: 1,
    revision: 1,
    private: "must-not-log",
  });
  const response = await POST(
    projectionRequest(`Bearer ${gatewayValue}`, input(1, [])),
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "CRON_PROJECTION_STATE_UNAVAILABLE",
  });
  assert.deepEqual(await getStore().getValue(cronProjectionKey()), {
    schemaVersion: 1,
    revision: 1,
    private: "must-not-log",
  });
});
