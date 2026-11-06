"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { User } from "@supabase/supabase-js";
import { GuardianPhoneOtpForm } from "@/components/auth/phone-otp-form";
import { LoadingState } from "@/components/ui/skeleton";
import { normalizeIndianMobile } from "@/lib/auth/phone";
import { guardianAttendancePath, rememberFamilyChild } from "@/lib/attendance/family";
import { createClient } from "@/lib/supabase/client";

const primaryButton = "w-full rounded-xl bg-blue-700 px-4 py-3 text-sm font-bold text-white hover:bg-blue-800 disabled:opacity-50";
const textButton = "text-sm font-semibold text-blue-700 underline underline-offset-4 dark:text-blue-300 disabled:opacity-50";

function subscribeToHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function inviteHash() { return window.location.hash; }

export function GuardianMobileInvitation() {
  const hash = useSyncExternalStore(subscribeToHash, inviteHash, () => null);
  const token = hash?.match(/^#token=([a-f0-9]{64})$/)?.[1];

  return <main className="grid min-h-screen place-items-center bg-[var(--bg)] p-4 sm:p-6">
    <section className="card w-full max-w-lg overflow-hidden" aria-labelledby="mobile-invite-heading">
      <header className="gradient p-5 text-white sm:p-7">
        <p className="text-[30px] font-black leading-none tracking-[-0.045em]">SMS</p>
        <h1 id="mobile-invite-heading" className="mt-3 text-2xl font-black">Guardian mobile invitation</h1>
      </header>
      <div className="space-y-5 p-5 sm:p-7">
        {hash === null ? <LoadingState variant="form">Opening invitation…</LoadingState>
          : token ? <MobileInviteForm key={token} token={token} />
          : <>
            <p className="text-sm muted">Open the original mobile invitation shared privately by your school.</p>
            <Link href="/login" className={textButton}>Go to sign in</Link>
          </>}
      </div>
    </section>
  </main>;
}

function MobileInviteForm({ token }: { token: string }) {
  const [client] = useState(createClient);
  const router = useRouter();
  const [account, setAccount] = useState<User | null>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [destination, setDestination] = useState("");
  const inFlight = useRef(false);

  useEffect(() => {
    let active = true;
    void client.auth.getUser().then(({ data, error: authError }) => {
      if (active) setAccount(authError ? null : data.user);
    }, () => { if (active) setAccount(null); });
    return () => { active = false; };
  }, [client]);

  async function accept() {
    if (!account || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      const { data: current, error: authError } = await client.auth.getUser();
      if (authError || current.user?.id !== account.id
        || current.user.phone !== account.phone || current.user.phone_confirmed_at !== account.phone_confirmed_at) {
        setAccount(authError ? null : current.user);
        setError("Your sign-in changed. Check the account before accepting the invitation.");
        return;
      }
      if (current.user.is_anonymous || !current.user.phone_confirmed_at || !normalizeIndianMobile(current.user.phone ?? "")) {
        setError("Verify the invited mobile number before accepting this invitation.");
        return;
      }
      const { data, error: inviteError } = await client.rpc("accept_guardian_invitation", { p_token: token });
      if (inviteError?.code === "42501") {
        setError("This account cannot accept the invitation. Use the verified mobile your school invited, or ask the school to check your access.");
        return;
      }
      if (inviteError?.code === "P0001") {
        setError("This invitation is expired, revoked, already used, or no longer available. Ask your school for a new link if you still need access.");
        return;
      }
      if (inviteError || typeof data?.student_id !== "string") throw new Error();
      const remembered = rememberFamilyChild(account.id, data.student_id);
      const path = remembered ? guardianAttendancePath : `${guardianAttendancePath}&child=${encodeURIComponent(data.student_id)}`;
      setDestination(path);
      router.replace(path);
    } catch {
      setError("Could not complete the invitation. Try again. If it was already accepted, open Attendance from your dashboard.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  async function switchAccount() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      const result = await client.auth.signOut({ scope: "local" });
      if (result.error) throw result.error;
      setAccount(null);
    } catch {
      setError("Could not sign out. Please try again.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  if (account === undefined) return <LoadingState variant="form">Checking your sign-in…</LoadingState>;
  if (destination) return <div className="space-y-3">
    <p role="status" className="text-sm muted">Invitation accepted. Opening attendance…</p>
    <Link href={destination} className={textButton}>Open attendance</Link>
  </div>;

  const phone = account?.phone_confirmed_at && normalizeIndianMobile(account.phone ?? "");
  return <>
    {error && <p role="alert" className="rounded-xl border border-red-500/40 p-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
    {account ? <div className="space-y-4">
      <p className="break-words text-sm muted">Signed in as <strong>{phone || account.email || "your account"}</strong>.</p>
      {phone && !account.is_anonymous ? <>
        <p className="text-sm muted">Accept this invitation to link your school account and view the child’s attendance history.</p>
        <button type="button" className={primaryButton} disabled={pending} onClick={() => void accept()}>Accept invitation</button>
      </> : <>
        <p className="text-sm muted">This account has no verified mobile. If you already use an email guardian account, verify your mobile from that account’s contact settings to keep your existing child links.</p>
        <Link href="/modules/profile?view=guardian" className={textButton}>Open guardian contact settings</Link>
      </>}
      <button type="button" className={textButton} disabled={pending} onClick={() => void switchAccount()}>Use a different account</button>
      {pending && <p role="status" className="text-sm muted">Please wait…</p>}
    </div> : <div className="space-y-4">
      <p className="text-sm muted">Verify the mobile number invited by your school. No email or password is required for a new mobile account. Verification alone does not link a child; you must accept the invitation next.</p>
      <GuardianPhoneOtpForm purpose="invitation" onVerified={setAccount} />
      <p className="text-sm muted">Already use an email guardian account? <Link href="/login" className={textButton}>Sign in with email</Link>, verify your mobile in contact settings, then reopen this invitation. Do not create a second account.</p>
    </div>}
  </>;
}
