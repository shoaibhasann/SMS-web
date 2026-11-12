"use client";

import Link from "next/link";
import { History, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LoadingState } from "@/components/ui/skeleton";
import { loadStaffMfaPolicy, saveStaffMfaPolicy, STAFF_MFA_PENDING_LIMIT, StaffMfaPolicyError, type StaffMfaPendingReason, type StaffMfaPolicy, type StaffMfaPolicyIntent } from "@/lib/admin/staff-mfa-policy";
import { roleLabel, toUiRole } from "@/lib/auth/roles";
import { mfaPath, readStaffMfaStatus, type StaffMfaStatus } from "@/lib/auth/staff-mfa";

const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold transition hover:bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
const reasonLabels: Record<StaffMfaPendingReason, string> = { not_enrolled: "Not enrolled", unconfirmed: "Email or phone not confirmed", banned: "Account blocked", deleted: "Account deleted" };
const staffRoles = (roles: string[]) => [...new Set(roles.map((role) => { const ui = toUiRole(role); return ui ? roleLabel(ui) : role; }))].join(", ");
type Props = { client: SupabaseClient; userId: string; schoolId: string; onLock: (value: boolean) => void };
export function SchoolStaffMfaPolicy(props: Props) {
  return <OwnSchoolStaffMfaPolicy key={`${props.userId}:${props.schoolId}`} {...props} />;
}
function OwnSchoolStaffMfaPolicy({ client, userId, schoolId, onLock }: Props) {
  const [record, setRecord] = useState<StaffMfaPolicy>();
  const [security, setSecurity] = useState<StaffMfaStatus>();
  const [reason, setReason] = useState("");
  const [intent, setIntent] = useState<StaffMfaPolicyIntent>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const [conflict, setConflict] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => { onLock(Boolean(intent || saving)); return () => onLock(false); }, [intent, onLock, saving]);
  useEffect(() => {
    const controller = new AbortController(); request.current = controller;
    void Promise.all([loadStaffMfaPolicy(client, userId, schoolId, controller.signal), readStaffMfaStatus(client, userId, controller.signal)]).then(([policy, status]) => {
      if (!controller.signal.aborted) {
        if (!status) { setError("Your account signed out. Reopen school settings."); return; }
        setRecord(policy); setSecurity(status); setError("");
      }
    }, () => { if (!controller.signal.aborted) setError("School security could not be checked. Reload to verify its saved status."); }).finally(() => { if (request.current === controller) request.current = null; });
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) { controller.abort(); request.current?.abort(); setRecord(undefined); setSecurity(undefined); setError("Your account changed or signed out. Reopen school settings."); }
    });
    return () => { controller.abort(); request.current?.abort(); subscription.unsubscribe(); };
  }, [client, reload, schoolId, userId]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!record?.can_manage || !security?.allowed || security.current_aal !== "aal2" || saving || request.current || conflict) return;
    const submission = intent ?? { schoolId, revision: record.revision, required: !record.required, requestId: crypto.randomUUID(), reason: reason.trim() };
    if (!intent && (submission.reason.length < 5 || submission.reason.length > 300)) { setError("Use a 5–300 character change reason."); return; }
    setIntent(submission); setSaving(true); setError(""); setNotice("");
    const controller = new AbortController(); request.current = controller;
    try {
      await saveStaffMfaPolicy(client, userId, submission, controller.signal);
      if (controller.signal.aborted) return;
      setIntent(undefined); setReason(""); setNotice("School authenticator policy saved."); setRecord(undefined); setSecurity(undefined); setReload((value) => value + 1);
    } catch (failure) {
      if (controller.signal.aborted) return;
      setError(failure instanceof StaffMfaPolicyError ? failure.message : "The policy save could not be confirmed. Retry the same request.");
      if (failure instanceof StaffMfaPolicyError && failure.code !== "unconfirmed") { setIntent(undefined); if (failure.code === "conflict") setConflict(true); }
    } finally { if (request.current === controller) request.current = null; if (!controller.signal.aborted) setSaving(false); }
  }
  const ready = security?.current_aal === "aal2" && security.verified_totp_count > 0;
  return <section className="card min-w-0 overflow-hidden" aria-labelledby="school-mfa-heading">
    <header className="flex items-start gap-3 border-b border-[var(--border)] p-5"><ShieldCheck size={21} className="mt-0.5 shrink-0 text-[var(--primary)]" aria-hidden="true" /><div><h2 id="school-mfa-heading" className="text-lg font-semibold">Staff authenticator policy</h2><p className="mt-1 text-sm leading-6 muted">Require an authenticator for administrators, principals, teachers, finance and reception staff.</p></div></header>
    <div className="space-y-4 p-5">
      {!record ? !error && <LoadingState variant="form">Checking school security…</LoadingState> : <>
        <div className="flex flex-wrap items-center justify-between gap-3"><span className="rounded-full bg-[var(--surface-2)] px-3 py-1.5 text-xs font-semibold">{record.required ? "Required for staff" : "Optional for staff"}</span><span className="text-xs muted">Revision {record.revision}</span></div>
        <dl className="grid grid-cols-3 gap-3">{[["Active staff", record.staff_count], ["Enrolled", record.enrolled_staff_count], ["Still needed", record.enrollment_required_count]].map(([label, value]) => <div key={label} className="rounded-xl border border-[var(--border)] p-3"><dt className="text-xs muted">{label}</dt><dd className="mt-1 text-xl font-bold">{value}</dd></div>)}</dl>
        {record.pending.length > 0 && <div className="space-y-2">
          <h3 id="school-mfa-pending-heading" className="text-sm font-semibold">Staff still to enroll</h3>
          <ul aria-labelledby="school-mfa-pending-heading" className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">{record.pending.map((person) => <li key={person.profile_id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3 py-2 text-sm">
            <span className="min-w-0 break-words"><span className="font-semibold">{person.full_name || "Unnamed staff account"}</span> <span className="text-xs muted">· {staffRoles(person.roles)}</span></span>
            <span className={`text-xs font-semibold ${person.reason === "not_enrolled" ? "muted" : "text-amber-700 dark:text-amber-300"}`}>{reasonLabels[person.reason]}</span>
          </li>)}</ul>
          {record.enrollment_required_count > record.pending.length && <p className="text-xs muted">Showing the first {STAFF_MFA_PENDING_LIMIT} of {record.enrollment_required_count}.</p>}
          <p className="text-xs leading-6 muted">A blocked, deleted or unconfirmed account cannot enroll. Fix the account or remove its staff role before enabling this policy.</p>
        </div>}
        <p className="text-xs leading-6 muted">Every active staff member must enroll before this can be enabled. A staff member with a guardian role must verify before opening either workspace. Existing authenticators remain required for their accounts when this policy is optional.</p>
        {record.can_manage ? !ready ? <Link className={button} href={`${mfaPath("/modules/settings")}&setup=1`}>Set up and verify your authenticator first</Link> : <form aria-label="Change staff authenticator policy" className="space-y-4" onSubmit={save}>
          <label className="block space-y-2 text-sm font-semibold"><span>Reason for {record.required ? "disabling" : "enabling"}</span><textarea required minLength={5} maxLength={300} className="field !min-h-24" value={intent?.reason ?? reason} disabled={saving || Boolean(intent) || conflict} onChange={(event) => setReason(event.target.value)} /></label>
          {!record.required && record.enrollment_required_count > 0 && <p className="text-sm leading-6 text-amber-700 dark:text-amber-300">Ask remaining staff to open Account settings → Authenticator security and finish setup. Reload this policy when everyone is ready.</p>}
          <button type="submit" className={button} disabled={saving || conflict || !record.required && record.enrollment_required_count > 0}>{saving ? "Saving policy…" : intent ? "Retry same policy save" : record.required ? "Disable school requirement" : "Require authenticator for staff"}</button>
          {intent && !saving && <p className="text-xs leading-5 muted">The result of this save is unknown. Retry its exact request before making another policy change.</p>}
        </form> : <p className="text-sm muted">Read-only access. A School Admin manages this security policy.</p>}
        {record.history.length > 0 && <details className="border-t border-[var(--border)] pt-3"><summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold"><History size={16} aria-hidden="true" />Recent policy changes</summary><ol className="space-y-3 pt-2">{record.history.map((item) => <li key={item.id} className="text-xs leading-6 muted">Revision {item.revision} · {item.required ? "Required" : "Optional"} · {item.actor_name || "School administrator"} · {new Date(item.changed_at).toLocaleString("en-IN")}</li>)}</ol></details>}
      </>}
      {error && <p role="alert" className="text-sm leading-6 text-red-700 dark:text-red-300">{error}</p>}
      {notice && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">{notice}</p>}
      <button type="button" disabled={saving || Boolean(intent)} className={button} onClick={() => { setConflict(false); setRecord(undefined); setSecurity(undefined); setReload((value) => value + 1); }}><RefreshCw size={16} aria-hidden="true" />Reload saved policy</button>
    </div>
  </section>;
}
