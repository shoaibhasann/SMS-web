"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { GraduationCap, Loader2, ShieldCheck, Users, UserRound } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Mode = "teacher" | "student" | "parent";

export default function ActivatePage() {
  const router = useRouter();
  const supabase = createClient();
  const [mode, setMode] = useState<Mode>("teacher");
  const [employeeId, setEmployeeId] = useState("");
  const [admissionNo, setAdmissionNo] = useState("");
  const [dob, setDob] = useState("");
  const [guardianCode, setGuardianCode] = useState("");
  const [mobile, setMobile] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault(); setLoading(true); setError("");
    let errorMessage = "";
    if (mode === "teacher") {
      const { error } = await supabase.rpc("activate_teacher", { p_employee_id: employeeId.trim(), p_mobile: mobile.trim() });
      errorMessage = error?.message ?? "";
    } else if (mode === "student") {
      const { error } = await supabase.rpc("activate_student", { p_admission_no: admissionNo.trim(), p_dob: dob, p_mobile: mobile.trim() });
      errorMessage = error?.message ?? "";
    } else {
      const { error } = await supabase.rpc("activate_parent", { p_parent_code: guardianCode.trim(), p_mobile: mobile.trim() });
      errorMessage = error?.message ?? "";
    }
    setLoading(false);
    if (errorMessage) { setError(errorMessage.replace(/^.*?: /, "")); return; }
    router.replace("/dashboard"); router.refresh();
  }

  return <main className="min-h-screen bg-[var(--bg)] p-6"><div className="mx-auto max-w-3xl"><div className="card overflow-hidden"><div className="gradient p-7 sm:p-9"><div className="flex items-center gap-3"><div className="grid h-12 w-12 place-items-center rounded-2xl bg-white text-blue-600"><GraduationCap/></div><div><div className="text-lg font-black">Kids Corner</div><div className="text-xs text-white/75">Account activation</div></div></div><h1 className="mt-8 text-3xl font-black">Verify your school account</h1><p className="mt-2 max-w-2xl text-sm text-white/80">Your login account is created, but no school role is attached yet. Verify your pre-created school record to activate access.</p></div><div className="p-6 sm:p-9"><div className="grid gap-3 sm:grid-cols-3"><button onClick={()=>{setMode("teacher");setError("")}} className={`rounded-2xl border p-4 text-left ${mode==="teacher"?"border-blue-500 bg-blue-50 dark:bg-blue-950/40":"border-[var(--border)]"}`}><UserRound size={20}/><div className="mt-2 font-bold">Teacher</div><div className="mt-1 text-xs muted">Employee ID + registered mobile</div></button><button onClick={()=>{setMode("student");setError("")}} className={`rounded-2xl border p-4 text-left ${mode==="student"?"border-blue-500 bg-blue-50 dark:bg-blue-950/40":"border-[var(--border)]"}`}><GraduationCap size={20}/><div className="mt-2 font-bold">Student</div><div className="mt-1 text-xs muted">Admission no. + DOB + mobile</div></button><button onClick={()=>{setMode("parent");setError("")}} className={`rounded-2xl border p-4 text-left ${mode==="parent"?"border-blue-500 bg-blue-50 dark:bg-blue-950/40":"border-[var(--border)]"}`}><Users size={20}/><div className="mt-2 font-bold">Parent</div><div className="mt-1 text-xs muted">Guardian code + registered mobile</div></button></div><form onSubmit={submit} className="mt-7 space-y-4">{mode==="teacher"&&<label className="block"><span className="mb-2 block text-xs font-semibold">Employee ID</span><input required value={employeeId} onChange={e=>setEmployeeId(e.target.value)} className="w-full rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] py-3.5 px-4 outline-none" placeholder="e.g. KC-T-001"/></label>}{mode==="student"&&<><label className="block"><span className="mb-2 block text-xs font-semibold">Admission Number</span><input required value={admissionNo} onChange={e=>setAdmissionNo(e.target.value)} className="w-full rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] py-3.5 px-4 outline-none" placeholder="e.g. KC-2026-001"/></label><label className="block"><span className="mb-2 block text-xs font-semibold">Date of Birth</span><input required type="date" value={dob} onChange={e=>setDob(e.target.value)} className="w-full rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] py-3.5 px-4 outline-none"/></label></>}{mode==="parent"&&<label className="block"><span className="mb-2 block text-xs font-semibold">Guardian Code</span><input required value={guardianCode} onChange={e=>setGuardianCode(e.target.value)} className="w-full rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] py-3.5 px-4 outline-none" placeholder="e.g. KC-P-001"/></label>}<label className="block"><span className="mb-2 block text-xs font-semibold">Registered Mobile</span><input required value={mobile} onChange={e=>setMobile(e.target.value)} className="w-full rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] py-3.5 px-4 outline-none" placeholder="10 digit mobile number"/></label>{error&&<div className="rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{error}</div>}<div className="flex items-start gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4 text-xs muted"><ShieldCheck className="shrink-0 text-emerald-600" size={18}/><span>School roles are never selected freely. The details above are matched against a record already created by the school.</span></div><button disabled={loading} className="flex w-full items-center justify-center gap-2 rounded-2xl gradient py-3.5 text-sm font-bold disabled:opacity-60">{loading?<Loader2 className="animate-spin" size={17}/>:"Verify & activate account"}</button></form><p className="mt-5 text-center text-xs muted">Need Admin, Principal, Finance or Reception access? Ask your School Admin to assign the role.</p></div></div></div></main>;
}
