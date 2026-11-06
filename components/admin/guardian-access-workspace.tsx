"use client";

import { useRef, useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  guardianInvitationUrl,
  lookupGuardianAccess,
  reinviteGuardianAccess,
  revokeGuardianAccess,
  type GuardianAccess,
} from "@/lib/guardian-invitations/admin";

const button = "min-h-11 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)] disabled:opacity-60";
const danger = `${button} border-red-300 text-red-700 dark:border-red-800 dark:text-red-300`;
const primary = `${button} bg-blue-700 text-white`;
const dateFormat = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Kolkata",
});

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed. Search again.";
}

type AccessAction = { kind: "remove"; parentId: string } | { kind: "reinvite"; revocationId: string };
type ReinviteLink = { invitationId: string; url: string; contact: string; expiresAt: string };

export function GuardianAccessWorkspace({ client, schoolId, busy, onBusyChange, onInvitationsChanged }: {
  client: SupabaseClient;
  schoolId: string;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onInvitationsChanged: () => void;
}) {
  const pending = useRef(false);
  const linkInput = useRef<HTMLInputElement>(null);
  const [admissionNo, setAdmissionNo] = useState("");
  const [record, setRecord] = useState<GuardianAccess | null>();
  const [selected, setSelected] = useState<AccessAction>();
  const [link, setLink] = useState<ReinviteLink>();
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const guardian = selected?.kind === "remove"
    ? record?.guardians.find((entry) => entry.parent_id === selected.parentId)
    : undefined;
  const removedGuardian = selected?.kind === "reinvite"
    ? record?.reinvitable_guardians.find((entry) => entry.revocation_id === selected.revocationId)
    : undefined;
  const displayLink = link && record?.reinvitable_guardians.some((entry) =>
    entry.pending_invitation_id === link.invitationId,
  );

  function selectAction(action: AccessAction) {
    setSelected(action);
    setReason("");
    setError("");
    setStatus("");
  }

  async function refreshRecord(admissionNumber: string) {
    try {
      setRecord(await lookupGuardianAccess(client, schoolId, admissionNumber));
    } catch {
      setError("Find the student again to refresh the access history.");
    }
  }

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || pending.current || !admissionNo.trim()) return;
    pending.current = true;
    onBusyChange(true);
    setError("");
    setStatus("Looking up guardian access…");
    setRecord(undefined);
    setSelected(undefined);
    setLink(undefined);
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
      setSelected(undefined);
      setReason("");
      setRecord({
        ...record,
        guardians: record.guardians.filter((entry) => entry.parent_id !== guardian.parent_id),
      });
      setStatus(removed ? "Guardian access removed." : "This guardian link was already removed.");
      if (removed) onInvitationsChanged();
      await refreshRecord(record.admission_no);
    } catch (cause) {
      setError(errorText(cause));
      setStatus("");
    } finally {
      pending.current = false;
      onBusyChange(false);
    }
  }

  async function reinvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!record || !removedGuardian || busy || pending.current) return;
    pending.current = true;
    onBusyChange(true);
    setLink(undefined);
    setError("");
    setStatus("Creating re-invitation…");
    try {
      const invitation = await reinviteGuardianAccess(client, schoolId, record.student_id, removedGuardian.revocation_id);
      setSelected(undefined);
      setLink({
        invitationId: invitation.id,
        url: guardianInvitationUrl(invitation.token, window.location.origin, invitation.email ? "email" : "phone"),
        contact: invitation.email || invitation.phone!,
        expiresAt: invitation.expires_at,
      });
      setRecord({
        ...record,
        reinvitable_guardians: record.reinvitable_guardians.map((entry) =>
          entry.revocation_id === removedGuardian.revocation_id ? {
            ...entry,
            email: invitation.email,
            phone: invitation.phone,
            pending_invitation_id: invitation.id,
            pending_expires_at: invitation.expires_at,
          } : entry,
        ),
      });
      setStatus("Re-invitation created. Copy the link and share it privately with the guardian.");
      onInvitationsChanged();
      await refreshRecord(record.admission_no);
    } catch (cause) {
      setError(errorText(cause));
      setStatus("");
    } finally {
      pending.current = false;
      onBusyChange(false);
    }
  }

  async function copyLink() {
    if (!link || !displayLink || busy) return;
    if (Date.parse(link.expiresAt) <= Date.now()) {
      setLink(undefined);
      setStatus("");
      setError("This link expired. Find the student again to create a replacement.");
      return;
    }
    try {
      await navigator.clipboard.writeText(link.url);
      setError("");
      setStatus("Re-invitation link copied.");
    } catch {
      linkInput.current?.focus();
      linkInput.current?.select();
      setStatus("");
      setError("Automatic copy is unavailable. Copy the selected re-invitation link manually.");
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
                    <p className="font-semibold">{entry.name || entry.email || entry.phone || "Guardian record"}</p>
                    {entry.name && (entry.email || entry.phone) && <p className="text-sm muted">{entry.email || entry.phone}</p>}
                    <p className="text-sm capitalize muted">{entry.relationship || "Guardian"} · {entry.has_account ? "Account linked" : "No account linked"}</p>
                  </div>
                  <button type="button" className={danger} disabled={busy || guardian?.parent_id === entry.parent_id}
                    aria-label={`Remove access for ${entry.email || entry.phone || entry.name || "guardian record"}`}
                    onClick={() => selectAction({ kind: "remove", parentId: entry.parent_id })}>
                    Remove access
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm muted">This student has no linked guardians.</p>}
          {guardian && (
            <form onSubmit={remove} className="space-y-3 rounded-xl border border-red-300 p-3 dark:border-red-800">
              <h4 className="font-bold">Remove {guardian.name || guardian.email || guardian.phone || "this guardian"}’s access?</h4>
              <p className="text-sm muted">Access for this student ends immediately. The school keeps the student’s attendance history. Other guardians and siblings keep their links.</p>
              <label className="block space-y-2 text-sm font-semibold">
                Reason for removal
                <textarea autoComplete="off" className="field min-h-20" value={reason} required minLength={5} maxLength={500}
                  disabled={busy} onChange={(event) => setReason(event.target.value)} />
              </label>
              <div className="flex flex-wrap gap-2">
                <button type="submit" className={danger} disabled={busy || reason.trim().length < 5}>Confirm removal</button>
                <button type="button" className={button} disabled={busy} onClick={() => { setSelected(undefined); setReason(""); }}>Cancel</button>
              </div>
            </form>
          )}
          {record.reinvitable_guardians.length > 0 && (
            <section aria-labelledby="removed-guardian-access" className="space-y-3 rounded-xl border border-[var(--border)] p-3">
              <div>
                <h4 id="removed-guardian-access" className="font-bold">Removed guardian access</h4>
                <p className="mt-1 text-sm muted">Access returns after the guardian signs in and accepts a new link for this student.</p>
              </div>
              <ul className="divide-y divide-[var(--border)]">
                {record.reinvitable_guardians.map((entry) => (
                  <li key={entry.revocation_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0 break-words" id={`removed-guardian-${entry.revocation_id}`}>
                      <p className="font-semibold">{entry.name || entry.email || entry.phone}</p>
                      {entry.name && <p className="text-sm muted">{entry.email || entry.phone}</p>}
                      <p className="text-sm muted">{entry.pending_expires_at
                        ? `Invitation pending · Expires ${dateFormat.format(new Date(entry.pending_expires_at))} IST`
                        : "Access removed"}</p>
                    </div>
                    <button type="button" className={button} disabled={busy || removedGuardian?.revocation_id === entry.revocation_id}
                      aria-describedby={`removed-guardian-${entry.revocation_id}`}
                      onClick={() => selectAction({ kind: "reinvite", revocationId: entry.revocation_id })}>
                      {entry.pending_expires_at ? "Replace invite link" : "Re-invite guardian"}
                    </button>
                  </li>
                ))}
              </ul>
              {removedGuardian && (
                <form onSubmit={reinvite} className="space-y-3 rounded-xl bg-[var(--surface-2)] p-3">
                  <p className="break-words text-sm">
                    Create a link for {removedGuardian.name || "this guardian"} to accept with {removedGuardian.email || removedGuardian.phone}?
                  </p>
                  {removedGuardian.pending_expires_at && <p className="text-sm muted">Creating a replacement invalidates the previous pending link.</p>}
                  <div className="flex flex-wrap gap-2">
                    <button type="submit" className={primary} disabled={busy}>Create re-invite link</button>
                    <button type="button" className={button} disabled={busy} onClick={() => setSelected(undefined)}>Cancel</button>
                  </div>
                </form>
              )}
              {displayLink && (
                <div className="space-y-3 rounded-xl bg-[var(--surface-2)] p-3">
                  <label className="block space-y-2 text-sm font-semibold">
                    Re-invitation link
                    <input className="field" ref={linkInput} readOnly value={link.url} />
                  </label>
                  <p className="break-words text-sm muted">For {link.contact}. Expires {dateFormat.format(new Date(link.expiresAt))} IST. Copy the link before leaving this student’s screen.</p>
                  <button type="button" className={button} disabled={busy} onClick={() => void copyLink()}>Copy re-invite link</button>
                </div>
              )}
            </section>
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
