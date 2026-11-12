"use client";

import { useRef, useState, type FormEvent } from "react";
import { Loader2, Mail, Send } from "lucide-react";

export function RequestPasswordResetForm() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/auth/recovery/request", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!response.ok) throw new Error();
      setSent(true);
    } catch {
      setError("The request could not be submitted. Check your email address and try again.");
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }

  if (sent) {
    return (
      <div role="status" className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300">
        If an account exists for that email, look for a password reset link. Open the latest link in this browser.
      </div>
    );
  }
  return (
    <form onSubmit={(event) => void submit(event)} className="mt-7 space-y-4">
      <label className="block">
        <span className="mb-2 block text-xs font-semibold">Email</span>
        <span className="relative block">
          <Mail className="absolute left-3 top-1/2 -translate-y-1/2 muted" size={18} aria-hidden="true" />
          <input required type="email" autoComplete="email" maxLength={254} value={email}
            onChange={(event) => setEmail(event.target.value)} className="field w-full pl-11" placeholder="name@school.com" />
        </span>
      </label>
      {error && <p role="alert" className="login-error">{error}</p>}
      <button type="submit" disabled={loading}
        className="login-submit">
        {loading ? <Loader2 className="animate-spin" size={17} aria-hidden="true" /> : <Send size={17} aria-hidden="true" />}
        {loading ? "Sending…" : "Send reset link"}
      </button>
    </form>
  );
}
