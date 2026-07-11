import { hostedWhatsAppUnavailableResponse } from "@/server/channels/whatsapp/hosted-support";

export async function GET(): Promise<Response> {
  return hostedWhatsAppUnavailableResponse();
}

export async function POST(): Promise<Response> {
  return hostedWhatsAppUnavailableResponse();
}
