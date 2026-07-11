import assert from "node:assert/strict";
import test from "node:test";

import {
  GatewayAdminRpcError,
  callGatewayAdminRpc,
} from "@/server/openclaw/admin-rpc";
import { OPENCLAW_GATEWAY_TOKEN_PATH } from "@/server/openclaw/config";
import type {
  CommandResult,
  SandboxHandle,
} from "@/server/sandbox/controller";

function commandResult(exitCode: number, stdout: string): CommandResult {
  return {
    exitCode,
    output: async (stream) => stream === "stderr" ? "" : stdout,
  };
}

function fakeSandbox(runCommand: SandboxHandle["runCommand"]): SandboxHandle {
  return {
    sandboxId: "sbx-admin-rpc",
    timeout: 300_000,
    timeoutRemaining: 300_000,
    status: "running",
    runCommand,
    writeFiles: async () => {},
    readFileToBuffer: async () => null,
    domain: () => "https://unused.invalid",
    snapshot: async () => ({ snapshotId: "snap-unused" }),
    stop: async () => {},
    delete: async () => {},
    extendTimeout: async () => {},
    updateNetworkPolicy: async (policy) => policy,
    runDetachedCommand: async () => ({ cmdId: "unused" }),
    getCommand: async () => ({ kill: async () => {} }),
  };
}

test("callGatewayAdminRpc reads the token from the sandbox credential file", async () => {
  let commandEnv: Record<string, string> | undefined;
  const sandbox = fakeSandbox(async (options) => {
    assert.equal(typeof options, "object");
    if (typeof options === "object") {
      commandEnv = options.env;
    }
    return commandResult(0, JSON.stringify({
      status: 200,
      body: JSON.stringify({ ok: true, payload: { status: "running" } }),
    }));
  });

  const payload = await callGatewayAdminRpc<{ status: string }>({
    sandbox,
    method: "gateway.suspend.status",
    params: { suspensionId: "suspension-1" },
  });

  assert.equal(payload.status, "running");
  assert.equal(commandEnv?.OPENCLAW_ADMIN_RPC_TOKEN_PATH, OPENCLAW_GATEWAY_TOKEN_PATH);
  assert.equal(commandEnv?.OPENCLAW_ADMIN_RPC_TOKEN, undefined);
  assert.match(commandEnv?.OPENCLAW_ADMIN_RPC_BODY ?? "", /gateway\.suspend\.status/);
});

test("callGatewayAdminRpc preserves structured Gateway errors", async () => {
  const sandbox = fakeSandbox(async () => commandResult(0, JSON.stringify({
    status: 503,
    body: JSON.stringify({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "Gateway suspension is busy.",
        retryable: true,
        retryAfterMs: 750,
        details: { phase: "preparing" },
      },
    }),
  })));

  await assert.rejects(
    callGatewayAdminRpc({
      sandbox,
      method: "gateway.suspend.prepare",
      params: { requestId: "operation-1" },
    }),
    (error: unknown) => {
      assert.ok(error instanceof GatewayAdminRpcError);
      assert.equal(error.code, "UNAVAILABLE");
      assert.equal(error.status, 503);
      assert.equal(error.retryable, true);
      assert.equal(error.retryAfterMs, 750);
      assert.deepEqual(error.details, { phase: "preparing" });
      return true;
    },
  );
});

test("callGatewayAdminRpc fails closed when the plugin route is missing", async () => {
  const sandbox = fakeSandbox(async () => commandResult(0, JSON.stringify({
    status: 404,
    body: "Not Found",
  })));

  await assert.rejects(
    callGatewayAdminRpc({
      sandbox,
      method: "gateway.suspend.prepare",
      params: { requestId: "operation-1" },
    }),
    (error: unknown) => {
      assert.ok(error instanceof GatewayAdminRpcError);
      assert.equal(error.code, "ADMIN_RPC_NOT_INSTALLED");
      assert.equal(error.status, 404);
      return true;
    },
  );
});
