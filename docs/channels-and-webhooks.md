# Channels and Webhooks

## What this doc covers

This guide explains how to connect Slack and Telegram to your OpenClaw deployment. Hosted Discord and WhatsApp are disabled because their upstream persistent transports do not match the wrapper's HTTP webhook model.

Channels are a first-class part of the product. They depend on durable state (Redis), a working sandbox lifecycle, and a verified deployment. This guide walks through the full path from "deployment exists" to "channel is safely connected and working."

For the complete hosted-vs-upstream boundary, see [Hosted Feature Support](getting-started/hosted-feature-support.md). The machine-readable matrix is `src/shared/hosted-feature-support.ts` and is exposed as `featureSupport` in `/api/status`, `/api/channels/summary`, and `/api/admin/launch-verify`.

The canonical state model for per-event channel handoff is documented in [Channel Delivery State Machine](channel-delivery-state-machine.md), implemented in `src/shared/channel-delivery.ts`, and governed by `docs/adr/0001-channel-delivery-state-machine-source.md`. This guide describes operator behavior; do not duplicate the transition table here.

## Before you connect a channel

There are two different gates here:

1. **Config gate** — can the app save channel credentials and expose a valid webhook URL?
2. **Operational gate** — has the deployment proven the full delivery path for real traffic?

Before the admin panel can save channel config, the deployment needs:

- **A resolvable public HTTPS origin.** The app must be able to build a canonical webhook URL. If it cannot, channel connect is blocked.
- **AI Gateway auth available.** On Vercel deployments this is usually OIDC. `AI_GATEWAY_API_KEY` can still act as a fallback when OIDC is unavailable. If AI Gateway auth is `unavailable`, channel connect is blocked.
- **Redis configured.** Channels rely on durable state for webhook queues and session history. On Vercel deployments, missing Redis is a hard blocker. In local or non-Vercel environments it is a warning only.

If any of those hard blockers are present, the channel config route returns HTTP 409 with a `CHANNEL_CONNECT_BLOCKED` error and a machine-readable list of issues.

These warnings do **not** block channel save by themselves:

- `OPENCLAW_PACKAGE_SPEC` not pinned
- `CRON_SECRET` not set

They still matter for deterministic resumes and cron recovery, but they are not part of the channel connectability hard-blocker set.

`VERCEL_AUTOMATION_BYPASS_SECRET` is a special case: the missing secret alone is only a warning, but when the app's runtime self-probe detects that Vercel Deployment Protection is actually active, the missing bypass becomes a hard blocker (`deployment-protection-active` issue with status `fail`) because webhooks literally cannot reach the app.

Destructive launch verification is a separate operational proof step. It is what proves queue delivery, sandbox boot or resume, real completions, wake-from-sleep, and resume-target sealing. The app does not currently use `channelReadiness.ready` as a save-time blocker; it is the signal that tells operators whether the current deployment is truly channel-ready.

## Preflight vs channel readiness

These checks answer different questions.

**Preflight** answers: "Is the deployment configured well enough to expose a channel webhook?" It is config-only. It checks origin resolution, store availability, auth, and webhook prerequisites without touching the sandbox.

**Safe launch verification** answers: "Can the deployment boot or resume the sandbox and get a real completion right now?" It runs `preflight`, `queuePing`, `ensureRunning`, and `chatCompletions`.

**Destructive launch verification** answers: "Can the deployment survive the full delivery path, including stop, wake-from-sleep, and resume-target preparation?" It adds `wakeFromSleep` and `restorePrepared`. This is the only mode that can make `channelReadiness.ready` true.

The operator rule is simple:

- Use **preflight** to see whether channel setup is blocked by config.
- Use **safe mode** to prove the live runtime path without testing sleep and resume.
- Use **destructive mode** before calling the deployment channel-ready.

## Recommended operator order

1. Run preflight.
2. Fix hard blockers until the channel reports `canConnect: true`.
3. Run destructive launch verification.
4. Save the channel credentials or register the webhook.
5. Send a real test message.

Channel save and channel readiness are separate. A channel can be connectable before the current deployment is fully verified for real traffic.

## Hosted channel support matrix

| Channel group | Hosted status | What the wrapper owns | Verification required before ready |
| --- | --- | --- | --- |
| Slack | supported | Credential storage, OAuth/manual setup, `/api/channels/slack/webhook`, wake forwarding, `lastForward`, readiness summary. | Route ready, native `/slack/events` accepted, and user-visible reply observation. |
| Telegram | supported | Bot token storage, webhook secret, `/api/channels/telegram/webhook`, port 8787 native forwarding, wake forwarding, `lastForward`, readiness summary. | Webhook registered, native listener ready, native forward accepted, and user-visible reply observation. |
| Discord | not supported | New setup and delivery fail closed; legacy credentials remain removable so old interaction endpoints can be detached. | Use local/upstream OpenClaw's persistent Discord Gateway transport. |
| WhatsApp | not supported | Setup and webhook routes fail closed; legacy credentials are not projected into the sandbox. | Use local/upstream OpenClaw linked-device WhatsApp support. |
| Other upstream channels | upstream-only | None in this wrapper. | Add credential storage, platform verification, webhook/native route, wake forwarding, `lastForward`, readiness summary, and real reply proof before claiming hosted support. |

## Slack

### Sending real debug messages

For live Slack delivery incidents, use the operator-only Slack debug sender when a repeatable real user message is needed. See [Slack Debug Sender](slack-debug-sender.md).

The sender uses a Slack OAuth user token with `chat:write` and posts through `chat.postMessage`, which triggers Slack's normal Events API path into `/api/channels/slack/webhook`. Do not use bot tokens, incoming webhooks, copied browser cookies, or fake Events API payloads as the primary end-to-end test; those do not prove the same user-message path.

The sender writes sanitized correlation output under `.agent-runs/channel-debug/<timestamp>/slack/channel/`. Use its `debugId` and Slack `channel:ts` to find `channels.slack_webhook_accepted`, then follow the resulting Slack event ID through `lastForward`, Vercel logs, Workflow state, and sandbox evidence.

### Connecting Slack

There are two ways to connect Slack:

**One-click OAuth install (recommended).** When `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET` are set as environment variables, the admin panel shows an **Install to Slack** button. Clicking it redirects to Slack's OAuth approval screen. After approval, the app exchanges the authorization code for a bot token and persists the config automatically. The signing secret comes from the environment variable rather than manual entry.

To set up OAuth install:

1. Create the Slack app from the manifest flow (admin panel → Create Slack App).
2. Copy Client ID, Client Secret, and Signing Secret from the Slack app's Basic Information page.
3. Set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET` in your environment.
4. Enable Slack distribution if installs must work outside the app owner's workspace.
5. Click **Install to Slack** from the admin panel.

**Manual credential entry.** When the OAuth env vars are not set, the admin panel shows the manual form for entering a Signing Secret and Bot Token. This is the fallback mode and the original connection method.

In both cases, the app stores the credentials in the metadata record and builds a webhook URL pointing to `/api/channels/slack/webhook`.

Slack delivery URLs may include the protection bypass parameter (`x-vercel-protection-bypass`) when `VERCEL_AUTOMATION_BYPASS_SECRET` is configured. This lets Slack webhooks reach the app even on protected deployments.

### How Slack messages flow

When a Slack message arrives at the webhook:

1. The route validates the Slack signature.
2. The route durably hands the event to Vercel Workflow. Production does not dispatch directly from the request because native admission and Workflow ownership are not atomic.
3. The Workflow reuses the running sandbox or resumes it, then forwards the original signed payload to OpenClaw's `/slack/events` handler on port 3000.
4. A stopped sandbox may get one Workflow-owned wake placeholder. Native acceptance transfers that placeholder to cleanup-only ownership; Slack uses threaded replies for responses.

## Telegram

### Connecting Telegram

Configure Telegram credentials from the admin panel. The app stores the bot token and webhook secret, then registers the webhook URL with the Telegram Bot API via `setWebhook`.

OpenClaw's config includes the app's public Telegram webhook route as `webhookUrl`. When the sandbox boots, OpenClaw itself also calls `setWebhook` with this URL, so the app's endpoint — not the sandbox's — is what Telegram calls.

Telegram validates webhooks via the `x-telegram-bot-api-secret-token` header. Registration URLs include the bypass query parameter when configured, allowing Telegram to work with Vercel Deployment Protection.

### How Telegram messages flow

When a Telegram update arrives at the webhook:

1. The route validates the webhook secret header.
2. The route durably hands the update to Vercel Workflow. The Workflow forwards the raw update to OpenClaw's native Telegram handler on port 8787, preserving slash commands, media, inline keyboards, and other native behavior.
3. OpenClaw confirms durable native acceptance with `x-openclaw-delivery-accepted: durable`. The wrapper trusts that marker only when the installed, manifest-verified bundle identity declares `telegram-durable-ack-v1`. A missing identity, missing capability, unmarked `2xx`, or generic `5xx` is recorded as `visibility-unknown` and is not blindly replayed; even a direct-local `5xx` can occur after the spool commit.
4. If the sandbox is stopped, the Workflow resumes it before forwarding. The wrapper does not create a new Telegram wake placeholder because Bot API sends have no idempotency key; an ambiguous send could otherwise orphan or duplicate the notice.
5. A suspension-admission `503` with OpenClaw code `gateway_unavailable` is treated as a pre-admission rejection only when the verified bundle declares `gateway-suspend-v1`; otherwise the outcome remains unknown and is not replayed.

## WhatsApp

Hosted WhatsApp setup and webhook delivery are disabled. The old wrapper accepted Meta Cloud API credentials and forwarded Meta payloads to `/whatsapp-webhook`, but OpenClaw's bundled WhatsApp channel owns a Baileys linked-device session instead. Those are different transports and cannot be joined by forwarding the raw Meta payload. Existing legacy credentials may be removed from the admin panel; new saves return `CHANNEL_CONNECT_BLOCKED`, and the webhook route returns `410 HOSTED_WHATSAPP_TRANSPORT_UNAVAILABLE`.

Use local/upstream OpenClaw for linked-device WhatsApp until a single hosted transport, credential model, lifecycle owner, and real end-to-end proof exist.

## Discord

Hosted Discord is not supported. OpenClaw's Discord integration owns a persistent Bot Gateway connection; this wrapper cannot replace it with an HTTP interaction forward. New setup, command registration, and Workflow delivery fail closed. A signed interaction for a retained legacy config receives an immediate private unavailable response instead of a deferred acknowledgement that can never complete.

Use local/upstream OpenClaw for Discord. The hosted DELETE route exists only to detach a legacy interactions endpoint and retains the credential when remote cleanup fails so the operator can retry.

## Protected deployments

Supported webhook channels (Slack and Telegram) use bypass-capable delivery URLs on protected deployments when `VERCEL_AUTOMATION_BYPASS_SECRET` is configured. The app auto-detects active Deployment Protection at runtime and hard-blocks channel connections when protection is on but bypass is not configured.

Admin-visible URLs — in the admin panel, preflight payload, status responses, and docs examples — must stay display-safe and never expose the bypass secret. The app enforces this by using `buildPublicDisplayUrl()` for all operator-visible surfaces and reserving `buildPublicUrl()` for outbound delivery only.

## Durable delivery for running and stopped sandboxes

Slack and Telegram production ingress always starts the shared Vercel Workflow path. A running sandbox makes the readiness phase short, but it does not bypass durable handoff. The direct native dispatch code is test-only until the host has an atomic queued-owner and native-idempotency contract.

1. Slack may create one Workflow-owned wake placeholder when the sandbox is cold. Telegram deliberately does not create a new placeholder because Bot API sends cannot be made idempotent.
2. The Workflow reuses, resumes, or creates the sandbox and waits for the relevant handler to become reachable.
3. The original webhook payload is forwarded to OpenClaw's native channel handler:
   - Slack: `/slack/events` on port 3000.
   - Telegram: `/telegram-webhook` on port 8787.
4. The native handler owns channel-specific processing and reply behavior.
5. Native acceptance does not prove a visible reply. The wake placeholder is cleared after native acceptance, while reply visibility remains a separate summary signal. Terminal failure or uncertain acceptance updates the notice instead.

The wrapper treats `gateway_unavailable` as a definite pre-admission rejection only when the verified bundle declares `gateway-suspend-v1`; an unverified response remains delivery-unknown and is not replayed.

The Workflow-based path is a native-forward wake path, not a generic `POST /v1/chat/completions` fallback.

The Workflow-based path is durable — it survives function restarts and retries on transient failures. On deployed Vercel environments, that durability depends on Redis-backed state and missing Redis is a hard blocker for channel setup. In local or non-Vercel environments the app can still run with the in-memory store, but queue state and wake/retry durability do not survive cold starts.

## Troubleshooting

### Channel connect is blocked

The admin panel shows a channel as blocked when deployment prerequisites are still failing. Check the preflight report for hard blockers: missing public origin, unavailable AI Gateway auth, or missing Redis on Vercel. Resolve the blockers and try again.

### Preflight passes but channel still is not trusted

This means config looks good, but the current deployment has not yet proven the runtime prerequisites for channel delivery. Preflight only checks config. Safe mode proves boot or resume plus a real completion, but destructive launch verification is still required before `channelReadiness.ready` becomes `true`. After connecting a channel, still send a real platform test message to prove external delivery.

### Channel webhooks fail on a protected deployment

Channel webhooks are hitting Vercel's Deployment Protection. Enable Protection Bypass for Automation in your Vercel project settings and set `VERCEL_AUTOMATION_BYPASS_SECRET`. Supported hosted channels (Slack and Telegram) include the bypass parameter in their delivery URLs when configured. The app detects active protection at runtime — if the admin panel shows a "Deployment Protection is blocking webhook delivery" banner, follow the instructions there.

### Launch verification phases look mostly healthy but overall result is false

Even when individual phases pass, `ok: false` means something is still wrong. Check these fields in the verification result:

- `runtime.dynamicConfigVerified` — was the running sandbox config in sync with the deployment?
- `sandboxHealth.configReconciled` — did stale config get successfully fixed?
- `runtime.restorePreparedStatus` — is the resume target reusable for future boots?

A partial pass with `ok: false` usually means dynamic config drifted or the resume target is not sealed. Re-running destructive verification after fixing the underlying issue is the right next step.

| Symptom | Likely meaning | Where to look |
| ------- | -------------- | ------------- |
| Channel connect is blocked | Deployment prerequisites are still failing | preflight checks, required actions |
| Preflight passes but channel still is not trusted | Full runtime path has not been verified yet | `channelReadiness.ready`, destructive launch verification |
| Slack works but Telegram registration fails on a protected deployment | Telegram is hitting protection behavior, not app auth | deployment protection exception, Telegram webhook URL behavior |
| Launch verification phases look mostly healthy but overall result is false | Dynamic config or resume-target state is still unhealthy | `runtime.dynamicConfigVerified`, `sandboxHealth.configReconciled`, `restorePreparedStatus` |

## Related docs

- [Preflight and Launch Verification](preflight-and-launch-verification.md) — how readiness is checked and proven
- [Deployment Protection](deployment-protection.md) — bypass secret behavior and display-safe URL rules
- [Sandbox Lifecycle and Restore](lifecycle-and-restore.md) — how the sandbox moves through states
- [API Reference](api-reference.md) — endpoint and payload shapes for channel routes and launch verification
- [Environment Variables](environment-variables.md) — full env var reference including channel-relevant config
