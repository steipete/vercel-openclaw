import { createHash } from "node:crypto";

import type { TelegramChannelConfig } from "@/shared/channels";
import { extractWhatsAppMessageId } from "@/server/channels/whatsapp/adapter";

/** Platform-owned identity shared by webhook diagnostics and workflow delivery. */
export function extractChannelPlatformDeliveryId(
  channel: string,
  payload: unknown,
): string | null {
  const record = payload as Record<string, unknown> | null;
  if (channel === "telegram" && typeof record?.update_id === "number") {
    return `telegram:${record.update_id}`;
  }
  if (channel === "slack") {
    const eventId = record?.event_id;
    if (typeof eventId === "string" && eventId) {
      return `slack:${eventId}`;
    }
    const event = record?.event;
    if (event && typeof event === "object" && !Array.isArray(event)) {
      const fields = event as Record<string, unknown>;
      if (typeof fields.channel === "string" && typeof fields.ts === "string") {
        return `slack:${fields.channel}:${fields.ts}`;
      }
    }
  }
  if (channel === "discord") {
    const interactionId = record?.id;
    if (typeof interactionId === "string" && interactionId) {
      return `discord:${interactionId}`;
    }
  }
  if (channel === "whatsapp") {
    const messageId = extractWhatsAppMessageId(payload);
    if (messageId) return `whatsapp:${messageId}`;
  }
  return null;
}

export function deriveChannelDeliveryId(input: {
  channel: string;
  payload: unknown;
  requestId: string | null;
  receivedAtMs: number | null;
  telegramConfig?: Pick<
    TelegramChannelConfig,
    "botUsername" | "configuredAt"
  > | null;
}): string {
  const platformId = extractChannelPlatformDeliveryId(
    input.channel,
    input.payload,
  );
  if (platformId) {
    if (input.channel === "telegram" && input.telegramConfig) {
      const generation = `${input.telegramConfig.botUsername || "unknown"}:${input.telegramConfig.configuredAt}`;
      return `telegram:${generation}:${platformId.slice("telegram:".length)}`;
    }
    return platformId;
  }

  const fallbackBody = `${input.requestId ?? ""}:${input.receivedAtMs ?? ""}:${JSON.stringify(input.payload ?? {})}`;
  const hash = createHash("sha256")
    .update(fallbackBody)
    .digest("hex")
    .slice(0, 32);
  return `${input.channel}:${hash}`;
}
