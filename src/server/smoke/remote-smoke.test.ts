/**
 * Tests for the remote smoke runner and phase functions.
 *
 * Verifies:
 *   - PhaseResult shape from each phase function
 *   - SmokeReport structure (passed, phases[], totalMs)
 *   - CLI exit codes: 0 for all-pass, 1 for any-fail
 *   - Safe-only mode skips destructive phases
 *   - --destructive flag includes destructive phases
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PhaseResult } from "./remote-phases.js";
import {
  health,
  status,
  gatewayProbe,
  firewallRead,
  channelsSummary,
  sshEcho,
  channelRoundTrip,
  channelGatewayContinuity,
  DEFAULT_REQUEST_TIMEOUT_MS,
  classifyResponse,
  parseJsonBody,
} from "./remote-phases.js";
import { authHeaders, getAuthSource, setAdminSecret, setAuthCookie, setProtectionBypass } from "./remote-auth.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Install a mock fetch that returns canned responses by URL pattern. */
function installMockFetch(
  routes: Array<{
    pattern: RegExp;
    response: (input: RequestInfo | URL, init?: RequestInit) => Response;
  }>,
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    for (const route of routes) {
      if (route.pattern.test(url)) {
        return route.response(input, init);
      }
    }
    return Response.json({ error: "no mock matched" }, { status: 500 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** Assert a PhaseResult has the correct shape. */
function assertPhaseShape(r: PhaseResult, expectedPhase: string): void {
  assert.equal(typeof r.phase, "string", "phase should be a string");
  assert.equal(r.phase, expectedPhase, `phase name should be "${expectedPhase}"`);
  assert.equal(typeof r.passed, "boolean", "passed should be a boolean");
  assert.equal(typeof r.durationMs, "number", "durationMs should be a number");
  assert.ok(r.durationMs >= 0, "durationMs should be non-negative");
  if (r.detail !== undefined) {
    assert.equal(typeof r.detail, "object", "detail should be an object if present");
  }
  if (r.error !== undefined) {
    assert.equal(typeof r.error, "string", "error should be a string if present");
  }
  // Enriched diagnostic fields
  if (r.endpoint !== undefined) {
    assert.equal(typeof r.endpoint, "string", "endpoint should be a string if present");
  }
  if (r.errorCode !== undefined) {
    assert.equal(typeof r.errorCode, "string", "errorCode should be a string if present");
  }
  if (r.httpStatus !== undefined) {
    assert.equal(typeof r.httpStatus, "number", "httpStatus should be a number if present");
  }
  if (r.hint !== undefined) {
    assert.equal(typeof r.hint, "string", "hint should be a string if present");
  }
  // Invariant: every failure must have error + errorCode
  if (!r.passed) {
    assert.ok(r.error, `failed phase "${r.phase}" must have non-empty error`);
    assert.ok(r.errorCode, `failed phase "${r.phase}" must have non-empty errorCode`);
  }
}

const BASE = "https://smoke-test.example.com";

// ---------------------------------------------------------------------------
// Phase function tests — shape and pass/fail logic
// ---------------------------------------------------------------------------

test("health phase: passes on { ok: true }", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/health/,
      response: () =>
        Response.json({ ok: true, authMode: "admin-secret", storeBackend: "memory", status: "running", hasSnapshot: false }),
    },
  ]);
  try {
    const r = await health(BASE);
    assertPhaseShape(r, "health");
    assert.equal(r.passed, true);
    assert.equal(r.detail?.ok, true);
  } finally {
    restore();
  }
});

test("health phase: fails on { ok: false }", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/health/,
      response: () => Response.json({ ok: false }, { status: 500 }),
    },
  ]);
  try {
    const r = await health(BASE);
    assertPhaseShape(r, "health");
    assert.equal(r.passed, false);
  } finally {
    restore();
  }
});

test("health phase: handles fetch error", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/health/,
      response: () => {
        throw new Error("connection refused");
      },
    },
  ]);
  try {
    const r = await health(BASE);
    assertPhaseShape(r, "health");
    assert.equal(r.passed, false);
    assert.ok(r.error?.includes("connection refused"));
  } finally {
    restore();
  }
});

test("status phase: passes with expected fields", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/status/,
      response: () =>
        Response.json({ status: "running", authMode: "admin-secret", storeBackend: "memory" }),
    },
  ]);
  try {
    const r = await status(BASE);
    assertPhaseShape(r, "status");
    assert.equal(r.passed, true);
  } finally {
    restore();
  }
});

test("status phase: fails when missing required fields", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/status/,
      response: () => Response.json({ status: "running" }),
    },
  ]);
  try {
    const r = await status(BASE);
    assertPhaseShape(r, "status");
    assert.equal(r.passed, false);
  } finally {
    restore();
  }
});

test("gatewayProbe phase: passes on 200", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/gateway/,
      response: () => new Response("<html>openclaw-app</html>", { status: 200 }),
    },
  ]);
  try {
    const r = await gatewayProbe(BASE);
    assertPhaseShape(r, "gatewayProbe");
    assert.equal(r.passed, true);
    assert.equal(r.detail?.httpStatus, 200);
  } finally {
    restore();
  }
});

test("gatewayProbe phase: passes on 202 waiting page", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/gateway/,
      response: () => new Response("<html>waiting</html>", { status: 202 }),
    },
  ]);
  try {
    const r = await gatewayProbe(BASE);
    assertPhaseShape(r, "gatewayProbe");
    assert.equal(r.passed, true);
    assert.equal(r.detail?.httpStatus, 202);
    assert.equal(r.detail?.isWaitingPage, true);
  } finally {
    restore();
  }
});

test("gatewayProbe phase: fails on 200 without openclaw-app marker", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/gateway/,
      response: () => new Response("<html><body>Generic page</body></html>", { status: 200 }),
    },
  ]);
  try {
    const r = await gatewayProbe(BASE);
    assertPhaseShape(r, "gatewayProbe");
    assert.equal(r.passed, false, "should fail when 200 body lacks openclaw-app marker");
    assert.equal(r.detail?.httpStatus, 200);
    assert.equal(r.detail?.hasMarker, false);
    assert.ok(r.error, "error should explain missing marker");
    assert.ok(r.error!.includes("openclaw-app"), `error should mention marker, got: ${r.error}`);
  } finally {
    restore();
  }
});

test("gatewayProbe phase: fails on empty 200 body", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/gateway/,
      response: () => new Response("", { status: 200 }),
    },
  ]);
  try {
    const r = await gatewayProbe(BASE);
    assertPhaseShape(r, "gatewayProbe");
    assert.equal(r.passed, false, "should fail on empty body");
    assert.equal(r.detail?.bodyLength, 0);
    assert.equal(r.detail?.hasMarker, false);
  } finally {
    restore();
  }
});

test("gatewayProbe phase: fails when response is a login page", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/gateway/,
      response: () =>
        new Response('<html><form action="/login"><input name="password"></form></html>', { status: 200 }),
    },
  ]);
  try {
    const r = await gatewayProbe(BASE);
    assertPhaseShape(r, "gatewayProbe");
    assert.equal(r.passed, false, "should fail on login page");
    assert.equal(r.errorCode, "APP_AUTH_FAILED");
  } finally {
    restore();
  }
});

test("gatewayProbe phase: 200 with marker reports hasMarker=true", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/gateway/,
      response: () =>
        new Response('<html><div id="openclaw-app"></div></html>', { status: 200 }),
    },
  ]);
  try {
    const r = await gatewayProbe(BASE);
    assertPhaseShape(r, "gatewayProbe");
    assert.equal(r.passed, true);
    assert.equal(r.detail?.hasMarker, true);
    assert.equal(r.error, undefined, "no error when marker present");
  } finally {
    restore();
  }
});

test("gatewayProbe phase: fails on 500", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/gateway/,
      response: () => new Response("error", { status: 500 }),
    },
  ]);
  try {
    const r = await gatewayProbe(BASE);
    assertPhaseShape(r, "gatewayProbe");
    assert.equal(r.passed, false);
  } finally {
    restore();
  }
});

test("firewallRead phase: passes with mode and allowlist", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/firewall/,
      response: () => Response.json({ mode: "learning", allowlist: [] }),
    },
  ]);
  try {
    const r = await firewallRead(BASE);
    assertPhaseShape(r, "firewallRead");
    assert.equal(r.passed, true);
  } finally {
    restore();
  }
});

test("firewallRead phase: fails without allowlist", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/firewall/,
      response: () => Response.json({ mode: "learning" }),
    },
  ]);
  try {
    const r = await firewallRead(BASE);
    assertPhaseShape(r, "firewallRead");
    assert.equal(r.passed, false);
  } finally {
    restore();
  }
});

test("channelsSummary phase: passes on valid object", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/channels\/summary/,
      response: () => Response.json({ slack: null, telegram: null, discord: null, whatsapp: { connected: false, lastError: null, deliveryMode: "gateway-native", requiresRunningSandbox: true } }),
    },
  ]);
  try {
    const r = await channelsSummary(BASE);
    assertPhaseShape(r, "channelsSummary");
    assert.equal(r.passed, true);
  } finally {
    restore();
  }
});

test("sshEcho phase: passes when stdout contains smoke-ok", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/admin\/ssh/,
      response: () => Response.json({ stdout: "smoke-ok\n", stderr: "", exitCode: 0 }),
    },
  ]);
  try {
    const r = await sshEcho(BASE);
    assertPhaseShape(r, "sshEcho");
    assert.equal(r.passed, true);
  } finally {
    restore();
  }
});

test("sshEcho phase: fails when stdout missing smoke-ok", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/admin\/ssh/,
      response: () => Response.json({ stdout: "something else\n", stderr: "", exitCode: 0 }),
    },
  ]);
  try {
    const r = await sshEcho(BASE);
    assertPhaseShape(r, "sshEcho");
    assert.equal(r.passed, false);
  } finally {
    restore();
  }
});

test("channelRoundTrip phase: correlates exact native acceptance", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/admin\/channel-secrets$/,
      response: () =>
        Response.json({
          configured: true,
          sent: true,
          webhookAccepted: true,
          status: 200,
          deliveryId: "synthetic:1",
        }),
    },
    {
      pattern: /\/api\/channels\/summary$/,
      response: () =>
        Response.json({
          slack: {
            connected: true,
            lastError: null,
            lastDeliveryState: {
              deliveryId: "synthetic:1",
              state: "visibility-unknown",
              terminal: true,
              native: { ok: true, classification: "accepted" },
              reply: { status: "unknown" },
            },
          },
          telegram: {
            connected: true,
            lastError: null,
            lastDeliveryState: {
              deliveryId: "synthetic:1",
              state: "visibility-unknown",
              terminal: true,
              native: { ok: true, classification: "accepted" },
              reply: { status: "unknown" },
            },
          },
          discord: { connected: false, lastError: null },
        }),
    },
  ]);
  try {
    const r = await channelRoundTrip(BASE);
    assertPhaseShape(r, "channelRoundTrip");
    assert.equal(r.passed, true);
    const channels =
      (r.detail?.channels as
        | Array<{
            channel: string;
            deliveryId: string;
            nativeAccepted: boolean;
            replyObserved: boolean;
          }>
        | undefined) ?? [];
    assert.deepEqual(
      channels.map((entry) => entry.channel).sort(),
      ["slack", "telegram"],
    );
    assert.ok(channels.every((entry) => entry.deliveryId === "synthetic:1"));
    assert.ok(channels.every((entry) => entry.nativeAccepted));
    assert.ok(channels.every((entry) => entry.replyObserved === false));
  } finally {
    restore();
  }
});

test("channelRoundTrip phase: does not promote unknown acceptance", async () => {
  const unknownEntry = {
    connected: true,
    lastError: null,
    lastDeliveryState: {
      deliveryId: "synthetic:unknown",
      state: "visibility-unknown",
      terminal: true,
      native: { ok: false, classification: "acceptance-unknown" },
      reply: { status: "unknown" },
    },
  };
  const restore = installMockFetch([
    {
      pattern: /\/api\/admin\/channel-secrets$/,
      response: () =>
        Response.json({
          configured: true,
          sent: true,
          webhookAccepted: true,
          status: 200,
          deliveryId: "synthetic:unknown",
        }),
    },
    {
      pattern: /\/api\/channels\/summary$/,
      response: () =>
        Response.json({
          slack: unknownEntry,
          telegram: unknownEntry,
          discord: unknownEntry,
        }),
    },
  ]);
  try {
    const result = await channelRoundTrip(BASE, { pollTimeoutMs: 100 });
    assertPhaseShape(result, "channelRoundTrip");
    assert.equal(result.passed, false);
    assert.equal(result.errorCode, "NATIVE_ACCEPTANCE_NOT_OBSERVED");
  } finally {
    restore();
  }
});

test("channelRoundTrip phase: one configured host rejection fails the whole phase", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/admin\/channel-secrets$/,
      response: (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { channel: string };
        if (body.channel === "slack") {
          return Response.json({
            configured: true,
            sent: false,
            webhookAccepted: false,
            status: 503,
            deliveryId: "slack:rejected",
          });
        }
        return Response.json({
          configured: body.channel === "telegram",
          sent: body.channel === "telegram",
          webhookAccepted: body.channel === "telegram",
          status: body.channel === "telegram" ? 200 : null,
          deliveryId: body.channel === "telegram" ? "telegram:accepted" : null,
        });
      },
    },
    {
      pattern: /\/api\/channels\/summary$/,
      response: () =>
        Response.json({
          slack: { connected: true, lastError: null },
          telegram: {
            connected: true,
            lastError: null,
            lastDeliveryState: {
              deliveryId: "telegram:accepted",
              state: "visibility-unknown",
              terminal: true,
              native: { ok: true, classification: "accepted" },
              reply: { status: "unknown" },
            },
          },
          discord: { connected: false, lastError: null },
        }),
    },
  ]);
  try {
    const result = await channelRoundTrip(BASE, { pollTimeoutMs: 100 });
    assertPhaseShape(result, "channelRoundTrip");
    assert.equal(result.passed, false);
    assert.equal(result.errorCode, "NATIVE_ACCEPTANCE_NOT_OBSERVED");
    const channels = result.detail?.channels as Array<{
      channel: string;
      webhookAccepted: boolean;
      nativeAccepted: boolean;
    }>;
    assert.deepEqual(
      channels.map((entry) => entry.channel).sort(),
      ["slack", "telegram"],
    );
    assert.equal(
      channels.find((entry) => entry.channel === "slack")?.webhookAccepted,
      false,
    );
  } finally {
    restore();
  }
});

test("channelRoundTrip phase: one host dispatch endpoint failure fails the whole phase", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/admin\/channel-secrets$/,
      response: (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { channel: string };
        if (body.channel === "slack") {
          return Response.json({ error: "unavailable" }, { status: 503 });
        }
        return Response.json({
          configured: body.channel === "telegram",
          sent: body.channel === "telegram",
          webhookAccepted: body.channel === "telegram",
          status: body.channel === "telegram" ? 200 : null,
          deliveryId: body.channel === "telegram" ? "telegram:accepted" : null,
        });
      },
    },
    {
      pattern: /\/api\/channels\/summary$/,
      response: () =>
        Response.json({
          slack: { connected: true, lastError: null },
          telegram: {
            connected: true,
            lastError: null,
            lastDeliveryState: {
              deliveryId: "telegram:accepted",
              state: "visibility-unknown",
              terminal: true,
              native: { ok: true, classification: "accepted" },
              reply: { status: "unknown" },
            },
          },
          discord: { connected: false, lastError: null },
        }),
    },
  ]);
  try {
    const result = await channelRoundTrip(BASE, { pollTimeoutMs: 100 });
    assertPhaseShape(result, "channelRoundTrip");
    assert.equal(result.passed, false);
    const channels = result.detail?.channels as Array<{
      channel: string;
      webhookAccepted: boolean;
    }>;
    assert.deepEqual(
      channels.map((entry) => entry.channel).sort(),
      ["slack", "telegram"],
    );
    assert.equal(
      channels.find((entry) => entry.channel === "slack")?.webhookAccepted,
      false,
    );
  } finally {
    restore();
  }
});

test("channelRoundTrip phase: all host dispatch endpoint failures fail", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/admin\/channel-secrets$/,
      response: () => Response.json({ error: "unavailable" }, { status: 503 }),
    },
  ]);
  try {
    const result = await channelRoundTrip(BASE, { pollTimeoutMs: 100 });
    assertPhaseShape(result, "channelRoundTrip");
    assert.equal(result.passed, false);
    assert.equal(result.errorCode, "WEBHOOK_SEND_FAILED");
  } finally {
    restore();
  }
});

test("channelRoundTrip phase: all disconnected summary entries allow a truthful skip", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/admin\/channel-secrets$/,
      response: () => Response.json({ error: "unavailable" }, { status: 503 }),
    },
    {
      pattern: /\/api\/channels\/summary$/,
      response: () =>
        Response.json({
          slack: { connected: false, lastError: null },
          telegram: { connected: false, lastError: null },
          discord: { connected: false, lastError: null },
        }),
    },
  ]);
  try {
    const result = await channelRoundTrip(BASE, { pollTimeoutMs: 100 });
    assertPhaseShape(result, "channelRoundTrip");
    assert.equal(result.passed, true);
    assert.equal(result.detail?.skipped, true);
  } finally {
    restore();
  }
});

test("channelRoundTrip phase: partial disconnected summary cannot prove a skip", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/admin\/channel-secrets$/,
      response: () => Response.json({ error: "unavailable" }, { status: 503 }),
    },
    {
      pattern: /\/api\/channels\/summary$/,
      response: () =>
        Response.json({
          slack: { connected: false, lastError: null },
        }),
    },
  ]);
  try {
    const result = await channelRoundTrip(BASE, { pollTimeoutMs: 100 });
    assertPhaseShape(result, "channelRoundTrip");
    assert.equal(result.passed, false);
    assert.equal(result.errorCode, "WEBHOOK_SEND_FAILED");
  } finally {
    restore();
  }
});

test("channelRoundTrip phase: ambiguous setup retries the same owner and fails", async () => {
  const setupOwnerIds: string[] = [];
  const restore = installMockFetch([
    {
      pattern: /\/api\/admin\/channel-secrets$/,
      response: (_input, init) => {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as { ownerId: string };
          setupOwnerIds.push(body.ownerId);
          return Response.json(
            { error: "unavailable" },
            { status: setupOwnerIds.length === 1 ? 409 : 400 },
          );
        }
        return Response.json({
          configured: false,
          sent: false,
          webhookAccepted: false,
        });
      },
    },
  ]);
  try {
    const result = await channelRoundTrip(BASE, { pollTimeoutMs: 100 });
    assertPhaseShape(result, "channelRoundTrip");
    assert.equal(result.passed, false);
    assert.equal(result.errorCode, "TEST_CHANNEL_SETUP_FAILED");
    assert.equal(setupOwnerIds.length, 2);
    assert.equal(setupOwnerIds[0], setupOwnerIds[1]);
  } finally {
    restore();
  }
});

test("channelRoundTrip phase: owned cleanup failure fails the phase", async () => {
  let configured = false;
  let cleanupAttempts = 0;
  const setupOwnerIds: string[] = [];
  const restore = installMockFetch([
    {
      pattern: /\/api\/admin\/channel-secrets$/,
      response: (_input, init) => {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as { ownerId: string };
          setupOwnerIds.push(body.ownerId);
          if (setupOwnerIds.length < 3) {
            return Response.json(
              { error: "busy" },
              { status: setupOwnerIds.length === 1 ? 409 : 503 },
            );
          }
          configured = true;
          return Response.json({
            cleanupToken: "opaque-cleanup-token",
            createdChannels: ["slack", "telegram"],
            recoveredChannels: [],
            preservedChannels: [],
          });
        }
        if (init?.method === "DELETE") {
          cleanupAttempts += 1;
          return Response.json(
            { error: "cleanup failed" },
            { status: cleanupAttempts === 1 ? 503 : 400 },
          );
        }
        const body = JSON.parse(String(init?.body)) as { channel: string };
        return Response.json({
          configured,
          sent: configured,
          webhookAccepted: configured,
          status: configured ? 200 : null,
          deliveryId: configured ? `${body.channel}:cleanup-proof` : null,
        });
      },
    },
    {
      pattern: /\/api\/channels\/summary$/,
      response: () =>
        Response.json(
          Object.fromEntries(
            ["slack", "telegram"].map((channel) => [
              channel,
              {
                connected: configured,
                lastError: null,
                lastDeliveryState: configured
                  ? {
                      deliveryId: `${channel}:cleanup-proof`,
                      state: "visibility-unknown",
                      terminal: true,
                      native: { ok: true, classification: "accepted" },
                      reply: { status: "unknown" },
                    }
                  : null,
              },
            ]),
          ),
        ),
    },
  ]);
  try {
    const result = await channelRoundTrip(BASE, { pollTimeoutMs: 100 });
    assertPhaseShape(result, "channelRoundTrip");
    assert.equal(result.passed, false);
    assert.equal(result.errorCode, "TEST_CHANNEL_CLEANUP_FAILED");
    assert.equal(setupOwnerIds.length, 3);
    assert.equal(new Set(setupOwnerIds).size, 1);
    assert.equal(cleanupAttempts, 2);
  } finally {
    restore();
  }
});

test("channelRoundTrip phase: cleanup response loss recovers idempotently", async () => {
  let configured = false;
  let cleanupAttempts = 0;
  const restore = installMockFetch([
    {
      pattern: /\/api\/admin\/channel-secrets$/,
      response: (_input, init) => {
        if (init?.method === "PUT") {
          configured = true;
          return Response.json({
            cleanupToken: "opaque-cleanup-token",
            createdChannels: ["slack", "telegram"],
            recoveredChannels: [],
            preservedChannels: [],
          });
        }
        if (init?.method === "DELETE") {
          cleanupAttempts += 1;
          if (cleanupAttempts === 1) {
            return Response.json(
              { error: "response lost after removal" },
              { status: 503 },
            );
          }
          configured = false;
          return Response.json({ removed: false, removedChannels: [] });
        }
        const body = JSON.parse(String(init?.body)) as { channel: string };
        return Response.json({
          configured,
          sent: configured,
          webhookAccepted: configured,
          status: configured ? 200 : null,
          deliveryId: configured ? `${body.channel}:cleanup-retry` : null,
        });
      },
    },
    {
      pattern: /\/api\/channels\/summary$/,
      response: () =>
        Response.json(
          Object.fromEntries(
            ["slack", "telegram"].map((channel) => [
              channel,
              {
                connected: configured,
                lastError: null,
                lastDeliveryState: configured
                  ? {
                      deliveryId: `${channel}:cleanup-retry`,
                      state: "visibility-unknown",
                      terminal: true,
                      native: { ok: true, classification: "accepted" },
                      reply: { status: "unknown" },
                    }
                  : null,
              },
            ]),
          ),
        ),
    },
  ]);
  try {
    const result = await channelRoundTrip(BASE, { pollTimeoutMs: 100 });
    assertPhaseShape(result, "channelRoundTrip");
    assert.equal(result.passed, true);
    assert.equal(cleanupAttempts, 2);
  } finally {
    restore();
  }
});

test("channelGatewayContinuity: exact acceptance-unknown delivery fails", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/gateway\/v1\/chat\/completions$/,
      response: () =>
        Response.json({
          choices: [{ message: { content: "smoke-ok" } }],
        }),
    },
    {
      pattern: /\/api\/admin\/channel-secrets$/,
      response: () =>
        Response.json({
          configured: true,
          sent: true,
          webhookAccepted: true,
          status: 200,
          deliveryId: "telegram:unknown",
        }),
    },
    {
      pattern: /\/api\/channels\/summary$/,
      response: () =>
        Response.json({
          telegram: {
            connected: true,
            lastError: null,
            lastDeliveryState: {
              deliveryId: "telegram:unknown",
              state: "visibility-unknown",
              terminal: true,
              native: { ok: false, classification: "acceptance-unknown" },
              reply: { status: "unknown" },
            },
          },
        }),
    },
  ]);
  try {
    const result = await channelGatewayContinuity(
      BASE,
      100,
      "telegram",
    );
    assertPhaseShape(result, "channelGatewayContinuity:telegram");
    assert.equal(result.passed, false);
    assert.equal(result.errorCode, "NATIVE_ACCEPTANCE_NOT_OBSERVED");
  } finally {
    restore();
  }
});

test("channelGatewayContinuity: unavailable channel summary fails", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/gateway\/v1\/chat\/completions$/,
      response: () =>
        Response.json({
          choices: [{ message: { content: "smoke-ok" } }],
        }),
    },
    {
      pattern: /\/api\/channels\/summary$/,
      response: () => Response.json({ error: "unavailable" }, { status: 503 }),
    },
  ]);
  try {
    const result = await channelGatewayContinuity(
      BASE,
      100,
      "telegram",
    );
    assertPhaseShape(result, "channelGatewayContinuity:telegram");
    assert.equal(result.passed, false);
    assert.equal(result.errorCode, "SUMMARY_UNAVAILABLE");
  } finally {
    restore();
  }
});

test("channelGatewayContinuity: waiting response fails the pre-check", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/gateway\/v1\/chat\/completions$/,
      response: () =>
        Response.json({ status: "waiting" }, { status: 202 }),
    },
  ]);
  try {
    const result = await channelGatewayContinuity(
      BASE,
      100,
      "telegram",
    );
    assertPhaseShape(result, "channelGatewayContinuity:telegram");
    assert.equal(result.passed, false);
    assert.equal(result.errorCode, "PRE_CHECK_FAILED");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// authHeaders tests
// ---------------------------------------------------------------------------

test("authHeaders: returns empty when no env cookie", () => {
  const orig = process.env.SMOKE_AUTH_COOKIE;
  delete process.env.SMOKE_AUTH_COOKIE;
  try {
    const hdrs = authHeaders();
    assert.equal(hdrs.Cookie, undefined);
    assert.equal(hdrs["X-Requested-With"], undefined);
  } finally {
    if (orig !== undefined) process.env.SMOKE_AUTH_COOKIE = orig;
  }
});

test("authHeaders: includes cookie from env", () => {
  const orig = process.env.SMOKE_AUTH_COOKIE;
  process.env.SMOKE_AUTH_COOKIE = "session=abc123";
  try {
    const hdrs = authHeaders();
    assert.equal(hdrs.Cookie, "session=abc123");
  } finally {
    if (orig !== undefined) {
      process.env.SMOKE_AUTH_COOKIE = orig;
    } else {
      delete process.env.SMOKE_AUTH_COOKIE;
    }
  }
});

test("authHeaders: adds CSRF header for mutations", () => {
  const hdrs = authHeaders({ mutation: true });
  assert.equal(hdrs["X-Requested-With"], "XMLHttpRequest");
});

test("authHeaders: no CSRF header for reads", () => {
  const hdrs = authHeaders();
  assert.equal(hdrs["X-Requested-With"], undefined);
});

test("authHeaders: includes admin bearer secret from env", () => {
  const origSmoke = process.env.SMOKE_ADMIN_SECRET;
  const origAdmin = process.env.ADMIN_SECRET;
  delete process.env.ADMIN_SECRET;
  process.env.SMOKE_ADMIN_SECRET = "admin-from-env";
  try {
    const hdrs = authHeaders();
    assert.equal(hdrs.Authorization, "Bearer admin-from-env");
  } finally {
    if (origSmoke !== undefined) process.env.SMOKE_ADMIN_SECRET = origSmoke;
    else delete process.env.SMOKE_ADMIN_SECRET;
    if (origAdmin !== undefined) process.env.ADMIN_SECRET = origAdmin;
    else delete process.env.ADMIN_SECRET;
  }
});

test("authHeaders: admin override and edge bypass source are reported without values", () => {
  const origBypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const origSmoke = process.env.SMOKE_ADMIN_SECRET;
  const origAdmin = process.env.ADMIN_SECRET;
  const origCookie = process.env.SMOKE_AUTH_COOKIE;
  delete process.env.SMOKE_AUTH_COOKIE;
  delete process.env.SMOKE_ADMIN_SECRET;
  delete process.env.ADMIN_SECRET;
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  try {
    setAdminSecret("admin-from-cli");
    setProtectionBypass("bypass-from-cli");
    const hdrs = authHeaders();
    assert.equal(hdrs.Authorization, "Bearer admin-from-cli");
    assert.equal(hdrs["x-vercel-protection-bypass"], "bypass-from-cli");
    assert.equal(getAuthSource(), "edge-bypass+admin-secret");
  } finally {
    setAdminSecret(undefined);
    setProtectionBypass(undefined);
    if (origBypass !== undefined) process.env.VERCEL_AUTOMATION_BYPASS_SECRET = origBypass;
    else delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    if (origSmoke !== undefined) process.env.SMOKE_ADMIN_SECRET = origSmoke;
    else delete process.env.SMOKE_ADMIN_SECRET;
    if (origAdmin !== undefined) process.env.ADMIN_SECRET = origAdmin;
    else delete process.env.ADMIN_SECRET;
    if (origCookie !== undefined) process.env.SMOKE_AUTH_COOKIE = origCookie;
    else delete process.env.SMOKE_AUTH_COOKIE;
  }
});

// ---------------------------------------------------------------------------
// CLI integration tests — exit codes and report structure
// ---------------------------------------------------------------------------

const CLI_PATH = new URL("./remote-smoke.ts", import.meta.url).pathname;

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", CLI_PATH, ...args],
      { timeout: 30_000, env: { ...process.env, NODE_NO_WARNINGS: "1" } },
    );
    return { code: 0, stdout, stderr };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

test("CLI: --help exits 0", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.code, 0);
  assert.ok(result.stderr.includes("--base-url"));
});

test("CLI: missing --base-url exits 1", async () => {
  const result = await runCli([]);
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes("--base-url"));
});

test("CLI: all-pass report has passed=true and exit 0", async () => {
  // Start a tiny HTTP server that returns passing responses for all safe phases
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/health") {
      res.end(JSON.stringify({ ok: true, authMode: "admin-secret", storeBackend: "memory", status: "running", hasSnapshot: false }));
    } else if (req.url === "/api/status") {
      res.end(JSON.stringify({ status: "running", authMode: "admin-secret", storeBackend: "memory" }));
    } else if (req.url === "/gateway" || req.url?.startsWith("/gateway/")) {
      res.end("<html>openclaw-app</html>");
    } else if (req.url === "/api/firewall") {
      res.end(JSON.stringify({ mode: "learning", allowlist: [] }));
    } else if (req.url === "/api/channels/summary") {
      res.end(JSON.stringify({ slack: { connected: false, lastError: null }, telegram: { connected: false, lastError: null }, discord: { connected: false, lastError: null }, whatsapp: { connected: false, lastError: null, deliveryMode: "unsupported", requiresRunningSandbox: false } }));
    } else if (req.url === "/api/admin/ssh") {
      res.end(JSON.stringify({ stdout: "smoke-ok\n", stderr: "", exitCode: 0 }));
    } else if (req.url === "/gateway/v1/chat/completions") {
      res.end(JSON.stringify({ choices: [{ message: { content: "smoke-ok" } }] }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as import("node:net").AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const result = await runCli(["--base-url", baseUrl]);
    assert.equal(result.code, 0, `Expected exit 0, got ${result.code}. stderr: ${result.stderr}`);

    // stdout should be valid JSON report
    const report = JSON.parse(result.stdout);
    assert.equal(report.schemaVersion, 1, "report must include schemaVersion: 1");
    assert.equal(report.passed, true);
    assert.ok(Array.isArray(report.phases));
    assert.equal(typeof report.totalMs, "number");
    assert.ok(report.totalMs >= 0);

    // Safe-only: 8 phases
    assert.equal(report.phases.length, 8);
    for (const phase of report.phases) {
      assertPhaseShape(phase, phase.phase);
      assert.equal(phase.passed, true);
    }

    // Verify safe phase names
    const names = report.phases.map((p: PhaseResult) => p.phase);
    assert.deepEqual(names, [
      "health",
      "status",
      "gatewayProbe",
      "firewallRead",
      "channelsSummary",
      "sshEcho",
      "chatCompletions",
      "channelRoundTrip",
    ]);
  } finally {
    server.close();
  }
});

test("CLI: any-fail report has passed=false and exit 1", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/health") {
      // Return failing health
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false }));
    } else if (req.url === "/api/status") {
      res.end(JSON.stringify({ status: "running", authMode: "admin-secret", storeBackend: "memory" }));
    } else if (req.url === "/gateway" || req.url?.startsWith("/gateway/")) {
      res.end("<html>openclaw-app</html>");
    } else if (req.url === "/api/firewall") {
      res.end(JSON.stringify({ mode: "learning", allowlist: [] }));
    } else if (req.url === "/api/channels/summary") {
      res.end(JSON.stringify({ slack: { connected: false, lastError: null }, telegram: { connected: false, lastError: null }, discord: { connected: false, lastError: null }, whatsapp: { connected: false, lastError: null, deliveryMode: "unsupported", requiresRunningSandbox: false } }));
    } else if (req.url === "/api/admin/ssh") {
      res.end(JSON.stringify({ stdout: "smoke-ok\n", stderr: "", exitCode: 0 }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as import("node:net").AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const result = await runCli(["--base-url", baseUrl]);
    assert.equal(result.code, 1, `Expected exit 1, got ${result.code}`);

    const report = JSON.parse(result.stdout);
    assert.equal(report.schemaVersion, 1, "report must include schemaVersion: 1");
    assert.equal(report.passed, false);
    assert.ok(Array.isArray(report.phases));
    assert.equal(typeof report.totalMs, "number");

    // health should have failed with diagnostic fields
    const healthPhase = report.phases.find((p: PhaseResult) => p.phase === "health");
    assert.ok(healthPhase);
    assert.equal(healthPhase.passed, false);
    assert.ok(healthPhase.error, "failed health phase must have error");
    assert.ok(healthPhase.errorCode, "failed health phase must have errorCode");
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Timeout / abort tests
// ---------------------------------------------------------------------------

test("health phase: hung endpoint aborts within requestTimeoutMs", async () => {
  // Start a server that never responds (holds connection open)
  const { createServer } = await import("node:http");
  const server = createServer(() => {
    // intentionally never respond — simulates a hung endpoint
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as import("node:net").AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const t0 = Date.now();
    const r = await health(baseUrl, { requestTimeoutMs: 500 });
    const elapsed = Date.now() - t0;

    assertPhaseShape(r, "health");
    assert.equal(r.passed, false);
    assert.ok(r.error, "error field should be set");
    assert.ok(
      r.error!.includes("timeout") || r.error!.includes("aborted"),
      `error should mention timeout or aborted, got: ${r.error}`,
    );
    // Should abort near the 500ms mark, not hang for 30s
    assert.ok(elapsed < 5_000, `Should abort quickly, took ${elapsed}ms`);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("status phase: hung endpoint aborts within requestTimeoutMs", async () => {
  const { createServer } = await import("node:http");
  const server = createServer(() => {
    // never respond
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as import("node:net").AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const r = await status(baseUrl, { requestTimeoutMs: 300 });
    assertPhaseShape(r, "status");
    assert.equal(r.passed, false);
    assert.ok(
      r.error!.includes("timeout") || r.error!.includes("aborted"),
      `error should mention timeout or aborted, got: ${r.error}`,
    );
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("sshEcho phase: hung endpoint aborts within requestTimeoutMs", async () => {
  const { createServer } = await import("node:http");
  const server = createServer(() => {
    // never respond
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as import("node:net").AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const r = await sshEcho(baseUrl, { requestTimeoutMs: 300 });
    assertPhaseShape(r, "sshEcho");
    assert.equal(r.passed, false);
    assert.ok(
      r.error!.includes("timeout") || r.error!.includes("aborted"),
      `error should mention timeout or aborted, got: ${r.error}`,
    );
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("DEFAULT_REQUEST_TIMEOUT_MS is exported and positive", () => {
  assert.equal(typeof DEFAULT_REQUEST_TIMEOUT_MS, "number");
  assert.ok(DEFAULT_REQUEST_TIMEOUT_MS > 0);
});

// ---------------------------------------------------------------------------
// CLI integration tests — exit codes and report structure
// ---------------------------------------------------------------------------

test("destructive flow: unavailable synthetic setup fails wake proof", async () => {
  const fetchedUrls: string[] = [];
  let sandboxToken = "fresh-token";

  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    fetchedUrls.push(req.url ?? "");
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/health") {
      res.end(JSON.stringify({ ok: true, authMode: "admin-secret", storeBackend: "memory", status: "running", hasSnapshot: false }));
    } else if (req.url === "/api/status") {
      res.end(JSON.stringify({ status: "running", authMode: "admin-secret", storeBackend: "memory", snapshotId: "should-not-use-this" }));
    } else if (req.url === "/gateway" || req.url?.startsWith("/gateway/")) {
      res.end("<html>openclaw-app</html>");
    } else if (req.url === "/api/firewall") {
      res.end(JSON.stringify({ mode: "learning", allowlist: [] }));
    } else if (req.url === "/api/channels/summary") {
      res.end(JSON.stringify({ slack: { connected: false, lastError: null }, telegram: { connected: false, lastError: null }, discord: { connected: false, lastError: null }, whatsapp: { connected: false, lastError: null, deliveryMode: "unsupported", requiresRunningSandbox: false } }));
    } else if (req.url === "/api/admin/ssh") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        const parsed = JSON.parse(body) as { command?: string };
        if (parsed.command?.includes("printf '%s' 'STALE-EXPIRED-TOKEN'")) {
          sandboxToken = "STALE-EXPIRED-TOKEN";
          res.end(JSON.stringify({ stdout: "", stderr: "", exitCode: 0 }));
          return;
        }
        if (parsed.command?.includes("cat /home/vercel-sandbox/.openclaw/.ai-gateway-api-key")) {
          res.end(JSON.stringify({ stdout: `${sandboxToken}\n`, stderr: "", exitCode: 0 }));
          return;
        }
        res.end(JSON.stringify({ stdout: "smoke-ok\n", stderr: "", exitCode: 0 }));
      });
      return;
    } else if (req.url === "/api/admin/ensure") {
      res.end(JSON.stringify({ state: "running" }));
    } else if (req.url === "/api/admin/snapshot") {
      res.end(JSON.stringify({ snapshotId: "snap-from-phase" }));
    } else if (req.url === "/api/admin/snapshots/restore") {
      // Verify the request body contains the snapshotId from the snapshot phase
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        const parsed = JSON.parse(body);
        res.end(JSON.stringify({ state: "running", status: "running", receivedSnapshotId: parsed.snapshotId }));
      });
      return;
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as import("node:net").AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const result = await runCli(["--base-url", baseUrl, "--destructive"]);
    assert.equal(result.code, 1);

    const report = JSON.parse(result.stdout);
    assert.equal(report.passed, false);

    const wakePhase = report.phases.find((p: PhaseResult) => p.phase === "channelWakeFromSleep");
    assert.ok(wakePhase, "channelWakeFromSleep phase should exist in destructive mode");
    assert.equal(wakePhase.passed, false);
    assert.equal(wakePhase.errorCode, "TEST_CHANNEL_SETUP_FAILED");

    // channelRoundTrip should also exist (twice: safe + destructive)
    const roundTrips = report.phases.filter((p: PhaseResult) => p.phase === "channelRoundTrip");
    assert.ok(roundTrips.length >= 1, "channelRoundTrip should exist");

    // chatCompletions should appear multiple times
    const completions = report.phases.filter((p: PhaseResult) => p.phase === "chatCompletions");
    assert.ok(completions.length >= 2, "chatCompletions should appear in both safe and destructive");
  } finally {
    server.close();
  }
});

test("CLI: safe-only mode runs 8 phases, --destructive runs 15", async () => {
  // We just test the safe count (already tested above) and verify --destructive
  // adds 7 destructive phases (ensure, chatCompletions, channelRoundTrip,
  // channelWakeFromSleep, chatCompletions, and two continuity phases)
  // by running with a mock server that handles the destructive endpoints.
  const { createServer } = await import("node:http");
  let sandboxToken = "fresh-token";
  let smokeConfigured = false;
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/health") {
      res.end(JSON.stringify({ ok: true, authMode: "admin-secret", storeBackend: "memory", status: "running", hasSnapshot: false }));
    } else if (req.url === "/api/status") {
      res.end(JSON.stringify({ status: "running", authMode: "admin-secret", storeBackend: "memory", snapshotId: "snap-test" }));
    } else if (req.url === "/gateway/v1/chat/completions") {
      res.end(JSON.stringify({ choices: [{ message: { content: "smoke-ok" } }] }));
    } else if (req.url === "/gateway" || req.url?.startsWith("/gateway/")) {
      res.end("<html>openclaw-app</html>");
    } else if (req.url === "/api/firewall") {
      res.end(JSON.stringify({ mode: "learning", allowlist: [] }));
    } else if (req.url === "/api/channels/summary") {
      const slack = smokeConfigured
        ? {
            connected: true,
            lastError: null,
            lastDeliveryState: {
              deliveryId: "slack:wake-proof",
              state: "visibility-unknown",
              terminal: true,
              native: { ok: true, classification: "accepted" },
              reply: { status: "unknown" },
            },
          }
        : { connected: false, lastError: null };
      res.end(JSON.stringify({ slack, telegram: { connected: false, lastError: null }, discord: { connected: false, lastError: null }, whatsapp: { connected: false, lastError: null, deliveryMode: "unsupported", requiresRunningSandbox: false } }));
    } else if (req.url === "/api/admin/channel-secrets") {
      if (req.method === "PUT") {
        smokeConfigured = true;
        res.end(JSON.stringify({
          cleanupToken: "opaque-cleanup-token",
          createdChannels: ["slack"],
          recoveredChannels: [],
          preservedChannels: ["telegram"],
        }));
      } else if (req.method === "DELETE") {
        smokeConfigured = false;
        res.end(JSON.stringify({ removed: true, removedChannels: ["slack"] }));
      } else if (smokeConfigured) {
        res.end(JSON.stringify({
          configured: true,
          sent: true,
          webhookAccepted: true,
          status: 200,
          deliveryId: "slack:wake-proof",
        }));
      } else {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "not configured" }));
      }
    } else if (req.url === "/api/admin/ssh") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        const parsed = JSON.parse(body) as { command?: string };
        if (parsed.command?.includes("printf '%s' 'STALE-EXPIRED-TOKEN'")) {
          sandboxToken = "STALE-EXPIRED-TOKEN";
          res.end(JSON.stringify({ stdout: "", stderr: "", exitCode: 0 }));
          return;
        }
        if (parsed.command?.includes("cat /home/vercel-sandbox/.openclaw/.ai-gateway-api-key")) {
          res.end(JSON.stringify({ stdout: `${sandboxToken}\n`, stderr: "", exitCode: 0 }));
          return;
        }
        res.end(JSON.stringify({ stdout: "smoke-ok\n", stderr: "", exitCode: 0 }));
      });
      return;
    } else if (req.url === "/api/admin/ensure") {
      // Already running
      res.end(JSON.stringify({ state: "running" }));
    } else if (req.url === "/api/admin/snapshot") {
      res.end(JSON.stringify({ snapshotId: "snap-test-123" }));
    } else if (req.url === "/api/admin/snapshots/restore") {
      res.end(JSON.stringify({ state: "running", status: "running" }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as import("node:net").AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const result = await runCli(["--base-url", baseUrl, "--destructive"]);
    assert.equal(result.code, 0, `Expected exit 0, got ${result.code}. stderr: ${result.stderr}`);

    const report = JSON.parse(result.stdout);
    assert.equal(report.passed, true);
    assert.equal(report.phases.length, 15);

    // Verify destructive phase names are present
    const names = report.phases.map((p: PhaseResult) => p.phase);
    assert.ok(names.includes("ensureRunning"));
    assert.ok(names.includes("channelWakeFromSleep"));
    assert.ok(names.includes("channelGatewayContinuity:slack"));
    assert.ok(names.includes("channelGatewayContinuity:telegram"));
    assert.ok(!names.includes("channelGatewayContinuity:discord"));
    // chatCompletions appears multiple times (safe + destructive)
    assert.ok(names.filter((n: string) => n === "chatCompletions").length >= 2);

    // Destructive phases come after safe phases
    const ensureIdx = names.indexOf("ensureRunning");
    const sshIdx = names.indexOf("sshEcho");
    assert.ok(ensureIdx > sshIdx, "destructive phases should come after safe phases");
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Enriched PhaseResult diagnostic field tests
// ---------------------------------------------------------------------------

test("health failure: includes errorCode and endpoint", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/health/,
      response: () => Response.json({ ok: false }, { status: 500 }),
    },
  ]);
  try {
    const r = await health(BASE);
    assertPhaseShape(r, "health");
    assert.equal(r.passed, false);
    assert.equal(r.endpoint, "/api/health");
    assert.ok(r.errorCode, "errorCode must be present");
    assert.ok(r.hint, "hint must be present");
  } finally {
    restore();
  }
});

test("health success: includes endpoint, no errorCode", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/health/,
      response: () =>
        Response.json({ ok: true, authMode: "admin-secret", storeBackend: "memory", status: "running", hasSnapshot: false }),
    },
  ]);
  try {
    const r = await health(BASE);
    assertPhaseShape(r, "health");
    assert.equal(r.passed, true);
    assert.equal(r.endpoint, "/api/health");
    assert.equal(r.errorCode, undefined);
    assert.equal(r.hint, undefined);
  } finally {
    restore();
  }
});

test("status failure: returns MISSING_FIELDS errorCode", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/status/,
      response: () => Response.json({ status: "running" }),
    },
  ]);
  try {
    const r = await status(BASE);
    assertPhaseShape(r, "status");
    assert.equal(r.passed, false);
    assert.equal(r.errorCode, "MISSING_FIELDS");
    assert.equal(r.endpoint, "/api/status");
    assert.ok(r.error!.includes("authMode") || r.error!.includes("storeBackend"));
  } finally {
    restore();
  }
});

test("gatewayProbe failure on 200 without marker: returns MISSING_MARKER", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/gateway/,
      response: () => new Response("<html>not the app</html>", { status: 200 }),
    },
  ]);
  try {
    const r = await gatewayProbe(BASE);
    assertPhaseShape(r, "gatewayProbe");
    assert.equal(r.passed, false);
    assert.equal(r.errorCode, "MISSING_MARKER");
    assert.equal(r.httpStatus, 200);
    assert.equal(r.endpoint, "/gateway");
  } finally {
    restore();
  }
});

test("gatewayProbe failure on redirect: returns UNEXPECTED_REDIRECT", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/gateway/,
      response: () => new Response(null, { status: 302, headers: { Location: "https://x.com" } }),
    },
  ]);
  try {
    const r = await gatewayProbe(BASE);
    assertPhaseShape(r, "gatewayProbe");
    assert.equal(r.passed, false);
    assert.equal(r.errorCode, "UNEXPECTED_REDIRECT");
    assert.equal(r.httpStatus, 302);
  } finally {
    restore();
  }
});

test("sshEcho failure: ECHO_MISMATCH when output wrong", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/admin\/ssh/,
      response: () => Response.json({ stdout: "wrong output\n", stderr: "", exitCode: 0 }),
    },
  ]);
  try {
    const r = await sshEcho(BASE);
    assertPhaseShape(r, "sshEcho");
    assert.equal(r.passed, false);
    assert.equal(r.errorCode, "ECHO_MISMATCH");
    assert.equal(r.endpoint, "/api/admin/ssh");
  } finally {
    restore();
  }
});

test("firewallRead failure: MISSING_FIELDS when allowlist absent", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/firewall/,
      response: () => Response.json({ mode: "learning" }),
    },
  ]);
  try {
    const r = await firewallRead(BASE);
    assertPhaseShape(r, "firewallRead");
    assert.equal(r.passed, false);
    assert.equal(r.errorCode, "MISSING_FIELDS");
    assert.equal(r.endpoint, "/api/firewall");
  } finally {
    restore();
  }
});

test("fetch error: returns TIMEOUT errorCode on abort", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/health/,
      response: () => {
        const err = new DOMException("The operation was aborted", "AbortError");
        throw err;
      },
    },
  ]);
  try {
    const r = await health(BASE);
    assertPhaseShape(r, "health");
    assert.equal(r.passed, false);
    assert.equal(r.errorCode, "TIMEOUT");
    assert.equal(r.endpoint, "/api/health");
  } finally {
    restore();
  }
});

test("fetch error: returns FETCH_ERROR errorCode on generic error", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/health/,
      response: () => {
        throw new Error("some network issue");
      },
    },
  ]);
  try {
    const r = await health(BASE);
    assertPhaseShape(r, "health");
    assert.equal(r.passed, false);
    assert.equal(r.errorCode, "FETCH_ERROR");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// classifyResponse unit tests
// ---------------------------------------------------------------------------

test("classifyResponse: 401 returns APP_AUTH_FAILED", () => {
  const c = classifyResponse(401, "Unauthorized");
  assert.ok(c);
  assert.equal(c.errorCode, "APP_AUTH_FAILED");
  assert.ok(c.error.includes("401"));
  assert.ok(c.hint.includes("SMOKE_AUTH_COOKIE"));
});

test("classifyResponse: 403 returns APP_AUTH_FAILED", () => {
  const c = classifyResponse(403, "Forbidden");
  assert.ok(c);
  assert.equal(c.errorCode, "APP_AUTH_FAILED");
  assert.ok(c.error.includes("403"));
});

test("classifyResponse: 302 redirect returns UNEXPECTED_REDIRECT", () => {
  const headers = new Headers({ location: "https://login.example.com" });
  const c = classifyResponse(302, "", headers);
  assert.ok(c);
  assert.equal(c.errorCode, "UNEXPECTED_REDIRECT");
  assert.ok(c.error.includes("login.example.com"));
  assert.ok(c.hint);
});

test("classifyResponse: 301 redirect returns UNEXPECTED_REDIRECT", () => {
  const c = classifyResponse(301, "", new Headers());
  assert.ok(c);
  assert.equal(c.errorCode, "UNEXPECTED_REDIRECT");
});

test("classifyResponse: login HTML with form+password returns APP_AUTH_FAILED", () => {
  const html = '<html><body><form action="/auth"><input type="password"></form></body></html>';
  const c = classifyResponse(200, html);
  assert.ok(c);
  assert.equal(c.errorCode, "APP_AUTH_FAILED");
  assert.ok(c.hint.includes("SMOKE_AUTH_COOKIE"));
});

test("classifyResponse: Sign in with Vercel page returns EDGE_BYPASS_FAILED", () => {
  const html = '<html><body>Sign in with Vercel to continue</body></html>';
  const c = classifyResponse(200, html);
  assert.ok(c);
  assert.equal(c.errorCode, "EDGE_BYPASS_FAILED");
});

test("classifyResponse: __vercel_auth marker returns EDGE_BYPASS_FAILED", () => {
  const html = '<html><script>__vercel_auth()</script></html>';
  const c = classifyResponse(200, html);
  assert.ok(c);
  assert.equal(c.errorCode, "EDGE_BYPASS_FAILED");
});

test("classifyResponse: normal 200 JSON returns null", () => {
  const c = classifyResponse(200, '{"ok":true}');
  assert.equal(c, null);
});

test("classifyResponse: normal 200 HTML without login returns null", () => {
  const c = classifyResponse(200, '<html><body>openclaw-app</body></html>');
  assert.equal(c, null);
});

test("classifyResponse: 500 returns null (not a classified error)", () => {
  const c = classifyResponse(500, '{"error":"internal"}');
  assert.equal(c, null);
});

// ---------------------------------------------------------------------------
// parseJsonBody unit tests
// ---------------------------------------------------------------------------

test("parseJsonBody: valid JSON object returns ok", () => {
  const r = parseJsonBody('{"key":"value"}');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.data.key, "value");
});

test("parseJsonBody: invalid JSON returns MALFORMED_JSON", () => {
  const r = parseJsonBody("not json at all");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.classification.errorCode, "MALFORMED_JSON");
    assert.ok(r.classification.error.includes("not valid JSON"));
    assert.ok(r.classification.hint);
  }
});

test("parseJsonBody: JSON array returns MALFORMED_JSON", () => {
  const r = parseJsonBody("[1,2,3]");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.classification.errorCode, "MALFORMED_JSON");
    assert.ok(r.classification.error.includes("array"));
  }
});

test("parseJsonBody: JSON null returns MALFORMED_JSON", () => {
  const r = parseJsonBody("null");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.classification.errorCode, "MALFORMED_JSON");
    assert.ok(r.classification.error.includes("null"));
  }
});

test("parseJsonBody: JSON string returns MALFORMED_JSON", () => {
  const r = parseJsonBody('"hello"');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.classification.errorCode, "MALFORMED_JSON");
    assert.ok(r.classification.error.includes("string"));
  }
});

test("parseJsonBody: HTML page returns MALFORMED_JSON", () => {
  const r = parseJsonBody("<html><body>Error</body></html>");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.classification.errorCode, "MALFORMED_JSON");
    assert.ok(r.classification.hint.includes("non-JSON"));
  }
});

// ---------------------------------------------------------------------------
// Phase integration: classifyResponse catches auth/login before phase logic
// ---------------------------------------------------------------------------

test("health phase: 401 returns APP_AUTH_FAILED via classifyResponse", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/health/,
      response: () => new Response("Unauthorized", { status: 401 }),
    },
  ]);
  try {
    const r = await health(BASE);
    assertPhaseShape(r, "health");
    assert.equal(r.passed, false);
    assert.equal(r.errorCode, "APP_AUTH_FAILED");
    assert.equal(r.httpStatus, 401);
    assert.ok(r.hint!.includes("SMOKE_AUTH_COOKIE"));
  } finally {
    restore();
  }
});

test("status phase: 403 returns APP_AUTH_FAILED via classifyResponse", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/status/,
      response: () => new Response("Forbidden", { status: 403 }),
    },
  ]);
  try {
    const r = await status(BASE);
    assertPhaseShape(r, "status");
    assert.equal(r.passed, false);
    assert.equal(r.errorCode, "APP_AUTH_FAILED");
    assert.equal(r.httpStatus, 403);
  } finally {
    restore();
  }
});

test("health phase: login page returns APP_AUTH_FAILED via classifyResponse", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/health/,
      response: () =>
        new Response('<html><form><input type="password">Sign in</form></html>', { status: 200 }),
    },
  ]);
  try {
    const r = await health(BASE);
    assertPhaseShape(r, "health");
    assert.equal(r.passed, false);
    assert.equal(r.errorCode, "APP_AUTH_FAILED");
    assert.ok(r.hint!.includes("SMOKE_AUTH_COOKIE"));
  } finally {
    restore();
  }
});

test("firewallRead phase: malformed JSON returns MALFORMED_JSON", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/firewall/,
      response: () => new Response("this is not json", { status: 200 }),
    },
  ]);
  try {
    const r = await firewallRead(BASE);
    assertPhaseShape(r, "firewallRead");
    assert.equal(r.passed, false);
    assert.equal(r.errorCode, "MALFORMED_JSON");
    assert.ok(r.hint!.includes("non-JSON"));
  } finally {
    restore();
  }
});

test("sshEcho phase: malformed JSON returns MALFORMED_JSON", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/admin\/ssh/,
      response: () => new Response("<html>Error page</html>", { status: 200 }),
    },
  ]);
  try {
    const r = await sshEcho(BASE);
    assertPhaseShape(r, "sshEcho");
    assert.equal(r.passed, false);
    assert.equal(r.errorCode, "MALFORMED_JSON");
  } finally {
    restore();
  }
});

test("channelsSummary phase: 302 redirect returns UNEXPECTED_REDIRECT", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/api\/channels\/summary/,
      response: () =>
        new Response(null, { status: 302, headers: { Location: "https://login.example.com" } }),
    },
  ]);
  try {
    const r = await channelsSummary(BASE);
    assertPhaseShape(r, "channelsSummary");
    assert.equal(r.passed, false);
    assert.equal(r.errorCode, "UNEXPECTED_REDIRECT");
    assert.equal(r.httpStatus, 302);
  } finally {
    restore();
  }
});

test("gatewayProbe phase: 401 returns APP_AUTH_FAILED via classifyResponse", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/gateway/,
      response: () => new Response("Unauthorized", { status: 401 }),
    },
  ]);
  try {
    const r = await gatewayProbe(BASE);
    assertPhaseShape(r, "gatewayProbe");
    assert.equal(r.passed, false);
    assert.equal(r.errorCode, "APP_AUTH_FAILED");
    assert.equal(r.httpStatus, 401);
  } finally {
    restore();
  }
});

test("gatewayProbe phase: Vercel protection page returns EDGE_BYPASS_FAILED", async () => {
  const restore = installMockFetch([
    {
      pattern: /\/gateway/,
      response: () =>
        new Response('<html><body>Sign in with Vercel</body></html>', { status: 200 }),
    },
  ]);
  try {
    const r = await gatewayProbe(BASE);
    assertPhaseShape(r, "gatewayProbe");
    assert.equal(r.passed, false);
    assert.equal(r.errorCode, "EDGE_BYPASS_FAILED");
  } finally {
    restore();
  }
});

test("CLI all-pass report: every phase has endpoint field", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/health") {
      res.end(JSON.stringify({ ok: true, authMode: "admin-secret", storeBackend: "memory", status: "running", hasSnapshot: false }));
    } else if (req.url === "/api/status") {
      res.end(JSON.stringify({ status: "running", authMode: "admin-secret", storeBackend: "memory" }));
    } else if (req.url === "/gateway" || req.url?.startsWith("/gateway/")) {
      res.end("<html>openclaw-app</html>");
    } else if (req.url === "/api/firewall") {
      res.end(JSON.stringify({ mode: "learning", allowlist: [] }));
    } else if (req.url === "/api/channels/summary") {
      res.end(JSON.stringify({ slack: { connected: false, lastError: null }, telegram: { connected: false, lastError: null }, discord: { connected: false, lastError: null }, whatsapp: { connected: false, lastError: null, deliveryMode: "unsupported", requiresRunningSandbox: false } }));
    } else if (req.url === "/api/admin/ssh") {
      res.end(JSON.stringify({ stdout: "smoke-ok\n", stderr: "", exitCode: 0 }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as import("node:net").AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const result = await runCli(["--base-url", baseUrl]);
    assert.equal(result.code, 0);
    const report = JSON.parse(result.stdout);
    for (const phase of report.phases) {
      assert.ok(phase.endpoint, `phase "${phase.phase}" should have endpoint field`);
      assert.equal(typeof phase.endpoint, "string");
    }
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// CLI flag tests — --request-timeout, --auth-cookie, --json-only
// ---------------------------------------------------------------------------

test("CLI: --help documents all flags", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.code, 0);
  assert.ok(result.stderr.includes("--request-timeout"), "help should mention --request-timeout");
  assert.ok(result.stderr.includes("--auth-cookie"), "help should mention --auth-cookie");
  assert.ok(result.stderr.includes("--json-only"), "help should mention --json-only");
  assert.ok(result.stderr.includes("--base-url"), "help should mention --base-url");
  assert.ok(result.stderr.includes("--destructive"), "help should mention --destructive");
  assert.ok(result.stderr.includes("--timeout"), "help should mention --timeout");
});

test("CLI: --request-timeout accepts a positive number", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/health") {
      res.end(JSON.stringify({ ok: true }));
    } else if (req.url === "/api/status") {
      res.end(JSON.stringify({ status: "running", authMode: "admin-secret", storeBackend: "memory" }));
    } else if (req.url === "/gateway" || req.url?.startsWith("/gateway/")) {
      res.end("<html>openclaw-app</html>");
    } else if (req.url === "/api/firewall") {
      res.end(JSON.stringify({ mode: "learning", allowlist: [] }));
    } else if (req.url === "/api/channels/summary") {
      res.end(JSON.stringify({ slack: { connected: false, lastError: null }, telegram: { connected: false, lastError: null }, discord: { connected: false, lastError: null }, whatsapp: { connected: false, lastError: null, deliveryMode: "unsupported", requiresRunningSandbox: false } }));
    } else if (req.url === "/api/admin/ssh") {
      res.end(JSON.stringify({ stdout: "smoke-ok\n", stderr: "", exitCode: 0 }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as import("node:net").AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const result = await runCli(["--base-url", baseUrl, "--request-timeout", "5"]);
    assert.equal(result.code, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.passed, true);
  } finally {
    server.close();
  }
});

test("CLI: --request-timeout rejects non-positive", async () => {
  const result = await runCli(["--base-url", "http://localhost", "--request-timeout", "0"]);
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes("--request-timeout"));
});

test("CLI: --request-timeout rejects non-numeric", async () => {
  const result = await runCli(["--base-url", "http://localhost", "--request-timeout", "abc"]);
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes("--request-timeout"));
});

test("CLI: --json-only suppresses stderr, emits only JSON to stdout", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/health") {
      res.end(JSON.stringify({ ok: true }));
    } else if (req.url === "/api/status") {
      res.end(JSON.stringify({ status: "running", authMode: "admin-secret", storeBackend: "memory" }));
    } else if (req.url === "/gateway" || req.url?.startsWith("/gateway/")) {
      res.end("<html>openclaw-app</html>");
    } else if (req.url === "/api/firewall") {
      res.end(JSON.stringify({ mode: "learning", allowlist: [] }));
    } else if (req.url === "/api/channels/summary") {
      res.end(JSON.stringify({ slack: { connected: false, lastError: null }, telegram: { connected: false, lastError: null }, discord: { connected: false, lastError: null }, whatsapp: { connected: false, lastError: null, deliveryMode: "unsupported", requiresRunningSandbox: false } }));
    } else if (req.url === "/api/admin/ssh") {
      res.end(JSON.stringify({ stdout: "smoke-ok\n", stderr: "", exitCode: 0 }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as import("node:net").AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const result = await runCli(["--base-url", baseUrl, "--json-only"]);
    assert.equal(result.code, 0);

    // stdout must be valid JSON report
    const report = JSON.parse(result.stdout);
    assert.equal(report.passed, true);
    assert.equal(report.schemaVersion, 1);

    // stderr must not have human-readable progress lines
    assert.ok(!result.stderr.includes("[PASS]"), "stderr should not contain [PASS] in --json-only mode");
    assert.ok(!result.stderr.includes("[FAIL]"), "stderr should not contain [FAIL] in --json-only mode");
    assert.ok(!result.stderr.includes("Smoke Report"), "stderr should not contain summary in --json-only mode");
  } finally {
    server.close();
  }
});

test("CLI: --auth-cookie overrides SMOKE_AUTH_COOKIE env var", async () => {
  const { createServer } = await import("node:http");
  let receivedCookie: string | undefined;

  const server = createServer((req, res) => {
    // Capture the Cookie header from the status request (which uses authHeaders)
    if (req.url === "/api/status") {
      receivedCookie = req.headers.cookie;
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/health") {
      res.end(JSON.stringify({ ok: true }));
    } else if (req.url === "/api/status") {
      res.end(JSON.stringify({ status: "running", authMode: "sign-in-with-vercel", storeBackend: "memory" }));
    } else if (req.url === "/gateway" || req.url?.startsWith("/gateway/")) {
      res.end("<html>openclaw-app</html>");
    } else if (req.url === "/api/firewall") {
      res.end(JSON.stringify({ mode: "learning", allowlist: [] }));
    } else if (req.url === "/api/channels/summary") {
      res.end(JSON.stringify({ slack: { connected: false, lastError: null }, telegram: { connected: false, lastError: null }, discord: { connected: false, lastError: null }, whatsapp: { connected: false, lastError: null, deliveryMode: "unsupported", requiresRunningSandbox: false } }));
    } else if (req.url === "/api/admin/ssh") {
      res.end(JSON.stringify({ stdout: "smoke-ok\n", stderr: "", exitCode: 0 }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as import("node:net").AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const result = await runCli([
      "--base-url", baseUrl,
      "--auth-cookie", "session=cli-override-value",
    ]);
    assert.equal(result.code, 0);
    assert.equal(receivedCookie, "session=cli-override-value", "server should receive CLI cookie");
  } finally {
    server.close();
  }
});

test("CLI: --admin-secret sends Authorization bearer header", async () => {
  const { createServer } = await import("node:http");
  let receivedAuth: string | undefined;

  const server = createServer((req, res) => {
    if (req.url === "/api/status") {
      receivedAuth = req.headers.authorization;
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/health") {
      res.end(JSON.stringify({ ok: true }));
    } else if (req.url === "/api/status") {
      res.end(JSON.stringify({ status: "running", authMode: "admin-secret", storeBackend: "memory" }));
    } else if (req.url === "/gateway" || req.url?.startsWith("/gateway/")) {
      res.end("<html>openclaw-app</html>");
    } else if (req.url === "/api/firewall") {
      res.end(JSON.stringify({ mode: "learning", allowlist: [] }));
    } else if (req.url === "/api/channels/summary") {
      res.end(JSON.stringify({ slack: { connected: false, lastError: null }, telegram: { connected: false, lastError: null }, discord: { connected: false, lastError: null }, whatsapp: { connected: false, lastError: null, deliveryMode: "unsupported", requiresRunningSandbox: false } }));
    } else if (req.url === "/api/admin/ssh") {
      res.end(JSON.stringify({ stdout: "smoke-ok\n", stderr: "", exitCode: 0 }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as import("node:net").AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const result = await runCli([
      "--base-url", baseUrl,
      "--admin-secret", "admin-cli-secret",
    ]);
    assert.equal(result.code, 0);
    assert.equal(receivedAuth, "Bearer admin-cli-secret");
  } finally {
    server.close();
  }
});

test("CLI: rejects x-vercel-protection-bypass in base URL", async () => {
  const result = await runCli([
    "--base-url",
    "https://example.com?x-vercel-protection-bypass=secret",
  ]);
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes("x-vercel-protection-bypass"));
});

test("CLI: --profile wake runs wake phases without continuity phases", async () => {
  const { createServer } = await import("node:http");
  let statusCalls = 0;

  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/health") {
      res.end(JSON.stringify({ ok: true, authMode: "admin-secret", storeBackend: "memory", status: "running", hasSnapshot: false }));
    } else if (req.url === "/api/status") {
      statusCalls += 1;
      res.end(JSON.stringify({ status: statusCalls > 2 ? "running" : "stopped", authMode: "admin-secret", storeBackend: "memory" }));
    } else if (req.url === "/gateway/v1/chat/completions") {
      res.end(JSON.stringify({ choices: [{ message: { content: "smoke-ok" } }] }));
    } else if (req.url === "/gateway" || req.url?.startsWith("/gateway/")) {
      res.end("<html>openclaw-app</html>");
    } else if (req.url === "/api/firewall") {
      res.end(JSON.stringify({ mode: "learning", allowlist: [] }));
    } else if (req.url === "/api/channels/summary") {
      const accepted = {
        connected: true,
        lastError: null,
        lastDeliveryState: {
          deliveryId: "synthetic:wake",
          state: "visibility-unknown",
          terminal: true,
          native: { ok: true, classification: "accepted" },
          reply: { status: "unknown" },
        },
      };
      res.end(JSON.stringify({
        slack: accepted,
        telegram: accepted,
        discord: accepted,
        whatsapp: { connected: false, lastError: null },
      }));
    } else if (req.url === "/api/admin/ssh") {
      res.end(JSON.stringify({ stdout: "smoke-ok\n", stderr: "", exitCode: 0 }));
    } else if (req.url === "/api/admin/ensure") {
      res.end(JSON.stringify({ state: "running" }));
    } else if (req.url === "/api/admin/channel-secrets") {
      res.end(JSON.stringify({
        configured: true,
        sent: true,
        webhookAccepted: true,
        status: 200,
        deliveryId: "synthetic:wake",
      }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as import("node:net").AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const result = await runCli(["--base-url", baseUrl, "--profile", "wake", "--timeout", "5"]);
    assert.equal(result.code, 0, `Expected exit 0, got ${result.code}. stderr: ${result.stderr}`);
    const report = JSON.parse(result.stdout);
    const names = report.phases.map((p: PhaseResult) => p.phase);
    assert.ok(names.includes("channelWakeFromSleep"));
    assert.ok(!names.some((name: string) => name.startsWith("channelGatewayContinuity")));
  } finally {
    server.close();
  }
});

test("CLI: --auth-cookie value is never logged to stderr or stdout", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/health") {
      res.end(JSON.stringify({ ok: true }));
    } else if (req.url === "/api/status") {
      res.end(JSON.stringify({ status: "running", authMode: "admin-secret", storeBackend: "memory" }));
    } else if (req.url === "/gateway" || req.url?.startsWith("/gateway/")) {
      res.end("<html>openclaw-app</html>");
    } else if (req.url === "/api/firewall") {
      res.end(JSON.stringify({ mode: "learning", allowlist: [] }));
    } else if (req.url === "/api/channels/summary") {
      res.end(JSON.stringify({ slack: { connected: false, lastError: null }, telegram: { connected: false, lastError: null }, discord: { connected: false, lastError: null }, whatsapp: { connected: false, lastError: null, deliveryMode: "unsupported", requiresRunningSandbox: false } }));
    } else if (req.url === "/api/admin/ssh") {
      res.end(JSON.stringify({ stdout: "smoke-ok\n", stderr: "", exitCode: 0 }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as import("node:net").AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const secretCookie = "session=super-secret-token-12345";

  try {
    const result = await runCli(["--base-url", baseUrl, "--auth-cookie", secretCookie]);
    assert.equal(result.code, 0);
    assert.ok(!result.stdout.includes(secretCookie), "stdout must not contain raw cookie");
    assert.ok(!result.stderr.includes(secretCookie), "stderr must not contain raw cookie");
  } finally {
    server.close();
  }
});

test("setAuthCookie: CLI override takes precedence over env var", () => {
  const orig = process.env.SMOKE_AUTH_COOKIE;
  process.env.SMOKE_AUTH_COOKIE = "session=from-env";
  try {
    setAuthCookie("session=from-cli");
    const hdrs = authHeaders();
    assert.equal(hdrs.Cookie, "session=from-cli");
  } finally {
    setAuthCookie(undefined); // clear override
    if (orig !== undefined) {
      process.env.SMOKE_AUTH_COOKIE = orig;
    } else {
      delete process.env.SMOKE_AUTH_COOKIE;
    }
  }
});

// ---------------------------------------------------------------------------
// Structured event stream tests
// ---------------------------------------------------------------------------

/** Parse stderr into JSON event lines (ignoring non-JSON lines). */
function parseEventLines(stderr: string): Array<Record<string, unknown>> {
  return stderr
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((e): e is Record<string, unknown> => e !== null);
}

/** Filter events by type. */
function eventsOfType(events: Array<Record<string, unknown>>, type: string) {
  return events.filter((e) => e.type === type);
}

test("event stream: --json-only emits smoke-start, phase-end, and smoke-finish events", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/health") {
      res.end(JSON.stringify({ ok: true, authMode: "admin-secret", storeBackend: "memory", status: "running", hasSnapshot: false }));
    } else if (req.url === "/api/status") {
      res.end(JSON.stringify({ status: "running", authMode: "admin-secret", storeBackend: "memory" }));
    } else if (req.url === "/gateway/v1/chat/completions") {
      res.end(JSON.stringify({ choices: [{ message: { content: "smoke-ok" } }] }));
    } else if (req.url === "/gateway" || req.url?.startsWith("/gateway/")) {
      res.end("<html>openclaw-app</html>");
    } else if (req.url === "/api/firewall") {
      res.end(JSON.stringify({ mode: "learning", allowlist: [] }));
    } else if (req.url === "/api/channels/summary") {
      res.end(JSON.stringify({ slack: { connected: false, lastError: null }, telegram: { connected: false, lastError: null }, discord: { connected: false, lastError: null }, whatsapp: { connected: false, lastError: null, deliveryMode: "unsupported", requiresRunningSandbox: false } }));
    } else if (req.url === "/api/admin/ssh") {
      res.end(JSON.stringify({ stdout: "smoke-ok\n", stderr: "", exitCode: 0 }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as import("node:net").AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const result = await runCli(["--base-url", baseUrl, "--json-only"]);
    assert.equal(result.code, 0);

    const events = parseEventLines(result.stderr);

    // Must have smoke-start
    const starts = eventsOfType(events, "smoke-start");
    assert.equal(starts.length, 1, "exactly one smoke-start event");
    assert.equal(starts[0].baseUrl, baseUrl);
    assert.equal(starts[0].destructive, false);
    assert.equal(typeof starts[0].timestamp, "string");
    assert.equal(typeof starts[0].timeoutMs, "number");
    assert.equal(typeof starts[0].requestTimeoutMs, "number");
    assert.equal(typeof starts[0].authSource, "string");

    // Must have phase-end for each of the 7 safe phases
    const phaseEnds = eventsOfType(events, "phase-end");
    assert.equal(phaseEnds.length, 8, "8 phase-end events for safe phases");
    for (const pe of phaseEnds) {
      assert.equal(typeof pe.phase, "string");
      assert.equal(typeof pe.passed, "boolean");
      assert.equal(typeof pe.durationMs, "number");
      assert.equal(typeof pe.timestamp, "string");
      // result field should be a full PhaseResult
      const result = pe.result as Record<string, unknown>;
      assert.ok(result, "phase-end must include result");
      assert.equal(typeof result.phase, "string");
      assert.equal(typeof result.passed, "boolean");
      assert.equal(typeof result.durationMs, "number");
    }

    // Must have smoke-finish
    const finishes = eventsOfType(events, "smoke-finish");
    assert.equal(finishes.length, 1, "exactly one smoke-finish event");
    assert.equal(finishes[0].passed, true);
    assert.equal(finishes[0].phaseCount, 8);
    assert.equal(finishes[0].passedCount, 8);
    assert.equal(finishes[0].failedCount, 0);
    assert.equal(typeof finishes[0].totalMs, "number");
    assert.equal(typeof finishes[0].timestamp, "string");

    // No human text in stderr (--json-only)
    assert.ok(!result.stderr.includes("[PASS]"), "no [PASS] in --json-only stderr");
    assert.ok(!result.stderr.includes("[FAIL]"), "no [FAIL] in --json-only stderr");
    assert.ok(!result.stderr.includes("Smoke Report"), "no Smoke Report in --json-only stderr");

    // Every non-noise line in stderr should be parseable JSON.
    // npm/node warnings (e.g. "npm warn ...") may appear from the tsx runner.
    const lines = result.stderr.split("\n").filter((l: string) => {
      const trimmed = l.trim();
      return trimmed.length > 0 && !trimmed.startsWith("npm warn") && !trimmed.startsWith("(node:");
    });
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), `stderr line should be valid JSON: ${line.slice(0, 80)}`);
    }
  } finally {
    server.close();
  }
});

test("event stream: non-json-only mode emits events AND human-readable text", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/health") {
      res.end(JSON.stringify({ ok: true, authMode: "admin-secret", storeBackend: "memory", status: "running", hasSnapshot: false }));
    } else if (req.url === "/api/status") {
      res.end(JSON.stringify({ status: "running", authMode: "admin-secret", storeBackend: "memory" }));
    } else if (req.url === "/gateway" || req.url?.startsWith("/gateway/")) {
      res.end("<html>openclaw-app</html>");
    } else if (req.url === "/api/firewall") {
      res.end(JSON.stringify({ mode: "learning", allowlist: [] }));
    } else if (req.url === "/api/channels/summary") {
      res.end(JSON.stringify({ slack: { connected: false, lastError: null }, telegram: { connected: false, lastError: null }, discord: { connected: false, lastError: null }, whatsapp: { connected: false, lastError: null, deliveryMode: "unsupported", requiresRunningSandbox: false } }));
    } else if (req.url === "/api/admin/ssh") {
      res.end(JSON.stringify({ stdout: "smoke-ok\n", stderr: "", exitCode: 0 }));
    } else if (req.url === "/gateway/v1/chat/completions") {
      res.end(JSON.stringify({ choices: [{ message: { content: "smoke-ok" } }] }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as import("node:net").AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const result = await runCli(["--base-url", baseUrl]);
    assert.equal(result.code, 0);

    const events = parseEventLines(result.stderr);

    // Structured events still present
    assert.equal(eventsOfType(events, "smoke-start").length, 1);
    assert.equal(eventsOfType(events, "phase-end").length, 8);
    assert.equal(eventsOfType(events, "smoke-finish").length, 1);

    // Human-readable text also present
    assert.ok(result.stderr.includes("[PASS]"), "human-readable [PASS] in default mode");
    assert.ok(result.stderr.includes("Smoke Report"), "human-readable summary in default mode");
  } finally {
    server.close();
  }
});

test("event stream: each event line is independently parseable", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/health") {
      // Return a failure to test failure events
      res.end(JSON.stringify({ ok: false }));
    } else if (req.url === "/api/status") {
      res.end(JSON.stringify({ status: "running", authMode: "admin-secret", storeBackend: "memory" }));
    } else if (req.url === "/gateway" || req.url?.startsWith("/gateway/")) {
      res.end("<html>openclaw-app</html>");
    } else if (req.url === "/api/firewall") {
      res.end(JSON.stringify({ mode: "learning", allowlist: [] }));
    } else if (req.url === "/api/channels/summary") {
      res.end(JSON.stringify({ slack: { connected: false, lastError: null }, telegram: { connected: false, lastError: null }, discord: { connected: false, lastError: null }, whatsapp: { connected: false, lastError: null, deliveryMode: "unsupported", requiresRunningSandbox: false } }));
    } else if (req.url === "/api/admin/ssh") {
      res.end(JSON.stringify({ stdout: "smoke-ok\n", stderr: "", exitCode: 0 }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as import("node:net").AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const result = await runCli(["--base-url", baseUrl, "--json-only"]);
    // health fails, so exit code 1
    assert.equal(result.code, 1);

    const events = parseEventLines(result.stderr);

    // smoke-finish should report the failure
    const finish = eventsOfType(events, "smoke-finish");
    assert.equal(finish.length, 1);
    assert.equal(finish[0].passed, false);
    assert.ok((finish[0].failedCount as number) >= 1);

    // The failed phase-end event should carry the full PhaseResult with error
    const healthEnd = eventsOfType(events, "phase-end").find((e) => e.phase === "health");
    assert.ok(healthEnd, "should have phase-end for health");
    assert.equal(healthEnd.passed, false);
    const healthResult = healthEnd.result as Record<string, unknown>;
    assert.ok(healthResult.error, "failed phase result should have error");
    assert.ok(healthResult.errorCode, "failed phase result should have errorCode");
  } finally {
    server.close();
  }
});

test("event stream: phase-end events have correct phase order", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/health") {
      res.end(JSON.stringify({ ok: true, authMode: "admin-secret", storeBackend: "memory", status: "running", hasSnapshot: false }));
    } else if (req.url === "/api/status") {
      res.end(JSON.stringify({ status: "running", authMode: "admin-secret", storeBackend: "memory" }));
    } else if (req.url === "/gateway" || req.url?.startsWith("/gateway/")) {
      res.end("<html>openclaw-app</html>");
    } else if (req.url === "/api/firewall") {
      res.end(JSON.stringify({ mode: "learning", allowlist: [] }));
    } else if (req.url === "/api/channels/summary") {
      res.end(JSON.stringify({ slack: { connected: false, lastError: null }, telegram: { connected: false, lastError: null }, discord: { connected: false, lastError: null }, whatsapp: { connected: false, lastError: null, deliveryMode: "unsupported", requiresRunningSandbox: false } }));
    } else if (req.url === "/api/admin/ssh") {
      res.end(JSON.stringify({ stdout: "smoke-ok\n", stderr: "", exitCode: 0 }));
    } else if (req.url === "/gateway/v1/chat/completions") {
      res.end(JSON.stringify({ choices: [{ message: { content: "smoke-ok" } }] }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as import("node:net").AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const result = await runCli(["--base-url", baseUrl, "--json-only"]);
    assert.equal(result.code, 0);

    const events = parseEventLines(result.stderr);
    const phaseNames = eventsOfType(events, "phase-end").map((e) => e.phase);

    assert.deepEqual(phaseNames, [
      "health",
      "status",
      "gatewayProbe",
      "firewallRead",
      "channelsSummary",
      "sshEcho",
      "chatCompletions",
      "channelRoundTrip",
    ]);
  } finally {
    server.close();
  }
});
