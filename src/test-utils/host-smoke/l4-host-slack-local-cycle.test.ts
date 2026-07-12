/**
 * L4-host Slack local cycle smoke.
 *
 * Proves the problematic local wrapper sequence in one deterministic test:
 * running sandbox -> signed Slack message fast-paths to native handler ->
 * sandbox stops/snapshots -> signed Slack message starts wake workflow ->
 * workflow forwards the original Slack request to native handler after wake ->
 * another signed Slack message fast-paths after wake.
 *
 * Run: npm test src/test-utils/host-smoke/l4-host-slack-local-cycle.test.ts
 */

import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { slackWebhookWorkflowRuntime } from "@/app/api/channels/slack/webhook/route";
import {
  buildExistingBootHandle,
  processChannelStep,
  type ChannelWorkflowHandoff,
  type RetryingForwardResult,
} from "@/server/workflows/channels/drain-channel-step";
import { getServerLogs, _resetLogBuffer } from "@/server/log";
import { withHarness } from "@/test-utils/harness";
import { callRoute, getSlackWebhookRoute, resetAfterCallbacks } from "@/test-utils/route-caller";
import {
  buildSignedSlackRequest,
  buildSlackAppMentionPayload,
  signSlackPayload,
} from "@/test-utils/host-smoke/slack-events";
import {
  chatCompletionsResponse,
  gatewayReadyResponse,
  slackOkResponse,
  type CapturedRequest,
} from "@/test-utils/fake-fetch";

const SLACK_SIGNING_SECRET = "test-slack-signing-secret-l4-local-cycle";
const CHANNEL_ID = "C0L4LOCALCYCLE";

function requireSlackSignature(
  rawBody: string,
  headers: HeadersInit | undefined,
  message: string,
): { signature: string; timestamp: string } {
  const h = headers instanceof Headers ? headers : new Headers(headers ?? {});
  const timestamp = h.get("x-slack-request-timestamp");
  const signature = h.get("x-slack-signature");
  assert.ok(timestamp, `${message}: missing Slack timestamp`);
  assert.ok(signature, `${message}: missing Slack signature`);
  const expected = signSlackPayload(
    rawBody,
    SLACK_SIGNING_SECRET,
    Number(timestamp),
  ).signature;
  assert.equal(signature, expected, `${message}: Slack signature must verify over exact raw body`);
  return { signature, timestamp };
}

class TestRetryableError extends Error {
  retryAfter?: string;

  constructor(message: string, options?: { retryAfter?: string }) {
    super(message);
    this.name = "RetryableError";
    this.retryAfter = options?.retryAfter;
  }

  static is(err: unknown): err is TestRetryableError {
    return err instanceof TestRetryableError;
  }
}

class TestFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalError";
  }

  static is(err: unknown): err is TestFatalError {
    return err instanceof TestFatalError;
  }
}

function slackForwardRequests(urlPrefix: string | null, requests: CapturedRequest[]) {
  return requests.filter(
    (r) =>
      r.method.toUpperCase() === "POST"
      && (urlPrefix === null || r.url.startsWith(urlPrefix))
      && r.url.endsWith("/slack/events"),
  );
}

test("L4-host Slack local cycle: durable Workflow before and after wake", async () => {
  await withHarness(async (h) => {
    _resetLogBuffer();
    h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
    h.fakeFetch.onPost(/\/v1\/chat\/completions/, () =>
      chatCompletionsResponse("slack local cycle reply"),
    );
    h.fakeFetch.onPost(/slack\.com\/api\//, (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { ts?: string };
      return body.ts
        ? slackOkResponse()
        : Response.json({ ok: true, ts: "boot-local-cycle-ts" });
    });

    const route = getSlackWebhookRoute();
    await h.driveToRunning();
    await h.mutateMeta((meta) => {
      meta.channels.slack = {
        signingSecret: SLACK_SIGNING_SECRET,
        botToken: "xoxb-l4-local-cycle-bot-token",
        configuredAt: Date.now(),
      };
    });

    const runningMeta = await h.getMeta();
    const sandboxUrl = runningMeta.portUrls?.["3000"];
    assert.ok(sandboxUrl, "driveToRunning should expose the sandbox gateway URL");

    const nativeBodies: string[] = [];
    h.fakeFetch.onPost(/\/slack\/events$/, (_url, init) => {
      const rawBody = String(init?.body ?? "");
      requireSlackSignature(rawBody, init?.headers, "native Slack forward");
      nativeBodies.push(rawBody);
      return new Response("ok", { status: 200 });
    });

    const startMock = mock.method(slackWebhookWorkflowRuntime, "start", async () => {});
    try {
      const firstPayload = buildSlackAppMentionPayload({
        channelId: CHANNEL_ID,
        ts: "1780000000.000100",
        threadTs: "1780000000.000100",
        text: "<@U0E2ETESTBOT> first local-cycle message",
      });
      const firstResult = await callRoute(
        route.POST,
        buildSignedSlackRequest({
          signingSecret: SLACK_SIGNING_SECRET,
          payload: firstPayload,
        }),
      );
      assert.equal(firstResult.status, 200);
      assert.deepEqual(firstResult.json, { ok: true });
      assert.equal(startMock.mock.callCount(), 1, "running sandbox should use durable Workflow");
      assert.equal(slackForwardRequests(sandboxUrl, h.fakeFetch.requests()).length, 0);
      assert.equal(nativeBodies.length, 0);

      await h.stopToSnapshot();
      const stoppedMeta = await h.getMeta();
      assert.equal(stoppedMeta.status, "stopped");
      assert.ok(stoppedMeta.snapshotId, "stopToSnapshot should leave a restorable snapshot");

      const wakePayload = buildSlackAppMentionPayload({
        channelId: CHANNEL_ID,
        ts: "1780000000.000200",
        threadTs: "1780000000.000200",
        text: "<@U0E2ETESTBOT> wake local-cycle message",
      });
      const wakeTimestampSeconds = Math.floor(Date.now() / 1000) - 60;
      const wakeRawBody = `{
  "token": "verification-token-unused",
  "team_id": "T0E2ETEST",
  "api_app_id": "A0E2ETEST",
  "type": "event_callback",
  "event_id": "Ev1780000000000200",
  "event_time": 1780000000,
  "event": {
    "type": "app_mention",
    "user": "U0E2ETESTHUMAN",
    "text": "<@U0E2ETESTBOT> wake local-cycle message",
    "ts": "1780000000.000200",
    "channel": "${CHANNEL_ID}",
    "event_ts": "1780000000.000200",
    "team": "T0E2ETEST",
    "thread_ts": "1780000000.000200"
  },
  "authorizations": [
    {
      "enterprise_id": null,
      "team_id": "T0E2ETEST",
      "user_id": "U0E2ETESTBOT",
      "is_bot": true,
      "is_enterprise_install": false
    }
  ]
}`;
      const wakeRequest = buildSignedSlackRequest({
        signingSecret: SLACK_SIGNING_SECRET,
        payload: wakePayload,
        rawBody: wakeRawBody,
        timestampSeconds: wakeTimestampSeconds,
      });
      const wakeResult = await callRoute(route.POST, wakeRequest);
      assert.equal(wakeResult.status, 200);
      assert.deepEqual(wakeResult.json, { ok: true });
      assert.equal(startMock.mock.callCount(), 2, "stopped sandbox should start durable wake workflow");

      const startArgs = startMock.mock.calls[1]?.arguments?.[1] as unknown[] | undefined;
      assert.ok(Array.isArray(startArgs), "workflow start should receive args array");
      const envelope = startArgs[0] as {
        payload?: unknown;
        bootMessageId?: string | null;
        workflowHandoff?: ChannelWorkflowHandoff | null;
      };
      assert.deepEqual(envelope.payload, wakePayload);
      assert.equal(
        envelope.bootMessageId,
        null,
        "webhook route must defer placeholder ownership to durable workflow",
      );
      assert.deepEqual(envelope.workflowHandoff?.slackBootTarget, {
        channel: CHANNEL_ID,
        threadTs: "1780000000.000200",
      });
      assert.equal(
        h.fakeFetch
          .requests()
          .filter((request) => request.url.endsWith("/chat.postMessage"))
          .length,
        0,
        "route must not post a placeholder before workflow start is durable",
      );
      assert.equal(envelope.workflowHandoff?.slackRawBody, wakeRawBody);
      assert.equal(
        envelope.workflowHandoff?.slackForwardHeaders?.["x-slack-request-timestamp"],
        wakeRequest.headers.get("x-slack-request-timestamp"),
      );
      assert.ok(
        envelope.workflowHandoff?.slackForwardHeaders?.["x-slack-signature"],
        "workflow handoff must preserve the Slack signature header",
      );

      let workflowForwardBody: string | null = null;
      let workflowForwardHeaders: Record<string, string> | null | undefined;
      await processChannelStep(
        "slack",
        wakePayload,
        "test",
        "req-l4-slack-local-cycle-wake",
        envelope.bootMessageId ?? null,
        {
          workflowHandoff: envelope.workflowHandoff ?? null,
          dependencies: {
            isRetryable: () => false,
            createSlackAdapter: () => ({}) as never,
            createTelegramAdapter: () => ({}) as never,
            createDiscordAdapter: () => ({}) as never,
            runWithBootMessages: async () => {
              await h.driveToRunning();
              return {
                meta: await h.getMeta(),
                bootMessageSent: false,
                admissionReady: true,
              };
            },
            ensureSandboxReady: async () => h.getMeta(),
            syncGatewayConfigToSandbox: async () => ({
              outcome: "applied",
              reason: "config_written_and_restarted",
              liveConfigFresh: true,
              operatorMessage: null,
            }),
            getSandboxDomain: async () => (await h.getMeta()).portUrls?.["3000"] ?? sandboxUrl,
            forwardToNativeHandler: async () => ({
              ok: true,
              status: 200,
              durationMs: 0,
              bodyLength: 0,
              bodyHead: "",
              headers: null,
            }),
            forwardTelegramToNativeHandlerLocally: async () => ({
              ok: true,
              status: 200,
              durationMs: 0,
              bodyLength: 0,
              bodyHead: "",
              headers: null,
              error: null,
            }),
            forwardToNativeHandlerWithRetry: async (
              forwardChannel,
              _payload,
              _meta,
              _getSandboxDomain,
              _forwardTelegramLocally,
              _preferLocalTelegramForward,
              extraForwardHeaders,
              rawBody,
            ): Promise<RetryingForwardResult> => {
              assert.equal(forwardChannel, "slack");
              assert.equal(rawBody, wakeRawBody);
              requireSlackSignature(
                rawBody ?? "",
                extraForwardHeaders ?? undefined,
                "workflow Slack forward",
              );
              workflowForwardHeaders = extraForwardHeaders;
              workflowForwardBody = rawBody;
              return {
                ok: true,
                status: 200,
                attempts: 1,
                totalMs: 50,
                transport: "public",
                retries: [],
              };
            },
            waitForTelegramNativeHandler: async () => ({
              ready: true,
              attempts: 1,
              waitMs: 0,
              lastStatus: 401,
              publicUrl: sandboxUrl,
              timeline: [],
            }),
            probeTelegramNativeHandlerLocally: async () => ({
              status: 401,
              ready: true,
              error: null,
            }),
            buildExistingBootHandle,
            hydrateVerifiedBundleIdentity: async () => null,
            RetryableError: TestRetryableError as never,
            FatalError: TestFatalError as never,
            getStepMetadata: (() => ({
              stepName: "processChannelStep",
              stepId: "test-step-id",
              stepStartedAt: new Date(),
              attempt: 1,
            })) as never,
            getWorkflowMetadata: (() => ({
              workflowId: "test-workflow-id",
              workflowRunId: "test-run-id",
              workflowStartedAt: new Date(),
            })) as never,
          },
        },
      );
      assert.equal(workflowForwardBody, wakeRawBody);
      assert.ok(workflowForwardHeaders?.["x-slack-signature"]);
      assert.ok(workflowForwardHeaders?.["x-slack-request-timestamp"]);
      assert.equal(
        h.fakeFetch
          .requests()
          .filter((request) => request.url.endsWith("/chat.postMessage"))
          .length,
        1,
        "durable workflow should create exactly one placeholder",
      );
      assert.equal(
        h.fakeFetch
          .requests()
          .filter((request) => request.url.endsWith("/chat.delete"))
          .length,
        1,
        "accepted workflow delivery should clear its placeholder",
      );
      assert.notEqual(
        workflowForwardHeaders?.["x-slack-request-timestamp"],
        wakeRequest.headers.get("x-slack-request-timestamp"),
        "workflow forward should re-sign with a fresh Slack timestamp",
      );

      const postWakePayload = buildSlackAppMentionPayload({
        channelId: CHANNEL_ID,
        ts: "1780000000.000300",
        threadTs: "1780000000.000300",
        text: "<@U0E2ETESTBOT> post-wake local-cycle message",
      });
      const postWakeResult = await callRoute(
        route.POST,
        buildSignedSlackRequest({
          signingSecret: SLACK_SIGNING_SECRET,
          payload: postWakePayload,
        }),
      );
      assert.equal(postWakeResult.status, 200);
      assert.deepEqual(postWakeResult.json, { ok: true });
      assert.equal(startMock.mock.callCount(), 3, "post-wake Slack message should remain Workflow-owned");
      assert.equal(slackForwardRequests(null, h.fakeFetch.requests()).length, 0);
      assert.equal(nativeBodies.length, 0);

      const logs = getServerLogs().map((entry) => entry.message);
      assert.ok(!logs.includes("channels.slack_fast_path_ok"));
      assert.ok(logs.includes("channels.slack_workflow_started"));
      assert.ok(logs.includes("channels.slack_wake_summary"));
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});
