/**
 * L4-host scenario 5: stale-running durable handoff.
 *
 * When meta says `status: running` + `sandboxId` is set but the sandbox is
 * actually dead (auto-stopped, snapshotted, or wedged), a Slack `app_mention`
 * must NOT be silently dropped. Production delivery hands off directly to the
 * durable Workflow and never performs an ambiguous route-level native POST.
 *
 * Two scenarios cover the two failure modes the route distinguishes:
 *
 *   - Definite route-unavailable fallback: forward returns a marked 502.
 *   - Pre-admission network fallback: forward rejects with ECONNREFUSED.
 *   - Empty platform 200 fallback: gateway probe lacks the OpenClaw marker,
 *     so the route must not forward to the sandbox catch-all.
 *
 * Every scenario must end with response 200, workflow.start exactly once,
 * and no route-level native forward.
 *
 * Catches: stale `running` metadata silently dropping events when the
 * sandbox has gone away under us.
 *
 * Run: npm test src/test-utils/host-smoke/l4-host-fast-path-stale.test.ts
 */

import assert from "node:assert/strict";
import { mock } from "node:test";
import test from "node:test";

import { withHarness, type ScenarioHarness } from "@/test-utils/harness";
import { callRoute, getSlackWebhookRoute, resetAfterCallbacks } from "@/test-utils/route-caller";
import { slackWebhookWorkflowRuntime } from "@/app/api/channels/slack/webhook/route";
import {
  buildSignedSlackRequest,
  buildSlackAppMentionPayload,
} from "@/test-utils/host-smoke/slack-events";
import { gatewayNotReadyResponse, gatewayReadyResponse, slackOkResponse } from "@/test-utils/fake-fetch";

const SLACK_SIGNING_SECRET = "test-slack-signing-secret-l4-stale";
const CHANNEL_ID = "C0L4STALE";
const SANDBOX_ID = "sbx-l4-stale-running";
const SANDBOX_URL_3000 = `https://${SANDBOX_ID}-3000.fake.vercel.run`;

async function configureRunningSandboxWithSlack(h: ScenarioHarness) {
  await h.mutateMeta((meta) => {
    meta.channels.slack = {
      signingSecret: SLACK_SIGNING_SECRET,
      botToken: "xoxb-l4-stale-bot-token",
      configuredAt: Date.now(),
    };
    meta.status = "running";
    meta.sandboxId = SANDBOX_ID;
    meta.portUrls = { "3000": SANDBOX_URL_3000 };
  });
}

function fastPathForwardAttempts(h: ScenarioHarness): number {
  return h.fakeFetch
    .requests()
    .filter(
      (r) =>
        r.method.toUpperCase() === "POST" &&
        r.url.startsWith(SANDBOX_URL_3000) &&
        r.url.endsWith("/slack/events"),
    ).length;
}

test("L4-host Workflow-only delivery ignores stale native 502 surface", async () => {
  await withHarness(async (h) => {
    await configureRunningSandboxWithSlack(h);

    h.fakeFetch.onGet(SANDBOX_URL_3000, () => gatewayReadyResponse());
    h.fakeFetch.onPost(/\/slack\/events$/, () =>
      new Response("sandbox is not listening", { status: 502 }),
    );
    // Boot message + any other Slack outbound during fallback.
    h.fakeFetch.onPost(/slack\.com\/api\//, () => slackOkResponse());

    const route = getSlackWebhookRoute();
    const startMock = mock.method(slackWebhookWorkflowRuntime, "start", async () => {});
    try {
      const req = buildSignedSlackRequest({
        signingSecret: SLACK_SIGNING_SECRET,
        payload: buildSlackAppMentionPayload({ channelId: CHANNEL_ID }),
      });
      const result = await callRoute(route.POST, req);

      assert.equal(result.status, 200);
      assert.equal(
        fastPathForwardAttempts(h),
        0,
        "production route must not attempt ambiguous native delivery",
      );
      assert.equal(
        startMock.mock.callCount(),
        1,
        "5xx fast-path must fall through to durable workflow",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("L4-host Workflow-only delivery ignores stale native network surface", async () => {
  await withHarness(async (h) => {
    await configureRunningSandboxWithSlack(h);

    h.fakeFetch.onGet(SANDBOX_URL_3000, () => gatewayReadyResponse());
    h.fakeFetch.onPost(/\/slack\/events$/, () => {
      throw Object.assign(
        new Error("ECONNREFUSED simulated for stale sandbox"),
        { code: "ECONNREFUSED" },
      );
    });
    h.fakeFetch.onPost(/slack\.com\/api\//, () => slackOkResponse());

    const route = getSlackWebhookRoute();
    const startMock = mock.method(slackWebhookWorkflowRuntime, "start", async () => {});
    try {
      const req = buildSignedSlackRequest({
        signingSecret: SLACK_SIGNING_SECRET,
        payload: buildSlackAppMentionPayload({ channelId: CHANNEL_ID }),
      });
      const result = await callRoute(route.POST, req);

      assert.equal(result.status, 200);
      assert.equal(
        fastPathForwardAttempts(h),
        0,
        "production route must not attempt ambiguous native delivery",
      );
      assert.equal(
        startMock.mock.callCount(),
        1,
        "definite pre-admission failure must fall through to durable workflow",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});


test("L4-host fast-path stale: empty platform 200 does not drop Slack event", async () => {
  await withHarness(async (h) => {
    await configureRunningSandboxWithSlack(h);

    h.fakeFetch.onGet(SANDBOX_URL_3000, () => gatewayNotReadyResponse());
    h.fakeFetch.onPost(/\/slack\/events$/, () =>
      new Response("", { status: 200 }),
    );
    h.fakeFetch.onPost(/slack\.com\/api\//, () => slackOkResponse());

    const route = getSlackWebhookRoute();
    const startMock = mock.method(slackWebhookWorkflowRuntime, "start", async () => {});
    try {
      const req = buildSignedSlackRequest({
        signingSecret: SLACK_SIGNING_SECRET,
        payload: buildSlackAppMentionPayload({ channelId: CHANNEL_ID }),
      });
      const result = await callRoute(route.POST, req);

      assert.equal(result.status, 200, "platform 200 must not be treated as native delivery");
      assert.equal(
        fastPathForwardAttempts(h),
        0,
        "route must skip native forward when gateway marker probe fails",
      );
      assert.equal(
        startMock.mock.callCount(),
        1,
        "gateway-marker failure must fall through to durable workflow",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});
