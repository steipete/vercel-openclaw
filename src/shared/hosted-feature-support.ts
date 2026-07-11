export type HostedFeatureSupportStatus =
  | "supported"
  | "experimental"
  | "bundled-only"
  | "upstream-only"
  | "not-supported";

export type HostedFeatureSupportArea =
  | "channels"
  | "webchat"
  | "devices"
  | "voice-canvas"
  | "plugins-skills"
  | "mcp-tools"
  | "automation"
  | "models";

export type HostedFeatureSupportEntry = {
  id: string;
  area: HostedFeatureSupportArea;
  feature: string;
  userExpectation: string;
  upstreamEvidence: string;
  hostedStatus: HostedFeatureSupportStatus;
  owningRepo: "vercel-openclaw" | "vclaw" | "vercel-labs/openclaw";
  verificationSignal: string;
  nextAction: string;
  alternativePath: string | null;
};

export type HostedFeatureSupportMatrix = {
  schemaVersion: 1;
  docsPath: string;
  generatedFrom: "src/shared/hosted-feature-support.ts";
  entries: HostedFeatureSupportEntry[];
};

export const HOSTED_FEATURE_SUPPORT_DOCS_PATH =
  "docs/getting-started/hosted-feature-support.md" as const;

export const HOSTED_FEATURE_SUPPORT_ENTRIES = [
  {
    id: "channel-slack",
    area: "channels",
    feature: "Slack",
    userExpectation: "Connect Slack and receive replies after wake-from-sleep.",
    upstreamEvidence: "OpenClaw includes Slack channel support.",
    hostedStatus: "supported",
    owningRepo: "vercel-openclaw",
    verificationSignal: "OAuth or manual credentials, /slack/events route readiness, lastForward accepted, and user-visible reply observation.",
    nextAction: "Keep setup, readiness, wake forwarding, and user-visible reply checks green.",
    alternativePath: null,
  },
  {
    id: "channel-telegram",
    area: "channels",
    feature: "Telegram",
    userExpectation: "Connect a Telegram bot and receive replies after wake-from-sleep.",
    upstreamEvidence: "OpenClaw includes Telegram channel support.",
    hostedStatus: "supported",
    owningRepo: "vercel-openclaw",
    verificationSignal: "Bot token validation, registered webhook, verified bundle capability telegram-durable-ack-v1, port 8787 listener, lastForward accepted, and user-visible reply observation.",
    nextAction: "Keep bundle identity, webhook secret flow, native listener readiness, and wake forwarding verified.",
    alternativePath: null,
  },
  {
    id: "channel-discord",
    area: "channels",
    feature: "Discord",
    userExpectation: "Connect Discord interactions and receive final replies.",
    upstreamEvidence:
      "OpenClaw's Discord integration requires a persistent Bot Gateway client; it does not expose a hosted HTTP interaction handler.",
    hostedStatus: "not-supported",
    owningRepo: "vercel-openclaw",
    verificationSignal:
      "Hosted setup and delivery remain fail-closed until a supported persistent Gateway transport exists.",
    nextAction:
      "Do not accept hosted Discord setup or defer interactions to a nonexistent native HTTP route.",
    alternativePath: "Use local/upstream OpenClaw Discord Gateway support.",
  },
  {
    id: "channel-whatsapp",
    area: "channels",
    feature: "WhatsApp",
    userExpectation: "Connect WhatsApp and receive replies through the hosted deployment.",
    upstreamEvidence: "OpenClaw includes WhatsApp channel support.",
    hostedStatus: "not-supported",
    owningRepo: "vercel-openclaw",
    verificationSignal: "No hosted transport contract bridges Meta Cloud API webhooks to OpenClaw's linked-device WhatsApp runtime.",
    nextAction: "Keep hosted setup disabled until one transport architecture is implemented and verified end to end.",
    alternativePath: "Use local/upstream OpenClaw linked-device WhatsApp support.",
  },
  {
    id: "channels-upstream-rest",
    area: "channels",
    feature: "Other upstream channels",
    userExpectation: "Connect channels such as iMessage, LINE, Matrix, Teams, Signal, Twitch, WeChat, or Zalo.",
    upstreamEvidence: "Upstream docs list many channel adapters beyond Slack, Telegram, Discord, and WhatsApp.",
    hostedStatus: "upstream-only",
    owningRepo: "vercel-labs/openclaw",
    verificationSignal: "No hosted credential storage, webhook route, wake forwarding, lastForward, or user-visible reply contract exists for these channels.",
    nextAction: "Add one hosted vertical slice at a time before presenting a channel as available.",
    alternativePath: "Run local/upstream OpenClaw and configure the channel in that runtime.",
  },
  {
    id: "webchat-gateway",
    area: "webchat",
    feature: "Hosted WebChat through /gateway",
    userExpectation: "Open the hosted OpenClaw UI and chat through the proxied gateway.",
    upstreamEvidence: "OpenClaw exposes a web UI and gateway routes.",
    hostedStatus: "supported",
    owningRepo: "vercel-openclaw",
    verificationSignal: "Authenticated /gateway proxy, HTML injection, WebSocket rewrite, heartbeat, and launch verification chatCompletions.",
    nextAction: "Keep gateway auth, token handoff, and launch verification aligned.",
    alternativePath: null,
  },
  {
    id: "companion-devices",
    area: "devices",
    feature: "macOS, iOS, Android companion nodes",
    userExpectation: "Pair hosted OpenClaw with local or mobile companion nodes.",
    upstreamEvidence: "Upstream docs describe companion nodes and Gateway WebSocket pairing.",
    hostedStatus: "upstream-only",
    owningRepo: "vercel-labs/openclaw",
    verificationSignal: "The hosted wrapper has no verified secure node discovery, pairing auth, persistence, or launch-verification contract for companion nodes.",
    nextAction: "Do not advertise hosted companion-device support until pairing, auth, proxying, persistence, and verification exist.",
    alternativePath: "Use local/upstream OpenClaw for companion-node workflows.",
  },
  {
    id: "voice-canvas",
    area: "voice-canvas",
    feature: "Voice, voice wake, and canvas",
    userExpectation: "Use hosted voice/audio routing and the macOS Canvas panel.",
    upstreamEvidence: "Upstream docs describe voice wake, talk behavior, and canvas surfaces.",
    hostedStatus: "upstream-only",
    owningRepo: "vercel-labs/openclaw",
    verificationSignal: "The hosted wrapper has no verified audio route, device permission model, canvas persistence, or smoke test.",
    nextAction: "Keep these out of hosted-ready copy until one capability is implemented and verified end to end.",
    alternativePath: "Use local/upstream OpenClaw for voice and canvas features.",
  },
  {
    id: "plugins-skills-bundled",
    area: "plugins-skills",
    feature: "Plugins, skills, and ClawHub content",
    userExpectation: "Install, update, verify, remove, and recover arbitrary plugins and skills from the hosted admin UI.",
    upstreamEvidence: "Upstream docs describe npm plugins, local extension loading, ClawHub skills, and migrations.",
    hostedStatus: "bundled-only",
    owningRepo: "vercel-labs/openclaw",
    verificationSignal: "The hosted sandbox verifies only the plugins, skills, sidecars, and runtime assets shipped in the pinned OpenClaw bundle.",
    nextAction: "Define persistence, restore, compatibility checks, rollback, and launch verification before offering install/update UI.",
    alternativePath: "Use local/upstream OpenClaw for arbitrary plugin and skill installation.",
  },
  {
    id: "mcp-browser-tools",
    area: "mcp-tools",
    feature: "MCP, browser tools, and runtime tools",
    userExpectation: "Configure arbitrary MCP bridges and browser/tool integrations in the hosted sandbox.",
    upstreamEvidence: "Upstream docs mention MCP via mcporter and tool integrations.",
    hostedStatus: "bundled-only",
    owningRepo: "vercel-labs/openclaw",
    verificationSignal: "Hosted verification covers only the tool surface included in the pinned bundle plus wrapper firewall/network policy behavior.",
    nextAction: "Add an explicit compatibility and firewall contract before exposing arbitrary hosted MCP/tool setup.",
    alternativePath: "Use local/upstream OpenClaw for custom MCP and tool configuration.",
  },
  {
    id: "cron-scheduled-jobs",
    area: "automation",
    feature: "Cron and scheduled jobs",
    userExpectation: "Persist scheduled OpenClaw jobs across sandbox sleep and restore.",
    upstreamEvidence: "OpenClaw can schedule jobs inside its runtime.",
    hostedStatus: "experimental",
    owningRepo: "vercel-openclaw",
    verificationSignal: "Sanitized bounded earliest-wake snapshot, Redis CAS dispatch, token-revalidating Workflow, and watchdog anti-entropy tests.",
    nextAction: "Require an exact verified cron-projection-v1 bundle, then prove schedule, reschedule, delete, sleep, and wake end to end.",
    alternativePath: null,
  },
  {
    id: "model-provider-gateway",
    area: "models",
    feature: "Model/provider access through Vercel AI Gateway",
    userExpectation: "Use the hosted deployment with the configured model provider without leaking provider tokens into the sandbox.",
    upstreamEvidence: "OpenClaw supports model/provider configuration.",
    hostedStatus: "supported",
    owningRepo: "vercel-openclaw",
    verificationSignal: "Preflight, launch verification chatCompletions, OPENAI_BASE_URL in sandbox, and AI Gateway transform rules in networkPolicy.",
    nextAction: "Keep token refresh and firewall policy verification green.",
    alternativePath: null,
  },
] as const satisfies readonly HostedFeatureSupportEntry[];

export const HOSTED_FEATURE_SUPPORT_MATRIX: HostedFeatureSupportMatrix = {
  schemaVersion: 1,
  docsPath: HOSTED_FEATURE_SUPPORT_DOCS_PATH,
  generatedFrom: "src/shared/hosted-feature-support.ts",
  entries: [...HOSTED_FEATURE_SUPPORT_ENTRIES],
};

export function getHostedFeatureSupportMatrix(): HostedFeatureSupportMatrix {
  return HOSTED_FEATURE_SUPPORT_MATRIX;
}
