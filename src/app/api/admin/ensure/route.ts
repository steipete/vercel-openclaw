import { after } from "next/server";

import { requireMutationAuth } from "@/server/auth/route-auth";
import { getPublicOrigin } from "@/server/public-url";
import { extractRequestId, logError } from "@/server/log";
import {
  ensureSandboxReady,
  ensureSandboxRunning,
  probeGatewayReady,
} from "@/server/sandbox/lifecycle";
import {
  buildHostIngressFencedResponse,
  getHostMutationFence,
} from "@/server/sandbox/host-suspension";
import { jsonError } from "@/shared/http";

const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const MIN_WAIT_TIMEOUT_MS = 5_000;
const MAX_WAIT_TIMEOUT_MS = 240_000;

function parseWaitFlag(request: Request): boolean {
  const url = new URL(request.url);
  const value = url.searchParams.get("wait");
  return value === "1" || value === "true";
}

function parseTimeoutMs(request: Request): number {
  const url = new URL(request.url);
  const raw = url.searchParams.get("timeoutMs");
  if (!raw) return DEFAULT_WAIT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_WAIT_TIMEOUT_MS;
  return Math.min(MAX_WAIT_TIMEOUT_MS, Math.max(MIN_WAIT_TIMEOUT_MS, parsed));
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const requestId = extractRequestId(request);

  try {
    const origin = getPublicOrigin(request);
    const wait = parseWaitFlag(request);
    const startedAtMs = Date.now();

    const admittedFence = await getHostMutationFence();
    const gatewayReplacementRecovery = admittedFence
      && (
        admittedFence.phase === "replacement-starting"
        || admittedFence.phase === "replacement-failed"
      );
    if (
      admittedFence
      && !gatewayReplacementRecovery
      && admittedFence.phase !== "stopped"
    ) {
      return buildHostIngressFencedResponse(admittedFence);
    }
    if (gatewayReplacementRecovery) {
      const recovered = await ensureSandboxRunning({
        origin,
        reason: "admin.ensure.gateway-replacement-recovery",
        schedule: after,
      });
      const remainingFence = await getHostMutationFence();
      if (remainingFence) {
        return buildHostIngressFencedResponse(remainingFence);
      }
      if (!wait) {
        const response = Response.json(
          {
            mode: "async",
            state: recovered.state,
            ready: recovered.state === "running",
            status: recovered.meta.status,
            sandboxId: recovered.meta.sandboxId ?? null,
            waitedMs: 0,
          },
          { status: recovered.state === "running" ? 200 : 202 },
        );
        if (auth.setCookieHeader) {
          response.headers.append("Set-Cookie", auth.setCookieHeader);
        }
        return response;
      }
    }

    if (wait) {
      const meta = await ensureSandboxReady({
        origin,
        reason: "admin.ensure.wait",
        timeoutMs: parseTimeoutMs(request),
      });

      const probe = await probeGatewayReady();

      const response = Response.json(
        {
          mode: "wait",
          state: "running",
          ready: probe.ready,
          status: meta.status,
          sandboxId: meta.sandboxId ?? null,
          waitedMs: Date.now() - startedAtMs,
          probe: {
            ready: probe.ready,
            statusCode: probe.statusCode,
            markerFound: probe.markerFound,
            error: probe.error,
          },
          restoreMetrics: meta.lastRestoreMetrics ?? undefined,
          restoreHistory: meta.restoreHistory,
        },
        { status: 200 },
      );
      if (auth.setCookieHeader) {
        response.headers.append("Set-Cookie", auth.setCookieHeader);
      }
      return response;
    }

    const result = await ensureSandboxRunning({
      origin,
      reason: "admin.ensure",
      schedule: after,
    });

    const response = Response.json(
      {
        mode: "async",
        state: result.state,
        ready: result.state === "running",
        status: result.meta.status,
        sandboxId: result.meta.sandboxId ?? null,
        waitedMs: 0,
      },
      { status: result.state === "running" ? 200 : 202 },
    );
    if (auth.setCookieHeader) {
      response.headers.append("Set-Cookie", auth.setCookieHeader);
    }
    return response;
  } catch (error) {
    const ctx: Record<string, unknown> = {
      error: error instanceof Error ? error.message : String(error),
    };
    if (requestId) ctx.requestId = requestId;
    logError("admin.ensure_failed", ctx);
    return jsonError(error);
  }
}
