"use client";

import { type FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { GraduationCap, Loader2, ShieldCheck, Users, UserRound } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

const modes = [
  { id: "teacher", label: "Teacher", detail: "Invitation from your school", Icon: UserRound },
  { id: "student", label: "Student", detail: "Admission number, date of birth and mobile", Icon: GraduationCap },
  { id: "parent", label: "Parent", detail: "Invitation from your school", Icon: Users },
] as const;

const inputClass = "w-full rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3.5";

export default function ActivatePage() {
  const router = useRouter();
  const supabase = createClient();
  const [mode, setMode] = useState<(typeof modes)[number]["id"]>("teacher");
  const [admissionNo, setAdmissionNo] = useState("");
  const [dob, setDob] = useState("");
  const [mobile, setMobile] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode !== "student" || loading) return;
    setLoading(true);
    setError("");

    const result = await supabase.rpc("activate_student", { p_admission_no: admissionNo.trim(), p_dob: dob, p_mobile: mobile.trim() });

    setLoading(false);
    if (result.error) {
      setError(result.error.message.replace(/^.*?: /, ""));
      return;
    }
    router.replace("/dashboard");
    router.refresh();
  }

  return (
    <main className="min-h-screen bg-[var(--bg)] p-6">
      <div className="mx-auto max-w-3xl">
        <div className="card overflow-hidden">
          <div className="gradient p-7 sm:p-9">
            <div>
              <p className="text-[30px] font-black leading-none tracking-[-0.045em]">SMS</p>
              <p className="mt-2 text-xs text-white/75">Account activation</p>
            </div>
            <h1 className="mt-8 text-3xl font-black">Verify your school account</h1>
            <p className="mt-2 max-w-2xl text-sm text-white/80">Choose how to verify your access to the school.</p>
          </div>
          <div className="p-6 sm:p-9">
            <div className="grid gap-3 sm:grid-cols-3">
              {modes.map(({ id, label, detail, Icon }) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={mode === id}
                  disabled={loading}
                  onClick={() => { setMode(id); setError(""); }}
                  className={`rounded-2xl border p-4 text-left ${mode === id ? "border-blue-500 bg-blue-50 dark:bg-blue-950/40" : "border-[var(--border)]"}`}
                >
                  <Icon size={20} aria-hidden="true" />
                  <span className="mt-2 block font-bold">{label}</span>
                  <span className="mt-1 block text-xs muted">{detail}</span>
                </button>
              ))}
            </div>
            {mode !== "student" ? (
              <section className="mt-7 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
                <h2 className="font-semibold">Open your {mode === "teacher" ? "teacher" : "guardian"} invitation</h2>
                <p className="mt-2 text-sm muted">
                  Ask your school to send you an invitation link. Open the link and sign in using the email address your school invited.
                </p>
              </section>
            ) : (
              <form onSubmit={submit} className="mt-7 space-y-4">
                <label className="block">
                  <span className="mb-2 block text-xs font-semibold">Admission Number</span>
                  <input required value={admissionNo} onChange={(e) => setAdmissionNo(e.target.value)} className={inputClass} placeholder="e.g. ADM-2026-001" />
                </label>
                <label className="block">
                  <span className="mb-2 block text-xs font-semibold">Date of Birth</span>
                  <input required type="date" value={dob} onChange={(e) => setDob(e.target.value)} className={inputClass} />
                </label>
                <label className="block">
                  <span className="mb-2 block text-xs font-semibold">Registered Mobile</span>
                  <input required type="tel" value={mobile} onChange={(e) => setMobile(e.target.value)} className={inputClass} placeholder="10 digit mobile number" />
                </label>
                {error && (
                  <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                    {error}
                  </div>
                )}
                <div className="flex items-start gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4 text-xs muted">
                  <ShieldCheck className="shrink-0 text-emerald-600" size={18} aria-hidden="true" />
                  <span>The school must already have a record matching the details you enter.</span>
                </div>
                <button type="submit" disabled={loading} className="flex w-full items-center justify-center gap-2 rounded-2xl gradient py-3.5 text-sm font-bold disabled:opacity-60">
                  {loading ? <><Loader2 className="animate-spin" size={17} aria-hidden="true" /> Verifying…</> : "Verify & activate account"}
                </button>
              </form>
            )}
            <p className="mt-5 text-center text-xs muted">Need Admin, Principal, Finance or Reception access? Ask your School Admin to assign the role.</p>
          </div>
        </div>
      </div>
    </main>
  );
}
