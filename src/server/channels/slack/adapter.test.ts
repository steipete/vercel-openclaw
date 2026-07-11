import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import { RetryableSendError } from "@/server/channels/core/types";
import type { ChannelReply } from "@/server/channels/core/types";
import {
  createSlackAdapter,
  deleteSlackMessage,
  getSlackUrlVerificationChallenge,
  isValidSlackSignature,
} from "@/server/channels/slack/adapter";
import type { SlackExtractedMessage } from "@/server/channels/slack/adapter";
import {
  _resetLogBuffer,
  getFilteredServerLogs,
} from "@/server/log";

test("isValidSlackSignature validates a correctly signed request", () => {
  const signingSecret = "secret";
  const rawBody = JSON.stringify({ type: "event_callback" });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex");

  assert.equal(
    isValidSlackSignature({
      signingSecret,
      rawBody,
      signatureHeader: `v0=${digest}`,
      timestampHeader: timestamp,
    }),
    true,
  );

  assert.equal(
    isValidSlackSignature({
      signingSecret,
      rawBody,
      signatureHeader: "v0=bad",
      timestampHeader: timestamp,
    }),
    false,
  );
});

test("getSlackUrlVerificationChallenge returns the challenge string", () => {
  assert.equal(
    getSlackUrlVerificationChallenge({
      type: "url_verification",
      challenge: "abc123",
    }),
    "abc123",
  );
});

test("createSlackAdapter extracts a basic threadable message", async () => {
  const adapter = createSlackAdapter({
    signingSecret: "secret",
    botToken: "xoxb-token",
  });

  const result = await adapter.extractMessage({
    type: "event_callback",
    event: {
      type: "message",
      text: "hello from slack",
      channel: "C123",
      ts: "123.45",
      user: "U123",
    },
  });

  assert.equal(result.kind, "message");
  if (result.kind !== "message") {
    return;
  }

  assert.equal(result.message.text, "hello from slack");
  assert.equal(result.message.channel, "C123");
  assert.equal(result.message.threadTs, "123.45");
});

test("createSlackAdapter sendReply throws RetryableSendError when Slack rate limits", async () => {
  const adapter = createSlackAdapter(
    {
      signingSecret: "secret",
      botToken: "xoxb-token",
    },
    {
      fetchFn: async () =>
        new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
          status: 429,
          headers: {
            "retry-after": "7",
          },
        }),
    },
  );

  await assert.rejects(
    adapter.sendReply(
      {
        text: "hello from slack",
        channel: "C123",
        threadTs: "123.45",
        ts: "123.45",
      },
      "reply text",
    ),
    (error) => {
      assert.ok(error instanceof RetryableSendError);
      assert.equal(error.retryAfterSeconds, 7);
      return true;
    },
  );
});

test("createSlackAdapter startProcessingIndicator posts and deletes a thinking placeholder", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

  const adapter = createSlackAdapter(
    {
      signingSecret: "secret",
      botToken: "xoxb-token",
    },
    {
      fetchFn: async (input, init) => {
        fetchCalls.push({ input, init });

        if (String(input).includes("chat.postMessage")) {
          return new Response(JSON.stringify({ ok: true, ts: "999.01" }), {
            status: 200,
          });
        }

        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
        });
      },
    },
  );

  const message: SlackExtractedMessage = {
    text: "hello from slack",
    channel: "C123",
    threadTs: "123.45",
    ts: "123.45",
  };

  const indicator = await adapter.startProcessingIndicator?.(message);

  assert.equal(message.processingPlaceholderTs, "999.01");
  assert.equal(fetchCalls.length, 1);
  assert.ok(String(fetchCalls[0].input).includes("chat.postMessage"));

  const postBody = JSON.parse(fetchCalls[0].init?.body as string);
  assert.equal(postBody.text, "_Thinking..._");
  assert.equal(postBody.channel, "C123");
  assert.equal(postBody.thread_ts, "123.45");

  await indicator?.stop();

  assert.equal(message.processingPlaceholderTs, undefined);
  assert.equal(fetchCalls.length, 2);
  assert.ok(String(fetchCalls[1].input).includes("chat.delete"));

  const deleteBody = JSON.parse(fetchCalls[1].init?.body as string);
  assert.equal(deleteBody.channel, "C123");
  assert.equal(deleteBody.ts, "999.01");
});

test("createSlackAdapter startProcessingIndicator stop() tolerates message_not_found", async () => {
  const adapter = createSlackAdapter(
    {
      signingSecret: "secret",
      botToken: "xoxb-token",
    },
    {
      fetchFn: async (input) => {
        if (String(input).includes("chat.postMessage")) {
          return new Response(JSON.stringify({ ok: true, ts: "999.02" }), {
            status: 200,
          });
        }

        return new Response(
          JSON.stringify({ ok: false, error: "message_not_found" }),
          { status: 200 },
        );
      },
    },
  );

  const message: SlackExtractedMessage = {
    text: "hello",
    channel: "C123",
    threadTs: "123.45",
    ts: "123.45",
  };

  const indicator = await adapter.startProcessingIndicator?.(message);
  // Should not throw despite message_not_found
  await indicator?.stop();
  assert.equal(message.processingPlaceholderTs, undefined);
});

test("deleteSlackMessage rejects HTTP 200 Slack API failures", async () => {
  await assert.rejects(
    deleteSlackMessage({
      botToken: "xoxb-token",
      channel: "C123",
      ts: "999.04",
      fetchFn: async () =>
        Response.json({ ok: false, error: "not_authed" }),
    }),
    /slack_message_delete_failed: status=200 error=not_authed/,
  );
});

test("createSlackAdapter startProcessingIndicator stop() is idempotent", async () => {
  let deleteCalls = 0;

  const adapter = createSlackAdapter(
    {
      signingSecret: "secret",
      botToken: "xoxb-token",
    },
    {
      fetchFn: async (input) => {
        if (String(input).includes("chat.postMessage")) {
          return new Response(JSON.stringify({ ok: true, ts: "999.03" }), {
            status: 200,
          });
        }
        if (String(input).includes("chat.delete")) {
          deleteCalls += 1;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    },
  );

  const message: SlackExtractedMessage = {
    text: "hello",
    channel: "C123",
    threadTs: "123.45",
    ts: "123.45",
  };

  const indicator = await adapter.startProcessingIndicator?.(message);
  await indicator?.stop();
  await indicator?.stop();
  // Second stop() should be a no-op since processingPlaceholderTs was cleared
  assert.equal(deleteCalls, 1);
});

test("createSlackAdapter extractMessage returns empty history and logs when thread fetch fails", async () => {
  _resetLogBuffer();

  const adapter = createSlackAdapter(
    {
      signingSecret: "secret",
      botToken: "xoxb-token",
    },
    {
      fetchFn: async () => {
        throw new Error("network down");
      },
    },
  );

  try {
    const result = await adapter.extractMessage({
      type: "event_callback",
      event: {
        type: "message",
        text: "thread reply",
        channel: "C123",
        ts: "124.56",
        thread_ts: "123.45",
        user: "U123",
      },
    });

    assert.equal(result.kind, "message");
    if (result.kind !== "message") {
      return;
    }

    assert.deepEqual(result.message.history, []);

    const [entry] = getFilteredServerLogs({
      search: "channels.slack_history_fetch_failed",
    });
    assert.ok(entry);
    assert.equal(entry.message, "channels.slack_history_fetch_failed");
    assert.deepEqual(entry.data, {
      channel: "C123",
      threadTs: "123.45",
      reason: "request_failed",
      error: "network down",
    });
  } finally {
    _resetLogBuffer();
  }
});

test("createSlackAdapter extractMessage omits the processing placeholder from thread history", async () => {
  const adapter = createSlackAdapter(
    {
      signingSecret: "secret",
      botToken: "xoxb-token",
    },
    {
      fetchFn: async (input) => {
        assert.ok(String(input).includes("conversations.replies"));
        return new Response(
          JSON.stringify({
            ok: true,
            messages: [
              { text: "hello", ts: "123.45", user: "U123" },
              {
                text: "_Thinking..._",
                ts: "123.46",
                bot_id: "B123",
                subtype: "bot_message",
              },
              {
                text: "real answer",
                ts: "123.47",
                bot_id: "B123",
                subtype: "bot_message",
              },
              { text: "follow-up", ts: "123.48", user: "U123" },
            ],
          }),
          { status: 200 },
        );
      },
    },
  );

  const result = await adapter.extractMessage({
    type: "event_callback",
    event: {
      type: "message",
      text: "follow-up",
      channel: "C123",
      ts: "123.48",
      thread_ts: "123.45",
      user: "U123",
    },
  });

  assert.equal(result.kind, "message");
  if (result.kind !== "message") {
    return;
  }

  assert.deepEqual(result.message.history, [
    { role: "user", content: "hello" },
    { role: "assistant", content: "real answer" },
  ]);
});

test("createSlackAdapter sendReply updates an existing processing placeholder in place", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

  const adapter = createSlackAdapter(
    {
      signingSecret: "secret",
      botToken: "xoxb-token",
    },
    {
      fetchFn: async (input, init) => {
        fetchCalls.push({ input, init });
        return new Response(JSON.stringify({ ok: true, ts: "999.01" }), {
          status: 200,
        });
      },
    },
  );

  const message: SlackExtractedMessage = {
    text: "hello",
    channel: "C123",
    threadTs: "123.45",
    ts: "123.45",
    processingPlaceholderTs: "999.01",
  };

  await adapter.sendReply(message, "reply text");

  assert.equal(message.processingPlaceholderTs, undefined);
  assert.equal(fetchCalls.length, 1);
  assert.ok(String(fetchCalls[0]?.input).includes("chat.update"));
  assert.deepEqual(JSON.parse(fetchCalls[0]?.init?.body as string), {
    channel: "C123",
    ts: "999.01",
    text: "reply text",
  });
});

test("createSlackAdapter sendReply falls back to post plus delete when placeholder update cannot be applied", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

  const adapter = createSlackAdapter(
    {
      signingSecret: "secret",
      botToken: "xoxb-token",
    },
    {
      fetchFn: async (input, init) => {
        fetchCalls.push({ input, init });

        if (String(input).includes("chat.update")) {
          return new Response(
            JSON.stringify({ ok: false, error: "message_not_found" }),
            { status: 200 },
          );
        }

        if (String(input).includes("chat.postMessage")) {
          return new Response(JSON.stringify({ ok: true, ts: "1000.01" }), {
            status: 200,
          });
        }

        if (String(input).includes("chat.delete")) {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
          });
        }

        throw new Error(`unexpected Slack URL: ${String(input)}`);
      },
    },
  );

  const message: SlackExtractedMessage = {
    text: "hello",
    channel: "C123",
    threadTs: "123.45",
    ts: "123.45",
    processingPlaceholderTs: "999.01",
  };

  await adapter.sendReply(message, "reply text");

  assert.equal(message.processingPlaceholderTs, undefined);
  assert.equal(fetchCalls.length, 3);
  assert.ok(String(fetchCalls[0]?.input).includes("chat.update"));
  assert.ok(String(fetchCalls[1]?.input).includes("chat.postMessage"));
  assert.ok(String(fetchCalls[2]?.input).includes("chat.delete"));
});

test("createSlackAdapter sendReply propagates non-retryable chat.update errors without fallback", async () => {
  const adapter = createSlackAdapter(
    {
      signingSecret: "secret",
      botToken: "xoxb-token",
    },
    {
      fetchFn: async (input) => {
        if (String(input).includes("chat.update")) {
          return new Response(
            JSON.stringify({ ok: false, error: "channel_not_found" }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    },
  );

  const message: SlackExtractedMessage = {
    text: "hello",
    channel: "C123",
    threadTs: "123.45",
    ts: "123.45",
    processingPlaceholderTs: "999.01",
  };

  await assert.rejects(
    adapter.sendReply(message, "reply text"),
    (error) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes("error=channel_not_found"));
      return true;
    },
  );
});

test("createSlackAdapter sendReply without placeholder posts normally", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL }> = [];

  const adapter = createSlackAdapter(
    {
      signingSecret: "secret",
      botToken: "xoxb-token",
    },
    {
      fetchFn: async (input) => {
        fetchCalls.push({ input });
        return new Response(JSON.stringify({ ok: true, ts: "1000.01" }), {
          status: 200,
        });
      },
    },
  );

  const message: SlackExtractedMessage = {
    text: "hello",
    channel: "C123",
    threadTs: "123.45",
    ts: "123.45",
  };

  await adapter.sendReply(message, "reply text");

  assert.equal(fetchCalls.length, 1);
  assert.ok(String(fetchCalls[0]?.input).includes("chat.postMessage"));
});

// ---------------------------------------------------------------------------
// sendReplyRich — generic media upload
// ---------------------------------------------------------------------------

test("createSlackAdapter sendReplyRich uploads audio media as a file", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

  const adapter = createSlackAdapter(
    {
      signingSecret: "secret",
      botToken: "xoxb-token",
    },
    {
      fetchFn: async (input, init) => {
        fetchCalls.push({ input, init });

        if (String(input).includes("chat.postMessage")) {
          return new Response(JSON.stringify({ ok: true, ts: "1000.01" }), {
            status: 200,
          });
        }
        if (String(input).includes("getUploadURLExternal")) {
          return new Response(
            JSON.stringify({ ok: true, upload_url: "https://files.slack.com/upload/v1/abc", file_id: "F123" }),
            { status: 200 },
          );
        }
        if (String(input).includes("files.slack.com")) {
          return new Response("OK", { status: 200 });
        }
        if (String(input).includes("completeUploadExternal")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }

        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    },
  );

  const message: SlackExtractedMessage = {
    text: "hello",
    channel: "C123",
    threadTs: "123.45",
    ts: "123.45",
  };

  const reply: ChannelReply = {
    text: "Here is the audio.",
    media: [
      {
        type: "audio",
        source: {
          kind: "data",
          mimeType: "audio/mpeg",
          base64: "SUQzBAAAAAAA",
          filename: "answer.mp3",
        },
      },
    ],
  };

  await adapter.sendReplyRich!(message, reply);

  // Should have: postMessage + getUploadURL + upload + completeUpload
  assert.ok(fetchCalls.some((c) => String(c.input).includes("chat.postMessage")), "should post text");
  assert.ok(fetchCalls.some((c) => String(c.input).includes("getUploadURLExternal")), "should get upload URL");
  assert.ok(fetchCalls.some((c) => String(c.input).includes("completeUploadExternal")), "should complete upload");
});

test("createSlackAdapter sendReplyRich uploads generic file (pdf) as a file", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

  const adapter = createSlackAdapter(
    {
      signingSecret: "secret",
      botToken: "xoxb-token",
    },
    {
      fetchFn: async (input, init) => {
        fetchCalls.push({ input, init });

        if (String(input).includes("chat.postMessage")) {
          return new Response(JSON.stringify({ ok: true, ts: "1000.01" }), { status: 200 });
        }
        if (String(input).includes("getUploadURLExternal")) {
          return new Response(
            JSON.stringify({ ok: true, upload_url: "https://files.slack.com/upload/v1/abc", file_id: "F456" }),
            { status: 200 },
          );
        }
        if (String(input).includes("files.slack.com")) {
          return new Response("OK", { status: 200 });
        }
        if (String(input).includes("completeUploadExternal")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }

        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    },
  );

  const message: SlackExtractedMessage = {
    text: "hello",
    channel: "C123",
    threadTs: "123.45",
    ts: "123.45",
  };

  const reply: ChannelReply = {
    text: "Report attached.",
    media: [
      {
        type: "file",
        source: {
          kind: "data",
          mimeType: "application/pdf",
          base64: "JVBERi0xLjQK",
          filename: "report.pdf",
        },
      },
    ],
  };

  await adapter.sendReplyRich!(message, reply);

  assert.ok(fetchCalls.some((c) => String(c.input).includes("chat.postMessage")), "should post text");
  assert.ok(fetchCalls.some((c) => String(c.input).includes("getUploadURLExternal")), "should get upload URL");
  assert.ok(fetchCalls.some((c) => String(c.input).includes("completeUploadExternal")), "should complete upload");
});

test("createSlackAdapter sendReplyRich image regression — existing data image upload still works", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

  const adapter = createSlackAdapter(
    {
      signingSecret: "secret",
      botToken: "xoxb-token",
    },
    {
      fetchFn: async (input, init) => {
        fetchCalls.push({ input, init });

        if (String(input).includes("chat.postMessage")) {
          return new Response(JSON.stringify({ ok: true, ts: "1000.01" }), { status: 200 });
        }
        if (String(input).includes("getUploadURLExternal")) {
          return new Response(
            JSON.stringify({ ok: true, upload_url: "https://files.slack.com/upload/v1/abc", file_id: "F789" }),
            { status: 200 },
          );
        }
        if (String(input).includes("files.slack.com")) {
          return new Response("OK", { status: 200 });
        }
        if (String(input).includes("completeUploadExternal")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }

        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    },
  );

  const message: SlackExtractedMessage = {
    text: "hello",
    channel: "C123",
    threadTs: "123.45",
    ts: "123.45",
  };

  // Use legacy images field (no media)
  const reply: ChannelReply = {
    text: "Chart ready.",
    images: [
      {
        kind: "data",
        mimeType: "image/png",
        base64: "iVBORw0KGgo=",
        filename: "chart.png",
      },
    ],
  };

  await adapter.sendReplyRich!(message, reply);

  assert.ok(fetchCalls.some((c) => String(c.input).includes("chat.postMessage")), "should post text");
  assert.ok(fetchCalls.some((c) => String(c.input).includes("getUploadURLExternal")), "should get upload URL for image");
  assert.ok(fetchCalls.some((c) => String(c.input).includes("completeUploadExternal")), "should complete image upload");
});

test("createSlackAdapter sendReplyRich treats transient image upload failures as retryable", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

  const adapter = createSlackAdapter(
    {
      signingSecret: "secret",
      botToken: "xoxb-token",
    },
    {
      fetchFn: async (input, init) => {
        fetchCalls.push({ input, init });

        if (String(input).includes("chat.postMessage")) {
          return new Response(JSON.stringify({ ok: true, ts: "1000.01" }), { status: 200 });
        }
        if (String(input).includes("getUploadURLExternal")) {
          return new Response(
            JSON.stringify({ ok: true, upload_url: "https://files.slack.com/upload/v1/abc", file_id: "F789" }),
            { status: 200 },
          );
        }
        if (String(input).includes("files.slack.com")) {
          return new Response("temporary gateway timeout", { status: 504 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    },
  );

  const message: SlackExtractedMessage = {
    text: "hello",
    channel: "C123",
    threadTs: "123.45",
    ts: "123.45",
  };

  const reply: ChannelReply = {
    text: "Chart ready.",
    images: [
      {
        kind: "data",
        mimeType: "image/png",
        base64: "iVBORw0KGgo=",
        filename: "chart.png",
      },
    ],
  };

  await assert.rejects(
    adapter.sendReplyRich!(message, reply),
    (error) => {
      assert.ok(error instanceof RetryableSendError);
      assert.match(error.message, /slack_upload_transfer_failed: status=504/);
      return true;
    },
  );

  const completeCalls = fetchCalls.filter((c) => String(c.input).includes("completeUploadExternal"));
  assert.equal(completeCalls.length, 0, "should not complete a failed upload");
});


test("createSlackAdapter sendReplyRich retries HTTP 504 transfer and completes in thread", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  let uploadUrlCalls = 0;
  let transferCalls = 0;

  const adapter = createSlackAdapter(
    { signingSecret: "secret", botToken: "xoxb-token" },
    {
      fetchFn: async (input, init) => {
        fetchCalls.push({ input, init });
        const url = String(input);
        if (url.includes("chat.postMessage")) {
          return new Response(JSON.stringify({ ok: true, ts: "1000.01" }), { status: 200 });
        }
        if (url.includes("getUploadURLExternal")) {
          uploadUrlCalls += 1;
          return new Response(
            JSON.stringify({
              ok: true,
              upload_url: `https://files.slack.com/upload/v1/retry-${uploadUrlCalls}`,
              file_id: `FRETRY${uploadUrlCalls}`,
            }),
            { status: 200 },
          );
        }
        if (url.includes("files.slack.com")) {
          transferCalls += 1;
          return new Response(transferCalls === 1 ? "gateway timeout" : "OK", {
            status: transferCalls === 1 ? 504 : 200,
          });
        }
        if (url.includes("completeUploadExternal")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        throw new Error(`unexpected Slack URL: ${url}`);
      },
    },
  );

  const message: SlackExtractedMessage = {
    text: "hello",
    channel: "D0B3416DCF4",
    threadTs: "1778530504.140709",
    ts: "1778530504.140709",
  };

  await adapter.sendReplyRich!(message, {
    text: "Chart ready.",
    images: [{ kind: "data", mimeType: "image/png", base64: "iVBORw0KGgo=", filename: "chart.png" }],
  });

  assert.equal(uploadUrlCalls, 2);
  assert.equal(transferCalls, 2);
  const completeCalls = fetchCalls.filter((c) => String(c.input).includes("completeUploadExternal"));
  assert.equal(completeCalls.length, 1);
  assert.deepEqual(JSON.parse(completeCalls[0]?.init?.body as string), {
    files: [{ id: "FRETRY2", title: "chart.png" }],
    channel_id: "D0B3416DCF4",
    thread_ts: "1778530504.140709",
  });
});

test("createSlackAdapter sendReplyRich retries complete upload with same thread payload", async () => {
  const completeBodies: unknown[] = [];
  let completeCalls = 0;

  const adapter = createSlackAdapter(
    { signingSecret: "secret", botToken: "xoxb-token" },
    {
      fetchFn: async (input, init) => {
        const url = String(input);
        if (url.includes("chat.postMessage")) {
          return new Response(JSON.stringify({ ok: true, ts: "1000.01" }), { status: 200 });
        }
        if (url.includes("getUploadURLExternal")) {
          return new Response(
            JSON.stringify({ ok: true, upload_url: "https://files.slack.com/upload/v1/abc", file_id: "F123" }),
            { status: 200 },
          );
        }
        if (url.includes("files.slack.com")) {
          return new Response("OK", { status: 200 });
        }
        if (url.includes("completeUploadExternal")) {
          completeCalls += 1;
          completeBodies.push(JSON.parse(init?.body as string));
          return new Response(JSON.stringify({ ok: completeCalls > 1 }), {
            status: completeCalls === 1 ? 504 : 200,
          });
        }
        throw new Error(`unexpected Slack URL: ${url}`);
      },
    },
  );

  await adapter.sendReplyRich!(
    { text: "hello", channel: "D0B3416DCF4", threadTs: "1778530504.140709", ts: "1778530504.140709" },
    { text: "Chart ready.", images: [{ kind: "data", mimeType: "image/png", base64: "iVBORw0KGgo=", filename: "chart.png" }] },
  );

  assert.equal(completeCalls, 2);
  assert.deepEqual(completeBodies[0], completeBodies[1]);
  assert.deepEqual(completeBodies[0], {
    files: [{ id: "F123", title: "chart.png" }],
    channel_id: "D0B3416DCF4",
    thread_ts: "1778530504.140709",
  });
});

test("createSlackAdapter sendReplyRich does not retry non-retryable upload failure", async () => {
  let uploadUrlCalls = 0;
  let transferCalls = 0;

  const adapter = createSlackAdapter(
    { signingSecret: "secret", botToken: "xoxb-token" },
    {
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes("chat.postMessage")) {
          return new Response(JSON.stringify({ ok: true, ts: "1000.01" }), { status: 200 });
        }
        if (url.includes("getUploadURLExternal")) {
          uploadUrlCalls += 1;
          return new Response(
            JSON.stringify({ ok: true, upload_url: "https://files.slack.com/upload/v1/abc", file_id: "F123" }),
            { status: 200 },
          );
        }
        if (url.includes("files.slack.com")) {
          transferCalls += 1;
          return new Response("bad request", { status: 400 });
        }
        throw new Error(`unexpected Slack URL: ${url}`);
      },
    },
  );

  await assert.rejects(
    adapter.sendReplyRich!(
      { text: "hello", channel: "D0B3416DCF4", threadTs: "1778530504.140709", ts: "1778530504.140709" },
      { text: "Chart ready.", images: [{ kind: "data", mimeType: "image/png", base64: "iVBORw0KGgo=", filename: "chart.png" }] },
    ),
    /slack_upload_transfer_failed: status=400/,
  );

  assert.equal(uploadUrlCalls, 1);
  assert.equal(transferCalls, 1);
});

test("createSlackAdapter sendReplyRich keeps placeholder on exhausted retryable upload", async () => {
  const adapter = createSlackAdapter(
    { signingSecret: "secret", botToken: "xoxb-token" },
    {
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes("chat.update")) {
          return new Response(JSON.stringify({ ok: true, ts: "999.01" }), { status: 200 });
        }
        if (url.includes("getUploadURLExternal")) {
          return new Response(
            JSON.stringify({ ok: true, upload_url: "https://files.slack.com/upload/v1/abc", file_id: "F123" }),
            { status: 200 },
          );
        }
        if (url.includes("files.slack.com")) {
          return new Response("gateway timeout", { status: 504 });
        }
        throw new Error(`unexpected Slack URL: ${url}`);
      },
    },
  );

  const message: SlackExtractedMessage = {
    text: "hello",
    channel: "D0B3416DCF4",
    threadTs: "1778530504.140709",
    ts: "1778530504.140709",
    processingPlaceholderTs: "999.01",
  };

  await assert.rejects(
    adapter.sendReplyRich!(message, {
      text: "Chart ready.",
      images: [{ kind: "data", mimeType: "image/png", base64: "iVBORw0KGgo=", filename: "chart.png" }],
    }),
    (error) => {
      assert.ok(error instanceof RetryableSendError);
      return true;
    },
  );

  assert.equal(message.processingPlaceholderTs, "999.01");
});
test("createSlackAdapter sendReplyRich uploads video media via the full upload flow", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

  const adapter = createSlackAdapter(
    {
      signingSecret: "secret",
      botToken: "xoxb-token",
    },
    {
      fetchFn: async (input, init) => {
        fetchCalls.push({ input, init });

        if (String(input).includes("chat.postMessage")) {
          return new Response(JSON.stringify({ ok: true, ts: "1000.01" }), { status: 200 });
        }
        if (String(input).includes("getUploadURLExternal")) {
          return new Response(
            JSON.stringify({ ok: true, upload_url: "https://files.slack.com/upload/v1/vid", file_id: "FVID" }),
            { status: 200 },
          );
        }
        if (String(input).includes("files.slack.com")) {
          return new Response("OK", { status: 200 });
        }
        if (String(input).includes("completeUploadExternal")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }

        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    },
  );

  const message: SlackExtractedMessage = {
    text: "hello",
    channel: "C123",
    threadTs: "123.45",
    ts: "123.45",
  };

  const reply: ChannelReply = {
    text: "Video attached.",
    media: [
      {
        type: "video",
        source: {
          kind: "data",
          mimeType: "video/mp4",
          base64: "AAAAIGZ0eXA=",
          filename: "run.mp4",
        },
      },
    ],
  };

  await adapter.sendReplyRich!(message, reply);

  // Full flow: postMessage + getUploadURLExternal + upload + completeUploadExternal
  assert.ok(fetchCalls.some((c) => String(c.input).includes("chat.postMessage")), "should post text");
  assert.ok(fetchCalls.some((c) => String(c.input).includes("getUploadURLExternal")), "should get upload URL");
  assert.ok(
    fetchCalls.some((c) => String(c.input).includes("files.slack.com")),
    "should upload file bytes",
  );
  assert.ok(fetchCalls.some((c) => String(c.input).includes("completeUploadExternal")), "should complete upload");

  // Verify the getUploadURLExternal call includes correct filename
  const uploadUrlCall = fetchCalls.find((c) => String(c.input).includes("getUploadURLExternal"));
  const uploadBody = JSON.parse(uploadUrlCall?.init?.body as string);
  assert.equal(uploadBody.filename, "run.mp4", "should use the provided filename");
});

test("createSlackAdapter sendReplyRich does not double-upload image present in media and images", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

  const adapter = createSlackAdapter(
    {
      signingSecret: "secret",
      botToken: "xoxb-token",
    },
    {
      fetchFn: async (input, init) => {
        fetchCalls.push({ input, init });

        if (String(input).includes("chat.postMessage")) {
          return new Response(JSON.stringify({ ok: true, ts: "1000.01" }), { status: 200 });
        }
        if (String(input).includes("getUploadURLExternal")) {
          return new Response(
            JSON.stringify({ ok: true, upload_url: "https://files.slack.com/upload/v1/abc", file_id: "F999" }),
            { status: 200 },
          );
        }
        if (String(input).includes("files.slack.com")) {
          return new Response("OK", { status: 200 });
        }
        if (String(input).includes("completeUploadExternal")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }

        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    },
  );

  const message: SlackExtractedMessage = {
    text: "hello",
    channel: "C123",
    threadTs: "123.45",
    ts: "123.45",
  };

  const image = {
    kind: "data" as const,
    mimeType: "image/png",
    base64: "iVBORw0KGgo=",
    filename: "chart.png",
  };
  const reply: ChannelReply = {
    text: "Chart ready.",
    images: [image],
    media: [{ type: "image", source: image }],
  };

  await adapter.sendReplyRich!(message, reply);

  assert.equal(
    fetchCalls.filter((c) => String(c.input).includes("getUploadURLExternal")).length,
    1,
    "should only prepare a single upload for the image",
  );
  assert.equal(
    fetchCalls.filter((c) => String(c.input).includes("completeUploadExternal")).length,
    1,
    "should only complete a single upload for the image",
  );
});
