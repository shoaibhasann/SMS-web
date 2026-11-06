"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { AcademicSetup } from "@/lib/admin/academic-setup";
import {
  academicCsvMaxBytes, academicCsvMaxRows, academicCsvTemplates, parseAcademicSetupCsv, previewAcademicSetupCsv,
  type AcademicImportKind, type AcademicImportRecord,
} from "@/lib/admin/academic-setup-csv";
import {
  AcademicImportRejected, importAcademicSetupRecords, listAcademicSetupImports, type AcademicImportHistory,
} from "@/lib/admin/academic-setup-import";
import { LoadingState } from "@/components/ui/skeleton";

type Preview = { fileName: string; requestId: string; rows: ReturnType<typeof parseAcademicSetupCsv> };
type Feedback = { kind: "error" | "retry" | "success"; text: string };
const dateLabel = new Intl.DateTimeFormat("en-IN", {
  day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata",
});

export function AcademicSetupCsvImport({
  client, schoolId, kind, setup, disabled, refreshVersion, onBusyChange, onImported,
}: {
  client: SupabaseClient;
  schoolId: string;
  kind: AcademicImportKind;
  setup: AcademicSetup | undefined;
  disabled: boolean;
  refreshVersion: number;
  onBusyChange: (busy: boolean) => void;
  onImported: () => void;
}) {
  const config = academicCsvTemplates[kind];
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<AcademicImportHistory[]>();
  const [historyError, setHistoryError] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [attemptedRecords, setAttemptedRecords] = useState<AcademicImportRecord[]>();
  const [reading, setReading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>();
  const submitting = useRef(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    listAcademicSetupImports(client, schoolId, kind).then((items) => {
      if (!active) return;
      setHistory(items);
      setHistoryError(false);
    }, () => {
      if (active) setHistoryError(true);
    });
    return () => { active = false; };
  }, [client, kind, open, refreshVersion, schoolId]);

  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || submitting.current) return;

    setPreview(undefined);
    setAttemptedRecords(undefined);
    setFeedback(undefined);
    setReading(true);
    try {
      if (!file.name.toLowerCase().endsWith(".csv")) throw new Error("Choose a .csv file.");
      if (file.size > academicCsvMaxBytes) throw new Error("Choose a CSV file that is 64 KB or smaller.");
      const bytes = await file.arrayBuffer();
      let csv: string;
      try {
        csv = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("Save the file as a UTF-8 CSV and try again.");
      }
      setPreview({ fileName: file.name, requestId: crypto.randomUUID(), rows: parseAcademicSetupCsv(csv, kind) });
    } catch (error) {
      setFeedback({ kind: "error", text: error instanceof Error ? error.message : "The CSV file could not be read." });
    } finally {
      setReading(false);
    }
  }

  const rows = preview ? previewAcademicSetupCsv(kind, preview.rows, setup) : [];
  const issueCount = rows.filter((row) => row.issue).length;
  const canSubmit = Boolean(preview && !disabled && !reading && !importing
    && (feedback?.kind === "retry" && attemptedRecords || (!feedback && setup && issueCount === 0)));

  async function submit() {
    if (!preview || !canSubmit || submitting.current) return;
    const records = attemptedRecords ?? rows.flatMap((row) => row.record ? [row.record] : []);
    if (records.length !== preview.rows.length) return;

    submitting.current = true;
    setAttemptedRecords(records);
    setImporting(true);
    onBusyChange(true);
    try {
      const count = await importAcademicSetupRecords(client, schoolId, kind, preview.requestId, records);
      setFeedback({ kind: "success", text: `${count} ${count === 1 ? config.singular : kind} imported.` });
      onImported();
    } catch (error) {
      setFeedback({
        kind: error instanceof AcademicImportRejected ? "error" : "retry",
        text: error instanceof Error ? error.message : "The import could not be confirmed. Retry the same preview.",
      });
    } finally {
      setImporting(false);
      onBusyChange(false);
      submitting.current = false;
    }
  }

  const template = `${config.header}\n${config.sample}\n`;
  return (
    <details className="rounded-xl border border-[var(--border)] p-4" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer font-bold">Import {kind} from CSV</summary>
      <div className="mt-4 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-xl space-y-1 text-sm muted">
            <p>Review up to {academicCsvMaxRows} records for the selected school before importing.</p>
            {kind === "classes" && <p>Use a display order from 0 to 999 for each class.</p>}
            {kind === "sections" && <p>Copy each class name exactly from the active Classes list.</p>}
            {kind === "subjects" && <p>Subject codes are optional. Leave the code column blank when unused.</p>}
          </div>
          <a className="text-sm font-semibold text-blue-600 underline-offset-4 hover:underline dark:text-blue-400"
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(template)}`}
            download={`${kind}-template.csv`}>Download {kind} CSV template</a>
        </div>
        <label className="inline-flex min-h-11 cursor-pointer items-center rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold focus-within:ring-2 focus-within:ring-blue-500 has-[:disabled]:cursor-default has-[:disabled]:opacity-60">
          <span>Choose {kind} CSV file</span>
          <input type="file" accept=".csv,text/csv" disabled={disabled || reading || importing || !setup}
            aria-label={`${config.label} CSV file`} className="sr-only" onChange={(event) => void selectFile(event)} />
        </label>
        {reading && <p role="status" className="text-sm muted">Reading CSV…</p>}
        {preview && (
          <div className="space-y-3">
            <p className="break-all text-sm font-semibold">{preview.fileName} · {rows.length} {rows.length === 1 ? "record" : "records"}</p>
            {issueCount > 0 && setup && !importing && !feedback && (
              <p role="alert" className="text-sm text-red-700 dark:text-red-400">
                {issueCount} {issueCount === 1 ? "row needs" : "rows need"} review. Fix the CSV and select it again.
              </p>
            )}
            <div tabIndex={0} role="region" aria-label={`${config.label} CSV preview`}
              className="max-h-72 overflow-auto rounded-xl border border-[var(--border)]">
              <table className="w-full min-w-[32rem] text-left text-sm">
                <thead className="border-b border-[var(--border)]">
                  <tr>
                    <th scope="col" className="px-3 py-2">Data row</th>
                    <th scope="col" className="px-3 py-2">Name</th>
                    <th scope="col" className="px-3 py-2">{config.detailLabel}</th>
                    <th scope="col" className="px-3 py-2">Check</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {rows.map((row) => (
                    <tr key={row.rowNumber}>
                      <td className="px-3 py-2 tabular-nums">{row.rowNumber}</td>
                      <td className="max-w-48 break-words px-3 py-2 font-semibold">{row.name || "—"}</td>
                      <td className="max-w-40 break-words px-3 py-2">{row.detail || "—"}</td>
                      <td className="px-3 py-2">
                        {feedback?.kind === "success" ? "Imported" : !setup ? "Checking…"
                          : row.issue ? <span className="text-red-700 dark:text-red-400">{row.issue}</span> : "Ready"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="button" disabled={!canSubmit} onClick={() => void submit()}
              className="min-h-11 rounded-xl bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60">
              {importing ? "Importing…" : feedback?.kind === "success" ? "Imported"
                : feedback?.kind === "retry" ? "Retry same import" : `Import ${rows.length} ${rows.length === 1 ? "record" : "records"}`}
            </button>
          </div>
        )}
        {feedback && (
          <p role={feedback.kind === "success" ? "status" : "alert"}
            className={feedback.kind === "success" ? "text-sm" : "text-sm text-red-700 dark:text-red-400"}>{feedback.text}</p>
        )}
        <section aria-labelledby="academic-csv-history" className="space-y-2 border-t border-[var(--border)] pt-4">
          <h3 id="academic-csv-history" className="text-sm font-bold">Recent CSV imports</h3>
          {historyError ? <p role="alert" className="text-sm muted">Import history could not be loaded. Reopen this panel to retry.</p>
            : !history ? <LoadingState variant="table" className="text-sm muted">Loading import history…</LoadingState>
            : history.length === 0 ? <p className="text-sm muted">No CSV imports for this record type.</p>
            : <ul className="divide-y divide-[var(--border)]">
              {history.map((item) => (
                <li key={item.request_id} className="flex flex-wrap justify-between gap-1 py-2 text-sm">
                  <span>{item.record_count} {item.record_count === 1 ? config.singular : kind}</span>
                  <span className="muted">{item.imported_by_name} · {dateLabel.format(new Date(item.imported_at))}</span>
                </li>
              ))}
            </ul>}
        </section>
      </div>
    </details>
  );
}
