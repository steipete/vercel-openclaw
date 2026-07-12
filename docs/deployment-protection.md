# Deployment Protection and Webhooks

`VERCEL_AUTOMATION_BYPASS_SECRET` is applied opportunistically when configured. The app also performs a runtime self-probe to detect whether Vercel Deployment Protection is actually active on the deployment.

When the self-probe confirms protection is active and no working bypass secret is configured, supported channel connections are hard-blocked (HTTP 409) because Slack and Telegram webhooks cannot reach the app. The missing secret alone (without confirmed protection) remains a warning, not a blocker.

## Channel behavior

All channel webhook URLs for supported hosted channels (Slack and Telegram) include the `x-vercel-protection-bypass` query parameter when `VERCEL_AUTOMATION_BYPASS_SECRET` is configured. This allows those platform callbacks to pass through Vercel Deployment Protection. Hosted Discord is unsupported; its retained endpoint exists only to return a signed fail-closed response for legacy configuration.

## Delivery URLs vs operator-visible URLs

These are intentionally different surfaces:

- Delivery URLs include `x-vercel-protection-bypass` when `VERCEL_AUTOMATION_BYPASS_SECRET` is configured.
- Admin-visible payloads, rendered UI, connectability output, and docs examples must use display URLs that never expose the bypass secret.

Examples:

```
Delivery URL (Slack):    https://app.example.com/api/channels/slack/webhook?x-vercel-protection-bypass=[redacted]
Display URL (Slack):     https://app.example.com/api/channels/slack/webhook
Delivery URL (Telegram): https://app.example.com/api/channels/telegram/webhook?x-vercel-protection-bypass=[redacted]
Display URL (Telegram):  https://app.example.com/api/channels/telegram/webhook
```

In code: use `buildPublicUrl()` only for outbound delivery or registration URLs that may need the bypass secret. Use `buildPublicDisplayUrl()` for admin JSON, UI, diagnostics, docs examples, and any operator-visible surface.

Reachability and readiness are different things.

- **Deployment Protection** decides whether supported Slack and Telegram webhooks can reach the app at all.
- **Preflight** tells you whether the deployment is configured well enough to expose those webhooks.
- **Safe launch verification** proves queue delivery, sandbox boot or resume, and a real completion.
- **Destructive launch verification** adds wake-from-sleep and resume-target preparation.

Run destructive launch verification before treating any channel as ready for real traffic. A deployment is channel-ready only after destructive launch verification passes and `channelReadiness.ready` is `true`.

For the full channel setup and readiness guide, see [Channels and Webhooks](channels-and-webhooks.md).
