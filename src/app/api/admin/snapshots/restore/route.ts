import { ApiError, jsonError } from "@/shared/http";
import { requireMutationAuth, authJsonOk } from "@/server/auth/route-auth";
import {
  ensureSandboxRunning,
  prepareSnapshotRestore,
} from "@/server/sandbox/lifecycle";

export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  let body: { snapshotId?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError(
      new ApiError(400, "INVALID_JSON", "Request body must be valid JSON."),
    );
  }

  const { snapshotId } = body;
  if (typeof snapshotId !== "string" || !snapshotId.trim()) {
    return jsonError(
      new ApiError(400, "MISSING_SNAPSHOT_ID", "A snapshotId is required."),
    );
  }

  const origin = new URL(request.url).origin;
  try {
    await prepareSnapshotRestore({
      snapshotId,
      reason: `restore-snapshot:${snapshotId}`,
    });
  } catch (error) {
    if (error instanceof ApiError) return jsonError(error);
    throw error;
  }
  const result = await ensureSandboxRunning({
    origin,
    reason: `restore-snapshot:${snapshotId}`,
  });

  return authJsonOk(
    {
      status: result.meta.status,
      snapshotId,
      state: result.state,
    },
    auth,
  );
}
