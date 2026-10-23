# Getting Started Guide

This guide is the main handoff for understanding how `vclaw`, `vercel-openclaw`, and the OpenClaw fork work together.

Use this section before making setup, provisioning, release, bundle, or channel-delivery changes. It condenses the standalone `~/dev/vclaw-handoff` material into the operator docs for this repository.

## Reading Order

1. [System map](system-map.md) explains the three-repo architecture and the contracts between each layer.
2. [Operational paths](operational-paths.md) follows create, deploy, sandbox boot, proxying, and channel delivery end to end.
3. [`vclaw create`](vclaw-create.md) describes the supported install path, important flags, and failure boundaries.
4. [Hosted feature support](hosted-feature-support.md) is the source of truth for supported, experimental, bundled-only, and upstream-only OpenClaw features in the Vercel-hosted path.
5. [Release and reliability](release-and-reliability.md) covers bundle compatibility, dashboard verification, CLI publication, and known risks.

## Repository Roles

| Repo | Role | First page |
| --- | --- | --- |
| `vercel-labs/openclaw` | Runtime, plugin/channel SDKs, and sandbox bundle release assets. | [Release and reliability](release-and-reliability.md) |
| `vercel-labs/vercel-openclaw` | This dashboard/control plane: auth, one persistent sandbox, `/gateway`, state, verification, channels, and operator UI. | [Operational paths](operational-paths.md) |
| `vercel-labs/vclaw` | User-facing CLI that creates the Vercel project, provisions Redis/env/protection, deploys, verifies, and optionally connects channels. | [`vclaw create`](vclaw-create.md) |

## When To Use Existing Deep Docs

The guide is the fast path. Use the existing deep docs when you need implementation detail:

- [Architecture](../architecture.md) for the dashboard subsystem map.
- [Sandbox Lifecycle and Restore](../lifecycle-and-restore.md) for state transitions, snapshotting, and resume behavior.
- [Preflight and Launch Verification](../preflight-and-launch-verification.md) for readiness semantics.
- [Hosted Feature Support](hosted-feature-support.md) before changing claims about channels, companion apps, voice, canvas, plugins, skills, MCP, tools, or model/provider behavior.
- [Channels and Webhooks](../channels-and-webhooks.md) for channel setup, webhook delivery, and protection behavior.
- [Environment Variables](../environment-variables.md) for every runtime variable.
- [Deployment Protection](../deployment-protection.md) for bypass behavior and display-safe URLs.
- [API Reference](../api-reference.md) for request and response shapes.
- [Architecture Tradeoffs](../architecture-tradeoffs.md) for alternatives explored and why the codebase is shaped this way.

## Maintenance Notes

- Keep this guide concise and link to deep docs instead of copying entire implementation walkthroughs.
- Keep `README.md`, `docs/README.md`, and `AGENTS.md` pointed at this guide as the main onboarding path.
- If `vclaw` flags, OpenClaw bundle assets, or dashboard verification gates change, update the relevant guide page in the same change.
