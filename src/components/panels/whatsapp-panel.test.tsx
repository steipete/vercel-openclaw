import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { RunAction, StatusPayload } from "@/components/admin-types";
import {
  DEFAULT_STATUS_LIFECYCLE,
  DEFAULT_STATUS_RESTORE_TARGET,
} from "@/components/status-payload-defaults";
import type { ChannelConnectability } from "@/shared/channel-connectability";

import { WhatsAppPanel } from "./whatsapp-panel";

function makeConnectability(): ChannelConnectability {
  return {
    channel: "whatsapp",
    mode: "unsupported",
    canConnect: false,
    status: "fail",
    webhookUrl: null,
    issues: [
      {
        id: "hosted-transport-unavailable",
        status: "fail",
        message: "Hosted WhatsApp is unavailable.",
        remediation: "Use local OpenClaw.",
        env: [],
      },
    ],
  };
}

const RUN_ACTION: RunAction = async () => true;

function makeStatus(
  whatsappOverrides: Partial<StatusPayload["channels"]["whatsapp"]> = {},
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
        connectability: {
          channel: "slack",
          mode: "unsupported",
          canConnect: true,
          status: "pass",
          webhookUrl: "",
          issues: [],
        },
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
        connectability: {
          channel: "telegram",
          mode: "unsupported",
          canConnect: true,
          status: "pass",
          webhookUrl: null,
          issues: [],
        },
      },
      discord: {
        configured: false,
        webhookUrl: "",
        desiredEndpointUrl: "",
        currentEndpointUrl: null,
        endpointDrift: false,
        canRepairEndpoint: false,
        nextSafeAction: "paste-token",
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
        connectability: {
          channel: "discord",
          mode: "unsupported",
          canConnect: true,
          status: "pass",
          webhookUrl: "",
          issues: [],
        },
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
        connectability: makeConnectability(),
        ...whatsappOverrides,
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
    <WhatsAppPanel
      status={status}
      busy={false}
      runAction={RUN_ACTION}
    />,
  );
}

test("WhatsAppPanel renders the hosted transport as unavailable", () => {
  const html = renderPanel(makeStatus());

  assert.ok(html.includes("WhatsApp (unavailable)"));
  assert.ok(html.includes("Hosted transport unavailable"));
  assert.ok(html.includes("Meta Cloud API webhooks do not match"));
  assert.equal(html.includes("Connect WhatsApp"), false);
  assert.equal(html.includes("Phone Number ID"), false);
});

test("WhatsAppPanel exposes only cleanup for legacy linked credentials", () => {
  const html = renderPanel(
    makeStatus({
      configured: true,
      webhookUrl: "https://openclaw.example/api/channels/whatsapp/webhook",
      status: "linked",
      displayName: "Support Inbox",
      linkedPhone: "+1 555 010 1000",
      lastError: "stale Meta delivery error",
      connectability: makeConnectability(),
    }),
  );

  assert.ok(html.includes("Legacy Meta credentials are still saved"));
  assert.ok(html.includes("Remove saved credentials"));
  assert.equal(html.includes("Business account"), false);
  assert.equal(html.includes("Webhook URL"), false);
  assert.equal(html.includes("Update credentials"), false);
  assert.equal(html.includes("Linked ·"), false);
  assert.equal(html.includes("stale Meta delivery error"), false);
});
