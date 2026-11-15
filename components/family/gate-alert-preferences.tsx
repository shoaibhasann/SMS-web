"use client";

import { LogIn, LogOut, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { LoadingState } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/client";
import { GateAlertPreferencesError, loadGateAlertPreferences, saveGateAlertPreferences, type GateAlertPreference } from "@/lib/notifications/gate-preferences";
import { notifyFamilyNotificationsChanged } from "@/lib/notifications/family";

const control = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)] disabled:opacity-50";
type Result = { children: GateAlertPreference[] } | { error: string };
const same = (a: GateAlertPreference, b: GateAlertPreference) => a.arrival === b.arrival && a.exit === b.exit;

export function GateAlertPreferences({ userId }: { userId: string }) {
  return <OwnGateAlertPreferences key={userId} userId={userId} />;
}

function OwnGateAlertPreferences({ userId }: { userId: string }) {
  const [client] = useState(createClient), [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<{ revision: number; result: Result }>();
  const [draft, setDraft] = useState<GateAlertPreference[]>([]);
  const [sessionChanged, setSessionChanged] = useState(false), [saving, setSaving] = useState<string>();
  const [notice, setNotice] = useState<{ error: boolean; text: string }>(), [needsRefresh, setNeedsRefresh] = useState(false);
  const read = useRef<AbortController | null>(null), write = useRef<AbortController | null>(null);
  const id = useId(), result = loaded?.revision === revision ? loaded.result : undefined;
  const children = result && "children" in result ? result.children : undefined;
  const savedById = new Map(children?.map(child => [child.student_id, child]));
  const dirty = draft.some(child => { const saved = savedById.get(child.student_id); return saved && !same(saved, child); });

  useEffect(() => {
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) {
        read.current?.abort(); write.current?.abort(); setSessionChanged(true); setDraft([]); setLoaded(undefined); setNotice(undefined);
      }
    });
    return () => { read.current?.abort(); write.current?.abort(); subscription.unsubscribe(); };
  }, [client, userId]);
  useEffect(() => {
    if (sessionChanged) return;
    const controller = new AbortController(); read.current = controller;
    loadGateAlertPreferences(client, userId, controller.signal).then((rows) => {
      if (!controller.signal.aborted) { setLoaded({ revision, result: { children: rows } }); setDraft(rows); setNeedsRefresh(false); }
    }, (error: unknown) => {
      if (!controller.signal.aborted) {
        setDraft([]); setLoaded({ revision, result: { error: error instanceof GateAlertPreferencesError ? error.message : "Gate preferences could not be loaded. Refresh to try again." } });
      }
    });
    return () => { controller.abort(); if (read.current === controller) read.current = null; };
  }, [client, userId, revision, sessionChanged]);

  async function save(event: FormEvent, next: GateAlertPreference) {
    event.preventDefault();
    if (write.current || sessionChanged || needsRefresh || !children?.some(child => child.student_id === next.student_id && child.preference_id === next.preference_id && !same(child, next))) return;
    const controller = new AbortController(); write.current = controller; read.current?.abort(); setSaving(next.student_id); setNotice(undefined);
    try {
      await saveGateAlertPreferences(client, userId, next, controller.signal);
      if (controller.signal.aborted) return;
      const rows = await loadGateAlertPreferences(client, userId, controller.signal);
      if (controller.signal.aborted) return;
      const saved = rows.find(child => child.student_id === next.student_id);
      setLoaded({ revision, result: { children: rows } });
      setDraft(previous => {
        const draftsById = new Map(previous.map(child => [child.student_id, child]));
        return rows.map(row => {
          const baseline = savedById.get(row.student_id), local = draftsById.get(row.student_id);
          return row.student_id !== next.student_id && baseline && local && row.preference_id === baseline.preference_id
            && local.preference_id === row.preference_id && row.version === baseline.version && local.version === baseline.version
            ? { ...row, arrival: local.arrival, exit: local.exit } : row;
        });
      });
      notifyFamilyNotificationsChanged(userId, "parent", { keepCursor: true });
      const confirmed = !!saved && saved.preference_id === next.preference_id && same(saved, next);
      setNotice({ error: !confirmed, text: confirmed
        ? `Gate preferences saved for ${saved.student_name}. Absence alerts are unchanged.`
        : "Your linked-child access or saved preferences changed. The current settings have been refreshed." });
    } catch (error) {
      if (controller.signal.aborted) return;
      const denied = error instanceof GateAlertPreferencesError && error.code === "access";
      if (denied) { setLoaded({ revision, result: { error: error.message } }); setDraft([]); notifyFamilyNotificationsChanged(userId, "parent"); }
      setNeedsRefresh(true);
      setNotice({ error: true, text: error instanceof GateAlertPreferencesError ? error.message : "The save could not be confirmed. Refresh gate preferences before saving again." });
    } finally {
      if (write.current === controller) { write.current = null; if (!controller.signal.aborted) setSaving(undefined); }
    }
  }

  return <section className="card overflow-hidden" aria-labelledby={`${id}-title`} aria-busy={!result && !sessionChanged}>
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] p-4 sm:p-5">
      <div className="min-w-0 flex-1"><h2 id={`${id}-title`} className="flex items-center gap-2 font-bold"><LogIn size={18} aria-hidden="true" />Gate alerts</h2>
        <p className="mt-1 text-sm leading-6 muted">Get an alert when your child enters or leaves the school gate. Both are off until you turn them on, and only affect your account. Turning one off also hides its past gate alerts.</p></div>
      <button type="button" className={control} aria-label="Refresh gate preferences" disabled={!!saving || sessionChanged}
        onClick={() => {
          if (dirty && !window.confirm("Reload saved gate preferences? Your unsaved selections will be replaced.")) return;
          setNotice(undefined); setDraft([]); setRevision(value => value + 1);
        }}><RefreshCw size={15} aria-hidden="true" />Refresh</button>
    </header>
    <div className="space-y-3 p-4 sm:p-5">
      <p className="flex items-start gap-2 rounded-xl bg-[var(--surface-2)] px-3 py-2.5 text-xs leading-5 muted"><ShieldCheck size={16} className="mt-0.5 shrink-0" aria-hidden="true" />Absence alerts always stay on. Gate alerts show here in Notifications only (not SMS or phone push) and start once the school sets up gate scanning.</p>
      {sessionChanged ? <p role="alert" className="text-sm muted">Your sign-in changed. Reopen Notifications to manage gate alerts.</p>
        : !result ? <LoadingState variant="list">Loading gate preferences…</LoadingState>
          : "error" in result ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{result.error}</p>
            : children?.length === 0 ? <p className="text-sm muted">No linked children are available for gate preferences.</p>
              : <div className="grid gap-3 lg:grid-cols-2">{draft.map(child => {
                const saved = savedById.get(child.student_id), dirty = !!saved && !same(saved, child);
                return <form key={child.student_id} aria-label={`Gate alerts for ${child.student_name}`} onSubmit={event => void save(event, child)} className="min-w-0 rounded-xl border border-[var(--border)] p-3.5">
                  <h3 className="break-words text-sm font-semibold">{child.student_name}</h3>
                  <fieldset disabled={!!saving || needsRefresh} className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1"><legend className="sr-only">{child.student_name} gate alerts</legend>
                    {(["arrival", "exit"] as const).map(kind => <label key={kind} className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm">
                      <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={child[kind]} aria-label={`${kind === "arrival" ? "Arrival" : "Exit"} alerts for ${child.student_name}`}
                        onChange={event => setDraft(rows => rows.map(row => row.student_id === child.student_id ? { ...row, [kind]: event.target.checked } : row))} />
                      {kind === "arrival" ? <LogIn size={15} aria-hidden="true" /> : <LogOut size={15} aria-hidden="true" />}{kind === "arrival" ? "Arrival" : "Exit"}
                    </label>)}
                    <button type="submit" className={`${control} ml-auto`} disabled={!dirty}>{saving === child.student_id ? "Saving…" : "Save"}</button>
                  </fieldset>
                </form>;
              })}</div>}
      {!sessionChanged && notice && !(result && "error" in result) && <p role={notice.error ? "alert" : "status"} className={`text-sm ${notice.error ? "text-red-700 dark:text-red-300" : "text-emerald-800 dark:text-emerald-300"}`}>{notice.text}</p>}
      {!sessionChanged && needsRefresh && children && <p className="text-xs leading-5 muted">Refresh gate preferences to confirm current child access and saved choices before another change.</p>}
    </div>
  </section>;
}
