import { createChannelAdminRouteHandlers } from "@/server/channels/admin/route-factory";
import { patchInteractionsEndpoint } from "@/server/channels/discord/application";
import { hostedDiscordUnavailableError } from "@/server/channels/discord/hosted-support";
import { setDiscordChannelConfig } from "@/server/channels/state";
import { ApiError } from "@/shared/http";

export const { GET, PUT, DELETE } = createChannelAdminRouteHandlers({
  channel: "discord",

  selectState(fullState) {
    return fullState.discord;
  },

  async get({ state }) {
    return state;
  },

  async put() {
    throw hostedDiscordUnavailableError();
  },

  async delete({ meta, assertMutationOwned }) {
    if (meta.channels.discord?.botToken) {
      await assertMutationOwned();
      try {
        await patchInteractionsEndpoint(
          meta.channels.discord.botToken,
          "",
        );
      } catch (error) {
        // A revoked token cannot clean up remotely and can never become valid
        // again. Permit local credential deletion; retry all transient errors.
        if (
          !(error instanceof ApiError)
          || error.code !== "DISCORD_INVALID_BOT_TOKEN"
        ) throw error;
      }
    }
    await assertMutationOwned();
    await setDiscordChannelConfig(null);
  },
});
