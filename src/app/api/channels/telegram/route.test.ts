import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";

import {
  buildChannelConnectability,
  buildChannelConnectBlockedResponse,
} from "@/server/channels/connectability";
import { _setAiGatewayTokenOverrideForTesting } from "@/server/env";
import { withHarness } from "@/test-utils/harness";
import {
  buildAuthDeleteRequest,
  buildAuthPutRequest,
  callRoute,
  getTelegramChannelRoute,
} from "@/test-utils/route-caller";

afterEach(() => {
  _setAiGatewayTokenOverrideForTesting(null);
});

test("telegram PUT returns 409 on localhost origin", async () => {
  _setAiGatewayTokenOverrideForTesting("oidc-token");
  const request = new Request("http://localhost:3000/api/channels/telegram", {
    method: "PUT",
    headers: {
      host: "localhost:3000",
      "x-forwarded-host": "localhost:3000",
      "x-forwarded-proto": "http",
    },
  });

  const connectability = await buildChannelConnectability("telegram", request);
  assert.equal(connectability.canConnect, false);
  assert.equal(connectability.channel, "telegram");
  assert.ok(connectability.issues.some((i) => i.status === "fail"));

  const response = buildChannelConnectBlockedResponse(
    { setCookieHeader: null },
    connectability,
  );

  assert.equal(response.status, 409);
});

test("telegram 409 response body matches expected shape", async () => {
  _setAiGatewayTokenOverrideForTesting("oidc-token");
  const request = new Request("http://localhost:3000/api/channels/telegram", {
    method: "PUT",
    headers: {
      host: "localhost:3000",
      "x-forwarded-host": "localhost:3000",
      "x-forwarded-proto": "http",
    },
  });

  const connectability = await buildChannelConnectability("telegram", request);
  const response = buildChannelConnectBlockedResponse(
    { setCookieHeader: null },
    connectability,
  );

  const payload = (await response.json()) as {
    error: { code: string; message: string };
    connectability: { channel: string; canConnect: boolean; issues: { id: string }[] };
  };

  assert.equal(payload.error.code, "CHANNEL_CONNECT_BLOCKED");
  assert.equal(payload.connectability.channel, "telegram");
  assert.equal(payload.connectability.canConnect, false);
  assert.ok(payload.connectability.issues.length > 0);
});

// ---------------------------------------------------------------------------
// Route-level regression: PUT through the route factory returns 409
// ---------------------------------------------------------------------------

test("telegram PUT through route factory returns 409 when not connectable", async () => {
  await withHarness(async () => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");

    const route = getTelegramChannelRoute();
    const request = buildAuthPutRequest(
      "/api/channels/telegram",
      JSON.stringify({ botToken: "123:abc" }),
    );

    const result = await callRoute(route.PUT!, request);

    assert.equal(result.status, 409);
    const body = result.json as {
      error: { code: string; message: string };
      connectability: { channel: string; canConnect: boolean };
    };
    assert.equal(body.error.code, "CHANNEL_CONNECT_BLOCKED");
    assert.equal(body.connectability.channel, "telegram");
    assert.equal(body.connectability.canConnect, false);
  });
});

test("telegram bot replacement keeps a durable cleanup obligation when old deletion fails", async () => {
  await withHarness(async (h) => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");
    const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://openclaw.example";
    await h.mutateMeta((meta) => {
      meta.channels.telegram = {
        botToken: "old-token",
        botId: "100",
        webhookSecret: "old-secret",
        webhookUrl: "https://openclaw.example/api/channels/telegram/webhook",
        botUsername: "old_bot",
        configuredAt: 1,
      };
    });
    const calls: string[] = [];
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/botnew-token/getMe")) {
        return Response.json({
          ok: true,
          result: { id: 200, is_bot: true, first_name: "New", username: "new_bot" },
        });
      }
      if (url.endsWith("/botold-token/deleteWebhook")) {
        return Response.json(
          { ok: false, error_code: 503, description: "cleanup unavailable" },
          { status: 503 },
        );
      }
      if (
        url.endsWith("/botnew-token/setWebhook") ||
        url.endsWith("/botnew-token/setMyCommands") ||
        url.endsWith("/botnew-token/deleteWebhook")
      ) {
        return Response.json({ ok: true, result: true });
      }
      throw new Error(`unexpected Telegram API call: ${url}`);
      },
    );
    try {
      const result = await callRoute(
        getTelegramChannelRoute().PUT!,
        buildAuthPutRequest(
          "/api/channels/telegram",
          JSON.stringify({ botToken: "new-token" }),
        ),
      );
      assert.equal(result.status, 200);
      const config = (await h.getMeta()).channels.telegram;
      assert.equal(config?.botToken, "new-token");
      assert.equal(config?.pendingWebhookCleanups?.[0]?.botToken, "old-token");
      assert.equal(
        calls.some((url) => url.endsWith("/botnew-token/setWebhook")),
        true,
      );
      assert.equal(
        calls.some((url) => url.endsWith("/botnew-token/deleteWebhook")),
        false,
      );
    } finally {
      fetchMock.mock.restore();
      if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    }
  });
});

test("telegram bot replacement keeps the old webhook when new setup fails", async () => {
  await withHarness(async (h) => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");
    const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://openclaw.example";
    await h.mutateMeta((meta) => {
      meta.channels.telegram = {
        botToken: "old-token",
        botId: "100",
        webhookSecret: "old-secret",
        webhookUrl: "https://openclaw.example/api/channels/telegram/webhook",
        botUsername: "old_bot",
        configuredAt: 1,
      };
    });
    const calls: string[] = [];
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/botnew-token/getMe")) {
          return Response.json({
            ok: true,
            result: { id: 200, is_bot: true, first_name: "New", username: "new_bot" },
          });
        }
        if (url.endsWith("/botnew-token/setWebhook")) {
          return Response.json(
            { ok: false, error_code: 503, description: "setup unavailable" },
            { status: 503 },
          );
        }
        throw new Error(`unexpected Telegram API call: ${url}`);
      },
    );
    try {
      const result = await callRoute(
        getTelegramChannelRoute().PUT!,
        buildAuthPutRequest(
          "/api/channels/telegram",
          JSON.stringify({ botToken: "new-token" }),
        ),
      );
      assert.equal(result.status, 500);
      assert.equal((await h.getMeta()).channels.telegram?.botToken, "old-token");
      assert.equal(
        calls.some((url) => url.endsWith("/botold-token/deleteWebhook")),
        false,
      );
    } finally {
      fetchMock.mock.restore();
      if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    }
  });
});

test("telegram DELETE retains durable retry state when webhook cleanup fails", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.channels.telegram = {
        botToken: "active-token",
        botId: "100",
        webhookSecret: "active-secret",
        webhookUrl: "https://openclaw.example/api/channels/telegram/webhook",
        botUsername: "active_bot",
        configuredAt: 1,
      };
    });
    const fetchMock = mock.method(globalThis, "fetch", async () =>
      Response.json(
        { ok: false, error_code: 503, description: "cleanup unavailable" },
        { status: 503 },
      ),
    );
    try {
      const result = await callRoute(
        getTelegramChannelRoute().DELETE!,
        buildAuthDeleteRequest("/api/channels/telegram", "{}"),
      );
      assert.equal(result.status, 500);
      const config = (await h.getMeta()).channels.telegram;
      assert.equal(config?.botToken, "active-token");
      assert.equal(config?.deletionPending, true);
      assert.equal(config?.lastError, "Telegram disconnect cleanup is pending.");
    } finally {
      fetchMock.mock.restore();
    }
  });
});
