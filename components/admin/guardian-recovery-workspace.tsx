"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Copy, RefreshCw, ShieldCheck } from "lucide-react";
import { LoadingState } from "@/components/ui/skeleton";
import { mfaPath, readStaffMfaStatus, type StaffMfaStatus } from "@/lib/auth/staff-mfa";
import { guardianRecoveryUrl, GuardianRecoveryError, loadGuardianRecovery, newGuardianRecoveryToken, recoveryContact, saveGuardianRecovery,
  type GuardianRecoveryCase, type GuardianRecoveryWorkspace as Workspace, type RecoveryIntent, type RecoveryReview } from "@/lib/guardian-invitations/recovery";

const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold hover:bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50";
const primary = `${button} bg-[var(--primary)] text-white dark:text-[var(--bg)]`;
const date = (value: string) => new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
type Props = { client: SupabaseClient; userId: string; schoolId: string; busy: boolean; onBusyChange(value: boolean): void };
type ReviewChoice = { record: GuardianRecoveryCase; decision: RecoveryReview["decision"] };

export function GuardianRecoveryWorkspace(props: Props) { return <OwnRecovery key={`${props.userId}:${props.schoolId}`} {...props} />; }
function OwnRecovery({ client, userId, schoolId, busy, onBusyChange }: Props) {
  const [workspace, setWorkspace] = useState<Workspace>();
  const [security, setSecurity] = useState<StaffMfaStatus>();
  const [admission, setAdmission] = useState(""), [search, setSearch] = useState("");
  const [parentId, setParentId] = useState(""), [channel, setChannel] = useState<"email" | "phone">("email");
  const [contact, setContact] = useState(""), [reason, setReason] = useState("");
  const [review, setReview] = useState<ReviewChoice>(), [reviewReason, setReviewReason] = useState("");
  const [intent, setIntent] = useState<RecoveryIntent>(), [pending, setPending] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [changed, setChanged] = useState(false);
  const [revision, setRevision] = useState(0), [issued, setIssued] = useState<{ url: string; expiresAt: string }>();
  const operation = useRef<AbortController | null>(null);
  useEffect(() => { onBusyChange(Boolean(intent || pending)); return () => onBusyChange(false); }, [intent, onBusyChange, pending]);
  useEffect(() => {
    const controller = new AbortController(); operation.current = controller;
    void (async () => {
      const state = await readStaffMfaStatus(client, userId, controller.signal);
      if (controller.signal.aborted) return;
      if (!state) throw new Error("Sign in again before opening school recovery.");
      setSecurity(state);
      if (!state.allowed || state.current_aal !== "aal2") { setWorkspace(undefined); return; }
      const value = await loadGuardianRecovery(client, userId, schoolId, search, controller.signal);
      if (!controller.signal.aborted) { setWorkspace(value); setParentId(current => value.guardians.some(g => g.parent_id === current) ? current : value.guardians[0]?.parent_id ?? ""); }
    })().catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Recovery access could not be checked."); })
      .finally(() => { if (operation.current === controller) operation.current = null; });
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) { controller.abort(); operation.current?.abort(); setChanged(true); setWorkspace(undefined); setSecurity(undefined); setIssued(undefined); setIntent(undefined); setContact(""); setReason(""); setReview(undefined); }
    });
    return () => { controller.abort(); operation.current?.abort(); subscription.unsubscribe(); };
  }, [client, userId, schoolId, search, revision]);

  function reload() { setWorkspace(undefined); setError(""); setRevision(value => value + 1); }
  async function submit(submission: RecoveryIntent) {
    if (operation.current || pending || changed || busy && !intent) return;
    const controller = new AbortController(); operation.current = controller;
    setIntent(submission); setPending(true); setError(""); setNotice(""); setIssued(undefined);
    try {
      const result = await saveGuardianRecovery(client, userId, submission, controller.signal);
      if (controller.signal.aborted) return;
      if (result.token) setIssued({ url: guardianRecoveryUrl(result.token, window.location.origin), expiresAt: result.expires_at });
      setIntent(undefined); setReview(undefined); setReason(""); setReviewReason(""); setContact("");
      setNotice(result.status === "approved" ? "Recovery approved. Share this private one-use link only with the verified guardian."
        : result.status === "pending" ? "Recovery request saved. A different authorized staff member must review it." : `Recovery ${result.status}.`);
      setWorkspace(undefined); setRevision(value => value + 1);
    } catch (failure) {
      if (controller.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : "The result is unknown. Retry this exact request.");
      if (failure instanceof GuardianRecoveryError && failure.code !== "unconfirmed") { setIntent(undefined); setReview(undefined); setWorkspace(undefined); setRevision(value => value + 1); }
    } finally { if (operation.current === controller) operation.current = null; if (!controller.signal.aborted) setPending(false); }
  }
  function request(event: FormEvent) {
    event.preventDefault(); const normalized = recoveryContact(channel, contact);
    if (!normalized || !parentId || reason.trim().length < 5) { setError("Choose a guardian, valid new contact and verification reason."); return; }
    void submit({ kind: "request", schoolId, parentId, channel, contact: normalized, reason: reason.trim(), requestId: crypto.randomUUID() });
  }
  function decide(event: FormEvent) {
    event.preventDefault(); if (!review) return;
    void submit({ kind: "review", caseId: review.record.id, version: review.record.version, decision: review.decision,
      reason: reviewReason.trim(), requestId: crypto.randomUUID(), token: review.decision === "approve" ? newGuardianRecoveryToken() : null });
  }
  const locked = pending || Boolean(intent) || busy;
  return <section className="card min-w-0 overflow-hidden" aria-labelledby="guardian-recovery-heading">
    <header className="flex gap-3 border-b border-[var(--border)] p-5 sm:p-6"><ShieldCheck size={23} className="mt-0.5 shrink-0 text-[var(--primary)]" aria-hidden="true" /><div><h2 id="guardian-recovery-heading" className="text-lg font-semibold">Guardian account recovery</h2><p className="mt-1 text-sm leading-6 muted">Restore access when the old email, mobile or authenticator is unavailable. Existing child links stay in place.</p></div></header>
    <div className="space-y-5 p-5 sm:p-6">
      {changed ? <p role="alert">Your account changed. Reopen this school workspace.</p> : !security ? !error && <LoadingState variant="form">Checking recovery access…</LoadingState>
        : !security.allowed || security.current_aal !== "aal2" ? <div className="space-y-3"><p className="text-sm muted">School recovery requires current authenticator verification, including when the school&apos;s general policy is optional.</p><Link className={button} href={`${mfaPath("/modules/guardian-invitations?recovery=1")}&setup=1`}>Verify account security</Link></div>
          : <>
            <p className="text-sm leading-6 muted">Verify the guardian against school records first. A different School Admin or Principal must independently approve. This recovers access through a different verified login; it does not reset someone else&apos;s password or remove an authenticator.</p>
            <form onSubmit={event => { event.preventDefault(); if (!locked) { setSearch(admission.trim()); setWorkspace(undefined); setError(""); setRevision(value => value + 1); } }} className="flex flex-wrap items-end gap-3" aria-label="Find guardian for recovery">
              <label className="min-w-0 flex-1 space-y-2 text-sm font-semibold"><span>Student admission number</span><input className="field" required maxLength={100} value={admission} disabled={locked} onChange={event => setAdmission(event.target.value)} /></label><button className={button} disabled={locked}>Find linked guardians</button>
            </form>
            {!workspace ? !error && <LoadingState variant="list">Loading recovery records…</LoadingState> : <>
              {search && !workspace.guardians.length && <p className="text-sm muted">No eligible guardian found. Recovery is for a single guardian-only account; staff, mixed-role and ambiguous accounts need platform support.</p>}
              {workspace.guardians.length > 0 && <form onSubmit={request} className="space-y-4 rounded-2xl border border-[var(--border)] p-4" aria-label="Request guardian recovery"><fieldset disabled={locked} className="min-w-0 space-y-4">
                <label className="block space-y-2 text-sm font-semibold"><span>Guardian account</span><select className="field" value={parentId} onChange={event => setParentId(event.target.value)}>{workspace.guardians.map(g => <option key={g.parent_id} value={g.parent_id}>{g.name || "Guardian"} · {g.linked_children} linked children{g.requires_mfa ? " · authenticator required" : ""}</option>)}</select></label>
                <div className="grid gap-4 sm:grid-cols-[140px_minmax(0,1fr)]"><label className="block space-y-2 text-sm font-semibold"><span>New sign-in method</span><select className="field" value={channel} onChange={event => { setChannel(event.target.value as "email" | "phone"); setContact(""); }}><option value="email">Email</option><option value="phone">Mobile OTP</option></select></label>
                  <label className="block min-w-0 space-y-2 text-sm font-semibold"><span>{channel === "email" ? "New email address" : "New Indian mobile"}</span><input className="field" type={channel === "email" ? "email" : "tel"} required maxLength={channel === "email" ? 254 : 25} value={contact} onChange={event => setContact(event.target.value)} /></label></div>
                <label className="block space-y-2 text-sm font-semibold"><span>School verification reason</span><textarea className="field !min-h-24" required minLength={5} maxLength={300} value={reason} onChange={event => setReason(event.target.value)} /></label>
                <p className="text-xs leading-6 muted">Use a school verification reference. Do not enter Aadhaar numbers, document scans, passwords or OTPs. Mobile recovery can be completed only after funded SMS verification is activated.</p>
                <button className={primary}>Request independent review</button>
              </fieldset></form>}
              <div className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Recent recovery requests</h3><span className="text-xs muted">Latest {workspace.cases.length} of {workspace.total_cases}</span></div>
                {!workspace.cases.length ? <p className="text-sm muted">No recovery requests yet.</p> : <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] px-4">{workspace.cases.map(c => <li key={c.id} className="space-y-2 py-4"><div className="flex flex-wrap justify-between gap-2"><p className="min-w-0 break-words text-sm font-semibold">{c.guardian_name || "Guardian"} · {c.contact}</p><span className="text-xs font-semibold capitalize">{c.status}</span></div><p className="text-xs leading-6 muted">{c.requester_name || "School staff"} · Version {c.version} · Expires {date(c.expires_at)} IST{c.requires_mfa ? " · Replacement authenticator required" : ""}</p>
                  {(c.can_review || c.can_cancel) && <div className="flex flex-wrap gap-2">{c.can_review && <><button className={button} disabled={locked} onClick={() => { setReview({ record: c, decision: "approve" }); setReviewReason(""); }}>Review and approve</button><button className={button} disabled={locked} onClick={() => { setReview({ record: c, decision: "reject" }); setReviewReason(""); }}>Reject</button></>}{c.can_cancel && <button className={button} disabled={locked} onClick={() => { setReview({ record: c, decision: "cancel" }); setReviewReason(""); }}>Cancel recovery</button>}</div>}
                </li>)}</ul>}
              </div>
            </>}
            {review && <form onSubmit={decide} className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4" aria-label="Review guardian recovery"><p className="break-words text-sm font-semibold capitalize">{review.decision}: {review.record.guardian_name || "Guardian"} → {review.record.contact}</p><p className="text-sm leading-6 muted">Confirm the guardian&apos;s identity and new contact independently. Approval will issue a one-use link; access changes only after that verified account accepts.</p><label className="block space-y-2 text-sm font-semibold"><span>Independent review reason</span><textarea className="field !min-h-24" required minLength={5} maxLength={300} disabled={locked} value={reviewReason} onChange={event => setReviewReason(event.target.value)} /></label><div className="flex flex-wrap gap-2"><button className={primary} disabled={locked}>Confirm {review.decision}</button><button type="button" className={button} disabled={locked} onClick={() => setReview(undefined)}>Keep unchanged</button></div></form>}
            {issued && <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4"><label className="block space-y-2 text-sm font-semibold"><span>Private recovery link</span><input className="field" readOnly value={issued.url} /></label><p className="text-xs leading-6 muted">Expires {date(issued.expiresAt)} IST. Copy before leaving this screen. If lost, cancel this recovery and request a replacement.</p><button type="button" className={button} onClick={() => void navigator.clipboard.writeText(issued.url).then(() => setNotice("Private recovery link copied."), () => setError("Copy the recovery link from the field above."))}><Copy size={16} aria-hidden="true" />Copy recovery link</button></div>}
            {intent && !pending && <div className="space-y-3"><p className="text-sm muted">This save may have completed. Retry its exact request before making another change.</p><button className={primary} onClick={() => void submit(intent)}>Retry same recovery request</button></div>}
            <button className={button} disabled={locked} onClick={reload}><RefreshCw size={16} aria-hidden="true" />Reload recovery records</button>
          </>}
      {error && <p role="alert" className="break-words text-sm leading-6 text-red-700 dark:text-red-300">{error}</p>}
      {notice && <p role="status" className="text-sm leading-6 text-emerald-700 dark:text-emerald-300">{notice}</p>}
    </div>
  </section>;
}
