import assert from "node:assert/strict";
import test from "node:test";

import { afterEach } from "node:test";

import {
  reconcileTelegramIntegration,
  reconcileTelegramWebhook,
  TELEGRAM_RECONCILE_KEY,
} from "@/server/channels/telegram/reconcile";
import { withHarness } from "@/test-utils/harness";
import { channelConfigLockKey } from "@/server/store/keyspace";

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("reconcileTelegramIntegration sets webhook, syncs commands, and records timestamp", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.channels.telegram = {
        botToken: "tg-bot-token",
        webhookSecret: "tg-secret",
        webhookUrl: "https://app.example.com/api/channels/telegram/webhook",
        botUsername: "test_bot",
        configuredAt: Date.now(),
      };
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    h.fakeFetch.onPost(
      /api\.telegram\.org\/bottg-bot-token\/setWebhook/,
      async () => {
        assert.equal(
          await h.getStore().acquireLock(
            channelConfigLockKey("telegram"),
            90,
          ),
          null,
          "reconcile must retain the Telegram config lease",
        );
        return Response.json({ ok: true, result: true });
      },
    );
    h.fakeFetch.onPost(/api\.telegram\.org\/bottg-bot-token\/getMyCommands/, () =>
      Response.json({ ok: true, result: [] }),
    );
    h.fakeFetch.onPost(/api\.telegram\.org\/bottg-bot-token\/setMyCommands/, () =>
      Response.json({ ok: true, result: true }),
    );

    try {
      const result = await reconcileTelegramIntegration({ force: true });
      assert.ok(result !== null);
      assert.equal(result.webhookReconciled, true);
      assert.equal(result.commandsSynced, true);
      assert.ok(result.commandCount > 0);

      const requests = h.fakeFetch.requests();
      const urls = requests.map((r) => r.url);
      assert.ok(urls.some((u) => u.includes("/setWebhook")));
      assert.ok(urls.some((u) => u.includes("/getMyCommands")));
      assert.ok(urls.some((u) => u.includes("/setMyCommands")));

      const store = h.getStore();
      const last = await store.getValue<number>(TELEGRAM_RECONCILE_KEY);
      assert.equal(typeof last, "number");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("reconcileTelegramIntegration skips command sync when commands already match", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.channels.telegram = {
        botToken: "tg-bot-token",
        webhookSecret: "tg-secret",
        webhookUrl: "https://app.example.com/api/channels/telegram/webhook",
        botUsername: "test_bot",
        configuredAt: Date.now(),
      };
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    h.fakeFetch.onPost(/api\.telegram\.org\/bottg-bot-token\/setWebhook/, () =>
      Response.json({ ok: true, result: true }),
    );
    h.fakeFetch.onPost(/api\.telegram\.org\/bottg-bot-token\/getMyCommands/, () =>
      Response.json({
        ok: true,
        result: [
          { command: "ask", description: "Ask the AI a question" },
          { command: "help", description: "Show available commands" },
          { command: "status", description: "Show current session status" },
          { command: "model", description: "Switch or view the current model" },
          { command: "reset", description: "Start a new conversation" },
          { command: "think", description: "Set thinking level (off, low, medium, high)" },
          { command: "compact", description: "Compact the conversation context" },
          { command: "stop", description: "Stop the current response" },
        ],
      }),
    );

    try {
      const result = await reconcileTelegramIntegration({ force: true });
      assert.ok(result !== null);
      assert.equal(result.commandsSynced, false);

      const requests = h.fakeFetch.requests();
      const urls = requests.map((r) => r.url);
      assert.ok(!urls.some((u) => u.includes("/setMyCommands")), "should not call setMyCommands when commands match");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("reconcileTelegramIntegration skips within throttle window", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.channels.telegram = {
        botToken: "tg-bot-token",
        webhookSecret: "tg-secret",
        webhookUrl: "https://app.example.com/api/channels/telegram/webhook",
        botUsername: "test_bot",
        configuredAt: Date.now(),
      };
    });
    await h.getStore().setValue(TELEGRAM_RECONCILE_KEY, Date.now());

    const result = await reconcileTelegramIntegration();
    assert.equal(result, null);
  });
});

test("reconcileTelegramWebhook delegates to reconcileTelegramIntegration", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.channels.telegram = {
        botToken: "tg-bot-token",
        webhookSecret: "tg-secret",
        webhookUrl: "https://app.example.com/api/channels/telegram/webhook",
        botUsername: "test_bot",
        configuredAt: Date.now(),
      };
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    h.fakeFetch.onPost(/api\.telegram\.org\/bottg-bot-token\/setWebhook/, () =>
      Response.json({ ok: true, result: true }),
    );
    h.fakeFetch.onPost(/api\.telegram\.org\/bottg-bot-token\/getMyCommands/, () =>
      Response.json({ ok: true, result: [] }),
    );
    h.fakeFetch.onPost(/api\.telegram\.org\/bottg-bot-token\/setMyCommands/, () =>
      Response.json({ ok: true, result: true }),
    );

    try {
      const changed = await reconcileTelegramWebhook({ force: true });
      assert.equal(changed, true);

      const requests = h.fakeFetch.requests();
      const urls = requests.map((r) => r.url);
      assert.ok(urls.some((u) => u.includes("/setWebhook")));
      assert.ok(urls.some((u) => u.includes("/getMyCommands")));
      assert.ok(urls.some((u) => u.includes("/setMyCommands")));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("reconcileTelegramIntegration uses bypass URL when VERCEL_AUTOMATION_BYPASS_SECRET is set", async () => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "test-bypass-secret";

  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.channels.telegram = {
        botToken: "tg-bot-token",
        webhookSecret: "tg-secret",
        webhookUrl: "https://app.example.com/api/channels/telegram/webhook",
        botUsername: "test_bot",
        configuredAt: Date.now(),
      };
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    h.fakeFetch.onPost(/api\.telegram\.org\/bottg-bot-token\/setWebhook/, () =>
      Response.json({ ok: true, result: true }),
    );
    h.fakeFetch.onPost(/api\.telegram\.org\/bottg-bot-token\/getMyCommands/, () =>
      Response.json({ ok: true, result: [] }),
    );
    h.fakeFetch.onPost(/api\.telegram\.org\/bottg-bot-token\/setMyCommands/, () =>
      Response.json({ ok: true, result: true }),
    );

    try {
      await reconcileTelegramIntegration({ force: true });

      const setWebhookReq = h.fakeFetch.requests().find((r) => r.url.includes("/setWebhook"));
      assert.ok(setWebhookReq, "setWebhook must be called");
      assert.ok(
        setWebhookReq.body?.includes("x-vercel-protection-bypass"),
        "reconciliation must send bypass param to setWebhook when VERCEL_AUTOMATION_BYPASS_SECRET is set",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
