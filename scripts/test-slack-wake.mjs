#!/usr/bin/env node

/**
 * Autonomous Slack wake-from-sleep test.
 *
 * Stops the sandbox, sends a synthetic Slack webhook via the
 * channel-secrets endpoint (server-side signs with the configured
 * signing secret), polls until the sandbox wakes up and the message
 * is processed, then reads the channel-forward-diag for a timing
 * breakdown.
 *
 * If Slack is not already configured, the script can auto-configure
 * smoke test channel credentials via PUT /api/admin/channel-secrets and
 * remove them afterward. This keeps local/public tunnel testing realistic
 * without requiring a real Slack app.
 *
 * NOTE: Slack Bolt enforces a hardcoded 5-minute replay protection
 * window against x-slack-request-timestamp. Wakes must complete within
 * that window; WORKFLOW_SANDBOX_READY_TIMEOUT_MS = 120s is well inside.
 *
 * Usage:
 *   node scripts/test-slack-wake.mjs --base-url https://my-app.vercel.app --admin-secret <secret>
 *   node scripts/test-slack-wake.mjs --base-url https://my-app.vercel.app --admin-secret <secret> --timeout 180
 *   node scripts/test-slack-wake.mjs --base-url https://my-app.vercel.app --admin-secret <secret> --json-only
 *   node scripts/test-slack-wake.mjs --base-url https://my-app.vercel.app --admin-secret <secret> --protection-bypass <secret>
 *
 * Environment:
 *   ADMIN_SECRET                    — admin bearer token (overridden by --admin-secret)
 *   SMOKE_AUTH_COOKIE               — auth cookie for sign-in-with-vercel mode (overridden by --auth-cookie)
 *   VERCEL_AUTOMATION_BYPASS_SECRET — deployment protection bypass (overridden by --protection-bypass)
 *
 * Exit codes:
 *   0 — wake-from-sleep succeeded, message was processed
 *   1 — wake-from-sleep failed (message lost, timeout, or error)
 *   2 — bad arguments
 */

import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    "base-url": { type: "string" },
    "admin-secret": { type: "string" },
    "auth-cookie": { type: "string" },
    "protection-bypass": { type: "string" },
    timeout: { type: "string", default: "180" },
    "request-timeout": { type: "string", default: "30" },
    "json-only": { type: "boolean", default: false },
    "skip-cleanup": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  process.stderr.write(`test-slack-wake — autonomous Slack wake-from-sleep test

USAGE
  node scripts/test-slack-wake.mjs --base-url <url> --admin-secret <secret> [options]

OPTIONS
  --base-url           (required) Deployed app URL
  --admin-secret       Admin bearer token (or set ADMIN_SECRET env var)
  --auth-cookie        Auth cookie value (or set SMOKE_AUTH_COOKIE env var)
  --protection-bypass  Deployment protection bypass secret (or set VERCEL_AUTOMATION_BYPASS_SECRET)
  --timeout            Overall timeout in seconds for wake polling (default: 180)
  --request-timeout    Per-request fetch timeout in seconds (default: 30)
  --json-only          Suppress human-readable stderr output; emit only JSON to stdout
  --skip-cleanup       Do not remove test channels after the test
  --help               Show this message

FLOW
  1. Ensure sandbox is running (pre-check)
  2. Configure test channels via PUT /api/admin/channel-secrets
  3. Stop the sandbox via POST /api/admin/stop
  4. Wait for status to become "stopped"
  5. Send a synthetic Slack webhook via POST /api/admin/channel-secrets (server signs)
  6. Poll /api/status until sandbox is "running"
  7. Poll /api/admin/channel-forward-diag for the timing trace
  8. Clean up test channels via DELETE /api/admin/channel-secrets
  9. Report timing breakdown and exit

EXIT CODES
  0 — success (wake + native acceptance confirmed; reply visibility reported separately)
  1 — failure (timeout, message lost, or error)
  2 — bad arguments
`);
  process.exit(0);
}

const baseUrl = values["base-url"]?.trim();
if (!baseUrl) {
  process.stderr.write("error: --base-url is required\n");
  process.exit(2);
}

const adminSecret =
  values["admin-secret"]?.trim() || process.env.ADMIN_SECRET?.trim() || "";
const authCookie =
  values["auth-cookie"]?.trim() || process.env.SMOKE_AUTH_COOKIE?.trim() || "";
const bypass =
  values["protection-bypass"]?.trim() ||
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() ||
  "";

if (!adminSecret && !authCookie) {
  process.stderr.write(
    "error: --admin-secret or --auth-cookie is required (or set ADMIN_SECRET / SMOKE_AUTH_COOKIE env vars)\n",
  );
  process.exit(2);
}

const timeoutSec = Number.parseInt(values.timeout, 10);
if (!Number.isFinite(timeoutSec) || timeoutSec < 1) {
  process.stderr.write("error: --timeout must be a positive integer\n");
  process.exit(2);
}
const timeoutMs = timeoutSec * 1000;

const requestTimeoutMs =
  Number.parseInt(values["request-timeout"], 10) * 1000;
const jsonOnly = values["json-only"];
const skipCleanup = values["skip-cleanup"];
const SMOKE_CONFIG_RETRY_WINDOW_MS = 6_000;
const SMOKE_CONFIG_RETRY_MAX_DELAY_MS = 1_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  if (!jsonOnly) {
    process.stderr.write(`[slack-wake] ${msg}\n`);
  }
}

function buildUrl(path) {
  const u = new URL(path, baseUrl);
  if (bypass) {
    u.searchParams.set("x-vercel-protection-bypass", bypass);
  }
  return u.href;
}

function buildHeaders(mutation = false) {
  const headers = {
    "content-type": "application/json",
  };
  if (mutation) {
    headers["x-requested-with"] = "XMLHttpRequest";
    headers["origin"] = new URL(baseUrl).origin;
  }
  if (adminSecret) {
    headers["authorization"] = `Bearer ${adminSecret}`;
  }
  if (authCookie) {
    headers["cookie"] = authCookie;
  }
  return headers;
}

async function fetchJson(path, opts = {}) {
  const u = buildUrl(path);
  const timeout = opts.timeoutMs ?? requestTimeoutMs;
  const response = await fetch(u, {
    method: opts.method ?? "GET",
    headers: opts.headers ?? buildHeaders(opts.mutation ?? false),
    body: opts.body ?? undefined,
    signal: AbortSignal.timeout(timeout),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, ok: response.ok, body };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildSlackPayload() {
  const rand = Math.floor(Math.random() * 1_000_000_000);
  const tsSeconds = Math.floor(Date.now() / 1000);
  return JSON.stringify({
    type: "event_callback",
    event_id: `Ev_SMOKE_${rand}`,
    event_time: tsSeconds,
    team_id: "T_SMOKE",
    api_app_id: "A_SMOKE",
    event: {
      type: "message",
      channel: "C_SMOKE",
      channel_type: "channel",
      user: "U_SMOKE",
      text: "/ask smoke-test: reply with exactly smoke-ok",
      ts: `${tsSeconds}.${String(rand).padStart(6, "0")}`,
      event_ts: `${tsSeconds}.${String(rand).padStart(6, "0")}`,
    },
  });
}

async function configureTestChannels() {
  log("phase: configuring smoke test channels...");
  const ownerId = randomUUID();
  let lastError = null;
  let retryDeadline = null;
  let delayMs = 100;
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      const res = await fetchJson("/api/admin/channel-secrets", {
        method: "PUT",
        mutation: true,
        body: JSON.stringify({ channels: ["slack"], ownerId }),
      });
      if (!res.ok) {
        lastError = new Error(
          `HTTP ${res.status} ${JSON.stringify(res.body)}`,
        );
        if (res.status !== 409 && res.status < 500) break;
      } else {
        const created = res.body?.createdChannels;
        const recovered = res.body?.recoveredChannels;
        const preserved = res.body?.preservedChannels;
        if (
          Array.isArray(created) &&
          Array.isArray(recovered) &&
          Array.isArray(preserved) &&
          (!(created.includes("slack") || recovered.includes("slack")) ||
            typeof res.body?.cleanupToken === "string")
        ) {
          log("smoke test channels configured");
          return res.body;
        }
        lastError = new Error("setup response omitted cleanup ownership");
      }
    } catch (error) {
      lastError = error;
    }
    retryDeadline ??= Date.now() + SMOKE_CONFIG_RETRY_WINDOW_MS;
    if (attempts >= 3 && Date.now() >= retryDeadline) break;
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, SMOKE_CONFIG_RETRY_MAX_DELAY_MS);
  }
  throw new Error(
    `configure test channels failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function cleanupTestChannels(cleanupToken) {
  log("phase: cleaning up smoke test channels...");
  let lastError = null;
  let retryDeadline = null;
  let delayMs = 100;
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      const res = await fetchJson("/api/admin/channel-secrets", {
        method: "DELETE",
        mutation: true,
        body: JSON.stringify({ cleanupToken }),
      });
      if (res.ok) {
        log("smoke test channels removed");
        return;
      }
      lastError = new Error(
        `HTTP ${res.status} ${JSON.stringify(res.body)}`,
      );
      if (res.status !== 409 && res.status < 500) break;
    } catch (error) {
      lastError = error;
    }
    retryDeadline ??= Date.now() + SMOKE_CONFIG_RETRY_WINDOW_MS;
    if (attempts >= 3 && Date.now() >= retryDeadline) break;
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, SMOKE_CONFIG_RETRY_MAX_DELAY_MS);
  }
  throw new Error(
    `cleanup test channels failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

async function ensureRunning() {
  log("phase: ensure sandbox is running (pre-check)...");
  const res = await fetchJson("/api/admin/ensure?wait=1&timeoutMs=240000", {
    method: "POST",
    mutation: true,
    timeoutMs: 250_000,
  });
  if (!res.ok) {
    throw new Error(
      `pre-check ensure failed: HTTP ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  log(`pre-check: sandbox running, status=${res.body?.status}`);
  return res.body;
}

async function ensureSlackConfigured(captureCleanupToken) {
  log("phase: verifying Slack is configured...");
  const res = await fetchJson("/api/channels/summary");
  if (!res.ok) {
    throw new Error(
      `channel summary failed: HTTP ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  const sl = res.body?.slack;
  if (sl?.configured) {
    log(`Slack: configured=${sl.configured} status=${sl.status}`);
    return { configuredByUs: false, summary: res.body };
  }

  log("Slack is not configured; falling back to smoke test channel config");
  const setup = await configureTestChannels();
  if (typeof setup.cleanupToken === "string") {
    // Capture ownership before any later validation can fail so main's finally
    // block can still remove only the smoke config created by this run.
    captureCleanupToken(setup.cleanupToken);
  }

  const retry = await fetchJson("/api/channels/summary");
  if (!retry.ok) {
    throw new Error(
      `channel summary retry failed: HTTP ${retry.status} ${JSON.stringify(retry.body)}`,
    );
  }

  const retrySlack = retry.body?.slack;
  if (!retrySlack?.configured) {
    throw new Error("Slack smoke test channel setup did not produce a configured Slack channel");
  }

  log(`Slack: configured=${retrySlack.configured} status=${retrySlack.status}`);
  return {
    configuredByUs: typeof setup.cleanupToken === "string",
    cleanupToken: setup.cleanupToken ?? null,
    summary: retry.body,
  };
}

async function stopSandbox() {
  log("phase: stopping sandbox...");
  const deadline = Date.now() + 20_000;
  let attempt = 0;
  let delay = 500;

  while (Date.now() < deadline) {
    attempt += 1;
    const res = await fetchJson("/api/admin/stop", {
      method: "POST",
      mutation: true,
    });
    if (res.ok) {
      log(`sandbox stop initiated${attempt > 1 ? ` after retry ${attempt}` : ""}`);
      return res.body;
    }

    const errorCode = res.body?.error;
    const lifecycleLockUnavailable =
      res.status === 500 && errorCode === "INTERNAL_ERROR";

    if (!lifecycleLockUnavailable || Date.now() + delay >= deadline) {
      throw new Error(
        `stop failed: HTTP ${res.status} ${JSON.stringify(res.body)}`,
      );
    }

    log(
      `stop attempt ${attempt} hit lifecycle lock contention; retrying in ${delay}ms`,
    );
    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.5), 2_000);
  }

  throw new Error("stop failed: lifecycle lock contention did not clear within 20s");
}

async function waitForStopped() {
  log("phase: waiting for stopped status...");
  const deadline = Date.now() + 60_000;
  let delay = 1_000;
  while (Date.now() < deadline) {
    await sleep(delay);
    try {
      const res = await fetchJson("/api/status");
      if (res.body?.status === "stopped") {
        log("sandbox is stopped");
        return;
      }
      log(`  status: ${res.body?.status}`);
    } catch {
      // ignore transient errors
    }
    delay = Math.min(delay * 1.3, 5_000);
  }
  throw new Error("sandbox did not reach 'stopped' within 60s");
}

async function sendSlackWebhook() {
  log("phase: sending synthetic Slack webhook while stopped...");
  const payload = buildSlackPayload();
  const res = await fetchJson("/api/admin/channel-secrets", {
    method: "POST",
    mutation: true,
    body: JSON.stringify({ channel: "slack", body: payload }),
  });
  if (!res.ok) {
    throw new Error(
      `send webhook failed: HTTP ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  if (!res.body?.webhookAccepted) {
    if (res.body?.configured === false) {
      throw new Error("Slack channel not configured (configured=false)");
    }
    throw new Error(
      `webhook not sent: ${JSON.stringify(res.body)}`,
    );
  }
  if (typeof res.body?.deliveryId !== "string") {
    throw new Error("webhook response did not include an exact deliveryId");
  }
  log(
    `webhook accepted by host: deliveryId=${res.body.deliveryId} status=${res.body.status}`,
  );
  return res.body;
}

async function waitForRunning() {
  log("phase: polling for sandbox to wake up...");
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  let delay = 3_000;
  while (Date.now() < deadline) {
    await sleep(delay);
    try {
      const res = await fetchJson("/api/status");
      const status = res.body?.status;
      const elapsed = Math.round((Date.now() - t0) / 1000);
      if (status === "running") {
        log(`sandbox woke up after ${elapsed}s`);
        return { wakeMs: Date.now() - t0 };
      }
      log(`  status=${status} elapsed=${elapsed}s`);
    } catch {
      // ignore transient errors
    }

    delay = Math.min(delay * 1.3, 10_000);
  }

  throw new Error(
    `sandbox did not wake up within ${timeoutSec}s — message may be lost`,
  );
}

async function readDiag() {
  log("phase: reading channel-forward-diag...");
  // The workflow may still be writing the diag; poll for a short window
  const deadline = Date.now() + 30_000;
  let delay = 2_000;
  let lastDiag = null;

  while (Date.now() < deadline) {
    await sleep(delay);
    try {
      const res = await fetchJson("/api/admin/channel-forward-diag");
      if (res.ok && res.body && !res.body.error) {
        lastDiag = res.body;
        // If the diag has a completedAt, it's done
        if (res.body.completedAt || res.body.outcome) {
          log(`diag available: outcome=${res.body.outcome}`);
          return res.body;
        }
      }
    } catch {
      // ignore
    }
    delay = Math.min(delay * 1.5, 5_000);
  }

  // Return whatever we got, even if incomplete
  if (lastDiag) {
    log("diag retrieved (may be incomplete)");
    return lastDiag;
  }
  log("no diag data available");
  return null;
}

async function waitForNativeAcceptance(deliveryId) {
  log(`phase: polling exact Slack delivery ${deliveryId}...`);
  const deadline = Date.now() + 60_000;
  let lastState = null;
  while (Date.now() < deadline) {
    const res = await fetchJson("/api/channels/summary");
    const state = res.body?.slack?.lastDeliveryState ?? null;
    if (state?.deliveryId === deliveryId) {
      lastState = state;
      const accepted =
        state.native?.ok === true &&
        state.native?.classification === "accepted";
      if (accepted || state.terminal === true) {
        return {
          accepted,
          state,
          replyObserved: state.reply?.status === "observed",
        };
      }
    }
    await sleep(2_000);
  }
  return { accepted: false, state: lastState, replyObserved: false };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function formatTimingBreakdown(diag) {
  if (!diag) return "  (no diagnostic data available)";

  const lines = [];
  const ms = (v) => (typeof v === "number" ? `${v}ms` : "n/a");

  lines.push(`  outcome:            ${diag.outcome ?? "unknown"}`);
  lines.push(`  channel:            ${diag.channel ?? "unknown"}`);
  lines.push(`  total duration:     ${ms(diag.totalDurationMs)}`);
  lines.push("");
  lines.push("  Boot phase:");
  lines.push(`    boot duration:    ${ms(diag.bootDurationMs)}`);
  lines.push(`    boot status:      ${diag.bootResultStatus ?? "n/a"}`);
  lines.push(`    boot message:     ${diag.bootMessageSent ?? "n/a"}`);
  lines.push("");
  lines.push("  Sandbox readiness:");
  lines.push(`    status:           ${diag.readyMetaStatus ?? "n/a"}`);
  lines.push(`    sandboxId:        ${diag.readyMetaSandboxId ?? "n/a"}`);
  lines.push(`    used boot meta:   ${diag.usedBootMetaDirectly ?? "n/a"}`);
  lines.push("");
  lines.push("  Slack signature headers:");
  lines.push(`    header keys:      ${Array.isArray(diag.slackForwardHeaderKeys) ? diag.slackForwardHeaderKeys.join(",") : "n/a"}`);
  lines.push(`    has signature:    ${diag.slackForwardHasSignature ?? "n/a"}`);
  lines.push(`    has timestamp:    ${diag.slackForwardHasTimestamp ?? "n/a"}`);
  lines.push("");
  lines.push("  Forward:");
  lines.push(`    transport:        ${diag.forwardTransport ?? "n/a"}`);
  lines.push(`    ok:               ${diag.forwardOk ?? "n/a"}`);
  lines.push(`    status:           ${diag.forwardStatus ?? "n/a"}`);
  lines.push(`    duration:         ${ms(diag.forwardDurationMs)}`);
  lines.push(`    attempts:         ${diag.forwardAttempts ?? diag.retryingForwardAttempts ?? "n/a"}`);
  lines.push(`    retries:          ${diag.retryingForwardRetries ?? "n/a"}`);
  lines.push(`    total (retries):  ${ms(diag.forwardTotalMs ?? diag.retryingForwardTotalMs)}`);

  if (diag.error) {
    lines.push("");
    lines.push(`  error:              ${diag.error}`);
  }

  return lines.join("\n");
}

function describeDeployedHarness(diag, wakeResult) {
  return {
    measures: [
      "single deployed wake-from-stopped attempt",
      "stop-to-webhook dispatch latency",
      "webhook-to-running wake latency",
      "channel-forward diagnostic timing breakdown",
    ],
    captures: {
      jsonResult: true,
      webhookResponse: true,
      channelForwardDiag: diag ? true : false,
      acceptedWebhookLog: false,
      requestScopedSlackLogs: false,
      workflowRunsStepsEvents: false,
      localProcessLogs: false,
    },
    keySignals: {
      diagOutcome: diag?.outcome ?? null,
      forwardOk: diag?.forwardOk ?? null,
      forwardStatus: diag?.forwardStatus ?? null,
      forwardTransport: diag?.forwardTransport ?? null,
      slackForwardHasSignature: diag?.slackForwardHasSignature ?? null,
      slackForwardHasTimestamp: diag?.slackForwardHasTimestamp ?? null,
      bootStatus: diag?.bootResultStatus ?? null,
      readyStatus: diag?.readyMetaStatus ?? null,
      wakeConfirmedBy: wakeResult?.viaDiagnostic ? "channel-forward-diag" : "api/status",
    },
    recommendedUse:
      "Fastest deployed yes/no repro for a single version when channel-forward-diag is sufficient and request-scoped logs are not required.",
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  let configuredByUs = false;
  let cleanupToken = null;
  let result;
  let exitCode = 1;

  try {
    // 1. Pre-check: sandbox must be running
    await ensureRunning();

    // 2. Verify Slack is configured, or auto-configure smoke credentials
    const configState = await ensureSlackConfigured((token) => {
      configuredByUs = true;
      cleanupToken = token;
    });
    configuredByUs = configState.configuredByUs;
    cleanupToken = configState.cleanupToken ?? null;

    // 3. Stop the sandbox
    await stopSandbox();

    // 4. Wait for stopped
    await waitForStopped();
    const stoppedAt = Date.now();

    // 5. Send synthetic Slack webhook
    const webhookResult = await sendSlackWebhook();
    const webhookSentAt = Date.now();

    // 6. Poll until running
    const wakeResult = await waitForRunning();
    const runningAt = Date.now();

    // 7. Prove native acceptance for this exact delivery. Diagnostic remains
    // supporting evidence only; it is process-global and can be stale.
    const acceptance = await waitForNativeAcceptance(webhookResult.deliveryId);
    const diag = await readDiag();
    const diagReadAt = Date.now();

    // 8. Build result
    const totalMs = diagReadAt - t0;
    const stopToWebhookMs = webhookSentAt - stoppedAt;
    const webhookToRunningMs = runningAt - webhookSentAt;
    const passed = acceptance.accepted;

    result = {
      schemaVersion: 1,
      type: "slack-wake-test",
      passed,
      generatedAt: new Date().toISOString(),
      baseUrl,
      timing: {
        totalMs,
        stopToWebhookMs,
        webhookToRunningMs,
        wakeMs: wakeResult.wakeMs,
        diagReadMs: diagReadAt - runningAt,
      },
      webhook: webhookResult,
      acceptance,
      replyObserved: acceptance.replyObserved,
      diag: diag ?? null,
      harness: describeDeployedHarness(diag, wakeResult),
      error: passed
        ? null
        : "exact delivery did not reach native accepted state",
    };

    if (!jsonOnly) {
      process.stderr.write("\n=== SLACK WAKE-FROM-SLEEP TEST ===\n\n");
      process.stderr.write(
        `  result:             ${passed ? "PASS" : "FAIL"}\n`,
      );
      process.stderr.write(`  total wall time:    ${totalMs}ms\n`);
      process.stderr.write(`  stop -> webhook:    ${stopToWebhookMs}ms\n`);
      process.stderr.write(
        `  webhook -> running: ${webhookToRunningMs}ms\n`,
      );
      process.stderr.write(`  wake latency:       ${wakeResult.wakeMs}ms\n`);
      process.stderr.write(
        `  reply observed:     ${acceptance.replyObserved ? "yes" : "no / unproven"}\n`,
      );
      process.stderr.write("\n--- Channel Forward Diagnostic ---\n\n");
      process.stderr.write(formatTimingBreakdown(diag) + "\n\n");
    }

    exitCode = passed ? 0 : 1;
  } catch (err) {
    const totalMs = Date.now() - t0;
    result = {
      schemaVersion: 1,
      type: "slack-wake-test",
      passed: false,
      generatedAt: new Date().toISOString(),
      baseUrl,
      timing: { totalMs },
      harness: describeDeployedHarness(null, null),
      error: err.message,
    };

    if (!jsonOnly) {
      process.stderr.write(`\n=== SLACK WAKE-FROM-SLEEP TEST ===\n\n`);
      process.stderr.write(`  result:  FAIL\n`);
      process.stderr.write(`  error:   ${err.message}\n`);
      process.stderr.write(`  elapsed: ${totalMs}ms\n\n`);
    }

    exitCode = 1;
  } finally {
    if (configuredByUs && cleanupToken && !skipCleanup) {
      try {
        await cleanupTestChannels(cleanupToken);
      } catch (cleanupError) {
        const message = `owned smoke config cleanup failed: ${cleanupError.message}`;
        process.stderr.write(
          jsonOnly
            ? `${JSON.stringify({ type: "cleanup-failure", channel: "slack", error: message })}\n`
            : `[slack-wake] cleanup warning: ${message}\n`,
        );
        result = {
          ...result,
          passed: false,
          error: result?.passed === true ? message : result?.error ?? message,
          cleanup: { attempted: true, ok: false, error: message },
        };
        exitCode = 1;
      }
    }
  }

  console.log(JSON.stringify(result, null, jsonOnly ? 0 : 2));
  return exitCode;
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`fatal: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
