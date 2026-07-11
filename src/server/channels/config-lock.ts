import type { ChannelName } from "@/shared/channels";
import { logWarn } from "@/server/log";
import { channelConfigLockKey } from "@/server/store/keyspace";
import { getStore } from "@/server/store/store";

const CHANNEL_CONFIG_LOCK_TTL_SECONDS = 90;
const CHANNEL_CONFIG_LOCK_RETRY_MS = 50;
const CHANNEL_CONFIG_LOCK_WAIT_MS = 60_000;

export type ChannelConfigLease = {
  release(): Promise<void>;
};

export async function acquireChannelConfigLease(
  channel: ChannelName,
  options: {
    ttlSeconds?: number;
    waitMs?: number;
  } = {},
): Promise<ChannelConfigLease> {
  const store = getStore();
  const key = channelConfigLockKey(channel);
  const deadline = Date.now() + (options.waitMs ?? CHANNEL_CONFIG_LOCK_WAIT_MS);
  let token: string | null = null;

  while (!token && Date.now() < deadline) {
    token = await store.acquireLock(
      key,
      options.ttlSeconds ?? CHANNEL_CONFIG_LOCK_TTL_SECONDS,
    );
    if (!token) {
      await new Promise((resolve) =>
        setTimeout(resolve, CHANNEL_CONFIG_LOCK_RETRY_MS),
      );
    }
  }

  if (!token) {
    throw new Error(`channel_config_lock_timeout:${channel}`);
  }

  return {
    async release() {
      await store.releaseLock(key, token).catch((error) => {
        logWarn("channels.config_lock_release_failed", {
          channel,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
  };
}

export async function withChannelConfigLease<T>(
  channel: ChannelName,
  operation: () => Promise<T>,
): Promise<T> {
  const lease = await acquireChannelConfigLease(channel);
  try {
    return await operation();
  } finally {
    await lease.release();
  }
}
