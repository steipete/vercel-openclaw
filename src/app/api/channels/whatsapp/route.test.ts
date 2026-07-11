import assert from "node:assert/strict";
import test from "node:test";

import { getInitializedMeta, mutateMeta } from "@/server/store/store";
import { withHarness } from "@/test-utils/harness";
import {
  buildAuthDeleteRequest,
  buildAuthGetRequest,
  buildAuthPutRequest,
  callRoute,
  getWhatsAppChannelRoute,
} from "@/test-utils/route-caller";

test("whatsapp GET keeps legacy state visible for removal", async () => {
  await withHarness(async () => {
    await mutateMeta((meta) => {
      meta.channels.whatsapp = {
        enabled: false,
        configuredAt: 1000,
        phoneNumberId: "legacy-phone",
        accessToken: "legacy-access",
        verifyToken: "legacy-verify",
        appSecret: "legacy-secret",
      };
    });

    const route = getWhatsAppChannelRoute();
    const result = await callRoute(
      route.GET!,
      buildAuthGetRequest("/api/channels/whatsapp"),
    );
    assert.equal(result.status, 200);
    const body = result.json as {
      configured?: unknown;
      mode?: unknown;
      webhookUrl?: unknown;
      status?: unknown;
      loginVia?: unknown;
    };
    assert.equal(body.configured, true);
    assert.equal(body.mode, "unsupported");
    assert.equal(body.webhookUrl, null);
    assert.equal(body.status, "disconnected");
    assert.equal(body.loginVia, null);
  });
});

test("whatsapp PUT fails closed before persisting webhook credentials", async () => {
  await withHarness(async () => {
    const route = getWhatsAppChannelRoute();
    const result = await callRoute(
      route.PUT!,
      buildAuthPutRequest(
        "/api/channels/whatsapp",
        JSON.stringify({
          enabled: true,
          phoneNumberId: "new-phone",
          accessToken: "new-access",
          verifyToken: "new-verify",
          appSecret: "new-secret",
        }),
      ),
    );

    assert.equal(result.status, 409);
    assert.equal(
      (result.json as { error?: { code?: unknown } }).error?.code,
      "CHANNEL_CONNECT_BLOCKED",
    );
    assert.equal((await getInitializedMeta()).channels.whatsapp, null);
  });
});

test("whatsapp DELETE removes legacy configuration", async () => {
  await withHarness(async () => {
    await mutateMeta((meta) => {
      meta.channels.whatsapp = {
        enabled: true,
        configuredAt: 1000,
        phoneNumberId: "legacy-phone",
        accessToken: "legacy-access",
        verifyToken: "legacy-verify",
        appSecret: "legacy-secret",
      };
    });
    const route = getWhatsAppChannelRoute();
    const result = await callRoute(
      route.DELETE!,
      buildAuthDeleteRequest("/api/channels/whatsapp", "{}"),
    );

    assert.equal(result.status, 200);
    assert.equal((await getInitializedMeta()).channels.whatsapp, null);
  });
});
