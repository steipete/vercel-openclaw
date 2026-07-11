import { ApiError, jsonError } from "@/shared/http";
import {
  requireJsonRouteAuth,
  requireMutationAuth,
  authJsonOk,
} from "@/server/auth/route-auth";
import { snapshotSandbox } from "@/server/sandbox/lifecycle";
import { getInitializedMeta } from "@/server/store/store";

export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const meta = await getInitializedMeta();
  return authJsonOk({ snapshots: meta.snapshotHistory }, auth);
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const meta = await getInitializedMeta();
  if (!meta.sandboxId || meta.status !== "running") {
    return jsonError(
      new ApiError(409, "SANDBOX_NOT_RUNNING", "Sandbox is not running."),
    );
  }

  try {
    // Persistent Sandbox v2 auto-saves on cooperative stop. Keep this legacy
    // UI endpoint on the canonical quiesce path instead of bypassing Gateway
    // admission with the SDK's direct snapshot call.
    const updated = await snapshotSandbox();

    return authJsonOk(
      {
        status: updated.status,
        snapshotId: null,
        record: null,
      },
      auth,
    );
  } catch (error) {
    return jsonError(error);
  }
}
