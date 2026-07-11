import { createHash, timingSafeEqual } from "node:crypto";
import * as workflowApi from "workflow/api";

import { supportsCronProjectionBundleIdentity } from "@/server/cron/compatibility";
import {
  cancelSupersededCronWake,
  reconcileCronProjection,
  type CronProjectionReconcileResult,
} from "@/server/cron/dispatch";
import {
  acceptCronProjection,
  type AcceptCronProjectionResult,
  CRON_PROJECTION_MAX_BODY_BYTES,
  parseCronProjectionInput,
} from "@/server/cron/projection";
import { logInfo, logWarn } from "@/server/log";
import { matchesConfiguredBundleIdentity } from "@/server/openclaw/bundle-identity";
import { getPublicOrigin } from "@/server/public-url";
import { getInitializedMeta } from "@/server/store/store";
import { cronWakeWorkflow } from "@/server/workflows/cron/cron-wake-workflow";

export const cronProjectionRouteRuntime = {
  start: workflowApi.start,
};

function bearerToken(request: Request): string | null {
  const match = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function safeTokenEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

async function getAuthorizedGatewayGeneration(
  request: Request,
): Promise<{
  gatewayGeneration: string;
  meta: Awaited<ReturnType<typeof getInitializedMeta>>;
} | null> {
  const provided = bearerToken(request);
  if (!provided) return null;
  const meta = await getInitializedMeta();
  if (!safeTokenEqual(provided, meta.gatewayToken)) return null;
  return {
    gatewayGeneration: createHash("sha256")
      .update(provided)
      .digest("hex")
      .slice(0, 32),
    meta,
  };
}

async function readBody(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > CRON_PROJECTION_MAX_BODY_BYTES
  ) {
    throw new Error("projection_body_too_large");
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > CRON_PROJECTION_MAX_BODY_BYTES) {
    throw new Error("projection_body_too_large");
  }
  return JSON.parse(text) as unknown;
}

export async function POST(request: Request): Promise<Response> {
  const authorized = await getAuthorizedGatewayGeneration(request);
  if (!authorized) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const identity = matchesConfiguredBundleIdentity(
    authorized.meta.bundleIdentity,
  )
    ? authorized.meta.bundleIdentity
    : null;
  if (!supportsCronProjectionBundleIdentity(identity)) {
    return Response.json(
      { error: "CRON_PROJECTION_UNVERIFIED_BUNDLE" },
      { status: 409 },
    );
  }

  let body: unknown;
  try {
    body = await readBody(request);
  } catch (error) {
    const code = error instanceof Error ? error.message : "invalid_json";
    return Response.json(
      { error: code === "projection_body_too_large" ? code : "invalid_json" },
      { status: code === "projection_body_too_large" ? 413 : 400 },
    );
  }
  const parsed = parseCronProjectionInput(body);
  if (!parsed.ok) {
    return Response.json(
      { error: "INVALID_CRON_PROJECTION", message: parsed.message },
      { status: 400 },
    );
  }
  if (parsed.value.gatewayGeneration !== authorized.gatewayGeneration) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  let accepted: AcceptCronProjectionResult;
  let dispatch: CronProjectionReconcileResult;
  try {
    accepted = await acceptCronProjection(parsed.value);
    await cancelSupersededCronWake(accepted.supersededWorkflowRunId);
    dispatch = await reconcileCronProjection({
      enabled: true,
      origin: getPublicOrigin(request),
      startWorkflow: async (envelope) => {
        const run = await cronProjectionRouteRuntime.start(
          cronWakeWorkflow,
          [envelope],
          { deploymentId: "latest" },
        );
        return { runId: run.runId };
      },
    });
  } catch (error) {
    logWarn("cron.projection_accept_failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return Response.json(
      { error: "CRON_PROJECTION_STATE_UNAVAILABLE" },
      { status: 503 },
    );
  }
  logInfo("cron.projection_accepted", {
    status: accepted.status,
    projectionRevision: accepted.record.projectionRevision,
    sourceRevision: accepted.record.source?.revision ?? null,
    wakeCount: accepted.record.wakes.length,
    nextRunAtMs: accepted.record.nextRunAtMs,
    dispatchStatus: dispatch.status,
  });
  if (dispatch.status === "failed" || dispatch.status === "starting") {
    return Response.json(
      {
        error: "CRON_PROJECTION_DISPATCH_PENDING",
        projectionRevision: accepted.record.projectionRevision,
        dispatch: dispatch.status,
      },
      { status: 503 },
    );
  }
  return Response.json(
    {
      ok: true,
      status: accepted.status,
      projectionRevision: accepted.record.projectionRevision,
      dispatch: dispatch.status,
    },
    { status: 202 },
  );
}
