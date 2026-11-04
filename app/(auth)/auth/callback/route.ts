import { NextResponse } from "next/server";
import { safeAuthRedirect } from "@/lib/auth/redirect";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeAuthRedirect(url.searchParams.get("next"));
  const guardianContinuation = next === "/guardian-invite";
  const failureUrl = new URL(guardianContinuation ? next : "/login?error=auth_callback_failed", url.origin);

  if (url.searchParams.has("error")) return NextResponse.redirect(failureUrl);
  if (!code?.trim()) {
    return NextResponse.redirect(guardianContinuation
      ? failureUrl
      : new URL("/login?error=auth_callback_missing_code", url.origin));
  }

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error || !data.session) return NextResponse.redirect(failureUrl);
  } catch {
    return NextResponse.redirect(failureUrl);
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
