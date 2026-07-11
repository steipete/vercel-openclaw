import { getAuthMode } from "@/server/env";
import { getProtectionBypassSecret } from "@/server/public-url";
import { HOSTED_DELIVERY_CHANNELS_LABEL } from "@/shared/channels";

export type WebhookBypassRequirementReason =
  | "admin-secret"
  | "sign-in-with-vercel"
  | "deployment-protection-detected";

export type WebhookBypassRequirement = {
  configured: boolean;
  protectionDetected: boolean;
  recommendation: "none" | "recommended";
  reason: WebhookBypassRequirementReason;
};

export function getWebhookBypassRequirement(opts?: {
  protectionDetected?: boolean;
}): WebhookBypassRequirement {
  const configured = Boolean(getProtectionBypassSecret());
  const authMode = getAuthMode();
  const protectionDetected = opts?.protectionDetected ?? false;

  // Webhook bypass is diagnostic-only across all auth modes. If
  // VERCEL_AUTOMATION_BYPASS_SECRET is set, it is applied opportunistically
  // to webhook URLs.
  //
  // sign-in-with-vercel implies Deployment Protection is likely active,
  // so the bypass is recommended (warn) for hosted channel webhooks.
  //
  // When the runtime self-probe detects protection is actually active
  // (regardless of auth mode), the bypass is also recommended. This
  // covers admin-secret deployments that have protection enabled.
  //
  // Still non-blocking at the requirement level — operators can disable
  // Deployment Protection instead. The hard block lives in
  // channel connectability when protection is confirmed active.
  const reason: WebhookBypassRequirementReason = protectionDetected
    ? "deployment-protection-detected"
    : authMode === "admin-secret"
      ? "admin-secret"
      : "sign-in-with-vercel";

  return {
    configured,
    protectionDetected,
    recommendation:
      !configured && (authMode === "sign-in-with-vercel" || protectionDetected)
        ? "recommended"
        : "none",
    reason,
  };
}

export function getWebhookBypassStatusMessage(
  input: WebhookBypassRequirement,
): string {
  if (input.configured) {
    return "Protection bypass is configured for protected deployment webhook flows.";
  }

  if (input.protectionDetected) {
    return `Deployment Protection is active but bypass is not configured. Channel webhooks (${HOSTED_DELIVERY_CHANNELS_LABEL}) will be blocked.`;
  }

  return "Protection bypass is not configured. That is fine only when Deployment Protection is disabled; otherwise third-party webhooks may never reach the app.";
}
