/**
 * Shared post-mutation helper for channel config changes.
 *
 * Both the admin channel route factory (PUT/DELETE) and the Slack OAuth
 * install callback delegate here after persisting credentials.  This
 * eliminates the duplicated markRestoreTargetDirty → syncGatewayConfigToSandbox
 * → error-normalisation → logging block that previously lived in two places.
 */

import type { ChannelName } from "@/shared/channels";
import type { LiveConfigSyncResult } from "@/shared/live-config-sync";
import { logInfo, logWarn } from "@/server/log";
import { getInitializedMeta } from "@/server/store/store";
import { withChannelConfigLease } from "@/server/channels/config-lock";
import {
  markRestoreTargetDirty,
  syncGatewayConfigToSandbox,
  syncGatewayConfigToSandboxUnderLifecycleLock,
} from "@/server/sandbox/lifecycle";

// ── Public types ──────────────────────────────────────────────────────

export type ChannelConfigMutationOperation =
  | "put"
  | "delete"
  | "oauth-install";

export type ChannelConfigApplyOutcome = {
  liveConfigSync: LiveConfigSyncResult;
  needsOperatorWarning: boolean;
};

// ── Helper ────────────────────────────────────────────────────────────

export async function applyChannelConfigChange(params: {
  channel: ChannelName;
  operation: ChannelConfigMutationOperation;
}): Promise<ChannelConfigApplyOutcome> {
  return applyChannelConfigChangeWithSync(params, {
    assertOwned: async () => {},
    sync: syncGatewayConfigToSandbox,
  });
}

export async function applyChannelConfigChangeUnderLifecycleLock(
  params: {
    channel: ChannelName;
    operation: ChannelConfigMutationOperation;
  },
  assertOwned: () => Promise<void>,
): Promise<ChannelConfigApplyOutcome> {
  return applyChannelConfigChangeWithSync(params, {
    assertOwned,
    sync: () => syncGatewayConfigToSandboxUnderLifecycleLock(assertOwned),
  });
}

async function applyChannelConfigChangeWithSync(
  params: {
    channel: ChannelName;
    operation: ChannelConfigMutationOperation;
  },
  options: {
    assertOwned: () => Promise<void>;
    sync: () => Promise<LiveConfigSyncResult>;
  },
): Promise<ChannelConfigApplyOutcome> {
  const { channel, operation } = params;
  await options.assertOwned();
  let channelGeneration =
    channel === "slack"
      ? (await getInitializedMeta()).channels.slack?.configuredAt ?? null
      : null;

  await options.assertOwned();
  await markRestoreTargetDirty({ reason: "dynamic-config-changed" });

  let liveConfigSync: LiveConfigSyncResult;
  try {
    liveConfigSync = await options.sync();
    if (channel === "slack") {
      const latestGeneration =
        (await getInitializedMeta()).channels.slack?.configuredAt ?? null;
      if (latestGeneration !== channelGeneration) {
        channelGeneration = latestGeneration;
        liveConfigSync = await options.sync();
        const afterRetryGeneration =
          (await getInitializedMeta()).channels.slack?.configuredAt ?? null;
        if (afterRetryGeneration !== channelGeneration) {
          liveConfigSync = {
            outcome: "failed",
            reason: "config_generation_superseded_during_sync",
            liveConfigFresh: false,
            operatorMessage:
              "Config changed again while live sync was running; a later sync owns readiness.",
          };
        }
      }
    }
  } catch (syncError) {
    const reason =
      syncError instanceof Error ? syncError.message : String(syncError);
    liveConfigSync = {
      outcome: "failed",
      reason,
      liveConfigFresh: false,
      operatorMessage:
        "Config sync failed. The sandbox may be serving stale configuration.",
    };
  }

  if (channel === "slack") {
    await options.assertOwned();
    await withChannelConfigLease("slack", (lease) =>
      lease.mutateMeta((meta) => {
        if (
          meta.channels.slack &&
          meta.channels.slack.configuredAt === channelGeneration
        ) {
          meta.channels.slack.liveConfigSync = {
            outcome: liveConfigSync.outcome,
            reason: liveConfigSync.reason,
            liveConfigFresh: liveConfigSync.liveConfigFresh,
            operatorMessage: liveConfigSync.operatorMessage,
            checkedAt: Date.now(),
          };
        }
      }),
    );
  }

  // Single canonical log event for all channel config mutations.
  const logPayload = {
    channel,
    operation,
    outcome: liveConfigSync.outcome,
    reason: liveConfigSync.reason,
    liveConfigFresh: liveConfigSync.liveConfigFresh,
  };

  if (
    liveConfigSync.outcome === "degraded" ||
    liveConfigSync.outcome === "failed"
  ) {
    logWarn("channels.config_apply_outcome", logPayload);
  } else {
    logInfo("channels.config_apply_outcome", logPayload);
  }

  return {
    liveConfigSync,
    needsOperatorWarning:
      liveConfigSync.outcome === "degraded" ||
      liveConfigSync.outcome === "failed",
  };
}
