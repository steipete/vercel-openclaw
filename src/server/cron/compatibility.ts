export const CRON_PROJECTION_CAPABILITY = "cron-projection-v1";

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
      identity.capabilities.includes(CRON_PROJECTION_CAPABILITY),
  );
}
