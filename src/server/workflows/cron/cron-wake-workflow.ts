import { sleep } from "workflow";

import type { CronWakeWorkflowEnvelopeV1 } from "@/server/cron/workflow-contract";
import {
  countCronSettlementRecoveryAttempt,
  getCronWakeDurableRetryMs,
  CRON_WAKE_MONITOR_INTERVAL_MS,
  shouldContinueCronSettlementRecovery,
} from "@/server/workflows/cron/cron-wake-contract";
import {
  handoffCronWakeStep,
  isCronDispatchRepairNeededStep,
  processCronWakeStep,
  settleCronWakeStep,
} from "@/server/workflows/cron/cron-wake-steps";

export {
  CRON_SETTLEMENT_MAX_RECOVERY_ATTEMPTS,
  CRON_WAKE_POST_DUE_SAFETY_MS,
  getCronWakeCredentialRetry,
  getCronWakeDurableRetryMs,
  countCronSettlementRecoveryAttempt,
  shouldContinueCronSettlementRecovery,
  shouldCancelCronWakeHandoff,
} from "@/server/workflows/cron/cron-wake-contract";
export {
  handoffCronWakeStep,
  isCronDispatchRepairNeededStep,
  processCronWakeStep,
  settleCronWakeStep,
} from "@/server/workflows/cron/cron-wake-steps";

export async function cronWakeWorkflow(
  envelope: CronWakeWorkflowEnvelopeV1,
): Promise<void> {
  "use workflow";

  if (envelope.version !== 1) {
    throw new Error("unsupported_cron_wake_workflow_envelope");
  }
  await sleep(new Date(envelope.wakeAtMs));
  let recoveryCycle = 0;
  while (true) {
    const outcome = await handoffCronWakeStep(envelope);
    if (outcome.status === "settled") return;
    if (outcome.status === "monitor") {
      let monitorAfterMs = CRON_WAKE_MONITOR_INTERVAL_MS;
      let settlementRecoveryAttempts = 0;
      while (true) {
        await sleep(monitorAfterMs);
        const monitor = await settleCronWakeStep(envelope);
        if (monitor.status === "settled") return;
        if (monitor.status === "rehandoff") break;
        settlementRecoveryAttempts = countCronSettlementRecoveryAttempt(
          settlementRecoveryAttempts,
          monitor.settlementRecoveryAttempted,
        );
        if (!shouldContinueCronSettlementRecovery(settlementRecoveryAttempts)) {
          return;
        }
        monitorAfterMs = monitor.retryAfterMs;
      }
      continue;
    }
    await sleep(
      getCronWakeDurableRetryMs(recoveryCycle, outcome.retryAfterMs),
    );
    recoveryCycle += 1;
  }
}

export async function cronDispatchRepairWorkflow(
  envelope: CronWakeWorkflowEnvelopeV1,
  repairAtMs: number,
): Promise<void> {
  "use workflow";

  if (envelope.version !== 1) {
    throw new Error("unsupported_cron_wake_workflow_envelope");
  }
  await sleep(new Date(repairAtMs));
  while (true) {
    const outcome = await settleCronWakeStep(envelope);
    if (outcome.status === "settled") return;
    if (outcome.status === "rehandoff") return;
    if (!(await isCronDispatchRepairNeededStep(envelope))) return;
    await sleep(outcome.retryAfterMs);
  }
}

export async function cronWakeExecutionWorkflow(
  envelope: CronWakeWorkflowEnvelopeV1,
  parentWorkflowRunId: string,
): Promise<void> {
  "use workflow";

  // Timer runs stay deployment-pinned. This stable v1 entry point lets the
  // timer resolve the current deployment only when the wake actually fires.
  if (envelope.version !== 1) {
    throw new Error("unsupported_cron_wake_workflow_envelope");
  }
  let recoveryCycle = 0;
  while (true) {
    const outcome = await processCronWakeStep(
      envelope,
      parentWorkflowRunId,
    );
    if (outcome.status === "settled") return;
    // Timer parents in every shipped deployment monitor after handoff. Keep
    // recovery parent-owned across mixed-deployment handoffs; the current
    // execution child owns only sandbox wake and completion state.
    if (outcome.status === "completed") return;
    await sleep(
      getCronWakeDurableRetryMs(recoveryCycle, outcome.retryAfterMs),
    );
    recoveryCycle += 1;
  }
}
