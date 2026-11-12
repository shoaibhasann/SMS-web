"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { studentName, type AttendanceStudent } from "@/lib/attendance/types";
import { loadRosterStudentDetails, updateRosterStudentDetails, type RosterStudentDetails } from "@/lib/students/roster";
import { LoadingState } from "@/components/ui/skeleton";

const neutralButton = "min-h-11 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold disabled:opacity-60";
const label = "block space-y-2 text-sm font-semibold";

export function StudentDetailsDialog({ client, userId, schoolId, student, onClose, onBusyChange, onSaved }: {
  client: SupabaseClient;
  userId: string;
  schoolId: string;
  student: AttendanceStudent;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
  onSaved: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const operation = useRef<AbortController | null>(null);
  const [fields, setFields] = useState<RosterStudentDetails>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => { operation.current?.abort(); };
  }, []);

  useEffect(() => {
    let active = true;
    loadRosterStudentDetails(client, schoolId, student.id).then(
      (details) => { if (active) setFields(details); },
      (failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : "The pupil details could not be loaded."); },
    );
    return () => { active = false; };
  }, [client, schoolId, student.id]);

  const set = (key: keyof RosterStudentDetails) => (value: string) => setFields((current) => current && { ...current, [key]: value });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || !fields?.firstName.trim()) return;
    const controller = new AbortController(); operation.current = controller;
    pending.current = true;
    onBusyChange(true);
    setSaving(true);
    setError("");
    try {
      await updateRosterStudentDetails(client, schoolId, student.id, fields, { userId, signal: controller.signal });
      if (controller.signal.aborted) return;
      onSaved();
      dialog.current?.close();
    } catch (failure: unknown) {
      if (controller.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : "The pupil details could not be confirmed.");
    } finally {
      if (operation.current === controller) operation.current = null;
      pending.current = false;
      setSaving(false);
      onBusyChange(false);
    }
  }

  return (
    <dialog ref={dialog} aria-labelledby="student-details-title" onClose={onClose}
      onCancel={(event) => { if (pending.current) event.preventDefault(); }}
      className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-[var(--text)] shadow-xl backdrop:bg-slate-950/60 sm:p-6">
      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        <div className="space-y-2">
          <h2 id="student-details-title" className="text-lg font-bold">Edit details for {studentName(student)}</h2>
          <p className="text-sm muted">
            Admission {student.admission_no}. The pupil needs a date of birth and registered mobile to activate a Student account.
            Changes are recorded in the school audit history.
          </p>
        </div>
        {!fields ? (error ? null : <LoadingState variant="form" className="text-sm muted">Loading pupil details…</LoadingState>)
          : <fieldset className="grid gap-4 sm:grid-cols-2" disabled={saving}>
              <label className={label}><span>First name</span>
                <input className="field" value={fields.firstName} maxLength={100} required onChange={(event) => set("firstName")(event.target.value)} /></label>
              <label className={label}><span>Middle name (optional)</span>
                <input className="field" value={fields.middleName} maxLength={100} onChange={(event) => set("middleName")(event.target.value)} /></label>
              <label className={label}><span>Last name (optional)</span>
                <input className="field" value={fields.lastName} maxLength={100} onChange={(event) => set("lastName")(event.target.value)} /></label>
              <label className={label}><span>Date of birth</span>
                <input className="field" type="date" value={fields.dateOfBirth} onChange={(event) => set("dateOfBirth")(event.target.value)} /></label>
              <label className={label}><span>Registered mobile</span>
                <input className="field" type="tel" inputMode="tel" value={fields.registeredMobile} maxLength={20} placeholder="10 digit mobile number"
                  onChange={(event) => set("registeredMobile")(event.target.value)} /></label>
            </fieldset>}
        {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={neutralButton} onClick={() => dialog.current?.close()} disabled={saving}>Cancel</button>
          <button type="submit" disabled={saving || !fields?.firstName.trim()}
            className="btn btn-primary">
            {saving ? "Saving details…" : "Save details"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
