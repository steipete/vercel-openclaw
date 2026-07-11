import type { ChannelLastForward } from "@/shared/channels";
import type { ChannelDeliverySnapshot } from "@/shared/channel-delivery";
import {
  type ChannelUserVisibleReplySummary,
  type DiscordSummaryEntry,
  type ChannelSummaryEntry,
  type ChannelSummaryResponse,
  type SlackSummaryEntry,
  type WhatsAppSummaryEntry,
  WHATSAPP_CONNECTION_SEMANTICS,
  WHATSAPP_SUMMARY_DETAIL_ROUTE,
  projectChannelDeliveryState,
  projectChannelLastForward,
} from "@/shared/channel-summary";
import { requireJsonRouteAuth } from "@/server/auth/route-auth";
import { logError, logInfo } from "@/server/log";
import { getInitializedMeta } from "@/server/store/store";
import {
  buildChannelDisplayWebhookUrl,
  toDisplaySafeWebhookUrl,
} from "@/server/channels/webhook-urls";
import { jsonError } from "@/shared/http";
import { getHostedFeatureSupportMatrix } from "@/shared/hosted-feature-support";

function projectReplyFromDelivery(
  reply: ChannelDeliverySnapshot["reply"] | null | undefined,
  now: number,
): ChannelUserVisibleReplySummary | null {
  if (!reply) return null;
  return {
    ...reply,
    ageMs: Math.max(0, now - reply.checkedAt),
  };
}

function buildSummaryEntry(
  channel: "telegram" | "discord",
  configured: boolean,
  lastError: string | null,
  lastForward: ChannelLastForward | null | undefined,
  lastDeliveryState: ChannelDeliverySnapshot | null | undefined,
  now: number,
): ChannelSummaryEntry {
  const lastForwardSummary = projectChannelLastForward(lastForward, now);
  const lastDeliverySummary = projectChannelDeliveryState(
    lastDeliveryState,
    lastForward,
    channel,
    now,
  );
  return {
    connected: configured,
    configured,
    lastError,
    lastForward: lastForwardSummary,
    lastDeliveryState: lastDeliverySummary,
    userVisibleReply:
      lastForwardSummary?.userVisibleReply ??
      projectReplyFromDelivery(lastDeliverySummary?.reply, now),
  };
}

function buildSlackSummaryEntry(
  config:
    | {
        lastError?: string;
        liveConfigSync?: {
          outcome: "skipped" | "applied" | "degraded" | "failed";
          reason: string;
          liveConfigFresh: boolean;
          checkedAt: number;
          operatorMessage?: string | null;
        };
      }
    | null
    | undefined,
  lastForward: ChannelLastForward | null | undefined,
  lastDeliveryState: ChannelDeliverySnapshot | null | undefined,
  now: number,
): SlackSummaryEntry {
  const configured = config !== null && config !== undefined;
  const liveConfigSync = config?.liveConfigSync ?? null;
  const liveConfigFresh = liveConfigSync?.liveConfigFresh === true;
  const lastForwardSummary = projectChannelLastForward(lastForward, now);
  const lastDeliverySummary = projectChannelDeliveryState(
    lastDeliveryState,
    lastForward,
    "slack",
    now,
  );

  // Delivery readiness considers BOTH the one-shot config-sync result AND
  // ongoing forward health. Truth-table priorities:
  //   - Recently-accepted forward → ready (regardless of stale config-sync
  //     state — a forward succeeding is stronger evidence than the last
  //     config-sync result, which may be hours old).
  //   - Recently-broken forward → not ready, with a specific live reason.
  //   - No recent forward yet → fall back to config-sync state.
  // Five minutes of "recent" is long enough that conversational chat
  // delivers ready=true continuously, and short enough that a freshly
  // suspended sandbox surfaces as not-ready quickly.
  const RECENT_FORWARD_WINDOW_MS = 5 * 60 * 1000;
  const recentBrokenForward =
    lastForwardSummary !== null &&
    lastForwardSummary.ok === false &&
    lastForwardSummary.ageMs < RECENT_FORWARD_WINDOW_MS &&
    (lastForwardSummary.classification === "sandbox-not-listening" ||
      lastForwardSummary.classification === "handler-not-ready" ||
      lastForwardSummary.classification === "exhausted");
  const recentlyAcceptedForward =
    lastForwardSummary !== null &&
    lastForwardSummary.ok === true &&
    lastForwardSummary.classification === "accepted" &&
    lastForwardSummary.ageMs < RECENT_FORWARD_WINDOW_MS;

  const deliveryReady =
    configured &&
    !recentBrokenForward &&
    (recentlyAcceptedForward || liveConfigFresh);

  // Reason precedence:
  //   1. Live failure mode (broken forward) — operator wants the real cause.
  //   2. Recently-accepted forward — operator sees the green signal even if
  //      the historical config-sync record was failed.
  //   3. Fall back to liveConfigSync's reason.
  //   4. Generic "not yet verified" sentinel when configured but never seen.
  let reason: string | null;
  if (recentBrokenForward && lastForwardSummary) {
    reason = `last_forward_${lastForwardSummary.classification}`;
  } else if (recentlyAcceptedForward) {
    reason = null;
  } else if (liveConfigSync?.reason) {
    reason = liveConfigSync.reason;
  } else {
    reason = configured ? "slack_delivery_not_verified" : null;
  }

  return {
    connected: configured,
    configured,
    lastError: config?.lastError ?? null,
    lastForward: lastForwardSummary,
    lastDeliveryState: lastDeliverySummary,
    userVisibleReply:
      lastForwardSummary?.userVisibleReply ??
      projectReplyFromDelivery(lastDeliverySummary?.reply, now),
    deliveryReady,
    routeReady: deliveryReady,
    liveConfigFresh,
    readiness: {
      configSyncOutcome: liveConfigSync?.outcome ?? null,
      reason,
      checkedAt: liveConfigSync?.checkedAt ?? null,
      operatorMessage: liveConfigSync?.operatorMessage ?? null,
      sandboxPath: "/slack/events",
      lastForward: lastForwardSummary,
      lastDeliveryState: lastDeliverySummary,
      userVisibleReply:
        lastForwardSummary?.userVisibleReply ??
        projectReplyFromDelivery(lastDeliverySummary?.reply, now),
      userVisibleReplyVerified:
        (lastForwardSummary?.userVisibleReply.status ?? lastDeliverySummary?.reply?.status) === "observed",
    },
  };
}

function buildWhatsAppSummaryEntry(
  config: object | null | undefined,
): WhatsAppSummaryEntry {
  const entry: WhatsAppSummaryEntry = {
    connected: false,
    configured: false,
    legacyConfigPresent: config != null,
    linkState: "unconfigured",
    lastError: null,
    lastForward: null,
    lastDeliveryState: null,
    userVisibleReply: null,
    connectionSemantics: WHATSAPP_CONNECTION_SEMANTICS,
    detailRoute: WHATSAPP_SUMMARY_DETAIL_ROUTE,
    deliveryMode: "unsupported",
    requiresRunningSandbox: false,
  };

  if (entry.legacyConfigPresent) {
    logInfo("channels.whatsapp_summary_projected", {
      legacyConfigPresent: true,
      configured: entry.configured,
      connected: entry.connected,
      linkState: entry.linkState,
      lastError: entry.lastError,
      connectionSemantics: entry.connectionSemantics,
      detailRoute: entry.detailRoute,
      deliveryMode: entry.deliveryMode,
      requiresRunningSandbox: entry.requiresRunningSandbox,
    });
  }

  return entry;
}

function buildDiscordSummaryEntry(
  config:
    | {
        endpointConfigured?: boolean;
        endpointUrl?: string;
        endpointError?: string;
        commandRegistered?: boolean;
        commandId?: string;
      }
    | null
    | undefined,
  desiredEndpointUrl: string,
  lastForward: ChannelLastForward | null | undefined,
  lastDeliveryState: ChannelDeliverySnapshot | null | undefined,
  now: number,
): DiscordSummaryEntry {
  const legacyConfigPresent = config !== null && config !== undefined;
  const lastForwardSummary = projectChannelLastForward(lastForward, now);
  const lastDeliverySummary = projectChannelDeliveryState(
    lastDeliveryState,
    lastForward,
    "discord",
    now,
  );
  const userVisibleReply =
    lastForwardSummary?.userVisibleReply ??
    projectReplyFromDelivery(lastDeliverySummary?.reply, now);
  const nativeAccepted = false;
  const userVisibleReplyVerified = false;
  const endpointConfigured = false;
  const currentEndpointUrl = toDisplaySafeWebhookUrl(config?.endpointUrl ?? null);
  const compareDesiredEndpointUrl = toDisplaySafeWebhookUrl(desiredEndpointUrl) ?? desiredEndpointUrl;
  const endpointDrift = Boolean(
    currentEndpointUrl &&
      (currentEndpointUrl !== compareDesiredEndpointUrl ||
        config?.endpointError?.toLowerCase().includes("different deployment") === true),
  );
  const commandRegistered = false;
  const reason = "hosted_discord_transport_unavailable";

  return {
    connected: false,
    configured: false,
    lastError: legacyConfigPresent ? reason : null,
    lastForward: lastForwardSummary,
    lastDeliveryState: lastDeliverySummary,
    userVisibleReply,
    endpointConfigured,
    desiredEndpointUrl: compareDesiredEndpointUrl,
    currentEndpointUrl,
    endpointDrift,
    commandRegistered,
    commandId: config?.commandId ?? null,
    routeReady: false,
    nativeAccepted,
    userVisibleReplyVerified,
    readiness: {
      endpointConfigured,
      endpointDrift,
      commandRegistered,
      routeReady: false,
      nativeAccepted,
      userVisibleReplyVerified,
      ackSemantics: "deferred-only",
      lastForward: lastForwardSummary,
      lastDeliveryState: lastDeliverySummary,
      userVisibleReply,
      reason,
    },
  };
}

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const meta = await getInitializedMeta();
    const now = Date.now();
    const diag = meta.channelDiagnostics ?? {};
    const discordDisplayWebhookUrl = buildChannelDisplayWebhookUrl("discord", request)!;

    const body: ChannelSummaryResponse = {
      featureSupport: getHostedFeatureSupportMatrix(),
      slack: buildSlackSummaryEntry(
        meta.channels.slack,
        diag.slack?.lastForward ?? null,
        diag.slack?.lastDeliveryState ?? null,
        now,
      ),
      telegram: buildSummaryEntry(
        "telegram",
        meta.channels.telegram !== null,
        meta.channels.telegram?.lastError ?? null,
        diag.telegram?.lastForward ?? null,
        diag.telegram?.lastDeliveryState ?? null,
        now,
      ),
      discord: buildDiscordSummaryEntry(
        meta.channels.discord,
        discordDisplayWebhookUrl,
        diag.discord?.lastForward ?? null,
        diag.discord?.lastDeliveryState ?? null,
        now,
      ),
      whatsapp: buildWhatsAppSummaryEntry(
        meta.channels.whatsapp,
      ),
    };

    const response = Response.json(body);
    if (auth.setCookieHeader) {
      response.headers.append("Set-Cookie", auth.setCookieHeader);
    }
    return response;
  } catch (error) {
    logError("channels.summary_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonError(error);
  }
}
