import { createHash } from "node:crypto";

import {
  isVerifiedBundleIdentity,
  type VerifiedBundleIdentity,
} from "@/shared/bundle-identity";

export type { VerifiedBundleIdentity } from "@/shared/bundle-identity";

export const OPENCLAW_BUNDLE_COMPATIBILITY_ERROR_CODE =
  "OPENCLAW_BUNDLE_COMPATIBILITY_MISMATCH";

export const REQUIRED_OPENCLAW_BUNDLE_CAPABILITIES = [
  "admin-http-rpc-v1",
  "cron-projection-v1",
  "gateway-suspend-v1",
  "telegram-durable-ack-v1",
] as const;

export const REQUIRED_OPENCLAW_BUNDLE_ASSETS = [
  "openclaw.bundle.mjs",
  "channel-catalog.json",
  "workspace-templates.tar.gz",
  "channels.tar.gz",
  "runtime-plugins.tar.gz",
  "external-plugins.json",
  "external-plugin-slack.tgz",
  "bundle-deps.tar.gz",
  "bundle-openclaw-pkg.tar.gz",
  "control-ui.tar.gz",
  "bundle-capabilities.json",
  "bundle-contract.json",
  "release.json",
] as const;

const OFFICIAL_BUNDLE_REPOSITORY = "vercel-labs/openclaw";
const OFFICIAL_UPSTREAM_REPOSITORY = "openclaw/openclaw";
const BUNDLE_MANIFEST_NAME = "asset-manifest.json";
const CAPABILITY_MANIFEST_NAME = "bundle-capabilities.json";
const EXTERNAL_PLUGIN_MANIFEST_NAME = "external-plugins.json";
const BUNDLE_CONTRACT_NAME = "bundle-contract.json";
const RELEASE_MANIFEST_NAME = "release.json";
const REQUIRED_RUNTIME_PLUGIN_ID = "admin-http-rpc";
const REQUIRED_EXTERNAL_PLUGIN_ID = "slack";
const REQUIRED_CHANNEL_PLUGIN_ID = "telegram";
const EXACT_PACKAGE_SPEC_RE =
  /^openclaw@(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?)$/;
const GIT_SHA_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const SAFE_ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const OFFICIAL_RELEASE_REF_RE =
  /^v[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(?:(?:-beta\.[1-9][0-9]*)|(?:-[1-9][0-9]*))?$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_CANONICAL_TARBALL_BYTES = 256 * 1024 * 1024;
const MAX_BUNDLE_ASSET_BYTES = 192 * 1024 * 1024;

const REQUIRED_ASSET_ROLES: Readonly<Record<string, string>> = {
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
const OPTIONAL_ASSET_ROLES: Readonly<Record<string, string>> = {
  "channel-shared-chunks.tar.gz": "bundled-channel-shared-dist-chunks",
};

type BundlePackageIdentity = {
  name: string;
  version: string;
};

type BundleSourceIdentity = {
  fork: {
    repository: string;
    ref: string;
    sha: string;
  };
  upstream: {
    repository: string;
    version: string;
    sha: string;
  };
};

export type VerifiedBundleAsset = {
  role: string;
  bytes: number;
  sha256: string;
};

export type VerifiedExternalPlugin = {
  id: string;
  packageName: string;
  version: string;
  spec: string;
  artifact: string;
  integrity: string;
  shasum: string;
  sha256: string;
};

export type VerifiedBundleAdmission = {
  identity: VerifiedBundleIdentity;
  canonicalTarball: string;
  canonicalTarballUrl: string;
  assets: Readonly<Record<string, VerifiedBundleAsset>>;
  externalPlugins: readonly VerifiedExternalPlugin[];
};

type ConfiguredBundle = {
  packageSpec: string | null;
  bundleUrl: string;
  bundleUiUrl: string;
  manifestUrl: string;
  sourceSha: string;
  canonicalSha256: string;
};

type BundleManifest = {
  package: BundlePackageIdentity;
  source: BundleSourceIdentity;
  canonicalTarball: string;
  assets: Record<string, VerifiedBundleAsset>;
  externalPlugins: unknown;
};

type FetchLike = typeof fetch;

let cachedAdmissionKey: string | null = null;
let cachedAdmissionPromise: Promise<VerifiedBundleAdmission | null> | null = null;
let admissionOverrideForTesting: VerifiedBundleAdmission | null | undefined;

function compatibilityError(detail: string): Error {
  return new Error(`${OPENCLAW_BUNDLE_COMPATIBILITY_ERROR_CODE}: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireNonemptyString(value: unknown, detail: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw compatibilityError(detail);
  }
  return value;
}

function requireExactGitSha(value: unknown, detail: string): string {
  if (typeof value !== "string" || !GIT_SHA_RE.test(value)) {
    throw compatibilityError(detail);
  }
  return value;
}

function requireSha256(value: unknown, detail: string): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw compatibilityError(detail);
  }
  return value;
}

function requireSortedUniqueStrings(value: unknown, detail: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw compatibilityError(detail);
  }
  const strings = value as string[];
  const sorted = [...strings].sort((left, right) => left.localeCompare(right));
  if (
    new Set(strings).size !== strings.length ||
    sorted.some((entry, index) => entry !== strings[index])
  ) {
    throw compatibilityError(`${detail} must be sorted and unique`);
  }
  return [...strings];
}

function requirePackageIdentity(
  value: unknown,
  detailPrefix: string,
): BundlePackageIdentity {
  if (!isRecord(value) || value.name !== "openclaw") {
    throw compatibilityError(`${detailPrefix}.package must name openclaw`);
  }
  const version = requireNonemptyString(
    value.version,
    `${detailPrefix}.package.version is required`,
  );
  if (!EXACT_PACKAGE_SPEC_RE.test(`openclaw@${version}`)) {
    throw compatibilityError(
      `${detailPrefix}.package.version must be an exact OpenClaw version`,
    );
  }
  return { name: "openclaw", version };
}

function requireSourceIdentity(
  value: unknown,
  detailPrefix: string,
): BundleSourceIdentity {
  if (!isRecord(value) || !isRecord(value.fork) || !isRecord(value.upstream)) {
    throw compatibilityError(`${detailPrefix}.source must identify fork and upstream`);
  }
  const fork = value.fork;
  const upstream = value.upstream;
  if (fork.repository !== OFFICIAL_BUNDLE_REPOSITORY) {
    throw compatibilityError(
      `${detailPrefix}.source.fork.repository must be ${OFFICIAL_BUNDLE_REPOSITORY}`,
    );
  }
  if (upstream.repository !== OFFICIAL_UPSTREAM_REPOSITORY) {
    throw compatibilityError(
      `${detailPrefix}.source.upstream.repository must be ${OFFICIAL_UPSTREAM_REPOSITORY}`,
    );
  }
  return {
    fork: {
      repository: OFFICIAL_BUNDLE_REPOSITORY,
      ref: requireNonemptyString(
        fork.ref,
        `${detailPrefix}.source.fork.ref is required`,
      ),
      sha: requireExactGitSha(
        fork.sha,
        `${detailPrefix}.source.fork.sha must be an exact lowercase git SHA`,
      ),
    },
    upstream: {
      repository: OFFICIAL_UPSTREAM_REPOSITORY,
      version: requireExactPackageVersion(
        upstream.version,
        `${detailPrefix}.source.upstream.version must be an exact OpenClaw version`,
      ),
      sha: requireExactGitSha(
        upstream.sha,
        `${detailPrefix}.source.upstream.sha must be an exact lowercase git SHA`,
      ),
    },
  };
}

function requireExactPackageVersion(value: unknown, detail: string): string {
  const version = requireNonemptyString(value, detail);
  if (!EXACT_PACKAGE_SPEC_RE.test(`openclaw@${version}`)) {
    throw compatibilityError(detail);
  }
  return version;
}

function requireAssetRecord(
  value: unknown,
  assetName: string,
  expectedRole: string,
  maxBytes = MAX_BUNDLE_ASSET_BYTES,
): VerifiedBundleAsset {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join("\0") !== "bytes\0role\0sha256" ||
    value.role !== expectedRole ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) <= 0 ||
    (value.bytes as number) > maxBytes
  ) {
    throw compatibilityError(
      `${BUNDLE_MANIFEST_NAME} has invalid asset record for ${assetName}`,
    );
  }
  return {
    role: value.role,
    bytes: value.bytes as number,
    sha256: requireSha256(
      value.sha256,
      `${BUNDLE_MANIFEST_NAME} has invalid SHA-256 for ${assetName}`,
    ),
  };
}

function requireBundleManifest(value: unknown): BundleManifest {
  if (!isRecord(value)) {
    throw compatibilityError(`${BUNDLE_MANIFEST_NAME} must be an object`);
  }
  if (value.schemaVersion !== 2) {
    throw compatibilityError(`${BUNDLE_MANIFEST_NAME} schemaVersion must be 2`);
  }
  if (value.name !== "openclaw-sandbox-bundle" || value.profile !== "sandbox") {
    throw compatibilityError(`${BUNDLE_MANIFEST_NAME} must describe the sandbox bundle`);
  }
  if (value.capabilityManifest !== CAPABILITY_MANIFEST_NAME) {
    throw compatibilityError(
      `${BUNDLE_MANIFEST_NAME} capabilityManifest must be ${CAPABILITY_MANIFEST_NAME}`,
    );
  }
  const bundlePackage = requirePackageIdentity(value.package, BUNDLE_MANIFEST_NAME);
  const source = requireSourceIdentity(value.source, BUNDLE_MANIFEST_NAME);
  if (value.tag !== source.fork.ref) {
    throw compatibilityError(
      `${BUNDLE_MANIFEST_NAME} tag must match source.fork.ref`,
    );
  }
  if (
    !isRecord(value.git) ||
    value.git.sha !== source.fork.sha ||
    value.git.sha7 !== source.fork.sha.slice(0, 7) ||
    value.git.upstreamSha !== source.upstream.sha
  ) {
    throw compatibilityError(`${BUNDLE_MANIFEST_NAME} git identity is invalid`);
  }
  if (
    !isRecord(value.runtime) ||
    value.runtime.nodeTarget !== "node22" ||
    typeof value.runtime.engines !== "string" ||
    value.runtime.engines.length === 0
  ) {
    throw compatibilityError(`${BUNDLE_MANIFEST_NAME} runtime identity is invalid`);
  }
  const canonicalTarball = requireNonemptyString(
    value.canonicalTarball,
    `${BUNDLE_MANIFEST_NAME} canonicalTarball is required`,
  );
  const expectedCanonicalTarball =
    `openclaw-sandbox-bundle-v${bundlePackage.version}-${source.fork.sha.slice(0, 7)}.tar.gz`;
  if (canonicalTarball !== expectedCanonicalTarball) {
    throw compatibilityError(`${BUNDLE_MANIFEST_NAME} canonicalTarball is invalid`);
  }
  if (!isRecord(value.assets)) {
    throw compatibilityError(`${BUNDLE_MANIFEST_NAME} assets must be an object`);
  }
  const assets: Record<string, VerifiedBundleAsset> = {};
  for (const [assetName, record] of Object.entries(value.assets)) {
    if (!SAFE_ASSET_NAME_RE.test(assetName)) {
      throw compatibilityError(`${BUNDLE_MANIFEST_NAME} has unsafe asset name`);
    }
    const expectedRole =
      REQUIRED_ASSET_ROLES[assetName] ?? OPTIONAL_ASSET_ROLES[assetName];
    if (!expectedRole && assetName !== canonicalTarball) {
      throw compatibilityError(
        `${BUNDLE_MANIFEST_NAME} contains unexpected asset ${assetName}`,
      );
    }
    assets[assetName] = requireAssetRecord(
      record,
      assetName,
      expectedRole ?? "canonical-release-tarball",
      assetName === canonicalTarball
        ? MAX_CANONICAL_TARBALL_BYTES
        : MAX_BUNDLE_ASSET_BYTES,
    );
  }
  for (const assetName of [
    ...REQUIRED_OPENCLAW_BUNDLE_ASSETS,
    canonicalTarball,
  ]) {
    if (!assets[assetName]) {
      throw compatibilityError(`${BUNDLE_MANIFEST_NAME} lacks assets.${assetName}`);
    }
  }
  return {
    package: bundlePackage,
    source,
    canonicalTarball,
    assets,
    externalPlugins: value.externalPlugins,
  };
}

function requireIdentityDocument(
  value: unknown,
  documentName: string,
  manifest: BundleManifest,
  externalPlugins: readonly VerifiedExternalPlugin[],
): void {
  if (!isRecord(value)) {
    throw compatibilityError(`${documentName} must be an object`);
  }
  const bundlePackage = requirePackageIdentity(value.package, documentName);
  const source = requireSourceIdentity(value.source, documentName);
  if (!samePackage(bundlePackage, manifest.package) || !sameSource(source, manifest.source)) {
    throw compatibilityError(
      `${documentName} identity does not match ${BUNDLE_MANIFEST_NAME}`,
    );
  }
  if (JSON.stringify(value.externalPlugins) !== JSON.stringify(externalPlugins)) {
    throw compatibilityError(
      `${documentName} external plugin metadata does not match ${BUNDLE_MANIFEST_NAME}`,
    );
  }
}

function samePackage(left: BundlePackageIdentity, right: BundlePackageIdentity): boolean {
  return left.name === right.name && left.version === right.version;
}

function sameSource(left: BundleSourceIdentity, right: BundleSourceIdentity): boolean {
  return (
    left.fork.repository === right.fork.repository &&
    left.fork.ref === right.fork.ref &&
    left.fork.sha === right.fork.sha &&
    left.upstream.repository === right.upstream.repository &&
    left.upstream.version === right.upstream.version &&
    left.upstream.sha === right.upstream.sha
  );
}

function requireBundleCapabilities(
  value: unknown,
  manifest: BundleManifest,
  externalPlugins: readonly VerifiedExternalPlugin[],
): string[] {
  if (!isRecord(value)) {
    throw compatibilityError(`${CAPABILITY_MANIFEST_NAME} must be an object`);
  }
  if (value.schemaVersion !== 1 || value.profile !== "sandbox") {
    throw compatibilityError(
      `${CAPABILITY_MANIFEST_NAME} must use sandbox schemaVersion 1`,
    );
  }
  const bundlePackage = requirePackageIdentity(value.package, CAPABILITY_MANIFEST_NAME);
  const source = requireSourceIdentity(value.source, CAPABILITY_MANIFEST_NAME);
  if (!samePackage(bundlePackage, manifest.package) || !sameSource(source, manifest.source)) {
    throw compatibilityError(
      `${CAPABILITY_MANIFEST_NAME} identity does not match ${BUNDLE_MANIFEST_NAME}`,
    );
  }
  if (
    JSON.stringify(value.externalPlugins) !== JSON.stringify(externalPlugins) ||
    JSON.stringify(manifest.externalPlugins) !== JSON.stringify(externalPlugins)
  ) {
    throw compatibilityError("external plugin metadata differs across bundle manifests");
  }
  const pluginIds = requireSortedUniqueStrings(
    value.pluginIds,
    `${CAPABILITY_MANIFEST_NAME} pluginIds`,
  );
  const capabilities = requireSortedUniqueStrings(
    value.capabilities,
    `${CAPABILITY_MANIFEST_NAME} capabilities`,
  );
  if (!pluginIds.includes(REQUIRED_RUNTIME_PLUGIN_ID)) {
    throw compatibilityError(
      `${CAPABILITY_MANIFEST_NAME} lacks plugin ${REQUIRED_RUNTIME_PLUGIN_ID}`,
    );
  }
  if (!pluginIds.includes(REQUIRED_EXTERNAL_PLUGIN_ID)) {
    throw compatibilityError(
      `${CAPABILITY_MANIFEST_NAME} lacks plugin ${REQUIRED_EXTERNAL_PLUGIN_ID}`,
    );
  }
  if (!pluginIds.includes(REQUIRED_CHANNEL_PLUGIN_ID)) {
    throw compatibilityError(
      `${CAPABILITY_MANIFEST_NAME} lacks plugin ${REQUIRED_CHANNEL_PLUGIN_ID}`,
    );
  }
  for (const capability of REQUIRED_OPENCLAW_BUNDLE_CAPABILITIES) {
    if (!capabilities.includes(capability)) {
      throw compatibilityError(`${CAPABILITY_MANIFEST_NAME} lacks ${capability}`);
    }
  }
  return capabilities;
}

function requireExternalPlugins(
  value: unknown,
  manifest: BundleManifest,
): VerifiedExternalPlugin[] {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.plugins)) {
    throw compatibilityError(
      `${EXTERNAL_PLUGIN_MANIFEST_NAME} must use schemaVersion 1 with plugins`,
    );
  }
  if (Object.keys(value).sort().join("\0") !== "plugins\0schemaVersion") {
    throw compatibilityError(
      `${EXTERNAL_PLUGIN_MANIFEST_NAME} contains unexpected fields`,
    );
  }
  if (value.plugins.length !== 1 || !isRecord(value.plugins[0])) {
    throw compatibilityError(
      `${EXTERNAL_PLUGIN_MANIFEST_NAME} must contain exactly the Slack plugin`,
    );
  }
  const raw = value.plugins[0];
  if (
    Object.keys(raw).sort().join("\0") !==
    "artifact\0id\0integrity\0packageName\0sha256\0shasum\0spec\0version"
  ) {
    throw compatibilityError(
      `${EXTERNAL_PLUGIN_MANIFEST_NAME} Slack record must use the exact contract`,
    );
  }
  const version = requireNonemptyString(
    raw.version,
    `${EXTERNAL_PLUGIN_MANIFEST_NAME} Slack version is required`,
  );
  const artifact = requireNonemptyString(
    raw.artifact,
    `${EXTERNAL_PLUGIN_MANIFEST_NAME} Slack artifact is required`,
  );
  const shasum = requireNonemptyString(
    raw.shasum,
    `${EXTERNAL_PLUGIN_MANIFEST_NAME} Slack shasum is required`,
  );
  const integrity = requireNonemptyString(
    raw.integrity,
    `${EXTERNAL_PLUGIN_MANIFEST_NAME} Slack integrity is required`,
  );
  if (
    raw.id !== REQUIRED_EXTERNAL_PLUGIN_ID ||
    raw.packageName !== "@openclaw/slack" ||
    version !== manifest.package.version ||
    raw.spec !== `@openclaw/slack@${version}` ||
    artifact !== "external-plugin-slack.tgz" ||
    !/^[a-f0-9]{40}$/.test(shasum) ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)
  ) {
    throw compatibilityError(
      `${EXTERNAL_PLUGIN_MANIFEST_NAME} has invalid Slack package identity`,
    );
  }
  const sha256 = requireSha256(
    raw.sha256,
    `${EXTERNAL_PLUGIN_MANIFEST_NAME} Slack SHA-256 is invalid`,
  );
  const asset = manifest.assets[artifact];
  if (!asset || asset.sha256 !== sha256) {
    throw compatibilityError("external Slack digest differs across bundle manifests");
  }
  return [
    {
      id: REQUIRED_EXTERNAL_PLUGIN_ID,
      packageName: "@openclaw/slack",
      version,
      spec: `@openclaw/slack@${version}`,
      artifact,
      integrity,
      shasum,
      sha256,
    },
  ];
}

function parseOfficialReleaseAssetUrl(
  rawUrl: string,
  expectedAssetName: string,
): { url: string; ref: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw compatibilityError(`${expectedAssetName} URL is invalid`);
  }
  const prefix = `/${OFFICIAL_BUNDLE_REPOSITORY}/releases/download/`;
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(prefix) ||
    !url.pathname.endsWith(`/${expectedAssetName}`)
  ) {
    throw compatibilityError(
      `${expectedAssetName} must use the official ${OFFICIAL_BUNDLE_REPOSITORY} release URL`,
    );
  }
  const encodedRef = url.pathname.slice(
    prefix.length,
    -`/${expectedAssetName}`.length,
  );
  if (!encodedRef || encodedRef.includes("/")) {
    throw compatibilityError(`${expectedAssetName} release ref is invalid`);
  }
  let ref: string;
  try {
    ref = decodeURIComponent(encodedRef);
  } catch {
    throw compatibilityError(`${expectedAssetName} release ref is invalid`);
  }
  if (!OFFICIAL_RELEASE_REF_RE.test(ref)) {
    throw compatibilityError(`${expectedAssetName} release ref is invalid`);
  }
  return { url: url.toString(), ref };
}

function siblingAssetUrl(manifestUrl: string, assetName: string): string {
  const url = new URL(manifestUrl);
  const segments = url.pathname.split("/");
  segments[segments.length - 1] = assetName;
  url.pathname = segments.join("/");
  return url.toString();
}

function readConfiguredBundle(): ConfiguredBundle | null {
  const bundleUrl = process.env.OPENCLAW_BUNDLE_URL?.trim() ?? "";
  const bundleUiUrl = process.env.OPENCLAW_BUNDLE_UI_URL?.trim() ?? "";
  const manifestUrl = process.env.OPENCLAW_BUNDLE_MANIFEST_URL?.trim() ?? "";
  const sourceSha = process.env.OPENCLAW_BUNDLE_SOURCE_SHA?.trim() ?? "";
  const canonicalSha256 = process.env.OPENCLAW_BUNDLE_SHA256?.trim() ?? "";
  const configuredValues = [
    bundleUrl,
    bundleUiUrl,
    manifestUrl,
    sourceSha,
    canonicalSha256,
  ];
  if (configuredValues.every((value) => value.length === 0)) {
    return null;
  }
  if (configuredValues.some((value) => value.length === 0)) {
    throw compatibilityError("verified bundle environment is incomplete");
  }
  const packageSpec = process.env.OPENCLAW_PACKAGE_SPEC?.trim() || null;
  if (packageSpec && !EXACT_PACKAGE_SPEC_RE.test(packageSpec)) {
    throw compatibilityError("OPENCLAW_PACKAGE_SPEC must be an exact OpenClaw version");
  }
  return {
    packageSpec,
    bundleUrl,
    bundleUiUrl,
    manifestUrl,
    sourceSha: requireExactGitSha(
      sourceSha,
      "OPENCLAW_BUNDLE_SOURCE_SHA must be an exact lowercase git SHA",
    ),
    canonicalSha256: requireSha256(
      canonicalSha256,
      "OPENCLAW_BUNDLE_SHA256 must be a lowercase SHA-256",
    ),
  };
}

async function fetchBytes(
  fetchImpl: FetchLike,
  url: string,
  assetName: string,
  maxBytes = MAX_MANIFEST_BYTES,
): Promise<Buffer> {
  const response = await fetchImpl(url, {
    headers: { accept: "application/octet-stream" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw compatibilityError(`HTTP ${response.status} fetching ${assetName}`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw compatibilityError(`${assetName} exceeds the manifest size limit`);
  }
  if (!response.body) {
    throw compatibilityError(`${assetName} has no response body`);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    totalBytes += chunk.value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw compatibilityError(`${assetName} exceeds the manifest size limit`);
    }
    chunks.push(Buffer.from(chunk.value));
  }
  if (totalBytes === 0) {
    throw compatibilityError(`${assetName} has an invalid size`);
  }
  return Buffer.concat(chunks, totalBytes);
}

function parseJson(bytes: Buffer, assetName: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw compatibilityError(`${assetName} is not valid JSON`);
  }
}

function requireManifestAssetBytes(
  manifest: BundleManifest,
  assetName: string,
  bytes: Buffer,
): void {
  const asset = manifest.assets[assetName];
  if (
    bytes.byteLength !== asset.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== asset.sha256
  ) {
    throw compatibilityError(`${assetName} does not match its manifest digest`);
  }
}

export function getConfiguredBundleFingerprint(): string | null {
  const configured = readConfiguredBundle();
  if (!configured) return null;
  return createHash("sha256")
    .update("openclaw-bundle-identity-v2\0")
    .update(configured.sourceSha)
    .update("\0")
    .update(configured.canonicalSha256)
    .digest("hex");
}

async function admitConfiguredBundleUncached(
  configured: ConfiguredBundle | null,
  fetchImpl: FetchLike,
): Promise<VerifiedBundleAdmission | null> {
  if (!configured) return null;

  const manifestLocation = parseOfficialReleaseAssetUrl(
    configured.manifestUrl,
    BUNDLE_MANIFEST_NAME,
  );
  const bundleLocation = parseOfficialReleaseAssetUrl(
    configured.bundleUrl,
    "openclaw.bundle.mjs",
  );
  const uiLocation = parseOfficialReleaseAssetUrl(
    configured.bundleUiUrl,
    "control-ui.tar.gz",
  );
  if (
    bundleLocation.ref !== manifestLocation.ref ||
    uiLocation.ref !== manifestLocation.ref
  ) {
    throw compatibilityError("verified bundle URLs must use one release ref");
  }

  const manifestBytes = await fetchBytes(
    fetchImpl,
    manifestLocation.url,
    BUNDLE_MANIFEST_NAME,
  );
  const manifest = requireBundleManifest(
    parseJson(manifestBytes, BUNDLE_MANIFEST_NAME),
  );
  if (manifest.source.fork.ref !== manifestLocation.ref) {
    throw compatibilityError("bundle release ref does not match manifest source ref");
  }
  if (configured.bundleUrl !== siblingAssetUrl(configured.manifestUrl, "openclaw.bundle.mjs")) {
    throw compatibilityError("OPENCLAW_BUNDLE_URL does not match the manifest release");
  }
  if (configured.bundleUiUrl !== siblingAssetUrl(configured.manifestUrl, "control-ui.tar.gz")) {
    throw compatibilityError("OPENCLAW_BUNDLE_UI_URL does not match the manifest release");
  }

  const expectedPackageSpec = `openclaw@${manifest.package.version}`;
  if (
    configured.packageSpec &&
    configured.packageSpec !== expectedPackageSpec
  ) {
    throw compatibilityError("OPENCLAW_PACKAGE_SPEC does not match bundle package identity");
  }
  if (configured.sourceSha !== manifest.source.fork.sha) {
    throw compatibilityError("OPENCLAW_BUNDLE_SOURCE_SHA does not match bundle source identity");
  }
  const canonicalAsset = manifest.assets[manifest.canonicalTarball];
  if (configured.canonicalSha256 !== canonicalAsset.sha256) {
    throw compatibilityError("OPENCLAW_BUNDLE_SHA256 does not match the canonical tarball");
  }

  const capabilityUrl = siblingAssetUrl(configured.manifestUrl, CAPABILITY_MANIFEST_NAME);
  const externalPluginManifestUrl = siblingAssetUrl(
    configured.manifestUrl,
    EXTERNAL_PLUGIN_MANIFEST_NAME,
  );
  const contractUrl = siblingAssetUrl(configured.manifestUrl, BUNDLE_CONTRACT_NAME);
  const releaseUrl = siblingAssetUrl(configured.manifestUrl, RELEASE_MANIFEST_NAME);
  const [externalPluginManifestBytes, capabilityBytes, contractBytes, releaseBytes] =
    await Promise.all([
      fetchBytes(
        fetchImpl,
        externalPluginManifestUrl,
        EXTERNAL_PLUGIN_MANIFEST_NAME,
      ),
      fetchBytes(fetchImpl, capabilityUrl, CAPABILITY_MANIFEST_NAME),
      fetchBytes(fetchImpl, contractUrl, BUNDLE_CONTRACT_NAME),
      fetchBytes(fetchImpl, releaseUrl, RELEASE_MANIFEST_NAME),
    ]);
  requireManifestAssetBytes(
    manifest,
    EXTERNAL_PLUGIN_MANIFEST_NAME,
    externalPluginManifestBytes,
  );
  const externalPlugins = requireExternalPlugins(
    parseJson(externalPluginManifestBytes, EXTERNAL_PLUGIN_MANIFEST_NAME),
    manifest,
  );

  requireManifestAssetBytes(manifest, CAPABILITY_MANIFEST_NAME, capabilityBytes);
  const capabilities = requireBundleCapabilities(
    parseJson(capabilityBytes, CAPABILITY_MANIFEST_NAME),
    manifest,
    externalPlugins,
  );

  for (const [documentName, bytes] of [
    [BUNDLE_CONTRACT_NAME, contractBytes],
    [RELEASE_MANIFEST_NAME, releaseBytes],
  ] as const) {
    requireManifestAssetBytes(manifest, documentName, bytes);
    requireIdentityDocument(
      parseJson(bytes, documentName),
      documentName,
      manifest,
      externalPlugins,
    );
  }

  return {
    identity: {
      packageSpec: expectedPackageSpec,
      version: manifest.package.version,
      forkSha: manifest.source.fork.sha,
      upstreamSha: manifest.source.upstream.sha,
      canonicalSha256: canonicalAsset.sha256,
      capabilities,
      verified: true,
    },
    canonicalTarball: manifest.canonicalTarball,
    canonicalTarballUrl: siblingAssetUrl(
      configured.manifestUrl,
      manifest.canonicalTarball,
    ),
    assets: manifest.assets,
    externalPlugins,
  };
}

export function admitConfiguredOpenClawBundle(
  fetchImpl: FetchLike = fetch,
): Promise<VerifiedBundleAdmission | null> {
  if (
    process.env.NODE_ENV === "test" &&
    admissionOverrideForTesting !== undefined
  ) {
    return Promise.resolve(admissionOverrideForTesting);
  }
  const configured = readConfiguredBundle();
  const key = configured ? JSON.stringify(configured) : "none";
  if (cachedAdmissionPromise && cachedAdmissionKey === key) {
    return cachedAdmissionPromise;
  }
  cachedAdmissionKey = key;
  cachedAdmissionPromise = admitConfiguredBundleUncached(
    configured,
    fetchImpl,
  ).catch((error: unknown) => {
    if (cachedAdmissionKey === key) {
      cachedAdmissionKey = null;
      cachedAdmissionPromise = null;
    }
    throw error;
  });
  return cachedAdmissionPromise;
}

export function verifiedBundleIdentitiesEqual(
  left: VerifiedBundleIdentity,
  right: VerifiedBundleIdentity,
): boolean {
  return (
    left.packageSpec === right.packageSpec &&
    left.version === right.version &&
    left.forkSha === right.forkSha &&
    left.upstreamSha === right.upstreamSha &&
    left.canonicalSha256 === right.canonicalSha256 &&
    left.verified === true &&
    right.verified === true &&
    left.capabilities.length === right.capabilities.length &&
    left.capabilities.every(
      (capability, index) => capability === right.capabilities[index],
    )
  );
}

export function bundleIdentityFromAdmission(
  admission: VerifiedBundleAdmission,
): VerifiedBundleIdentity {
  return structuredClone(admission.identity);
}

export async function hydrateVerifiedBundleIdentity(
  storedIdentity: unknown,
  fetchImpl: FetchLike = fetch,
): Promise<VerifiedBundleIdentity | null> {
  if (!isVerifiedBundleIdentity(storedIdentity)) {
    return null;
  }
  const admission = await admitConfiguredOpenClawBundle(fetchImpl);
  if (
    !admission ||
    !verifiedBundleIdentitiesEqual(storedIdentity, admission.identity)
  ) {
    return null;
  }
  return structuredClone(storedIdentity);
}

export function _resetBundleIdentityForTesting(): void {
  if (process.env.NODE_ENV !== "test") return;
  cachedAdmissionKey = null;
  cachedAdmissionPromise = null;
  admissionOverrideForTesting = undefined;
}

export function _setBundleAdmissionForTesting(
  admission: VerifiedBundleAdmission | null,
): void {
  if (process.env.NODE_ENV !== "test") return;
  cachedAdmissionKey = null;
  cachedAdmissionPromise = null;
  admissionOverrideForTesting = structuredClone(admission);
}
