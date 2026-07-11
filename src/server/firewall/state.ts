import { createHash, randomUUID } from "node:crypto";

import { ApiError } from "@/shared/http";
import type {
  FirewallEvent,
  FirewallIngestOutcome,
  FirewallReport,
  FirewallState,
  FirewallSyncOutcome,
  LearnedDomain,
  SingleMeta,
} from "@/shared/types";
import {
  computePolicyHash,
  FIREWALL_FAIL_CLOSED_LAST_ERROR,
} from "@/shared/types";
import {
  firewallFailClosedReason,
  type FirewallPolicyRevision,
} from "@/server/firewall/fail-close";
import { getInitializedMeta, getStore, mutateMeta } from "@/server/store/store";
import {
  firewallPolicyApplyLockKey,
  learningLockKey,
} from "@/server/store/keyspace";
import {
  applyFirewallPolicyToSandbox,
  controlPlaneDomains,
} from "@/server/firewall/policy";
import { extractDomainsWithContext, groupByRegistrableDomain, normalizeDomainList } from "@/server/firewall/domains";
import { logDebug, logInfo, logWarn } from "@/server/log";
import { getSandboxController } from "@/server/sandbox/controller";
import { resolveAiGatewayCredentialOptional } from "@/server/env";
import { getPublicOrigin } from "@/server/public-url";
import {
  withSandboxLifecycleMutationLock,
  withSandboxLifecycleRecoveryLock,
} from "@/server/sandbox/lifecycle";
import {
  enqueueHostStopOperation,
  getHostMutationFence,
  markHostSuspensionStopped,
  type HostSuspensionState,
} from "@/server/sandbox/host-suspension";

const EVENT_RETENTION = 1000;
const LEARNED_RETENTION = 500;
const LEARNING_LOG_PATH = "/tmp/shell-commands-for-learning.log";
const LEARNING_INGEST_INTERVAL_MS = 10_000;
// Outlives the bounded Function/SDK request so a lost lifecycle lease cannot
// permit a second, unordered policy write while the first call can still land.
const FIREWALL_POLICY_APPLY_LOCK_TTL_SECONDS = 330;

type FirewallPolicyContext = {
  requestId?: string;
  controlPlaneOrigin?: string;
};

type AssertLifecycleOwnership = () => Promise<void>;

type SandboxGeneration = {
  sandboxId: string;
  lifecycleAttemptId: string | null;
};

type LearningGeneration = SandboxGeneration & {
  learningStartedAt: number | null;
  learningEpochId: string | null;
};

class FirewallPolicySyncError extends Error {
  constructor(
    cause: unknown,
    readonly generation: SandboxGeneration,
    readonly revision: FirewallPolicyRevision,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "FirewallPolicySyncError";
  }
}

async function withFirewallLifecycleMutation<T>(
  action: (
    assertOwned: AssertLifecycleOwnership,
    generation: SandboxGeneration | null,
  ) => Promise<T>,
): Promise<T> {
  return withSandboxLifecycleMutationLock(async (assertOwned) => {
    await assertOwned();
    const fence = await getHostMutationFence();
    if (fence) {
      throw new ApiError(
        503,
        "HOST_INGRESS_FENCED",
        "Sandbox lifecycle suspension is in progress. Retry this request.",
      );
    }
    const meta = await getInitializedMeta();
    await assertOwned();
    const generation = meta.sandboxId
      && (meta.status === "running" || meta.status === "booting")
      ? {
          sandboxId: meta.sandboxId,
          lifecycleAttemptId: meta.lifecycleAttemptId ?? null,
        }
      : null;
    return action(assertOwned, generation);
  });
}

function ownsSandboxGeneration(
  meta: SingleMeta,
  generation: SandboxGeneration,
): boolean {
  return (
    ownsSandboxIdentity(meta, generation) &&
    (meta.status === "running" || meta.status === "booting")
  );
}

function ownsSandboxIdentity(
  meta: SingleMeta,
  generation: SandboxGeneration,
): boolean {
  return meta.sandboxId === generation.sandboxId
    && (meta.lifecycleAttemptId ?? null) === generation.lifecycleAttemptId;
}

function ownsLearningGeneration(
  meta: SingleMeta,
  generation: LearningGeneration,
): boolean {
  return (
    ownsSandboxGeneration(meta, generation) &&
    meta.firewall.mode === "learning" &&
    meta.firewall.learningStartedAt === generation.learningStartedAt
    && (meta.firewall.learningEpochId ?? null) === generation.learningEpochId
  );
}

function learningPendingLogPath(generation: LearningGeneration): string {
  const generationHash = createHash("sha256")
    .update(
      JSON.stringify([
        generation.sandboxId,
        generation.lifecycleAttemptId,
        generation.learningStartedAt,
        generation.learningEpochId,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
  return `${LEARNING_LOG_PATH}.${generationHash}.pending`;
}

async function mutateFirewallSyncForGeneration(
  generation: SandboxGeneration,
  revisionId: string,
  mutator: (meta: SingleMeta) => void,
): Promise<boolean> {
  // The SDK update targets one external process generation. Never let its
  // outcome or credential refresh attest a replacement sandbox.
  let ownsGeneration = false;
  await mutateMeta((meta) => {
    ownsGeneration = ownsSandboxGeneration(meta, generation)
      && meta.firewall.policyRevisionId === revisionId;
    if (!ownsGeneration) return;
    mutator(meta);
  });
  return ownsGeneration;
}

async function recordPolicySdkCompletion(
  generation: SandboxGeneration,
  revision: FirewallPolicyRevision,
  applied: boolean,
): Promise<boolean> {
  let recorded = false;
  await mutateMeta((meta) => {
    if (!ownsSandboxIdentity(meta, generation)) return;
    recorded = true;
    meta.firewall.lastPolicySdkCompletionRevisionId = revision.revisionId;
    meta.firewall.lastPolicySdkCompletionHash = revision.policyHash;
    if (meta.firewall.policyRevisionId !== revision.revisionId) {
      // A later desired revision started while this SDK call was in flight.
      // Fence atomically with completion ordering so process death before the
      // caller's next ownership assertion cannot leave the stale policy live.
      meta.status = "error";
      meta.portUrls = null;
      meta.lastGatewayProbeReady = false;
      meta.lastError = FIREWALL_FAIL_CLOSED_LAST_ERROR;
      meta.firewall.failClosedPolicyRevisionId = revision.revisionId;
      meta.firewall.failClosedPolicyHash = revision.policyHash;
    } else if (
      applied
      && meta.status === "error"
      && meta.lastError === FIREWALL_FAIL_CLOSED_LAST_ERROR
      && meta.firewall.failClosedPolicyRevisionId !== revision.revisionId
    ) {
      // The current desired revision settled after an older stale completion;
      // its policy is authoritative and retires that transient fence.
      meta.status = "running";
      meta.lastError = null;
      meta.lastGatewayProbeReady = false;
      meta.firewall.failClosedPolicyRevisionId = null;
      meta.firewall.failClosedPolicyHash = null;
    }
  });
  return recorded;
}

function requiredControlPlaneDomains(
  mode: FirewallState["mode"],
  origin?: string,
): string[] {
  if (mode !== "enforcing") return [];
  try {
    return controlPlaneDomains(origin ?? getPublicOrigin());
  } catch {
    // Local deployments may intentionally omit a canonical origin. Keep the
    // existing operator policy usable; host-owned egress requires an explicit
    // canonical origin before it can be added safely.
    return [];
  }
}

export async function getFirewallState(): Promise<FirewallState> {
  const firewall = (await getInitializedMeta()).firewall;
  return { ...firewall, wouldBlock: computeWouldBlock(firewall) };
}

/**
 * Compute which learned domains would be blocked if enforcing were enabled.
 * Only meaningful in learning mode — returns [] for disabled/enforcing.
 */
export function computeWouldBlock(firewall: FirewallState): string[] {
  if (firewall.mode !== "learning") {
    return [];
  }
  const allowlist = new Set(firewall.allowlist);
  const seen = new Set<string>();
  return firewall.learned
    .filter((entry) => {
      if (allowlist.has(entry.domain) || seen.has(entry.domain)) return false;
      seen.add(entry.domain);
      return true;
    })
    .map((entry) => entry.domain)
    .sort((a, b) => a.localeCompare(b));
}

export async function setFirewallMode(
  mode: FirewallState["mode"],
  options?: FirewallPolicyContext,
): Promise<FirewallState> {
  return withFirewallLifecycleMutation((assertOwned, generation) =>
    withFirewallPolicyApplyLock(() =>
      setFirewallModeWithinLifecycleLock(
        mode,
        assertOwned,
        generation,
        options,
      )));
}

async function setFirewallModeWithinLifecycleLock(
  mode: FirewallState["mode"],
  assertOwned: AssertLifecycleOwnership,
  generation: SandboxGeneration | null,
  options?: FirewallPolicyContext,
): Promise<FirewallState> {
  const current = (await getInitializedMeta()).firewall.mode;
  if (current === mode) {
    logInfo("firewall.mode_change_noop", { operation: "mode_change", mode, requestId: options?.requestId });
    await syncFirewallPolicyAfterMutation(
      "setFirewallMode",
      assertOwned,
      generation,
      options,
    );
    return (await getInitializedMeta()).firewall;
  }

  logInfo("firewall.mode_change_requested", { operation: "mode_change", from: current, to: mode, requestId: options?.requestId });
  const meta = await mutateMeta((meta) => {
    if (mode === "enforcing" && meta.firewall.allowlist.length === 0) {
      logWarn("firewall.mode_change_failed", {
        operation: "mode_change",
        code: "FIREWALL_ALLOWLIST_EMPTY",
        reason: "Cannot enable enforcing with empty allowlist",
        mode,
        requestId: options?.requestId,
      });
      throw new ApiError(
        409,
        "FIREWALL_ALLOWLIST_EMPTY",
        "Cannot enable enforcing mode with an empty allowlist.",
      );
    }

    const now = Date.now();
    meta.firewall.mode = mode;
    meta.firewall.updatedAt = now;

    if (mode === "learning") {
      meta.firewall.learningStartedAt = now;
      meta.firewall.learningEpochId = randomUUID();
      meta.firewall.commandsObserved = 0;
      logInfo("firewall.mode_change_learning_started", { operation: "mode_change", learningStartedAt: now, requestId: options?.requestId });
    }
  });
  await syncFirewallPolicyAfterMutation(
    "setFirewallMode",
    assertOwned,
    generation,
    options,
  );
  logInfo("firewall.mode_change_applied", {
    operation: "mode_change",
    from: current,
    to: mode,
    requestId: options?.requestId,
  });
  return meta.firewall;
}

export async function approveDomains(
  domains: string[],
  options?: FirewallPolicyContext,
): Promise<FirewallState> {
  return withFirewallLifecycleMutation((assertOwned, generation) =>
    withFirewallPolicyApplyLock(() =>
      approveDomainsWithinLifecycleLock(
        domains,
        assertOwned,
        generation,
        options,
      )));
}

async function approveDomainsWithinLifecycleLock(
  domains: string[],
  assertOwned: AssertLifecycleOwnership,
  generation: SandboxGeneration | null,
  options?: FirewallPolicyContext,
): Promise<FirewallState> {
  logInfo("firewall.domains_approved_requested", { operation: "approve", count: domains.length, requestId: options?.requestId });
  const normalized = normalizeDomainList(domains);
  if (normalized.invalid.length > 0) {
    logWarn("firewall.approve_failed", {
      operation: "approve",
      code: "INVALID_DOMAINS",
      reason: "One or more domains are invalid",
      invalid: normalized.invalid,
      requestId: options?.requestId,
    });
    throw new ApiError(400, "INVALID_DOMAINS", "One or more domains are invalid.");
  }

  const meta = await mutateMeta((meta) => {
    const now = Date.now();
    const allowlist = new Set(meta.firewall.allowlist);
    for (const domain of normalized.valid) {
      allowlist.add(domain);
    }
    meta.firewall.allowlist = [...allowlist].sort((left, right) =>
      left.localeCompare(right),
    );
    meta.firewall.learned = meta.firewall.learned.filter(
      (entry) => !allowlist.has(entry.domain),
    );
    meta.firewall.updatedAt = now;
    prependFirewallEvent(meta.firewall, {
      id: eventId(),
      timestamp: now,
      action: "allowlist_updated",
      decision: "allowed",
      reason: `Approved ${normalized.valid.length} domain(s)`,
      source: "api",
    });
  });
  await syncFirewallPolicyAfterMutation(
    "approveDomains",
    assertOwned,
    generation,
    options,
  );
  logInfo("firewall.domains_approved_applied", {
    operation: "approve",
    count: normalized.valid.length,
    requestId: options?.requestId,
  });
  return meta.firewall;
}

export async function removeDomains(
  domains: string[],
  options?: FirewallPolicyContext,
): Promise<FirewallState> {
  return withFirewallLifecycleMutation((assertOwned, generation) =>
    withFirewallPolicyApplyLock(() =>
      removeDomainsWithinLifecycleLock(
        domains,
        assertOwned,
        generation,
        options,
      )));
}

async function removeDomainsWithinLifecycleLock(
  domains: string[],
  assertOwned: AssertLifecycleOwnership,
  generation: SandboxGeneration | null,
  options?: FirewallPolicyContext,
): Promise<FirewallState> {
  logInfo("firewall.remove_started", { operation: "remove", count: domains.length, requestId: options?.requestId });
  const normalized = normalizeDomainList(domains);
  if (normalized.invalid.length > 0) {
    logWarn("firewall.remove_failed", {
      operation: "remove",
      code: "INVALID_DOMAINS",
      reason: "One or more domains are invalid",
      invalid: normalized.invalid,
      requestId: options?.requestId,
    });
    throw new ApiError(400, "INVALID_DOMAINS", "One or more domains are invalid.");
  }

  const meta = await mutateMeta((meta) => {
    const now = Date.now();
    const removals = new Set(normalized.valid);
    const nextAllowlist = meta.firewall.allowlist.filter(
      (domain) => !removals.has(domain),
    );
    if (meta.firewall.mode === "enforcing" && nextAllowlist.length === 0) {
      logWarn("firewall.remove_failed", {
        operation: "remove",
        code: "FIREWALL_ALLOWLIST_EMPTY",
        reason: "Cannot empty allowlist while enforcing",
        mode: meta.firewall.mode,
        requestId: options?.requestId,
      });
      throw new ApiError(
        409,
        "FIREWALL_ALLOWLIST_EMPTY",
        "Cannot empty the allowlist while enforcing mode is active.",
      );
    }
    meta.firewall.allowlist = nextAllowlist;
    meta.firewall.updatedAt = now;
    prependFirewallEvent(meta.firewall, {
      id: eventId(),
      timestamp: now,
      action: "allowlist_updated",
      decision: "allowed",
      reason: `Removed ${normalized.valid.length} domain(s)`,
      source: "api",
    });
  });
  logInfo("firewall.remove_completed", { operation: "remove", count: normalized.valid.length, requestId: options?.requestId });
  await syncFirewallPolicyAfterMutation(
    "removeDomains",
    assertOwned,
    generation,
    options,
  );
  return meta.firewall;
}

export async function promoteLearnedDomainsToEnforcing(
  options?: FirewallPolicyContext,
): Promise<FirewallState> {
  return withFirewallLifecycleMutation((assertOwned, generation) =>
    withFirewallPolicyApplyLock(() =>
      promoteLearnedDomainsToEnforcingWithinLifecycleLock(
        assertOwned,
        generation,
        options,
      )));
}

async function promoteLearnedDomainsToEnforcingWithinLifecycleLock(
  assertOwned: AssertLifecycleOwnership,
  generation: SandboxGeneration | null,
  options?: FirewallPolicyContext,
): Promise<FirewallState> {
  logInfo("firewall.promote_started", { operation: "promote", requestId: options?.requestId });
  const meta = await mutateMeta((meta) => {
    const learnedNames = meta.firewall.learned.map((entry) => entry.domain);
    const nextAllowlist = new Set([...meta.firewall.allowlist, ...learnedNames]);
    if (nextAllowlist.size === 0) {
      logWarn("firewall.promote_failed", {
        operation: "promote",
        code: "FIREWALL_ALLOWLIST_EMPTY",
        reason: "Cannot promote with empty allowlist",
        requestId: options?.requestId,
      });
      throw new ApiError(
        409,
        "FIREWALL_ALLOWLIST_EMPTY",
        "Cannot enable enforcing mode with an empty allowlist.",
      );
    }

    const now = Date.now();
    meta.firewall.allowlist = [...nextAllowlist].sort((left, right) =>
      left.localeCompare(right),
    );
    meta.firewall.learned = [];
    meta.firewall.mode = "enforcing";
    meta.firewall.updatedAt = now;
    prependFirewallEvent(meta.firewall, {
      id: eventId(),
      timestamp: now,
      action: "mode_updated",
      decision: "allowed",
      reason: `Promoted ${learnedNames.length} learned domain(s) to enforcing`,
      source: "api",
    });
  });
  logInfo("firewall.promote_completed", { operation: "promote", requestId: options?.requestId });
  await syncFirewallPolicyAfterMutation(
    "promoteLearnedDomainsToEnforcing",
    assertOwned,
    generation,
    options,
  );
  return meta.firewall;
}

export async function dismissLearnedDomains(
  domains: string[],
  options?: { requestId?: string },
): Promise<FirewallState> {
  logInfo("firewall.dismiss_started", { operation: "dismiss", count: domains.length, requestId: options?.requestId });
  const normalized = normalizeDomainList(domains);
  if (normalized.invalid.length > 0) {
    logWarn("firewall.dismiss_failed", {
      operation: "dismiss",
      code: "INVALID_DOMAINS",
      reason: "One or more domains are invalid",
      invalid: normalized.invalid,
      requestId: options?.requestId,
    });
    throw new ApiError(400, "INVALID_DOMAINS", "One or more domains are invalid.");
  }

  const meta = await mutateMeta((meta) => {
    const now = Date.now();
    const dismissals = new Set(normalized.valid);
    meta.firewall.learned = meta.firewall.learned.filter(
      (entry) => !dismissals.has(entry.domain),
    );
    meta.firewall.updatedAt = now;
    prependFirewallEvent(meta.firewall, {
      id: eventId(),
      timestamp: now,
      action: "learned_dismissed",
      decision: "allowed",
      reason: `Dismissed ${normalized.valid.length} learned domain(s)`,
      source: "api",
    });
  });
  logInfo("firewall.dismiss_completed", { operation: "dismiss", count: normalized.valid.length, requestId: options?.requestId });
  return meta.firewall;
}

async function syncFirewallPolicyAfterMutation(
  mutation: string,
  assertOwned: AssertLifecycleOwnership,
  _generation: SandboxGeneration | null,
  options?: FirewallPolicyContext,
): Promise<void> {
  try {
    const outcome = await syncFirewallPolicyWithFailCloseWithinLifecycleLock(
      assertOwned,
      options,
    );
    if (outcome.reason === "sandbox-generation-changed") {
      throw new Error("Firewall sync target changed during policy application.");
    }
  } catch (error) {
    if (
      error instanceof ApiError
      && error.code === "FIREWALL_POLICY_APPLY_IN_PROGRESS"
    ) throw error;
    logWarn("firewall.sync_failed_after_mutation", {
      operation: "sync",
      code: "FIREWALL_SYNC_FAILED",
      reason: error instanceof Error ? error.message : String(error),
      mutation,
      requestId: options?.requestId,
    });
    throw new ApiError(
      502,
      "FIREWALL_SYNC_FAILED",
      "Failed to sync firewall policy to the running sandbox.",
    );
  }
}

async function failClosedFirewallGeneration(
  generation: SandboxGeneration,
  revision: FirewallPolicyRevision,
  assertOwned: AssertLifecycleOwnership,
): Promise<void> {
  try {
    await assertOwned();
  } catch {
    await recoverFirewallFailCloseAfterOwnershipLoss(generation, revision);
    return;
  }
  // Publish the durable forced-stop owner first. Its reason is sufficient for
  // the monitor to stop this exact generation even if this worker dies before
  // the diagnostic metadata write below.
  let stopOperation: HostSuspensionState;
  try {
    stopOperation = await enqueueHostStopOperation({
      ...generation,
      reason: firewallFailClosedReason(revision),
      assertOwned,
    });
  } catch {
    await recoverFirewallFailCloseAfterOwnershipLoss(generation, revision);
    return;
  }

  const fenced = await fenceFirewallGenerationMeta(generation, revision);
  if (!fenced) return;

  try {
    await assertOwned();
  } catch {
    // The exact-generation metadata fence and durable stop outbox are the
    // recovery handoff. This stale worker must not issue SDK calls.
    logWarn("firewall.fail_closed_deferred", {
      operation: "sync",
      sandboxId: generation.sandboxId,
      lifecycleAttemptId: generation.lifecycleAttemptId,
      reason: "lifecycle-ownership-lost",
    });
    return;
  }

  const sandbox = await getSandboxController().get({
    sandboxId: generation.sandboxId,
    resume: false,
  });
  await assertOwned();
  let denyAllApplied = false;
  try {
    await sandbox.updateNetworkPolicy("deny-all");
    denyAllApplied = true;
  } catch (error) {
    logWarn("firewall.fail_closed_policy_failed", {
      operation: "sync",
      sandboxId: generation.sandboxId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  await assertOwned();
  let stopConfirmed = false;
  try {
    await sandbox.stop({ blocking: true });
    stopConfirmed = true;
    await markHostSuspensionStopped(stopOperation);
  } catch (error) {
    logWarn("firewall.fail_closed_stop_failed", {
      operation: "sync",
      sandboxId: generation.sandboxId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (!denyAllApplied && !stopConfirmed) {
    throw new Error(
      "Firewall fail-closed policy and confirmed sandbox stop both failed.",
    );
  }
  await assertOwned();
  logWarn("firewall.fail_closed", {
    operation: "sync",
    sandboxId: generation.sandboxId,
    lifecycleAttemptId: generation.lifecycleAttemptId,
    denyAllApplied,
    stopConfirmed,
  });
}

async function recoverFirewallFailCloseAfterOwnershipLoss(
  generation: SandboxGeneration,
  revision: FirewallPolicyRevision,
): Promise<void> {
  // Exact revision CAS prevents a stale worker from fencing a successfully
  // repaired policy on the same sandbox lifecycle generation.
  const fenced = await fenceFirewallGenerationMeta(generation, revision);
  if (fenced) {
    try {
      await withSandboxLifecycleRecoveryLock(async () => {
        const current = await getInitializedMeta();
        if (
          current.status !== "error"
          || current.sandboxId !== generation.sandboxId
          || (current.lifecycleAttemptId ?? null) !== generation.lifecycleAttemptId
          || current.firewall.lastPolicySdkCompletionRevisionId
            !== revision.revisionId
          || current.firewall.lastPolicySdkCompletionHash !== revision.policyHash
          || current.firewall.failClosedPolicyRevisionId !== revision.revisionId
          || current.firewall.failClosedPolicyHash !== revision.policyHash
        ) return;
        await enqueueHostStopOperation({
          ...generation,
          reason: firewallFailClosedReason(revision),
        });
      });
    } catch {
      // The durable metadata marker is repaired by status and watchdog passes.
    }
  }
  logWarn("firewall.fail_closed_deferred", {
    operation: "sync",
    sandboxId: generation.sandboxId,
    lifecycleAttemptId: generation.lifecycleAttemptId,
    reason: "lifecycle-ownership-lost",
  });
}

async function fenceFirewallGenerationMeta(
  generation: SandboxGeneration,
  revision: FirewallPolicyRevision,
): Promise<boolean> {
  let fenced = false;
  await mutateMeta((meta) => {
    if (
      !ownsSandboxIdentity(meta, generation)
      || meta.firewall.lastPolicySdkCompletionRevisionId
        !== revision.revisionId
      || meta.firewall.lastPolicySdkCompletionHash !== revision.policyHash
    ) return;
    // The durable monitor may complete between its outbox write and this
    // diagnostic update. Never regress a confirmed stop back to error.
    if (meta.status === "stopped") return;
    fenced = true;
    meta.status = "error";
    meta.portUrls = null;
    meta.lastGatewayProbeReady = false;
    meta.lastError = FIREWALL_FAIL_CLOSED_LAST_ERROR;
    meta.firewall.failClosedPolicyRevisionId = revision.revisionId;
    meta.firewall.failClosedPolicyHash = revision.policyHash;
  });
  return fenced;
}

export async function syncFirewallPolicyIfRunning(
  options?: FirewallPolicyContext,
): Promise<FirewallSyncOutcome> {
  return withFirewallLifecycleMutation((assertOwned) =>
    withFirewallPolicyApplyLock(() =>
      syncFirewallPolicyWithFailCloseWithinLifecycleLock(
        assertOwned,
        options,
      )));
}

async function withFirewallPolicyApplyLock<T>(
  action: () => Promise<T>,
): Promise<T> {
  const store = getStore();
  const lockKey = firewallPolicyApplyLockKey();
  const lockToken = await store.acquireLock(
    lockKey,
    FIREWALL_POLICY_APPLY_LOCK_TTL_SECONDS,
  );
  if (!lockToken) {
    throw new ApiError(
      503,
      "FIREWALL_POLICY_APPLY_IN_PROGRESS",
      "Another firewall policy application is still in progress. Retry this request.",
    );
  }
  try {
    return await action();
  } finally {
    await store.releaseLock(lockKey, lockToken);
  }
}

async function syncFirewallPolicyWithFailCloseWithinLifecycleLock(
  assertOwned: AssertLifecycleOwnership,
  options?: FirewallPolicyContext,
): Promise<FirewallSyncOutcome> {
  try {
    return await syncFirewallPolicyIfRunningWithinLifecycleLock(
      assertOwned,
      options,
    );
  } catch (error) {
    if (error instanceof FirewallPolicySyncError) {
      try {
        await failClosedFirewallGeneration(
          error.generation,
          error.revision,
          assertOwned,
        );
      } catch (fenceError) {
        logWarn("firewall.fail_closed_incomplete", {
          operation: "sync",
          reason: fenceError instanceof Error
            ? fenceError.message
            : String(fenceError),
          requestId: options?.requestId,
        });
      }
    }
    throw error;
  }
}

async function syncFirewallPolicyIfRunningWithinLifecycleLock(
  assertOwned: AssertLifecycleOwnership,
  options?: FirewallPolicyContext,
): Promise<FirewallSyncOutcome> {
  let meta = await getInitializedMeta();
  const sandboxActive =
    Boolean(meta.sandboxId) &&
    (meta.status === "running" || meta.status === "booting");
  const requiredDomains = sandboxActive
    ? requiredControlPlaneDomains(
        meta.firewall.mode,
        options?.controlPlaneOrigin,
      )
    : [];
  const hash = computePolicyHash(
    meta.firewall.mode,
    meta.firewall.allowlist,
    requiredDomains,
  );

  if (!sandboxActive || !meta.sandboxId) {
    const reason = "sandbox-not-running";
    const outcome: FirewallSyncOutcome = {
      timestamp: Date.now(),
      durationMs: 0,
      allowlistCount: meta.firewall.allowlist.length,
      policyHash: hash,
      applied: false,
      reason,
    };
    logInfo("firewall.sync_skipped", { operation: "sync", reason, policyHash: hash, requestId: options?.requestId });
    await mutateMeta((m) => {
      m.firewall.lastSyncReason = reason;
      m.firewall.lastSyncOutcome = outcome;
    });
    return outcome;
  }

  const syncStart = Date.now();
  const generation: SandboxGeneration = {
    sandboxId: meta.sandboxId,
    lifecycleAttemptId: meta.lifecycleAttemptId ?? null,
  };
  const revision: FirewallPolicyRevision = {
    revisionId: randomUUID(),
    policyHash: hash,
  };
  let revisionOwned = false;
  meta = await mutateMeta((current) => {
    if (!ownsSandboxGeneration(current, generation)) return;
    const currentRequiredDomains = requiredControlPlaneDomains(
      current.firewall.mode,
      options?.controlPlaneOrigin,
    );
    if (
      computePolicyHash(
        current.firewall.mode,
        current.firewall.allowlist,
        currentRequiredDomains,
      ) !== revision.policyHash
    ) return;
    revisionOwned = true;
    current.firewall.policyRevisionId = revision.revisionId;
    current.firewall.failClosedPolicyRevisionId = null;
    current.firewall.failClosedPolicyHash = null;
  });
  if (!revisionOwned) {
    return {
      timestamp: Date.now(),
      durationMs: 0,
      allowlistCount: meta.firewall.allowlist.length,
      policyHash: hash,
      applied: false,
      reason: "sandbox-generation-changed",
    };
  }
  try {
    // Resolve the current AI Gateway credential so the firewall transform rule
    // is refreshed with a fresh OIDC token on every policy sync. Without this,
    // the sandbox retains whatever token was injected at last restore, which
    // typically expires after ~1h and causes AI Gateway 401s with no recovery.
    const credential = await resolveAiGatewayCredentialOptional();
    await assertOwned();
    const beforeApply = await getInitializedMeta();
    const beforeApplyDomains = requiredControlPlaneDomains(
      beforeApply.firewall.mode,
      options?.controlPlaneOrigin,
    );
    if (
      !ownsSandboxGeneration(beforeApply, generation)
      || computePolicyHash(
        beforeApply.firewall.mode,
        beforeApply.firewall.allowlist,
        beforeApplyDomains,
      ) !== hash
    ) {
      return {
        timestamp: Date.now(),
        durationMs: Date.now() - syncStart,
        allowlistCount: meta.firewall.allowlist.length,
        policyHash: hash,
        applied: false,
        reason: "sandbox-generation-changed",
      };
    }
    const sandbox = await getSandboxController().get({
      sandboxId: generation.sandboxId,
      resume: false,
    });
    await assertOwned();
    let applyError: unknown;
    let applyFailed = false;
    try {
      await applyFirewallPolicyToSandbox(
        sandbox,
        meta,
        credential?.token,
        requiredDomains,
      );
    } catch (error) {
      applyFailed = true;
      applyError = error;
    }
    const completionRecorded = await recordPolicySdkCompletion(
      generation,
      revision,
      !applyFailed,
    );
    if (applyFailed) throw applyError;
    if (!completionRecorded) {
      return {
        timestamp: Date.now(),
        durationMs: Date.now() - syncStart,
        allowlistCount: meta.firewall.allowlist.length,
        policyHash: hash,
        applied: false,
        reason: "sandbox-generation-changed",
      };
    }
    await assertOwned();
    const now = Date.now();
    const durationMs = now - syncStart;
    const outcome: FirewallSyncOutcome = {
      timestamp: now,
      durationMs,
      allowlistCount: meta.firewall.allowlist.length,
      policyHash: hash,
      applied: true,
      reason: "policy-applied",
    };
    const persisted = await mutateFirewallSyncForGeneration(
      generation,
      revision.revisionId,
      (m) => {
      m.firewall.lastSyncAppliedAt = now;
      m.firewall.lastSyncReason = "policy-applied";
      m.firewall.lastSyncOutcome = outcome;
      if (credential?.token) {
        m.lastTokenRefreshAt = now;
        m.lastTokenSource = credential.source;
        m.lastTokenExpiresAt = credential.expiresAt ?? null;
      }
      },
    );
    if (!persisted) {
      const staleOutcome: FirewallSyncOutcome = {
        ...outcome,
        applied: false,
        reason: "sandbox-generation-changed",
      };
      logInfo("firewall.sync_discarded", {
        operation: "sync",
        reason: staleOutcome.reason,
        sandboxId: generation.sandboxId,
        lifecycleAttemptId: generation.lifecycleAttemptId,
        policyHash: hash,
        requestId: options?.requestId,
      });
      return staleOutcome;
    }
    logInfo("firewall.sync_completed", {
      operation: "sync",
      durationMs,
      policyHash: hash,
      allowlistCount: meta.firewall.allowlist.length,
      aiGatewayTokenApplied: !!credential?.token,
      aiGatewayTokenSource: credential?.source ?? null,
      requestId: options?.requestId,
    });
    return outcome;
  } catch (error) {
    const now = Date.now();
    const durationMs = now - syncStart;
    const reason = error instanceof Error ? error.message : String(error);
    const outcome: FirewallSyncOutcome = {
      timestamp: now,
      durationMs,
      allowlistCount: meta.firewall.allowlist.length,
      policyHash: hash,
      applied: false,
      reason,
    };
    logWarn("firewall.sync_failed", { operation: "sync", code: "SYNC_APPLY_ERROR", reason, durationMs, policyHash: hash, requestId: options?.requestId });
    try {
      await assertOwned();
      await mutateFirewallSyncForGeneration(
        generation,
        revision.revisionId,
        (m) => {
        m.firewall.lastSyncFailedAt = now;
        m.firewall.lastSyncReason = reason;
        m.firewall.lastSyncOutcome = outcome;
        },
      );
    } catch {
      // A stale worker may report its local failure, but it cannot publish
      // diagnostics into a lifecycle generation it no longer owns.
    }
    throw new FirewallPolicySyncError(error, generation, revision);
  }
}

export async function ingestLearningFromSandbox(
  force = false,
  options?: { requestId?: string },
): Promise<{
  ingested: boolean;
  reason: string;
  domains: string[];
  outcome: FirewallIngestOutcome;
}> {
  return withFirewallLifecycleMutation((assertOwned) =>
    ingestLearningFromSandboxWithinLifecycleLock(force, assertOwned, options));
}

async function ingestLearningFromSandboxWithinLifecycleLock(
  force: boolean,
  assertOwned: AssertLifecycleOwnership,
  options?: { requestId?: string },
): Promise<{
  ingested: boolean;
  reason: string;
  domains: string[];
  outcome: FirewallIngestOutcome;
}> {
  const ingestStart = Date.now();

  const makeSkipOutcome = (skipReason: string): FirewallIngestOutcome => ({
    timestamp: Date.now(),
    durationMs: Date.now() - ingestStart,
    domainsSeenCount: 0,
    newCount: 0,
    updatedCount: 0,
    skipReason,
  });

  const meta = await getInitializedMeta();
  if (meta.firewall.mode !== "learning") {
    logDebug("firewall.ingest_skipped", { operation: "ingest", reason: "mode-not-learning", mode: meta.firewall.mode, requestId: options?.requestId });
    const outcome = makeSkipOutcome("mode-not-learning");
    await persistIngestionSkip("mode-not-learning", outcome);
    return { ingested: false, reason: "mode-not-learning", domains: [], outcome };
  }
  if (!meta.sandboxId || (meta.status !== "running" && meta.status !== "booting")) {
    logDebug("firewall.ingest_skipped", { operation: "ingest", reason: "sandbox-not-running", status: meta.status, requestId: options?.requestId });
    const outcome = makeSkipOutcome("sandbox-not-running");
    await persistIngestionSkip("sandbox-not-running", outcome);
    return { ingested: false, reason: "sandbox-not-running", domains: [], outcome };
  }
  if (
    !force &&
    meta.firewall.lastIngestedAt &&
    Date.now() - meta.firewall.lastIngestedAt < LEARNING_INGEST_INTERVAL_MS
  ) {
    logDebug("firewall.ingest_skipped", { operation: "ingest", reason: "throttled", lastIngestedAt: meta.firewall.lastIngestedAt, requestId: options?.requestId });
    const outcome = makeSkipOutcome("throttled");
    await persistIngestionSkip("throttled", outcome);
    return { ingested: false, reason: "throttled", domains: [], outcome };
  }

  const store = getStore();
  const lockKey = learningLockKey();
  const lockToken = await store.acquireLock(lockKey, 10);
  if (!lockToken) {
    logDebug("firewall.ingest_skipped", { operation: "ingest", reason: "locked", requestId: options?.requestId });
    const outcome = makeSkipOutcome("locked");
    await persistIngestionSkip("locked", outcome);
    return { ingested: false, reason: "locked", domains: [], outcome };
  }

  const generation: LearningGeneration = {
    sandboxId: meta.sandboxId,
    lifecycleAttemptId: meta.lifecycleAttemptId ?? null,
    learningStartedAt: meta.firewall.learningStartedAt,
    learningEpochId: meta.firewall.learningEpochId ?? null,
  };
  const pendingLogPath = learningPendingLogPath(generation);
  const pendingIdPath = `${pendingLogPath}.id`;
  const proposedBatchId = randomUUID();

  try {
    await assertOwned();
    const sandbox = await getSandboxController().get({
      sandboxId: generation.sandboxId,
      resume: false,
    });
    await assertOwned();
    const result = await sandbox.runCommand("bash", [
      "-lc",
      'log=$1; pending=$2; idfile=$3; proposed=$4; known=$5; write_id() { tmp="${idfile}.$$"; printf "%s" "$1" > "$tmp" || exit 1; mv -- "$tmp" "$idfile" || exit 1; }; if [ ! -e "$pending" ] && [ -f "$log" ]; then write_id "$proposed"; mv -- "$log" "$pending" || exit 1; set -C; : > "$log" 2>/dev/null || true; set +C; fi; if [ -f "$pending" ]; then if [ ! -s "$idfile" ]; then write_id "${known:-$proposed}"; fi; printf "OPENCLAW_BATCH_ID=%s\\n" "$(cat -- "$idfile")"; cat -- "$pending"; fi',
      "bash",
      LEARNING_LOG_PATH,
      pendingLogPath,
      pendingIdPath,
      proposedBatchId,
      meta.firewall.lastCommittedLearningBatchId ?? "",
    ]);
    const batchOutput = await result.output("both");
    if (result.exitCode !== 0) {
      throw new Error(`Learning log read failed with exit code ${result.exitCode}.`);
    }
    await assertOwned();
    const markerEnd = batchOutput.indexOf("\n");
    const marker = markerEnd >= 0 ? batchOutput.slice(0, markerEnd) : "";
    const batchId = marker.startsWith("OPENCLAW_BATCH_ID=")
      ? marker.slice("OPENCLAW_BATCH_ID=".length)
      : proposedBatchId;
    const output = marker.startsWith("OPENCLAW_BATCH_ID=")
      ? batchOutput.slice(markerEnd + 1)
      : batchOutput;
    const logLineCount = output.split("\n").filter((line) => line.trim().length > 0).length;
    const enriched = extractDomainsWithContext(output);
    const domains = enriched.map((entry) => entry.domain);
    if (domains.length > 0) {
      logDebug("firewall.ingest_domains_learned", {
        operation: "ingest",
        count: domains.length,
        domains: enriched.map((e) => ({
          domain: e.domain,
          category: e.category,
          sourceCommand: e.sourceCommand,
        })),
        requestId: options?.requestId,
      });
    }

    const contextMap = new Map(enriched.map((e) => [e.domain, e]));
    let newCount = 0;
    let updatedCount = 0;
    let alreadyCommitted = false;

    let committedOutcome: FirewallIngestOutcome | undefined;
    await mutateMeta((next) => {
      // mutateMeta may replay this callback after a CAS conflict. Never carry
      // acceptance or counters from a draft that was not persisted.
      committedOutcome = undefined;
      newCount = 0;
      updatedCount = 0;
      alreadyCommitted = false;
      if (!ownsLearningGeneration(next, generation)) return;
      if (next.firewall.lastCommittedLearningBatchId === batchId) {
        alreadyCommitted = true;
        committedOutcome = next.firewall.lastIngestOutcome ?? {
          timestamp: Date.now(),
          durationMs: Date.now() - ingestStart,
          domainsSeenCount: 0,
          newCount: 0,
          updatedCount: 0,
          skipReason: null,
        };
        return;
      }

      next.firewall.lastIngestedAt = Date.now();
      next.firewall.commandsObserved += logLineCount;
      next.firewall.lastIngestionSkipReason = null;
      next.firewall.ingestionSkipCount = 0;
      if (domains.length === 0) {
        committedOutcome = {
          timestamp: Date.now(),
          durationMs: Date.now() - ingestStart,
          domainsSeenCount: 0,
          newCount: 0,
          updatedCount: 0,
          skipReason: null,
        };
        next.firewall.lastIngestOutcome = committedOutcome;
        next.firewall.lastCommittedLearningBatchId = batchId;
        return;
      }

      const allowlist = new Set(next.firewall.allowlist);
      const learnedMap = new Map(
        next.firewall.learned.map((entry) => [entry.domain, { ...entry }]),
      );
      const now = Date.now();

      for (const domain of domains) {
        if (allowlist.has(domain)) {
          continue;
        }

        const ctx = contextMap.get(domain);
        const existing = learnedMap.get(domain);
        const current =
          existing ??
          ({
            domain,
            firstSeenAt: now,
            lastSeenAt: now,
            hitCount: 0,
          } satisfies LearnedDomain);

        if (existing) {
          updatedCount += 1;
        } else {
          newCount += 1;
        }

        current.lastSeenAt = now;
        current.hitCount += 1;

        if (ctx) {
          const existingCategories = new Set(current.categories ?? []);
          existingCategories.add(ctx.category);
          current.categories = [...existingCategories];
        }

        learnedMap.set(domain, current);

        prependFirewallEvent(next.firewall, {
          id: eventId(),
          timestamp: now,
          action: "domain_observed",
          decision: "learned",
          domain,
          reason: "Observed in shell command log while learning",
          source: "learning-log",
          sourceCommand: ctx?.sourceCommand,
          category: ctx?.category,
        });
      }

      next.firewall.learned = [...learnedMap.values()]
        .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
        .slice(0, LEARNED_RETENTION);
      next.firewall.updatedAt = now;

      committedOutcome = {
        timestamp: Date.now(),
        durationMs: Date.now() - ingestStart,
        domainsSeenCount: domains.length,
        newCount,
        updatedCount,
        skipReason: null,
      };
      next.firewall.lastIngestOutcome = committedOutcome;
      next.firewall.lastCommittedLearningBatchId = batchId;
    });

    if (!committedOutcome) {
      const outcome = makeSkipOutcome("sandbox-generation-changed");
      logDebug("firewall.ingest_skipped", {
        operation: "ingest",
        reason: "sandbox-generation-changed",
        sandboxId: generation.sandboxId,
        lifecycleAttemptId: generation.lifecycleAttemptId,
        requestId: options?.requestId,
      });
      return {
        ingested: false,
        reason: "sandbox-generation-changed",
        domains: [],
        outcome,
      };
    }

    const outcome = committedOutcome as FirewallIngestOutcome;

    // The generation-specific batch remains recoverable until its metadata
    // commit is durable. Cleanup failure is safe: a retry may duplicate counts,
    // but cannot lose observations or consume a successor's batch.
    try {
      await assertOwned();
      const cleanupMeta = await getInitializedMeta();
      await assertOwned();
      if (!ownsLearningGeneration(cleanupMeta, generation)) {
        logDebug("firewall.ingest_cleanup_skipped", {
          operation: "ingest",
          reason: "sandbox-generation-changed",
          sandboxId: generation.sandboxId,
          lifecycleAttemptId: generation.lifecycleAttemptId,
          requestId: options?.requestId,
        });
        return {
          ingested: !alreadyCommitted && domains.length > 0,
          reason: alreadyCommitted
            ? "already-committed"
            : domains.length > 0
              ? "updated"
              : "no-domains",
          domains: alreadyCommitted ? [] : domains,
          outcome,
        };
      }
      const cleanup = await sandbox.runCommand("bash", [
        "-lc",
        'rm -f -- "$2" "$1"',
        "bash",
        pendingLogPath,
        pendingIdPath,
      ]);
      await cleanup.output("both");
      if (cleanup.exitCode !== 0) {
        throw new Error(
          `Learning log cleanup failed with exit code ${cleanup.exitCode}.`,
        );
      }
      await assertOwned();
      await mutateMeta((meta) => {
        if (
          ownsLearningGeneration(meta, generation)
          && meta.firewall.lastCommittedLearningBatchId === batchId
        ) {
          meta.firewall.lastCommittedLearningBatchId = null;
        }
      });
    } catch (error) {
      // Ownership loss must abort. Other cleanup failures leave the pending
      // batch intact so the same generation can ingest it again.
      await assertOwned();
      logWarn("firewall.ingest_cleanup_failed", {
        operation: "ingest",
        reason: error instanceof Error ? error.message : String(error),
        sandboxId: generation.sandboxId,
        lifecycleAttemptId: generation.lifecycleAttemptId,
        requestId: options?.requestId,
      });
    }

    logDebug("firewall.ingest_completed", {
      operation: "ingest",
      durationMs: outcome.durationMs,
      domainsSeenCount: outcome.domainsSeenCount,
      newCount: outcome.newCount,
      updatedCount: outcome.updatedCount,
      requestId: options?.requestId,
    });

    return {
      ingested: !alreadyCommitted && domains.length > 0,
      reason: alreadyCommitted
        ? "already-committed"
        : domains.length > 0
          ? "updated"
          : "no-domains",
      domains: alreadyCommitted ? [] : domains,
      outcome,
    };
  } catch (error) {
    // Do not turn lifecycle ownership loss into an ordinary read failure.
    await assertOwned();
    logWarn("firewall.ingest_failed", {
      operation: "ingest",
      code: "SANDBOX_READ_FAILED",
      reason: error instanceof Error ? error.message : String(error),
      requestId: options?.requestId,
    });
    const outcome: FirewallIngestOutcome = {
      timestamp: Date.now(),
      durationMs: Date.now() - ingestStart,
      domainsSeenCount: 0,
      newCount: 0,
      updatedCount: 0,
      skipReason: "sandbox-read-failed",
    };
    await persistIngestionSkipForLearningGeneration(
      "sandbox-read-failed",
      outcome,
      generation,
    );
    return { ingested: false, reason: "sandbox-read-failed", domains: [], outcome };
  } finally {
    await store.releaseLock(lockKey, lockToken);
  }
}

const BENIGN_SKIP_REASONS = new Set(["throttled", "locked"]);

async function persistIngestionSkip(reason: string, outcome: FirewallIngestOutcome): Promise<void> {
  await mutateMeta((m) => {
    m.firewall.lastIngestOutcome = outcome;
    if (!BENIGN_SKIP_REASONS.has(reason)) {
      m.firewall.lastIngestionSkipReason = reason;
      m.firewall.ingestionSkipCount += 1;
    }
  });
}

async function persistIngestionSkipForLearningGeneration(
  reason: string,
  outcome: FirewallIngestOutcome,
  generation: LearningGeneration,
): Promise<void> {
  await mutateMeta((meta) => {
    if (!ownsLearningGeneration(meta, generation)) return;
    meta.firewall.lastIngestOutcome = outcome;
    if (!BENIGN_SKIP_REASONS.has(reason)) {
      meta.firewall.lastIngestionSkipReason = reason;
      meta.firewall.ingestionSkipCount += 1;
    }
  });
}

export type FirewallDiagnostics = {
  mode: FirewallState["mode"];
  learningHealth: {
    durationMs: number | null;
    commandsObserved: number;
    uniqueDomains: number;
    lastIngestedAt: number | null;
    stalenessMs: number | null;
  };
  syncStatus: {
    lastAppliedAt: number | null;
    lastFailedAt: number | null;
    lastReason: string | null;
  };
  ingestionStatus: {
    lastSkipReason: string | null;
    consecutiveSkips: number;
  };
  wouldBlockCount: number;
};

export async function getFirewallDiagnostics(): Promise<FirewallDiagnostics> {
  const fw = await getFirewallState();
  const now = Date.now();

  const isLearning = fw.mode === "learning";

  return {
    mode: fw.mode,
    learningHealth: {
      durationMs:
        isLearning && fw.learningStartedAt !== null
          ? now - fw.learningStartedAt
          : null,
      commandsObserved: fw.commandsObserved,
      uniqueDomains: fw.learned.length,
      lastIngestedAt: fw.lastIngestedAt,
      stalenessMs:
        isLearning && fw.lastIngestedAt !== null
          ? now - fw.lastIngestedAt
          : null,
    },
    syncStatus: {
      lastAppliedAt: fw.lastSyncAppliedAt,
      lastFailedAt: fw.lastSyncFailedAt,
      lastReason: fw.lastSyncReason,
    },
    ingestionStatus: {
      lastSkipReason: fw.lastIngestionSkipReason,
      consecutiveSkips: fw.ingestionSkipCount,
    },
    wouldBlockCount: fw.wouldBlock.length,
  };
}

const FIREWALL_LIMITATIONS: string[] = [
  "Learning is based on shell command text observation, not actual network traffic inspection.",
  "Domains accessed by background processes or daemons may not be captured.",
  "IP-only connections bypass domain-based firewall rules.",
  "DNS-over-HTTPS traffic is not observable through shell log inspection.",
  "Learning log is truncated on each read — domains only appear once per ingest cycle.",
];

export async function getFirewallReport(
  options?: Pick<FirewallPolicyContext, "controlPlaneOrigin">,
): Promise<FirewallReport> {
  const fw = await getFirewallState();
  const diagnostics = await getFirewallDiagnostics();
  const requiredDomains = requiredControlPlaneDomains(
    fw.mode,
    options?.controlPlaneOrigin,
  );
  const hash = computePolicyHash(fw.mode, fw.allowlist, requiredDomains);

  return {
    schemaVersion: 1,
    generatedAt: Date.now(),
    state: fw,
    diagnostics,
    groupedLearned: groupByRegistrableDomain(fw.learned),
    wouldBlock: fw.wouldBlock,
    lastIngest: fw.lastIngestOutcome,
    lastSync: fw.lastSyncOutcome,
    limitations: FIREWALL_LIMITATIONS,
    policyHash: hash,
  };
}

function prependFirewallEvent(state: FirewallState, event: FirewallEvent): void {
  state.events = [event, ...state.events].slice(0, EVENT_RETENTION);
}

function eventId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
