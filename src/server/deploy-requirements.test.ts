import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  getWebhookBypassRequirement,
  getWebhookBypassStatusMessage,
} from "@/server/deploy-requirements";

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  resetEnv();
});

test("bypass is not required in sign-in-with-vercel mode", () => {
  process.env.VERCEL_AUTH_MODE = "sign-in-with-vercel";
  delete process.env.VERCEL;
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  const requirement = getWebhookBypassRequirement();
  assert.deepEqual(requirement, {
    configured: false,
    protectionDetected: false,
    recommendation: "recommended",
    reason: "sign-in-with-vercel",
  });
  assert.equal(
    getWebhookBypassStatusMessage(requirement),
    "Protection bypass is not configured. That is fine only when Deployment Protection is disabled; otherwise third-party webhooks may never reach the app.",
  );
});

test("bypass recommendation is none in admin-secret mode", () => {
  delete process.env.VERCEL_AUTH_MODE;
  delete process.env.VERCEL;
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  const requirement = getWebhookBypassRequirement();
  assert.deepEqual(requirement, {
    configured: false,
    protectionDetected: false,
    recommendation: "none",
    reason: "admin-secret",
  });
  assert.equal(
    getWebhookBypassStatusMessage(requirement),
    "Protection bypass is not configured. That is fine only when Deployment Protection is disabled; otherwise third-party webhooks may never reach the app.",
  );
});

test("bypass recommendation is none on Vercel in admin-secret mode", () => {
  delete process.env.VERCEL_AUTH_MODE;
  process.env.VERCEL = "1";
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  const requirement = getWebhookBypassRequirement();
  assert.deepEqual(requirement, {
    configured: false,
    protectionDetected: false,
    recommendation: "none",
    reason: "admin-secret",
  });
  assert.equal(
    getWebhookBypassStatusMessage(requirement),
    "Protection bypass is not configured. That is fine only when Deployment Protection is disabled; otherwise third-party webhooks may never reach the app.",
  );
});

test("bypass recommendation is none when secret is already configured", () => {
  delete process.env.VERCEL_AUTH_MODE;
  process.env.VERCEL = "1";
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "secret";

  const requirement = getWebhookBypassRequirement();
  assert.deepEqual(requirement, {
    configured: true,
    protectionDetected: false,
    recommendation: "none",
    reason: "admin-secret",
  });
  assert.equal(
    getWebhookBypassStatusMessage(requirement),
    "Protection bypass is configured for protected deployment webhook flows.",
  );
});

// --- protectionDetected parameter ---

test("bypass is recommended in admin-secret mode when protection is detected", () => {
  delete process.env.VERCEL_AUTH_MODE;
  process.env.VERCEL = "1";
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  const requirement = getWebhookBypassRequirement({ protectionDetected: true });
  assert.deepEqual(requirement, {
    configured: false,
    protectionDetected: true,
    recommendation: "recommended",
    reason: "deployment-protection-detected",
  });
  assert.equal(
    getWebhookBypassStatusMessage(requirement),
    "Deployment Protection is active but bypass is not configured. Channel webhooks (Slack, Telegram) will be blocked.",
  );
});

test("bypass recommendation stays none when protection detected but secret configured", () => {
  delete process.env.VERCEL_AUTH_MODE;
  process.env.VERCEL = "1";
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "secret";

  const requirement = getWebhookBypassRequirement({ protectionDetected: true });
  assert.deepEqual(requirement, {
    configured: true,
    protectionDetected: true,
    recommendation: "none",
    reason: "deployment-protection-detected",
  });
  assert.equal(
    getWebhookBypassStatusMessage(requirement),
    "Protection bypass is configured for protected deployment webhook flows.",
  );
});
