import type { ChannelName } from "@/shared/channels";
import type { SingleMeta } from "@/shared/types";
import type {
  BootMessageHandle,
  ExtractedChannelMessage,
  PlatformAdapter,
} from "@/server/channels/core/types";
import { logInfo, logWarn } from "@/server/log";
import {
  ensureSandboxRunning,
  probeGatewayReady,
} from "@/server/sandbox/lifecycle";
import {
  readSetupProgress,
  type SetupPhase,
} from "@/server/sandbox/setup-progress";

const BOOT_MESSAGE_INITIAL =
  "🦞 Waking the sandbox. First reply after idle may be slow.";

const STATUS_MESSAGES: Partial<Record<SingleMeta["status"], string>> = {
  restoring: "🦞 Resuming sandbox\u2026",
  creating: "🦞 Creating sandbox\u2026",
  setup: "🦞 Syncing channel config\u2026",
  booting: "🦞 Starting OpenClaw gateway\u2026",
  running: "🦞 Sending your message\u2026",
};

const TELEGRAM_STATUS_MESSAGES: Partial<Record<SingleMeta["status"], string>> = {
  running: "🦞 Verifying Telegram listener\u2026",
};

const SLACK_STATUS_MESSAGES: Partial<Record<SingleMeta["status"], string>> = {
  running: "🦞 Verifying Slack route\u2026",
};

const SETUP_PHASE_MESSAGES: Partial<Record<SetupPhase, string>> = {
  "creating-sandbox": "🦞 Creating sandbox\u2026",
  "resuming-sandbox": "🦞 Resuming sandbox\u2026",
  "downloading-bundle": "🦞 Downloading OpenClaw bundle\u2026",
  "installing-openclaw": "🦞 Preparing OpenClaw\u2026",
  "installing-bun": "🦞 Preparing runtime\u2026",
  "cleaning-cache": "🦞 Cleaning cache\u2026",
  "installing-peer-deps": "🦞 Installing channel dependencies\u2026",
  "patching-openclaw": "🦞 Patching OpenClaw\u2026",
  "installing-plugin": "🦞 Loading channel plugin\u2026",
  "writing-config": "🦞 Syncing channel config\u2026",
  "checking-version": "🦞 Checking OpenClaw version\u2026",
  "starting-gateway": "🦞 Starting OpenClaw gateway\u2026",
  "waiting-for-gateway": "🦞 Waiting for gateway\u2026",
  "pairing-device": "🦞 Pairing device\u2026",
  "applying-firewall": "🦞 Applying network policy\u2026",
  ready: "🦞 Sending your message\u2026",
};

function channelStatusMessageFor(
  channel: ChannelName,
  status: SingleMeta["status"],
): string | undefined {
  if (channel === "telegram") {
    return TELEGRAM_STATUS_MESSAGES[status] ?? STATUS_MESSAGES[status];
  }
  if (channel === "slack") {
    return SLACK_STATUS_MESSAGES[status] ?? STATUS_MESSAGES[status];
  }
  return STATUS_MESSAGES[status];
}

async function statusMessageFor(
  channel: ChannelName,
  meta: SingleMeta,
): Promise<string | undefined> {
  if (["creating", "restoring", "setup", "booting"].includes(meta.status)) {
    const progress = await readSetupProgress(meta.id).catch((error) => {
      logWarn("channels.boot_message_setup_progress_read_failed", {
        channel,
        status: meta.status,
        instanceId: meta.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    if (progress?.active) {
      const phaseMessage = SETUP_PHASE_MESSAGES[progress.phase];
      if (phaseMessage) {
        return phaseMessage;
      }
    }
  }

  return channelStatusMessageFor(channel, meta.status);
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const BOOT_MESSAGE_CLEAR_DELAY_MS = 500;

type TelegramRestoreReadinessAssessment = {
  status: "verified" | "not-expected" | "unverified";
  restoreMetricsRecordedAt: number | null;
  telegramExpected: boolean | null;
  telegramListenerReady: boolean | null;
  telegramListenerWaitMs: number | null;
};

export type RunWithBootMessagesOptions<
  TMessage extends ExtractedChannelMessage,
> = {
  channel: ChannelName;
  adapter: PlatformAdapter<unknown, TMessage>;
  message: TMessage;
  origin: string;
  reason: string;
  timeoutMs: number;
  pollIntervalMs?: number;
  /** Reuse a boot message already sent (e.g. from the webhook route). */
  existingBootHandle?: BootMessageHandle;
  /**
   * Skip the implicit 500ms auto-clear when the function returns. Use when the
   * caller needs to keep the boot message visible past sandbox-ready (e.g. to
   * fill the gap before the real bot reply arrives) and will clear it itself.
   */
  deferCleanupToCaller?: boolean;
};

export type BootMessagesResult = {
  meta: SingleMeta;
  bootMessageSent: boolean;
  /** True only after the lifecycle controller grants this sandbox admission. */
  admissionReady: boolean;
};

function assessTelegramRestoreReadiness(
  meta: SingleMeta,
): TelegramRestoreReadinessAssessment {
  const restore = meta.lastRestoreMetrics;
  if (!restore) {
    return {
      status: "unverified",
      restoreMetricsRecordedAt: null,
      telegramExpected: null,
      telegramListenerReady: null,
      telegramListenerWaitMs: null,
    };
  }
  if (restore.telegramExpected !== true) {
    return {
      status: "not-expected",
      restoreMetricsRecordedAt: restore.recordedAt,
      telegramExpected: restore.telegramExpected ?? false,
      telegramListenerReady: restore.telegramListenerReady ?? null,
      telegramListenerWaitMs: restore.telegramListenerWaitMs ?? null,
    };
  }
  return {
    status: restore.telegramListenerReady === true ? "verified" : "unverified",
    restoreMetricsRecordedAt: restore.recordedAt,
    telegramExpected: true,
    telegramListenerReady: restore.telegramListenerReady ?? false,
    telegramListenerWaitMs: restore.telegramListenerWaitMs ?? null,
  };
}

/**
 * Wake the sandbox with phased boot status messages.
 *
 * If the sandbox is already running, returns immediately without sending
 * a boot message. Otherwise sends "🦞 Waking the sandbox." and progressively updates
 * the message as the sandbox transitions through restore phases.
 */
export async function runWithBootMessages<
  TMessage extends ExtractedChannelMessage,
>(
  options: RunWithBootMessagesOptions<TMessage>,
): Promise<BootMessagesResult> {
  const {
    channel,
    adapter,
    message,
    origin,
    reason,
    timeoutMs,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    existingBootHandle,
    deferCleanupToCaller = false,
  } = options;

  const initialEnsure = await ensureSandboxRunning({ origin, reason });
  const initialMeta = initialEnsure.meta;

  if (
    initialEnsure.state === "running"
    && initialMeta.status === "running"
    && initialMeta.sandboxId
  ) {
    if (channel === "telegram") {
      const assessment = assessTelegramRestoreReadiness(initialMeta);
      const logData = {
        channel,
        sandboxId: initialMeta.sandboxId,
        restoreMetricsRecordedAt: assessment.restoreMetricsRecordedAt,
        telegramExpected: assessment.telegramExpected,
        telegramListenerReady: assessment.telegramListenerReady,
        telegramListenerWaitMs: assessment.telegramListenerWaitMs,
      };
      if (assessment.status === "unverified") {
        logWarn("channels.telegram_boot_running_unverified", logData);
      } else {
        logInfo("channels.telegram_boot_running_contract", {
          ...logData,
          contractStatus: assessment.status,
        });
      }
    }
    // Sandbox already running. Only clear a pre-sent boot message when the
    // caller did not opt into managing it. The workflow wake path passes
    // deferCleanupToCaller: true for Slack/Telegram so a retry that lands on
    // an already-running sandbox keeps the user-visible placeholder alive
    // until the caller decides the terminal outcome (success → "Almost
    // ready", failure → "Couldn't reach assistant", retryable → "Still
    // trying"). Deleting here would leave the retry path holding a handle
    // to a deleted message, and the next forward would complete invisibly.
    if (existingBootHandle) {
      if (deferCleanupToCaller) {
        void existingBootHandle
          .update(
            channelStatusMessageFor(channel, "running") ??
              "🦞 Sending your message\u2026",
          )
          .catch((error) => {
            logWarn("channels.boot_message_update_failed", {
              channel,
              phase: "already-running",
              error: error instanceof Error ? error.message : String(error),
            });
          });
      } else {
        existingBootHandle.clear().catch((error) => {
          logWarn("channels.boot_message_cleanup_failed", {
            channel,
            phase: "already-running",
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }
    return { meta: initialMeta, bootMessageSent: false, admissionReady: true };
  }

  if (!existingBootHandle && !adapter.sendBootMessage) {
    return { meta: initialMeta, bootMessageSent: false, admissionReady: false };
  }

  let handle: BootMessageHandle;
  if (existingBootHandle) {
    handle = existingBootHandle;
  } else {
    try {
      handle = await adapter.sendBootMessage!(message, BOOT_MESSAGE_INITIAL);
    } catch (error) {
      logWarn("channels.boot_message_send_failed", {
        channel,
        error: error instanceof Error ? error.message : String(error),
      });
      return { meta: initialMeta, bootMessageSent: false, admissionReady: false };
    }
  }

  logInfo("channels.boot_message_sent", { channel });

  let lastStatus: string | null = null;
  let lastBootMessageText: string | null = existingBootHandle
    ? null
    : BOOT_MESSAGE_INITIAL;
  const deadline = Date.now() + timeoutMs;

  try {
    try {
    for (;;) {
      const result = await ensureSandboxRunning({ origin, reason });
      const meta = result.meta;

      if (meta.status !== lastStatus) {
        lastStatus = meta.status;
      }

      const statusMessage = await statusMessageFor(channel, meta);
      if (statusMessage && statusMessage !== lastBootMessageText) {
        lastBootMessageText = statusMessage;
        void handle.update(statusMessage).catch((error) => {
          logWarn("channels.boot_message_update_failed", {
            channel,
            status: meta.status,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }

      if (result.state === "running" && meta.status === "running" && meta.sandboxId) {
        return { meta, bootMessageSent: true, admissionReady: true };
      }

      if (meta.status === "error") {
        throw new Error(
          `Sandbox entered error state: ${meta.lastError ?? "unknown"}`,
        );
      }

      // Also try gateway probe for statuses that might already be running.
      // Do NOT do this for Telegram: port 3000 can become healthy while the
      // native Telegram listener on 127.0.0.1:8787 is still unbound. Returning
      // early here causes the workflow to treat the sandbox as ready and then
      // hit ECONNREFUSED on the local Telegram forward path.
      if (
        channel !== "telegram" &&
        meta.sandboxId &&
        ["setup", "booting"].includes(meta.status)
      ) {
        const probe = await probeGatewayReady();
        if (probe.ready) {
          // The probe and metadata read are not atomic. Re-enter lifecycle
          // admission so a generation replacement cannot inherit readiness.
          const admitted = await ensureSandboxRunning({ origin, reason });
          if (
            admitted.state !== "running"
            || admitted.meta.status !== "running"
            || !admitted.meta.sandboxId
          ) {
            continue;
          }
          void handle
            .update(
              channelStatusMessageFor(channel, "running") ??
                "🦞 Sending your message\u2026",
            )
            .catch((error) => {
              logWarn("channels.boot_message_update_failed", {
                channel,
                status: "running",
                error: error instanceof Error ? error.message : String(error),
              });
            });
          return {
            meta: admitted.meta,
            bootMessageSent: true,
            admissionReady: true,
          };
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Sandbox did not become ready within ${Math.ceil(timeoutMs / 1000)} seconds (last status: ${meta.status}).`,
        );
      }

      await sleep(pollIntervalMs);
    }
    } catch (loopError) {
      // The boot-message poll loop has thrown — the caller will get a
      // workflow-level retry/terminal message, but if this is a sandbox-
      // start failure (timeout or "error" state), the user has been
      // staring at a setup/booting status message the
      // whole time. Push ONE final synchronous chat.update with a
      // diagnostic message so the placeholder reflects reality before
      // the error propagates to the workflow's own catch handler.
      const errMsg =
        loopError instanceof Error ? loopError.message : String(loopError);
      const finalText = `🛑 Sandbox failed to start. Last status: ${
        lastStatus ?? "unknown"
      }. Run \`vclaw doctor\` or check admin logs.`;
      try {
        await handle.update(finalText);
      } catch (updateError) {
        logWarn("channels.boot_message_final_error_update_failed", {
          channel,
          lastStatus,
          loopError: errMsg,
          updateError:
            updateError instanceof Error
              ? updateError.message
              : String(updateError),
        });
      }
      logWarn("channels.boot_message_loop_failed", {
        channel,
        lastStatus,
        error: errMsg,
      });
      throw loopError;
    }
  } finally {
    // Caller opts out when it wants to keep the boot message alive past
    // sandbox-ready (e.g. to fill the gap before the real bot reply arrives).
    if (!deferCleanupToCaller) {
      setTimeout(() => {
        void handle.clear().catch((error) => {
          logWarn("channels.boot_message_cleanup_failed", {
            channel,
            phase: "finalize",
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, BOOT_MESSAGE_CLEAR_DELAY_MS).unref?.();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
