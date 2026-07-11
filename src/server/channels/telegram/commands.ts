import { getChannelCommandDefinitions } from "@/shared/channel-commands";
import type { ChannelCommandDefinition } from "@/shared/channel-commands";
import { setMyCommands, type TelegramBotCommand } from "@/server/channels/telegram/bot-api";

export function toTelegramBotCommands(
  defs: readonly ChannelCommandDefinition[],
): TelegramBotCommand[] {
  return defs
    .filter((def) => def.telegram.enabled)
    .map((def) => ({
      command: def.name,
      description: def.description.slice(0, 256),
    }));
}

export function getTelegramBotCommands(): TelegramBotCommand[] {
  return toTelegramBotCommands(getChannelCommandDefinitions());
}

export async function syncTelegramCommands(
  botToken: string,
  options?: { signal?: AbortSignal },
): Promise<TelegramBotCommand[]> {
  const commands = getTelegramBotCommands();
  await setMyCommands(botToken, commands, options);
  return commands;
}
