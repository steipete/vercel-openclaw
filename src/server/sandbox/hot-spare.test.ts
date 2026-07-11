/**
 * Tests for snapshot-backed hot-spare pre-creation and metadata mutation.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  preCreateHotSpareFromSnapshot,
  applyPreCreateToMeta,
  evaluateHotSparePromotion,
  type SnapshotBackedCreateDeps,
  type PreCreateResult,
} from "@/server/sandbox/hot-spare";
import { createDefaultHotSpareState } from "@/shared/types";
import type { SingleMeta, HotSpareState } from "@/shared/types";
import type { SandboxHandle } from "@/server/sandbox/controller";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal SingleMeta-like object for the Pick<> used by preCreateHotSpareFromSnapshot. */
function buildMetaPick(overrides: Partial<{
  id: string;
  snapshotId: string | null;
  snapshotDynamicConfigHash: string | null;
  snapshotConfigHash: string | null;
  snapshotAssetSha256: string | null;
  hotSpare: HotSpareState | undefined;
}> = {}) {
  return {
    id: overrides.id ?? "single-abc",
    snapshotId: "snapshotId" in overrides ? overrides.snapshotId! : "snap_123",
    snapshotDynamicConfigHash: "snapshotDynamicConfigHash" in overrides ? overrides.snapshotDynamicConfigHash! : "cfg_456",
    snapshotConfigHash: "snapshotConfigHash" in overrides ? overrides.snapshotConfigHash! : null,
    snapshotAssetSha256: "snapshotAssetSha256" in overrides ? overrides.snapshotAssetSha256! : "asset_789",
    hotSpare: overrides.hotSpare ?? createDefaultHotSpareState(),
  };
}

function buildDeps(overrides: Partial<SnapshotBackedCreateDeps> = {}): SnapshotBackedCreateDeps {
  return {
    create: overrides.create ?? (async (opts) => ({
      sandboxId: opts.name,
      status: "running",
      stop: async () => {},
      update: async () => {},
      shells: { create: async () => ({ command: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }) },
      getUrl: () => `https://${opts.name}.example.com`,
    }) as unknown as SandboxHandle),
    getSandboxVcpus: overrides.getSandboxVcpus ?? (() => 1),
    getSandboxSleepAfterMs: overrides.getSandboxSleepAfterMs ?? (() => 1800000),
    sandboxPorts: overrides.sandboxPorts ?? [3000, 8787],
    restoreEnv: overrides.restoreEnv ?? { OPENCLAW_GATEWAY_TOKEN: "gw-tok" },
    networkPolicy: overrides.networkPolicy ?? {
      allow: ["app.example.com"],
    },
  };
}

// ---------------------------------------------------------------------------
// preCreateHotSpareFromSnapshot
// ---------------------------------------------------------------------------

test("hot-spare snapshot: returns skipped when feature flag is off", async () => {
  // Ensure the flag is off (default).
  delete process.env.OPENCLAW_HOT_SPARE_ENABLED;

  const result = await preCreateHotSpareFromSnapshot(buildMetaPick(), buildDeps());

  assert.equal(result.status, "skipped");
  assert.equal(result.candidateSandboxId, null);
  assert.equal(result.error, null);
});

test("hot-spare snapshot: returns skipped when candidate is already ready", async () => {
  process.env.OPENCLAW_HOT_SPARE_ENABLED = "true";
  try {
    const meta = buildMetaPick({
      hotSpare: {
        ...createDefaultHotSpareState(),
        status: "ready",
        candidateSandboxId: "existing-spare",
      },
    });

    const result = await preCreateHotSpareFromSnapshot(meta, buildDeps());

    assert.equal(result.status, "skipped");
    assert.equal(result.candidateSandboxId, "existing-spare");
  } finally {
    delete process.env.OPENCLAW_HOT_SPARE_ENABLED;
  }
});

test("hot-spare snapshot: returns skipped when candidate is creating", async () => {
  process.env.OPENCLAW_HOT_SPARE_ENABLED = "true";
  try {
    const meta = buildMetaPick({
      hotSpare: {
        ...createDefaultHotSpareState(),
        status: "creating",
        candidateSandboxId: "in-progress-spare",
      },
    });

    const result = await preCreateHotSpareFromSnapshot(meta, buildDeps());

    assert.equal(result.status, "skipped");
    assert.equal(result.candidateSandboxId, "in-progress-spare");
  } finally {
    delete process.env.OPENCLAW_HOT_SPARE_ENABLED;
  }
});

test("hot-spare snapshot: returns skipped when no snapshot available", async () => {
  process.env.OPENCLAW_HOT_SPARE_ENABLED = "true";
  try {
    const meta = buildMetaPick({ snapshotId: null });

    const result = await preCreateHotSpareFromSnapshot(meta, buildDeps());

    assert.equal(result.status, "skipped");
    assert.equal(result.candidateSandboxId, null);
  } finally {
    delete process.env.OPENCLAW_HOT_SPARE_ENABLED;
  }
});

test("hot-spare snapshot: creates candidate from snapshot when enabled and idle", async () => {
  process.env.OPENCLAW_HOT_SPARE_ENABLED = "true";
  try {
    const createCalls: Array<Record<string, unknown>> = [];
    const deps = buildDeps({
      create: async (opts) => {
        createCalls.push(opts as unknown as Record<string, unknown>);
        return { sandboxId: opts.name } as unknown as SandboxHandle;
      },
    });

    const meta = buildMetaPick({
      id: "single-test",
      snapshotId: "snap_abc",
    });

    const result = await preCreateHotSpareFromSnapshot(meta, deps);

    assert.equal(result.status, "created");
    assert.equal(result.candidateSandboxId, "oc-spare-single-test");
    assert.equal(result.error, null);

    // Verify the create call used snapshot source.
    assert.equal(createCalls.length, 1);
    const call = createCalls[0]!;
    assert.deepEqual(call.source, { type: "snapshot", snapshotId: "snap_abc" });
    assert.equal(call.persistent, true);
    assert.deepEqual(call.ports, [3000, 8787]);
    assert.deepEqual(call.networkPolicy, {
      allow: ["app.example.com"],
    });
  } finally {
    delete process.env.OPENCLAW_HOT_SPARE_ENABLED;
  }
});

test("hot-spare snapshot: returns failed when create throws", async () => {
  process.env.OPENCLAW_HOT_SPARE_ENABLED = "true";
  try {
    const deps = buildDeps({
      create: async () => {
        throw new Error("sandbox quota exceeded");
      },
    });

    const result = await preCreateHotSpareFromSnapshot(buildMetaPick(), deps);

    assert.equal(result.status, "failed");
    assert.equal(result.candidateSandboxId, null);
    assert.equal(result.error, "sandbox quota exceeded");
  } finally {
    delete process.env.OPENCLAW_HOT_SPARE_ENABLED;
  }
});

test("hot-spare snapshot: falls back to snapshotConfigHash when dynamicConfigHash is null", async () => {
  process.env.OPENCLAW_HOT_SPARE_ENABLED = "true";
  try {
    const createCalls: Array<Record<string, unknown>> = [];
    const deps = buildDeps({
      create: async (opts) => {
        createCalls.push(opts as unknown as Record<string, unknown>);
        return { sandboxId: opts.name } as unknown as SandboxHandle;
      },
    });

    const meta = buildMetaPick({
      snapshotDynamicConfigHash: null,
      snapshotConfigHash: "legacy_hash",
    });

    const result = await preCreateHotSpareFromSnapshot(meta, deps);

    assert.equal(result.status, "created");
    assert.equal(createCalls.length, 1);
  } finally {
    delete process.env.OPENCLAW_HOT_SPARE_ENABLED;
  }
});

// ---------------------------------------------------------------------------
// applyPreCreateToMeta
// ---------------------------------------------------------------------------

test("applyPreCreateToMeta: sets provenance fields on created", () => {
  const meta = {
    snapshotId: "snap_xyz",
    snapshotDynamicConfigHash: "dyn_hash",
    snapshotConfigHash: null,
    snapshotAssetSha256: "asset_hash",
    hotSpare: undefined,
  } as unknown as SingleMeta;

  const result: PreCreateResult = {
    status: "created",
    candidateSandboxId: "oc-spare-test",
    error: null,
  };

  applyPreCreateToMeta(meta, result);

  assert.equal(meta.hotSpare!.status, "ready");
  assert.equal(meta.hotSpare!.candidateSandboxId, "oc-spare-test");
  assert.equal(meta.hotSpare!.candidateSourceSnapshotId, "snap_xyz");
  assert.equal(meta.hotSpare!.candidateDynamicConfigHash, "dyn_hash");
  assert.equal(meta.hotSpare!.candidateAssetSha256, "asset_hash");
  assert.equal(meta.hotSpare!.lastError, null);
  assert.ok(typeof meta.hotSpare!.createdAt === "number");
  assert.ok(typeof meta.hotSpare!.preparedAt === "number");
});

test("applyPreCreateToMeta: falls back to snapshotConfigHash for dynamicConfigHash", () => {
  const meta = {
    snapshotId: "snap_xyz",
    snapshotDynamicConfigHash: null,
    snapshotConfigHash: "legacy_cfg",
    snapshotAssetSha256: "asset_hash",
    hotSpare: undefined,
  } as unknown as SingleMeta;

  const result: PreCreateResult = {
    status: "created",
    candidateSandboxId: "oc-spare-test",
    error: null,
  };

  applyPreCreateToMeta(meta, result);

  assert.equal(meta.hotSpare!.candidateDynamicConfigHash, "legacy_cfg");
});

test("applyPreCreateToMeta: prefers result provenance over current meta snapshot fields", () => {
  const meta = {
    snapshotId: "snap_new",
    snapshotDynamicConfigHash: "dyn_new",
    snapshotConfigHash: null,
    snapshotAssetSha256: "asset_new",
    hotSpare: undefined,
  } as unknown as SingleMeta;

  const result: PreCreateResult = {
    status: "created",
    candidateSandboxId: "oc-spare-test",
    error: null,
    candidateSourceSnapshotId: "snap_old",
    candidateDynamicConfigHash: "dyn_old",
    candidateAssetSha256: "asset_old",
  };

  applyPreCreateToMeta(meta, result);

  assert.equal(meta.hotSpare!.candidateSourceSnapshotId, "snap_old");
  assert.equal(meta.hotSpare!.candidateDynamicConfigHash, "dyn_old");
  assert.equal(meta.hotSpare!.candidateAssetSha256, "asset_old");
});

test("applyPreCreateToMeta: sets failed status with error", () => {
  const meta = {
    snapshotId: "snap_xyz",
    snapshotDynamicConfigHash: "hash",
    snapshotConfigHash: null,
    snapshotAssetSha256: null,
    hotSpare: undefined,
  } as unknown as SingleMeta;

  const result: PreCreateResult = {
    status: "failed",
    candidateSandboxId: null,
    error: "quota exceeded",
  };

  applyPreCreateToMeta(meta, result);

  assert.equal(meta.hotSpare!.status, "failed");
  assert.equal(meta.hotSpare!.lastError, "quota exceeded");
  assert.equal(meta.hotSpare!.candidateSandboxId, null);
});

test("applyPreCreateToMeta: skipped does not mutate state", () => {
  const hotSpare = createDefaultHotSpareState();
  const meta = {
    snapshotId: null,
    snapshotDynamicConfigHash: null,
    snapshotConfigHash: null,
    snapshotAssetSha256: null,
    hotSpare,
  } as unknown as SingleMeta;

  const result: PreCreateResult = {
    status: "skipped",
    candidateSandboxId: null,
    error: null,
  };

  applyPreCreateToMeta(meta, result);

  assert.equal(meta.hotSpare!.status, "idle");
  assert.equal(meta.hotSpare!.candidateSandboxId, null);
});

// ---------------------------------------------------------------------------
// evaluateHotSparePromotion
// ---------------------------------------------------------------------------

function buildReadyHotSpare(overrides: Partial<HotSpareState> = {}): HotSpareState {
  return {
    ...createDefaultHotSpareState(),
    status: "ready",
    candidateSandboxId: "oc-spare-test",
    candidateSourceSnapshotId: "snap_123",
    candidateDynamicConfigHash: "cfg_456",
    candidateAssetSha256: "asset_789",
    ...overrides,
  };
}

test("evaluateHotSparePromotion: returns feature-disabled when flag is off", () => {
  delete process.env.OPENCLAW_HOT_SPARE_ENABLED;

  const result = evaluateHotSparePromotion({
    hotSpare: buildReadyHotSpare(),
    desiredSnapshotId: "snap_123",
    desiredDynamicConfigHash: "cfg_456",
    desiredAssetSha256: "asset_789",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "feature-disabled");
});

test("evaluateHotSparePromotion: returns missing-candidate when no hot spare", () => {
  process.env.OPENCLAW_HOT_SPARE_ENABLED = "true";
  try {
    const result = evaluateHotSparePromotion({
      hotSpare: null,
      desiredSnapshotId: "snap_123",
      desiredDynamicConfigHash: "cfg_456",
      desiredAssetSha256: "asset_789",
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing-candidate");
  } finally {
    delete process.env.OPENCLAW_HOT_SPARE_ENABLED;
  }
});

test("evaluateHotSparePromotion: returns missing-candidate when status is not ready", () => {
  process.env.OPENCLAW_HOT_SPARE_ENABLED = "true";
  try {
    const result = evaluateHotSparePromotion({
      hotSpare: { ...buildReadyHotSpare(), status: "idle" },
      desiredSnapshotId: "snap_123",
      desiredDynamicConfigHash: "cfg_456",
      desiredAssetSha256: "asset_789",
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing-candidate");
  } finally {
    delete process.env.OPENCLAW_HOT_SPARE_ENABLED;
  }
});

test("evaluateHotSparePromotion: returns snapshot-mismatch on different snapshot", () => {
  process.env.OPENCLAW_HOT_SPARE_ENABLED = "true";
  try {
    const result = evaluateHotSparePromotion({
      hotSpare: buildReadyHotSpare(),
      desiredSnapshotId: "snap_DIFFERENT",
      desiredDynamicConfigHash: "cfg_456",
      desiredAssetSha256: "asset_789",
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "snapshot-mismatch");
  } finally {
    delete process.env.OPENCLAW_HOT_SPARE_ENABLED;
  }
});

test("evaluateHotSparePromotion: returns dynamic-config-mismatch on different hash", () => {
  process.env.OPENCLAW_HOT_SPARE_ENABLED = "true";
  try {
    const result = evaluateHotSparePromotion({
      hotSpare: buildReadyHotSpare(),
      desiredSnapshotId: "snap_123",
      desiredDynamicConfigHash: "cfg_DIFFERENT",
      desiredAssetSha256: "asset_789",
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "dynamic-config-mismatch");
  } finally {
    delete process.env.OPENCLAW_HOT_SPARE_ENABLED;
  }
});

test("evaluateHotSparePromotion: returns asset-mismatch on different asset hash", () => {
  process.env.OPENCLAW_HOT_SPARE_ENABLED = "true";
  try {
    const result = evaluateHotSparePromotion({
      hotSpare: buildReadyHotSpare(),
      desiredSnapshotId: "snap_123",
      desiredDynamicConfigHash: "cfg_456",
      desiredAssetSha256: "asset_DIFFERENT",
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "asset-mismatch");
  } finally {
    delete process.env.OPENCLAW_HOT_SPARE_ENABLED;
  }
});

test("evaluateHotSparePromotion: returns candidate-ready when all match", () => {
  process.env.OPENCLAW_HOT_SPARE_ENABLED = "true";
  try {
    const result = evaluateHotSparePromotion({
      hotSpare: buildReadyHotSpare(),
      desiredSnapshotId: "snap_123",
      desiredDynamicConfigHash: "cfg_456",
      desiredAssetSha256: "asset_789",
    });

    assert.equal(result.ok, true);
    assert.equal(result.reason, "candidate-ready");
  } finally {
    delete process.env.OPENCLAW_HOT_SPARE_ENABLED;
  }
});

test("evaluateHotSparePromotion: returns missing-candidate when candidateSandboxId is null", () => {
  process.env.OPENCLAW_HOT_SPARE_ENABLED = "true";
  try {
    const result = evaluateHotSparePromotion({
      hotSpare: { ...buildReadyHotSpare(), candidateSandboxId: null },
      desiredSnapshotId: "snap_123",
      desiredDynamicConfigHash: "cfg_456",
      desiredAssetSha256: "asset_789",
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing-candidate");
  } finally {
    delete process.env.OPENCLAW_HOT_SPARE_ENABLED;
  }
});
