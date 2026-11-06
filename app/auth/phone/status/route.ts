import { guardianPhoneAuthStatus } from "@/lib/auth/sms-delivery";

export const runtime = "nodejs";

export async function GET() {
  return Response.json(await guardianPhoneAuthStatus(), { headers: { "Cache-Control": "no-store" } });
}
