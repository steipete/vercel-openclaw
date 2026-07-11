export const HOSTED_WHATSAPP_UNAVAILABLE_CODE =
  "HOSTED_WHATSAPP_TRANSPORT_UNAVAILABLE" as const;

export const HOSTED_WHATSAPP_UNAVAILABLE_MESSAGE =
  "Hosted WhatsApp is disabled: this app expects Meta Cloud API webhooks, while the bundled OpenClaw WhatsApp channel uses linked-device transport." as const;

export function hostedWhatsAppUnavailableResponse(status = 410): Response {
  return Response.json(
    {
      ok: false,
      error: {
        code: HOSTED_WHATSAPP_UNAVAILABLE_CODE,
        message: HOSTED_WHATSAPP_UNAVAILABLE_MESSAGE,
      },
    },
    { status },
  );
}
