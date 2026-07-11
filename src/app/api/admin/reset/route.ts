import { NextResponse } from "next/server";

import { requireMutationAuth } from "@/server/auth/route-auth";
import { getPublicOrigin } from "@/server/public-url";
import { resetSandbox } from "@/server/sandbox/lifecycle";

export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) return auth;

  const meta = await resetSandbox({
    origin: getPublicOrigin(request),
    reason: "admin.reset",
  });
  return NextResponse.json({
    ok: true,
    message: "Sandbox reset completed",
    status: meta.status,
  });
}
