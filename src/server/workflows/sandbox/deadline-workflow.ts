import { sleep } from "workflow";

import {
  processSandboxDeadlineStep,
  type DeadlineStepResult,
} from "@/server/sandbox/deadline-coordinator";

export async function sandboxDeadlineWorkflow(generationId: string): Promise<void> {
  "use workflow";

  while (true) {
    const result = await runSandboxDeadlineStep(generationId);
    if (result.status === "done") return;
    await sleep(new Date(result.deadlineAtMs));
  }
}

async function runSandboxDeadlineStep(
  generationId: string,
): Promise<DeadlineStepResult> {
  "use step";

  return processSandboxDeadlineStep(generationId);
}
