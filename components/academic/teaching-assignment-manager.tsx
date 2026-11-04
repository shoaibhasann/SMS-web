"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  createTeachingAssignmentRepository, type AssignmentAccess, type AssignmentData,
  type TeachingAssignmentDraft, type TeachingAssignmentRepository, type TeachingAssignmentRow,
} from "@/lib/assignments/repository";

const emptyDraft: TeachingAssignmentDraft = { teacher_id: "", class_id: "", section_id: "", subject_id: "", is_class_teacher: false };
const panel = "rounded-2xl border border-slate-800 bg-[#0f172a] p-6 text-slate-200";
const field = "mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-white disabled:opacity-50";
const action = "min-h-11 rounded-xl border border-slate-700 px-4 py-2 text-sm font-semibold disabled:opacity-50";
const errorText = (error: unknown) => error instanceof Error ? error.message : "Teaching assignments could not be loaded. Please refresh.";

export function TeachingAssignmentManager({ repository: suppliedRepository }: { repository?: TeachingAssignmentRepository }) {
  const [repository] = useState(() => suppliedRepository ?? createTeachingAssignmentRepository(createClient()));
  const [accessVersion, setAccessVersion] = useState(0);
  const [accessState, setAccessState] = useState<{ version: number; value?: AssignmentAccess; error?: string } | null>(null);
  const [schoolId, setSchoolId] = useState("");
  const [dataVersion, setDataVersion] = useState(0);
  const [view, setView] = useState<{ key: string; data?: AssignmentData; error?: string } | null>(null);
  const [draft, setDraft] = useState<TeachingAssignmentDraft>(emptyDraft);
  const [editing, setEditing] = useState<TeachingAssignmentRow | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<TeachingAssignmentRow | null>(null);
  const [search, setSearch] = useState("");
  const [teacherFilter, setTeacherFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const messageElement = useRef<HTMLDivElement>(null);
  const access = accessState?.version === accessVersion ? accessState.value : undefined;
  const school = access?.schools.find((item) => item.id === schoolId);
  const key = `${accessVersion}:${schoolId}:${dataVersion}`;
  const currentView = view?.key === key ? view : null;
  const data = currentView?.data;
  const dirty = editing !== null || Object.values(draft).some(Boolean);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    let active = true;
    repository.access().then((value) => {
      if (!active) return;
      setAccessState({ version: accessVersion, value });
      setSchoolId((previous) => value.schools.some((item) => item.id === previous)
        ? previous : value.schools.length === 1 ? value.schools[0].id : "");
    }, (error: unknown) => {
      if (active) setAccessState({ version: accessVersion, error: errorText(error) });
    });
    return () => { active = false; };
  }, [repository, accessVersion]);
  useEffect(() => {
    if (!school) return;
    let active = true;
    repository.load(school).then((value) => {
      if (active) setView({ key, data: value });
    }, (error: unknown) => {
      if (active) setView({ key, error: errorText(error) });
    });
    return () => { active = false; };
  }, [repository, school, key]);
  useEffect(() => { if (message?.error) messageElement.current?.focus(); }, [message]);

  const names = useMemo(() => ({
    teachers: new Map(data?.teachers.map((item) => [item.id, item.name])),
    classes: new Map(data?.classes.map((item) => [item.id, item.name])),
    sections: new Map(data?.sections.map((item) => [item.id, item.name])),
    subjects: new Map(data?.subjects.map((item) => [item.id, item.name])),
  }), [data]);
  const rows = useMemo(() => (data?.rows ?? []).filter((row) =>
    (!teacherFilter || teacherFilter === row.teacher_id) && [names.teachers.get(row.teacher_id), names.classes.get(row.class_id),
      row.section_id ? names.sections.get(row.section_id) : "All sections", names.subjects.get(row.subject_id),
      row.is_class_teacher ? "class teacher" : "subject teacher"].join(" ").toLowerCase().includes(search.toLowerCase())),
  [data, teacherFilter, names, search]);

  function cancel() { setDraft(emptyDraft); setEditing(null); setPendingRemoval(null); setMessage(null); }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !school?.canManage || !data) return;
    if (!data.teachers.some((item) => item.id === draft.teacher_id) || !data.classes.some((item) => item.id === draft.class_id) ||
      !data.sections.some((item) => item.id === draft.section_id && item.class_id === draft.class_id) ||
      !data.subjects.some((item) => item.id === draft.subject_id)) {
      setMessage({ error: true, text: "Select a teacher, class, section and subject from this school's records." }); return;
    }
    inFlight.current = true; setBusy(true); setMessage(null);
    try {
      await repository.save(school.id, data.year.id, draft, editing);
      if (!alive.current) return;
      setDraft(emptyDraft); setEditing(null);
      setMessage({ error: false, text: editing ? "Teaching assignment updated." : "Teaching assignment added." });
      setDataVersion((value) => value + 1);
    } catch (error: unknown) {
      if (alive.current) setMessage({ error: true, text: errorText(error) });
    } finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  async function remove() {
    if (inFlight.current || !school?.canManage || !pendingRemoval) return;
    inFlight.current = true; setBusy(true); setMessage(null);
    try {
      await repository.remove(school.id, pendingRemoval);
      if (!alive.current) return;
      setPendingRemoval(null); setEditing(null); setDraft(emptyDraft);
      setMessage({ error: false, text: "Teaching assignment removed." }); setDataVersion((value) => value + 1);
    } catch (error: unknown) {
      if (alive.current) setMessage({ error: true, text: errorText(error) });
    } finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }

  const accessError = accessState?.version === accessVersion ? accessState.error : null;
  if (!access) return <section className={panel}>
    {accessError ? <><p role="alert">{accessError}</p><button type="button" onClick={() => setAccessVersion((value) => value + 1)} className={`${action} mt-4`}>Retry access check</button></>
      : <p role="status">Checking teaching assignment access…</p>}
  </section>;

  return <div className="space-y-6">
    <section className={panel}>
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div><h1 className="text-2xl font-bold text-white">{school && !school.canManage ? "My Teaching Assignments" : "Teaching Assignments"}</h1>
          <p className="mt-2 text-sm text-slate-400">{school?.canManage ? "Administrators and principals assign teachers to classes and subjects." : "Your school administrator or principal manages these assignments."}</p>
          {data && <p className="mt-2 text-sm text-blue-300">Academic year: {data.year.name}</p>}</div>
        <button type="button" className={action} disabled={busy || dirty || pendingRemoval !== null} onClick={() => {
          setMessage(null); setAccessVersion((value) => value + 1); setDataVersion((value) => value + 1);
        }}>Refresh assignments</button>
      </div>
      <label className="mt-5 block text-sm font-semibold">School<select className={field} value={schoolId} disabled={busy || dirty || pendingRemoval !== null} onChange={(event) => {
        setSchoolId(event.target.value); setSearch(""); setTeacherFilter(""); cancel();
      }}><option value="">Select school</option>{access.schools.map((item) => <option key={item.id} value={item.id}>{item.name}{item.canManage ? "" : " — my assignments"}</option>)}</select></label>
      {dirty && <p className="mt-2 text-xs text-slate-400">Save or cancel this assignment before changing school or refreshing.</p>}
    </section>
    {message && <div ref={messageElement} tabIndex={-1} role={message.error ? "alert" : "status"}
      className={`rounded-xl border p-4 text-sm ${message.error ? "border-red-500/40 text-red-500" : "border-emerald-500/30 text-emerald-600"}`}>{message.text}</div>}
    {!school ? <p className="text-sm muted">Select an authorized school to continue.</p>
      : currentView?.error ? <section className={panel}><p role="alert">{currentView.error}</p></section>
      : !data ? <section className={panel}><p role="status">Loading teaching assignments…</p></section>
      : <>
        {school.canManage && <section className={panel}>
          <h2 className="text-lg font-semibold text-white">{editing ? "Edit Assignment" : "Add Teaching Assignment"}</h2>
          {(!data.teachers.length || !data.classes.length || !data.sections.length || !data.subjects.length)
            ? <p role="status" className="mt-3 text-sm text-slate-400">School setup is incomplete. Add teachers, classes, sections and subjects before creating an assignment.</p>
            : <form aria-label="Teaching assignment" onSubmit={(event) => void save(event)} className="mt-5 space-y-5">
              <fieldset disabled={busy || pendingRemoval !== null} className="space-y-5">
                <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
                  <label className="text-sm font-semibold">Teacher<select required className={field} value={draft.teacher_id} onChange={(event) => setDraft((value) => ({ ...value, teacher_id: event.target.value }))}>
                    <option value="">Select teacher</option>{data.teachers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                  <label className="text-sm font-semibold">Class<select required className={field} value={draft.class_id} onChange={(event) => setDraft((value) => ({ ...value, class_id: event.target.value, section_id: "" }))}>
                    <option value="">Select class</option>{data.classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                  <label className="text-sm font-semibold">Section<select required className={field} value={draft.section_id} disabled={!draft.class_id} onChange={(event) => setDraft((value) => ({ ...value, section_id: event.target.value }))}>
                    <option value="">Select section</option>{data.sections.filter((item) => item.class_id === draft.class_id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                  <label className="text-sm font-semibold">Subject<select required className={field} value={draft.subject_id} onChange={(event) => setDraft((value) => ({ ...value, subject_id: event.target.value }))}>
                    <option value="">Select subject</option>{data.subjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                </div>
                <label className="flex min-h-11 items-center gap-3 rounded-xl border border-slate-700 p-4 text-sm"><input type="checkbox" checked={draft.is_class_teacher} onChange={(event) => setDraft((value) => ({ ...value, is_class_teacher: event.target.checked }))} />Mark as class teacher</label>
                <p className="text-xs text-slate-400">Review existing class-teacher duties before assigning a new duty.</p>
                <div className="flex flex-wrap justify-end gap-3">{dirty && <button type="button" onClick={cancel} className={action}>Cancel assignment</button>}
                  <button className={`${action} bg-blue-600 text-white`} type="submit">{busy ? "Saving…" : editing ? "Update Assignment" : "Add Assignment"}</button></div>
              </fieldset>
            </form>}
        </section>}
        <section className={panel}>
          <h2 className="text-lg font-semibold text-white">{school.canManage ? "All Teaching Assignments" : "My Teaching Assignments"}</h2>
          <div className="mt-4 flex flex-wrap gap-4">
            <label className="flex-1 text-sm">Search assignments<input type="search" className={field} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Teacher, class or subject" /></label>
            {school.canManage && <label className="text-sm">Teacher filter<select className={field} value={teacherFilter} onChange={(event) => setTeacherFilter(event.target.value)}><option value="">All teachers</option>{data.teachers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
          </div>
          <p className="mt-3 text-xs text-slate-400">Showing {rows.length} of {data.rows.length} assignments.</p>
          {pendingRemoval && <div role="group" aria-label="Confirm assignment removal" className="mt-4 rounded-xl border border-red-500/40 p-4">
            <p className="text-sm">Remove this assignment? The teacher will lose the access provided by this assignment.</p>
            <div className="mt-3 flex gap-3"><button type="button" disabled={busy} onClick={() => void remove()} className={`${action} text-red-400`}>Confirm remove</button><button type="button" disabled={busy} onClick={() => setPendingRemoval(null)} className={action}>Keep assignment</button></div>
          </div>}
          {!rows.length ? <p className="py-6 text-sm text-slate-400">{data.rows.length ? "No assignments match these filters." : school.canManage ? "No teaching assignments found for this academic year." : "No teaching assignments found. Contact your school administrator or principal."}</p>
            : <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[680px] text-left text-sm">
              <thead><tr className="border-b border-slate-700">{["Teacher", "Class", "Section", "Subject", "Role", ...(school.canManage ? ["Actions"] : [])].map((title) => <th key={title} scope="col" className="p-3 text-xs uppercase text-blue-300">{title}</th>)}</tr></thead>
              <tbody>{rows.map((row) => <tr key={row.id} className="border-b border-slate-800">
                <td className="p-3">{names.teachers.get(row.teacher_id)}</td><td className="p-3">{names.classes.get(row.class_id)}</td><td className="p-3">{row.section_id ? names.sections.get(row.section_id) : "All sections"}</td><td className="p-3">{names.subjects.get(row.subject_id)}</td><td className="p-3">{row.is_class_teacher ? "Class teacher" : "Subject teacher"}</td>
                {school.canManage && <td className="p-3"><div className="flex gap-2">
                  <button type="button" className={action} disabled={busy || pendingRemoval !== null || dirty} onClick={() => { setEditing(row); setDraft({ teacher_id: row.teacher_id, class_id: row.class_id, section_id: row.section_id ?? "", subject_id: row.subject_id, is_class_teacher: row.is_class_teacher }); setMessage(null); }}>Edit</button>
                  <button type="button" className={`${action} text-red-400`} disabled={busy || pendingRemoval !== null || dirty} onClick={() => setPendingRemoval(row)}>Remove</button>
                </div></td>}
              </tr>)}</tbody>
            </table></div>}
        </section>
      </>}
  </div>;
}
