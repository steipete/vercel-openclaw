/**
 * Tests for sandbox sleep-after timeout config resolution.
 *
 * Run: node --test src/server/sandbox/timeout.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  getSandboxSleepConfig,
  getSandboxSleepAfterMs,
  getSandboxPlatformTimeoutMs,
  getSandboxTimeoutExtensionMs,
  getSandboxHeartbeatIntervalMs,
  getSandboxTouchThrottleMs,
  _resetSandboxSleepConfigCacheForTesting,
  DEFAULT_SANDBOX_SLEEP_AFTER_MS,
  MIN_SANDBOX_SLEEP_AFTER_MS,
  MAX_PORTABLE_SANDBOX_SLEEP_AFTER_MS,
  MAX_DESIRED_SANDBOX_IDLE_MS,
} from "@/server/sandbox/timeout";

function withEnv(value: string | undefined, fn: () => void): void {
  const original = process.env.OPENCLAW_SANDBOX_SLEEP_AFTER_MS;
  try {
    if (value === undefined) {
      delete process.env.OPENCLAW_SANDBOX_SLEEP_AFTER_MS;
    } else {
      process.env.OPENCLAW_SANDBOX_SLEEP_AFTER_MS = value;
    }
    _resetSandboxSleepConfigCacheForTesting();
    fn();
  } finally {
    if (original === undefined) {
      delete process.env.OPENCLAW_SANDBOX_SLEEP_AFTER_MS;
    } else {
      process.env.OPENCLAW_SANDBOX_SLEEP_AFTER_MS = original;
    }
    _resetSandboxSleepConfigCacheForTesting();
  }
}

test("timeout: unset env returns default 30 minutes", () => {
  withEnv(undefined, () => {
    const config = getSandboxSleepConfig();
    assert.equal(config.sleepAfterMs, DEFAULT_SANDBOX_SLEEP_AFTER_MS);
    assert.equal(config.sleepAfterMs, 30 * 60 * 1000);
  });
});

test("timeout: 300000 resolves correctly", () => {
  withEnv("300000", () => {
    const config = getSandboxSleepConfig();
    assert.equal(config.sleepAfterMs, 300_000);
    assert.equal(config.heartbeatIntervalMs, 150_000);
    assert.equal(config.touchThrottleMs, 30_000);
  });
});

test("timeout: value below minimum clamps to MIN_SANDBOX_SLEEP_AFTER_MS", () => {
  withEnv("1000", () => {
    const config = getSandboxSleepConfig();
    assert.equal(config.sleepAfterMs, MIN_SANDBOX_SLEEP_AFTER_MS);
  });
});

test("timeout: value above maximum reserves native safety runway", () => {
  withEnv("9999999999", () => {
    const config = getSandboxSleepConfig();
    assert.equal(config.sleepAfterMs, MAX_DESIRED_SANDBOX_IDLE_MS);
    assert.equal(
      getSandboxPlatformTimeoutMs(),
      MAX_PORTABLE_SANDBOX_SLEEP_AFTER_MS,
    );
  });
});

test("timeout: extension is capped by total session headroom", () => {
  assert.equal(
    getSandboxTimeoutExtensionMs({
      currentTotalMs: MAX_PORTABLE_SANDBOX_SLEEP_AFTER_MS - 60_000,
      currentRemainingMs: 1,
      targetRemainingMs: 10 * 60 * 1000,
    }),
    60_000,
  );
  assert.equal(
    getSandboxTimeoutExtensionMs({
      currentTotalMs: MAX_PORTABLE_SANDBOX_SLEEP_AFTER_MS,
      currentRemainingMs: 1,
      targetRemainingMs: 10 * 60 * 1000,
    }),
    0,
  );
});

test("timeout: invalid string falls back to default", () => {
  withEnv("not-a-number", () => {
    const config = getSandboxSleepConfig();
    assert.equal(config.sleepAfterMs, DEFAULT_SANDBOX_SLEEP_AFTER_MS);
  });
});

test("timeout: negative value falls back to default", () => {
  withEnv("-5000", () => {
    const config = getSandboxSleepConfig();
    assert.equal(config.sleepAfterMs, DEFAULT_SANDBOX_SLEEP_AFTER_MS);
  });
});

test("timeout: zero falls back to default", () => {
  withEnv("0", () => {
    const config = getSandboxSleepConfig();
    assert.equal(config.sleepAfterMs, DEFAULT_SANDBOX_SLEEP_AFTER_MS);
  });
});

test("timeout: empty string falls back to default", () => {
  withEnv("", () => {
    const config = getSandboxSleepConfig();
    assert.equal(config.sleepAfterMs, DEFAULT_SANDBOX_SLEEP_AFTER_MS);
  });
});

test("timeout: whitespace string falls back to default", () => {
  withEnv("   ", () => {
    const config = getSandboxSleepConfig();
    assert.equal(config.sleepAfterMs, DEFAULT_SANDBOX_SLEEP_AFTER_MS);
  });
});

test("timeout: heartbeat is at most half the sleep value", () => {
  withEnv("120000", () => {
    const config = getSandboxSleepConfig();
    assert.ok(config.heartbeatIntervalMs <= config.sleepAfterMs / 2);
    assert.ok(config.heartbeatIntervalMs >= 15_000);
  });
});

test("timeout: heartbeat caps at 4 min for long sleep windows", () => {
  withEnv(undefined, () => {
    const config = getSandboxSleepConfig();
    assert.equal(config.heartbeatIntervalMs, 4 * 60 * 1000);
  });
});

test("timeout: touch throttle is at most quarter of sleep", () => {
  withEnv("120000", () => {
    const config = getSandboxSleepConfig();
    assert.equal(config.touchThrottleMs, 30_000);
  });
});

test("timeout: convenience accessors match config", () => {
  withEnv("300000", () => {
    const config = getSandboxSleepConfig();
    assert.equal(getSandboxSleepAfterMs(), config.sleepAfterMs);
    assert.equal(getSandboxHeartbeatIntervalMs(), config.heartbeatIntervalMs);
    assert.equal(getSandboxTouchThrottleMs(), config.touchThrottleMs);
  });
});

test("timeout: config is cached for same env value", () => {
  withEnv("300000", () => {
    const config1 = getSandboxSleepConfig();
    const config2 = getSandboxSleepConfig();
    assert.strictEqual(config1, config2);
  });
});

test("timeout: config recalculates when env changes", () => {
  withEnv("300000", () => {
    const config1 = getSandboxSleepConfig();
    process.env.OPENCLAW_SANDBOX_SLEEP_AFTER_MS = "600000";
    const config2 = getSandboxSleepConfig();
    assert.notStrictEqual(config1, config2);
    assert.equal(config2.sleepAfterMs, 600_000);
  });
});
