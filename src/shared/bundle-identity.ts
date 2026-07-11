export type VerifiedBundleIdentity = {
  packageSpec: string;
  version: string;
  forkSha: string;
  upstreamSha: string;
  canonicalSha256: string;
  capabilities: string[];
  verified: true;
};

const EXACT_PACKAGE_SPEC_RE =
  /^openclaw@(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?)$/;
const GIT_SHA_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const VERIFIED_BUNDLE_IDENTITY_KEYS = [
  "canonicalSha256",
  "capabilities",
  "forkSha",
  "packageSpec",
  "upstreamSha",
  "verified",
  "version",
] as const;

function isSortedUniqueStrings(value: unknown): value is string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    return false;
  }
  const sorted = [...value].sort((left, right) => left.localeCompare(right));
  return (
    new Set(value).size === value.length &&
    sorted.every((entry, index) => entry === value[index])
  );
}

export function isVerifiedBundleIdentity(
  value: unknown,
): value is VerifiedBundleIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const identity = value as Record<string, unknown>;
  const keys = Object.keys(identity).sort((left, right) => left.localeCompare(right));
  if (
    keys.length !== VERIFIED_BUNDLE_IDENTITY_KEYS.length ||
    keys.some((key, index) => key !== VERIFIED_BUNDLE_IDENTITY_KEYS[index])
  ) {
    return false;
  }
  const packageVersion =
    typeof identity.packageSpec === "string"
      ? EXACT_PACKAGE_SPEC_RE.exec(identity.packageSpec)?.[1]
      : undefined;
  return (
    packageVersion !== undefined &&
    identity.version === packageVersion &&
    typeof identity.forkSha === "string" &&
    GIT_SHA_RE.test(identity.forkSha) &&
    typeof identity.upstreamSha === "string" &&
    GIT_SHA_RE.test(identity.upstreamSha) &&
    typeof identity.canonicalSha256 === "string" &&
    SHA256_RE.test(identity.canonicalSha256) &&
    isSortedUniqueStrings(identity.capabilities) &&
    identity.verified === true
  );
}
