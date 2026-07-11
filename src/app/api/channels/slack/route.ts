import { ApiError } from "@/shared/http";
import { createChannelAdminRouteHandlers } from "@/server/channels/admin/route-factory";
import { fetchSlackAuthIdentity } from "@/server/channels/slack/auth";
import { setSlackChannelConfig } from "@/server/channels/state";

function parseNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(400, `INVALID_${field.toUpperCase()}`, `${field} must be a non-empty string`);
  }

  return value.trim();
}

export const { GET, PUT, DELETE } = createChannelAdminRouteHandlers({
  channel: "slack",

  selectState(fullState) {
    return fullState.slack;
  },

  async get({ state, url, meta }) {
    if (url.searchParams.get("diagnostics") !== "1" || !meta.channels.slack?.botToken) {
      return state;
    }

    const diagnostics = await fetchSlackAuthIdentity(meta.channels.slack.botToken)
      .then((identity) => ({
        authValid: true,
        ...identity,
      }))
      .catch((error) => ({
        authValid: false,
        error: error instanceof Error ? error.message : String(error),
      }));

    return { ...state, diagnostics };
  },

  async put({ request, assertMutationOwned }) {
    const body = (await request.json()) as {
      signingSecret?: unknown;
      botToken?: unknown;
    };

    const signingSecret = parseNonEmptyString(body.signingSecret, "signingSecret");
    const botToken = parseNonEmptyString(body.botToken, "botToken");

    const authTest = await fetchSlackAuthIdentity(botToken).catch((error) => {
      const code = error instanceof Error ? error.message : String(error);
      throw new ApiError(400, code, code);
    });

    await assertMutationOwned();
    await setSlackChannelConfig({
      signingSecret,
      botToken,
      configuredAt: Date.now(),
      team: authTest.team,
      user: authTest.user,
      botId: authTest.botId,
      liveConfigSync: {
        outcome: "skipped",
        reason: "config_sync_pending",
        liveConfigFresh: false,
        checkedAt: Date.now(),
      },
    });
  },

  async delete({ assertMutationOwned }) {
    await assertMutationOwned();
    await setSlackChannelConfig(null);
  },
});
