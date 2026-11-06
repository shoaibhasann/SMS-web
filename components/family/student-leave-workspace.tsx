"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { CalendarDays, Check, Clock3, RefreshCw, Send, X } from "lucide-react";
import { loadFamilyStudents, rememberFamilyChild, restoreFamilyChild, type FamilyStudent } from "@/lib/attendance/family";
import { loadSchoolManagementAccess } from "@/lib/attendance/repository";
import { schoolDate, studentName } from "@/lib/attendance/types";
import { createClient } from "@/lib/supabase/client";
import {
  listFamilyStudentLeave, listStudentLeaveReview, reviewStudentLeave, studentLeavePageSize,
  StudentLeaveError, submitStudentLeave, validateStudentLeave,
  type StudentLeaveDecision, type StudentLeaveRequest, type StudentLeaveStatus,
} from "@/lib/student-leave";
import { LoadingState } from "@/components/ui/skeleton";

type Client = ReturnType<typeof createClient>;
type Role = "parent" | "student" | "admin" | "principal";
type Mode = "family" | "review";
type Load<T> = { data: T; error?: never } | { data?: never; error: string };
type Notice = { error: boolean; text: string };
type Access = Awaited<ReturnType<typeof loadSchoolManagementAccess>>;
type BusyProps = { onBusyChange: (busy: boolean) => void };

const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold disabled:opacity-50";
const primary = `${button} border-transparent bg-[var(--primary)] text-white dark:text-slate-950`;
const label = "block space-y-2 text-sm font-semibold";
const dateFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const timeFormat = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const statusLabels: Record<StudentLeaveStatus, string> = { pending: "Pending review", approved: "Approved", rejected: "Rejected" };

function errorText(error: unknown, fallback: string) {
  return error instanceof StudentLeaveError ? error.message : fallback;
}

function useMounted() {
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  return alive;
}

export function StudentLeaveWorkspace({ role, userId, mode }: { role: Role; userId: string; mode?: Mode }) {
  const resolvedMode = mode ?? (role === "parent" || role === "student" ? "family" : "review");
  return <LeaveSession key={`${userId}:${role}:${resolvedMode}`} role={role} userId={userId} mode={resolvedMode} />;
}

function LeaveSession({ role, userId, mode }: { role: Role; userId: string; mode: Mode }) {
  const [client] = useState(createClient);
  const [sessionChanged, setSessionChanged] = useState(false);
  useEffect(() => {
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) setSessionChanged(true);
    });
    return () => subscription.unsubscribe();
  }, [client, userId]);
  const family = role === "parent" || role === "student";
  return <div className="space-y-6">
    <header>
      <p className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-blue-700 dark:text-blue-300"><CalendarDays size={15} aria-hidden="true" /> Student wellbeing</p>
      <h1 className="mt-2 text-3xl font-black tracking-tight">Leave requests</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed muted">{mode === "family"
        ? "Request time away from school and follow the saved decision for each child."
        : "Review student leave with a recorded decision and reason. Historical requests stay with their original class and session."}</p>
    </header>
    {sessionChanged ? <p role="alert" className="card p-5 text-sm text-red-700 dark:text-red-300">Your sign-in changed. Reload this page to verify leave access.</p>
      : family !== (mode === "family") ? <p role="alert" className="card p-5 text-sm">This account cannot open this leave view.</p>
        : family ? <FamilyLeaveAccess client={client} role={role} userId={userId} />
          : <ReviewLeaveAccess client={client} userId={userId} />}
  </div>;
}

function FamilyLeaveAccess({ client, role, userId }: { client: Client; role: "parent" | "student"; userId: string }) {
  const [attempt, setAttempt] = useState(0);
  const [access, setAccess] = useState<{ attempt: number; result: Load<FamilyStudent[]> }>();
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);
  const result = access?.attempt === attempt ? access.result : undefined;
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const { data: { user }, error } = await client.auth.getUser();
        if (error || user?.id !== userId) throw new Error("Account changed");
        const students = await loadFamilyStudents(client, role, userId);
        if (!active) return;
        setAccess({ attempt, result: { data: students } });
        setSelected((previous) => students.some((student) => student.id === previous) ? previous
          : role === "parent" ? restoreFamilyChild(userId, students) : students[0]?.id ?? "");
      } catch {
        if (active) setAccess({ attempt, result: { error: "The students linked to this account could not be verified. Refresh linked students to try again." } });
      }
    }
    void load();
    return () => { active = false; };
  }, [attempt, client, role, userId]);
  const students = result?.data ?? [];
  const student = students.find((item) => item.id === selected);
  function confirmDiscard() {
    if (hasDraft && !window.confirm("Discard the unsaved leave request? Its dates and reason will be cleared.")) return false;
    setHasDraft(false);
    return true;
  }
  return <>
    <section className="card flex flex-col gap-4 p-4 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between sm:p-5" aria-label="Leave student access">
      {role === "parent" && result?.data?.length ? <div className={`${label} min-w-0 sm:max-w-xl sm:flex-1`}>
        <label htmlFor="student-leave-child">Select child</label><select id="student-leave-child" className="field" value={selected} disabled={busy} onChange={(event) => {
          if (event.target.value === selected || !students.some((item) => item.id === event.target.value) || !confirmDiscard()) return;
          setSelected(event.target.value); rememberFamilyChild(userId, event.target.value);
        }}>{students.map((item) => <option key={item.id} value={item.id}>{studentName(item)} · {item.admission_no}</option>)}</select>
      </div> : <div><h2 className="font-bold">{student ? studentName(student) : "Linked student access"}</h2>{student && <p className="mt-1 text-sm muted">{student.admission_no}</p>}</div>}
      <button type="button" className={button} disabled={busy || !result} onClick={() => { if (confirmDiscard()) setAttempt((value) => value + 1); }}><RefreshCw size={15} aria-hidden="true" /> Refresh linked students</button>
    </section>
    {!result ? <LoadingState variant="form" className="text-sm muted">Checking linked student access…</LoadingState>
      : result.error ? <p role="alert" className="card p-5 text-sm text-red-700 dark:text-red-300">{result.error}</p>
        : !student ? <p className="card p-5 text-sm muted">No student is currently linked to this account.</p>
          : <FamilyStudentLeave key={student.id} client={client} student={student} onBusyChange={setBusy} onDraftChange={setHasDraft} />}
  </>;
}

function FamilyStudentLeave({ client, student, onBusyChange, onDraftChange }: { client: Client; student: FamilyStudent; onDraftChange: (dirty: boolean) => void } & BusyProps) {
  const [page, setPage] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [startDate, setStartDate] = useState(schoolDate);
  const [endDate, setEndDate] = useState(schoolDate);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const [result, setResult] = useState<{ key: string; value: Load<StudentLeaveRequest[]> }>();
  const attempt = useRef<{ payload: string; key: string } | null>(null);
  const inFlight = useRef(false);
  const alive = useMounted();
  const queryKey = `${student.id}:${page}:${refresh}`;
  const history = result?.key === queryKey ? result.value : undefined;
  useEffect(() => {
    let active = true;
    listFamilyStudentLeave(client, student.id, student.school_id, page * studentLeavePageSize).then(
      (rows) => { if (active) setResult({ key: queryKey, value: { data: rows } }); },
      (error: unknown) => { if (active) setResult({ key: queryKey, value: { error: errorText(error, "Leave history could not be loaded. Refresh to try again.") } }); },
    );
    return () => { active = false; };
  }, [client, page, queryKey, student.id, student.school_id]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || student.status !== "active") return;
    const invalid = validateStudentLeave(startDate, endDate, reason);
    if (invalid) { setNotice({ error: true, text: invalid }); return; }
    const payload = JSON.stringify([student.id, startDate, endDate, reason.trim()]);
    inFlight.current = true;
    setSaving(true); onBusyChange(true); setNotice(undefined);
    try {
      if (attempt.current?.payload !== payload) attempt.current = { payload, key: crypto.randomUUID() };
      await submitStudentLeave(client, { studentId: student.id, startDate, endDate, reason, idempotencyKey: attempt.current.key });
      if (!alive.current) return;
      attempt.current = null;
      onDraftChange(false);
      setReason(""); setPage(0); setRefresh((value) => value + 1);
      setNotice({ error: false, text: "Leave request saved. The school will review it; refresh history to follow its decision." });
    } catch (error) {
      if (alive.current) setNotice({ error: true, text: errorText(error, "The submission could not be confirmed. Your dates and reason are kept. Retry the same request or refresh its saved history.") });
    } finally {
      inFlight.current = false;
      if (alive.current) { setSaving(false); onBusyChange(false); }
    }
  }

  return <div className="grid items-start gap-5 xl:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.5fr)]">
    <section className="card space-y-4 p-5" aria-labelledby="leave-request-heading">
      <div className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-blue-500/10 text-blue-700 dark:text-blue-300"><Send size={20} aria-hidden="true" /></div>
      <div><h2 id="leave-request-heading" className="text-lg font-bold">Request student leave</h2><p className="mt-1 text-sm leading-relaxed muted">Use dates within the student’s current academic year. Pending and approved requests cannot overlap.</p></div>
      {notice && <Message notice={notice} />}
      {student.status !== "active" ? <p className="rounded-xl bg-[var(--surface-2)] p-4 text-sm muted">New requests are available only for an active student. The saved leave history remains below.</p> : <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          <div className={label}><label htmlFor="student-leave-start">Start date</label><input id="student-leave-start" className="field" type="date" required value={startDate} disabled={saving} onChange={(event) => { setStartDate(event.target.value); onDraftChange(true); }} /></div>
          <div className={label}><label htmlFor="student-leave-end">End date</label><input id="student-leave-end" className="field" type="date" required min={startDate || undefined} value={endDate} disabled={saving} onChange={(event) => { setEndDate(event.target.value); onDraftChange(true); }} /></div>
        </div>
        <div className={label}><label htmlFor="student-leave-reason">Leave reason</label><textarea id="student-leave-reason" className="field min-h-28 resize-y" rows={4} required minLength={3} maxLength={1000} value={reason} disabled={saving} onChange={(event) => { setReason(event.target.value); onDraftChange(true); }} aria-describedby="leave-reason-help" /></div>
        <p id="leave-reason-help" className="text-xs muted">3–1,000 characters. Share only what the school needs to review this request.</p>
        <button type="submit" className={`${primary} w-full`} disabled={saving}><Send size={16} aria-hidden="true" />{saving ? "Saving request…" : "Submit leave request"}</button>
      </form>}
      <p className="border-t border-[var(--border)] pt-4 text-xs leading-relaxed muted">A leave decision does not change the attendance register. Contact the school if an attendance record needs correction.</p>
    </section>
    <section className="card overflow-hidden" aria-label="Student leave history" aria-busy={!history}>
      <HistoryHeader title="Saved leave history" busy={saving} onRefresh={() => setRefresh((value) => value + 1)} />
      {!history ? <LoadingState variant="table" className="p-5 text-sm muted">Loading saved leave history…</LoadingState>
        : history.error ? <p role="alert" className="p-5 text-sm text-red-700 dark:text-red-300">{history.error}</p>
          : <><RequestList rows={history.data ?? []} /><HistoryPagination rows={history.data ?? []} page={page} busy={saving} onPage={setPage} /></>}
    </section>
  </div>;
}

function ReviewLeaveAccess({ client, userId }: { client: Client; userId: string }) {
  const [attempt, setAttempt] = useState(0);
  const [access, setAccess] = useState<{ attempt: number; result: Load<Access> }>();
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const result = access?.attempt === attempt ? access.result : undefined;
  useEffect(() => {
    let active = true;
    loadSchoolManagementAccess(client, "student leave", ["school_admin", "principal"]).then(
      (data) => {
        if (active) setAccess({ attempt, result: data.userId === userId ? { data } : { error: "Your sign-in changed. Reload this page to verify school access." } });
      },
      () => { if (active) setAccess({ attempt, result: { error: "School review access could not be verified. Retry school access to continue." } }); },
    );
    return () => { active = false; };
  }, [attempt, client, userId]);
  const schools = result?.data?.schools ?? [];
  const schoolId = schools.find((school) => school.id === selected)?.id ?? (schools.length === 1 ? schools[0].id : "");
  return <>
    {!result ? <LoadingState variant="form" className="text-sm muted">Checking school review access…</LoadingState>
      : result.error ? <div className="card space-y-3 p-5"><p role="alert" className="text-sm text-red-700 dark:text-red-300">{result.error}</p><button type="button" className={button} onClick={() => setAttempt((value) => value + 1)}>Retry school access</button></div>
        : <>
          <section className="card flex flex-col gap-4 p-5 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between" aria-label="Leave review school access">
            <div className={`${label} min-w-0 sm:max-w-xl sm:flex-1`}><label htmlFor="student-leave-school">School</label><select id="student-leave-school" className="field" value={schoolId} disabled={busy || schools.length === 1} onChange={(event) => setSelected(event.target.value)}><option value="">Choose school</option>{schools.map((school) => <option key={school.id} value={school.id}>{school.name}</option>)}</select></div>
            <button type="button" className={button} disabled={busy} onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={15} aria-hidden="true" /> Refresh school access</button>
          </section>
          {schoolId ? <StudentLeaveReview key={schoolId} client={client} schoolId={schoolId} userId={userId} onBusyChange={setBusy} />
            : <p className="text-sm muted">Select an authorized school to review student leave.</p>}
        </>}
  </>;
}

function StudentLeaveReview({ client, schoolId, userId, onBusyChange }: { client: Client; schoolId: string; userId: string } & BusyProps) {
  const [status, setStatus] = useState<StudentLeaveStatus | "">("pending");
  const [page, setPage] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ key: string; value: Load<StudentLeaveRequest[]> }>();
  const [selected, setSelected] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const inFlight = useRef(false);
  const alive = useMounted();
  const key = `${schoolId}:${status}:${page}:${refresh}`;
  const history = result?.key === key ? result.value : undefined;
  useEffect(() => {
    let active = true;
    listStudentLeaveReview(client, schoolId, status || null, page * studentLeavePageSize).then(
      (rows) => { if (active) setResult({ key, value: { data: rows } }); },
      (error: unknown) => { if (active) setResult({ key, value: { error: errorText(error, "Student leave requests could not be loaded. Refresh to try again.") } }); },
    );
    return () => { active = false; };
  }, [client, key, page, schoolId, status]);

  async function decide(event: FormEvent<HTMLFormElement>, request: StudentLeaveRequest) {
    event.preventDefault();
    const decision = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value");
    if (inFlight.current || request.status !== "pending" || request.requester_id === userId || !["approved", "rejected"].includes(decision ?? "")) return;
    if (reason.trim().length < 3 || reason.trim().length > 1000) { setNotice({ error: true, text: "Enter a review reason between 3 and 1,000 characters." }); return; }
    inFlight.current = true;
    setSaving(true); onBusyChange(true); setNotice(undefined);
    try {
      await reviewStudentLeave(client, request.id, decision as StudentLeaveDecision, reason);
      if (!alive.current) return;
      setSelected(""); setReason(""); setRefresh((value) => value + 1);
      setNotice({ error: false, text: decision === "approved" ? "Leave approved. The decision is saved; attendance has not been changed." : "Leave rejected. The decision and reason are saved." });
    } catch (error) {
      if (alive.current) setNotice({ error: true, text: errorText(error, "The review could not be confirmed. Your reason is kept. Retry the same decision or refresh the saved status.") });
    } finally {
      inFlight.current = false;
      if (alive.current) { setSaving(false); onBusyChange(false); }
    }
  }

  return <section className="card overflow-hidden" aria-label="Student leave review" aria-busy={!history}>
    <HistoryHeader title="Student leave review" busy={saving} onRefresh={() => setRefresh((value) => value + 1)} />
    <div className="space-y-4 border-b border-[var(--border)] p-5">
      <div className={`${label} max-w-xs`}><label htmlFor="student-leave-status">Request status</label><select id="student-leave-status" className="field" value={status} disabled={saving} onChange={(event) => { setStatus(event.target.value as StudentLeaveStatus | ""); setPage(0); }}><option value="pending">Pending review</option><option value="">All requests</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select></div>
      <p className="text-xs muted">Each request has one final decision. The attendance register is managed separately.</p>
      {notice && <Message notice={notice} />}
    </div>
    {!history ? <LoadingState variant="table" className="p-5 text-sm muted">Loading student leave requests…</LoadingState>
      : history.error ? <p role="alert" className="p-5 text-sm text-red-700 dark:text-red-300">{history.error}</p>
        : <><RequestList rows={history.data ?? []} review={(request) => request.status !== "pending" ? null
          : request.requester_id === userId ? <p className="text-sm muted">Another administrator or principal must review your own request.</p>
            : selected !== request.id ? <button type="button" className={button} disabled={saving} onClick={() => { setSelected(request.id); setReason(""); setNotice(undefined); }}>Review request</button>
              : <form className="space-y-3 rounded-xl bg-[var(--surface-2)] p-4" onSubmit={(event) => void decide(event, request)}>
                <div className={label}><label htmlFor="student-leave-review-reason">Review reason</label><textarea id="student-leave-review-reason" className="field" required rows={3} minLength={3} maxLength={1000} value={reason} disabled={saving} onChange={(event) => setReason(event.target.value)} /></div>
                <div className="flex flex-wrap gap-2"><button type="submit" value="approved" className={primary} disabled={saving}><Check size={16} aria-hidden="true" />Approve leave</button><button type="submit" value="rejected" className={`${button} text-red-700 dark:text-red-300`} disabled={saving}><X size={16} aria-hidden="true" />Reject leave</button><button type="button" className={button} disabled={saving} onClick={() => { setSelected(""); setReason(""); setNotice(undefined); }}>Cancel review</button></div>
              </form>} /><HistoryPagination rows={history.data ?? []} page={page} busy={saving} onPage={setPage} /></>}
  </section>;
}

function HistoryHeader({ title, busy, onRefresh }: { title: string; busy: boolean; onRefresh: () => void }) {
  return <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] p-5"><div><h2 className="text-lg font-bold">{title}</h2><p className="mt-1 text-xs muted">Saved requests and recorded school decisions.</p></div><button type="button" className={button} disabled={busy} onClick={onRefresh}><RefreshCw size={15} aria-hidden="true" />Refresh leave history</button></header>;
}

function Message({ notice }: { notice: Notice }) {
  return <p role={notice.error ? "alert" : "status"} className={`rounded-xl p-3 text-sm ${notice.error ? "bg-red-500/10 text-red-700 dark:text-red-300" : "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"}`}>{notice.text}</p>;
}

function RequestList({ rows, review }: { rows: StudentLeaveRequest[]; review?: (request: StudentLeaveRequest) => React.ReactNode }) {
  if (!rows.length) return <p className="p-5 text-sm muted">No leave requests on this page.</p>;
  return <ul className="divide-y divide-[var(--border)]" aria-label="Saved leave requests">{rows.map((request) => <li key={request.id} className="space-y-4 p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-bold">{request.student_name}</h3><p className="mt-1 text-xs muted">{request.admission_no} · {[request.academic_year_name, request.class_name, request.section_name].filter(Boolean).join(" / ")}</p></div><span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold ${request.status === "pending" ? "bg-amber-500/10 text-amber-800 dark:text-amber-200" : request.status === "approved" ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300" : "bg-red-500/10 text-red-700 dark:text-red-300"}`}><Clock3 size={13} aria-hidden="true" />{statusLabels[request.status]}</span></div>
    <p className="text-sm font-semibold"><time dateTime={request.start_date}>{dateFormat.format(new Date(`${request.start_date}T00:00:00Z`))}</time>{request.end_date !== request.start_date && <> – <time dateTime={request.end_date}>{dateFormat.format(new Date(`${request.end_date}T00:00:00Z`))}</time></>}</p>
    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{request.reason}</p>
    <p className="text-xs muted">Requested{request.requester_name && ` by ${request.requester_name}`} · {timeFormat.format(new Date(request.created_at))} IST</p>
    {request.reviewed_at && <div className="rounded-xl bg-[var(--surface-2)] p-4"><p className="text-xs font-semibold">{statusLabels[request.status]}{request.reviewer_name && ` by ${request.reviewer_name}`} · {timeFormat.format(new Date(request.reviewed_at))} IST</p><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{request.review_note}</p></div>}
    {review?.(request)}
  </li>)}</ul>;
}

function HistoryPagination({ rows, page, busy, onPage }: { rows: StudentLeaveRequest[]; page: number; busy: boolean; onPage: (page: number) => void }) {
  const total = rows[0]?.total_count ?? 0;
  return <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] p-5"><p className="text-xs muted">{rows.length ? `${page * studentLeavePageSize + 1}–${page * studentLeavePageSize + rows.length} of ${total} requests` : `Page ${page + 1}`}</p><div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy || page === 0} onClick={() => onPage(page - 1)}>Previous requests</button><button type="button" className={button} disabled={busy || (page + 1) * studentLeavePageSize >= total} onClick={() => onPage(page + 1)}>Next requests</button></div></footer>;
}
