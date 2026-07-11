import type { SandboxHandle } from "@/server/sandbox/controller";
import { OPENCLAW_GATEWAY_TOKEN_PATH } from "@/server/openclaw/config";

const ADMIN_RPC_PATH = "/api/v1/admin/rpc";
const ADMIN_RPC_TIMEOUT_MS = 10_000;

const LOOPBACK_ADMIN_RPC_SCRIPT = String.raw`
import { readFile } from "node:fs/promises";
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), Number(process.env.OPENCLAW_ADMIN_RPC_TIMEOUT_MS));
try {
  const gatewayToken = (await readFile(process.env.OPENCLAW_ADMIN_RPC_TOKEN_PATH, "utf8")).trim();
  const response = await fetch("http://127.0.0.1:3000/api/v1/admin/rpc", {
    method: "POST",
    headers: {
      authorization: "Bearer " + gatewayToken,
      "content-type": "application/json",
    },
    body: process.env.OPENCLAW_ADMIN_RPC_BODY,
    signal: controller.signal,
  });
  const body = await response.text();
  process.stdout.write(JSON.stringify({ status: response.status, body }));
} finally {
  clearTimeout(timeout);
}
`;

type AdminRpcErrorBody = {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  retryable?: unknown;
  retryAfterMs?: unknown;
};

type AdminRpcEnvelope = {
  id?: unknown;
  ok?: unknown;
  payload?: unknown;
  error?: AdminRpcErrorBody;
};

type LoopbackResult = {
  status?: unknown;
  body?: unknown;
};

export class GatewayAdminRpcError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly details: unknown;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(input: {
    code: string;
    message: string;
    status?: number | null;
    details?: unknown;
    retryable?: boolean;
    retryAfterMs?: number | null;
  }) {
    super(input.message);
    this.name = "GatewayAdminRpcError";
    this.code = input.code;
    this.status = input.status ?? null;
    this.details = input.details;
    this.retryable = input.retryable === true;
    this.retryAfterMs = input.retryAfterMs ?? null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new GatewayAdminRpcError({
      code: "ADMIN_RPC_INVALID_RESPONSE",
      message: `${label} returned invalid JSON.`,
    });
  }
}

/**
 * Call the opt-in Admin HTTP RPC route over sandbox loopback. The Gateway
 * operator token is read from its existing sandbox file and never crosses the
 * public sandbox domain or appears in command arguments/environment values.
 */
export async function callGatewayAdminRpc<T>(input: {
  sandbox: SandboxHandle;
  method: string;
  params?: unknown;
  requestId?: string;
}): Promise<T> {
  const body = JSON.stringify({
    ...(input.requestId ? { id: input.requestId } : {}),
    method: input.method,
    params: input.params ?? {},
  });
  const result = await input.sandbox.runCommand({
    cmd: "node",
    args: ["--input-type=module", "-e", LOOPBACK_ADMIN_RPC_SCRIPT],
    env: {
      OPENCLAW_ADMIN_RPC_TOKEN_PATH: OPENCLAW_GATEWAY_TOKEN_PATH,
      OPENCLAW_ADMIN_RPC_BODY: body,
      OPENCLAW_ADMIN_RPC_TIMEOUT_MS: String(ADMIN_RPC_TIMEOUT_MS),
    },
  });

  if (result.exitCode !== 0) {
    throw new GatewayAdminRpcError({
      code: "ADMIN_RPC_UNREACHABLE",
      message: "OpenClaw Admin RPC is unavailable over sandbox loopback.",
      retryable: true,
    });
  }

  const raw = await result.output("stdout");
  const loopback = asRecord(parseJson(raw, "Admin RPC loopback command")) as LoopbackResult | null;
  const status = typeof loopback?.status === "number" ? loopback.status : null;
  const responseBody = typeof loopback?.body === "string" ? loopback.body : null;
  if (status === null || responseBody === null) {
    throw new GatewayAdminRpcError({
      code: "ADMIN_RPC_INVALID_RESPONSE",
      message: "Admin RPC loopback command returned an invalid response shape.",
    });
  }

  if (status === 404) {
    throw new GatewayAdminRpcError({
      code: "ADMIN_RPC_NOT_INSTALLED",
      message: `The bundled admin-http-rpc plugin is not enabled at ${ADMIN_RPC_PATH}.`,
      status,
    });
  }

  const envelope = asRecord(parseJson(responseBody, "OpenClaw Admin RPC")) as AdminRpcEnvelope | null;
  if (envelope?.ok === true) {
    return envelope.payload as T;
  }

  const rpcError = envelope?.error;
  const code = typeof rpcError?.code === "string"
    ? rpcError.code
    : status === 404
      ? "ADMIN_RPC_NOT_INSTALLED"
      : "ADMIN_RPC_FAILED";
  const message = typeof rpcError?.message === "string"
    ? rpcError.message
    : status === 404
      ? `The bundled admin-http-rpc plugin is not enabled at ${ADMIN_RPC_PATH}.`
      : "OpenClaw Admin RPC request failed.";
  throw new GatewayAdminRpcError({
    code,
    message,
    status,
    details: rpcError?.details,
    retryable: rpcError?.retryable === true || status === 503,
    retryAfterMs:
      typeof rpcError?.retryAfterMs === "number" ? rpcError.retryAfterMs : null,
  });
}

export function isGatewaySuspensionCapabilityUnavailable(
  error: unknown,
): error is GatewayAdminRpcError {
  return error instanceof GatewayAdminRpcError
    && error.code === "ADMIN_RPC_NOT_INSTALLED";
}
