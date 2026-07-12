# Slack Debug Sender

This guide describes the operator-only tool for sending real Slack user messages during channel incidents.

The sender uses Slack Web API `chat.postMessage` with an explicitly authorized OAuth user token. It does not use Slack CLI app-management credentials, bot tokens, incoming webhooks, browser cookies, or fake Events API payloads. The goal is to trigger the same Slack Events API path that a real user message triggers: Slack -> `/api/channels/slack/webhook` -> durable Workflow handoff -> sandbox `/slack/events` -> user-visible reply.

For first-time setup in a new workspace or Enterprise Grid org, follow [Slack Debug Sender Setup Guide](slack-debug-sender/GUIDE.md).

## Slack App

Create a small internal Slack app such as `OpenClaw Debug Sender`, or add the user OAuth scopes below to an existing internal debug app. Avoid adding these user scopes to the production OpenClaw receiver app unless the reinstall and approval blast radius is intentional.

Required user scopes:

- `chat:write` — post the debug message as the authorized user.

Optional discovery scopes:

- `channels:read` — list public channel IDs.
- `groups:read` — list private channel IDs.
- `im:read` — list DM IDs.
- `mpim:read` — list multi-person DM IDs.
- `im:write` — open a DM with the OpenClaw bot.
- `users:read` — resolve user IDs.

The main user must explicitly authorize the app and provide the resulting user token through a secret manager. Admin/org URLs prove management context, not permission to send messages as a user.

## Script

Use `scripts/slack-debug-send.mjs` or the package script:

```bash
pnpm slack:debug-send --help
```

The token is accepted only through `SLACK_USER_TOKEN`; do not pass it as an argument.

```bash
set +x
umask 077
export SLACK_USER_TOKEN="$(op read 'op://OpenClaw/Slack Debug Main User/user-token')"
export SLACK_EXPECT_USER_ID="U_MAIN_USER"
export SLACK_EXPECT_ENTERPRISE_ID="E0AU3DH8RFT"
```

Verify the token identity before sending:

```bash
pnpm slack:debug-send auth
```

List accessible conversations when you need a channel ID. For Enterprise Grid or org-level installs, pass the workspace `T...` team ID; the `E...` value from the admin URL is an Enterprise ID, not a message target.

```bash
pnpm slack:debug-send list --team-id "$SLACK_TEAM_ID"
```

Open or reuse a DM with the OpenClaw bot only for DM-specific incidents:

```bash
pnpm slack:debug-send open-dm --user "$OPENCLAW_BOT_USER_ID"
```

Send one real debug message and save sanitized correlation output inside the channel-debug artifact root:

```bash
CHANNEL=slack
RUN_TS="$(date -u +%Y%m%dT%H%M%SZ)"
ART=".agent-runs/channel-debug/$RUN_TS/$CHANNEL"
mkdir -p "$ART"/{admin,vercel,sandbox,workflow,channel}

pnpm slack:debug-send send \
  --channel "$SLACK_CHANNEL_ID" \
  --bot-user "$OPENCLAW_BOT_USER_ID" \
  --artifact-root "$ART" \
  | tee "$ART/channel/slack-send.stdout.json"
```

The sanitized artifact at `$ART/channel/slack-send.sanitized.json` contains the Slack team, Enterprise, user, channel, message timestamp, and `debugId`. It never contains the OAuth token.

## Correlation

Use the `debugId` marker to find the webhook event in the app logs:

```bash
DEBUG_ID="$(jq -r '.correlation.debugId' "$ART/channel/slack-send.sanitized.json")"
curl -sS $APP_AUTH_HEADERS "$URL/api/admin/logs" \
  | tee "$ART/admin/admin-logs-after-send.json" \
  | jq --arg marker "$DEBUG_ID" '.logs[] | select(tostring | contains($marker))'
```

After `channels.slack_webhook_accepted` appears, extract the Slack `event_id` or dedup ID. The native-forward `deliveryId` is usually `slack:<event_id>`. Follow that through `/api/channels/summary`, `channels.forward_attempt`, `channels.forward_outcome`, Vercel Workflow state, and sandbox runtime evidence.

## Safety Rules

- Send one debug message at a time. Honor Slack `Retry-After` on HTTP 429.
- Store user tokens only in a secret manager such as 1Password, Vault, Doppler, or Keychain.
- Keep `SLACK_USER_TOKEN` out of `.env.45`, `.agent-runs`, Vercel logs, shell traces, and handoff markdown.
- Store only sanitized output: team ID, Enterprise ID, user ID, channel ID, message timestamp, and debug marker.
- If the API response contains `message_bot_id`, the post did not behave like a user-authored message; use manual Slack UI fallback.

## Fallbacks

The most faithful fallback is manual Slack UI from the main user with the same debug marker. The safest repeatable automation is a dedicated Slack debug user with its own OAuth user token. Bot-token `chat.postMessage` can test Slack write permissions, but it does not prove the user-message event path because this app skips bot-authored messages.
