import {
  authJsonError,
  authJsonOk,
  requireMutationAuth,
} from "@/server/auth/route-auth";
import { getPublicOrigin } from "@/server/public-url";
import { resetSandbox } from "@/server/sandbox/lifecycle";

export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) return auth;

  try {
    const meta = await resetSandbox({
      origin: getPublicOrigin(request),
      reason: "admin.reset",
    });
    if (meta.status !== "uninitialized" || meta.sandboxId !== null) {
      throw new Error(`Sandbox reset ended in ${meta.status}.`);
    }
    return authJsonOk({
      ok: true,
      message: "Sandbox reset completed",
      status: meta.status,
    }, auth);
  } catch (error) {
    return authJsonError(error, auth);
  }
}
