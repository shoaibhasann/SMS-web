"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import {
  confirmGuardianMobileChange, createGuardianVerificationClient, guardianPhone, readGuardianAuthUser,
  readGuardianContactProviders, requestGuardianEmailChange, requestGuardianMobileChange, syncVerifiedGuardianMobile,
  type GuardianContactProviders,
} from "@/lib/guardian-invitations/contact";
import { LoadingState } from "@/components/ui/skeleton";

type Notice = { text: string; error?: boolean };
type ProviderState = GuardianContactProviders | "unavailable";
const label = "block space-y-2 text-sm font-semibold";
const button = "min-h-11 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)] disabled:opacity-60";
const primaryButton = `${button} bg-blue-700 text-white`;

export function GuardianContactSettings({ userId, callbackStatus }: { userId: string; callbackStatus: string | null }) {
  const [client] = useState(createClient);
  const [account, setAccount] = useState<User>();
  const [provider, setProvider] = useState<ProviderState>();
  const [attempt, setAttempt] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [sessionChanged, setSessionChanged] = useState(false);
  const [email, setEmail] = useState("");
  const [mobile, setMobile] = useState("");
  const [notice, setNotice] = useState<Notice>();
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const pending = useRef(false);

  useEffect(() => {
    active.current = true;
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) {
        active.current = false;
        setSessionChanged(true);
      }
    });
    return () => {
      active.current = false;
      subscription.unsubscribe();
    };
  }, [client, userId]);

  useEffect(() => {
    if (sessionChanged) return;
    let current = true;
    readGuardianAuthUser(client, userId).then((user) => {
      if (!current) return;
      setAccount(user);
      setLoadError("");
    }, (error: unknown) => {
      if (!current) return;
      setAccount(undefined);
      setLoadError(error instanceof Error ? error.message : "Contact details could not be loaded.");
    });
    readGuardianContactProviders().then((result) => {
      if (current) setProvider(result);
    }, () => {
      if (current) setProvider("unavailable");
    });
    return () => { current = false; };
  }, [attempt, client, sessionChanged, userId]);

  const verifiedEmail = account?.email_confirmed_at ? account.email : "";
  const verifiedMobile = account?.phone_confirmed_at ? guardianPhone(account.phone) : "";
  const pendingEmail = account?.new_email && account.new_email !== verifiedEmail ? account.new_email : "";
  const pendingMobile = guardianPhone(account?.new_phone);
  const emailEnabled = provider !== "unavailable" && provider?.email;
  const smsEnabled = provider !== "unavailable" && provider?.sms;

  async function run(action: () => Promise<Notice>) {
    if (!active.current || pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await action();
      if (active.current) setNotice(result);
    } catch (error: unknown) {
      if (active.current) setNotice({ text: error instanceof Error ? error.message : "The request could not be completed.", error: true });
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }

  async function refreshContacts() {
    await run(async () => {
      const user = await readGuardianAuthUser(client, userId);
      if (!active.current) return { text: "" };
      setAccount(user);
      const phone = user.phone_confirmed_at && guardianPhone(user.phone);
      if (phone && !await syncVerifiedGuardianMobile(client, phone)) {
        return { text: "Your mobile is verified. The school record could not be refreshed. Try again or contact the school office.", error: true };
      }
      return { text: "Contact details refreshed." };
    });
  }

  async function requestEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!emailEnabled) return;
    await run(async () => {
      if (!(await readGuardianContactProviders()).email) throw new Error("Email verification is unavailable for this school.");
      const user = await requestGuardianEmailChange(client, userId, email, window.location.origin);
      if (active.current) {
        setAccount(user);
        setEmail("");
      }
      return { text: "Email confirmation requested. Follow the links in the email inboxes before using your new address." };
    });
  }

  async function requestMobile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!smsEnabled || pending.current) return;
    const password = new FormData(event.currentTarget).get("currentPassword");
    event.currentTarget.reset();
    await run(async () => {
      if (!(await readGuardianContactProviders()).sms) throw new Error("SMS verification is unavailable for this school.");
      const user = await requestGuardianMobileChange(client, createGuardianVerificationClient(), userId, mobile, String(password ?? ""));
      if (active.current) {
        setAccount(user);
        setMobile("");
      }
      return { text: "SMS verification code requested. Enter the code sent to the pending number." };
    });
  }

  async function verifyMobile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!smsEnabled || pending.current) return;
    const code = new FormData(event.currentTarget).get("smsCode");
    event.currentTarget.reset();
    await run(async () => {
      if (!(await readGuardianContactProviders()).sms) throw new Error("SMS verification is unavailable for this school.");
      const user = await confirmGuardianMobileChange(client, createGuardianVerificationClient(), userId, pendingMobile, String(code ?? ""));
      if (!active.current) return { text: "" };
      setAccount(user);
      const synced = await syncVerifiedGuardianMobile(client, guardianPhone(user.phone));
      return synced ? { text: "Mobile number verified and updated." }
        : { text: "Mobile number verified. Refresh contact details to finish updating the school record.", error: true };
    });
  }

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <p className="text-xs font-bold uppercase tracking-widest text-blue-700 dark:text-blue-300">Profile</p>
        <h1 className="text-3xl font-black">Guardian contact settings</h1>
        <p className="text-sm muted">Manage the sign-in email and registered mobile for this account. Your linked children stay with this account.</p>
      </header>
      {sessionChanged ? <p role="alert" className="card p-4 text-sm">Your account changed. Sign in again to manage contact details.</p>
        : loadError ? (
          <section className="card space-y-3 p-4">
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">{loadError}</p>
            <button type="button" className={button} onClick={() => {
              setLoadError("");
              setAttempt((value) => value + 1);
            }}>Retry contact check</button>
          </section>
        ) : !account ? <LoadingState variant="form" className="text-sm muted">Loading your contact details…</LoadingState>
        : <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm muted">Keep access to the inbox or number you want to verify.</p>
            <button type="button" className={button} disabled={busy} onClick={() => void refreshContacts()}>Refresh contact details</button>
          </div>
          {callbackStatus === "email-pending" && pendingEmail &&
            <p role="status" className="card p-4 text-sm">Email confirmation is still pending. Check both inboxes to finish the change.</p>}
          {callbackStatus === "email-returned" &&
            <p role="status" className="card p-4 text-sm">Check the verified email below. Any pending change still needs confirmation.</p>}
          {callbackStatus === "email-link-error" &&
            <p role="alert" className="card p-4 text-sm">The confirmation link did not return to this session. Refresh your contact details or sign in with the email that completed confirmation.</p>}
          {provider === "unavailable" &&
            <section className="card space-y-3 p-4">
              <p role="alert" className="text-sm text-red-700 dark:text-red-300">Contact verification settings could not be checked.</p>
              <button type="button" className={button} disabled={busy} onClick={() => {
                setProvider(undefined);
                setAttempt((value) => value + 1);
              }}>Retry verification check</button>
            </section>}
          {notice && <p role={notice.error ? "alert" : "status"}
            className={`card p-4 text-sm ${notice.error ? "text-red-700 dark:text-red-300" : "text-emerald-700 dark:text-emerald-300"}`}>{notice.text}</p>}

          <section className="card space-y-4 p-4 sm:p-5" aria-labelledby="guardian-sign-in-email">
            <div>
              <h2 id="guardian-sign-in-email" className="text-lg font-bold">Sign-in email</h2>
              <p className="mt-1 break-all text-sm muted">Verified email · {verifiedEmail || "Unavailable"}</p>
            </div>
            {pendingEmail && <p className="break-all rounded-xl border border-[var(--border)] p-3 text-sm">Confirmation pending for {pendingEmail}.</p>}
            {emailEnabled && verifiedEmail ? (
              <form onSubmit={(event) => void requestEmail(event)} className="max-w-md space-y-3">
                <p className="text-sm muted">Open the confirmation links from both inboxes in the browser where you requested the change.</p>
                <label className={label}><span>New email address</span>
                  <input type="email" autoComplete="email" className="field" required maxLength={254} value={email}
                    disabled={busy} onChange={(event) => setEmail(event.target.value)} />
                </label>
                <button type="submit" className={primaryButton} disabled={busy || !email.trim()}>Send email confirmation</button>
              </form>
            ) : provider && provider !== "unavailable" &&
              <p className="text-sm muted">{verifiedEmail ? "Email verification is unavailable for this school." : "Contact the school office to verify your sign-in email."}</p>}
          </section>

          <section className="card space-y-4 p-4 sm:p-5" aria-labelledby="guardian-registered-mobile">
            <div>
              <h2 id="guardian-registered-mobile" className="text-lg font-bold">Registered mobile</h2>
              <p className="mt-1 break-all text-sm muted">Verified mobile · {verifiedMobile || "No mobile verified"}</p>
            </div>
            {pendingMobile && <p className="break-all rounded-xl border border-[var(--border)] p-3 text-sm">SMS verification pending for {pendingMobile}.</p>}
            {!provider && <LoadingState variant="form" className="text-sm muted">Checking contact verification availability…</LoadingState>}
            {smsEnabled && verifiedEmail ? (
              <div className="max-w-md space-y-4">
                {pendingMobile && (
                  <form onSubmit={(event) => void verifyMobile(event)} className="space-y-3">
                    <label className={label}><span>SMS verification code</span>
                      <input name="smsCode" className="field" type="text" inputMode="numeric" autoComplete="one-time-code"
                        required minLength={6} maxLength={6} pattern="[0-9]{6}" disabled={busy} />
                    </label>
                    <button type="submit" className={primaryButton} disabled={busy}>Verify mobile number</button>
                  </form>
                )}
                <form onSubmit={(event) => void requestMobile(event)} className="space-y-3">
                  <p className="text-sm muted">Confirm your password and enter the code sent to the new number. Include the country code.</p>
                  <label className={label}><span>New mobile number</span>
                    <input type="tel" autoComplete="tel" placeholder="+91" className="field" required maxLength={25}
                      value={mobile} disabled={busy} onChange={(event) => setMobile(event.target.value)} />
                  </label>
                  <label className={label}><span>Current password</span>
                    <input name="currentPassword" type="password" autoComplete="current-password" className="field" required disabled={busy} />
                  </label>
                  <button type="submit" className={primaryButton} disabled={busy || !mobile.trim()}>Send SMS code</button>
                </form>
              </div>
            ) : provider && provider !== "unavailable" &&
              <p className="text-sm muted">{!smsEnabled ? "SMS verification is unavailable. The school must enable phone authentication and configure an SMS provider before you can verify a new mobile."
                : "A verified sign-in email is required to confirm your password. Contact the school office."}</p>}
          </section>
        </>}
    </div>
  );
}
