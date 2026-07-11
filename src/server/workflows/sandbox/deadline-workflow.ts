import { getWorkflowMetadata, sleep } from "workflow";

type DeadlineStepResult =
  | { status: "done"; reason: string }
  | { status: "sleep"; deadlineAtMs: number };

export async function sandboxDeadlineWorkflow(
  generationId: string,
  workflowAttemptId: string,
): Promise<void> {
  "use workflow";

  const workflowRunId = getWorkflowMetadata().workflowRunId;
  if (!await adoptSandboxDeadlineWorkflowStep(
    generationId,
    workflowAttemptId,
    workflowRunId,
  )) return;

  while (true) {
    const result = await runSandboxDeadlineStep(generationId, workflowAttemptId);
    if (result.status === "done") return;
    await sleep(new Date(result.deadlineAtMs));
  }
}

async function runSandboxDeadlineStep(
  generationId: string,
  workflowAttemptId: string,
): Promise<DeadlineStepResult> {
  "use step";

  const { processSandboxDeadlineStep } = await import(
    "@/server/sandbox/deadline-coordinator"
  );
  return processSandboxDeadlineStep(generationId, workflowAttemptId);
}

async function adoptSandboxDeadlineWorkflowStep(
  generationId: string,
  workflowAttemptId: string,
  workflowRunId: string,
): Promise<boolean> {
  "use step";

  const { adoptSandboxDeadlineWorkflow } = await import(
    "@/server/sandbox/deadline-coordinator"
  );
  return adoptSandboxDeadlineWorkflow(
    generationId,
    workflowAttemptId,
    workflowRunId,
  );
}
