import { authJsonError, requireJsonRouteAuth } from "@/server/auth/route-auth";
import { hostedDiscordUnavailableError } from "@/server/channels/discord/hosted-support";

export async function POST(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  return authJsonError(hostedDiscordUnavailableError(), auth);
}
