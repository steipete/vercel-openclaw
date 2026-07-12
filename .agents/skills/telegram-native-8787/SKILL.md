---
name: telegram-native-8787
description: "Telegram channel specialist workflow: debug /api/channels/telegram/webhook, native port 8787 /telegram-webhook, webhookSecret, boot cleanup, and post-accept reply visibility."
---

# Telegram Native 8787

Use after `channel-debug-core` for Telegram issues.

## Files

- `src/app/api/channels/telegram/webhook/route.ts`
- `src/server/channels/telegram/**`
- `src/server/workflows/channels/drain-channel-workflow.ts`
- `src/server/openclaw/config.ts`
- `src/server/admin/why-not-ready.ts`
- `src/app/api/channels/summary/route.ts`

## Runtime Path

```text
Telegram update -> /api/channels/telegram/webhook -> secret header validation -> durable Workflow handoff -> sandbox port 8787 /telegram-webhook -> local/public native handler probe -> OpenClaw Telegram provider -> Telegram user-visible reply
```

## Parallel Lane Inputs To Consume

Before proposing a Telegram fix, consume:

- Vercel/app logs lane: accepted webhook, planner event, Workflow handoff, requestId/deliveryId/update_id, and project targeting proof.
- Sandbox runtime lane: actual sandboxId, port 8787 listener, local/public `/telegram-webhook` probe, sanitized config has `channels.telegram`, webhookSecret presence without value.
- Workflow lane: `drainChannelWorkflow` run state and whether 8787 not-listening/ECONNREFUSED triggered reconciliation, with verified project targeting when `.vercel/project.json` differs from the incident target.
- Prior-fix comparison: webhookSecret flow, suspicious_empty_200, stale 8787 URL refresh, boot-message cleanup.

## Special Checks

- Port 8787 is not port 3000.
- Native handler registered evidence is local/public probe behavior, especially local 401 on invalid secret.
- Fast, empty 200 is suspicious; do not call it accepted.
- Generic local or public 5xx is acceptance-unknown; only the admitted durable marker proves the spool committed.
- `lastRestoreMetrics.telegramListenerReady` is evidence, not the whole truth.
- `webhookSecret` must flow through config build, restore assets, dynamic resume files, and config hash.
- Accepted forward does not prove a visible Telegram reply.
- Boot message send/update/delete behavior is user-visible evidence.
