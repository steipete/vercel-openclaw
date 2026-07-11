import type { ChannelLastForward, ChannelName } from "@/shared/channels";
import type { LogEntry, SingleMeta } from "@/shared/types";
import { filterLogEntries, getServerLogs } from "@/server/log";
import { getInitializedMeta } from "@/server/store/store";

const RECENT_FORWARD_WINDOW_MS = 5 * 60 * 1000;
const RECENT_LOG_LIMIT = 50;
const RELEVANT_LOG_PREFIXES = ["channels.", "sandbox.", "gateway.", "proxy."] as const;

export type Blocker = {
  kind:
    | "no_credentials"
    | "endpoint_missing"
    | "endpoint_drift"
    | "command_missing"
    | "public_url_unusable"
    | "config_sync_failed"
    | "stale_port_url"
    | "handler_not_ready"
    | "sandbox_not_listening"
    | "gateway_restarting"
    | "sandbox_not_running"
    | "lock_held";
  detail: string;
  evidence: Record<string, unknown>;
  firstObservedAt: number;
  suggestedAction: string | null;
};

export type ObservabilityGap = {
  kind:
    | "deferred_ack_without_native_forward"
    | "native_accepted_without_user_visible_reply"
    | "user_visible_reply_unknown"
    | "user_visible_reply_timed_out";
  detail: string;
  evidence: Record<string, unknown>;
  firstObservedAt: number;
  suggestedAction: string | null;
};

export type ChannelReport = {
  hostedDeliverySupported: boolean;
  ready: boolean;
  blockers: Blocker[];
  observabilityGaps: ObservabilityGap[];
  readinessSnapshot: {
    liveConfigSync: unknown;
    lastForward: unknown;
    userVisibleReply: unknown;
    sandboxId: string | null;
    portUrls: Record<string, string> | null;
  };
};

export type WhyNotReadyResponse = {
  asOf: number;
  channels: {
    slack: ChannelReport;
    telegram: ChannelReport;
    discord: ChannelReport;
    whatsapp: ChannelReport;
  };
  sandbox: {
    status: string;
    sandboxId: string | null;
    portUrls: Record<string, string> | null;
  };
  locks: Record<string, unknown>;
  recentLogs: unknown[];
};

function isRecentForwardOk(
  forward: ChannelLastForward | null | undefined,
  now: number,
): boolean {
  if (!forward) return false;
  if (!forward.ok) return false;
  if (forward.classification !== "accepted") return false;
  return now - forward.completedAt < RECENT_FORWARD_WINDOW_MS;
}

function buildChannelReport(
  channel: ChannelName,
  meta: SingleMeta,
  now: number,
): ChannelReport {
  const config = meta.channels[channel];
  const lastForward = meta.channelDiagnostics?.[channel]?.lastForward ?? null;
  const slackConfig = channel === "slack" ? meta.channels.slack : null;
  const liveConfigSync = slackConfig?.liveConfigSync ?? null;

  const blockers: Blocker[] = [];
  const observabilityGaps: ObservabilityGap[] = [];

  if (config === null || config === undefined) {
    blockers.push({
      kind: "no_credentials",
      detail: `${channel} is not configured.`,
      evidence: {},
      firstObservedAt: now,
      suggestedAction: `Configure ${channel} credentials.`,
    });
  } else {
    if (channel === "discord") {
      const discordConfig = meta.channels.discord;
      if (discordConfig) {
        const endpointUrl = discordConfig.endpointUrl ?? null;
        const storedDriftWarning =
          typeof discordConfig.endpointError === "string" &&
          discordConfig.endpointError.toLowerCase().includes("different deployment");
        if (endpointUrl && (storedDriftWarning || discordConfig.endpointConfigured !== true)) {
          blockers.push({
            kind: "endpoint_drift",
            detail: "Discord interactions endpoint points at a different deployment.",
            evidence: {
              endpointConfigured: discordConfig.endpointConfigured === true,
              endpointUrl,
              endpointError: discordConfig.endpointError ?? null,
            },
            firstObservedAt: discordConfig.configuredAt,
            suggestedAction: "Use the Discord panel endpoint repair action before testing /ask.",
          });
        } else if (!endpointUrl) {
          blockers.push({
            kind: "endpoint_missing",
            detail: "Discord interactions endpoint is not configured for this deployment.",
            evidence: {
              endpointConfigured: discordConfig.endpointConfigured === true,
              endpointUrl,
            },
            firstObservedAt: discordConfig.configuredAt,
            suggestedAction: "Configure the Discord interactions endpoint from the Discord panel.",
          });
        } else if (!endpointUrl.includes("/api/channels/discord/webhook")) {
          blockers.push({
            kind: "endpoint_drift",
            detail: "Discord interactions endpoint does not point at the OpenClaw Discord webhook path.",
            evidence: { endpointUrl },
            firstObservedAt: discordConfig.configuredAt,
            suggestedAction: "Use the Discord panel endpoint repair action before testing /ask.",
          });
        }

        if (discordConfig.commandRegistered !== true) {
          blockers.push({
            kind: "command_missing",
            detail: "Discord /ask command is not registered.",
            evidence: { commandId: discordConfig.commandId ?? null },
            firstObservedAt: discordConfig.configuredAt,
            suggestedAction: "Register /ask from the Discord panel.",
          });
        }

        try {
          const endpoint = new URL(endpointUrl ?? "");
          if (endpoint.protocol !== "https:") {
            blockers.push({
              kind: "public_url_unusable",
              detail: "Discord interactions endpoint must be an HTTPS public URL.",
              evidence: { endpointUrl },
              firstObservedAt: discordConfig.configuredAt,
              suggestedAction: "Set a public HTTPS app URL before configuring Discord.",
            });
          }
        } catch {
          blockers.push({
            kind: "public_url_unusable",
            detail: "Discord interactions endpoint URL is not parseable.",
            evidence: { endpointUrl },
            firstObservedAt: discordConfig.configuredAt,
            suggestedAction: "Repair the endpoint from the Discord panel.",
          });
        }
      }
    }

    if (lastForward?.classification === "sandbox-not-listening") {
      blockers.push({
        kind: "sandbox_not_listening",
        detail: `Last ${channel} forward hit a sandbox tunnel that isn't listening.`,
        evidence: {
          sandboxUrl: lastForward.sandboxUrl,
          sandboxId: lastForward.sandboxId,
          attempts: lastForward.attempts,
          completedAt: lastForward.completedAt,
        },
        firstObservedAt: lastForward.completedAt,
        suggestedAction:
          "Refresh the sandbox port URL or wait for the watchdog to reconcile.",
      });
    }

    const finalReasonHead = lastForward?.finalReasonHead ?? "";
    const isHandlerNotReady =
      lastForward?.classification === "handler-not-ready" ||
      (lastForward?.classification === "exhausted" &&
        typeof finalReasonHead === "string" &&
        finalReasonHead.includes("Not Found"));
    if (isHandlerNotReady) {
      const evidence: Record<string, unknown> = {
        classification: lastForward?.classification,
        finalReasonHead,
        attempts: lastForward?.attempts,
      };
      if (channel === "slack") {
        evidence.sandboxPath = "/slack/events";
      }
      blockers.push({
        kind: "handler_not_ready",
        detail: `${channel} native handler did not respond ok after retries.`,
        evidence,
        firstObservedAt: lastForward?.completedAt ?? now,
        suggestedAction:
          "Wait for the gateway to mount the channel route, or trigger a config-sync.",
      });
    }

    if (
      channel === "telegram" &&
      meta.lastRestoreMetrics?.telegramExpected === true &&
      meta.lastRestoreMetrics.telegramListenerReady !== true
    ) {
      blockers.push({
        kind: "handler_not_ready",
        detail: "Telegram native listener on port 8787 was expected but not confirmed ready.",
        evidence: {
          telegramExpected: meta.lastRestoreMetrics.telegramExpected,
          telegramConfigPresent: meta.lastRestoreMetrics.telegramConfigPresent ?? null,
          telegramListenerReady: meta.lastRestoreMetrics.telegramListenerReady ?? null,
          telegramListenerStatus: meta.lastRestoreMetrics.telegramListenerStatus ?? null,
          telegramListenerError: meta.lastRestoreMetrics.telegramListenerError ?? null,
          restoreMetricsRecordedAt: meta.lastRestoreMetrics.recordedAt,
          sandboxPath: "/telegram-webhook",
          sandboxPort: 8787,
        },
        firstObservedAt: meta.lastRestoreMetrics.recordedAt,
        suggestedAction:
          "Trigger config-sync or reset the sandbox, then check gateway.route_probe and Telegram webhook startup logs.",
      });
    }

    const recentlyAccepted = isRecentForwardOk(lastForward, now);
    const userVisibleReply = lastForward?.userVisibleReply ?? null;
    if (
      channel === "discord" &&
      (lastForward === null || lastForward === undefined)
    ) {
      observabilityGaps.push({
        kind: "deferred_ack_without_native_forward",
        detail:
          "Discord may accept and defer an interaction before any native OpenClaw forward has been recorded.",
        evidence: {
          lastForward: null,
          ackSemantics: "deferred-only",
        },
        firstObservedAt: now,
        suggestedAction: "Run a real Discord /ask and inspect channels.discord_* workflow logs.",
      });
    }

    if (
      lastForward?.ok === true &&
      lastForward.classification === "accepted" &&
      userVisibleReply?.status === "unknown"
    ) {
      observabilityGaps.push({
        kind:
          channel === "discord"
            ? "native_accepted_without_user_visible_reply"
            : "user_visible_reply_unknown",
        detail: `${channel} native handler accepted the delivery, but no platform-visible OpenClaw reply was observed.`,
        evidence: {
          deliveryId: lastForward.deliveryId,
          nativeAcceptedAt: lastForward.completedAt,
          userVisibleReply,
        },
        firstObservedAt: userVisibleReply.checkedAt,
        suggestedAction:
          "Run a channel canary once platform credentials and observer support are configured.",
      });
    }
    if (userVisibleReply?.status === "timed-out") {
      observabilityGaps.push({
        kind: "user_visible_reply_timed_out",
        detail: `${channel} reply observation timed out after native acceptance.`,
        evidence: {
          deliveryId: lastForward?.deliveryId ?? null,
          userVisibleReply,
        },
        firstObservedAt: userVisibleReply.checkedAt,
        suggestedAction: "Inspect channel/platform logs and native OpenClaw reply path.",
      });
    }

    if (
      liveConfigSync?.outcome === "failed" &&
      !recentlyAccepted
    ) {
      blockers.push({
        kind: "config_sync_failed",
        detail: "Last config-sync attempt failed.",
        evidence: {
          reason: liveConfigSync.reason,
          checkedAt: liveConfigSync.checkedAt,
          operatorMessage: liveConfigSync.operatorMessage ?? null,
        },
        firstObservedAt: liveConfigSync.checkedAt,
        suggestedAction:
          "Re-run config-sync after the underlying error is addressed.",
      });
    }

    const portUrls = meta.portUrls;
    const portUrlsEmpty =
      portUrls === null ||
      portUrls === undefined ||
      Object.keys(portUrls).length === 0;
    if (
      portUrlsEmpty &&
      meta.sandboxId !== null &&
      meta.status === "running"
    ) {
      blockers.push({
        kind: "stale_port_url",
        detail: "Sandbox is running but no port URLs are cached.",
        evidence: {
          sandboxId: meta.sandboxId,
          status: meta.status,
        },
        firstObservedAt: now,
        suggestedAction: "A forward will refresh the cache; informational only.",
      });
    }
  }

  const recentlyAccepted = isRecentForwardOk(lastForward, now);
  const configSyncApplied = liveConfigSync?.outcome === "applied";
  const userVisibleReplyVerified = lastForward?.userVisibleReply?.status === "observed";
  const ready =
    blockers.length === 0 &&
    (channel === "slack"
      ? recentlyAccepted || configSyncApplied
      : channel === "discord"
        ? recentlyAccepted && userVisibleReplyVerified
        : recentlyAccepted);

  return {
    hostedDeliverySupported: true,
    ready,
    blockers,
    observabilityGaps,
    readinessSnapshot: {
      liveConfigSync,
      lastForward,
      userVisibleReply: lastForward?.userVisibleReply ?? null,
      sandboxId: meta.sandboxId,
      portUrls: meta.portUrls,
    },
  };
}

function buildUnsupportedWhatsAppReport(meta: SingleMeta): ChannelReport {
  return {
    // Unsupported hosted transport is not a readiness blocker. Legacy config
    // remains cleanup-only and must not produce configure/fix guidance.
    hostedDeliverySupported: false,
    ready: true,
    blockers: [],
    observabilityGaps: [],
    readinessSnapshot: {
      liveConfigSync: null,
      lastForward: null,
      userVisibleReply: null,
      sandboxId: meta.sandboxId,
      portUrls: meta.portUrls,
    },
  };
}

function collectRecentLogs(): LogEntry[] {
  const all = getServerLogs();
  // Filter to channel/lifecycle/proxy/gateway events.
  const relevant = filterLogEntries(all, {}).filter((entry) =>
    RELEVANT_LOG_PREFIXES.some((prefix) => entry.message.startsWith(prefix)),
  );
  return relevant.slice(-RECENT_LOG_LIMIT);
}

export async function buildWhyNotReady(
  metaArg?: SingleMeta,
): Promise<WhyNotReadyResponse> {
  const meta = metaArg ?? (await getInitializedMeta());
  const now = Date.now();

  const channels = {
    slack: buildChannelReport("slack", meta, now),
    telegram: buildChannelReport("telegram", meta, now),
    discord: buildChannelReport("discord", meta, now),
    whatsapp: buildUnsupportedWhatsAppReport(meta),
  };

  return {
    asOf: now,
    channels,
    sandbox: {
      status: meta.status,
      sandboxId: meta.sandboxId,
      portUrls: meta.portUrls,
    },
    locks: {},
    recentLogs: collectRecentLogs(),
  };
}
