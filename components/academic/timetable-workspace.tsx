"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { CalendarClock, Pencil, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
import { loadFamilyStudents, rememberFamilyChild, restoreFamilyChild, type FamilyStudent } from "@/lib/attendance/family";
import { loadSchoolManagementAccess } from "@/lib/attendance/repository";
import { studentName } from "@/lib/attendance/types";
import { createClient } from "@/lib/supabase/client";
import {
  findStaleTimetablePeriods, formatTimetableTime, getFamilyTimetable, getOfficeTimetable, getTeacherTimetable, getTimetableSetup,
  removeTimetablePeriod, saveTimetablePeriod, timetableDays, TimetableError, validateTimetableDraft,
  type TimetableDraft, type TimetablePeriod, type TimetableSetup, type TimetableView,
} from "@/lib/timetable";
import { LoadingState } from "@/components/ui/skeleton";

type Client = ReturnType<typeof createClient>;
type Role = "admin" | "principal" | "teacher" | "parent" | "student";
type Load<T> = { data: T; error?: never } | { data?: never; error: string };
type Notice = { text: string; error?: boolean };
type Access = Awaited<ReturnType<typeof loadSchoolManagementAccess>>;
const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold disabled:opacity-50";
const primary = `${button} border-transparent bg-[var(--primary)] text-white dark:text-slate-950`;
const label = "min-w-0 space-y-2 text-sm font-semibold";
const errorText = (error: unknown, fallback: string) => error instanceof TimetableError ? error.message : fallback;

function useAlive() {
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  return alive;
}

export function TimetableWorkspace({ role, userId }: { role: Role; userId: string }) {
  return <TimetableSession key={`${role}:${userId}`} role={role} userId={userId} />;
}

function TimetableSession({ role, userId }: { role: Role; userId: string }) {
  const [client] = useState(createClient);
  const [sessionChanged, setSessionChanged] = useState(false);
  const office = role === "admin" || role === "principal";
  useEffect(() => {
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) setSessionChanged(true);
    });
    return () => subscription.unsubscribe();
  }, [client, userId]);
  return <div className="space-y-6">
    <header><p className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-blue-700 dark:text-blue-300"><CalendarClock size={15} aria-hidden="true" /> School week</p>
      <h1 className="mt-2 text-3xl font-black tracking-tight">Timetable</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed muted">{office
        ? "Plan class periods with eligible teachers. Saved changes are shared immediately with the permitted class and teacher."
        : "Your weekly school schedule, with subjects, teachers and school times in IST."}</p></header>
    {sessionChanged ? <p role="alert" className="card p-5 text-sm text-red-700 dark:text-red-300">Your sign-in changed. Reload this page to verify timetable access.</p>
      : office ? <OfficeAccess client={client} userId={userId} />
        : role === "teacher" ? <TeacherTimetable client={client} />
          : <FamilyTimetableAccess client={client} role={role} userId={userId} />}
  </div>;
}

function FamilyTimetableAccess({ client, role, userId }: { client: Client; role: "parent" | "student"; userId: string }) {
  const [attempt, setAttempt] = useState(0);
  const [access, setAccess] = useState<{ attempt: number; result: Load<FamilyStudent[]> }>();
  const [selected, setSelected] = useState("");
  const result = access?.attempt === attempt ? access.result : undefined;
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const { data: { user }, error } = await client.auth.getUser();
        if (error || user?.id !== userId) throw new Error();
        const students = await loadFamilyStudents(client, role, userId);
        if (!active) return;
        setAccess({ attempt, result: { data: students } });
        setSelected((previous) => students.some((item) => item.id === previous) ? previous
          : role === "parent" ? restoreFamilyChild(userId, students) : students[0]?.id ?? "");
      } catch { if (active) setAccess({ attempt, result: { error: "Linked students could not be verified. Refresh linked students to try again." } }); }
    })();
    return () => { active = false; };
  }, [attempt, client, role, userId]);
  const students = result?.data ?? [], student = students.find((item) => item.id === selected);
  return <>
    <section aria-label="Timetable student access" className="card flex flex-col gap-4 p-5 sm:flex-row sm:items-end sm:justify-between">
      {role === "parent" && students.length ? <div className={`${label} sm:max-w-xl sm:flex-1`}><label htmlFor="timetable-child">Select child</label>
        <select id="timetable-child" className="field" value={selected} onChange={(event) => { setSelected(event.target.value); rememberFamilyChild(userId, event.target.value); }}>
          {students.map((item) => <option key={item.id} value={item.id}>{studentName(item)} · {item.admission_no}</option>)}
        </select></div> : <div><h2 className="font-bold">{student ? studentName(student) : "Student access"}</h2>{student && <p className="mt-1 text-sm muted">{student.admission_no}</p>}</div>}
      <button type="button" className={button} disabled={!result} onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={15} aria-hidden="true" />Refresh linked students</button>
    </section>
    {!result ? <LoadingState variant="form" className="text-sm muted">Checking linked student access…</LoadingState>
      : result.error ? <ErrorMessage text={result.error} />
        : !student ? <p className="card p-5 text-sm muted">No student is currently linked to this account.</p>
          : <FamilyWeek key={student.id} client={client} student={student} />}
  </>;
}

function FamilyWeek({ client, student }: { client: Client; student: FamilyStudent }) {
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ refresh: number; value: Load<TimetableView> }>();
  const current = result?.refresh === refresh ? result.value : undefined;
  useEffect(() => {
    let active = true;
    getFamilyTimetable(client, student.id, student.school_id).then(
      (data) => { if (active) setResult({ refresh, value: { data } }); },
      (error: unknown) => { if (active) setResult({ refresh, value: { error: errorText(error, "The student's timetable could not be loaded. Refresh to try again.") } }); },
    );
    return () => { active = false; };
  }, [client, refresh, student.id, student.school_id]);
  return <SchedulePanel result={current} onRefresh={() => setRefresh((value) => value + 1)} />;
}

function TeacherTimetable({ client }: { client: Client }) {
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ refresh: number; value: Load<TimetableView> }>();
  const current = result?.refresh === refresh ? result.value : undefined;
  useEffect(() => {
    let active = true;
    getTeacherTimetable(client).then((data) => { if (active) setResult({ refresh, value: { data } }); },
      (error: unknown) => { if (active) setResult({ refresh, value: { error: errorText(error, "Your timetable could not be loaded. Refresh to try again.") } }); });
    return () => { active = false; };
  }, [client, refresh]);
  return <SchedulePanel result={current} onRefresh={() => setRefresh((value) => value + 1)} />;
}

function OfficeAccess({ client, userId }: { client: Client; userId: string }) {
  const [attempt, setAttempt] = useState(0);
  const [access, setAccess] = useState<{ attempt: number; result: Load<Access> }>();
  const [selected, setSelected] = useState("");
  const [locked, setLocked] = useState(false);
  const result = access?.attempt === attempt ? access.result : undefined;
  useEffect(() => {
    let active = true;
    loadSchoolManagementAccess(client, "timetable", ["school_admin", "principal"]).then(
      (data) => { if (active) setAccess({ attempt, result: data.userId === userId ? { data } : { error: "Your sign-in changed. Reload to verify school access." } }); },
      () => { if (active) setAccess({ attempt, result: { error: "School timetable access could not be verified. Refresh school access to try again." } }); },
    );
    return () => { active = false; };
  }, [attempt, client, userId]);
  const schools = result?.data?.schools ?? [];
  const schoolId = schools.some((school) => school.id === selected) ? selected : schools.length === 1 ? schools[0].id : "";
  return <>
    <section aria-label="Timetable school access" className="card flex flex-col gap-4 p-5 sm:flex-row sm:items-end sm:justify-between">
      <div className={`${label} sm:max-w-xl sm:flex-1`}><label htmlFor="timetable-school">School</label><select id="timetable-school" className="field" value={schoolId} disabled={locked || schools.length === 1} onChange={(event) => setSelected(event.target.value)}>
        <option value="">Choose school</option>{schools.map((school) => <option key={school.id} value={school.id}>{school.name}</option>)}
      </select></div>
      <button type="button" className={button} disabled={locked || !result} onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={15} aria-hidden="true" />Refresh school access</button>
    </section>
    {!result ? <LoadingState variant="form" className="text-sm muted">Checking school access…</LoadingState>
      : result.error ? <ErrorMessage text={result.error} />
        : schoolId ? <OfficeSchool key={schoolId} client={client} schoolId={schoolId} onLocked={setLocked} />
          : <p className="text-sm muted">Choose an authorized school to manage its timetable.</p>}
  </>;
}

function OfficeSchool({ client, schoolId, onLocked }: { client: Client; schoolId: string; onLocked: (value: boolean) => void }) {
  const [attempt, setAttempt] = useState(0);
  const [setup, setSetup] = useState<{ attempt: number; value: Load<TimetableSetup> }>();
  const [yearId, setYearId] = useState("");
  const [classId, setClassId] = useState("");
  const [sectionId, setSectionId] = useState("");
  const [locked, setLocked] = useState(false);
  const current = setup?.attempt === attempt ? setup.value : undefined;
  useEffect(() => {
    let active = true;
    getTimetableSetup(client, schoolId).then((data) => {
      if (!active) return;
      setSetup({ attempt, value: { data } });
      setYearId((previous) => data.years.some((item) => item.id === previous) ? previous : data.years.find((item) => item.is_current)?.id ?? data.years[0]?.id ?? "");
      setClassId((previous) => data.classes.some((item) => item.id === previous) ? previous : data.classes[0]?.id ?? "");
    }, (error: unknown) => { if (active) setSetup({ attempt, value: { error: errorText(error, "Timetable setup could not be loaded. Refresh setup to try again.") } }); });
    return () => { active = false; };
  }, [attempt, client, schoolId]);
  function lock(value: boolean) { setLocked(value); onLocked(value); }
  const data = current?.data;
  const sections = data?.sections.filter((item) => item.class_id === classId) ?? [];
  const section = sections.some((item) => item.id === sectionId) ? sectionId : "";
  return <>
    <section className="card space-y-4 p-5" aria-label="Timetable class scope">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-bold">Class schedule</h2><button type="button" className={button} disabled={locked || !current} onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={15} aria-hidden="true" />Refresh timetable setup</button></div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className={label}><label htmlFor="timetable-year">Academic year</label><select id="timetable-year" className="field" value={yearId} disabled={locked || !data} onChange={(event) => setYearId(event.target.value)}><option value="">Choose year</option>{data?.years.map((item) => <option key={item.id} value={item.id}>{item.name}{item.is_current ? " · Current" : ""}</option>)}</select></div>
        <div className={label}><label htmlFor="timetable-class">Class</label><select id="timetable-class" className="field" value={classId} disabled={locked || !data} onChange={(event) => { setClassId(event.target.value); setSectionId(""); }}><option value="">Choose class</option>{data?.classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
        <div className={label}><label htmlFor="timetable-section">View section</label><select id="timetable-section" className="field" value={section} disabled={locked || !data} onChange={(event) => setSectionId(event.target.value)}><option value="">All sections</option>{sections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
      </div>
      {locked && <p className="text-xs muted">Save or cancel the open period draft before changing school, class or session.</p>}
    </section>
    {!current ? <LoadingState variant="form" className="text-sm muted">Loading timetable setup…</LoadingState> : current.error ? <ErrorMessage text={current.error} />
      : data && yearId && classId ? <OfficeWeek key={`${schoolId}:${yearId}:${classId}:${section}`} client={client} schoolId={schoolId} yearId={yearId} classId={classId} sectionId={section || null} setup={data} onLocked={lock} />
        : <p className="card p-5 text-sm muted">Set up an academic year and class before creating periods.</p>}
  </>;
}

function OfficeWeek({ client, schoolId, yearId, classId, sectionId, setup, onLocked }: {
  client: Client; schoolId: string; yearId: string; classId: string; sectionId: string | null; setup: TimetableSetup; onLocked: (value: boolean) => void;
}) {
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ refresh: number; value: Load<TimetableView>; stale?: TimetablePeriod[] }>();
  const [draft, setDraft] = useState<TimetableDraft>();
  const [baseline, setBaseline] = useState<TimetablePeriod | null>(null);
  const [removal, setRemoval] = useState<TimetablePeriod>();
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const request = useRef<{ payload: string; id: string } | null>(null);
  const inFlight = useRef(false);
  const alive = useAlive();
  const current = result?.refresh === refresh ? result.value : undefined;
  const stale = result?.refresh === refresh ? result.stale ?? [] : [];
  const assignments = setup.assignments.filter((item) => item.academic_year_id === yearId && item.class_id === classId);
  const assignment = assignments.find((item) => item.id === draft?.assignmentId);
  const sections = setup.sections.filter((item) => item.class_id === classId);

  useEffect(() => {
    let active = true;
    getOfficeTimetable(client, schoolId, yearId, classId, sectionId).then(async (data) => {
      // A failed check only hides the clean-up action; the periods still show as Needs attention.
      const orphaned = await findStaleTimetablePeriods(client, data.rows).catch(() => []);
      if (active) setResult({ refresh, value: { data }, stale: orphaned });
    },
      (error: unknown) => { if (active) setResult({ refresh, value: { error: errorText(error, "The class timetable could not be loaded. Refresh to try again.") } }); });
    return () => { active = false; };
  }, [classId, client, refresh, schoolId, sectionId, yearId]);

  function clear() { setDraft(undefined); setBaseline(null); setRemoval(undefined); request.current = null; onLocked(false); }
  function edit(row?: TimetablePeriod) {
    if ((draft || removal) && !window.confirm("Discard the open timetable draft? Unsaved changes will be cleared.")) return;
    setRemoval(undefined); setBaseline(row ? { ...row } : null); request.current = null; setNotice(undefined); onLocked(true);
    setDraft(row ? { assignmentId: row.assignment_id ?? "", sectionId: row.section_id, day: row.day_of_week,
      period: row.period_no, start: row.start_time ?? "", end: row.end_time ?? "", room: row.room ?? "" }
      : { assignmentId: "", sectionId, day: 1, period: 1, start: "", end: "", room: "" });
  }
  function update(patch: Partial<TimetableDraft>) { setDraft((previous) => previous ? { ...previous, ...patch } : previous); }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || inFlight.current) return;
    const invalid = validateTimetableDraft(draft);
    if (invalid) { setNotice({ text: invalid, error: true }); return; }
    await mutate("save", draft, baseline);
  }
  async function mutate(kind: "save" | "remove", value: TimetableDraft | null, row: TimetablePeriod | null) {
    if (inFlight.current) return;
    const payload = JSON.stringify([kind, schoolId, row?.id, row?.version, value ? { ...value, room: value.room.trim() || null } : null]);
    if (request.current?.payload !== payload) request.current = { payload, id: crypto.randomUUID() };
    inFlight.current = true; setSaving(true); onLocked(true); setNotice(undefined);
    try {
      if (kind === "save" && value) await saveTimetablePeriod(client, schoolId, value, row, request.current.id);
      else if (row) await removeTimetablePeriod(client, schoolId, row, request.current.id);
      if (!alive.current) return;
      clear(); setRefresh((previous) => previous + 1);
      setNotice({ text: kind === "save" ? "Period saved and shared with its permitted class and teacher." : "Period removed from the shared timetable." });
    } catch (error) { if (alive.current) setNotice({ error: true, text: errorText(error, "The change could not be confirmed. Your draft is kept. Retry the same change or refresh the saved timetable.") }); }
    finally { inFlight.current = false; if (alive.current) setSaving(false); }
  }

  async function removeStale(rows: TimetablePeriod[]) {
    const plural = rows.length === 1 ? "" : "s";
    if (inFlight.current || !window.confirm(`Remove ${rows.length} stale period${plural} whose teaching assignment was removed? Attendance and learning records are preserved.`)) return;
    inFlight.current = true; setSaving(true); onLocked(true); setNotice(undefined);
    let removed = 0;
    try {
      // Each period goes through the governed, receipted removal with its loaded version.
      for (const row of rows) { await removeTimetablePeriod(client, schoolId, row, crypto.randomUUID()); removed += 1; }
      if (alive.current) setNotice({ text: `${removed} stale period${plural} removed from the shared timetable.` });
    } catch (error) {
      if (alive.current) setNotice({ error: true, text: `${removed} of ${rows.length} stale periods removed. ${errorText(error, "The rest could not be confirmed. Refresh the timetable and try again.")}` });
    } finally {
      inFlight.current = false;
      if (alive.current) { setSaving(false); onLocked(false); setRefresh((value) => value + 1); }
    }
  }

  return <div className="space-y-5">
    {notice && <p role={notice.error ? "alert" : "status"} className={`card p-4 text-sm ${notice.error ? "text-red-700 dark:text-red-300" : "text-emerald-800 dark:text-emerald-300"}`}>{notice.text}</p>}
    <div className="flex flex-wrap gap-3"><button type="button" className={primary} disabled={saving || !current?.data} onClick={() => edit()}><Plus size={16} aria-hidden="true" />Add period</button>
      <button type="button" className={button} disabled={saving} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={15} aria-hidden="true" />Refresh timetable</button></div>
    {stale.length > 0 && <section className="card space-y-3 p-5" aria-label="Stale timetable periods">
      <p className="text-sm text-amber-900 dark:text-amber-200">{stale.length} period{stale.length === 1 ? " still uses" : "s still use"} a teaching assignment that was removed. {stale.length === 1 ? "It is" : "They are"} hidden from teachers and families but still reserve the teacher&apos;s time.</p>
      <button type="button" className={`${button} text-red-700 dark:text-red-300`} disabled={saving || Boolean(draft || removal)} onClick={() => void removeStale(stale)}><Trash2 size={16} aria-hidden="true" />Remove stale periods</button>
    </section>}
    {draft && <section className="card p-5" aria-labelledby="timetable-editor-heading"><div className="flex items-start justify-between gap-3"><div><h2 id="timetable-editor-heading" className="text-lg font-bold">{baseline ? "Edit period" : "New period"}</h2><p className="mt-1 text-sm muted">Times are in IST. Saving shares this period immediately.</p></div><button type="button" className={button} disabled={saving} onClick={clear}><X size={16} aria-hidden="true" />Cancel draft</button></div>
      <form className="mt-5 space-y-4" onSubmit={(event) => void save(event)}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className={`${label} sm:col-span-2`}><label htmlFor="period-assignment">Subject and teacher</label><select id="period-assignment" className="field" required value={draft.assignmentId} disabled={saving} onChange={(event) => {
            const selected = assignments.find((item) => item.id === event.target.value);
            update({ assignmentId: event.target.value, sectionId: selected?.section_id ?? draft.sectionId });
          }}><option value="">Choose an eligible teaching assignment</option>{assignments.map((item) => <option key={item.id} value={item.id}>{item.subject_name} · {item.teacher_name} · {item.section_id ? sections.find((section) => section.id === item.section_id)?.name ?? "Section" : "Whole class assignment"}</option>)}</select></div>
          <div className={label}><label htmlFor="period-section">Period section</label><select id="period-section" className="field" value={draft.sectionId ?? ""} disabled={saving || !assignment || assignment.section_id !== null} onChange={(event) => update({ sectionId: event.target.value || null })}>
            <option value="">Whole class (all sections)</option>{sections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></div>
          <div className={label}><label htmlFor="period-day">Weekday</label><select id="period-day" className="field" value={draft.day} disabled={saving} onChange={(event) => update({ day: Number(event.target.value) })}>{timetableDays.map((day, index) => <option key={day} value={index + 1}>{day}</option>)}</select></div>
          <div className={label}><label htmlFor="period-number">Period number</label><input id="period-number" className="field" type="number" min={1} step={1} required value={draft.period || ""} disabled={saving} onChange={(event) => update({ period: Number(event.target.value) })} /></div>
          <div className={label}><label htmlFor="period-room">Room (optional)</label><input id="period-room" className="field" maxLength={120} value={draft.room} disabled={saving} onChange={(event) => update({ room: event.target.value })} /></div>
          <div className={label}><label htmlFor="period-start">Start time</label><input id="period-start" className="field" type="time" step={60} required value={draft.start} disabled={saving} onChange={(event) => update({ start: event.target.value })} /></div>
          <div className={label}><label htmlFor="period-end">End time</label><input id="period-end" className="field" type="time" step={60} required value={draft.end} disabled={saving} onChange={(event) => update({ end: event.target.value })} /></div>
        </div>
        {!assignments.length && <p className="text-sm muted">No eligible teaching assignments are available for this class and academic year. Set up an assignment before saving a period.</p>}
        {baseline?.assignment_id && !assignment && <p className="text-sm text-amber-800 dark:text-amber-200">The original teaching assignment is no longer eligible. Choose a current assignment before saving.</p>}
        <p className="text-xs leading-relaxed muted">Teacher availability, class/section overlaps and duplicate period numbers are checked when saving. Adjacent periods may meet at the same time. A list refresh keeps this draft and its original version.</p>
        <button type="submit" className={primary} disabled={saving || !assignment}><Save size={16} aria-hidden="true" />{saving ? "Saving period…" : "Save period"}</button>
      </form>
    </section>}
    {removal && <section className="card space-y-4 p-5" aria-labelledby="period-removal-heading"><h2 id="period-removal-heading" className="text-lg font-bold">Remove this period?</h2>
      <p className="text-sm muted">{timetableDays[removal.day_of_week - 1] ?? "Unconfigured day"} · Period {removal.period_no} · {removal.subject_name ?? "Unconfigured subject"}. It will disappear from the shared timetable. Attendance and learning records are preserved.</p>
      <div className="flex flex-wrap gap-3"><button type="button" className={`${button} text-red-700 dark:text-red-300`} disabled={saving} onClick={() => void mutate("remove", null, removal)}><Trash2 size={16} aria-hidden="true" />{saving ? "Removing period…" : "Confirm remove period"}</button><button type="button" className={button} disabled={saving} onClick={clear}>Keep period</button></div>
    </section>}
    <SchedulePanel result={current} office onEdit={edit} onRemove={(row) => {
      if ((draft || removal) && !window.confirm("Discard the open timetable draft? Unsaved changes will be cleared.")) return;
      setDraft(undefined); setBaseline(null); setRemoval({ ...row }); request.current = null; setNotice(undefined); onLocked(true);
    }} saving={saving} />
  </div>;
}

function ErrorMessage({ text }: { text: string }) {
  return <p role="alert" className="card p-5 text-sm text-red-700 dark:text-red-300">{text}</p>;
}

function SchedulePanel({ result, onRefresh, office = false, saving = false, onEdit, onRemove }: {
  result?: Load<TimetableView>; onRefresh?: () => void; office?: boolean; saving?: boolean;
  onEdit?: (row: TimetablePeriod) => void; onRemove?: (row: TimetablePeriod) => void;
}) {
  const data = result?.data;
  const days = [...timetableDays.map((name, index) => ({ name, day: index + 1 })), { name: "Needs attention", day: 0 }];
  return <section aria-label="Weekly timetable" className="space-y-4" aria-busy={!result}>
    <header className="card flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-lg font-bold">Weekly timetable</h2>
      <p className="mt-1 text-sm muted">{data?.academic_year_name ? [data.academic_year_name, data.class_name, data.section_name].filter(Boolean).join(" / ") : "Current school schedule"} · All times IST</p></div>
      {onRefresh && <button type="button" className={button} onClick={onRefresh}><RefreshCw size={15} aria-hidden="true" />Refresh timetable</button>}
    </header>
    {!result ? <LoadingState variant="list" className="text-sm muted">Loading saved timetable…</LoadingState> : result.error ? <ErrorMessage text={result.error} />
      : !data?.rows.length ? <p className="card p-5 text-sm muted">{data?.academic_year_id ? "No shared periods are scheduled for this view." : "No current timetable is available for this account or enrollment."}</p>
        : <div className="grid items-start gap-4 lg:grid-cols-2">{days.map(({ name, day }) => {
          const rows = data.rows.filter((row) => day ? row.day_of_week === day : row.day_of_week < 1 || row.day_of_week > 7)
            .sort((a, b) => (a.start_time ?? "99").localeCompare(b.start_time ?? "99") || a.period_no - b.period_no || a.id.localeCompare(b.id));
          return !rows.length ? null : <section className="card overflow-hidden" key={day} aria-label={`${name} periods`}><h3 className="border-b border-[var(--border)] px-5 py-4 font-bold">{name}</h3>
            <ul className="divide-y divide-[var(--border)]">{rows.map((row) => <li key={row.id} className="space-y-3 p-5">
              <div className="flex flex-wrap items-start justify-between gap-2"><p className="font-bold">{formatTimetableTime(row.start_time)} – {formatTimetableTime(row.end_time)}</p><span className="rounded-full bg-[var(--surface-2)] px-3 py-1 text-xs font-semibold">Period {row.period_no}</span></div>
              <div className="min-w-0"><p className="break-words font-semibold">{row.subject_name ?? "Subject needs setup"}</p><p className="mt-1 break-words text-sm muted">{row.teacher_name ?? "Teacher needs setup"}</p><p className="mt-1 break-words text-xs muted">{row.class_name} / {row.section_name ?? "Whole class"}{row.room && ` · ${row.room}`}</p></div>
              {row.needs_attention && <p className="rounded-xl bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">Needs attention: verify the teaching assignment and times before sharing. This row is hidden from family and teacher views.</p>}
              {office && <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={saving} aria-label={`Edit ${name} period ${row.period_no} ${row.section_name ?? "whole class"}`} onClick={() => onEdit?.(row)}><Pencil size={15} aria-hidden="true" />Edit</button><button type="button" className={`${button} text-red-700 dark:text-red-300`} disabled={saving} aria-label={`Remove ${name} period ${row.period_no} ${row.section_name ?? "whole class"}`} onClick={() => onRemove?.(row)}><Trash2 size={15} aria-hidden="true" />Remove</button></div>}
            </li>)}</ul></section>;
        })}</div>}
  </section>;
}
