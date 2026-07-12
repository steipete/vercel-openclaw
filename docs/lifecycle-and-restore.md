# Sandbox Lifecycle and Restore

The project uses `@vercel/sandbox@^2.0.0-beta` with one named persistent OpenClaw sandbox. The normal lifecycle relies on Sandbox v2 persistent auto-save on stop and explicit resume by name. Every main-sandbox stop, including the legacy manual snapshot endpoint, uses the same cooperative stop controller; it never calls the SDK's direct `snapshot()` path.

## Lifecycle states

The sandbox moves through these states:

| State | Meaning |
| ----- | ------- |
| `uninitialized` | No sandbox has been created yet |
| `creating` | A sandbox is being created (fresh or resumed from stop) and bootstrapped |
| `setup` | Bootstrap is writing config files and installing OpenClaw |
| `booting` | The gateway is starting up |
| `running` | The sandbox is healthy and serving requests |
| `stopped` | The persistent sandbox was stopped; Sandbox v2 auto-saved state and the stable name can be resumed |
| `error` | Something went wrong; may be recoverable |

## What "ensure running" does

Calling ensure does not always mean "create from scratch." The app picks the cheapest path:

- If no sandbox exists yet, it creates one from scratch with `{ name: "oc-xxx", persistent: true }` (full bootstrap).
- If the persistent sandbox exists, npm mode uses `Sandbox.get({ name, resume: true })` for the normal wake path. Bundle mode always discovers with `resume: false` and explicitly resumes only after the stored exact identity is admitted for the current deployment.
- Before bundle-mode fast restore launches Gateway, the host verifies the retained canonical release archive against its admitted digest and compares every executable bundle-owned runtime and plugin tree with that archive. Missing archives are fetched only from the same digest-pinned release URL; byte or version drift fails closed.
- A definitive not-found result falls back to `Sandbox.create({ name, persistent: true, ... })`. Name-conflict and interrupted-candidate recovery also discover with `resume: false`, so identity or ownership checks happen before any wake.
- If the sandbox is already running and healthy, it does nothing.

The work is scheduled with `after()` so the API responds immediately with a waiting state. The browser polls until the sandbox is ready.

Verified bundle bootstrap records a durable candidate identity before running
untrusted setup work. The identity includes a random ownership tag attached to
the Sandbox create request, so a reused persistent name never authorizes deletion
of another generation. The tag rotates after every confirmed delete. Lifecycle
lease renewal and generation-guarded metadata commits prevent an expired function
from deleting or publishing a newer attempt. The host deletes a newly created
candidate if bootstrap fails before the exact receipt is committed, and a retry
replaces any candidate left by an interrupted function. An existing persistent sandbox with a missing
or mismatched bundle receipt is different: the host quiesces it and returns
`OPENCLAW_BUNDLE_MIGRATION_REQUIRED` instead of deleting user state. A failed
quiesce remains visible as `OPENCLAW_BUNDLE_QUIESCE_FAILED` through readiness
polling.

Bundle migration quiescing uses the same durable stop handoff: the host records
the actual discovered sandbox ID and migration intent before the non-blocking
platform request. If the function disappears, the Workflow monitor finishes the
stop and projects `OPENCLAW_BUNDLE_MIGRATION_REQUIRED`; reset can then delete the
preserved sandbox by its real ID.

Bundle mode does not create or promote the experimental hot-spare sandbox. A
hot spare uses a different persistent name and cannot preserve the canonical
bundle generation or its user state safely.

## What stop and snapshot mean today

For the main OpenClaw sandbox, stopping means `sandbox.stop({ blocking: false })` on a persistent sandbox. Vercel Sandbox v2 auto-saves persistent state during stop; the app does not need a manual snapshot ID for normal resume.

`POST /api/admin/snapshot` and `POST /api/admin/snapshots` are compatibility aliases for that cooperative persistent stop. The plural endpoint returns `record: null`; it does not create a manual snapshot-history record. Direct SDK snapshots remain limited to disposable diagnostic sandboxes, not the managed OpenClaw sandbox.

Legacy snapshot-history rows are read/delete-only. Vercel snapshots belong to
the sandbox that produced them, and deleting that sandbox also deletes its
snapshots. A request for the current snapshot is therefore a non-destructive
ensure/wake; a request for a historical snapshot fails with
`HISTORICAL_SNAPSHOT_RESTORE_UNSUPPORTED` before changing metadata or deleting
the current sandbox. A future historical-restore implementation must clone the
target into a separately owned recovery sandbox before retiring its source.

The stop path parks metadata in `snapshotting` before calling `sandbox.stop({ blocking: false })`. That ordering closes the race where a concurrent heartbeat still sees `running` and resumes the sandbox while the stop request is being accepted. While metadata is `snapshotting`, status reconciliation must inspect the sandbox with `Sandbox.get({ resume: false })`; observation must not wake the sandbox being observed. Normal wake uses `Sandbox.get({ resume: true })`.

### Cooperative stop protocol

Cooperative Gateway suspension is capability-gated. The host enables the
`admin-http-rpc` plugin only for an admitted bundle that declares
`admin-http-rpc-v1`. The released npm-package runtime predates that contract;
when the RPC route or suspend methods are absent, the controller preserves its
legacy platform stop/delete behavior and does not leave a synthetic Gateway
fence behind.

With the admitted capability, before any irreversible platform stop or reset,
the host:

1. persists a host-suspension operation and fences app-owned ingress;
2. calls the loopback-only OpenClaw Admin RPC `gateway.suspend.prepare` with a stable request ID;
3. refuses the operation when OpenClaw reports active work;
4. persists cron state and cleanup, renews the OpenClaw suspension lease, then records an absolute stop-request deadline;
5. requests the non-blocking Sandbox stop and leaves reconciliation to a durable Workflow monitor.

The monitor adopts interrupted operations by operation ID, renews the Gateway lease while the platform is transitional, and only records `stopped` after the SDK confirms a terminal stop. An ambiguous SDK response stays fenced. If the SDK remains `running` after the bounded request/grace window, the controller resumes Gateway admission before reopening host ingress. Reset uses the same prepare gate and then deletes directly because reset intentionally discards persistent state.

Wake readiness is admission-aware: the host first verifies Control UI liveness,
resumes any persisted Gateway suspension, and then requires `/readyz` to return
success. A live but still-draining Gateway is never published as ready.

Authenticated host mutations share the lifecycle lock. This makes mutation versus stop ordering explicit: the mutation completes first and stop waits/refuses, or the lifecycle transition wins and the mutation receives a retryable fence response. Gateway and channel ingress check the durable fence after their own authentication checks.

### Desired-idle deadline and platform runway

The durable deadline Workflow owns idle stop timing. Heartbeats move one deadline for the current sandbox generation; duplicate same-generation Workflow starts converge under the coordinator lock. Workflow creation happens while the coordinator lock is held, and the deadline plus run ID are persisted together. A process death can therefore leave only an orphan Workflow, which exits on its generation check, never a persisted deadline without a repair owner. At the deadline, the coordinator extends the native Sandbox timeout before attempting cooperative stop. Busy OpenClaw work is retried instead of interrupted.

The portable Sandbox timeout ceiling is 45 minutes. The configured desired idle window is therefore capped at 40 minutes, reserving five minutes of native timeout runway for Workflow scheduling, busy refusal, lease renewal, and stop acceptance. The native timeout remains a final safety net, not the primary idle controller.

### Measuring snapshot duration

Unit tests use `FakeSandboxHandle`, so they prove host fencing, Gateway prepare/resume behavior, metadata parking, deadline generation guards, polling, and terminal projection. They do not measure Vercel's real snapshot duration.

Use `scripts/bench-stop-cycle.mjs` for manual ops measurements against a deployed app. Run enough completed cycles for each workload, and prefer `--sdk-poll` so the benchmark records the platform status separately from the app's 5-minute stale guardrail.

For local linked-project measurements that bypass the app entirely, use `scripts/bench-sdk-snapshot.mjs`. It creates disposable persistent sandboxes through `@vercel/sandbox`, can download the same bundle artifacts used by `vclaw create`, and measures the SDK stop result directly.

Example:

```bash
ADMIN_SECRET=... node scripts/bench-stop-cycle.mjs \
  --base-url https://your-app.vercel.app \
  --cycles=20 \
  --workload=home-small \
  --sdk-poll
```

The useful fields are `platformSnapshottingDurationMs` and `platformStopToStoppedMs`. App-only fields can be lower-bounded or guardrail-capped if the host force-reconciles before the platform actually leaves `snapshotting`.

If app status remains `snapshotting` while `--sdk-poll` reports platform `running`, treat that as a lifecycle bug or an accidental SDK resume, not as measured snapshot duration.

Local bundle example:

```bash
node --env-file=.env.local scripts/bench-sdk-snapshot.mjs \
  --cycles=1 \
  --workload=bundle \
  --bundle-url https://duiylqr0ujvwgwtm.public.blob.vercel-storage.com/openclaw.bundle.mjs \
  --start-bundle \
  --bundle-run-ms=30000
```

## Resume fast path

Resuming a persistent sandbox from stop is faster than creating from scratch (~10s vs full bootstrap) because most of the sandbox state is preserved automatically by v2. The resume path splits files into two groups to avoid redundant work.

### Static resume assets

These are files that only change when the app version changes: the startup script, force-pair script, skill markdown, skill scripts, and the built-in image-gen override.

Static assets are only rewritten when the restore asset hash (`assetSha256`) has changed since the last resume. If the app version has not changed, these uploads are skipped entirely.

### Dynamic resume assets

These are files that change with runtime configuration, primarily `openclaw.json`. Dynamic files are always checked against the current desired state using a config hash comparison.

### Credential brokering

The preferred AI Gateway credential path is host-controlled network policy `transform` rules that add an `Authorization: Bearer <token>` header to outbound requests to `ai-gateway.vercel.sh`. Token refresh updates the network policy with `sandbox.update({ networkPolicy })`; it does not rewrite files or restart the gateway.

Current bootstrap still has a compatibility exception: `buildRuntimeEnv()` may pass `AI_GATEWAY_API_KEY`/`OPENAI_API_KEY` into sandbox creation env when a token is available, while also setting `OPENAI_BASE_URL` for AI Gateway. Treat the network policy as the enforcement boundary, but do not claim the credential never exists inside the VM until that env fallback is removed.

### Readiness checks

Resume readiness is checked in two stages:

1. **Local-first readiness** — `curl http://localhost:3000/` inside the sandbox checks whether the gateway process started (accepts any HTTP response, not just 200 with a specific marker).
2. **Public readiness** — a fetch through the proxied app route checks whether the proxy, DNS, and public networking all work.

This separation makes it easy to tell whether a failure is inside the sandbox or in the path between the sandbox and the outside world.

## Cron wake behavior

OpenClaw remains the only authority for cron jobs and due checks. The hosted app projects only wake times:

1. **After the capability-owned baseline:** a legacy `cron-projection-v1` bundle adopts its scheduler from `gateway_start`. A `cron-projection-v2` bundle waits for the complete `cron_reconciled` snapshot, whose abort signal fences that exact scheduler generation. The modes are exclusive, v2 wins when both are declared, and premature `cron_changed` hints cannot establish a v2 baseline. The plugin lists the adopted scheduler and posts a bounded snapshot of the earliest 4,096 wake times plus credential-keyed job hashes to the authenticated host endpoint.
2. **After job changes:** `cron_changed` is a coalesced hint to reread the adopted scheduler. Event deltas are never treated as ordered state.
3. **On host acceptance:** the endpoint atomically replaces the sanitized Redis projection. Job IDs are keyed-hashed inside the sandbox before transmission; job names, prompts, payloads, delivery targets, and other job configuration never enter the host store.
4. **For the earliest wake:** Vercel Workflow sleeps until the projected time. Its step rereads the Redis projection and atomically claims the current revision and dispatch token before resuming the sandbox. Superseded workflows become no-ops.
5. **On watchdog runs:** the watchdog repairs a missing, failed, or stale Workflow dispatch and exposes sanitized projection diagnostics. It does not independently decide that a cron job is due.

The wake extends the current sandbox session through a 15-minute post-due safety window, covering OpenClaw's default 10-minute command timeout. Longer agent runs remain constrained by the Vercel plan's per-session maximum and are not yet a supported hosted cron guarantee.

The migration from the former `cron-next-wake-ms` / `cron-jobs-json` keys is gated on an exact verified bundle identity declaring `cron-projection-v1` or `cron-projection-v2`. It imports only the old earliest wake as a temporary fallback. If only the legacy jobs key exists for a resumable sleeping sandbox, key presence can arm one immediate bootstrap wake without reading or importing its payload. An authoritative plugin baseline retires the old wake key, but the jobs backup remains until an explicit verified data migration or destructive reset owns its removal.

Enabling bundle mode does not authorize replacing an existing persistent sandbox. Missing or stale bundle identity fails with `OPENCLAW_BUNDLE_MIGRATION_REQUIRED` so OpenClaw-owned cron state stays intact; use an explicit verified migration, or reset only when discarding the sandbox is intentional.

Sandbox reset rotates the internal gateway credential and generation-fences the projection before a replacement sandbox can start. Delayed snapshots from the destroyed sandbox therefore remain stale even when host and sandbox clocks differ.

## Resume-prepared state

A sandbox can be "running" right now but still not be a good future resume target. The app tracks this separately. With v2 persistent sandboxes, the saved state is keyed by the persistent sandbox name, but its config/assets may not match the current deployment.

### Statuses

| Status | Meaning |
| ------ | ------- |
| `unknown` | No information yet |
| `dirty` | The persistent sandbox state does not match the desired config |
| `preparing` | A prepare cycle is in progress |
| `ready` | The sandbox is a verified reusable resume target |
| `failed` | Preparation was attempted and failed |

Before the persistent stop, preparation stores the verified config and asset
hashes as a pending attestation. The synchronous caller waits only within its
absolute function budget. If Vercel finishes the stop later, durable status
reconciliation promotes that pending attestation to `ready`; a timed-out
function is not required to resume and repeat the preparation.

### Reasons

Common reasons for the current status:

- `persisted-state-missing` — there is no saved persistent state to evaluate
- `persisted-state-config-stale` — saved dynamic config does not match the desired config
- `persisted-state-assets-stale` — saved static assets do not match the desired app version
- `dynamic-config-changed` — runtime config has drifted since the sandbox was last stopped
- `static-assets-changed` — app version changed and static assets no longer match
- `deployment-changed` — the deployment itself has changed
- `prepare-failed` — a prepare attempt did not succeed
- `prepared` — the sandbox state matches desired config and is verified

### Example metadata

```json
{
  "restorePreparedStatus": "ready",
  "restorePreparedReason": "prepared",
  "persistedStateDynamicConfigHash": "abc123",
  "persistedStateAssetSha256": "def456",
  "persistedStateSavedAt": 1778269200000,
  "persistedStateSource": "persistent-auto-save",
  "runtimeDynamicConfigHash": "abc123",
  "runtimeAssetSha256": "def456"
}
```

### Why this matters

Launch verification and the watchdog both use resume-prepared state to decide whether the persistent sandbox is safe to resume. A stale sandbox that would boot with the wrong config is worse than a fresh create, because the sandbox would come up in a misconfigured state that is hard to diagnose.

## Where to read next

- [Preflight and Launch Verification](preflight-and-launch-verification.md) — how the app proves config and runtime readiness
- [API Reference](api-reference.md) — the exact request and response shapes for lifecycle endpoints
