import assert from "node:assert/strict";
import test from "node:test";

import type { ChannelLastForward, ChannelName } from "@/shared/channels";
import { createUnknownUserVisibleReply } from "@/shared/channels";
import type { ChannelSummaryResponse } from "@/shared/channel-summary";
import { _resetStoreForTesting, mutateMeta } from "@/server/store/store";
import {
  buildAuthGetRequest,
  callRoute,
  getChannelsSummaryRoute,
  patchNextServerAfter,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";

patchNextServerAfter();

const ENV_KEYS = [
  "NODE_ENV",
  "VERCEL",
  "VERCEL_AUTH_MODE",
  "REDIS_URL",
  "KV_URL",
  "ADMIN_SECRET",
  "SESSION_SECRET",
] as const;

const DISCORD_WEBHOOK_URL = "http://localhost:3000/api/channels/discord/webhook";

async function withSummaryTestEnv(fn: () => Promise<void>): Promise<void> {
  const originals: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) originals[key] = process.env[key];
  (process.env as Record<string, string | undefined>).NODE_ENV = "test";
  delete process.env.VERCEL;
  delete process.env.VERCEL_AUTH_MODE;
  delete process.env.REDIS_URL;
  delete process.env.KV_URL;
  process.env.ADMIN_SECRET = "test-admin-secret-for-scenarios";
  process.env.SESSION_SECRET = "summary-regression-session-secret";
  _resetStoreForTesting();
  try {
    await fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (originals[key] === undefined) delete process.env[key];
      else (process.env as Record<string, string | undefined>)[key] = originals[key];
    }
    _resetStoreForTesting();
    resetAfterCallbacks();
  }
}

async function readSummary(): Promise<ChannelSummaryResponse> {
  const route = getChannelsSummaryRoute();
  const result = await callRoute(route.GET!, buildAuthGetRequest("/api/channels/summary"));
  assert.equal(result.status, 200);
  return result.json as ChannelSummaryResponse;
}

function makeForward(input: {
  channel: ChannelName;
  ok: boolean;
  classification: string;
  status?: number | null;
  completedAt?: number;
  userVisibleReply?: ChannelLastForward["userVisibleReply"];
}): ChannelLastForward {
  const completedAt = input.completedAt ?? Date.now();
  return {
    ok: input.ok,
    status: input.status ?? (input.ok ? 200 : 404),
    classification: input.classification,
    attempts: 1,
    totalMs: 25,
    transport: "public",
    sandboxUrl: "https://sandbox.example.test",
    sandboxId: "sbx-summary",
    finalReasonHead: input.ok ? null : "not delivered",
    startedAt: completedAt - 25,
    completedAt,
    deliveryId: `${input.channel}:summary`,
    userVisibleReply:
      input.userVisibleReply ?? createUnknownUserVisibleReply(completedAt),
  };
}

test("SUM-01 summary keeps configured-only distinct from route/delivery/user-visible readiness", async () => {
  await withSummaryTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.channels.slack = {
        signingSecret: "secret",
        botToken: "xoxb-test",
        configuredAt: Date.now(),
      };
    });

    const summary = await readSummary();

    assert.equal(summary.slack.configured, true);
    assert.equal(summary.slack.routeReady, false);
    assert.equal(summary.slack.deliveryReady, false);
    assert.equal(summary.slack.userVisibleReply?.status ?? null, null);
  });
});

test("SUM-02 hosted Discord stays unavailable despite legacy route configuration", async () => {
  await withSummaryTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.channels.discord = {
        publicKey: "0".repeat(64),
        applicationId: "app-1",
        botToken: "bot-token",
        configuredAt: Date.now(),
        endpointConfigured: true,
        endpointUrl: DISCORD_WEBHOOK_URL,
        commandRegistered: true,
        commandId: "cmd-1",
      };
    });

    const summary = await readSummary();

    assert.equal(summary.discord.routeReady, false);
    assert.equal(summary.discord.nativeAccepted, false);
    assert.equal(summary.discord.userVisibleReplyVerified, false);
    assert.equal(summary.discord.readiness.reason, "hosted_discord_transport_unavailable");
  });
});

test("SUM-03 legacy Discord forward evidence cannot enable unsupported hosted delivery", async () => {
  await withSummaryTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.channels.discord = {
        publicKey: "0".repeat(64),
        applicationId: "app-1",
        botToken: "bot-token",
        configuredAt: Date.now(),
        endpointConfigured: false,
        commandRegistered: false,
      };
      meta.channelDiagnostics = {
        discord: {
          lastForward: makeForward({
            channel: "discord",
            ok: true,
            classification: "accepted",
          }),
        },
      };
    });

    const summary = await readSummary();

    assert.equal(summary.discord.nativeAccepted, false);
    assert.equal(summary.discord.routeReady, false);
    assert.equal(summary.discord.userVisibleReplyVerified, false);
    assert.equal(summary.discord.readiness.reason, "hosted_discord_transport_unavailable");
  });
});

test("SUM-04 legacy Discord reply evidence cannot enable unsupported hosted delivery", async () => {
  await withSummaryTestEnv(async () => {
    const now = Date.now();
    await mutateMeta((meta) => {
      meta.channels.discord = {
        publicKey: "0".repeat(64),
        applicationId: "app-1",
        botToken: "bot-token",
        configuredAt: now,
        endpointConfigured: true,
        endpointUrl: DISCORD_WEBHOOK_URL,
        commandRegistered: true,
      };
      meta.channelDiagnostics = {
        discord: {
          lastForward: makeForward({
            channel: "discord",
            ok: true,
            classification: "accepted",
            userVisibleReply: {
              status: "timed-out",
              checkedAt: now,
              observedAt: null,
              timeoutMs: 30_000,
              source: "synthetic-canary",
              reason: "reply_not_seen",
              evidence: { attempts: 1 },
            },
          }),
        },
      };
    });

    const summary = await readSummary();

    assert.equal(summary.discord.nativeAccepted, false);
    assert.equal(summary.discord.userVisibleReplyVerified, false);
    assert.equal(summary.discord.readiness.reason, "hosted_discord_transport_unavailable");
  });
});

test("SUM-05 Slack recent accepted forward may override stale sync failure while diagnostics remain visible", async () => {
  await withSummaryTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.channels.slack = {
        signingSecret: "secret",
        botToken: "xoxb-test",
        configuredAt: Date.now(),
        liveConfigSync: {
          outcome: "failed",
          reason: "Slack route did not become ready after config sync restart",
          liveConfigFresh: false,
          checkedAt: 123,
          operatorMessage: "stale config-sync failure",
        },
      };
      meta.channelDiagnostics = {
        slack: {
          lastForward: makeForward({
            channel: "slack",
            ok: true,
            classification: "accepted",
          }),
        },
      };
    });

    const summary = await readSummary();

    assert.equal(summary.slack.deliveryReady, true);
    assert.equal(summary.slack.readiness.configSyncOutcome, "failed");
    assert.equal(summary.slack.readiness.operatorMessage, "stale config-sync failure");
    assert.equal(summary.slack.readiness.lastForward?.classification, "accepted");
  });
});
