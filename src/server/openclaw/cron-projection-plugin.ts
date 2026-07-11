export const OPENCLAW_CRON_PROJECTION_PLUGIN_ID = "vercel-cron-projection";
export const OPENCLAW_CRON_PROJECTION_PLUGIN_DIR =
  `/home/vercel-sandbox/.openclaw/extensions/${OPENCLAW_CRON_PROJECTION_PLUGIN_ID}`;
export const OPENCLAW_CRON_PROJECTION_MAX_WAKES = 4_096;

const pluginManifest = {
  id: OPENCLAW_CRON_PROJECTION_PLUGIN_ID,
  activation: {
    onStartup: true,
    onConfigPaths: [
      `plugins.entries.${OPENCLAW_CRON_PROJECTION_PLUGIN_ID}`,
    ],
  },
  configSchema: {
    type: "object",
    additionalProperties: false,
    required: ["endpoint"],
    properties: {
      endpoint: { type: "string", format: "uri" },
    },
  },
};

const pluginPackage = {
  name: "@vercel/openclaw-cron-projection",
  version: "1.0.0",
  private: true,
  type: "module",
  openclaw: { extensions: ["./index.mjs"] },
};

export function buildCronProjectionPluginSource(): string {
  return `import { createHash, createHmac, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const sourceId = randomUUID();
const sourceStartedAtMs = Date.now();
const attemptTimeoutMs = 30_000;
const maxProjectedWakes = ${OPENCLAW_CRON_PROJECTION_MAX_WAKES};
const settlementGraceMs = 5 * 60_000;
const overdueSafetyIntervalMs = 15 * 60_000;
const maxTimerDelayMs = 2_147_000_000;

const waitForAbort = (signal) => new Promise((_, reject) => {
  const rejectAborted = () => reject(
    signal.reason instanceof Error ? signal.reason : new Error("projection attempt aborted"),
  );
  if (signal.aborted) rejectAborted();
  else signal.addEventListener("abort", rejectAborted, { once: true });
});

export default definePluginEntry({
  id: "${OPENCLAW_CRON_PROJECTION_PLUGIN_ID}",
  name: "Vercel cron projection",
  description: "Project bounded OpenClaw cron wake snapshots to the Vercel host",
  reload: {
    restartPrefixes: [
      "plugins.enabled",
      "plugins.allow",
      "plugins.load",
      "plugins.entries.${OPENCLAW_CRON_PROJECTION_PLUGIN_ID}",
    ],
  },
  register(api) {
    const endpoint = api.pluginConfig?.endpoint;
    const gatewayValue = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
    if (typeof endpoint !== "string" || !endpoint || !gatewayValue) {
      throw new Error("vercel cron projection requires endpoint and gateway token");
    }
    const gatewayGeneration = createHash("sha256")
      .update(gatewayValue)
      .digest("hex")
      .slice(0, 32);

    const lifecycle = new AbortController();
    let cron;
    let enabled = false;
    let hasBaseline = false;
    let requestedRevision = 0;
    let requestedReason = "changed";
    let appliedRevision = 0;
    let worker = Promise.resolve();
    let activeAttempt;
    let settlementTimer;
    let reconciliationSignal;

    const waitUntil = async (deadlineMs, signal) => {
      while (Date.now() < deadlineMs) {
        await sleep(
          Math.min(maxTimerDelayMs, deadlineMs - Date.now()),
          undefined,
          { signal },
        );
      }
    };

    const scheduleSettlementSafety = (wakes) => {
      settlementTimer?.abort();
      settlementTimer = undefined;
      const earliestRunAtMs = wakes[0]?.runAtMs;
      if (!earliestRunAtMs) return;
      const timer = new AbortController();
      settlementTimer = timer;
      const naturalDeadlineMs = earliestRunAtMs + settlementGraceMs;
      const deadlineMs = Math.max(
        naturalDeadlineMs,
        Date.now() + (naturalDeadlineMs <= Date.now() ? overdueSafetyIntervalMs : 0),
      );
      const signal = AbortSignal.any([lifecycle.signal, timer.signal]);
      void waitUntil(deadlineMs, signal)
        .then(() => {
          if (!signal.aborted && settlementTimer === timer) {
            return requestProjection("changed");
          }
        })
        .catch(() => undefined);
    };

    const projectLatest = async () => {
      const ownerSignal = reconciliationSignal;
      if (!ownerSignal || ownerSignal.aborted) return;
      let retryMs = 1_000;
      while (
        !lifecycle.signal.aborted &&
        !ownerSignal.aborted &&
        appliedRevision < requestedRevision
      ) {
        const targetRevision = requestedRevision;
        const targetReason = requestedReason;
        const attempt = new AbortController();
        const timeoutSignal = AbortSignal.timeout(attemptTimeoutMs);
        const controlSignal = AbortSignal.any([
          lifecycle.signal,
          attempt.signal,
          ownerSignal,
        ]);
        const signal = AbortSignal.any([
          controlSignal,
          timeoutSignal,
        ]);
        activeAttempt = attempt;
        try {
          const jobs = enabled && cron
            ? await Promise.race([
                cron.list({ includeDisabled: true }),
                waitForAbort(signal),
              ])
            : [];
          if (signal.aborted || targetRevision !== requestedRevision) continue;
          const wakes = jobs
            .flatMap((job) => {
              const runAtMs = job.enabled === false ? undefined : job.state?.nextRunAtMs;
              return Number.isSafeInteger(runAtMs) && runAtMs > 0
                ? [{
                    jobKey: createHmac("sha256", gatewayValue)
                      .update(job.id)
                      .digest("hex")
                      .slice(0, 32),
                    runAtMs,
                  }]
                : [];
            })
            .sort((left, right) =>
              left.runAtMs - right.runAtMs || left.jobKey.localeCompare(right.jobKey),
            )
            .slice(0, maxProjectedWakes);
          const response = await fetch(endpoint, {
            method: "POST",
            headers: {
              authorization: "Bearer " + gatewayValue,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              schemaVersion: 1,
              gatewayGeneration,
              sourceId,
              sourceStartedAtMs,
              sourceRevision: targetRevision,
              reason: targetReason,
              projectedAtMs: Date.now(),
              wakes,
            }),
            signal,
          });
          let responseStatus;
          try {
            if (!response.ok) {
              throw new Error("host rejected cron projection with status " + response.status);
            }
            const payload = await response.json();
            responseStatus = payload?.status;
            if (responseStatus !== "accepted" && responseStatus !== "idempotent") {
              throw new Error("host did not accept cron projection ownership");
            }
          } finally {
            if (!response.bodyUsed) await response.body?.cancel();
          }
          if (signal.aborted || targetRevision !== requestedRevision) continue;
          appliedRevision = targetRevision;
          scheduleSettlementSafety(wakes);
          retryMs = 1_000;
        } catch {
          if (lifecycle.signal.aborted) return;
          if (ownerSignal.aborted) return;
          if (attempt.signal.aborted) continue;
          api.logger.warn("Vercel cron projection failed; retrying in " + retryMs + "ms");
          try {
            await sleep(retryMs, undefined, { signal: controlSignal });
          } catch {
            if (lifecycle.signal.aborted) return;
            if (ownerSignal.aborted) return;
            if (attempt.signal.aborted) continue;
          }
          retryMs = Math.min(retryMs * 2, 30_000);
        } finally {
          attempt.abort();
          if (activeAttempt === attempt) activeAttempt = undefined;
        }
      }
    };

    const requestProjection = (reason) => {
      requestedReason = reason;
      const targetRevision = ++requestedRevision;
      activeAttempt?.abort();
      worker = worker.then(async () => {
        if (!lifecycle.signal.aborted && appliedRevision < targetRevision) {
          await projectLatest();
        }
      });
      return worker;
    };

    api.on("cron_reconciled", (event, ctx) => {
      const reconciledCron = ctx.getCron?.();
      if (event.enabled && !reconciledCron) {
        api.logger.warn("cron reconciliation did not expose a scheduler");
        return;
      }
      cron = reconciledCron;
      enabled = event.enabled;
      hasBaseline = true;
      reconciliationSignal = ctx.abortSignal;
      return requestProjection(event.reason);
    });

    api.on("cron_changed", () => {
      if (hasBaseline && !reconciliationSignal?.aborted) {
        return requestProjection("changed");
      }
    });

    api.on("gateway_stop", async () => {
      lifecycle.abort();
      settlementTimer?.abort();
      await worker;
    });
  },
});
`;
}

export function buildCronProjectionPluginFiles(): Array<{
  path: string;
  content: Buffer;
}> {
  return [
    {
      path: `${OPENCLAW_CRON_PROJECTION_PLUGIN_DIR}/openclaw.plugin.json`,
      content: Buffer.from(`${JSON.stringify(pluginManifest, null, 2)}\n`),
    },
    {
      path: `${OPENCLAW_CRON_PROJECTION_PLUGIN_DIR}/package.json`,
      content: Buffer.from(`${JSON.stringify(pluginPackage, null, 2)}\n`),
    },
    {
      path: `${OPENCLAW_CRON_PROJECTION_PLUGIN_DIR}/index.mjs`,
      content: Buffer.from(buildCronProjectionPluginSource()),
    },
  ];
}
