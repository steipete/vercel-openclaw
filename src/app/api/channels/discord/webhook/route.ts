import * as workflowApi from "workflow/api";

import {
  CHANNEL_DELIVERY_DEDUP_LOCK_TTL_SECONDS,
  tryAcquireChannelDedupLock,
  type ChannelDedupLock,
} from "@/server/channels/dedup";
import { recordChannelDlqFailure } from "@/server/channels/dlq";
import { getPublicOrigin } from "@/server/public-url";
import { verifyDiscordRequestSignature } from "@/server/channels/discord/adapter";
import { channelDedupKey } from "@/server/channels/keys";
import { drainChannelWorkflow } from "@/server/workflows/channels/drain-channel-workflow";
import { extractRequestId, logInfo, logWarn } from "@/server/log";
import { createOperationContext, withOperationContext } from "@/server/observability/operation-context";
import { getInitializedMeta, getStore } from "@/server/store/store";

type DiscordWebhookDedupLock = ChannelDedupLock;

type DiscordWebhookDedupReleaseResult = {
  attempted: boolean;
  released: boolean;
  releaseError: string | null;
};

const DISCORD_FORWARD_HEADERS = [
  "x-signature-ed25519",
  "x-signature-timestamp",
  "content-type",
] as const;

export const discordWebhookWorkflowRuntime = {
  start: workflowApi.start,
};

function extractInteractionId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const raw = payload as { id?: unknown };
  if (typeof raw.id === "string" && raw.id.length > 0) {
    return raw.id;
  }

  return null;
}

function collectForwardHeaders(
  request: Request,
  names: readonly string[],
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of names) {
    const value = request.headers.get(name);
    if (value) {
      headers[name] = value;
    }
  }
  return headers;
}

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
    applicationId: typeof raw.application_id === "string" ? raw.application_id : null,
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

function workflowStartFailedResponse() {
  return Response.json(
    { ok: false, error: "WORKFLOW_START_FAILED", retryable: true },
    { status: 500 },
  );
}

async function releaseDiscordWebhookDedupLockForRetry(
  lock: DiscordWebhookDedupLock | null,
): Promise<DiscordWebhookDedupReleaseResult> {
  if (!lock) {
    return { attempted: false, released: false, releaseError: null };
  }

  try {
    await getStore().releaseLock(lock.key, lock.token);
    return { attempted: true, released: true, releaseError: null };
  } catch (error) {
    return {
      attempted: true,
      released: false,
      releaseError: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function POST(request: Request): Promise<Response> {
  const receivedAtMs = Date.now();
  const requestId = extractRequestId(request);
  const meta = await getInitializedMeta();
  const config = meta.channels.discord;
  if (!config) {
    logWarn("channels.discord_webhook_rejected", {
      requestId,
      reason: "no_config",
    });
    return Response.json(
      { error: "DISCORD_NOT_CONFIGURED", message: "Discord is not configured." },
      { status: 409 },
    );
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-signature-ed25519") ?? "";
  const timestamp = request.headers.get("x-signature-timestamp") ?? "";
  if (!config.publicKey) {
    logWarn("channels.discord_webhook_rejected", {
      requestId,
      reason: "no_public_key",
      bodyLength: rawBody.length,
    });
    return Response.json(
      { error: "DISCORD_SIGNATURE_INVALID", message: "Invalid Discord request signature." },
      { status: 401 },
    );
  }
  if (!verifyDiscordRequestSignature(rawBody, signature, timestamp, config.publicKey)) {
    logWarn("channels.discord_webhook_signature_invalid", {
      requestId,
      hasSignature: signature.length > 0,
      hasTimestamp: timestamp.length > 0,
      bodyLength: rawBody.length,
    });
    return Response.json(
      { error: "DISCORD_SIGNATURE_INVALID", message: "Invalid Discord request signature." },
      { status: 401 },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    logWarn("channels.discord_webhook_rejected", {
      requestId,
      reason: "invalid_json",
      bodyLength: rawBody.length,
    });
    return Response.json(
      { error: "INVALID_JSON_BODY", message: "Invalid JSON body." },
      { status: 400 },
    );
  }

  if ((payload as { type?: unknown }).type === 1) {
    logInfo("channels.discord_ping_ack", {
      requestId,
      ...extractDiscordInteractionInfo(payload),
    });
    return Response.json({ type: 1 });
  }

  const interactionId = extractInteractionId(payload);
  let dedupLock: DiscordWebhookDedupLock | null = null;
  if (interactionId) {
    const dedupKey = channelDedupKey("discord", interactionId);
    const dedupResult = await tryAcquireChannelDedupLock({
      channel: "discord",
      key: dedupKey,
      ttlSeconds: CHANNEL_DELIVERY_DEDUP_LOCK_TTL_SECONDS,
      requestId: requestId ?? null,
      dedupId: interactionId,
    });
    if (dedupResult.kind === "duplicate") {
      logInfo("channels.discord_webhook_dedup_skip", {
        requestId,
        interactionId,
        dedupKey,
      });
      return Response.json({ type: 5 });
    }
    if (dedupResult.kind === "acquired") {
      dedupLock = dedupResult.lock;
    }
    // degraded: continue without dedup. The degraded log comes from the
    // helper; we still return type:5 (deferred) and let the workflow run.
  }

  const op = createOperationContext({
    trigger: "channel.discord.webhook",
    reason: "incoming discord webhook",
    requestId: requestId ?? null,
    channel: "discord",
    dedupId: interactionId ?? null,
    sandboxId: meta.sandboxId ?? null,
    snapshotId: meta.snapshotId ?? null,
    status: meta.status,
  });

  const discordForwardHeaders = collectForwardHeaders(
    request,
    DISCORD_FORWARD_HEADERS,
  );
  const handoffDelayMs = Date.now() - receivedAtMs;

  logInfo("channels.discord_webhook_accepted", withOperationContext(op, {
    ...extractDiscordInteractionInfo(payload),
    ackSemantics: "deferred-only",
    responseType: 5,
    forwardHeaderKeys: Object.keys(discordForwardHeaders).sort(),
  }));

  try {
    const origin = getPublicOrigin(request);
    logInfo("channels.discord_workflow_starting", withOperationContext(op, {
      handoffDelayMs,
      forwardHeaderKeys: Object.keys(discordForwardHeaders).sort(),
    }));
    await discordWebhookWorkflowRuntime.start(drainChannelWorkflow, [
      {
        version: 1,
        channel: "discord",
        payload,
        origin,
        requestId: requestId ?? null,
        receivedAtMs,
        workflowHandoff: {
          discordForwardHeaders,
          discordRawBody: rawBody,
        },
      },
    ]);
    logInfo("channels.discord_workflow_started", withOperationContext(op, {
      handoffDelayMs,
      forwardHeaderKeys: Object.keys(discordForwardHeaders).sort(),
    }));
  } catch (error) {
    const dedupRelease = await releaseDiscordWebhookDedupLockForRetry(dedupLock);
    logWarn("channels.discord_workflow_start_failed", withOperationContext(op, {
      error: error instanceof Error ? error.message : String(error),
      attemptedAction: "start_drain_channel_workflow",
      dedupLockKey: dedupLock?.key ?? null,
      dedupLockReleaseAttempted: dedupRelease.attempted,
      dedupLockReleased: dedupRelease.released,
      dedupLockReleaseError: dedupRelease.releaseError,
      retryable: true,
    }));
    const discordDeliveryId = interactionId
      ? `discord:${interactionId}`
      : `discord:request:${requestId ?? receivedAtMs}`;
    await recordChannelDlqFailure({
      channel: "discord",
      deliveryId: discordDeliveryId,
      phase: "workflow-start-failed",
      terminal: false,
      retryable: true,
      deliveryOutcome: "not-accepted",
      requestId: requestId ?? null,
      receivedAtMs,
      error,
      diag: {
        interactionId,
        dedupLockReleased: dedupRelease.released,
      },
    });
    return workflowStartFailedResponse();
  }

  return Response.json({ type: 5 });
}
