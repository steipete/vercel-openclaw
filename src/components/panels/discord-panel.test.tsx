import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { RequestJson, RunAction, StatusPayload } from "@/components/admin-types";
import {
  DEFAULT_STATUS_LIFECYCLE,
  DEFAULT_STATUS_RESTORE_TARGET,
} from "@/components/status-payload-defaults";
import type { ChannelConnectability } from "@/shared/channel-connectability";

import { DiscordPanel } from "./discord-panel";

function makeConnectability(
  channel: ChannelConnectability["channel"],
): ChannelConnectability {
  return {
    channel,
    mode: channel === "discord" ? "unsupported" : "webhook-proxied",
    canConnect: channel !== "discord",
    status: channel === "discord" ? "fail" : "pass",
    webhookUrl:
      channel === "discord"
        ? null
        : `https://openclaw.example/api/channels/${channel}/webhook`,
    issues:
      channel === "discord"
        ? [
            {
              id: "hosted-transport-unavailable",
              status: "fail",
              message: "Hosted Discord is unavailable.",
              remediation: "Use local OpenClaw Discord Gateway support.",
              env: [],
            },
          ]
        : [],
  };
}

const RUN_ACTION: RunAction = async () => true;
const REQUEST_JSON: RequestJson = async () => ({ ok: true, data: null, meta: { requestId: "test", action: "test", label: "test", status: 200, refreshed: false } });

function makeStatus(
  discordOverrides: Partial<StatusPayload["channels"]["discord"]> = {},
): StatusPayload {
  return {
    authMode: "admin-secret",
    storeBackend: "redis",
    persistentStore: true,
    status: "running",
    sandboxId: "sbx-test",
    snapshotId: "snap-test",
    gatewayReady: true,
    gatewayStatus: "ready",
    gatewayCheckedAt: null,
    gatewayUrl: "/gateway",
    lastError: null,
    lastKeepaliveAt: null,
    sleepAfterMs: 300_000,
    heartbeatIntervalMs: 15_000,
    timeoutRemainingMs: 120_000,
    timeoutSource: "estimated",
    setupProgress: null,
    firewall: {
      mode: "learning",
      allowlist: [],
      learned: [],
      events: [],
      updatedAt: 0,
      lastIngestedAt: null,
      learningStartedAt: null,
      commandsObserved: 0,
      wouldBlock: [],
    },
    channels: {
      slack: {
        configured: false,
        webhookUrl: "",
        configuredAt: null,
        team: null,
        user: null,
        botId: null,
        hasSigningSecret: false,
        hasBotToken: false,
        lastError: null,
        connectability: makeConnectability("slack"),
        installMethod: "manual",
        installUrl: null,
        appCredentialsConfigured: false,
        appCredentialsSource: "none",
        appId: null,
        appName: null,
        appCreatedAt: null,
        projectScope: null,
        projectName: null,
      },
      telegram: {
        configured: false,
        webhookUrl: null,
        botUsername: null,
        configuredAt: null,
        lastError: null,
        status: "disconnected",
        commandSyncStatus: "unsynced",
        commandsRegisteredAt: null,
        commandSyncError: null,
        connectability: makeConnectability("telegram"),
      },
      discord: {
        configured: false,
        webhookUrl: "https://openclaw.example/api/channels/discord/webhook",
        applicationId: null,
        publicKey: null,
        configuredAt: null,
        appName: null,
        botUsername: null,
        endpointConfigured: false,
        endpointUrl: null,
        desiredEndpointUrl: "https://openclaw.example/api/channels/discord/webhook",
        currentEndpointUrl: null,
        endpointDrift: false,
        canRepairEndpoint: false,
        nextSafeAction: "use-local-openclaw",
        endpointError: null,
        commandRegistered: false,
        commandId: null,
        inviteUrl: null,
        isPublicUrl: false,
        connectability: makeConnectability("discord"),
        ...discordOverrides,
      },
      whatsapp: {
        configured: false,
        mode: "webhook-proxied",
        webhookUrl: null,
        status: "unconfigured",
        configuredAt: null,
        displayName: null,
        linkedPhone: null,
        lastError: null,
        requiresRunningSandbox: false,
        loginVia: "/gateway",
        connectability: makeConnectability("whatsapp"),
      },
    },
    restoreTarget: {
      ...DEFAULT_STATUS_RESTORE_TARGET,
    },
    lifecycle: DEFAULT_STATUS_LIFECYCLE,
    user: { sub: "admin", name: "Admin" },
  };
}

function renderPanel(status: StatusPayload): string {
  return renderToStaticMarkup(
    <DiscordPanel
      status={status}
      busy={false}
      runAction={RUN_ACTION}
      requestJson={REQUEST_JSON}
    />,
  );
}

test("DiscordPanel renders unsupported guidance without setup actions", () => {
  const html = renderPanel(makeStatus());

  assert.ok(html.includes("Discord (not supported)"));
  assert.ok(html.includes("Use local or upstream OpenClaw"));
  assert.ok(html.includes("persistent Discord Gateway transport"));
  assert.ok(!html.includes("Bot token"));
  assert.ok(!html.includes("Connect Discord"));
  assert.ok(!html.includes("Register /ask"));
  assert.ok(!html.includes("Invite bot"));
  assert.ok(!html.includes("Run /ask"));
  assert.ok(!html.includes("Update credentials"));
});

test("DiscordPanel exposes only diagnostics and removal for legacy config", () => {
  const html = renderPanel(
    makeStatus({
      configured: true,
      appName: "LegacyBot",
      applicationId: "app-123",
      currentEndpointUrl: "https://old.example/discord",
      endpointUrl: "https://old.example/discord",
      nextSafeAction: "disconnect-legacy",
    }),
  );

  assert.ok(html.includes("Legacy hosted configuration retained for cleanup"));
  assert.ok(html.includes("cleanup only"));
  assert.ok(html.includes("LegacyBot"));
  assert.ok(html.includes("https://old.example/discord"));
  assert.ok(html.includes("Remove legacy config"));
  assert.ok(!html.includes(">connected<"));
  assert.ok(!html.includes("Register"));
  assert.ok(!html.includes("Invite bot"));
  assert.ok(!html.includes("Run /ask"));
  assert.ok(!html.includes("Update credentials"));
});
