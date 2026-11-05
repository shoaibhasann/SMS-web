"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { guardianAttendancePath, rememberFamilyChild } from "@/lib/attendance/family";
import { createClient } from "@/lib/supabase/client";

const primaryButton = "w-full rounded-xl bg-blue-700 px-4 py-3 text-sm font-bold text-white hover:bg-blue-800 disabled:opacity-50";
const textButton = "text-sm font-semibold text-blue-700 underline underline-offset-4 dark:text-blue-300 disabled:opacity-50";
const unavailable = "This invitation is expired, revoked, already used, or no longer available. Ask your school for a new link if you still need access.";

type Account = { id: string; email?: string };
type InvitationKind = "guardian" | "teacher";

const invitationDetails = {
  guardian: {
    title: "Guardian invitation",
    route: "/guardian-invite",
    rpc: "accept_guardian_invitation",
    access: "view the child’s attendance history",
    account: "Create a guardian account",
    dashboard: "attendance",
  },
  teacher: {
    title: "Teacher invitation",
    route: "/teacher-invite",
    rpc: "accept_teacher_invitation",
    access: "open your teaching workspace",
    account: "Create a teacher account",
    dashboard: "dashboard",
  },
} as const;

function subscribeToHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function getInviteHash() {
  return window.location.hash;
}

export function SchoolInvitationPage({ kind }: { kind: InvitationKind }) {
  const { title } = invitationDetails[kind];
  // Keep the bearer token out of HTTP URLs, auth callbacks and persistent storage.
  const hash = useSyncExternalStore(subscribeToHash, getInviteHash, () => null);
  const token = hash?.match(/^#token=([a-f0-9]{64})$/)?.[1];

  return (
    <main className="grid min-h-screen place-items-center bg-[var(--bg)] p-4 sm:p-6">
      <section className="card w-full max-w-lg overflow-hidden" aria-labelledby="school-invite-heading">
        <header className="gradient p-5 text-white sm:p-7">
          <div>
            <p className="text-[30px] font-black leading-none tracking-[-0.045em]">SMS</p>
            <h1 id="school-invite-heading" className="mt-3 text-2xl font-black">{title}</h1>
          </div>
        </header>
        <div className="space-y-5 p-5 sm:p-7">
          {hash === null ? <p role="status" className="text-sm muted">Opening invitation…</p>
            : token ? <SchoolInviteForm key={token} token={token} kind={kind} />
            : (
              <>
                <p className="text-sm muted">Open the original invitation from your school. If you just confirmed your email, reopen that link to finish linking your account.</p>
                <Link href="/login" className={textButton}>Go to sign in</Link>
              </>
            )}
        </div>
      </section>
    </main>
  );
}

function SchoolInviteForm({ token, kind }: { token: string; kind: InvitationKind }) {
  const details = invitationDetails[kind];
  const router = useRouter();
  const [client] = useState(createClient);
  const [account, setAccount] = useState<Account | null>();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [destinationPath, setDestinationPath] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const actionInFlight = useRef(false);

  useEffect(() => {
    let active = true;
    void client.auth.getUser().then(({ data, error: authError }) => {
      if (active) setAccount(authError ? null : data.user);
    }, () => {
      if (active) setAccount(null);
    });
    return () => { active = false; };
  }, [client]);

  async function runAction(action: () => Promise<void>, failureMessage: string) {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setPending(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch {
      setError(failureMessage);
    } finally {
      actionInFlight.current = false;
      setPending(false);
    }
  }

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === "signin") {
      await runAction(async () => {
        const { data, error: authError } = await client.auth.signInWithPassword({ email: email.trim(), password });
        if (authError || !data.user || !data.session) throw authError ?? new Error();
        setPassword("");
        setAccount(data.user);
      }, "Could not sign in. Use the email invited by your school and check your password and email confirmation.");
      return;
    }

    await runAction(async () => {
      const callback = new URL("/auth/callback", window.location.origin);
      callback.searchParams.set("next", details.route);
      const { data, error: authError } = await client.auth.signUp({
        email: email.trim(),
        password,
        options: { emailRedirectTo: callback.toString() },
      });
      if (authError) throw authError;
      setPassword("");
      if (data.session) {
        await client.auth.signOut({ scope: "local" });
        setError("Email confirmation is required. Ask your school to check the account setup.");
        return;
      }
      setMode("signin");
      setMessage("Check your email for a confirmation link. Confirm your email, then reopen the original school invitation and sign in. If you already have an account, sign in below.");
    }, "Could not create the account. Check your email and password, or sign in if you already have an account.");
  }

  async function acceptInvite() {
    if (!account) return;
    await runAction(async () => {
      const { data: current, error: authError } = await client.auth.getUser();
      if (authError || current.user?.id !== account.id || current.user.email !== account.email) {
        setAccount(authError ? null : current.user);
        setError("Your sign-in changed. Check the account before accepting the invitation.");
        return;
      }
      const { data, error: inviteError } = await client.rpc(details.rpc, { p_token: token });
      if (inviteError?.code === "42501") {
        setError(kind === "teacher"
          ? "This account cannot accept the invitation. Use the confirmed email your school invited. If that is already correct, ask the school to check your existing roles and teacher link."
          : "This account cannot accept the invitation. Sign in with the confirmed email your school invited, or ask the school to check your access.");
        return;
      }
      if (inviteError?.code === "P0001") {
        setError(unavailable);
        return;
      }
      if (inviteError) throw inviteError;
      let destination = "/dashboard";
      if (kind === "guardian") {
        if (typeof data?.student_id !== "string") throw new Error();
        const remembered = rememberFamilyChild(account.id, data.student_id);
        destination = remembered ? guardianAttendancePath : `${guardianAttendancePath}&child=${encodeURIComponent(data.student_id)}`;
      } else if (typeof data?.teacher_id !== "string") {
        throw new Error();
      }
      setDestinationPath(destination);
      router.replace(destination);
    }, kind === "guardian"
      ? "Could not complete the invitation. Try again. If it was already accepted, open Attendance from your dashboard."
      : "Could not complete the invitation. Try again. If it was already accepted, open your dashboard.");
  }

  async function switchAccount() {
    await runAction(async () => {
      const { error: authError } = await client.auth.signOut({ scope: "local" });
      if (authError) throw authError;
      setAccount(null);
      setEmail("");
      setPassword("");
      setMode("signin");
    }, "Could not sign out. Please try again.");
  }

  if (account === undefined) return <p role="status" className="text-sm muted">Checking your sign-in…</p>;
  if (destinationPath) {
    return (
      <div className="space-y-3">
        <p role="status" className="text-sm muted">Invitation accepted. Opening {details.dashboard}…</p>
        <Link href={destinationPath} className={textButton}>Open {details.dashboard}</Link>
      </div>
    );
  }

  return (
    <>
      {error && <p role="alert" className="rounded-xl border border-red-500/40 p-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
      {message && <p role="status" className="rounded-xl border border-[var(--border)] p-3 text-sm">{message}</p>}
      {account ? (
        <div className="space-y-4">
          <p className="break-words text-sm muted">Signed in as <strong>{account.email ?? "your account"}</strong>.</p>
          <p className="text-sm muted">Accept the invitation to link your school account and {details.access}.</p>
          <button type="button" className={primaryButton} onClick={acceptInvite} disabled={pending}>Accept invitation</button>
          <button type="button" className={textButton} onClick={switchAccount} disabled={pending}>Use a different account</button>
          {pending && <p role="status" className="text-sm muted">Please wait…</p>}
        </div>
      ) : (
        <form className="space-y-4" onSubmit={authenticate}>
          <p className="text-sm muted">Use the email address your school invited. New accounts need email confirmation before accepting.</p>
          <label className="block space-y-1 text-sm font-semibold">
            <span>Email address</span>
            <input className="field" autoComplete="email" type="email" required value={email}
              disabled={pending} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label className="block space-y-1 text-sm font-semibold">
            <span>Password</span>
            <input className="field" autoComplete={mode === "signup" ? "new-password" : "current-password"}
              type="password" required minLength={mode === "signup" ? 8 : undefined} value={password}
              disabled={pending} onChange={(event) => setPassword(event.target.value)} />
          </label>
          <button type="submit" className={primaryButton} disabled={pending}>
            {pending ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}
          </button>
          <div className="flex flex-wrap justify-between gap-3">
            <button type="button" className={textButton} disabled={pending} onClick={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setPassword("");
              setError("");
              setMessage("");
            }}>{mode === "signin" ? details.account : "I already have an account"}</button>
            {mode === "signin" && <Link href="/forgot-password" className={textButton}>Forgot password?</Link>}
          </div>
        </form>
      )}
    </>
  );
}
