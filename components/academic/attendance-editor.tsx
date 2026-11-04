"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { createAttendanceRepository } from "@/lib/attendance/repository";
import {
  attendanceContextKey,
  attendanceLabels,
  attendanceStatuses,
  schoolDate,
  studentName,
  type AttendanceContext,
  type AttendanceEntry,
  type AttendanceRepository,
  type AttendanceSnapshot,
  type AttendanceStatus,
} from "@/lib/attendance/types";

type Props = {
  context: AttendanceContext | null;
  userId: string;
  repository?: AttendanceRepository;
  rosterVersion?: number;
  onLockChange?: (locked: boolean) => void;
  onSaved?: () => void;
  studentSearch?: boolean;
};

type LoadState = {
  key: string;
  snapshot: AttendanceSnapshot | null;
  error: string | null;
};

/** One editor is used by the dashboard and the dedicated teacher register. */
export function AttendanceEditor(props: Props) {
  if (!props.context) {
    return (
      <p className="text-sm muted" role="status">
        An assigned class and section are required to record attendance.
      </p>
    );
  }
  return (
    <ScopedAttendanceEditor
      key={attendanceContextKey(props.context)}
      {...props}
      context={props.context}
    />
  );
}

function ScopedAttendanceEditor({
  context,
  userId,
  repository: suppliedRepository,
  rosterVersion = 0,
  onLockChange,
  onSaved,
  studentSearch = false,
}: Props & { context: AttendanceContext }) {
  const [defaultRepository] = useState(() =>
    suppliedRepository ?? createAttendanceRepository(createClient()),
  );
  const repository = suppliedRepository ?? defaultRepository;
  const [date, setDate] = useState(schoolDate);
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<LoadState | null>(null);
  const [draft, setDraft] = useState<Record<string, AttendanceStatus>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const savingRef = useRef(false);
  const aliveRef = useRef(true);
  const loadGenerationRef = useRef(0);
  const { schoolId, academicYearId, classId, sectionId } = context;
  const contextKey = attendanceContextKey(context);
  const requestKey = JSON.stringify([contextKey, date, revision, rosterVersion]);
  const snapshot = loaded?.key === requestKey ? loaded.snapshot : null;
  const ready = snapshot !== null;
  const students = snapshot?.students ?? [];
  const dirtyIds = Object.keys(draft).filter(
    (id) => draft[id] !== snapshot?.entries[id]?.status,
  );
  const dirty = dirtyIds.length > 0;
  const loadError = loaded?.key === requestKey ? loaded.error : null;
  const locked = saving || dirty || (!ready && !loadError);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  useEffect(() => {
    onLockChange?.(locked);
    return () => { onLockChange?.(false); };
  }, [locked, onLockChange]);

  useEffect(() => {
    let active = true;
    loadGenerationRef.current += 1;
    repository.load({ schoolId, academicYearId, classId, sectionId }, date).then(
      (result) => {
        if (active) setLoaded({ key: requestKey, snapshot: result, error: null });
      },
      (error: unknown) => {
        if (active) setLoaded({
          key: requestKey,
          snapshot: null,
          error: error instanceof Error ? error.message : "Attendance could not be loaded.",
        });
      },
    );
    return () => { active = false; };
  }, [schoolId, academicYearId, classId, sectionId, date, repository, requestKey]);

  useEffect(() => {
    if (!dirty) return;
    function warnBeforeLeaving(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [dirty]);

  function selectDate(value: string) {
    if (!value || savingRef.current || dirty) return;
    setDraft({});
    setMessage("");
    setDate(value);
  }

  function mark(studentId: string, status: AttendanceStatus) {
    if (!ready || savingRef.current) return;
    setMessage("");
    setDraft((previous) => {
      const next = { ...previous };
      if (snapshot?.entries[studentId]?.status === status) delete next[studentId];
      else next[studentId] = status;
      return next;
    });
  }

  function markUnmarkedPresent() {
    if (!snapshot || savingRef.current) return;
    const next = { ...draft };
    for (const student of students) {
      if (!next[student.id] && !snapshot.entries[student.id]) next[student.id] = "present";
    }
    setDraft(next);
    setMessage("");
  }

  function markHoliday() {
    if (!snapshot || savingRef.current) return;
    const next: Record<string, AttendanceStatus> = {};
    for (const student of students) {
      if (snapshot.entries[student.id]?.status !== "holiday") next[student.id] = "holiday";
    }
    setDraft(next);
    setMessage("Holiday selected for this register. Review and save to apply it.");
  }

  async function save() {
    if (!snapshot || !dirty || savingRef.current) return;
    savingRef.current = true;
    const loadGeneration = loadGenerationRef.current;
    setSaving(true);
    setMessage("");
    const changes = dirtyIds.map((studentId) => ({
      studentId,
      status: draft[studentId],
      expected: snapshot.entries[studentId] ?? null,
    }));
    try {
      const result = await repository.save(context, date, userId, changes);
      if (!aliveRef.current) return;
      if (loadGeneration !== loadGenerationRef.current) {
        if (result.saved.length) onSaved?.();
        setRevision((value) => value + 1);
        setMessage("The register changed while saving. Reloading the current records; review any remaining edits.");
        return;
      }
      const savedEntries: Record<string, AttendanceEntry> = { ...snapshot.entries };
      const remainingDraft = { ...draft };
      for (const entry of result.saved) {
        savedEntries[entry.student_id] = entry;
        delete remainingDraft[entry.student_id];
      }
      setLoaded({ key: requestKey, snapshot: { ...snapshot, entries: savedEntries }, error: null });
      setDraft(remainingDraft);
      if (result.failures.length) {
        const firstFailure = result.failures[0];
        const student = students.find((item) => item.id === firstFailure.studentId);
        setMessage(`${result.saved.length} saved; ${result.failures.length} could not be saved. ${student ? studentName(student) + ": " : ""}${firstFailure.message} Your remaining edits are kept. Reload to check the current register.`);
      } else {
        setMessage(`Attendance saved for ${result.saved.length} student${result.saved.length === 1 ? "" : "s"}.`);
      }
      if (result.saved.length) onSaved?.();
    } catch (error: unknown) {
      if (aliveRef.current) setMessage(`${error instanceof Error ? error.message : "Attendance could not be saved."} Your edits are kept. Reload before retrying if the connection was interrupted.`);
    } finally {
      savingRef.current = false;
      if (aliveRef.current) setSaving(false);
    }
  }

  function reload() {
    if (savingRef.current) return;
    setDraft({});
    setMessage("");
    setRevision((value) => value + 1);
  }

  const marked = students.filter((student) => draft[student.id] || snapshot?.entries[student.id]).length;
  const searchTerm = search.trim().toLocaleLowerCase();
  const visibleStudents = studentSearch && searchTerm ? students.filter((student) =>
    [studentName(student), student.admission_no, student.roll_no].some((value) =>
      value?.toLocaleLowerCase().includes(searchTerm)),
  ) : students;

  return (
    <section className="space-y-3" aria-label="Attendance editor" aria-busy={!ready && !loadError || saving}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="text-sm font-semibold">Attendance date
          <input aria-label="Attendance date" type="date" value={date} disabled={saving || dirty} onChange={(event) => selectDate(event.target.value)} className="field mt-2 w-auto" />
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={markUnmarkedPresent} disabled={!ready || saving || !students.length} className="rounded-xl border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50">Mark unmarked present</button>
          <button type="button" onClick={markHoliday} disabled={!ready || saving || !students.length} className="rounded-xl border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50">Mark holiday</button>
          <button type="button" onClick={reload} disabled={saving} className="rounded-xl border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50">{dirty ? "Discard changes and reload" : "Reload register"}</button>
        </div>
      </div>
      {loadError ? <p role="alert" className="text-sm text-red-600">{loadError} Saving is disabled until the register loads successfully.</p> : !ready ? <p role="status" className="text-sm muted">Loading attendance register…</p> : (
        <>
          <p className="text-xs muted">{students.length} students · {marked} marked · {students.length - marked} unmarked. Only changed records are saved.</p>
          {studentSearch && students.length > 0 && (
            <label className="block max-w-sm space-y-2 text-sm font-semibold">
              <span>Find student</span>
              <input type="search" className="field" value={search} onChange={(event) => setSearch(event.target.value)}
                placeholder="Name, admission number or roll number" />
            </label>
          )}
          <div className="max-h-96 overflow-auto rounded-xl border border-[var(--border)]">
            {visibleStudents.length ? visibleStudents.map((student) => (
              <div key={student.id} className="flex items-center gap-3 border-b border-[var(--border)] p-3 last:border-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{studentName(student)}</p>
                  <p className="text-xs muted">{student.admission_no} · Roll {student.roll_no || "—"}</p>
                </div>
                <select aria-label={`Attendance for ${studentName(student)}`} value={draft[student.id] ?? snapshot?.entries[student.id]?.status ?? ""} disabled={saving} onChange={(event) => mark(student.id, event.target.value as AttendanceStatus)} className="field w-auto min-w-32">
                  <option value="" disabled>Unmarked</option>
                  {attendanceStatuses.map((status) => <option key={status} value={status}>{attendanceLabels[status]}</option>)}
                </select>
              </div>
            )) : <p className="p-5 text-sm muted">{students.length ? "No students match your search." : "No active students found for this class and section."}</p>}
          </div>
        </>
      )}
      {dirty && <p className="text-xs muted">{dirtyIds.length} unsaved change{dirtyIds.length === 1 ? "" : "s"}. Save or discard before changing the date or class.</p>}
      <button type="button" disabled={!ready || saving || !dirty || !students.length} onClick={save} className="rounded-xl gradient px-4 py-2.5 text-sm font-bold disabled:opacity-50">{saving ? "Saving attendance…" : "Save Attendance"}</button>
      {message && <p role="status" className="text-sm" aria-live="polite">{message}</p>}
    </section>
  );
}
