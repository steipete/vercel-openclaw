import assert from "node:assert/strict";
import test from "node:test";

import type { PublicWhatsAppState } from "@/shared/channel-admin-state";

import { buildWhatsAppOverviewRow } from "./command-shell";

function makeWhatsAppState(
  overrides: Partial<PublicWhatsAppState> = {},
): PublicWhatsAppState {
  return {
    configured: true,
    mode: "unsupported",
    webhookUrl: null,
    status: "disconnected",
    configuredAt: 1,
    displayName: null,
    linkedPhone: null,
    lastError: null,
    requiresRunningSandbox: false,
    loginVia: null,
    connectability: {
      channel: "whatsapp",
      mode: "unsupported",
      canConnect: false,
      status: "fail",
      webhookUrl: null,
      issues: [],
    },
    ...overrides,
  };
}

test("WhatsApp overview renders legacy cleanup state as unavailable", () => {
  assert.deepEqual(buildWhatsAppOverviewRow(makeWhatsAppState()), {
    name: "WhatsApp",
    state: "unavailable",
    tone: "muted",
  });
});

test("WhatsApp overview preserves configured state for a supported transport", () => {
  assert.deepEqual(
    buildWhatsAppOverviewRow(
      makeWhatsAppState({
        mode: "gateway-native",
        status: "linked",
      }),
    ),
    {
      name: "WhatsApp",
      state: "linked",
      tone: "success",
    },
  );
});
