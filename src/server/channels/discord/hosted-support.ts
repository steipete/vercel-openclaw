import { ApiError } from "@/shared/http";

export const HOSTED_DISCORD_UNAVAILABLE_CODE =
  "HOSTED_DISCORD_TRANSPORT_UNAVAILABLE";
export const HOSTED_DISCORD_UNAVAILABLE_MESSAGE =
  "Discord is not available on the hosted Vercel transport. Use OpenClaw's local Discord Gateway integration instead.";

export function hostedDiscordUnavailableError(): ApiError {
  return new ApiError(
    409,
    HOSTED_DISCORD_UNAVAILABLE_CODE,
    HOSTED_DISCORD_UNAVAILABLE_MESSAGE,
  );
}

export function buildDiscordHostedUnavailableInteractionResponse(): Response {
  return Response.json({
    type: 4,
    data: {
      content: HOSTED_DISCORD_UNAVAILABLE_MESSAGE,
      flags: 64,
    },
  });
}
