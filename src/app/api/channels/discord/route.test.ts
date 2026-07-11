import assert from "node:assert/strict";
import test, { mock } from "node:test";

import {
  _resetStoreForTesting,
  getInitializedMeta,
  mutateMeta,
} from "@/server/store/store";
import {
  buildAuthDeleteRequest,
  buildAuthPostRequest,
  buildAuthPutRequest,
  callRoute,
  getDiscordChannelRoute,
  getDiscordRegisterCommandRoute,
  patchNextServerAfter,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";

patchNextServerAfter();

async function withTestEnv(fn: () => Promise<void>): Promise<void> {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAdminSecret = process.env.ADMIN_SECRET;
  const originalSessionSecret = process.env.SESSION_SECRET;
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  (process.env as Record<string, string>).NODE_ENV = "test";
  process.env.ADMIN_SECRET = "test-admin-secret-for-scenarios";
  process.env.SESSION_SECRET = "test-session-secret-for-discord-route";
  process.env.NEXT_PUBLIC_APP_URL = "https://openclaw.example";
  _resetStoreForTesting();
  try {
    await fn();
  } finally {
    const mutableEnv = process.env as Record<string, string | undefined>;
    if (originalNodeEnv === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = originalNodeEnv;
    if (originalAdminSecret === undefined) delete process.env.ADMIN_SECRET;
    else process.env.ADMIN_SECRET = originalAdminSecret;
    if (originalSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSessionSecret;
    if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    _resetStoreForTesting();
    resetAfterCallbacks();
  }
}

test("PUT /api/channels/discord is fail-closed before external mutation", async () => {
  await withTestEnv(async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      throw new Error("Discord API must not be called");
    });
    try {
      const response = await callRoute(
        getDiscordChannelRoute().PUT!,
        buildAuthPutRequest(
          "/api/channels/discord",
          JSON.stringify({ botToken: "legacy-token" }),
        ),
      );
      assert.equal(response.status, 409);
      assert.equal(
        (response.json as { error: { code: string } }).error.code,
        "CHANNEL_CONNECT_BLOCKED",
      );
      assert.equal(fetchMock.mock.callCount(), 0);
      assert.equal((await getInitializedMeta()).channels.discord, null);
    } finally {
      fetchMock.mock.restore();
    }
  });
});

test("POST /api/channels/discord/register-command is unavailable", async () => {
  await withTestEnv(async () => {
    const response = await callRoute(
      getDiscordRegisterCommandRoute().POST!,
      buildAuthPostRequest("/api/channels/discord/register-command", "{}"),
    );
    assert.equal(response.status, 409);
    assert.equal(
      (response.json as { error: string }).error,
      "HOSTED_DISCORD_TRANSPORT_UNAVAILABLE",
    );
  });
});

test("DELETE /api/channels/discord removes legacy config even if remote cleanup fails", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.channels.discord = {
        applicationId: "legacy-app",
        publicKey: "legacy-key",
        botToken: "legacy-token",
        configuredAt: Date.now(),
      };
    });
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      throw new Error("remote unavailable");
    });
    try {
      const response = await callRoute(
        getDiscordChannelRoute().DELETE!,
        buildAuthDeleteRequest("/api/channels/discord", "{}"),
      );
      assert.equal(response.status, 200);
      assert.equal((await getInitializedMeta()).channels.discord, null);
    } finally {
      fetchMock.mock.restore();
    }
  });
});
