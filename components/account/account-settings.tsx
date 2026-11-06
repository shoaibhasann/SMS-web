"use client";

import Link from "next/link";
import { CheckCircle2, KeyRound, LockKeyhole, RefreshCw, UserRound } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { LoadingState } from "@/components/ui/skeleton";
import { changeOwnPassword, PasswordChangeError, validatePasswordChange, type PasswordChange } from "@/lib/account/password";
import { roleLabel, type UiRole } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/client";
import { normalizeIndianMobile } from "@/lib/auth/phone";
import { NativePushSettings } from "@/components/notifications/native-push-settings";
import type { NativePushRole } from "@/lib/notifications/native-push";

type Details = { name: string; email: string | null; verified: boolean; phone: string | null; providers: string[]; oauthOnly: boolean };
type Result = { details: Details } | { error: string };
const emptyPassword = { currentPassword: "", newPassword: "", confirmation: "" };
const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold transition hover:bg-[var(--surface-2)] disabled:opacity-50";
const label = "block min-w-0 space-y-2 text-sm font-semibold";

type AccountProps = { userId: string; role: UiRole; hasGuardianRole: boolean; hasStudentRole?: boolean };

export function AccountSettings(props: AccountProps) {
  return <OwnAccountSettings key={props.userId} {...props} />;
}

function OwnAccountSettings({ userId, role, hasGuardianRole, hasStudentRole = role === "student" }: AccountProps) {
  const pushRoles: NativePushRole[] = [...(hasGuardianRole ? ["parent" as const] : []), ...(hasStudentRole ? ["student" as const] : [])];
  const [client] = useState(createClient);
  const [result, setResult] = useState<{ version: number; result: Result }>();
  const [version, setVersion] = useState(0);
  const [password, setPassword] = useState<PasswordChange>(emptyPassword);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [completed, setCompleted] = useState<{ temporarySessionClosed: boolean }>();
  const [sessionChanged, setSessionChanged] = useState(false);
  const request = useRef<AbortController | null>(null);
  const current = result?.version === version ? result.result : undefined;
  const details = current && "details" in current ? current.details : undefined;

  useEffect(() => {
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) {
        request.current?.abort();
        setPassword(emptyPassword);
        setSessionChanged(true);
      }
    });
    return () => { request.current?.abort(); subscription.unsubscribe(); };
  }, [client, userId]);

  useEffect(() => {
    if (sessionChanged || completed) return;
    let active = true;
    async function load() {
      try {
        const [auth, profile] = await Promise.all([
          client.auth.getUser(),
          client.from("profiles").select("full_name,is_active").eq("id", userId).maybeSingle(),
        ]);
        if (!active) return;
        if (auth.error || !auth.data.user || auth.data.user.id !== userId || auth.data.user.is_anonymous) {
          setSessionChanged(true); setPassword(emptyPassword); return;
        }
        if (profile.error || profile.data?.is_active !== true) throw new Error();
        const user = auth.data.user;
        const providers = [...new Set((user.identities ?? []).map((identity) => identity.provider).filter((provider) => typeof provider === "string"))];
        setResult({ version, result: { details: {
          name: typeof profile.data.full_name === "string" && profile.data.full_name.trim() ? profile.data.full_name : "School account",
          email: user.email || null, verified: !!user.email_confirmed_at,
          phone: user.phone_confirmed_at ? normalizeIndianMobile(user.phone ?? "") : null, providers,
          oauthOnly: providers.length > 0 && !providers.includes("email"),
        } } });
      } catch {
        if (active) setResult({ version, result: { error: "Account details could not be verified. Refresh or contact your school." } });
      }
    }
    void load();
    return () => { active = false; };
  }, [client, userId, version, sessionChanged, completed]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current || sessionChanged || completed || !details || details.oauthOnly || !details.verified) return;
    const invalid = validatePasswordChange(password);
    setError(invalid ?? undefined);
    if (invalid) return;
    const controller = new AbortController(); request.current = controller; setSaving(true);
    try {
      const outcome = await changeOwnPassword(client, userId, password, controller.signal);
      if (controller.signal.aborted) return;
      setPassword(emptyPassword);
      setCompleted({ temporarySessionClosed: outcome.temporarySessionClosed });
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure instanceof PasswordChangeError ? failure.message : "The password change could not be confirmed. Try signing in before retrying.");
        setPassword((value) => ({ ...value, currentPassword: "" }));
      }
    } finally {
      if (request.current === controller) { request.current = null; if (!controller.signal.aborted) setSaving(false); }
    }
  }

  return <div className="mx-auto max-w-4xl space-y-5">
    <header><p className="text-xs font-semibold uppercase tracking-wider muted">Your account</p>
      <h1 className="mt-1 text-2xl font-bold sm:text-3xl">Account settings</h1>
      <p className="mt-2 text-sm leading-6 muted">Review your sign-in details and manage your own password.</p></header>
    {sessionChanged ? <section className="card space-y-3 p-5"><p role="alert" className="text-sm">Your account changed or signed out. Reopen settings after signing in.</p>
      <Link href="/login" className={button}>Return to sign in</Link></section>
      : completed ? <section className="card space-y-4 p-5 sm:p-6">
        <CheckCircle2 className="text-emerald-700 dark:text-emerald-300" aria-hidden="true" />
        <h2 className="text-lg font-semibold">Password changed</h2>
        <p role="status" className="text-sm">Use your new password next time you sign in. You may need to sign in again in other tabs.</p>
        {!completed.temporarySessionClosed && <p className="text-sm muted">Your password changed, but temporary session cleanup could not be confirmed. Do not repeat the password change.</p>}
        <Link href="/dashboard" className={`${button} bg-blue-700 text-white hover:bg-blue-800`}>Return to dashboard</Link>
      </section>
      : !current ? <LoadingState variant="form">Loading account settings…</LoadingState>
      : "error" in current ? <section className="card space-y-3 p-5"><p role="alert" className="text-sm">{current.error}</p>
        <button type="button" className={button} onClick={() => setVersion((value) => value + 1)}><RefreshCw size={16} aria-hidden="true" /> Refresh account</button></section>
      : <>
        <section className="card space-y-5 p-5 sm:p-6" aria-labelledby="account-details-heading">
          <div className="flex items-center gap-2"><UserRound size={19} aria-hidden="true" /><h2 id="account-details-heading" className="font-semibold">Account details</h2></div>
          <dl className="grid min-w-0 gap-5 sm:grid-cols-2">
            {[["Name", current.details.name], ["Email", current.details.email ?? "No email linked"], ["School role", roleLabel(role)],
              ["Verified mobile", current.details.phone ?? "No mobile verified"],
              ["Email verification", current.details.verified ? "Verified" : "Not verified"], ["Sign-in methods", current.details.providers.length ? current.details.providers.map((provider) => provider === "email" ? "Email" : provider === "google" ? "Google" : provider).join(", ") : "School account"]].map(([title, value]) => <div key={title} className="min-w-0"><dt className="text-xs muted">{title}</dt><dd className="mt-1 break-words text-sm font-semibold">{value}</dd></div>)}
          </dl>
          <p className="text-xs leading-6 muted">School profile changes need school verification. Sign-in details cannot be edited on this page.</p>
          {hasGuardianRole && <Link href="/modules/profile?view=guardian" className={`${button} text-blue-700 dark:text-blue-300`}>Verified guardian contact settings</Link>}
        </section>
        <NativePushSettings userId={userId} roles={pushRoles} />
        <section className="card space-y-4 p-5 sm:p-6" aria-labelledby="password-heading">
          <div className="flex items-center gap-2"><KeyRound size={19} aria-hidden="true" /><h2 id="password-heading" className="font-semibold">Change password</h2></div>
          {!current.details.email && current.details.phone ? <p className="text-sm leading-6 muted">This guardian account uses mobile OTP. You do not need a password. Manage your verified number in guardian contact settings. If you lose that number, contact the school office to verify your identity.</p>
            : current.details.oauthOnly ? <p className="text-sm leading-6 muted">This account uses {current.details.providers.join(" / ")}. If you have not set a school password, use password recovery first or continue with your existing sign-in method.</p>
            : !current.details.email || !current.details.verified ? <p className="text-sm leading-6 muted">A verified sign-in email is required to change a password. Contact your school to verify your account.</p>
            : <form aria-label="Change your password" onSubmit={save} className="space-y-4">
              <p className="text-sm leading-6 muted">Use at least 12 characters. If your password is too long, choose a shorter one. Use your new password the next time you sign in.</p>
              <fieldset disabled={saving} className="min-w-0 space-y-4">
                <label className={label}><span>Current password</span><input required className="field" type="password" autoComplete="current-password" value={password.currentPassword}
                  onChange={(event) => setPassword((value) => ({ ...value, currentPassword: event.target.value }))} /></label>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className={label}><span>New password</span><input required className="field" type="password" autoComplete="new-password" value={password.newPassword}
                    onChange={(event) => setPassword((value) => ({ ...value, newPassword: event.target.value }))} /></label>
                  <label className={label}><span>Confirm new password</span><input required className="field" type="password" autoComplete="new-password" value={password.confirmation}
                    onChange={(event) => setPassword((value) => ({ ...value, confirmation: event.target.value }))} /></label>
                </div>
                <button type="submit" className={`${button} bg-blue-700 text-white hover:bg-blue-800`}><LockKeyhole size={16} aria-hidden="true" />{saving ? "Changing password…" : "Change password"}</button>
              </fieldset>
              {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
            </form>}
          {current.details.email && <Link href="/forgot-password" className="inline-flex min-h-11 items-center text-sm font-semibold text-blue-700 hover:underline dark:text-blue-300">Forgot your password?</Link>}
        </section>
      </>}
  </div>;
}
