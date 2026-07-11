import type { ChannelName } from "@/shared/channels";
import { CHANNEL_DELIVERY_DEDUP_LOCK_TTL_SECONDS } from "@/server/channels/dedup";
import { logError, logWarn } from "@/server/log";
import {
  channelFailedIndexKey,
  channelFailedIndexLockKey,
  channelFailedKey,
  channelFailedRecordLockKey,
  channelFailedResolvedKey,
  channelFailedUnknownKey,
} from "@/server/store/keyspace";
import { getStore } from "@/server/store/store";

export const CHANNEL_DLQ_RECORD_TTL_SECONDS = 30 * 24 * 60 * 60;
export const CHANNEL_DLQ_RESOLUTION_FENCE_TTL_SECONDS =
  CHANNEL_DELIVERY_DEDUP_LOCK_TTL_SECONDS;
const CHANNEL_DLQ_INDEX_MAX = 500;
const CHANNEL_DLQ_LOCK_TTL_SECONDS = 30;
const CHANNEL_DLQ_LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
const CHANNEL_DLQ_LOCK_RETRY_INTERVAL_MS = 25;
const CHANNEL_DLQ_LOCK_RENEW_INTERVAL_MS = 10_000;
const CHANNEL_DLQ_FENCE_WRITE_ATTEMPTS = 5;

type ChannelDlqLockGuard = {
  assertHeld: () => Promise<void>;
  setValue: <T>(key: string, value: T, ttlSeconds: number) => Promise<void>;
};

// Poison-payload detection: when the same deliveryId fails many times
// in a short window, it's very likely a payload the step can never
// process (malformed fields, unsupported interaction type, etc.) rather
// than a transient infra blip. Alert once per deliveryId to avoid
// spamming logs on every redelivery after the threshold.
const CHANNEL_DLQ_POISON_THRESHOLD = 5;
const CHANNEL_DLQ_POISON_WINDOW_MS = 15 * 60 * 1000;

export type ChannelDlqPhase =
  | "workflow-start-failed"
  | "workflow-step-failed";

export type ChannelDlqDeliveryOutcome = "not-accepted" | "unknown";

export type ChannelDlqRecoveryState =
  | "automatic-retry"
  | "blocked";

export type ChannelDlqRecord = {
  channel: ChannelName;
  deliveryId: string;
  phase: ChannelDlqPhase;
  terminal: boolean;
  retryable: boolean;
  deliveryOutcome: ChannelDlqDeliveryOutcome;
  recoveryState: ChannelDlqRecoveryState;
  requestId: string | null;
  errorName: string | null;
  errorMessage: string;
  firstFailedAt: number;
  failedAt: number;
  failureCount: number;
  receivedAtMs: number | null;
  ageMs: number | null;
  // Timestamp of the poison-payload alert emitted for this deliveryId.
  // Null when no alert has fired yet; carried across upserts so each
  // poison payload produces exactly one `dlq_poison_payload_detected`
  // log, not one per redelivery.
  poisonAlertedAt: number | null;
  diag: Record<string, unknown>;
};

export type ChannelDlqIndexEntry = {
  channel: ChannelName;
  deliveryId: string;
  key: string;
  failedAt: number;
  phase: ChannelDlqPhase;
  terminal: boolean;
};

export async function recordChannelDlqFailure(input: {
  channel: ChannelName;
  deliveryId: string;
  phase: ChannelDlqPhase;
  terminal: boolean;
  retryable: boolean;
  deliveryOutcome?: ChannelDlqDeliveryOutcome;
  requestId: string | null;
  receivedAtMs: number | null;
  error: unknown;
  diag?: Record<string, unknown>;
}): Promise<ChannelDlqRecord | null> {
  const requestedOutcome =
    input.deliveryOutcome ??
    (input.phase === "workflow-start-failed" ? "not-accepted" : "unknown");
  if (requestedOutcome === "unknown") {
    try {
      // Fence before waiting for the record lock. Even if a stale writer owns
      // the lock, projected outcome immediately becomes unknown.
      await writeChannelDlqFence(
        channelFailedUnknownKey(input.channel, input.deliveryId),
        { recordedAt: Date.now() },
      );
    } catch (error) {
      await getStore()
        .deleteValue(channelFailedKey(input.channel, input.deliveryId))
        .catch(() => {});
      logError("channels.dlq_unknown_fence_write_failed", {
        channel: input.channel,
        deliveryId: input.deliveryId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  const lockKey = channelFailedRecordLockKey(input.channel, input.deliveryId);
  return await withChannelDlqLock(lockKey, async (lock) => {
    const resolvedFence = await readChannelDlqFence(
      channelFailedResolvedKey(input.channel, input.deliveryId),
    );
    if (resolvedFence !== "absent") {
      return null;
    }
    return await recordChannelDlqFailureLocked(input, lock);
  }).catch((error) => {
    logError("channels.dlq_record_lock_failed", {
      channel: input.channel,
      deliveryId: input.deliveryId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
}

async function recordChannelDlqFailureLocked(
  input: {
    channel: ChannelName;
    deliveryId: string;
    phase: ChannelDlqPhase;
    terminal: boolean;
    retryable: boolean;
    deliveryOutcome?: ChannelDlqDeliveryOutcome;
    requestId: string | null;
    receivedAtMs: number | null;
    error: unknown;
    diag?: Record<string, unknown>;
  },
  lock: ChannelDlqLockGuard,
): Promise<ChannelDlqRecord | null> {
  const key = channelFailedKey(input.channel, input.deliveryId);
  const now = Date.now();
  const store = getStore();
  let existing: Partial<ChannelDlqRecord> | null;
  try {
    existing = await store.getValue<Partial<ChannelDlqRecord>>(key);
  } catch (error) {
    logError("channels.dlq_record_read_failed", {
      channel: input.channel,
      deliveryId: input.deliveryId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  const errorMessage =
    input.error instanceof Error ? input.error.message : String(input.error);
  const errorName =
    input.error instanceof Error ? input.error.name : null;
  const firstFailedAt =
    typeof existing?.firstFailedAt === "number"
      ? existing.firstFailedAt
      : now;
  const failureCount =
    typeof existing?.failureCount === "number" ? existing.failureCount + 1 : 1;
  const previousPoisonAlertedAt =
    typeof existing?.poisonAlertedAt === "number"
      ? existing.poisonAlertedAt
      : null;
  const unknownFenceKey = channelFailedUnknownKey(
    input.channel,
    input.deliveryId,
  );
  const initialUnknownFence = await readChannelDlqFence(unknownFenceKey);
  if (initialUnknownFence === "unavailable") return null;
  // Once any attempt may have reached the native handler, later rejection
  // evidence cannot make the same delivery ID definite again.
  let deliveryOutcome: ChannelDlqDeliveryOutcome =
    initialUnknownFence === "present" ||
    existing?.deliveryOutcome === "unknown" ||
    (input.deliveryOutcome ??
      (input.phase === "workflow-start-failed" ? "not-accepted" : "unknown")) ===
      "unknown"
      ? "unknown"
      : "not-accepted";
  // Fences are written outside the record lock so accepted/unknown evidence
  // can dominate immediately. Re-read immediately
  // before persistence so an in-flight stale writer is sanitized as well.
  const [resolvedFence, finalUnknownFence] = await Promise.all([
    readChannelDlqFence(
      channelFailedResolvedKey(input.channel, input.deliveryId),
    ),
    readChannelDlqFence(unknownFenceKey),
  ]);
  if (resolvedFence !== "absent" || finalUnknownFence === "unavailable") {
    return null;
  }
  if (finalUnknownFence === "present") {
    deliveryOutcome = "unknown";
  }

  const terminal =
    deliveryOutcome === "unknown" ||
    input.terminal ||
    existing?.terminal === true;
  const retryable =
    deliveryOutcome === "unknown" || terminal ? false : input.retryable;
  const recoveryState: ChannelDlqRecoveryState = terminal
    ? "blocked"
    : "automatic-retry";
  // Only alert on the first threshold crossing, and only when the
  // failures are clustered inside the window. Rare per-week failures
  // that happen to accumulate over 30 days should NOT be flagged.
  const poisonWindowMs = now - firstFailedAt;
  const shouldEmitPoisonAlert =
    previousPoisonAlertedAt === null &&
    failureCount >= CHANNEL_DLQ_POISON_THRESHOLD &&
    poisonWindowMs <= CHANNEL_DLQ_POISON_WINDOW_MS;
  const record: ChannelDlqRecord = {
    channel: input.channel,
    deliveryId: input.deliveryId,
    phase: input.phase,
    terminal,
    retryable,
    deliveryOutcome,
    recoveryState,
    requestId: input.requestId,
    errorName,
    errorMessage,
    firstFailedAt,
    failedAt: now,
    failureCount,
    receivedAtMs: input.receivedAtMs,
    ageMs:
      typeof input.receivedAtMs === "number" ? now - input.receivedAtMs : null,
    poisonAlertedAt: shouldEmitPoisonAlert ? now : previousPoisonAlertedAt,
    diag: input.diag ?? {},
  };
  try {
    await lock.setValue(key, record, CHANNEL_DLQ_RECORD_TTL_SECONDS);
  } catch (writeError) {
    logError("channels.dlq_record_write_failed", {
      channel: input.channel,
      deliveryId: input.deliveryId,
      phase: input.phase,
      error:
        writeError instanceof Error ? writeError.message : String(writeError),
    });
    return null;
  }
  // Index maintenance is best-effort. Record persistence must not
  // depend on the index being writable.
  await indexDlqRecord(record).catch((indexError) => {
    logError("channels.dlq_index_write_failed", {
      channel: input.channel,
      deliveryId: input.deliveryId,
      error:
        indexError instanceof Error ? indexError.message : String(indexError),
    });
  });
  // Poison-payload alert fires once per deliveryId when failureCount
  // crosses the threshold inside a tight window. Durable record of
  // having alerted is carried on poisonAlertedAt so the next retry
  // won't re-fire. Log AFTER the successful write so alerting
  // necessarily reflects durable state.
  if (shouldEmitPoisonAlert) {
    logError("channels.dlq_poison_payload_detected", {
      channel: record.channel,
      deliveryId: record.deliveryId,
      phase: record.phase,
      terminal: record.terminal,
      retryable: record.retryable,
      requestId: record.requestId,
      failureCount: record.failureCount,
      firstFailedAt: record.firstFailedAt,
      failedAt: record.failedAt,
      poisonWindowMs,
      poisonThreshold: CHANNEL_DLQ_POISON_THRESHOLD,
      errorName: record.errorName,
      errorMessage: record.errorMessage,
    });
  }
  return await getChannelDlqRecord(record.channel, record.deliveryId);
}

export async function getChannelDlqRecord(
  channel: ChannelName,
  deliveryId: string,
): Promise<ChannelDlqRecord | null> {
  const store = getStore();
  const resolvedFence = await readChannelDlqFence(
    channelFailedResolvedKey(channel, deliveryId),
  );
  if (resolvedFence === "unavailable") {
    throw new Error("Channel DLQ resolved fence unavailable.");
  }
  if (resolvedFence === "present") return null;
  const record = await store.getValue<ChannelDlqRecord>(
    channelFailedKey(channel, deliveryId),
  );
  if (!record) return null;
  const unknownFence = await readChannelDlqFence(
    channelFailedUnknownKey(channel, deliveryId),
  );
  if (unknownFence === "unavailable") {
    throw new Error("Channel DLQ unknown fence unavailable.");
  }
  if (unknownFence === "present") {
    return {
      ...record,
      terminal: true,
      retryable: false,
      deliveryOutcome: "unknown",
      recoveryState: "blocked",
    };
  }
  return record;
}

export async function resolveChannelDlqFailure(
  channel: ChannelName,
  deliveryId: string,
): Promise<void> {
  const store = getStore();
  const recordKey = channelFailedKey(channel, deliveryId);
  const indexKey = channelFailedIndexKey();
  const resolvedKey = channelFailedResolvedKey(channel, deliveryId);
  // Every accepted delivery gets only a short contention fence. A durable
  // tombstone is justified only when an actual failure record must be retired.
  try {
    await writeChannelDlqFence(
      resolvedKey,
      { resolvedAt: Date.now() },
      CHANNEL_DLQ_RESOLUTION_FENCE_TTL_SECONDS,
    );
  } catch (error) {
    await store.deleteValue(recordKey).catch(() => {});
    throw error;
  }
  const recordLockKey = channelFailedRecordLockKey(channel, deliveryId);
  try {
    await withChannelDlqLock(recordLockKey, async (recordLock) => {
      const record = await store.getValue<ChannelDlqRecord>(recordKey);
      if (!record) return;

      // Existing durable failure state needs a matching durable accepted
      // tombstone. It keeps a late writer hidden after best-effort cleanup.
      await writeChannelDlqFence(
        resolvedKey,
        { resolvedAt: Date.now() },
        CHANNEL_DLQ_RECORD_TTL_SECONDS,
      );
      try {
        const indexLockKey = channelFailedIndexLockKey();
        await recordLock.assertHeld();
        await withChannelDlqLock(indexLockKey, async (indexLock) => {
          const current = await store.getValue<ChannelDlqIndexEntry[] | null>(
            indexKey,
          );
          const next = Array.isArray(current)
            ? current.filter((entry) => entry?.key !== recordKey)
            : [];
          await indexLock.setValue(
            indexKey,
            next,
            CHANNEL_DLQ_RECORD_TTL_SECONDS,
          );
        });
      } finally {
        await recordLock.assertHeld();
        await store.deleteValue(recordKey).catch(() => {});
      }
    });
  } catch (error) {
    // Lock contention means a failure writer may still be in flight. Extend
    // the fence so accepted evidence remains dominant after the short window.
    await writeChannelDlqFence(
      resolvedKey,
      { resolvedAt: Date.now() },
      CHANNEL_DLQ_RECORD_TTL_SECONDS,
    ).catch(() => {});
    await store.deleteValue(recordKey).catch(() => {});
    throw error;
  }
}

export type ChannelDlqSummary = {
  indexSize: number;
  channelCounts: Record<ChannelName, number>;
  terminalCount: number;
  oldestFailedAt: number | null;
  newestFailedAt: number | null;
  unavailable?: boolean;
};

/**
 * Best-effort aggregate of the bounded DLQ index. Safe to call from
 * preflight / health routes — a store read failure returns an empty
 * summary with `unavailable: true` rather than throwing, so it never
 * flips a config preflight from ok to not-ok.
 */
export async function getChannelDlqSummary(): Promise<ChannelDlqSummary> {
  const base: ChannelDlqSummary = {
    indexSize: 0,
    channelCounts: { slack: 0, telegram: 0, whatsapp: 0, discord: 0 },
    terminalCount: 0,
    oldestFailedAt: null,
    newestFailedAt: null,
  };
  try {
    const store = getStore();
    // Intentionally don't swallow the read error here — the outer
    // try sets unavailable:true so callers can distinguish "index is
    // empty" from "couldn't read index at all".
    const indexRaw = await store.getValue<ChannelDlqIndexEntry[] | null>(
      channelFailedIndexKey(),
    );
    const index: ChannelDlqIndexEntry[] = Array.isArray(indexRaw)
      ? indexRaw.filter((entry): entry is ChannelDlqIndexEntry => {
          return (
            entry != null &&
            typeof entry === "object" &&
            typeof (entry as ChannelDlqIndexEntry).key === "string" &&
            typeof (entry as ChannelDlqIndexEntry).channel === "string"
          );
        })
      : [];
    const liveRecords = (
      await Promise.all(
        index.map(async (entry) => {
          const record = await getChannelDlqRecord(
            entry.channel,
            entry.deliveryId,
          );
          return record ? { entry, record } : null;
        }),
      )
    ).filter(
      (value): value is {
        entry: ChannelDlqIndexEntry;
        record: ChannelDlqRecord;
      } => value !== null,
    );
    const summary: ChannelDlqSummary = {
      ...base,
      // Stale index writes are harmless: accepted tombstones and unknown
      // fences are authoritative, so only live projected records count.
      indexSize: liveRecords.length,
    };
    for (const { record } of liveRecords) {
      if (record.channel in summary.channelCounts) {
        summary.channelCounts[record.channel] += 1;
      }
      if (record.terminal) summary.terminalCount += 1;
      if (typeof record.failedAt === "number") {
        if (
          summary.oldestFailedAt === null ||
          record.failedAt < summary.oldestFailedAt
        ) {
          summary.oldestFailedAt = record.failedAt;
        }
        if (
          summary.newestFailedAt === null ||
          record.failedAt > summary.newestFailedAt
        ) {
          summary.newestFailedAt = record.failedAt;
        }
      }
    }
    return summary;
  } catch {
    return { ...base, unavailable: true };
  }
}

async function indexDlqRecord(record: ChannelDlqRecord): Promise<void> {
  const store = getStore();
  const indexKey = channelFailedIndexKey();
  const lockKey = channelFailedIndexLockKey();
  await withChannelDlqLock(lockKey, async (lock) => {
    const currentRaw = await store.getValue<ChannelDlqIndexEntry[] | null>(
      indexKey,
    );
    const current: ChannelDlqIndexEntry[] = Array.isArray(currentRaw)
      ? currentRaw.filter((entry): entry is ChannelDlqIndexEntry => {
          return (
            entry != null &&
            typeof entry === "object" &&
            typeof (entry as ChannelDlqIndexEntry).key === "string"
          );
      })
      : [];
    const liveCurrent = (
      await Promise.all(
        current.map(async (entry) => {
          const projected = await getChannelDlqRecord(
            entry.channel,
            entry.deliveryId,
          );
          return projected ? entry : null;
        }),
      )
    ).filter((entry): entry is ChannelDlqIndexEntry => entry !== null);
    const key = channelFailedKey(record.channel, record.deliveryId);
    const nextEntry: ChannelDlqIndexEntry = {
      channel: record.channel,
      deliveryId: record.deliveryId,
      key,
      failedAt: record.failedAt,
      phase: record.phase,
      terminal: record.terminal,
    };
    const next = [
      nextEntry,
      ...liveCurrent.filter((entry) => entry.key !== key),
    ].slice(0, CHANNEL_DLQ_INDEX_MAX);
    await lock.setValue(indexKey, next, CHANNEL_DLQ_RECORD_TTL_SECONDS);
  });
}

async function acquireChannelDlqLock(key: string): Promise<string> {
  const store = getStore();
  const deadline = Date.now() + CHANNEL_DLQ_LOCK_ACQUIRE_TIMEOUT_MS;
  while (true) {
    const token = await store
      .acquireLock(key, CHANNEL_DLQ_LOCK_TTL_SECONDS)
      .catch(() => null);
    if (token) return token;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) =>
      setTimeout(resolve, CHANNEL_DLQ_LOCK_RETRY_INTERVAL_MS),
    );
  }
  throw new Error(`Channel DLQ lock unavailable: ${key}`);
}

async function withChannelDlqLock<T>(
  key: string,
  fn: (lock: ChannelDlqLockGuard) => Promise<T>,
): Promise<T> {
  const store = getStore();
  const token = await acquireChannelDlqLock(key);
  let renewalLost = false;
  let renewalInFlight: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (renewalInFlight) return;
    renewalInFlight = store
      .renewLock(key, token, CHANNEL_DLQ_LOCK_TTL_SECONDS)
      .then((renewed) => {
        if (!renewed) renewalLost = true;
      })
      .catch((error) => {
        renewalLost = true;
        logWarn("channels.dlq_lock_renewal_failed", {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        renewalInFlight = null;
      });
  }, CHANNEL_DLQ_LOCK_RENEW_INTERVAL_MS);
  (timer as unknown as { unref?: () => void }).unref?.();

  const assertLockHeld = async (): Promise<void> => {
    const renewed = await store.renewLock(
      key,
      token,
      CHANNEL_DLQ_LOCK_TTL_SECONDS,
    );
    if (!renewed) {
      renewalLost = true;
      throw new Error(`Channel DLQ lock ownership lost: ${key}`);
    }
  };
  const setValue = async <V>(
    valueKey: string,
    value: V,
    ttlSeconds: number,
  ): Promise<void> => {
    const written = await store.setValueIfLockHeld(
      key,
      token,
      valueKey,
      value,
      ttlSeconds,
    );
    if (!written) {
      renewalLost = true;
      throw new Error(`Channel DLQ lock ownership lost: ${key}`);
    }
  };

  try {
    const result = await fn({ assertHeld: assertLockHeld, setValue });
    if (renewalInFlight) await renewalInFlight;
    if (renewalLost) {
      throw new Error(`Channel DLQ lock renewal lost: ${key}`);
    }
    return result;
  } finally {
    clearInterval(timer);
    const pendingRenewal = renewalInFlight as Promise<void> | null;
    if (pendingRenewal) await pendingRenewal.catch(() => {});
    await store.releaseLock(key, token).catch(() => {});
  }
}

type ChannelDlqFenceState = "present" | "absent" | "unavailable";

async function readChannelDlqFence(key: string): Promise<ChannelDlqFenceState> {
  try {
    return (await getStore().getValue(key)) === null ? "absent" : "present";
  } catch {
    return "unavailable";
  }
}

async function writeChannelDlqFence(
  key: string,
  value: Record<string, number>,
  ttlSeconds = CHANNEL_DLQ_RECORD_TTL_SECONDS,
): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= CHANNEL_DLQ_FENCE_WRITE_ATTEMPTS; attempt += 1) {
    try {
      await getStore().setValue(
        key,
        value,
        ttlSeconds,
      );
      return;
    } catch (error) {
      lastError = error;
      if (attempt < CHANNEL_DLQ_FENCE_WRITE_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, CHANNEL_DLQ_LOCK_RETRY_INTERVAL_MS),
        );
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Channel DLQ fence write failed: ${key}`);
}
