# vclaw Create

`vclaw create` is the supported install path because it controls provisioning through live launch verification instead of stopping at a deployed project.

## Sequence

```mermaid
sequenceDiagram
  participant U as User
  participant C as vclaw create
  participant V as Vercel APIs/CLI
  participant R as Redis Marketplace
  participant G as GitHub Releases
  participant D as Dashboard deployment

  U->>C: create flags / prompts
  C->>C: check prereqs and auth
  C->>V: resolve scope and active team
  C->>C: resolve managed workspace or --dir
  C->>V: create/link project
  C->>R: provision Redis unless skipped
  C->>V: configure deployment protection and bypass
  C->>G: find compatible OpenClaw bundle
  C->>V: push env vars
  C->>V: deploy and wait for READY
  C->>D: launch verification
  C->>D: optional channel connect
  C->>C: register friendly claw name
```

## Important Flags

- `--scope` chooses the Vercel owner.
- `--name` chooses the Vercel project name.
- `--claw-name` writes the local friendly registry alias after successful verification.
- `--admin-secret` is required non-interactively.
- `--deployment-protection` can be `none`, `sso`, or `password`.
- `--protection-bypass-secret` supplies or overrides the automation bypass secret.
- `--bundle-url` pins an OpenClaw bundle URL.
- `--no-bundle` skips automatic bundle discovery.
- `--dir` uses an existing local `vercel-openclaw` checkout unless paired with `--clone`.
- `--clone` clones or updates `vercel-openclaw` into `--dir` or the managed workspace.
- `--skip-clone` prevents clone/update when using the managed/default path.
- `--skip-redis` assumes Redis is already provisioned.
- `--skip-deploy` stops before live verification and cannot be combined with channel flags.
- `--telegram` connects a Telegram bot after verification.
- Slack supports app creation with `--slack-config-token` or existing-app connection with `--slack-bot-token` plus `--slack-signing-secret`.

For the current flag surface, use `vclaw create --help` and the `vclaw` source in `src/commands/create.mjs`. The command source is the authority for validation rules.

## Linked Debug Workspaces

Use `--auto-link` when the deployment should be immediately debuggable from a local checkout:

```bash
vclaw create \
  --scope your-team \
  --auto-project-name \
  --dir ~/dev/vercel-openclaw \
  --admin-secret "$ADMIN_SECRET" \
  --auto-link
```

`--auto-link` writes `.env.local` in the linked directory with the admin secret, automation bypass secret, and vclaw project metadata after managed environment variables have round-tripped through Vercel. It also ensures `.gitignore` covers `.env.local` and `.vercel`. Use that directory for production debugging so the Vercel project link, local source, and admin/debug commands agree.

Treat `.env.local` as a secret-bearing local file. Do not commit it, paste it into logs, or include it in `.agent-runs` artifacts. For local UI inspection against production metadata, add `LOCAL_READ_ONLY=1` before `pnpm dev`.

## Non-Interactive Runs

Promptless create flows usually need `--scope`, `--name`, `--claw-name`, `--admin-secret`, and `--yes`.

For non-interactive Slack setup, use one of these flows:

- New app: `--slack-config-token <token>` with optional `--slack-app-name <name>`.
- Existing app: `--slack-bot-token <xoxb-token> --slack-signing-secret <secret>`.

`--slack` by itself selects the interactive Slack setup menu.

Be careful with shell expansion. `VAR=value vclaw create --slack-config-token "$VAR"` expands `$VAR` before the temporary assignment applies, so the flag can be empty. Export the variable first or pass the literal value.

## Failure Boundaries

- Invalid Vercel auth should fail before later provisioning prompts.
- Deployment must reach READY before verification.
- Launch verification failure means the app may exist but is not operational.
- Explicit channel flags are requested outcomes. Telegram failures and invalid Slack credentials should fail or return a concrete recovery path. Slack has one deliberate degraded-success case: if credentials are saved and `auth.test` passes but `deliveryReady` or `routeReady` are still propagating, `vclaw create` warns and continues unless `VCLAW_STRICT_SLACK_DELIVERY=1` is set. Re-run `vclaw verify` or send a real Slack message to confirm delivery.
- The local claw registry write is intentionally deferred until deploy, verify, and requested channel setup succeed.
- Partial create failures with a real workspace/deployment usually recover through `vclaw doctor --workspace <path> --url <verify-url> --launch-verify` plus `vclaw verify`, not by deleting everything.

## Completion Guidance

After a successful create, users should treat [Hosted Feature Support](hosted-feature-support.md) as the source of truth for what the deployment supports. The dashboard exposes the same matrix in `/api/status`, `/api/channels/summary`, and `/api/admin/launch-verify` as `featureSupport`, so `vclaw` completion output and future smoke checks can link to or read the same contract. Bundle-backed create is complete only when launch verification returns a non-null `bundleIdentity` with `verified: true` matching the requested package, source SHA, canonical digest, and required capabilities.

Slack and Telegram are the hosted channels. Discord and WhatsApp setup is disabled because their persistent upstream transports do not match this wrapper's webhook model; use local/upstream OpenClaw for them. Companion apps, voice, canvas, arbitrary channel adapters, and arbitrary plugin/skill/MCP installation require local/upstream OpenClaw unless the hosted matrix says otherwise.

## Bundle Resolution

`vclaw` resolves an OpenClaw release that contains the full sandbox sidecar set, not just `openclaw.bundle.mjs`. In local development, the resolver defaults to `~/dev/openclaw` unless `OPENCLAW_REPO_DIR` is set, so stale remotes or local branch surprises can affect release selection.
