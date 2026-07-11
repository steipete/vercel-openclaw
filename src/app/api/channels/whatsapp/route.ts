import { createChannelAdminRouteHandlers } from "@/server/channels/admin/route-factory";
import { setWhatsAppChannelConfig } from "@/server/channels/state";
import { logInfo } from "@/server/log";
import { ApiError } from "@/shared/http";

export const { GET, PUT, DELETE } = createChannelAdminRouteHandlers({
  channel: "whatsapp",

  selectState(fullState) {
    return fullState.whatsapp;
  },

  async put() {
    // Defense in depth: connectability blocks before this owner callback.
    throw new ApiError(
      409,
      "HOSTED_WHATSAPP_TRANSPORT_UNAVAILABLE",
      "Hosted WhatsApp is unavailable because OpenClaw uses linked-device transport, not Meta Cloud API webhooks.",
    );
  },

  async delete({ assertMutationOwned }) {
    await assertMutationOwned();
    await setWhatsAppChannelConfig(null);
    logInfo("channels.whatsapp_config_removed", {});
  },
});
