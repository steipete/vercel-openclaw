import * as workflowApi from "workflow/api";

import { monitorHostStopWorkflow } from "@/server/workflows/sandbox/host-stop-workflow";

type WorkflowStarter = typeof workflowApi.start;

let testStartOverride: WorkflowStarter | null = null;

export async function startHostStopMonitor(operationId: string): Promise<void> {
  const testRuntime = process.env.NODE_ENV === "test"
    || process.env.NODE_TEST_CONTEXT !== undefined;
  if (testRuntime && !testStartOverride) return;
  const start = testStartOverride ?? workflowApi.start;
  await start(monitorHostStopWorkflow, [operationId]);
}

export function _setHostStopWorkflowStarterForTesting(
  starter: WorkflowStarter | null,
): void {
  if (process.env.NODE_ENV !== "test" && starter !== null) {
    throw new Error("test-only helper called outside tests");
  }
  testStartOverride = starter;
}
