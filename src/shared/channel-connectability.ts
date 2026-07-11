import type { ChannelMode, ChannelName } from "@/shared/channels";
import type { DeploymentRequirementId } from "@/shared/deployment-requirements";

export type ChannelConnectabilityStatus = "pass" | "warn" | "fail";

/**
 * Channel-only issue IDs that do not originate from the deployment contract.
 * Keep this set small — most blocking logic should live in the contract.
 */
export type ChannelOnlyIssueId =
  | "public-webhook-url"
  | "launch-verification"
  | "deployment-protection-active"
  | "hosted-transport-unavailable";

type LegacyChannelConnectabilityIssueId = "running-only";

/**
 * Union of deployment-contract requirement IDs and channel-specific IDs.
 * Derived from DeploymentRequirementId so adding a new contract requirement
 * automatically makes it available here — no manual sync needed.
 */
export type ChannelConnectabilityIssueId =
  | DeploymentRequirementId
  | ChannelOnlyIssueId
  | LegacyChannelConnectabilityIssueId;

export type ChannelConnectabilityIssue = {
  id: ChannelConnectabilityIssueId;
  status: ChannelConnectabilityStatus;
  message: string;
  remediation: string;
  env: string[];
};

export type ChannelConnectability = {
  channel: ChannelName;
  mode: ChannelMode;
  canConnect: boolean;
  status: ChannelConnectabilityStatus;
  webhookUrl: string | null;
  issues: ChannelConnectabilityIssue[];
};
