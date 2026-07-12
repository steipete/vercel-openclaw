---
name: whatsapp-delivery
description: "WhatsApp hosted fail-closed and legacy-cleanup verification workflow."
---

# WhatsApp Hosted Cleanup

Use after `channel-debug-core` to prove hosted setup/delivery remains disabled or to debug legacy credential cleanup. Use local/upstream OpenClaw for real WhatsApp delivery.

## Files

- `src/app/api/channels/whatsapp/webhook/route.ts`
- `src/server/channels/whatsapp/**`
- `src/server/workflows/channels/drain-channel-workflow.ts`
- `src/server/admin/why-not-ready.ts`
- `src/app/api/channels/summary/route.ts`

## Runtime Path

```text
Hosted setup/message ingress -> explicit fail-closed response; legacy DELETE -> credential cleanup
```

## Parallel Lane Inputs To Consume

Before proposing a hosted WhatsApp cleanup fix, consume:

- Vercel/app logs lane: fail-closed response or cleanup attempt and project targeting proof.
- State lane: retained legacy credential/config and cleanup result without exposing secret values.
- Upstream lane: local/persistent linked-device transport when the report is about actual WhatsApp delivery.

## Special Checks

- Do not present hosted WhatsApp as connectable or delivery-ready.
- Cleanup failures must retain enough credential state for a safe retry.
- `linkState` is legacy projection evidence, not hosted delivery proof.
