import * as workflowApi from "workflow/api";

import { sandboxDeadlineWorkflow } from "@/server/workflows/sandbox/deadline-workflow";

type WorkflowStarter = typeof workflowApi.start;
let testStartOverride: WorkflowStarter | null = null;

export async function startSandboxDeadlineWorkflow(
  generationId: string,
  workflowAttemptId: string,
): Promise<string> {
  const testRuntime = process.env.NODE_ENV === "test"
    || process.env.NODE_TEST_CONTEXT !== undefined;
  if (testRuntime && !testStartOverride) return `test-deadline-${generationId}`;
  const start = testStartOverride ?? workflowApi.start;
  const run = await start(sandboxDeadlineWorkflow, [generationId, workflowAttemptId]);
  return run.runId;
}

export function _setSandboxDeadlineWorkflowStarterForTesting(
  starter: WorkflowStarter | null,
): void {
  if (process.env.NODE_ENV !== "test" && starter !== null) {
    throw new Error("test-only helper called outside tests");
  }
  testStartOverride = starter;
}
