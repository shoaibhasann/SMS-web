"use client";

import Link from "next/link";
import { FileUp, History, RefreshCw } from "lucide-react";
import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LoadingState } from "@/components/ui/skeleton";
import { validCsvCell } from "@/lib/csv";
import { SchoolCalendarError } from "@/lib/attendance/calendar";
import { historicalCalendarCsvHeader, historicalCalendarCsvMaxBytes, parseHistoricalCalendarCsv, type HistoricalCalendarCsvRow, type HistoricalCalendarRecord } from "@/lib/attendance/historical-calendar-csv";
import { importHistoricalCalendar, loadHistoricalCalendarContext, previewHistoricalCalendar, type HistoricalCalendarContext, type HistoricalCalendarImportIntent, type HistoricalCalendarPreview } from "@/lib/attendance/historical-calendar-import";

type Props = { client: SupabaseClient; userId: string; schoolId: string; disabled: boolean; onLock(value: boolean): void; onImported(): void };
const control = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-50";
const formatDate = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
const record = (row: HistoricalCalendarCsvRow): HistoricalCalendarRecord => ({ day: row.day, status: row.status as HistoricalCalendarRecord["status"], label: row.label });

export function HistoricalCalendarImport(props: Props) {
  return <OwnHistoricalCalendarImport key={`${props.userId}:${props.schoolId}`} {...props} />;
}
function OwnHistoricalCalendarImport({ client, userId, schoolId, disabled, onLock, onImported }: Props) {
  const [open, setOpen] = useState(false), [version, setVersion] = useState(0), [loaded, setLoaded] = useState<{ version: number; data: HistoricalCalendarContext }>();
  const [yearId, setYearId] = useState(""), [rows, setRows] = useState<HistoricalCalendarCsvRow[]>([]), [fileName, setFileName] = useState("");
  const [reason, setReason] = useState(""), [acknowledged, setAcknowledged] = useState(false), [preview, setPreview] = useState<HistoricalCalendarPreview>();
  const [intent, setIntent] = useState<HistoricalCalendarImportIntent>(), [busy, setBusy] = useState<"file" | "preview" | "save">();
  const [sessionChanged, setSessionChanged] = useState(false), [error, setError] = useState<string>(), [success, setSuccess] = useState<string>();
  const read = useRef<AbortController | null>(null), action = useRef<AbortController | null>(null), fileGeneration = useRef(0), alive = useRef(true);
  const context = loaded?.version === version ? loaded.data : undefined;
  const locked = !!busy || !!intent || !!fileName || rows.length > 0 || !!reason, frozen = !!intent;
  const reasonValid = reason.trim().length >= 5 && validCsvCell(reason.trim(), 300);
  const id = useId(), invalidRows = rows.filter(row => row.issue).length;
  useEffect(() => { onLock(locked); }, [locked, onLock]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; read.current?.abort(); action.current?.abort(); onLock(false); }; }, [onLock]);
  useEffect(() => {
    if (!open) return;
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id === userId) return;
      fileGeneration.current++; read.current?.abort(); action.current?.abort(); setSessionChanged(true); setLoaded(undefined); setRows([]); setFileName("");
      setPreview(undefined); setIntent(undefined); setBusy(undefined); setReason(""); setAcknowledged(false); setSuccess(undefined); setError(undefined);
    });
    return () => subscription.unsubscribe();
  }, [client, userId, open]);
  useEffect(() => {
    if (!open || sessionChanged) return;
    const controller = new AbortController(); read.current = controller;
    loadHistoricalCalendarContext(client, userId, schoolId, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      setLoaded({ version, data }); setYearId(value => data.years.some(year => year.id === value) ? value : "");
    }, (failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof SchoolCalendarError ? failure.message : "Historical calendar could not be loaded. Reload to try again.");
    });
    return () => { controller.abort(); if (read.current === controller) read.current = null; };
  }, [client, userId, schoolId, open, version, sessionChanged]);

  function discard() {
    if (busy || intent) return;
    fileGeneration.current++; setRows([]); setFileName(""); setReason(""); setPreview(undefined); setAcknowledged(false); setError(undefined); setSuccess(undefined);
  }
  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file || busy || frozen || disabled || !context?.can_import) return;
    const generation = ++fileGeneration.current; setBusy("file"); setRows([]); setFileName(file.name); setPreview(undefined); setAcknowledged(false); setError(undefined); setSuccess(undefined);
    try {
      if (!file.name.toLowerCase().endsWith(".csv") || file.size > historicalCalendarCsvMaxBytes) throw new Error("Choose a .csv file that is 64 KB or smaller.");
      const value = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      if (!alive.current || generation !== fileGeneration.current) return;
      setRows(parseHistoricalCalendarCsv(value));
    } catch (failure) {
      if (alive.current && generation === fileGeneration.current) setError(failure instanceof Error ? failure.message : "Use a valid UTF-8 CSV file.");
    } finally {
      if (alive.current && generation === fileGeneration.current) setBusy(undefined);
    }
  }
  async function review() {
    if (!context?.can_import || disabled || busy || intent || invalidRows || !rows.length || !yearId || action.current) return;
    const controller = new AbortController(); action.current = controller; setBusy("preview"); setPreview(undefined); setAcknowledged(false); setError(undefined); setSuccess(undefined);
    try {
      const result = await previewHistoricalCalendar(client, userId, schoolId, yearId, rows.map(record), controller.signal);
      if (!controller.signal.aborted) setPreview(result);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof SchoolCalendarError ? failure.message : "The preview could not be confirmed. Try a fresh server preview.");
    } finally {
      if (action.current === controller) { action.current = null; if (!controller.signal.aborted) setBusy(undefined); }
    }
  }
  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (busy || disabled || action.current || !context?.can_import || (!intent && (!preview?.can_import || !acknowledged || !reasonValid))) return;
    const next = intent ?? { schoolId, academicYearId: yearId, rows: rows.map(record), expectedRevision: preview!.revision, previewToken: preview!.preview_token,
      acknowledgeImpact: true as const, reason: reason.trim(), requestId: crypto.randomUUID() };
    const controller = new AbortController(); action.current = controller; setIntent(next); setBusy("save"); setError(undefined); setSuccess(undefined);
    try {
      const result = await importHistoricalCalendar(client, userId, next, controller.signal);
      if (controller.signal.aborted) return;
      setIntent(undefined); setRows([]); setFileName(""); setReason(""); setAcknowledged(false); setPreview(undefined);
      setSuccess(`${result.replayed ? "Previous import confirmed" : "Historical calendar imported"}: ${result.importedRows} dates (${result.workingRows} working, ${result.holidayRows} holidays), revision ${result.revision}. Saved attendance is unchanged.`);
      setVersion(value => value + 1); onImported();
    } catch (failure) {
      if (controller.signal.aborted) return;
      const problem = failure instanceof SchoolCalendarError ? failure : new SchoolCalendarError("The import outcome is unknown. Retry the same frozen import.");
      if (problem.code !== "unconfirmed" && problem.code !== "access") { setIntent(undefined); setPreview(undefined); setAcknowledged(false); }
      setError(problem.message);
    } finally {
      if (action.current === controller) { action.current = null; if (!controller.signal.aborted) setBusy(undefined); }
    }
  }

  return <section className="card min-w-0 overflow-hidden" aria-labelledby={`${id}-title`}>
    <header className="flex flex-wrap items-start justify-between gap-3 p-4"><div><h3 id={`${id}-title`} className="flex items-center gap-2 font-semibold"><FileUp size={17} aria-hidden="true" />Historical calendar import</h3>
      <p className="mt-1 max-w-3xl text-xs leading-5 muted">Fill missing school calendar dates from an approved historical record. Existing calendar decisions and attendance marks cannot be overwritten.</p></div>
      <button type="button" className={control} aria-expanded={open} aria-controls={`${id}-content`} disabled={disabled || locked || sessionChanged} onClick={() => { setOpen(value => !value); setError(undefined); }}>{open ? "Close import" : "Import historical CSV"}</button></header>
    {open && <div id={`${id}-content`} className="space-y-4 border-t border-[var(--border)] p-4">
      {sessionChanged ? <p role="alert" className="text-sm">Your sign-in changed. Reopen school settings.</p> : <>
        {success && <p role="status" className="rounded-xl bg-emerald-500/10 p-3 text-sm text-emerald-800 dark:text-emerald-300">{success}</p>}
        {error && <p role="alert" className="rounded-xl bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
        {!context ? <>{!error && <LoadingState variant="form">Loading historical calendar import…</LoadingState>}{error && <button type="button" className={control} disabled={!!busy || frozen} onClick={() => { setError(undefined); setVersion(value => value + 1); }}>Reload import access</button>}</> : <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs leading-5 muted"><span>IST · Today {formatDate(context.server_today)} · School calendar revision {context.revision}</span>
            <button type="button" className={control} disabled={locked || disabled} onClick={() => { setError(undefined); setVersion(value => value + 1); }}><RefreshCw size={14} aria-hidden="true" />Reload import</button></div>
          {!context.can_import ? <p className="rounded-xl bg-[var(--surface-2)] p-3 text-sm leading-6">Import requires a School Admin or Principal with a verified authenticator session. <Link href="/account/settings" className="font-semibold text-[var(--primary)] underline">Account security</Link></p>
            : <form aria-label="Historical calendar CSV import" className="space-y-4" onSubmit={confirm}>
              <fieldset disabled={disabled || !!busy || frozen} className="grid min-w-0 gap-4 lg:grid-cols-2">
                <label className="block min-w-0 space-y-2 text-sm font-semibold"><span>Historical academic year</span><select required disabled={!context.years.length} className="field" value={yearId} onChange={event => { setYearId(event.target.value); setPreview(undefined); setAcknowledged(false); setError(undefined); }}><option value="">Choose an academic year</option>{context.years.map(year => <option key={year.id} value={year.id}>{year.name} · {year.start_date} – {year.end_date}</option>)}</select></label>
                <label className="block min-w-0 space-y-2 text-sm font-semibold"><span>Calendar CSV file</span><input aria-label="Calendar CSV file" type="file" disabled={!context.years.length} accept=".csv,text/csv" className="field min-h-11 w-full min-w-0 text-xs file:mr-3 file:rounded-lg file:border-0 file:bg-[var(--surface-2)] file:px-3 file:py-2 file:font-semibold" onChange={chooseFile} /></label>
              </fieldset>
              {!context.years.length && <p role="status" className="rounded-xl bg-[var(--surface-2)] p-3 text-sm leading-6">No supported historical academic years are available. Add a school academic year with explicit start and end dates, lasting at most 366 days and beginning before today, then reload import.</p>}
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs leading-5 muted"><p>UTF-8 · 64 KB maximum · 1–366 dates · Columns: <code>{historicalCalendarCsvHeader}</code>. Dates use <code>YYYY-MM-DD</code> or <code>DD-MM-YYYY</code>; status is <code>working</code> or <code>holiday</code> (any capitalisation); every date needs a 1–120 character label.</p>
                <a className={`${control} shrink-0`} href={`data:text/csv;charset=utf-8,${encodeURIComponent(`${historicalCalendarCsvHeader}\n`)}`} download="historical-school-calendar-template.csv">Download CSV template</a></div>
              <p className="rounded-xl bg-[var(--surface-2)] p-3 text-xs leading-5 muted">Dates must be before today and within the selected year. This year sets import bounds; calendar facts apply to the entire school. Any already configured date rejects the complete batch. Fully blank rows are ignored; no other row is ever silently skipped.</p>
              {fileName && <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="min-w-0 break-all font-semibold">{fileName}{rows.length > 0 && ` · ${rows.length} dates · ${invalidRows} file errors`}</span><button type="button" className={control} disabled={!!busy || frozen} onClick={discard}>Discard import draft</button></div>}
              {rows.length > 0 && <div className="max-h-80 overflow-auto rounded-xl border border-[var(--border)]" tabIndex={0} aria-label="Historical calendar CSV preview"><table className="w-full min-w-[680px] text-left text-xs"><caption className="sr-only">CSV data rows with local validation and authoritative server review</caption><thead className="sticky top-0 bg-[var(--surface-2)]"><tr>{["Data row", "Date", "Decision", "Label", "Review / saved attendance"].map(label => <th key={label} scope="col" className="p-3 font-semibold">{label}</th>)}</tr></thead><tbody>{rows.map((row, index) => {
                const reviewed = preview?.rows[index], issue = row.issue ?? reviewed?.issue;
                return <tr key={row.rowNumber} className="border-t border-[var(--border)] align-top"><td className="p-3">{row.rowNumber}</td><td className="whitespace-nowrap p-3">{row.day || "—"}</td><td className="p-3 capitalize">{row.status || "—"}</td><td className="max-w-64 break-words p-3">{row.label || "—"}</td><td className="max-w-80 p-3">{issue ? <span className="font-semibold text-red-700 dark:text-red-300">{issue}</span> : reviewed ? <><span className="font-semibold text-emerald-800 dark:text-emerald-300">Ready</span><p className="mt-1 leading-5 muted">{reviewed.attendance_count} saved marks · {reviewed.pupils_with_marks} pupils</p>{reviewed.attendance_count > 0 && <p className="mt-1 leading-5 muted">Present {reviewed.present_count} · Late {reviewed.late_count} · Half Day {reviewed.half_day_count} · Absent {reviewed.absent_count} · Leave {reviewed.leave_count} · Holiday {reviewed.holiday_count}</p>}{reviewed.status === "working" && reviewed.holiday_count > 0 && <p className="mt-1 font-semibold text-amber-800 dark:text-amber-300">Legacy Holiday marks need a separate correction. Official rate stays unavailable for affected records.</p>}{reviewed.status === "holiday" && reviewed.attendance_count > reviewed.holiday_count && <p className="mt-1 font-semibold text-amber-800 dark:text-amber-300">Existing non-holiday marks stay saved; this date is excluded from the official rate.</p>}</> : <span className="muted">File valid · server review required</span>}</td></tr>;
              })}</tbody></table></div>}
              <button type="button" className={control} disabled={disabled || !!busy || frozen || !rows.length || invalidRows > 0 || !yearId} onClick={() => void review()}>{busy === "preview" ? "Reviewing server calendar…" : preview ? "Refresh server preview" : "Review on server"}</button>
              {preview && <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3" aria-label="Server import summary"><p className="text-sm font-semibold">Server preview · Revision {preview.revision}</p><p className="text-xs leading-5 muted">{preview.summary.valid_rows} of {preview.summary.total_rows} ready · {preview.summary.working_rows} working · {preview.summary.holiday_rows} holidays · {preview.summary.attendance_records} saved marks · {preview.summary.pupils_with_marks} pupils with saved marks</p>
                {!preview.can_import && <p role="alert" className="text-xs font-semibold text-red-700 dark:text-red-300">Fix every server review issue and review the complete file again. Nothing has been imported.</p>}
                <fieldset disabled={disabled || !!busy || frozen || !preview.can_import} className="space-y-3"><label className="block space-y-2 text-sm font-semibold"><span>Import reason</span><textarea required minLength={5} maxLength={300} className="field" value={reason} onChange={event => setReason(event.target.value)} placeholder="Source and approval for these historical school dates" /></label>{reason && !reasonValid && <p className="text-xs text-red-700 dark:text-red-300">Use a 5–300 character reason without line breaks or control characters.</p>}
                  <label className="flex min-h-11 items-start gap-3 text-xs leading-5"><input required type="checkbox" className="mt-1 size-4 shrink-0 accent-[var(--primary)]" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} /><span>I reviewed the school-wide impact. Attendance, gate events and fee history will remain unchanged. Holidays are excluded from official percentages; working dates add to the denominator. Missing or inconsistent marks keep the official rate unavailable.</span></label></fieldset>
              </div>}
              {(preview?.can_import || frozen) && <button type="submit" className={`${control} bg-[var(--primary)] text-white dark:text-[var(--bg)]`} disabled={disabled || !!busy || !frozen && (!acknowledged || !reasonValid)}>{busy === "save" ? "Importing calendar…" : frozen ? "Retry same frozen import" : "Confirm historical import"}</button>}
              {frozen && <p className="text-xs leading-5 muted">The import outcome is unconfirmed. Its file, year, reason and request stay fixed; retry the same import to confirm it without creating another batch. If access needs verification, <Link href="/account/settings" target="_blank" rel="noreferrer" className="font-semibold text-[var(--primary)] underline">verify account security in a new tab</Link>, then retry here.</p>}
            </form>}
          <section className="space-y-2" aria-label="Historical calendar import history"><h4 className="flex items-center gap-2 text-sm font-semibold"><History size={15} aria-hidden="true" />Recent historical imports</h4><p className="text-xs muted">Latest {context.history.length} batches for this school. Attendance history is retained.</p>{context.history.length ? <ul className="max-h-64 space-y-2 overflow-y-auto" tabIndex={0} aria-label="Historical import batches">{context.history.map(receipt => <li key={receipt.request_id} className="rounded-xl bg-[var(--surface-2)] p-3 text-xs leading-5"><strong>{context.years.find(year => year.id === receipt.academic_year_id)?.name ?? "Retained academic year"} · Revision {receipt.revision}</strong><p>{receipt.imported_rows} dates · {receipt.working_rows} working · {receipt.holiday_rows} holidays</p><p className="break-words muted">{receipt.reason}</p><p className="break-words muted">{receipt.actor_id === userId ? "Imported by you" : `Imported by ${receipt.actor_name ?? "Unknown user"}`}</p><time className="muted" dateTime={receipt.created_at}>{new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(receipt.created_at))} IST</time></li>)}</ul> : <p className="text-xs muted">No historical calendar imports yet.</p>}</section>
        </>}
      </>}
    </div>}
  </section>;
}
