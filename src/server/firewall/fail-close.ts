const FIREWALL_FAIL_CLOSED_REASON_PREFIX = "firewall-policy-apply-failed:";

export type FirewallPolicyRevision = {
  revisionId: string;
  policyHash: string;
};

export function firewallFailClosedReason(
  revision: FirewallPolicyRevision,
): string {
  return `${FIREWALL_FAIL_CLOSED_REASON_PREFIX}${revision.revisionId}:${revision.policyHash}`;
}

export function parseFirewallFailClosedReason(
  reason: string,
): FirewallPolicyRevision | null {
  if (!reason.startsWith(FIREWALL_FAIL_CLOSED_REASON_PREFIX)) return null;
  const payload = reason.slice(FIREWALL_FAIL_CLOSED_REASON_PREFIX.length);
  const separator = payload.indexOf(":");
  if (separator <= 0) return null;
  const revisionId = payload.slice(0, separator);
  const policyHash = payload.slice(separator + 1);
  if (!revisionId || !/^[a-f0-9]{64}$/.test(policyHash)) return null;
  return { revisionId, policyHash };
}
