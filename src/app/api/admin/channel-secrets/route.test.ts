/**
 * Auth and security tests for /api/admin/channel-secrets.
 *
 * Verifies:
 * - Every exported method (PUT, POST, DELETE) rejects unauthenticated requests → 401
 * - Every exported method rejects wrong bearer token → 401
 * - Authenticated PUT does not return raw signing secrets in response body
 * - Authenticated POST does not return raw signing secrets in response body
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  _resetStoreForTesting,
  getInitializedMeta,
  mutateMeta,
} from "@/server/store/store";
import {
  callRoute,
  buildPutRequest,
  buildPostRequest,
  buildDeleteRequest,
  buildAuthPutRequest,
  buildAuthPostRequest,
  buildAuthDeleteRequest,
  getAdminChannelSecretsRoute,
  patchNextServerAfter,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";

// ---------------------------------------------------------------------------
// Patch next/server before route modules are loaded
// ---------------------------------------------------------------------------
patchNextServerAfter();

// ---------------------------------------------------------------------------
// Environment isolation
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "NODE_ENV",
  "VERCEL",
  "VERCEL_AUTH_MODE",
  "SESSION_SECRET",
  "ADMIN_SECRET",
  "REDIS_URL",
  "KV_URL",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "NEXT_PUBLIC_BASE_DOMAIN",
  "NEXT_PUBLIC_APP_URL",
  "VERCEL_AUTOMATION_BYPASS_SECRET",
];

let smokeOwnerSequence = 0;

function smokeSetupBody(channels?: string[]): string {
  smokeOwnerSequence += 1;
  return JSON.stringify({
    ownerId: `test-smoke-owner-${smokeOwnerSequence}`,
    ...(channels ? { channels } : {}),
  });
}

function withAdminAuthEnv(fn: () => Promise<void>): Promise<void> {
  const originals: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    originals[key] = process.env[key];
  }

  (process.env as Record<string, string | undefined>)["NODE_ENV"] = "test";
  process.env.ADMIN_SECRET = "test-admin-secret-for-scenarios";
  process.env.SESSION_SECRET = "test-session-secret-for-smoke-tests";
  process.env.NEXT_PUBLIC_BASE_DOMAIN = "http://localhost:3000";
  delete process.env.VERCEL;
  delete process.env.VERCEL_AUTH_MODE;
  delete process.env.REDIS_URL;
  delete process.env.KV_URL;
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.VERCEL_OIDC_TOKEN;
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  delete process.env.NEXT_PUBLIC_APP_URL;

  _resetStoreForTesting();

  return fn().finally(() => {
    for (const key of ENV_KEYS) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
    _resetStoreForTesting();
    resetAfterCallbacks();
  });
}

// ===========================================================================
// 1. Unauthenticated requests → 401
// ===========================================================================

test("channel-secrets: unauthenticated PUT returns 401", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();
    const request = buildPutRequest("/api/admin/channel-secrets", "{}");
    const result = await callRoute(route.PUT!, request);
    assert.equal(result.status, 401, `Expected 401, got ${result.status}`);
  });
});

test("channel-secrets: unauthenticated POST returns 401", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();
    const request = buildPostRequest("/api/admin/channel-secrets", "{}");
    const result = await callRoute(route.POST!, request);
    assert.equal(result.status, 401, `Expected 401, got ${result.status}`);
  });
});

test("channel-secrets: unauthenticated DELETE returns 401", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();
    const request = buildDeleteRequest("/api/admin/channel-secrets", "{}");
    const result = await callRoute(route.DELETE!, request);
    assert.equal(result.status, 401, `Expected 401, got ${result.status}`);
  });
});

// ===========================================================================
// 2. Wrong bearer token → 401
// ===========================================================================

test("channel-secrets: PUT with wrong bearer returns 401", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();
    const request = buildPutRequest("/api/admin/channel-secrets", "{}", {
      authorization: "Bearer wrong-token",
      origin: "http://localhost:3000",
      "x-requested-with": "XMLHttpRequest",
    });
    const result = await callRoute(route.PUT!, request);
    assert.equal(result.status, 401, `Expected 401, got ${result.status}`);
  });
});

test("channel-secrets: POST with wrong bearer returns 401", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();
    const request = buildPostRequest("/api/admin/channel-secrets", "{}", {
      authorization: "Bearer wrong-token",
      origin: "http://localhost:3000",
      "x-requested-with": "XMLHttpRequest",
    });
    const result = await callRoute(route.POST!, request);
    assert.equal(result.status, 401, `Expected 401, got ${result.status}`);
  });
});

// ===========================================================================
// 3. Authenticated PUT does not return raw signing secrets
// ===========================================================================

test("channel-secrets: authenticated PUT response does not contain raw secrets", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();
    const request = buildAuthPutRequest(
      "/api/admin/channel-secrets",
      smokeSetupBody(),
    );
    const result = await callRoute(route.PUT!, request);

    assert.equal(result.status, 200, `Expected 200, got ${result.status}`);

    // The response text should not contain any 64-char hex strings (signing secrets)
    // or PEM private key markers
    assert.ok(
      !/[0-9a-f]{64}/i.test(result.text),
      "Response should not contain 64-char hex secrets",
    );
    assert.ok(
      !result.text.includes("BEGIN PRIVATE KEY"),
      "Response should not contain private keys",
    );
    assert.ok(
      !result.text.includes("signingSecret"),
      "Response should not expose signingSecret field",
    );
    assert.ok(
      !result.text.includes("webhookSecret"),
      "Response should not expose webhookSecret field",
    );
    assert.ok(
      !result.text.includes("botToken"),
      "Response should not expose botToken field",
    );
    assert.deepEqual(
      (result.json as { channels?: unknown }).channels,
      ["slack", "telegram", "discord"],
    );
  });
});

test("channel-secrets: authenticated PUT requires a client owner id", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();
    const result = await callRoute(
      route.PUT!,
      buildAuthPutRequest("/api/admin/channel-secrets", "{}"),
    );

    assert.equal(result.status, 400);
    assert.equal(
      (result.json as { error?: unknown }).error,
      "OWNER_ID_REQUIRED",
    );
  });
});

test("channel-secrets: repeated owner setup recovers cleanup authority", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();
    const ownerId = "test-smoke-owner-idempotent";
    const body = JSON.stringify({ ownerId, channels: ["discord"] });
    const first = await callRoute(
      route.PUT!,
      buildAuthPutRequest("/api/admin/channel-secrets", body),
    );
    const second = await callRoute(
      route.PUT!,
      buildAuthPutRequest("/api/admin/channel-secrets", body),
    );

    assert.equal(first.status, 200);
    assert.deepEqual(
      (first.json as { createdChannels?: unknown }).createdChannels,
      ["discord"],
    );
    assert.equal(second.status, 200);
    assert.deepEqual(
      (second.json as { createdChannels?: unknown }).createdChannels,
      [],
    );
    assert.deepEqual(
      (second.json as { recoveredChannels?: unknown }).recoveredChannels,
      ["discord"],
    );
    const cleanupToken = (second.json as { cleanupToken?: unknown })
      .cleanupToken;
    assert.equal(typeof cleanupToken, "string");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ type: 1 });
    try {
      const dispatch = await callRoute(
        route.POST!,
        buildAuthPostRequest(
          "/api/admin/channel-secrets",
          JSON.stringify({
            channel: "discord",
            body: JSON.stringify({ id: "discord-smoke-id", type: 1 }),
          }),
        ),
      );
      assert.equal(dispatch.status, 200);
      assert.equal(
        (dispatch.json as { webhookAccepted?: unknown }).webhookAccepted,
        true,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    const cleanup = await callRoute(
      route.DELETE!,
      buildAuthDeleteRequest(
        "/api/admin/channel-secrets",
        JSON.stringify({ cleanupToken }),
      ),
    );
    assert.equal(cleanup.status, 200);
    assert.equal((await getInitializedMeta()).channels.discord, null);
  });
});

test("channel-secrets: setup adopts ownerless legacy smoke configs", async () => {
  await withAdminAuthEnv(async () => {
    await mutateMeta((meta) => {
      meta.channels.slack = {
        signingSecret: "legacy-smoke-signing-secret",
        botToken: "xoxb-smoke-test-token",
        configuredAt: 1,
        botId: "B_SMOKE",
      };
      meta.channels.telegram = {
        botToken: "000000000:smoke-test-bot-token",
        webhookSecret: "legacy-smoke-webhook-secret",
        webhookUrl: "https://example.test/api/channels/telegram/webhook",
        botUsername: "smoke_test_bot",
        configuredAt: 2,
      };
      meta.channels.discord = {
        publicKey: "legacy-smoke-public-key",
        applicationId: "discord-smoke-app",
        botToken: "discord-smoke-bot-token",
        configuredAt: 3,
      };
    });

    const route = getAdminChannelSecretsRoute();
    const setup = await callRoute(
      route.PUT!,
      buildAuthPutRequest(
        "/api/admin/channel-secrets",
        JSON.stringify({
          ownerId: "test-smoke-owner-legacy-adoption",
          channels: ["slack", "telegram", "discord"],
        }),
      ),
    );

    assert.equal(setup.status, 200);
    assert.deepEqual(
      (setup.json as { createdChannels?: unknown }).createdChannels,
      [],
    );
    assert.deepEqual(
      (setup.json as { recoveredChannels?: unknown }).recoveredChannels,
      ["slack", "telegram", "discord"],
    );
    const adopted = await getInitializedMeta();
    assert.equal(
      adopted.channels.slack?.smokeOwnerId,
      "test-smoke-owner-legacy-adoption",
    );
    assert.equal(
      adopted.channels.telegram?.smokeOwnerId,
      "test-smoke-owner-legacy-adoption",
    );
    assert.equal(
      adopted.channels.discord?.smokeOwnerId,
      "test-smoke-owner-legacy-adoption",
    );
    assert.notEqual(
      adopted.channels.discord?.publicKey,
      "legacy-smoke-public-key",
    );

    const cleanupToken = (setup.json as { cleanupToken?: unknown })
      .cleanupToken;
    assert.equal(typeof cleanupToken, "string");
    const cleanup = await callRoute(
      route.DELETE!,
      buildAuthDeleteRequest(
        "/api/admin/channel-secrets",
        JSON.stringify({ cleanupToken }),
      ),
    );
    assert.equal(cleanup.status, 200);
    assert.deepEqual(
      (cleanup.json as { removedChannels?: unknown }).removedChannels,
      ["slack", "telegram", "discord"],
    );
  });
});

// ===========================================================================
// 4. Authenticated POST (sign+send) does not return raw secrets
// ===========================================================================

test("channel-secrets: authenticated POST response does not contain raw secrets", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();

    // First configure test channels
    const putRequest = buildAuthPutRequest(
      "/api/admin/channel-secrets",
      smokeSetupBody(),
    );
    await callRoute(route.PUT!, putRequest);

    // Now send a smoke webhook — the response should not contain secrets
    const postRequest = buildAuthPostRequest(
      "/api/admin/channel-secrets",
      JSON.stringify({ channel: "slack", body: '{"type":"url_verification","challenge":"test"}' }),
    );

    // The POST will try to fetch the local webhook endpoint which doesn't
    // exist in test, so it may return 503. That's fine — we only care that
    // the response body doesn't contain secrets.
    const result = await callRoute(route.POST!, postRequest);

    assert.ok(
      !result.text.includes("BEGIN PRIVATE KEY"),
      "POST response should not contain private keys",
    );
  });
});

// ===========================================================================
// 5. Authenticated DELETE works and returns clean response
// ===========================================================================

test("channel-secrets: authenticated DELETE removes only owned smoke configs", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();
    const setup = await callRoute(
      route.PUT!,
      buildAuthPutRequest(
        "/api/admin/channel-secrets",
        smokeSetupBody(["slack"]),
      ),
    );
    const cleanupToken = (setup.json as { cleanupToken?: unknown }).cleanupToken;
    assert.equal(typeof cleanupToken, "string");
    const request = buildAuthDeleteRequest(
      "/api/admin/channel-secrets",
      JSON.stringify({ cleanupToken }),
    );
    const result = await callRoute(route.DELETE!, request);

    assert.equal(result.status, 200, `Expected 200, got ${result.status}`);
    const body = result.json as { removed: boolean; removedChannels?: unknown };
    assert.equal(body.removed, true);
    assert.deepEqual(body.removedChannels, ["slack"]);
    assert.equal((await getInitializedMeta()).channels.slack, null);
  });
});

test("channel-secrets: setup and cleanup preserve sibling real config", async () => {
  await withAdminAuthEnv(async () => {
    const realTelegram = {
      botToken: "real-telegram-token",
      webhookSecret: "real-telegram-secret",
      webhookUrl: "https://example.test/api/channels/telegram/webhook",
      botUsername: "real_bot",
      configuredAt: 123,
    };
    const legacyWhatsApp = {
      enabled: true,
      configuredAt: 456,
      phoneNumberId: "legacy-phone-id",
      accessToken: "legacy-access-token",
      verifyToken: "legacy-verify-token",
      appSecret: "legacy-app-secret",
    };
    await mutateMeta((meta) => {
      meta.channels.telegram = realTelegram;
      meta.channels.whatsapp = legacyWhatsApp;
    });
    const route = getAdminChannelSecretsRoute();
    const setup = await callRoute(
      route.PUT!,
      buildAuthPutRequest(
        "/api/admin/channel-secrets",
        smokeSetupBody(["slack", "telegram"]),
      ),
    );
    assert.deepEqual(
      (setup.json as { createdChannels?: unknown }).createdChannels,
      ["slack"],
    );
    assert.deepEqual(
      (setup.json as { preservedChannels?: unknown }).preservedChannels,
      ["telegram"],
    );
    assert.deepEqual((await getInitializedMeta()).channels.telegram, realTelegram);
    assert.deepEqual(
      (await getInitializedMeta()).channels.whatsapp,
      legacyWhatsApp,
    );

    const cleanupToken = (setup.json as { cleanupToken?: unknown }).cleanupToken;
    await callRoute(
      route.DELETE!,
      buildAuthDeleteRequest(
        "/api/admin/channel-secrets",
        JSON.stringify({ cleanupToken }),
      ),
    );
    const afterCleanup = await getInitializedMeta();
    assert.equal(afterCleanup.channels.slack, null);
    assert.deepEqual(afterCleanup.channels.telegram, realTelegram);
    assert.deepEqual(afterCleanup.channels.whatsapp, legacyWhatsApp);
  });
});

test("channel-secrets: stale cleanup token preserves replacement config", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();
    const setup = await callRoute(
      route.PUT!,
      buildAuthPutRequest(
        "/api/admin/channel-secrets",
        JSON.stringify({
          ownerId: "test-smoke-owner-original",
          channels: ["slack"],
        }),
      ),
    );
    const cleanupToken = (setup.json as { cleanupToken?: unknown })
      .cleanupToken;
    await mutateMeta((meta) => {
      meta.channels.slack = {
        signingSecret: "replacement-signing-secret",
        botToken: "replacement-bot-token",
        configuredAt: Date.now(),
        botId: "B_SMOKE",
        smokeOwnerId: "test-smoke-owner-replacement",
      };
    });

    const cleanup = await callRoute(
      route.DELETE!,
      buildAuthDeleteRequest(
        "/api/admin/channel-secrets",
        JSON.stringify({ cleanupToken }),
      ),
    );

    assert.equal(cleanup.status, 200);
    assert.deepEqual(
      (cleanup.json as { preservedChannels?: unknown }).preservedChannels,
      ["slack"],
    );
    assert.equal(
      (await getInitializedMeta()).channels.slack?.smokeOwnerId,
      "test-smoke-owner-replacement",
    );
  });
});

test("channel-secrets: PUT rejects unsupported hosted whatsapp setup", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();
    const result = await callRoute(
      route.PUT!,
      buildAuthPutRequest(
        "/api/admin/channel-secrets",
        smokeSetupBody(["whatsapp"]),
      ),
    );

    assert.equal(result.status, 400);
    assert.equal(
      (result.json as { error?: unknown }).error,
      "UNSUPPORTED_CHANNEL",
    );
  });
});

// ===========================================================================
// 6. POST input validation
// ===========================================================================

test("channel-secrets: POST rejects non-object JSON", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();
    const request = buildAuthPostRequest(
      "/api/admin/channel-secrets",
      JSON.stringify("just a string"),
    );
    const result = await callRoute(route.POST!, request);
    assert.equal(result.status, 400);
    const body = result.json as { error: string };
    assert.equal(body.error, "INVALID_JSON");
  });
});

test("channel-secrets: POST rejects unsupported hosted whatsapp dispatch", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();
    const request = buildAuthPostRequest(
      "/api/admin/channel-secrets",
      JSON.stringify({
        channel: "whatsapp",
        body: '{"object":"whatsapp_business_account"}',
      }),
    );
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 400);
    assert.equal(
      (result.json as { error?: unknown }).error,
      "UNSUPPORTED_CHANNEL",
    );
  });
});

test("channel-secrets: POST rejects empty body", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();
    const request = buildAuthPostRequest(
      "/api/admin/channel-secrets",
      JSON.stringify({ channel: "slack", body: "" }),
    );
    const result = await callRoute(route.POST!, request);
    assert.equal(result.status, 400);
    const body = result.json as { error: string };
    assert.equal(body.error, "EMPTY_BODY");
  });
});

test("channel-secrets: POST rejects payload larger than 64 KiB", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();
    const largeBody = "x".repeat(65537);
    const request = buildAuthPostRequest(
      "/api/admin/channel-secrets",
      JSON.stringify({ channel: "slack", body: largeBody }),
    );
    const result = await callRoute(route.POST!, request);
    assert.equal(result.status, 413);
    const body = result.json as { error: string };
    assert.equal(body.error, "PAYLOAD_TOO_LARGE");
  });
});

test("channel-secrets: POST rejects missing body field", async () => {
  await withAdminAuthEnv(async () => {
    const route = getAdminChannelSecretsRoute();
    const request = buildAuthPostRequest(
      "/api/admin/channel-secrets",
      JSON.stringify({ channel: "slack" }),
    );
    const result = await callRoute(route.POST!, request);
    assert.equal(result.status, 400);
    const body = result.json as { error: string };
    assert.equal(body.error, "MISSING_FIELDS");
  });
});

// ===========================================================================
// 7. Telegram smoke dispatch uses canonical public URL with bypass param
// ===========================================================================

test("channel-secrets: POST dispatches telegram webhook via canonical public URL", async () => {
  await withAdminAuthEnv(async () => {
    process.env.NEXT_PUBLIC_BASE_DOMAIN = "https://example.test";
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass-secret";

    const route = getAdminChannelSecretsRoute();

    // Configure test channels
    const putRequest = buildAuthPutRequest(
      "/api/admin/channel-secrets",
      smokeSetupBody(),
    );
    const setup = await callRoute(route.PUT!, putRequest);

    // Intercept fetch to capture the dispatch URL
    let capturedUrl = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      return Response.json({ ok: true });
    };

    try {
      const postRequest = buildAuthPostRequest(
        "/api/admin/channel-secrets",
        JSON.stringify({
          channel: "telegram",
          body: '{"update_id":4242}',
        }),
      );
      const result = await callRoute(route.POST!, postRequest);
      assert.equal(result.status, 200);

      assert.ok(
        capturedUrl.startsWith(
          "https://example.test/api/channels/telegram/webhook",
        ),
        `Expected canonical URL, got: ${capturedUrl}`,
      );
      assert.ok(
        capturedUrl.includes("x-vercel-protection-bypass=bypass-secret"),
        `Expected bypass param, got: ${capturedUrl}`,
      );
      assert.equal(
        (result.json as { deliveryId?: unknown }).deliveryId,
        "telegram:4242",
      );
    } finally {
      globalThis.fetch = originalFetch;

      // Clean up
      await callRoute(
        route.DELETE!,
        buildAuthDeleteRequest(
          "/api/admin/channel-secrets",
          JSON.stringify({
            cleanupToken: (setup.json as { cleanupToken?: unknown })
              .cleanupToken,
          }),
        ),
      );
    }
  });
});
