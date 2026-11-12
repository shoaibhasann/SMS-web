"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { studentName, type AttendanceContext, type AttendanceStudent } from "@/lib/attendance/types";
import { stageSectionPromotions, type PlacementYear } from "@/lib/students/placements";

type NamedOption = { id: string; name: string };
type SectionOption = NamedOption & { class_id: string };
type PromotionStudent = AttendanceStudent & { enrollment_id: string };

const MAX_PUPILS = 200;
const label = "block space-y-2 text-sm font-semibold";
const button = "min-h-11 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold disabled:opacity-60";

export function SectionPromotionDialog({
  client, source, currentYear, years, classes, sections, students, onClose, onBusyChange, onStaged,
}: {
  client: SupabaseClient;
  source: AttendanceContext;
  currentYear: PlacementYear;
  years: PlacementYear[];
  classes: NamedOption[];
  sections: SectionOption[];
  students: PromotionStudent[];
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
  onStaged: (result: { staged: number; alreadyStaged: number }) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const request = useRef<{ draft: string; id: string } | null>(null);
  const promotionYears = years.filter((year) => !year.is_current && year.start_date > currentYear.end_date);
  const [academicYearId, setAcademicYearId] = useState(promotionYears.length === 1 ? promotionYears[0].id : "");
  const [classId, setClassId] = useState("");
  const [sectionId, setSectionId] = useState("");
  const [reason, setReason] = useState("");
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  const destinationYear = promotionYears.find((year) => year.id === academicYearId);
  const destinationClass = classes.find((entry) => entry.id === classId);
  const availableSections = sections.filter((section) => section.class_id === classId);
  const destinationSection = availableSections.find((entry) => entry.id === sectionId);
  const selected = students.filter((student) => !excluded.has(student.enrollment_id));
  const canSave = Boolean(destinationYear && destinationClass && destinationSection && reason.trim().length >= 5
    && selected.length && selected.length <= MAX_PUPILS);

  function toggle(enrollmentId: string) {
    setError("");
    setExcluded((current) => {
      const next = new Set(current);
      if (!next.delete(enrollmentId)) next.add(enrollmentId);
      return next;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave || pending.current) return;
    pending.current = true;
    onBusyChange(true);
    setSaving(true);
    setError("");
    try {
      const enrollmentIds = selected.map((student) => student.enrollment_id);
      const draft = JSON.stringify([academicYearId, classId, sectionId, reason.trim(), enrollmentIds]);
      if (request.current?.draft !== draft) request.current = { draft, id: crypto.randomUUID() };
      const result = await stageSectionPromotions(client, source, enrollmentIds, { academicYearId, classId, sectionId }, reason, request.current.id);
      onStaged(result);
      dialog.current?.close();
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : "The promotion could not be confirmed.");
    } finally {
      pending.current = false;
      setSaving(false);
      onBusyChange(false);
    }
  }

  return (
    <dialog ref={dialog} aria-labelledby="promotion-title" aria-describedby="promotion-description" onClose={onClose}
      onCancel={(event) => { if (pending.current) event.preventDefault(); }}
      className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-[var(--text)] shadow-xl backdrop:bg-slate-950/60 sm:p-6">
      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        <div className="space-y-1">
          <h2 id="promotion-title" className="text-lg font-bold">Promote this section</h2>
          <p id="promotion-description" className="text-sm muted">
            Prepare the promotion of {currentYear.name} · {classes.find((entry) => entry.id === source.classId)?.name} · {sections.find((entry) => entry.id === source.sectionId)?.name} to a later academic year. Untick students who should not move with the section.
          </p>
        </div>
        <fieldset className="grid gap-3 sm:grid-cols-2" disabled={saving}>
          <legend className="sr-only">Destination placement</legend>
          <label className={`${label} sm:col-span-2`}>
            <span>Destination academic year</span>
            <select className="field" value={academicYearId} required onChange={(event) => {
              setAcademicYearId(event.target.value);
              setError("");
            }}>
              <option value="">Select a later academic year</option>
              {promotionYears.map((year) => <option key={year.id} value={year.id}>{year.name}</option>)}
            </select>
          </label>
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
        <fieldset className="space-y-2" disabled={saving}>
          <legend className="text-sm font-semibold">Students to promote ({selected.length} of {students.length})</legend>
          <ul className="max-h-64 divide-y divide-[var(--border)] overflow-y-auto rounded-xl border border-[var(--border)] px-3">
            {students.map((student) => (
              <li key={student.enrollment_id} className="py-2 text-sm">
                <label className="flex items-center gap-3 break-words">
                  <input type="checkbox" className="size-4" checked={!excluded.has(student.enrollment_id)}
                    onChange={() => toggle(student.enrollment_id)} />
                  <span>{studentName(student)} · {student.admission_no}</span>
                </label>
              </li>
            ))}
          </ul>
          {selected.length > MAX_PUPILS && <p className="text-sm text-red-700 dark:text-red-400">Promote at most {MAX_PUPILS} students at a time.</p>}
        </fieldset>
        {destinationYear && destinationClass && destinationSection && (
          <div className="rounded-xl border border-[var(--border)] p-3 text-sm" aria-live="polite">
            <p className="font-semibold">Promotion review</p>
            <p className="mt-1 break-words">{selected.length} student{selected.length === 1 ? "" : "s"} → {destinationYear.name} · {destinationClass.name} · {destinationSection.name}</p>
            <p className="mt-1 muted">This prepares the promotion. It takes effect after the new academic year is activated in Academics &amp; Subjects.</p>
            <p className="mt-1 muted">Students who already have a staged placement in this year keep it. Use Change placement to revise one student.</p>
            {students.length > selected.length && <p className="mt-1 muted">Unticked students stay unplaced until you promote, move or withdraw them.</p>}
          </div>
        )}
        <label className={label}>
          <span>Reason for promotion</span>
          <textarea className="field min-h-20" value={reason} onChange={(event) => setReason(event.target.value)}
            minLength={5} maxLength={300} required disabled={saving} />
        </label>
        {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={button} onClick={() => dialog.current?.close()} disabled={saving}>Cancel</button>
          <button type="submit" disabled={saving || !canSave} className="btn btn-primary">
            {saving ? "Staging promotion…" : `Stage promotion for ${selected.length} student${selected.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </form>
    </dialog>
  );
}
