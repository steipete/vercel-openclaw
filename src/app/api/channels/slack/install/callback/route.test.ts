import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { withHarness } from "@/test-utils/harness";
import { _setAiGatewayTokenOverrideForTesting } from "@/server/env";
import { patchNextServerAfter } from "@/test-utils/route-caller";
import {
  encryptPayload,
} from "@/server/auth/session";
import { getInitializedMeta } from "@/server/store/store";
import {
  hostSuspensionOperationKey,
  lifecycleLockKey,
} from "@/server/store/keyspace";

patchNextServerAfter();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { GET } = require("@/app/api/channels/slack/install/callback/route") as {
  GET: (request: Request) => Promise<Response>;
};

afterEach(() => {
  _setAiGatewayTokenOverrideForTesting(null);
  delete process.env.SLACK_CLIENT_ID;
  delete process.env.SLACK_CLIENT_SECRET;
  delete process.env.SLACK_SIGNING_SECRET;
});

function setSlackEnv(): void {
  process.env.SLACK_CLIENT_ID = "test-client-id";
  process.env.SLACK_CLIENT_SECRET = "test-client-secret";
  process.env.SLACK_SIGNING_SECRET = "test-signing-secret";
}

async function buildCallbackRequest(
  params: {
    code?: string;
    state?: string;
    error?: string;
  },
  cookies: { state?: string; ctx?: string } = {},
): Promise<Request> {
  const url = new URL("https://openclaw.example/api/channels/slack/install/callback");
  if (params.code) url.searchParams.set("code", params.code);
  if (params.state) url.searchParams.set("state", params.state);
  if (params.error) url.searchParams.set("error", params.error);

  const cookieParts: string[] = [];
  if (cookies.state) {
    cookieParts.push(`slack_oauth_state=${encodeURIComponent(cookies.state)}`);
  }
  if (cookies.ctx) {
    cookieParts.push(`slack_oauth_ctx=${encodeURIComponent(cookies.ctx)}`);
  }

  return new Request(url.toString(), {
    method: "GET",
    headers: {
      authorization: "Bearer test-admin-secret-for-scenarios",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "openclaw.example",
      host: "openclaw.example",
      ...(cookieParts.length ? { cookie: cookieParts.join("; ") } : {}),
    },
  });
}

test("callback redirects with error when Slack returns error param", async () => {
  await withHarness(async () => {
    setSlackEnv();
    const request = await buildCallbackRequest({ error: "access_denied" });
    const response = await GET(request);
    assert.equal(response.status, 302);
    const location = response.headers.get("location")!;
    assert.ok(location.includes("slack_install_error=access_denied"));
  });
});

test("callback redirects with error on state mismatch", async () => {
  await withHarness(async () => {
    setSlackEnv();
    const request = await buildCallbackRequest(
      { code: "test-code", state: "state-a" },
      { state: "state-b" },
    );
    const response = await GET(request);
    assert.equal(response.status, 302);
    const location = response.headers.get("location")!;
    assert.ok(location.includes("slack_install_error=state_mismatch"));
  });
});

test("callback redirects with error on missing context cookie", async () => {
  await withHarness(async () => {
    setSlackEnv();
    const stateValue = "matching-state";
    const request = await buildCallbackRequest(
      { code: "test-code", state: stateValue },
      { state: stateValue }, // no ctx cookie
    );
    const response = await GET(request);
    assert.equal(response.status, 302);
    const location = response.headers.get("location")!;
    assert.ok(location.includes("slack_install_error=context_expired"));
  });
});

test("callback persists Slack config on successful token exchange", async () => {
  await withHarness(async (h) => {
    setSlackEnv();
    _setAiGatewayTokenOverrideForTesting("oidc-token");

    // Mock Slack oauth.v2.access
    h.fakeFetch.onPost(/slack\.com\/api\/oauth\.v2\.access/, () =>
      Response.json({
        ok: true,
        access_token: "xoxb-test-bot-token-from-oauth",
        token_type: "bot",
        team: { id: "T123", name: "TestTeam" },
        bot_user_id: "U456",
      }),
    );

    // Mock Slack auth.test
    h.fakeFetch.onPost(/slack\.com\/api\/auth\.test/, () =>
      Response.json({
        ok: true,
        team: "TestTeam",
        user: "openclaw",
        bot_id: "B789",
      }),
    );

    const stateValue = "valid-state-token";
    const ctxEncrypted = await encryptPayload({ next: "/admin" }, "5m");

    const request = await buildCallbackRequest(
      { code: "valid-code", state: stateValue },
      { state: stateValue, ctx: ctxEncrypted },
    );

    const response = await GET(request);
    assert.equal(response.status, 302);
    const location = response.headers.get("location")!;
    assert.ok(
      !location.includes("slack_install_error"),
      "no error in redirect",
    );
    assert.ok(location.includes("/admin"), "redirects to admin");

    // Verify config was persisted
    const meta = await getInitializedMeta();
    assert.ok(meta.channels.slack, "Slack config should be set");
    assert.equal(meta.channels.slack!.botToken, "xoxb-test-bot-token-from-oauth");
    assert.equal(meta.channels.slack!.signingSecret, "test-signing-secret");
    assert.equal(meta.channels.slack!.team, "TestTeam");
    assert.equal(meta.channels.slack!.botId, "B789");

    // Verify cookies are cleared
    const cookies = response.headers.getSetCookie();
    const stateCleared = cookies.find(
      (c) => c.startsWith("slack_oauth_state=") && c.includes("Max-Age=0"),
    );
    const ctxCleared = cookies.find(
      (c) => c.startsWith("slack_oauth_ctx=") && c.includes("Max-Age=0"),
    );
    assert.ok(stateCleared, "state cookie is cleared");
    assert.ok(ctxCleared, "context cookie is cleared");
  });
});

test("callback does not persist Slack config when host stop fences before lifecycle admission", async () => {
  await withHarness(async (h) => {
    setSlackEnv();
    _setAiGatewayTokenOverrideForTesting("oidc-token");
    h.fakeFetch.onPost(/slack\.com\/api\/oauth\.v2\.access/, () =>
      Response.json({
        ok: true,
        access_token: "xoxb-stop-race",
        token_type: "bot",
      }),
    );
    h.fakeFetch.onPost(/slack\.com\/api\/auth\.test/, () =>
      Response.json({
        ok: true,
        team: "Stop Race Team",
        user: "openclaw",
        bot_id: "B_STOP_RACE",
      }),
    );

    const store = h.getStore();
    const acquireLock = store.acquireLock.bind(store);
    let injected = false;
    store.acquireLock = async (key, ttlSeconds) => {
      const token = await acquireLock(key, ttlSeconds);
      if (key === lifecycleLockKey() && token && !injected) {
        injected = true;
        const now = Date.now();
        await store.setValue(hostSuspensionOperationKey(), {
          version: 1,
          operationId: "operation-slack-oauth-stop-race",
          requestId: "operation-slack-oauth-stop-race",
          sandboxId: "sbx-slack-oauth-stop-race",
          lifecycleAttemptId: null,
          intent: "stop",
          reason: "test-race",
          phase: "stopping",
          ingressFenced: true,
          suspensionId: "suspension-slack-oauth-stop-race",
          leaseExpiresAtMs: now + 60_000,
          stopRequestDeadlineAtMs: null,
          monitorHeartbeatAtMs: now,
          startedAtMs: now - 1_000,
          updatedAtMs: now,
          stoppedAtMs: null,
          resumedAtMs: null,
          lastError: null,
          lastErrorCode: null,
          lastErrorClass: null,
        });
      }
      return token;
    };

    try {
      const stateValue = "stop-race-state";
      const ctxEncrypted = await encryptPayload({ next: "/admin" }, "5m");
      const response = await GET(await buildCallbackRequest(
        { code: "stop-race-code", state: stateValue },
        { state: stateValue, ctx: ctxEncrypted },
      ));

      assert.equal(response.status, 302);
      assert.match(
        response.headers.get("location") ?? "",
        /slack_install_error=host_ingress_fenced/,
      );
      assert.equal((await getInitializedMeta()).channels.slack, null);
    } finally {
      store.acquireLock = acquireLock;
    }
  });
});

test("callback clears OAuth state and reports lifecycle contention without persisting config", async () => {
  await withHarness(async (h) => {
    setSlackEnv();
    _setAiGatewayTokenOverrideForTesting("oidc-token");
    h.fakeFetch.onPost(/slack\.com\/api\/oauth\.v2\.access/, () =>
      Response.json({ ok: true, access_token: "xoxb-lock-contended" }),
    );
    h.fakeFetch.onPost(/slack\.com\/api\/auth\.test/, () =>
      Response.json({
        ok: true,
        team: "Contended Team",
        user: "openclaw",
        bot_id: "B_CONTENDED",
      }),
    );

    const store = h.getStore();
    const token = await store.acquireLock(lifecycleLockKey(), 30);
    assert.ok(token);
    try {
      const stateValue = "lock-contended-state";
      const ctxEncrypted = await encryptPayload({ next: "/admin" }, "5m");
      const response = await GET(await buildCallbackRequest(
        { code: "lock-contended-code", state: stateValue },
        { state: stateValue, ctx: ctxEncrypted },
      ));

      assert.equal(response.status, 302);
      assert.match(
        response.headers.get("location") ?? "",
        /slack_install_error=lifecycle_busy/,
      );
      assert.equal((await getInitializedMeta()).channels.slack, null);
      assert.equal(response.headers.getSetCookie().length, 2);
    } finally {
      await store.releaseLock(lifecycleLockKey(), token);
    }
  });
});
