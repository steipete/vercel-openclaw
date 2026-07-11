import assert from "node:assert/strict";
import { mock } from "node:test";
import test from "node:test";

import { discordWebhookWorkflowRuntime } from "@/app/api/channels/discord/webhook/route";
import { HOSTED_DISCORD_UNAVAILABLE_MESSAGE } from "@/server/channels/discord/hosted-support";
import { withHarness } from "@/test-utils/harness";
import { callRoute, resetAfterCallbacks } from "@/test-utils/route-caller";
import {
  buildDiscordPing,
  buildDiscordWebhook,
} from "@/test-utils/webhook-builders";

let discordRouteModule:
  | typeof import("@/app/api/channels/discord/webhook/route")
  | null = null;

function getDiscordWebhookRoute() {
  if (!discordRouteModule) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    discordRouteModule = require("@/app/api/channels/discord/webhook/route") as typeof import("@/app/api/channels/discord/webhook/route");
  }
  return discordRouteModule;
}

test("Discord webhook: PING returns pong without starting workflow", async () => {
  await withHarness(async (h) => {
    const secrets = h.configureAllChannels();
    const startMock = mock.method(
      discordWebhookWorkflowRuntime,
      "start",
      async () => {},
    );
    try {
      const result = await callRoute(
        getDiscordWebhookRoute().POST,
        buildDiscordPing({
          privateKey: secrets.discordPrivateKey,
          publicKeyHex: secrets.discordPublicKeyHex,
        }),
      );
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { type: 1 });
      assert.equal(startMock.mock.callCount(), 0);
    } finally {
      startMock.mock.restore();
      resetAfterCallbacks();
    }
  });
});

test("Discord webhook: signed interactions fail closed with an immediate ephemeral reply", async () => {
  await withHarness(async (h) => {
    const secrets = h.configureAllChannels();
    const startMock = mock.method(
      discordWebhookWorkflowRuntime,
      "start",
      async () => {},
    );
    try {
      const result = await callRoute(
        getDiscordWebhookRoute().POST,
        buildDiscordWebhook({
          privateKey: secrets.discordPrivateKey,
          publicKeyHex: secrets.discordPublicKeyHex,
          payload: {
            id: "interaction-unsupported-1",
            type: 2,
            token: "interaction-token",
            application_id: "app-1",
            data: { name: "ask" },
          },
        }),
      );
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, {
        type: 4,
        data: { content: HOSTED_DISCORD_UNAVAILABLE_MESSAGE, flags: 64 },
      });
      assert.equal(startMock.mock.callCount(), 0);
    } finally {
      startMock.mock.restore();
      resetAfterCallbacks();
    }
  });
});
