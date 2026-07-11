import assert from "node:assert/strict";
import test from "node:test";

import {
  runWithBootMessages,
} from "@/server/channels/core/boot-messages";
import {
  beginSetupProgress,
  SetupProgressWriter,
} from "@/server/sandbox/setup-progress";
import type {
  ExtractedChannelMessage,
  PlatformAdapter,
} from "@/server/channels/core/types";
import {
  _resetStoreForTesting,
  getStore,
  mutateMeta,
} from "@/server/store/store";
import { _setSandboxControllerForTesting } from "@/server/sandbox/controller";
import { FakeSandboxController } from "@/test-utils/fake-sandbox-controller";
import { _resetLogBuffer } from "@/server/log";
import { hostSuspensionOperationKey } from "@/server/store/keyspace";
import type { HostSuspensionState } from "@/server/sandbox/host-suspension";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_ENV: Record<string, string | undefined> = {
  NODE_ENV: "test",
  VERCEL: undefined,
  REDIS_URL: undefined,
  KV_URL: undefined,
  AI_GATEWAY_API_KEY: "test-key",
};

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    originals[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }

  try {
    return await fn();
  } finally {
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }

    _resetStoreForTesting();
    _resetLogBuffer();
  }
}

type BootMessageLog = {
  action: "send" | "update" | "clear";
  text?: string;
};

function createTrackingAdapter(): {
  adapter: PlatformAdapter<unknown, ExtractedChannelMessage>;
  log: BootMessageLog[];
} {
  const log: BootMessageLog[] = [];

  const adapter: PlatformAdapter<unknown, ExtractedChannelMessage> = {
    extractMessage: () => ({ kind: "skip", reason: "test" }),
    sendReply: async () => {},
    async sendBootMessage(_message, text) {
      log.push({ action: "send", text });
      return {
        async update(newText: string) {
          log.push({ action: "update", text: newText });
        },
        async clear() {
          log.push({ action: "clear" });
        },
      };
    },
  };

  return { adapter, log };
}

function createMessage(): ExtractedChannelMessage {
  return { text: "hello" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("boot-messages: no boot message when sandbox is already running", async () => {
  await withEnv(TEST_ENV, async () => {
    const fakeController = new FakeSandboxController();
    _setSandboxControllerForTesting(fakeController);

    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-running";
    });

    const { adapter, log } = createTrackingAdapter();

    const result = await runWithBootMessages({
      channel: "telegram",
      adapter,
      message: createMessage(),
      origin: "https://app.test",
      reason: "test",
      timeoutMs: 5_000,
    });

    assert.equal(result.bootMessageSent, false);
    assert.equal(log.length, 0);
  });
});

test("boot-messages: fenced running metadata never bypasses admission", async () => {
  await withEnv(TEST_ENV, async () => {
    const fakeController = new FakeSandboxController();
    _setSandboxControllerForTesting(fakeController);
    const now = Date.now();
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-fenced";
      meta.lifecycleAttemptId = "attempt-fenced";
    });
    await getStore().setValue<HostSuspensionState>(hostSuspensionOperationKey(), {
      version: 1,
      operationId: "operation-fenced",
      requestId: "operation-fenced",
      sandboxId: "sbx-fenced",
      lifecycleAttemptId: "attempt-fenced",
      intent: "stop",
      reason: "test-stop",
      phase: "prepared",
      ingressFenced: true,
      suspensionId: "suspension-fenced",
      leaseExpiresAtMs: now + 120_000,
      stopRequestDeadlineAtMs: null,
      monitorHeartbeatAtMs: now,
      startedAtMs: now,
      updatedAtMs: now,
      stoppedAtMs: null,
      resumedAtMs: null,
      lastError: null,
      lastErrorCode: null,
      lastErrorClass: null,
    });
    const { adapter, log } = createTrackingAdapter();

    await assert.rejects(
      runWithBootMessages({
        channel: "slack",
        adapter,
        message: createMessage(),
        origin: "https://app.test",
        reason: "fenced-running-test",
        timeoutMs: 20,
        pollIntervalMs: 5,
      }),
      /did not become ready/,
    );
    assert.equal(log.some((entry) => entry.action === "send"), true);
  });
});

test("boot-messages: probe success cannot admit a replacement generation", async () => {
  await withEnv(TEST_ENV, async () => {
    const fakeController = new FakeSandboxController();
    _setSandboxControllerForTesting(fakeController);
    const handle = await fakeController.create({ ports: [3000] });
    await mutateMeta((meta) => {
      meta.status = "setup";
      meta.sandboxId = handle.sandboxId;
      meta.lifecycleAttemptId = "attempt-probed";
    });
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      if (fetchCalls === 2) {
        const now = Date.now();
        await mutateMeta((meta) => {
          meta.status = "running";
          meta.sandboxId = "sbx-replacement";
          meta.lifecycleAttemptId = "attempt-replacement";
        });
        await getStore().setValue<HostSuspensionState>(
          hostSuspensionOperationKey(),
          {
            version: 1,
            operationId: "operation-replacement",
            requestId: "operation-replacement",
            sandboxId: "sbx-replacement",
            lifecycleAttemptId: "attempt-replacement",
            intent: "stop",
            reason: "replacement-race",
            phase: "prepared",
            ingressFenced: true,
            suspensionId: "suspension-replacement",
            leaseExpiresAtMs: now + 120_000,
            stopRequestDeadlineAtMs: null,
            monitorHeartbeatAtMs: now,
            startedAtMs: now,
            updatedAtMs: now,
            stoppedAtMs: null,
            resumedAtMs: null,
            lastError: null,
            lastErrorCode: null,
            lastErrorClass: null,
          },
        );
        return new Response("ready", { status: 200 });
      }
      return new Response("openclaw-app", { status: 200 });
    }) as typeof fetch;

    try {
      const { adapter } = createTrackingAdapter();
      await assert.rejects(
        runWithBootMessages({
          channel: "slack",
          adapter,
          message: createMessage(),
          origin: "https://app.test",
          reason: "probe-generation-race",
          timeoutMs: 20,
          pollIntervalMs: 5,
        }),
        /did not become ready/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("boot-messages: already-running + existingBootHandle + deferCleanupToCaller → update, no clear", async () => {
  await withEnv(TEST_ENV, async () => {
    const fakeController = new FakeSandboxController();
    _setSandboxControllerForTesting(fakeController);

    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-running";
    });

    const handleLog: BootMessageLog[] = [];
    const existingBootHandle = {
      async update(text: string) {
        handleLog.push({ action: "update", text });
      },
      async clear() {
        handleLog.push({ action: "clear" });
      },
    };

    const { adapter } = createTrackingAdapter();

    const result = await runWithBootMessages({
      channel: "slack",
      adapter,
      message: createMessage(),
      origin: "https://app.test",
      reason: "test",
      timeoutMs: 5_000,
      existingBootHandle,
      deferCleanupToCaller: true,
    });

    // Give the fire-and-forget update promise a tick to resolve.
    await new Promise((r) => setImmediate(r));

    assert.equal(result.bootMessageSent, false);
    assert.deepEqual(
      handleLog.map((e) => e.action),
      ["update"],
      "deferCleanupToCaller must preserve the boot message, not delete it",
    );
    assert.ok(
      typeof handleLog[0].text === "string" && handleLog[0].text.length > 0,
      "update must carry a status message",
    );
  });
});

test("boot-messages: already-running + existingBootHandle + default cleanup → clear", async () => {
  await withEnv(TEST_ENV, async () => {
    const fakeController = new FakeSandboxController();
    _setSandboxControllerForTesting(fakeController);

    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-running";
    });

    const handleLog: BootMessageLog[] = [];
    const existingBootHandle = {
      async update(text: string) {
        handleLog.push({ action: "update", text });
      },
      async clear() {
        handleLog.push({ action: "clear" });
      },
    };

    const { adapter } = createTrackingAdapter();

    const result = await runWithBootMessages({
      channel: "slack",
      adapter,
      message: createMessage(),
      origin: "https://app.test",
      reason: "test",
      timeoutMs: 5_000,
      existingBootHandle,
    });

    await new Promise((r) => setImmediate(r));

    assert.equal(result.bootMessageSent, false);
    assert.deepEqual(
      handleLog.map((e) => e.action),
      ["clear"],
      "without deferCleanupToCaller we still delete the orphan",
    );
  });
});

test("boot-messages: no boot message when adapter lacks sendBootMessage", async () => {
  await withEnv(TEST_ENV, async () => {
    const adapter: PlatformAdapter<unknown, ExtractedChannelMessage> = {
      extractMessage: () => ({ kind: "skip", reason: "test" }),
      sendReply: async () => {},
      // No sendBootMessage
    };

    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-1";
    });

    const result = await runWithBootMessages({
      channel: "telegram",
      adapter,
      message: createMessage(),
      origin: "https://app.test",
      reason: "test",
      timeoutMs: 5_000,
    });

    assert.equal(result.bootMessageSent, false);
  });
});

test("boot-messages: sends boot message and clears on running", async () => {
  await withEnv(TEST_ENV, async () => {
    const fakeController = new FakeSandboxController();
    _setSandboxControllerForTesting(fakeController);

    // Start stopped, then transition to running after first poll
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-1";
    });

    const { adapter, log } = createTrackingAdapter();

    // Override ensureSandboxRunning behavior by mutating meta on poll
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response("not-openclaw-app", { status: 200 });
    }) as typeof fetch;

    try {
      const resultPromise = runWithBootMessages({
        channel: "telegram",
        adapter,
        message: createMessage(),
        origin: "https://app.test",
        reason: "test",
        timeoutMs: 10_000,
        pollIntervalMs: 50,
      });

      // Simulate sandbox becoming running after a short delay
      setTimeout(async () => {
        await mutateMeta((meta) => {
          meta.status = "running";
          meta.sandboxId = "sbx-1";
        });
        // Now make gateway probe succeed
        globalThis.fetch = (async () => {
          return new Response("openclaw-app", { status: 200 });
        }) as typeof fetch;
      }, 200);

      const result = await resultPromise;

      assert.equal(result.bootMessageSent, true);
      // Should have sent initial boot message
      assert.ok(log.some((e) => e.action === "send"), "should have sent boot message");
      // Clear now happens asynchronously after the wake path returns.
      await new Promise((r) => setTimeout(r, 600));
      assert.ok(log.some((e) => e.action === "clear"), "should have cleared boot message");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("boot-messages: boot message cleared after successful restore", async () => {
  await withEnv(TEST_ENV, async () => {
    const fakeController = new FakeSandboxController();
    _setSandboxControllerForTesting(fakeController);

    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-1";
    });

    const { adapter, log } = createTrackingAdapter();

    // Let the fake controller restore instantly and gateway probe succeed
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response("openclaw-app", { status: 200 });
    }) as typeof fetch;

    try {
      const result = await runWithBootMessages({
        channel: "telegram",
        adapter,
        message: createMessage(),
        origin: "https://app.test",
        reason: "test",
        timeoutMs: 10_000,
        pollIntervalMs: 50,
      });

      assert.equal(result.bootMessageSent, true);
      // Boot message must always be cleared (even on success)
      assert.ok(log.some((e) => e.action === "send"), "should have sent boot message");
      await new Promise((r) => setTimeout(r, 600));
      assert.ok(log.some((e) => e.action === "clear"), "should have cleared after restore");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("boot-messages: sendBootMessage failure is non-fatal", async () => {
  await withEnv(TEST_ENV, async () => {
    const fakeController = new FakeSandboxController();
    _setSandboxControllerForTesting(fakeController);

    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-1";
    });

    const adapter: PlatformAdapter<unknown, ExtractedChannelMessage> = {
      extractMessage: () => ({ kind: "skip", reason: "test" }),
      sendReply: async () => {},
      async sendBootMessage() {
        throw new Error("telegram api down");
      },
    };

    const result = await runWithBootMessages({
      channel: "telegram",
      adapter,
      message: createMessage(),
      origin: "https://app.test",
      reason: "test",
      timeoutMs: 5_000,
    });

    // Should return gracefully without boot message
    assert.equal(result.bootMessageSent, false);
  });
});

test("boot-messages: updates message on status transition", async () => {
  await withEnv(TEST_ENV, async () => {
    const fakeController = new FakeSandboxController();
    _setSandboxControllerForTesting(fakeController);

    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-1";
    });

    const { adapter, log } = createTrackingAdapter();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response("not-ready", { status: 200 });
    }) as typeof fetch;

    try {
      const resultPromise = runWithBootMessages({
        channel: "telegram",
        adapter,
        message: createMessage(),
        origin: "https://app.test",
        reason: "test",
        timeoutMs: 10_000,
        pollIntervalMs: 50,
      });

      // Simulate status transitions
      await new Promise((r) => setTimeout(r, 100));
      await mutateMeta((meta) => {
        meta.status = "creating";
      });
      await new Promise((r) => setTimeout(r, 100));
      await mutateMeta((meta) => {
        meta.status = "booting";
        meta.sandboxId = "sbx-1";
      });
      await new Promise((r) => setTimeout(r, 100));
      await mutateMeta((meta) => {
        meta.status = "running";
      });
      globalThis.fetch = (async () => {
        return new Response("openclaw-app", { status: 200 });
      }) as typeof fetch;

      const result = await resultPromise;

      assert.equal(result.bootMessageSent, true);

      // Should have status update messages
      const updates = log.filter((e) => e.action === "update");
      assert.ok(updates.length >= 1, "should have at least one status update");

      // Check that we see restore-oriented status transitions
      const updateTexts = updates.map((e) => e.text).join("|");
      assert.ok(
        updateTexts.includes("Resuming") || updateTexts.includes("Verifying"),
        `should have status transitions in: ${updateTexts}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("boot-messages: setup progress phases update while meta status stays setup", async () => {
  await withEnv(TEST_ENV, async () => {
    const fakeController = new FakeSandboxController();
    _setSandboxControllerForTesting(fakeController);

    await mutateMeta((meta) => {
      meta.status = "setup";
      meta.sandboxId = "sbx-setup-progress";
      meta.snapshotId = "snap-setup-progress";
    });

    const progress = await beginSetupProgress({
      attemptId: "attempt-setup-progress",
      phase: "writing-config",
    });
    const writer = new SetupProgressWriter(progress);

    const { adapter, log } = createTrackingAdapter();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("not-ready", { status: 200 })) as typeof fetch;

    try {
      const resultPromise = runWithBootMessages({
        channel: "slack",
        adapter,
        message: createMessage(),
        origin: "https://app.test",
        reason: "test",
        timeoutMs: 10_000,
        pollIntervalMs: 50,
      });

      await new Promise((r) => setTimeout(r, 100));
      writer.setPhase("starting-gateway");
      await new Promise((r) => setTimeout(r, 400));

      writer.setPhase("waiting-for-gateway");
      await new Promise((r) => setTimeout(r, 400));

      await new Promise((r) => setTimeout(r, 100));
      await mutateMeta((meta) => {
        meta.status = "running";
      });

      const result = await resultPromise;

      assert.equal(result.bootMessageSent, true);
      const updateTexts = log
        .filter((e) => e.action === "update")
        .map((e) => e.text);
      assert.ok(
        updateTexts.includes("🦞 Syncing channel config\u2026"),
        `expected config phase update in ${JSON.stringify(updateTexts)}`,
      );
      assert.ok(
        updateTexts.includes("🦞 Starting OpenClaw gateway\u2026"),
        `expected gateway start phase update in ${JSON.stringify(updateTexts)}`,
      );
      assert.ok(
        updateTexts.includes("🦞 Waiting for gateway\u2026"),
        `expected gateway wait phase update in ${JSON.stringify(updateTexts)}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("boot-messages: telegram does not short-circuit on port 3000 gateway readiness", async () => {
  await withEnv(TEST_ENV, async () => {
    const fakeController = new FakeSandboxController();
    _setSandboxControllerForTesting(fakeController);

    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-1";
    });

    const { adapter, log } = createTrackingAdapter();

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("openclaw-app", { status: 200 });
    }) as typeof fetch;

    try {
      const resultPromise = runWithBootMessages({
        channel: "telegram",
        adapter,
        message: createMessage(),
        origin: "https://app.test",
        reason: "test",
        timeoutMs: 10_000,
        pollIntervalMs: 50,
      });

      await new Promise((r) => setTimeout(r, 150));
      await mutateMeta((meta) => {
        meta.status = "booting";
        meta.sandboxId = "sbx-telegram";
      });

      await new Promise((r) => setTimeout(r, 200));

      let settled = false;
      void resultPromise.then(() => {
        settled = true;
      });

      assert.equal(
        settled,
        false,
        "telegram boot flow must keep waiting even when port 3000 probe succeeds",
      );
      assert.equal(fetchCalls, 0, "telegram boot flow must not call probeGatewayReady");

      await mutateMeta((meta) => {
        meta.status = "running";
      });

      const result = await resultPromise;

      assert.equal(result.bootMessageSent, true);
      assert.ok(log.some((e) => e.action === "send"), "should have sent boot message");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("boot-messages: surfaces a real error to the user when the poll loop throws (Patch A)", async () => {
  await withEnv(TEST_ENV, async () => {
    const fakeController = new FakeSandboxController();
    _setSandboxControllerForTesting(fakeController);

    // Sandbox stuck in setup — never transitions to running.
    await mutateMeta((meta) => {
      meta.status = "setup";
      meta.sandboxId = "sbx-stuck";
      meta.snapshotId = "snap-stuck";
    });

    const { adapter, log } = createTrackingAdapter();

    const originalFetch = globalThis.fetch;
    // Gateway probe returns a non-openclaw response so the slack short-
    // circuit cannot fire. (We use telegram below, which already skips
    // the probe.) Keep the override defensive.
    globalThis.fetch = (async () => new Response("nope", { status: 200 })) as typeof fetch;

    try {
      // Tiny timeout so the deadline check in the loop throws quickly.
      let thrown: unknown = null;
      try {
        await runWithBootMessages({
          channel: "telegram",
          adapter,
          message: createMessage(),
          origin: "https://app.test",
          reason: "test",
          timeoutMs: 100,
          pollIntervalMs: 30,
        });
      } catch (err) {
        thrown = err;
      }

      assert.ok(thrown instanceof Error, "loop should have thrown a real Error");
      assert.match(
        (thrown as Error).message,
        /did not become ready/,
        "thrown error should be the deadline-exceeded message",
      );

      // The final, synchronous chat.update with a sandbox-failure message
      // should have been recorded BEFORE the throw propagated.
      const finalUpdates = log.filter(
        (e) => e.action === "update" && (e.text ?? "").includes("Sandbox failed to start"),
      );
      assert.ok(
        finalUpdates.length >= 1,
        `expected a final 'Sandbox failed to start' update, got: ${JSON.stringify(log)}`,
      );
      // It should reference the lastStatus we observed (setup).
      assert.match(
        finalUpdates[0].text ?? "",
        /Last status: setup/,
        "final error message should include the last observed status",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
