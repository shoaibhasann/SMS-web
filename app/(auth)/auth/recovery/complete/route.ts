import { NextResponse } from "next/server";
import { createRecoveryClient, sameOriginRecoveryPost, verifiedRecoverySession } from "@/lib/auth/recovery";
import { readStaffMfaStatus } from "@/lib/auth/staff-mfa";
import { passwordProblem } from "@/lib/account/password-rule";

const headers = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  const origin = sameOriginRecoveryPost(request);
  if (!origin) return NextResponse.json({ error: "invalid_recovery" }, { status: 403, headers });

  const body = await request.json().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";
  if (passwordProblem(password)) {
    return NextResponse.json({ error: "invalid_password" }, { status: 400, headers });
  }

  try {
    const { supabase, clearSession } = await createRecoveryClient(origin.startsWith("https:"));
    const recovery = await verifiedRecoverySession(supabase);
    if (!recovery || recovery.sessionId !== body?.sessionId) {
      return NextResponse.json({ error: "invalid_recovery" }, { status: 403, headers });
    }
    const security = await readStaffMfaStatus(supabase, recovery.userId);
    if (!security) return NextResponse.json({ error: "invalid_recovery" }, { status: 403, headers });
    if (!security.allowed) return NextResponse.json({ error: "mfa_required" }, { status: 409, headers });

    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      if (error.code === "weak_password" || error.code === "same_password" || error.code === "validation_failed") {
        return NextResponse.json({ error: "invalid_password" }, { status: 400, headers });
      }
      if (error.status === 401 || error.status === 403) {
        return NextResponse.json({ error: "invalid_recovery" }, { status: 403, headers });
      }
      return NextResponse.json({ error: "retry" }, { status: 502, headers });
    }

    // Sign out of this recovery session only. An unrelated account may be
    // using the ordinary application cookies in another tab.
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      // The password was updated. Remove local recovery cookies even if Auth cannot sign out.
    } finally {
      clearSession();
    }
    return NextResponse.json({ ok: true }, { headers });
  } catch {
    return NextResponse.json({ error: "retry" }, { status: 502, headers });
  }
}
