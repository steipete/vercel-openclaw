# Release And Reliability

Release work crosses the OpenClaw fork, this dashboard, and the `vclaw` CLI, so each artifact needs its own verification proof.

## OpenClaw Bundle Release

The OpenClaw fork publishes sandbox bundle assets through its Sandbox Bundle Assets workflow. A compatible release must include the full sidecar set expected by `vclaw` and dashboard bootstrap.

Required bundle assets currently include:

- `asset-manifest.json` (schema v2)
- `openclaw.bundle.mjs`
- `channel-catalog.json`
- `workspace-templates.tar.gz`
- `channels.tar.gz`
- `runtime-plugins.tar.gz`
- `external-plugins.json`
- `external-plugin-slack.tgz`
- `bundle-deps.tar.gz`
- `bundle-openclaw-pkg.tar.gz`
- `control-ui.tar.gz`
- `bundle-capabilities.json`
- `bundle-contract.json`
- `release.json`
- the canonical release tarball named by `asset-manifest.json`

`channel-shared-chunks.tar.gz` remains an optional manifest-declared asset.

The important compatibility risk is asset shape drift. A release with only `openclaw.bundle.mjs` is not enough, and a bundle can build successfully while still failing dashboard restore or channel route readiness.

The hosted plugin and skill contract is currently bundled-only: the dashboard verifies the plugins, skills, sidecars, and runtime assets shipped in the pinned OpenClaw bundle. Arbitrary plugin, skill, ClawHub, MCP, or tool installation needs a persistence, restore, compatibility, rollback, firewall, and launch-verification contract before the hosted UI offers install/update actions.

Dashboard bootstrap admits only exact schema-v2 assets from one official `vercel-labs/openclaw` GitHub Release. Package version, release ref, fork and upstream SHAs, canonical digest, capabilities, asset roles and digests, and Slack package metadata must agree across the asset, capability, contract, release, and external-plugin manifests. Missing, legacy, malformed, oversized, or mismatched assets fail with `OPENCLAW_BUNDLE_COMPATIBILITY_MISMATCH` before sandbox installation.

Required capabilities are `admin-http-rpc-v1`, `cron-projection-v1`, `gateway-suspend-v1`, and `telegram-durable-ack-v1`; required plugin IDs include `admin-http-rpc`, `slack`, and `telegram`. Hosted code gates these paths on admitted capability identity, never release-version guesses.

The sandbox downloads only the manifest-named canonical tarball, verifies its exact bytes and SHA-256, verifies every contained asset before extraction, and installs the verified Slack tarball offline through the OpenClaw plugin installer. It writes the bundle identity receipt only after config and external-plugin installation succeed. Persistent resume requires that receipt and stored metadata to match exactly. An existing sandbox with missing or stale identity fails closed with `OPENCLAW_BUNDLE_MIGRATION_REQUIRED`; the dashboard never deletes sandbox-owned cron or other state as an implicit upgrade step.

Release order matters: publish the exact `@openclaw/slack@<bundle-version>` package before assembling the bundle, then publish and verify the marker-producing bundle, then deploy `vclaw` and dashboard consumers. No older plugin or unverified bundle fallback is supported.

## Dashboard Release

Dashboard changes land in this repository. The canonical CI entrypoint is:

```bash
node scripts/verify.mjs
```

For docs or env-contract changes, also run:

```bash
pnpm check:verify-contract
```

For live operational fixes, verify with runtime surfaces as well as tests: `/api/admin/why-not-ready`, `/api/channels/summary`, `/api/admin/sandbox-diag`, `/api/admin/logs`, and a real channel or launch-verify path when relevant.

## CLI Publish

`@vercel/vclaw` publishes through GitHub trusted publishing. Before release work, audit the package surface from the `vclaw` repository:

```bash
npm pack --dry-run --json
```

The workflow should check tag/version agreement, run tests, and publish with npm provenance. Treat the package allowlist as part of the release contract because `vclaw` is a user-facing global CLI.

## Cross-Repo Compatibility Gates

- `vclaw` bundle resolver finds a GitHub Release with the complete asset set.
- Dashboard bootstrap understands the bundle asset layout.
- The complete verified-bundle environment points at one official release and matches its manifest identity.
- Channel route readiness is tested after OpenClaw plugin/channel runtime changes.
- Documentation does not treat passing CI as proof of live webhook delivery.
- Hosted feature claims stay aligned with `src/shared/hosted-feature-support.ts` and [Hosted Feature Support](hosted-feature-support.md).

## Known Risk Areas

- Deployment Protection can block webhooks before dashboard auth runs.
- Redis env vars can exist before an integration secret is usable at runtime.
- Persistent sandboxes preserve filesystem state across code changes. Moving an existing npm-backed or identity-mismatched sandbox to bundle mode requires an explicit data migration; reset is the destructive fallback only when its state can be discarded.
- AI Gateway auth depends on Vercel OIDC in deployed environments; tokens should be injected through network policy transforms, not written into sandbox config.
- Channel delivery has layered states; connected, delivery-ready, route-ready, accepted, and user-visible are not interchangeable.
