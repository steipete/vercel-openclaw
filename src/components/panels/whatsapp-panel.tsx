"use client";

import { ConfirmDialog, useConfirm } from "@/components/ui/confirm-dialog";
import type { RunAction, StatusPayload } from "@/components/admin-types";
import {
  ChannelCardFrame,
  getChannelActionLabel,
} from "@/components/panels/channel-panel-shared";

type WhatsAppPanelProps = {
  status: StatusPayload;
  busy: boolean;
  runAction: RunAction;
  preflightBlockerIds?: Set<string> | null;
};

export function WhatsAppPanel({
  status,
  busy,
  runAction,
  preflightBlockerIds,
}: WhatsAppPanelProps) {
  const wa = status.channels.whatsapp;
  const { confirm, dialogProps } = useConfirm();

  async function handleRemoveLegacyCredentials(): Promise<void> {
    const ok = await confirm({
      title: "Remove saved WhatsApp credentials?",
      description:
        "This removes legacy Meta Cloud API credentials. Hosted WhatsApp delivery remains unavailable.",
      confirmLabel: "Remove credentials",
      variant: "danger",
    });
    if (!ok) {
      return;
    }

    await runAction("/api/channels/whatsapp", {
      label: getChannelActionLabel("whatsapp", "disconnect"),
      method: "DELETE",
    });
  }

  return (
    <ChannelCardFrame
      channel="whatsapp"
      configured={false}
      channelClassName="channel-whatsapp"
      title="WhatsApp (unavailable)"
      summary="Hosted transport unavailable"
      pill={{ label: "unavailable", variant: "warn" }}
      errors={wa.mode === "unsupported" ? [] : [wa.lastError]}
      connectability={wa.connectability}
      suppressedIds={preflightBlockerIds}
    >
      <div className="channel-connected-view">
        <p className="muted-copy">
          Meta Cloud API webhooks do not match OpenClaw&apos;s linked-device
          WhatsApp transport. Use local OpenClaw for WhatsApp until a hosted
          transport is implemented.
        </p>
        {wa.configured ? (
          <>
            <p className="muted-copy">
              Legacy Meta credentials are still saved but cannot deliver
              messages from this hosted deployment.
            </p>
            <div className="inline-actions">
              <button
                className="button ghost"
                disabled={busy}
                onClick={() => void handleRemoveLegacyCredentials()}
              >
                Remove saved credentials
              </button>
            </div>
          </>
        ) : null}
      </div>
      <ConfirmDialog {...dialogProps} />
    </ChannelCardFrame>
  );
}
