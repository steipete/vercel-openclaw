import { randomUUID } from "node:crypto";

import type {
  ChannelLastForwardInput,
  ChannelName,
} from "@/shared/channels";
import {
  channelHandoffKey,
  channelHandoffLockKey,
} from "@/server/store/keyspace";
import { getStore } from "@/server/store/store";

const HANDOFF_TTL_SECONDS = 24 * 60 * 60;
const HANDOFF_LOCK_TTL_SECONDS = 10;
const HANDOFF_LOCK_WAIT_MS = 5_000;
const HANDOFF_STALE_START_MS = 5_000;
// Native fast-path fetches may legitimately run for ten minutes. A platform
// retry must not close their ownership while the original request can still
// return an authoritative acceptance result.
export const CHANNEL_FAST_PATH_DISPATCH_STALE_MS = 10 * 60 * 1000 + 30_000;

export type ChannelHandoffState =
  | "acquired"
  | "starting"
  | "fast-path-dispatching"
  | "handed-off"
  | "processing"
  | "workflow-dispatching"
  | "native-accepted"
  | "start-failed"
  | "terminal";

export type ChannelHandoffRecord = {
  revision: number;
  channel: ChannelName;
  deliveryId: string;
  state: ChannelHandoffState;
  attemptId: string;
  envelope: unknown;
  runId: string | null;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  nativeAcceptedForward?: ChannelLastForwardInput | null;
  acceptedCleanupRetry?: {
    attempts: number;
    firstAttemptAtMs: number;
  } | null;
};

type PrepareResult =
  | { action: "start"; attemptId: string }
  | { action: "ack"; state: ChannelHandoffState }
  | { action: "retry"; state: ChannelHandoffState };

export type FastPathDispatchDisposition =
  | { action: "dispatch"; attemptId: string }
  | {
      action: "ack";
      state:
        | "handed-off"
        | "processing"
        | "workflow-dispatching"
        | "native-accepted"
        | "terminal";
    }
  | {
      action: "retry" | "settle-unknown";
      state: "fast-path-dispatching";
      attemptId: string;
      ageMs: number;
    };

export function classifyFastPathDispatch(
  record: ChannelHandoffRecord,
  now = Date.now(),
): Extract<FastPathDispatchDisposition, { state: "fast-path-dispatching" }> {
  const ageMs = Math.max(0, now - record.updatedAt);
  return {
    action:
      ageMs >= CHANNEL_FAST_PATH_DISPATCH_STALE_MS
        ? "settle-unknown"
        : "retry",
    state: "fast-path-dispatching",
    attemptId: record.attemptId,
    ageMs,
  };
}

async function withHandoffLock<T>(
  channel: ChannelName,
  deliveryId: string,
  operation: (
    current: ChannelHandoffRecord | null,
    save: (next: ChannelHandoffRecord) => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  const store = getStore();
  const lockKey = channelHandoffLockKey(channel, deliveryId);
  const deadline = Date.now() + HANDOFF_LOCK_WAIT_MS;
  let token: string | null = null;
  while (!token && Date.now() < deadline) {
    token = await store.acquireLock(lockKey, HANDOFF_LOCK_TTL_SECONDS);
    if (!token) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!token) throw new Error(`channel_handoff_lock_timeout:${channel}`);
  try {
    const key = channelHandoffKey(channel, deliveryId);
    const current = await store.getValue<ChannelHandoffRecord>(key);
    const save = async (next: ChannelHandoffRecord) => {
      const saved = await store.setValueIfLockHeld(
        lockKey,
        token as string,
        key,
        next,
        HANDOFF_TTL_SECONDS,
      );
      if (!saved) throw new Error(`channel_handoff_lock_lost:${channel}`);
    };
    return await operation(current, save);
  } finally {
    await store.releaseLock(lockKey, token).catch(() => {});
  }
}

export async function prepareChannelHandoff(input: {
  channel: ChannelName;
  deliveryId: string;
  envelope: unknown;
}): Promise<PrepareResult> {
  return withHandoffLock(input.channel, input.deliveryId, async (current, save) => {
    const now = Date.now();
    if (
      current?.state === "handed-off" ||
      current?.state === "processing" ||
      current?.state === "workflow-dispatching" ||
      current?.state === "native-accepted" ||
      current?.state === "terminal"
    ) {
      return { action: "ack", state: current.state };
    }
    if (
      current &&
      (current.state === "acquired" || current.state === "starting") &&
      now - current.updatedAt < HANDOFF_STALE_START_MS
    ) {
      return { action: "retry", state: current.state };
    }

    const attemptId = randomUUID();
    await save({
      revision: (current?.revision ?? 0) + 1,
      channel: input.channel,
      deliveryId: input.deliveryId,
      state: "acquired",
      attemptId,
      envelope: input.envelope,
      runId: null,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      error: null,
      nativeAcceptedForward: null,
      acceptedCleanupRetry: null,
    });
    return { action: "start", attemptId };
  });
}

async function transitionChannelHandoff(input: {
  channel: ChannelName;
  deliveryId: string;
  attemptId: string;
  state: ChannelHandoffState;
  runId?: string | null;
  error?: string | null;
}): Promise<void> {
  await withHandoffLock(input.channel, input.deliveryId, async (current, save) => {
    if (!current || current.attemptId !== input.attemptId) return;
    if (
      current.state === "processing" ||
      current.state === "workflow-dispatching" ||
      current.state === "native-accepted" ||
      current.state === "terminal"
    ) return;
    await save({
      ...current,
      revision: current.revision + 1,
      state: input.state,
      runId: input.runId ?? current.runId,
      updatedAt: Date.now(),
      error: input.error ?? null,
    });
  });
}

export function markChannelHandoffStarting(input: {
  channel: ChannelName;
  deliveryId: string;
  attemptId: string;
}): Promise<void> {
  return transitionChannelHandoff({ ...input, state: "starting" });
}

export function markChannelHandoffHandedOff(input: {
  channel: ChannelName;
  deliveryId: string;
  attemptId: string;
  runId: string;
}): Promise<void> {
  return transitionChannelHandoff({ ...input, state: "handed-off" });
}

export function markChannelHandoffStartFailed(input: {
  channel: ChannelName;
  deliveryId: string;
  attemptId: string;
  error: unknown;
}): Promise<void> {
  return transitionChannelHandoff({
    ...input,
    state: "start-failed",
    error: input.error instanceof Error ? input.error.message : String(input.error),
  });
}

export async function claimChannelHandoff(input: {
  channel: ChannelName;
  deliveryId: string;
  attemptId: string;
  runId: string;
}): Promise<boolean> {
  return withHandoffLock(input.channel, input.deliveryId, async (current, save) => {
    if (!current || current.attemptId !== input.attemptId) return false;
    if (current.state === "processing") return current.runId === input.runId;
    if (
      current.state === "workflow-dispatching" ||
      current.state === "native-accepted"
    ) {
      return current.runId === input.runId;
    }
    if (current.state === "terminal") return false;
    await save({
      ...current,
      revision: current.revision + 1,
      state: "processing",
      runId: input.runId,
      updatedAt: Date.now(),
      error: null,
    });
    return true;
  });
}

export type ChannelWorkflowDispatchDisposition =
  | { action: "dispatch" }
  | { action: "resume-accepted" }
  | { action: "settle-unknown" }
  | { action: "skip" };

/** Fence the exact Workflow owner before its non-idempotent native dispatch. */
export async function beginChannelWorkflowDispatch(input: {
  channel: ChannelName;
  deliveryId: string;
  attemptId: string;
  runId: string;
}): Promise<ChannelWorkflowDispatchDisposition> {
  return withHandoffLock(input.channel, input.deliveryId, async (current, save) => {
    if (
      !current ||
      current.attemptId !== input.attemptId ||
      current.runId !== input.runId
    ) {
      return { action: "skip" };
    }
    if (current.state === "native-accepted") {
      return { action: "resume-accepted" };
    }
    if (current.state === "workflow-dispatching") {
      return { action: "settle-unknown" };
    }
    if (current.state !== "processing") {
      return { action: "skip" };
    }
    await save({
      ...current,
      revision: current.revision + 1,
      state: "workflow-dispatching",
      updatedAt: Date.now(),
      error: null,
    });
    return { action: "dispatch" };
  });
}

/** Persist authoritative native acceptance without coupling it to UI cleanup. */
export async function markChannelWorkflowNativeAccepted(input: {
  channel: ChannelName;
  deliveryId: string;
  attemptId: string;
  runId: string;
  acceptedForward: ChannelLastForwardInput;
}): Promise<boolean> {
  return withHandoffLock(input.channel, input.deliveryId, async (current, save) => {
    if (
      !current ||
      current.attemptId !== input.attemptId ||
      current.runId !== input.runId
    ) {
      return false;
    }
    if (current.state === "native-accepted") return true;
    if (current.state !== "workflow-dispatching") return false;
    await save({
      ...current,
      revision: current.revision + 1,
      state: "native-accepted",
      updatedAt: Date.now(),
      error: null,
      nativeAcceptedForward: input.acceptedForward,
      acceptedCleanupRetry: null,
    });
    return true;
  });
}

/** Count cleanup failures independently after native acceptance is durable. */
export async function reserveChannelAcceptedCleanupAttempt(input: {
  channel: ChannelName;
  deliveryId: string;
  attemptId: string;
  runId: string;
}): Promise<{ attempt: number; firstAttemptAtMs: number } | null> {
  return withHandoffLock(input.channel, input.deliveryId, async (current, save) => {
    if (
      !current ||
      current.state !== "native-accepted" ||
      current.attemptId !== input.attemptId ||
      current.runId !== input.runId
    ) {
      return null;
    }
    const now = Date.now();
    const next = {
      attempts: (current.acceptedCleanupRetry?.attempts ?? 0) + 1,
      firstAttemptAtMs:
        current.acceptedCleanupRetry?.firstAttemptAtMs ?? now,
    };
    await save({
      ...current,
      revision: current.revision + 1,
      updatedAt: now,
      acceptedCleanupRetry: next,
    });
    return { attempt: next.attempts, firstAttemptAtMs: next.firstAttemptAtMs };
  });
}

/** Re-open only a dispatch that the native handler definitely rejected. */
export async function resetChannelWorkflowDispatch(input: {
  channel: ChannelName;
  deliveryId: string;
  attemptId: string;
  runId: string;
}): Promise<boolean> {
  return withHandoffLock(input.channel, input.deliveryId, async (current, save) => {
    if (
      !current ||
      current.state !== "workflow-dispatching" ||
      current.attemptId !== input.attemptId ||
      current.runId !== input.runId
    ) {
      return false;
    }
    await save({
      ...current,
      revision: current.revision + 1,
      state: "processing",
      updatedAt: Date.now(),
      error: null,
    });
    return true;
  });
}

export async function markChannelDeliveryTerminal(input: {
  channel: ChannelName;
  deliveryId: string;
  expectedAttemptId?: string | null;
}): Promise<boolean> {
  return withHandoffLock(input.channel, input.deliveryId, async (current, save) => {
    if (current?.state === "native-accepted") return false;
    if (
      input.expectedAttemptId &&
      (!current ||
        current.attemptId !== input.expectedAttemptId ||
        current.state !== "fast-path-dispatching")
    ) {
      return false;
    }
    const now = Date.now();
    await save({
      revision: (current?.revision ?? 0) + 1,
      channel: input.channel,
      deliveryId: input.deliveryId,
      state: "terminal",
      attemptId: current?.attemptId ?? `direct:${randomUUID()}`,
      envelope: current?.envelope ?? null,
      runId: current?.runId ?? null,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      error: current?.error ?? null,
      nativeAcceptedForward: current?.nativeAcceptedForward ?? null,
      acceptedCleanupRetry: current?.acceptedCleanupRetry ?? null,
    });
    return true;
  });
}

export async function markChannelFastPathDispatching(input: {
  channel: ChannelName;
  deliveryId: string;
}): Promise<FastPathDispatchDisposition> {
  return withHandoffLock(input.channel, input.deliveryId, async (current, save) => {
    const now = Date.now();
    if (
      current?.state === "handed-off" ||
      current?.state === "processing" ||
      current?.state === "workflow-dispatching" ||
      current?.state === "native-accepted" ||
      current?.state === "terminal"
    ) {
      return { action: "ack", state: current.state };
    }
    if (current?.state === "fast-path-dispatching") {
      return classifyFastPathDispatch(current, now);
    }
    const attemptId = `fast:${randomUUID()}`;
    await save({
      revision: (current?.revision ?? 0) + 1,
      channel: input.channel,
      deliveryId: input.deliveryId,
      state: "fast-path-dispatching",
      attemptId,
      envelope: current?.envelope ?? null,
      runId: null,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      error: null,
      nativeAcceptedForward: null,
      acceptedCleanupRetry: null,
    });
    return { action: "dispatch", attemptId };
  });
}

/** Extend the exact active native-dispatch owner before another bounded fetch. */
export async function renewChannelFastPathDispatch(input: {
  channel: ChannelName;
  deliveryId: string;
  attemptId: string;
}): Promise<boolean> {
  return withHandoffLock(input.channel, input.deliveryId, async (current, save) => {
    if (
      !current
      || current.state !== "fast-path-dispatching"
      || current.attemptId !== input.attemptId
    ) return false;
    await save({
      ...current,
      revision: current.revision + 1,
      updatedAt: Date.now(),
    });
    return true;
  });
}

export async function readChannelHandoff(
  channel: ChannelName,
  deliveryId: string,
): Promise<ChannelHandoffRecord | null> {
  return getStore().getValue<ChannelHandoffRecord>(
    channelHandoffKey(channel, deliveryId),
  );
}
