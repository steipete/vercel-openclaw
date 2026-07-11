import { jsonError } from "@/shared/http";
import { requireJsonRouteAuth } from "@/server/auth/route-auth";
import {
  approveDomains,
  removeDomains,
} from "@/server/firewall/state";
import { extractRequestId } from "@/server/log";
import { getPublicOrigin } from "@/server/public-url";

type DomainBody = {
  domains?: string[];
};

export async function POST(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const requestId = extractRequestId(request);
    const body = (await request.json()) as DomainBody;
    const firewall = await approveDomains(body.domains ?? [], {
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

export async function DELETE(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const requestId = extractRequestId(request);
    const body = (await request.json()) as DomainBody;
    const firewall = await removeDomains(body.domains ?? [], {
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
