"use client";

import Link from "next/link";
import { CalendarDays, ChevronLeft, ChevronRight, History, RefreshCw, Save } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LoadingState } from "@/components/ui/skeleton";
import { schoolDate } from "@/lib/attendance/types";
import { calendarMonthRange, loadSchoolAttendanceCalendar, saveSchoolAttendanceCalendar, SchoolCalendarError, validateSchoolCalendarIntent,
  type CalendarMode, type SchoolAttendanceCalendar as CalendarRecord, type SchoolCalendarIntent } from "@/lib/attendance/calendar";

type Props = { client: SupabaseClient; userId: string; schoolId: string; onLock(value: boolean): void };
type Editor = { kind: "policy" | "exception"; expectedRevision: number; date: string; workingDays: number[]; window: string; mode: CalendarMode | ""; label: string; reason: string };
const control = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-50";
const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fullWeekdayLabels = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dateFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const formatDate = (value: string) => dateFormat.format(new Date(`${value}T00:00:00Z`));
const modeLabel = { holiday: "Holiday / closed", working: "Extra working day", inherit: "Use weekly schedule" };

export function SchoolAttendanceCalendar(props: Props) {
  return <OwnSchoolAttendanceCalendar key={`${props.userId}:${props.schoolId}`} {...props} />;
}

function OwnSchoolAttendanceCalendar({ client, userId, schoolId, onLock }: Props) {
  const [month, setMonth] = useState(() => schoolDate().slice(0, 7)), [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; data?: CalendarRecord; error?: string }>();
  const [editor, setEditor] = useState<Editor>(), [intent, setIntent] = useState<SchoolCalendarIntent>();
  const [saving, setSaving] = useState(false), [conflict, setConflict] = useState(false), [sessionChanged, setSessionChanged] = useState(false);
  const [conflictKey, setConflictKey] = useState<string>();
  const [notice, setNotice] = useState<{ error: boolean; text: string }>();
  const read = useRef<AbortController | null>(null), write = useRef<AbortController | null>(null);
  let range: { from: string; to: string } | undefined;
  try { range = calendarMonthRange(month); } catch { /* Invalid month controls do not start a request. */ }
  const from = range?.from, to = range?.to;
  const id = useId(), key = `${month}:${revision}`;
  const current: typeof loaded = !range ? { key, error: "Choose a valid calendar month." } : loaded?.key === key ? loaded : undefined;
  const calendar = current?.data, locked = !!editor || !!intent || saving;
  useEffect(() => { onLock(locked); }, [locked, onLock]);
  useEffect(() => {
    if (!locked) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [locked]);
  useEffect(() => {
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) { read.current?.abort(); write.current?.abort(); setSessionChanged(true); setLoaded(undefined); setEditor(undefined); setIntent(undefined); }
    });
    return () => { read.current?.abort(); write.current?.abort(); subscription.unsubscribe(); onLock(false); };
  }, [client, userId, onLock]);
  useEffect(() => {
    if (sessionChanged || !from || !to) return;
    const controller = new AbortController(); read.current = controller;
    loadSchoolAttendanceCalendar(client, userId, schoolId, from, to, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      setLoaded({ key, data });
      if (!data.can_edit) { setEditor(undefined); setIntent(undefined); setConflict(false); }
    }, (error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof SchoolCalendarError && error.code === "access") { setEditor(undefined); setIntent(undefined); setConflict(false); }
      setLoaded({ key, error: error instanceof SchoolCalendarError ? error.message : "School calendar could not be loaded. Reload to try again." });
    });
    return () => { controller.abort(); if (read.current === controller) read.current = null; };
  }, [client, userId, schoolId, from, to, key, sessionChanged]);

  function reload() { if (!write.current && !intent) setRevision(value => value + 1); }
  function moveMonth(offset: number) {
    if (locked) return;
    try {
      const date = new Date(`${month}-01T00:00:00Z`); date.setUTCMonth(date.getUTCMonth() + offset);
      const next = date.toISOString().slice(0, 7); calendarMonthRange(next); setMonth(next);
    } catch { /* Keep the supported date range. */ }
  }
  function begin(kind: Editor["kind"]) {
    if (!calendar?.can_edit || locked) return;
    setEditor({ kind, expectedRevision: calendar.revision, date: "", workingDays: [], window: "", mode: "", label: "", reason: "" }); setNotice(undefined); setConflict(false);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!calendar?.can_edit || !editor || write.current || conflict) return;
    const common = { schoolId, expectedRevision: editor.expectedRevision, requestId: crypto.randomUUID(), reason: editor.reason.trim() };
    const next = intent ?? (editor.kind === "policy"
      ? { ...common, kind: "policy" as const, effectiveFrom: editor.date, workingDays: editor.workingDays, correctionWindowDays: editor.window === "" ? NaN : Number(editor.window) }
      : { ...common, kind: "exception" as const, day: editor.date, mode: editor.mode as CalendarMode, label: editor.mode === "inherit" ? null : editor.label.trim() });
    const invalid = validateSchoolCalendarIntent(next);
    if (invalid || !intent && editor.date < calendar.server_today) { setNotice({ error: true, text: invalid ?? "Choose today or a future date. Existing calendar history cannot be rewritten." }); return; }
    const controller = new AbortController(); write.current = controller; read.current?.abort(); setIntent(next); setSaving(true); setNotice(undefined);
    try {
      const saved = await saveSchoolAttendanceCalendar(client, userId, next, controller.signal);
      if (controller.signal.aborted) return;
      setIntent(undefined); setEditor(undefined); setConflict(false); setRevision(value => value + 1);
      setNotice({ error: false, text: saved.replayed ? "The previous calendar save is confirmed. Reloading saved rules." : "School calendar saved. Existing attendance is unchanged." });
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = error instanceof SchoolCalendarError ? error : new SchoolCalendarError("The save could not be confirmed. Retry the same frozen calendar save.");
      if (failure.code !== "unconfirmed") setIntent(undefined);
      if (failure.code === "access") { setEditor(undefined); setLoaded({ key, error: failure.message }); }
      setConflict(failure.code === "conflict"); setConflictKey(failure.code === "conflict" ? key : undefined); setNotice({ error: true, text: failure.message });
    } finally {
      if (write.current === controller) { write.current = null; if (!controller.signal.aborted) setSaving(false); }
    }
  }

  return <section id="attendance-calendar" className="scroll-mt-24 space-y-4" aria-labelledby={`${id}-title`}>
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h2 id={`${id}-title`} className="flex items-center gap-2 text-xl font-bold"><CalendarDays size={21} aria-hidden="true" />Calendar &amp; daily attendance rules</h2>
      <p className="mt-1 text-sm leading-6 muted">One school schedule for manual and gate attendance. Changes preserve saved marks and history.</p></div>
      <button type="button" className={control} disabled={saving || !!intent || sessionChanged} onClick={reload}><RefreshCw size={15} aria-hidden="true" />Reload calendar</button></header>
    {sessionChanged ? <p role="alert" className="card p-4 text-sm">Your sign-in changed. Reopen school settings.</p>
      : !current ? <LoadingState variant="form">Loading school attendance calendar…</LoadingState>
        : current.error ? <div className="card space-y-3 p-4"><p role="alert" className="text-sm text-red-700 dark:text-red-300">{current.error}</p>
          {!range && <label className="block space-y-2 text-sm font-semibold"><span>Calendar month</span><input type="month" className="field w-auto" value={month} onChange={event => setMonth(event.target.value)} /></label>}
          {editor && !intent && <button type="button" className={control} onClick={() => { setEditor(undefined); setConflict(false); }}>Discard calendar draft</button>}</div>
          : calendar && <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3 text-xs leading-5 muted">
              <span>IST · Revision {calendar.revision} · Today {formatDate(calendar.server_today)}</span>
              <span>{calendar.can_edit ? "School Admin / Principal · verified editing access" : <>Changes require a School Admin or Principal with a verified authenticator session. <Link href="/account/settings" className="inline-flex min-h-11 items-center font-semibold text-[var(--primary)] underline">Account security</Link></>}</span>
            </div>
            <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
              <section className="card min-w-0 overflow-hidden" aria-label="Resolved school calendar"><header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] p-4">
                <div className="flex items-center gap-2"><button type="button" className={control} aria-label="Previous calendar month" disabled={locked} onClick={() => moveMonth(-1)}><ChevronLeft size={16} /></button>
                  <label className="text-sm font-semibold"><span className="sr-only">Calendar month</span><input aria-label="Calendar month" type="month" className="field w-auto" value={month} disabled={locked} onChange={event => setMonth(event.target.value)} /></label>
                  <button type="button" className={control} aria-label="Next calendar month" disabled={locked} onClick={() => moveMonth(1)}><ChevronRight size={16} /></button></div>
                <span className="text-xs muted">Server-resolved days</span></header>
                <MonthGrid calendar={calendar} />
                <p className="border-t border-[var(--border)] p-4 text-xs leading-5 muted">Working · Closed · Not configured. No calendar policy means no assumed weekly defaults. Missing scans stay Unmarked; this calendar does not create absence.</p>
              </section>
              <section className="card space-y-4 p-4" aria-label="Manage daily attendance rules">
                <div><h3 className="font-semibold">Plan a calendar change</h3><p className="mt-1 text-xs leading-5 muted">Use today or a future date. Today is locked after any attendance or gate evidence. Past records are never rewritten.</p></div>
                {!editor ? <><div className="flex flex-wrap gap-2"><button type="button" className={control} disabled={!calendar.can_edit} onClick={() => begin("policy")}>Set weekly rules</button><button type="button" className={control} disabled={!calendar.can_edit || calendar.policy_count === 0} onClick={() => begin("exception")}>Add dated exception</button></div>
                  {calendar.policy_count === 0 && <p className="text-xs leading-5 muted">Configure weekly rules before adding dated exceptions.</p>}</>
                  : <form aria-label={editor.kind === "policy" ? "School weekly attendance rules" : "School calendar exception"} className="space-y-4" onSubmit={save}>
                    <fieldset disabled={saving || !!intent || conflict} className="space-y-4">
                      <label className="block space-y-2 text-sm font-semibold"><span>{editor.kind === "policy" ? "Effective from" : "Exception date"}</span><input className="field" type="date" min={calendar.server_today} required value={editor.date} onChange={event => setEditor({ ...editor, date: event.target.value })} /></label>
                      {editor.kind === "policy" ? <>
                        <fieldset><legend className="text-sm font-semibold">Working weekdays</legend><div className="mt-2 flex flex-wrap gap-2">{weekdayLabels.map((label, day) => <label key={label} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[var(--border)] px-3 text-sm"><input type="checkbox" aria-label={fullWeekdayLabels[day]} className="size-4 accent-[var(--primary)]" checked={editor.workingDays.includes(day)} onChange={event => setEditor({ ...editor, workingDays: event.target.checked ? [...editor.workingDays, day].sort((a, b) => a - b) : editor.workingDays.filter(value => value !== day) })} />{label}</label>)}</div></fieldset>
                        <label className="block space-y-2 text-sm font-semibold"><span>Teacher correction window (calendar days)</span><input className="field" type="number" min={0} max={365} required value={editor.window} onChange={event => setEditor({ ...editor, window: event.target.value })} /></label>
                        <p className="text-xs leading-5 muted">0 disables new historical Teacher correction requests. Existing reviewed history stays intact. Submission cutoff and gate lateness times are separate settings.</p>
                      </> : <>
                        <label className="block space-y-2 text-sm font-semibold"><span>Day decision</span><select className="field" required value={editor.mode} onChange={event => setEditor({ ...editor, mode: event.target.value as CalendarMode | "", label: event.target.value === "inherit" ? "" : editor.label })}><option value="">Choose a decision</option>{Object.entries(modeLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                        {editor.mode !== "inherit" && <label className="block space-y-2 text-sm font-semibold"><span>Calendar label</span><input className="field" required maxLength={120} value={editor.label} onChange={event => setEditor({ ...editor, label: event.target.value })} /></label>}
                        <p className="text-xs leading-5 muted">A dated exception overrides the weekly schedule. “Use weekly schedule” clears that override without deleting its audit history.</p>
                      </>}
                      <label className="block space-y-2 text-sm font-semibold"><span>Change reason</span><textarea className="field" minLength={5} maxLength={300} required value={editor.reason} onChange={event => setEditor({ ...editor, reason: event.target.value })} /></label>
                    </fieldset>
                    <div className="flex flex-wrap gap-2"><button type="submit" className={`${control} bg-[var(--primary)] text-white dark:text-[var(--bg)]`} disabled={saving || conflict}><Save size={15} aria-hidden="true" />{saving ? "Saving calendar…" : intent ? "Retry same calendar save" : "Save calendar change"}</button>
                      {!intent && <button type="button" className={control} disabled={saving} onClick={() => { setEditor(undefined); setConflict(false); setNotice(undefined); }}>Cancel calendar edit</button>}</div>
                    {intent && !saving && <p className="text-xs leading-5 muted">This save has an unknown outcome. Its request and fields stay fixed until the same save is confirmed.</p>}
                    {conflict && <div className="space-y-3 rounded-xl bg-[var(--surface-2)] p-3 text-xs leading-5"><p>Your draft uses revision {editor.expectedRevision}; the verified calendar is revision {calendar.revision}. Reload the calendar, compare its saved rules and choose a future date if today is locked.</p>
                      <button type="button" className={control} disabled={current.key === conflictKey} onClick={() => { setEditor({ ...editor, expectedRevision: calendar.revision }); setConflict(false); setNotice(undefined); }}>Use displayed revision for this draft</button></div>}
                  </form>}
              </section>
            </div>
            {notice && <p role={notice.error ? "alert" : "status"} className={`text-sm ${notice.error ? "text-red-700 dark:text-red-300" : "text-emerald-800 dark:text-emerald-300"}`}>{notice.text}</p>}
            <section className="card space-y-3 p-4" aria-label="Calendar rule history"><h3 className="flex items-center gap-2 font-semibold"><History size={17} aria-hidden="true" />Saved calendar rules</h3>
              <p className="text-xs leading-5 muted">Latest {calendar.policies.length} of {calendar.policy_count} policy versions and {calendar.exceptions.length} of {calendar.exception_count} dated decisions. Day resolution uses the complete server history.</p>
              <div className="grid gap-4 md:grid-cols-2"><div><h4 className="text-sm font-semibold">Weekly policy versions</h4>{calendar.policies.length ? <ul className="mt-2 max-h-64 space-y-2 overflow-y-auto" tabIndex={0} aria-label="Weekly policy history">{calendar.policies.map(policy => <li key={policy.revision} className="rounded-xl bg-[var(--surface-2)] p-3 text-xs leading-5"><strong>From {formatDate(policy.effective_from)} · Revision {policy.revision}</strong><p>{policy.working_days.map(day => weekdayLabels[day]).join(", ")} · Teacher window {policy.correction_window_days} days</p><p className="mt-1 break-words muted">{policy.reason}</p></li>)}</ul> : <p className="mt-2 text-sm muted">No weekly policy configured.</p>}</div>
                <div><h4 className="text-sm font-semibold">Dated exceptions</h4>{calendar.exceptions.length ? <ul className="mt-2 max-h-64 space-y-2 overflow-y-auto" tabIndex={0} aria-label="Dated exception history">{calendar.exceptions.map(exception => <li key={exception.revision} className="rounded-xl bg-[var(--surface-2)] p-3 text-xs leading-5"><strong>{formatDate(exception.day)} · {modeLabel[exception.mode]}</strong><p className="break-words">{exception.label ?? "Weekly schedule inherited"} · Revision {exception.revision}</p><p className="mt-1 break-words muted">{exception.reason}</p></li>)}</ul> : <p className="mt-2 text-sm muted">No dated exceptions saved.</p>}</div></div>
            </section>
          </>}
  </section>;
}

function MonthGrid({ calendar }: { calendar: CalendarRecord }) {
  const leading = new Date(`${calendar.from}T00:00:00Z`).getUTCDay(), cells = [...Array<null>(leading).fill(null), ...calendar.days];
  return <div className="overflow-x-auto p-3"><table className="w-full table-fixed text-center text-xs" aria-label="School working and closed days"><thead><tr>{weekdayLabels.map(day => <th scope="col" key={day} className="pb-2 font-semibold muted">{day}</th>)}</tr></thead>
    <tbody>{Array.from({ length: Math.ceil(cells.length / 7) }, (_, week) => <tr key={week}>{Array.from({ length: 7 }, (_, dayIndex) => {
      const day = cells[week * 7 + dayIndex];
      return <td key={dayIndex} className="p-0.5 align-top">{day && <div className={`min-h-16 rounded-lg border p-1.5 ${day.day === calendar.server_today ? "border-[var(--primary)]" : "border-[var(--border)]"} ${day.configured && day.is_working === false ? "bg-amber-500/10" : "bg-[var(--surface-2)]"}`} title={day.label ?? undefined}>
        <time dateTime={day.day} className="block font-semibold">{Number(day.day.slice(-2))}</time><span className="mt-1 block break-words text-[10px] leading-4 muted">{!day.configured ? "Not set" : day.is_working ? "Working" : "Closed"}</span>{day.source === "exception" && <span className="sr-only">{day.label ?? "Dated exception"}</span>}
      </div>}</td>;
    })}</tr>)}</tbody></table></div>;
}
