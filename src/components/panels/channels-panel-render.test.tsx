import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { RequestJson, RunAction, StatusPayload } from "@/components/admin-types";
import {
  DEFAULT_STATUS_LIFECYCLE,
  DEFAULT_STATUS_RESTORE_TARGET,
} from "@/components/status-payload-defaults";
import type { ChannelConnectability } from "@/shared/channel-connectability";

import { ChannelsPanel } from "./channels-panel";

function makeConnectability(
  channel: ChannelConnectability["channel"],
): ChannelConnectability {
  return {
    channel,
    mode: channel === "whatsapp" ? "unsupported" : "webhook-proxied",
    canConnect: channel !== "whatsapp",
    status: channel === "whatsapp" ? "fail" : "pass",
    webhookUrl:
      channel === "whatsapp"
        ? null
        : `https://openclaw.example/api/channels/${channel}/webhook`,
    issues:
      channel === "whatsapp"
        ? [
            {
              id: "hosted-transport-unavailable",
              status: "fail",
              message: "Hosted WhatsApp is unavailable.",
              remediation: "Use local OpenClaw.",
              env: [],
            },
          ]
        : [],
  };
}

const RUN_ACTION: RunAction = async () => true;
const REQUEST_JSON: RequestJson = async () => ({ ok: true, data: null, meta: { requestId: "test", action: "test", label: "test", status: 200, refreshed: false } });

function makeStatus(): StatusPayload {
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
        webhookUrl: "",
        desiredEndpointUrl: "",
        currentEndpointUrl: null,
        endpointDrift: false,
        canRepairEndpoint: false,
        nextSafeAction: "use-local-openclaw",
        applicationId: null,
        publicKey: null,
        configuredAt: null,
        appName: null,
        botUsername: null,
        endpointConfigured: false,
        endpointUrl: null,
        endpointError: null,
        commandRegistered: false,
        commandId: null,
        inviteUrl: null,
        isPublicUrl: false,
        connectability: makeConnectability("discord"),
      },
      whatsapp: {
        configured: false,
        mode: "unsupported",
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

function renderChannelsPanel(status?: StatusPayload): string {
  return renderToStaticMarkup(
    <ChannelsPanel
      active={true}
      status={status ?? makeStatus()}
      busy={false}
      runAction={RUN_ACTION}
      requestJson={REQUEST_JSON}
      refresh={async () => {}}
    />,
  );
}

test("ChannelsPanel does not show detail toggle when no readiness data exists", () => {
  const html = renderChannelsPanel();

  // No Show/Hide details when there is no verifyResult and no persisted readiness
  assert.ok(!html.includes("Show details"), "Show details absent without readiness data");
  assert.ok(!html.includes("Hide details"), "Hide details absent on initial render");
});

test("ChannelsPanel renders all four channel cards", () => {
  const html = renderChannelsPanel();

  assert.ok(html.includes("channel-slack"), "Slack card must render");
  assert.ok(html.includes("channel-telegram"), "Telegram card must render");
  assert.ok(html.includes("channel-discord"), "Discord card must render");
  assert.ok(html.includes("channel-whatsapp"), "WhatsApp card must render");
});

test("ChannelsPanel renders hosted support boundary", () => {
  const html = renderChannelsPanel();

  assert.ok(html.includes("Hosted OpenClaw support"), "support boundary heading must render");
  assert.ok(html.includes('data-feature-support-docs="docs/getting-started/hosted-feature-support.md"'));
  assert.ok(html.includes('href="https://github.com/vercel-labs/vercel-openclaw/blob/main/docs/getting-started/hosted-feature-support.md"'));
  assert.ok(html.includes('data-feature-id="channel-slack"'));
  assert.ok(html.includes('data-feature-id="channel-telegram"'));
  assert.ok(html.includes('data-feature-id="channel-discord"'));
  assert.ok(html.includes('data-feature-id="channel-whatsapp"'));
  assert.ok(html.includes('data-feature-id="channels-upstream-rest"'));
  assert.ok(html.includes('data-feature-id="companion-devices"'));
  assert.ok(html.includes('data-feature-id="voice-canvas"'));
  assert.ok(html.includes('data-feature-id="plugins-skills-bundled"'));
  assert.ok(html.includes('data-hosted-status="supported"'));
  assert.ok(html.includes('data-hosted-status="not-supported"'));
  assert.ok(html.includes('data-hosted-status="upstream-only"'));
  assert.ok(html.includes('data-hosted-status="bundled-only"'));
});

test("ChannelsPanel exposes preflight state as data attributes", () => {
  const html = renderChannelsPanel();

  assert.ok(html.includes('data-preflight-ok="unknown"'), "preflight ok defaults to unknown before fetch");
});

test("ChannelsPanel only offers connect actions for hosted delivery channels", () => {
  const html = renderChannelsPanel();

  assert.ok(html.includes("Connect Slack"), "Slack shows connect title");
  assert.ok(html.includes("Connect Telegram"), "Telegram shows connect title");
  assert.ok(html.includes("Discord (not supported)"), "Discord shows unsupported title");
  assert.ok(!html.includes("Connect Discord"), "Discord does not offer hosted setup");
  assert.ok(html.includes("WhatsApp (unavailable)"), "WhatsApp shows unavailable title");
  assert.ok(!html.includes("Connect WhatsApp"), "WhatsApp does not offer hosted setup");

  const connectButtons = html.match(/>Connect<\/button>/g) ?? [];
  assert.equal(
    connectButtons.length,
    2,
    `expected exactly 2 Connect buttons, found ${connectButtons.length}`,
  );

  // Legacy "Save Credentials" label must not appear anywhere
  assert.equal(
    (html.match(/Save Credentials/g) ?? []).length,
    0,
    "legacy Save Credentials label must not appear in rendered HTML",
  );
});

test("ChannelsPanel exposes machine-readable channel card state", () => {
  const html = renderChannelsPanel();

  assert.ok(html.includes('data-channel="slack"'), "slack data-channel attribute");
  assert.ok(html.includes('data-channel="telegram"'), "telegram data-channel attribute");
  assert.ok(html.includes('data-channel="discord"'), "discord data-channel attribute");
  assert.ok(html.includes('data-channel="whatsapp"'), "whatsapp data-channel attribute");

  const configuredAttrs = html.match(/data-configured="(?:true|false)"/g) ?? [];
  const connectableAttrs = html.match(/data-can-connect="(?:true|false)"/g) ?? [];
  const statusAttrs = html.match(/data-connectability-status="(?:pass|warn|fail)"/g) ?? [];

  assert.equal(configuredAttrs.length, 4, "all four cards have data-configured");
  assert.equal(connectableAttrs.length, 4, "all four cards have data-can-connect");
  assert.equal(statusAttrs.length, 4, "all four cards have data-connectability-status");
});
