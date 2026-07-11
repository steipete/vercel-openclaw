export const CRON_DISPATCH_SETTLEMENT_GRACE_MS = 5 * 60_000;

export type CronWakeWorkflowEnvelopeV1 = {
  version: 1;
  projectionRevision: number;
  token: string;
  runAtMs: number;
  wakeAtMs: number;
  origin: string;
};
