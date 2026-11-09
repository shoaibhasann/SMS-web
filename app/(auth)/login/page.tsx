"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Eye, EyeOff, Loader2, LockKeyhole, Mail, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { GuardianPhoneOtpForm } from "@/components/auth/phone-otp-form";
import { mfaPath, readStaffMfaStatus } from "@/lib/auth/staff-mfa";

export default function LoginPage() {
  const router = useRouter();
  const [supabase] = useState(createClient);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [method, setMethod] = useState<"email" | "mobile">("email");
  const [mobileBusy, setMobileBusy] = useState(false);
  const [error, setError] = useState("");
  const [resumeUserId, setResumeUserId] = useState<string>();
  const [resuming, setResuming] = useState(false);
  const resumeAttempt = useRef<{ userId: string; controller: AbortController }>(null);
  const busy = loading || googleLoading || mobileBusy || resuming;

  useEffect(() => {
    let check: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const attempt = resumeAttempt.current;
      if (attempt && attempt.userId !== session?.user.id) attempt.controller.abort();
      check?.abort();
      clearTimeout(timer);
      setResumeUserId(undefined);
      if (!session) return;
      const controller = new AbortController();
      check = controller;
      // Auth lookups must run after the SDK finishes dispatching this event.
      timer = setTimeout(() => {
        void readStaffMfaStatus(supabase, session.user.id, controller.signal).then((status) => {
          if (!controller.signal.aborted && status?.action === "challenge" && status.current_aal === "aal1") {
            setResumeUserId(status.user_id);
          }
        }, () => { /* An unconfirmed session cannot offer resume. */ });
      }, 0);
    });
    return () => { check?.abort(); resumeAttempt.current?.controller.abort(); clearTimeout(timer); subscription.unsubscribe(); };
  }, [supabase]);

  async function signIn(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setLoading(true);
    setError("");

    try {
      const current = await supabase.auth.getSession();
      // A rejected password leaves any older Supabase session intact.
      if (current.error || current.data.session) {
        const { error } = await supabase.auth.signOut({ scope: "local" });
        if (error) {
          setError("Couldn’t clear the previous sign-in. Please try again.");
          setLoading(false);
          return;
        }
      }
      const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) {
        if (error.code === "invalid_credentials" || (!error.code && error.message === "Invalid login credentials")) {
          setError("Incorrect email or password. Please try again.");
        } else if (error.status === 429) {
          setError("Too many sign-in attempts. Wait a moment and try again.");
        } else {
          setError("Sign-in couldn’t be completed. Try again or contact your school.");
        }
        setLoading(false);
        return;
      }
      if (!data?.session || data.session.user.id !== data.user?.id) {
        setError("Sign-in couldn’t be completed. Try again or contact your school.");
        setLoading(false);
        return;
      }
      router.replace("/dashboard");
      router.refresh();
    } catch {
      setError("We couldn’t connect. Check your connection and try again.");
      setLoading(false);
    }
  }

  async function resumeAuthenticator() {
    if (busy || !resumeUserId || resumeAttempt.current) return;
    setError("");
    setResuming(true);
    const controller = new AbortController();
    resumeAttempt.current = { userId: resumeUserId, controller };
    const status = await readStaffMfaStatus(supabase, resumeUserId, controller.signal).catch(() => null);
    resumeAttempt.current = null;
    if (!controller.signal.aborted && status?.action === "challenge" && status.current_aal === "aal1") {
      router.replace(mfaPath("/dashboard"));
      return;
    }
    if (!controller.signal.aborted) setResumeUserId(undefined);
    setResuming(false);
    setError("That sign-in can’t be resumed. Sign in again to verify your account.");
  }

  async function signInWithGoogle() {
    if (busy) return;
    setGoogleLoading(true);
    setError("");

    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) {
        setError("Google sign-in couldn’t open. Please try again.");
        setGoogleLoading(false);
      }
    } catch {
      setError("Google sign-in couldn’t open. Please try again.");
      setGoogleLoading(false);
    }
  }

  return (
    <main className="login-page">
      <div className="login-frame">
        <section className="login-hero" aria-label="SMS school workspace">
          <div className="login-brand">
            <div><p className="login-brand-name">SMS</p><p className="login-brand-caption">School Management System</p></div>
          </div>

          <div className="login-art" aria-hidden="true">
            <Image
              src="/images/login-school-illustration.webp"
              alt=""
              width={1200}
              height={1200}
              sizes="(max-width: 1023px) 1px, (max-width: 1440px) 46vw, 600px"
              loading="eager"
              className="login-school-art"
            />
          </div>

          <div className="login-hero-copy">
            <h2>Every school day,<br />in sync.</h2>
            <p>One place for attendance, homework and school updates.</p>
          </div>
          <svg className="login-wave" viewBox="0 0 160 1000" preserveAspectRatio="none" aria-hidden="true">
            <path d="M148 0C28 78 0 210 28 352C48 468 156 498 156 650C156 821 88 938 12 1000H160V0Z" fill="currentColor" />
          </svg>
        </section>

        <section className="login-form-panel" aria-labelledby="login-heading">
          <div className="login-form-content">
            <div className="login-brand login-mobile-brand">
              <div><p className="login-brand-name">SMS</p><p className="login-brand-caption">School Management System</p></div>
            </div>

            <h1 id="login-heading" className="login-heading">Welcome back</h1>
            <p className="login-intro">Sign in to your school workspace.</p>

            <div role="group" aria-label="Sign-in method" className="mt-5 grid grid-cols-2 gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-1">
              {([["email", "Email & password"], ["mobile", "Guardian mobile"]] as const).map(([value, title]) => <button key={value} type="button"
                aria-pressed={method === value} disabled={busy} onClick={() => { setMethod(value); setError(""); }}
                className={`min-h-11 rounded-lg px-2 py-2 text-xs font-semibold transition ${method === value ? "bg-[var(--surface)] text-[var(--text)] shadow-sm" : "muted"}`}>{title}</button>)}
            </div>

            {method === "mobile" ? <GuardianPhoneOtpForm purpose="login" onBusyChange={setMobileBusy} onVerified={() => {
              router.replace("/dashboard"); router.refresh();
            }} /> : <>
            <form onSubmit={signIn} className="login-form" aria-busy={busy}>
              <div>
                <label htmlFor="login-email" className="login-label">Email address</label>
                <div className="login-input-wrap">
                  <Mail className="login-input-icon" size={18} aria-hidden="true" />
                  <input
                    id="login-email"
                    name="email"
                    required
                    type="email"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={email}
                    disabled={busy}
                    onChange={(event) => setEmail(event.target.value)}
                    className="login-input"
                    placeholder="you@school.com"
                  />
                </div>
              </div>

              <div>
                <div className="login-label-row">
                  <label htmlFor="login-password" className="login-label">Password</label>
                  <Link href="/forgot-password" className="login-forgot">Forgot password?</Link>
                </div>
                <div className="login-input-wrap">
                  <LockKeyhole className="login-input-icon" size={18} aria-hidden="true" />
                  <input
                    id="login-password"
                    name="password"
                    required
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    value={password}
                    disabled={busy}
                    onChange={(event) => setPassword(event.target.value)}
                    className="login-input login-password-input"
                    placeholder="Enter your password"
                  />
                  <button
                    type="button"
                    className="login-password-toggle"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    aria-pressed={showPassword}
                    aria-controls="login-password"
                    disabled={busy}
                    onClick={() => setShowPassword((shown) => !shown)}
                  >
                    {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
                  </button>
                </div>
              </div>

              {error && <p role="alert" className="login-error">{error}</p>}

              <button type="submit" disabled={busy} className="login-submit">
                {loading ? <><Loader2 className="animate-spin" size={18} aria-hidden="true" /> Signing in…</> : <>Sign in <ArrowRight size={18} aria-hidden="true" /></>}
              </button>
            </form>

            {resumeUserId && <div className="mt-3 space-y-2">
              <button type="button" onClick={resumeAuthenticator} disabled={busy} className="login-google">
                {resuming ? <Loader2 size={18} className="animate-spin" aria-hidden="true" /> : <ShieldCheck size={18} aria-hidden="true" />}
                {resuming ? "Checking sign-in…" : "Continue with authenticator"}
              </button>
              <p className="text-center text-xs leading-5 muted">Resume the sign-in you already started in this browser.</p>
            </div>}

            <div className="login-divider"><span />or continue with<span /></div>

            <button type="button" onClick={signInWithGoogle} disabled={busy} className="login-google">
              {googleLoading ? <Loader2 className="animate-spin" size={19} aria-hidden="true" /> : (
                <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                  <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-1.99 3.02v2.51h3.22c1.89-1.74 2.99-4.3 2.99-7.36Z" />
                  <path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.61-2.41l-3.22-2.51c-.9.6-2.05.96-3.39.96-2.61 0-4.82-1.76-5.61-4.12H3.07v2.59A9.99 9.99 0 0 0 12 22Z" />
                  <path fill="#FBBC05" d="M6.39 13.92A6 6 0 0 1 6.08 12c0-.67.11-1.32.31-1.92V7.49H3.07A9.99 9.99 0 0 0 2 12c0 1.61.39 3.14 1.07 4.51l3.32-2.59Z" />
                  <path fill="#EA4335" d="M12 5.96c1.47 0 2.79.5 3.82 1.49l2.87-2.87A9.62 9.62 0 0 0 12 2a9.99 9.99 0 0 0-8.93 5.49l3.32 2.59C7.18 7.72 9.39 5.96 12 5.96Z" />
                </svg>
              )}
              {googleLoading ? "Opening Google…" : "Continue with Google"}
            </button>
            </>}

            <p className="login-access-note">School access is managed by your administrator.</p>
          </div>
        </section>
      </div>
    </main>
  );
}
