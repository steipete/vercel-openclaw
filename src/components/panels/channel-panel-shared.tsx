"use client";

import type { ReactNode } from "react";
import { ChannelPill } from "@/components/ui/badge";
import { ConnectabilityNotice } from "@/components/panels/connectability-notice";
import type { ChannelConnectability } from "@/shared/channel-connectability";
import type { PortCheck } from "@/app/api/admin/sandbox-diag/route";

export type SupportedChannelName = "slack" | "telegram" | "discord" | "whatsapp";

export type ChannelActionKind = "connect" | "update" | "disconnect";

const CHANNEL_DISPLAY_NAMES: Record<SupportedChannelName, string> = {
  slack: "Slack",
  telegram: "Telegram",
  discord: "Discord (cleanup only)",
  whatsapp: "WhatsApp (cleanup only)",
};

export function getChannelActionLabel(
  channel: SupportedChannelName,
  kind: ChannelActionKind,
): string {
  const name = CHANNEL_DISPLAY_NAMES[channel];
  switch (kind) {
    case "connect":
      return `Connect ${name}`;
    case "update":
      return `Update ${name} credentials`;
    case "disconnect":
      return `Disconnect ${name}`;
  }
}

export type ChannelPillModel = {
  label: string;
  variant: "good" | "bad" | "idle" | "warn";
};

export function ChannelCardFrame({
  channel,
  configured,
  channelClassName,
  title,
  summary,
  pill,
  errors = [],
  connectability,
  suppressedIds,
  children,
}: {
  channel: SupportedChannelName;
  configured: boolean;
  channelClassName: string;
  title: string;
  summary: string;
  pill: ChannelPillModel;
  errors?: Array<string | null | undefined>;
  connectability: ChannelConnectability;
  suppressedIds?: ReadonlySet<string> | null;
  children: ReactNode;
}) {
  const visibleErrors = errors.filter(
    (value): value is string => Boolean(value && value.trim()),
  );
  return (
    <section
      className={`channel-card ${channelClassName}`}
      data-channel={channel}
      data-configured={String(configured)}
      data-can-connect={String(connectability.canConnect)}
      data-channel-pill={pill.label}
      data-connectability-status={connectability.status}
      data-connectability-issue-ids={connectability.issues
        .map((issue) => issue.id)
        .join(",")}
      data-visible-error-count={String(visibleErrors.length)}
    >
      <div className="channel-head">
        <div>
          <h3>{title}</h3>
          <p className="muted-copy">{summary}</p>
        </div>
        <ChannelPill variant={pill.variant}>{pill.label}</ChannelPill>
      </div>

      {visibleErrors.map((message) => (
        <p key={message} className="error-banner">
          {message}
        </p>
      ))}
      <ConnectabilityNotice
        connectability={connectability}
        suppressedIds={suppressedIds}
      />
      {children}
    </section>
  );
}

export function ChannelInfoRow({
  label,
  children,
  action,
}: {
  label: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="channel-detail-row">
      <span className="field-label">{label}</span>
      {children}
      {action}
    </div>
  );
}

export function ChannelCopyValue({
  label,
  value,
  copied,
  onCopy,
  disabled = false,
  emptyLabel = "—",
}: {
  label: string;
  value: string | null | undefined;
  copied: boolean;
  onCopy: () => void;
  disabled?: boolean;
  emptyLabel?: string;
}) {
  return (
    <ChannelInfoRow label={label}>
      <div className="channel-copy-row">
        <code className="inline-code channel-copy-code">
          {value ?? emptyLabel}
        </code>
        <button
          type="button"
          className="button ghost channel-copy-btn"
          onClick={onCopy}
          disabled={disabled || !value}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </ChannelInfoRow>
  );
}

export function ChannelTextField({
  label,
  value,
  onChange,
  placeholder,
  help,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  help?: ReactNode;
}) {
  return (
    <div className="stack">
      <span className="field-label">{label}</span>
      {help ? <p className="muted-copy">{help}</p> : null}
      <input
        className="text-input"
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        data-1p-ignore
        data-lpignore="true"
        data-form-type="other"
      />
    </div>
  );
}

export function ChannelSecretField({
  label,
  value,
  onChange,
  placeholder,
  shown,
  onToggleShown,
  help,
  validationMessage,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  shown: boolean;
  onToggleShown: () => void;
  help?: ReactNode;
  validationMessage?: string | null;
}) {
  return (
    <div className="stack">
      <span className="field-label">{label}</span>
      {help ? <p className="muted-copy">{help}</p> : null}
      <div className="channel-token-row">
        <input
          className="text-input"
          type={shown ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
        />
        <button
          type="button"
          className="button ghost channel-toggle-btn"
          onClick={onToggleShown}
        >
          {shown ? "Hide" : "Show"}
        </button>
      </div>
      {validationMessage ? (
        <p className="channel-validation-error">{validationMessage}</p>
      ) : null}
    </div>
  );
}

const PORT_STATUS_DOTS: Record<PortCheck["status"], { color: string; label: string }> = {
  ok: { color: "var(--success)", label: "Ready" },
  warn: { color: "var(--warning)", label: "Starting" },
  fail: { color: "var(--error)", label: "Down" },
  unchecked: { color: "var(--foreground-subtle)", label: "Unknown" },
};

export function PortStatusRow({ port }: { port: PortCheck | null | undefined }) {
  if (!port) return null;
  const dot = PORT_STATUS_DOTS[port.status];
  return (
    <div className="port-status-row" data-port-status={port.status}>
      <div className="port-status-header">
        <span
          className="port-status-dot"
          style={{ background: dot.color }}
          aria-label={dot.label}
        />
        <span className="field-label">
          Port {port.port}
        </span>
        <span className="port-status-message">
          {port.message}
        </span>
      </div>
      {port.tip ? (
        <p className="port-status-tip">{port.tip}</p>
      ) : null}
    </div>
  );
}
