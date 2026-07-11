import {
  normalizeChannelLastForward,
  normalizeChannelUserVisibleReply,
  type ChannelLastForward,
  type ChannelLastForwardInput,
  type ChannelName,
  type ChannelUserVisibleReply,
} from "@/shared/channels";
import {
  applyUserVisibleReplyToChannelDelivery,
  channelDeliveryFromLastForward,
  closeChannelDeliverySnapshot,
  type ChannelDeliveryClosedOutcome,
} from "@/shared/channel-delivery";
import { logInfo, logWarn } from "@/server/log";
import { mutateMeta } from "@/server/store/store";

/**
 * Persist most-recent forward outcome to `meta.channelDiagnostics.<ch>.
 * lastForward` so /api/channels/summary, /api/admin/why-not-ready, and
 * channel UI panels can surface ongoing delivery health (distinct from
 * the one-shot config-sync state).
 *
 * Both the Slack fast path (POST /api/channels/slack/webhook → direct
 * fetch) and the workflow path (drainChannelWorkflow → forwardToNative
 * HandlerWithRetry) call this. Writes are best-effort: failure does not
 * abort delivery.
 */
export async function recordChannelLastForward(
  channel: ChannelName,
  forward: ChannelLastForwardInput,
  options: { closedOutcome?: ChannelDeliveryClosedOutcome } = {},
): Promise<void> {
  const normalizedForward = normalizeChannelLastForward(forward);
  if (!normalizedForward) {
    logWarn("channels.last_forward_invalid", {
      channel,
      deliveryId: forward.deliveryId,
    });
    return;
  }

  const projectedDeliveryState = channelDeliveryFromLastForward({
    channel,
    lastForward: normalizedForward,
  });
  const lastDeliveryState = options.closedOutcome
    ? closeChannelDeliverySnapshot({
        current: projectedDeliveryState,
        channel,
        deliveryId: normalizedForward.deliveryId,
        outcome: options.closedOutcome,
        reason:
          options.closedOutcome === "unknown"
            ? "native-delivery-outcome-unknown"
            : `terminal_${normalizedForward.classification}`,
        now: normalizedForward.completedAt,
      })
    : projectedDeliveryState;

  let preservedStrongerEvidence = false;
  try {
    await mutateMeta((next) => {
      if (!next.channelDiagnostics) next.channelDiagnostics = {};
      const currentEntry = next.channelDiagnostics[channel];
      const currentDelivery = currentEntry?.lastDeliveryState;
      const sameDelivery =
        currentDelivery?.deliveryId === normalizedForward.deliveryId;
      const preserveObserved =
        sameDelivery && currentDelivery?.state === "reply-observed";
      const preserveUnknown =
        sameDelivery &&
        currentDelivery?.state === "visibility-unknown" &&
        !normalizedForward.ok;
      if (preserveObserved || preserveUnknown) {
        // A later retry can prove acceptance/reply, but rejection cannot undo
        // earlier evidence that this exact delivery may have reached the user.
        preservedStrongerEvidence = true;
        return;
      }
      next.channelDiagnostics[channel] = {
        ...currentEntry,
        lastForward: normalizedForward,
        lastDeliveryState,
      };
    });
    if (preservedStrongerEvidence) {
      logInfo("channels.forward_outcome_weaker_evidence_ignored", {
        channel,
        deliveryId: normalizedForward.deliveryId,
        classification: normalizedForward.classification,
      });
      return;
    }
    logInfo("channels.forward_outcome", {
      channel,
      ok: normalizedForward.ok,
      classification: normalizedForward.classification,
      attempts: normalizedForward.attempts,
      totalMs: normalizedForward.totalMs,
      sandboxUrl: normalizedForward.sandboxUrl,
      sandboxId: normalizedForward.sandboxId,
      transport: normalizedForward.transport,
      deliveryId: normalizedForward.deliveryId,
      userVisibleReplyStatus: normalizedForward.userVisibleReply.status,
      userVisibleReplySource: normalizedForward.userVisibleReply.source,
      closedOutcome: options.closedOutcome ?? null,
    });
  } catch (err) {
    logWarn("channels.last_forward_persist_failed", {
      channel,
      error: err instanceof Error ? err.message : String(err),
      deliveryId: normalizedForward.deliveryId,
    });
  }
}

export async function recordChannelDeliveryClosedOutcome(input: {
  channel: ChannelName;
  deliveryId: string | null;
  outcome: ChannelDeliveryClosedOutcome;
  reason: string;
}): Promise<void> {
  try {
    await mutateMeta((next) => {
      const currentEntry = next.channelDiagnostics?.[input.channel];
      if (!next.channelDiagnostics) next.channelDiagnostics = {};
      next.channelDiagnostics[input.channel] = {
        ...currentEntry,
        lastDeliveryState: closeChannelDeliverySnapshot({
          current: currentEntry?.lastDeliveryState,
          channel: input.channel,
          deliveryId: input.deliveryId,
          outcome: input.outcome,
          reason: input.reason,
        }),
      };
    });
    logInfo("channels.delivery_closed", {
      channel: input.channel,
      deliveryId: input.deliveryId,
      outcome: input.outcome,
      reason: input.reason,
    });
  } catch (error) {
    logWarn("channels.delivery_close_persist_failed", {
      channel: input.channel,
      deliveryId: input.deliveryId,
      outcome: input.outcome,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function recordChannelUserVisibleReply(
  channel: ChannelName,
  deliveryId: string | null,
  userVisibleReply: ChannelUserVisibleReply,
): Promise<boolean> {
  let updated = false;
  try {
    await mutateMeta((next) => {
      const currentEntry = next.channelDiagnostics?.[channel];
      const current = currentEntry?.lastForward;
      if (!current || current.deliveryId !== deliveryId) return;
      const normalizedReply = normalizeChannelUserVisibleReply(userVisibleReply);
      if (!normalizedReply) return;
      const updatedForward: ChannelLastForward = {
        ...current,
        userVisibleReply: normalizedReply,
      };
      const updatedDeliveryState = applyUserVisibleReplyToChannelDelivery({
        current: currentEntry?.lastDeliveryState ?? null,
        channel,
        deliveryId,
        userVisibleReply: normalizedReply,
        fallbackLastForward: updatedForward,
      });
      if (!next.channelDiagnostics) next.channelDiagnostics = {};
      next.channelDiagnostics[channel] = {
        ...currentEntry,
        lastForward: updatedForward,
        ...(updatedDeliveryState ? { lastDeliveryState: updatedDeliveryState } : {}),
      };
      updated = true;
    });
  } catch (err) {
    logWarn("channels.user_visible_reply_persist_failed", {
      channel,
      deliveryId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return updated;
}
