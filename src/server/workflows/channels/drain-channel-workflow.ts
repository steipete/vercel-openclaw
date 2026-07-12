import type { ChannelWorkflowHandoff } from "@/server/workflows/channels/drain-channel-step";

type ProcessChannelStepOptions = {
  receivedAtMs: number | null;
  workflowHandoff: ChannelWorkflowHandoff | null;
  requireTelegramConfigGeneration: boolean;
  requireSlackConfigGeneration: boolean;
};

export async function processChannelStep(
  channel: string,
  payload: unknown,
  origin: string,
  requestId: string | null,
  bootMessageId: number | string | null,
  options: ProcessChannelStepOptions,
): Promise<void> {
  "use step";

  const { processChannelStep: runProcessChannelStep } = await import(
    "@/server/workflows/channels/drain-channel-step"
  );
  await runProcessChannelStep(
    channel,
    payload,
    origin,
    requestId,
    bootMessageId,
    options,
  );
}

// Delivery and accepted cleanup each own 25 executions. A crash after the
// acceptance fence can consume the last delivery execution before cleanup is
// reserved, so Workflow must allow both full budgets (initial + 49 retries).
processChannelStep.maxRetries = 49;

export type DrainChannelWorkflowEnvelopeV1 = {
  version: 1;
  channel: string;
  payload: unknown;
  origin: string;
  requestId: string | null;
  bootMessageId?: number | string | null;
  receivedAtMs?: number | null;
  workflowHandoff?: ChannelWorkflowHandoff | null;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isEnvelopeLike(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && "version" in value;
}

function isEnvelopeV1(value: unknown): value is DrainChannelWorkflowEnvelopeV1 {
  return (
    isPlainObject(value) &&
    value.version === 1 &&
    typeof value.channel === "string"
  );
}

async function throwFatalEnvelopeError(message: string): Promise<never> {
  const { FatalError } = await import("workflow");
  throw new FatalError(message);
}

export async function drainChannelWorkflow(
  channelOrEnvelope: string | DrainChannelWorkflowEnvelopeV1,
  payload?: unknown,
  origin?: string,
  requestId?: string | null,
  bootMessageId?: number | string | null,
  receivedAtMs?: number | null,
  workflowHandoff?: ChannelWorkflowHandoff | null,
): Promise<void> {
  "use workflow";

  if (isEnvelopeV1(channelOrEnvelope)) {
    const env = channelOrEnvelope;
    await processChannelStep(
      env.channel,
      env.payload,
      env.origin,
      env.requestId,
      env.bootMessageId ?? null,
      {
        receivedAtMs: env.receivedAtMs ?? null,
        workflowHandoff: env.workflowHandoff ?? null,
        requireTelegramConfigGeneration: true,
        requireSlackConfigGeneration: true,
      },
    );
    return;
  }

  if (isEnvelopeLike(channelOrEnvelope)) {
    await throwFatalEnvelopeError(
      `unsupported_drain_channel_workflow_envelope_version:${String(channelOrEnvelope.version)}`,
    );
  }
  if (typeof channelOrEnvelope !== "string") {
    await throwFatalEnvelopeError(
      "invalid_legacy_drain_channel_workflow_channel",
    );
  }

  await processChannelStep(
    channelOrEnvelope,
    payload,
    origin as string,
    requestId ?? null,
    bootMessageId ?? null,
    {
      receivedAtMs: receivedAtMs ?? null,
      workflowHandoff: workflowHandoff ?? null,
      requireTelegramConfigGeneration: true,
      requireSlackConfigGeneration: true,
    },
  );
}
