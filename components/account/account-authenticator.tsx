"use client";

import Link from "next/link";
import Image from "next/image";
import { Check, KeyRound, Plus, RefreshCw, ShieldCheck, Smartphone, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { LoadingState } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/client";
import { createBoundMfaClient, enrollAuthenticator, listAuthenticators, readStaffMfaStatus, refreshMfaSession,
  removeAuthenticator, StaffMfaError, verifyAuthenticator, type AuthenticatorFactor, type StaffMfaStatus } from "@/lib/auth/staff-mfa";

const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold transition hover:bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
const primary = `${button} border-transparent bg-[var(--primary)] text-white hover:brightness-95 dark:text-[var(--bg)]`;
type Setup = { id: string; secret: string; qr: string };
type Snapshot = { status: StaffMfaStatus; factors: AuthenticatorFactor[] };

/** Enrollment secrets live only in this keyed component, and are discarded on account change/unmount. */
export function AccountAuthenticator({ userId, onVerified, challengeOnly = false }: {
  userId: string; onVerified?: (status: StaffMfaStatus) => void; challengeOnly?: boolean;
}) {
  return <OwnAuthenticator key={userId} userId={userId} onVerified={onVerified} challengeOnly={challengeOnly} />;
}
function OwnAuthenticator({ userId, onVerified, challengeOnly }: { userId: string; onVerified?: (status: StaffMfaStatus) => void; challengeOnly: boolean }) {
  const [client] = useState(createClient);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [setup, setSetup] = useState<Setup>();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [factorId, setFactorId] = useState("");
  const [showSetup, setShowSetup] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [changed, setChanged] = useState(false);
  const [reload, setReload] = useState(0);
  const [removing, setRemoving] = useState<string>();
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) {
        request.current?.abort(); setSetup(undefined); setCode(""); setChanged(true);
      }
    });
    return () => { mounted.current = false; request.current?.abort(); subscription.unsubscribe(); };
  }, [client, userId]);
  useEffect(() => {
    if (changed) return;
    const controller = new AbortController(); request.current = controller;
    async function load() {
      try {
        const status = await readStaffMfaStatus(client, userId, controller.signal);
        if (!status) throw new StaffMfaError("Sign in again before managing your authenticator.", "access");
        const isolated = await createBoundMfaClient(client, userId, controller.signal);
        const factors = await listAuthenticators(isolated);
        if (controller.signal.aborted) return;
        setSnapshot({ status, factors }); setFactorId((current) => factors.some((factor) => factor.id === current) ? current : factors[0]?.id ?? "");
        setError("");
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof StaffMfaError ? failure.message : "Account security could not be loaded. Retry to check its status.");
      } finally { if (request.current === controller) request.current = null; }
    }
    void load();
    return () => controller.abort();
  }, [changed, client, reload, userId]);

  async function run(operation: (signal: AbortSignal) => Promise<void>) {
    if (request.current || changed || pending) return;
    const controller = new AbortController(); request.current = controller;
    setPending(true); setError(""); setNotice("");
    try { await operation(controller.signal); }
    catch (failure) {
      if (!controller.signal.aborted && mounted.current) setError(failure instanceof StaffMfaError ? failure.message : "This security change could not be confirmed. Reload its status before retrying.");
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted && mounted.current) setPending(false);
    }
  }
  async function begin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(async (signal) => {
      const bound = await createBoundMfaClient(client, userId, signal);
      const enrolled = await enrollAuthenticator(bound, name);
      if (signal.aborted) return;
      setSetup(enrolled); setCode(""); setNotice("");
    });
  }
  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(async (signal) => {
      const bound = await createBoundMfaClient(client, userId, signal);
      await verifyAuthenticator(bound, setup?.id ?? factorId, code);
      if (signal.aborted) return;
      // The provider may have accepted a code even if refresh fails. Discard secrets and reload, never enroll again automatically.
      setSetup(undefined); setCode(""); setShowSetup(false); setName("");
      const status = await refreshMfaSession(client, userId, signal);
      if (signal.aborted) return;
      const factors = await listAuthenticators(await createBoundMfaClient(client, userId, signal));
      if (signal.aborted) return;
      setSnapshot({ status, factors }); setNotice("Authenticator verified. Your account security is up to date.");
      onVerified?.(status);
    });
  }
  async function cancelSetup() {
    await run(async (signal) => {
      // A timed-out verification may have committed. Never treat that verified credential as a pending setup.
      if (setup) {
        const bound = await createBoundMfaClient(client, userId, signal);
        const verified = await listAuthenticators(bound);
        if (signal.aborted) return;
        if (verified.some((factor) => factor.id === setup.id)) {
          setSetup(undefined); setCode(""); setShowSetup(false); setName("");
          const status = await refreshMfaSession(client, userId, signal);
          const factors = await listAuthenticators(await createBoundMfaClient(client, userId, signal));
          if (signal.aborted) return;
          setSnapshot({ status, factors }); setNotice("This authenticator was already verified. Your verified device has been kept.");
          onVerified?.(status);
          return;
        }
        // Cancel only the still-pending factor created by this exact form.
        await removeAuthenticator(bound, setup.id);
      }
      if (signal.aborted) return;
      setSetup(undefined); setCode(""); setShowSetup(false); setName(""); setNotice("Authenticator setup cancelled.");
    });
  }
  async function remove() {
    if (!removing || !snapshot || snapshot.status.policy_required && snapshot.factors.length <= 1) return;
    const target = removing;
    await run(async (signal) => {
      const status = await readStaffMfaStatus(client, userId, signal);
      if (!status?.allowed || status.current_aal !== "aal2") throw new StaffMfaError("Verify your authenticator again before removing a device.", "access");
      const bound = await createBoundMfaClient(client, userId, signal);
      const factors = await listAuthenticators(bound);
      if (!factors.some((factor) => factor.id === target) || (status.policy_required || status.roles.some((role) => role.role === "super_admin" && role.school_id === null)) && factors.length <= 1) throw new StaffMfaError("Keep at least one verified authenticator while your school requires it.", "access");
      await removeAuthenticator(bound, target);
      if (signal.aborted) return;
      setRemoving(undefined);
      const refreshed = await refreshMfaSession(client, userId, signal);
      if (signal.aborted) return;
      const remaining = await listAuthenticators(await createBoundMfaClient(client, userId, signal));
      if (signal.aborted) return;
      setSnapshot({ status: refreshed, factors: remaining });
      setNotice("Authenticator removed."); onVerified?.(refreshed);
    });
  }

  const needsChallenge = snapshot?.status.action === "challenge";
  const canEnroll = snapshot && !needsChallenge && snapshot.status.action !== "sign_in";
  const lastRequired = Boolean(snapshot && snapshot.status.required && snapshot.status.verified_totp_count <= 1 && (snapshot.status.policy_required || snapshot.status.roles.some((role) => role.role === "super_admin" && role.school_id === null)));
  const qr = setup?.qr.startsWith("data:image/svg+xml;") ? setup.qr : setup?.qr.startsWith("<svg") ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(setup.qr)}` : "";

  return <section className="card min-w-0 overflow-hidden" aria-labelledby="authenticator-heading">
    <header className="flex items-start gap-3 border-b border-[var(--border)] p-5 sm:p-6">
      <span className="rounded-xl bg-[var(--surface-2)] p-2.5 text-[var(--primary)]"><ShieldCheck size={21} aria-hidden="true" /></span>
      <div className="min-w-0"><h2 id="authenticator-heading" className="text-lg font-semibold">Authenticator security</h2><p className="mt-1 text-sm leading-6 muted">A six-digit code adds another check after your usual sign-in. No SMS charges.</p></div>
    </header>
    <div className="space-y-5 p-5 sm:p-6">
      {changed ? <p role="alert" className="text-sm">Your account changed or signed out. <Link href="/login" className="font-semibold underline">Sign in again</Link>.</p>
        : !snapshot ? <>{!error && <LoadingState variant="form">Checking authenticator security…</LoadingState>}</>
          : snapshot.status.action === "sign_in" ? <p className="text-sm">Your security session is no longer valid. <Link href="/login" className="font-semibold underline">Sign in again</Link> to continue.</p>
            : <>
              <div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-[var(--surface-2)] px-3 py-1 text-xs font-semibold">{snapshot.factors.length ? `${snapshot.factors.length} verified ${snapshot.factors.length === 1 ? "authenticator" : "authenticators"}` : "Not configured"}</span>
                {snapshot.status.policy_required && <span className="text-xs muted">Required by your school</span>}</div>
              {needsChallenge && <p className="text-sm leading-6">Enter a code from your saved authenticator to unlock this account. Password recovery does not remove this check.</p>}
              {!needsChallenge && !challengeOnly && snapshot.factors.length > 0 && <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] px-4">{snapshot.factors.map((factor) => <li key={factor.id} className="flex items-center gap-3 py-3"><Smartphone size={19} className="shrink-0 muted" aria-hidden="true" /><span className="min-w-0 flex-1 truncate text-sm font-semibold">{factor.friendly_name || "Authenticator app"}</span>
                <button type="button" aria-label={`Remove ${factor.friendly_name || "authenticator"}`} disabled={pending || lastRequired || Boolean(setup)} className={`${button} !px-3`} onClick={() => setRemoving(factor.id)}><Trash2 size={16} aria-hidden="true" /><span className="hidden sm:inline">Remove</span></button></li>)}</ul>}
              {lastRequired && !challengeOnly && <p className="text-xs leading-5 muted">Keep one verified authenticator while your school requires it. Add a backup before replacing your device.</p>}
              {removing && <div className="space-y-3 rounded-xl border border-amber-500/30 bg-[var(--surface-2)] p-4"><p className="text-sm">Remove this authenticator? Confirm that you can still sign in using another device, or that your school does not require an authenticator.</p><div className="flex flex-wrap gap-2"><button type="button" disabled={pending} className={button} onClick={() => void remove()}>Confirm removal</button><button type="button" disabled={pending} className={button} onClick={() => setRemoving(undefined)}>Keep authenticator</button></div></div>}
              {setup && <div className="space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4"><p className="text-sm font-semibold">Scan in Google Authenticator, Microsoft Authenticator or your preferred authenticator app.</p>
                {qr && <div className="w-fit rounded-xl bg-white p-3">{/* Auth provider SVG stays in memory and is rendered as an image, never inserted as HTML. */}
                  <Image unoptimized src={qr} width={192} height={192} alt="Scan this private setup code with your authenticator app" /></div>}
                <details className="text-sm"><summary className="min-h-10 cursor-pointer font-semibold">Enter a setup key instead</summary><code className="mt-2 block select-all break-all rounded-xl border border-[var(--border)] p-3 text-sm">{setup.secret}</code></details>
                <p className="text-xs leading-5 muted">This key grants access to your account. Do not share it or include it in screenshots.</p></div>}
              {(needsChallenge || setup) && <form aria-label="Verify authenticator" onSubmit={verify} className="space-y-4"><fieldset className="min-w-0 space-y-4" disabled={pending}>
                {!setup && snapshot.factors.length > 1 && <label className="block space-y-2 text-sm font-semibold"><span>Authenticator</span><select className="field" value={factorId} onChange={(event) => setFactorId(event.target.value)}>{snapshot.factors.map((factor) => <option key={factor.id} value={factor.id}>{factor.friendly_name || "Authenticator app"}</option>)}</select></label>}
                <label className="block max-w-xs space-y-2 text-sm font-semibold"><span>Six-digit code</span><input className="field !text-lg tracking-[0.3em]" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} placeholder="000000" /></label>
                <div className="flex flex-wrap gap-2"><button type="submit" className={primary}><Check size={16} aria-hidden="true" />{pending ? "Verifying…" : "Verify authenticator"}</button>{setup && <button type="button" className={button} onClick={() => void cancelSetup()}>Cancel setup</button>}</div>
              </fieldset></form>}
              {canEnroll && !setup && (showSetup || snapshot.status.action === "enroll") && <form aria-label="Set up authenticator" onSubmit={begin} className="space-y-4"><label className="block space-y-2 text-sm font-semibold"><span>Device name</span><input className="field" required minLength={2} maxLength={60} disabled={pending} value={name} onChange={(event) => setName(event.target.value)} placeholder="My phone" /></label><button type="submit" className={primary} disabled={pending}><KeyRound size={16} aria-hidden="true" />{pending ? "Preparing setup…" : "Generate setup code"}</button></form>}
              {canEnroll && !showSetup && !setup && snapshot.status.action !== "enroll" && !challengeOnly && <div className="space-y-3"><p className="text-sm leading-6 muted">Use an authenticator app on your phone. After setup, all future sign-ins will ask for a code. Keep a second verified device if you need a backup.</p><button type="button" className={button} onClick={() => setShowSetup(true)}><Plus size={16} aria-hidden="true" />{snapshot.factors.length ? "Add backup authenticator" : "Set up authenticator"}</button></div>}
            </>}
      {error && <div className="space-y-2"><p role="alert" className="text-sm leading-6 text-red-700 dark:text-red-300">{error}</p><button type="button" className={button} disabled={pending} onClick={() => { setReload((value) => value + 1); setError(""); }}><RefreshCw size={16} aria-hidden="true" />Reload security status</button></div>}
      {notice && <p role="status" className="text-sm leading-6 text-emerald-700 dark:text-emerald-300">{notice}</p>}
    </div>
  </section>;
}
