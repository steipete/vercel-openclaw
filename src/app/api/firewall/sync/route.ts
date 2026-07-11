import { authJsonError, authJsonOk, requireMutationAuth } from "@/server/auth/route-auth";
import { syncFirewallPolicyIfRunning } from "@/server/firewall/state";
import { extractRequestId } from "@/server/log";
import { getPublicOrigin } from "@/server/public-url";

export async function POST(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const requestId = extractRequestId(request);
    const result = await syncFirewallPolicyIfRunning({
      requestId,
      controlPlaneOrigin: getPublicOrigin(request),
    });
    return authJsonOk({ result }, auth);
  } catch (error) {
    return authJsonError(error, auth);
  }
}
