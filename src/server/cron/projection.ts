import { createHash, randomUUID } from "node:crypto";

import {
  cronJobsKey,
  cronNextWakeKey,
  cronProjectionKey,
} from "@/server/store/keyspace";
import { getStore, type Store } from "@/server/store/store";

const PROJECTION_CAS_ATTEMPTS = 12;
export const CRON_PROJECTION_MAX_WAKES = 4_096;
export const CRON_PROJECTION_MAX_BODY_BYTES = 512 * 1024;
export const CRON_PROJECTION_SOURCE_LEASE_MS = 60_000;
const MAX_DATE_MS = 8_640_000_000_000_000;
const MAX_SOURCE_CLOCK_SKEW_MS = 10 * 60_000;

export type CronProjectionReason = "startup" | "reload" | "changed";

export type CronProjectionInputV1 = {
  schemaVersion: 1;
  gatewayGeneration: string;
  sourceId: string;
  sourceLeaseToken: string | null;
  /** Internal parser marker; absent on direct trusted callers means provided. */
  sourceLeaseTokenProvided?: boolean;
  sourceStartedAtMs: number;
  sourceRevision: number;
  reason: CronProjectionReason;
  projectedAtMs: number;
  wakes: Array<{ jobKey: string; runAtMs: number }>;
};

export type SanitizedCronWake = {
  jobKey: string;
  runAtMs: number;
};

type CronDispatchIdentity = {
  token: string;
  runAtMs: number;
  wakeAtMs: number;
  attempt: number;
};

export type CronDispatchState =
  | { status: "none" }
  | (CronDispatchIdentity & { status: "pending" })
  | (CronDispatchIdentity & {
      status: "starting";
      startLeaseExpiresAtMs: number;
      repairWorkflowRunId: string;
    })
  | (CronDispatchIdentity & {
      status: "scheduled";
      workflowRunId: string;
      executionWorkflowRunId: string | null;
      legacyWorkflowOwner?: true;
      scheduledAtMs: number;
    })
  | (CronDispatchIdentity & {
      status: "running";
      claimedAtMs: number;
      workflowRunId: string;
      executionWorkflowRunId: string;
      legacyWorkflowOwner?: true;
    })
  | (CronDispatchIdentity & {
      status: "completed";
      completedAtMs: number;
      workflowRunId: string;
      executionWorkflowRunId: string;
      legacyWorkflowOwner?: true;
    })
  | (CronDispatchIdentity & {
      status: "failed";
      failedAtMs: number;
      retryAtMs: number;
      errorCode: string;
    });

export type CronProjectionRecordV1 = {
  schemaVersion: 1;
  /** Binds projections to the current sandbox gateway credential generation. */
  gatewayGeneration: string | null;
  /** CAS revision for every record mutation. */
  revision: number;
  /** Advances only when an authoritative full projection is accepted. */
  projectionRevision: number;
  source: {
    key: string;
    epoch: number;
    leaseToken: string;
    startedAtMs: number;
    revision: number;
    reason: CronProjectionReason;
    projectedAtMs: number;
  } | null;
  digest: string;
  wakes: SanitizedCronWake[];
  nextRunAtMs: number | null;
  acceptedAtMs: number;
  /** Latest reset fence; projections from older sandbox processes are stale. */
  resetAtMs: number | null;
  dispatch: CronDispatchState;
  migration: {
    legacyWakeImportedAtMs: number | null;
    legacyBootstrapWakeAtMs: number | null;
    legacyWakeClearedAtMs: number | null;
  };
};

export type AcceptCronProjectionResult =
  | {
      status: "accepted";
      record: CronProjectionRecordV1;
      supersededWorkflowRunId: string | null;
      sourceLeaseToken: string;
    }
  | {
      status: "idempotent";
      record: CronProjectionRecordV1;
      supersededWorkflowRunId: null;
      sourceLeaseToken: string;
    }
  | {
      status: "stale";
      record: CronProjectionRecordV1;
      supersededWorkflowRunId: null;
      retryAfterMs: number | null;
      sourceLeaseToken: null;
    };

export type FenceCronProjectionResult = {
  record: CronProjectionRecordV1;
  supersededWorkflowRunId: string | null;
};

export type CronProjectionDiagnostics = {
  schemaVersion: 1;
  revision: number;
  projectionRevision: number;
  sourceRevision: number | null;
  sourceReason: CronProjectionReason | "legacy-migration" | "reset-fence";
  sourceProjectedAtMs: number | null;
  acceptedAtMs: number;
  digest: string;
  wakeCount: number;
  nextRunAtMs: number | null;
  dispatchStatus: CronDispatchState["status"];
  dispatchTokenHash: string | null;
  dispatchRunAtMs: number | null;
  dispatchWakeAtMs: number | null;
  dispatchAttempt: number | null;
  dispatchStartLeaseExpiresAtMs: number | null;
  dispatchScheduledAtMs: number | null;
  dispatchClaimedAtMs: number | null;
  dispatchCompletedAtMs: number | null;
  dispatchFailedAtMs: number | null;
  dispatchRetryAtMs: number | null;
  workflowRunId: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullablePositiveSafeInteger(value: unknown): value is number | null {
  return value === null || isPositiveSafeInteger(value);
}

function isHex(value: unknown, length: number): value is string {
  return typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
}

function hashSourceId(sourceId: string): string {
  return createHash("sha256").update(sourceId).digest("hex").slice(0, 32);
}

function digestWakes(wakes: readonly SanitizedCronWake[]): string {
  return createHash("sha256").update(JSON.stringify(wakes)).digest("hex");
}

function createDispatch(nextRunAtMs: number | null, attempt = 0): CronDispatchState {
  if (nextRunAtMs === null) return { status: "none" };
  return {
    status: "pending",
    token: randomUUID(),
    runAtMs: nextRunAtMs,
    wakeAtMs: nextRunAtMs,
    attempt,
  };
}

export function parseCronProjectionInput(
  value: unknown,
  options: { now?: () => number } = {},
): { ok: true; value: CronProjectionInputV1 } | { ok: false; message: string } {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return { ok: false, message: "schemaVersion must be 1" };
  }
  if (!isHex(value.gatewayGeneration, 32)) {
    return { ok: false, message: "gatewayGeneration is invalid" };
  }
  if (
    typeof value.sourceId !== "string" ||
    value.sourceId.length < 8 ||
    value.sourceId.length > 128
  ) {
    return { ok: false, message: "sourceId must be an 8-128 character string" };
  }
  if (
    value.sourceLeaseToken !== undefined &&
    value.sourceLeaseToken !== null &&
    (typeof value.sourceLeaseToken !== "string" ||
      value.sourceLeaseToken.length < 16 ||
      value.sourceLeaseToken.length > 128)
  ) {
    return { ok: false, message: "sourceLeaseToken is invalid" };
  }
  if (!isPositiveSafeInteger(value.sourceStartedAtMs)) {
    return { ok: false, message: "sourceStartedAtMs must be a positive integer" };
  }
  const now = options.now?.() ?? Date.now();
  if (value.sourceStartedAtMs > now + MAX_SOURCE_CLOCK_SKEW_MS) {
    return { ok: false, message: "sourceStartedAtMs is too far in the future" };
  }
  if (!isPositiveSafeInteger(value.sourceRevision)) {
    return { ok: false, message: "sourceRevision must be a positive integer" };
  }
  if (!isPositiveSafeInteger(value.projectedAtMs)) {
    return { ok: false, message: "projectedAtMs must be a positive integer" };
  }
  if (value.projectedAtMs > now + MAX_SOURCE_CLOCK_SKEW_MS) {
    return { ok: false, message: "projectedAtMs is too far in the future" };
  }
  if (!(["startup", "reload", "changed"] as const).includes(value.reason as never)) {
    return { ok: false, message: "reason is invalid" };
  }
  if (!Array.isArray(value.wakes) || value.wakes.length > CRON_PROJECTION_MAX_WAKES) {
    return {
      ok: false,
      message: `wakes must contain at most ${CRON_PROJECTION_MAX_WAKES} entries`,
    };
  }

  const wakes: CronProjectionInputV1["wakes"] = [];
  const jobKeys = new Set<string>();
  for (const candidate of value.wakes) {
    if (!isRecord(candidate)) {
      return { ok: false, message: "every wake must be an object" };
    }
    if (
      !isHex(candidate.jobKey, 32)
    ) {
      return { ok: false, message: "wake jobKey is invalid" };
    }
    if (jobKeys.has(candidate.jobKey)) {
      return { ok: false, message: "wake jobKeys must be unique" };
    }
    if (
      !isPositiveSafeInteger(candidate.runAtMs) ||
      candidate.runAtMs > MAX_DATE_MS
    ) {
      return { ok: false, message: "wake runAtMs must be a valid future Date" };
    }
    jobKeys.add(candidate.jobKey);
    wakes.push({ jobKey: candidate.jobKey, runAtMs: candidate.runAtMs });
  }

  return {
    ok: true,
    value: {
      schemaVersion: 1,
      gatewayGeneration: value.gatewayGeneration,
      sourceId: value.sourceId,
      sourceLeaseToken:
        typeof value.sourceLeaseToken === "string"
          ? value.sourceLeaseToken
          : null,
      sourceLeaseTokenProvided: Object.hasOwn(value, "sourceLeaseToken"),
      sourceStartedAtMs: value.sourceStartedAtMs,
      sourceRevision: value.sourceRevision,
      reason: value.reason as CronProjectionReason,
      projectedAtMs: value.projectedAtMs,
      wakes,
    },
  };
}

function sanitizeWakes(input: CronProjectionInputV1): SanitizedCronWake[] {
  return input.wakes
    .map((wake) => ({ jobKey: wake.jobKey, runAtMs: wake.runAtMs }))
    .sort((left, right) =>
      left.runAtMs - right.runAtMs || left.jobKey.localeCompare(right.jobKey),
    );
}

function compareSource(
  current: CronProjectionRecordV1,
  input: CronProjectionInputV1,
  digest: string,
  now: number,
): "newer" | "same" | "stale" | "leased" {
  if (
    current.gatewayGeneration !== null &&
    input.gatewayGeneration !== current.gatewayGeneration
  ) {
    return "stale";
  }
  if (!current.source) return "newer";
  const sourceKey = hashSourceId(input.sourceId);
  if (sourceKey === current.source.key) {
    if (input.sourceRevision < current.source.revision) return "stale";
    if (input.sourceRevision === current.source.revision) {
      return digest === current.digest ? "same" : "stale";
    }
    return input.sourceLeaseToken === null ||
      input.sourceLeaseToken === current.source.leaseToken
      ? "newer"
      : "stale";
  }
  // Pre-token plugins may renew their current source during rollout, but once
  // superseded they can never contend for ownership again.
  if (input.sourceLeaseTokenProvided === false) return "stale";
  // Only a fresh source may contend for an expired lease. A superseded
  // process keeps its old token and must never reclaim ownership later.
  if (input.sourceLeaseToken !== null) return "stale";
  // A host clock rollback must not extend another process's lease without
  // bound. Treat a future acceptance timestamp as an expired lease.
  if (current.acceptedAtMs > now) return "newer";
  // Process clocks and UUID ordering cannot establish Gateway ownership.
  // A live source renews this bounded host lease with every newer snapshot;
  // after silence, any process from the same gateway generation may take over.
  return current.acceptedAtMs + CRON_PROJECTION_SOURCE_LEASE_MS <= now
    ? "newer"
    : "leased";
}

export async function readCronProjection(
  store: Store = getStore(),
): Promise<CronProjectionRecordV1 | null> {
  const state = await readCronProjectionState(store);
  if (state.status === "corrupt") {
    throw new Error("cron_projection_state_corrupt");
  }
  return state.status === "valid" ? state.record : null;
}

export type CronProjectionReadState =
  | { status: "absent" }
  | { status: "corrupt"; token: string }
  | { status: "valid"; record: CronProjectionRecordV1; token: string };

function migrateCronProjectionRecord(
  value: unknown,
): CronProjectionRecordV1 | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  const candidate: Record<string, unknown> = { ...value };
  if (isPositiveSafeInteger(value.revision)) {
    candidate.revision = value.revision + 1;
  }
  if (isRecord(value.source)) {
    candidate.source = {
      ...value.source,
      epoch: value.source.epoch === undefined ? 1 : value.source.epoch,
      leaseToken:
        value.source.leaseToken === undefined
          ? randomUUID()
          : value.source.leaseToken,
    };
  }
  if (isRecord(value.dispatch)) {
    switch (value.dispatch.status) {
      case "starting":
        if (value.dispatch.repairWorkflowRunId === undefined) {
          candidate.dispatch = {
            status: "pending",
            token: randomUUID(),
            runAtMs: value.dispatch.runAtMs,
            wakeAtMs: value.dispatch.wakeAtMs,
            attempt: value.dispatch.attempt,
          };
        }
        break;
      case "scheduled":
        if (value.dispatch.executionWorkflowRunId === undefined) {
          candidate.dispatch = {
            ...value.dispatch,
            executionWorkflowRunId: null,
            legacyWorkflowOwner: true,
          };
        }
        break;
      case "running":
      case "completed":
        if (value.dispatch.executionWorkflowRunId === undefined) {
          candidate.dispatch = {
            ...value.dispatch,
            executionWorkflowRunId: value.dispatch.workflowRunId,
            legacyWorkflowOwner: true,
          };
        }
        break;
    }
  }
  return isCronProjectionRecord(candidate) ? candidate : null;
}

export async function readCronProjectionState(
  store: Store = getStore(),
): Promise<CronProjectionReadState> {
  for (let attempt = 0; attempt < PROJECTION_CAS_ATTEMPTS; attempt += 1) {
    const state = await store.getValueState<unknown>(cronProjectionKey());
    if (state.status === "absent") return { status: "absent" };
    if (isCronProjectionRecord(state.value)) {
      return { status: "valid", record: state.value, token: state.token };
    }
    const migrated = migrateCronProjectionRecord(state.value);
    if (!migrated) return { status: "corrupt", token: state.token };
    if (
      await store.compareAndSetValueToken(
        cronProjectionKey(),
        state.token,
        migrated,
      )
    ) {
      const saved = await store.getValueState<CronProjectionRecordV1>(
        cronProjectionKey(),
      );
      if (saved.status === "present" && isCronProjectionRecord(saved.value)) {
        return { status: "valid", record: saved.value, token: saved.token };
      }
    }
  }
  throw new Error("cron_projection_migration_cas_exhausted");
}

export async function getCronProjectionDiagnostics(
  store: Store = getStore(),
): Promise<CronProjectionDiagnostics | null> {
  const record = await readCronProjection(store);
  if (!record) return null;
  const dispatch = record.dispatch;
  return {
    schemaVersion: 1,
    revision: record.revision,
    projectionRevision: record.projectionRevision,
    sourceRevision: record.source?.revision ?? null,
    sourceReason:
      record.source?.reason ??
      (record.resetAtMs ? "reset-fence" : "legacy-migration"),
    sourceProjectedAtMs: record.source?.projectedAtMs ?? null,
    acceptedAtMs: record.acceptedAtMs,
    digest: record.digest,
    wakeCount: record.wakes.length,
    nextRunAtMs: record.nextRunAtMs,
    dispatchStatus: dispatch.status,
    dispatchTokenHash:
      dispatch.status === "none"
        ? null
        : createHash("sha256").update(dispatch.token).digest("hex").slice(0, 16),
    dispatchRunAtMs: dispatch.status === "none" ? null : dispatch.runAtMs,
    dispatchWakeAtMs: dispatch.status === "none" ? null : dispatch.wakeAtMs,
    dispatchAttempt: dispatch.status === "none" ? null : dispatch.attempt,
    dispatchStartLeaseExpiresAtMs:
      dispatch.status === "starting" ? dispatch.startLeaseExpiresAtMs : null,
    dispatchScheduledAtMs:
      dispatch.status === "scheduled" ? dispatch.scheduledAtMs : null,
    dispatchClaimedAtMs:
      dispatch.status === "running" ? dispatch.claimedAtMs : null,
    dispatchCompletedAtMs:
      dispatch.status === "completed" ? dispatch.completedAtMs : null,
    dispatchFailedAtMs:
      dispatch.status === "failed" ? dispatch.failedAtMs : null,
    dispatchRetryAtMs:
      dispatch.status === "failed" ? dispatch.retryAtMs : null,
    workflowRunId:
      dispatch.status === "scheduled" ||
      dispatch.status === "running" ||
      dispatch.status === "completed"
        ? dispatch.workflowRunId
        : null,
  };
}

function scheduledWorkflowRunId(
  record: CronProjectionRecordV1 | null,
): string | null {
  return record?.dispatch.status === "scheduled"
    ? record.dispatch.workflowRunId
    : null;
}

function activeWorkflowRunId(
  record: CronProjectionRecordV1 | null,
): string | null {
  return record?.dispatch.status === "scheduled" ||
    record?.dispatch.status === "running" ||
    record?.dispatch.status === "completed"
    ? record.dispatch.workflowRunId
    : null;
}

export async function acceptCronProjection(
  input: CronProjectionInputV1,
  options: { store?: Store; now?: () => number } = {},
): Promise<AcceptCronProjectionResult> {
  const store = options.store ?? getStore();
  const now = options.now ?? Date.now;
  const wakes = sanitizeWakes(input);
  const digest = digestWakes(wakes);

  for (let attempt = 0; attempt < PROJECTION_CAS_ATTEMPTS; attempt += 1) {
    const current = await readCronProjection(store);
    if (current) {
      const acceptedAtMs = now();
      const comparison = compareSource(current, input, digest, acceptedAtMs);
      if (comparison === "same") {
        return {
          status: "idempotent",
          record: current,
          supersededWorkflowRunId: null,
          sourceLeaseToken: current.source!.leaseToken,
        };
      }
      if (comparison === "stale") {
        return {
          status: "stale",
          record: current,
          supersededWorkflowRunId: null,
          retryAfterMs: null,
          sourceLeaseToken: null,
        };
      }
      if (comparison === "leased") {
        return {
          status: "stale",
          record: current,
          supersededWorkflowRunId: null,
          sourceLeaseToken: null,
          retryAfterMs: Math.max(
            1_000,
            current.acceptedAtMs + CRON_PROJECTION_SOURCE_LEASE_MS -
              acceptedAtMs,
          ),
        };
      }
      if (current.digest === digest) {
        const sourceKey = hashSourceId(input.sourceId);
        const sameSource = current.source?.key === sourceKey;
        const next: CronProjectionRecordV1 = {
          ...current,
          revision: current.revision + 1,
          source: {
            key: sourceKey,
            epoch: sameSource ? current.source!.epoch : current.source!.epoch + 1,
            leaseToken: sameSource
              ? current.source!.leaseToken
              : randomUUID(),
            startedAtMs: input.sourceStartedAtMs,
            revision: input.sourceRevision,
            reason: input.reason,
            projectedAtMs: input.projectedAtMs,
          },
          acceptedAtMs,
        };
        if (
          await store.compareAndSetValue(
            cronProjectionKey(),
            current.revision,
            next,
          )
        ) {
          return {
            status: "idempotent",
            record: next,
            supersededWorkflowRunId: null,
            sourceLeaseToken: next.source!.leaseToken,
          };
        }
        continue;
      }
    }

    const nextRunAtMs = wakes[0]?.runAtMs ?? null;
    const sourceKey = hashSourceId(input.sourceId);
    const sameSource = current?.source?.key === sourceKey;
    const next: CronProjectionRecordV1 = {
      schemaVersion: 1,
      gatewayGeneration: input.gatewayGeneration,
      revision: (current?.revision ?? 0) + 1,
      projectionRevision: (current?.projectionRevision ?? 0) + 1,
      source: {
        key: sourceKey,
        epoch: sameSource ? current.source!.epoch : (current?.source?.epoch ?? 0) + 1,
        leaseToken: sameSource
          ? current.source!.leaseToken
          : randomUUID(),
        startedAtMs: input.sourceStartedAtMs,
        revision: input.sourceRevision,
        reason: input.reason,
        projectedAtMs: input.projectedAtMs,
      },
      digest,
      wakes,
      nextRunAtMs,
      acceptedAtMs: now(),
      resetAtMs: current?.resetAtMs ?? null,
      dispatch: createDispatch(nextRunAtMs),
      migration: {
        legacyWakeImportedAtMs:
          current?.migration.legacyWakeImportedAtMs ?? null,
        legacyBootstrapWakeAtMs:
          current?.migration.legacyBootstrapWakeAtMs ?? null,
        legacyWakeClearedAtMs:
          current?.migration.legacyWakeClearedAtMs ?? null,
      },
    };
    const saved = await store.compareAndSetValue(
      cronProjectionKey(),
      current?.revision ?? null,
      next,
    );
    if (saved) {
      return {
        status: "accepted",
        record: next,
        supersededWorkflowRunId: scheduledWorkflowRunId(current),
        sourceLeaseToken: next.source!.leaseToken,
      };
    }
  }

  throw new Error("cron_projection_cas_exhausted");
}

export async function mutateCronProjection(
  mutator: (current: CronProjectionRecordV1) => CronProjectionRecordV1 | null,
  store: Store = getStore(),
): Promise<CronProjectionRecordV1 | null> {
  for (let attempt = 0; attempt < PROJECTION_CAS_ATTEMPTS; attempt += 1) {
    const current = await readCronProjection(store);
    if (!current) return null;
    const candidate = mutator(structuredClone(current));
    if (!candidate) return current;
    const next = { ...candidate, revision: current.revision + 1 };
    if (!isCronProjectionRecord(next)) {
      throw new Error("cron_projection_mutation_invalid");
    }
    if (
      await store.compareAndSetValue(
        cronProjectionKey(),
        current.revision,
        next,
      )
    ) {
      return next;
    }
  }
  throw new Error("cron_projection_cas_exhausted");
}

export async function migrateLegacyCronWake(
  options: {
    store?: Store;
    now?: () => number;
    enabled: boolean;
    bootstrapFromLegacyJobs?: boolean;
  },
): Promise<CronProjectionRecordV1 | null> {
  if (!options.enabled) return readCronProjection(options.store);
  const store = options.store ?? getStore();
  const current = await readCronProjection(store);
  if (current) return current;

  const rawWake = await store.getValue<unknown>(cronNextWakeKey());
  const now = options.now ?? Date.now;
  const legacyWake = isPositiveSafeInteger(rawWake) ? rawWake : null;
  const bootstrapWake =
    legacyWake === null &&
    options.bootstrapFromLegacyJobs === true &&
    (await store.hasValue(cronJobsKey()))
      ? now()
      : null;
  const nextRunAtMs = legacyWake ?? bootstrapWake;
  if (nextRunAtMs === null) return null;
  const acceptedAtMs = now();
  const next: CronProjectionRecordV1 = {
    schemaVersion: 1,
    gatewayGeneration: null,
    revision: 1,
    projectionRevision: 0,
    source: null,
    digest: createHash("sha256")
      .update(legacyWake ? `legacy:${legacyWake}` : "legacy-jobs-presence")
      .digest("hex"),
    wakes: [],
    nextRunAtMs,
    acceptedAtMs,
    resetAtMs: null,
    dispatch: createDispatch(nextRunAtMs),
    migration: {
      legacyWakeImportedAtMs: legacyWake === null ? null : acceptedAtMs,
      legacyBootstrapWakeAtMs: bootstrapWake,
      legacyWakeClearedAtMs: null,
    },
  };
  const saved = await store.compareAndSetValue(cronProjectionKey(), null, next);
  return saved ? next : readCronProjection(store);
}

export async function clearLegacyCronStateAfterBaseline(
  options: { store?: Store; now?: () => number } = {},
): Promise<CronProjectionRecordV1 | null> {
  const store = options.store ?? getStore();
  const current = await readCronProjection(store);
  if (!current?.source) {
    return current;
  }

  await store.deleteValue(cronNextWakeKey());
  if (current.migration.legacyWakeClearedAtMs !== null) {
    return current;
  }
  const now = options.now ?? Date.now;
  return mutateCronProjection((latest) => {
    if (!latest.source || latest.migration.legacyWakeClearedAtMs !== null) {
      return null;
    }
    latest.migration.legacyWakeClearedAtMs = now();
    return latest;
  }, store);
}

export async function fenceCronProjectionStateForReset(
  options: {
    gatewayGeneration: string;
    expectedGatewayGeneration: string | null;
    store?: Store;
    now?: () => number;
  },
): Promise<FenceCronProjectionResult> {
  if (!isHex(options.gatewayGeneration, 32)) {
    throw new Error("cron_projection_gateway_generation_invalid");
  }
  if (
    options.expectedGatewayGeneration !== null
    && !isHex(options.expectedGatewayGeneration, 32)
  ) {
    throw new Error("cron_projection_expected_gateway_generation_invalid");
  }
  const store = options.store ?? getStore();
  const now = options.now ?? Date.now;
  for (let attempt = 0; attempt < PROJECTION_CAS_ATTEMPTS; attempt += 1) {
    const state = await readCronProjectionState(store);
    const current = state.status === "valid" ? state.record : null;
    if (
      current?.gatewayGeneration === options.gatewayGeneration
      && current.source === null
      && current.dispatch.status === "none"
    ) {
      return { record: current, supersededWorkflowRunId: null };
    }
    if (
      current
      && current.gatewayGeneration !== null
      && current.gatewayGeneration !== options.expectedGatewayGeneration
    ) {
      throw new Error("cron_projection_reset_generation_superseded");
    }
    const resetAtMs = now();
    const next: CronProjectionRecordV1 = {
      schemaVersion: 1,
      gatewayGeneration: options.gatewayGeneration,
      revision: (current?.revision ?? 0) + 1,
      projectionRevision: (current?.projectionRevision ?? 0) + 1,
      source: null,
      digest: createHash("sha256").update(`reset:${resetAtMs}`).digest("hex"),
      wakes: [],
      nextRunAtMs: null,
      acceptedAtMs: resetAtMs,
      resetAtMs,
      dispatch: { status: "none" },
      migration: {
        legacyWakeImportedAtMs:
          current?.migration.legacyWakeImportedAtMs ?? null,
        legacyBootstrapWakeAtMs:
          current?.migration.legacyBootstrapWakeAtMs ?? null,
        legacyWakeClearedAtMs: resetAtMs,
      },
    };
    const saved =
      state.status === "corrupt"
        ? await store.compareAndSetValueToken(
            cronProjectionKey(),
            state.token,
            next,
          )
        : await store.compareAndSetValue(
            cronProjectionKey(),
            current?.revision ?? null,
            next,
          );
    if (saved) {
      return {
        record: next,
        supersededWorkflowRunId: activeWorkflowRunId(current),
      };
    }
  }
  throw new Error("cron_projection_reset_fence_cas_exhausted");
}

export async function clearLegacyCronStateForReset(options: {
  gatewayGeneration: string;
  projectionRevision: number;
  store?: Store;
}): Promise<boolean> {
  const store = options.store ?? getStore();
  const state = await readCronProjectionState(store);
  if (
    state.status !== "valid" ||
    state.record.gatewayGeneration !== options.gatewayGeneration ||
    state.record.projectionRevision !== options.projectionRevision ||
    state.record.source !== null ||
    state.record.resetAtMs === null ||
    state.record.dispatch.status !== "none"
  ) {
    return false;
  }
  return store.deleteValuesIfValueToken(
    cronProjectionKey(),
    state.token,
    [cronNextWakeKey(), cronJobsKey()],
  );
}

export async function normalizeResetCronProjectionGeneration(options: {
  gatewayGeneration: string;
  expectedGatewayGeneration: string | null;
  store?: Store;
}): Promise<CronProjectionRecordV1 | null> {
  if (!isHex(options.gatewayGeneration, 32)) {
    throw new Error("cron_projection_gateway_generation_invalid");
  }
  return mutateCronProjection((latest) => {
    if (
      latest.source !== null ||
      latest.dispatch.status !== "none" ||
      latest.gatewayGeneration !== options.expectedGatewayGeneration ||
      latest.gatewayGeneration === options.gatewayGeneration
    ) {
      return null;
    }
    latest.gatewayGeneration = options.gatewayGeneration;
    return latest;
  }, options.store);
}

export function isCronProjectionRecord(value: unknown): value is CronProjectionRecordV1 {
  if (!isRecord(value)) return false;
  if (
    value.schemaVersion !== 1 ||
    !(
      value.gatewayGeneration === null ||
      isHex(value.gatewayGeneration, 32)
    ) ||
    !isPositiveSafeInteger(value.revision) ||
    !isNonNegativeSafeInteger(value.projectionRevision) ||
    !isHex(value.digest, 64) ||
    !Array.isArray(value.wakes) ||
    value.wakes.length > CRON_PROJECTION_MAX_WAKES ||
    !isNullablePositiveSafeInteger(value.nextRunAtMs) ||
    !isPositiveSafeInteger(value.acceptedAtMs) ||
    value.acceptedAtMs > MAX_DATE_MS ||
    !isNullablePositiveSafeInteger(value.resetAtMs) ||
    (value.resetAtMs !== null && value.resetAtMs > MAX_DATE_MS) ||
    !isRecord(value.dispatch) ||
    !isRecord(value.migration)
  ) {
    return false;
  }

  if (value.source !== null) {
    if (
      value.gatewayGeneration === null ||
      !isRecord(value.source) ||
      !isHex(value.source.key, 32) ||
      !isPositiveSafeInteger(value.source.epoch) ||
      typeof value.source.leaseToken !== "string" ||
      value.source.leaseToken.length < 16 ||
      value.source.leaseToken.length > 128 ||
      !isPositiveSafeInteger(value.source.startedAtMs) ||
      value.source.startedAtMs > MAX_DATE_MS ||
      !isPositiveSafeInteger(value.source.revision) ||
      !(value.source.reason === "startup" ||
        value.source.reason === "reload" ||
        value.source.reason === "changed") ||
      !isPositiveSafeInteger(value.source.projectedAtMs) ||
      value.source.projectedAtMs > MAX_DATE_MS
    ) {
      return false;
    }
  } else {
    if (value.wakes.length !== 0) return false;
    if (value.resetAtMs === null && value.projectionRevision !== 0) return false;
    if (value.resetAtMs !== null && value.nextRunAtMs !== null) return false;
  }

  const wakeKeys = new Set<string>();
  let previousWake: { jobKey: string; runAtMs: number } | null = null;
  for (const wake of value.wakes) {
    if (
      !isRecord(wake) ||
      !isHex(wake.jobKey, 32) ||
      !isPositiveSafeInteger(wake.runAtMs) ||
      wake.runAtMs > MAX_DATE_MS ||
      wakeKeys.has(wake.jobKey)
    ) {
      return false;
    }
    if (
      previousWake &&
      (wake.runAtMs < previousWake.runAtMs ||
        (wake.runAtMs === previousWake.runAtMs &&
          wake.jobKey.localeCompare(previousWake.jobKey) <= 0))
    ) {
      return false;
    }
    wakeKeys.add(wake.jobKey);
    previousWake = { jobKey: wake.jobKey, runAtMs: wake.runAtMs };
  }
  if (
    value.source !== null &&
    value.nextRunAtMs !== (value.wakes[0]?.runAtMs ?? null)
  ) {
    return false;
  }

  if (
    !isNullablePositiveSafeInteger(value.migration.legacyWakeImportedAtMs) ||
    !isNullablePositiveSafeInteger(value.migration.legacyBootstrapWakeAtMs) ||
    !isNullablePositiveSafeInteger(value.migration.legacyWakeClearedAtMs)
  ) {
    return false;
  }

  const dispatch = value.dispatch;
  if (value.source && digestWakes(value.wakes) !== value.digest) return false;
  if (dispatch.status === "none") return value.nextRunAtMs === null;
  if (
    typeof dispatch.token !== "string" ||
    dispatch.token.length < 8 ||
    dispatch.token.length > 128 ||
    !isPositiveSafeInteger(dispatch.runAtMs) ||
    dispatch.runAtMs > MAX_DATE_MS ||
    dispatch.runAtMs !== value.nextRunAtMs ||
    !isPositiveSafeInteger(dispatch.wakeAtMs) ||
    // Retry repair can wake after the original due slot; both timestamps
    // remain bounded even when wakeAtMs is later than runAtMs.
    dispatch.wakeAtMs > MAX_DATE_MS ||
    !isNonNegativeSafeInteger(dispatch.attempt)
  ) {
    return false;
  }
  switch (dispatch.status) {
    case "pending":
      return true;
    case "starting":
      return (
        isPositiveSafeInteger(dispatch.startLeaseExpiresAtMs) &&
        typeof dispatch.repairWorkflowRunId === "string" &&
        dispatch.repairWorkflowRunId.length > 0 &&
        dispatch.repairWorkflowRunId.length <= 256
      );
    case "scheduled":
      return (
        typeof dispatch.workflowRunId === "string" &&
        dispatch.workflowRunId.length > 0 &&
        dispatch.workflowRunId.length <= 256 &&
        (dispatch.executionWorkflowRunId === null ||
          (typeof dispatch.executionWorkflowRunId === "string" &&
            dispatch.executionWorkflowRunId.length > 0 &&
            dispatch.executionWorkflowRunId.length <= 256)) &&
        (dispatch.legacyWorkflowOwner === undefined ||
          dispatch.legacyWorkflowOwner === true) &&
        isPositiveSafeInteger(dispatch.scheduledAtMs)
      );
    case "running":
      return (
        typeof dispatch.workflowRunId === "string" &&
        dispatch.workflowRunId.length > 0 &&
        dispatch.workflowRunId.length <= 256 &&
        typeof dispatch.executionWorkflowRunId === "string" &&
        dispatch.executionWorkflowRunId.length > 0 &&
        dispatch.executionWorkflowRunId.length <= 256 &&
        (dispatch.legacyWorkflowOwner === undefined ||
          dispatch.legacyWorkflowOwner === true) &&
        isPositiveSafeInteger(dispatch.claimedAtMs)
      );
    case "completed":
      return (
        typeof dispatch.workflowRunId === "string" &&
        dispatch.workflowRunId.length > 0 &&
        dispatch.workflowRunId.length <= 256 &&
        typeof dispatch.executionWorkflowRunId === "string" &&
        dispatch.executionWorkflowRunId.length > 0 &&
        dispatch.executionWorkflowRunId.length <= 256 &&
        (dispatch.legacyWorkflowOwner === undefined ||
          dispatch.legacyWorkflowOwner === true) &&
        isPositiveSafeInteger(dispatch.completedAtMs)
      );
    case "failed":
      return (
        isPositiveSafeInteger(dispatch.failedAtMs) &&
        isPositiveSafeInteger(dispatch.retryAtMs) &&
        dispatch.retryAtMs >= dispatch.failedAtMs &&
        (dispatch.errorCode === "workflow-start-failed" ||
          dispatch.errorCode === "workflow-handoff-failed" ||
          dispatch.errorCode === "sandbox-wake-failed")
      );
    default:
      return false;
  }
}
