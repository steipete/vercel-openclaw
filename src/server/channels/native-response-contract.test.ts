import assert from "node:assert/strict";
import test from "node:test";

import {
  isAdmittedGatewayAdmissionUnavailableResponse,
  isAdmittedTelegramDurableAcceptance,
  isDefiniteNativePreAdmissionError,
} from "@/server/channels/native-response-contract";

test("native response contract: Telegram durable marker requires admitted capability", () => {
  assert.equal(
    isAdmittedTelegramDurableAcceptance(false, "durable"),
    false,
  );
  assert.equal(
    isAdmittedTelegramDurableAcceptance(true, " durable "),
    true,
  );
});

test("native response contract: gateway_unavailable requires admitted capability", () => {
  const body = JSON.stringify({ error: { code: "gateway_unavailable" } });
  assert.equal(
    isAdmittedGatewayAdmissionUnavailableResponse(false, 503, body),
    false,
  );
  assert.equal(
    isAdmittedGatewayAdmissionUnavailableResponse(true, 503, body),
    true,
  );
});

test("native response contract: connection refusal is pre-admission", () => {
  const error = Object.assign(new TypeError("fetch failed"), {
    cause: { code: "ECONNREFUSED" },
  });
  assert.equal(isDefiniteNativePreAdmissionError(error), true);
});

test("native response contract: response-loss errors stay unknown", () => {
  assert.equal(
    isDefiniteNativePreAdmissionError(
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNRESET" },
      }),
    ),
    false,
  );
  const timeout = new Error("timed out");
  timeout.name = "TimeoutError";
  assert.equal(isDefiniteNativePreAdmissionError(timeout), false);
});
