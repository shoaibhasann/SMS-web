"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { studentName, type AttendanceContext, type AttendanceStudent } from "@/lib/attendance/types";
import { listRosterWithdrawals, reinstateRosterEnrollment, withdrawRosterStudent, type RosterWithdrawal } from "@/lib/students/withdrawals";
import { LoadingState } from "@/components/ui/skeleton";

const historyDate = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Kolkata",
});
const neutralButton = "min-h-11 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold disabled:opacity-60";

export function StudentWithdrawalDialog({ client, context, student, onClose, onBusyChange, onWithdrawn }: {
  client: SupabaseClient;
  context: AttendanceContext;
  student: AttendanceStudent;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
  onWithdrawn: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const [reason, setReason] = useState("");
  const hintId = useId();
  const [error, setError] = useState("");

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || reason.trim().length < 5) return;
    pending.current = true;
    onBusyChange(true);
    setSaving(true);
    setError("");
    try {
      await withdrawRosterStudent(client, context, student.id, reason);
      onWithdrawn();
      dialog.current?.close();
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : "Withdrawal could not be confirmed.");
    } finally {
      pending.current = false;
      setSaving(false);
      onBusyChange(false);
    }
  }

  return (
    <dialog ref={dialog} aria-labelledby="withdrawal-title" onClose={onClose}
      onCancel={(event) => { if (pending.current) event.preventDefault(); }}
      className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-[var(--text)] shadow-xl backdrop:bg-slate-950/60 sm:p-6">
      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        <div className="space-y-2">
          <h2 id="withdrawal-title" className="text-lg font-bold">Withdraw {studentName(student)}?</h2>
          <p className="text-sm muted">
            This removes admission {student.admission_no} from the current class roster.
            Attendance and fee history stay available to authorized users, including linked guardians.
            A School Admin or Principal can reinstate this pupil during the current academic year.
          </p>
        </div>
        <div className="space-y-2">
          <label className="block space-y-2 text-sm font-semibold">
            <span>Withdrawal reason</span>
            <textarea className="field min-h-24" value={reason} onChange={(event) => setReason(event.target.value)}
              minLength={5} maxLength={300} required disabled={saving} aria-describedby={hintId} />
          </label>
          <span id={hintId} className="block text-xs font-normal muted">At least 5 characters.</span>
        </div>
        {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={neutralButton} onClick={() => dialog.current?.close()} disabled={saving}>Cancel</button>
          <button type="submit" disabled={saving || reason.trim().length < 5}
            className="btn btn-danger-solid">
            {saving ? "Saving withdrawal…" : "Confirm withdrawal"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function StudentWithdrawalHistory({ client, context, currentAcademicYearId, revision, busy, onBusyChange, onReinstated }: {
  client: SupabaseClient;
  context: AttendanceContext;
  currentAcademicYearId: string;
  revision: number;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onReinstated: (record: RosterWithdrawal) => void;
}) {
  const { schoolId, academicYearId, classId, sectionId } = context;
  const [result, setResult] = useState<{ revision: number; records: RosterWithdrawal[]; error?: string }>();
  const [reinstating, setReinstating] = useState<RosterWithdrawal>();

  useEffect(() => {
    let active = true;
    listRosterWithdrawals(client, { schoolId, academicYearId, classId, sectionId }).then(
      (records) => { if (active) setResult({ revision, records }); },
      (failure: unknown) => {
        if (active) setResult({
          revision,
          records: [],
          error: failure instanceof Error ? failure.message : "Withdrawal history could not be loaded.",
        });
      },
    );
    return () => { active = false; };
  }, [client, schoolId, academicYearId, classId, sectionId, revision]);

  const history = result?.revision === revision ? result : undefined;
  // reinstate_roster_enrollment only accepts a withdrawal from the current academic year.
  const canReinstate = academicYearId === currentAcademicYearId;
  return (
    <details className="card p-4">
      <summary className="cursor-pointer text-lg font-bold">Withdrawal history</summary>
      <div className="mt-3">
        {!history ? <LoadingState variant="list" className="text-sm muted">Loading withdrawals…</LoadingState>
          : history.error ? <p role="alert" className="text-sm text-red-700 dark:text-red-400">{history.error}</p>
          : !history.records.length ? <p className="text-sm muted">No withdrawals recorded for this section.</p>
          : <ul className="divide-y divide-[var(--border)]">
              {history.records.map((record) => (
                <li key={record.enrollment_id} className="space-y-1 py-3 text-sm">
                  <p className="font-semibold">{record.student_name} · {record.admission_no}</p>
                  <p className="break-words">{record.reason}</p>
                  <p className="muted">{record.withdrawn_by_name} · {historyDate.format(new Date(record.withdrawn_at))} IST</p>
                  {canReinstate && <button type="button" className={neutralButton} disabled={busy} aria-label={`Reinstate ${record.student_name}`}
                    onClick={() => setReinstating(record)}>Reinstate</button>}
                </li>
              ))}
            </ul>}
      </div>
      {reinstating && (
        <StudentReinstatementDialog client={client} schoolId={schoolId} record={reinstating}
          onClose={() => setReinstating(undefined)} onBusyChange={onBusyChange} onReinstated={onReinstated} />
      )}
    </details>
  );
}

function StudentReinstatementDialog({ client, schoolId, record, onClose, onBusyChange, onReinstated }: {
  client: SupabaseClient;
  schoolId: string;
  record: RosterWithdrawal;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
  onReinstated: (record: RosterWithdrawal) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const [reason, setReason] = useState("");
  const hintId = useId();
  const [error, setError] = useState("");

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || reason.trim().length < 5) return;
    pending.current = true;
    onBusyChange(true);
    setSaving(true);
    setError("");
    try {
      await reinstateRosterEnrollment(client, schoolId, record.enrollment_id, reason);
      onReinstated(record);
      dialog.current?.close();
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : "Reinstatement could not be confirmed.");
    } finally {
      pending.current = false;
      setSaving(false);
      onBusyChange(false);
    }
  }

  return (
    <dialog ref={dialog} aria-labelledby="reinstatement-title" onClose={onClose}
      onCancel={(event) => { if (pending.current) event.preventDefault(); }}
      className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-[var(--text)] shadow-xl backdrop:bg-slate-950/60 sm:p-6">
      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        <div className="space-y-2">
          <h2 id="reinstatement-title" className="text-lg font-bold">Reinstate {record.student_name}?</h2>
          <p className="text-sm muted">
            Admission {record.admission_no} returns to this class roster with the same pupil record and history.
            The withdrawal stays in the school audit history.
          </p>
        </div>
        <div className="space-y-2">
          <label className="block space-y-2 text-sm font-semibold">
            <span>Reinstatement reason</span>
            <textarea className="field min-h-24" value={reason} onChange={(event) => setReason(event.target.value)}
              minLength={5} maxLength={300} required disabled={saving} aria-describedby={hintId} />
          </label>
          <span id={hintId} className="block text-xs font-normal muted">At least 5 characters.</span>
        </div>
        {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={neutralButton} onClick={() => dialog.current?.close()} disabled={saving}>Cancel</button>
          <button type="submit" disabled={saving || reason.trim().length < 5}
            className="btn btn-primary">
            {saving ? "Saving reinstatement…" : "Confirm reinstatement"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
