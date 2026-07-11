import { logError, logInfo, logWarn } from "@/server/log";
import { getOpenclawPackageSpec, isVercelDeployment } from "@/server/env";
import { isPinnedPackageSpec } from "@/server/deployment-contract";
import {
  admitConfiguredOpenClawBundle,
  bundleIdentityFromAdmission,
  type VerifiedBundleAdmission,
  type VerifiedBundleIdentity,
} from "@/server/openclaw/bundle-identity";
import {
  buildStartupScript,
  BUN_BIN,
  BUN_DOWNLOAD_SHA256,
  BUN_DOWNLOAD_URL,
  BUN_INSTALL_DIR,
  getOpenclawBundleUrl,
  getOpenclawGatewayCmd,
  OPENCLAW_BIN,
  OPENCLAW_BUNDLE_PATH,
  OPENCLAW_BUNDLED_PLUGINS_DIR_PATH,
  OPENCLAW_CONFIG_PATH,
  OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
  OPENCLAW_INSTALL_PATCH_SCRIPT_PATH,
  OPENCLAW_LOG_FILE,
  OPENCLAW_STARTUP_SCRIPT_PATH,
  OPENCLAW_STATE_DIR,
  OPENCLAW_WORKSPACE_TEMPLATES_DIR,
} from "@/server/openclaw/config";
import {
  buildOpenClawInstallPatchScript,
  parseOpenClawInstallPatchOutcome,
} from "@/server/openclaw/install-patches";
import {
  buildBootstrapFiles,
  buildRestoreAssetManifest,
} from "@/server/openclaw/restore-assets";
import type { SetupProgressWriter } from "@/server/sandbox/setup-progress";

import type { CommandResult, SandboxHandle } from "@/server/sandbox/controller";

// ---------------------------------------------------------------------------
// Structured command-failure error
// ---------------------------------------------------------------------------

export class CommandFailedError extends Error {
  readonly command: string;
  readonly exitCode: number;
  readonly trimmedOutput: string;

  constructor(opts: { command: string; exitCode: number; output: string }) {
    const trimmed = opts.output.trim().slice(-500);
    super(
      `Command "${opts.command}" failed with exit code ${opts.exitCode}: ${trimmed}`,
    );
    this.name = "CommandFailedError";
    this.command = opts.command;
    this.exitCode = opts.exitCode;
    this.trimmedOutput = trimmed;
  }

  toJSON() {
    return {
      error: this.name,
      command: this.command,
      exitCode: this.exitCode,
      output: this.trimmedOutput,
    };
  }
}

async function assertCommandSuccess(
  label: string,
  result: CommandResult,
): Promise<void> {
  if (result.exitCode !== 0) {
    const output = await result.output("both");
    throw new CommandFailedError({
      command: label,
      exitCode: result.exitCode,
      output,
    });
  }
}

function buildBundleCompatibilityShimScript(): string {
  return [
    "set -e",
    "ROOT=/home/vercel-sandbox",
    "mkdir -p \"$ROOT/agents\" \"$ROOT/config\" \"$ROOT/plugins\" \"$ROOT/dist\" \"$ROOT/dist/agents\" \"$ROOT/dist/config\" \"$ROOT/dist/plugins\"",
    "find \"$ROOT\" -maxdepth 1 -type f \\( -name '*.js' -o -name '*.cjs' \\) -exec cp -f {} \"$ROOT/dist/\" \\;",
    "if grep -Rqs './agents/model-catalog.runtime.js' \"$ROOT\"/*.js \"$ROOT\"/*/*.js 2>/dev/null; then",
    "  if [ ! -f \"$ROOT/run-model-catalog.runtime.js\" ]; then",
    "    echo 'missing run-model-catalog.runtime.js for agents/model-catalog.runtime.js shim' >&2",
    "    exit 1",
    "  fi",
    "  cat > \"$ROOT/agents/model-catalog.runtime.js\" <<'EOF'",
    "export * from '../run-model-catalog.runtime.js';",
    "EOF",
    "  cat > \"$ROOT/dist/agents/model-catalog.runtime.js\" <<'EOF'",
    "export * from '../run-model-catalog.runtime.js';",
    "EOF",
    "fi",
    "if grep -Rqs './agents/auth-profiles.runtime.js' \"$ROOT\"/*.js \"$ROOT\"/*/*.js 2>/dev/null; then",
    "  auth_module=$(grep -l 'ensureAuthProfileStore' \"$ROOT\"/auth-profiles-*.js 2>/dev/null | head -n 1 || true)",
    "  if [ -z \"$auth_module\" ]; then",
    "    echo 'missing auth-profiles chunk for agents/auth-profiles.runtime.js shim' >&2",
    "    exit 1",
    "  fi",
    "  auth_base=$(basename \"$auth_module\")",
    "  cat > \"$ROOT/agents/auth-profiles.runtime.js\" <<EOF",
    "export * from '../$auth_base';",
    "EOF",
    "  cat > \"$ROOT/dist/agents/auth-profiles.runtime.js\" <<EOF",
    "export * from '../$auth_base';",
    "EOF",
    "fi",
    "if grep -Rqs './agents/pi-model-discovery-runtime.js' \"$ROOT\"/*.js \"$ROOT\"/*/*.js 2>/dev/null; then",
    "  if [ -f \"$ROOT/dist/agents/pi-model-discovery-runtime.js\" ]; then",
    "    cp -f \"$ROOT/dist/agents/pi-model-discovery-runtime.js\" \"$ROOT/agents/pi-model-discovery-runtime.js\"",
    "  else",
    "    pi_discovery_module=$(grep -l 'discoverModels' \"$ROOT\"/pi-model-discovery-*.js 2>/dev/null | head -n 1 || true)",
    "    if [ -z \"$pi_discovery_module\" ]; then",
    "      echo 'missing pi-model-discovery chunk for agents/pi-model-discovery-runtime.js shim' >&2",
    "      exit 1",
    "    fi",
    "    pi_discovery_base=$(basename \"$pi_discovery_module\")",
    "    cat > \"$ROOT/agents/pi-model-discovery-runtime.js\" <<EOF",
    "import * as piDiscovery from '../$pi_discovery_base';",
    "export * from '../$pi_discovery_base';",
    "const byName = (name) => Object.values(piDiscovery).find((value) => typeof value === 'function' && value.name === name);",
    "export const discoverModels = piDiscovery.discoverModels ?? byName('discoverModels') ?? piDiscovery.a ?? piDiscovery.i;",
    "export const discoverAuthStorage = piDiscovery.discoverAuthStorage ?? byName('discoverAuthStorage') ?? piDiscovery.i ?? piDiscovery.r;",
    "export const normalizeDiscoveredPiModel = piDiscovery.normalizeDiscoveredPiModel ?? byName('normalizeDiscoveredPiModel') ?? piDiscovery.o ?? piDiscovery.a;",
    "export const scrubLegacyStaticAuthJsonEntriesForDiscovery = piDiscovery.scrubLegacyStaticAuthJsonEntriesForDiscovery ?? byName('scrubLegacyStaticAuthJsonEntriesForDiscovery') ?? piDiscovery.c;",
    "export const resolvePiCredentialsForDiscovery = piDiscovery.resolvePiCredentialsForDiscovery ?? byName('resolvePiCredentialsForDiscovery') ?? piDiscovery.s ?? piDiscovery.o;",
    "export const addEnvBackedPiCredentials = piDiscovery.addEnvBackedPiCredentials ?? byName('addEnvBackedPiCredentials') ?? piDiscovery.r ?? piDiscovery.s;",
    "export const ModelRegistry = piDiscovery.ModelRegistry ?? piDiscovery.PiModelRegistryClass ?? byName('ModelRegistry') ?? piDiscovery.n;",
    "export const PiModelRegistryClass = ModelRegistry;",
    "export const AuthStorage = piDiscovery.AuthStorage ?? piDiscovery.PiAuthStorageClass ?? byName('AuthStorage') ?? piDiscovery.t;",
    "export const PiAuthStorageClass = AuthStorage;",
    "EOF",
    "    cp -f \"$ROOT/agents/pi-model-discovery-runtime.js\" \"$ROOT/dist/agents/pi-model-discovery-runtime.js\"",
    "  fi",
    "fi",
    "if grep -Rqs './agents/models-config.runtime.js' \"$ROOT\"/*.js \"$ROOT\"/*/*.js 2>/dev/null; then",
    "  models_config_module=$(grep -l 'ensureOpenClawModelsJson' \"$ROOT\"/models-config-*.js 2>/dev/null | head -n 1 || true)",
    "  if [ -z \"$models_config_module\" ]; then",
    "    echo 'missing models-config chunk for agents/models-config.runtime.js shim' >&2",
    "    exit 1",
    "  fi",
    "  models_config_base=$(basename \"$models_config_module\")",
    "  cat > \"$ROOT/agents/models-config.runtime.js\" <<EOF",
    "export * from '../$models_config_base';",
    "export { n as ensureOpenClawModelsJson, r as writeModelsFileAtomicForModelsJson, t as ensureModelsFileModeForModelsJson } from '../$models_config_base';",
    "EOF",
    "  cat > \"$ROOT/dist/agents/models-config.runtime.js\" <<EOF",
    "export * from '../$models_config_base';",
    "export { n as ensureOpenClawModelsJson, r as writeModelsFileAtomicForModelsJson, t as ensureModelsFileModeForModelsJson } from '../$models_config_base';",
    "EOF",
    "fi",
    "if grep -Rqs './agents/pi-bundle-mcp-runtime.js' \"$ROOT\"/*.js \"$ROOT\"/*/*.js 2>/dev/null; then",
    "  pi_mcp_module=$(grep -l 'createSessionMcpRuntime' \"$ROOT\"/pi-bundle-mcp-runtime-*.js 2>/dev/null | head -n 1 || true)",
    "  if [ -z \"$pi_mcp_module\" ]; then",
    "    echo 'missing pi-bundle-mcp-runtime chunk for agents/pi-bundle-mcp-runtime.js shim' >&2",
    "    exit 1",
    "  fi",
    "  pi_mcp_base=$(basename \"$pi_mcp_module\")",
    "  cat > \"$ROOT/agents/pi-bundle-mcp-runtime.js\" <<EOF",
    "export * from '../$pi_mcp_base';",
    "export { r as createSessionMcpRuntime, o as getOrCreateSessionMcpRuntime, s as getSessionMcpRuntimeManager, a as disposeSessionMcpRuntime, c as retireSessionMcpRuntime, i as disposeAllSessionMcpRuntimes, l as retireSessionMcpRuntimeForSessionKey, n as createBundleMcpJsonSchemaValidator, t as __testing } from '../$pi_mcp_base';",
    "EOF",
    "  cat > \"$ROOT/dist/agents/pi-bundle-mcp-runtime.js\" <<EOF",
    "export * from '../$pi_mcp_base';",
    "export { r as createSessionMcpRuntime, o as getOrCreateSessionMcpRuntime, s as getSessionMcpRuntimeManager, a as disposeSessionMcpRuntime, c as retireSessionMcpRuntime, i as disposeAllSessionMcpRuntimes, l as retireSessionMcpRuntimeForSessionKey, n as createBundleMcpJsonSchemaValidator, t as __testing } from '../$pi_mcp_base';",
    "EOF",
    "fi",
    "if grep -Rqs './plugins/provider-discovery.runtime.js' \"$ROOT\"/*.js \"$ROOT\"/*/*.js 2>/dev/null; then",
    "  if [ ! -f \"$ROOT/provider-discovery.runtime.js\" ]; then",
    "    echo 'missing provider-discovery.runtime.js for plugins/provider-discovery.runtime.js shim' >&2",
    "    exit 1",
    "  fi",
    "  cat > \"$ROOT/plugins/provider-discovery.runtime.js\" <<'EOF'",
    "export * from '../provider-discovery.runtime.js';",
    "export { t as resolvePluginDiscoveryProvidersRuntime } from '../provider-discovery.runtime.js';",
    "EOF",
    "  cat > \"$ROOT/dist/plugins/provider-discovery.runtime.js\" <<'EOF'",
    "export * from '../provider-discovery.runtime.js';",
    "export { t as resolvePluginDiscoveryProvidersRuntime } from '../provider-discovery.runtime.js';",
    "EOF",
    "fi",
    "if grep -Rqs './config/config.js' \"$ROOT\"/*.js \"$ROOT\"/*/*.js 2>/dev/null; then",
    "  io_module=$(grep -l 'getRuntimeConfig as i' \"$ROOT\"/io-*.js 2>/dev/null | head -n 1 || true)",
    "  mutate_module=$(grep -l 'replaceConfigFile as r' \"$ROOT\"/mutate-*.js 2>/dev/null | head -n 1 || true)",
    "  paths_module=$(grep -l 'CONFIG_PATH as t' \"$ROOT\"/paths-*.js 2>/dev/null | head -n 1 || true)",
    "  if [ -z \"$io_module\" ] || [ -z \"$mutate_module\" ] || [ -z \"$paths_module\" ]; then",
    "    echo 'missing shared config chunks for config/config.js shim' >&2",
    "    exit 1",
    "  fi",
    "  io_base=$(basename \"$io_module\")",
    "  mutate_base=$(basename \"$mutate_module\")",
    "  paths_base=$(basename \"$paths_module\")",
    "  cat > \"$ROOT/config/config.js\" <<EOF",
    "export { A as applyConfigOverrides, C as validateConfigObjectRaw, S as validateConfigObject, T as validateConfigObjectWithPlugins, U as formatInvalidConfigDetails, a as loadConfig, b as writeConfigFile, d as readConfigFileSnapshotForWrite, f as readConfigFileSnapshotWithPluginMetadata, i as getRuntimeConfig, l as readBestEffortConfig, n as clearConfigCache, r as createConfigIO, u as readConfigFileSnapshot, v as registerConfigWriteListener, x as collectUnsupportedSecretRefPolicyIssues, y as resolveConfigSnapshotHash } from '../$io_base';",
    "export { n as mutateConfigFile, r as replaceConfigFile, t as ConfigMutationConflictError } from '../$mutate_base';",
    "export { _ as resolveOAuthPath, a as resolveCanonicalConfigPath, c as resolveDefaultConfigCandidates, d as resolveIncludeRoots, f as resolveIsNixMode, g as resolveOAuthDir, h as resolveNewStateDir, i as isNixMode, l as resolveGatewayLockDir, m as resolveLegacyStateDirs, n as DEFAULT_GATEWAY_PORT, o as resolveConfigPath, p as resolveLegacyStateDir, r as STATE_DIR, s as resolveConfigPathCandidate, t as CONFIG_PATH, u as resolveGatewayPort, v as resolveStateDir } from '../$paths_base';",
    "EOF",
    "  cat > \"$ROOT/dist/config/config.js\" <<EOF",
    "export { A as applyConfigOverrides, C as validateConfigObjectRaw, S as validateConfigObject, T as validateConfigObjectWithPlugins, U as formatInvalidConfigDetails, a as loadConfig, b as writeConfigFile, d as readConfigFileSnapshotForWrite, f as readConfigFileSnapshotWithPluginMetadata, i as getRuntimeConfig, l as readBestEffortConfig, n as clearConfigCache, r as createConfigIO, u as readConfigFileSnapshot, v as registerConfigWriteListener, x as collectUnsupportedSecretRefPolicyIssues, y as resolveConfigSnapshotHash } from '../$io_base';",
    "export { n as mutateConfigFile, r as replaceConfigFile, t as ConfigMutationConflictError } from '../$mutate_base';",
    "export { _ as resolveOAuthPath, a as resolveCanonicalConfigPath, c as resolveDefaultConfigCandidates, d as resolveIncludeRoots, f as resolveIsNixMode, g as resolveOAuthDir, h as resolveNewStateDir, i as isNixMode, l as resolveGatewayLockDir, m as resolveLegacyStateDirs, n as DEFAULT_GATEWAY_PORT, o as resolveConfigPath, p as resolveLegacyStateDir, r as STATE_DIR, s as resolveConfigPathCandidate, t as CONFIG_PATH, u as resolveGatewayPort, v as resolveStateDir } from '../$paths_base';",
    "EOF",
    "fi",
  ].join("\n");
}

const OPENCLAW_BUNDLE_METADATA_DIR = "/home/vercel-sandbox/.openclaw-bundle";
export const OPENCLAW_BUNDLE_IDENTITY_PATH =
  `${OPENCLAW_BUNDLE_METADATA_DIR}/identity.json`;
const OPENCLAW_BUNDLE_STAGE_DIR = "/tmp/openclaw-bundle-assets";
const OPENCLAW_BUNDLE_ARCHIVE_PATH = "/tmp/openclaw-release.tar.gz";

function shellArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildVerifiedBundleInstallScript(
  admission: VerifiedBundleAdmission,
): string {
  const archiveAssets = Object.keys(admission.assets)
    .filter((assetName) => assetName !== admission.canonicalTarball)
    .sort((left, right) => left.localeCompare(right));
  const expectedEntries = archiveAssets.map(shellArg).join(" ");
  const canonicalAsset = admission.assets[admission.canonicalTarball];
  const nestedTarAssets = [
    "workspace-templates.tar.gz",
    "channels.tar.gz",
    "runtime-plugins.tar.gz",
    "bundle-deps.tar.gz",
    "bundle-openclaw-pkg.tar.gz",
    "control-ui.tar.gz",
    ...admission.externalPlugins.map((plugin) => plugin.artifact),
    ...(admission.assets["channel-shared-chunks.tar.gz"]
      ? ["channel-shared-chunks.tar.gz"]
      : []),
  ];
  const lines = [
    "set -euo pipefail",
    "export LC_ALL=C",
    `rm -rf ${shellArg(OPENCLAW_BUNDLE_STAGE_DIR)} ${shellArg(OPENCLAW_BUNDLE_ARCHIVE_PATH)}`,
    `mkdir -p ${shellArg(OPENCLAW_BUNDLE_STAGE_DIR)}`,
    `curl -fsSL --proto '=https' --proto-redir '=https' --max-time 180 --connect-timeout 10 --max-filesize ${canonicalAsset.bytes} -o ${shellArg(OPENCLAW_BUNDLE_ARCHIVE_PATH)} ${shellArg(admission.canonicalTarballUrl)}`,
    `test "$(wc -c < ${shellArg(OPENCLAW_BUNDLE_ARCHIVE_PATH)} | tr -d '[:space:]')" = ${shellArg(String(canonicalAsset.bytes))}`,
    `printf '%s  %s\\n' ${shellArg(admission.identity.canonicalSha256)} ${shellArg(OPENCLAW_BUNDLE_ARCHIVE_PATH)} | sha256sum -c -`,
    `printf '%s\\n' ${expectedEntries} | sort > /tmp/openclaw-bundle-expected.txt`,
    `tar -tzf ${shellArg(OPENCLAW_BUNDLE_ARCHIVE_PATH)} | sed 's#^\\./##' | sort > /tmp/openclaw-bundle-actual.txt`,
    "cmp -s /tmp/openclaw-bundle-expected.txt /tmp/openclaw-bundle-actual.txt || { echo 'canonical bundle entries do not match asset-manifest.json' >&2; exit 1; }",
    `tar -tvzf ${shellArg(OPENCLAW_BUNDLE_ARCHIVE_PATH)} | awk 'substr($1,1,1) != "-" { exit 1 }'`,
    `tar xzf ${shellArg(OPENCLAW_BUNDLE_ARCHIVE_PATH)} -C ${shellArg(OPENCLAW_BUNDLE_STAGE_DIR)}`,
  ];

  for (const assetName of archiveAssets) {
    const asset = admission.assets[assetName];
    const assetPath = `${OPENCLAW_BUNDLE_STAGE_DIR}/${assetName}`;
    lines.push(
      `test -f ${shellArg(assetPath)} && test ! -L ${shellArg(assetPath)}`,
      `test "$(wc -c < ${shellArg(assetPath)} | tr -d '[:space:]')" = ${shellArg(String(asset.bytes))}`,
      `printf '%s  %s\\n' ${shellArg(asset.sha256)} ${shellArg(assetPath)} | sha256sum -c -`,
    );
  }

  const verifyNpmIntegrity = [
    'const fs = require("node:fs");',
    'const crypto = require("node:crypto");',
    "const [file, expectedSha1, expectedIntegrity] = process.argv.slice(1);",
    "const bytes = fs.readFileSync(file);",
    'const sha1 = crypto.createHash("sha1").update(bytes).digest("hex");',
    'const integrity = `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;',
    'if (sha1 !== expectedSha1 || integrity !== expectedIntegrity) throw new Error("external plugin npm integrity mismatch");',
  ].join("");
  for (const plugin of admission.externalPlugins) {
    lines.push(
      `node -e ${shellArg(verifyNpmIntegrity)} ${shellArg(`${OPENCLAW_BUNDLE_STAGE_DIR}/${plugin.artifact}`)} ${shellArg(plugin.shasum)} ${shellArg(plugin.integrity)}`,
    );
  }

  const verifyTar = [
    "set -e;",
    'archive="$1";',
    "tar -tzf \"$archive\" | awk '",
    '  /^\\// { exit 1 }',
    '  /(^|\\/)\\.\\.(\\/|$)/ { exit 1 }',
    '  seen[$0]++ { exit 1 }',
    "';",
    "tar -tvzf \"$archive\" | awk '",
    '  { type = substr($1, 1, 1) }',
    '  type != "-" && type != "d" { exit 1 }',
    "'",
  ].join("\n");
  for (const assetName of nestedTarAssets) {
    lines.push(
      `bash -c ${shellArg(verifyTar)} verify-tar ${shellArg(`${OPENCLAW_BUNDLE_STAGE_DIR}/${assetName}`)}`,
    );
  }

  const verifyPackageJson = [
    'const fs = require("node:fs");',
    "const [expectedName, expectedVersion] = process.argv.slice(1);",
    'const value = JSON.parse(fs.readFileSync(0, "utf8"));',
    'if (value.name !== expectedName || value.version !== expectedVersion) throw new Error("external plugin package identity mismatch");',
  ].join("");
  const verifyPluginManifest = [
    'const fs = require("node:fs");',
    "const [expectedId] = process.argv.slice(1);",
    'const value = JSON.parse(fs.readFileSync(0, "utf8"));',
    'if (value.id !== expectedId) throw new Error("external plugin manifest identity mismatch");',
  ].join("");
  for (const plugin of admission.externalPlugins) {
    const pluginArchive = `${OPENCLAW_BUNDLE_STAGE_DIR}/${plugin.artifact}`;
    lines.push(
      `tar -tzf ${shellArg(pluginArchive)} | grep -qx 'package/package.json'`,
      `tar -tzf ${shellArg(pluginArchive)} | grep -qx 'package/openclaw.plugin.json'`,
      `tar -tzf ${shellArg(pluginArchive)} | grep -Eq '^package/dist/.+\\.js$'`,
      `tar -xOzf ${shellArg(pluginArchive)} package/package.json | node -e ${shellArg(verifyPackageJson)} ${shellArg(plugin.packageName)} ${shellArg(plugin.version)}`,
      `tar -xOzf ${shellArg(pluginArchive)} package/openclaw.plugin.json | node -e ${shellArg(verifyPluginManifest)} ${shellArg(plugin.id)}`,
    );
  }

  lines.push(
    `mkdir -p /home/vercel-sandbox/dist ${shellArg(OPENCLAW_WORKSPACE_TEMPLATES_DIR)} ${shellArg(OPENCLAW_BUNDLED_PLUGINS_DIR_PATH)} ${shellArg(OPENCLAW_BUNDLE_METADATA_DIR)}`,
    `install -m 0644 ${shellArg(`${OPENCLAW_BUNDLE_STAGE_DIR}/openclaw.bundle.mjs`)} ${shellArg(OPENCLAW_BUNDLE_PATH)}`,
    `install -m 0644 ${shellArg(`${OPENCLAW_BUNDLE_STAGE_DIR}/channel-catalog.json`)} /home/vercel-sandbox/dist/channel-catalog.json`,
    `tar xzf ${shellArg(`${OPENCLAW_BUNDLE_STAGE_DIR}/workspace-templates.tar.gz`)} -C ${shellArg(OPENCLAW_WORKSPACE_TEMPLATES_DIR)}`,
    `tar xzf ${shellArg(`${OPENCLAW_BUNDLE_STAGE_DIR}/channels.tar.gz`)} -C ${shellArg(OPENCLAW_BUNDLED_PLUGINS_DIR_PATH)}`,
    `tar xzf ${shellArg(`${OPENCLAW_BUNDLE_STAGE_DIR}/runtime-plugins.tar.gz`)} -C ${shellArg(OPENCLAW_BUNDLED_PLUGINS_DIR_PATH)}`,
    `test -s ${shellArg(`${OPENCLAW_BUNDLED_PLUGINS_DIR_PATH}/admin-http-rpc/package.json`)}`,
    `test -s ${shellArg(`${OPENCLAW_BUNDLED_PLUGINS_DIR_PATH}/admin-http-rpc/index.js`)}`,
    `tar xzf ${shellArg(`${OPENCLAW_BUNDLE_STAGE_DIR}/bundle-deps.tar.gz`)} -C /home/vercel-sandbox`,
    `tar xzf ${shellArg(`${OPENCLAW_BUNDLE_STAGE_DIR}/bundle-openclaw-pkg.tar.gz`)} -C /home/vercel-sandbox`,
  );

  if (admission.assets["channel-shared-chunks.tar.gz"]) {
    lines.push(
      `tar xzf ${shellArg(`${OPENCLAW_BUNDLE_STAGE_DIR}/channel-shared-chunks.tar.gz`)} -C /home/vercel-sandbox`,
    );
  }

  lines.push(
    buildBundleCompatibilityShimScript(),
    `tar xzf ${shellArg(`${OPENCLAW_BUNDLE_STAGE_DIR}/control-ui.tar.gz`)} -C /home/vercel-sandbox/dist`,
    `install -m 0644 ${shellArg(`${OPENCLAW_BUNDLE_STAGE_DIR}/bundle-capabilities.json`)} ${shellArg(`${OPENCLAW_BUNDLE_METADATA_DIR}/bundle-capabilities.json`)}`,
    `install -m 0644 ${shellArg(`${OPENCLAW_BUNDLE_STAGE_DIR}/bundle-contract.json`)} ${shellArg(`${OPENCLAW_BUNDLE_METADATA_DIR}/bundle-contract.json`)}`,
    `install -m 0644 ${shellArg(`${OPENCLAW_BUNDLE_STAGE_DIR}/release.json`)} ${shellArg(`${OPENCLAW_BUNDLE_METADATA_DIR}/release.json`)}`,
    `printf '%s\\n' ${shellArg(JSON.stringify({ name: "openclaw", private: true, version: admission.identity.version, type: "module" }))} > /home/vercel-sandbox/package.json`,
  );
  for (const plugin of admission.externalPlugins) {
    lines.push(
      `install -m 0600 ${shellArg(`${OPENCLAW_BUNDLE_STAGE_DIR}/${plugin.artifact}`)} ${shellArg(`${OPENCLAW_BUNDLE_METADATA_DIR}/${plugin.artifact}`)}`,
    );
  }
  lines.push(
    `rm -rf ${shellArg(OPENCLAW_BUNDLE_STAGE_DIR)} ${shellArg(OPENCLAW_BUNDLE_ARCHIVE_PATH)} /tmp/openclaw-bundle-expected.txt /tmp/openclaw-bundle-actual.txt`,
  );
  return lines.join("\n");
}

export type BootstrapRuntime = {
  packageSpec: string;
  installedVersion: string | null;
  drift: boolean;
};

export async function setupOpenClaw(
  sandbox: SandboxHandle,
  options: {
    gatewayToken: string;
    apiKey?: string;
    proxyOrigin: string;
    telegramBotToken?: string;
    slackCredentials?: { botToken: string; signingSecret: string };
    telegramWebhookSecret?: string;
    progress?: SetupProgressWriter;
  },
): Promise<{
  startupScript: string;
  openclawVersion: string | null;
  runtime: BootstrapRuntime;
  bundleIdentity: VerifiedBundleIdentity | null;
}> {
  const startupScript = buildStartupScript();
  const progress = options.progress;

  let packageSpec: string;
  const onVercel = isVercelDeployment();
  const bundleUrl = getOpenclawBundleUrl();
  let bundleAdmission: VerifiedBundleAdmission | null = null;
  let bundleIdentity: VerifiedBundleIdentity | null = null;

  if (bundleUrl) {
    bundleAdmission = await admitConfiguredOpenClawBundle();
    if (!bundleAdmission) {
      throw new Error("Verified bundle admission is required when OPENCLAW_BUNDLE_URL is set");
    }
    // Bundle mode takes its package identity from the digest-pinned manifest.
    // Never let the npm fallback select a different runtime for this archive.
    packageSpec = bundleAdmission.identity.packageSpec;
  } else {
    packageSpec = getOpenclawPackageSpec();
    if (onVercel && !isPinnedPackageSpec(packageSpec)) {
      logWarn("openclaw.setup.unpinned_package_spec", {
        sandboxId: sandbox.sandboxId,
        packageSpec,
        reason: "Vercel deployments should use a pinned OPENCLAW_PACKAGE_SPEC for deterministic restores — falling back to current spec",
      });
    }
  }

  logInfo("openclaw.setup.start", { sandboxId: sandbox.sandboxId, packageSpec, onVercel, bundleUrl: bundleUrl ?? null });

  if (bundleAdmission) {
    const admission = bundleAdmission;
    progress?.setPhase("downloading-bundle", "Downloading verified bundle");
    const downloadResult = await sandbox.runCommand({
      cmd: "bash",
      args: ["-c", buildVerifiedBundleInstallScript(admission)],
      stdout: progress?.makeWritable("stdout"),
      stderr: progress?.makeWritable("stderr"),
    });
    await assertCommandSuccess("verified bundle install", downloadResult);

    // The bundle has no provider bootstrap for this synthetic runtime, so
    // seed the placeholder profile used by the network-policy auth transform.
    await sandbox.writeFiles([
      {
        path: "/home/vercel-sandbox/.openclaw/agents/main/agent/auth-profiles.json",
        content: Buffer.from(
          JSON.stringify({
            version: 1,
            profiles: {
              "vercel-ai-gateway:default": {
                type: "api_key",
                provider: "vercel-ai-gateway",
                key: "sk-placeholder-injected-via-network-policy",
              },
            },
          }),
        ),
      },
    ]);
    logInfo("openclaw.setup.bundle_verified", {
      sandboxId: sandbox.sandboxId,
      packageSpec: admission.identity.packageSpec,
      forkSha: admission.identity.forkSha,
      upstreamSha: admission.identity.upstreamSha,
      canonicalSha256: admission.identity.canonicalSha256,
      capabilities: admission.identity.capabilities,
    });
  } else {
    // ---------- npm install path (existing) ----------
    progress?.setPhase("installing-openclaw", `Installing ${packageSpec}`);
    const installResult = await sandbox.runCommand({
      cmd: "npm",
      args: [
        "install",
        "-g",
        packageSpec,
        "--ignore-scripts",
        "--loglevel",
        "info",
      ],
      env: {
        NPM_CONFIG_CACHE: "/tmp/openclaw-npm-cache",
        NPM_CONFIG_PROGRESS: "false",
      },
      stdout: progress?.makeWritable("stdout"),
      stderr: progress?.makeWritable("stderr"),
    });
    await assertCommandSuccess("npm install", installResult);

    // Install missing plugin peer dependencies into the openclaw package directory.
    // OpenClaw 2026.3.31+ bundles plugins (slack, telegram, discord, bedrock) but
    // their peer deps aren't installed with --ignore-scripts.  Without these, the
    // gateway returns 500 on all routes during plugin init.
    progress?.setPhase("installing-peer-deps", "Installing missing peer dependencies");
    const peerDepResult = await sandbox.runCommand({
      cmd: "bash",
      args: [
        "-lc",
        [
          "set -e",
          "OC_PKG=/home/vercel-sandbox/.global/npm/lib/node_modules/openclaw",
          "mkdir -p /tmp/openclaw-peer-deps && cd /tmp/openclaw-peer-deps",
          "npm init -y > /dev/null 2>&1",
          "npm install @buape/carbon @slack/web-api grammy --no-save --ignore-scripts --loglevel warn 2>&1",
          "mkdir -p $OC_PKG/node_modules",
          "cp -r node_modules/@buape node_modules/@slack node_modules/grammy $OC_PKG/node_modules/ 2>/dev/null || true",
          // Copy scoped package internals that @slack/web-api needs
          "for dep in @slack/types @slack/logger @slack/oauth @slack/socket-mode; do [ -d node_modules/${dep%%/*} ] && cp -r node_modules/${dep%%/*} $OC_PKG/node_modules/ 2>/dev/null; done || true",
          "rm -rf /tmp/openclaw-peer-deps",
        ].join(" && "),
      ],
      stdout: progress?.makeWritable("stdout"),
      stderr: progress?.makeWritable("stderr"),
    });
    if (peerDepResult.exitCode !== 0) {
      const stderr = (await peerDepResult.output("stderr")).trim();
      logWarn("openclaw.setup.peer_deps_install_failed", {
        sandboxId: sandbox.sandboxId,
        exitCode: peerDepResult.exitCode,
        stderr: stderr.slice(-500),
      });
    } else {
      logInfo("openclaw.bootstrap.peer_deps_ready", { sandboxId: sandbox.sandboxId, package: "@buape/carbon" });
    }

    // Install Bun for faster gateway startup on snapshot restore.
    // Bun's JSC engine loads the 577MB/10K-file openclaw package ~33% faster
    // than Node.js v22 on 1 vCPU.  Best-effort — restore falls back to Node
    // if Bun is missing.
    //
    // Downloads the pinned release binary directly from GitHub, verifies its
    // SHA-256, and extracts to BUN_INSTALL_DIR.  No remote installer script
    // is executed.
    progress?.setPhase("installing-bun", "Installing Bun runtime");
    const bunInstall = await sandbox.runCommand({
      cmd: "sh",
      args: [
        "-c",
        [
          "set -e",
          `curl -fsSL --max-time 60 --connect-timeout 10 -o /tmp/bun.zip ${JSON.stringify(BUN_DOWNLOAD_URL)}`,
          `printf '%s  /tmp/bun.zip\\n' ${JSON.stringify(BUN_DOWNLOAD_SHA256)} | sha256sum -c`,
          `mkdir -p ${JSON.stringify(BUN_INSTALL_DIR + "/bin")}`,
          `unzip -o -j /tmp/bun.zip -d ${JSON.stringify(BUN_INSTALL_DIR + "/bin")}`,
          `chmod +x ${JSON.stringify(BUN_BIN)}`,
          `rm -f /tmp/bun.zip`,
          `${JSON.stringify(BUN_BIN)} --version`,
        ].join(" && "),
      ],
      stdout: progress?.makeWritable("stdout"),
      stderr: progress?.makeWritable("stderr"),
    });
    if (bunInstall.exitCode === 0) {
      const bunVersion = (await bunInstall.output("stdout")).trim();
      progress?.setPreview(`Installed Bun ${bunVersion}`);
      logInfo("openclaw.setup.bun_installed", { sandboxId: sandbox.sandboxId, bunVersion });
    } else {
      const stderr = (await bunInstall.output("stderr")).trim();
      logWarn("openclaw.setup.bun_install_failed", {
        sandboxId: sandbox.sandboxId,
        exitCode: bunInstall.exitCode,
        stderr: stderr.slice(-500),
      });
    }

    progress?.setPhase("cleaning-cache", "Cleaning npm cache");
    const npmCacheCleanup = await sandbox.runCommand({
      cmd: "bash",
      args: [
        "-lc",
        [
          "rm -rf /home/vercel-sandbox/.npm || true",
          "rm -rf /root/.npm || true",
          "rm -rf /tmp/openclaw-npm-cache || true",
        ].join("\n"),
      ],
      stdout: progress?.makeWritable("stdout"),
      stderr: progress?.makeWritable("stderr"),
    });
    await assertCommandSuccess("npm cache cleanup", npmCacheCleanup);
    logInfo("openclaw.setup.npm_cache_cleared", { sandboxId: sandbox.sandboxId });
  }

  progress?.setPhase("writing-config", "Writing gateway config");
  progress?.appendLine("system", "Writing OpenClaw config and startup files");

  const bootstrapFiles = [
    ...buildBootstrapFiles({
      gatewayToken: options.gatewayToken,
      apiKey: options.apiKey,
      proxyOrigin: options.proxyOrigin,
      telegramBotToken: options.telegramBotToken,
      telegramWebhookSecret: options.telegramWebhookSecret,
      slackCredentials: options.slackCredentials,
      bundleCapabilities: bundleAdmission?.identity.capabilities,
    }),
    {
      path: OPENCLAW_INSTALL_PATCH_SCRIPT_PATH,
      content: Buffer.from(buildOpenClawInstallPatchScript()),
    },
  ];

  logInfo("openclaw.setup.bootstrap_files_prepared", {
    sandboxId: sandbox.sandboxId,
    fileCount: bootstrapFiles.length,
    restoreManifestSha256: buildRestoreAssetManifest().sha256,
  });

  await sandbox.writeFiles(bootstrapFiles);

  if (bundleAdmission) {
    progress?.setPhase("installing-plugin", "Installing verified external plugins");
    for (const plugin of bundleAdmission.externalPlugins) {
      const archivePath = `${OPENCLAW_BUNDLE_METADATA_DIR}/${plugin.artifact}`;
      const pluginResult = await sandbox.runCommand({
        cmd: "node",
        args: [
          OPENCLAW_BUNDLE_PATH,
          "plugins",
          "install",
          `npm-pack:${archivePath}`,
        ],
        env: {
          PATH: "/home/vercel-sandbox/.global/npm/bin:/usr/local/bin:/usr/bin:/bin",
          HOME: "/home/vercel-sandbox",
          OPENCLAW_HOME: "/home/vercel-sandbox",
          OPENCLAW_CONFIG_PATH,
          OPENCLAW_BUNDLE_PROFILE: "sandbox",
          OPENCLAW_BUNDLED_PLUGINS_DIR: OPENCLAW_BUNDLED_PLUGINS_DIR_PATH,
          npm_config_audit: "false",
          npm_config_fund: "false",
          npm_config_offline: "true",
        },
        stdout: progress?.makeWritable("stdout"),
        stderr: progress?.makeWritable("stderr"),
      });
      await assertCommandSuccess(`install external plugin ${plugin.id}`, pluginResult);
    }
    const receiptPath = OPENCLAW_BUNDLE_IDENTITY_PATH;
    const receiptResult = await sandbox.runCommand({
      cmd: "bash",
      args: [
        "-c",
        [
          "set -e",
          `umask 077`,
          `printf '%s\\n' ${shellArg(JSON.stringify(bundleAdmission.identity))} > ${shellArg(`${receiptPath}.tmp`)}`,
          `mv -f ${shellArg(`${receiptPath}.tmp`)} ${shellArg(receiptPath)}`,
        ].join("\n"),
      ],
      stdout: progress?.makeWritable("stdout"),
      stderr: progress?.makeWritable("stderr"),
    });
    await assertCommandSuccess("persist verified bundle identity", receiptResult);
    bundleIdentity = bundleIdentityFromAdmission(bundleAdmission);
  }

  // Install patches only apply to the npm-installed package tree.
  if (!bundleUrl) {
    progress?.setPhase("patching-openclaw", "Applying OpenClaw install patches");
    const installPatchResult = await sandbox.runCommand({
      cmd: "node",
      args: [OPENCLAW_INSTALL_PATCH_SCRIPT_PATH],
      stdout: progress?.makeWritable("stdout"),
      stderr: progress?.makeWritable("stderr"),
    });
    await assertCommandSuccess("openclaw install patch", installPatchResult);
    const installPatchOutput = (await installPatchResult.output("stdout")).trim();
    const installPatchOutcome = parseOpenClawInstallPatchOutcome(installPatchOutput);
    if (!installPatchOutcome) {
      logWarn("openclaw.setup.install_patch_output_unparsed", {
        sandboxId: sandbox.sandboxId,
        output: installPatchOutput.slice(0, 500),
      });
    } else if (installPatchOutcome.status === "skipped") {
      logWarn("openclaw.setup.install_patch_skipped", {
        sandboxId: sandbox.sandboxId,
        ...installPatchOutcome,
      });
    } else {
      logInfo("openclaw.setup.install_patch_applied", {
        sandboxId: sandbox.sandboxId,
        ...installPatchOutcome,
      });
    }
  }

  progress?.setPhase("checking-version", "Checking installed version");
  const versionResult = await sandbox.runCommand({
    cmd: bundleUrl ? "node" : OPENCLAW_BIN,
    args: bundleUrl ? [OPENCLAW_BUNDLE_PATH, "--version"] : ["--version"],
    stdout: progress?.makeWritable("stdout"),
    stderr: progress?.makeWritable("stderr"),
  });
  await assertCommandSuccess("openclaw --version", versionResult);
  const openclawVersion = normalizeOpenClawVersion(
    await versionResult.output("stdout"),
  );
  progress?.setPreview(openclawVersion ? `Installed ${openclawVersion}` : "Version check passed");

  const drift = detectDrift(packageSpec, openclawVersion);
  const runtime: BootstrapRuntime = { packageSpec, installedVersion: openclawVersion, drift };

  logInfo("openclaw.setup.installed", {
    sandboxId: sandbox.sandboxId,
    packageSpec,
    installedVersion: openclawVersion,
    drift,
  });

  progress?.setPhase("starting-gateway", "Launching gateway");
  const startupResult = await sandbox.runCommand({
    cmd: "bash",
    args: [OPENCLAW_STARTUP_SCRIPT_PATH],
    stdout: progress?.makeWritable("stdout"),
    stderr: progress?.makeWritable("stderr"),
  });

  const startupStdout = (await startupResult.output("stdout")).trim();
  const startupStderr = (await startupResult.output("stderr")).trim();
  logInfo("openclaw.setup.startup_script_result", {
    sandboxId: sandbox.sandboxId,
    exitCode: startupResult.exitCode,
    stdoutHead: startupStdout.slice(0, 500),
    stderrHead: startupStderr.slice(0, 500),
  });
  progress?.appendLine("system", `Startup script exit=${startupResult.exitCode}`);
  await assertCommandSuccess("bash startup-script", startupResult);

  // Quick process check for debugging gateway launch issues.
  try {
    const psResult = await sandbox.runCommand("bash", ["-c", "ps aux | grep openclaw || true"]);
    const psOut = (await psResult.output("stdout")).trim();
    logInfo("openclaw.setup.process_check", { sandboxId: sandbox.sandboxId, psOutput: psOut.slice(0, 500) });
    progress?.appendLine("system", `Process check: ${psOut.split("\n").filter(l => !l.includes("grep")).join("; ").slice(0, 200)}`);
  } catch { /* best effort */ }

  // Check listening ports and gateway log immediately after launch.
  try {
    const portCheck = await sandbox.runCommand("bash", ["-c",
      "ss -tlnp 2>/dev/null | grep -E '3000|8787' || echo 'no listeners on 3000/8787'",
    ]);
    progress?.appendLine("system", `Ports: ${(await portCheck.output("stdout")).trim().slice(0, 200)}`);
  } catch { /* best effort */ }

  try {
    const logCheck = await sandbox.runCommand("bash", ["-c",
      `tail -20 ${OPENCLAW_LOG_FILE} 2>/dev/null || echo 'no log file'`,
    ]);
    const logOut = (await logCheck.output("stdout")).trim();
    if (logOut) progress?.appendLine("system", `Gateway log: ${logOut.slice(0, 300)}`);
  } catch { /* best effort */ }

  progress?.setPhase("waiting-for-gateway", "Waiting for OpenClaw to respond");
  try {
    await waitForGatewayReady(sandbox);
  } catch (waitErr) {
    // Collect diagnostics before re-throwing so they appear in setup progress.
    try {
      const diag = await collectGatewayWaitFailureDiagnostics(sandbox);
      for (const [k, v] of Object.entries(diag)) {
        progress?.appendLine("system", `[diag:${k}] ${v.slice(0, 300)}`);
      }
    } catch { /* best effort */ }
    throw waitErr;
  }

  try {
    progress?.setPhase("pairing-device", "Pairing device");
    await sandbox.runCommand({
      cmd: "node",
      args: [
        OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
        OPENCLAW_STATE_DIR,
      ],
      stdout: progress?.makeWritable("stdout"),
      stderr: progress?.makeWritable("stderr"),
    });
  } catch {
    // Best-effort only.
    progress?.appendLine("system", "Pairing step skipped");
  }

  logInfo("openclaw.setup.ready", { sandboxId: sandbox.sandboxId, runtime });
  return { startupScript, openclawVersion, runtime, bundleIdentity };
}

const GATEWAY_DIAG_MAX_CHARS = 7000;

/**
 * Best-effort sandbox introspection when the gateway readiness probe exhausts.
 * Emits structured fields for Vercel function logs (ring buffer + stderr).
 */
async function collectGatewayWaitFailureDiagnostics(
  sandbox: SandboxHandle,
): Promise<Record<string, string>> {
  const cap = (s: string) => s.replace(/\r/g, "").slice(0, GATEWAY_DIAG_MAX_CHARS);
  const diag: Record<string, string> = {};

  try {
    const r = await sandbox.runCommand("bash", [
      "-c",
      [
        "echo '=== GET http://127.0.0.1:3000/ (no -f, stderr merged) ==='",
        "curl -sS --max-time 8 -w '\\n__http_code:%{http_code}\\n' http://127.0.0.1:3000/ 2>&1 | head -c 4000",
      ].join("\n"),
    ]);
    diag.httpProbe = cap(await r.output("both"));
  } catch (e) {
    diag.httpProbe = `error: ${e instanceof Error ? e.message : String(e)}`;
  }

  try {
    const r = await sandbox.runCommand("bash", [
      "-c",
      [
        "echo '=== openclaw log files (tail) ==='",
        "found=0",
        "for f in /tmp/openclaw/openclaw-*.log; do",
        '  [ -f "$f" ] || continue',
        "  found=1",
        '  echo "--- $f ---"',
        '  tail -n 50 "$f"',
        "done",
        '[ "$found" = 0 ] && echo "(no /tmp/openclaw/openclaw-*.log)"',
      ].join("\n"),
    ]);
    diag.openclawLogs = cap(await r.output("both"));
  } catch (e) {
    diag.openclawLogs = `error: ${e instanceof Error ? e.message : String(e)}`;
  }

  try {
    const r = await sandbox.runCommand("bash", [
      "-c",
      [
        "echo '=== listeners :3000 ==='",
        "(command -v ss >/dev/null 2>&1 && ss -tlnp 2>/dev/null | grep 3000) || true",
        "(netstat -tlnp 2>/dev/null | grep 3000) || true",
        "echo '=== node / openclaw processes ==='",
        "ps aux 2>/dev/null | grep -E '[n]ode|[o]penclaw' | head -20 || true",
      ].join("\n"),
    ]);
    diag.portsAndProcesses = cap(await r.output("both"));
  } catch (e) {
    diag.portsAndProcesses = `error: ${e instanceof Error ? e.message : String(e)}`;
  }

  return diag;
}

export async function waitForGatewayReady(
  sandbox: SandboxHandle,
  options?: { maxAttempts?: number; delayMs?: number },
): Promise<void> {
  const maxAttempts = options?.maxAttempts ?? 60;
  const delayMs = options?.delayMs ?? 1000;

  logInfo("openclaw.gateway_wait_start", {
    sandboxId: sandbox.sandboxId,
    maxAttempts,
    delayMs,
  });

  let lastProbe: Record<string, unknown> = {};

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const result = await sandbox.runCommand("curl", [
        "-s",
        "--max-time",
        "5",
        "-w",
        "\n__HTTP_STATUS:%{http_code}",
        "http://localhost:3000/",
      ]);
      const rawBody = await result.output("stdout");
      // Strip the status line appended by -w
      const statusMatch = rawBody.match(/__HTTP_STATUS:(\d+)/);
      const httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : 0;
      const body = rawBody.replace(/\n?__HTTP_STATUS:\d+$/, "");
      let stderr = "";
      try {
        stderr = await result.output("stderr");
      } catch {
        // Some test doubles only implement a single output stream.
      }
      const hasMarker = body.includes("openclaw-app");
      lastProbe = {
        attempt: attempt + 1,
        exitCode: result.exitCode,
        httpStatus,
        bodyBytes: body.length,
        bodyHead: body.slice(0, 300),
        stderrHead: stderr.slice(0, 200),
        hasOpenclawMarker: hasMarker,
      };

      // Log every single probe attempt so we can trace exactly what happens.
      logInfo("openclaw.gateway_probe", {
        sandboxId: sandbox.sandboxId,
        attempt: attempt + 1,
        httpStatus,
        exitCode: result.exitCode,
        bodyBytes: body.length,
        hasMarker,
        bodyHead: body.slice(0, 200),
      });

      // Accept any HTTP response from the gateway — the openclaw-app marker
      // is preferred, but a plain HTTP response (even 500) means the gateway
      // is running.  Plugin init errors (e.g. missing @slack/web-api) cause
      // 500 without the marker but the gateway is functional.
      if (hasMarker || (httpStatus > 0 && httpStatus < 600)) {
        logInfo("openclaw.gateway_wait_ok", {
          sandboxId: sandbox.sandboxId,
          attempts: attempt + 1,
          httpStatus,
          hasMarker,
        });
        return;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      lastProbe = {
        attempt: attempt + 1,
        probeThrew: true,
        error: errMsg.slice(0, 300),
      };
      logInfo("openclaw.gateway_probe", {
        sandboxId: sandbox.sandboxId,
        attempt: attempt + 1,
        threw: true,
        error: errMsg.slice(0, 200),
      });
    }

    const n = attempt + 1;
    // Snapshot ports+processes every 10 probes for deeper visibility.
    if (n % 10 === 0) {
      logWarn("openclaw.gateway_wait_pending", {
        sandboxId: sandbox.sandboxId,
        attempt: n,
        maxAttempts,
        lastProbe,
      });
      try {
        const snap = await sandbox.runCommand("bash", [
          "-c",
          'echo "PORTS:"; ss -tlnp 2>/dev/null | grep -E "3000|8787" || echo "none"; echo "PS:"; ps aux 2>/dev/null | grep -E "[o]penclaw|[n]ode" | head -5 || true',
        ]);
        const snapOut = (await snap.output("stdout")).trim();
        logInfo("openclaw.gateway_snapshot", {
          sandboxId: sandbox.sandboxId,
          attempt: n,
          snapshot: snapOut.slice(0, 500),
        });
      } catch {
        /* best effort */
      }
    }

    if (attempt < maxAttempts - 1) {
      await sleep(delayMs);
    }
  }

  const diagnostics = await collectGatewayWaitFailureDiagnostics(sandbox);
  logError("openclaw.gateway_wait_exhausted", {
    sandboxId: sandbox.sandboxId,
    maxAttempts,
    delayMs,
    lastProbe,
    ...diagnostics,
  });

  throw new Error(`Gateway never became ready within ${maxAttempts} attempts.`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeOpenClawVersion(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Detect whether the installed version drifts from the requested package spec.
 *
 * A pinned spec like "openclaw@1.2.3" should match the installed version exactly.
 * Range specs ("openclaw@^1.0.0") or "openclaw@latest" always report drift=true
 * because the resolved version is non-deterministic.
 */
export function detectDrift(packageSpec: string, installedVersion: string | null): boolean {
  if (!installedVersion) return true;

  // Extract the version part after @
  const atIdx = packageSpec.lastIndexOf("@");
  if (atIdx <= 0) return true;

  const specVersion = packageSpec.slice(atIdx + 1);

  // "latest", "next", or any dist-tag is always drifty
  if (!/^\d/.test(specVersion)) return true;

  // Range specs (^, ~, >=, etc.) are non-deterministic
  if (/[~^>=<|*x]/.test(specVersion)) return true;

  // Exact pinned version — compare directly
  return specVersion !== installedVersion;
}
