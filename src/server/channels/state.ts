import { randomBytes } from "node:crypto";

import type {
  DiscordChannelConfig,
  SlackChannelConfig,
  TelegramChannelConfig,
  WhatsAppChannelConfig,
} from "@/shared/channels";
import type { ChannelConnectability } from "@/shared/channel-connectability";
import type { SingleMeta } from "@/shared/types";
import {
  buildChannelConnectabilityMap,
} from "@/server/channels/connectability";
import {
  withChannelConfigLease,
  type ChannelConfigLease,
} from "@/server/channels/config-lock";
import {
  isPublicUrl,
} from "@/server/channels/discord/application";
import {
  buildChannelDisplayWebhookUrl,
  buildChannelWebhookUrl,
  toDisplaySafeWebhookUrl,
} from "@/server/channels/webhook-urls";
import { getSlackAppConfig } from "@/server/channels/slack/app-config";
import { getSlackInstallConfig } from "@/server/channels/slack/install-config";
import { buildDeploymentContract } from "@/server/deployment-contract";
import { logDebug } from "@/server/log";
import { getInitializedMeta, mutateMeta } from "@/server/store/store";

export type {
  PublicSlackState,
  PublicTelegramState,
  PublicDiscordState,
  PublicWhatsAppState,
  PublicChannelState,
} from "@/shared/channel-admin-state";

import type {
  PublicSlackState,
  PublicTelegramState,
  PublicDiscordState,
  PublicWhatsAppState,
  PublicChannelState,
} from "@/shared/channel-admin-state";

export function buildSlackWebhookUrl(request?: Request): string {
  return buildChannelWebhookUrl("slack", request)!;
}

export function buildTelegramWebhookUrl(request?: Request): string {
  return buildChannelWebhookUrl("telegram", request)!;
}

export function buildDiscordPublicWebhookUrl(request?: Request): string {
  return buildChannelWebhookUrl("discord", request)!;
}

export function createTelegramWebhookSecret(): string {
  return randomBytes(24).toString("base64url");
}

export async function getPublicChannelState(
  request: Request,
  meta?: SingleMeta,
): Promise<PublicChannelState> {
  const resolvedMeta = meta ?? (await getInitializedMeta());

  // Display URLs (without bypass secret) — safe for admin-visible state.
  // Resolved once and threaded through to both public state and connectability.
  const slackDisplayUrl = buildChannelDisplayWebhookUrl("slack", request)!;
  const telegramDisplayUrl = buildChannelDisplayWebhookUrl("telegram", request)!;
  const discordDisplayUrl = buildChannelDisplayWebhookUrl("discord", request)!;

  // Single contract + single connectability map — no redundant builds.
  const contract = await buildDeploymentContract({ request });
  const [connectability, slackInstallConfig, slackApp] = await Promise.all([
    buildChannelConnectabilityMap(request, {
      shared: { contract },
      webhookUrlOverrides: {
        slack: slackDisplayUrl,
        telegram: telegramDisplayUrl,
        discord: discordDisplayUrl,
      },
    }),
    getSlackInstallConfig(),
    getSlackAppConfig().catch(() => null),
  ]);

  logDebug("public_channel_state.built", {
    contractSource: "fresh",
    channels: (["slack", "telegram", "discord", "whatsapp"] as const).map(
      (ch) => `${ch}:${connectability[ch].status}`,
    ),
  });

  return {
    slack: toPublicSlackState(
      resolvedMeta.channels.slack,
      slackDisplayUrl,
      connectability.slack,
      slackInstallConfig,
      slackApp,
    ),
    telegram: toPublicTelegramState(
      resolvedMeta.channels.telegram,
      telegramDisplayUrl,
      connectability.telegram,
    ),
    discord: toPublicDiscordState(
      resolvedMeta.channels.discord,
      discordDisplayUrl,
      isPublicUrl(discordDisplayUrl),
      connectability.discord,
    ),
    whatsapp: toPublicWhatsAppState(
      resolvedMeta.channels.whatsapp,
      connectability.whatsapp,
    ),
  };
}

export async function setSlackChannelConfig(
  config: SlackChannelConfig | null,
): Promise<SingleMeta> {
  return withChannelConfigLease("slack", async (lease) => {
    return lease.mutateMeta((meta) => {
      if (!config) {
        meta.channels.slack = null;
        return;
      }
      const previousGeneration = meta.channels.slack?.configuredAt ?? 0;
      meta.channels.slack = {
        ...config,
        configuredAt: Math.max(config.configuredAt, previousGeneration + 1),
      };
    });
  });
}

export async function setTelegramChannelConfig(
  config: TelegramChannelConfig | null,
): Promise<SingleMeta> {
  return withChannelConfigLease("telegram", (lease) =>
    setTelegramChannelConfigUnderLease(lease, config),
  );
}

export async function setTelegramChannelConfigUnderLease(
  lease: ChannelConfigLease,
  config: TelegramChannelConfig | null,
): Promise<SingleMeta> {
  return lease.mutateMeta((meta) => {
    meta.channels.telegram = config;
  });
}

export async function setDiscordChannelConfig(
  config: DiscordChannelConfig | null,
): Promise<SingleMeta> {
  return mutateMeta((meta) => {
    meta.channels.discord = config;
  });
}

export async function setWhatsAppChannelConfig(
  config: WhatsAppChannelConfig | null,
): Promise<SingleMeta> {
  return mutateMeta((meta) => {
    meta.channels.whatsapp = config;
  });
}

function toPublicSlackState(
  config: SlackChannelConfig | null,
  webhookUrl: string,
  connectability: ChannelConnectability,
  installConfig: Awaited<ReturnType<typeof getSlackInstallConfig>>,
  app: Awaited<ReturnType<typeof getSlackAppConfig>>,
): PublicSlackState {
  return {
    configured: config !== null,
    webhookUrl,
    configuredAt: config?.configuredAt ?? null,
    team: config?.team ?? null,
    user: config?.user ?? null,
    botId: config?.botId ?? null,
    hasSigningSecret: Boolean(config?.signingSecret),
    hasBotToken: Boolean(config?.botToken),
    lastError: config?.lastError ?? null,
    connectability,
    installMethod: installConfig.enabled ? "oauth" : "manual",
    installUrl: installConfig.enabled ? "/api/channels/slack/install" : null,
    appCredentialsConfigured: installConfig.enabled,
    appCredentialsSource: installConfig.source,
    appId: app?.appId ?? null,
    appName: app?.appName ?? null,
    appCreatedAt: app?.createdAt ?? null,
    projectScope: app?.projectScope ?? null,
    projectName: app?.projectName ?? null,
  };
}

function toPublicTelegramState(
  config: TelegramChannelConfig | null,
  webhookUrl: string,
  connectability: ChannelConnectability,
): PublicTelegramState {
  const status =
    config?.lastError ? "error" : config ? "connected" : "disconnected";

  return {
    configured: config !== null,
    webhookUrl: config ? webhookUrl : null,
    botUsername: config?.botUsername ?? null,
    configuredAt: config?.configuredAt ?? null,
    lastError: config?.lastError ?? null,
    status,
    commandSyncStatus: config?.commandSyncStatus ?? "unsynced",
    commandsRegisteredAt: config?.commandsRegisteredAt ?? null,
    commandSyncError: config?.commandSyncError ?? null,
    connectability,
  };
}

function toPublicDiscordState(
  config: DiscordChannelConfig | null,
  webhookUrl: string,
  publicUrl: boolean,
  connectability: ChannelConnectability,
): PublicDiscordState {
  const inviteUrl =
    config?.applicationId
      ? `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(config.applicationId)}&scope=bot+applications.commands&permissions=3072`
      : null;
  const currentEndpointUrl = toDisplaySafeWebhookUrl(config?.endpointUrl ?? null);
  const compareWebhookUrl = toDisplaySafeWebhookUrl(webhookUrl) ?? webhookUrl;
  const endpointDrift = Boolean(
    currentEndpointUrl && currentEndpointUrl !== compareWebhookUrl,
  );
  const endpointConfigured = config?.endpointConfigured === true && !endpointDrift;
  const commandRegistered = config?.commandRegistered === true;
  const canRepairEndpoint = Boolean(config && publicUrl && endpointDrift);
  const nextSafeAction: PublicDiscordState["nextSafeAction"] = !config
    ? "paste-token"
    : endpointDrift
      ? "repair-endpoint"
      : !endpointConfigured
        ? "configure-endpoint"
        : !commandRegistered
          ? "register-command"
          : inviteUrl
            ? "run-ask-test"
            : "invite-bot";

  return {
    configured: config !== null,
    webhookUrl,
    desiredEndpointUrl: compareWebhookUrl,
    currentEndpointUrl,
    endpointDrift,
    canRepairEndpoint,
    nextSafeAction,
    applicationId: config?.applicationId ?? null,
    publicKey: config?.publicKey ?? null,
    configuredAt: config?.configuredAt ?? null,
    appName: config?.appName ?? null,
    botUsername: config?.botUsername ?? null,
    endpointConfigured,
    endpointUrl: currentEndpointUrl,
    endpointError: config?.endpointError ?? null,
    commandRegistered,
    commandId: config?.commandId ?? null,
    inviteUrl,
    isPublicUrl: publicUrl,
    connectability,
  };
}

function toPublicWhatsAppState(
  config: WhatsAppChannelConfig | null,
  connectability: ChannelConnectability,
): PublicWhatsAppState {
  return {
    // Any persisted legacy config stays visible solely so operators can
    // remove it, regardless of its former enabled flag.
    configured: config !== null,
    mode: connectability.mode,
    webhookUrl: null,
    status: config ? "disconnected" : "unconfigured",
    configuredAt: config?.configuredAt ?? null,
    displayName: null,
    linkedPhone: null,
    lastError: config?.lastError ?? null,
    requiresRunningSandbox: false,
    loginVia: null,
    connectability,
  };
}
