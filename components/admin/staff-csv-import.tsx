"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  maxStaffCsvBytes, maxStaffImportRows, parseStaffCsv, staffCsvTemplate, staffEmployeeKey, type StaffCsvRow,
} from "@/lib/teachers/staff-csv";
import {
  importSchoolStaff, listSchoolStaffImports, StaffImportRejected, type StaffImportHistory,
} from "@/lib/teachers/staff-import";

type Preview = { fileName: string; requestId: string; rows: StaffCsvRow[] };
type Feedback = { kind: "error" | "retry" | "success"; text: string };
const dateLabel = new Intl.DateTimeFormat("en-IN", {
  day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata",
});

export function StaffCsvImport({
  client, schoolId, existingEmployeeIds, disabled, refreshVersion, onBusyChange, onImported,
}: {
  client: SupabaseClient;
  schoolId: string;
  existingEmployeeIds?: readonly string[];
  disabled: boolean;
  refreshVersion: number;
  onBusyChange: (busy: boolean) => void;
  onImported: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<StaffImportHistory[]>();
  const [historyError, setHistoryError] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [reading, setReading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>();
  const submitting = useRef(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    listSchoolStaffImports(client, schoolId).then((items) => {
      if (!active) return;
      setHistory(items);
      setHistoryError(false);
    }, () => {
      if (active) setHistoryError(true);
    });
    return () => { active = false; };
  }, [client, open, refreshVersion, schoolId]);

  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || submitting.current) return;

    setPreview(undefined);
    setFeedback(undefined);
    setReading(true);
    try {
      if (!file.name.toLowerCase().endsWith(".csv")) throw new Error("Choose a .csv file.");
      if (file.size > maxStaffCsvBytes) throw new Error("Choose a CSV file that is 64 KB or smaller.");
      const bytes = await file.arrayBuffer();
      let csv: string;
      try {
        csv = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("Save the file as a UTF-8 CSV and try again.");
      }
      setPreview({ fileName: file.name, requestId: crypto.randomUUID(), rows: parseStaffCsv(csv) });
    } catch (error) {
      setFeedback({ kind: "error", text: error instanceof Error ? error.message : "The CSV file could not be read." });
    } finally {
      setReading(false);
    }
  }

  const employeeIds = new Set(existingEmployeeIds?.map(staffEmployeeKey));
  const rows = preview?.rows.map((row) => ({
    ...row,
    issue: row.issue ?? (employeeIds.has(staffEmployeeKey(row.employeeId)) ? "Employee ID already exists in this school." : undefined),
  })) ?? [];
  const issueCount = rows.filter((row) => row.issue).length;
  const canSubmit = Boolean(preview && !disabled && !reading && !importing && existingEmployeeIds
    && (feedback?.kind === "retry" || (!feedback && issueCount === 0)));

  async function submit() {
    if (!preview || !canSubmit || submitting.current) return;
    submitting.current = true;
    setImporting(true);
    onBusyChange(true);
    try {
      const staff = preview.rows.map(({ employeeId, fullName, staffType }) => ({ employeeId, fullName, staffType }));
      const counts = await importSchoolStaff(client, schoolId, preview.requestId, staff);
      setFeedback({
        kind: "success",
        text: `${staff.length} staff ${staff.length === 1 ? "record" : "records"} imported. ${counts.teacher_count} teaching · ${counts.staff_count} non-teaching.`,
      });
      onImported();
    } catch (error) {
      setFeedback({
        kind: error instanceof StaffImportRejected ? "error" : "retry",
        text: error instanceof Error ? error.message : "The import could not be confirmed. Retry the same preview.",
      });
    } finally {
      setImporting(false);
      onBusyChange(false);
      submitting.current = false;
    }
  }

  return (
    <details className="card p-4 sm:p-5" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-lg font-bold">Import staff from CSV</summary>
      <div className="mt-4 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-xl text-sm muted">
            Review up to {maxStaffImportRows} teaching and non-teaching records for the selected school.
            Use a unique employee ID for each person. Imports create directory entries. Teachers can be invited separately.
          </p>
          <a className="text-sm font-semibold text-blue-600 underline-offset-4 hover:underline dark:text-blue-400"
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(staffCsvTemplate)}`}
            download="staff-template.csv">Download staff CSV template</a>
        </div>
        <label className={`inline-flex min-h-11 items-center rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold focus-within:ring-2 focus-within:ring-blue-500 ${disabled || reading || !existingEmployeeIds ? "opacity-60" : "cursor-pointer"}`}>
          <span>Choose staff CSV file</span>
          <input type="file" accept=".csv,text/csv" disabled={disabled || reading || importing || !existingEmployeeIds}
            aria-label="Staff CSV file" className="sr-only" onChange={(event) => void selectFile(event)} />
        </label>
        {!existingEmployeeIds && <p className="text-sm muted">Wait for both directories to load before checking a file.</p>}
        {reading && <p role="status" className="text-sm muted">Reading CSV…</p>}
        {preview && (
          <div className="space-y-3">
            <p className="break-all text-sm font-semibold">{preview.fileName} · {rows.length} {rows.length === 1 ? "record" : "records"}</p>
            {issueCount > 0 && !importing && !feedback && (
              <p role="alert" className="text-sm text-red-700 dark:text-red-400">
                {issueCount} {issueCount === 1 ? "row needs" : "rows need"} review. Fix the CSV and select it again.
              </p>
            )}
            <div tabIndex={0} role="region" aria-label="Staff CSV preview"
              className="max-h-72 overflow-auto rounded-xl border border-[var(--border)]">
              <table className="w-full min-w-[38rem] text-left text-sm">
                <thead className="border-b border-[var(--border)]">
                  <tr>
                    <th scope="col" className="px-3 py-2">Data row</th>
                    <th scope="col" className="px-3 py-2">Employee ID</th>
                    <th scope="col" className="px-3 py-2">Full name</th>
                    <th scope="col" className="px-3 py-2">Staff type</th>
                    <th scope="col" className="px-3 py-2">Check</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {rows.map((row) => (
                    <tr key={row.rowNumber}>
                      <td className="px-3 py-2 tabular-nums">{row.rowNumber}</td>
                      <td className="max-w-40 break-words px-3 py-2 font-semibold">{row.employeeId || "—"}</td>
                      <td className="max-w-52 break-words px-3 py-2">{row.fullName || "—"}</td>
                      <td className="max-w-32 break-words px-3 py-2">{row.staffType || "—"}</td>
                      <td className="px-3 py-2">
                        {feedback?.kind === "success" ? "Imported"
                          : row.issue ? <span className="text-red-700 dark:text-red-400">{row.issue}</span> : "Ready"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="button" disabled={!canSubmit} onClick={() => void submit()}
              className="min-h-11 rounded-xl bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60">
              {importing ? "Importing staff…" : feedback?.kind === "success" ? "Imported"
                : feedback?.kind === "retry" ? "Retry same import" : `Import ${rows.length} ${rows.length === 1 ? "record" : "records"}`}
            </button>
          </div>
        )}
        {feedback && (
          <p role={feedback.kind === "success" ? "status" : "alert"}
            className={feedback.kind === "success" ? "text-sm" : "text-sm text-red-700 dark:text-red-400"}>{feedback.text}</p>
        )}

        <section aria-labelledby="staff-csv-history" className="space-y-2 border-t border-[var(--border)] pt-4">
          <h3 id="staff-csv-history" className="text-sm font-bold">Recent CSV imports</h3>
          {historyError ? <p role="alert" className="text-sm muted">Import history could not be loaded. Reopen this panel to retry.</p>
            : !history ? <p role="status" className="text-sm muted">Loading import history…</p>
            : history.length === 0 ? <p className="text-sm muted">No staff CSV imports for this school.</p>
            : <ul className="divide-y divide-[var(--border)]">
              {history.map((item) => (
                <li key={item.request_id} className="flex flex-wrap justify-between gap-1 py-2 text-sm">
                  <span>{item.teacher_count} teaching · {item.staff_count} non-teaching</span>
                  <span className="muted">{item.imported_by_name} · {dateLabel.format(new Date(item.imported_at))}</span>
                </li>
              ))}
            </ul>}
        </section>
      </div>
    </details>
  );
}
