import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  _resetBundleIdentityForTesting,
  admitConfiguredOpenClawBundle,
  bundleIdentityFromAdmission,
  hydrateVerifiedBundleIdentity,
  matchesConfiguredBundleIdentity,
  REQUIRED_OPENCLAW_BUNDLE_ASSETS,
} from "@/server/openclaw/bundle-identity";

const VERSION = "2026.7.2";
const TAG = "v2026.7.2-beta.1";
const FORK_SHA = "1".repeat(40);
const UPSTREAM_SHA = "2".repeat(40);
const CANONICAL_SHA = "3".repeat(64);
const BASE_URL = `https://github.com/vercel-labs/openclaw/releases/download/${TAG}`;
const MANIFEST_URL = `${BASE_URL}/asset-manifest.json`;
const BUNDLE_URL = `${BASE_URL}/openclaw.bundle.mjs`;
const UI_URL = `${BASE_URL}/control-ui.tar.gz`;
const ASSET_ROLES: Record<string, string> = {
  "openclaw.bundle.mjs": "entry",
  "bundle-deps.tar.gz": "runtime-deps",
  "bundle-openclaw-pkg.tar.gz": "openclaw-package-shim",
  "channels.tar.gz": "bundled-channel-extensions",
  "runtime-plugins.tar.gz": "explicit-runtime-plugins",
  "external-plugins.json": "external-plugin-metadata",
  "external-plugin-slack.tgz": "external-plugin-package",
  "bundle-capabilities.json": "bundle-capabilities",
  "channel-catalog.json": "channel-catalog",
  "workspace-templates.tar.gz": "workspace-templates",
  "control-ui.tar.gz": "control-ui-assets",
  "release.json": "release-metadata",
  "bundle-contract.json": "bundle-contract",
};

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function fixture() {
  const source = {
    fork: {
      repository: "vercel-labs/openclaw",
      ref: TAG,
      sha: FORK_SHA,
    },
    upstream: {
      repository: "openclaw/openclaw",
      version: "2026.7.1",
      sha: UPSTREAM_SHA,
    },
  };
  const externalPlugins = [
    {
      id: "slack",
      packageName: "@openclaw/slack",
      version: VERSION,
      spec: `@openclaw/slack@${VERSION}`,
      artifact: "external-plugin-slack.tgz",
      integrity: "sha512-AAAA",
      shasum: "4".repeat(40),
      sha256: "5".repeat(64),
    },
  ];
  const externalManifestBytes = jsonBytes({
    schemaVersion: 1,
    plugins: externalPlugins,
  });
  const capabilityBytes = jsonBytes({
    schemaVersion: 1,
    profile: "sandbox",
    package: { name: "openclaw", version: VERSION },
    source,
    pluginIds: ["admin-http-rpc", "slack", "telegram"],
    externalPlugins,
    capabilities: [
      "admin-http-rpc-v1",
      "cron-projection-v1",
      "gateway-suspend-v1",
      "telegram-durable-ack-v1",
    ],
  });
  const contractBytes = jsonBytes({
    schemaVersion: 1,
    profile: "sandbox",
    package: { name: "openclaw", version: VERSION },
    source,
    externalPlugins,
  });
  const releaseBytes = jsonBytes({
    schemaVersion: 1,
    profile: "sandbox",
    package: { name: "openclaw", version: VERSION },
    source,
    externalPlugins,
  });
  const canonicalTarball = `openclaw-sandbox-bundle-v${VERSION}-${FORK_SHA.slice(0, 7)}.tar.gz`;
  const assets = Object.fromEntries(
    [...REQUIRED_OPENCLAW_BUNDLE_ASSETS, canonicalTarball].map((name) => [
      name,
      { role: ASSET_ROLES[name] ?? name, bytes: 1, sha256: "a".repeat(64) },
    ]),
  );
  assets[canonicalTarball] = {
    role: "canonical-release-tarball",
    bytes: 987654,
    sha256: CANONICAL_SHA,
  };
  assets["bundle-capabilities.json"] = {
    role: "bundle-capabilities",
    bytes: capabilityBytes.byteLength,
    sha256: digest(capabilityBytes),
  };
  assets["external-plugins.json"] = {
    role: "external-plugin-metadata",
    bytes: externalManifestBytes.byteLength,
    sha256: digest(externalManifestBytes),
  };
  assets["external-plugin-slack.tgz"] = {
    role: "external-plugin-package",
    bytes: 123,
    sha256: externalPlugins[0].sha256,
  };
  assets["bundle-contract.json"] = {
    role: "bundle-contract",
    bytes: contractBytes.byteLength,
    sha256: digest(contractBytes),
  };
  assets["release.json"] = {
    role: "release-metadata",
    bytes: releaseBytes.byteLength,
    sha256: digest(releaseBytes),
  };
  const manifest = {
    schemaVersion: 2,
    name: "openclaw-sandbox-bundle",
    profile: "sandbox",
    package: { name: "openclaw", version: VERSION },
    source,
    tag: TAG,
    git: {
      sha: FORK_SHA,
      sha7: FORK_SHA.slice(0, 7),
      upstreamSha: UPSTREAM_SHA,
    },
    runtime: { nodeTarget: "node22", engines: ">=22.14.0" },
    capabilityManifest: "bundle-capabilities.json",
    externalPlugins,
    canonicalTarball,
    assets,
  };
  return {
    manifest,
    manifestBytes: jsonBytes(manifest),
    capabilityBytes,
    externalManifestBytes,
    contractBytes,
    releaseBytes,
  };
}

function replaceManifestAsset(
  data: ReturnType<typeof fixture>,
  assetName: "bundle-capabilities.json" | "external-plugins.json" | "bundle-contract.json" | "release.json",
  bytes: Buffer,
): void {
  data.manifest.assets[assetName] = {
    ...data.manifest.assets[assetName],
    bytes: bytes.byteLength,
    sha256: digest(bytes),
  };
  data.manifestBytes = jsonBytes(data.manifest);
}

function configureVerifiedBundle(): () => void {
  const keys = [
    "OPENCLAW_PACKAGE_SPEC",
    "OPENCLAW_BUNDLE_URL",
    "OPENCLAW_BUNDLE_UI_URL",
    "OPENCLAW_BUNDLE_MANIFEST_URL",
    "OPENCLAW_BUNDLE_SOURCE_SHA",
    "OPENCLAW_BUNDLE_SHA256",
  ] as const;
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalNodeEnv = process.env.NODE_ENV;
  (process.env as Record<string, string | undefined>).NODE_ENV = "test";
  process.env.OPENCLAW_PACKAGE_SPEC = `openclaw@${VERSION}`;
  process.env.OPENCLAW_BUNDLE_URL = BUNDLE_URL;
  process.env.OPENCLAW_BUNDLE_UI_URL = UI_URL;
  process.env.OPENCLAW_BUNDLE_MANIFEST_URL = MANIFEST_URL;
  process.env.OPENCLAW_BUNDLE_SOURCE_SHA = FORK_SHA;
  process.env.OPENCLAW_BUNDLE_SHA256 = CANONICAL_SHA;
  _resetBundleIdentityForTesting();
  return () => {
    for (const key of keys) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetBundleIdentityForTesting();
    if (originalNodeEnv === undefined) {
      delete (process.env as Record<string, string | undefined>).NODE_ENV;
    }
    else (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
  };
}

function fixtureFetch(
  data = fixture(),
  beforeResponse?: (url: string) => void,
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    beforeResponse?.(url);
    let bytes: Buffer | undefined;
    if (url.endsWith("/asset-manifest.json")) bytes = data.manifestBytes;
    if (url.endsWith("/bundle-capabilities.json")) bytes = data.capabilityBytes;
    if (url.endsWith("/external-plugins.json")) bytes = data.externalManifestBytes;
    if (url.endsWith("/bundle-contract.json")) bytes = data.contractBytes;
    if (url.endsWith("/release.json")) bytes = data.releaseBytes;
    if (!bytes) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { "content-length": String(bytes.byteLength) },
    });
  }) as typeof fetch;
}

test("admits one exact manifest v2 identity with independent upstream version", async () => {
  const restore = configureVerifiedBundle();
  try {
    const admission = await admitConfiguredOpenClawBundle(fixtureFetch());
    assert.ok(admission);
    assert.deepEqual(admission.identity, {
      packageSpec: `openclaw@${VERSION}`,
      version: VERSION,
      forkSha: FORK_SHA,
      upstreamSha: UPSTREAM_SHA,
      canonicalSha256: CANONICAL_SHA,
      capabilities: [
        "admin-http-rpc-v1",
        "cron-projection-v1",
        "gateway-suspend-v1",
        "telegram-durable-ack-v1",
      ],
      verified: true,
    });
    assert.equal(admission.externalPlugins[0]?.spec, `@openclaw/slack@${VERSION}`);
    assert.equal(
      admission.canonicalTarballUrl,
      `${BASE_URL}/${admission.canonicalTarball}`,
    );
  } finally {
    restore();
  }
});

test("derives bundle packageSpec from manifest without npm fallback", async () => {
  const restore = configureVerifiedBundle();
  try {
    delete process.env.OPENCLAW_PACKAGE_SPEC;
    _resetBundleIdentityForTesting();
    const admission = await admitConfiguredOpenClawBundle(fixtureFetch());
    assert.equal(admission?.identity.packageSpec, `openclaw@${VERSION}`);
  } finally {
    restore();
  }
});

test("does not fetch admission metadata without a persisted identity", async () => {
  const restore = configureVerifiedBundle();
  try {
    let fetched = false;
    assert.equal(
      await hydrateVerifiedBundleIdentity(
        null,
        fixtureFetch(undefined, () => {
          fetched = true;
        }),
      ),
      null,
    );
    assert.equal(fetched, false);
  } finally {
    restore();
  }
});

test("fails closed on incomplete verified bundle environment before fetch", async () => {
  const restore = configureVerifiedBundle();
  try {
    delete process.env.OPENCLAW_BUNDLE_SOURCE_SHA;
    _resetBundleIdentityForTesting();
    let fetched = false;
    await assert.rejects(
      async () =>
        await admitConfiguredOpenClawBundle(
          fixtureFetch(undefined, () => { fetched = true; }),
        ),
      /verified bundle environment is incomplete/,
    );
    assert.equal(fetched, false);
  } finally {
    restore();
  }
});

test("rejects capability and external plugin semantic drift", async () => {
  const restore = configureVerifiedBundle();
  try {
    const badCapabilities = fixture();
    const parsedCapabilities = JSON.parse(
      badCapabilities.capabilityBytes.toString("utf8"),
    ) as { capabilities: string[] };
    parsedCapabilities.capabilities = ["admin-http-rpc-v1"];
    badCapabilities.capabilityBytes = jsonBytes(parsedCapabilities);
    replaceManifestAsset(
      badCapabilities,
      "bundle-capabilities.json",
      badCapabilities.capabilityBytes,
    );
    await assert.rejects(
      admitConfiguredOpenClawBundle(fixtureFetch(badCapabilities)),
      /bundle-capabilities\.json lacks cron-projection-v1/,
    );

    _resetBundleIdentityForTesting();
    const badPluginIds = fixture();
    const parsedPluginIds = JSON.parse(
      badPluginIds.capabilityBytes.toString("utf8"),
    ) as { pluginIds: string[] };
    parsedPluginIds.pluginIds = ["admin-http-rpc", "slack"];
    badPluginIds.capabilityBytes = jsonBytes(parsedPluginIds);
    replaceManifestAsset(
      badPluginIds,
      "bundle-capabilities.json",
      badPluginIds.capabilityBytes,
    );
    await assert.rejects(
      admitConfiguredOpenClawBundle(fixtureFetch(badPluginIds)),
      /bundle-capabilities\.json lacks plugin telegram/,
    );

    _resetBundleIdentityForTesting();
    const badExternal = fixture();
    const parsedExternal = JSON.parse(
      badExternal.externalManifestBytes.toString("utf8"),
    ) as { plugins: Array<{ spec: string }> };
    parsedExternal.plugins[0].spec = "@openclaw/slack@latest";
    badExternal.externalManifestBytes = jsonBytes(parsedExternal);
    replaceManifestAsset(
      badExternal,
      "external-plugins.json",
      badExternal.externalManifestBytes,
    );
    await assert.rejects(
      admitConfiguredOpenClawBundle(fixtureFetch(badExternal)),
      /external-plugins\.json has invalid Slack package identity/,
    );
  } finally {
    restore();
  }
});

test("rejects identity drift in bundle contract after digest verification", async () => {
  const restore = configureVerifiedBundle();
  try {
    const badContract = fixture();
    const parsedContract = JSON.parse(
      badContract.contractBytes.toString("utf8"),
    ) as { source: { upstream: { sha: string } } };
    parsedContract.source.upstream.sha = "9".repeat(40);
    badContract.contractBytes = jsonBytes(parsedContract);
    replaceManifestAsset(
      badContract,
      "bundle-contract.json",
      badContract.contractBytes,
    );

    await assert.rejects(
      admitConfiguredOpenClawBundle(fixtureFetch(badContract)),
      /bundle-contract\.json identity does not match asset-manifest\.json/,
    );
  } finally {
    restore();
  }
});

test("rejects official-host URLs with non-release refs before fetch", async () => {
  const restore = configureVerifiedBundle();
  try {
    process.env.OPENCLAW_BUNDLE_MANIFEST_URL =
      "https://github.com/vercel-labs/openclaw/releases/download/v2026.7.2-bundle.1/asset-manifest.json";
    _resetBundleIdentityForTesting();
    let fetched = false;
    await assert.rejects(
      admitConfiguredOpenClawBundle(
        fixtureFetch(undefined, () => {
          fetched = true;
        }),
      ),
      /release ref is invalid/,
    );
    assert.equal(fetched, false);
  } finally {
    restore();
  }
});

test("evicts rejected admission so a transient fetch can retry", async () => {
  const restore = configureVerifiedBundle();
  try {
    let fail = true;
    const goodFetch = fixtureFetch();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (fail) {
        fail = false;
        return new Response(null, { status: 503 });
      }
      return goodFetch(input, init);
    }) as typeof fetch;
    await assert.rejects(admitConfiguredOpenClawBundle(fetchImpl), /HTTP 503/);
    const admission = await admitConfiguredOpenClawBundle(fetchImpl);
    assert.ok(admission);
  } finally {
    restore();
  }
});

test("hydrates only the persisted identity admitted by current configuration", async () => {
  const restore = configureVerifiedBundle();
  try {
    const fetchImpl = fixtureFetch();
    const admission = await admitConfiguredOpenClawBundle(fetchImpl);
    assert.ok(admission);
    const copiedIdentity = bundleIdentityFromAdmission(admission);
    assert.deepEqual(copiedIdentity, admission.identity);
    assert.notEqual(copiedIdentity, admission.identity);
    assert.deepEqual(
      await hydrateVerifiedBundleIdentity(admission.identity, fetchImpl),
      admission.identity,
    );
    assert.equal(
      await hydrateVerifiedBundleIdentity(
        { ...admission.identity, forkSha: "9".repeat(40) },
        fetchImpl,
      ),
      null,
    );
    assert.equal(
      await hydrateVerifiedBundleIdentity(
        { ...admission.identity, releaseUrl: "https://must-not-leak.invalid" },
        fetchImpl,
      ),
      null,
    );
  } finally {
    restore();
  }
});

test("matches persisted bundle identity against static deployment pins", () => {
  const restore = configureVerifiedBundle();
  try {
    const identity = {
      packageSpec: `openclaw@${VERSION}`,
      version: VERSION,
      forkSha: FORK_SHA,
      upstreamSha: UPSTREAM_SHA,
      canonicalSha256: CANONICAL_SHA,
      capabilities: [
        "admin-http-rpc-v1",
        "cron-projection-v1",
        "gateway-suspend-v1",
        "telegram-durable-ack-v1",
      ],
      verified: true as const,
    };
    assert.equal(matchesConfiguredBundleIdentity(identity), true);
    assert.equal(
      matchesConfiguredBundleIdentity({
        ...identity,
        canonicalSha256: "9".repeat(64),
      }),
      false,
    );
    delete process.env.OPENCLAW_BUNDLE_SOURCE_SHA;
    assert.equal(matchesConfiguredBundleIdentity(identity), false);
  } finally {
    restore();
  }
});
