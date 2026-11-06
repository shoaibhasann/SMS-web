"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { WalletCards } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { readPages } from "@/lib/attendance/repository";
import { AdvanceCreditAccount } from "./advance-credit-account";
import { LoadingState } from "@/components/ui/skeleton";

type OfficeRole = { role: string; school_id: string | null };
type School = { id: string; name: string };
type Student = { id: string; admission_no: string; first_name: string; middle_name: string | null; last_name: string | null; status: string };
type Access = { schools: School[]; roles: OfficeRole[] };
const officeRoles = ["school_admin", "principal", "accountant"];
const button = "inline-flex min-h-11 items-center justify-center rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold disabled:opacity-50";

function rememberedContext(userId: string) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(`kids-corner-advance-context:v1:${userId}`) ?? "null");
    return saved && typeof saved.schoolId === "string" && typeof saved.studentId === "string" ? saved as { schoolId: string; studentId: string } : null;
  } catch { return null; }
}
function rememberContext(userId: string, schoolId: string, studentId: string) {
  try { sessionStorage.setItem(`kids-corner-advance-context:v1:${userId}`, JSON.stringify({ schoolId, studentId })); } catch { /* Optional browser convenience; operation recovery has its own scoped key. */ }
}

export function AdvanceCreditWorkspace({ userId }: { userId: string }) {
  return <OfficeAdvanceCredit key={userId} userId={userId} />;
}

function OfficeAdvanceCredit({ userId }: { userId: string }) {
  const [client] = useState(createClient), id = useId();
  const [access, setAccess] = useState<Access>();
  const [schoolId, setSchoolId] = useState("");
  const [studentId, setStudentId] = useState("");
  const [search, setSearch] = useState("");
  const [roster, setRoster] = useState<{ schoolId: string; students?: Student[]; error?: string }>();
  const [error, setError] = useState("");
  const [sessionChanged, setSessionChanged] = useState(false);
  const [contextLocked, setContextLocked] = useState(false);
  const sessionValid = useRef(true);
  const students = roster?.schoolId === schoolId ? roster.students : undefined;
  const selected = students?.find((row) => row.id === studentId);
  const filtered = students?.filter((row) => row.id === studentId || `${row.admission_no} ${row.first_name} ${row.middle_name ?? ""} ${row.last_name ?? ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) ?? [];
  const canReview = Boolean(access?.roles.some((role) => (role.role === "super_admin" && role.school_id === null)
    || (["school_admin", "principal"].includes(role.role) && role.school_id === schoolId)));

  useEffect(() => {
    let active = true;
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) { sessionValid.current = false; setSessionChanged(true); setAccess(undefined); setRoster(undefined); }
    });
    void (async () => {
      try {
        const { data: { user }, error: authError } = await client.auth.getUser();
        if (authError || user?.id !== userId) throw new Error("Sign in again to open advance credit.");
        const roles = await readPages<OfficeRole>((from, to) => client.from("user_roles").select("role,school_id", { count: "exact" }).eq("user_id", userId).order("id").range(from, to), "Finance access");
        const globalAdmin = roles.some((row) => row.role === "super_admin" && row.school_id === null);
        const schoolIds = [...new Set(roles.flatMap((row) => row.school_id && officeRoles.includes(row.role) ? [row.school_id] : []))];
        if (!globalAdmin && !schoolIds.length) throw new Error("A school Admin, Principal or Finance role is required for advance credit.");
        const schools = await readPages<School>((from, to) => {
          const query = client.from("schools").select("id,name", { count: "exact" }).order("name").order("id");
          return (globalAdmin ? query : query.in("id", schoolIds)).range(from, to);
        }, "Authorized schools");
        if (!schools.length) throw new Error("No authorized school was found.");
        if (!active || !sessionValid.current) return;
        const saved = rememberedContext(userId), savedSchool = schools.find((school) => school.id === saved?.schoolId);
        setAccess({ schools, roles });
        setSchoolId(savedSchool?.id ?? (schools.length === 1 ? schools[0].id : ""));
        if (savedSchool) setStudentId(saved!.studentId);
      } catch (issue) { if (active && sessionValid.current) setError(issue instanceof Error ? issue.message : "School access could not be verified. Reopen this page."); }
    })();
    return () => { active = false; subscription.unsubscribe(); };
  }, [client, userId]);

  useEffect(() => {
    if (!schoolId || !sessionValid.current) return;
    let active = true;
    void readPages<Student>((from, to) => client.from("students")
      .select("id,admission_no,first_name,middle_name,last_name,status", { count: "exact" })
      .eq("school_id", schoolId).order("admission_no").order("id").range(from, to), "School students")
      .then((rows) => { if (active && sessionValid.current) setRoster({ schoolId, students: rows }); }, () => {
        if (active && sessionValid.current) setRoster({ schoolId, error: "Students could not be loaded. Reopen this page to verify school access." });
      });
    return () => { active = false; };
  }, [client, schoolId]);

  return <div className="space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-blue-700 dark:text-blue-300"><WalletCards size={16} aria-hidden="true" /> Finance</div>
        <h1 className="text-2xl font-bold sm:text-3xl">Advance credit</h1>
        <p className="mt-2 max-w-2xl text-sm muted">Receive money ahead of fees, apply stored credit to a student&apos;s dues, and track controlled offline refunds.</p></div>
      <Link href="/modules/fees" className={button}>Back to fees</Link>
    </header>
    {sessionChanged ? <p role="alert" className="card p-5 text-sm">Your sign-in changed. Reopen this page to verify access. No previous account results are shown.</p>
      : error ? <p role="alert" className="card p-5 text-sm text-red-700 dark:text-red-300">{error}</p>
        : !access ? <LoadingState variant="form" className="card p-5 text-sm muted">Checking school finance access…</LoadingState>
          : <>
            <section aria-label="Advance credit context" className="card space-y-3 p-4 sm:p-5">
              <div className="grid gap-4 lg:grid-cols-3">
                <div><label htmlFor={`${id}-school`} className="mb-2 block text-sm font-semibold">Credit school</label><select id={`${id}-school`} className="field" value={schoolId} disabled={contextLocked || access.schools.length === 1} onChange={(event) => {
                  const value = event.target.value; setSchoolId(value); setStudentId(""); setSearch(""); rememberContext(userId, value, "");
                }}><option value="">Choose school</option>{access.schools.map((school) => <option key={school.id} value={school.id}>{school.name}</option>)}</select></div>
                <div><label htmlFor={`${id}-search`} className="mb-2 block text-sm font-semibold">Find student</label><input id={`${id}-search`} type="search" className="field" value={search} disabled={!students || contextLocked} placeholder="Name or admission number" onChange={(event) => setSearch(event.target.value)} /></div>
                <div><label htmlFor={`${id}-student`} className="mb-2 block text-sm font-semibold">Credit student</label><select id={`${id}-student`} className="field" value={selected?.id ?? ""} disabled={!students || contextLocked} onChange={(event) => { setStudentId(event.target.value); rememberContext(userId, schoolId, event.target.value); }}>
                  <option value="">Choose student</option>{filtered.map((student) => <option key={student.id} value={student.id}>{student.admission_no} · {[student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" ")}{student.status !== "active" ? ` (${student.status})` : ""}</option>)}</select></div>
              </div>
              <p className="text-xs muted">Credit belongs to this student in this school across academic sessions. Applying credit is separate from receiving money.</p>
              {contextLocked && <p role="status" className="text-xs text-amber-800 dark:text-amber-300">Finish or discard the current review before changing student. An unconfirmed saved operation must be retried first.</p>}
              {schoolId && !students && (roster?.schoolId === schoolId && roster.error ? <p role="alert" className="text-sm muted">{roster.error}</p> : <LoadingState variant="table">Loading students…</LoadingState>)}
            </section>
            {selected && <AdvanceCreditAccount key={`${userId}:${schoolId}:${selected.id}`} client={client} schoolId={schoolId} userId={userId} studentId={selected.id} canReview={canReview} onLockChange={setContextLocked} />}
          </>}
  </div>;
}
