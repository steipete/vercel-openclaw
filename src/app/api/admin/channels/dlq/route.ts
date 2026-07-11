import { requireJsonRouteAuth } from "@/server/auth/route-auth";
import {
  getChannelDlqRecord,
  type ChannelDlqIndexEntry,
} from "@/server/channels/dlq";
import { channelFailedIndexKey } from "@/server/store/keyspace";
import { getStore } from "@/server/store/store";
import { isChannelName } from "@/shared/channels";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function jsonWithAuth(
  body: unknown,
  status: number,
  auth: { setCookieHeader: string | null },
): Response {
  const response = Response.json(body, { status });
  if (auth.setCookieHeader) {
    response.headers.append("Set-Cookie", auth.setCookieHeader);
  }
  return response;
}

function toPositiveInt(value: string | null, fallback: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const limit = toPositiveInt(url.searchParams.get("limit"), DEFAULT_LIMIT, MAX_LIMIT);
  const channelParam = url.searchParams.get("channel");
  const channel =
    channelParam && isChannelName(channelParam) ? channelParam : null;
  const includeTerminalOnly = url.searchParams.get("terminal") === "true";

  const store = getStore();
  let indexRaw: ChannelDlqIndexEntry[] | null;
  try {
    indexRaw = await store.getValue<ChannelDlqIndexEntry[] | null>(
      channelFailedIndexKey(),
    );
  } catch {
    return jsonWithAuth(
      {
        error: {
          code: "DLQ_UNAVAILABLE",
          message: "Channel delivery failure state is temporarily unavailable.",
        },
      },
      503,
      auth,
    );
  }
  const index: ChannelDlqIndexEntry[] = Array.isArray(indexRaw)
    ? indexRaw.filter((entry): entry is ChannelDlqIndexEntry => {
        return (
          entry != null &&
          typeof entry === "object" &&
          typeof (entry as ChannelDlqIndexEntry).key === "string"
        );
      })
    : [];
  // Channel is immutable in the index entry. Scope before record projection so
  // one channel's store outage cannot break an unrelated channel query.
  const scopedIndex = channel
    ? index.filter((entry) => entry.channel === channel)
    : index;
  const now = Date.now();
  const projectItems = () =>
    Promise.all(
      scopedIndex.map(async (entry) => {
        const record = await getChannelDlqRecord(
          entry.channel,
          entry.deliveryId,
        );
        if (!record) return null;
        return {
          channel: record.channel,
          deliveryId: record.deliveryId,
          key: entry.key,
          phase: record.phase,
          terminal: record.terminal,
          retryable: record.retryable,
          requestId: record.requestId,
          errorName: record.errorName,
          errorMessage: record.errorMessage,
          firstFailedAt: record.firstFailedAt,
          failedAt: record.failedAt,
          failureCount: record.failureCount,
          deliveryOutcome: record.deliveryOutcome,
          recoveryState: record.recoveryState,
          replayAvailable: false as const,
          automatedRedriveAvailable: false as const,
          manualRecoveryRequired: false as const,
          replayUnavailableReason: "automated-redrive-disabled" as const,
          receivedAtMs: record.receivedAtMs,
          ageMs: Math.max(0, now - record.failedAt),
        };
      }),
    );
  let projectedItems: Awaited<ReturnType<typeof projectItems>>;
  try {
    projectedItems = await projectItems();
  } catch {
    return jsonWithAuth(
      {
        error: {
          code: "DLQ_UNAVAILABLE",
          message: "Channel delivery failure state is temporarily unavailable.",
        },
      },
      503,
      auth,
    );
  }
  const liveItems = projectedItems
    .filter((item) => item !== null)
    .sort((left, right) => right.failedAt - left.failedAt);
  const items = liveItems
    .filter((item) => !includeTerminalOnly || item.terminal)
    .slice(0, limit);

  return Response.json({
    items,
    count: items.length,
    indexSize: scopedIndex.length,
    staleIndexCount: scopedIndex.length - liveItems.length,
    limit,
    channel,
    includeTerminalOnly,
  });
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) return auth;

  const response = jsonWithAuth(
    {
      error: {
        code: "DLQ_REDRIVE_UNAVAILABLE",
        message:
          "Automated redrive is disabled until workflow start or the native handler provides an exact idempotency contract.",
      },
      recoveryMode: "inspection-only",
    },
    405,
    auth,
  );
  response.headers.set("Allow", "GET");
  return response;
}
