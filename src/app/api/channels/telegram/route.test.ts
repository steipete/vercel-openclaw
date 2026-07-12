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
        pendingWebhookCleanups: [
          { botToken: "new-token", botId: "200", requestedAt: 1 },
        ],
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

test("telegram publishes the new webhook secret before registering it remotely", async () => {
  await withHarness(async (h) => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");
    const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://openclaw.example";
    let publishedSecret: string | null = null;
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/botnew-token/getMe")) {
          return Response.json({
            ok: true,
            result: {
              id: 200,
              is_bot: true,
              first_name: "New",
              username: "new_bot",
            },
          });
        }
        if (url.endsWith("/botnew-token/setWebhook")) {
          const config = (await h.getMeta()).channels.telegram;
          assert.equal(config?.botToken, "new-token");
          assert.equal(config?.webhookSetupPending, true);
          publishedSecret = config?.webhookSecret ?? null;
          assert.ok(publishedSecret);
          return Response.json({ ok: true, result: true });
        }
        if (url.endsWith("/botnew-token/setMyCommands")) {
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
      assert.equal(config?.webhookSecret, publishedSecret);
      assert.equal(config?.webhookSetupPending, false);
      assert.equal(config?.lastError, undefined);
    } finally {
      fetchMock.mock.restore();
      if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    }
  });
});

test("telegram same-bot rotation preserves the queued delivery identity", async () => {
  await withHarness(async (h) => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");
    const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://openclaw.example";
    await h.mutateMeta((meta) => {
      meta.channels.telegram = {
        botToken: "old-token",
        botId: "200",
        deliveryNamespace: "bot:200",
        webhookSecret: "old-secret",
        webhookUrl: "https://openclaw.example/api/channels/telegram/webhook",
        botUsername: "same_bot",
        configuredAt: 1,
      };
    });
    let pendingSecret: string | null = null;
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/botrotated-token/getMe")) {
          return Response.json({
            ok: true,
            result: {
              id: 200,
              is_bot: true,
              first_name: "Same",
              username: "same_bot",
            },
          });
        }
        if (url.endsWith("/botrotated-token/setWebhook")) {
          const pending = (await h.getMeta()).channels.telegram;
          assert.equal(pending?.webhookSetupPending, true);
          assert.equal(pending?.botId, "200");
          assert.equal(pending?.deliveryNamespace, "bot:200");
          assert.equal(pending?.previousWebhookSecret, "old-secret");
          assert.equal(pending?.previousBotId, "200");
          assert.equal(pending?.previousDeliveryNamespace, "bot:200");
          assert.equal(pending?.previousConfiguredAt, 1);
          assert.equal(pending?.pendingWebhookCleanups, undefined);
          pendingSecret = pending?.webhookSecret ?? null;
          return Response.json({ ok: true, result: true });
        }
        if (url.endsWith("/botrotated-token/setMyCommands")) {
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
          JSON.stringify({ botToken: "rotated-token" }),
        ),
      );
      assert.equal(result.status, 200);
      const config = (await h.getMeta()).channels.telegram;
      assert.ok(pendingSecret);
      assert.equal(config?.webhookSecret, pendingSecret);
      assert.equal(config?.webhookSetupPending, false);
      assert.equal(config?.botId, "200");
      assert.equal(config?.deliveryNamespace, "bot:200");
      assert.equal(config?.previousWebhookSecret, "old-secret");
      assert.equal(config?.previousDeliveryNamespace, "bot:200");
    } finally {
      fetchMock.mock.restore();
      if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    }
  });
});

test("telegram does not activate a new webhook when running config sync fails", async () => {
  await withHarness(async (h) => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");
    const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://openclaw.example";
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "missing-running-sandbox";
      meta.channels.telegram = {
        botToken: "old-token",
        botId: "100",
        webhookSecret: "old-secret",
        webhookUrl: "https://openclaw.example/api/channels/telegram/webhook",
        botUsername: "old_bot",
        configuredAt: 1,
      };
    });
    await h.controller.get({
      sandboxId: "missing-running-sandbox",
      resume: false,
    });
    const handle = h.controller.getHandle("missing-running-sandbox");
    assert.ok(handle);
    let failNextWrite = true;
    handle.writeFilesHook = () => {
      if (!failNextWrite) return;
      failNextWrite = false;
      throw new Error("partial activation sync failure");
    };
    handle.responders.push((command, args) => {
      if (
        command === "bash" &&
        args?.join(" ").includes("grep -q 'openclaw-app'")
      ) {
        return { exitCode: 0, output: async () => "ok" };
      }
      if (
        command === "bash" &&
        args?.join(" ").includes("openclaw-config-sync-tg-probe")
      ) {
        return { exitCode: 0, output: async () => "401" };
      }
      return undefined;
    });
    let setWebhookCalls = 0;
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/botnew-token/getMe")) {
          return Response.json({
            ok: true,
            result: {
              id: 200,
              is_bot: true,
              first_name: "New",
              username: "new_bot",
            },
          });
        }
        if (url.endsWith("/botnew-token/setWebhook")) {
          setWebhookCalls += 1;
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
      assert.equal(result.status, 503);
      assert.equal(
        (result.json as { error: string }).error,
        "TELEGRAM_LIVE_CONFIG_SYNC_FAILED",
      );
      assert.equal(setWebhookCalls, 0);
      const config = (await h.getMeta()).channels.telegram;
      assert.equal(config?.botToken, "old-token");
      assert.equal(config?.webhookSecret, "old-secret");
      const latestConfig = [...handle.writtenFiles]
        .reverse()
        .find((file) => file.path.endsWith("/openclaw.json"));
      assert.ok(latestConfig);
      assert.equal(latestConfig.content.toString().includes("old-token"), true);
      assert.equal(latestConfig.content.toString().includes("new-token"), false);
    } finally {
      fetchMock.mock.restore();
      if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    }
  });
});

test("telegram fails closed when rollback config cannot resync", async () => {
  await withHarness(async (h) => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");
    const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://openclaw.example";
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "rollback-sync-failure-sandbox";
      meta.channels.telegram = {
        botToken: "old-token",
        botId: "100",
        webhookSecret: "old-secret",
        webhookUrl: "https://openclaw.example/api/channels/telegram/webhook",
        botUsername: "old_bot",
        configuredAt: 1,
      };
    });
    await h.controller.get({
      sandboxId: "rollback-sync-failure-sandbox",
      resume: false,
    });
    const handle = h.controller.getHandle("rollback-sync-failure-sandbox");
    assert.ok(handle);
    handle.writeFilesHook = () => {
      throw new Error("config writes unavailable");
    };
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/botnew-token/getMe")) {
          return Response.json({
            ok: true,
            result: {
              id: 200,
              is_bot: true,
              first_name: "New",
              username: "new_bot",
            },
          });
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
      assert.equal(result.status, 503);
      assert.equal(
        (result.json as { error: string }).error,
        "TELEGRAM_ROLLBACK_SYNC_FAILED",
      );
      const config = (await h.getMeta()).channels.telegram;
      assert.equal(config?.botToken, "old-token");
      assert.equal(config?.webhookSetupPending, true);
      assert.match(config?.lastError ?? "", /ingress is paused/i);
    } finally {
      fetchMock.mock.restore();
      if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    }
  });
});

test("telegram first setup retains a removal tombstone when rollback cannot resync", async () => {
  await withHarness(async (h) => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");
    const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://openclaw.example";
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "first-setup-rollback-failure-sandbox";
      meta.channels.telegram = null;
    });
    await h.controller.get({
      sandboxId: "first-setup-rollback-failure-sandbox",
      resume: false,
    });
    const handle = h.controller.getHandle(
      "first-setup-rollback-failure-sandbox",
    );
    assert.ok(handle);
    handle.writeFilesHook = () => {
      throw new Error("config writes unavailable");
    };
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/botnew-token/getMe")) {
          return Response.json({
            ok: true,
            result: {
              id: 200,
              is_bot: true,
              first_name: "New",
              username: "new_bot",
            },
          });
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
      assert.equal(result.status, 503);
      assert.equal(
        (result.json as { error: string }).error,
        "TELEGRAM_ROLLBACK_SYNC_FAILED",
      );
      const config = (await h.getMeta()).channels.telegram;
      assert.equal(config?.botToken, "new-token");
      assert.equal(config?.webhookSetupPending, true);
      assert.equal(config?.deletionPending, true);
      assert.match(config?.lastError ?? "", /credential removal is pending/i);
    } finally {
      fetchMock.mock.restore();
      if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    }
  });
});

test("telegram setup retry clears a prior removal tombstone", async () => {
  await withHarness(async (h) => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");
    const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://openclaw.example";
    await h.mutateMeta((meta) => {
      meta.channels.telegram = {
        botToken: "new-token",
        botId: "200",
        deliveryNamespace: "bot:200",
        webhookSecret: "pending-secret",
        webhookUrl: "https://openclaw.example/api/channels/telegram/webhook",
        botUsername: "new_bot",
        configuredAt: 2,
        webhookSetupPending: true,
        deletionPending: true,
        lastError: "credential removal is pending",
      };
    });
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/botnew-token/getMe")) {
          return Response.json({
            ok: true,
            result: { id: 200, is_bot: true, first_name: "New", username: "new_bot" },
          });
        }
        if (
          url.endsWith("/botnew-token/setWebhook")
          || url.endsWith("/botnew-token/setMyCommands")
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
      assert.equal(config?.webhookSetupPending, false);
      assert.equal(config?.deletionPending, undefined);
      assert.equal(config?.lastError, undefined);
    } finally {
      fetchMock.mock.restore();
      if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    }
  });
});

test("telegram bot replacement rolls back on a definite setup rejection", async () => {
  await withHarness(async (h) => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");
    const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://openclaw.example";
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "running-rollback-sandbox";
      meta.channels.telegram = {
        botToken: "old-token",
        botId: "100",
        webhookSecret: "old-secret",
        webhookUrl: "https://openclaw.example/api/channels/telegram/webhook",
        botUsername: "old_bot",
        configuredAt: 1,
      };
    });
    await h.controller.get({
      sandboxId: "running-rollback-sandbox",
      resume: false,
    });
    const handle = h.controller.getHandle("running-rollback-sandbox");
    assert.ok(handle);
    handle.responders.push((command, args) => {
      if (
        command === "bash" &&
        args?.join(" ").includes("grep -q 'openclaw-app'")
      ) {
        return { exitCode: 0, output: async () => "ok" };
      }
      if (
        command === "bash" &&
        args?.join(" ").includes("openclaw-config-sync-tg-probe")
      ) {
        return { exitCode: 0, output: async () => "401" };
      }
      return undefined;
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
            { ok: false, error_code: 400, description: "invalid webhook" },
            { status: 400 },
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
      const configWrites = handle.writtenFiles.filter((file) =>
        file.path.endsWith("/openclaw.json"),
      );
      assert.ok(configWrites.length >= 2);
      const latestConfig = configWrites.at(-1);
      assert.ok(latestConfig);
      assert.equal(latestConfig.content.toString().includes("old-token"), true);
      assert.equal(latestConfig.content.toString().includes("new-token"), false);
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

test("telegram preserves pending setup after an ambiguous provider failure", async () => {
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
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request) => {
        const url = String(input);
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
      const config = (await h.getMeta()).channels.telegram;
      assert.equal(config?.botToken, "new-token");
      assert.equal(config?.webhookSetupPending, true);
      assert.match(config?.lastError ?? "", /outcome is uncertain/i);
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
