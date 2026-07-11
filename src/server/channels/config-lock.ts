import type { ChannelName } from "@/shared/channels";
import { logWarn } from "@/server/log";
import { channelConfigLockKey } from "@/server/store/keyspace";
import { getStore } from "@/server/store/store";

const CHANNEL_CONFIG_LOCK_TTL_SECONDS = 90;
const CHANNEL_CONFIG_LOCK_RETRY_MS = 50;
const CHANNEL_CONFIG_LOCK_WAIT_MS = 60_000;

export type ChannelConfigLease = {
  readonly signal: AbortSignal;
  assertOwned(): Promise<void>;
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

  const heldToken = token;
  const ttlSeconds = options.ttlSeconds ?? CHANNEL_CONFIG_LOCK_TTL_SECONDS;
  const abortController = new AbortController();
  let released = false;
  let renewing = false;
  const loseOwnership = (reason: unknown) => {
    if (!abortController.signal.aborted) {
      abortController.abort(
        reason instanceof Error
          ? reason
          : new Error(`channel_config_lock_lost:${channel}`),
      );
    }
  };
  const renew = async (): Promise<boolean> => {
    if (released || abortController.signal.aborted) return false;
    try {
      const owned = await store.renewLock(key, heldToken, ttlSeconds);
      if (!owned) {
        loseOwnership(new Error(`channel_config_lock_lost:${channel}`));
      }
      return owned;
    } catch (error) {
      loseOwnership(error);
      return false;
    }
  };
  const renewalTimer = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void renew().finally(() => {
      renewing = false;
    });
  }, Math.max(1_000, Math.floor((ttlSeconds * 1000) / 3)));
  renewalTimer.unref?.();

  return {
    signal: abortController.signal,
    async assertOwned() {
      if (abortController.signal.aborted || !(await renew())) {
        throw abortController.signal.reason instanceof Error
          ? abortController.signal.reason
          : new Error(`channel_config_lock_lost:${channel}`);
      }
    },
    async release() {
      if (released) return;
      released = true;
      clearInterval(renewalTimer);
      await store.releaseLock(key, heldToken).catch((error) => {
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
  operation: (lease: ChannelConfigLease) => Promise<T>,
): Promise<T> {
  const lease = await acquireChannelConfigLease(channel);
  try {
    await lease.assertOwned();
    const result = await operation(lease);
    await lease.assertOwned();
    return result;
  } finally {
    await lease.release();
  }
}
