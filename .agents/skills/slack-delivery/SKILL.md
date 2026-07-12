---
name: slack-delivery
description: "Slack channel specialist workflow: debug OAuth, durable Workflow handoff, /slack/events signatures, cleanup, and lastForward."
---

# Slack Delivery

Use after `channel-debug-core` for Slack issues.

## Files

- `src/app/api/channels/slack/webhook/route.ts`
- `src/server/channels/slack/**`
- `src/server/workflows/channels/drain-channel-workflow.ts`
- `src/server/admin/why-not-ready.ts`
- `src/app/api/channels/summary/route.ts`

## Runtime Path

```text
Slack event -> /api/channels/slack/webhook -> Slack signature validation over raw body -> durable Workflow handoff -> port 3000 /slack/events -> Bolt signature re-verification -> threaded Slack reply
```

## Parallel Lane Inputs To Consume

Before proposing a Slack fix, consume:

- Vercel/app logs lane: `channels.slack_webhook_accepted`, Workflow handoff, requestId/deliveryId, and project targeting proof.
- Sandbox runtime lane: port 3000 listener, `/slack/events` probe behavior, OpenClaw plugin count, sanitized config has `channels.slack`.
- Workflow lane: `drainChannelWorkflow` run and native-forward state, with verified project targeting when `.vercel/project.json` differs from the incident target.
- Prior-fix comparison: openclaw-42 zero-plugin wedge, stale sandbox URL, workflow retry exhaustion, Slack 401 raw-body/signature failure.

## Special Checks

- Raw body and `x-slack-*` headers must survive forwarding.
- Slack 401 from native handler usually means Bolt signature failure.
- OAuth complete is not delivery-ready.
- `liveConfigSync` failed can be overridden by recent accepted `lastForward`.
- Route repair after 404 must be proven with before/after signals.
- Pending boot message cleanup happens when bot reply events arrive.
- `app_mention` plus `message.channels` can duplicate user intent.
