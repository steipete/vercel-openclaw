import assert from "node:assert/strict";
import test from "node:test";

import type { ChannelName } from "@/shared/channels";
import {
  FastPathFallbackReason,
  FastPathOutcomeKind,
  FastPathSkipReason,
  ForwardClassification,
} from "@/server/channels/core/outcomes";

import { createChannelRegressionHarness } from "@/test-utils/channel-regression/channel-regression-harness";
import { responseOutcome, sandboxNotListeningResponse } from "@/test-utils/channel-regression/fake-channel-gateway";
import { assertLastForward, assertNoUserVisibleDelivery, assertStructuredSkip } from "@/test-utils/channel-regression/assertions";

const ROUTE_FAST_PATH_CHANNELS: ChannelName[] = ["slack", "telegram"];

const failureCases = [
  {
    name: "handler error",
    response: responseOutcome(500, "handler failed"),
    classification: ForwardClassification.HandlerError,
  },
  {
    name: "proxy error",
    response: responseOutcome(502, "Bad Gateway"),
    classification: ForwardClassification.ProxyError,
  },
  {
    name: "handler not ready",
    response: responseOutcome(404, "Not Found"),
    classification: ForwardClassification.HandlerNotReady,
  },
  {
    name: "sandbox not listening",
    response: sandboxNotListeningResponse(),
    classification: ForwardClassification.SandboxNotListening,
  },
] as const;

for (const channel of ROUTE_FAST_PATH_CHANNELS) {
  test(`FP-01 ${channel}: accepted fast path records lastForward`, async () => {
    const h = createChannelRegressionHarness();
    h.gateway.enqueueChannel(channel, responseOutcome(200, "accepted"));

    const outcome = await h.deliverFastPath({ channel });

    assert.equal(outcome.kind, FastPathOutcomeKind.Accepted);
    assertLastForward({
      store: h.store,
      channel,
      classification: ForwardClassification.Accepted,
      ok: true,
      attempts: 1,
      userVisibleReplyStatus: "unknown",
    });
  });

  for (const failure of failureCases) {
    test(`FP ${channel}: route fast path ${failure.name} records failed lastForward`, async () => {
      const h = createChannelRegressionHarness();
      h.gateway.enqueueChannel(channel, failure.response);

      const outcome = await h.deliverFastPath({ channel });

      assert.equal("classification" in outcome ? outcome.classification : null, failure.classification);
      assertLastForward({
        store: h.store,
        channel,
        classification: failure.classification,
        ok: false,
        attempts: 1,
        userVisibleReplyStatus: "unknown",
      });
      assertNoUserVisibleDelivery({ store: h.store, channel });
    });
  }

  test(`FP-06 ${channel}: route fast path fetch exception records unknown delivery without replay`, async () => {
    const h = createChannelRegressionHarness();
    h.gateway.throwChannelOnce(channel, new Error("connect ECONNRESET"));

    const outcome = await h.deliverFastPath({ channel });

    assert.equal(outcome.kind, FastPathOutcomeKind.FallbackToWorkflow);
    assert.equal(outcome.reason, FastPathFallbackReason.FetchException);
    assertLastForward({
      store: h.store,
      channel,
      classification: ForwardClassification.FetchException,
      ok: false,
      attempts: 1,
      userVisibleReplyStatus: "unknown",
    });
    assert.equal(h.workflow.events.some((event) => event.type === "workflow-started"), false);
  });

  test(`FP-07 ${channel}: route fast path abort timeout preserves timeout reason and indeterminate flag`, async () => {
    const h = createChannelRegressionHarness();
    h.gateway.throwChannelOnce(channel, Object.assign(new Error("signal timed out"), { name: "TimeoutError" }));

    const outcome = await h.deliverFastPath({ channel });

    assert.equal(outcome.kind, FastPathOutcomeKind.FallbackToWorkflow);
    assert.equal(outcome.reason, FastPathFallbackReason.FastPathTimeout);
    assert.equal(outcome.indeterminateDelivery, true);
    assertLastForward({
      store: h.store,
      channel,
      classification: ForwardClassification.FetchException,
      ok: false,
    });
  });

  test(`FP-08 ${channel}: route fast path snapshotting skip is structured and starts wake workflow`, () => {
    const h = createChannelRegressionHarness({ status: "snapshotting" });

    const outcome = h.skipFastPath({ channel });

    assertStructuredSkip(outcome, FastPathSkipReason.SandboxStatusNotRunning);
    assert.equal(h.workflow.events.some((event) => event.type === "boot-message"), true);
    assert.equal(h.workflow.events.some((event) => event.type === "workflow-started"), true);
  });

  test(`FP-10 ${channel}: route fast path running without sandboxId skip is structured`, () => {
    const h = createChannelRegressionHarness({ status: "running", sandboxId: null });

    const outcome = h.skipFastPath({ channel });

    assertStructuredSkip(outcome, FastPathSkipReason.MissingSandboxId);
  });
}

for (const failure of failureCases) {
  test(`FP classifier discord: shared ${failure.name} projection is covered without claiming route fast path`, async () => {
    const channel: ChannelName = "discord";
    const h = createChannelRegressionHarness();
    h.gateway.enqueueChannel(channel, failure.response);

    const outcome = await h.deliverFastPath({ channel });

    assert.equal("classification" in outcome ? outcome.classification : null, failure.classification);
    assertLastForward({
      store: h.store,
      channel,
      classification: failure.classification,
      ok: false,
      attempts: 1,
      userVisibleReplyStatus: "unknown",
    });
  });
}
