import { randomBytes } from "node:crypto";

import { requireMutationAuth, authJsonOk } from "@/server/auth/route-auth";
import { decryptPayload, encryptPayload } from "@/server/auth/session";
import { ApiError, jsonError } from "@/shared/http";
import { getInitializedMeta, getStore, mutateMeta } from "@/server/store/store";
import {
  generateDiscordSmokeKeyPair,
  signDiscordPayload,
  signSlackPayload,
} from "@/server/smoke/remote-crypto";
import { extractRequestId, logInfo, logWarn } from "@/server/log";
import { buildPublicDisplayUrl, buildPublicUrl } from "@/server/public-url";
import { extractChannelPlatformDeliveryId } from "@/server/channels/delivery-id";
import { withChannelConfigLease } from "@/server/channels/config-lock";
import {
  smokeChannelConfigLockKey,
  smokeDiscordKeyPairKey,
} from "@/server/store/keyspace";

// All work under this lock is store-only and bounded. Clients retry the same
// owner/token for longer than this TTL so a lost response remains recoverable.
const SMOKE_CONFIG_LOCK_TTL_SECONDS = 5;

const MAX_SMOKE_WEBHOOK_BYTES = 64 * 1024;
const SMOKE_CONFIG_TTL_SECONDS = 60 * 60;

type SmokeChannel = "slack" | "telegram" | "discord";

type DiscordSmokeKeyRecord = {
  publicKeyHex: string;
  privateKeyPkcs8Pem: string;
};

type SmokeCleanupTokenV1 = {
  version: 1;
  ownerId: string;
  channels: SmokeChannel[];
};

const SMOKE_CHANNELS: SmokeChannel[] = ["slack", "telegram", "discord"];

function isSmokeChannel(value: unknown): value is SmokeChannel {
  return value === "slack" || value === "telegram" || value === "discord";
}

function withChannelConfigLeasesIfNeeded<T>(
  channels: readonly SmokeChannel[],
  operation: () => Promise<T>,
): Promise<T> {
  const fencedChannels = (["slack", "telegram"] as const).filter((channel) =>
    channels.includes(channel),
  );
  const run = (index: number): Promise<T> => {
    const channel = fencedChannels[index];
    return channel
      ? withChannelConfigLease(channel, () => run(index + 1))
      : operation();
  };
  return run(0);
}

function parseSmokeSetupInput(input: unknown): {
  channels: SmokeChannel[];
  ownerId: string;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(400, "INVALID_JSON", "Request body must be a JSON object.");
  }
  const raw = input as { channels?: unknown; ownerId?: unknown };
  if (
    typeof raw.ownerId !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(raw.ownerId)
  ) {
    throw new ApiError(
      400,
      "OWNER_ID_REQUIRED",
      "ownerId must be a client-generated opaque identifier.",
    );
  }
  const channels = raw.channels;
  if (channels === undefined) {
    return { channels: SMOKE_CHANNELS, ownerId: raw.ownerId };
  }
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new ApiError(400, "INVALID_CHANNELS", "channels must be a non-empty array.");
  }
  if (!channels.every(isSmokeChannel)) {
    throw new ApiError(
      400,
      "UNSUPPORTED_CHANNEL",
      "Only slack, telegram, and discord are supported.",
    );
  }
  return { channels: [...new Set(channels)], ownerId: raw.ownerId };
}

function parseSmokeCleanupToken(value: unknown): SmokeCleanupTokenV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<SmokeCleanupTokenV1>;
  if (
    candidate.version !== 1 ||
    typeof candidate.ownerId !== "string" ||
    !Array.isArray(candidate.channels) ||
    !candidate.channels.every(isSmokeChannel)
  ) {
    return null;
  }
  return candidate as SmokeCleanupTokenV1;
}

function smokeConfigStillOwned(
  channel: SmokeChannel,
  ownerId: string,
  meta: Awaited<ReturnType<typeof getInitializedMeta>>,
): boolean {
  switch (channel) {
    case "slack":
      return (
        meta.channels.slack?.smokeOwnerId === ownerId &&
        meta.channels.slack.botId === "B_SMOKE"
      );
    case "telegram":
      return (
        meta.channels.telegram?.smokeOwnerId === ownerId &&
        meta.channels.telegram.botUsername === "smoke_test_bot"
      );
    case "discord":
      return (
        meta.channels.discord?.smokeOwnerId === ownerId &&
        meta.channels.discord.applicationId === "discord-smoke-app"
      );
  }
}

function adoptLegacySmokeConfig(input: {
  channel: SmokeChannel;
  ownerId: string;
  meta: Awaited<ReturnType<typeof getInitializedMeta>>;
  discordKeys: DiscordSmokeKeyRecord | null;
}): boolean {
  switch (input.channel) {
    case "slack": {
      const config = input.meta.channels.slack;
      if (
        !config ||
        config.smokeOwnerId !== undefined ||
        config.botId !== "B_SMOKE" ||
        config.botToken !== "xoxb-smoke-test-token"
      ) {
        return false;
      }
      config.smokeOwnerId = input.ownerId;
      return true;
    }
    case "telegram": {
      const config = input.meta.channels.telegram;
      if (
        !config ||
        config.smokeOwnerId !== undefined ||
        config.botUsername !== "smoke_test_bot" ||
        config.botToken !== "000000000:smoke-test-bot-token"
      ) {
        return false;
      }
      config.smokeOwnerId = input.ownerId;
      return true;
    }
    case "discord": {
      const config = input.meta.channels.discord;
      if (
        !config ||
        !input.discordKeys ||
        config.smokeOwnerId !== undefined ||
        config.applicationId !== "discord-smoke-app" ||
        config.botToken !== "discord-smoke-bot-token"
      ) {
        return false;
      }
      config.smokeOwnerId = input.ownerId;
      // The previous global private-key record was not instance scoped. Rotate
      // the synthetic pair so the adopted config has a canonical owner key.
      config.publicKey = input.discordKeys.publicKeyHex;
      return true;
    }
  }
}

function discordSmokePrivateKeyStoreKey(ownerId: string): string {
  return smokeDiscordKeyPairKey(ownerId);
}

function isDiscordSmokeKeyRecord(
  value: unknown,
): value is DiscordSmokeKeyRecord {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Partial<DiscordSmokeKeyRecord>).publicKeyHex ===
      "string" &&
    typeof (value as Partial<DiscordSmokeKeyRecord>).privateKeyPkcs8Pem ===
      "string"
  );
}

function parseSmokeDispatchInput(
  input: unknown,
): { channel: SmokeChannel; payloadBody: string; payloadBytes: number } {
  if (!input || typeof input !== "object") {
    throw new ApiError(400, "INVALID_JSON", "Request body must be a JSON object.");
  }

  const raw = input as { channel?: unknown; body?: unknown };
  if (
    raw.channel !== "slack" &&
    raw.channel !== "telegram" &&
    raw.channel !== "discord"
  ) {
    throw new ApiError(
      400,
      "UNSUPPORTED_CHANNEL",
      "Only slack, telegram, and discord are supported.",
    );
  }

  if (typeof raw.body !== "string") {
    throw new ApiError(
      400,
      "MISSING_FIELDS",
      "channel and body are required strings.",
    );
  }

  const payloadBytes = Buffer.byteLength(raw.body, "utf8");
  if (payloadBytes === 0) {
    throw new ApiError(400, "EMPTY_BODY", "body must not be empty.");
  }
  if (payloadBytes > MAX_SMOKE_WEBHOOK_BYTES) {
    throw new ApiError(
      413,
      "PAYLOAD_TOO_LARGE",
      `body must be at most ${MAX_SMOKE_WEBHOOK_BYTES} bytes.`,
    );
  }

  return { channel: raw.channel, payloadBody: raw.body, payloadBytes };
}

function buildSmokeDispatchUrl(
  channel: SmokeChannel,
  request: Request,
): string {
  switch (channel) {
    case "slack":
      return buildPublicUrl("/api/channels/slack/webhook", request);
    case "telegram":
      return buildPublicUrl("/api/channels/telegram/webhook", request);
    case "discord":
      return buildPublicUrl("/api/channels/discord/webhook", request);
  }
}

function extractSmokeDeliveryId(
  channel: SmokeChannel,
  payloadBody: string,
): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadBody);
  } catch {
    return null;
  }
  return extractChannelPlatformDeliveryId(channel, payload);
}

/**
 * Smoke testing endpoint for channel webhooks.
 *
 * PUT  — Configure test channels with generated credentials (bypasses
 *        platform API validation). Sets up Slack, Telegram, and Discord with
 *        generated credentials so smoke webhooks can be sent.
 *
 * POST — Sign and send a webhook payload to the local webhook endpoint.
 *        Raw secrets never leave the server.
 *
 * DELETE — Remove only configs owned by the opaque setup cleanup token.
 */

// ---- PUT: configure test channels ----------------------------------------

export async function PUT(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  let setupInput: unknown;
  try {
    setupInput = await request.json();
  } catch {
    return jsonError(
      new ApiError(400, "INVALID_JSON", "Request body must be valid JSON."),
    );
  }

  let requestedChannels: SmokeChannel[];
  let ownerId: string;
  try {
    const parsed = parseSmokeSetupInput(setupInput);
    requestedChannels = parsed.channels;
    ownerId = parsed.ownerId;
  } catch (error) {
    return error instanceof ApiError
      ? jsonError(error)
      : jsonError(new ApiError(400, "INVALID_REQUEST", "Invalid setup request."));
  }

  const store = getStore();
  const configLockKey = smokeChannelConfigLockKey();
  const configLockToken = await store
    .acquireLock(configLockKey, SMOKE_CONFIG_LOCK_TTL_SECONDS)
    .catch(() => null);
  if (!configLockToken) {
    return jsonError(
      new ApiError(
        409,
        "SMOKE_CONFIG_BUSY",
        "Another smoke channel configuration change is in progress.",
      ),
    );
  }

  const now = Date.now();
  let createdChannels: SmokeChannel[] = [];
  let ownedChannels: SmokeChannel[] = [];
  let createdDiscordKeyRecord = false;
  try {
    const slackSigningSecret = randomBytes(32).toString("hex");
    const telegramWebhookSecret = randomBytes(24).toString("base64url");
    let discordKeys: DiscordSmokeKeyRecord | null = null;
    if (requestedChannels.includes("discord")) {
      const keyStoreKey = discordSmokePrivateKeyStoreKey(ownerId);
      const storedKeys = await store
        .getValue<unknown>(keyStoreKey)
        .catch(() => null);
      if (isDiscordSmokeKeyRecord(storedKeys)) {
        discordKeys = storedKeys;
      } else {
        discordKeys = generateDiscordSmokeKeyPair();
        createdDiscordKeyRecord = true;
      }
      await store.setValue(
        keyStoreKey,
        discordKeys,
        SMOKE_CONFIG_TTL_SECONDS,
      );
    }
    const telegramWebhookUrl = buildPublicDisplayUrl(
      "/api/channels/telegram/webhook",
      request,
    );
    const cleanupTokenCandidate = await encryptPayload(
      {
        smokeCleanup: {
          version: 1,
          ownerId,
          channels: requestedChannels,
        } satisfies SmokeCleanupTokenV1,
      },
      "1h",
    );

    const requested = new Set(requestedChannels);
    await withChannelConfigLeasesIfNeeded(requestedChannels, () =>
      mutateMeta((meta) => {
      const created: SmokeChannel[] = [];
      const owned: SmokeChannel[] = [];
      if (requested.has("slack") && !meta.channels.slack) {
        meta.channels.slack = {
          signingSecret: slackSigningSecret,
          botToken: "xoxb-smoke-test-token",
          configuredAt: now,
          team: "Smoke Test",
          user: "smoke-bot",
          botId: "B_SMOKE",
          smokeOwnerId: ownerId,
        };
        created.push("slack");
      }
      if (requested.has("slack")) {
        adoptLegacySmokeConfig({
          channel: "slack",
          ownerId,
          meta,
          discordKeys,
        });
      }
      if (
        requested.has("slack") &&
        smokeConfigStillOwned("slack", ownerId, meta)
      ) {
        owned.push("slack");
      }
      if (requested.has("telegram") && !meta.channels.telegram) {
        meta.channels.telegram = {
          botToken: "000000000:smoke-test-bot-token",
          webhookSecret: telegramWebhookSecret,
          webhookUrl: telegramWebhookUrl,
          botUsername: "smoke_test_bot",
          configuredAt: now,
          smokeOwnerId: ownerId,
        };
        created.push("telegram");
      }
      if (requested.has("telegram")) {
        adoptLegacySmokeConfig({
          channel: "telegram",
          ownerId,
          meta,
          discordKeys,
        });
      }
      if (
        requested.has("telegram") &&
        smokeConfigStillOwned("telegram", ownerId, meta)
      ) {
        owned.push("telegram");
      }
      if (requested.has("discord") && !meta.channels.discord) {
        if (!discordKeys) {
          throw new Error("Discord smoke keys were not prepared.");
        }
        meta.channels.discord = {
          publicKey: discordKeys.publicKeyHex,
          applicationId: "discord-smoke-app",
          botToken: "discord-smoke-bot-token",
          configuredAt: now,
          smokeOwnerId: ownerId,
        };
        created.push("discord");
      }
      if (requested.has("discord")) {
        adoptLegacySmokeConfig({
          channel: "discord",
          ownerId,
          meta,
          discordKeys,
        });
      }
      if (
        requested.has("discord") &&
        smokeConfigStillOwned("discord", ownerId, meta) &&
        discordKeys
      ) {
        // The owner-scoped key record is canonical, so a retry heals a crash
        // between key persistence and the metadata commit.
        meta.channels.discord!.publicKey = discordKeys.publicKeyHex;
      }
      if (
        requested.has("discord") &&
        smokeConfigStillOwned("discord", ownerId, meta)
      ) {
        owned.push("discord");
      }
      createdChannels = created;
      ownedChannels = owned;
      }),
    );
    if (
      requestedChannels.includes("discord") &&
      !ownedChannels.includes("discord")
    ) {
      await store
        .deleteValue(discordSmokePrivateKeyStoreKey(ownerId))
        .catch(() => {});
    }
    const cleanupToken =
      ownedChannels.length > 0
        ? cleanupTokenCandidate
        : null;
    const preservedChannels = requestedChannels.filter(
      (channel) => !ownedChannels.includes(channel),
    );
    const recoveredChannels = ownedChannels.filter(
      (channel) => !createdChannels.includes(channel),
    );

    logInfo("admin.smoke_channels_configured", {
      ownerId,
      requestedChannels,
      createdChannels,
      recoveredChannels,
      preservedChannels,
      whatsapp: false,
    });
    return authJsonOk(
      {
        configured: true,
        channels: requestedChannels,
        createdChannels,
        recoveredChannels,
        preservedChannels,
        ownerId,
        cleanupToken,
      },
      auth,
    );
  } catch (error) {
    if (createdChannels.length > 0) {
      await withChannelConfigLeasesIfNeeded(createdChannels, () =>
        mutateMeta((meta) => {
          for (const channel of createdChannels) {
            if (smokeConfigStillOwned(channel, ownerId, meta)) {
              meta.channels[channel] = null;
            }
          }
        }),
      ).catch(() => {});
      if (
        createdChannels.includes("discord") ||
        createdDiscordKeyRecord
      ) {
        await store
          .deleteValue(discordSmokePrivateKeyStoreKey(ownerId))
          .catch(() => {});
      }
    }
    logWarn("admin.smoke_channels_configure_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonError(new ApiError(503, "CONFIGURE_FAILED", "Failed to configure test channels."));
  } finally {
    await store.releaseLock(configLockKey, configLockToken).catch(() => {});
  }
}

// ---- POST: sign and send webhook -----------------------------------------

export async function POST(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const requestId = extractRequestId(request);

  let rawInput: unknown;
  try {
    rawInput = await request.json();
  } catch {
    return jsonError(
      new ApiError(400, "INVALID_JSON", "Request body must be valid JSON."),
    );
  }

  let parsed: {
    channel: SmokeChannel;
    payloadBody: string;
    payloadBytes: number;
  };
  try {
    parsed = parseSmokeDispatchInput(rawInput);
  } catch (error) {
    if (error instanceof ApiError) {
      return jsonError(error);
    }
    throw error;
  }

  const { channel, payloadBody, payloadBytes } = parsed;
  const targetUrl = buildSmokeDispatchUrl(channel, request);
  const deliveryId = extractSmokeDeliveryId(channel, payloadBody);

  logInfo("admin.smoke_webhook_dispatch_requested", {
    requestId,
    channel,
    payloadBytes,
    deliveryId,
  });

  try {
    const meta = await getInitializedMeta();

    if (channel === "slack") {
      const config = meta.channels.slack;
      if (!config) {
        return authJsonOk(
          {
            configured: false,
            sent: false,
            webhookAccepted: false,
            channel,
            deliveryId,
          },
          auth,
        );
      }

      const headers = signSlackPayload(config.signingSecret, payloadBody);
      const res = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: payloadBody,
      });

      logInfo("admin.smoke_webhook_dispatch_completed", {
        requestId,
        channel,
        status: res.status,
        ok: res.ok,
        deliveryId,
      });
      return authJsonOk(
        {
          configured: true,
          sent: res.ok,
          webhookAccepted: res.ok,
          status: res.status,
          channel,
          deliveryId,
        },
        auth,
      );
    }

    if (channel === "telegram") {
      const config = meta.channels.telegram;
      if (!config) {
        return authJsonOk(
          {
            configured: false,
            sent: false,
            webhookAccepted: false,
            channel,
            deliveryId,
          },
          auth,
        );
      }

      const res = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-telegram-bot-api-secret-token": config.webhookSecret,
        },
        body: payloadBody,
      });

      logInfo("admin.smoke_webhook_dispatch_completed", {
        requestId,
        channel,
        status: res.status,
        ok: res.ok,
        deliveryId,
      });
      return authJsonOk(
        {
          configured: true,
          sent: res.ok,
          webhookAccepted: res.ok,
          status: res.status,
          channel,
          deliveryId,
        },
        auth,
      );
    }

    // discord
    const config = meta.channels.discord;
    if (!config) {
      return authJsonOk(
        {
          configured: false,
          sent: false,
          webhookAccepted: false,
          channel,
          deliveryId,
        },
        auth,
      );
    }

    const smokeOwnerId = config.smokeOwnerId;
    const discordKeys = smokeOwnerId
      ? await getStore().getValue<unknown>(
          discordSmokePrivateKeyStoreKey(smokeOwnerId),
        )
      : null;
    if (!isDiscordSmokeKeyRecord(discordKeys)) {
      return jsonError(
        new ApiError(
          409,
          "DISCORD_SMOKE_KEY_MISSING",
          "Discord smoke signing key is not configured.",
        ),
      );
    }

    const headers = signDiscordPayload(
      discordKeys.privateKeyPkcs8Pem,
      payloadBody,
    );
    const res = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: payloadBody,
    });

    logInfo("admin.smoke_webhook_dispatch_completed", {
      requestId,
      channel,
      status: res.status,
      ok: res.ok,
      deliveryId,
    });
    return authJsonOk(
      {
        configured: true,
        sent: res.ok,
        webhookAccepted: res.ok,
        status: res.status,
        channel,
        deliveryId,
      },
      auth,
    );
  } catch (error) {
    logWarn("admin.smoke_webhook_failed", {
      requestId,
      channel,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonError(
      new ApiError(503, "SEND_FAILED", "Failed to send smoke webhook."),
    );
  }
}

// ---- DELETE: remove test channels ----------------------------------------

export async function DELETE(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  let rawInput: unknown;
  try {
    rawInput = await request.json();
  } catch {
    return jsonError(
      new ApiError(400, "INVALID_JSON", "Request body must be valid JSON."),
    );
  }
  const cleanupToken =
    rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? (rawInput as { cleanupToken?: unknown }).cleanupToken
      : null;
  if (typeof cleanupToken !== "string") {
    return jsonError(
      new ApiError(
        400,
        "CLEANUP_TOKEN_REQUIRED",
        "cleanupToken from the smoke setup response is required.",
      ),
    );
  }

  try {
    const decrypted = await decryptPayload<{ smokeCleanup?: unknown }>(
      cleanupToken,
    );
    const ownership = parseSmokeCleanupToken(decrypted?.smokeCleanup);
    if (!ownership) {
      return jsonError(
        new ApiError(400, "INVALID_CLEANUP_TOKEN", "cleanupToken is invalid."),
      );
    }

    const store = getStore();
    const configLockKey = smokeChannelConfigLockKey();
    const configLockToken = await store
      .acquireLock(configLockKey, SMOKE_CONFIG_LOCK_TTL_SECONDS)
      .catch(() => null);
    if (!configLockToken) {
      return jsonError(
        new ApiError(
          409,
          "SMOKE_CONFIG_BUSY",
          "Another smoke channel configuration change is in progress.",
        ),
      );
    }

    const removedChannels: SmokeChannel[] = [];
    const preservedChannels: SmokeChannel[] = [];
    try {
      await withChannelConfigLeasesIfNeeded(ownership.channels, () =>
        mutateMeta((meta) => {
          const removed: SmokeChannel[] = [];
          const preserved: SmokeChannel[] = [];
          for (const channel of ownership.channels) {
            if (smokeConfigStillOwned(channel, ownership.ownerId, meta)) {
              meta.channels[channel] = null;
              removed.push(channel);
            } else {
              preserved.push(channel);
            }
          }
          removedChannels.splice(0, removedChannels.length, ...removed);
          preservedChannels.splice(0, preservedChannels.length, ...preserved);
        }),
      );
      if (ownership.channels.includes("discord")) {
        await store.deleteValue(
          discordSmokePrivateKeyStoreKey(ownership.ownerId),
        );
      }
    } finally {
      await store
        .releaseLock(configLockKey, configLockToken)
        .catch(() => {});
    }
    logInfo("admin.smoke_channels_removed", {
      ownerId: ownership.ownerId,
      removedChannels,
      preservedChannels,
    });
    return authJsonOk(
      {
        removed: removedChannels.length > 0,
        removedChannels,
        preservedChannels,
      },
      auth,
    );
  } catch (error) {
    logWarn("admin.smoke_channels_remove_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonError(new ApiError(503, "REMOVE_FAILED", "Failed to remove test channels."));
  }
}
