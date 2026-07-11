/**
 * Remote smoke phase functions.
 *
 * Each function hits a live deployed instance over HTTP and returns
 * a structured PhaseResult. No external dependencies — plain fetch().
 */

import { randomUUID } from "node:crypto";

import { authHeaders, getAuthSource as _getAuthSource } from "./remote-auth.js";
import {
  buildSlackSmokePayload,
  buildDiscordSmokePayload,
  buildTelegramSmokePayload,
} from "./remote-crypto.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PhaseResult {
  phase: string;
  passed: boolean;
  durationMs: number;
  detail?: Record<string, unknown>;
  error?: string;
  /** Machine-readable error classification. Present on every failure. */
  errorCode?: string;
  /** The endpoint that was called when the failure occurred. */
  endpoint?: string;
  /** HTTP status code of the failed response, if applicable. */
  httpStatus?: number;
  /** Actionable suggestion for fixing the failure. */
  hint?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default per-request timeout in milliseconds. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function url(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path}`;
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const result = await fn();
  return [result, Math.round(performance.now() - t0)];
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function log(phase: string, msg: string, data?: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), phase, msg, ...data };
  console.error(JSON.stringify(entry));
}

/**
 * Fetch with an AbortController timeout.
 * Rejects with an error containing "timeout" if the request exceeds `timeoutMs`.
 */
function fetchWithTimeout(
  input: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(input, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * Normalize abort/timeout errors to a consistent message and error code.
 */
function classifyError(err: unknown): { message: string; errorCode: string; hint: string } {
  if (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error &&
      (err.name === "AbortError" || err.message.includes("aborted")))
  ) {
    return {
      message: "request timeout (aborted)",
      errorCode: "TIMEOUT",
      hint: "Increase --request-timeout or check if the endpoint is reachable",
    };
  }
  if (err instanceof Error) {
    if (err.message.includes("ECONNREFUSED") || err.message.includes("connect")) {
      return {
        message: err.message,
        errorCode: "CONNECTION_REFUSED",
        hint: "Verify the base URL is correct and the server is running",
      };
    }
    if (err.message.includes("ENOTFOUND") || err.message.includes("getaddrinfo")) {
      return {
        message: err.message,
        errorCode: "DNS_FAILURE",
        hint: "Check the hostname in --base-url",
      };
    }
    return {
      message: err.message,
      errorCode: "FETCH_ERROR",
      hint: "Check network connectivity and server logs",
    };
  }
  return {
    message: String(err),
    errorCode: "UNKNOWN_ERROR",
    hint: "Unexpected error — check stderr logs for details",
  };
}

/** Back-compat wrapper used in polling loop. */
function errorMessage(err: unknown): string {
  return classifyError(err).message;
}

/** Build a failed PhaseResult from a caught exception. */
function failFromError(
  phase: string,
  endpoint: string,
  err: unknown,
): PhaseResult {
  const { message, errorCode, hint } = classifyError(err);
  log(phase, "error", { error: message, errorCode });
  return { phase, passed: false, durationMs: 0, error: message, errorCode, endpoint, hint };
}

/** Build a failed PhaseResult from an unexpected HTTP response. */
function failFromHttp(
  phase: string,
  endpoint: string,
  httpStatus: number,
  error: string,
  opts: { durationMs: number; detail?: Record<string, unknown>; errorCode?: string; hint?: string },
): PhaseResult {
  const errorCode = opts.errorCode ?? (httpStatus === 401 || httpStatus === 403 ? "AUTH_FAILED" : `HTTP_${httpStatus}`);
  const hint = opts.hint ?? (httpStatus === 401 || httpStatus === 403
    ? "Set SMOKE_AUTH_COOKIE or check deployment protection settings"
    : `Endpoint returned HTTP ${httpStatus}`);
  return {
    phase,
    passed: false,
    durationMs: opts.durationMs,
    detail: opts.detail,
    error,
    errorCode,
    endpoint,
    httpStatus,
    hint,
  };
}

// ---------------------------------------------------------------------------
// Centralized response classification
// ---------------------------------------------------------------------------

/** Structured classification of an HTTP response or parse failure. */
export interface ResponseClassification {
  errorCode: string;
  error: string;
  hint: string;
}

/** Detect Vercel Deployment Protection pages before app-level auth. */
function looksLikeVercelProtectionPage(body: string): boolean {
  const lower = body.toLowerCase();
  return (
    lower.includes("__vercel_auth") ||
    lower.includes("authentication required") ||
    lower.includes("x-vercel-protection-bypass") ||
    lower.includes("sign in with vercel")
  );
}

/** Detect app login/sign-in pages returned as 200 instead of expected content. */
function looksLikeLoginPage(body: string): boolean {
  const lower = body.toLowerCase();
  return (
    lower.includes("<form") &&
    (lower.includes("login") ||
      lower.includes("sign in") ||
      lower.includes("password"))
  );
}

/**
 * Classify common HTTP response problems before phase-specific validation.
 * Returns null if no common problem is detected.
 *
 * Handles: 401/403 auth, login HTML detection, unexpected redirects.
 */
export function classifyResponse(
  status: number,
  bodyText: string,
  headers?: { get(name: string): string | null },
): ResponseClassification | null {
  if (status === 401 || status === 403) {
    if (looksLikeVercelProtectionPage(bodyText)) {
      return {
        errorCode: "EDGE_BYPASS_FAILED",
        error: `Vercel Deployment Protection blocked the request (HTTP ${status})`,
        hint: "Set VERCEL_AUTOMATION_BYPASS_SECRET for the target Vercel project or verify it with vercel curl",
      };
    }
    return {
      errorCode: "APP_AUTH_FAILED",
      error: `OpenClaw app authentication failed (HTTP ${status})`,
      hint: "Set SMOKE_ADMIN_SECRET or ADMIN_SECRET for admin-secret mode, or SMOKE_AUTH_COOKIE for sign-in-with-vercel mode",
    };
  }

  if (status >= 300 && status < 400) {
    const location = headers?.get("location") ?? "unknown";
    return {
      errorCode: "UNEXPECTED_REDIRECT",
      error: `Unexpected redirect to ${location} (HTTP ${status})`,
      hint: "Check proxy rewrite rules or deployment protection settings",
    };
  }

  if (looksLikeVercelProtectionPage(bodyText)) {
    return {
      errorCode: "EDGE_BYPASS_FAILED",
      error: "Response is the Vercel Deployment Protection authentication page, not the expected content",
      hint: "Set VERCEL_AUTOMATION_BYPASS_SECRET for the target Vercel project or verify it with vercel curl",
    };
  }

  if (looksLikeLoginPage(bodyText)) {
    return {
      errorCode: "APP_AUTH_FAILED",
      error: "Response is an app login/sign-in page, not the expected content",
      hint: "Set SMOKE_ADMIN_SECRET or ADMIN_SECRET for admin-secret mode, or SMOKE_AUTH_COOKIE for sign-in-with-vercel mode",
    };
  }

  return null;
}

/**
 * Try to parse a response body as a JSON object.
 * Returns the parsed data or a classification for malformed/non-object JSON.
 */
export function parseJsonBody(
  bodyText: string,
): { ok: true; data: Record<string, unknown> } | { ok: false; classification: ResponseClassification } {
  try {
    const data = JSON.parse(bodyText);
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      const kind = data === null ? "null" : Array.isArray(data) ? "array" : typeof data;
      return {
        ok: false,
        classification: {
          errorCode: "MALFORMED_JSON",
          error: `Expected JSON object, got ${kind}`,
          hint: "The endpoint returned valid JSON but not an object — check the API implementation",
        },
      };
    }
    return { ok: true, data: data as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      classification: {
        errorCode: "MALFORMED_JSON",
        error: "Response body is not valid JSON",
        hint: "The endpoint returned non-JSON content — it may be an error page or login redirect",
      },
    };
  }
}

/**
 * Read body as text, run classifyResponse, then parse JSON.
 * Returns a PhaseResult on early failure or the parsed body on success.
 */
function classifyAndParseJson(
  phase: string,
  endpoint: string,
  res: Response,
  bodyText: string,
  durationMs: number,
): PhaseResult | { body: Record<string, unknown> } {
  const c = classifyResponse(res.status, bodyText, res.headers);
  if (c) {
    log(phase, "classified", { errorCode: c.errorCode, httpStatus: res.status });
    return {
      phase, passed: false, durationMs, endpoint,
      httpStatus: res.status, error: c.error, errorCode: c.errorCode, hint: c.hint,
    };
  }
  const p = parseJsonBody(bodyText);
  if (!p.ok) {
    log(phase, "malformed-json", { errorCode: p.classification.errorCode });
    return {
      phase, passed: false, durationMs, endpoint,
      httpStatus: res.status,
      error: p.classification.error,
      errorCode: p.classification.errorCode,
      hint: p.classification.hint,
    };
  }
  return { body: p.data };
}

// ---------------------------------------------------------------------------
// Options shared by all phase functions
// ---------------------------------------------------------------------------

export interface PhaseOptions {
  /** Per-request timeout in milliseconds. Defaults to DEFAULT_REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Safe phases (read-only)
// ---------------------------------------------------------------------------

export async function health(baseUrl: string, opts?: PhaseOptions): Promise<PhaseResult> {
  const phase = "health";
  const endpoint = "/api/health";
  const timeout = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  try {
    // Health is unauthenticated at the app level, but Vercel deployment
    // protection intercepts at the edge. Include bypass headers if available.
    const bypassHdrs = authHeaders();
    const [res, ms] = await timed(() =>
      fetchWithTimeout(url(baseUrl, endpoint), Object.keys(bypassHdrs).length ? { headers: bypassHdrs } : undefined, timeout),
    );
    const bodyText = await res.text();
    const cr = classifyAndParseJson(phase, endpoint, res, bodyText, ms);
    if ("passed" in cr) return cr;
    const body = cr.body;

    const passed = res.ok && body.ok === true;
    log(phase, passed ? "ok" : "failed", { status: res.status, body });
    if (passed) return { phase, passed, durationMs: ms, detail: body, endpoint };
    return failFromHttp(phase, endpoint, res.status, body.ok === false ? "health check returned ok:false" : `unexpected HTTP ${res.status}`, {
      durationMs: ms,
      detail: body,
      errorCode: body.ok === false ? "HEALTH_NOT_OK" : undefined,
      hint: body.ok === false ? "The server is up but reporting unhealthy — check server logs" : undefined,
    });
  } catch (err) {
    return failFromError(phase, endpoint, err);
  }
}

export async function status(baseUrl: string, opts?: PhaseOptions): Promise<PhaseResult> {
  const phase = "status";
  const endpoint = "/api/status";
  const timeout = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  try {
    const hdrs = authHeaders();
    const [res, ms] = await timed(() =>
      fetchWithTimeout(url(baseUrl, endpoint), { headers: hdrs }, timeout),
    );
    const bodyText = await res.text();
    const cr = classifyAndParseJson(phase, endpoint, res, bodyText, ms);
    if ("passed" in cr) return cr;
    const body = cr.body;

    const passed =
      res.ok &&
      typeof body.status === "string" &&
      typeof body.authMode === "string" &&
      typeof body.storeBackend === "string";
    log(phase, passed ? "ok" : "failed", { status: res.status, body });
    if (passed) return { phase, passed, durationMs: ms, detail: body, endpoint };
    const missing = ["status", "authMode", "storeBackend"].filter(k => typeof body[k] !== "string");
    return failFromHttp(phase, endpoint, res.status,
      !res.ok ? `HTTP ${res.status}` : `missing fields: ${missing.join(", ")}`,
      { durationMs: ms, detail: body, errorCode: res.ok ? "MISSING_FIELDS" : undefined, hint: res.ok ? "Status endpoint returned 200 but response is missing expected fields" : undefined },
    );
  } catch (err) {
    return failFromError(phase, endpoint, err);
  }
}

export async function gatewayProbe(baseUrl: string, opts?: PhaseOptions): Promise<PhaseResult> {
  const phase = "gatewayProbe";
  const endpoint = "/gateway";
  const timeout = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  try {
    const hdrs = authHeaders();
    // Follow redirects (e.g. Next.js trailing-slash 308) so we reach the
    // actual gateway HTML rather than classifying the redirect as a failure.
    const [res, ms] = await timed(() =>
      fetchWithTimeout(
        url(baseUrl, endpoint),
        { headers: hdrs },
        timeout,
      ),
    );
    const text = await res.text();

    // Centralized classification for auth/redirect/login-page
    const classified = classifyResponse(res.status, text, res.headers);
    if (classified) {
      log(phase, "classified", { errorCode: classified.errorCode, httpStatus: res.status });
      return {
        phase, passed: false, durationMs: ms, endpoint,
        httpStatus: res.status, error: classified.error, errorCode: classified.errorCode, hint: classified.hint,
      };
    }

    const hasMarker = text.includes("openclaw-app");
    const isWaitingPage = res.status === 202 || text.includes("waiting");

    const passed =
      (res.status === 200 && hasMarker) || res.status === 202;

    const detail: Record<string, unknown> = {
      httpStatus: res.status,
      bodyLength: text.length,
      hasMarker,
      isWaitingPage,
      ...(res.status === 200 && !hasMarker
        ? { expected: "body containing 'openclaw-app'", found: "200 without marker" }
        : {}),
    };

    if (passed) {
      log(phase, "ok", detail);
      return { phase, passed, durationMs: ms, detail, endpoint };
    }

    const error =
      res.status === 200 && !hasMarker
        ? "200 response missing 'openclaw-app' marker — may not be the real gateway"
        : `unexpected HTTP ${res.status}`;
    const errorCode =
      res.status === 200 && !hasMarker ? "MISSING_MARKER" : `HTTP_${res.status}`;
    const hint =
      res.status === 200 && !hasMarker
        ? "The response body should contain 'openclaw-app' — the proxy may be serving a different page"
        : `Gateway returned HTTP ${res.status}`;

    log(phase, "failed", detail);
    return { phase, passed, durationMs: ms, detail, error, errorCode, endpoint, httpStatus: res.status, hint };
  } catch (err) {
    return failFromError(phase, endpoint, err);
  }
}

export async function firewallRead(baseUrl: string, opts?: PhaseOptions): Promise<PhaseResult> {
  const phase = "firewallRead";
  const endpoint = "/api/firewall";
  const timeout = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  try {
    const hdrs = authHeaders();
    const [res, ms] = await timed(() =>
      fetchWithTimeout(url(baseUrl, endpoint), { headers: hdrs }, timeout),
    );
    const bodyText = await res.text();
    const cr = classifyAndParseJson(phase, endpoint, res, bodyText, ms);
    if ("passed" in cr) return cr;
    const body = cr.body;

    const passed =
      res.ok &&
      typeof body.mode === "string" &&
      Array.isArray(body.allowlist);
    log(phase, passed ? "ok" : "failed", { status: res.status, body });
    if (passed) return { phase, passed, durationMs: ms, detail: body, endpoint };
    const missing = [
      typeof body.mode !== "string" && "mode",
      !Array.isArray(body.allowlist) && "allowlist",
    ].filter(Boolean);
    return failFromHttp(phase, endpoint, res.status,
      !res.ok ? `HTTP ${res.status}` : `missing fields: ${missing.join(", ")}`,
      { durationMs: ms, detail: body, errorCode: res.ok ? "MISSING_FIELDS" : undefined, hint: res.ok ? "Firewall endpoint responded but is missing expected fields" : undefined },
    );
  } catch (err) {
    return failFromError(phase, endpoint, err);
  }
}

export async function channelsSummary(baseUrl: string, opts?: PhaseOptions): Promise<PhaseResult> {
  const phase = "channelsSummary";
  const endpoint = "/api/channels/summary";
  const timeout = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  try {
    const hdrs = authHeaders();
    const [res, ms] = await timed(() =>
      fetchWithTimeout(url(baseUrl, endpoint), { headers: hdrs }, timeout),
    );
    const bodyText = await res.text();
    const cr = classifyAndParseJson(phase, endpoint, res, bodyText, ms);
    if ("passed" in cr) return cr;
    const body = cr.body;

    const passed = res.ok;
    log(phase, passed ? "ok" : "failed", { status: res.status, body });
    if (passed) return { phase, passed, durationMs: ms, detail: body, endpoint };
    return failFromHttp(phase, endpoint, res.status,
      `HTTP ${res.status}`,
      { durationMs: ms, detail: body },
    );
  } catch (err) {
    return failFromError(phase, endpoint, err);
  }
}

export async function sshEcho(baseUrl: string, opts?: PhaseOptions): Promise<PhaseResult> {
  const phase = "sshEcho";
  const endpoint = "/api/admin/ssh";
  const timeout = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  try {
    const hdrs = { ...authHeaders({ mutation: true }), "Content-Type": "application/json" };
    const [res, ms] = await timed(() =>
      fetchWithTimeout(
        url(baseUrl, endpoint),
        {
          method: "POST",
          headers: hdrs,
          body: JSON.stringify({ command: "echo", args: ["smoke-ok"] }),
        },
        timeout,
      ),
    );
    const bodyText = await res.text();
    const cr = classifyAndParseJson(phase, endpoint, res, bodyText, ms);
    if ("passed" in cr) return cr;
    const body = cr.body;

    const passed =
      res.ok &&
      typeof body.stdout === "string" &&
      (body.stdout as string).includes("smoke-ok");
    log(phase, passed ? "ok" : "failed", { status: res.status, body });
    if (passed) return { phase, passed, durationMs: ms, detail: body, endpoint };
    if (!res.ok) {
      return failFromHttp(phase, endpoint, res.status, `HTTP ${res.status}`, { durationMs: ms, detail: body });
    }
    return {
      phase, passed: false, durationMs: ms, detail: body, endpoint,
      error: "stdout missing 'smoke-ok' marker",
      errorCode: "ECHO_MISMATCH",
      hint: "SSH echo command ran but output did not contain expected marker",
    };
  } catch (err) {
    return failFromError(phase, endpoint, err);
  }
}

// ---------------------------------------------------------------------------
// Test channel configuration
// ---------------------------------------------------------------------------

const SMOKE_CONFIG_RETRY_WINDOW_MS = 6_000;
const SMOKE_CONFIG_RETRY_MAX_DELAY_MS = 1_000;

/**
 * Configure test channels with generated credentials (bypasses platform API
 * validation). Returns an opaque cleanup token for only the configs created.
 */
async function configureTestChannels(
  baseUrl: string,
  requestTimeoutMs: number,
  channels: SmokeChannel[],
): Promise<{ cleanupToken: string | null; createdChannels: SmokeChannel[] } | null> {
  const ownerId = randomUUID();
  let retryDeadline: number | null = null;
  let delayMs = 100;
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      const hdrs = { ...authHeaders({ mutation: true }), "Content-Type": "application/json" };
      const res = await fetchWithTimeout(
        url(baseUrl, "/api/admin/channel-secrets"),
        {
          method: "PUT",
          headers: hdrs,
          body: JSON.stringify({ channels, ownerId }),
        },
        requestTimeoutMs,
      );
      if (!res.ok) {
        if (res.status !== 409 && res.status < 500) return null;
      } else {
        const body = (await res.json()) as {
          cleanupToken?: unknown;
          createdChannels?: unknown;
          recoveredChannels?: unknown;
          preservedChannels?: unknown;
        };
        const ownershipShapeValid =
          Array.isArray(body.createdChannels) &&
          Array.isArray(body.recoveredChannels) &&
          Array.isArray(body.preservedChannels);
        const createdChannels = Array.isArray(body.createdChannels)
          ? body.createdChannels.filter(isSmokeChannel)
          : [];
        const recoveredChannels = Array.isArray(body.recoveredChannels)
          ? body.recoveredChannels.filter(isSmokeChannel)
          : [];
        const cleanupToken =
          typeof body.cleanupToken === "string" ? body.cleanupToken : null;
        if (
          ownershipShapeValid &&
          cleanupToken !== null ||
          (ownershipShapeValid &&
            createdChannels.length === 0 &&
            recoveredChannels.length === 0)
        ) {
          return {
            cleanupToken,
            createdChannels,
          };
        }
      }
    } catch {
      // The request may have committed before its response was lost. Retry
      // with the same owner until the server lock can expire or be released.
    }
    retryDeadline ??= Date.now() + SMOKE_CONFIG_RETRY_WINDOW_MS;
    if (attempts >= 3 && Date.now() >= retryDeadline) return null;
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, SMOKE_CONFIG_RETRY_MAX_DELAY_MS);
  }
}

/**
 * Remove test channel configurations.
 */
async function removeTestChannels(
  baseUrl: string,
  requestTimeoutMs: number,
  cleanupToken: string,
): Promise<boolean> {
  let retryDeadline: number | null = null;
  let delayMs = 100;
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      const hdrs = { ...authHeaders({ mutation: true }), "Content-Type": "application/json" };
      const response = await fetchWithTimeout(
        url(baseUrl, "/api/admin/channel-secrets"),
        {
          method: "DELETE",
          headers: hdrs,
          body: JSON.stringify({ cleanupToken }),
        },
        requestTimeoutMs,
      );
      if (response.ok) return true;
      if (response.status !== 409 && response.status < 500) return false;
    } catch {
      // DELETE is idempotent for an owner token; retry ambiguous responses.
    }
    retryDeadline ??= Date.now() + SMOKE_CONFIG_RETRY_WINDOW_MS;
    if (attempts >= 3 && Date.now() >= retryDeadline) return false;
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, SMOKE_CONFIG_RETRY_MAX_DELAY_MS);
  }
}

// ---------------------------------------------------------------------------
// Server-side channel webhook signing
// ---------------------------------------------------------------------------

/**
 * Ask the server to sign and send a webhook payload for the given channel.
 * The server constructs the signed request and POSTs it to the local webhook
 * endpoint — raw secrets never leave the server.
 *
 * Returns admission status and an exact delivery ID, or null if the endpoint
 * is unreachable.
 */
type SmokeChannel = "slack" | "telegram" | "discord";

function isSmokeChannel(value: unknown): value is SmokeChannel {
  return value === "slack" || value === "telegram" || value === "discord";
}

type SmokeDispatchResult = {
  configured: boolean;
  sent: boolean;
  webhookAccepted?: boolean;
  status?: number;
  deliveryId?: string | null;
};

type SmokeDispatchMap = Record<SmokeChannel, SmokeDispatchResult | null>;

function attemptedSmokeDispatches(
  dispatches: SmokeDispatchMap,
): Array<[SmokeChannel, SmokeDispatchResult | null]> {
  return (Object.entries(dispatches) as Array<
    [SmokeChannel, SmokeDispatchResult | null]
  >).filter(([, result]) => result === null || result.configured === true);
}

async function sendSmokeWebhook(
  baseUrl: string,
  channel: SmokeChannel,
  payloadBody: string,
  requestTimeoutMs: number,
): Promise<SmokeDispatchResult | null> {
  try {
    const hdrs = { ...authHeaders({ mutation: true }), "Content-Type": "application/json" };
    const res = await fetchWithTimeout(
      url(baseUrl, "/api/admin/channel-secrets"),
      {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({ channel, body: payloadBody }),
      },
      requestTimeoutMs,
    );
    if (!res.ok) return null;
    return (await res.json()) as SmokeDispatchResult;
  } catch {
    return null;
  }
}

type RemoteChannelDeliveryState = {
  deliveryId?: string | null;
  state?: string;
  terminal?: boolean;
  native?: {
    ok?: boolean;
    classification?: string | null;
  } | null;
  reply?: { status?: string } | null;
};

type RemoteChannelSummary = Record<
  string,
  {
    connected: boolean;
    lastError: string | null;
    lastDeliveryState?: RemoteChannelDeliveryState | null;
  } | null
>;

async function fetchChannelSummary(
  baseUrl: string,
  requestTimeoutMs: number,
): Promise<RemoteChannelSummary | null> {
  try {
    const hdrs = authHeaders();
    const res = await fetchWithTimeout(
      url(baseUrl, "/api/channels/summary"),
      { headers: hdrs },
      requestTimeoutMs,
    );
    if (!res.ok) return null;
    return (await res.json()) as RemoteChannelSummary;
  } catch {
    return null;
  }
}

type WakeChannel = "slack" | "telegram";

function selectWakeChannel(
  summary: Record<string, { connected?: boolean } | null> | null,
): WakeChannel | null {
  if (!summary) return null;
  for (const channel of ["slack", "telegram"] as const) {
    if (summary[channel]?.connected === true) return channel;
  }
  return null;
}

type NativeAcceptanceProbe = {
  accepted: boolean;
  deliveryId: string;
  state: string | null;
  nativeClassification: string | null;
  replyObserved: boolean;
  timedOut: boolean;
  durationMs: number;
};

async function pollNativeAcceptance(input: {
  baseUrl: string;
  channel: SmokeChannel;
  deliveryId: string;
  timeoutMs: number;
  requestTimeoutMs: number;
}): Promise<NativeAcceptanceProbe> {
  const startedAt = Date.now();
  const deadline = startedAt + input.timeoutMs;
  let lastState: RemoteChannelDeliveryState | null = null;

  while (Date.now() < deadline) {
    const summary = await fetchChannelSummary(
      input.baseUrl,
      input.requestTimeoutMs,
    );
    const candidate = summary?.[input.channel]?.lastDeliveryState ?? null;
    if (candidate?.deliveryId === input.deliveryId) {
      lastState = candidate;
      const accepted =
        candidate.native?.ok === true &&
        candidate.native.classification === "accepted";
      if (accepted || candidate.terminal === true) {
        return {
          accepted,
          deliveryId: input.deliveryId,
          state: candidate.state ?? null,
          nativeClassification: candidate.native?.classification ?? null,
          replyObserved: candidate.reply?.status === "observed",
          timedOut: false,
          durationMs: Date.now() - startedAt,
        };
      }
    }
    await sleep(1_000);
  }

  return {
    accepted: false,
    deliveryId: input.deliveryId,
    state: lastState?.state ?? null,
    nativeClassification: lastState?.native?.classification ?? null,
    replyObserved: lastState?.reply?.status === "observed",
    timedOut: true,
    durationMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Channel native-acceptance phase. Reply visibility requires a real observer.
// ---------------------------------------------------------------------------

export async function channelRoundTrip(baseUrl: string, opts?: PhaseOptions & { pollTimeoutMs?: number }): Promise<PhaseResult> {
  const phase = "channelRoundTrip";
  const endpoint = "/api/admin/channel-secrets";
  const reqTimeout = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pollTimeoutMs = opts?.pollTimeoutMs ?? 120_000;

  let cleanupToken: string | null = null;

  const result = await (async (): Promise<PhaseResult> => {
    try {
    const dispatch = async (): Promise<SmokeDispatchMap> => {
      const [slack, telegram, discord] = await Promise.all([
        sendSmokeWebhook(
          baseUrl,
          "slack",
          buildSlackSmokePayload().body,
          reqTimeout,
        ),
        sendSmokeWebhook(
          baseUrl,
          "telegram",
          buildTelegramSmokePayload(),
          reqTimeout,
        ),
        sendSmokeWebhook(
          baseUrl,
          "discord",
          buildDiscordSmokePayload(),
          reqTimeout,
        ),
      ]);
      return { slack, telegram, discord };
    };

    let dispatches = await dispatch();
    if (Object.values(dispatches).every((result) => result === null)) {
      const summary = await fetchChannelSummary(baseUrl, reqTimeout);
      const noConfiguredChannels = summary !== null &&
        (["slack", "telegram", "discord"] as const).every(
          (channel) => summary[channel]?.connected === false,
        );
      if (noConfiguredChannels) {
        log(phase, "skipped", { reason: "no-configured-channels" });
        return {
          phase, passed: true, durationMs: 0, endpoint,
          detail: { skipped: true, reason: "No channels are configured" },
        };
      }
      log(phase, "send-failed", { reason: "smoke-webhook-endpoint-unavailable" });
      return {
        phase, passed: false, durationMs: 0, endpoint,
        error: "Could not reach the smoke webhook endpoint for any channel",
        errorCode: "WEBHOOK_SEND_FAILED",
        detail: { dispatches },
      };
    }

    let attemptedDispatches = attemptedSmokeDispatches(dispatches);

    if (attemptedDispatches.length === 0) {
      const noneConfigured = Object.values(dispatches).every(
        (result) => result?.configured === false,
      );
      if (noneConfigured) {
        log(phase, "auto-configuring", { reason: "no-channels-configured" });
        const setup = await configureTestChannels(
          baseUrl,
          reqTimeout,
          ["slack", "telegram", "discord"],
        );
        if (!setup) {
          log(phase, "failed", { reason: "auto-configure-failed" });
          return {
            phase,
            passed: false,
            durationMs: 0,
            endpoint,
            error: "Smoke channel setup failed or its result was ambiguous",
            errorCode: "TEST_CHANNEL_SETUP_FAILED",
            hint: "Retry with the same owner ID or remove any owned synthetic channel config before continuing",
          };
        }
        cleanupToken = setup.cleanupToken;
        dispatches = await dispatch();
        attemptedDispatches = attemptedSmokeDispatches(dispatches);
      }

      if (attemptedDispatches.length === 0) {
        log(phase, "send-failed", dispatches);
        return {
          phase, passed: false, durationMs: 0, endpoint,
          error: "Failed to send smoke webhooks",
          errorCode: "WEBHOOK_SEND_FAILED",
          detail: dispatches,
        };
      }
    }

    const t0 = performance.now();
    const channelResults = await Promise.all(
      attemptedDispatches.map(async ([channel, dispatchResult]) => {
        if (!dispatchResult) {
          return {
            channel,
            deliveryId: null,
            webhookAccepted: false,
            nativeAccepted: false,
            nativeClassification: null,
            deliveryState: null,
            replyObserved: false,
            timedOut: false,
            durationMs: 0,
            error: "Smoke dispatch endpoint did not return a successful response.",
          };
        }
        if (dispatchResult.webhookAccepted !== true) {
          return {
            channel,
            deliveryId: dispatchResult.deliveryId ?? null,
            webhookAccepted: false,
            nativeAccepted: false,
            nativeClassification: null,
            deliveryState: null,
            replyObserved: false,
            timedOut: false,
            durationMs: 0,
            error: `Host webhook rejected the smoke delivery (HTTP ${dispatchResult.status ?? "unknown"}).`,
          };
        }
        const deliveryId = dispatchResult.deliveryId ?? null;
        if (!deliveryId) {
          return {
            channel,
            deliveryId,
            webhookAccepted: true,
            nativeAccepted: false,
            nativeClassification: null,
            deliveryState: null,
            replyObserved: false,
            timedOut: false,
            durationMs: 0,
            error: "Smoke webhook did not return a deliveryId.",
          };
        }
        const probe = await pollNativeAcceptance({
          baseUrl,
          channel,
          deliveryId,
          timeoutMs: pollTimeoutMs,
          requestTimeoutMs: reqTimeout,
        });
        return {
          channel,
          deliveryId,
          webhookAccepted: true,
          nativeAccepted: probe.accepted,
          nativeClassification: probe.nativeClassification,
          deliveryState: probe.state,
          replyObserved: probe.replyObserved,
          timedOut: probe.timedOut,
          durationMs: probe.durationMs,
        };
      }),
    );
    const totalMs = Math.round(performance.now() - t0);
    const passed =
      channelResults.length > 0 &&
      channelResults.every((result) => result.nativeAccepted);

    log(phase, passed ? "ok" : "failed", {
      channelResults,
      autoConfigured: cleanupToken !== null,
    });

    return {
      phase, passed, durationMs: totalMs, endpoint: "/api/channels/*/webhook",
      detail: { channels: channelResults, autoConfigured: cleanupToken !== null },
      ...(!passed ? {
        error: "Native acceptance was not observed for every smoke delivery",
        errorCode: "NATIVE_ACCEPTANCE_NOT_OBSERVED",
        hint: "Inspect the exact delivery IDs in /api/channels/summary; reply visibility is a separate proof surface",
      } : {}),
    };
    } catch (err) {
      return failFromError(phase, endpoint, err);
    }
  })();
  if (cleanupToken) {
    const removed = await removeTestChannels(baseUrl, reqTimeout, cleanupToken);
    log(phase, removed ? "test-channels-removed" : "test-channel-cleanup-failed", {});
    if (!removed) {
      return {
        phase,
        passed: false,
        durationMs: result.durationMs,
        endpoint,
        error: "Smoke channel cleanup failed after the round-trip phase",
        errorCode: "TEST_CHANNEL_CLEANUP_FAILED",
        hint: "Retry cleanup with the same owner token before trusting this smoke run",
        detail: { originalResult: result },
      };
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Channel wake-from-sleep phase (destructive: stop → webhook → verify wake)
// ---------------------------------------------------------------------------

export async function channelWakeFromSleep(
  baseUrl: string,
  timeoutMs = 120_000,
  opts?: PhaseOptions,
): Promise<PhaseResult> {
  const phase = "channelWakeFromSleep";
  const endpoint = "/api/channels/*/webhook";
  const reqTimeout = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  let cleanupToken: string | null = null;

  const result = await (async (): Promise<PhaseResult> => {
    try {
    // 1. Read channel configuration without delivering fake webhooks.
    let wakeChannel = selectWakeChannel(await fetchChannelSummary(baseUrl, reqTimeout));

    if (!wakeChannel) {
      // Auto-configure test channels
      log(phase, "auto-configuring", { reason: "no-wake-channel-configured" });
      const setup = await configureTestChannels(
        baseUrl,
        reqTimeout,
        ["slack", "telegram"],
      );
      if (!setup) {
        log(phase, "failed", { reason: "auto-configure-failed" });
        return {
          phase,
          passed: false,
          durationMs: 0,
          endpoint,
          error: "Wake-channel smoke setup failed or its result was ambiguous",
          errorCode: "TEST_CHANNEL_SETUP_FAILED",
          hint: "Retry with the same owner ID or remove any owned synthetic channel config before continuing",
        };
      }
      cleanupToken = setup.cleanupToken;
      wakeChannel = selectWakeChannel(await fetchChannelSummary(baseUrl, reqTimeout));
      if (!wakeChannel) {
        log(phase, "failed", { reason: "still-not-configured-after-auto" });
        return {
          phase,
          passed: false,
          durationMs: 0,
          endpoint,
          error: "Wake-capable channels were not configured after setup",
          errorCode: "TEST_CHANNEL_SETUP_FAILED",
        };
      }
    }

    const t0 = performance.now();

    // 2. Verify sandbox is stopped
    const statusRes = await fetchWithTimeout(
      url(baseUrl, "/api/status"),
      { headers: authHeaders() },
      reqTimeout,
    );
    const statusBody = (await statusRes.json()) as Record<string, unknown>;
    if (statusBody.status === "running") {
      // Stop it first
      log(phase, "stopping-sandbox", {});
      const stopRes = await fetchWithTimeout(
        url(baseUrl, "/api/admin/snapshot"),
        { method: "POST", headers: { ...authHeaders({ mutation: true }), "Content-Type": "application/json" }, body: "{}" },
        reqTimeout,
      );
      if (!stopRes.ok) {
        return failFromHttp(phase, "/api/admin/snapshot", stopRes.status, "Failed to stop sandbox for wake test", {
          durationMs: Math.round(performance.now() - t0),
        });
      }
      log(phase, "sandbox-stopped", {});
    }

    // 3. Send webhook while sandbox is stopped (signed + sent server-side)
    log(phase, "sending-webhook-while-stopped", { channel: wakeChannel });
    const wakePayload =
      wakeChannel === "slack"
        ? buildSlackSmokePayload().body
        : buildTelegramSmokePayload();
    const wakeResult = await sendSmokeWebhook(
      baseUrl,
      wakeChannel,
      wakePayload,
      reqTimeout,
    );
    if (!wakeResult?.webhookAccepted) {
      return {
        phase, passed: false, durationMs: Math.round(performance.now() - t0), endpoint,
        error: `Failed to send ${wakeChannel} webhook (status: ${wakeResult?.status ?? "unknown"})`,
        errorCode: "WEBHOOK_SEND_FAILED",
        hint: `Check ${wakeChannel} channel configuration`,
      };
    }

    // 4. Poll until sandbox wakes up (workflow handles delivery internally)
    const deadline = Date.now() + timeoutMs;
    let delay = 3_000;
    let sandboxRunning = false;

    while (Date.now() < deadline) {
      await sleep(delay);

      // Check status
      try {
        const res = await fetchWithTimeout(
          url(baseUrl, "/api/status"),
          { headers: authHeaders() },
          reqTimeout,
        );
        const body = (await res.json()) as Record<string, unknown>;
        if (body.status === "running") {
          if (!sandboxRunning) {
            log(phase, "sandbox-woke-up", { elapsedMs: Math.round(performance.now() - t0) });
          }
          sandboxRunning = true;
          break;
        }
        log(phase, "poll", { status: body.status, sandboxRunning });
      } catch {
        // ignore fetch errors during polling
      }

      delay = Math.min(delay * 1.3, 10_000);
    }

    const totalMs = Math.round(performance.now() - t0);

    if (!sandboxRunning) {
      return {
        phase, passed: false, durationMs: totalMs, endpoint,
        error: "Sandbox did not wake up within timeout",
        errorCode: "WAKE_TIMEOUT",
        hint: "The channel webhook was sent but the sandbox did not reach 'running' — increase --timeout",
      };
    }

    if (!wakeResult.deliveryId) {
      return {
        phase,
        passed: false,
        durationMs: totalMs,
        endpoint,
        error: "Wake webhook did not return a deliveryId",
        errorCode: "DELIVERY_ID_MISSING",
        hint: "Deploy a channel-secrets endpoint that returns exact delivery correlation IDs",
      };
    }

    const remainingMs = Math.max(1_000, timeoutMs - totalMs);
    const acceptance = await pollNativeAcceptance({
      baseUrl,
      channel: wakeChannel,
      deliveryId: wakeResult.deliveryId,
      timeoutMs: remainingMs,
      requestTimeoutMs: reqTimeout,
    });
    const completedMs = Math.round(performance.now() - t0);
    if (!acceptance.accepted) {
      return {
        phase,
        passed: false,
        durationMs: completedMs,
        endpoint,
        error: "Sandbox woke, but native acceptance was not observed for the wake delivery",
        errorCode: "NATIVE_ACCEPTANCE_NOT_OBSERVED",
        hint: "Inspect the exact deliveryId in /api/channels/summary; do not infer acceptance from sandbox status",
        detail: {
          sandboxWokeUp: true,
          wakeChannel,
          ...acceptance,
        },
      };
    }

    return {
      phase, passed: true, durationMs: completedMs, endpoint,
      detail: {
        sandboxWokeUp: true,
        nativeAccepted: true,
        replyObserved: acceptance.replyObserved,
        deliveryId: acceptance.deliveryId,
        deliveryState: acceptance.state,
        autoConfigured: cleanupToken !== null,
        wakeChannel,
      },
    };
    } catch (err) {
      return failFromError(phase, endpoint, err);
    }
  })();
  if (cleanupToken) {
    const removed = await removeTestChannels(baseUrl, reqTimeout, cleanupToken);
    log(phase, removed ? "test-channels-removed" : "test-channel-cleanup-failed", {});
    if (!removed) {
      return {
        phase,
        passed: false,
        durationMs: result.durationMs,
        endpoint,
        error: "Smoke channel cleanup failed after the wake phase",
        errorCode: "TEST_CHANNEL_CLEANUP_FAILED",
        hint: "Retry cleanup with the same owner token before trusting this smoke run",
        detail: { originalResult: result },
      };
    }
  }
  return result;
}

export async function chatCompletions(baseUrl: string, opts?: PhaseOptions): Promise<PhaseResult> {
  const phase = "chatCompletions";
  const endpoint = "/gateway/v1/chat/completions";
  const timeout = opts?.requestTimeoutMs ?? 60_000; // LLM responses can be slow
  try {
    const hdrs = {
      ...authHeaders({ mutation: true }),
      "Content-Type": "application/json",
    };
    const body = JSON.stringify({
      model: "openclaw",
      messages: [{ role: "user", content: "Reply with exactly: smoke-ok" }],
      stream: false,
    });

    const [res, ms] = await timed(() =>
      fetchWithTimeout(url(baseUrl, endpoint), { method: "POST", headers: hdrs, body }, timeout),
    );

    const bodyText = await res.text();

    // Check for auth/redirect issues first
    const classified = classifyResponse(res.status, bodyText, res.headers);
    if (classified) {
      log(phase, "classified", { errorCode: classified.errorCode, httpStatus: res.status });
      return {
        phase, passed: false, durationMs: ms, endpoint,
        httpStatus: res.status, error: classified.error, errorCode: classified.errorCode, hint: classified.hint,
      };
    }

    // 202 = waiting page (sandbox not ready yet)
    if (res.status === 202) {
      log(phase, "waiting", { status: 202 });
      return {
        phase, passed: false, durationMs: ms, endpoint,
        httpStatus: 202,
        error: "Sandbox not ready — gateway returned waiting page",
        errorCode: "SANDBOX_NOT_READY",
        hint: "Run with --destructive to ensure the sandbox is running first, or wait for bootstrap to complete",
      };
    }

    if (!res.ok) {
      log(phase, "failed", { status: res.status, body: bodyText.slice(0, 500) });
      return failFromHttp(phase, endpoint, res.status, `HTTP ${res.status}`, {
        durationMs: ms,
        detail: { bodyPreview: bodyText.slice(0, 500) },
      });
    }

    // Try to parse as OpenAI-compatible response
    const parsed = parseJsonBody(bodyText);
    if (!parsed.ok) {
      // Non-JSON response — could be streaming or HTML
      const hasContent = bodyText.length > 10;
      log(phase, hasContent ? "non-json-response" : "empty-response", { bodyLength: bodyText.length });
      return {
        phase,
        passed: hasContent, // pass if we got any substantial response
        durationMs: ms,
        endpoint,
        detail: {
          bodyLength: bodyText.length,
          bodyPreview: bodyText.slice(0, 200),
          format: "non-json",
        },
        ...(hasContent ? {} : {
          error: "Empty response from completions endpoint",
          errorCode: "EMPTY_RESPONSE",
          hint: "OpenClaw may not be fully bootstrapped or the model is not responding",
        }),
      };
    }

    const data = parsed.data;

    // OpenAI format: { choices: [{ message: { content: "..." } }] }
    const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
    const content = choices?.[0]?.message?.content ?? "";
    const hasContent = content.length > 0;

    log(phase, hasContent ? "ok" : "empty-content", {
      status: res.status,
      contentLength: content.length,
      contentPreview: content.slice(0, 200),
      model: data.model,
    });

    return {
      phase,
      passed: hasContent,
      durationMs: ms,
      endpoint,
      detail: {
        model: data.model,
        contentLength: content.length,
        contentPreview: content.slice(0, 200),
        ...(data.usage ? { usage: data.usage } : {}),
      },
      ...(hasContent ? {} : {
        error: "Completions response had no content",
        errorCode: "EMPTY_CONTENT",
        hint: "The endpoint responded with valid JSON but the assistant message was empty",
      }),
    };
  } catch (err) {
    return failFromError(phase, endpoint, err);
  }
}

// ---------------------------------------------------------------------------
// Destructive phases (opt-in)
// ---------------------------------------------------------------------------

const POLL_INITIAL_MS = 2_000;
const POLL_MAX_MS = 10_000;
const POLL_BACKOFF = 1.5;

async function pollUntilRunning(
  baseUrl: string,
  timeoutMs: number,
  requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<{ running: boolean; lastBody: Record<string, unknown> | null }> {
  const deadline = Date.now() + timeoutMs;
  let delay = POLL_INITIAL_MS;
  let lastBody: Record<string, unknown> | null = null;

  while (Date.now() < deadline) {
    await sleep(delay);
    try {
      const hdrs = authHeaders();
      const res = await fetchWithTimeout(
        url(baseUrl, "/api/status"),
        { headers: hdrs },
        requestTimeoutMs,
      );
      const body = (await res.json()) as Record<string, unknown>;
      lastBody = body;
      log("poll", "status", { status: body.status });
      if (body.status === "running") return { running: true, lastBody };
      if (body.status === "error") return { running: false, lastBody };
    } catch (err) {
      log("poll", "fetch-error", { error: errorMessage(err) });
    }
    delay = Math.min(delay * POLL_BACKOFF, POLL_MAX_MS);
  }

  return { running: false, lastBody };
}

export async function ensureRunning(
  baseUrl: string,
  timeoutMs = 120_000,
  opts?: PhaseOptions,
): Promise<PhaseResult> {
  const phase = "ensureRunning";
  const endpoint = "/api/admin/ensure";
  const reqTimeout = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  try {
    const hdrs = { ...authHeaders({ mutation: true }), "Content-Type": "application/json" };
    const [res, fetchMs] = await timed(() =>
      fetchWithTimeout(
        url(baseUrl, endpoint),
        { method: "POST", headers: hdrs, body: "{}" },
        reqTimeout,
      ),
    );
    const bodyText = await res.text();
    const cr = classifyAndParseJson(phase, endpoint, res, bodyText, fetchMs);
    if ("passed" in cr) return cr;
    const body = cr.body;
    log(phase, "initial-response", { status: res.status, body });

    if (res.status === 200 && body.state === "running") {
      return { phase, passed: true, durationMs: fetchMs, detail: body, endpoint };
    }

    if (res.status === 202) {
      const [poll, pollMs] = await timed(() =>
        pollUntilRunning(baseUrl, timeoutMs, reqTimeout),
      );
      const totalMs = fetchMs + pollMs;
      if (poll.running) {
        log(phase, "running-after-poll", { totalMs });
        return {
          phase,
          passed: true,
          durationMs: totalMs,
          detail: poll.lastBody ?? body,
          endpoint,
        };
      }
      log(phase, "timeout", { totalMs, lastBody: poll.lastBody });
      return {
        phase, passed: false, durationMs: totalMs,
        detail: poll.lastBody ?? body,
        error: "Timed out waiting for running state",
        errorCode: "POLL_TIMEOUT",
        endpoint,
        hint: "Sandbox did not reach 'running' within the timeout — increase --timeout or check sandbox logs",
      };
    }

    return failFromHttp(phase, endpoint, res.status, `Unexpected status ${res.status}`, {
      durationMs: fetchMs, detail: body,
    });
  } catch (err) {
    return failFromError(phase, endpoint, err);
  }
}

export async function snapshotStop(baseUrl: string, opts?: PhaseOptions): Promise<PhaseResult> {
  const phase = "snapshotStop";
  const endpoint = "/api/admin/snapshot";
  const timeout = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  try {
    const hdrs = { ...authHeaders({ mutation: true }), "Content-Type": "application/json" };
    const [res, ms] = await timed(() =>
      fetchWithTimeout(
        url(baseUrl, endpoint),
        { method: "POST", headers: hdrs, body: "{}" },
        timeout,
      ),
    );
    const bodyText = await res.text();
    const cr = classifyAndParseJson(phase, endpoint, res, bodyText, ms);
    if ("passed" in cr) return cr;
    const body = cr.body;

    const passed = res.ok && typeof body.snapshotId === "string";
    log(phase, passed ? "ok" : "failed", { status: res.status, body });
    if (passed) return { phase, passed, durationMs: ms, detail: body, endpoint };
    if (!res.ok) {
      return failFromHttp(phase, endpoint, res.status, `HTTP ${res.status}`, { durationMs: ms, detail: body });
    }
    return {
      phase, passed: false, durationMs: ms, detail: body, endpoint,
      error: "Response missing snapshotId field",
      errorCode: "MISSING_SNAPSHOT_ID",
      hint: "Snapshot endpoint returned 200 but no snapshotId — the sandbox may not have been running",
    };
  } catch (err) {
    return failFromError(phase, endpoint, err);
  }
}

export async function restoreFromSnapshot(
  baseUrl: string,
  snapshotId?: string,
  timeoutMs = 120_000,
  opts?: PhaseOptions,
): Promise<PhaseResult> {
  const phase = "restoreFromSnapshot";
  const endpoint = "/api/admin/snapshots/restore";
  const reqTimeout = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  try {
    // If no snapshotId provided, read it from status
    let sid = snapshotId;
    if (!sid) {
      const hdrs = authHeaders();
      const statusRes = await fetchWithTimeout(
        url(baseUrl, "/api/status"),
        { headers: hdrs },
        reqTimeout,
      );
      const statusText = await statusRes.text();
      const statusCr = classifyAndParseJson(phase, "/api/status", statusRes, statusText, 0);
      if ("passed" in statusCr) return statusCr;
      sid = statusCr.body.snapshotId as string | undefined;
      if (!sid) {
        return {
          phase, passed: false, durationMs: 0, endpoint,
          error: "No snapshotId available for restore",
          errorCode: "NO_SNAPSHOT_ID",
          hint: "Run snapshotStop first or ensure status returns a snapshotId",
        };
      }
    }

    const hdrs = { ...authHeaders({ mutation: true }), "Content-Type": "application/json" };
    const [res, fetchMs] = await timed(() =>
      fetchWithTimeout(
        url(baseUrl, endpoint),
        { method: "POST", headers: hdrs, body: JSON.stringify({ snapshotId: sid }) },
        reqTimeout,
      ),
    );
    const bodyText = await res.text();
    const cr = classifyAndParseJson(phase, endpoint, res, bodyText, fetchMs);
    if ("passed" in cr) return cr;
    const body = cr.body;
    log(phase, "initial-response", { status: res.status, body });

    // Poll until running if not immediate
    if (body.status !== "running" && body.state !== "running") {
      const [poll, pollMs] = await timed(() =>
        pollUntilRunning(baseUrl, timeoutMs, reqTimeout),
      );
      const totalMs = fetchMs + pollMs;
      if (poll.running) {
        log(phase, "running-after-poll", { totalMs });
        return {
          phase, passed: true, durationMs: totalMs, endpoint,
          detail: { snapshotId: sid, ...poll.lastBody },
        };
      }
      return {
        phase, passed: false, durationMs: totalMs, endpoint,
        detail: poll.lastBody ?? body,
        error: "Timed out waiting for restore to complete",
        errorCode: "POLL_TIMEOUT",
        hint: "Restore did not reach 'running' within the timeout — increase --timeout",
      };
    }

    if (res.ok) {
      return {
        phase, passed: true, durationMs: fetchMs, endpoint,
        detail: { snapshotId: sid, ...body },
      };
    }
    return failFromHttp(phase, endpoint, res.status, `HTTP ${res.status}`, {
      durationMs: fetchMs, detail: { snapshotId: sid, ...body },
    });
  } catch (err) {
    return failFromError(phase, endpoint, err);
  }
}

// ---------------------------------------------------------------------------
// Gateway continuity: prove exact native channel acceptance while chat remains
// healthy before and after the delivery.
// ---------------------------------------------------------------------------

const CONTINUITY_GATEWAY_TIMEOUT_MS = 60_000;

type GatewayContinuityHealth = {
  healthy: boolean;
  status: number | null;
  contentPreview: string | null;
};

async function readGatewayContinuityHealth(
  response: Response | null,
): Promise<GatewayContinuityHealth> {
  if (!response) {
    return { healthy: false, status: null, contentPreview: null };
  }
  const text = await response.text().catch(() => "");
  const parsed = parseJsonBody(text);
  const choices = parsed.ok
    ? (parsed.data.choices as
        | Array<{ message?: { content?: unknown } }>
        | undefined)
    : undefined;
  const content = choices?.[0]?.message?.content;
  const contentPreview =
    typeof content === "string" ? content.slice(0, 200) : null;
  return {
    healthy:
      response.status === 200 &&
      typeof content === "string" &&
      content.trim().length > 0,
    status: response.status,
    contentPreview,
  };
}

export type ContinuityChannel = "slack" | "telegram" | "discord";

function buildChannelSmokePayload(channel: ContinuityChannel): string {
  switch (channel) {
    case "slack":
      return buildSlackSmokePayload().body;
    case "telegram":
      return buildTelegramSmokePayload();
    case "discord":
      return buildDiscordSmokePayload();
  }
}

export async function channelGatewayContinuity(
  baseUrl: string,
  pollTimeoutMs: number,
  channel: ContinuityChannel,
  opts?: PhaseOptions,
): Promise<PhaseResult> {
  const phase = `channelGatewayContinuity:${channel}`;
  const endpoint = "/api/admin/channel-secrets";
  const reqTimeout = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const phaseStartedAt = performance.now();

  try {
    // Step 1: Verify the gateway is healthy before channel delivery.
    const preCheck = await fetchWithTimeout(
      url(baseUrl, "/gateway/v1/chat/completions"),
      {
        method: "POST",
        headers: { ...authHeaders({ mutation: true }), "Content-Type": "application/json" },
        body: JSON.stringify({ model: "openclaw", messages: [{ role: "user", content: "say smoke-ok" }], stream: false }),
      },
      CONTINUITY_GATEWAY_TIMEOUT_MS,
    );
    const preHealth = await readGatewayContinuityHealth(preCheck);
    if (!preHealth.healthy) {
      return {
        phase, passed: false, durationMs: 0, endpoint,
        error: `Gateway not healthy before channel delivery (HTTP ${preHealth.status ?? "unavailable"})`,
        errorCode: "PRE_CHECK_FAILED",
        hint: "Ensure the sandbox is running before this phase",
        detail: { gateway: preHealth },
      };
    }
    log(phase, "pre-check-ok", { status: preHealth.status });

    // Step 2: Read channel connectability.
    const baselineSummary = await fetchChannelSummary(baseUrl, reqTimeout);
    if (!baselineSummary) {
      return {
        phase,
        passed: false,
        durationMs: Math.round(performance.now() - phaseStartedAt),
        endpoint,
        error: "Channel summary was unavailable before continuity delivery",
        errorCode: "SUMMARY_UNAVAILABLE",
      };
    }
    const channelSummary = baselineSummary?.[channel];
    if (!channelSummary?.connected) {
      return {
        phase,
        passed: true,
        durationMs: 0,
        endpoint,
        detail: { skipped: true, reason: "channel_not_configured" },
      };
    }

    // Step 3: Send a smoke webhook and prove exact native acceptance.
    const payload = buildChannelSmokePayload(channel);
    const sendResult = await sendSmokeWebhook(baseUrl, channel, payload, reqTimeout);
    if (
      sendResult?.webhookAccepted !== true ||
      typeof sendResult.deliveryId !== "string" ||
      sendResult.deliveryId.length === 0
    ) {
      return {
        phase, passed: false, durationMs: 0, endpoint,
        error: `Failed to admit ${channel} smoke webhook with an exact delivery ID`,
        errorCode: "WEBHOOK_SEND_FAILED",
        detail: { sendResult },
      };
    }
    log(phase, "webhook-admitted", { deliveryId: sendResult.deliveryId });

    const nativeAcceptance = await pollNativeAcceptance({
      baseUrl,
      channel,
      deliveryId: sendResult.deliveryId,
      timeoutMs: pollTimeoutMs,
      requestTimeoutMs: reqTimeout,
    });
    if (!nativeAcceptance.accepted) {
      return {
        phase,
        passed: false,
        durationMs: nativeAcceptance.durationMs,
        endpoint,
        error: `Native acceptance was not observed for ${channel} delivery ${sendResult.deliveryId}`,
        errorCode: "NATIVE_ACCEPTANCE_NOT_OBSERVED",
        detail: { sendResult, nativeAcceptance },
      };
    }
    log(phase, "native-accepted", {
      deliveryId: sendResult.deliveryId,
      replyObserved: nativeAcceptance.replyObserved,
    });

    // Step 4: Verify the gateway remains healthy after native acceptance.
    const deadline = Date.now() + pollTimeoutMs;
    let delay = POLL_INITIAL_MS;

    while (Date.now() < deadline) {
      await sleep(delay);

      const postCheck = await fetchWithTimeout(
        url(baseUrl, "/gateway/v1/chat/completions"),
        {
          method: "POST",
          headers: { ...authHeaders({ mutation: true }), "Content-Type": "application/json" },
          body: JSON.stringify({ model: "openclaw", messages: [{ role: "user", content: "say smoke-ok" }], stream: false }),
        },
        CONTINUITY_GATEWAY_TIMEOUT_MS,
      ).catch(() => null);

      const postHealth = await readGatewayContinuityHealth(postCheck);
      const gatewayHealthyAfterDelivery = postHealth.healthy;
      const elapsedMs = Math.round(performance.now() - phaseStartedAt);
      log(phase, gatewayHealthyAfterDelivery ? "post-check-ok" : "post-check-failed", {
        status: postHealth.status, elapsedMs,
      });

      if (gatewayHealthyAfterDelivery) {
        return {
          phase,
          passed: true,
          durationMs: elapsedMs,
          endpoint,
          detail: {
            channel,
            gatewayHealthyAfterDelivery,
            postCheckStatus: postHealth.status,
            postCheckContentPreview: postHealth.contentPreview,
            elapsedMs,
            deliveryId: sendResult.deliveryId,
            nativeAcceptance,
          },
        };
      }

      delay = Math.min(delay * POLL_BACKOFF, POLL_MAX_MS);
    }

    const totalMs = Math.round(performance.now() - phaseStartedAt);
    return {
      phase, passed: false, durationMs: totalMs, endpoint,
      error: "Gateway was not healthy after channel delivery within timeout",
      errorCode: "POLL_TIMEOUT",
      hint: "Inspect gateway health for the exact delivery window, or increase --timeout",
    };
  } catch (err) {
    return failFromError(phase, endpoint, err);
  }
}
