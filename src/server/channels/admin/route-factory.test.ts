import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { createChannelAdminRouteHandlers } from "@/server/channels/admin/route-factory";
import {
  LIVE_CONFIG_SYNC_OUTCOME_HEADER,
  LIVE_CONFIG_SYNC_MESSAGE_HEADER,
} from "@/shared/live-config-sync";
import { withHarness } from "@/test-utils/harness";
import { buildAuthPutRequest, buildAuthDeleteRequest, callRoute } from "@/test-utils/route-caller";
import { _setAiGatewayTokenOverrideForTesting } from "@/server/env";

const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

afterEach(() => {
  _setAiGatewayTokenOverrideForTesting(null);
  if (ORIGINAL_APP_URL === undefined) {
    delete process.env.NEXT_PUBLIC_APP_URL;
  } else {
    process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL;
  }
});

// ---------------------------------------------------------------------------
// Route-factory regression: blocked connectability returns 409 with zero
// channel-side effects. The PUT handler must return before spec.put() and
// before any post-mutation state reads/writes.
// ---------------------------------------------------------------------------

test("PUT handler returns 409 when connectability blocks — spec.put and spec.delete are never called", async () => {
  await withHarness(async () => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");
    // Ensure no public origin is configured so localhost fails the check
    delete process.env.NEXT_PUBLIC_APP_URL;

    let putCalls = 0;
    let deleteCalls = 0;
    let selectStateCalls = 0;

    const { PUT } = createChannelAdminRouteHandlers({
      channel: "slack",
      selectState: (s) => {
        selectStateCalls++;
        return s.slack;
      },
      async put() {
        putCalls++;
      },
      async delete() {
        deleteCalls++;
      },
    });

    // localhost origin → connectability returns canConnect:false → 409
    const request = buildAuthPutRequest(
      "/api/channels/slack",
      JSON.stringify({}),
    );

    const result = await callRoute(PUT, request);

    assert.equal(result.status, 409);
    const body = result.json as {
      error: { code: string };
      connectability: { channel: string; canConnect: boolean };
    };
    assert.equal(body.error.code, "CHANNEL_CONNECT_BLOCKED");
    assert.equal(body.connectability.channel, "slack");
    assert.equal(body.connectability.canConnect, false);

    // Zero side effects: no spec methods called after the connectability guard
    assert.equal(putCalls, 0, "spec.put must not be called when blocked");
    assert.equal(deleteCalls, 0, "spec.delete must not be called when blocked");
    assert.equal(selectStateCalls, 0, "selectState (post-mutation read) must not be called when blocked");
  });
});

// ---------------------------------------------------------------------------
// Route-factory regression: exceptions inside the try block are caught
// by authJsonError and returned as a structured JSON error envelope.
//
// The PUT handler's try block covers: buildChannelConnectability,
// getInitializedMeta, spec.put, and getPublicChannelState. Proving
// that a thrown error is caught proves that connectability exceptions
// (which execute in the same block) cannot escape the handler.
// ---------------------------------------------------------------------------

test("PUT handler wraps thrown errors in JSON error envelope (authJsonError)", async () => {
  await withHarness(async () => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";

    const { PUT } = createChannelAdminRouteHandlers({
      channel: "slack",
      selectState: (s) => s.slack,
      async put() {
        throw new Error("simulated failure inside try block");
      },
      async delete() {},
    });

    const request = buildAuthPutRequest(
      "/api/channels/slack",
      JSON.stringify({}),
      {
        host: "app.example.com",
        "x-forwarded-host": "app.example.com",
        "x-forwarded-proto": "https",
      },
    );

    const result = await callRoute(PUT, request);

    assert.equal(result.status, 500);
    const body = result.json as { error: string; message: string };
    assert.equal(body.error, "INTERNAL_ERROR");
    assert.equal(typeof body.message, "string");
  });
});

test("PUT handler wraps ApiError with correct status code", async () => {
  await withHarness(async () => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";

    const { ApiError } = await import("@/shared/http");

    const { PUT } = createChannelAdminRouteHandlers({
      channel: "slack",
      selectState: (s) => s.slack,
      async put() {
        throw new ApiError(400, "BAD_INPUT", "invalid field");
      },
      async delete() {},
    });

    const request = buildAuthPutRequest(
      "/api/channels/slack",
      JSON.stringify({}),
      {
        host: "app.example.com",
        "x-forwarded-host": "app.example.com",
        "x-forwarded-proto": "https",
      },
    );

    const result = await callRoute(PUT, request);

    assert.equal(result.status, 400);
    const body = result.json as { error: string; message: string };
    assert.equal(body.error, "BAD_INPUT");
    assert.equal(body.message, "invalid field");
  });
});

// ---------------------------------------------------------------------------
// WhatsApp now follows the same webhook-proxied connectability contract as
// Slack and Telegram, so localhost requests are blocked before spec.put().
// ---------------------------------------------------------------------------

test("PUT handler for webhook-proxied channel (whatsapp) returns 409 on localhost", async () => {
  await withHarness(async () => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");
    delete process.env.NEXT_PUBLIC_APP_URL;

    let putCalled = false;

    const { PUT } = createChannelAdminRouteHandlers({
      channel: "whatsapp",
      selectState: (s) => s.whatsapp,
      async put() {
        putCalled = true;
      },
      async delete() {},
    });

    const request = buildAuthPutRequest(
      "/api/channels/whatsapp",
      JSON.stringify({ enabled: true }),
    );

    const result = await callRoute(PUT, request);

    assert.equal(result.status, 409, "whatsapp PUT must be blocked without a public origin");
    assert.equal(putCalled, false, "spec.put must not be called when connectability blocks");
  });
});

// ---------------------------------------------------------------------------
// Route factory: DELETE calls syncGatewayConfigToSandbox after spec.delete
// ---------------------------------------------------------------------------

test("DELETE handler calls spec.delete and returns updated state", async () => {
  await withHarness(async () => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");

    let deleteCalled = false;

    const { DELETE } = createChannelAdminRouteHandlers({
      channel: "whatsapp",
      selectState: (s) => s.whatsapp,
      async put() {},
      async delete() {
        deleteCalled = true;
      },
    });

    const request = buildAuthDeleteRequest(
      "/api/channels/whatsapp",
      "{}",
    );

    const result = await callRoute(DELETE, request);

    assert.equal(result.status, 200);
    assert.equal(deleteCalled, true, "spec.delete must be called");
    const body = result.json as { configured: boolean; mode: string };
    assert.equal(body.mode, "unsupported");
  });
});

// ---------------------------------------------------------------------------
// Live config sync headers: PUT and DELETE attach x-openclaw-live-config-sync-*
// ---------------------------------------------------------------------------

test("PUT handler attaches skipped live-config-sync header and body when sandbox not running", async () => {
  await withHarness(async () => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";

    const { PUT } = createChannelAdminRouteHandlers({
      channel: "slack",
      selectState: (s) => s.slack,
      async put() {},
      async delete() {},
    });

    const request = buildAuthPutRequest(
      "/api/channels/slack",
      JSON.stringify({}),
      {
        host: "app.example.com",
        "x-forwarded-host": "app.example.com",
        "x-forwarded-proto": "https",
      },
    );

    const result = await callRoute(PUT, request);

    assert.equal(result.status, 200);
    assert.equal(
      result.response.headers.get(LIVE_CONFIG_SYNC_OUTCOME_HEADER),
      "skipped",
      "outcome header must be skipped when sandbox is not running",
    );
    assert.equal(
      result.response.headers.get(LIVE_CONFIG_SYNC_MESSAGE_HEADER),
      null,
      "no message header for skipped outcome",
    );

    // Verify liveConfigSync is in the response body
    const body = result.json as { liveConfigSync: { outcome: string; reason: string; liveConfigFresh: boolean; operatorMessage: string | null } };
    assert.ok(body.liveConfigSync, "response body must include liveConfigSync");
    assert.equal(body.liveConfigSync.outcome, "skipped");
    assert.equal(body.liveConfigSync.reason, "sandbox_not_running");
    assert.equal(body.liveConfigSync.liveConfigFresh, false);
    assert.equal(body.liveConfigSync.operatorMessage, null);
  });
});

test("PUT handler persists Slack live config sync state for summary readiness", async () => {
  await withHarness(async (h) => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";

    const { PUT } = createChannelAdminRouteHandlers({
      channel: "slack",
      selectState: (s) => s.slack,
      async put() {
        await h.mutateMeta((meta) => {
          meta.channels.slack = {
            signingSecret: "test-signing-secret",
            botToken: "xoxb-test",
            configuredAt: Date.now(),
          };
        });
      },
      async delete() {},
    });

    const request = buildAuthPutRequest(
      "/api/channels/slack",
      JSON.stringify({}),
      {
        host: "app.example.com",
        "x-forwarded-host": "app.example.com",
        "x-forwarded-proto": "https",
      },
    );

    const result = await callRoute(PUT, request);

    assert.equal(result.status, 200);
    const meta = await h.getMeta();
    assert.equal(meta.channels.slack?.liveConfigSync?.outcome, "skipped");
    assert.equal(meta.channels.slack?.liveConfigSync?.reason, "sandbox_not_running");
    assert.equal(meta.channels.slack?.liveConfigSync?.liveConfigFresh, false);
    assert.equal(typeof meta.channels.slack?.liveConfigSync?.checkedAt, "number");
  });
});

test("DELETE handler attaches skipped live-config-sync header and body when sandbox not running", async () => {
  await withHarness(async () => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");

    const { DELETE } = createChannelAdminRouteHandlers({
      channel: "whatsapp",
      selectState: (s) => s.whatsapp,
      async put() {},
      async delete() {},
    });

    const request = buildAuthDeleteRequest(
      "/api/channels/whatsapp",
      "{}",
    );

    const result = await callRoute(DELETE, request);

    assert.equal(result.status, 200);
    assert.equal(
      result.response.headers.get(LIVE_CONFIG_SYNC_OUTCOME_HEADER),
      "skipped",
      "outcome header must be skipped when sandbox is not running",
    );

    // Verify liveConfigSync is in the response body
    const body = result.json as { liveConfigSync: { outcome: string; liveConfigFresh: boolean } };
    assert.ok(body.liveConfigSync, "response body must include liveConfigSync");
    assert.equal(body.liveConfigSync.outcome, "skipped");
    assert.equal(body.liveConfigSync.liveConfigFresh, false);
  });
});
