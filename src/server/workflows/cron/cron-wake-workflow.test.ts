import assert from "node:assert/strict";
import test from "node:test";

import {
  countCronSettlementRecoveryAttempt,
  CRON_SETTLEMENT_MAX_RECOVERY_ATTEMPTS,
  CRON_WAKE_POST_DUE_SAFETY_MS,
  getCronWakeCredentialRetry,
  getCronWakeDurableRetryMs,
  handoffCronWakeStep,
  isCronDispatchRepairNeededStep,
  processCronWakeStep,
  settleCronWakeStep,
  shouldContinueCronSettlementRecovery,
  shouldCancelCronWakeHandoff,
} from "@/server/workflows/cron/cron-wake-workflow";

test("cron wake step retry budget reaches the explicit terminal attempt", () => {
  assert.equal(processCronWakeStep.maxRetries, 4);
  assert.equal(handoffCronWakeStep.maxRetries, 4);
  assert.equal(settleCronWakeStep.maxRetries, 4);
  assert.equal(isCronDispatchRepairNeededStep.maxRetries, 4);
});

test("cron wake covers the default command timeout after the due time", () => {
  assert.equal(CRON_WAKE_POST_DUE_SAFETY_MS, 15 * 60_000);
  assert.equal(CRON_SETTLEMENT_MAX_RECOVERY_ATTEMPTS, 4);
  assert.equal(shouldContinueCronSettlementRecovery(3), true);
  assert.equal(shouldContinueCronSettlementRecovery(4), false);
  let failedSettlementAttempts = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    failedSettlementAttempts = countCronSettlementRecoveryAttempt(
      failedSettlementAttempts,
      true,
    );
  }
  assert.equal(failedSettlementAttempts, 4);
  assert.equal(
    shouldContinueCronSettlementRecovery(failedSettlementAttempts),
    false,
  );
});

test("cron wake keeps terminal recovery durable with bounded backoff", () => {
  assert.equal(getCronWakeDurableRetryMs(0), 60_000);
  assert.equal(getCronWakeDurableRetryMs(1), 120_000);
  assert.equal(getCronWakeDurableRetryMs(2), 240_000);
  assert.equal(getCronWakeDurableRetryMs(10), 15 * 60_000);
  assert.equal(getCronWakeDurableRetryMs(0, 30 * 60_000), 15 * 60_000);
});

test("cron wake retries every credential outcome without a usable credential", () => {
  assert.deepEqual(
    getCronWakeCredentialRetry({
      refreshed: false,
      reason: "circuit-breaker-open",
      retryAfterMs: 12_345,
    }),
    { usable: false, retryAfterMs: 12_345 },
  );
  assert.deepEqual(
    getCronWakeCredentialRetry({
      refreshed: false,
      reason: "lock-contended",
    }),
    { usable: false, retryAfterMs: 60_000 },
  );
  assert.deepEqual(
    getCronWakeCredentialRetry({
      refreshed: false,
      reason: "api-key-no-refresh-needed",
      credential: { token: "test-token", source: "api-key", expiresAt: null },
    }),
    { usable: true },
  );
});

test("handoff cancellation distinguishes an orphan from its fast completed child", () => {
  assert.equal(shouldCancelCronWakeHandoff("installed"), false);
  assert.equal(shouldCancelCronWakeHandoff("owned"), false);
  assert.equal(shouldCancelCronWakeHandoff("occupied"), true);
  assert.equal(shouldCancelCronWakeHandoff("stale"), true);
});
