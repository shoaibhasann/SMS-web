"use client";

import Link from "next/link";
import { BellRing, History, RefreshCw, Save } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { LoadingState } from "@/components/ui/skeleton";
import { LateAlertSettingsError, loadSchoolLateAlertSettings, saveSchoolLateAlertSettings,
  type SchoolLateAlertSettings as Policy, type SchoolLateAlertSettingsIntent } from "@/lib/notifications/late-settings";

type Props = { schoolId: string; userId: string; onLock?: (busy: boolean) => void };
type Draft = { enabled: boolean; reason: string };
const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-50";
const date = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const validReason = (value: string) => value.trim().length >= 5 && value.trim().length <= 300 && !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(value);

export function SchoolLateAlertSettings(props: Props) {
  const [client] = useState(createClient);
  return <OwnSchoolLateAlertSettings key={`${props.userId}:${props.schoolId}`} client={client} {...props} />;
}

function OwnSchoolLateAlertSettings({ client, schoolId, userId, onLock }: Props & { client: ReturnType<typeof createClient> }) {
  const [revision, setRevision] = useState(0), [loaded, setLoaded] = useState<{ revision: number; policy?: Policy; error?: string }>();
  const [draft, setDraft] = useState<Draft>(), [intent, setIntent] = useState<SchoolLateAlertSettingsIntent>();
  const [saving, setSaving] = useState(false), [sessionChanged, setSessionChanged] = useState(false), [blocked, setBlocked] = useState<string>();
  const [notice, setNotice] = useState<{ error: boolean; text: string }>();
  const read = useRef<AbortController | null>(null), write = useRef<AbortController | null>(null), lockCallback = useRef(onLock), id = useId();
  const result = loaded?.revision === revision ? loaded : undefined, policy = result?.policy;
  const enabled = intent?.enabled ?? draft?.enabled ?? policy?.enabled ?? false, reason = intent?.reason ?? draft?.reason ?? "";
  const dirty = !!draft && (!!draft.reason || draft.enabled !== policy?.enabled), locked = saving || !!intent;
  const invalidate = useCallback((message: string) => {
    read.current?.abort(); write.current?.abort(); write.current = null; setSaving(false); setLoaded(undefined); setDraft(undefined); setIntent(undefined); setNotice(undefined); setBlocked(message);
  }, []);

  useEffect(() => { lockCallback.current = onLock; onLock?.(dirty || locked); }, [dirty, locked, onLock]);

  useEffect(() => {
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) { invalidate("Your sign-in changed. Reopen school settings to check the Late alert policy."); setSessionChanged(true); }
    });
    return () => { read.current?.abort(); write.current?.abort(); subscription.unsubscribe(); lockCallback.current?.(false); };
  }, [client, userId, invalidate]);

  useEffect(() => {
    if (sessionChanged || blocked) return;
    const controller = new AbortController(); read.current = controller;
    loadSchoolLateAlertSettings(client, userId, schoolId, controller.signal).then(policy => {
      if (!controller.signal.aborted) setLoaded({ revision, policy });
    }, (failure: unknown) => {
      if (controller.signal.aborted) return;
      const error = failure instanceof LateAlertSettingsError ? failure : new LateAlertSettingsError("The saved Late alert policy could not be checked. Reload to try again.");
      if (error.code !== "unconfirmed") invalidate(error.message); else setLoaded({ revision, error: error.message });
    });
    return () => { controller.abort(); if (read.current === controller) read.current = null; };
  }, [client, userId, schoolId, revision, blocked, sessionChanged, invalidate]);

  useEffect(() => {
    if (sessionChanged) return;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      read.current?.abort(); write.current?.abort(); write.current = null; setSaving(false); setBlocked(undefined); setRevision(value => value + 1);
      if (intent) setNotice({ error: true, text: "The previous save may already have completed. Its exact request is retained; check the refreshed policy and retry the same save to confirm it." });
      else { setDraft(undefined); setNotice(dirty ? { error: false, text: "Saved policy refreshed. Unsaved Late alert changes were cleared when you returned." } : undefined); }
    };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [dirty, intent, sessionChanged]);

  useEffect(() => {
    if (!dirty && !locked) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, locked]);

  function reload() {
    if (write.current || saving || sessionChanged) return;
    if (dirty && !intent && !window.confirm("Reload the saved Late alert policy and discard your unsaved changes?")) return;
    read.current?.abort(); if (!intent) setDraft(undefined); setBlocked(undefined); setRevision(value => value + 1); setNotice(undefined);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!policy || write.current || saving || blocked || sessionChanged || !intent && enabled === policy.enabled) return;
    if (!validReason(reason)) { setNotice({ error: true, text: "Use a 5–300 character reason without control characters." }); return; }
    let next: SchoolLateAlertSettingsIntent;
    try { next = intent ?? Object.freeze({ schoolId, expectedVersion: policy.version, enabled, reason: reason.trim(), requestId: crypto.randomUUID() }); }
    catch { setNotice({ error: true, text: "A secure change request could not be created. Reload before saving the policy." }); return; }
    const controller = new AbortController(); write.current = controller; read.current?.abort(); setIntent(next); setSaving(true); setNotice(undefined);
    try {
      const saved = await saveSchoolLateAlertSettings(client, userId, next, controller.signal);
      if (controller.signal.aborted) return;
      setIntent(undefined); setDraft(undefined); setRevision(value => value + 1);
      setNotice({ error: false, text: saved.replayed ? "The previous policy change is confirmed. Reloading the current saved policy." : "Policy change confirmed. Reloading the current saved policy." });
    } catch (failure) {
      if (controller.signal.aborted) return;
      const error = failure instanceof LateAlertSettingsError ? failure : new LateAlertSettingsError("The save outcome is unknown. Retry the same frozen policy save.");
      if (error.code === "unconfirmed") setNotice({ error: true, text: error.message }); else invalidate(error.message);
    } finally { if (write.current === controller) { write.current = null; if (!controller.signal.aborted) setSaving(false); } }
  }

  return <section id="late-attendance-alerts" className="card min-w-0 scroll-mt-24 overflow-hidden" aria-labelledby={`${id}-heading`}>
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] p-4 sm:p-5"><div className="flex min-w-0 flex-1 gap-3"><BellRing size={21} className="mt-0.5 shrink-0 text-[var(--primary)]" aria-hidden="true" /><div><h2 id={`${id}-heading`} className="text-lg font-semibold">Late attendance alerts</h2><p className="mt-1 text-sm leading-6 muted">School policy for Guardian in-app updates when a pupil is marked Late.</p></div></div><button type="button" className={button} disabled={saving || sessionChanged} onClick={reload}><RefreshCw size={15} aria-hidden="true" />Reload saved Late policy</button></header>
    <div className="space-y-4 p-4 sm:p-5">
      <p className="rounded-xl bg-[var(--surface-2)] p-3 text-xs leading-6 muted">Off until a verified School Admin or Principal explicitly enables it. Changes start or stop new Late alerts; they do not backfill old attendance. Retained alerts remain subject to current Guardian/child access and a source record that is still Late.</p>
      {sessionChanged ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">Your sign-in changed. Reopen school settings to check the Late alert policy.</p>
        : blocked ? <div className="space-y-3"><p role="alert" className="text-sm text-red-700 dark:text-red-300">{blocked}</p><p className="text-xs leading-5 muted">Reload the saved policy before making another change. School and authenticator access are checked by the server.</p><Link href="/account/settings" className={`${button} text-[var(--primary)]`}>Account security</Link></div>
          : !result ? <LoadingState variant="form">Checking Late alert policy…</LoadingState>
            : result.error ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{result.error}</p>
              : policy && <>
                <div className="flex flex-wrap items-center justify-between gap-3"><p className="rounded-full bg-[var(--surface-2)] px-3 py-1.5 text-xs font-semibold">Saved policy: {policy.enabled ? "On" : "Off"}</p><p className="text-xs muted">Version {policy.version}</p></div>
                <form aria-label="Change school Late alert policy" className="space-y-4" onSubmit={event => void save(event)}><fieldset disabled={locked} className="min-w-0 space-y-4"><label className="flex min-h-11 items-start gap-3 rounded-xl border border-[var(--border)] p-3 text-sm font-semibold"><input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" checked={enabled} onChange={event => setDraft({ enabled: event.target.checked, reason })} /><span>Send Guardian in-app Late attendance alerts</span></label><label className="block space-y-2 text-sm font-semibold"><span>Late policy change reason</span><textarea className="field min-h-24" minLength={5} maxLength={300} required value={reason} onChange={event => setDraft({ enabled, reason: event.target.value })} /></label></fieldset>
                  <div className="flex flex-wrap gap-2"><button type="submit" className={button} disabled={saving || !validReason(reason) || !intent && enabled === policy.enabled}><Save size={15} aria-hidden="true" />{saving ? "Saving Late policy…" : intent ? "Retry same Late policy save" : "Save Late alert policy"}</button>{!intent && dirty && <button type="button" className={button} disabled={saving} onClick={() => { setDraft(undefined); setNotice(undefined); }}>Discard Late policy draft</button>}</div>
                </form>
                {intent && !saving && <p className="text-xs leading-6 muted">This save has an unknown outcome. Its school, version, choice, reason and request ID stay fixed. Retry this exact save; do not start a replacement change. A later policy may already be current.</p>}
                <section aria-label="Late alert policy history" className="min-w-0 space-y-3 border-t border-[var(--border)] pt-4"><h3 className="flex items-center gap-2 text-sm font-semibold"><History size={16} aria-hidden="true" />Policy history</h3><p className="text-xs leading-5 muted">Latest {policy.history.length} saved versions; at most 20 are shown. Earlier policy history is retained.</p>{policy.history.length ? <ol className="max-h-72 space-y-2 overflow-y-auto" tabIndex={0} aria-label="Recent Late alert policy changes">{policy.history.map(item => <li key={item.version} className="min-w-0 space-y-1 rounded-xl bg-[var(--surface-2)] p-3 text-xs leading-6"><p className="font-semibold">Version {item.version} · {item.enabled ? "On" : "Off"} · <time dateTime={item.created_at}>{date.format(new Date(item.created_at))} IST</time></p><p className="break-words muted">{item.reason}</p><p className="break-all font-mono text-[11px] muted">Changed by {item.actor_id}</p></li>)}</ol> : <p className="text-sm muted">No policy changes saved. Late alerts are off by default.</p>}</section>
              </>}
      {!sessionChanged && !blocked && notice && <p role={notice.error ? "alert" : "status"} className={`text-sm leading-6 ${notice.error ? "text-red-700 dark:text-red-300" : "text-emerald-800 dark:text-emerald-300"}`}>{notice.text}</p>}
      <p className="text-xs leading-6 muted">Absence alerts and Guardian arrival/exit choices are separate and unchanged. This policy does not enable phone push, SMS or email.</p>
    </div>
  </section>;
}
