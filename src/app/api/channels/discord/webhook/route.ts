import { verifyDiscordRequestSignature } from "@/server/channels/discord/adapter";
import {
  buildDiscordHostedUnavailableInteractionResponse,
} from "@/server/channels/discord/hosted-support";
import { extractRequestId, logInfo, logWarn } from "@/server/log";
import { getInitializedMeta } from "@/server/store/store";

// Retained as a test seam while hosted Discord is fail-closed. POST never
// invokes it; tests assert that invariant.
export const discordWebhookWorkflowRuntime = {
  start: workflowApi.start,
};

function extractDiscordInteractionInfo(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") {
    return { payloadKeys: [] };
  }
  const raw = payload as {
    id?: unknown;
    type?: unknown;
    application_id?: unknown;
    channel_id?: unknown;
    guild_id?: unknown;
    user?: { id?: unknown };
    member?: { user?: { id?: unknown } };
    data?: { name?: unknown };
  };
  return {
    interactionId: typeof raw.id === "string" ? raw.id : null,
    type: typeof raw.type === "number" ? raw.type : null,
    applicationId:
      typeof raw.application_id === "string" ? raw.application_id : null,
    channelId: typeof raw.channel_id === "string" ? raw.channel_id : null,
    guildId: typeof raw.guild_id === "string" ? raw.guild_id : null,
    userId:
      typeof raw.member?.user?.id === "string"
        ? raw.member.user.id
        : typeof raw.user?.id === "string"
          ? raw.user.id
          : null,
    commandName: typeof raw.data?.name === "string" ? raw.data.name : null,
    payloadKeys: Object.keys(raw).sort(),
  };
}

export async function POST(request: Request): Promise<Response> {
  const requestId = extractRequestId(request);
  const config = (await getInitializedMeta()).channels.discord;
  if (!config) {
    logWarn("channels.discord_webhook_rejected", {
      requestId,
      reason: "no_config",
    });
    return Response.json(
      {
        error: "DISCORD_NOT_CONFIGURED",
        message: "Discord is not configured.",
      },
      { status: 409 },
    );
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-signature-ed25519") ?? "";
  const timestamp = request.headers.get("x-signature-timestamp") ?? "";
  if (
    !config.publicKey ||
    !verifyDiscordRequestSignature(
      rawBody,
      signature,
      timestamp,
      config.publicKey,
    )
  ) {
    logWarn("channels.discord_webhook_signature_invalid", {
      requestId,
      hasSignature: signature.length > 0,
      hasTimestamp: timestamp.length > 0,
      bodyLength: rawBody.length,
    });
    return Response.json(
      {
        error: "DISCORD_SIGNATURE_INVALID",
        message: "Invalid Discord request signature.",
      },
      { status: 401 },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json(
      { error: "INVALID_JSON_BODY", message: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const interactionInfo = extractDiscordInteractionInfo(payload);
  if ((payload as { type?: unknown }).type === 1) {
    logInfo("channels.discord_ping_ack", { requestId, ...interactionInfo });
    return Response.json({ type: 1 });
  }

  logWarn("channels.discord_hosted_unavailable", {
    requestId,
    ...interactionInfo,
  });
  return buildDiscordHostedUnavailableInteractionResponse();
}
import * as workflowApi from "workflow/api";
