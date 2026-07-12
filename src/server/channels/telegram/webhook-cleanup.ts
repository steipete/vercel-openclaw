import { withChannelConfigLease } from "@/server/channels/config-lock";
import {
  deleteWebhook,
  TelegramApiError,
} from "@/server/channels/telegram/bot-api";
import { logWarn } from "@/server/log";
import { getInitializedMeta } from "@/server/store/store";
import { applyChannelConfigChangeUnderLifecycleLock } from "@/server/channels/admin/apply-channel-config-change";
import { withSandboxLifecycleMutationLock } from "@/server/sandbox/lifecycle";

const CLEANUP_MAX_TOKENS_PER_PASS = 2;
const CLEANUP_TOKEN_TIMEOUT_MS = 3_000;

function isTerminalCleanupCredentialError(
  error: unknown,
): error is TelegramApiError {
  return error instanceof TelegramApiError
    && [400, 401, 403, 404].includes(error.status_code);
}

export type TelegramWebhookCleanupResult = {
  attempted: number;
  cleaned: number;
  remaining: number;
  disconnected: boolean;
};

/**
 * Watchdog anti-entropy for webhook deletions persisted by replacement or
 * disconnect. The config lease makes each pass generation-safe.
 */
export async function reconcileTelegramWebhookCleanups(): Promise<TelegramWebhookCleanupResult> {
  const pass = await withChannelConfigLease("telegram", async (lease) => {
    const current = (await getInitializedMeta()).channels.telegram;
    if (!current) {
      return {
        result: { attempted: 0, cleaned: 0, remaining: 0, disconnected: false },
        finalizeGeneration: null,
      };
    }

    const pendingTokens = new Set(
      current.pendingWebhookCleanups
        ?.map((cleanup) => cleanup.botToken)
        .filter(
          (botToken) =>
            current.deletionPending || botToken !== current.botToken,
        ) ?? [],
    );
    if (current.deletionPending) pendingTokens.add(current.botToken);
    if (pendingTokens.size === 0) {
      return {
        result: { attempted: 0, cleaned: 0, remaining: 0, disconnected: false },
        finalizeGeneration: null,
      };
    }

    const cleanedTokens = new Set<string>();
    const attemptedTokens = [...pendingTokens].slice(
      0,
      CLEANUP_MAX_TOKENS_PER_PASS,
    );
    for (const botToken of attemptedTokens) {
      try {
        await deleteWebhook(botToken, {
          signal: AbortSignal.any([
            lease.signal,
            AbortSignal.timeout(CLEANUP_TOKEN_TIMEOUT_MS),
          ]),
        });
        cleanedTokens.add(botToken);
      } catch (error) {
        if (isTerminalCleanupCredentialError(error)) {
          cleanedTokens.add(botToken);
          logWarn("channels.telegram_webhook_cleanup_credential_retired", {
            botTokenOwner:
              botToken === current.botToken ? "current" : "superseded",
            statusCode: error.status_code,
          });
          continue;
        }
        logWarn("channels.telegram_webhook_cleanup_retry_failed", {
          botTokenOwner:
            botToken === current.botToken ? "current" : "superseded",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    let remaining = pendingTokens.size - cleanedTokens.size;
    let finalizeGeneration: number | null = null;
    await lease.mutateMeta((meta) => {
      const telegram = meta.channels.telegram;
      if (!telegram || telegram.configuredAt !== current.configuredAt) return;

      const nextPending = telegram.pendingWebhookCleanups?.filter(
        (cleanup) =>
          !cleanedTokens.has(cleanup.botToken) &&
          (telegram.deletionPending || cleanup.botToken !== telegram.botToken),
      );
      telegram.pendingWebhookCleanups =
        nextPending && nextPending.length > 0 ? nextPending : undefined;

      const currentWebhookCleaned = cleanedTokens.has(telegram.botToken);
      if (
        telegram.deletionPending &&
        currentWebhookCleaned &&
        !telegram.pendingWebhookCleanups?.length
      ) {
        remaining = 0;
        finalizeGeneration = telegram.configuredAt;
        return;
      }

      if (remaining > 0) {
        telegram.lastError = "Telegram webhook cleanup is pending.";
      } else if (!telegram.webhookSetupPending) {
        telegram.lastError = undefined;
      }
    });

    return {
      result: {
        attempted: attemptedTokens.length,
        cleaned: cleanedTokens.size,
        remaining,
        disconnected: false,
      },
      finalizeGeneration,
    };
  });

  if (pass.finalizeGeneration === null) return pass.result;

  return withSandboxLifecycleMutationLock(async (assertOwned) => {
    let removed = false;
    let tombstone: Awaited<ReturnType<typeof getInitializedMeta>>["channels"]["telegram"] = null;
    await withChannelConfigLease("telegram", (lease) =>
      lease.mutateMeta((meta) => {
        const telegram = meta.channels.telegram;
        if (
          !telegram ||
          telegram.configuredAt !== pass.finalizeGeneration ||
          !telegram.deletionPending ||
          telegram.pendingWebhookCleanups?.length
        ) {
          return;
        }
        tombstone = structuredClone(telegram);
        meta.channels.telegram = null;
        removed = true;
      }),
    );
    if (!removed) {
      return { ...pass.result, remaining: 1, disconnected: false };
    }

    let liveConfigSync;
    try {
      ({ liveConfigSync } =
        await applyChannelConfigChangeUnderLifecycleLock(
          { channel: "telegram", operation: "delete" },
          assertOwned,
        ));
    } catch (error) {
      await restoreTelegramDeletionTombstone(tombstone);
      throw error;
    }
    const stoppedConfigPersisted =
      liveConfigSync.outcome === "skipped"
      && liveConfigSync.reason === "sandbox_not_running";
    if (!liveConfigSync.liveConfigFresh && !stoppedConfigPersisted) {
      await restoreTelegramDeletionTombstone(tombstone);
      return { ...pass.result, remaining: 1, disconnected: false };
    }
    return { ...pass.result, remaining: 0, disconnected: true };
  });
}

async function restoreTelegramDeletionTombstone(
  tombstone: Awaited<ReturnType<typeof getInitializedMeta>>["channels"]["telegram"],
): Promise<void> {
  if (!tombstone) return;
  await withChannelConfigLease("telegram", (lease) =>
    lease.mutateMeta((meta) => {
      if (meta.channels.telegram) return;
      meta.channels.telegram = {
        ...tombstone,
        deletionPending: true,
        lastError: "Telegram disconnect cleanup is pending live config removal.",
      };
    }),
  );
}
