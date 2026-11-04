import { NextResponse } from "next/server";
import { createRecoveryClient, recoveryDestination, sameOriginRecoveryPost } from "@/lib/auth/recovery";

const headers = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  const origin = sameOriginRecoveryPost(request);
  if (!origin) return NextResponse.json({ ok: false }, { status: 403, headers });

  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    return NextResponse.json({ ok: false }, { status: 400, headers });
  }

  try {
    const { supabase } = await createRecoveryClient(origin.startsWith("https:"), true);
    const redirectTo = new URL("/auth/callback", origin);
    redirectTo.searchParams.set("next", recoveryDestination);
    await supabase.auth.resetPasswordForEmail(email, { redirectTo: redirectTo.toString() });
  } catch {
    // Use the same result for unknown email addresses and provider failures.
  }
  return NextResponse.json({ ok: true }, { headers });
}
