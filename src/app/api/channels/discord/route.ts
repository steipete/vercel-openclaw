import { createChannelAdminRouteHandlers } from "@/server/channels/admin/route-factory";
import { patchInteractionsEndpoint } from "@/server/channels/discord/application";
import { hostedDiscordUnavailableError } from "@/server/channels/discord/hosted-support";
import { setDiscordChannelConfig } from "@/server/channels/state";

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
      await patchInteractionsEndpoint(
        meta.channels.discord.botToken,
        "",
      ).catch(() => {});
    }
    await assertMutationOwned();
    await setDiscordChannelConfig(null);
  },
});
