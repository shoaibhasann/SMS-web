"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { schoolDate, studentName, type AttendanceContext, type AttendanceStudent } from "@/lib/attendance/types";
import {
  changeRosterPlacement, listRosterPlacementChanges, type PlacementYear, type RosterPlacementChange,
} from "@/lib/students/placements";

type NamedOption = { id: string; name: string };
type SectionOption = NamedOption & { class_id: string };
type PlacementKind = RosterPlacementChange["change_kind"];

const label = "block space-y-2 text-sm font-semibold";
const button = "min-h-11 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold disabled:opacity-60";
const historyDate = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata",
});

export function StudentPlacementDialog({
  client, source, currentYear, years, classes, sections, student, onClose, onBusyChange, onPlaced,
}: {
  client: SupabaseClient;
  source: AttendanceContext;
  currentYear: PlacementYear;
  years: PlacementYear[];
  classes: NamedOption[];
  sections: SectionOption[];
  student: AttendanceStudent & { enrollment_id: string };
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
  onPlaced: (kind: PlacementKind) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const request = useRef<{ draft: string; id: string } | null>(null);
  const today = schoolDate();
  const canMoveThisYear = today >= currentYear.start_date && today <= currentYear.end_date;
  const [academicYearId, setAcademicYearId] = useState(canMoveThisYear ? currentYear.id : "");
  const [classId, setClassId] = useState("");
  const [sectionId, setSectionId] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  const promotionYears = years.filter((year) => !year.is_current && year.start_date > currentYear.end_date);
  const isPromotion = Boolean(academicYearId && academicYearId !== currentYear.id);
  const kind = isPromotion ? "promotion" : "move";
  const destinationYear = isPromotion ? promotionYears.find((year) => year.id === academicYearId) : canMoveThisYear ? currentYear : undefined;
  const availableSections = sections.filter((section) =>
    section.class_id === classId && (isPromotion || section.id !== source.sectionId),
  );
  const destinationClass = classes.find((entry) => entry.id === classId);
  const destinationSection = availableSections.find((entry) => entry.id === sectionId);
  const canSave = Boolean(destinationYear && destinationClass && destinationSection && reason.trim().length >= 5);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave || pending.current) return;
    pending.current = true;
    onBusyChange(true);
    setSaving(true);
    setError("");
    try {
      const draft = JSON.stringify([academicYearId, classId, sectionId, reason.trim()]);
      if (request.current?.draft !== draft) request.current = { draft, id: crypto.randomUUID() };
      await changeRosterPlacement(client, source, student.enrollment_id, { academicYearId, classId, sectionId }, reason, request.current.id);
      onPlaced(kind);
      dialog.current?.close();
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : "The placement could not be confirmed.");
    } finally {
      pending.current = false;
      setSaving(false);
      onBusyChange(false);
    }
  }

  return (
    <dialog ref={dialog} aria-labelledby="placement-title" aria-describedby="placement-description" onClose={onClose}
      onCancel={(event) => { if (pending.current) event.preventDefault(); }}
      className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-[var(--text)] shadow-xl backdrop:bg-slate-950/60 sm:p-6">
      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        <div className="space-y-1">
          <h2 id="placement-title" className="text-lg font-bold">Change placement for {studentName(student)}</h2>
          <p id="placement-description" className="text-sm muted">Transfer the student to another class or section, or prepare a promotion to a later academic year.</p>
        </div>
        <div className="rounded-xl border border-[var(--border)] p-3 text-sm">
          <p className="font-semibold">Current placement</p>
          <p className="mt-1 break-words">{currentYear.name} · {classes.find((entry) => entry.id === source.classId)?.name} · {sections.find((entry) => entry.id === source.sectionId)?.name}</p>
          <p className="mt-1 muted">Admission {student.admission_no}{student.roll_no ? ` · Roll ${student.roll_no}` : ""}</p>
        </div>
        <fieldset className="grid gap-3 sm:grid-cols-2" disabled={saving}>
          <legend className="sr-only">Destination placement</legend>
          <label className={`${label} sm:col-span-2`}>
            <span>Destination academic year</span>
            <select className="field" value={academicYearId} onChange={(event) => {
              setAcademicYearId(event.target.value);
              setClassId("");
              setSectionId("");
              setError("");
            }}>
              {!canMoveThisYear && <option value="">Select a later academic year</option>}
              <option value={currentYear.id} disabled={!canMoveThisYear}>{currentYear.name} (current year)</option>
              {promotionYears.map((year) => <option key={year.id} value={year.id}>{year.name} (promotion)</option>)}
            </select>
          </label>
          {!canMoveThisYear &&
            <p className="text-sm muted sm:col-span-2">A same-year move requires a current academic year in progress.</p>}
          {!promotionYears.length &&
            <p className="text-sm muted sm:col-span-2">Add a later academic year in Academics &amp; Subjects to prepare promotions.</p>}
          <label className={label}>
            <span>Destination class</span>
            <select className="field" value={classId} required onChange={(event) => {
              setClassId(event.target.value);
              setSectionId("");
              setError("");
            }}>
              <option value="">Select class</option>
              {classes.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </select>
          </label>
          <label className={label}>
            <span>Destination section</span>
            <select className="field" value={sectionId} required disabled={!availableSections.length} onChange={(event) => {
              setSectionId(event.target.value);
              setError("");
            }}>
              <option value="">{classId && !availableSections.length ? "No eligible sections" : "Select section"}</option>
              {availableSections.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </select>
          </label>
        </fieldset>
        {destinationYear && destinationClass && destinationSection && (
          <div className="rounded-xl border border-[var(--border)] p-3 text-sm" aria-live="polite">
            <p className="font-semibold">{isPromotion ? "Promotion preview" : "Move preview"}</p>
            <p className="mt-1 break-words">{destinationYear.name} · {destinationClass.name} · {destinationSection.name}</p>
            <p className="mt-1 muted">{isPromotion
              ? "This prepares the promotion. It takes effect after the new academic year is activated in Academics & Subjects."
              : "The student moves to the destination roster today. The move can be saved only before today’s attendance is marked."}</p>
            {isPromotion && <p className="mt-1 muted">To revise a staged promotion before activation, use Change placement again and choose a different class or section in the same destination year.</p>}
            <p className="mt-1 muted">The destination roll number will be unassigned. Past attendance and fee records remain with the student.</p>
          </div>
        )}
        <label className={label}>
          <span>Reason for placement change</span>
          <textarea className="field min-h-20" value={reason} onChange={(event) => setReason(event.target.value)}
            minLength={5} maxLength={300} required disabled={saving} />
        </label>
        {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={button} onClick={() => dialog.current?.close()} disabled={saving}>Cancel</button>
          <button type="submit" disabled={saving || !canSave} className={`${button} bg-blue-600 text-white`}>
            {saving ? "Saving placement…" : isPromotion ? "Confirm staged promotion" : "Confirm move"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function StudentPlacementHistory({ client, context, years, revision }: {
  client: SupabaseClient;
  context: AttendanceContext;
  years: PlacementYear[];
  revision: number;
}) {
  const { schoolId, classId, sectionId } = context;
  const [academicYearId, setAcademicYearId] = useState(context.academicYearId);
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ revision: number; attempt: number; academicYearId: string; changes?: RosterPlacementChange[]; error?: string }>();

  useEffect(() => {
    if (!open) return;
    let active = true;
    listRosterPlacementChanges(client, { schoolId, academicYearId, classId, sectionId }).then(
      (changes) => { if (active) setResult({ revision, attempt, academicYearId, changes }); },
      (failure: unknown) => {
        if (active) setResult({ revision, attempt, academicYearId, error: failure instanceof Error ? failure.message : "Placement history could not be loaded." });
      },
    );
    return () => { active = false; };
  }, [client, schoolId, academicYearId, classId, sectionId, revision, attempt, open]);

  const history = result?.revision === revision && result.attempt === attempt && result.academicYearId === academicYearId ? result : undefined;
  return (
    <details className="card p-4" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-lg font-bold">Placement history</summary>
      {open && <div className="mt-3 space-y-3">
        <label className={`${label} max-w-sm`}>
          <span>Source academic year</span>
          <select className="field" value={academicYearId} onChange={(event) => setAcademicYearId(event.target.value)}>
            {years.map((year) => <option key={year.id} value={year.id}>{year.name}</option>)}
          </select>
        </label>
        {!history ? <p role="status" className="text-sm muted">Loading placement history…</p>
          : history.error ? <>
              <p role="alert" className="text-sm text-red-700 dark:text-red-400">{history.error}</p>
              <button type="button" className={button} onClick={() => setAttempt((value) => value + 1)}>Retry placement history</button>
            </>
          : !history.changes?.length ? <p className="text-sm muted">No moves or promotions recorded from this section.</p>
          : <ul className="divide-y divide-[var(--border)]">
              {history.changes.map((record) => (
                <li key={record.request_id} className="space-y-1 break-words py-3 text-sm">
                  <p className="font-semibold">{record.student_name} · {record.admission_no}</p>
                  <p>{record.change_kind === "move" ? "Moved to" : "Promotion prepared for"} {record.destination_year_name} · {record.destination_class_name} · {record.destination_section_name}</p>
                  <p className="muted">{record.change_kind === "move" ? "Effective" : "Destination session starts"} {record.effective_date}</p>
                  <p>{record.reason}</p>
                  <p className="muted">{record.changed_by_name || "School staff"} · {historyDate.format(new Date(record.changed_at))} IST</p>
                </li>
              ))}
            </ul>}
      </div>}
    </details>
  );
}
