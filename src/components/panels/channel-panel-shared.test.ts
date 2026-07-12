import assert from "node:assert/strict";
import test from "node:test";

import { getChannelActionLabel } from "@/components/panels/channel-panel-shared";

test("getChannelActionLabel keeps connect/update/disconnect vocabulary aligned", () => {
  assert.equal(getChannelActionLabel("slack", "connect"), "Connect Slack");
  assert.equal(
    getChannelActionLabel("telegram", "update"),
    "Update Telegram credentials",
  );
  assert.equal(
    getChannelActionLabel("discord", "disconnect"),
    "Disconnect Discord (cleanup only)",
  );
  assert.equal(
    getChannelActionLabel("whatsapp", "disconnect"),
    "Disconnect WhatsApp (cleanup only)",
  );
});
