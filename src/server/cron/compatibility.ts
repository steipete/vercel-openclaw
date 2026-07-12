export const CRON_PROJECTION_V1_CAPABILITY = "cron-projection-v1";
export const CRON_PROJECTION_V2_CAPABILITY = "cron-projection-v2";

export type CronProjectionBaselineMode =
  | "gateway-start"
  | "cron-reconciled";

export type CronProjectionBundleIdentity = {
  packageSpec: string;
  version: string;
  forkSha: string;
  upstreamSha: string;
  canonicalSha256: string;
  capabilities: readonly string[];
  verified: boolean;
};

function isExactOpenclawPackageSpec(spec: string, version: string): boolean {
  if (!/^\d{4}\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return false;
  return spec === `openclaw@${version}`;
}

export function getCronProjectionBaselineMode(
  capabilities: readonly string[],
): CronProjectionBaselineMode | null {
  // Upgrade releases may carry both capabilities. Prefer v2 so a reconciled
  // bundle never also installs the legacy gateway-start baseline.
  if (capabilities.includes(CRON_PROJECTION_V2_CAPABILITY)) {
    return "cron-reconciled";
  }
  if (capabilities.includes(CRON_PROJECTION_V1_CAPABILITY)) {
    return "gateway-start";
  }
  return null;
}

export function supportsCronProjectionBundleIdentity(
  identity: CronProjectionBundleIdentity | null,
  configuredPackageSpec?: string | null,
): boolean {
  return Boolean(
    identity?.verified === true &&
      (!configuredPackageSpec || identity.packageSpec === configuredPackageSpec) &&
      isExactOpenclawPackageSpec(identity.packageSpec, identity.version) &&
      /^[a-f0-9]{40}$/.test(identity.forkSha) &&
      /^[a-f0-9]{40}$/.test(identity.upstreamSha) &&
      /^[a-f0-9]{64}$/.test(identity.canonicalSha256) &&
      getCronProjectionBaselineMode(identity.capabilities) !== null,
  );
}
