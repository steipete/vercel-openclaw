import { after } from "next/server";

import { ApiError, jsonError, jsonOk } from "@/shared/http";
import { requireAdminAuth, requireAdminMutationAuth } from "@/server/auth/admin-auth";
import { logWarn } from "@/server/log";
import {
  buildHostIngressFencedResponse,
  getHostMutationFence,
  type HostIngressFence,
} from "@/server/sandbox/host-suspension";
import { lifecycleLockKey } from "@/server/store/keyspace";
import { getStore } from "@/server/store/store";

type AdminAuthResult = Exclude<
  Awaited<ReturnType<typeof requireAdminAuth>>,
  Response
>;

/**
 * Opt-in local safety switch: when LOCAL_READ_ONLY=1, block every mutation
 * route at the auth boundary. Intended for "pnpm dev against prod env"
 * sessions where the operator wants to tweak UI without risking accidental
 * sandbox stop / reset / snapshot delete / channel re-register against prod.
 */
function localReadOnlyBlocked(): Response | null {
  if (process.env.LOCAL_READ_ONLY?.trim() !== "1") {
    return null;
  }
  return jsonError(
    new ApiError(
      403,
      "LOCAL_READ_ONLY",
      "Mutations are disabled because LOCAL_READ_ONLY=1 is set. Unset it to allow writes.",
    ),
  );
}

const ALWAYS_ALLOWED_SUSPENSION_CONTROL_PATHS = new Set([
  "/api/admin/reset",
  "/api/admin/snapshot",
  "/api/admin/stop",
]);

const WAKE_CONTROL_PATHS = new Set([
  "/api/admin/ensure",
  "/api/admin/snapshots/restore",
  "/api/admin/watchdog",
]);

const LIFECYCLE_MANAGED_MUTATION_PATHS = new Set([
  "/api/admin/ensure",
  "/api/admin/launch-verify",
  "/api/admin/lifecycle-lock",
  "/api/admin/prepare-restore",
  "/api/admin/reset",
  "/api/admin/snapshot",
  "/api/admin/snapshots",
  "/api/admin/snapshots/restore",
  "/api/admin/stop",
  "/api/admin/watchdog",
  "/api/debug/restore-waterfall",
]);

const HOST_MUTATION_LOCK_TTL_SECONDS = 330;

function hostMutationLockBusyResponse(): Response {
  return Response.json({
    error: "HOST_MUTATION_BUSY",
    message: "Another sandbox mutation or lifecycle transition is in progress.",
  }, {
    status: 503,
    headers: { "Cache-Control": "no-store", "Retry-After": "2" },
  });
}

async function admitHostMutation(request: Request): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (LIFECYCLE_MANAGED_MUTATION_PATHS.has(path)) return null;

  const store = getStore();
  const token = await store.acquireLock(
    lifecycleLockKey(),
    HOST_MUTATION_LOCK_TTL_SECONDS,
  );
  if (!token) return hostMutationLockBusyResponse();

  const release = async () => {
    await store.releaseLock(lifecycleLockKey(), token);
  };
  try {
    // The first fence read and lock acquisition are not atomic. Recheck while
    // holding the lifecycle lock so a stop that won the race cannot be
    // followed by a mutation after it releases the lock.
    const suspensionBlock = await hostMutationBlocked(request);
    if (suspensionBlock) {
      await release();
      return suspensionBlock;
    }
  } catch (error) {
    await release();
    throw error;
  }
  const testRuntime = process.env.NODE_ENV === "test"
    || process.env.NODE_TEST_CONTEXT !== undefined;
  if (testRuntime) {
    await release();
    return null;
  }

  try {
    // Hold the same distributed lock used by stop/reset until the response is
    // complete. Either the mutation wins first and stop refuses, or stop wins
    // first and this admission refuses; no check-to-action gap remains.
    after(release);
    return null;
  } catch (error) {
    await release();
    logWarn("auth.host_mutation_after_registration_failed", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return hostMutationLockBusyResponse();
  }
}

function mutationAllowedDuringSuspension(
  request: Request,
  fence: HostIngressFence,
): boolean {
  const path = new URL(request.url).pathname;
  if (ALWAYS_ALLOWED_SUSPENSION_CONTROL_PATHS.has(path)) return true;
  return fence.phase === "stopped" && WAKE_CONTROL_PATHS.has(path);
}

async function hostMutationBlocked(request: Request): Promise<Response | null> {
  const fence = await getHostMutationFence();
  if (!fence || mutationAllowedDuringSuspension(request, fence)) return null;
  return buildHostIngressFencedResponse(fence);
}

/**
 * Require admin auth for JSON API routes.
 * For mutations (POST/PUT/DELETE), also enforces CSRF for cookie sessions.
 */
export async function requireJsonRouteAuth(
  request: Request,
): Promise<Response | AdminAuthResult> {
  const method = request.method.toUpperCase();
  const isMutation = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";

  if (isMutation) {
    return requireMutationAuth(request);
  }

  return requireAdminAuth(request);
}

/**
 * Require admin auth + CSRF for mutation routes.
 */
export async function requireMutationAuth(
  request: Request,
): Promise<Response | AdminAuthResult> {
  const blocked = localReadOnlyBlocked();
  if (blocked) return blocked;
  const auth = await requireAdminMutationAuth(request);
  if (auth instanceof Response) return auth;
  const suspensionBlock = await hostMutationBlocked(request);
  if (suspensionBlock) return suspensionBlock;
  const admissionBlock = await admitHostMutation(request);
  if (admissionBlock) return admissionBlock;
  return auth;
}

export function authJsonOk<T>(
  data: T,
  auth: { setCookieHeader: string | null } | null,
  init?: ResponseInit,
): Response {
  const response = jsonOk(data, init);
  if (auth?.setCookieHeader) {
    response.headers.append("Set-Cookie", auth.setCookieHeader);
  }
  return response;
}

export function authJsonError(
  error: unknown,
  auth: { setCookieHeader: string | null } | null = null,
  init?: ResponseInit,
): Response {
  const response = jsonError(error, init);
  if (auth?.setCookieHeader) {
    response.headers.append("Set-Cookie", auth.setCookieHeader);
  }
  return response;
}
