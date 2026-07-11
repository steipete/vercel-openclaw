import * as workflowApi from "workflow/api";

import {
  CHANNEL_DELIVERY_DEDUP_LOCK_TTL_SECONDS,
  SLACK_USER_MESSAGE_DEDUP_LOCK_TTL_SECONDS,
  tryAcquireChannelDedupLock,
  type ChannelDedupLock,
} from "@/server/channels/dedup";
import { recordChannelDlqFailure } from "@/server/channels/dlq";
import { refreshChannelFastPathGatewayToken } from "@/server/channels/fast-path-token";
import { recordChannelLastForward } from "@/server/channels/last-forward";
import {
  isDefiniteNativePreAdmissionError,
  isGatewayAdmissionUnavailableResponseShape,
  OPENCLAW_GATEWAY_SUSPEND_CAPABILITY,
} from "@/server/channels/native-response-contract";
import { getPublicOrigin } from "@/server/public-url";
import {
  channelDedupKey,
  channelUserMessageDedupKey,
} from "@/server/channels/keys";
import { drainChannelWorkflow } from "@/server/workflows/channels/drain-channel-workflow";
import {
  deleteSlackMessage,
  getSlackUrlVerificationChallenge,
  isValidSlackSignature,
} from "@/server/channels/slack/adapter";
import { extractRequestId, logInfo, logWarn } from "@/server/log";
import { createOperationContext, withOperationContext } from "@/server/observability/operation-context";
import { getSandboxDomain, markSandboxPortUrlStale, probeGatewayReady, reconcileSandboxHealth, reconcileStaleRunningStatus, syncGatewayConfigToSandbox } from "@/server/sandbox/lifecycle";
import { getInitializedMeta, getStore } from "@/server/store/store";
import { hydrateVerifiedBundleIdentity } from "@/server/openclaw/bundle-identity";
import {
  buildHostIngressFencedResponse,
  getHostIngressFence,
} from "@/server/sandbox/host-suspension";
const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const SLACK_BOOT_MESSAGE_TIMEOUT_MS = 5_000;
// The fast path intentionally awaits the native handler's full turn
// (including long AI work like image generation). Keep this generous
// enough to cover real long turns but short enough to avoid burning
// the full Vercel function maxDuration when the TCP connection to the
// sandbox wedges half-open. 10 minutes hits that middle ground.
const SLACK_FAST_PATH_FORWARD_TIMEOUT_MS = 10 * 60 * 1000;

const SLACK_FORWARD_HEADERS = [
  "x-slack-signature",
  "x-slack-request-timestamp",
  "x-slack-retry-num",
  "x-slack-retry-reason",
] as const;

type SlackWebhookDedupLock = ChannelDedupLock;

type SlackWebhookDedupReleaseResult = {
  attempted: boolean;
  released: boolean;
  releaseError: string | null;
};

export const slackWebhookWorkflowRuntime = {
  start: workflowApi.start,
};

function unauthorizedResponse() {
  return Response.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
}

function workflowStartFailedResponse() {
  return Response.json(
    { ok: false, error: "WORKFLOW_START_FAILED", retryable: true },
    { status: 500 },
  );
}

async function releaseSlackWebhookDedupLocksForRetry(
  locks: ReadonlyArray<SlackWebhookDedupLock | null>,
): Promise<SlackWebhookDedupReleaseResult[]> {
  return Promise.all(
    locks.map(async (lock) => {
      if (!lock) {
        return { attempted: false, released: false, releaseError: null };
      }
      try {
        await getStore().releaseLock(lock.key, lock.token);
        return { attempted: true, released: true, releaseError: null };
      } catch (error) {
        return {
          attempted: true,
          released: false,
          releaseError: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

function extractSlackEventInfo(payload: unknown): {
  eventType: string | null;
  eventSubtype: string | null;
  channel: string | null;
  user: string | null;
  text: string | null;
  threadTs: string | null;
  ts: string | null;
  botId: string | null;
  payloadType: string | null;
} {
  if (!payload || typeof payload !== "object") {
    return { eventType: null, eventSubtype: null, channel: null, user: null, text: null, threadTs: null, ts: null, botId: null, payloadType: null };
  }

  const p = payload as Record<string, unknown>;
  const event = p.event as Record<string, unknown> | undefined;

  return {
    payloadType: typeof p.type === "string" ? p.type : null,
    eventType: typeof event?.type === "string" ? event.type : null,
    eventSubtype: typeof event?.subtype === "string" ? event.subtype : null,
    channel: typeof event?.channel === "string" ? event.channel : null,
    user: typeof event?.user === "string" ? event.user : null,
    text: typeof event?.text === "string" ? event.text.slice(0, 100) : null,
    threadTs: typeof event?.thread_ts === "string" ? event.thread_ts : null,
    ts: typeof event?.ts === "string" ? event.ts : null,
    botId: typeof event?.bot_id === "string" ? event.bot_id : null,
  };
}

function extractSlackDedupId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const raw = payload as {
    event_id?: unknown;
    event?: { channel?: unknown; ts?: unknown };
  };
  if (typeof raw.event_id === "string" && raw.event_id.length > 0) {
    return raw.event_id;
  }

  if (
    typeof raw.event?.channel === "string" &&
    typeof raw.event?.ts === "string"
  ) {
    return `${raw.event.channel}:${raw.event.ts}`;
  }

  return null;
}

export async function POST(request: Request): Promise<Response> {
  const receivedAtMs = Date.now();
  const requestId = extractRequestId(request);
  const rawBody = await request.text().catch(() => "");
  const signatureHeader = request.headers.get("x-slack-signature");
  const timestampHeader = request.headers.get("x-slack-request-timestamp");
  const retryNum = request.headers.get("x-slack-retry-num");
  const retryReason = request.headers.get("x-slack-retry-reason");

  if (!signatureHeader || !timestampHeader) {
    logWarn("channels.slack_webhook_rejected", {
      reason: "missing_signature_headers",
      hasSignature: Boolean(signatureHeader),
      hasTimestamp: Boolean(timestampHeader),
      requestId,
    });
    return unauthorizedResponse();
  }

  const meta = await getInitializedMeta();
  const config = meta.channels.slack;
  if (!config) {
    logWarn("channels.slack_webhook_rejected", {
      reason: "slack_not_configured",
      requestId,
    });
    return Response.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
  }

  const signatureValid = isValidSlackSignature({
    signingSecret: config.signingSecret,
    signatureHeader,
    timestampHeader,
    rawBody,
  });
  if (!signatureValid) {
    // Lenient parse on failure so we can tell a stale-secret rotation from a
    // second Slack app install. If two apps subscribe to the same webhook URL,
    // api_app_id / team_id will differ between accepted and rejected requests.
    const failDiag: {
      apiAppId: string | null;
      teamId: string | null;
      eventType: string | null;
    } = {
      apiAppId: null,
      teamId: null,
      eventType: null,
    };
    try {
      const parsed = rawBody.length > 0 ? JSON.parse(rawBody) : null;
      if (parsed && typeof parsed === "object") {
        const p = parsed as Record<string, unknown>;
        failDiag.apiAppId = typeof p.api_app_id === "string" ? p.api_app_id : null;
        failDiag.teamId = typeof p.team_id === "string" ? p.team_id : null;
        const ev = p.event as Record<string, unknown> | undefined;
        failDiag.eventType = typeof ev?.type === "string" ? ev.type : null;
      }
    } catch {
      // ignore — payload was not JSON
    }
    logWarn("channels.slack_webhook_rejected", {
      reason: "invalid_signature",
      requestId,
      timestampHeader,
      bodyLength: rawBody.length,
      ...failDiag,
    });
    return unauthorizedResponse();
  }

  let payload: unknown;
  try {
    payload = rawBody.length > 0 ? JSON.parse(rawBody) : null;
  } catch {
    logWarn("channels.slack_webhook_rejected", {
      reason: "invalid_json",
      requestId,
      bodyLength: rawBody.length,
      bodyHead: rawBody.slice(0, 100),
    });
    return Response.json({ ok: true });
  }

  const challenge = getSlackUrlVerificationChallenge(payload);
  if (challenge !== null) {
    logInfo("channels.slack_url_verification", {
      requestId,
      challengeLength: challenge.length,
    });
    return new Response(challenge, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }

  const eventInfo = extractSlackEventInfo(payload);
  const dedupId = extractSlackDedupId(payload);

  // Bot replies are transport output, not new user work. Skip them before the
  // host ingress fence; the workflow that owns a wake placeholder also owns
  // its update/delete lifecycle.
  if (eventInfo.botId) {
    logInfo("channels.slack_webhook_bot_skip", {
      requestId,
      dedupId,
      botId: eventInfo.botId,
      eventType: eventInfo.eventType,
    });
    return Response.json({ ok: true });
  }

  const ingressFence = await getHostIngressFence();
  if (ingressFence) {
    logInfo("channels.slack_host_ingress_fenced", {
      requestId,
      phase: ingressFence.phase,
      operationId: ingressFence.operationId,
    });
    return buildHostIngressFencedResponse(ingressFence);
  }

  let verifiedBundleIdentity: Awaited<
    ReturnType<typeof hydrateVerifiedBundleIdentity>
  > = null;
  try {
    verifiedBundleIdentity = await hydrateVerifiedBundleIdentity(
      meta.bundleIdentity,
    );
  } catch {
    // Fail closed below. Bundle admission errors must not create a platform
    // retry storm for an otherwise valid Slack webhook.
  }
  const gatewayAdmissionRejectionAdmitted =
    verifiedBundleIdentity?.capabilities.includes(
      OPENCLAW_GATEWAY_SUSPEND_CAPABILITY,
    ) === true;
  if (!gatewayAdmissionRejectionAdmitted) {
    logWarn("slack.delivery.bundle_capability_missing", {
      capabilityId: OPENCLAW_GATEWAY_SUSPEND_CAPABILITY,
      bundleIdentityMissing: meta.bundleIdentity === null,
      bundleIdentityVerified: verifiedBundleIdentity !== null,
      requestId,
    });
  }

  let dedupLock: SlackWebhookDedupLock | null = null;
  if (dedupId) {
    const dedupKey = channelDedupKey("slack", dedupId);
    const dedupResult = await tryAcquireChannelDedupLock({
      channel: "slack",
      key: dedupKey,
      ttlSeconds: CHANNEL_DELIVERY_DEDUP_LOCK_TTL_SECONDS,
      requestId: requestId ?? null,
      dedupId,
      lockKind: "event-id",
    });
    if (dedupResult.kind === "duplicate") {
      logInfo("channels.slack_webhook_dedup_skip", {
        requestId,
        dedupId,
        ...eventInfo,
      });
      return Response.json({ ok: true });
    }
    if (dedupResult.kind === "acquired") {
      dedupLock = dedupResult.lock;
    }
    // degraded: dedupLock stays null and we proceed without a lock.
    // The helper already logged channels.dedup_lock_acquire_failed_degraded.
  }

  // Skip message edit/deletion subtypes. Slack fires `message_changed`
  // repeatedly as a user types (every few keystrokes) and `message_deleted`
  // when messages are removed. Each event has a unique event_id, so dedup
  // doesn't catch them — and a stopped sandbox would wake, send a "Waking
  // up…" boot message, and try to forward the edit, multiplying work for
  // what is not a user-intended utterance. The native Slack handler already
  // ignores edits, so forwarding them buys nothing even when running.
  const ignorableSubtypes = new Set(["message_changed", "message_deleted"]);
  if (eventInfo.eventSubtype && ignorableSubtypes.has(eventInfo.eventSubtype)) {
    logInfo("channels.slack_webhook_subtype_skip", {
      requestId,
      dedupId,
      eventType: eventInfo.eventType,
      eventSubtype: eventInfo.eventSubtype,
    });
    return Response.json({ ok: true });
  }

  const op = createOperationContext({
    trigger: "channel.slack.webhook",
    reason: "incoming slack webhook",
    requestId: requestId ?? null,
    channel: "slack",
    dedupId: dedupId ?? null,
    sandboxId: meta.sandboxId ?? null,
    snapshotId: meta.snapshotId ?? null,
    status: meta.status,
  });

  const payloadRoot = payload as Record<string, unknown> | null;
  const apiAppId =
    payloadRoot && typeof payloadRoot.api_app_id === "string"
      ? payloadRoot.api_app_id
      : null;
  const teamId =
    payloadRoot && typeof payloadRoot.team_id === "string"
      ? payloadRoot.team_id
      : null;
  logInfo("channels.slack_webhook_accepted", withOperationContext(op, {
    ...eventInfo,
    retryNum: retryNum ? Number(retryNum) : null,
    retryReason,
    bodyLength: rawBody.length,
    apiAppId,
    teamId,
  }));

  // --- Fast path: forward to OpenClaw's native Slack handler ---
  // When the sandbox is running, delegate entirely to the native handler.
  // Await the response so the native handler can complete its full
  // processing cycle (including long AI tasks like image generation).
  // Fluid Compute bills only for CPU cycles, not idle wait time.
  //
  // A 2xx response is accepted. Replay only responses or transport failures
  // that prove dispatch stopped before handler admission; close every other
  // outcome as unknown so the wake path cannot duplicate an accepted event.
  let effectiveMeta = meta;
  let revalidateSandboxBeforeForward = false;
  if (effectiveMeta.status === "running" && effectiveMeta.sandboxId) {
    const forwardHeaders: Record<string, string> = {
      "content-type": request.headers.get("content-type") ?? "application/json",
    };
    for (const h of SLACK_FORWARD_HEADERS) {
      const v = request.headers.get(h);
      if (v) forwardHeaders[h] = v;
    }
    const fastPathDedupId = extractSlackDedupId(payload);
    if (fastPathDedupId) {
      forwardHeaders["x-openclaw-delivery-id"] = `slack:${fastPathDedupId}`;
    }

    const fastPathStartedAt = Date.now();
    let fastPathSandboxUrl: string | null = null;
    let fastPathAttempts = 0;
    let nativeDispatchInFlight = false;
    try {
      const sandboxUrl = await getSandboxDomain();
      fastPathSandboxUrl = sandboxUrl;
      const forwardUrl = `${sandboxUrl}/slack/events`;

      await refreshChannelFastPathGatewayToken({
        channel: "slack",
        requestId: requestId ?? null,
        sandboxId: effectiveMeta.sandboxId,
        op,
        controlPlaneOrigin: getPublicOrigin(request),
      });

      const readiness = await probeGatewayReady({ timeoutMs: 1_000 });
      if (!readiness.ready) {
        const health = await reconcileSandboxHealth({
          origin: getPublicOrigin(request),
          reason: "channel:slack-fast-path",
          op,
        });
        effectiveMeta = health.meta;
        logWarn("channels.slack_fast_path_gateway_not_ready", withOperationContext(op, {
          sandboxId: effectiveMeta.sandboxId,
          action: "reconcile_and_wake",
          statusCode: readiness.statusCode,
          markerFound: readiness.markerFound,
          probeError: readiness.error,
          healthStatus: health.status,
          repaired: health.repaired,
          healthError: health.error,
          ...eventInfo,
        }));
      } else {
        logInfo("channels.slack_fast_path_gateway_ready", withOperationContext(op, {
          sandboxId: effectiveMeta.sandboxId,
          statusCode: readiness.statusCode,
          markerFound: readiness.markerFound,
          ...eventInfo,
        }));

        logInfo("channels.slack_fast_path_forwarding", withOperationContext(op, {
          sandboxId: effectiveMeta.sandboxId,
          forwardUrl,
          forwardHeaderKeys: Object.keys(forwardHeaders),
          hasSlackSignature: Boolean(forwardHeaders["x-slack-signature"]),
          hasSlackTimestamp: Boolean(forwardHeaders["x-slack-request-timestamp"]),
          ...eventInfo,
        }));

        fastPathAttempts += 1;
        nativeDispatchInFlight = true;
        let resp = await fetch(forwardUrl, {
          method: "POST",
          headers: forwardHeaders,
          body: rawBody,
          signal: AbortSignal.timeout(SLACK_FAST_PATH_FORWARD_TIMEOUT_MS),
        });
        nativeDispatchInFlight = false;
        if (resp.ok) {
          logInfo("channels.slack_fast_path_ok", withOperationContext(op, {
            sandboxId: effectiveMeta.sandboxId,
            responseStatus: resp.status,
            ackSemantics: "native-handler-accepted",
            ...eventInfo,
          }));
          await recordChannelLastForward("slack", {
            ok: true,
            status: resp.status,
            classification: "accepted",
            attempts: fastPathAttempts,
            totalMs: Date.now() - fastPathStartedAt,
            transport: "public",
            sandboxUrl: fastPathSandboxUrl,
            sandboxId: effectiveMeta.sandboxId ?? null,
            finalReasonHead: null,
            startedAt: fastPathStartedAt,
            completedAt: Date.now(),
            deliveryId: fastPathDedupId ? `slack:${fastPathDedupId}` : null,
          });
          return Response.json({ ok: true });
        }

        if (resp.status === 404) {
          const sync = await syncGatewayConfigToSandbox();
          logWarn("channels.slack_fast_path_route_missing_repair", withOperationContext(op, {
            status: resp.status,
            sandboxId: effectiveMeta.sandboxId,
            syncOutcome: sync.outcome,
            syncReason: sync.reason,
            liveConfigFresh: sync.liveConfigFresh,
            action: sync.liveConfigFresh ? "retry_native_handler" : "start_drain_channel_workflow",
            ...eventInfo,
          }));

          if (sync.liveConfigFresh) {
            fastPathAttempts += 1;
            nativeDispatchInFlight = true;
            const retry = await fetch(forwardUrl, {
              method: "POST",
              headers: forwardHeaders,
              body: rawBody,
              signal: AbortSignal.timeout(SLACK_FAST_PATH_FORWARD_TIMEOUT_MS),
            });
            nativeDispatchInFlight = false;
            if (retry.ok) {
              logInfo("channels.slack_fast_path_ok", withOperationContext(op, {
                sandboxId: effectiveMeta.sandboxId,
                responseStatus: retry.status,
                ackSemantics: "native-handler-accepted-after-route-repair",
                ...eventInfo,
              }));
              await recordChannelLastForward("slack", {
                ok: true,
                status: retry.status,
                classification: "accepted",
                attempts: fastPathAttempts,
                totalMs: Date.now() - fastPathStartedAt,
                transport: "public",
                sandboxUrl: fastPathSandboxUrl,
                sandboxId: effectiveMeta.sandboxId ?? null,
                finalReasonHead: null,
                startedAt: fastPathStartedAt,
                completedAt: Date.now(),
                deliveryId: fastPathDedupId ? `slack:${fastPathDedupId}` : null,
              });
              return Response.json({ ok: true });
            }
            resp = retry;
            logWarn("channels.slack_fast_path_route_repair_retry_failed", withOperationContext(op, {
              status: retry.status,
              sandboxId: effectiveMeta.sandboxId,
              action: "start_drain_channel_workflow",
              ...eventInfo,
            }));
          }
        }

        // Classify the final response, including a route-repair retry. Only
        // exact pre-admission evidence may continue to workflow replay.
        const slackFallbackIsGatewayError =
          resp.status === 502 || resp.status === 503 || resp.status === 504;

        // Read response body once to (a) sniff for SANDBOX_NOT_LISTENING and
        // (b) capture a finalReasonHead for the diagnostics record. Body is
        // small (Vercel sandbox error pages are <500 bytes); cost is bounded.
        let respBodyHead: string | null = null;
        try {
          respBodyHead = (await resp.text()).slice(0, 200);
        } catch {
          /* response body already consumed or unreachable */
        }
        const isSandboxNotListening =
          resp.status === 502 &&
          respBodyHead != null &&
          respBodyHead.includes("sandbox is not listening");
        const gatewayUnavailableResponse =
          isGatewayAdmissionUnavailableResponseShape(
            resp.status,
            respBodyHead,
          );
        const admittedGatewayUnavailable =
          gatewayUnavailableResponse &&
          gatewayAdmissionRejectionAdmitted;
        const definitePreAdmissionResponse =
          resp.status === 404 ||
          isSandboxNotListening ||
          admittedGatewayUnavailable;
        if (!definitePreAdmissionResponse) {
          await recordChannelLastForward(
            "slack",
            {
              ok: false,
              status: resp.status,
              classification: "acceptance-unknown",
              attempts: fastPathAttempts,
              totalMs: Date.now() - fastPathStartedAt,
              transport: "public",
              sandboxUrl: fastPathSandboxUrl,
              sandboxId: effectiveMeta.sandboxId ?? null,
              finalReasonHead: respBodyHead,
              startedAt: fastPathStartedAt,
              completedAt: Date.now(),
              deliveryId: fastPathDedupId
                ? `slack:${fastPathDedupId}`
                : null,
            },
            { closedOutcome: "unknown" },
          );
          logWarn(
            "channels.slack_fast_path_acceptance_unknown",
            withOperationContext(op, {
              status: resp.status,
              sandboxId: effectiveMeta.sandboxId,
              action: "ack_without_blind_redrive",
              reason:
                gatewayUnavailableResponse &&
                !gatewayAdmissionRejectionAdmitted
                  ? "unverified_gateway_unavailable"
                  : "native_response_acceptance_unknown",
              ...eventInfo,
            }),
          );
          return Response.json({ ok: true });
        }
        revalidateSandboxBeforeForward = admittedGatewayUnavailable;

        logWarn(
          slackFallbackIsGatewayError
            ? "channels.slack_fast_path_gateway_error"
            : "channels.slack_fast_path_fallback_to_workflow",
          withOperationContext(op, {
            status: resp.status,
            sandboxId: effectiveMeta.sandboxId,
            action: slackFallbackIsGatewayError
              ? "reconcile_and_wake"
              : "start_drain_channel_workflow",
            classification: isSandboxNotListening
              ? "sandbox-not-listening"
              : admittedGatewayUnavailable
                ? "gateway-unavailable"
              : slackFallbackIsGatewayError
                ? "proxy-error"
                : resp.status === 404
                  ? "handler-not-ready"
                : "handler-error",
            sandboxUrl: fastPathSandboxUrl,
            bodyHead: respBodyHead,
            ...eventInfo,
          }),
        );

        // Persist the failed forward so /api/channels/summary surfaces it.
        await recordChannelLastForward("slack", {
          ok: false,
          status: resp.status,
          classification: isSandboxNotListening
            ? "sandbox-not-listening"
            : admittedGatewayUnavailable
              ? "gateway-unavailable"
            : slackFallbackIsGatewayError
              ? "proxy-error"
              : resp.status === 404
                ? "handler-not-ready"
              : "handler-error",
          attempts: fastPathAttempts,
          totalMs: Date.now() - fastPathStartedAt,
          transport: "public",
          sandboxUrl: fastPathSandboxUrl,
          sandboxId: effectiveMeta.sandboxId ?? null,
          finalReasonHead: respBodyHead,
          startedAt: fastPathStartedAt,
          completedAt: Date.now(),
          deliveryId: fastPathDedupId ? `slack:${fastPathDedupId}` : null,
        });

        // For SANDBOX_NOT_LISTENING, refresh the cached port URL + reconcile
        // sandbox status now so the workflow fall-through path forwards to a
        // fresh URL instead of the same dead one.
        if (isSandboxNotListening) {
          try {
            await markSandboxPortUrlStale(
              effectiveMeta.sandboxId ?? null,
              undefined,
              "fast-path-sandbox-not-listening",
            );
          } catch (err) {
            logWarn("channels.slack_fast_path_port_url_refresh_failed", withOperationContext(op, {
              error: err instanceof Error ? err.message : String(err),
              sandboxId: effectiveMeta.sandboxId,
            }));
          }
        }

        effectiveMeta = await reconcileStaleRunningStatus();
      }
    } catch (error) {
      // A fetch exception can happen after request bytes leave the process.
      // Only a known pre-admission transport error is safe to replay.
      const isAbort =
        error instanceof Error && error.name === "TimeoutError";
      const acceptanceUnknown =
        nativeDispatchInFlight &&
        !isDefiniteNativePreAdmissionError(error);
      logWarn("channels.slack_fast_path_failed", withOperationContext(op, {
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : undefined,
        sandboxId: effectiveMeta.sandboxId,
        action: acceptanceUnknown
          ? "ack_without_blind_redrive"
          : "reconcile_and_wake",
        reason: isAbort ? "fast_path_forward_timeout" : "network_error",
        indeterminateDelivery: acceptanceUnknown,
        fastPathTimeoutMs: isAbort
          ? SLACK_FAST_PATH_FORWARD_TIMEOUT_MS
          : null,
        ...eventInfo,
      }));
      await recordChannelLastForward(
        "slack",
        {
          ok: false,
          status: null,
          classification: acceptanceUnknown
            ? "acceptance-unknown"
            : "fetch-exception",
          attempts: Math.max(1, fastPathAttempts),
          totalMs: Date.now() - fastPathStartedAt,
          transport: "public",
          sandboxUrl: fastPathSandboxUrl,
          sandboxId: effectiveMeta.sandboxId ?? null,
          finalReasonHead:
            error instanceof Error ? error.message : String(error),
          startedAt: fastPathStartedAt,
          completedAt: Date.now(),
          deliveryId: fastPathDedupId ? `slack:${fastPathDedupId}` : null,
        },
        acceptanceUnknown ? { closedOutcome: "unknown" } : undefined,
      );
      if (acceptanceUnknown) {
        return Response.json({ ok: true });
      }
      effectiveMeta = await reconcileStaleRunningStatus();
    }
  } else {
    logInfo("channels.slack_fast_path_skipped", withOperationContext(op, {
      reason: effectiveMeta.status !== "running" ? `sandbox_status_${effectiveMeta.status}` : "no_sandbox_id",
      status: effectiveMeta.status,
      sandboxId: effectiveMeta.sandboxId,
      ...eventInfo,
    }));
  }

  // Wake-path only: collapse Slack's dual-event delivery (app_mention +
  // message.channels for the same user post). Both have distinct event_ids
  // so the event-id dedup above lets both through; this second lock keyed on
  // the user message's channel+ts ensures only ONE wake/workflow per user
  // post. The fast path above intentionally forwards BOTH events to the
  // native Bolt handler, which has its own dedup.
  let userMessageDedupLock: SlackWebhookDedupLock | null = null;
  const userMessageTs =
    typeof (payload as { event?: { ts?: unknown } } | null)?.event?.ts === "string"
      ? (payload as { event: { ts: string } }).event.ts
      : null;
  if (eventInfo.channel && userMessageTs) {
    const userMessageKey = channelUserMessageDedupKey(
      "slack",
      eventInfo.channel,
      userMessageTs,
    );
    const userMessageResult = await tryAcquireChannelDedupLock({
      channel: "slack",
      key: userMessageKey,
      ttlSeconds: SLACK_USER_MESSAGE_DEDUP_LOCK_TTL_SECONDS,
      requestId: requestId ?? null,
      dedupId: userMessageTs,
      lockKind: "user-message",
    });
    if (userMessageResult.kind === "duplicate") {
      logInfo(
        "channels.slack_webhook_user_message_dedup_skip",
        withOperationContext(op, {
          channel: eventInfo.channel,
          ts: userMessageTs,
          eventType: eventInfo.eventType,
          eventSubtype: eventInfo.eventSubtype,
          dedupId,
        }),
      );
      return Response.json({ ok: true });
    }
    if (userMessageResult.kind === "acquired") {
      userMessageDedupLock = userMessageResult.lock;
    }
    // degraded: continue without user-message dedup. The helper already
    // emitted channels.dedup_lock_acquire_failed_degraded.
  }

  // Send a wake boot message from the webhook route (before workflow)
  // so the user gets immediate feedback. The message ts is passed to the
  // workflow so the step can update/delete it during processing.
  let bootMessageTs: string | null = null;
  if (effectiveMeta.status !== "running" && eventInfo.channel) {
    try {
      const resp = await fetch(SLACK_POST_MESSAGE_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.botToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          channel: eventInfo.channel,
          ...(eventInfo.threadTs ?? eventInfo.ts
            ? { thread_ts: eventInfo.threadTs ?? eventInfo.ts }
            : {}),
          text: "🦞 Waking the sandbox. First reply after idle may be slow.",
        }),
        signal: AbortSignal.timeout(SLACK_BOOT_MESSAGE_TIMEOUT_MS),
      });
      if (resp.ok) {
        const body = await resp.json() as { ok?: boolean; ts?: string };
        if (body.ok && body.ts) {
          bootMessageTs = body.ts;
        }
      }
      if (bootMessageTs) {
        logInfo("channels.slack_boot_message_sent", withOperationContext(op, {
          channel: eventInfo.channel,
          bootMessageTs,
        }));
      }
    } catch (err) {
      logWarn("channels.slack_boot_message_failed", withOperationContext(op, {
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  // Capture Slack signature headers so the workflow wake path can replay the
  // forward with signatures intact. OpenClaw's Slack Bolt HTTPReceiver
  // re-verifies signatures and rejects with 401 when they're missing.
  const slackForwardHeaders: Record<string, string> = {};
  for (const h of SLACK_FORWARD_HEADERS) {
    const v = request.headers.get(h);
    if (v) slackForwardHeaders[h] = v;
  }

  try {
    const origin = getPublicOrigin(request);
    await slackWebhookWorkflowRuntime.start(drainChannelWorkflow, [
      {
        version: 1,
        channel: "slack",
        payload,
        origin,
        requestId: requestId ?? null,
        bootMessageId: bootMessageTs,
        receivedAtMs,
        workflowHandoff: {
          slackCleanupConfig: {
            botToken: config.botToken,
            configuredAt: config.configuredAt,
          },
          revalidateSandboxBeforeForward,
          slackForwardHeaders,
          slackRawBody: rawBody,
        },
      },
    ]);
    logInfo("channels.slack_workflow_started", withOperationContext(op, {
      ...eventInfo,
      slackForwardHeaderKeys: Object.keys(slackForwardHeaders),
    }));
  } catch (error) {
    // Best-effort delete the boot message we posted just before this failed
    // workflow start. Slack will not auto-retry the webhook (we return 5xx),
    // and the user will eventually retry manually — leaving a dangling
    // boot placeholder looks broken. Symmetric to the Telegram path.
    let bootMessageCleanupSucceeded: boolean | null = null;
    if (bootMessageTs && eventInfo.channel) {
      try {
        await deleteSlackMessage({
          botToken: config.botToken,
          channel: eventInfo.channel,
          ts: bootMessageTs,
          timeoutMs: SLACK_BOOT_MESSAGE_TIMEOUT_MS,
        });
        bootMessageCleanupSucceeded = true;
      } catch (cleanupError) {
        bootMessageCleanupSucceeded = false;
        logWarn("channels.slack_boot_message_cleanup_after_handoff_failed", {
          requestId,
          channel: eventInfo.channel,
          bootMessageTs,
          error:
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
        });
        // Don't let cleanup failure mask the real error response.
      }
    }
    const [dedupRelease, userMessageRelease] =
      await releaseSlackWebhookDedupLocksForRetry([
        dedupLock,
        userMessageDedupLock,
      ]);
    logWarn("channels.slack_workflow_start_failed", withOperationContext(op, {
      error: error instanceof Error ? error.message : String(error),
      attemptedAction: "start_drain_channel_workflow",
      dedupLockKey: dedupLock?.key ?? null,
      dedupLockReleaseAttempted: dedupRelease.attempted,
      dedupLockReleased: dedupRelease.released,
      dedupLockReleaseError: dedupRelease.releaseError,
      userMessageDedupLockKey: userMessageDedupLock?.key ?? null,
      userMessageDedupLockReleaseAttempted: userMessageRelease.attempted,
      userMessageDedupLockReleased: userMessageRelease.released,
      userMessageDedupLockReleaseError: userMessageRelease.releaseError,
      bootMessageCleanupAttempted: Boolean(bootMessageTs && eventInfo.channel),
      bootMessageCleanupSucceeded,
      retryable: true,
      ...eventInfo,
    }));
    const dlqDeliveryId = dedupId
      ? `slack:${dedupId}`
      : `slack:request:${requestId ?? receivedAtMs}`;
    await recordChannelDlqFailure({
      channel: "slack",
      deliveryId: dlqDeliveryId,
      phase: "workflow-start-failed",
      terminal: false,
      retryable: true,
      deliveryOutcome: "not-accepted",
      requestId: requestId ?? null,
      receivedAtMs,
      error,
      diag: {
        dedupId,
        bootMessageTs,
        dedupLockReleased: dedupRelease.released,
        userMessageDedupLockReleased: userMessageRelease.released,
        eventInfo,
      },
    });
    return workflowStartFailedResponse();
  }

  return Response.json({ ok: true });
}
