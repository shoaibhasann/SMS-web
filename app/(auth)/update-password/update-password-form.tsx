"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { MAX_PASSWORD_BYTES, MIN_PASSWORD_LENGTH, passwordProblem } from "@/lib/account/password-rule";

export function UpdatePasswordForm({ sessionId, mfaRequired = false, factors = [] }: { sessionId: string; mfaRequired?: boolean; factors?: { id: string; friendly_name?: string }[] }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<"expired" | "complete">();
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const [unlocked, setUnlocked] = useState(!mfaRequired);
  const [code, setCode] = useState(""), [factorId, setFactorId] = useState(factors[0]?.id ?? "");

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true; setLoading(true); setError("");
    try {
      const response = await fetch("/auth/recovery/mfa", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, factorId, code }) });
      if (response.ok) setUnlocked(true);
      else if (response.status === 403) setStatus("expired");
      else if (response.status === 429) setError("Too many attempts. Wait before trying another code.");
      else if ([400, 422].includes(response.status)) setError("That code was not accepted. Use the latest six-digit authenticator code.");
      else setError("Verification could not be confirmed. Retry before continuing.");
    } catch { setError("Verification could not be confirmed. Retry before continuing."); }
    finally { setCode(""); setLoading(false); inFlight.current = false; }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    setError("");
    if (passwordProblem(password)) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters and at most ${MAX_PASSWORD_BYTES} bytes.`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    inFlight.current = true;
    setLoading(true);
    try {
      const response = await fetch("/auth/recovery/complete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, sessionId }),
      });
      if (response.ok) { setStatus("complete"); setPassword(""); setConfirm(""); }
      else if (response.status === 409) { setUnlocked(false); setPassword(""); setConfirm(""); setError("Account security changed. Verify your authenticator before continuing."); }
      else if (response.status === 403) setStatus("expired");
      else if (response.status === 400) setError("Choose a stronger password that differs from your current password.");
      else setError("The update could not be confirmed. Try again.");
    } catch {
      setError("The update could not be confirmed. Try again.");
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }

  if (status === "complete") {
    return (
      <div className="mt-6 space-y-4">
        <p role="status" className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Password updated. Sign in with your new password.</p>
        <Link href="/login" className="account-primary inline-flex min-h-11 items-center rounded-xl px-4 text-sm font-semibold">
          Back to sign in
        </Link>
      </div>
    );
  }
  if (status === "expired") {
    return (
      <div className="mt-6 space-y-4">
        <p role="alert" className="text-sm">This reset session is no longer active. If you already changed your password, try signing in.</p>
        <Link href="/forgot-password" className="inline-flex min-h-11 items-center text-sm font-semibold text-[var(--primary)]">Request a new reset link</Link>
      </div>
    );
  }
  if (!unlocked) return <div className="mt-6 space-y-4">
    <p className="text-sm leading-6 muted">A reset email does not replace your authenticator. Verify its code before setting a new password.</p>
    {factors.length ? <form onSubmit={verify} className="space-y-4" aria-label="Verify password recovery authenticator"><fieldset disabled={loading} className="min-w-0 space-y-4">
      {factors.length > 1 && <label className="block space-y-2 text-sm font-semibold"><span>Authenticator</span><select className="field" value={factorId} onChange={event => setFactorId(event.target.value)}>{factors.map(factor => <option key={factor.id} value={factor.id}>{factor.friendly_name || "Authenticator"}</option>)}</select></label>}
      <label className="block max-w-xs space-y-2 text-sm font-semibold"><span>Six-digit authenticator code</span><input className="field !text-lg tracking-[0.3em]" placeholder="000000" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ""))} /></label>
      <button type="submit" className="login-submit">{loading ? "Verifying…" : "Verify recovery authenticator"}</button>
    </fieldset></form> : <p className="text-sm leading-6">No usable authenticator was found in this recovery session. Reopen a fresh reset link or contact your school for independently reviewed account recovery.</p>}
    {error && <p role="alert" className="login-error">{error}</p>}
    <Link href="/update-password" className="inline-flex min-h-11 items-center text-sm font-semibold text-[var(--primary)]">Reload account security</Link>
  </div>;
  return (
    <form onSubmit={(event) => void submit(event)} className="mt-7 space-y-4">
      <label className="block space-y-2 text-sm font-semibold">
        <span>New password</span>
        <input required type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} value={password}
          onChange={(event) => setPassword(event.target.value)} className="field w-full" />
      </label>
      <label className="block space-y-2 text-sm font-semibold">
        <span>Confirm password</span>
        <input required type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} value={confirm}
          onChange={(event) => setConfirm(event.target.value)} className="field w-full" />
      </label>
      {error && <p role="alert" className="login-error">{error}</p>}
      <button type="submit" disabled={loading}
        className="login-submit">
        {loading && <Loader2 className="animate-spin" size={17} aria-hidden="true" />}
        {loading ? "Updating…" : "Update password"}
      </button>
    </form>
  );
}
