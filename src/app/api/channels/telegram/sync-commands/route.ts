import { ApiError } from "@/shared/http";
import { authJsonError, authJsonOk, requireJsonRouteAuth } from "@/server/auth/route-auth";
import { setTelegramChannelConfigUnderLease } from "@/server/channels/state";
import { withChannelConfigLease } from "@/server/channels/config-lock";
import { syncTelegramCommands } from "@/server/channels/telegram/commands";
import { getInitializedMeta } from "@/server/store/store";

export async function POST(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    return await withChannelConfigLease("telegram", async (lease) => {
      const meta = await getInitializedMeta();
      const config = meta.channels.telegram;
      if (!config) {
        throw new ApiError(409, "TELEGRAM_NOT_CONFIGURED", "Telegram is not configured.");
      }

      try {
        const commands = await syncTelegramCommands(config.botToken, {
          signal: lease.signal,
        });
        const now = Date.now();

        await setTelegramChannelConfigUnderLease(lease, {
          ...config,
          commandSyncStatus: "synced",
          commandsRegisteredAt: now,
          commandSyncError: undefined,
        });

        return authJsonOk(
          {
            ok: true,
            commandCount: commands.length,
          },
          auth,
        );
      } catch (error) {
        await setTelegramChannelConfigUnderLease(lease, {
          ...config,
          commandSyncStatus: "error",
          commandSyncError: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  } catch (error) {
    return authJsonError(error, auth);
  }
}
