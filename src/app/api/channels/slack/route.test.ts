import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  buildChannelConnectability,
  buildChannelConnectBlockedResponse,
} from "@/server/channels/connectability";
import { _setAiGatewayTokenOverrideForTesting } from "@/server/env";
import {
  getSlackAppConfig,
  setSlackAppConfig,
} from "@/server/channels/slack/app-config";
import { setSlackChannelConfig } from "@/server/channels/state";
import { getInitializedMeta } from "@/server/store/store";
import { withHarness } from "@/test-utils/harness";
import {
  buildAuthPutRequest,
  buildAuthDeleteRequest,
  callRoute,
  getSlackChannelRoute,
} from "@/test-utils/route-caller";

afterEach(() => {
  _setAiGatewayTokenOverrideForTesting(null);
});

test("slack PUT returns 409 on localhost origin", async () => {
  _setAiGatewayTokenOverrideForTesting("oidc-token");
  const request = new Request("http://localhost:3000/api/channels/slack", {
    method: "PUT",
    headers: {
      host: "localhost:3000",
      "x-forwarded-host": "localhost:3000",
      "x-forwarded-proto": "http",
    },
  });

  const connectability = await buildChannelConnectability("slack", request);
  assert.equal(connectability.canConnect, false);
  assert.equal(connectability.channel, "slack");
  assert.ok(connectability.issues.some((i) => i.status === "fail"));

  const response = buildChannelConnectBlockedResponse(
    { setCookieHeader: null },
    connectability,
  );

  assert.equal(response.status, 409);
});

test("slack 409 response body matches expected shape", async () => {
  _setAiGatewayTokenOverrideForTesting("oidc-token");
  const request = new Request("http://localhost:3000/api/channels/slack", {
    method: "PUT",
    headers: {
      host: "localhost:3000",
      "x-forwarded-host": "localhost:3000",
      "x-forwarded-proto": "http",
    },
  });

  const connectability = await buildChannelConnectability("slack", request);
  const response = buildChannelConnectBlockedResponse(
    { setCookieHeader: null },
    connectability,
  );

  const payload = (await response.json()) as {
    error: { code: string; message: string };
    connectability: { channel: string; canConnect: boolean; issues: { id: string }[] };
  };

  assert.equal(payload.error.code, "CHANNEL_CONNECT_BLOCKED");
  assert.equal(payload.connectability.channel, "slack");
  assert.equal(payload.connectability.canConnect, false);
  assert.ok(payload.connectability.issues.length > 0);
});

// ---------------------------------------------------------------------------
// Route-level regression: PUT through the route factory returns 409
// ---------------------------------------------------------------------------

test("slack PUT through route factory returns 409 when not connectable", async () => {
  await withHarness(async () => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");

    const route = getSlackChannelRoute();
    const request = buildAuthPutRequest(
      "/api/channels/slack",
      JSON.stringify({ signingSecret: "s", botToken: "t" }),
    );

    const result = await callRoute(route.PUT!, request);

    assert.equal(result.status, 409);
    const body = result.json as {
      error: { code: string; message: string };
      connectability: { channel: string; canConnect: boolean };
    };
    assert.equal(body.error.code, "CHANNEL_CONNECT_BLOCKED");
    assert.equal(body.connectability.channel, "slack");
    assert.equal(body.connectability.canConnect, false);
  });
});

test("slack DELETE removes app credentials after disconnect applies", async () => {
  await withHarness(async () => {
    await setSlackChannelConfig({
      signingSecret: "signing-secret",
      botToken: "xoxb-connected",
      configuredAt: 1,
    });
    await setSlackAppConfig({
      appId: "A123",
      clientId: "client-id",
      clientSecret: "client-secret",
      signingSecret: "app-signing-secret",
      configToken: "config-token",
      refreshToken: "refresh-token",
      createdAt: 1,
    });

    const route = getSlackChannelRoute();
    const result = await callRoute(
      route.DELETE!,
      buildAuthDeleteRequest("/api/channels/slack", "{}"),
    );

    assert.equal(result.status, 200);
    assert.equal((await getInitializedMeta()).channels.slack, null);
    assert.equal(await getSlackAppConfig(), null);
  });
});
