import { jsonError } from "@/shared/http";
import { requireJsonRouteAuth } from "@/server/auth/route-auth";
import {
  promoteLearnedDomainsToEnforcing,
} from "@/server/firewall/state";
import { extractRequestId, logInfo } from "@/server/log";
import { getPublicOrigin } from "@/server/public-url";

export async function POST(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const requestId = extractRequestId(request);
    logInfo("firewall.promote_requested", { operation: "promote", requestId });
    const firewall = await promoteLearnedDomainsToEnforcing({
      requestId,
      controlPlaneOrigin: getPublicOrigin(request),
    });
    const response = Response.json({ firewall });
    if (auth.setCookieHeader) {
      response.headers.append("Set-Cookie", auth.setCookieHeader);
    }
    return response;
  } catch (error) {
    return jsonError(error);
  }
}
