"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Building2,
  Chrome,
  GraduationCap,
  Loader2,
  LockKeyhole,
  Mail,
  ShieldCheck,
} from "lucide-react";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState("");

  async function signIn(event: FormEvent) {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setError("");

    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    router.replace("/dashboard");
    router.refresh();
  }

  async function signInWithGoogle() {
    if (googleLoading) return;
    setGoogleLoading(true);
    setError("");

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      setError(error.message);
      setGoogleLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[var(--bg)] p-4 sm:p-6">
      <div className="mx-auto grid min-h-[calc(100vh-32px)] max-w-6xl overflow-hidden rounded-[32px] border border-[var(--border)] bg-[var(--surface)] shadow-2xl lg:grid-cols-2">
        <section className="relative hidden overflow-hidden gradient p-10 lg:flex lg:flex-col lg:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="grid h-12 w-12 place-items-center rounded-2xl bg-white text-blue-600">
                <GraduationCap />
              </div>
              <div>
                <div className="text-lg font-black">Kids Corner</div>
                <div className="text-xs text-white/70">School Management System</div>
              </div>
            </div>
            <div className="mt-24 max-w-md">
              <div className="text-6xl font-black leading-[.95]">
                Bright Minds.
                <br />
                Brighter Futures.
              </div>
              <p className="mt-6 text-base leading-7 text-white/80">
                One connected school workspace for administration, teachers,
                students, parents and finance.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-6 text-xs text-white/70">
            <span className="flex items-center gap-2">
              <ShieldCheck size={15} /> Secure & role-based
            </span>
            <span className="flex items-center gap-2">
              <Building2 size={15} /> CBSE + UP Board ready
            </span>
          </div>
        </section>

        <section className="relative flex items-center justify-center p-6 sm:p-10">
          <div className="absolute right-6 top-6">
            <ThemeToggle />
          </div>

          <div className="w-full max-w-md">
            <div className="mb-10 lg:hidden">
              <div className="flex items-center gap-3">
                <div className="grid h-12 w-12 place-items-center rounded-2xl gradient">
                  <GraduationCap />
                </div>
                <div>
                  <div className="font-black">Kids Corner</div>
                  <div className="text-xs muted">School Management System</div>
                </div>
              </div>
            </div>

            <h1 className="text-3xl font-black tracking-tight">Welcome back 👋</h1>
            <p className="mt-2 text-sm muted">
              Sign in with your school account or continue with Google.
            </p>

            <form onSubmit={signIn} className="mt-8 space-y-4">
              <label className="block">
                <span className="mb-2 block text-xs font-semibold">Email</span>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 muted" size={18} />
                  <input
                    required
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] py-3.5 pl-11 pr-4 outline-none focus:ring-2 focus:ring-blue-500/20"
                    placeholder="you@school.com"
                  />
                </div>
              </label>

              <label className="block">
                <span className="mb-2 block text-xs font-semibold">Password</span>
                <div className="relative">
                  <LockKeyhole className="absolute left-3 top-1/2 -translate-y-1/2 muted" size={18} />
                  <input
                    required
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] py-3.5 pl-11 pr-4 outline-none focus:ring-2 focus:ring-blue-500/20"
                    placeholder="Enter password"
                  />
                </div>
              </label>

              {error && (
                <div className="rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                  {error}
                </div>
              )}

              <button
                disabled={loading}
                className="flex w-full items-center justify-center gap-2 rounded-2xl gradient py-3.5 text-sm font-bold shadow-lg shadow-blue-500/20 disabled:opacity-60"
              >
                {loading ? <Loader2 className="animate-spin" size={17} /> : <>Sign In <ArrowRight size={17} /></>}
              </button>
            </form>

            <div className="my-6 flex items-center gap-3 text-xs muted">
              <div className="h-px flex-1 bg-[var(--border)]" />
              OR
              <div className="h-px flex-1 bg-[var(--border)]" />
            </div>

            <button
              type="button"
              onClick={signInWithGoogle}
              disabled={googleLoading}
              className="flex w-full items-center justify-center gap-3 rounded-2xl border border-[var(--border)] py-3.5 text-sm font-semibold disabled:opacity-60"
            >
              {googleLoading ? <Loader2 className="animate-spin" size={18} /> : <Chrome size={18} />}
              Continue with Google
            </button>

            <p className="mt-8 text-center text-xs muted">
              Google login is open to everyone, but school access is granted only
              after a verified school role is linked.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
