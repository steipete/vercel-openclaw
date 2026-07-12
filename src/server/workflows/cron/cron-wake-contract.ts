import type { TokenRefreshResult } from "@/server/sandbox/lifecycle";

export const CRON_WAKE_MAX_STEP_ATTEMPTS = 5;
export const CRON_WAKE_DEFAULT_RETRY_MS = 60_000;
export const CRON_WAKE_MAX_DURABLE_RETRY_MS = 15 * 60_000;
export const CRON_WAKE_MONITOR_INTERVAL_MS = 60_000;
export const CRON_SETTLEMENT_RECOVERY_INTERVAL_MS = 15 * 60_000;
export const CRON_SETTLEMENT_MAX_RECOVERY_ATTEMPTS = 4;
export const CRON_WAKE_POST_DUE_SAFETY_MS = 15 * 60_000;

export type CronWakeHandoffOutcome =
  | { status: "settled" }
  | { status: "monitor" }
  | { status: "retry"; retryAfterMs: number };

export type CronWakeProcessOutcome =
  | { status: "settled" }
  | { status: "completed" }
  | { status: "retry"; retryAfterMs: number };

export type CronWakeSettleOutcome =
  | { status: "settled" }
  | { status: "rehandoff" }
  | {
      status: "retry";
      retryAfterMs: number;
      settlementRecoveryAttempted: boolean;
    };

export function shouldCancelCronWakeHandoff(
  result: "installed" | "owned" | "occupied" | "stale",
): boolean {
  return result === "occupied" || result === "stale";
}

export function getCronWakeCredentialRetry(
  result: TokenRefreshResult,
): { usable: true } | { usable: false; retryAfterMs: number } {
  if (result.credential?.token) return { usable: true };
  return {
    usable: false,
    retryAfterMs: Math.max(
      1_000,
      result.retryAfterMs ?? CRON_WAKE_DEFAULT_RETRY_MS,
    ),
  };
}

export function getCronWakeDurableRetryMs(
  recoveryCycle: number,
  requestedRetryMs = CRON_WAKE_DEFAULT_RETRY_MS,
): number {
  const cycle = Math.max(0, Math.min(4, Math.trunc(recoveryCycle)));
  const requested = Math.max(1_000, requestedRetryMs);
  return Math.min(
    CRON_WAKE_MAX_DURABLE_RETRY_MS,
    requested * 2 ** cycle,
  );
}

export function shouldContinueCronSettlementRecovery(
  completedAttempts: number,
): boolean {
  return completedAttempts < CRON_SETTLEMENT_MAX_RECOVERY_ATTEMPTS;
}

export function countCronSettlementRecoveryAttempt(
  completedAttempts: number,
  attempted: boolean,
): number {
  return attempted ? completedAttempts + 1 : completedAttempts;
}
