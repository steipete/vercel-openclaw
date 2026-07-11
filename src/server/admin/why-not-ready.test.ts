import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildWhyNotReady } from "@/server/admin/why-not-ready";
import { createDefaultMeta, type SingleMeta } from "@/shared/types";
import {
  createUnknownUserVisibleReply,
  type ChannelLastForward,
} from "@/shared/channels";

function metaFixture(): SingleMeta {
  return createDefaultMeta(1_000_000, "test-token", "test-instance");
}

function slackForward(
  overrides: Partial<ChannelLastForward> = {},
): ChannelLastForward {
  return {
    ok: true,
    status: 200,
    classification: "accepted",
    attempts: 1,
    totalMs: 50,
    transport: "public",
    sandboxUrl: "https://sb-test.vercel.run",
    sandboxId: "sb-test",
    finalReasonHead: null,
    startedAt: Date.now() - 1000,
    completedAt: Date.now() - 500,
    deliveryId: "delivery-1",
    userVisibleReply: createUnknownUserVisibleReply(Date.now() - 500),
    ...overrides,
  };
}

describe("buildWhyNotReady", () => {
  test("unsupported hosted WhatsApp never produces readiness blockers", async () => {
    for (const legacyConfigPresent of [false, true]) {
      const meta = metaFixture();
      meta.channels.whatsapp = legacyConfigPresent
        ? {
            enabled: true,
            pluginSpec: "@openclaw/whatsapp",
            dmPolicy: "pairing",
            allowFrom: [],
            groupPolicy: "allowlist",
            groupAllowFrom: [],
            groups: [],
            lastKnownLinkState: "linked",
            linkedPhone: "+15555550100",
            displayName: "Legacy",
            configuredAt: Date.now(),
            lastError: "stale legacy error",
          }
        : null;
      meta.channelDiagnostics = {
        whatsapp: {
          lastForward: slackForward({
            ok: false,
            classification: "handler-not-ready",
          }),
        },
      };

      const report = await buildWhyNotReady(meta);

      assert.equal(report.channels.whatsapp.hostedDeliverySupported, false);
      assert.equal(report.channels.whatsapp.ready, true);
      assert.deepEqual(report.channels.whatsapp.blockers, []);
      assert.deepEqual(report.channels.whatsapp.observabilityGaps, []);
      assert.equal(report.channels.whatsapp.readinessSnapshot.lastForward, null);
    }
  });

  test("flags slack with no credentials as not ready", async () => {
    const meta = metaFixture();
    meta.channels.slack = null;

    const report = await buildWhyNotReady(meta);

    assert.equal(report.channels.slack.ready, false);
    const kinds = report.channels.slack.blockers.map((b) => b.kind);
    assert.ok(
      kinds.includes("no_credentials"),
      `expected no_credentials blocker, got ${kinds.join(",")}`,
    );
  });

  test("slack with creds and recent ok forward is ready", async () => {
    const meta = metaFixture();
    meta.channels.slack = {
      signingSecret: "secret",
      botToken: "xoxb-test",
      configuredAt: Date.now(),
    };
    meta.channelDiagnostics = {
      slack: { lastForward: slackForward() },
    };

    const report = await buildWhyNotReady(meta);

    assert.equal(report.channels.slack.ready, true);
    assert.deepEqual(report.channels.slack.blockers, []);
    assert.equal(
      report.channels.slack.observabilityGaps[0]?.kind,
      "user_visible_reply_unknown",
    );
    assert.equal(
      report.channels.slack.readinessSnapshot.userVisibleReply,
      report.channels.slack.observabilityGaps[0]?.evidence.userVisibleReply,
    );
  });

  test("observed user-visible reply clears native-acceptance observability gap", async () => {
    const meta = metaFixture();
    meta.channels.slack = {
      signingSecret: "secret",
      botToken: "xoxb-test",
      configuredAt: Date.now(),
    };
    meta.channelDiagnostics = {
      slack: {
        lastForward: slackForward({
          userVisibleReply: {
            status: "observed",
            checkedAt: Date.now() - 400,
            observedAt: Date.now() - 400,
            timeoutMs: null,
            source: "manual",
            reason: "operator-confirmed",
            evidence: null,
          },
        }),
      },
    };

    const report = await buildWhyNotReady(meta);

    assert.equal(report.channels.slack.ready, true);
    assert.deepEqual(report.channels.slack.observabilityGaps, []);
  });

  test("timed-out user-visible reply adds observability gap without changing ready", async () => {
    const meta = metaFixture();
    meta.channels.slack = {
      signingSecret: "secret",
      botToken: "xoxb-test",
      configuredAt: Date.now(),
    };
    meta.channelDiagnostics = {
      slack: {
        lastForward: slackForward({
          userVisibleReply: {
            status: "timed-out",
            checkedAt: Date.now() - 400,
            observedAt: null,
            timeoutMs: 30_000,
            source: "synthetic-canary",
            reason: "deadline-expired",
            evidence: null,
          },
        }),
      },
    };

    const report = await buildWhyNotReady(meta);

    assert.equal(report.channels.slack.ready, true);
    assert.equal(
      report.channels.slack.observabilityGaps[0]?.kind,
      "user_visible_reply_timed_out",
    );
  });

  test("slack lastForward sandbox-not-listening yields blocker with sandboxUrl", async () => {
    const meta = metaFixture();
    meta.channels.slack = {
      signingSecret: "secret",
      botToken: "xoxb-test",
      configuredAt: Date.now(),
    };
    meta.channelDiagnostics = {
      slack: {
        lastForward: slackForward({
          ok: false,
          status: 502,
          classification: "sandbox-not-listening",
          sandboxUrl: "https://sb-stale.vercel.run",
        }),
      },
    };

    const report = await buildWhyNotReady(meta);

    assert.equal(report.channels.slack.ready, false);
    const blocker = report.channels.slack.blockers.find(
      (b) => b.kind === "sandbox_not_listening",
    );
    assert.ok(blocker, "expected sandbox_not_listening blocker");
    assert.equal(blocker.evidence.sandboxUrl, "https://sb-stale.vercel.run");
  });

  test("telegram expected listener without ready proof yields handler blocker", async () => {
    const meta = metaFixture();
    meta.status = "running";
    meta.sandboxId = "sbx-telegram";
    meta.channels.telegram = {
      botToken: "tg-token",
      webhookSecret: "tg-secret",
      webhookUrl: "https://app.example.com/api/channels/telegram/webhook",
      botUsername: "test_bot",
      configuredAt: Date.now(),
    };
    meta.lastRestoreMetrics = {
      sandboxCreateMs: 0,
      tokenWriteMs: 0,
      assetSyncMs: 0,
      startupScriptMs: 0,
      forcePairMs: 0,
      firewallSyncMs: 0,
      localReadyMs: 0,
      publicReadyMs: 0,
      totalMs: 0,
      skippedStaticAssetSync: true,
      assetSha256: null,
      vcpus: 0,
      recordedAt: Date.now() - 1_000,
      telegramExpected: true,
      telegramConfigPresent: true,
      telegramListenerReady: false,
      telegramListenerStatus: 0,
      telegramListenerError: "connection refused",
    };

    const report = await buildWhyNotReady(meta);

    assert.equal(report.channels.telegram.ready, false);
    const blocker = report.channels.telegram.blockers.find(
      (b) => b.kind === "handler_not_ready",
    );
    assert.ok(blocker, "expected handler_not_ready blocker");
    assert.equal(blocker.evidence.sandboxPort, 8787);
    assert.equal(blocker.evidence.telegramListenerReady, false);
  });

  test("discord endpoint drift and missing command are separate blockers", async () => {
    const meta = metaFixture();
    meta.channels.discord = {
      publicKey: "discord-public-key",
      applicationId: "discord-app",
      botToken: "discord-token",
      configuredAt: Date.now(),
      endpointConfigured: false,
      endpointUrl: "https://old.example.com/api/channels/discord/webhook",
      endpointError: "Discord interactions endpoint points at a different deployment.",
      commandRegistered: false,
    };

    const report = await buildWhyNotReady(meta);

    assert.equal(report.channels.discord.ready, false);
    const kinds = report.channels.discord.blockers.map((b) => b.kind);
    assert.ok(kinds.includes("endpoint_drift"), `expected endpoint_drift, got ${kinds.join(",")}`);
    assert.ok(kinds.includes("command_missing"), `expected command_missing, got ${kinds.join(",")}`);
  });

  test("discord deferred ack without native forward is an observability gap", async () => {
    const meta = metaFixture();
    meta.channels.discord = {
      publicKey: "discord-public-key",
      applicationId: "discord-app",
      botToken: "discord-token",
      configuredAt: Date.now(),
      endpointConfigured: true,
      endpointUrl: "https://app.example.com/api/channels/discord/webhook",
      commandRegistered: true,
      commandId: "cmd-1",
    };

    const report = await buildWhyNotReady(meta);

    assert.equal(
      report.channels.discord.observabilityGaps[0]?.kind,
      "deferred_ack_without_native_forward",
    );
  });

  test("discord native acceptance without visible reply is still not fully ready", async () => {
    const meta = metaFixture();
    meta.channels.discord = {
      publicKey: "discord-public-key",
      applicationId: "discord-app",
      botToken: "discord-token",
      configuredAt: Date.now(),
      endpointConfigured: true,
      endpointUrl: "https://app.example.com/api/channels/discord/webhook",
      commandRegistered: true,
      commandId: "cmd-1",
    };
    meta.channelDiagnostics = {
      discord: { lastForward: slackForward() },
    };

    const report = await buildWhyNotReady(meta);

    assert.equal(report.channels.discord.ready, false);
    assert.equal(
      report.channels.discord.observabilityGaps[0]?.kind,
      "native_accepted_without_user_visible_reply",
    );
  });

  test("discord observed visible reply is required for why-not-ready readiness", async () => {
    const meta = metaFixture();
    const checkedAt = Date.now() - 400;
    meta.channels.discord = {
      publicKey: "discord-public-key",
      applicationId: "discord-app",
      botToken: "discord-token",
      configuredAt: Date.now(),
      endpointConfigured: true,
      endpointUrl: "https://app.example.com/api/channels/discord/webhook",
      commandRegistered: true,
      commandId: "cmd-1",
    };
    meta.channelDiagnostics = {
      discord: {
        lastForward: slackForward({
          deliveryId: "discord:interaction-1",
          userVisibleReply: {
            status: "observed",
            checkedAt,
            observedAt: checkedAt,
            timeoutMs: null,
            source: "platform-api",
            reason: "interaction-edit-observed",
            evidence: { observer: "discord-interaction-edit" },
          },
        }),
      },
    };

    const report = await buildWhyNotReady(meta);

    assert.equal(report.channels.discord.ready, true);
    assert.deepEqual(report.channels.discord.observabilityGaps, []);
  });

  test("slack recent broken forward wins over stale green config-sync", async () => {
    const meta = metaFixture();
    const now = Date.now();
    meta.channels.slack = {
      signingSecret: "secret",
      botToken: "xoxb-test",
      configuredAt: now,
      liveConfigSync: {
        outcome: "applied",
        reason: "config_written_and_restarted",
        liveConfigFresh: true,
        checkedAt: now - 60_000,
      },
    };
    meta.channelDiagnostics = {
      slack: {
        lastForward: slackForward({
          ok: false,
          status: 404,
          classification: "handler-not-ready",
          finalReasonHead: "Not Found",
          completedAt: now - 1_000,
        }),
      },
    };

    const report = await buildWhyNotReady(meta);

    assert.equal(report.channels.slack.ready, false);
    assert.ok(
      report.channels.slack.blockers.some((blocker) => blocker.kind === "handler_not_ready"),
      "expected handler_not_ready blocker",
    );
    assert.equal(report.channels.slack.readinessSnapshot.liveConfigSync, meta.channels.slack.liveConfigSync);
  });
});
