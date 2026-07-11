import assert from "node:assert/strict";
import test from "node:test";

import {
  CRON_WAKE_POST_DUE_SAFETY_MS,
  getCronWakeCredentialRetry,
  handoffCronWakeStep,
  processCronWakeStep,
} from "@/server/workflows/cron/cron-wake-workflow";

test("cron wake step retry budget reaches the explicit terminal attempt", () => {
  assert.equal(processCronWakeStep.maxRetries, 4);
  assert.equal(handoffCronWakeStep.maxRetries, 4);
});

test("cron wake covers the default command timeout after the due time", () => {
  assert.equal(CRON_WAKE_POST_DUE_SAFETY_MS, 15 * 60_000);
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
