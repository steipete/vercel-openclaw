import { authJsonOk, requireMutationAuth } from "@/server/auth/route-auth";
import { requireDebugEnabled } from "@/server/auth/debug-guard";
import { getPublicOrigin } from "@/server/public-url";
import {
  stopSandbox,
  waitForSandboxReady,
} from "@/server/sandbox/lifecycle";
import { ApiError } from "@/shared/http";

type WaterfallEntry = {
  step: string;
  startMs: number;
  endMs: number;
  deltaMs: number;
};

export async function POST(request: Request): Promise<Response> {
  const blocked = requireDebugEnabled();
  if (blocked) return blocked;

  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) return auth;

  const waterfall: WaterfallEntry[] = [];
  const startedAtMs = Date.now();
  const step = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    const startMs = Date.now() - startedAtMs;
    const result = await action();
    const endMs = Date.now() - startedAtMs;
    waterfall.push({ step: name, startMs, endMs, deltaMs: endMs - startMs });
    return result;
  };

  try {
    await step("stopSandbox", async () => {
      try {
        await stopSandbox();
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "SANDBOX_NOT_RUNNING") {
          throw error;
        }
      }
    });

    const ready = await step("waitForSandboxReady", () =>
      waitForSandboxReady({
        origin: getPublicOrigin(request),
        reason: "debug.restore-waterfall",
        reconcile: true,
      }));
    const metrics = ready.meta.lastRestoreMetrics;

    return authJsonOk({
      waterfall,
      totalMs: Date.now() - startedAtMs,
      readyAction: ready.readyAction,
      sandboxId: ready.meta.sandboxId,
      restoreMetrics: metrics,
      summary: metrics
        ? {
            sandboxCreateMs: metrics.sandboxCreateMs,
            assetSyncMs: metrics.assetSyncMs,
            startupScriptMs: metrics.startupScriptMs,
            firewallSyncMs: metrics.firewallSyncMs,
            localReadyMs: metrics.localReadyMs,
            totalMs: metrics.totalMs,
          }
        : null,
    }, auth);
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : String(error),
      waterfall,
      totalMs: Date.now() - startedAtMs,
    }, { status: 500 });
  }
}
