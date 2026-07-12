import {
  buildDeploymentContract,
  type DeploymentContract,
} from "@/server/deployment-contract";
import { getCurrentDeploymentId } from "@/server/launch-verify/state";
import { logError, logInfo } from "@/server/log";
import {
  createOperationContext,
} from "@/server/observability/operation-context";
import { getPublicOrigin } from "@/server/public-url";
import { matchesConfiguredBundleIdentity } from "@/server/openclaw/bundle-identity";
import { supportsCronProjectionBundleIdentity } from "@/server/cron/compatibility";
import {
  ensureUsableAiGatewayCredential,
  isBusyStatus,
  prepareHotSpareFromPreparedRestore,
  prepareRestoreTarget,
  probeGatewayReady,
  reconcileSandboxHealth,
  reconcileSnapshottingStatus,
  reconcileStaleRunningStatus,
  type PrepareHotSpareResult,
  type ProbeResult,
  type SandboxHealthResult,
  type TokenRefreshResult,
} from "@/server/sandbox/lifecycle";
import {
  reconcileCronProjection,
  type CronProjectionReconcileResult,
  type CronWorkflowRunStatus,
} from "@/server/cron/dispatch";
import type { CronWakeWorkflowEnvelopeV1 } from "@/server/cron/workflow-contract";
import {
  getCronProjectionDiagnostics,
  type CronProjectionDiagnostics,
} from "@/server/cron/projection";
import {
  cronDispatchRepairWorkflow,
  cronWakeWorkflow,
} from "@/server/workflows/cron/cron-wake-workflow";
import {
  runRestoreOracleCycle,
  type RestoreOracleCycleResult,
} from "@/server/sandbox/restore-oracle";
import { getInitializedMeta, mutateMeta } from "@/server/store/store";
import {
  type OperationContext,
  type SingleMeta,
} from "@/shared/types";
import {
  armSandboxDeadline,
  type SandboxDeadlineState,
} from "@/server/sandbox/deadline-coordinator";
import { getSandboxController } from "@/server/sandbox/controller";
import type { WatchdogCheck, WatchdogReport } from "@/shared/watchdog";
import {
  readWatchdogReport,
  writeWatchdogReport,
} from "@/server/watchdog/state";
import {
  reconcileTelegramWebhookCleanups,
  type TelegramWebhookCleanupResult,
} from "@/server/channels/telegram/webhook-cleanup";
import { reconcileFirewallPolicyIfNeeded } from "@/server/firewall/state";
import type { FirewallSyncOutcome } from "@/shared/types";

export type RunSandboxWatchdogOptions = {
  request: Request;
  repair?: boolean;
  schedule?: (callback: () => Promise<void> | void) => void;
};

export type WatchdogDeps = {
  buildContract: (options: { request?: Request }) => Promise<DeploymentContract>;
  getMeta: () => Promise<SingleMeta>;
  reconcileLifecycleState?: () => Promise<SingleMeta>;
  probe: () => Promise<ProbeResult>;
  reconcileStale: () => Promise<SingleMeta>;
  reconcile: (options: {
    origin: string;
    reason: string;
    schedule?: (callback: () => Promise<void> | void) => void;
    op?: OperationContext;
  }) => Promise<SandboxHealthResult>;
  readPrevious: () => Promise<WatchdogReport>;
  writeReport: (report: WatchdogReport) => Promise<WatchdogReport>;
  reconcileCronProjection: (options: {
    origin: string;
    enabled: boolean;
    bootstrapFromLegacyJobs?: boolean;
  }) => Promise<CronProjectionReconcileResult>;
  getCronProjectionDiagnostics: () => Promise<CronProjectionDiagnostics | null>;
  refreshGatewayToken: (input: {
    force?: boolean;
    reason: string;
    controlPlaneOrigin?: string;
  }) => Promise<TokenRefreshResult>;
  reconcileFirewallPolicy: (input: {
    controlPlaneOrigin: string;
  }) => Promise<FirewallSyncOutcome | null>;
  runRestoreOracle: (input: {
    origin: string;
    reason: string;
    force?: boolean;
    minIdleMs?: number;
    op?: OperationContext;
  }) => Promise<RestoreOracleCycleResult>;
  prepareHotSpare: (options?: {
    op?: OperationContext;
  }) => Promise<PrepareHotSpareResult>;
  armDeadline: (meta: SingleMeta) => Promise<SandboxDeadlineState | null>;
  reconcileChannelCleanups: () => Promise<TelegramWebhookCleanupResult>;
  now: () => number;
};

const WATCHDOG_CRON_WAKE_CHECK_ID = "cron.wake" as const;

const USABLE_TOKEN_REFRESH_REASONS = new Set([
  "refreshed",
  "meta-ttl-sufficient",
  "meta-ttl-sufficient-after-lock",
  "refreshed-by-another-request",
  "api-key-no-refresh-needed",
]);

async function startCronWakeWorkflow(
  envelope: CronWakeWorkflowEnvelopeV1,
): Promise<{ runId: string }> {
  const { start } = await import("workflow/api");
  const run = await start(cronWakeWorkflow, [envelope], {
    deploymentId: "latest",
  });
  return { runId: run.runId };
}

async function startCronDispatchRepairWorkflow(
  envelope: CronWakeWorkflowEnvelopeV1,
  repairAtMs: number,
): Promise<{ runId: string }> {
  const { start } = await import("workflow/api");
  const run = await start(
    cronDispatchRepairWorkflow,
    [envelope, repairAtMs],
    { deploymentId: "latest" },
  );
  return { runId: run.runId };
}

async function getCronWakeWorkflowStatus(
  runId: string,
): Promise<CronWorkflowRunStatus> {
  const { getRun } = await import("workflow/api");
  const run = getRun(runId);
  if (!(await run.exists)) return "missing";
  return run.status;
}

const defaultDeps: WatchdogDeps = {
  buildContract: buildDeploymentContract,
  getMeta: getInitializedMeta,
  reconcileLifecycleState: reconcileSnapshottingStatus,
  probe: () => probeGatewayReady({ resume: false, thaw: false }),
  reconcileStale: reconcileStaleRunningStatus,
  reconcile: reconcileSandboxHealth,
  readPrevious: readWatchdogReport,
  writeReport: writeWatchdogReport,
  reconcileCronProjection: (options) =>
    reconcileCronProjection({
      ...options,
      startWorkflow: startCronWakeWorkflow,
      startRepairWorkflow: startCronDispatchRepairWorkflow,
      getWorkflowRunStatus: getCronWakeWorkflowStatus,
    }),
  getCronProjectionDiagnostics,
  refreshGatewayToken: (input) =>
    ensureUsableAiGatewayCredential({
      force: input.force,
      reason: input.reason,
      controlPlaneOrigin: input.controlPlaneOrigin,
    }),
  reconcileFirewallPolicy: (input) =>
    reconcileFirewallPolicyIfNeeded({
      controlPlaneOrigin: input.controlPlaneOrigin,
    }),
  runRestoreOracle: (input) =>
    runRestoreOracleCycle(input, {
      getMeta: getInitializedMeta,
      mutate: mutateMeta,
      probe: probeGatewayReady,
      prepare: prepareRestoreTarget,
      now: () => Date.now(),
    }),
  prepareHotSpare: prepareHotSpareFromPreparedRestore,
  armDeadline: async (meta) => {
    if (!meta.sandboxId) return null;
    const sandbox = await getSandboxController().get({
      sandboxId: meta.sandboxId,
      resume: false,
    });
    return armSandboxDeadline(meta, undefined, {
      refreshDeadline: false,
      forceWorkflowStart: true,
      activityAtMs: meta.lastAccessedAt ?? meta.updatedAt,
      nativeTimeoutRemainingMs: sandbox.timeoutRemaining,
    });
  },
  reconcileChannelCleanups: reconcileTelegramWebhookCleanups,
  now: () => Date.now(),
};

export async function runSandboxWatchdog(
  options: RunSandboxWatchdogOptions,
  deps: WatchdogDeps = defaultDeps,
): Promise<WatchdogReport> {
  const startedAt = deps.now();
  const deploymentId = getCurrentDeploymentId();
  const checks: WatchdogCheck[] = [];

  const addCheck = (
    id: WatchdogCheck["id"],
    status: WatchdogCheck["status"],
    stepStartedAt: number,
    message: string,
    data?: Record<string, unknown>,
  ): void => {
    const check: WatchdogCheck = {
      id,
      status,
      durationMs: Math.max(0, deps.now() - stepStartedAt),
      message,
    };
    if (data) check.data = data;
    checks.push(check);
  };

  const refreshGatewayTokenForWatchdog = async (input: {
    force?: boolean;
    reason: string;
    message: string;
  }): Promise<TokenRefreshResult> => {
    const refreshStartedAt = deps.now();
    const expectedSandboxId = meta.sandboxId;
    const expectedLifecycleAttemptId = meta.lifecycleAttemptId ?? null;
    const result = await deps.refreshGatewayToken({
      force: input.force,
      reason: input.reason,
      controlPlaneOrigin: getPublicOrigin(options.request),
    });
    const postRefreshMeta = await deps.getMeta();
    const generationChanged =
      postRefreshMeta.status !== "running"
      || postRefreshMeta.sandboxId !== expectedSandboxId
      || (postRefreshMeta.lifecycleAttemptId ?? null)
        !== expectedLifecycleAttemptId;
    meta = postRefreshMeta;
    const failed = !USABLE_TOKEN_REFRESH_REASONS.has(result.reason)
      || generationChanged;
    const failureReason = generationChanged
      ? "sandbox generation changed or was fail-closed during token refresh"
      : result.reason;
    addCheck(
      "token.refresh",
      failed ? "fail" : "pass",
      refreshStartedAt,
      failed ? `AI Gateway token refresh failed: ${failureReason}` : input.message,
      {
        refreshed: result.refreshed,
        reason: result.reason,
        force: input.force === true,
        retryAfterMs: result.retryAfterMs,
        source: result.credential?.source ?? null,
        expiresAt: result.credential?.expiresAt ?? null,
        postRefreshSandboxStatus: postRefreshMeta.status,
      },
    );
    if (failed) {
      tokenRefreshFailed = true;
      lastError = `AI Gateway token refresh failed: ${failureReason}`;
      status = "failed";
    }
    if (generationChanged) throw new Error(lastError ?? failureReason);
    return result;
  };

  let previous: WatchdogReport = {
    deploymentId,
    ranAt: null,
    status: "idle",
    sandboxStatus: "uninitialized",
    triggeredRepair: false,
    consecutiveFailures: 0,
    lastError: null,
    checks: [],
  };
  let meta: SingleMeta = { status: "uninitialized" } as SingleMeta;
  let status: WatchdogReport["status"] = "idle";
  let triggeredRepair = false;
  let lastError: string | null = null;
  let tokenRefreshFailed = false;
  let deadlineOwnerFailed = false;
  let cronProjectionEnabled = false;

  const runChannelCleanupAntiEntropy = async (): Promise<void> => {
    const cleanupStartedAt = deps.now();
    try {
      const cleanup = await deps.reconcileChannelCleanups();
      const repaired = cleanup.cleaned > 0;
      triggeredRepair ||= repaired;
      if (cleanup.remaining > 0) {
        lastError = `Telegram webhook cleanup remains pending for ${cleanup.remaining} token(s).`;
        status = "failed";
        addCheck(
          "channel.cleanup",
          "fail",
          cleanupStartedAt,
          lastError,
          { ...cleanup },
        );
        return;
      }
      if (repaired && status !== "failed") status = "repairing";
      addCheck(
        "channel.cleanup",
        cleanup.attempted > 0 ? "pass" : "skip",
        cleanupStartedAt,
        cleanup.attempted > 0
          ? "Telegram webhook cleanup obligations reconciled."
          : "No pending channel cleanup obligations.",
        { ...cleanup },
      );
    } catch (error) {
      lastError = `Channel cleanup reconciliation failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      status = "failed";
      addCheck("channel.cleanup", "fail", cleanupStartedAt, lastError);
    }
  };

  const runCronAntiEntropy = async (): Promise<void> => {
    // Independent repair lane: unrelated contract, sandbox, deadline, or
    // restore failures must not suppress cron ownership reconciliation.
    const cronCheckStartedAt = deps.now();
    try {
      const cron = await deps.reconcileCronProjection({
        origin: getPublicOrigin(options.request),
        enabled: cronProjectionEnabled,
        bootstrapFromLegacyJobs:
          (meta.status === "stopped" || meta.status === "error") &&
          Boolean(meta.sandboxId || meta.snapshotId),
      });
      const diagnostics = await deps.getCronProjectionDiagnostics();
      if (
        cron.status === "failed" ||
        cron.status === "starting" ||
        cron.status === "settlement-blocked"
      ) {
        lastError = cron.status === "starting"
          ? "Cron projection workflow start lease has not settled."
          : cron.status === "settlement-blocked"
            ? "Cron settlement recovery budget is exhausted; waiting for a new authoritative projection."
            : "Cron projection workflow could not be started.";
        addCheck(
          WATCHDOG_CRON_WAKE_CHECK_ID,
          "fail",
          cronCheckStartedAt,
          lastError,
          diagnostics ?? undefined,
        );
        status = "failed";
        return;
      }
      const repaired = cron.status === "started" && cron.repaired;
      triggeredRepair ||= repaired;
      if (repaired && status !== "failed") status = "repairing";
      addCheck(
        WATCHDOG_CRON_WAKE_CHECK_ID,
        cron.status === "unsupported" ||
          cron.status === "empty" ||
          cron.status === "idle"
          ? "skip"
          : "pass",
        cronCheckStartedAt,
        cron.status === "unsupported"
          ? "Cron projection is disabled because the active bundle capability is not verified."
          : cron.status === "empty"
          ? "No cron projection baseline is available."
          : cron.status === "idle"
            ? "Cron projection has no pending wake."
            : cron.status === "started"
              ? "Cron projection Workflow started."
              : "Cron projection Workflow is scheduled.",
        diagnostics ?? undefined,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      lastError = `Cron projection reconciliation failed: ${errMsg}`;
      addCheck(WATCHDOG_CRON_WAKE_CHECK_ID, "fail", cronCheckStartedAt, lastError);
      status = "failed";
    }
  };

  try {
    previous = await deps.readPrevious();
    meta = await deps.getMeta();
    if (deps.reconcileLifecycleState) {
      meta = await deps.reconcileLifecycleState();
    }
    const bundleIdentity = matchesConfiguredBundleIdentity(meta.bundleIdentity)
      ? meta.bundleIdentity
      : null;
    cronProjectionEnabled = supportsCronProjectionBundleIdentity(bundleIdentity);

    // Check deployment contract
    const contractStartedAt = deps.now();
    const contract = await deps.buildContract({ request: options.request });
    const failingRequirementIds = contract.requirements
      .filter((requirement) => requirement.status === "fail")
      .map((requirement) => requirement.id);

    if (failingRequirementIds.length > 0) {
      lastError = `Deployment contract failing: ${failingRequirementIds.join(", ")}`;
      addCheck("contract", "fail", contractStartedAt, lastError);
    } else {
      addCheck(
        "contract",
        "pass",
        contractStartedAt,
        `Deployment contract passed with ${contract.requirements.length} evaluated requirements.`,
      );
    }

    // Detect stuck busy states: restoring/creating with no sandboxId for >90s.
    if (isBusyStatus(meta.status) && !meta.sandboxId) {
      const ageMs = deps.now() - meta.updatedAt;
      const threshold = 90_000;

      if (ageMs > threshold) {
        const stuckMsg = `Sandbox stuck in ${meta.status} for ${Math.round(ageMs / 1000)}s with no sandboxId.`;
        addCheck("probe", "fail", deps.now(), stuckMsg);
        lastError = stuckMsg;

        if (options.repair !== false) {
          const repairStartedAt = deps.now();
          try {
            const watchdogOp = createOperationContext({
              trigger: "watchdog",
              reason: "watchdog:stuck_busy",
            });
            const result = await deps.reconcile({
              origin: getPublicOrigin(options.request),
              reason: "watchdog:stuck_busy",
              schedule: options.schedule,
              op: watchdogOp,
            });
            triggeredRepair = true;
            addCheck("reconcile", "pass", repairStartedAt,
              `Stuck ${meta.status} recovery triggered (result: ${result.status}).`);
            status = "repairing";
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            addCheck("reconcile", "fail", repairStartedAt, `Stuck recovery failed: ${errMsg}`);
            status = "failed";
          }
        } else {
          addCheck("reconcile", "skip", deps.now(), "Repair disabled for this run.");
          status = "failed";
        }
      } else {
        addCheck("probe", "skip", deps.now(),
          `Sandbox status is ${meta.status} (age ${Math.round(ageMs / 1000)}s, threshold ${Math.round(threshold / 1000)}s); waiting for operation.`);
        addCheck("reconcile", "skip", deps.now(), "Operation still within threshold.");
        status = failingRequirementIds.length > 0 ? "failed" : "idle";
      }
    } else if (meta.status !== "running" || !meta.sandboxId) {
      addCheck(
        "probe",
        "skip",
        deps.now(),
        `Sandbox status is ${meta.status}; watchdog does not wake idle sandboxes.`,
      );
      addCheck(
        "reconcile",
        "skip",
        deps.now(),
        "No repair needed because metadata does not claim the sandbox is running.",
      );
      status = failingRequirementIds.length > 0 ? "failed" : "idle";
    } else {
      // Before probing the gateway, check whether the sandbox is actually
      // still running via the SDK.  When the platform auto-sleeps a sandbox
      // after its timeout, metadata still says "running" — probing and then
      // repairing would needlessly restore it.
      const staleCheckStart = deps.now();
      const reconciledMeta = await deps.reconcileStale();
      if (reconciledMeta.status !== "running") {
        addCheck("probe", "skip", staleCheckStart,
          `SDK reports sandbox is ${reconciledMeta.status}; metadata reconciled from stale running state.`);
        addCheck("reconcile", "skip", deps.now(),
          "No repair needed — sandbox naturally slept after timeout.");
        meta = reconciledMeta;
        status = failingRequirementIds.length > 0 ? "failed" : "idle";
      } else {
        const deadlineStartedAt = deps.now();
        try {
          const deadline = await deps.armDeadline(reconciledMeta);
          const workflowAttached = deadline?.workflowRunId !== null
            && deadline?.workflowRunId !== undefined;
          addCheck(
            "sandbox.deadline",
            workflowAttached ? "pass" : "fail",
            deadlineStartedAt,
            workflowAttached
              ? "Sandbox deadline Workflow is attached."
              : "Sandbox deadline Workflow attachment has not settled.",
            deadline
              ? {
                  generationId: deadline.generationId,
                  workflowAttached,
                  deadlineAtMs: deadline.deadlineAtMs,
                }
              : undefined,
          );
          if (!workflowAttached) {
            deadlineOwnerFailed = true;
            lastError = "Sandbox deadline Workflow attachment has not settled.";
          }
        } catch (deadlineError) {
          const message = deadlineError instanceof Error
            ? deadlineError.message
            : String(deadlineError);
          addCheck("sandbox.deadline", "fail", deadlineStartedAt, message);
          throw deadlineError;
        }

        const probeStartedAt = deps.now();
        const probe = await deps.probe();

      if (probe.ready) {
        addCheck("probe", "pass", probeStartedAt, "Gateway probe returned the openclaw-app marker.");
        addCheck("reconcile", "skip", deps.now(), "Probe passed; no repair scheduled.");

        await refreshGatewayTokenForWatchdog({
          force: false,
          reason: "watchdog:healthy-running",
          message: "AI Gateway token is usable for running sandbox.",
        });

        const firewallStartedAt = deps.now();
        const expectedFirewallSandboxId = meta.sandboxId;
        const expectedFirewallLifecycleAttemptId =
          meta.lifecycleAttemptId ?? null;
        try {
          const firewall = await deps.reconcileFirewallPolicy({
            controlPlaneOrigin: getPublicOrigin(options.request),
          });
          const postFirewallMeta = await deps.getMeta();
          const generationChanged =
            postFirewallMeta.status !== "running"
            || postFirewallMeta.sandboxId !== expectedFirewallSandboxId
            || (postFirewallMeta.lifecycleAttemptId ?? null)
              !== expectedFirewallLifecycleAttemptId;
          meta = postFirewallMeta;
          if (generationChanged) {
            throw new Error(
              "Sandbox generation changed or was fail-closed during firewall reconciliation.",
            );
          }
          if (!firewall) {
            addCheck(
              "firewall.policy",
              "skip",
              firewallStartedAt,
              "Firewall policy already matches its latest successful SDK attestation.",
            );
          } else if (firewall.applied) {
            triggeredRepair = true;
            if (!tokenRefreshFailed && failingRequirementIds.length === 0) {
              status = "repairing";
            }
            addCheck(
              "firewall.policy",
              "pass",
              firewallStartedAt,
              "Reconciled the desired firewall policy with the running sandbox.",
              {
                policyHash: firewall.policyHash,
                reason: firewall.reason,
              },
            );
          } else {
            throw new Error(
              `Firewall policy reconciliation did not apply: ${firewall.reason}`,
            );
          }
        } catch (firewallError) {
          meta = await deps.getMeta();
          const message = firewallError instanceof Error
            ? firewallError.message
            : String(firewallError);
          addCheck("firewall.policy", "fail", firewallStartedAt, message);
          lastError = message;
          status = "failed";
          throw firewallError;
        }

        // Restore oracle: attempt to seal a fresh restore target when idle
        const restorePrepareStartedAt = deps.now();
        try {
          const oracle = await deps.runRestoreOracle({
            origin: getPublicOrigin(options.request),
            reason: "watchdog:restore-prepare",
          });

          const oracleData: Record<string, unknown> = {
            blockedReason: oracle.blockedReason,
            decision: oracle.decision,
          };

          if (oracle.executed && oracle.prepare?.ok) {
            triggeredRepair = true;

            // Prewarm a snapshot-backed spare so the next Telegram wake can
            // skip the Sandbox.create() latency entirely.
            const hotSpare = await deps.prepareHotSpare({
              op: createOperationContext({
                trigger: "watchdog",
                reason: "watchdog:restore-prepare-hot-spare",
                sandboxId: meta.sandboxId,
                status: meta.status,
              }),
            });
            oracleData.hotSpareCandidateSandboxId = hotSpare.candidateSandboxId;
            oracleData.hotSpareReason = hotSpare.reason;
            logInfo("watchdog.restore_prepare_hot_spare_result", {
              ok: hotSpare.ok,
              reason: hotSpare.reason,
              candidateSandboxId: hotSpare.candidateSandboxId,
            });

            addCheck(
              "restore.prepare",
              "pass",
              restorePrepareStartedAt,
              oracle.prepare.snapshotId
                ? `Prepared fresh restore target ${oracle.prepare.snapshotId}.`
                : "Prepared fresh restore target.",
              oracleData,
            );
            meta = await deps.getMeta();
            status = failingRequirementIds.length > 0 ? "failed" : "repairing";
          } else if (oracle.executed) {
            const message =
              oracle.prepare?.actions.find((a) => a.status === "failed")?.message ??
              "Restore prepare failed.";
            addCheck("restore.prepare", "fail", restorePrepareStartedAt, message, oracleData);
            lastError = message;
            status = "failed";
          } else {
            const message =
              oracle.blockedReason === "already-ready"
                ? "Restore target already reusable."
                : `Skipped: ${oracle.blockedReason ?? "unknown"}.`;
            addCheck("restore.prepare", "skip", restorePrepareStartedAt, message, oracleData);
            if (tokenRefreshFailed || failingRequirementIds.length > 0) {
              status = "failed";
            } else if (status !== "repairing") {
              status = "ok";
            }
          }
        } catch (oracleError) {
          const errMsg = oracleError instanceof Error ? oracleError.message : String(oracleError);
          addCheck("restore.prepare", "fail", restorePrepareStartedAt, `Oracle error: ${errMsg}`);
          lastError = errMsg;
          status = "failed";
        }
      } else {
        lastError =
          probe.error ??
          `Gateway probe failed (status=${probe.statusCode ?? "unknown"} markerFound=${probe.markerFound ?? false}).`;
        addCheck("probe", "fail", probeStartedAt, lastError);

        if (options.repair === false) {
          addCheck("reconcile", "skip", deps.now(), "Repair disabled for this run.");
          status = "failed";
        } else {
          const reconcileStartedAt = deps.now();
          const watchdogOp = createOperationContext({
            trigger: "watchdog",
            reason: "watchdog:probe_failed",
            sandboxId: meta.sandboxId,
            status: meta.status,
          });
          const reconciliation = await deps.reconcile({
            origin: getPublicOrigin(options.request),
            reason: "watchdog",
            schedule: options.schedule,
            op: watchdogOp,
          });

          triggeredRepair = reconciliation.repaired;

          if (reconciliation.status === "recovering" || reconciliation.repaired) {
            addCheck("reconcile", "pass", reconcileStartedAt, `Recovery scheduled from status ${meta.status}.`);
            status = failingRequirementIds.length > 0 ? "failed" : "repairing";
          } else {
            addCheck("reconcile", "fail", reconcileStartedAt,
              reconciliation.error ?? "Health reconciliation did not schedule recovery.");
            status = "failed";
          }
        }
      }
      } // close SDK stale-check else
    }

  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    logError("watchdog.run_failed", {
      error: lastError,
    });
    status = "failed";
  }

  await runCronAntiEntropy();
  await runChannelCleanupAntiEntropy();

  if (deadlineOwnerFailed) status = "failed";

  const report: WatchdogReport = {
    deploymentId,
    ranAt: new Date(startedAt).toISOString(),
    status,
    sandboxStatus: meta.status,
    triggeredRepair,
    consecutiveFailures:
      status === "failed" ? previous.consecutiveFailures + 1 : 0,
    lastError,
    checks,
  };

  logInfo("watchdog.run_completed", {
    deploymentId,
    status,
    sandboxStatus: meta.status,
    triggeredRepair,
    consecutiveFailures: report.consecutiveFailures,
  });

  return deps.writeReport(report);
}
