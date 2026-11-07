import { NextResponse } from "next/server";
import { createRecoveryClient, sameOriginRecoveryPost, verifiedRecoverySession } from "@/lib/auth/recovery";
import { listAuthenticators, readStaffMfaStatus } from "@/lib/auth/staff-mfa";

const headers = { "Cache-Control": "no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const denied = () => NextResponse.json({ error: "invalid_recovery" }, { status: 403, headers });

export async function POST(request: Request) {
  const origin = sameOriginRecoveryPost(request);
  if (!origin) return denied();
  const body = await request.json().catch(() => null);
  if (typeof body?.code !== "string" || !/^\d{6}$/.test(body.code) || typeof body?.factorId !== "string" || !uuid.test(body.factorId)
    || typeof body?.sessionId !== "string" || !uuid.test(body.sessionId)) return NextResponse.json({ error: "invalid_code" }, { status: 400, headers });
  try {
    const { supabase } = await createRecoveryClient(origin.startsWith("https:"));
    const recovery = await verifiedRecoverySession(supabase);
    if (!recovery || recovery.sessionId !== body.sessionId) return denied();
    const security = await readStaffMfaStatus(supabase, recovery.userId);
    if (!security) return denied();
    if (security.allowed) return NextResponse.json({ ok: true }, { headers });
    if (security.action !== "challenge") return denied();
    const factors = await listAuthenticators(supabase);
    if (!factors.some(factor => factor.id === body.factorId)) return denied();
    const verified = await supabase.auth.mfa.challengeAndVerify({ factorId: body.factorId, code: body.code });
    if (verified.error) {
      if (verified.error.status === 429) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers });
      if (["mfa_verification_failed", "mfa_challenge_expired", "validation_failed"].includes(verified.error.code ?? "")) return NextResponse.json({ error: "invalid_code" }, { status: 422, headers });
      return denied();
    }
    const current = await verifiedRecoverySession(supabase);
    if (!current || current.userId !== recovery.userId || current.sessionId !== recovery.sessionId) return denied();
    const elevated = await readStaffMfaStatus(supabase, recovery.userId);
    if (!elevated?.allowed || elevated.current_aal !== "aal2") return denied();
    return NextResponse.json({ ok: true }, { headers });
  } catch { return NextResponse.json({ error: "retry" }, { status: 502, headers }); }
}
