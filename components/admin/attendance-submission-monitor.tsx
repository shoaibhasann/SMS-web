"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { CalendarCheck, RefreshCw } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { LoadingState } from "@/components/ui/skeleton";

type SectionProgress = {
  section_id: string;
  class_name: string;
  section_name: string;
  expected_count: number;
  marked_count: number;
  unmarked_count: number;
  status: "complete" | "partial" | "unmarked";
  is_pending: boolean;
};

type Monitor = {
  day: string;
  as_of: string;
  cutoff_time: string | null;
  cutoff_at: string | null;
  revision: number;
  can_edit: boolean;
  roster_issue_count: number;
  session_state: "active" | "missing" | "ambiguous" | "outside_dates";
  sections: SectionProgress[];
};

const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50";
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function validMonitor(data: unknown): data is Monitor {
  const record = data as Monitor | null;
  return Boolean(record && typeof record.day === "string" && typeof record.as_of === "string"
    && (record.cutoff_time === null || typeof record.cutoff_time === "string")
    && (record.cutoff_at === null || typeof record.cutoff_at === "string")
    && count(record.revision) && count(record.roster_issue_count) && typeof record.can_edit === "boolean"
    && ["active", "missing", "ambiguous", "outside_dates"].includes(record.session_state)
    && Array.isArray(record.sections) && record.sections.every((section) => section
      && typeof section.section_id === "string" && typeof section.class_name === "string"
      && typeof section.section_name === "string" && count(section.expected_count)
      && count(section.marked_count) && count(section.unmarked_count)
      && ["complete", "partial", "unmarked"].includes(section.status) && typeof section.is_pending === "boolean"));
}

export function AttendanceSubmissionMonitor({ schoolId, userId, settings = false, disabled = false,
  refreshVersion = 0, onBusyChange }: {
  schoolId: string;
  userId: string;
  settings?: boolean;
  disabled?: boolean;
  refreshVersion?: number;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [client] = useState(createClient);
  const [version, setVersion] = useState(0);
  const [response, setResponse] = useState<{ key: string; schoolId: string; record?: Monitor; error?: string }>();
  const [sessionChanged, setSessionChanged] = useState(false);
  const key = `${schoolId}:${refreshVersion}:${version}`;
  const record = response?.key === key ? response.record : undefined;
  const error = response?.key === key ? response.error : undefined;
  const editorRecord = response?.schoolId === schoolId ? response.record : undefined;
  const headingId = useId();
  const refresh = useCallback(() => setVersion((value) => value + 1), []);

  useEffect(() => {
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) setSessionChanged(true);
    });
    return () => subscription.unsubscribe();
  }, [client, userId]);

  useEffect(() => {
    if (sessionChanged) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const { data, error: requestError } = await client.rpc("get_attendance_submission_monitor", { p_school_id: schoolId })
          .abortSignal(controller.signal).returns<unknown>();
        if (requestError || !validMonitor(data)) throw requestError ?? new Error();
        if (!controller.signal.aborted) setResponse({ key, schoolId, record: data });
      } catch {
        if (!controller.signal.aborted) setResponse((previous) => ({ key, schoolId,
          record: previous?.schoolId === schoolId ? previous.record : undefined,
          error: "Attendance progress could not be loaded. Refresh to try again." }));
      }
    })();
    return () => controller.abort();
  }, [client, key, schoolId, sessionChanged]);

  useEffect(() => {
    if (sessionChanged || disabled) return;
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 60_000);
    function visible() { if (document.visibilityState === "visible") refresh(); }
    document.addEventListener("visibilitychange", visible);
    const cutoffDelay = record?.cutoff_at ? Date.parse(record.cutoff_at) - Date.parse(record.as_of) : 0;
    const cutoff = cutoffDelay > 0 && cutoffDelay <= 60_000 ? window.setTimeout(refresh, cutoffDelay + 100) : undefined;
    return () => {
      window.clearInterval(interval);
      if (cutoff !== undefined) window.clearTimeout(cutoff);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [disabled, record, refresh, sessionChanged]);

  const pending = record?.sections.filter((section) => section.is_pending).length ?? 0;

  return (
    <section className="card overflow-hidden" aria-labelledby={headingId} aria-busy={!sessionChanged && !record && !error}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] p-4">
        <div className="flex items-start gap-3">
          <CalendarCheck size={21} className="mt-1 shrink-0 text-blue-600" aria-hidden="true" />
          <div>
            <h2 id={headingId} className="font-bold">Today’s attendance progress</h2>
            <p className="mt-1 text-sm muted">Daily registers across enrolled sections.</p>
          </div>
        </div>
        <button type="button" className={button} disabled={disabled || sessionChanged} onClick={refresh}
          aria-label="Refresh attendance progress"><RefreshCw size={15} aria-hidden="true" /> Refresh</button>
      </header>
      {sessionChanged ? <p role="alert" className="p-4 text-sm muted">Your sign-in changed. Reopen this page to check attendance progress.</p>
        : error ? <p role="alert" className="p-4 text-sm text-red-700 dark:text-red-300">{error}</p>
          : !record ? <LoadingState variant="list" className="p-4 text-sm muted">Loading attendance progress…</LoadingState>
            : <>
              <div className="space-y-2 p-4">
                <p className="text-sm muted">{record.day} · IST · {record.cutoff_time ? `Daily cutoff ${record.cutoff_time}` : "Cutoff not configured"}</p>
                {record.roster_issue_count > 0 && <p role="alert" className="text-sm text-amber-800 dark:text-amber-300">
                  {record.roster_issue_count} roster {record.roster_issue_count === 1 ? "record needs" : "records need"} a valid active class and section. Review the student placements to complete the school register.
                </p>}
                {record.session_state === "active" && <p role="status" className={`text-sm font-semibold ${pending ? "text-amber-800 dark:text-amber-300" : "muted"}`}>
                  {pending ? `${pending} ${pending === 1 ? "section has" : "sections have"} pending attendance after cutoff.`
                    : "Complete means every pupil in the current register has a saved mark."}
                </p>}
                {record.session_state !== "active" ? <p className="text-sm muted">{record.session_state === "outside_dates"
                  ? "Today is outside the current academic year dates."
                  : "Set exactly one current academic year to monitor today’s registers."}</p>
                  : record.sections.length === 0 ? <p className="text-sm muted">{record.roster_issue_count > 0
                    ? "Fix the student placements to see their attendance registers."
                    : "No enrolled sections need attendance today."}</p>
                    : <ul className="divide-y divide-[var(--border)]">
                      {record.sections.map((section) => (
                        <li key={section.section_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                          <div className="min-w-0">
                            <p className="break-words font-semibold">{section.class_name} · {section.section_name}</p>
                            <p className="mt-1 text-sm muted">{section.marked_count} of {section.expected_count} marked · {section.unmarked_count} unmarked</p>
                          </div>
                          <span className={`rounded-full px-3 py-1 text-xs font-bold ${section.is_pending ? "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
                            : section.status === "complete" ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200" : "bg-[var(--surface-2)] muted"}`}>
                            {section.is_pending ? "Pending" : section.status === "complete" ? "Complete" : section.status === "partial" ? "Partial" : "Unmarked"}
                          </span>
                        </li>
                      ))}
                    </ul>}
              </div>
              {!settings && <footer className="border-t border-[var(--border)] px-4 py-2">
                <Link href="/modules/attendance" className="inline-flex min-h-11 items-center text-sm font-semibold text-blue-700 dark:text-blue-300">Open Attendance</Link>
              </footer>}
            </>}
      {settings && !sessionChanged && editorRecord?.can_edit && <CutoffEditor key={schoolId} client={client} schoolId={schoolId} record={editorRecord}
        disabled={disabled || Boolean(error)} onSaved={refresh} onBusyChange={onBusyChange} />}
    </section>
  );
}

function CutoffEditor({ client, schoolId, record, disabled, onSaved, onBusyChange }: {
  client: ReturnType<typeof createClient>;
  schoolId: string;
  record: Monitor;
  disabled: boolean;
  onSaved: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [time, setTime] = useState("");
  const [reason, setReason] = useState("");
  const [expectedRevision, setExpectedRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || inFlight.current || reason.trim().length < 5) return;
    const controller = new AbortController();
    request.current = controller;
    inFlight.current = true;
    setSaving(true);
    setError("");
    onBusyChange?.(true);
    try {
      const { data, error: saveError } = await client.rpc("update_attendance_submission_cutoff", {
        p_school_id: schoolId, p_cutoff_time: time || null, p_expected_revision: expectedRevision, p_reason: reason.trim(),
      }).abortSignal(controller.signal).returns<unknown>();
      if (controller.signal.aborted) return;
      if (saveError) throw saveError;
      if (!data || typeof data !== "object" || !("revision" in data) || !("cutoff_time" in data)
        || !count(data.revision) || (data.revision as number) < expectedRevision || data.cutoff_time !== (time || null)) throw new Error();
      setEditing(false);
      onSaved();
    } catch (cause) {
      if (!controller.signal.aborted) {
        const code = (cause as { code?: string })?.code;
        setError(code === "40001" || code === "55000" ? "The cutoff changed elsewhere. Cancel, refresh progress and reopen settings before saving."
          : code === "42501" ? "Only this school’s administrator can change the cutoff."
            : "The cutoff could not be saved. Check the time and reason, then try again.");
      }
    } finally {
      inFlight.current = false;
      onBusyChange?.(false);
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  return (
    <div className="border-t border-[var(--border)] p-4">
      {!editing ? <button type="button" className={button} disabled={disabled} onClick={() => {
        setTime(record.cutoff_time ?? ""); setExpectedRevision(record.revision); setReason(""); setError(""); setEditing(true);
      }}>Configure attendance cutoff</button>
        : <form onSubmit={save} className="space-y-3" aria-label="Attendance cutoff settings">
          <h3 className="font-bold">Attendance cutoff</h3>
          <p className="text-sm muted">Choose the daily submission time in IST. Leave the time empty to disable cutoff reminders.</p>
          <label className="block max-w-xs space-y-2 text-sm font-semibold">Daily cutoff (IST)
            <input type="time" className="field" value={time} disabled={disabled || saving} onChange={(event) => setTime(event.target.value)} />
          </label>
          <label className="block space-y-2 text-sm font-semibold">Change reason
            <textarea className="field min-h-20" required minLength={5} maxLength={300} value={reason}
              disabled={disabled || saving} onChange={(event) => setReason(event.target.value)} />
          </label>
          {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={`${button} bg-blue-700 text-white`} disabled={disabled || saving || reason.trim().length < 5}>{saving ? "Saving cutoff…" : "Save attendance cutoff"}</button>
            <button type="button" className={button} disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </form>}
    </div>
  );
}
