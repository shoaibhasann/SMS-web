"use client";

import Link from "next/link";
import { ArrowUpRight, Building2, CheckCircle2, CircleAlert, History, RefreshCw, Save, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { loadSchoolManagementAccess } from "@/lib/attendance/repository";
import { createClient } from "@/lib/supabase/client";
import { LoadingState } from "@/components/ui/skeleton";
import { SchoolStaffMfaPolicy } from "@/components/admin/school-staff-mfa-policy";
import { SchoolAttendanceCalendar } from "@/components/admin/school-attendance-calendar";
import { loadSchoolSettings, saveSchoolSettings, schoolBoards, schoolDetails, SchoolSettingsError, validateSchoolDetails,
  type SchoolDetails, type SchoolSettings, type SchoolSettingsIntent } from "@/lib/admin/school-settings";

const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold transition hover:bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
const primary = `${button} border-transparent bg-[var(--primary)] text-white hover:brightness-95 dark:text-[var(--bg)]`;
const fieldLabels: Record<keyof SchoolDetails, string> = { name: "School name", board: "Education board", affiliation_no: "Affiliation number",
  address: "School address", city: "City", state: "State", pincode: "PIN code", phone: "School phone", email: "School email", website: "School website" };
type Access = Awaited<ReturnType<typeof loadSchoolManagementAccess>>;
type Client = ReturnType<typeof createClient>;
type Editor = { details: SchoolDetails; reason: string; revision: number };

export function SchoolSettingsWorkspace({ userId }: { userId: string }) {
  return <OwnSchoolSettings key={userId} userId={userId} />;
}

function OwnSchoolSettings({ userId }: { userId: string }) {
  const [client] = useState(createClient);
  const [access, setAccess] = useState<Access>();
  const [schoolId, setSchoolId] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [sessionChanged, setSessionChanged] = useState(false);
  const [locked, setLocked] = useState(false);
  const [policyLocked, setPolicyLocked] = useState(false);
  const [calendarLocked, setCalendarLocked] = useState(false);

  useEffect(() => {
    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || session?.user.id !== userId) setSessionChanged(true);
    });
    return () => subscription.unsubscribe();
  }, [client, userId]);

  useEffect(() => {
    if (sessionChanged) return;
    let active = true;
    void loadSchoolManagementAccess(client, "school settings", ["school_admin", "principal"]).then((result) => {
      if (!active) return;
      if (result.userId !== userId) { setSessionChanged(true); return; }
      setAccess(result); setError("");
    }, () => { if (active) setError("School access could not be verified. Retry or sign in again."); });
    return () => { active = false; };
  }, [attempt, client, sessionChanged, userId]);

  const selected = access?.schools.find((school) => school.id === schoolId) ?? (access?.schools.length === 1 ? access.schools[0] : undefined);
  return <div className="mx-auto max-w-6xl space-y-5">
    <header className="flex items-start gap-3">
      <div className="rounded-2xl bg-[var(--surface-2)] p-3 text-[var(--primary)]"><Building2 size={24} aria-hidden="true" /></div>
      <div><p className="text-xs font-semibold uppercase tracking-wider muted">School workspace</p>
        <h1 className="mt-1 text-2xl font-bold sm:text-3xl">School settings</h1>
        <p className="mt-2 text-sm leading-6 muted">Keep your school details current and follow the connected setup steps.</p>
        <a href="#attendance-calendar" className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-[var(--primary)] hover:underline">Calendar &amp; daily attendance rules</a></div>
    </header>
    {sessionChanged ? <section className="card space-y-3 p-5"><p role="alert">Your sign-in changed. Reopen school settings after signing in.</p><Link href="/login" className={button}>Return to sign in</Link></section>
      : error ? <section className="card space-y-3 p-5"><p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>
        <button type="button" className={button} onClick={() => { setError(""); setAttempt((value) => value + 1); }}>Retry school access</button></section>
        : !access ? <LoadingState variant="form">Checking school settings access…</LoadingState>
          : <>
            <label className="card block space-y-2 p-4 text-sm font-semibold"><span>School</span>
              <select className="field" value={selected?.id ?? ""} disabled={locked || policyLocked || calendarLocked || access.schools.length === 1} onChange={(event) => setSchoolId(event.target.value)}>
                <option value="">Choose a school</option>{access.schools.map((school) => <option value={school.id} key={school.id}>{school.name}</option>)}
              </select>
              {(locked || policyLocked || calendarLocked) && <span className="block text-xs font-normal muted">Finish or cancel the current edit before switching schools.</span>}
            </label>
            {selected && <SchoolAttendanceCalendar client={client} schoolId={selected.id} userId={userId} onLock={setCalendarLocked} />}
            {selected && <SchoolEditor key={selected.id} client={client} schoolId={selected.id} userId={userId} onLock={setLocked} />}
            {selected && <SchoolStaffMfaPolicy key={`mfa-${selected.id}`} client={client} schoolId={selected.id} userId={userId} onLock={setPolicyLocked} />}
          </>}
  </div>;
}

function SchoolEditor({ client, schoolId, userId, onLock }: { client: Client; schoolId: string; userId: string; onLock: (value: boolean) => void }) {
  const [record, setRecord] = useState<SchoolSettings>();
  const [loadError, setLoadError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<Editor>();
  const [intent, setIntent] = useState<SchoolSettingsIntent>();
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const request = useRef<AbortController | null>(null);
  const reading = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current?.abort(); reading.current?.abort(); onLock(false); };
  }, [onLock]);
  useEffect(() => { onLock(Boolean(editor || intent || saving)); }, [editor, intent, onLock, saving]);
  useEffect(() => {
    const controller = new AbortController(); reading.current = controller;
    void loadSchoolSettings(client, userId, schoolId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setRecord(result); setLoadError(""); setLoading(false);
      if (!result.can_edit) { setEditor(undefined); setIntent(undefined); setConflict(false); }
    }, (error) => {
      if (!controller.signal.aborted) {
        if (error instanceof SchoolSettingsError && error.code === "access") { setRecord(undefined); setEditor(undefined); setIntent(undefined); setConflict(false); }
        setLoadError(error instanceof SchoolSettingsError ? error.message : "School settings could not be loaded. Reload to try again.");
        setLoading(false);
      }
    });
    return () => controller.abort();
  }, [client, refresh, schoolId, userId]);

  function reload() {
    if (request.current || intent) return;
    setLoading(true); setLoadError(""); setRefresh((value) => value + 1);
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!record?.can_edit || !editor || request.current || conflict) return;
    const details = schoolDetails(editor.details);
    const invalid = validateSchoolDetails(details);
    if (invalid || editor.reason.trim().length < 5 || editor.reason.trim().length > 300) {
      setNotice({ text: invalid ?? "Add a change reason with 5–300 characters.", error: true }); return;
    }
    const pending = intent ?? { schoolId, expectedRevision: editor.revision, requestId: crypto.randomUUID(), details, reason: editor.reason.trim() };
    setIntent(pending); setSaving(true); setNotice(undefined);
    const controller = new AbortController(); request.current = controller;
    try {
      const result = await saveSchoolSettings(client, userId, pending, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setIntent(undefined); setEditor(undefined); setConflict(false);
      setNotice({ text: result.replayed ? "The previous save is confirmed. Reloading school settings." : result.changed ? "School details saved. Reloading school settings." : "The saved school details already match. Reloading school settings." });
      setLoading(true); setRefresh((value) => value + 1);
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      const failure = error instanceof SchoolSettingsError ? error : new SchoolSettingsError("The save could not be confirmed. Retry the same save to check its outcome.");
      if (failure.code !== "unconfirmed") setIntent(undefined);
      setConflict(failure.code === "conflict");
      setNotice({ text: failure.message, error: true });
    } finally {
      if (request.current === controller) request.current = null;
      if (mounted.current && !controller.signal.aborted) setSaving(false);
    }
  }
  function edit() {
    if (!record?.can_edit || loading || loadError) return;
    setEditor({ details: schoolDetails(record.school), reason: "", revision: record.school.revision }); setNotice(undefined); setConflict(false);
  }
  function change(key: keyof SchoolDetails, value: string) {
    setEditor((current) => current ? { ...current, details: { ...current.details, [key]: key === "name" ? value : value || null } } : current);
  }

  if (!record && loading) return <LoadingState variant="form">Loading school settings…</LoadingState>;
  if (!record) return <section className="card space-y-3 p-5"><p role="alert" className="text-sm text-red-700 dark:text-red-300">{loadError}</p><button className={button} type="button" onClick={reload}>Reload school settings</button></section>;
  const values = editor?.details ?? record.school;
  const readonly = !editor || saving || Boolean(intent) || conflict;
  return <>
    {loadError && <p role="alert" className="rounded-xl border border-red-500/30 p-4 text-sm text-red-700 dark:text-red-300">{loadError} The displayed record is the last verified version.</p>}
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-5">
        <section className="card overflow-hidden" aria-labelledby="school-profile-heading" aria-busy={loading || saving}>
          <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] p-5">
            <div><h2 id="school-profile-heading" className="text-lg font-semibold">School details</h2><p className="mt-1 text-xs leading-5 muted">School code {record.school.code ?? "Not assigned"} · Revision {record.school.revision}</p></div>
            {!editor && record.can_edit && <button type="button" className={button} disabled={loading || Boolean(loadError)} onClick={edit}>Edit school details</button>}
          </header>
          <div className="space-y-4 p-5">
            <p className="flex items-start gap-2 text-xs leading-5 muted"><ShieldCheck size={17} className="mt-0.5 shrink-0" aria-hidden="true" />{record.can_edit ? "Updates are school-scoped and saved with your change reason." : "Read-only access. A School Admin manages these school details."}</p>
            <form aria-label="School details" className="space-y-4" onSubmit={save}>
              <fieldset disabled={readonly} className="grid min-w-0 gap-4 sm:grid-cols-2">
                <label className="block min-w-0 space-y-2 text-sm font-semibold sm:col-span-2"><span>School name</span><input className="field" required minLength={2} maxLength={160} value={values.name} onChange={(event) => change("name", event.target.value)} /></label>
                <label className="block min-w-0 space-y-2 text-sm font-semibold"><span>Education board</span><select className="field" value={values.board ?? ""} onChange={(event) => change("board", event.target.value)}>
                  <option value="">Not configured</option>{schoolBoards.map((board) => <option key={board} value={board}>{board === "UP_BOARD" ? "UP Board" : board}</option>)}
                </select></label>
                <label className="block min-w-0 space-y-2 text-sm font-semibold"><span>Affiliation number</span><input className="field" maxLength={100} value={values.affiliation_no ?? ""} onChange={(event) => change("affiliation_no", event.target.value)} /></label>
                <label className="block min-w-0 space-y-2 text-sm font-semibold sm:col-span-2"><span>School address</span><textarea className="field !min-h-24" rows={3} maxLength={1000} value={values.address ?? ""} onChange={(event) => change("address", event.target.value)} /></label>
                {([{ key: "city", length: 100 }, { key: "state", length: 100 }, { key: "pincode", length: 6, mode: "numeric" }, { key: "phone", length: 24, type: "tel" }, { key: "email", length: 254, type: "email" }, { key: "website", length: 300, type: "url" }] as const).map((field) => <label key={field.key} className="block min-w-0 space-y-2 text-sm font-semibold"><span>{fieldLabels[field.key]}</span>
                  <input className="field" type={"type" in field ? field.type : "text"} inputMode={"mode" in field ? field.mode : undefined} maxLength={field.length} value={values[field.key] ?? ""} placeholder={field.key === "website" ? "https://school.example" : undefined} onChange={(event) => change(field.key, event.target.value)} />
                </label>)}
              </fieldset>
              <p className="text-xs leading-5 muted">Optional contact fields may be left empty. These details do not change anyone’s sign-in email or mobile.</p>
              {editor && <>
                <label className="block space-y-2 text-sm font-semibold"><span>Change reason</span><textarea className="field !min-h-24" required minLength={5} maxLength={300} value={editor.reason} disabled={readonly} onChange={(event) => setEditor((current) => current ? { ...current, reason: event.target.value } : current)} /></label>
                <div className="flex flex-wrap gap-2">
                  <button type="submit" className={primary} disabled={saving || conflict || loading || Boolean(loadError)}><Save size={16} aria-hidden="true" />{saving ? "Saving school details…" : intent ? "Retry same save" : "Save school details"}</button>
                  {!intent && <button type="button" className={button} disabled={saving} onClick={() => { setEditor(undefined); setNotice(undefined); setConflict(false); }}>Cancel editing</button>}
                </div>
                {intent && !saving && <p className="text-xs leading-5 muted">This save has an unknown outcome. Its fields and request stay fixed until the same save is confirmed.</p>}
                {conflict && <section className="space-y-3 rounded-xl border border-amber-500/30 bg-[var(--surface-2)] p-4" aria-label="Compare school settings conflict">
                  <p className="text-sm leading-6">Your draft is kept. Reload saved settings to compare the latest version before saving again.</p>
                  <button type="button" className={button} disabled={loading} onClick={reload}>Reload saved settings for comparison</button>
                  {record.school.revision !== editor.revision && !loading && !loadError && <>
                    <dl className="space-y-3 text-xs">{(Object.keys(fieldLabels) as (keyof SchoolDetails)[]).filter((key) => values[key] !== record.school[key]).map((key) => <div key={key} className="space-y-1 break-words"><dt className="font-semibold">{fieldLabels[key]}</dt><dd><span className="muted">Latest saved:</span> {record.school[key] ?? "Empty"}</dd><dd><span className="muted">Your draft:</span> {values[key] ?? "Empty"}</dd></div>)}</dl>
                    <p className="text-xs leading-5 muted">Keeping this draft replaces the displayed school details with your draft when you save.</p>
                    <button type="button" className={button} onClick={() => { setEditor((current) => current ? { ...current, revision: record.school.revision } : current); setConflict(false); setNotice({ text: "Review your draft, then save it against the latest revision." }); }}>Keep draft against latest revision</button>
                  </>}
                </section>}
              </>}
              {notice && <p role={notice.error ? "alert" : "status"} className={`text-sm leading-6 ${notice.error ? "text-red-700 dark:text-red-300" : "text-emerald-700 dark:text-emerald-300"}`}>{notice.text}</p>}
            </form>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] pt-4"><span className="text-xs muted">Timezone: {record.school.timezone}</span>
              <button type="button" className={button} disabled={saving || Boolean(intent) || loading} onClick={reload}><RefreshCw size={15} aria-hidden="true" />{loading ? "Reloading…" : "Reload school settings"}</button></div>
          </div>
        </section>
        <section className="card p-5" aria-labelledby="school-history-heading"><div className="flex items-center gap-2"><History size={18} aria-hidden="true" /><h2 id="school-history-heading" className="font-semibold">Recent school changes</h2></div>
          <p className="mt-2 text-xs leading-5 muted">The latest ten settings changes. Private change reasons and previous contact details are not shown here.</p>
          {record.history.length ? <ol className="mt-3 divide-y divide-[var(--border)]">{record.history.map((event) => <li key={event.id} className="space-y-1 py-3 text-sm"><p className="font-semibold">Revision {event.revision} · {event.changed_fields.map((field) => fieldLabels[field as keyof SchoolDetails]).join(", ")}</p><p className="text-xs leading-5 muted">{event.actor_name ?? "School administrator"} · {new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(event.changed_at))} IST</p></li>)}</ol>
            : <p className="mt-4 text-sm muted">No school detail changes recorded yet.</p>}
        </section>
      </div>
      <SetupChecklist setup={record.setup} />
    </div>
  </>;
}

function SetupChecklist({ setup }: { setup: SchoolSettings["setup"] }) {
  const current = setup.current_year;
  const activeYear = Boolean(current && current.start_date <= setup.school_day && current.end_date >= setup.school_day);
  const amount = (value: number, one: string, many = `${one}s`) => `${value} ${value === 1 ? one : many}`;
  const steps = [
    { name: "Academic year", href: "/modules/academics", good: activeYear, detail: current ? `${current.name} · ${current.start_date} to ${current.end_date}${activeYear ? "" : " · Review dates"}` : `${amount(setup.current_year_count, "current year")} · Set exactly one current year` },
    { name: "Classes and sections", href: "/modules/academics", good: setup.active_classes > 0 && setup.sections > 0 && setup.classes_without_sections === 0, detail: `${amount(setup.active_classes, "active class", "active classes")} · ${amount(setup.sections, "section")} · ${amount(setup.classes_without_sections, "class", "classes")} ${setup.classes_without_sections === 1 ? "needs" : "need"} a section` },
    { name: "Subjects", href: "/modules/academics", good: setup.active_subjects > 0, detail: amount(setup.active_subjects, "active subject") },
    { name: "Staff sign-in links", href: "/modules/teachers", good: setup.teachers > 0 && setup.linked_teachers === setup.teachers, detail: `${amount(setup.linked_teachers, "verified sign-in link")} / ${amount(setup.teachers, "teacher directory record")}` },
    { name: "Teaching assignments", href: "/modules/teacher-assignments", good: setup.teaching_assignments > 0 && setup.sections_without_class_teacher === 0, detail: `${amount(setup.teaching_assignments, "assignment")} · ${amount(setup.sections_without_class_teacher, "section")} ${setup.sections_without_class_teacher === 1 ? "needs" : "need"} a class teacher` },
    { name: "Student enrollment", href: "/modules/students", good: setup.enrolled_students > 0 && setup.invalid_enrollments === 0, detail: `${amount(setup.enrolled_students, "current student")} · ${amount(setup.invalid_enrollments, "placement")} ${setup.invalid_enrollments === 1 ? "needs" : "need"} review` },
    { name: "Guardian access", href: "/modules/guardian-invitations", good: setup.enrolled_students > 0 && setup.linked_students === setup.enrolled_students, detail: `${amount(setup.linked_students, "student")} with a verified guardian link · ${amount(setup.pending_guardian_invitations, "pending invitation")}` },
    { name: "Attendance walkthrough", href: "/modules/attendance", good: setup.today_attendance > 0, detail: `${amount(setup.today_attendance, "saved attendance record")} for ${setup.school_day}. This count does not confirm all registers are complete.` },
  ];
  return <section className="card min-w-0 overflow-hidden" aria-labelledby="school-setup-heading"><header className="border-b border-[var(--border)] p-5"><h2 id="school-setup-heading" className="text-lg font-semibold">Connected school setup</h2><p className="mt-2 text-sm leading-6 muted">Live records guide the next step. Each link opens the existing school workflow.</p></header>
    <ol className="divide-y divide-[var(--border)] px-5">{steps.map((step) => <li key={step.name} className="flex items-start gap-3 py-4">
      {step.good ? <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden="true" /> : <CircleAlert size={20} className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" />}
      <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{step.name}</h3><span className="text-[11px] font-semibold muted">{step.good ? "Records available" : "Needs review"}</span></div><p className="mt-1 text-xs leading-5 muted">{step.detail}</p><Link href={step.href} className="mt-1 inline-flex min-h-10 items-center gap-1 text-xs font-semibold text-[var(--primary)]">Open {step.name.toLowerCase()}<ArrowUpRight size={13} aria-hidden="true" /></Link></div>
    </li>)}</ol>
    <footer className="space-y-2 border-t border-[var(--border)] bg-[var(--surface-2)] p-5 text-xs leading-5 muted"><p>These are setup signals for an existing school. They do not certify full onboarding, attendance policy or commercial readiness.</p><p>A new school and its first administrator must be provisioned by the platform operator.</p></footer>
  </section>;
}
