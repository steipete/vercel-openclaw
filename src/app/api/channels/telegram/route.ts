import { ApiError } from "@/shared/http";
import { createChannelAdminRouteHandlers } from "@/server/channels/admin/route-factory";
import { getMe, getWebhookInfo, deleteWebhook, setWebhook } from "@/server/channels/telegram/bot-api";
import { syncTelegramCommands } from "@/server/channels/telegram/commands";
import {
  buildTelegramWebhookUrl,
  createTelegramWebhookSecret,
  setTelegramChannelConfigUnderLease,
} from "@/server/channels/state";
import { withChannelConfigLease } from "@/server/channels/config-lock";
import { getInitializedMeta } from "@/server/store/store";
import { logWarn } from "@/server/log";

const PREVIOUS_SECRET_GRACE_MS = 30 * 60 * 1000;

function parseBotToken(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(400, "INVALID_BOT_TOKEN", "botToken must be a non-empty string");
  }

  return value.trim();
}

export const { GET, PUT, DELETE } = createChannelAdminRouteHandlers({
  channel: "telegram",

  selectState(fullState) {
    return fullState.telegram;
  },

  async get({ state, url, meta }) {
    if (url.searchParams.get("diagnostics") !== "1" || !meta.channels.telegram?.botToken) {
      return state;
    }

    const webhookInfo = await getWebhookInfo(meta.channels.telegram.botToken).catch(() => null);
    return { ...state, webhookInfo };
  },

  async put({ request, assertMutationOwned }) {
    await withChannelConfigLease("telegram", async (lease) => {
      const body = (await request.json()) as { botToken?: unknown };
      const botToken = parseBotToken(body.botToken);
      const bot = await getMe(botToken, { signal: lease.signal });

      const current = (await getInitializedMeta()).channels.telegram;
      const botId = String(bot.id);
      const sameBotIdentity = Boolean(
        current &&
          (current.botId
            ? current.botId === botId
            : current.botToken === botToken),
      );
      const previousDeliveryNamespace = current
        ? current.deliveryNamespace ??
          (current.botId
            ? `bot:${current.botId}`
            : `legacy:${current.botUsername || "unknown"}:${current.configuredAt}`)
        : null;
      const deliveryNamespace =
        sameBotIdentity && previousDeliveryNamespace
          ? previousDeliveryNamespace
          : `bot:${botId}`;
      const webhookSecret = createTelegramWebhookSecret();
      const webhookUrl = buildTelegramWebhookUrl(request);

      await assertMutationOwned();
      await setWebhook(botToken, webhookUrl, webhookSecret, {
        signal: lease.signal,
      });

      const now = Date.now();
      let commandSyncStatus: "synced" | "error" = "synced";
      let commandSyncError: string | undefined;
      let commandsRegisteredAt: number | undefined = now;

      try {
        await assertMutationOwned();
        await syncTelegramCommands(botToken, { signal: lease.signal });
      } catch (error) {
        commandSyncStatus = "error";
        commandSyncError = error instanceof Error ? error.message : String(error);
        commandsRegisteredAt = undefined;
      }

      const configuredAt = Math.max(now, (current?.configuredAt ?? 0) + 1);
      const inheritedCleanups = current?.pendingWebhookCleanups ?? [];
      const pendingWebhookCleanups =
        current?.botToken && !sameBotIdentity
          ? [
              ...inheritedCleanups,
              {
                botToken: current.botToken,
                botId: current.botId,
                requestedAt: now,
              },
            ]
          : inheritedCleanups;
      await assertMutationOwned();
      await setTelegramChannelConfigUnderLease(lease, {
        botToken,
        botId,
        deliveryNamespace,
        webhookSecret,
        previousWebhookSecret: sameBotIdentity
          ? current?.webhookSecret
          : undefined,
        previousSecretExpiresAt: sameBotIdentity && current?.webhookSecret
          ? now + PREVIOUS_SECRET_GRACE_MS
          : undefined,
        previousBotId: sameBotIdentity ? botId : undefined,
        previousDeliveryNamespace: sameBotIdentity
          ? previousDeliveryNamespace ?? undefined
          : undefined,
        previousBotUsername: sameBotIdentity
          ? current?.botUsername
          : undefined,
        previousConfiguredAt: sameBotIdentity
          ? current?.configuredAt
          : undefined,
        webhookUrl,
        botUsername: bot.username ?? "",
        configuredAt,
        pendingWebhookCleanups:
          pendingWebhookCleanups.length > 0
            ? pendingWebhookCleanups
            : undefined,
        commandSyncStatus,
        commandsRegisteredAt,
        commandSyncError,
      });

      for (const cleanup of pendingWebhookCleanups) {
        try {
          await assertMutationOwned();
          await deleteWebhook(cleanup.botToken, { signal: lease.signal });
          await lease.mutateMeta((meta) => {
            if (meta.channels.telegram?.configuredAt !== configuredAt) return;
            const remaining =
              meta.channels.telegram.pendingWebhookCleanups?.filter(
                (candidate) => candidate.botToken !== cleanup.botToken,
              ) ?? [];
            meta.channels.telegram.pendingWebhookCleanups =
              remaining.length > 0 ? remaining : undefined;
          });
        } catch (error) {
          logWarn("channels.telegram_old_webhook_cleanup_pending", {
            botId: cleanup.botId ?? null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });
  },

  async delete({ assertMutationOwned }) {
    await withChannelConfigLease("telegram", async (lease) => {
      let current = (await getInitializedMeta()).channels.telegram;
      if (current) {
        const pendingMeta = await lease.mutateMeta((meta) => {
          if (!meta.channels.telegram) return;
          meta.channels.telegram.deletionPending = true;
          meta.channels.telegram.lastError =
            "Telegram disconnect cleanup is pending.";
        });
        current = pendingMeta.channels.telegram;
      }
      const cleanupTokens = current
        ? [
            current.botToken,
            ...(current.pendingWebhookCleanups?.map(
              (cleanup) => cleanup.botToken,
            ) ?? []),
          ]
        : [];
      for (const cleanupToken of new Set(cleanupTokens)) {
        await assertMutationOwned();
        await deleteWebhook(cleanupToken, { signal: lease.signal });
      }
      await assertMutationOwned();
      await setTelegramChannelConfigUnderLease(lease, null);
    });
  },
});
