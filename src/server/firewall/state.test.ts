import assert from "node:assert/strict";
import test from "node:test";

import type { NetworkPolicy } from "@vercel/sandbox";

import { ApiError } from "@/shared/http";
import type { SingleMeta } from "@/shared/types";
import { DOMAIN_PRESETS, computePolicyHash, ensureMetaShape } from "@/shared/types";
import {
  _setAiGatewayCredentialOverrideForTesting,
  _setInstanceIdOverrideForTesting,
} from "@/server/env";
import {
  approveDomains,
  computeWouldBlock,
  dismissLearnedDomains,
  getFirewallReport,
  getFirewallState,
  ingestLearningFromSandbox,
  promoteLearnedDomainsToEnforcing,
  removeDomains,
  setFirewallMode,
  syncFirewallPolicyIfRunning,
} from "@/server/firewall/state";
import { toNetworkPolicy } from "@/server/firewall/policy";
import { parseFirewallFailClosedReason } from "@/server/firewall/fail-close";
import { _setSandboxControllerForTesting } from "@/server/sandbox/controller";
import type { SandboxController, SandboxHandle } from "@/server/sandbox/controller";
import {
  hostSuspensionOperationKey,
  learningLockKey,
  lifecycleLockKey,
} from "@/server/store/keyspace";
import {
  _resetStoreForTesting,
  getInitializedMeta,
  getStore,
  mutateMeta,
} from "@/server/store/store";
import { getServerLogs, _resetLogBuffer } from "@/server/log";

async function withFirewallTestStore(fn: () => Promise<void>): Promise<void> {
  const overrides: Record<string, string | undefined> = {
    NODE_ENV: "test",
    VERCEL: undefined,
    REDIS_URL: undefined,
    KV_URL: undefined,
    AI_GATEWAY_API_KEY: undefined,
    VERCEL_OIDC_TOKEN: undefined,
    NEXT_PUBLIC_APP_URL: undefined,
    NEXT_PUBLIC_BASE_DOMAIN: undefined,
    BASE_DOMAIN: undefined,
    VERCEL_PROJECT_PRODUCTION_URL: undefined,
    VERCEL_BRANCH_URL: undefined,
    VERCEL_URL: undefined,
  };
  const originals: Record<string, string | undefined> = {};

  for (const key of Object.keys(overrides)) {
    originals[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }

  // Default tests to no AI Gateway credential so firewall sync does not
  // inject a transform rule. Tests that exercise token injection explicitly
  // set their own credential override.
  _setAiGatewayCredentialOverrideForTesting(null);

  try {
    await fn();
  } finally {
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
    _setAiGatewayCredentialOverrideForTesting(null);
    _resetStoreForTesting();
    _resetLogBuffer();
  }
}

function withInstanceId<T>(
  instanceId: string | null,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const original = process.env.OPENCLAW_INSTANCE_ID;
  if (instanceId === null) {
    delete process.env.OPENCLAW_INSTANCE_ID;
  } else {
    process.env.OPENCLAW_INSTANCE_ID = instanceId;
  }
  _setInstanceIdOverrideForTesting(null);

  const restore = () => {
    if (original === undefined) {
      delete process.env.OPENCLAW_INSTANCE_ID;
    } else {
      process.env.OPENCLAW_INSTANCE_ID = original;
    }
    _setInstanceIdOverrideForTesting(null);
  };

  let result: T | Promise<T>;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }

  if (result instanceof Promise) {
    return result.finally(restore);
  }

  restore();
  return result;
}

async function prepareRunningSandbox(
  configure?: (meta: SingleMeta) => void,
): Promise<void> {
  await mutateMeta((meta) => {
    meta.status = "running";
    meta.sandboxId = "sandbox-123";
    configure?.(meta);
  });
}

function installFailingSandboxSync(options?: { stopFails?: boolean }): {
  readonly updateCalls: number;
  readonly stopCalls: number;
  readonly attemptedPolicies: NetworkPolicy[];
  readonly stopBlocking: boolean[];
  restore(): void;
} {
  let updateCalls = 0;
  let stopCalls = 0;
  const attemptedPolicies: NetworkPolicy[] = [];
  const stopBlocking: boolean[] = [];

  const fakeController: SandboxController = {
    async create() {
      throw new Error("not implemented in this test");
    },
    async get() {
      return {
        sandboxId: "sandbox-123",
        get timeout() { return 1800000; },
        get timeoutRemaining() { return 1800000; },
        get status() { return "running" as const; },
        async runCommand() {
          return { exitCode: 0, output: async () => "" };
        },
        async writeFiles() {},
        domain() {
          return "https://fake.vercel.run";
        },
        async snapshot() {
          return { snapshotId: "snap-123" };
        },
        async extendTimeout() {},
        async extendTimeoutWithoutResume() {},
        async updateNetworkPolicy(policy) {
          updateCalls += 1;
          attemptedPolicies.push(policy);
          throw new Error("sandbox policy update failed");
        },
        async readFileToBuffer() { return null; },
        async stop(stopOptions) {
          stopCalls += 1;
          stopBlocking.push(stopOptions?.blocking ?? true);
          if (options?.stopFails) {
            throw new Error("sandbox stop failed");
          }
        },
        async delete() {},
        async runDetachedCommand() { return { cmdId: "fake-cmd" }; },
        async getCommand() { return { async kill() {} }; },
      };
    },
  };

  _setSandboxControllerForTesting(fakeController);

  return {
    get updateCalls() {
      return updateCalls;
    },
    get stopCalls() {
      return stopCalls;
    },
    get attemptedPolicies() {
      return attemptedPolicies;
    },
    get stopBlocking() {
      return stopBlocking;
    },
    restore() {
      _setSandboxControllerForTesting(null);
    },
  };
}

async function assertFirewallSyncFailed(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 502);
    assert.equal(error.code, "FIREWALL_SYNC_FAILED");
    assert.equal(
      error.message,
      "Failed to sync firewall policy to the running sandbox.",
    );
    return true;
  });
}

test(
  "setFirewallMode throws FIREWALL_SYNC_FAILED when sandbox sync fails after persisting mode update",
  async () => {
    await withFirewallTestStore(async () => {
      const sandbox = installFailingSandboxSync();

      try {
        await prepareRunningSandbox();

        await assertFirewallSyncFailed(setFirewallMode("learning"));

        const firewall = await getFirewallState();
        assert.equal(firewall.mode, "learning");
        assert.equal(sandbox.updateCalls, 2);
        assert.equal(sandbox.stopCalls, 1);
        assert.deepEqual(sandbox.stopBlocking, [true]);
        assert.equal(sandbox.attemptedPolicies.at(-1), "deny-all");
        const meta = await getInitializedMeta();
        assert.equal(meta.status, "error");
        assert.equal(meta.portUrls, null);
      } finally {
        sandbox.restore();
      }
    });
  },
);

test("same-mode retry reconciles a previously failed policy apply", async () => {
  await withFirewallTestStore(async () => {
    const failing = installFailingSandboxSync();
    try {
      await prepareRunningSandbox();
      await assertFirewallSyncFailed(setFirewallMode("learning"));
    } finally {
      failing.restore();
    }

    const succeeding = installSucceedingSandboxController();
    try {
      await mutateMeta((meta) => {
        meta.status = "running";
      });
      await getStore().deleteValue(hostSuspensionOperationKey());
      const firewall = await setFirewallMode("learning");

      assert.equal(firewall.mode, "learning");
      assert.equal(succeeding.appliedPolicies.length, 1);
      assert.equal(firewall.lastSyncOutcome?.applied, true);
      assert.equal(firewall.lastSyncOutcome?.reason, "policy-applied");
    } finally {
      succeeding.restore();
    }
  });
});

test("firewall failure does not claim completion when deny-all and stop both fail", async () => {
  await withFirewallTestStore(async () => {
    const sandbox = installFailingSandboxSync({ stopFails: true });
    try {
      await prepareRunningSandbox();
      _resetLogBuffer();

      await assertFirewallSyncFailed(setFirewallMode("learning"));

      const meta = await getInitializedMeta();
      const messages = getServerLogs().map((entry) => entry.message);
      assert.equal(meta.status, "error");
      assert.deepEqual(sandbox.stopBlocking, [true]);
      assert.ok(messages.includes("firewall.fail_closed_incomplete"));
      assert.ok(!messages.includes("firewall.fail_closed"));
    } finally {
      sandbox.restore();
    }
  });
});

test(
  "approveDomains throws FIREWALL_SYNC_FAILED when sandbox sync fails after persisting allowlist update",
  async () => {
    await withFirewallTestStore(async () => {
      const sandbox = installFailingSandboxSync();

      try {
        await prepareRunningSandbox();

        await assertFirewallSyncFailed(approveDomains(["api.openai.com"]));

        const firewall = await getFirewallState();
        assert.deepEqual(firewall.allowlist, ["ai-gateway.vercel.sh", "api.openai.com"]);
        assert.equal(sandbox.updateCalls, 2);
        assert.equal(sandbox.stopCalls, 1);
      } finally {
        sandbox.restore();
      }
    });
  },
);

test(
  "removeDomains throws FIREWALL_SYNC_FAILED when sandbox sync fails after persisting allowlist removal",
  async () => {
    await withFirewallTestStore(async () => {
      const sandbox = installFailingSandboxSync();

      try {
        await prepareRunningSandbox((meta) => {
          meta.firewall.allowlist = ["api.openai.com", "vercel.com"];
        });

        await assertFirewallSyncFailed(removeDomains(["api.openai.com"]));

        const firewall = await getFirewallState();
        assert.deepEqual(firewall.allowlist, ["vercel.com"]);
        assert.equal(sandbox.updateCalls, 2);
        assert.equal(sandbox.stopCalls, 1);
      } finally {
        sandbox.restore();
      }
    });
  },
);

test(
  "promoteLearnedDomainsToEnforcing throws FIREWALL_SYNC_FAILED when sandbox sync fails after persisting promotion",
  async () => {
    await withFirewallTestStore(async () => {
      const sandbox = installFailingSandboxSync();

      try {
        await prepareRunningSandbox((meta) => {
          meta.firewall.mode = "learning";
          meta.firewall.learned = [
            {
              domain: "api.openai.com",
              firstSeenAt: 1,
              lastSeenAt: 2,
              hitCount: 3,
            },
          ];
        });

        await assertFirewallSyncFailed(promoteLearnedDomainsToEnforcing());

        const firewall = await getFirewallState();
        assert.equal(firewall.mode, "enforcing");
        assert.deepEqual(firewall.allowlist, ["ai-gateway.vercel.sh", "api.openai.com"]);
        assert.deepEqual(firewall.learned, []);
        assert.equal(sandbox.updateCalls, 2);
        assert.equal(sandbox.stopCalls, 1);
      } finally {
        sandbox.restore();
      }
    });
  },
);

// ===========================================================================
// Happy-path helpers — succeeding sandbox controller
// ===========================================================================

function installSucceedingSandboxController(opts?: {
  /** Shell command log content returned by `cat /tmp/shell-commands-for-learning.log` */
  shellLog?: string;
  onLearningRead?: () => void | Promise<void>;
  onLearningCleanup?: () => void | Promise<void>;
  onUpdateNetworkPolicy?: () => void | Promise<void>;
}): {
  readonly appliedPolicies: NetworkPolicy[];
  readonly commands: Array<{ command: string; args: string[] }>;
  restore(): void;
} {
  const appliedPolicies: NetworkPolicy[] = [];
  const commands: Array<{ command: string; args: string[] }> = [];
  const shellLog = opts?.shellLog ?? "";
  let pendingBatchId: string | null = null;

  const fakeController: SandboxController = {
    async create() {
      throw new Error("not implemented in this test");
    },
    async get() {
      return {
        sandboxId: "sandbox-123",
        get timeout() { return 1800000; },
        get timeoutRemaining() { return 1800000; },
        get status() { return "running" as const; },
        async runCommand(_cmd: string, args?: string[]) {
          commands.push({ command: _cmd, args: args ?? [] });
          const cmdStr = [_cmd, ...(args ?? [])].join(" ");
          // If reading the learning log, return the configured content
          if (cmdStr.includes('cat -- "$pending"')) {
            await opts?.onLearningRead?.();
            pendingBatchId ??= args?.[6] ?? "test-batch";
            return {
              exitCode: 0,
              output: async () =>
                `OPENCLAW_BATCH_ID=${pendingBatchId}\n${shellLog}`,
            };
          }
          if (cmdStr.includes("rm -f")) {
            await opts?.onLearningCleanup?.();
            pendingBatchId = null;
          }
          return { exitCode: 0, output: async () => "" };
        },
        async writeFiles() {},
        domain() {
          return "https://fake.vercel.run";
        },
        async snapshot() {
          return { snapshotId: "snap-123" };
        },
        async extendTimeout() {},
        async extendTimeoutWithoutResume() {},
        async updateNetworkPolicy(policy: NetworkPolicy) {
          appliedPolicies.push(policy);
          await opts?.onUpdateNetworkPolicy?.();
          return policy;
        },
        async readFileToBuffer() { return null; },
        async stop() {},
        async delete() {},
        async runDetachedCommand() { return { cmdId: "fake-cmd" }; },
        async getCommand() { return { async kill() {} }; },
      } satisfies SandboxHandle;
    },
  };

  _setSandboxControllerForTesting(fakeController);

  return {
    get appliedPolicies() {
      return appliedPolicies;
    },
    get commands() {
      return commands;
    },
    restore() {
      _setSandboxControllerForTesting(null);
    },
  };
}

// ===========================================================================
// Firewall mode transition tests (happy path)
// ===========================================================================

test("disabled → learning: mode changes, sandbox policy stays allow-all", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox();

      // Default mode is disabled
      let fw = await getFirewallState();
      assert.equal(fw.mode, "disabled");

      // Transition to learning
      fw = await setFirewallMode("learning");
      assert.equal(fw.mode, "learning");

      // Policy applied to sandbox should be allow-all (both disabled and learning map to allow-all)
      assert.equal(ctrl.appliedPolicies.length, 1);
      assert.equal(ctrl.appliedPolicies[0], "allow-all");
    } finally {
      ctrl.restore();
    }
  });
});

test("learning → enforcing: learned domains become the allowlist, sandbox policy updates to { allow: [...] }", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "learning";
        meta.firewall.learned = [
          { domain: "api.openai.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 5 },
          { domain: "registry.npmjs.org", firstSeenAt: 1, lastSeenAt: 3, hitCount: 2 },
        ];
      });

      // Promote learned domains to enforcing
      const fw = await promoteLearnedDomainsToEnforcing();

      assert.equal(fw.mode, "enforcing");
      assert.deepEqual(fw.allowlist, ["ai-gateway.vercel.sh", "api.openai.com", "registry.npmjs.org"]);
      assert.deepEqual(fw.learned, []);

      // Sandbox should have received { allow: [...] } policy
      assert.equal(ctrl.appliedPolicies.length, 1);
      const applied = ctrl.appliedPolicies[0] as { allow: string[] };
      assert.ok(typeof applied === "object" && "allow" in applied);
      assert.deepEqual(applied.allow, [
        "ai-gateway.vercel.sh",
        "api.openai.com",
        "registry.npmjs.org",
      ]);
    } finally {
      ctrl.restore();
    }
  });
});

test("enforcing: approveDomains updates allowlist and syncs sandbox policy", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "enforcing";
        meta.firewall.allowlist = ["api.openai.com"];
      });

      const fw = await approveDomains(["vercel.com"]);

      assert.deepEqual(fw.allowlist, ["api.openai.com", "vercel.com"]);
      assert.equal(ctrl.appliedPolicies.length, 1);
      const applied = ctrl.appliedPolicies[0] as { allow: string[] };
      assert.deepEqual(applied.allow, ["api.openai.com", "vercel.com"]);
    } finally {
      ctrl.restore();
    }
  });
});

test("enforcing: removeDomains updates allowlist and syncs sandbox policy", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "enforcing";
        meta.firewall.allowlist = ["api.openai.com", "registry.npmjs.org", "vercel.com"];
      });

      const fw = await removeDomains(["registry.npmjs.org"]);

      assert.deepEqual(fw.allowlist, ["api.openai.com", "vercel.com"]);
      assert.equal(ctrl.appliedPolicies.length, 1);
      const applied = ctrl.appliedPolicies[0] as { allow: string[] };
      assert.deepEqual(applied.allow, ["api.openai.com", "vercel.com"]);
    } finally {
      ctrl.restore();
    }
  });
});

test("full transition: disabled → learning → ingest domains → enforcing with allowlist", async () => {
  await withFirewallTestStore(async () => {
    const shellLog = [
      "curl https://api.openai.com/v1/chat/completions",
      "wget https://registry.npmjs.org/express",
    ].join("\n");

    const ctrl = installSucceedingSandboxController({ shellLog });
    try {
      await prepareRunningSandbox();

      // Step 1: disabled → learning
      let fw = await setFirewallMode("learning");
      assert.equal(fw.mode, "learning");
      assert.equal(ctrl.appliedPolicies.length, 1);
      assert.equal(ctrl.appliedPolicies[0], "allow-all");

      // Step 2: ingest domains from shell log
      const ingestResult = await ingestLearningFromSandbox(true);
      assert.equal(ingestResult.ingested, true);
      assert.ok(ingestResult.domains.includes("api.openai.com"));
      assert.ok(ingestResult.domains.includes("registry.npmjs.org"));

      // Verify learned domains stored in metadata
      fw = await getFirewallState();
      assert.equal(fw.learned.length, 2);
      const learnedNames = fw.learned.map((d) => d.domain).sort();
      assert.deepEqual(learnedNames, ["api.openai.com", "registry.npmjs.org"]);

      // Step 3: learning → enforcing (promote learned)
      fw = await promoteLearnedDomainsToEnforcing();
      assert.equal(fw.mode, "enforcing");
      assert.deepEqual(fw.allowlist, ["ai-gateway.vercel.sh", "api.openai.com", "registry.npmjs.org"]);
      assert.deepEqual(fw.learned, []);

      // Should have synced twice total (setFirewallMode + promote)
      assert.equal(ctrl.appliedPolicies.length, 2);
      const enforcingPolicy = ctrl.appliedPolicies[1] as { allow: string[] };
      assert.deepEqual(enforcingPolicy.allow, [
        "ai-gateway.vercel.sh",
        "api.openai.com",
        "registry.npmjs.org",
      ]);
    } finally {
      ctrl.restore();
    }
  });
});

test("learning ingestion: extracts domains from shell command log and stores in metadata", async () => {
  await withFirewallTestStore(async () => {
    const shellLog = [
      "dns lookup api.anthropic.com",
      "host: cdn.vercel.com",
      "https://hooks.slack.com/services/T123/B456",
    ].join("\n");

    const ctrl = installSucceedingSandboxController({ shellLog });
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "learning";
      });

      const result = await ingestLearningFromSandbox(true);

      assert.equal(result.ingested, true);
      assert.ok(result.domains.length >= 2, `Expected ≥2 domains, got ${result.domains.length}`);
      assert.ok(result.domains.includes("api.anthropic.com"));
      assert.ok(result.domains.includes("cdn.vercel.com"));
      assert.ok(result.domains.includes("hooks.slack.com"));

      // Verify learned entries have correct shape
      const fw = await getFirewallState();
      for (const entry of fw.learned) {
        assert.ok(typeof entry.domain === "string");
        assert.ok(typeof entry.firstSeenAt === "number");
        assert.ok(typeof entry.lastSeenAt === "number");
        assert.ok(typeof entry.hitCount === "number");
        assert.ok(entry.hitCount >= 1);
      }

      // Verify events were recorded
      assert.ok(
        fw.events.some((e) => e.action === "domain_observed"),
        "Expected at least one domain_observed event",
      );
    } finally {
      ctrl.restore();
    }
  });
});

test("learning ingestion leaves a generation-specific batch when the sandbox changes after read", async () => {
  await withFirewallTestStore(async () => {
    await prepareRunningSandbox((meta) => {
      meta.lifecycleAttemptId = "attempt-old";
      meta.firewall.mode = "learning";
      meta.firewall.learningStartedAt = 100;
    });
    const ctrl = installSucceedingSandboxController({
      shellLog: "curl https://api.openai.com/v1/models\n",
      onLearningRead: async () => {
        await mutateMeta((meta) => {
          meta.sandboxId = "sandbox-new";
          meta.lifecycleAttemptId = "attempt-new";
        });
      },
    });

    try {
      const result = await ingestLearningFromSandbox(true);
      const meta = await getInitializedMeta();

      assert.equal(result.ingested, false);
      assert.equal(result.reason, "sandbox-generation-changed");
      assert.deepEqual(meta.firewall.learned, []);
      assert.equal(meta.firewall.commandsObserved, 0);
      assert.equal(meta.firewall.lastIngestOutcome, null);
      assert.equal(
        ctrl.commands.filter((command) => command.args[1]?.includes("rm -f"))
          .length,
        0,
      );
      const read = ctrl.commands.find((command) =>
        command.args[1]?.includes('cat -- "$pending"'));
      assert.ok(read);
      assert.equal(read.args[3], "/tmp/shell-commands-for-learning.log");
      assert.match(read.args[4] ?? "", /\.pending$/);
    } finally {
      ctrl.restore();
    }
  });
});

test("learning ingestion clears draft acceptance when CAS retries against a replacement", async () => {
  await withFirewallTestStore(async () => {
    await prepareRunningSandbox((meta) => {
      meta.lifecycleAttemptId = "attempt-old";
      meta.firewall.mode = "learning";
      meta.firewall.learningStartedAt = 100;
    });
    const store = getStore();
    const originalCompareAndSetMeta = store.compareAndSetMeta.bind(store);
    let replaceOnFirstCommit = true;
    store.compareAndSetMeta = async (expectedVersion, next) => {
      if (replaceOnFirstCommit) {
        replaceOnFirstCommit = false;
        const current = await getInitializedMeta();
        const replacement = structuredClone(current);
        replacement.sandboxId = "sandbox-new";
        replacement.lifecycleAttemptId = "attempt-new";
        replacement.version = current.version + 1;
        assert.equal(
          await originalCompareAndSetMeta(current.version, replacement),
          true,
        );
        return false;
      }
      return originalCompareAndSetMeta(expectedVersion, next);
    };
    const ctrl = installSucceedingSandboxController({
      shellLog: "curl https://api.openai.com/v1/models\n",
    });

    try {
      const result = await ingestLearningFromSandbox(true);
      const meta = await getInitializedMeta();

      assert.equal(result.reason, "sandbox-generation-changed");
      assert.equal(meta.sandboxId, "sandbox-new");
      assert.equal(meta.lifecycleAttemptId, "attempt-new");
      assert.deepEqual(meta.firewall.learned, []);
      assert.equal(meta.firewall.commandsObserved, 0);
      assert.equal(meta.firewall.lastIngestOutcome, null);
      assert.equal(
        ctrl.commands.filter((command) => command.args[1]?.includes("rm -f"))
          .length,
        0,
      );
    } finally {
      store.compareAndSetMeta = originalCompareAndSetMeta;
      ctrl.restore();
    }
  });
});

test("learning ingestion does not commit or delete its batch after leaving learning mode", async () => {
  await withFirewallTestStore(async () => {
    await prepareRunningSandbox((meta) => {
      meta.lifecycleAttemptId = "attempt-1";
      meta.firewall.mode = "learning";
      meta.firewall.learningStartedAt = 100;
    });
    const ctrl = installSucceedingSandboxController({
      shellLog: "curl https://api.openai.com/v1/models\n",
      onLearningRead: async () => {
        await mutateMeta((meta) => {
          meta.firewall.mode = "enforcing";
        });
      },
    });

    try {
      const result = await ingestLearningFromSandbox(true);
      const meta = await getInitializedMeta();

      assert.equal(result.reason, "sandbox-generation-changed");
      assert.equal(meta.firewall.mode, "enforcing");
      assert.deepEqual(meta.firewall.learned, []);
      assert.equal(meta.firewall.commandsObserved, 0);
      assert.equal(meta.firewall.lastIngestOutcome, null);
      assert.equal(
        ctrl.commands.filter((command) => command.args[1]?.includes("rm -f"))
          .length,
        0,
      );
    } finally {
      ctrl.restore();
    }
  });
});

test("learning ingestion deletes the pending batch only after an accepted commit", async () => {
  await withFirewallTestStore(async () => {
    await prepareRunningSandbox((meta) => {
      meta.lifecycleAttemptId = "attempt-1";
      meta.firewall.mode = "learning";
      meta.firewall.learningStartedAt = 100;
    });
    const ctrl = installSucceedingSandboxController({
      shellLog: "curl https://api.openai.com/v1/models\n",
    });

    try {
      const result = await ingestLearningFromSandbox(true);
      const meta = await getInitializedMeta();
      const read = ctrl.commands.find((command) =>
        command.args[1]?.includes('cat -- "$pending"'));
      const cleanup = ctrl.commands.find((command) =>
        command.args[1]?.includes("rm -f"));

      assert.equal(result.reason, "updated");
      assert.deepEqual(meta.firewall.learned.map((entry) => entry.domain), [
        "api.openai.com",
      ]);
      assert.equal(meta.firewall.lastIngestOutcome?.skipReason, null);
      assert.ok(read);
      assert.ok(cleanup);
      assert.equal(cleanup.args[3], read.args[4]);
      assert.equal(
        read.args[1]?.includes("/tmp/shell-commands-for-learning.log"),
        false,
      );
    } finally {
      ctrl.restore();
    }
  });
});

test("learning ingestion does not replay a committed batch after cleanup failure", async () => {
  await withFirewallTestStore(async () => {
    await prepareRunningSandbox((meta) => {
      meta.lifecycleAttemptId = "attempt-1";
      meta.firewall.mode = "learning";
      meta.firewall.learningStartedAt = 100;
    });
    let cleanupCalls = 0;
    const ctrl = installSucceedingSandboxController({
      shellLog: "curl https://api.openai.com/v1/models\n",
      onLearningCleanup: () => {
        cleanupCalls += 1;
        if (cleanupCalls === 1) throw new Error("cleanup failed");
      },
    });

    try {
      assert.equal((await ingestLearningFromSandbox(true)).reason, "updated");
      assert.equal(
        (await ingestLearningFromSandbox(true)).reason,
        "already-committed",
      );
      const meta = await getInitializedMeta();
      assert.equal(meta.firewall.commandsObserved, 1);
      assert.equal(meta.firewall.learned[0]?.hitCount, 1);
      assert.equal(cleanupCalls, 2);
    } finally {
      ctrl.restore();
    }
  });
});

test("learning ingestion: skips when mode is not learning", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController({ shellLog: "https://api.openai.com" });
    try {
      await prepareRunningSandbox(); // mode = disabled (default)

      const result = await ingestLearningFromSandbox(true);

      assert.equal(result.ingested, false);
      assert.equal(result.reason, "mode-not-learning");
      assert.deepEqual(result.domains, []);
    } finally {
      ctrl.restore();
    }
  });
});

test("toNetworkPolicy: disabled and learning return allow-all, enforcing returns { allow: [...] }", () => {
  assert.equal(toNetworkPolicy("disabled", []), "allow-all");
  assert.equal(toNetworkPolicy("learning", ["api.openai.com"]), "allow-all");
  assert.deepEqual(toNetworkPolicy("enforcing", ["vercel.com", "api.openai.com"]), {
    allow: ["api.openai.com", "vercel.com"],
  });
});

// ===========================================================================
// Sync while stopped: setFirewallMode when sandbox is not running
// ===========================================================================

test("setFirewallMode succeeds when sandbox is stopped (no sync needed)", async () => {
  await withFirewallTestStore(async () => {
    // Leave sandbox as uninitialized (default) — no sandboxId, no running instance
    const fw = await setFirewallMode("learning");
    assert.equal(fw.mode, "learning");
    // No sync should have been attempted — no sandbox to sync to
  });
});

test("approveDomains succeeds when sandbox is stopped (no sync)", async () => {
  await withFirewallTestStore(async () => {
    const fw = await approveDomains(["api.openai.com"]);
    assert.deepEqual(fw.allowlist, ["ai-gateway.vercel.sh", "api.openai.com"]);
  });
});

test("removeDomains succeeds when sandbox is stopped (no sync)", async () => {
  await withFirewallTestStore(async () => {
    await mutateMeta((meta) => {
      meta.firewall.allowlist = ["api.openai.com", "vercel.com"];
    });
    const fw = await removeDomains(["api.openai.com"]);
    assert.deepEqual(fw.allowlist, ["vercel.com"]);
  });
});

// ===========================================================================
// setFirewallMode to enforcing with empty allowlist is rejected
// ===========================================================================

test("setFirewallMode to enforcing with empty allowlist throws 409", async () => {
  await withFirewallTestStore(async () => {
    // Clear the default-seeded allowlist so the empty-allowlist guard is tested
    await mutateMeta((meta) => {
      meta.firewall.allowlist = [];
    });
    await assert.rejects(
      setFirewallMode("enforcing"),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 409);
        assert.equal(error.code, "FIREWALL_ALLOWLIST_EMPTY");
        return true;
      },
    );
  });
});

// ===========================================================================
// Domain merge: ingesting same domain multiple times increments hitCount
// ===========================================================================

test("learning ingestion: enriches events with sourceCommand and category, and learned domains with categories", async () => {
  await withFirewallTestStore(async () => {
    const shellLog = [
      "curl https://api.openai.com/v1/chat/completions",
      "npm http fetch GET 200 https://registry.npmjs.org/typescript 50ms",
    ].join("\n");

    const ctrl = installSucceedingSandboxController({ shellLog });
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "learning";
      });

      const result = await ingestLearningFromSandbox(true);
      assert.equal(result.ingested, true);

      const fw = await getFirewallState();

      // Verify events carry sourceCommand and category
      const curlEvent = fw.events.find(
        (e) => e.domain === "api.openai.com" && e.action === "domain_observed",
      );
      assert.ok(curlEvent, "Expected domain_observed event for api.openai.com");
      assert.equal(curlEvent.category, "curl");
      assert.ok(curlEvent.sourceCommand?.includes("curl"));

      const npmEvent = fw.events.find(
        (e) => e.domain === "registry.npmjs.org" && e.action === "domain_observed",
      );
      assert.ok(npmEvent, "Expected domain_observed event for registry.npmjs.org");
      assert.equal(npmEvent.category, "npm");

      // Verify learned domains carry categories
      const openaiLearned = fw.learned.find((l) => l.domain === "api.openai.com");
      assert.ok(openaiLearned);
      assert.ok(openaiLearned.categories?.includes("curl"));

      const npmLearned = fw.learned.find((l) => l.domain === "registry.npmjs.org");
      assert.ok(npmLearned);
      assert.ok(npmLearned.categories?.includes("npm"));
    } finally {
      ctrl.restore();
    }
  });
});

test("learning ingestion: caps learned list at 500 entries", async () => {
  await withFirewallTestStore(async () => {
    // Pre-fill with 499 learned domains so ingesting 2 more exceeds the 500 cap
    const existing = Array.from({ length: 499 }, (_, i) => ({
      domain: `d${String(i).padStart(4, "0")}.example.com`,
      firstSeenAt: 1000,
      lastSeenAt: 2000,
      hitCount: 1,
    }));

    const shellLog = [
      "curl https://new-a.example.com/api",
      "curl https://new-b.example.com/api",
    ].join("\n");

    const ctrl = installSucceedingSandboxController({ shellLog });
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "learning";
        meta.firewall.learned = existing;
      });

      const result = await ingestLearningFromSandbox(true);
      assert.equal(result.ingested, true);

      const fw = await getFirewallState();
      // 499 existing + 2 new = 501 → capped at 500
      assert.equal(fw.learned.length, 500);

      // New domains should be present (sorted by lastSeenAt desc, newest first)
      const learnedDomains = fw.learned.map((e) => e.domain);
      assert.ok(learnedDomains.includes("new-a.example.com"));
      assert.ok(learnedDomains.includes("new-b.example.com"));
    } finally {
      ctrl.restore();
    }
  });
});

test("learning ingestion: re-ingesting same domain increments hitCount", async () => {
  await withFirewallTestStore(async () => {
    const shellLog = "curl https://api.openai.com/v1/chat";
    const ctrl = installSucceedingSandboxController({ shellLog });
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "learning";
      });

      // First ingestion
      const r1 = await ingestLearningFromSandbox(true);
      assert.equal(r1.ingested, true);

      let fw = await getFirewallState();
      const firstEntry = fw.learned.find((e) => e.domain === "api.openai.com");
      assert.ok(firstEntry);
      assert.equal(firstEntry.hitCount, 1);

      // Second ingestion with same domain
      const r2 = await ingestLearningFromSandbox(true);
      assert.equal(r2.ingested, true);

      fw = await getFirewallState();
      const secondEntry = fw.learned.find((e) => e.domain === "api.openai.com");
      assert.ok(secondEntry);
      assert.equal(secondEntry.hitCount, 2);
    } finally {
      ctrl.restore();
    }
  });
});

// ===========================================================================
// wouldBlock computation tests
// ===========================================================================

test("computeWouldBlock: returns learned domains not in allowlist when mode is learning", () => {
  const state = {
    mode: "learning" as const,
    allowlist: ["api.openai.com"],
    learned: [
      { domain: "api.openai.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 1 },
      { domain: "cdn.vercel.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 1 },
      { domain: "registry.npmjs.org", firstSeenAt: 1, lastSeenAt: 2, hitCount: 1 },
    ],
    events: [],
    updatedAt: 0,
    lastIngestedAt: null,
    learningStartedAt: null,
    commandsObserved: 0,
    wouldBlock: [],
    lastSyncAppliedAt: null,
    lastSyncFailedAt: null,
    lastSyncReason: null,
    lastIngestionSkipReason: null,
    ingestionSkipCount: 0,
    lastIngestOutcome: null,
    lastSyncOutcome: null,
  };

  const result = computeWouldBlock(state);
  assert.deepEqual(result, ["cdn.vercel.com", "registry.npmjs.org"]);
});

test("computeWouldBlock: returns empty array when mode is disabled", () => {
  const state = {
    mode: "disabled" as const,
    allowlist: [],
    learned: [
      { domain: "cdn.vercel.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 1 },
    ],
    events: [],
    updatedAt: 0,
    lastIngestedAt: null,
    learningStartedAt: null,
    commandsObserved: 0,
    wouldBlock: [],
    lastSyncAppliedAt: null,
    lastSyncFailedAt: null,
    lastSyncReason: null,
    lastIngestionSkipReason: null,
    ingestionSkipCount: 0,
    lastIngestOutcome: null,
    lastSyncOutcome: null,
  };

  assert.deepEqual(computeWouldBlock(state), []);
});

test("computeWouldBlock: returns empty array when mode is enforcing", () => {
  const state = {
    mode: "enforcing" as const,
    allowlist: ["api.openai.com"],
    learned: [],
    events: [],
    updatedAt: 0,
    lastIngestedAt: null,
    learningStartedAt: null,
    commandsObserved: 0,
    wouldBlock: [],
    lastSyncAppliedAt: null,
    lastSyncFailedAt: null,
    lastSyncReason: null,
    lastIngestionSkipReason: null,
    ingestionSkipCount: 0,
    lastIngestOutcome: null,
    lastSyncOutcome: null,
  };

  assert.deepEqual(computeWouldBlock(state), []);
});

test("computeWouldBlock: returns empty when all learned domains are in allowlist", () => {
  const state = {
    mode: "learning" as const,
    allowlist: ["api.openai.com", "cdn.vercel.com"],
    learned: [
      { domain: "api.openai.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 1 },
      { domain: "cdn.vercel.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 1 },
    ],
    events: [],
    updatedAt: 0,
    lastIngestedAt: null,
    learningStartedAt: null,
    commandsObserved: 0,
    wouldBlock: [],
    lastSyncAppliedAt: null,
    lastSyncFailedAt: null,
    lastSyncReason: null,
    lastIngestionSkipReason: null,
    ingestionSkipCount: 0,
    lastIngestOutcome: null,
    lastSyncOutcome: null,
  };

  assert.deepEqual(computeWouldBlock(state), []);
});

test("getFirewallState: includes wouldBlock in response during learning", async () => {
  await withFirewallTestStore(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "learning";
      meta.firewall.allowlist = ["api.openai.com"];
      meta.firewall.learned = [
        { domain: "api.openai.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 1 },
        { domain: "cdn.vercel.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 3 },
      ];
    });

    const fw = await getFirewallState();
    assert.deepEqual(fw.wouldBlock, ["cdn.vercel.com"]);
  });
});

test("getFirewallState: wouldBlock is empty when mode is disabled", async () => {
  await withFirewallTestStore(async () => {
    await mutateMeta((meta) => {
      meta.firewall.learned = [
        { domain: "cdn.vercel.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 1 },
      ];
    });

    const fw = await getFirewallState();
    assert.deepEqual(fw.wouldBlock, []);
  });
});

// ===========================================================================
// Soak-time tracking tests
// ===========================================================================

test("setFirewallMode('learning') sets learningStartedAt and resets commandsObserved", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.commandsObserved = 42;
        meta.firewall.learningStartedAt = 1000;
      });

      const before = Date.now();
      const fw = await setFirewallMode("learning");

      assert.equal(fw.mode, "learning");
      assert.equal(fw.commandsObserved, 0);
      assert.ok(
        fw.learningStartedAt !== null && fw.learningStartedAt >= before,
        "learningStartedAt should be set to current time",
      );
    } finally {
      ctrl.restore();
    }
  });
});

test("each learning activation receives a distinct random epoch", async () => {
  await withFirewallTestStore(async () => {
    const first = await setFirewallMode("learning");
    await setFirewallMode("disabled");
    const second = await setFirewallMode("learning");

    assert.ok(first.learningEpochId);
    assert.ok(second.learningEpochId);
    assert.notEqual(first.learningEpochId, second.learningEpochId);
  });
});

test("setFirewallMode('disabled') does not reset learningStartedAt", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "learning";
        meta.firewall.learningStartedAt = 5000;
        meta.firewall.commandsObserved = 10;
      });

      const fw = await setFirewallMode("disabled");
      assert.equal(fw.mode, "disabled");
      // learningStartedAt and commandsObserved are preserved (not reset) when leaving learning
      assert.equal(fw.learningStartedAt, 5000);
      assert.equal(fw.commandsObserved, 10);
    } finally {
      ctrl.restore();
    }
  });
});

test("ingestLearningFromSandbox increments commandsObserved by number of log lines", async () => {
  await withFirewallTestStore(async () => {
    const shellLog = [
      "curl https://api.openai.com/v1/chat",
      "npm http fetch GET 200 https://registry.npmjs.org/express",
      "some other command without a domain",
    ].join("\n");

    const ctrl = installSucceedingSandboxController({ shellLog });
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "learning";
        meta.firewall.commandsObserved = 5;
      });

      await ingestLearningFromSandbox(true);

      const fw = await getFirewallState();
      // 5 existing + 3 log lines = 8
      assert.equal(fw.commandsObserved, 8);
    } finally {
      ctrl.restore();
    }
  });
});

test("ingestLearningFromSandbox increments commandsObserved even when no domains are found", async () => {
  await withFirewallTestStore(async () => {
    const shellLog = "ls -la\necho hello";
    const ctrl = installSucceedingSandboxController({ shellLog });
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "learning";
        meta.firewall.commandsObserved = 0;
      });

      await ingestLearningFromSandbox(true);

      const fw = await getFirewallState();
      assert.equal(fw.commandsObserved, 2);
    } finally {
      ctrl.restore();
    }
  });
});

// ===========================================================================
// DOMAIN_PRESETS tests
// ===========================================================================

test("DOMAIN_PRESETS contains at least 4 presets with non-empty domain lists", () => {
  const keys = Object.keys(DOMAIN_PRESETS);
  assert.ok(keys.length >= 4, `Expected ≥4 presets, got ${keys.length}`);
  for (const key of keys) {
    const preset = DOMAIN_PRESETS[key];
    assert.ok(preset.label.length > 0, `Preset ${key} should have a label`);
    assert.ok(preset.domains.length > 0, `Preset ${key} should have at least one domain`);
    for (const domain of preset.domains) {
      assert.ok(domain.includes("."), `Domain ${domain} in preset ${key} should be a valid hostname`);
    }
  }
});

test("DOMAIN_PRESETS domains can be approved via approveDomains", async () => {
  await withFirewallTestStore(async () => {
    const fw = await approveDomains(DOMAIN_PRESETS.npm.domains);
    for (const domain of DOMAIN_PRESETS.npm.domains) {
      assert.ok(fw.allowlist.includes(domain), `Expected ${domain} in allowlist`);
    }
  });
});

// ===========================================================================
// ensureMetaShape migration tests for new fields
// ===========================================================================

test("ensureMetaShape: migrates metadata missing learningStartedAt and commandsObserved", () => {
  const old = {
    _schemaVersion: 1,
    version: 1,
    id: "openclaw-single",
    sandboxId: null,
    snapshotId: null,
    status: "running",
    gatewayToken: "tok",
    createdAt: 1000,
    updatedAt: 2000,
    lastAccessedAt: null,
    portUrls: null,
    startupScript: null,
    lastError: null,
    firewall: {
      mode: "learning",
      allowlist: ["example.com"],
      learned: [],
      events: [],
      updatedAt: 1000,
      lastIngestedAt: null,
      // No learningStartedAt or commandsObserved
    },
    lastTokenRefreshAt: null,
    channels: {},
    snapshotHistory: [],
  };

  const result = ensureMetaShape(old);
  assert.ok(result);
  assert.equal(result.firewall.learningStartedAt, null);
  assert.equal(result.firewall.commandsObserved, 0);
});

// ===========================================================================
// Same-mode idempotency tests
// ===========================================================================

test("setFirewallMode preserves same-mode state while reconciling policy", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "learning";
        meta.firewall.learningStartedAt = 5000;
        meta.firewall.commandsObserved = 42;
        meta.firewall.updatedAt = 9000;
      });

      const fw = await setFirewallMode("learning");

      // Mode unchanged, learning counters preserved (not reset)
      assert.equal(fw.mode, "learning");
      assert.equal(fw.learningStartedAt, 5000);
      assert.equal(fw.commandsObserved, 42);

      assert.equal(ctrl.appliedPolicies.length, 1);
    } finally {
      ctrl.restore();
    }
  });
});

test("setFirewallMode is a no-op for disabled → disabled", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox(); // default mode is disabled

      const fw = await setFirewallMode("disabled");
      assert.equal(fw.mode, "disabled");
      assert.equal(ctrl.appliedPolicies.length, 1);
    } finally {
      ctrl.restore();
    }
  });
});

// ===========================================================================
// Single sync per mode change (no double sync)
// ===========================================================================

test("setFirewallMode syncs sandbox policy exactly once per mode change", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox();

      await setFirewallMode("learning");
      assert.equal(ctrl.appliedPolicies.length, 1, "Expected exactly 1 sync for mode change");

      // Same mode reconciles again in case a prior SDK apply failed after the
      // desired metadata was persisted.
      await setFirewallMode("learning");
      assert.equal(ctrl.appliedPolicies.length, 2);
    } finally {
      ctrl.restore();
    }
  });
});

// ===========================================================================
// removeDomains rejects emptying allowlist while enforcing
// ===========================================================================

test("removeDomains rejects with 409 when removal would empty allowlist while enforcing", async () => {
  await withFirewallTestStore(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["api.openai.com"];
    });

    await assert.rejects(
      removeDomains(["api.openai.com"]),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 409);
        assert.equal(error.code, "FIREWALL_ALLOWLIST_EMPTY");
        return true;
      },
    );

    // Allowlist should be unchanged
    const fw = await getFirewallState();
    assert.deepEqual(fw.allowlist, ["api.openai.com"]);
  });
});

test("removeDomains allows partial removal while enforcing (non-empty result)", async () => {
  await withFirewallTestStore(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["api.openai.com", "vercel.com"];
    });

    const fw = await removeDomains(["api.openai.com"]);
    assert.deepEqual(fw.allowlist, ["vercel.com"]);
  });
});

test("removeDomains allows emptying allowlist when mode is not enforcing", async () => {
  await withFirewallTestStore(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "learning";
      meta.firewall.allowlist = ["api.openai.com"];
    });

    const fw = await removeDomains(["api.openai.com"]);
    assert.deepEqual(fw.allowlist, []);
  });
});

// ===========================================================================
// computeWouldBlock deduplicates learned domains
// ===========================================================================

test("computeWouldBlock deduplicates when learned list contains duplicate domain entries", () => {
  const state = {
    mode: "learning" as const,
    allowlist: [],
    learned: [
      { domain: "cdn.vercel.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 1 },
      { domain: "cdn.vercel.com", firstSeenAt: 3, lastSeenAt: 4, hitCount: 2 },
      { domain: "api.openai.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 1 },
    ],
    events: [],
    updatedAt: 0,
    lastIngestedAt: null,
    learningStartedAt: null,
    commandsObserved: 0,
    wouldBlock: [],
    lastSyncAppliedAt: null,
    lastSyncFailedAt: null,
    lastSyncReason: null,
    lastIngestionSkipReason: null,
    ingestionSkipCount: 0,
    lastIngestOutcome: null,
    lastSyncOutcome: null,
  };

  const result = computeWouldBlock(state);
  assert.deepEqual(result, ["api.openai.com", "cdn.vercel.com"]);
});

test("ensureMetaShape: preserves existing learningStartedAt and commandsObserved", () => {
  const existing = {
    _schemaVersion: 2,
    version: 1,
    id: "openclaw-single",
    sandboxId: null,
    snapshotId: null,
    status: "running",
    gatewayToken: "tok",
    createdAt: 1000,
    updatedAt: 2000,
    lastAccessedAt: null,
    portUrls: null,
    startupScript: null,
    lastError: null,
    firewall: {
      mode: "learning",
      allowlist: [],
      learned: [],
      events: [],
      updatedAt: 1000,
      lastIngestedAt: null,
      learningStartedAt: 5000,
      commandsObserved: 42,
    },
    lastTokenRefreshAt: null,
    channels: {},
    snapshotHistory: [],
  };

  const result = ensureMetaShape(existing);
  assert.ok(result);
  assert.equal(result.firewall.learningStartedAt, 5000);
  assert.equal(result.firewall.commandsObserved, 42);
});

// ===========================================================================
// Structured logging: logWarn before ApiError throws
// ===========================================================================

test("setFirewallMode to enforcing with empty allowlist emits logWarn before throwing", async () => {
  await withFirewallTestStore(async () => {
    // Clear the default-seeded allowlist so the empty-allowlist guard is tested
    await mutateMeta((meta) => {
      meta.firewall.allowlist = [];
    });
    _resetLogBuffer();
    await assert.rejects(
      setFirewallMode("enforcing"),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "FIREWALL_ALLOWLIST_EMPTY");
        return true;
      },
    );

    const logs = getServerLogs();
    const warnLog = logs.find(
      (e) => e.level === "warn" && e.data?.code === "FIREWALL_ALLOWLIST_EMPTY",
    );
    assert.ok(warnLog, "Expected logWarn with FIREWALL_ALLOWLIST_EMPTY before throw");
    assert.equal(warnLog.message, "firewall.mode_change_failed");
  });
});

test("approveDomains with invalid domains emits logWarn before throwing", async () => {
  await withFirewallTestStore(async () => {
    _resetLogBuffer();
    await assert.rejects(
      approveDomains(["not-valid"]),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "INVALID_DOMAINS");
        return true;
      },
    );

    const logs = getServerLogs();
    const warnLog = logs.find(
      (e) => e.level === "warn" && e.data?.code === "INVALID_DOMAINS",
    );
    assert.ok(warnLog, "Expected logWarn with INVALID_DOMAINS before throw");
  });
});

test("removeDomains with invalid domains emits logWarn before throwing", async () => {
  await withFirewallTestStore(async () => {
    _resetLogBuffer();
    await assert.rejects(
      removeDomains(["not-valid"]),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "INVALID_DOMAINS");
        return true;
      },
    );

    const logs = getServerLogs();
    const warnLog = logs.find(
      (e) => e.level === "warn" && e.data?.code === "INVALID_DOMAINS",
    );
    assert.ok(warnLog, "Expected logWarn with INVALID_DOMAINS before throw");
  });
});

test("removeDomains emptying allowlist while enforcing emits logWarn before throwing", async () => {
  await withFirewallTestStore(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["api.openai.com"];
    });

    _resetLogBuffer();
    await assert.rejects(
      removeDomains(["api.openai.com"]),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "FIREWALL_ALLOWLIST_EMPTY");
        return true;
      },
    );

    const logs = getServerLogs();
    const warnLog = logs.find(
      (e) => e.level === "warn" && e.data?.code === "FIREWALL_ALLOWLIST_EMPTY",
    );
    assert.ok(warnLog, "Expected logWarn with FIREWALL_ALLOWLIST_EMPTY before throw");
  });
});

test("dismissLearnedDomains with invalid domains emits logWarn before throwing", async () => {
  await withFirewallTestStore(async () => {
    _resetLogBuffer();
    await assert.rejects(
      dismissLearnedDomains(["not-valid"]),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "INVALID_DOMAINS");
        return true;
      },
    );

    const logs = getServerLogs();
    const warnLog = logs.find(
      (e) => e.level === "warn" && e.data?.code === "INVALID_DOMAINS",
    );
    assert.ok(warnLog, "Expected logWarn with INVALID_DOMAINS before throw");
  });
});

// ===========================================================================
// Structured logging: ingestion skip reasons
// ===========================================================================

test("ingestLearningFromSandbox returns skip reason when mode is not learning", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox(); // mode = disabled

      const result = await ingestLearningFromSandbox(true);
      assert.equal(result.ingested, false);
      assert.equal(result.reason, "mode-not-learning");
    } finally {
      ctrl.restore();
    }
  });
});

test("ingestLearningFromSandbox returns skip reason when sandbox is not running", async () => {
  await withFirewallTestStore(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "learning";
      meta.status = "stopped";
    });

    const result = await ingestLearningFromSandbox(true);
    assert.equal(result.ingested, false);
    assert.equal(result.reason, "sandbox-not-running");
  });
});

test("ingestLearningFromSandbox acquires the learning lock with the active instance id", async () => {
  await withFirewallTestStore(async () => {
    await withInstanceId("fork-a", async () => {
      const ctrl = installSucceedingSandboxController();
      try {
        await prepareRunningSandbox((meta) => {
          meta.firewall.mode = "learning";
        });

        const storeModule = await import("@/server/store/store");
        const store = storeModule.getStore();
        const originalAcquireLock = store.acquireLock.bind(store);
        const originalReleaseLock = store.releaseLock.bind(store);
        const acquiredKeys: string[] = [];
        const releasedKeys: string[] = [];

        store.acquireLock = async (key, ttlSeconds) => {
          acquiredKeys.push(key);
          return originalAcquireLock(key, ttlSeconds);
        };
        store.releaseLock = async (key, token) => {
          releasedKeys.push(key);
          return originalReleaseLock(key, token);
        };

        try {
          await ingestLearningFromSandbox(true);
        } finally {
          store.acquireLock = originalAcquireLock;
          store.releaseLock = originalReleaseLock;
        }

        assert.deepEqual(acquiredKeys, [lifecycleLockKey(), learningLockKey()]);
        assert.deepEqual(releasedKeys, [learningLockKey(), lifecycleLockKey()]);
      } finally {
        ctrl.restore();
      }
    });
  });
});

// ===========================================================================
// Request correlation: requestId passed through mutation functions
// ===========================================================================

test("setFirewallMode includes requestId in log entries", async () => {
  await withFirewallTestStore(async () => {
    _resetLogBuffer();
    await setFirewallMode("learning", { requestId: "req-abc-123" });

    const logs = getServerLogs();
    const modeChangeLog = logs.find(
      (e) => e.message === "firewall.mode_change_requested" && e.data?.requestId === "req-abc-123",
    );
    assert.ok(modeChangeLog, "Expected firewall.mode_change_requested log with requestId");
  });
});

// ===========================================================================
// FirewallIngestOutcome and FirewallSyncOutcome
// ===========================================================================

test("computePolicyHash: deterministic — same inputs produce same hash", () => {
  const h1 = computePolicyHash("enforcing", ["b.com", "a.com"]);
  const h2 = computePolicyHash("enforcing", ["a.com", "b.com"]);
  assert.equal(h1, h2, "Hash must be deterministic regardless of allowlist order");
  assert.equal(h1.length, 64, "SHA-256 hex should be 64 chars");
});

test("computePolicyHash: different mode produces different hash", () => {
  const h1 = computePolicyHash("enforcing", ["a.com"]);
  const h2 = computePolicyHash("disabled", ["a.com"]);
  assert.notEqual(h1, h2, "Different modes must produce different hashes");
});

test("computePolicyHash: different allowlist produces different hash", () => {
  const h1 = computePolicyHash("enforcing", ["a.com"]);
  const h2 = computePolicyHash("enforcing", ["a.com", "b.com"]);
  assert.notEqual(h1, h2, "Different allowlists must produce different hashes");
});

test("computePolicyHash: required control-plane domains affect the applied policy hash", () => {
  const withoutControlPlane = computePolicyHash("enforcing", ["a.com"]);
  const withControlPlane = computePolicyHash(
    "enforcing",
    ["a.com"],
    ["app.example.com"],
  );
  assert.notEqual(withoutControlPlane, withControlPlane);
});

test("syncFirewallPolicyIfRunning returns FirewallSyncOutcome with policyHash", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox();
      const outcome = await syncFirewallPolicyIfRunning();
      assert.equal(typeof outcome.timestamp, "number");
      assert.equal(typeof outcome.durationMs, "number");
      assert.equal(typeof outcome.allowlistCount, "number");
      assert.equal(typeof outcome.policyHash, "string");
      assert.equal(outcome.policyHash.length, 64);
      assert.equal(typeof outcome.applied, "boolean");
      assert.equal(typeof outcome.reason, "string");
    } finally {
      ctrl.restore();
    }
  });
});

test("syncFirewallPolicyIfRunning persists lastSyncOutcome in metadata", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox();
      await syncFirewallPolicyIfRunning();
      const state = await getFirewallState();
      assert.ok(state.lastSyncOutcome, "lastSyncOutcome should be persisted");
      assert.equal(state.lastSyncOutcome.applied, true);
      assert.equal(state.lastSyncOutcome.reason, "policy-applied");
      assert.equal(state.lastSyncOutcome.policyHash.length, 64);
    } finally {
      ctrl.restore();
    }
  });
});

test("syncFirewallPolicyIfRunning cannot attribute an old apply to a replacement generation", async () => {
  await withFirewallTestStore(async () => {
    await prepareRunningSandbox((meta) => {
      meta.lifecycleAttemptId = "attempt-old";
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["api.openai.com"];
    });
    const ctrl = installSucceedingSandboxController({
      onUpdateNetworkPolicy: async () => {
        await mutateMeta((meta) => {
          meta.sandboxId = "sandbox-replacement";
          meta.lifecycleAttemptId = "attempt-new";
          meta.status = "booting";
        });
      },
    });

    try {
      const outcome = await syncFirewallPolicyIfRunning();
      const meta = await getInitializedMeta();

      assert.equal(outcome.applied, false);
      assert.equal(outcome.reason, "sandbox-generation-changed");
      assert.equal(meta.sandboxId, "sandbox-replacement");
      assert.equal(meta.lifecycleAttemptId, "attempt-new");
      assert.equal(meta.firewall.lastSyncAppliedAt, null);
      assert.equal(meta.firewall.lastSyncReason, null);
      assert.equal(meta.firewall.lastSyncOutcome, null);
    } finally {
      ctrl.restore();
    }
  });
});

test("firewall mutations never retry a stale worker against a replacement generation", async () => {
  await withFirewallTestStore(async () => {
    await prepareRunningSandbox((meta) => {
      meta.lifecycleAttemptId = "attempt-old";
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["api.openai.com"];
    });
    let updateCount = 0;
    const ctrl = installSucceedingSandboxController({
      onUpdateNetworkPolicy: async () => {
        updateCount += 1;
        if (updateCount !== 1) return;
        await mutateMeta((meta) => {
          meta.sandboxId = "sandbox-replacement";
          meta.lifecycleAttemptId = "attempt-new";
          meta.status = "booting";
        });
      },
    });

    try {
      await assertFirewallSyncFailed(approveDomains(["vercel.com"]));
      const meta = await getInitializedMeta();

      assert.equal(updateCount, 1);
      assert.equal(meta.sandboxId, "sandbox-replacement");
      assert.equal(meta.lifecycleAttemptId, "attempt-new");
      assert.equal(meta.firewall.lastSyncOutcome, null);
      assert.deepEqual(ctrl.appliedPolicies, [
        { allow: ["api.openai.com", "vercel.com"] },
      ]);
    } finally {
      ctrl.restore();
    }
  });
});

test("firewall sync fails after losing lifecycle ownership during SDK apply", async () => {
  await withFirewallTestStore(async () => {
    await prepareRunningSandbox((meta) => {
      meta.lifecycleAttemptId = "attempt-old";
      meta.firewall.mode = "enforcing";
      meta.firewall.allowlist = ["api.openai.com"];
    });
    const store = getStore();
    const originalRenewLock = store.renewLock.bind(store);
    let loseOwnership = false;
    let updateCount = 0;
    store.renewLock = async (key, token, ttlSeconds) => {
      if (!loseOwnership) {
        return originalRenewLock(key, token, ttlSeconds);
      }
      await store.releaseLock(key, token);
      return false;
    };
    const ctrl = installSucceedingSandboxController({
      onUpdateNetworkPolicy: () => {
        updateCount += 1;
        loseOwnership = true;
      },
    });

    try {
      await assert.rejects(
        syncFirewallPolicyIfRunning(),
        /Sandbox lifecycle lock ownership was lost/,
      );
      const meta = await getInitializedMeta();
      assert.equal(updateCount, 1);
      assert.equal(meta.firewall.lastSyncOutcome, null);
    } finally {
      store.renewLock = originalRenewLock;
      ctrl.restore();
    }
  });
});

test("firewall mutation durably fences its generation after lifecycle ownership loss", async () => {
  await withFirewallTestStore(async () => {
    await prepareRunningSandbox((meta) => {
      meta.lifecycleAttemptId = "attempt-old";
      meta.firewall.mode = "learning";
      meta.firewall.allowlist = ["api.openai.com"];
    });
    const store = getStore();
    const originalRenewLock = store.renewLock.bind(store);
    let loseOwnership = false;
    let updateCount = 0;
    store.renewLock = async (key, token, ttlSeconds) => {
      if (!loseOwnership) {
        return originalRenewLock(key, token, ttlSeconds);
      }
      await store.releaseLock(key, token);
      return false;
    };
    const ctrl = installSucceedingSandboxController({
      onUpdateNetworkPolicy: () => {
        updateCount += 1;
        loseOwnership = true;
      },
    });

    try {
      _resetLogBuffer();
      await assertFirewallSyncFailed(setFirewallMode("enforcing"));

      const meta = await getInitializedMeta();
      assert.equal(updateCount, 1);
      assert.equal(meta.firewall.mode, "enforcing");
      assert.equal(meta.status, "error");
      assert.equal(meta.portUrls, null);
      const stopOperation = await getStore().getValue<{
        sandboxId: string;
        lifecycleAttemptId: string | null;
        reason: string;
        ingressFenced: boolean;
      }>(hostSuspensionOperationKey());
      assert.equal(stopOperation?.sandboxId, "sandbox-123");
      assert.equal(stopOperation?.lifecycleAttemptId, "attempt-old");
      assert.ok(parseFirewallFailClosedReason(stopOperation?.reason ?? ""));
      assert.equal(stopOperation?.ingressFenced, true);
      assert.ok(
        getServerLogs().some(
          (entry) => entry.message === "firewall.fail_closed_deferred",
        ),
      );
    } finally {
      store.renewLock = originalRenewLock;
      ctrl.restore();
    }
  });
});

test("fail-close repairs ownership loss during durable stop enqueue", async () => {
  await withFirewallTestStore(async () => {
    await prepareRunningSandbox((meta) => {
      meta.lifecycleAttemptId = "attempt-enqueue-loss";
    });
    const store = getStore();
    const originalRenewLock = store.renewLock.bind(store);
    let policyFailed = false;
    let renewalsAfterFailure = 0;
    store.renewLock = async (key, token, ttlSeconds) => {
      if (!policyFailed) {
        return originalRenewLock(key, token, ttlSeconds);
      }
      renewalsAfterFailure += 1;
      if (renewalsAfterFailure < 3) {
        return originalRenewLock(key, token, ttlSeconds);
      }
      await store.releaseLock(key, token);
      return false;
    };
    const ctrl = installSucceedingSandboxController({
      onUpdateNetworkPolicy: () => {
        policyFailed = true;
        throw new Error("policy apply failed");
      },
    });

    try {
      await assertFirewallSyncFailed(setFirewallMode("learning"));

      const meta = await getInitializedMeta();
      const stopOperation = await getStore().getValue<{
        sandboxId: string;
        lifecycleAttemptId: string | null;
        reason: string;
      }>(hostSuspensionOperationKey());
      assert.ok(renewalsAfterFailure >= 3);
      assert.equal(meta.status, "error");
      assert.equal(stopOperation?.sandboxId, "sandbox-123");
      assert.equal(stopOperation?.lifecycleAttemptId, "attempt-enqueue-loss");
      assert.ok(parseFirewallFailClosedReason(stopOperation?.reason ?? ""));
    } finally {
      store.renewLock = originalRenewLock;
      ctrl.restore();
    }
  });
});

test("stale fail-close cannot stop a repaired policy revision on the same sandbox generation", async () => {
  await withFirewallTestStore(async () => {
    await prepareRunningSandbox((meta) => {
      meta.lifecycleAttemptId = "attempt-shared";
      meta.firewall.mode = "learning";
      meta.firewall.allowlist = ["api.openai.com"];
    });
    const store = getStore();
    const originalAcquireLock = store.acquireLock.bind(store);
    const originalRenewLock = store.renewLock.bind(store);
    let loseOwnership = false;
    let successorInstalled = false;
    store.renewLock = async (key, token, ttlSeconds) => {
      if (!loseOwnership) {
        return originalRenewLock(key, token, ttlSeconds);
      }
      await store.releaseLock(key, token);
      return false;
    };
    store.acquireLock = async (key, ttlSeconds) => {
      if (
        key === lifecycleLockKey()
        && loseOwnership
        && !successorInstalled
      ) {
        successorInstalled = true;
        await mutateMeta((meta) => {
          meta.status = "running";
          meta.firewall.policyRevisionId = "successor-policy-revision";
          meta.firewall.lastPolicySdkCompletionRevisionId =
            "successor-policy-revision";
          meta.firewall.lastPolicySdkCompletionHash = "b".repeat(64);
          meta.firewall.failClosedPolicyRevisionId = null;
          meta.firewall.failClosedPolicyHash = null;
          meta.firewall.lastSyncReason = "policy-applied";
        });
      }
      return originalAcquireLock(key, ttlSeconds);
    };
    const ctrl = installSucceedingSandboxController({
      onUpdateNetworkPolicy: () => {
        loseOwnership = true;
      },
    });

    try {
      await assertFirewallSyncFailed(setFirewallMode("enforcing"));

      const meta = await getInitializedMeta();
      assert.equal(successorInstalled, true);
      assert.equal(meta.status, "running");
      assert.equal(meta.firewall.policyRevisionId, "successor-policy-revision");
      assert.equal(meta.firewall.lastSyncReason, "policy-applied");
      assert.equal(await getStore().getValue(hostSuspensionOperationKey()), null);
      assert.equal(ctrl.appliedPolicies.length, 1);
    } finally {
      store.acquireLock = originalAcquireLock;
      store.renewLock = originalRenewLock;
      ctrl.restore();
    }
  });
});

test("policy apply lock prevents same-generation successor SDK overlap", async () => {
  await withFirewallTestStore(async () => {
    await prepareRunningSandbox((meta) => {
      meta.lifecycleAttemptId = "attempt-overlap";
    });
    const store = getStore();
    const originalAcquireLock = store.acquireLock.bind(store);
    let firstLifecycleToken: string | null = null;
    store.acquireLock = async (key, ttlSeconds) => {
      const token = await originalAcquireLock(key, ttlSeconds);
      if (key === lifecycleLockKey() && token && !firstLifecycleToken) {
        firstLifecycleToken = token;
      }
      return token;
    };
    let applyCalls = 0;
    let signalFirstApply!: () => void;
    let releaseFirstApply!: () => void;
    const firstApplyStarted = new Promise<void>((resolve) => {
      signalFirstApply = resolve;
    });
    const firstApplyGate = new Promise<void>((resolve) => {
      releaseFirstApply = resolve;
    });
    const ctrl = installSucceedingSandboxController({
      onUpdateNetworkPolicy: async () => {
        applyCalls += 1;
        if (applyCalls !== 1) return;
        signalFirstApply();
        await firstApplyGate;
      },
    });

    try {
      const stale = setFirewallMode("learning");
      await firstApplyStarted;
      assert.ok(firstLifecycleToken);
      await store.releaseLock(lifecycleLockKey(), firstLifecycleToken);

      await assert.rejects(
        setFirewallMode("enforcing"),
        (error: unknown) => {
          assert.equal(
            (error as { code?: unknown }).code,
            "FIREWALL_POLICY_APPLY_IN_PROGRESS",
          );
          return true;
        },
      );
      releaseFirstApply();
      await assertFirewallSyncFailed(stale);

      const meta = await getInitializedMeta();
      const stopOperation = await getStore().getValue<{
        reason: string;
        ingressFenced: boolean;
      }>(hostSuspensionOperationKey());
      const stoppedRevision = parseFirewallFailClosedReason(
        stopOperation?.reason ?? "",
      );
      assert.equal(applyCalls, 1);
      assert.equal(meta.status, "error");
      assert.equal(meta.firewall.mode, "learning");
      assert.equal(stopOperation?.ingressFenced, true);
      assert.equal(
        stoppedRevision?.revisionId,
        meta.firewall.lastPolicySdkCompletionRevisionId,
      );
      assert.equal(stoppedRevision?.revisionId, meta.firewall.policyRevisionId);
    } finally {
      store.acquireLock = originalAcquireLock;
      ctrl.restore();
    }
  });
});

test("firewall sync and report work without a canonical public origin", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "enforcing";
        meta.firewall.allowlist = ["registry.npmjs.org"];
      });

      const outcome = await syncFirewallPolicyIfRunning();
      const expectedHash = computePolicyHash(
        "enforcing",
        ["registry.npmjs.org"],
        [],
      );
      assert.deepEqual(ctrl.appliedPolicies.at(-1), {
        allow: ["registry.npmjs.org"],
      });
      assert.equal(outcome.policyHash, expectedHash);
      assert.equal((await getFirewallReport()).policyHash, expectedHash);
    } finally {
      ctrl.restore();
    }
  });
});

test("syncFirewallPolicyIfRunning preserves cron control-plane egress in enforcing mode", async () => {
  await withFirewallTestStore(async () => {
    const originalOrigin = process.env.NEXT_PUBLIC_BASE_DOMAIN;
    process.env.NEXT_PUBLIC_BASE_DOMAIN = "app.example.com";
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox((meta) => {
        meta.firewall.mode = "enforcing";
        meta.firewall.allowlist = ["registry.npmjs.org"];
        meta.bundleIdentity = {
          packageSpec: "openclaw@2026.7.2",
          version: "2026.7.2",
          forkSha: "1".repeat(40),
          upstreamSha: "2".repeat(40),
          canonicalSha256: "3".repeat(64),
          capabilities: ["cron-projection-v1"],
          verified: true,
        };
      });

      const outcome = await syncFirewallPolicyIfRunning();
      assert.deepEqual(ctrl.appliedPolicies.at(-1), {
        allow: ["app.example.com", "registry.npmjs.org"],
      });
      assert.equal(
        outcome.policyHash,
        computePolicyHash(
          "enforcing",
          ["registry.npmjs.org"],
          ["app.example.com"],
        ),
      );
      assert.deepEqual(
        (await getFirewallState()).allowlist,
        ["registry.npmjs.org"],
      );
    } finally {
      ctrl.restore();
      if (originalOrigin === undefined) {
        delete process.env.NEXT_PUBLIC_BASE_DOMAIN;
      } else {
        process.env.NEXT_PUBLIC_BASE_DOMAIN = originalOrigin;
      }
    }
  });
});

test("ingestLearningFromSandbox returns FirewallIngestOutcome with timing", async () => {
  await withFirewallTestStore(async () => {
    // Mode not learning — should return skip outcome
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox(); // mode = disabled
      const result = await ingestLearningFromSandbox(true);
      const outcome = result.outcome;
      assert.equal(typeof outcome.timestamp, "number");
      assert.equal(typeof outcome.durationMs, "number");
      assert.equal(outcome.domainsSeenCount, 0);
      assert.equal(outcome.newCount, 0);
      assert.equal(outcome.updatedCount, 0);
      assert.equal(outcome.skipReason, "mode-not-learning");
    } finally {
      ctrl.restore();
    }
  });
});

test("ingestLearningFromSandbox persists lastIngestOutcome in metadata", async () => {
  await withFirewallTestStore(async () => {
    const ctrl = installSucceedingSandboxController();
    try {
      await prepareRunningSandbox();
      await ingestLearningFromSandbox(true);
      const state = await getFirewallState();
      assert.ok(state.lastIngestOutcome, "lastIngestOutcome should be persisted");
      assert.equal(state.lastIngestOutcome.skipReason, "mode-not-learning");
    } finally {
      ctrl.restore();
    }
  });
});

test("ensureMetaShape: migrates old metadata without lastIngestOutcome/lastSyncOutcome", () => {
  const existing = {
    _schemaVersion: 2,
    version: 1,
    id: "openclaw-single",
    sandboxId: null,
    snapshotId: null,
    status: "running",
    gatewayToken: "tok",
    createdAt: 1000,
    updatedAt: 2000,
    lastAccessedAt: null,
    portUrls: null,
    startupScript: null,
    lastError: null,
    firewall: {
      mode: "learning",
      allowlist: [],
      learned: [],
      events: [],
      updatedAt: 1000,
      lastIngestedAt: null,
      learningStartedAt: 5000,
      commandsObserved: 42,
      // No lastIngestOutcome or lastSyncOutcome — simulates old data
    },
    lastTokenRefreshAt: null,
    channels: {},
    snapshotHistory: [],
  };

  const result = ensureMetaShape(existing);
  assert.ok(result);
  assert.equal(result.firewall.lastIngestOutcome, null);
  assert.equal(result.firewall.lastSyncOutcome, null);
});

test("ensureMetaShape: is idempotent — running twice produces identical output", () => {
  const existing = {
    _schemaVersion: 2,
    version: 1,
    id: "openclaw-single",
    sandboxId: null,
    snapshotId: null,
    status: "running",
    gatewayToken: "tok",
    createdAt: 1000,
    updatedAt: 2000,
    lastAccessedAt: null,
    portUrls: null,
    startupScript: null,
    lastError: null,
    firewall: {
      mode: "disabled",
      allowlist: ["a.com"],
      learned: [],
      events: [],
      updatedAt: 1000,
      lastIngestedAt: null,
    },
    lastTokenRefreshAt: null,
    channels: {},
    snapshotHistory: [],
  };

  const first = ensureMetaShape(existing);
  assert.ok(first);
  const second = ensureMetaShape(first);
  assert.ok(second);
  assert.deepEqual(first, second, "ensureMetaShape must be idempotent");
});

test("ensureMetaShape: preserves valid FirewallIngestOutcome and FirewallSyncOutcome", () => {
  const ingestOutcome = {
    timestamp: 1000,
    durationMs: 50,
    domainsSeenCount: 3,
    newCount: 2,
    updatedCount: 1,
    skipReason: null,
  };
  const syncOutcome = {
    timestamp: 2000,
    durationMs: 100,
    allowlistCount: 5,
    policyHash: "a".repeat(64),
    applied: true,
    reason: "policy-applied",
  };

  const existing = {
    _schemaVersion: 2,
    version: 1,
    id: "openclaw-single",
    sandboxId: null,
    snapshotId: null,
    status: "running",
    gatewayToken: "tok",
    createdAt: 1000,
    updatedAt: 2000,
    lastAccessedAt: null,
    portUrls: null,
    startupScript: null,
    lastError: null,
    firewall: {
      mode: "disabled",
      allowlist: [],
      learned: [],
      events: [],
      updatedAt: 1000,
      lastIngestedAt: null,
      lastIngestOutcome: ingestOutcome,
      lastSyncOutcome: syncOutcome,
    },
    lastTokenRefreshAt: null,
    channels: {},
    snapshotHistory: [],
  };

  const result = ensureMetaShape(existing);
  assert.ok(result);
  assert.deepEqual(result.firewall.lastIngestOutcome, ingestOutcome);
  assert.deepEqual(result.firewall.lastSyncOutcome, syncOutcome);
});
