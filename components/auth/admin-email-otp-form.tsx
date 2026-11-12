"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, KeyRound, Loader2, Mail } from "lucide-react";

type EmailCodeAction = "request" | "verify";

export function AdminEmailOtpForm({ onBusyChange, onVerified }: {
  onBusyChange: (busy: boolean) => void;
  onVerified: () => void;
}) {
  const [email, setEmail] = useState("");
  const [target, setTarget] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<EmailCodeAction | null>(null);
  const [error, setError] = useState("");
  const [retryAt, setRetryAt] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const request = useRef<AbortController | null>(null);
  const validCode = /^[0-9]{6,10}$/.test(code);

  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!retryAt) return;
    const timer = window.setInterval(() => {
      const seconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
      setRemaining(seconds);
      if (!seconds) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  async function submit(action: EmailCodeAction) {
    if (request.current || (action === "request" && Date.now() < retryAt)) return;
    const address = target || email.trim().toLowerCase();
    if (!address || (action === "verify" && (!target || !validCode))) return;

    const controller = new AbortController();
    request.current = controller;
    setPending(action);
    onBusyChange(true);
    setError("");
    let navigating = false;
    try {
      const response = await fetch("/auth/admin-email-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "request" ? { action, email: address } : { action, email: address, code }),
        redirect: "error",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      // Resend cooldown only; a 429 is the 15-minute throttle window, stated in the message instead of a short timer.
      if (action === "request" && response.ok) {
        setRetryAt(Date.now() + 60_000);
        setRemaining(60);
      }
      if (response.ok) {
        if (action === "verify") {
          onVerified();
          navigating = true;
        }
        else {
          setTarget(address);
          setCode("");
        }
      } else if (response.status === 429) {
        setError("Too many attempts. Try again in 15 minutes.");
      } else if (response.status === 503) {
        setError("Email code sign-in is unavailable. Use your password or try again later.");
      } else if (response.status === 401 && action === "verify") {
        setError("That code is invalid or expired. Try again or request a new code.");
      } else {
        setError("Email code sign-in couldn’t be completed. Try again.");
      }
    } catch {
      if (!controller.signal.aborted) setError("We couldn’t connect. Check your connection and try again.");
    } finally {
      request.current = null;
      if (!controller.signal.aborted && !navigating) {
        setPending(null);
        onBusyChange(false);
      }
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit(target ? "verify" : "request");
  }

  return (
    <div className="mt-5 space-y-4">
      {target ? (
        <>
          <p role="status" className="break-words text-sm leading-6 muted">
            If <strong>{target}</strong> is eligible, a sign-in code will arrive by email. Check your spam folder too.
          </p>
          <button type="button" className="min-h-11 text-sm font-semibold text-[var(--login-link)]" disabled={!!pending}
            onClick={() => { setTarget(""); setCode(""); setError(""); }}>Change email</button>
        </>
      ) : <p className="text-sm leading-6 muted">Use your school admin email to receive a sign-in code. Your school may require an authenticator.</p>}

      <form onSubmit={handleSubmit} aria-label={target ? "Verify admin email code" : "Request admin email code"}
        aria-busy={!!pending} className="space-y-4">
        {target ? (
          <div>
            <label htmlFor="admin-email-code" className="login-label">Email code</label>
            <div className="login-input-wrap">
              <KeyRound className="login-input-icon" size={18} aria-hidden="true" />
              <input id="admin-email-code" type="text" inputMode="numeric" autoComplete="one-time-code" required
                pattern="[0-9]{6,10}" minLength={6} maxLength={10} className="login-input" value={code} disabled={!!pending}
                onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, "").slice(0, 10))} />
            </div>
          </div>
        ) : (
          <div>
            <label htmlFor="admin-signin-email" className="login-label">Email address</label>
            <div className="login-input-wrap">
              <Mail className="login-input-icon" size={18} aria-hidden="true" />
              <input id="admin-signin-email" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false}
                required maxLength={254} className="login-input" placeholder="you@school.com" value={email}
                disabled={!!pending} onChange={(event) => setEmail(event.target.value)} />
            </div>
          </div>
        )}
        {error && <p role="alert" className="login-error">{error}</p>}
        <button type="submit" className="login-submit" disabled={!!pending || (target ? !validCode : !email.trim() || remaining > 0)}>
          {pending === (target ? "verify" : "request") ? <>
            <Loader2 className="animate-spin" size={18} aria-hidden="true" />{target ? "Verifying code…" : "Requesting code…"}
          </> : <>{target ? "Verify email code" : remaining > 0 ? `Try again in ${remaining}s` : "Send email code"}
            <ArrowRight size={18} aria-hidden="true" /></>}
        </button>
      </form>
      {target && <button type="button" className="min-h-11 text-sm font-semibold text-[var(--login-link)]"
        disabled={!!pending || remaining > 0} onClick={() => void submit("request")}>
        {pending === "request" ? "Requesting code…" : remaining > 0 ? `Resend available in ${remaining}s` : "Resend code"}
      </button>}
    </div>
  );
}
