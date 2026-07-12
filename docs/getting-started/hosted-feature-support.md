# Hosted Feature Support Matrix

This page is the operator-facing source of truth for what the Vercel-hosted OpenClaw path supports today. The machine-readable version is `src/shared/hosted-feature-support.ts` and is exposed in `/api/status`, `/api/channels/summary`, and `/api/admin/launch-verify` as `featureSupport`.

The hosted deployment must not claim support merely because upstream OpenClaw has docs or local runtime code for a feature. A feature is hosted-supported only when this wrapper has setup, persistence, proxying or wake behavior, readiness state, and verification signals for that path.

## Status meanings

| Status | Meaning |
| --- | --- |
| `supported` | The hosted wrapper owns setup or operation and has a verification signal. |
| `experimental` | The hosted wrapper has code paths, but real platform delivery and user-visible replies are not yet strong enough to call generally supported. |
| `bundled-only` | The hosted wrapper supports only what ships in the pinned OpenClaw bundle. Arbitrary install/update/remove is not a hosted contract. |
| `upstream-only` | The feature belongs to local/upstream OpenClaw and is not a verified hosted Vercel path. |
| `not-supported` | The hosted wrapper explicitly does not support the feature. |

## Matrix

| Feature area | User expectation | Upstream evidence | Hosted status | Owning repo | Verification signal | Next action |
| --- | --- | --- | --- | --- | --- | --- |
| Slack | Connect Slack and receive replies after wake-from-sleep. | OpenClaw includes Slack channel support. | `supported` | `vercel-openclaw` | OAuth or manual credentials, `/slack/events` route readiness, `lastForward` accepted, and user-visible reply observation. | Keep setup, readiness, wake forwarding, and user-visible reply checks green. |
| Telegram | Connect a Telegram bot and receive replies after wake-from-sleep. | OpenClaw includes Telegram channel support. | `supported` | `vercel-openclaw` | Bot token validation, registered webhook, verified bundle capability `telegram-durable-ack-v1`, port 8787 listener, `lastForward` accepted, and user-visible reply observation. | Keep bundle identity, webhook secret flow, native listener readiness, and wake forwarding verified. |
| Discord | Connect Discord interactions and receive final replies. | OpenClaw requires a persistent Discord Bot Gateway client. | `not-supported` | `vercel-openclaw` | Setup and delivery fail closed; legacy endpoint cleanup remains retryable. | Use local/upstream OpenClaw's Discord Gateway transport. |
| WhatsApp | Connect WhatsApp and receive replies through the hosted deployment. | OpenClaw includes WhatsApp channel support. | `not-supported` | `vercel-openclaw` | No hosted transport contract bridges Meta Cloud API webhooks to OpenClaw's linked-device WhatsApp runtime. | Keep hosted setup disabled until one transport architecture is implemented and verified end to end. |
| Other upstream channels | Connect channels such as iMessage, LINE, Matrix, Teams, Signal, Twitch, WeChat, or Zalo. | Upstream docs list many channel adapters beyond Slack, Telegram, Discord, and WhatsApp. | `upstream-only` | `vercel-labs/openclaw` | No hosted credential storage, webhook route, wake forwarding, `lastForward`, or user-visible reply contract exists for these channels. | Add one hosted vertical slice at a time before presenting a channel as available. |
| Hosted WebChat through `/gateway` | Open the hosted OpenClaw UI and chat through the proxied gateway. | OpenClaw exposes a web UI and gateway routes. | `supported` | `vercel-openclaw` | Authenticated `/gateway` proxy, HTML injection, WebSocket rewrite, heartbeat, and launch verification chat completions. | Keep gateway auth, token handoff, and launch verification aligned. |
| Companion apps and devices | Pair hosted OpenClaw with macOS, iOS, Android, or local companion nodes. | Upstream docs describe companion nodes and Gateway WebSocket pairing. | `upstream-only` | `vercel-labs/openclaw` | No verified secure node discovery, pairing auth, persistence, or launch-verification contract exists in the hosted wrapper. | Use local/upstream OpenClaw until pairing, auth, proxying, persistence, and verification exist for the hosted path. |
| Voice and canvas | Use hosted voice/audio routing and the macOS Canvas panel. | Upstream docs describe voice wake, talk behavior, and canvas surfaces. | `upstream-only` | `vercel-labs/openclaw` | No verified audio route, device permission model, canvas persistence, or smoke test exists in the hosted wrapper. | Keep these out of hosted-ready copy until one capability is implemented and verified end to end. |
| Plugins, skills, and ClawHub content | Install, update, verify, remove, and recover arbitrary plugins and skills from the hosted admin UI. | Upstream docs describe npm plugins, local extension loading, ClawHub skills, and migrations. | `bundled-only` | `vercel-labs/openclaw` | Hosted verification covers only plugins, skills, sidecars, and runtime assets shipped in the pinned OpenClaw bundle. | Define persistence, restore, compatibility checks, rollback, and launch verification before offering install/update UI. |
| MCP, browser tools, and runtime tools | Configure arbitrary MCP bridges and browser/tool integrations in the hosted sandbox. | Upstream docs mention MCP via `mcporter` and tool integrations. | `bundled-only` | `vercel-labs/openclaw` | Hosted verification covers only the tool surface included in the pinned bundle plus wrapper firewall/network policy behavior. | Add a compatibility and firewall contract before exposing arbitrary hosted MCP/tool setup. |
| Cron and scheduled jobs | Wake a sleeping sandbox for scheduled OpenClaw jobs without copying job definitions into the host. | OpenClaw can schedule jobs and exposes reconciled/changed plugin hooks. | `experimental` | `vercel-openclaw` | Bounded earliest-wake hook projection (up to 4,096), sanitized Redis CAS state, token-revalidating Workflow, stale-workflow no-op, and watchdog anti-entropy tests. | Require an exact verified bundle declaring `cron-projection-v1`, then verify schedule, reschedule, delete, sleep, and wake end to end before marking supported. |
| Model/provider access | Use the hosted deployment with the configured model provider without leaking provider tokens into the sandbox. | OpenClaw supports model/provider configuration. | `supported` | `vercel-openclaw` | Preflight, launch verification chat completions, `OPENAI_BASE_URL` in sandbox, and AI Gateway transform rules in network policy. | Keep token refresh and firewall policy verification green. |

## Hosted channel rule

Do not add a hosted channel claim without all of these pieces: credential storage, platform webhook verification, a route or native handler contract, wake forwarding, `lastForward` recording, readiness summary, and real platform delivery proof with user-visible reply evidence.

Slack and Telegram are the hosted channels. Discord and WhatsApp are disabled; use local/upstream OpenClaw's persistent channel transports.

## Companion-device boundary

The hosted `/gateway` path is for the authenticated OpenClaw web UI. It rewrites WebSockets and handles gateway-token handoff for that UI, but it is not currently a supported remote companion-node pairing service. Companion nodes, mobile pairing, voice wake, talk behavior, and canvas remain local/upstream OpenClaw capabilities until the hosted wrapper implements pairing auth, secure discovery, proxying, persistence, and verification.

## Plugin and skill lifecycle boundary

The hosted sandbox supports the pinned OpenClaw bundle and its shipped sidecars. It does not currently provide an arbitrary plugin or skill install/update/remove lifecycle. Do not add install buttons or setup claims until the hosted path defines compatibility checks, durable persistence, restore behavior, rollback, firewall policy impact, and launch-verification coverage.
