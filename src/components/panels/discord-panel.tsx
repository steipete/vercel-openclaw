import { ConfirmDialog, useConfirm } from "@/components/ui/confirm-dialog";
import type {
  RequestJson,
  RunAction,
  StatusPayload,
} from "@/components/admin-types";
import {
  ChannelCardFrame,
  ChannelCopyValue,
  ChannelInfoRow,
  type ChannelPillModel,
} from "@/components/panels/channel-panel-shared";

type DiscordPanelProps = {
  status: StatusPayload;
  busy: boolean;
  runAction: RunAction;
  requestJson: RequestJson;
  preflightBlockerIds?: Set<string> | null;
};

function getDiscordPill(configured: boolean): ChannelPillModel {
  return configured
    ? { label: "cleanup only", variant: "warn" }
    : { label: "unsupported", variant: "idle" };
}

export function DiscordPanel({
  status,
  busy,
  runAction,
  preflightBlockerIds,
}: DiscordPanelProps) {
  const { confirm, dialogProps } = useConfirm();
  const discord = status.channels.discord;

  async function handleDisconnect(): Promise<void> {
    const ok = await confirm({
      title: "Remove legacy Discord configuration?",
      description:
        "This detaches the saved interactions endpoint, then removes the retained hosted credentials.",
      confirmLabel: "Remove legacy config",
      variant: "danger",
    });
    if (!ok) return;

    await runAction("/api/channels/discord", {
      label: "Remove legacy Discord configuration",
      method: "DELETE",
    });
  }

  return (
    <ChannelCardFrame
      channel="discord"
      configured={discord.configured}
      channelClassName="channel-discord"
      title="Discord (not supported)"
      summary={
        discord.configured
          ? "Legacy hosted configuration retained for cleanup"
          : "Use local or upstream OpenClaw"
      }
      pill={getDiscordPill(discord.configured)}
      errors={[discord.endpointError]}
      connectability={discord.connectability}
      suppressedIds={preflightBlockerIds}
    >
      <p className="muted-copy">
        Hosted Vercel deployments cannot replace OpenClaw&apos;s persistent
        Discord Gateway transport. Setup, command registration, and delivery
        remain disabled.
      </p>

      {discord.configured ? (
        <div className="channel-connected-view">
          <ChannelInfoRow label="Legacy application">
            <code className="inline-code">
              {discord.appName ?? discord.applicationId ?? "Unknown"}
            </code>
          </ChannelInfoRow>
          {discord.currentEndpointUrl ? (
            <ChannelCopyValue
              label="Legacy interactions endpoint"
              value={discord.currentEndpointUrl}
              copied={false}
              onCopy={() => {
                void navigator.clipboard.writeText(
                  discord.currentEndpointUrl ?? "",
                );
              }}
            />
          ) : null}
          <div className="inline-actions">
            <button
              className="button ghost"
              disabled={busy}
              onClick={() => void handleDisconnect()}
            >
              Remove legacy config
            </button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog {...dialogProps} />
    </ChannelCardFrame>
  );
}
