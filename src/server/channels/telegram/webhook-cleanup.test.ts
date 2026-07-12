import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { setTelegramChannelConfig } from "@/server/channels/state";
import { reconcileTelegramWebhookCleanups } from "@/server/channels/telegram/webhook-cleanup";
import {
  _resetStoreForTesting,
  getInitializedMeta,
} from "@/server/store/store";
import { withHarness } from "@/test-utils/harness";

test.beforeEach(() => {
  (process.env as Record<string, string | undefined>).NODE_ENV = "test";
  _resetStoreForTesting();
});

test("watchdog cleanup removes superseded Telegram webhook obligations", async () => {
  await setTelegramChannelConfig({
    botToken: "current-token",
    webhookSecret: "current-secret",
    webhookUrl: "https://app.test/api/channels/telegram/webhook",
    botUsername: "current_bot",
    configuredAt: 10,
    pendingWebhookCleanups: [
      { botToken: "old-token", botId: "1", requestedAt: 9 },
    ],
  });
  const fetchMock = mock.method(globalThis, "fetch", async () =>
    Response.json({ ok: true, result: true }),
  );

  try {
    assert.deepEqual(await reconcileTelegramWebhookCleanups(), {
      attempted: 1,
      cleaned: 1,
      remaining: 0,
      disconnected: false,
    });
    assert.equal(
      (await getInitializedMeta()).channels.telegram?.pendingWebhookCleanups,
      undefined,
    );
  } finally {
    fetchMock.mock.restore();
  }
});

test("watchdog cleanup never deletes the current token outside disconnect", async () => {
  await setTelegramChannelConfig({
    botToken: "current-token",
    webhookSecret: "current-secret",
    webhookUrl: "https://app.test/api/channels/telegram/webhook",
    botUsername: "current_bot",
    configuredAt: 15,
    pendingWebhookCleanups: [
      { botToken: "current-token", requestedAt: 1 },
      { botToken: "old-token", requestedAt: 2 },
    ],
  });
  const calledTokens: string[] = [];
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request) => {
      const match = /\/bot([^/]+)\/deleteWebhook$/u.exec(String(input));
      if (match) calledTokens.push(match[1]);
      return Response.json({ ok: true, result: true });
    },
  );

  try {
    assert.deepEqual(await reconcileTelegramWebhookCleanups(), {
      attempted: 1,
      cleaned: 1,
      remaining: 0,
      disconnected: false,
    });
    assert.deepEqual(calledTokens, ["old-token"]);
    assert.equal(
      (await getInitializedMeta()).channels.telegram?.pendingWebhookCleanups,
      undefined,
    );
  } finally {
    fetchMock.mock.restore();
  }
});

test("watchdog cleanup completes disconnect while the sandbox is stopped", async () => {
  await setTelegramChannelConfig({
    botToken: "disconnect-token",
    webhookSecret: "disconnect-secret",
    webhookUrl: "https://app.test/api/channels/telegram/webhook",
    botUsername: "disconnect_bot",
    configuredAt: 20,
    deletionPending: true,
    lastError: "Telegram disconnect cleanup is pending.",
  });
  const fetchMock = mock.method(globalThis, "fetch", async () =>
    Response.json({ ok: true, result: true }),
  );

  try {
    const result = await reconcileTelegramWebhookCleanups();
    assert.deepEqual(result, {
      attempted: 1,
      cleaned: 1,
      remaining: 0,
      disconnected: true,
    });
    assert.equal((await getInitializedMeta()).channels.telegram, null);
  } finally {
    fetchMock.mock.restore();
  }
});

test("watchdog cleanup retires a revoked Telegram credential", async () => {
  await setTelegramChannelConfig({
    botToken: "revoked-token",
    webhookSecret: "disconnect-secret",
    webhookUrl: "https://app.test/api/channels/telegram/webhook",
    botUsername: "revoked_bot",
    configuredAt: 21,
    deletionPending: true,
  });
  const fetchMock = mock.method(globalThis, "fetch", async () =>
    Response.json(
      { ok: false, error_code: 401, description: "Unauthorized" },
      { status: 401 },
    ),
  );

  try {
    assert.deepEqual(await reconcileTelegramWebhookCleanups(), {
      attempted: 1,
      cleaned: 1,
      remaining: 0,
      disconnected: true,
    });
    assert.equal((await getInitializedMeta()).channels.telegram, null);
  } finally {
    fetchMock.mock.restore();
  }
});

test("watchdog disconnect removes running gateway credentials through live config apply", async () => {
  await withHarness(async (h) => {
    const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
    await h.driveToRunning();
    await setTelegramChannelConfig({
      botToken: "disconnect-running-token",
      webhookSecret: "disconnect-running-secret",
      webhookUrl: "https://app.test/api/channels/telegram/webhook",
      botUsername: "disconnect_running_bot",
      configuredAt: 25,
      deletionPending: true,
    });
    const handle = h.controller.created.at(-1);
    assert.ok(handle);
    handle.responders.push((command, args) => {
      if (
        command === "bash" &&
        args?.join(" ").includes("grep -q 'openclaw-app'")
      ) {
        return { exitCode: 0, output: async () => "ok" };
      }
      return undefined;
    });
    const writesBefore = handle.writtenFiles.length;
    const fetchMock = mock.method(globalThis, "fetch", async () =>
      Response.json({ ok: true, result: true }),
    );

    try {
      const result = await reconcileTelegramWebhookCleanups();
      assert.equal(result.disconnected, true);
      assert.equal((await h.getMeta()).channels.telegram, null);
      assert.ok(handle.writtenFiles.length > writesBefore);
      const latestConfig = [...handle.writtenFiles]
        .reverse()
        .find((file) => file.path.endsWith("/openclaw.json"));
      assert.ok(latestConfig);
      assert.equal(
        latestConfig.content.toString().includes("disconnect-running-token"),
        false,
      );
    } finally {
      fetchMock.mock.restore();
      if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    }
  });
});

test("watchdog disconnect restores tombstone when live config removal is stale", async () => {
  await withHarness(async (h) => {
    const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
    await h.driveToRunning();
    await setTelegramChannelConfig({
      botToken: "disconnect-retry-token",
      webhookSecret: "disconnect-retry-secret",
      webhookUrl: "https://app.test/api/channels/telegram/webhook",
      botUsername: "disconnect_retry_bot",
      configuredAt: 26,
      deletionPending: true,
    });
    const handle = h.controller.created.at(-1);
    assert.ok(handle);
    handle.writeFilesHook = () => {
      throw new Error("live config removal unavailable");
    };
    const fetchMock = mock.method(globalThis, "fetch", async () =>
      Response.json({ ok: true, result: true }),
    );

    try {
      assert.deepEqual(await reconcileTelegramWebhookCleanups(), {
        attempted: 1,
        cleaned: 1,
        remaining: 1,
        disconnected: false,
      });
      const config = (await h.getMeta()).channels.telegram;
      assert.equal(config?.botToken, "disconnect-retry-token");
      assert.equal(config?.deletionPending, true);
      assert.match(config?.lastError ?? "", /pending live config removal/i);
    } finally {
      fetchMock.mock.restore();
      if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    }
  });
});

test("watchdog cleanup bounds provider calls per pass", async () => {
  await setTelegramChannelConfig({
    botToken: "current-token",
    webhookSecret: "current-secret",
    webhookUrl: "https://app.test/api/channels/telegram/webhook",
    botUsername: "current_bot",
    configuredAt: 30,
    pendingWebhookCleanups: [
      { botToken: "old-token-1", requestedAt: 1 },
      { botToken: "old-token-2", requestedAt: 2 },
      { botToken: "old-token-3", requestedAt: 3 },
    ],
  });
  let calls = 0;
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return Response.json({ ok: true, result: true });
  });

  try {
    assert.deepEqual(await reconcileTelegramWebhookCleanups(), {
      attempted: 2,
      cleaned: 2,
      remaining: 1,
      disconnected: false,
    });
    assert.equal(calls, 2);
    assert.deepEqual(
      (await getInitializedMeta()).channels.telegram?.pendingWebhookCleanups?.map(
        (cleanup) => cleanup.botToken,
      ),
      ["old-token-3"],
    );
  } finally {
    fetchMock.mock.restore();
  }
});
