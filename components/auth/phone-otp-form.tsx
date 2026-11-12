"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { User } from "@supabase/supabase-js";
import { ArrowRight, KeyRound, Loader2, Smartphone } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { normalizeIndianMobile, phoneAuthError, prepareGuardianPhoneRequest, readGuardianPhoneStatus, type GuardianPhoneStatus } from "@/lib/auth/phone";
import { LoadingState } from "@/components/ui/skeleton";
import { PhoneSecurityCheck } from "./phone-security-check";

export function GuardianPhoneOtpForm({ purpose, onVerified, disabled = false, onBusyChange }: {
  purpose: "login" | "invitation" | "recovery"; onVerified: (user: User) => void; disabled?: boolean; onBusyChange?: (busy: boolean) => void;
}) {
  const [client] = useState(createClient);
  const [status, setStatus] = useState<GuardianPhoneStatus>();
  const [version, setVersion] = useState(0);
  const [phone, setPhone] = useState("");
  const [target, setTarget] = useState("");
  const [code, setCode] = useState("");
  const [captcha, setCaptcha] = useState("");
  const [challengeVersion, setChallengeVersion] = useState(0);
  const [retryAt, setRetryAt] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const active = useRef(false);

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    readGuardianPhoneStatus(controller.signal).then(setStatus, (failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Mobile sign-in could not be checked.");
    });
    return () => controller.abort();
  }, [version]);
  useEffect(() => {
    if (!retryAt) return;
    const update = () => setRemaining(Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  async function run(action: () => Promise<void>) {
    if (pending.current || disabled) return;
    pending.current = true; setBusy(true); onBusyChange?.(true); setError(""); setNotice("");
    try { await action(); }
    catch (failure) { if (active.current) setError(failure instanceof Error ? failure.message : "Mobile sign-in could not be completed. Try again."); }
    finally { pending.current = false; if (active.current) { setBusy(false); onBusyChange?.(false); } }
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!status?.enabled || !captcha || Date.now() < retryAt) return;
    const number = target || normalizeIndianMobile(phone);
    if (!number) { setError("Enter a valid 10-digit Indian mobile number."); return; }
    await run(async () => {
      const token = captcha;
      setCaptcha(""); setChallengeVersion((value) => value + 1);
      setRetryAt(Date.now() + 60_000);
      await prepareGuardianPhoneRequest(number, token);
      if (!active.current) return;
      const response = await client.auth.signInWithOtp({ phone: number, options: { shouldCreateUser: purpose !== "login" } });
      if (response.error) throw new Error(phoneAuthError(response.error));
      if (active.current) { setTarget(number); setCode(""); setNotice("If this number is eligible, a code will arrive by SMS. Enter it below."); }
    });
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    if (!target || !/^\d{6}$/.test(code)) { setError("Enter the six-digit SMS code."); return; }
    await run(async () => {
      const token = code; setCode("");
      const response = await client.auth.verifyOtp({ phone: target, token, type: "sms" });
      const user = response.data.user;
      if (response.error || !response.data.session || !user || user.is_anonymous || !user.phone_confirmed_at
        || normalizeIndianMobile(user.phone ?? "") !== target) throw new Error(phoneAuthError(response.error, true));
      const current = await client.auth.getUser();
      if (current.error || current.data.user?.id !== user.id || normalizeIndianMobile(current.data.user.phone ?? "") !== target
        || !current.data.user.phone_confirmed_at) throw new Error("Your sign-in changed. Reopen this page before continuing.");
      if (active.current) onVerified(current.data.user);
    });
  }

  if (!status) return <div className="mt-5 space-y-3">{error ? <><p role="alert" className="login-error">{error}</p>
    <button type="button" className="login-google" onClick={() => { setError(""); setVersion((value) => value + 1); }}>Retry mobile availability</button></>
    : <LoadingState variant="form">Checking mobile sign-in…</LoadingState>}</div>;
  if (!status.enabled) return <div className="mt-5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4 text-sm leading-6 muted">
    Mobile sign-in is not available yet. Existing guardians can use email sign-in. Ask your school office about activating mobile access.
  </div>;

  return <div className="mt-5 space-y-4">
    <p className="text-sm leading-6 muted">{purpose === "recovery" ? "Use the new mobile number independently approved by your school. The SMS code verifies this contact; recovery still needs your explicit acceptance."
      : purpose === "invitation" ? "Use the mobile number your school invited. Already have an email account? Verify your mobile from that account first to keep your child links."
      : "Use the mobile verified on your guardian account. Staff and students should use email sign-in."}</p>
    {!target ? <form onSubmit={send} className="space-y-4" aria-label="Request guardian SMS code">
      <div>
        <label className="login-label" htmlFor="guardian-mobile">Mobile number</label>
        <div className="login-input-wrap"><Smartphone className="login-input-icon" size={18} aria-hidden="true" />
          <input id="guardian-mobile" type="tel" inputMode="tel" autoComplete="tel" className="login-input" placeholder="10-digit mobile number"
            required maxLength={25} value={phone} disabled={busy || disabled} onChange={(event) => setPhone(event.target.value)} /></div>
      </div>
      <PhoneSecurityCheck key={challengeVersion} siteKey={status.captchaSiteKey!} onToken={setCaptcha} />
      <button type="submit" className="login-submit" disabled={busy || disabled || !captcha || remaining > 0}>
        {busy ? <><Loader2 className="animate-spin" size={18} aria-hidden="true" /> Requesting code…</>
          : remaining > 0 ? `Try again in ${remaining}s` : <>Send code <ArrowRight size={18} aria-hidden="true" /></>}
      </button>
    </form> : <>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>Code for <strong>{target}</strong></span>
        <button type="button" className="min-h-11 font-semibold text-[var(--primary)]" disabled={busy || disabled} onClick={() => {
          setTarget(""); setCode(""); setError(""); setNotice(""); setCaptcha(""); setChallengeVersion((value) => value + 1);
        }}>Change number</button></div>
      <form onSubmit={verify} className="space-y-4" aria-label="Verify guardian SMS code">
        <div>
          <label htmlFor="guardian-sms-code" className="login-label">SMS code</label>
          <div className="login-input-wrap"><KeyRound className="login-input-icon" size={18} aria-hidden="true" />
            <input id="guardian-sms-code" className="login-input" type="text" inputMode="numeric" autoComplete="one-time-code"
              required pattern="[0-9]{6}" minLength={6} maxLength={6} value={code} disabled={busy || disabled}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} /></div>
        </div>
        <button type="submit" className="login-submit" disabled={busy || disabled || !/^\d{6}$/.test(code)}>
          {busy ? <><Loader2 className="animate-spin" size={18} aria-hidden="true" /> Verifying code…</> : "Verify and continue"}
        </button>
      </form>
      <PhoneSecurityCheck key={challengeVersion} siteKey={status.captchaSiteKey!} onToken={setCaptcha} />
      <button type="button" className="min-h-11 text-sm font-semibold text-[var(--primary)]" disabled={busy || disabled || remaining > 0 || !captcha}
        onClick={() => void send()}>{remaining > 0 ? `Resend available in ${remaining}s` : "Resend code"}</button>
    </>}
    {notice && <p role="status" className="text-sm leading-6 muted">{notice}</p>}
    {error && <p role="alert" className="login-error">{error}</p>}
  </div>;
}
