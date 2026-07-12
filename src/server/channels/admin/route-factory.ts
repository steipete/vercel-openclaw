import type { ChannelName } from "@/shared/channels";
import type { PublicChannelState } from "@/shared/channel-admin-state";
import type { LiveConfigSyncResult } from "@/shared/live-config-sync";
import {
  LIVE_CONFIG_SYNC_OUTCOME_HEADER,
  LIVE_CONFIG_SYNC_MESSAGE_HEADER,
} from "@/shared/live-config-sync";
import type { SingleMeta } from "@/shared/types";
import { authJsonError, authJsonOk, requireJsonRouteAuth } from "@/server/auth/route-auth";
import {
  buildChannelConnectability,
  buildChannelConnectBlockedResponse,
} from "@/server/channels/connectability";
import { applyChannelConfigChangeUnderLifecycleLock } from "@/server/channels/admin/apply-channel-config-change";
import { getPublicChannelState } from "@/server/channels/state";
import {
  buildHostIngressFencedResponse,
  getHostMutationFence,
} from "@/server/sandbox/host-suspension";
import { withSandboxLifecycleMutationLock } from "@/server/sandbox/lifecycle";
import { getInitializedMeta } from "@/server/store/store";

type RouteAuth = Exclude<Awaited<ReturnType<typeof requireJsonRouteAuth>>, Response>;

export type ChannelRouteContext = {
  request: Request;
  auth: RouteAuth;
  meta: SingleMeta;
  url: URL;
};

export type ChannelMutationRouteContext = ChannelRouteContext & {
  assertMutationOwned: () => Promise<void>;
};

export type ChannelGetContext<TState> = ChannelRouteContext & {
  fullState: PublicChannelState;
  state: TState;
};

export type ChannelAdminRouteSpec<TState> = {
  channel: ChannelName;
  selectState(fullState: PublicChannelState): TState;
  get?(context: ChannelGetContext<TState>): Promise<unknown | Response>;
  put(context: ChannelMutationRouteContext): Promise<void | Response>;
  delete(context: ChannelMutationRouteContext): Promise<void | Response>;
  afterDeleteApplied?(
    context: ChannelMutationRouteContext & {
      liveConfigSync: LiveConfigSyncResult;
    },
  ): Promise<void | Response>;
};

export function createChannelAdminRouteHandlers<TState>(
  spec: ChannelAdminRouteSpec<TState>,
): {
  GET(request: Request): Promise<Response>;
  PUT(request: Request): Promise<Response>;
  DELETE(request: Request): Promise<Response>;
} {
  return {
    async GET(request: Request): Promise<Response> {
      const auth = await requireJsonRouteAuth(request);
      if (auth instanceof Response) {
        return auth;
      }

      try {
        const meta = await getInitializedMeta();
        const fullState = await getPublicChannelState(request, meta);
        const state = spec.selectState(fullState);
        const result = spec.get
          ? await spec.get({
              request,
              auth,
              meta,
              url: new URL(request.url),
              fullState,
              state,
            })
          : state;

        return result instanceof Response ? result : authJsonOk(result, auth);
      } catch (error) {
        return authJsonError(error, auth);
      }
    },

    async PUT(request: Request): Promise<Response> {
      const auth = await requireJsonRouteAuth(request);
      if (auth instanceof Response) {
        return auth;
      }

      try {
        const connectability = await buildChannelConnectability(spec.channel, request);
        if (!connectability.canConnect) {
          return buildChannelConnectBlockedResponse(auth, connectability);
        }

        return await withSandboxLifecycleMutationLock(async (assertOwned) => {
          await assertOwned();
          const fence = await getHostMutationFence();
          if (fence) return buildHostIngressFencedResponse(fence);

          await assertOwned();
          const meta = await getInitializedMeta();
          const result = await spec.put({
            request,
            auth,
            meta,
            url: new URL(request.url),
            assertMutationOwned: assertOwned,
          });
          if (result instanceof Response) return result;

          await assertOwned();
          const { liveConfigSync } =
            await applyChannelConfigChangeUnderLifecycleLock({
              channel: spec.channel,
              operation: "put",
            }, assertOwned);

          const nextState = spec.selectState(await getPublicChannelState(request));
          const body = {
            ...nextState,
            liveConfigSync: toLiveConfigSyncPayload(liveConfigSync),
          };
          const response = authJsonOk(body, auth);
          return attachLiveConfigSyncHeaders(response, liveConfigSync);
        });
      } catch (error) {
        return authJsonError(error, auth);
      }
    },

    async DELETE(request: Request): Promise<Response> {
      const auth = await requireJsonRouteAuth(request);
      if (auth instanceof Response) {
        return auth;
      }

      try {
        return await withSandboxLifecycleMutationLock(async (assertOwned) => {
          await assertOwned();
          const fence = await getHostMutationFence();
          if (fence) return buildHostIngressFencedResponse(fence);

          await assertOwned();
          const meta = await getInitializedMeta();
          const result = await spec.delete({
            request,
            auth,
            meta,
            url: new URL(request.url),
            assertMutationOwned: assertOwned,
          });
          if (result instanceof Response) return result;

          await assertOwned();
          const { liveConfigSync } =
            await applyChannelConfigChangeUnderLifecycleLock({
              channel: spec.channel,
              operation: "delete",
            }, assertOwned);

          await assertOwned();
          const afterDeleteResult = await spec.afterDeleteApplied?.({
            request,
            auth,
            meta,
            url: new URL(request.url),
            assertMutationOwned: assertOwned,
            liveConfigSync,
          });
          if (afterDeleteResult instanceof Response) return afterDeleteResult;

          const nextState = spec.selectState(await getPublicChannelState(request));
          const body = {
            ...nextState,
            liveConfigSync: toLiveConfigSyncPayload(liveConfigSync),
          };
          const response = authJsonOk(body, auth);
          return attachLiveConfigSyncHeaders(response, liveConfigSync);
        });
      } catch (error) {
        return authJsonError(error, auth);
      }
    },
  };
}

function toLiveConfigSyncPayload(
  syncResult: LiveConfigSyncResult,
): {
  outcome: string;
  reason: string | null;
  liveConfigFresh: boolean;
  operatorMessage: string | null;
} {
  return {
    outcome: syncResult.outcome,
    reason: syncResult.reason,
    liveConfigFresh: syncResult.liveConfigFresh,
    operatorMessage: syncResult.operatorMessage,
  };
}

function attachLiveConfigSyncHeaders(
  response: Response,
  syncResult: LiveConfigSyncResult,
): Response {
  response.headers.set(LIVE_CONFIG_SYNC_OUTCOME_HEADER, syncResult.outcome);
  if (syncResult.operatorMessage) {
    response.headers.set(LIVE_CONFIG_SYNC_MESSAGE_HEADER, syncResult.operatorMessage);
  }
  return response;
}
