# ADR 0001: Channel Delivery State Machine Source

Status: Accepted

## Context

Channel delivery has shared state names, transitions, and diagnostic projections.
Duplicating that model in prose lets runtime behavior and operator guidance drift.

## Decision

`src/shared/channel-delivery.ts` is the source of truth for delivery states,
events, transitions, and transport extension metadata. The generated diagram in
`docs/channel-delivery-state-machine.md` must be regenerated with
`scripts/render-channel-delivery-diagram.ts` whenever that source changes.

The state model is transport-neutral. Presence in extension metadata is not a
hosted-support claim. `src/shared/hosted-feature-support.ts` and
`HOSTED_DELIVERY_CHANNEL_NAMES` define the hosted product boundary: only Slack
and Telegram may enter native-acceptance Workflow verification. Discord and
WhatsApp remain fail-closed and cleanup-only in this wrapper.

## Consequences

- Runtime changes start in `src/shared/channel-delivery.ts`; generated docs do
  not become an independent source.
- CI validates both the generated diagram and this governance document.
- Smoke and readiness surfaces must not infer hosted support from the generic
  channel or extension registries.
