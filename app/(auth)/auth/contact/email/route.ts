import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { boundMfaSession, readStaffMfaStatus, StaffMfaError } from "@/lib/auth/staff-mfa";
import { requestContactEmail, sameOriginContactPost } from "@/lib/auth/contact-change";

const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
export async function POST(request: Request) {
  const origin = sameOriginContactPost(request);
  if (!origin) return NextResponse.json({ error: "invalid_request" }, { status: 403, headers });
  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (typeof body?.userId !== "string" || !email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400, headers });
  }
  try {
    const primary = await createClient();
    const session = await boundMfaSession(primary, body.userId);
    const security = await readStaffMfaStatus(primary, body.userId);
    if (!session || !security?.allowed || !security.profile_school_id || !security.roles.some((role) => role.role === "parent" && role.school_id === security.profile_school_id)) {
      return NextResponse.json({ error: "verification_required" }, { status: 403, headers });
    }
    const verified = await primary.auth.getUser(session.access_token);
    if (verified.error || verified.data.user?.id !== body.userId || !verified.data.user.email_confirmed_at || !verified.data.user.email) {
      return NextResponse.json({ error: "verification_required" }, { status: 403, headers });
    }
    if (verified.data.user.email.toLowerCase() === email) return NextResponse.json({ error: "invalid_email" }, { status: 400, headers });
    const result = await requestContactEmail(primary, session, email, origin);
    if (result.error) {
      const limited = result.error.status === 429;
      if (["email_exists", "user_already_exists"].includes(result.error.code ?? "")) {
        return NextResponse.json({ error: "contact_unavailable" }, { status: 409, headers });
      }
      return NextResponse.json({ error: limited ? "rate_limited" : "email_unconfirmed" }, { status: limited ? 429 : 502, headers });
    }
    return NextResponse.json({ ok: true }, { headers });
  } catch (error) {
    const access = error instanceof StaffMfaError || error instanceof Error && error.message === "invalid_owner";
    return NextResponse.json({ error: access ? "verification_required" : "email_unconfirmed" }, { status: access ? 403 : 502, headers });
  }
}
