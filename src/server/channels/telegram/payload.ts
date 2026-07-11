function extractTelegramMessage(update: unknown): Record<string, unknown> | null {
  if (!update || typeof update !== "object") return null;
  const payload = update as Record<string, unknown>;
  const message =
    payload.message ?? payload.edited_message ?? payload.channel_post;
  return message && typeof message === "object"
    ? (message as Record<string, unknown>)
    : null;
}

export function extractTelegramChatId(update: unknown): string | null {
  const message = extractTelegramMessage(update);
  const chat = message?.chat;
  if (!chat || typeof chat !== "object") return null;
  const chatId = (chat as Record<string, unknown>).id;
  return typeof chatId === "number" ? String(chatId) : null;
}

export function extractTelegramThreadId(update: unknown): number | null {
  const threadId = extractTelegramMessage(update)?.message_thread_id;
  return typeof threadId === "number" ? threadId : null;
}
