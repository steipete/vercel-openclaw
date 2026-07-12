import { ApiError, jsonError } from "@/shared/http";
import { requireMutationAuth, authJsonOk } from "@/server/auth/route-auth";
import { getInitializedMeta, mutateMeta } from "@/server/store/store";
import { withSandboxLifecycleMutationLock } from "@/server/sandbox/lifecycle";
import {
  buildHostIngressFencedResponse,
  getHostMutationFence,
} from "@/server/sandbox/host-suspension";
import {
  deleteVercelSnapshot,
  isSnapshotNotFoundError,
} from "@/server/sandbox/snapshot-delete";

export type SnapshotsDeleteDeps = {
  deleteSnapshot?: (snapshotId: string) => Promise<void>;
};

export async function postAdminSnapshotsDelete(
  request: Request,
  deps: SnapshotsDeleteDeps = {},
): Promise<Response> {
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

  const snapshotId =
    typeof body.snapshotId === "string" ? body.snapshotId.trim() : "";
  if (!snapshotId) {
    return jsonError(
      new ApiError(400, "MISSING_SNAPSHOT_ID", "A snapshotId is required."),
    );
  }

  const del = deps.deleteSnapshot ?? deleteVercelSnapshot;
  try {
    const result = await withSandboxLifecycleMutationLock(async (assertOwned) => {
      await assertOwned();
      const fence = await getHostMutationFence();
      if (fence) return buildHostIngressFencedResponse(fence);

      await assertOwned();
      const meta = await getInitializedMeta();
      const inHistory = meta.snapshotHistory.some(
        (s) => s.snapshotId === snapshotId,
      );
      if (!inHistory) {
        throw new ApiError(
          404,
          "SNAPSHOT_NOT_FOUND",
          "Snapshot not found in history.",
        );
      }
      if (meta.snapshotId === snapshotId) {
        throw new ApiError(
          409,
          "CANNOT_DELETE_CURRENT_SNAPSHOT",
          "Cannot delete the current snapshot.",
        );
      }

      await assertOwned();
      try {
        await del(snapshotId);
      } catch (error) {
        if (!isSnapshotNotFoundError(error)) throw error;
      }
      await assertOwned();
      return mutateMeta((next) => {
        if (
          next.snapshotId !== meta.snapshotId
          || next.sandboxId !== meta.sandboxId
          || (next.lifecycleAttemptId ?? null)
            !== (meta.lifecycleAttemptId ?? null)
        ) {
          throw new ApiError(
            409,
            "SNAPSHOT_DELETE_SUPERSEDED",
            "Sandbox lifecycle changed while deleting the snapshot.",
          );
        }
        next.snapshotHistory = next.snapshotHistory.filter(
          (s) => s.snapshotId !== snapshotId,
        );
      });
    });

    if (result instanceof Response) return result;

    return authJsonOk(
      { ok: true, snapshotId, snapshots: result.snapshotHistory },
      auth,
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  return postAdminSnapshotsDelete(request);
}
