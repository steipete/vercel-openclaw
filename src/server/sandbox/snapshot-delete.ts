import { APIError } from "@vercel/sandbox";

import { ApiError } from "@/shared/http";

type SnapshotValidationOverride = (
  snapshotId: string,
) => Promise<{ status: "created" | "deleted" | "failed"; expiresAt?: Date }>;

let snapshotValidationOverride: SnapshotValidationOverride | null = null;
let snapshotDeletionOverride: ((snapshotId: string) => Promise<void>) | null = null;

export function _setSnapshotValidationOverrideForTesting(
  override: SnapshotValidationOverride | null,
): void {
  snapshotValidationOverride = override;
}

export function _setSnapshotDeletionOverrideForTesting(
  override: ((snapshotId: string) => Promise<void>) | null,
): void {
  snapshotDeletionOverride = override;
}

export async function assertVercelSnapshotReady(
  snapshotId: string,
): Promise<void> {
  if (snapshotValidationOverride) {
    const snapshot = await snapshotValidationOverride(snapshotId);
    assertSnapshotReady(snapshotId, snapshot.status, snapshot.expiresAt);
    return;
  }
  // Unit/route harnesses use synthetic snapshot ids. Production always checks
  // provider truth before a destructive historical restore.
  if (process.env.NODE_ENV === "test") return;
  const { Snapshot } = await import("@vercel/sandbox");
  let snapshot: Awaited<ReturnType<typeof Snapshot.get>>;
  try {
    snapshot = await Snapshot.get({ snapshotId });
  } catch (error) {
    if (isSnapshotNotFoundError(error)) {
      throw new ApiError(
        404,
        "SNAPSHOT_NOT_FOUND",
        "Snapshot no longer exists at the provider.",
      );
    }
    throw error;
  }
  assertSnapshotReady(snapshotId, snapshot.status, snapshot.expiresAt);
}

function assertSnapshotReady(
  snapshotId: string,
  status: "created" | "deleted" | "failed",
  expiresAt?: Date,
): void {
  if (status !== "created") {
    throw new ApiError(
      409,
      "SNAPSHOT_NOT_READY",
      `Snapshot ${snapshotId} cannot be restored because its provider status is ${status}.`,
    );
  }
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new ApiError(
      410,
      "SNAPSHOT_EXPIRED",
      `Snapshot ${snapshotId} has expired.`,
    );
  }
}

export async function deleteVercelSnapshot(snapshotId: string): Promise<void> {
  if (snapshotDeletionOverride) {
    await snapshotDeletionOverride(snapshotId);
    return;
  }
  const { Snapshot } = await import("@vercel/sandbox");
  const snap = await Snapshot.get({ snapshotId });
  await snap.delete();
}

export function isSnapshotNotFoundError(error: unknown): boolean {
  return (
    error instanceof APIError && error.response?.status === 404
  );
}
