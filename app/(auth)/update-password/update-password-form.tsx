"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";

export function UpdatePasswordForm({ sessionId }: { sessionId: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<"expired" | "complete">();
  const [error, setError] = useState("");
  const inFlight = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    setError("");
    if (password.length < 8 || new TextEncoder().encode(password).length > 72) {
      setError("Use at least 8 characters and at most 72 bytes.");
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
      if (response.ok) setStatus("complete");
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
        <Link href="/login" className="inline-flex min-h-11 items-center rounded-xl bg-blue-700 px-4 py-2 text-sm font-semibold text-white">
          Go to login
        </Link>
      </div>
    );
  }
  if (status === "expired") {
    return (
      <div className="mt-6 space-y-4">
        <p role="alert" className="text-sm">This reset session is no longer active. If you already changed your password, try signing in.</p>
        <Link href="/forgot-password" className="text-sm font-semibold text-blue-600">Request a new reset link</Link>
      </div>
    );
  }
  return (
    <form onSubmit={(event) => void submit(event)} className="mt-7 space-y-4">
      <label className="block space-y-2 text-sm font-semibold">
        <span>New password</span>
        <input required type="password" autoComplete="new-password" minLength={8} value={password}
          onChange={(event) => setPassword(event.target.value)} className="field w-full" />
      </label>
      <label className="block space-y-2 text-sm font-semibold">
        <span>Confirm password</span>
        <input required type="password" autoComplete="new-password" minLength={8} value={confirm}
          onChange={(event) => setConfirm(event.target.value)} className="field w-full" />
      </label>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={loading}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl gradient px-4 py-3 text-sm font-bold disabled:opacity-60">
        {loading && <Loader2 className="animate-spin" size={17} aria-hidden="true" />}
        {loading ? "Updating…" : "Update password"}
      </button>
    </form>
  );
}
