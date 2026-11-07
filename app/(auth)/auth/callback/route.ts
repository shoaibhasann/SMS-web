import { NextResponse } from "next/server";
import { guardianContactPath, guardianEmailContinuation, safeAuthRedirect } from "@/lib/auth/redirect";
import { createClient } from "@/lib/supabase/server";
import { finishGuardianEmailChange } from "@/lib/auth/contact-change";
import {
  allowedRecoveryOrigin, createRecoveryClient, recoveryDestination, recoveryFailureDestination, verifiedRecoverySession,
} from "@/lib/auth/recovery";

async function recover(url: URL, code: string | null) {
  function redirect(path: string) {
    const response = NextResponse.redirect(new URL(path, url.origin));
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  }

  if (!allowedRecoveryOrigin(url) || !code?.trim() || url.searchParams.has("error") || url.searchParams.has("error_code")) {
    return redirect(recoveryFailureDestination);
  }
  try {
    const { supabase, clearSession } = await createRecoveryClient(url.protocol === "https:");
    const flowId = url.searchParams.get("sb_flow_id");
    const { data, error } = await supabase.auth.exchangeCodeForSession(code, flowId === null ? undefined : { flowId });
    if (error || !data.session) return redirect(recoveryFailureDestination);

    const recovery = await verifiedRecoverySession(supabase, data.session.access_token);
    if (!recovery || recovery.userId !== data.user?.id) {
      clearSession();
      return redirect(recoveryFailureDestination);
    }
    return redirect(recoveryDestination);
  } catch {
    return redirect(recoveryFailureDestination);
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeAuthRedirect(url.searchParams.get("next"));
  if (new URL(next, url.origin).pathname === recoveryDestination) return recover(url, code);
  const invitationContinuation = next === "/guardian-invite" || next === "/teacher-invite" || next === "/guardian-recover";
  const guardianContactContinuation = next === guardianEmailContinuation;
  const contactUrl = (status: "email-pending" | "email-returned" | "email-link-error") => {
    const destination = new URL(guardianContactPath, url.origin);
    destination.searchParams.set("contact", status);
    return destination;
  };
  const failureUrl = guardianContactContinuation ? contactUrl("email-link-error")
    : new URL(invitationContinuation ? next : "/login?error=auth_callback_failed", url.origin);

  function respond(destination: URL) {
    const response = NextResponse.redirect(destination);
    if (guardianContactContinuation) {
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("Referrer-Policy", "no-referrer");
    }
    return response;
  }

  if (guardianContactContinuation) return respond(contactUrl(await finishGuardianEmailChange(url, code)));

  if (url.searchParams.has("error")) return respond(failureUrl);
  if (!code?.trim()) {
    return NextResponse.redirect(invitationContinuation
      ? failureUrl
      : new URL("/login?error=auth_callback_missing_code", url.origin));
  }

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error || !data.session) return respond(failureUrl);
  } catch {
    return respond(failureUrl);
  }

  return respond(guardianContactContinuation ? contactUrl("email-returned") : new URL(next, url.origin));
}
