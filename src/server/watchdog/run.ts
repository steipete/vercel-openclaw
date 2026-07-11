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
  FIREWALL_FAIL_CLOSED_LAST_ERROR,
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

export type RunSandboxWatchdogOptions = {
  request: Request;
  repair?: boolean;
  schedule?: (callback: () => Promise<void> | void) => void;
};

export type WatchdogDeps = {
  buildContract: (options: { request?: Request }) => Promise<DeploymentContract>;
  getMeta: () => Promise<SingleMeta>;
  reconcileFailClosed?: () => Promise<SingleMeta>;
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
  now: () => number;
};

const WATCHDOG_CRON_WAKE_CHECK_ID = "cron.wake" as const;

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
  reconcileFailClosed: reconcileSnapshottingStatus,
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
    const result = await deps.refreshGatewayToken({
      force: input.force,
      reason: input.reason,
      controlPlaneOrigin: getPublicOrigin(options.request),
    });
    const failed = result.reason.startsWith("refresh-failed:") ||
      result.reason === "no-credential-available";
    addCheck(
      "token.refresh",
      failed ? "fail" : "pass",
      refreshStartedAt,
      failed ? `AI Gateway token refresh failed: ${result.reason}` : input.message,
      {
        refreshed: result.refreshed,
        reason: result.reason,
        force: input.force === true,
        retryAfterMs: result.retryAfterMs,
        source: result.credential?.source ?? null,
        expiresAt: result.credential?.expiresAt ?? null,
      },
    );
    if (failed) {
      tokenRefreshFailed = true;
      lastError = `AI Gateway token refresh failed: ${result.reason}`;
      status = "failed";
    }
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

  try {
    previous = await deps.readPrevious();
    meta = await deps.getMeta();
    if (
      meta.status === "error"
      && meta.lastError === FIREWALL_FAIL_CLOSED_LAST_ERROR
      && deps.reconcileFailClosed
    ) {
      meta = await deps.reconcileFailClosed();
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
            status = tokenRefreshFailed || failingRequirementIds.length > 0 ? "failed" : "ok";
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

    // Anti-entropy only. A token-revalidating Workflow owns the actual wake;
    // watchdog repairs missing/stale dispatch without becoming a second timer.
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
      if (cron.status === "failed" || cron.status === "starting") {
        lastError = cron.status === "starting"
          ? "Cron projection workflow start lease has not settled."
          : "Cron projection workflow could not be started.";
        addCheck(
          WATCHDOG_CRON_WAKE_CHECK_ID,
          "fail",
          cronCheckStartedAt,
          lastError,
          diagnostics ?? undefined,
        );
        status = "failed";
      } else {
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
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      lastError = `Cron projection reconciliation failed: ${errMsg}`;
      addCheck(WATCHDOG_CRON_WAKE_CHECK_ID, "fail", cronCheckStartedAt, lastError);
      status = "failed";
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    logError("watchdog.run_failed", {
      error: lastError,
    });
    status = "failed";
  }

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
