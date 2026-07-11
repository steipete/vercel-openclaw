import { useEffect, useRef, useState } from "react";
import {
  buildJsonRouteErrorMessage,
  type JsonRouteErrorPayload,
} from "@/components/api-route-errors";
import type {
  StatusPayload,
  RunAction,
  RequestJson,
} from "@/components/admin-types";
import { TelegramPanel } from "@/components/panels/telegram-panel";
import { SlackPanel } from "@/components/panels/slack-panel";
import { WhatsAppPanel } from "@/components/panels/whatsapp-panel";
import { DiscordPanel } from "@/components/panels/discord-panel";
import type {
  LaunchVerificationPayload,
  LaunchVerificationPhase,
  ChannelReadiness,
} from "@/shared/launch-verification";
import type { SandboxDiagPayload } from "@/app/api/admin/sandbox-diag/route";
import {
  HOSTED_FEATURE_SUPPORT_MATRIX,
  type HostedFeatureSupportEntry,
  type HostedFeatureSupportStatus,
} from "@/shared/hosted-feature-support";
import { HOSTED_DELIVERY_CHANNELS_LABEL } from "@/shared/channels";

type PreflightCheck = {
  id: string;
  status: "pass" | "warn" | "fail";
  message: string;
};

type PreflightAction = {
  id: string;
  status: "required" | "recommended";
  message: string;
  remediation: string;
  env: string[];
};

type PreflightData = {
  ok: boolean;
  checks: PreflightCheck[];
  actions: PreflightAction[];
  deploymentProtectionDetected?: boolean;
  webhookBypassEnabled?: boolean;
};

export type PreflightSummary = {
  ok: boolean | null;
  blockerIds: string[];
  blockerMessages: string[];
  requiredActionIds: string[];
  requiredRemediations: string[];
};

type PreflightResponsePayload = PreflightData & JsonRouteErrorPayload;

type ChannelsPanelProps = {
  active: boolean;
  status: StatusPayload;
  busy: boolean;
  runAction: RunAction;
  requestJson: RequestJson;
  refresh: () => Promise<void>;
};

const FEATURE_STATUS_LABELS: Record<HostedFeatureSupportStatus, string> = {
  supported: "Supported",
  experimental: "Experimental",
  "bundled-only": "Bundled only",
  "upstream-only": "Upstream only",
  "not-supported": "Not supported",
};

function FeatureSupportBoundary({ entries }: { entries: HostedFeatureSupportEntry[] }) {
  const visibleEntries = entries.filter((entry) =>
    [
      "channel-slack",
      "channel-telegram",
      "channel-discord",
      "channel-whatsapp",
      "channels-upstream-rest",
      "companion-devices",
      "voice-canvas",
      "plugins-skills-bundled",
    ].includes(entry.id),
  );

  return (
    <section
      className="hosted-support-boundary"
      aria-label="Hosted OpenClaw support boundary"
      data-feature-support-docs={HOSTED_FEATURE_SUPPORT_MATRIX.docsPath}
    >
      <div className="hosted-support-boundary-head">
        <div>
          <h3>Hosted OpenClaw support</h3>
          <p className="muted-copy">
            This Vercel deployment supports the wrapper-verified surface below; upstream-only features require local OpenClaw until the hosted path has setup, persistence, wake, and verification coverage.
          </p>
        </div>
        <a
          className="button ghost"
          href={`https://github.com/vercel-labs/vercel-openclaw/blob/main/${HOSTED_FEATURE_SUPPORT_MATRIX.docsPath}`}
        >
          Matrix
        </a>
      </div>
      <div className="hosted-support-grid">
        {visibleEntries.map((entry) => (
          <div
            key={entry.id}
            className="hosted-support-row"
            data-feature-id={entry.id}
            data-hosted-status={entry.hostedStatus}
          >
            <div>
              <span className="hosted-support-feature">{entry.feature}</span>
              <span className="hosted-support-owner">{entry.owningRepo}</span>
            </div>
            <span className={`hosted-support-pill ${entry.hostedStatus}`}>
              {FEATURE_STATUS_LABELS[entry.hostedStatus]}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function getPreflightBlockerIds(
  preflight: Pick<PreflightData, "ok" | "checks"> | null,
): Set<string> | null {
  if (!preflight || preflight.ok) return null;
  return new Set(
    preflight.checks
      .filter((c) => c.status === "fail")
      .map((c) => c.id),
  );
}

export function summarizePreflight(
  preflight: PreflightData | null,
): PreflightSummary {
  const failedChecks =
    preflight?.checks.filter((check) => check.status === "fail") ?? [];
  const requiredActions =
    preflight?.actions.filter((action) => action.status === "required") ?? [];

  return {
    ok: preflight ? preflight.ok : null,
    blockerIds: failedChecks.map((check) => check.id),
    blockerMessages: failedChecks.map((check) => check.message),
    requiredActionIds: requiredActions.map((action) => action.id),
    requiredRemediations: requiredActions.map((action) => action.remediation),
  };
}

export function formatPreflightFetchError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Failed to load deployment preflight. Refresh the panel or open /api/admin/preflight.";
}

async function loadPreflightData(): Promise<PreflightData> {
  const res = await fetch("/api/admin/preflight", {
    cache: "no-store",
    headers: { accept: "application/json" },
  });

  const payload = (await res.json().catch(() => null)) as
    | PreflightResponsePayload
    | null;

  if (!res.ok) {
    throw new Error(
      buildJsonRouteErrorMessage(
        payload,
        `Failed to load deployment preflight: HTTP ${res.status}`,
      ),
    );
  }

  if (
    !payload ||
    typeof payload.ok !== "boolean" ||
    !Array.isArray(payload.checks) ||
    !Array.isArray(payload.actions)
  ) {
    throw new Error(
      "Failed to load deployment preflight: invalid JSON payload.",
    );
  }

  return payload;
}

/* ── Launch verification helpers (kept for exported API surface) ── */

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/* ── Verification view-model ── */

export type VerificationViewModel = {
  badgeText: string;
  badgeClassName: string;
  summaryText: string;
  primaryActionLabel: "Verify" | "Re-verify" | "Verifying\u2026";
  primaryActionClassName: string;
  showQuickCheck: boolean;
};

export function getVerificationViewModel({
  readiness,
  verifyResult,
  verifyRunning,
  totalMs,
}: {
  readiness: Pick<ChannelReadiness, "ready" | "verifiedAt"> | null;
  verifyResult: Pick<LaunchVerificationPayload, "ok"> | null;
  verifyRunning: boolean;
  totalMs: number;
}): VerificationViewModel {
  const isVerified = readiness?.ready === true;
  const isFailed = verifyResult?.ok === false;

  if (verifyRunning) {
    return {
      badgeText: "Verifying\u2026",
      badgeClassName: "status-badge restoring",
      summaryText: "Verification in progress",
      primaryActionLabel: "Verifying\u2026",
      primaryActionClassName: "button primary",
      showQuickCheck: false,
    };
  }

  if (isFailed) {
    return {
      badgeText: "Failed",
      badgeClassName: "status-badge error",
      summaryText: "Last verification failed",
      primaryActionLabel: isVerified ? "Re-verify" : "Verify",
      primaryActionClassName: "button primary",
      showQuickCheck: !isVerified,
    };
  }

  if (isVerified) {
    const durationSuffix = verifyResult ? ` in ${formatDuration(totalMs)}` : "";
    return {
      badgeText: "Verified",
      badgeClassName: "status-badge running",
      summaryText: readiness?.verifiedAt
        ? `Verified ${formatTimestamp(readiness.verifiedAt)}${durationSuffix}`
        : `Verified${durationSuffix}`,
      primaryActionLabel: "Re-verify",
      primaryActionClassName: "button ghost",
      showQuickCheck: false,
    };
  }

  return {
    badgeText: "",
    badgeClassName: "",
    summaryText: "Not yet verified",
    primaryActionLabel: "Verify",
    primaryActionClassName: "button primary",
    showQuickCheck: true,
  };
}

/* ── Structured verification telemetry ── */

type VerificationRunMode = "safe" | "destructive";

type ChannelsPanelEvent =
  | {
      event: "channels.preflight.refresh";
      source: "channels-panel";
      ts: string;
      ok: boolean | null;
      blockerIds: string[];
      requiredActionIds: string[];
    }
  | {
      event: "channels.preflight.error";
      source: "channels-panel";
      ts: string;
      error: string;
    }
  | {
      event: "channels.readiness.refresh";
      source: "channels-panel";
      ts: string;
      ok: boolean;
      verifiedAt: string | null;
    }
  | {
      event: "channels.verify.start";
      source: "channels-panel";
      ts: string;
      requestId: string;
      mode: VerificationRunMode;
    }
  | {
      event: "channels.verify.phase";
      source: "channels-panel";
      ts: string;
      requestId: string;
      mode: VerificationRunMode;
      phaseId: string;
      phaseStatus: LaunchVerificationPhase["status"];
      durationMs: number;
      message: string;
      error?: string;
    }
  | {
      event: "channels.verify.result";
      source: "channels-panel";
      ts: string;
      requestId: string;
      mode: VerificationRunMode;
      ok: boolean;
      totalMs: number;
      verifiedAt: string | null;
    }
  | {
      event: "channels.verify.error";
      source: "channels-panel";
      ts: string;
      requestId: string;
      mode: VerificationRunMode;
      error: string;
    };

export function createVerificationRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `verify-${crypto.randomUUID()}`;
  }
  return `verify-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

type ChannelsPanelEventInput = {
  [K in ChannelsPanelEvent["event"]]: Omit<
    Extract<ChannelsPanelEvent, { event: K }>,
    "source" | "ts"
  >;
}[ChannelsPanelEvent["event"]];

export function emitChannelsPanelEvent(
  event: ChannelsPanelEventInput,
): void {
  const payload = {
    source: "channels-panel" as const,
    ts: new Date().toISOString(),
    ...event,
  };

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("openclaw:channels-panel", { detail: payload }),
    );
  }

  const serialized = JSON.stringify(payload);
  if (payload.event.endsWith(".error")) {
    console.error(`[openclaw.channels] ${serialized}`);
    return;
  }
  console.info(`[openclaw.channels] ${serialized}`);
}

export function formatLaunchVerificationFetchError(
  payload: { error?: { message?: string }; message?: string } | null,
  status: number,
): string {
  const explicit = payload?.error?.message ?? payload?.message;
  if (explicit && explicit.trim().length > 0) {
    return explicit;
  }
  return `Verification request failed (HTTP ${status}). Refresh the panel or open /api/admin/launch-verify.`;
}

export function getVerificationSurfaceState(args: {
  readiness: ChannelReadiness | null;
  verifyResult: LaunchVerificationPayload | null;
  verifyRunning: boolean;
}): "idle" | "running" | "verified" | "failed" {
  if (args.verifyRunning) return "running";
  if (args.verifyResult) return args.verifyResult.ok ? "verified" : "failed";
  if (args.readiness?.ready) return "verified";
  return "idle";
}

/* ── Main component ── */

export function ChannelsPanel({
  active,
  status,
  busy,
  runAction,
  requestJson,
  refresh,
}: ChannelsPanelProps) {
  /* Preflight state */
  const [preflight, setPreflight] = useState<PreflightData | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [preflightLoadedAt, setPreflightLoadedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const preflightRequestIdRef = useRef(0);
  const mountedRef = useRef(true);

  /* Sandbox diagnostics state */
  const [sandboxDiag, setSandboxDiag] = useState<SandboxDiagPayload | null>(null);

  const preflightSummary = summarizePreflight(preflight);
  const preflightBlockerIds =
    preflightSummary.ok === false
      ? new Set(preflightSummary.blockerIds)
      : null;
  const featureSupport = status.featureSupport ?? HOSTED_FEATURE_SUPPORT_MATRIX;

  /* ── Sandbox diagnostics fetching ── */

  async function refreshSandboxDiag(): Promise<void> {
    if (status.status !== "running") {
      setSandboxDiag(null);
      return;
    }
    try {
      const res = await fetch("/api/admin/sandbox-diag", {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (res.ok) {
        const data = (await res.json()) as SandboxDiagPayload;
        if (mountedRef.current) {
          setSandboxDiag(data);
        }
      }
    } catch {
      // Best effort — diag is supplementary, not critical
    }
  }

  /* ── Preflight fetching ── */

  async function refreshPreflight(): Promise<void> {
    const requestId = preflightRequestIdRef.current + 1;
    preflightRequestIdRef.current = requestId;

    try {
      const nextPreflight = await loadPreflightData();
      if (!mountedRef.current || requestId !== preflightRequestIdRef.current) {
        return;
      }

      const summary = summarizePreflight(nextPreflight);
      setPreflight(nextPreflight);
      setPreflightError(null);
      setPreflightLoadedAt(Date.now());
      emitChannelsPanelEvent({
        event: "channels.preflight.refresh",
        ok: summary.ok,
        blockerIds: summary.blockerIds,
        requiredActionIds: summary.requiredActionIds,
      });
    } catch (error) {
      if (!mountedRef.current || requestId !== preflightRequestIdRef.current) {
        return;
      }

      const message = formatPreflightFetchError(error);
      setPreflightError(message);
      emitChannelsPanelEvent({
        event: "channels.preflight.error",
        error: message,
      });
    }
  }

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => {
      void refreshPreflight();
      void refreshSandboxDiag();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [active, status.status]);

  return (
    <article
      className="panel-card full-span"
      data-preflight-ok={
        preflightSummary.ok === null ? "unknown" : String(preflightSummary.ok)
      }
      data-preflight-blocker-ids={preflightSummary.blockerIds.join(",")}
      data-preflight-required-action-ids={preflightSummary.requiredActionIds.join(",")}
    >
      <div className="panel-head">
        <div>
          <h2>External entry points</h2>
        </div>
        <button
          className="button ghost"
          disabled={busy || refreshing}
          onClick={() => {
            setRefreshing(true);
            void Promise.all([refresh(), refreshPreflight(), refreshSandboxDiag()])
              .finally(() => setRefreshing(false));
          }}
        >
          {refreshing ? "Refreshing\u2026" : "Refresh"}
        </button>
      </div>

      {/* ── Preflight error ── */}
      {preflightError ? (
        <div className="error-banner" style={{ marginTop: 16, marginBottom: 16 }} aria-live="polite">
          <p style={{ margin: 0, fontWeight: 500 }}>{preflightError}</p>
          <p className="muted-copy" style={{ margin: "4px 0 0" }}>
            Channel cards keep the last known preflight snapshot until refresh succeeds.
          </p>
        </div>
      ) : null}

      {/* ── Deployment blockers (consolidated) ── */}
      {(preflight?.deploymentProtectionDetected && !preflight?.webhookBypassEnabled) || preflightSummary.ok === false ? (
        <div
          className="error-banner"
          style={{ marginTop: 16, marginBottom: 16 }}
          aria-live="polite"
          data-preflight-banner="deployment-blockers"
        >
          <p style={{ margin: 0, fontWeight: 500 }}>
            Resolve deployment blockers before connecting channels.
          </p>

          {preflight?.deploymentProtectionDetected && !preflight?.webhookBypassEnabled ? (
            <p className="muted-copy" style={{ margin: "4px 0 0" }}>
              Vercel Deployment Protection is blocking webhook delivery — {HOSTED_DELIVERY_CHANNELS_LABEL} webhooks cannot reach this deployment.
            </p>
          ) : null}

          {preflightSummary.ok === false
            ? preflightSummary.blockerMessages
                .filter((msg) => !msg.toLowerCase().includes("deployment protection"))
                .map((message) => (
                  <p key={message} className="muted-copy" style={{ margin: "4px 0 0" }}>
                    {message}
                  </p>
                ))
            : null}

          <details className="channel-details" style={{ marginTop: 10 }}>
            <summary>How to fix</summary>
            <div className="channel-details-body">
              {preflight?.deploymentProtectionDetected && !preflight?.webhookBypassEnabled ? (
                <ol style={{ margin: 0, paddingLeft: 20 }}>
                  <li style={{ fontSize: 13, color: "var(--foreground-subtle)", lineHeight: 1.5 }}>In the Vercel Dashboard, open your project and go to <strong>Settings &gt; Deployment Protection</strong>.</li>
                  <li style={{ fontSize: 13, color: "var(--foreground-subtle)", lineHeight: 1.5 }}>Under <strong>Protection Bypass for Automation</strong>, enable it and copy the generated secret.</li>
                  <li style={{ fontSize: 13, color: "var(--foreground-subtle)", lineHeight: 1.5 }}>Add <code>VERCEL_AUTOMATION_BYPASS_SECRET</code> as an environment variable with the copied value.</li>
                  <li style={{ fontSize: 13, color: "var(--foreground-subtle)", lineHeight: 1.5 }}>Redeploy for the change to take effect.</li>
                </ol>
              ) : null}
              {preflightSummary.requiredRemediations.map((remediation) => (
                <p key={remediation} style={{ margin: 0, fontSize: 13, color: "var(--foreground-subtle)", lineHeight: 1.5 }}>
                  {remediation}
                </p>
              ))}
            </div>
          </details>

          {preflightLoadedAt ? (
            <p className="muted-copy" style={{ margin: "8px 0 0" }}>
              Checked {new Date(preflightLoadedAt).toLocaleTimeString()}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="channel-grid">
        <SlackPanel
          status={status}
          busy={busy}
          runAction={runAction}
          requestJson={requestJson}
          preflightBlockerIds={preflightBlockerIds}
          portCheck={sandboxDiag?.ports.find((p) => p.label === "Slack") ?? null}
        />
        <TelegramPanel
          status={status}
          busy={busy}
          runAction={runAction}
          requestJson={requestJson}
          preflightBlockerIds={preflightBlockerIds}
          portCheck={sandboxDiag?.ports.find((p) => p.label === "Telegram") ?? null}
        />
        <DiscordPanel
          status={status}
          busy={busy}
          runAction={runAction}
          requestJson={requestJson}
          preflightBlockerIds={preflightBlockerIds}
        />
        <WhatsAppPanel
          status={status}
          busy={busy}
          runAction={runAction}
          preflightBlockerIds={preflightBlockerIds}
        />
      </div>

      <FeatureSupportBoundary entries={featureSupport.entries} />
    </article>
  );
}
