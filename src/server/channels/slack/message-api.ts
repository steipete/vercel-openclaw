import { RetryableSendError } from "@/server/channels/core/types";
import { logInfo } from "@/server/log";

const SLACK_DELETE_MESSAGE_URL = "https://slack.com/api/chat.delete";
const SLACK_UPDATE_MESSAGE_URL = "https://slack.com/api/chat.update";
const SLACK_REQUEST_TIMEOUT_MS = 15_000;

type SlackMessageResponse = {
  ok?: boolean;
  error?: string;
};

type SlackMessagePayload = {
  text: string;
  blocks?: unknown[];
};

function isLikelyNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econn") ||
    message.includes("enotfound") ||
    message.includes("socket")
  );
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function retryableError(
  message: string,
  retryAfterSeconds?: number,
  cause?: unknown,
): RetryableSendError {
  return new RetryableSendError(message, { retryAfterSeconds, cause });
}

export async function updateProcessingPlaceholder(
  botToken: string,
  channel: string,
  ts: string,
  textOrPayload: string | SlackMessagePayload,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<void> {
  const message =
    typeof textOrPayload === "string"
      ? { text: textOrPayload }
      : textOrPayload;
  let response: Response;
  try {
    response = await fetchFn(SLACK_UPDATE_MESSAGE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${botToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ channel, ts, ...message }),
      signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (isLikelyNetworkError(error)) {
      throw retryableError(
        `slack_processing_placeholder_update_network: ${
          error instanceof Error ? error.message : String(error)
        }`,
        undefined,
        error,
      );
    }
    throw error;
  }

  const payload = (await response.json().catch(() => null)) as
    | SlackMessageResponse
    | null;
  if (response.status === 429 || response.status >= 500) {
    throw retryableError(
      `slack_processing_placeholder_update_retryable status=${response.status}`,
      parseRetryAfterSeconds(response.headers.get("retry-after")),
    );
  }
  const detail = typeof payload?.error === "string" ? payload.error : "";
  if (!response.ok || payload?.ok !== true) {
    throw new Error(
      detail
        ? `slack_processing_placeholder_update_failed: status=${response.status} error=${detail}`
        : `slack_processing_placeholder_update_failed: status=${response.status}`,
    );
  }
  logInfo("channels.slack_processing_placeholder_updated", { channel, ts });
}

export async function deleteSlackMessage(input: {
  botToken: string;
  channel: string;
  ts: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): Promise<void> {
  const fetchFn = input.fetchFn ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchFn(SLACK_DELETE_MESSAGE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.botToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ channel: input.channel, ts: input.ts }),
      signal: AbortSignal.timeout(
        input.timeoutMs ?? SLACK_REQUEST_TIMEOUT_MS,
      ),
    });
  } catch (error) {
    if (isLikelyNetworkError(error)) {
      throw retryableError(
        `slack_message_delete_network: ${
          error instanceof Error ? error.message : String(error)
        }`,
        undefined,
        error,
      );
    }
    throw error;
  }

  const payload = (await response.json().catch(() => null)) as
    | SlackMessageResponse
    | null;
  if (response.status === 429 || response.status >= 500) {
    throw retryableError(
      `slack_message_delete_retryable status=${response.status}`,
      parseRetryAfterSeconds(response.headers.get("retry-after")),
    );
  }
  const detail = typeof payload?.error === "string" ? payload.error : "";
  if (detail === "message_not_found") {
    logInfo("channels.slack_processing_placeholder_already_gone", {
      channel: input.channel,
      ts: input.ts,
    });
    return;
  }
  if (!response.ok || payload?.ok !== true) {
    throw new Error(
      detail
        ? `slack_message_delete_failed: status=${response.status} error=${detail}`
        : `slack_message_delete_failed: status=${response.status}`,
    );
  }
  logInfo("channels.slack_processing_placeholder_deleted", {
    channel: input.channel,
    ts: input.ts,
  });
}
