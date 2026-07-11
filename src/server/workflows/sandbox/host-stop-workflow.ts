import { sleep } from "workflow";

import { logInfo } from "@/server/log";
import {
  heartbeatHostStopMonitor,
  readHostSuspensionState,
  type HostSuspensionState,
} from "@/server/sandbox/host-suspension";
import {
  reconcileSnapshottingStatus,
  resetSandbox,
} from "@/server/sandbox/lifecycle";
import { getInitializedMeta } from "@/server/store/store";
import type { SingleMeta } from "@/shared/types";

const HOST_STOP_POLL_MS = 5_000;

export type HostStopMonitorResult =
  | { status: "done"; reason: string }
  | { status: "poll"; phase: string; sandboxStatus: string };

export type HostStopMonitorDeps = {
  readSuspension: () => Promise<HostSuspensionState | null>;
  getMeta: () => Promise<SingleMeta>;
  reconcile: () => Promise<SingleMeta>;
  resumeReset: () => Promise<SingleMeta>;
  heartbeat: (operationId: string) => Promise<void>;
};

const defaultDeps: HostStopMonitorDeps = {
  readSuspension: readHostSuspensionState,
  getMeta: getInitializedMeta,
  reconcile: reconcileSnapshottingStatus,
  resumeReset: () => resetSandbox({
    origin: "http://127.0.0.1",
    reason: "sandbox.reset.monitor",
  }),
  heartbeat: heartbeatHostStopMonitor,
};

export async function monitorHostStopWorkflow(operationId: string): Promise<void> {
  "use workflow";

  while (true) {
    await sleep(HOST_STOP_POLL_MS);
    const result = await processHostStopMonitorStep(operationId);
    if (result.status === "done") return;
  }
}

export async function processHostStopMonitorStep(
  operationId: string,
  deps: HostStopMonitorDeps = defaultDeps,
): Promise<HostStopMonitorResult> {
  "use step";

  await deps.heartbeat(operationId);
  const state = await deps.readSuspension();
  if (!state || state.operationId !== operationId) {
    return { status: "done", reason: "operation-replaced-or-cleared" };
  }
  let meta = await deps.getMeta();
  if (state.intent === "reset" && state.phase === "stopping") {
    try {
      meta = await deps.resumeReset();
    } catch (error) {
      // Reset itself records terminal delete failures and reopens admission.
      // Lock contention or transient cleanup errors keep this durable monitor
      // alive so a later step can adopt the same reset operation.
      logInfo("sandbox.host_stop_monitor.reset_retry_deferred", {
        operationId,
        error: error instanceof Error ? error.message : String(error),
      });
      meta = await deps.getMeta();
    }
  } else if (
    meta.status === "snapshotting"
    || state.phase === "fencing"
    || state.phase === "preparing"
    || state.phase === "prepared"
    || state.phase === "stop-requesting"
  ) {
    meta = await deps.reconcile();
  }
  const latest = await deps.readSuspension();
  if (!latest || latest.operationId !== operationId) {
    return { status: "done", reason: "operation-replaced-or-cleared" };
  }
  if (
    latest.phase === "stopped"
    || latest.phase === "running"
    || (!latest.ingressFenced && latest.phase === "failed")
  ) {
    logInfo("sandbox.host_stop_monitor.completed", {
      operationId,
      phase: latest.phase,
      sandboxStatus: meta.status,
    });
    return { status: "done", reason: `terminal-${latest.phase}` };
  }

  return {
    status: "poll",
    phase: latest.phase,
    sandboxStatus: meta.status,
  };
}
