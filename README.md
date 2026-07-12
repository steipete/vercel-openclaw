<p align="center"><strong>Research Preview</strong></p>

<p align="center">
  <img src="public/openclaw-logo.svg" width="80" height="80" alt="OpenClaw" />
</p>

<h1 align="center">Deploy OpenClaw on Vercel</h1>

<p align="center">
  Get a personal OpenClaw instance running in a Vercel Sandbox with one command.
</p>

<h2 align="center">Recommended: the <code>vclaw</code> CLI</h2>

<p align="center">
  <code>npx @vercel/vclaw create --scope your-team</code>
</p>

<p align="center">
  <strong>This is the only fully supported install path.</strong> Use it unless you have a specific reason not to.
</p>

### Why `vclaw` over the Deploy button

The Deploy button starts a project but stops short of a working OpenClaw. `vclaw` takes you end-to-end:

| Step | `vclaw create` | Deploy button |
| ---- | :-: | :-: |
| Uses or clones `vercel-labs/vercel-openclaw` | yes | yes |
| Links a Vercel project in the scope you pick | yes | partial (browser flow) |
| Provisions Redis via the Marketplace integration | yes | yes |
| Prompts for and sets `ADMIN_SECRET` | yes | yes |
| Can set `CRON_SECRET` for independent cron rotation | yes, with `--cron-secret` | no |
| Enables Deployment Protection and wires `VERCEL_AUTOMATION_BYPASS_SECRET` | yes (`--deployment-protection`) | no |
| Runs a production deploy | yes | yes |
| Runs launch verification against the live URL | yes | no |
| Works headlessly with `VERCEL_TOKEN` | yes | no |

Result: after `vclaw create` finishes, channel webhooks can reach OpenClaw through protection when bypass is configured, and you have proof the sandbox can complete a real chat roundtrip. Cron auth rotates independently from your admin login only when you pass `--cron-secret`; otherwise the runtime falls back to `ADMIN_SECRET`. The Deploy button gets you a booted UI, nothing more.

### Prerequisites

- Node.js 20 or newer
- `git`
- The Vercel CLI: `npm i -g vercel`
- Authenticated: run `vercel login`, or export `VERCEL_TOKEN` for non-interactive runs

Check your environment before you start:

```bash
npx @vercel/vclaw doctor
```

### Quick start with `vclaw`

```bash
npx @vercel/vclaw create --scope your-team
```

For the full onboarding path across the CLI, dashboard, sandbox runtime, and release contracts, read the [Getting Started Guide](docs/getting-started/README.md). It is the main guide for maintainers and agents working across `vclaw`, `vercel-openclaw`, and the OpenClaw fork.

This walks through the full setup:

1. Verifies local prerequisites.
2. Picks a Vercel scope (prompts if you have more than one).
3. Uses a managed workspace under `~/.vclaw` by default, or uses the directory passed with `--dir`. Pass `--clone` to clone or update `vercel-labs/vercel-openclaw` into that directory.
4. Creates and links a Vercel project (prompts for a unique name if `openclaw` is taken).
5. Provisions Redis via the Redis Cloud Marketplace integration.
6. Optionally enables Deployment Protection (`sso` or `password`) and sets the automation bypass secret so webhooks still reach the app.
7. Prompts for `ADMIN_SECRET` (masked, confirmed). This is the password you will type into the admin UI.
8. Pushes managed env vars: `ADMIN_SECRET`, `CRON_SECRET` (if `--cron-secret` is set), `VERCEL_AUTOMATION_BYPASS_SECRET` (if protection is enabled).
9. Runs a production deploy.
10. Runs launch verification against the new URL and reports `channelReadiness`.
11. Optionally wires a Telegram bot with `--telegram`, or Slack through the interactive `--slack` flow, non-interactive `--slack-config-token`, or `--slack-bot-token --slack-signing-secret` flows.

### Common `vclaw` flows

Choose a project name and use an existing checkout:

```bash
vclaw create --scope your-team --name my-openclaw --dir ~/dev/vercel-openclaw
```

Clone or update into a chosen directory:

```bash
vclaw create --scope your-team --name my-openclaw --dir ~/dev/my-openclaw --clone
```

Enable SSO deployment protection (auto-configures webhook bypass):

```bash
vclaw create --scope your-team --deployment-protection sso
```

Prepare a project but skip the deploy step:

```bash
vclaw create --scope your-team --skip-deploy
```

Wire up a Telegram bot in the same run:

```bash
vclaw create --scope your-team --telegram "123456:AA...BotFatherToken"
```

After launch verification passes, `vclaw` calls `PUT /api/channels/telegram` on the new deployment. The app validates the token via Telegram's `getMe`, generates a webhook secret, registers the Vercel URL with Telegram, and syncs slash commands — no admin-panel clicks needed.

Wire up Slack in the same run:

```bash
vclaw create --scope your-team --slack
```

`--slack` opens the interactive Slack setup menu. For non-interactive Slack setup, choose one flow:

```bash
# Create a new Slack app, then complete OAuth in the browser.
vclaw create --scope your-team \
  --slack-config-token "$SLACK_CONFIG_TOKEN" \
  --slack-app-name "My OpenClaw"
```

```bash
# Connect an existing Slack app.
vclaw create --scope your-team \
  --slack-bot-token "xoxb-..." \
  --slack-signing-secret "abcd1234..."
```

`--slack-config-token` creates a new app and opens the OAuth install flow. `--slack-bot-token` and `--slack-signing-secret` must be passed together for an existing app.

Slack setup requires a live deployment and is mutually exclusive with `--skip-deploy`.

Re-run launch verification against an existing deployment:

```bash
vclaw verify \
  --url https://my-openclaw.vercel.app \
  --admin-secret "$ADMIN_SECRET"
```

For protected deployments, include the automation bypass secret:

```bash
vclaw verify \
  --url https://my-openclaw.vercel.app \
  --admin-secret "$ADMIN_SECRET" \
  --protection-bypass "$VERCEL_AUTOMATION_BYPASS_SECRET"
```

Full reference: [github.com/vercel-labs/vclaw](https://github.com/vercel-labs/vclaw).

---

<details>
<summary><strong>Alternative: Deploy button (not recommended)</strong></summary>

<br />

Use this only if you cannot install Node locally. It provisions Redis and prompts for `ADMIN_SECRET`, but leaves Deployment Protection, `CRON_SECRET`, and launch verification for you to do by hand afterward.

<p align="center">
  <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fvercel-openclaw.git&env=ADMIN_SECRET&envDescription=Serves%20as%20your%20password%20for%20the%20admin%20UI.&project-name=openclaw&repository-name=openclaw&stores=%255B%257B%2522type%2522%253A%2522integration%2522%252C%2522integrationSlug%2522%253A%2522redis%2522%252C%2522productSlug%2522%253A%2522redis%2522%257D%255D"><img src="https://vercel.com/button" alt="Deploy with Vercel" /></a>
</p>

After the deploy finishes, you still need to:

1. Sign in with your `ADMIN_SECRET`.
2. Run destructive launch verification from the admin panel before connecting any channel.
3. Manually set `CRON_SECRET` if you want cron auth separate from admin login.
4. Manually enable Deployment Protection and set `VERCEL_AUTOMATION_BYPASS_SECRET` if you want protected previews that channels can still reach.

</details>

---

## What is this?

A Next.js app that wraps [OpenClaw](https://openclaw.vercel.app) in a full control plane (auth, persistent sandboxes, channel integrations, egress firewall) and runs it inside a [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox).

## Getting started

After `vclaw create` finishes:

1. **Sign in.** Open the printed deployment URL and enter your `ADMIN_SECRET`.
2. **Use OpenClaw.** Visit `/gateway` or click **Start** in the admin panel. First boot takes about a minute while OpenClaw installs into the sandbox. Resumes after that take about 10 seconds (the sandbox auto-snapshots on stop and auto-resumes on get).
3. **Verify.** `vclaw` already ran launch verification once. Re-run it from the admin panel any time you change config. Preflight is only a config-readiness check; it does not prove the sandbox can complete a real channel delivery.
4. **Connect channels.** Wire up Slack or Telegram from the admin panel — or pre-wire them during `vclaw create` itself with `--telegram` / `--slack --slack-signing-secret`. Hosted Discord and WhatsApp setup is disabled because OpenClaw owns persistent Gateway/linked-device transports rather than compatible HTTP webhook handlers. For Slack OAuth install, set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET`, or enter credentials manually. A deployment is channel-ready only after destructive launch verification passes and `channelReadiness.ready` is `true`.

See [Hosted Feature Support](docs/getting-started/hosted-feature-support.md) for the exact hosted surface. Upstream-only OpenClaw features such as companion nodes, voice, canvas, arbitrary channel adapters, and arbitrary plugin/skill installation are not presented as hosted support until this wrapper has setup, persistence, wake/proxy behavior, and verification for them.

## What you get

- **Full OpenClaw UI** proxied at `/gateway` with auth and WebSocket rewriting.
- **Persistent sandboxes.** State is preserved on stop and restored on resume.
- **Slack and Telegram** channels with durable delivery. Discord and WhatsApp remain available through local/upstream OpenClaw, not this hosted wrapper.
- **Bundled OpenClaw plugins and skills only.** Arbitrary plugin, skill, ClawHub, MCP, and tool installation is a local/upstream OpenClaw path until a hosted lifecycle contract exists.
- **Egress firewall.** Learn which domains your agent talks to, then lock it down.
- **Auto-wake (experimental).** Verified bundles declaring `cron-projection-v1` (legacy `gateway_start` baseline) or `cron-projection-v2` (`cron_reconciled` baseline) can arm a durable, token-revalidating Workflow from a sanitized OpenClaw wake projection; the watchdog repairs stale dispatch.

## Built with

| Technology | Role |
| ---------- | ---- |
| [Next.js](https://nextjs.org) | App framework |
| [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) | Runs the OpenClaw instance (persistent sandboxes, auto-snapshot on stop, auto-resume on get) |
| [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) | OIDC-authenticated model access for the agent |
| [Redis Cloud](https://vercel.com/marketplace/redis) | Persistent state for metadata, snapshots, and channel config (any Redis-wire-protocol endpoint works) |
| [Vercel Workflow](https://vercel.com/docs/workflow) | Durable Slack and Telegram message delivery and scheduled sandbox wake |
| [Vercel Queues](https://vercel.com/docs/queues) | Launch verification probe delivery |
| [Vercel Cron](https://vercel.com/docs/cron-jobs) | Watchdog health checks and cron-projection anti-entropy |

## Configuration

For the default path (`VERCEL_AUTH_MODE=admin-secret`), the only value you must provide up front is `ADMIN_SECRET`. Everything else auto-configures:

- **Redis.** Provisioned by `vclaw` (or the Deploy button) via the Redis Cloud Marketplace integration, which sets `REDIS_URL`.
- **AI Gateway auth.** Handled via Vercel OIDC on deployed environments.
- **Cron secret.** Falls back to `ADMIN_SECRET` when `CRON_SECRET` is unset. Set `CRON_SECRET` separately on deployed environments if you want cron auth to rotate independently from admin login. `vclaw --cron-secret` sets this for you.
- **Watchdog cron.** Runs once daily by default so Hobby-plan deploys succeed. Cron wake timing comes from Workflow; increasing the watchdog frequency only shortens repair time for failed or stale dispatch.

Switching to `VERCEL_AUTH_MODE=sign-in-with-vercel` also requires `NEXT_PUBLIC_VERCEL_APP_CLIENT_ID`, `VERCEL_APP_CLIENT_SECRET`, and `SESSION_SECRET`.

See [docs/environment-variables.md](docs/environment-variables.md) for the full reference, including optional tuning (vCPU count, sleep timeout, version pinning) and alternative auth modes.

## Local development

```bash
pnpm install
vercel link && vercel env pull   # pulls OIDC credentials for AI Gateway
pnpm dev                         # http://localhost:3000
```

### Running locally against production data

For production debugging, prefer a linked local workspace created by `vclaw create --auto-link`. It links the Vercel project under `--dir`, writes the production admin/protection values into that directory's `.env.local`, and makes sure local-only files stay ignored. That keeps the local checkout you inspect, the `.vercel/project.json` link, and the auth values used by admin/debug commands in one place.

```bash
npx @vercel/vclaw create \
  --scope your-team \
  --auto-project-name \
  --dir ~/dev/vercel-openclaw \
  --admin-secret "$ADMIN_SECRET" \
  --auto-link

cd ~/dev/vercel-openclaw
# .env.local now contains the admin secret, automation bypass secret, and vclaw project metadata.
# Keep it local; do not paste it into logs, commits, issues, or agent handoffs.
```

For read-only UI work against real prod Redis/metadata, edit that `.env.local` before `pnpm dev`:

```bash
# in .env.local:
#   VERCEL_ENV=development     # flips the Vercel-deployment gate so Redis connects
#   LOCAL_READ_ONLY=1          # blocks every admin mutation route with 403 LOCAL_READ_ONLY
#   unset VERCEL_AUTH_MODE     # use admin-secret auth locally
pnpm dev
```

With `LOCAL_READ_ONLY=1`, `POST /api/admin/stop`, `/ensure`, `/reset`, `/snapshot`, and channel config writes all return `403 { error: "LOCAL_READ_ONLY" }` before touching the sandbox SDK. Reads (`/api/status`, `/api/admin/preflight`, `/api/admin/logs`) still work. Unset the variable only when you intentionally want to test a mutation.

## Debugging channels with agents

Channel delivery has several independent states: the app can be connected, the sandbox can be running, the native handler can accept a forward, and the user still might not see a reply. When Slack or Telegram is stuck, use the repo-local Codex agents and skills to split evidence gathering by channel instead of guessing from one readiness label. Hosted Discord and WhatsApp should fail closed; use their local/upstream transports instead.

Codex custom agent roles live in `.codex/agents/*.toml`; shared debugging playbooks live in `.agents/skills/*/SKILL.md`. Use the channel agents for parallel triage and the skills for repeatable evidence collection:

| Channel | Agent | Primary skill | Focus |
| ------- | ----- | ------------- | ----- |
| Telegram | `channel_telegram` | `telegram-native-8787` | Native port 8787, webhook secret flow, boot cleanup, user-visible replies |
| Slack | `channel_slack` | `slack-delivery` | OAuth vs delivery readiness, raw-body signature Workflow forwarding, `/slack/events` acceptance |
| Discord (hosted disabled) | `channel_discord` | `discord-delivery` | Ed25519 verification, immediate fail-closed replies, and legacy endpoint cleanup |
| WhatsApp (hosted disabled) | `channel_whatsapp` | `whatsapp-delivery` | Fail-closed setup/webhook proof and legacy credential removal |

For any channel incident, start with `$channel-debug-core`. It requires deployment-state proof, the admin readiness surfaces, a runtime path diagram, a hypothesis table, and a channel handoff before proposing a fix. Before changing webhook routes or the shared workflow, use `$channel-forward-parity` to verify every terminal path logs, updates `lastForward`, classifies failures, and refreshes stale sandbox port URLs when needed.

Suggested workflow:

1. Prove the deployed runtime matches the source you are reading: local `git rev-parse HEAD`, remote `git ls-remote origin main`, and live `GET /api/admin/sandbox-diag`.
2. Collect `GET /api/admin/why-not-ready`, `GET /api/channels/summary`, `GET /api/admin/sandbox-diag`, and `GET /api/admin/logs` before editing code.
3. If multiple channels are suspect, explicitly spawn the relevant channel agents and ask each to return `.agents/skills/channel-debug-core/references/handoff-template.md`.
4. Keep `route-ready`, `native-accepted`, and `user-visible-reply` separate in the report. A green `lastForward` is not proof that the user saw a message.
5. Save raw runtime evidence under `.agent-runs/channel-debug/<timestamp>/` and do not commit it.

## Debugging app subsystems with agents

Channel delivery is only one slice of the wrapper. For cron, lifecycle, proxy, firewall, auth/store, bootstrap, launch verification, and admin UI work, use the matching repo-local Codex agent plus its skill so each investigation starts from the right evidence and file ownership.

| Area | Agent | Primary skill | Focus |
| ---- | ----- | ------------- | ----- |
| Cron/watchdog | `cron_watchdog` | `cron-watchdog-debug` | projection revision/digest, Workflow dispatch token hash, watchdog anti-entropy, OpenClaw hook evidence |
| Sandbox lifecycle | `sandbox_lifecycle` | `sandbox-lifecycle-debug` | create/resume/stop/snapshot/reset, stale-running reconciliation, locks, hot spares |
| Gateway/proxy | `gateway_proxy` | `gateway-proxy-debug` | `/gateway`, HTML injection, WebSocket rewrite, waiting page, gateway-token handoff |
| Firewall/AI Gateway | `firewall_ai_gateway` | `firewall-ai-gateway-debug` | network policy, OIDC token refresh, transform rules, egress allowlists |
| Auth/store | `auth_store` | `auth-store-debug` | admin-secret, Vercel auth, sessions, CSRF, Redis/memory store, keyspace |
| OpenClaw bootstrap | `openclaw_bootstrap` | `openclaw-bootstrap-debug` | bundle sidecars, config hashes, restore assets, plugin discovery, gateway restart |
| Launch verification | `launch_verify` | `launch-verify-debug` | preflight, queue ping, chat completions, wake-from-sleep, restorePrepared, remote smoke |
| Admin UI | `admin_ui` | `admin-ui-debug` | command shell, status panels, action helpers, operator copy, visual verification |

For cron incidents, start with `$cron-watchdog-debug` and keep these states separate: OpenClaw baseline reconciled, host projection accepted, Workflow armed, dispatch token claimed, sandbox woke, OpenClaw scheduler ran the due job, and user-visible delivery happened. Save raw runtime evidence under `.agent-runs/cron-debug/<timestamp>/` and do not commit it.

## Documentation

| Document | Contents |
| -------- | -------- |
| [Getting Started Guide](docs/getting-started/README.md) | Main handoff for the three-repo system, operational paths, `vclaw create`, release, and reliability contracts |
| [Architecture](docs/architecture.md) | System overview and subsystem map |
| [Sandbox Lifecycle and Restore](docs/lifecycle-and-restore.md) | State transitions, persistent sandboxes, resume behavior |
| [Preflight and Launch Verification](docs/preflight-and-launch-verification.md) | Deployment readiness and runtime verification |
| [Channels and Webhooks](docs/channels-and-webhooks.md) | Slack/Telegram delivery, Discord/WhatsApp hosted limitations, readiness, protection behavior |
| [Environment Variables](docs/environment-variables.md) | Full env var reference |
| [API Reference](docs/api-reference.md) | Endpoint and payload reference |
| [Deployment Protection](docs/deployment-protection.md) | Bypass secret behavior and display-safe URLs |
| [Architecture Tradeoffs](docs/architecture-tradeoffs.md) | Why the codebase is shaped this way, alternatives explored |
| [Contributing](CONTRIBUTING.md) | Architecture, routes, testing, development workflows |
