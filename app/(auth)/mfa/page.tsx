"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AccountAuthenticator } from "@/components/account/account-authenticator";
import { LoadingState } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/client";
import { readStaffMfaStatus, safeMfaNext, type StaffMfaStatus } from "@/lib/auth/staff-mfa";

function destination(next: string) {
  const fragment = window.location.hash;
  return ["/guardian-invite", "/teacher-invite", "/guardian-recover"].includes(next) && /^#token=[a-f0-9]{64}$/.test(fragment) ? `${next}${fragment}` : next;
}

export default function MfaPage() { return <Suspense fallback={<LoadingState variant="form">Checking account security…</LoadingState>}><MfaContent /></Suspense>; }
function MfaContent() {
  const [client] = useState(createClient);
  const router = useRouter();
  const params = useSearchParams();
  const next = safeMfaNext(params.get("next"));
  const requestedSetup = params.get("setup") === "1";
  const overviewContinuation = params.get("next") === "/dashboard" && params.get("stepup") !== "1";
  const [status, setStatus] = useState<StaffMfaStatus>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void readStaffMfaStatus(client, undefined, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (!result || result.action === "sign_in") { router.replace("/login"); return; }
      if (!requestedSetup && (result.allowed || (overviewContinuation && result.dashboard_allowed))) {
        router.replace(destination(next));
        router.refresh(); return;
      }
      setStatus(result); setError("");
    }, () => { if (!controller.signal.aborted) setError("Account security could not be checked. Retry or sign in again."); });
    return () => controller.abort();
  }, [attempt, client, next, overviewContinuation, requestedSetup, router]);
  function verified(result: StaffMfaStatus) {
    if (!result.allowed) { setStatus(result); return false; }
    router.replace(destination(next));
    router.refresh();
    return true;
  }
  return <main className="grid min-h-dvh place-items-center bg-[var(--bg)] px-4 py-8 sm:px-6">
    <div className="w-full max-w-xl space-y-6">
      <header><Link href="/login" className="text-3xl font-extrabold tracking-tight">SMS</Link><p className="mt-1 text-xs muted">School Management System</p>
        <h1 className="mt-7 text-2xl font-bold tracking-tight sm:text-3xl">{status?.action === "enroll" || requestedSetup ? "Secure your school account" : "One more security check"}</h1>
        <p className="mt-2 text-sm leading-6 muted">{status?.action === "enroll" ? "Your school requires an authenticator before you can open its workspace." : "Your school records stay protected until account verification is complete."}</p></header>
      {error ? <section className="card space-y-4 p-5"><p role="alert" className="text-sm muted">{error}</p><button type="button" className="min-h-11 rounded-xl border border-[var(--border)] px-4 text-sm font-semibold" onClick={() => setAttempt((value) => value + 1)}>Retry verification</button></section>
        : status ? <>
          {requestedSetup && status.allowed && status.verified_totp_count > 0 && <section className="card space-y-3 p-5"><p className="text-sm leading-6 muted">Your authenticator is already verified. Continue, or add a backup device below.</p><button type="button" className="account-primary inline-flex min-h-11 items-center rounded-xl px-4 text-sm font-semibold" onClick={() => { verified(status); }}>Continue to workspace</button></section>}
          <AccountAuthenticator userId={status.user_id} challengeOnly={!requestedSetup && status.action !== "enroll"} onVerified={verified} />
        </>
          : <LoadingState variant="form">Checking account security…</LoadingState>}
      <p className="text-center text-xs leading-5 muted">Lost your authenticator? Contact your school or platform operator for identity verification. Resetting your password will not remove your authenticator.</p>
      <div className="text-center"><Link href="/login" className="inline-flex min-h-11 items-center text-sm font-semibold text-[var(--primary)]">Back to sign-in options</Link></div>
    </div>
  </main>;
}
