# Architecture

## What this app is

`vercel-openclaw` is a single-instance Next.js control plane for one OpenClaw sandbox on Vercel.

It handles:

- admin auth in front of the proxy
- creating and resuming the sandbox on demand (Sandbox v2 persistent auto-save on stop)
- proxying the OpenClaw UI at `/gateway`
- injecting the gateway token into proxied HTML so WebSocket connections and auth work through the app
- learning and enforcing egress firewall rules
- receiving Slack, Telegram, and Discord (experimental) webhooks and delivering them to OpenClaw; hosted WhatsApp fails closed because its former Meta webhook transport is incompatible with OpenClaw's linked-device runtime
- exposing a hosted feature support matrix in `/api/status`, `/api/channels/summary`, and the admin UI

It does not handle:

- multiple sandboxes
- per-sandbox passwords
- remote companion-node pairing, hosted voice/audio routing, or hosted canvas guarantees
- arbitrary plugin, skill, ClawHub, MCP, or tool installation beyond what ships in the pinned OpenClaw bundle

## The two planes

### Control plane

The control plane is a single metadata record stored in Redis (or an in-memory store for local dev). It tracks the sandbox name, lifecycle status, firewall state, gateway token, and channel configuration.

The store backend is selected at startup. Redis is required for production because channels, cron wake, and durable state all depend on persistent storage. Any Redis-wire-protocol endpoint works (Redis Cloud, self-hosted, etc.).

### Enforcement plane

The enforcement plane is the actual Vercel Sandbox plus its network policy. The app talks to it through the `@vercel/sandbox` v2 beta SDK to create, resume, stop, and update the sandbox network policy. Sandboxes are persistent: stop auto-saves state, normal wake uses `Sandbox.get({ name, resume: true })`, and observation paths use `resume: false` so status checks do not wake stopped sandboxes.

The network policy also handles **credential brokering**: AI Gateway tokens are injected as `Authorization` headers via `transform` rules at the firewall layer, and token refresh is a single `sandbox.update({ networkPolicy })` call with no gateway restart. Current bootstrap still has a compatibility exception where `buildRuntimeEnv()` may pass AI Gateway tokens into sandbox env, so the security model is host-controlled policy plus a documented bootstrap fallback, not a blanket claim that the credential never exists in the VM.

In enforcing mode, a configured or request-resolved canonical control-plane hostname is permitted as an internal system domain. OpenClaw uses it for durable cron projection and other host-owned control-plane calls. This exception is applied to create, resume, hot-spare, diagnostic restore, and policy-refresh paths, but is not copied into the operator-managed allowlist or included in its displayed count. Local background operations without a resolvable canonical origin retain the operator policy unchanged.

## Request flow to `/gateway`

1. The browser requests `/gateway`.
2. The app authenticates the request (admin-secret cookie or Vercel OAuth session).
3. If the sandbox is not running, the app schedules create or resume work with `after()` and returns a waiting page. The browser polls until the sandbox is ready.
4. Once the sandbox is running and the gateway is healthy, the app proxies the request to port `3000` inside the sandbox.
5. HTML responses are rewritten so WebSocket connections route through the app and the gateway token is injected for client-side auth.

## Main subsystems

- **Auth** — session cookies, admin-secret exchange, optional Vercel OAuth
- **Sandbox lifecycle** — create, resume, stop, health checks (Sandbox v2 persistent auto-save)
- **Proxy** — reverse proxy to the sandbox, HTML injection, waiting page
- **Firewall** — domain learning from shell commands, policy enforcement
- **Channels** — Slack, Telegram, and Discord (experimental) webhook ingestion, boot-message flow, durable delivery via Workflow DevKit; explicit hosted WhatsApp unsupported state
- **Deployment readiness** — preflight config checks, launch verification runtime checks, watchdog cron
- **Hosted feature support** — static support matrix that keeps hosted claims distinct from upstream-only OpenClaw capabilities

## Where to read next

- [Sandbox Lifecycle and Restore](lifecycle-and-restore.md) — how the sandbox moves through states and how persistent resume works
- [Preflight and Launch Verification](preflight-and-launch-verification.md) — how the app proves it is correctly deployed and operational
- [Hosted Feature Support](getting-started/hosted-feature-support.md) — which OpenClaw capabilities are supported, experimental, bundled-only, or upstream-only in the hosted path
- [Channels and Webhooks](channels-and-webhooks.md) — supported channel setup, hosted WhatsApp limitations, readiness, and webhook behavior
