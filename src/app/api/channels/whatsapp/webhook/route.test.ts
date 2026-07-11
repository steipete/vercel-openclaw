import assert from "node:assert/strict";
import test from "node:test";

import {
  GET,
  POST,
} from "@/app/api/channels/whatsapp/webhook/route";

for (const [method, handler] of [
  ["GET", GET],
  ["POST", POST],
] as const) {
  test(`${method} WhatsApp webhook fails closed while hosted transport is unavailable`, async () => {
    const response = await handler();
    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: {
        code: "HOSTED_WHATSAPP_TRANSPORT_UNAVAILABLE",
        message:
          "Hosted WhatsApp is disabled: this app expects Meta Cloud API webhooks, while the bundled OpenClaw WhatsApp channel uses linked-device transport.",
      },
    });
  });
}
