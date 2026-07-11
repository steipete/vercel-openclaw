export const OPENCLAW_DELIVERY_ACCEPTED_HEADER =
  "x-openclaw-delivery-accepted" as const;
export const OPENCLAW_DURABLE_ACCEPTANCE_VALUE = "durable" as const;
export const OPENCLAW_TELEGRAM_DURABLE_ACK_CAPABILITY =
  "telegram-durable-ack-v1" as const;
export const OPENCLAW_GATEWAY_SUSPEND_CAPABILITY =
  "gateway-suspend-v1" as const;

export type NativeDeliveryAcceptance =
  | "accepted"
  | "rejected"
  | "unknown";

export function isAdmittedTelegramDurableAcceptance(
  bundleCapabilityAdmitted: boolean,
  marker: string | null | undefined,
): boolean {
  return (
    bundleCapabilityAdmitted &&
    marker?.trim().toLowerCase() === OPENCLAW_DURABLE_ACCEPTANCE_VALUE
  );
}

/** OpenClaw rejects new HTTP work with this shape after suspension admission closes. */
export function isAdmittedGatewayAdmissionUnavailableResponse(
  bundleCapabilityAdmitted: boolean,
  status: number,
  bodyHead: string | null | undefined,
): boolean {
  return (
    bundleCapabilityAdmitted &&
    isGatewayAdmissionUnavailableResponseShape(status, bodyHead)
  );
}

export function isGatewayAdmissionUnavailableResponseShape(
  status: number,
  bodyHead: string | null | undefined,
): boolean {
  return (
    status === 503 &&
    typeof bodyHead === "string" &&
    /["']code["']\s*:\s*["']gateway_unavailable["']/i.test(bodyHead)
  );
}

const DEFINITE_PRE_ADMISSION_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ERR_INVALID_URL",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function errorCode(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** Transport failures that prove no connection reached the native handler. */
export function isDefiniteNativePreAdmissionError(error: unknown): boolean {
  const directCode = errorCode(error);
  const causeCode =
    error && typeof error === "object"
      ? errorCode((error as { cause?: unknown }).cause)
      : null;
  const code = directCode ?? causeCode;
  return code !== null && DEFINITE_PRE_ADMISSION_ERROR_CODES.has(code);
}
