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
import { LoadingState } from "@/components/ui/skeleton";

type Props = {
  context: AttendanceContext | null;
  userId: string;
  repository?: AttendanceRepository;
  rosterVersion?: number;
  onLockChange?: (locked: boolean) => void;
  onSaved?: () => void;
  onCorrectionRequested?: () => void;
  studentSearch?: boolean;
  reviewOnlyHistory?: boolean;
  dateLimits?: { start: string; end: string };
  readOnly?: boolean;
};

type LoadState = {
  key: string;
  snapshot: AttendanceSnapshot | null;
  error: string | null;
};

// Selected-status colours; each choice also carries its word, so colour never says it alone.
const statusTone: Record<AttendanceStatus, string> = {
  present: "border-emerald-700 bg-emerald-700 text-white",
  absent: "border-red-700 bg-red-700 text-white",
  late: "border-amber-400 bg-amber-400 text-slate-950",
  half_day: "border-violet-700 bg-violet-700 text-white",
  leave: "border-sky-700 bg-sky-700 text-white",
  holiday: "border-slate-600 bg-slate-600 text-white",
};

// 22023 on a Holiday write is the DB guard refusing pupil Holiday marks on a configured working day.
function holidayRefused(code: string | undefined, statuses: (AttendanceStatus | undefined)[]) {
  return code === "22023" && statuses.includes("holiday")
    ? "Holiday can only be marked on a school holiday. Reload the register." : null;
}

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
  onCorrectionRequested,
  studentSearch = false,
  reviewOnlyHistory = false,
  dateLimits,
  readOnly = false,
}: Props & { context: AttendanceContext }) {
  const [defaultRepository] = useState(() =>
    suppliedRepository ?? createAttendanceRepository(createClient(), userId),
  );
  const repository = suppliedRepository ?? defaultRepository;
  const today = schoolDate();
  const maxDate = dateLimits && dateLimits.end < today ? dateLimits.end : today;
  const [date, setDate] = useState(maxDate);
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<LoadState | null>(null);
  const [draft, setDraft] = useState<Record<string, AttendanceStatus>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean; pending?: boolean } | null>(null);
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionConflict, setCorrectionConflict] = useState(false);
  const [search, setSearch] = useState("");
  const savingRef = useRef(false);
  const correctionRequest = useRef<{ key: string; id: string } | null>(null);
  const aliveRef = useRef(true);
  const loadGenerationRef = useRef(0);
  const { schoolId, academicYearId, classId, sectionId } = context;
  const contextKey = attendanceContextKey(context);
  const requestKey = JSON.stringify([contextKey, date, revision, rosterVersion]);
  const snapshot = loaded?.key === requestKey ? loaded.snapshot : null;
  const ready = snapshot !== null;
  const schoolToday = snapshot?.day?.server_today ?? today;
  const historical = date < schoolToday;
  const closedDay = snapshot?.day?.is_working === false;
  const canMarkHoliday = snapshot?.day?.can_mark_holiday === true;
  // A configured working day stays in the denominator; closures belong in the school calendar, not pupil Holiday marks.
  const canChooseHoliday = canMarkHoliday && snapshot?.day?.configured !== true;
  const requestHistorical = !readOnly && historical && !reviewOnlyHistory && !closedDay
    && snapshot?.day?.can_request_correction !== false && Boolean(repository.requestCorrection);
  const canEdit = !readOnly && !closedDay && (date === schoolToday || requestHistorical);
  const students = snapshot?.students ?? [];
  const searchTerm = search.trim().toLocaleLowerCase();
  const filtering = studentSearch && Boolean(searchTerm);
  const visibleStudents = filtering ? students.filter((student) =>
    [studentName(student), student.admission_no, student.roll_no].some((value) =>
      value?.toLocaleLowerCase().includes(searchTerm)),
  ) : students;
  const dirtyIds = Object.keys(draft).filter(
    (id) => draft[id] !== snapshot?.entries[id]?.status,
  );
  const dirty = dirtyIds.length > 0;
  const hasVisibleUnmarked = visibleStudents.some((student) => !draft[student.id] && !snapshot?.entries[student.id]);
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
    if (!value || value > maxDate || (dateLimits && value < dateLimits.start) || savingRef.current || dirty) return;
    setDraft({});
    setCorrectionReason("");
    setCorrectionConflict(false);
    correctionRequest.current = null;
    setMessage(null);
    setDate(value);
  }

  function mark(studentId: string, status: AttendanceStatus) {
    if (!ready || !canEdit || savingRef.current || (historical && dirty && !dirtyIds.includes(studentId))) return;
    if (status === "holiday" && !canChooseHoliday) return;
    if (!canMarkHoliday && snapshot?.entries[studentId]?.status === "holiday") return;
    setMessage(null);
    setDraft((previous) => {
      const next = { ...previous };
      if (snapshot?.entries[studentId]?.status === status) delete next[studentId];
      else next[studentId] = status;
      return next;
    });
  }

  function markUnmarkedPresent() {
    if (!snapshot || !canEdit || historical || savingRef.current) return;
    const next = { ...draft };
    for (const student of visibleStudents) {
      if (!next[student.id] && !snapshot.entries[student.id]) next[student.id] = "present";
    }
    setDraft(next);
    setMessage(null);
  }

  function markHoliday() {
    if (!snapshot || !canEdit || !canChooseHoliday || filtering || historical || savingRef.current) return;
    const next: Record<string, AttendanceStatus> = {};
    for (const student of students) {
      if (snapshot.entries[student.id]?.status !== "holiday") next[student.id] = "holiday";
    }
    setDraft(next);
    setMessage({ text: "Holiday selected for this register. Review and save to apply it.", pending: true });
  }

  async function save() {
    if (!snapshot || !dirty || !canEdit || savingRef.current) return;
    if (historical && (correctionConflict || dirtyIds.length !== 1 || !correctionReason.trim() || !repository.requestCorrection)) return;
    savingRef.current = true;
    const loadGeneration = loadGenerationRef.current;
    setSaving(true);
    setMessage(null);
    const changes = dirtyIds.map((studentId) => ({
      studentId,
      status: draft[studentId],
      expected: snapshot.entries[studentId] ?? null,
    }));
    try {
      if (historical && repository.requestCorrection) {
        const reason = correctionReason.trim();
        const key = JSON.stringify([date, changes[0], reason]);
        if (correctionRequest.current?.key !== key) correctionRequest.current = { key, id: crypto.randomUUID() };
        await repository.requestCorrection(context, date, changes[0], reason, correctionRequest.current.id);
        if (!aliveRef.current) return;
        correctionRequest.current = null;
        setDraft({});
        setCorrectionReason("");
        setMessage({ text: "Correction requested. The saved attendance stays in place until a reviewer approves it." });
        onCorrectionRequested?.();
        return;
      }
      const result = await repository.save(context, date, userId, changes);
      if (!aliveRef.current) return;
      if (loadGeneration !== loadGenerationRef.current) {
        if (result.saved.length) onSaved?.();
        setRevision((value) => value + 1);
        setMessage({ text: "The register changed while saving. Reloading the current records; review any remaining edits.", error: true });
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
        const failure = holidayRefused(firstFailure.code, [draft[firstFailure.studentId]]) ?? firstFailure.message;
        setMessage({ text: `${result.saved.length} saved; ${result.failures.length} could not be saved. ${student ? studentName(student) + ": " : ""}${failure} Your remaining edits are kept. Reload to check the current register.`, error: true });
      } else {
        setMessage({ text: `Attendance saved for ${result.saved.length} student${result.saved.length === 1 ? "" : "s"}.` });
      }
      if (result.saved.length) onSaved?.();
    } catch (error: unknown) {
      if (aliveRef.current && historical && ["PT409", "40001"].includes((error as { code?: string })?.code ?? "")) setCorrectionConflict(true);
      // Correction-request 22023s mean other refusals (reason, same status, day), not the Holiday guard.
      if (aliveRef.current) setMessage({ text: `${(!historical ? holidayRefused((error as { code?: string })?.code, changes.map((change) => change.status)) : null)
        ?? (error instanceof Error ? error.message : "Attendance could not be saved.")} Your edits are kept. Reload before retrying if the connection was interrupted.`, error: true });
    } finally {
      savingRef.current = false;
      if (aliveRef.current) setSaving(false);
    }
  }

  function reload() {
    if (savingRef.current) return;
    setDraft({});
    setCorrectionReason("");
    setCorrectionConflict(false);
    correctionRequest.current = null;
    setMessage(null);
    setRevision((value) => value + 1);
  }

  const marked = students.filter((student) => draft[student.id] || snapshot?.entries[student.id]).length;

  return (
    <section className="space-y-3" aria-label="Attendance editor" aria-busy={!ready && !loadError || saving}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="text-sm font-semibold">Attendance date
          <input aria-label="Attendance date" type="date" min={dateLimits?.start} max={maxDate} value={date} disabled={saving || dirty} onChange={(event) => selectDate(event.target.value)} className="field mt-2 w-auto" />
        </label>
        <div className="flex flex-wrap gap-2">
          {canEdit && !historical && <>
            <button type="button" onClick={markUnmarkedPresent} disabled={!ready || saving || !hasVisibleUnmarked} className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50">Mark unmarked present</button>
            {canChooseHoliday && <button type="button" onClick={markHoliday} disabled={!ready || saving || !students.length || filtering} className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50">Mark holiday</button>}
          </>}
          <button type="button" onClick={reload} disabled={saving} className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50">{dirty ? "Discard changes and reload" : "Reload register"}</button>
        </div>
      </div>
      {canEdit && !historical && canChooseHoliday && filtering && <p className="text-xs muted">Clear the search to mark the whole register as a holiday.</p>}
      {loadError ? <div className="space-y-2">
        <p role="alert" className="notice notice-error">{loadError} Saving is disabled until the register loads successfully.</p>
        <button type="button" onClick={reload} disabled={saving} className="btn btn-secondary">Retry loading register</button>
      </div> : !ready ? <LoadingState variant="table" className="text-sm muted">Loading attendance register…</LoadingState> : (
        <>
          {snapshot.day && <p role="status" className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-sm leading-6">
            {!snapshot.day.configured ? "School calendar is not configured for this date. Existing daily attendance rules remain in effect."
              : closedDay ? `${snapshot.day.label ?? "School closed"}. No daily register is required; existing history stays available. Gate scans are held for review.`
                : `${snapshot.day.label ?? "School working day"}. The saved school calendar applies to this register and gate attendance.${canMarkHoliday && !historical && !readOnly
                  ? " To close the whole school, add a holiday exception in Settings > Calendar & daily attendance rules (future dates, or today before any attendance or gate scan is recorded); pupil Holiday marks on a working day are not accepted." : ""}`}
            {historical && snapshot.day.can_request_correction === false && !reviewOnlyHistory && !readOnly
              ? " Teacher correction requests are unavailable under the current school policy or assignment. Contact the school office." : ""}
          </p>}
          <p className="text-xs muted">{students.length} students · {marked} marked · {students.length - marked} unmarked. {readOnly ? "This academic year is read-only." : historical
            ? requestHistorical ? "For past dates, request one pupil’s correction at a time." : "Past attendance changes through the correction review."
            : "Only changed records are saved."}</p>
          {studentSearch && students.length > 0 && (
            <label className="block max-w-sm space-y-2 text-sm font-semibold">
              <span>Find student</span>
              <input type="search" className="field" value={search} onChange={(event) => setSearch(event.target.value)}
                placeholder="Name, admission number or roll number" />
            </label>
          )}
          <div className="rounded-xl border border-[var(--border)] sm:max-h-96 sm:overflow-auto">
            {visibleStudents.length ? visibleStudents.map((student) => {
              const name = studentName(student);
              const current = draft[student.id] ?? snapshot?.entries[student.id]?.status;
              const rowDisabled = saving || !canEdit || (!canMarkHoliday && snapshot?.entries[student.id]?.status === "holiday")
                || (historical && dirty && !dirtyIds.includes(student.id));
              return (
                <div key={student.id} className="flex flex-col gap-3 border-b border-[var(--border)] p-3 last:border-0 md:flex-row md:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{name}</p>
                    <p className="text-xs muted">{student.admission_no} · Roll {student.roll_no || "—"}{current ? "" : " · Unmarked"}</p>
                  </div>
                  {/* Pills are relative so their sr-only radios stay inside the scrolling list instead of stretching the page. */}
                  {/* Phones: equal pills in a grid whose cells are never narrower than "Present"/"Holiday" (44px at 11px + padding), so a label wraps between words or moves to the next row instead of splitting mid-word. */}
                  <div role="radiogroup" aria-label={`Attendance for ${name}`} className="grid grid-cols-[repeat(auto-fit,minmax(3.125rem,1fr))] gap-1 md:flex md:flex-wrap md:gap-1.5">
                    {attendanceStatuses.filter((status) => status !== "holiday" || canChooseHoliday || current === "holiday").map((status) => (
                      <label key={status} className={`relative inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg border px-0.5 text-center text-[11px] font-semibold break-normal md:flex-none md:px-3 md:text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-blue-600 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 ${current === status
                        ? statusTone[status] : "border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)]"}`}>
                        <input type="radio" name={`attendance-${student.id}`} value={status} checked={current === status}
                          disabled={rowDisabled || (status === "holiday" && !canChooseHoliday)} onChange={() => mark(student.id, status)} className="sr-only" />
                        {attendanceLabels[status]}
                      </label>
                    ))}
                  </div>
                </div>
              );
            }) : <p className="p-5 text-sm muted">{students.length ? "No students match your search." : "No students found for this class and section on the selected date."}</p>}
          </div>
        </>
      )}
      {requestHistorical && dirty && <label className="block max-w-lg space-y-1.5 text-sm font-semibold">
        <span>Correction reason</span>
        <textarea className="field" rows={2} value={correctionReason} maxLength={500} required disabled={saving} onChange={(event) => setCorrectionReason(event.target.value)} />
      </label>}
      {/* Below lg the app shell's fixed mobile nav (z-30) owns the bottom ~5rem, so pin above it. */}
      {(dirty || canEdit || message) && <div className="sticky bottom-[calc(5rem+env(safe-area-inset-bottom))] z-10 flex flex-wrap items-center gap-3 border-t border-[var(--border)] bg-[var(--surface)] py-3 lg:bottom-0">
        {message && <p role={message.error ? "alert" : "status"} className={`notice w-full ${message.error ? "notice-error" : message.pending ? "notice-warning" : "notice-success"}`}>{message.text}</p>}
        {dirty && <p className="text-xs muted">{dirtyIds.length} unsaved change{dirtyIds.length === 1 ? "" : "s"}. {historical ? "Request or discard before changing the date or class." : "Save or discard before changing the date or class."}</p>}
        {canEdit && <button type="button" disabled={!ready || saving || !dirty || !students.length || (historical && (correctionConflict || !correctionReason.trim()))} onClick={save} className="min-h-11 w-full rounded-xl gradient px-4 py-2.5 text-sm font-bold disabled:opacity-50 sm:w-auto">
          {historical ? saving ? "Submitting correction…" : "Request correction" : saving ? "Saving attendance…" : "Save Attendance"}
        </button>}
      </div>}
    </section>
  );
}
