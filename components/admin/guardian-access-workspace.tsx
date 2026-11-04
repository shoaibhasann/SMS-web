"use client";

import { useRef, useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { lookupGuardianAccess, revokeGuardianAccess, type GuardianAccess } from "@/lib/guardian-invitations/admin";

const button = "min-h-11 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)] disabled:opacity-60";
const danger = `${button} border-red-300 text-red-700 dark:border-red-800 dark:text-red-300`;
const dateFormat = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Kolkata",
});

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed. Search again.";
}

export function GuardianAccessWorkspace({ client, schoolId, busy, onBusyChange }: {
  client: SupabaseClient;
  schoolId: string;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const pending = useRef(false);
  const [admissionNo, setAdmissionNo] = useState("");
  const [record, setRecord] = useState<GuardianAccess | null>();
  const [selected, setSelected] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const guardian = record?.guardians.find((entry) => entry.parent_id === selected);

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || pending.current || !admissionNo.trim()) return;
    pending.current = true;
    onBusyChange(true);
    setError("");
    setStatus("Looking up guardian access…");
    setRecord(undefined);
    setSelected("");
    setReason("");
    try {
      setRecord(await lookupGuardianAccess(client, schoolId, admissionNo.trim()));
      setStatus("");
    } catch (cause) {
      setError(errorText(cause));
      setStatus("");
    } finally {
      pending.current = false;
      onBusyChange(false);
    }
  }

  async function remove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!record || !guardian || busy || pending.current || reason.trim().length < 5 || reason.trim().length > 500) return;
    pending.current = true;
    onBusyChange(true);
    setError("");
    setStatus("Removing guardian access…");
    try {
      const removed = await revokeGuardianAccess(client, schoolId, record.student_id, guardian.parent_id, reason.trim());
      setSelected("");
      setReason("");
      setRecord({
        ...record,
        guardians: record.guardians.filter((entry) => entry.parent_id !== guardian.parent_id),
      });
      setStatus(removed ? "Guardian access removed." : "This guardian link was already removed.");
      try {
        setRecord(await lookupGuardianAccess(client, schoolId, record.admission_no));
      } catch {
        setError("Search again to refresh the access history.");
      }
    } catch (cause) {
      setError(errorText(cause));
      setStatus("");
    } finally {
      pending.current = false;
      onBusyChange(false);
    }
  }

  return (
    <section className="card space-y-4 p-4 sm:p-5" aria-labelledby="linked-guardian-access">
      <div>
        <h2 id="linked-guardian-access" className="text-lg font-bold">Manage linked guardians</h2>
        <p className="mt-1 text-sm muted">Find a student by admission number, including students who have withdrawn.</p>
      </div>
      <form onSubmit={search} className="flex flex-wrap items-end gap-3">
        <label className="block w-full min-w-0 space-y-2 text-sm font-semibold sm:max-w-xs">
          Admission number
          <input type="text" className="field" required value={admissionNo} disabled={busy}
            onChange={(event) => setAdmissionNo(event.target.value)} />
        </label>
        <button type="submit" className={button} disabled={busy || !admissionNo.trim()}>Find student</button>
      </form>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
      {status && <p role="status" className="text-sm muted">{status}</p>}
      {record === null && <p role="status" className="text-sm muted">No student with that admission number was found in this school.</p>}
      {record && (
        <div className="space-y-4 border-t border-[var(--border)] pt-4">
          <div>
            <h3 className="font-bold">{record.student_name || "Student"}</h3>
            <p className="mt-1 break-words text-sm muted">{record.admission_no}</p>
          </div>
          {record.guardians.length > 0 ? (
            <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] px-3">
              {record.guardians.map((entry) => (
                <li key={entry.parent_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0 break-words">
                    <p className="font-semibold">{entry.name || entry.email || "Guardian record"}</p>
                    {entry.name && entry.email && <p className="text-sm muted">{entry.email}</p>}
                    <p className="text-sm capitalize muted">{entry.relationship || "Guardian"} · {entry.has_account ? "Account linked" : "No account linked"}</p>
                  </div>
                  <button type="button" className={danger} disabled={busy || selected === entry.parent_id}
                    aria-label={`Remove access for ${entry.email || entry.name || "guardian record"}`}
                    onClick={() => { setSelected(entry.parent_id); setReason(""); setError(""); setStatus(""); }}>
                    Remove access
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm muted">This student has no linked guardians.</p>}
          {guardian && (
            <form onSubmit={remove} className="space-y-3 rounded-xl border border-red-300 p-3 dark:border-red-800">
              <h4 className="font-bold">Remove {guardian.name || guardian.email || "this guardian"}’s access?</h4>
              <p className="text-sm muted">Access for this student ends immediately. Other guardians and siblings keep their links.</p>
              <label className="block space-y-2 text-sm font-semibold">
                Reason for removal
                <textarea autoComplete="off" className="field min-h-20" value={reason} required minLength={5} maxLength={500}
                  disabled={busy} onChange={(event) => setReason(event.target.value)} />
              </label>
              <div className="flex flex-wrap gap-2">
                <button type="submit" className={danger} disabled={busy || reason.trim().length < 5}>Confirm removal</button>
                <button type="button" className={button} disabled={busy} onClick={() => { setSelected(""); setReason(""); }}>Cancel</button>
              </div>
            </form>
          )}
          <details className="rounded-xl border border-[var(--border)] p-3">
            <summary className="cursor-pointer text-sm font-bold">Recent access history</summary>
            {record.events.length > 0 ? (
              <ul className="mt-3 divide-y divide-[var(--border)]">
                {record.events.map((entry) => (
                  <li key={entry.id} className="space-y-1 break-words py-2 text-sm">
                    <p className="font-semibold">{entry.action === "linked" ? "Access linked" : "Access removed"}{entry.guardian_name ? ` · ${entry.guardian_name}` : ""}</p>
                    <p className="muted">{dateFormat.format(new Date(entry.occurred_at))}{entry.actor_name ? ` · ${entry.actor_name}` : ""}</p>
                    {entry.reason && <p>{entry.reason}</p>}
                  </li>
                ))}
              </ul>
            ) : <p className="mt-3 text-sm muted">No access changes recorded yet.</p>}
          </details>
        </div>
      )}
    </section>
  );
}
