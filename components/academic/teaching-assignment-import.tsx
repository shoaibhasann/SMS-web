"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  assignmentCsvTemplate, maxAssignmentCsvBytes, maxAssignmentImportRows, parseAssignmentCsv,
} from "@/lib/assignments/csv";
import {
  AssignmentImportRejected, type AssignmentImportRow, type MatchedAssignmentImportRow,
} from "@/lib/assignments/import";
import type { AssignmentOption, TeachingAssignmentRepository } from "@/lib/assignments/repository";

type Preview = { fileName: string; requestId: string; rows: AssignmentImportRow[] };
type Feedback = { message: string; retryable?: boolean };

const action = "min-h-11 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold disabled:opacity-50";

export function TeachingAssignmentImport({
  repository, schoolId, year, disabled, onBusyChange, onImported,
}: {
  repository: Pick<TeachingAssignmentRepository, "previewImport" | "confirmImport">;
  schoolId: string;
  year: AssignmentOption;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onImported: (count: number) => void;
}) {
  const [preview, setPreview] = useState<Preview>();
  const [reading, setReading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>();
  const active = useRef(false);
  const readingFile = useRef(false);
  const submitting = useRef(false);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || disabled || readingFile.current || submitting.current) return;

    readingFile.current = true;
    setPreview(undefined);
    setFeedback(undefined);
    setReading(true);
    try {
      if (!file.name.toLowerCase().endsWith(".csv")) throw new Error("Choose a .csv file.");
      if (file.size > maxAssignmentCsvBytes) throw new Error("Choose a CSV file that is 64 KB or smaller.");
      const bytes = await file.arrayBuffer();
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("Save the file as a UTF-8 CSV and try again.");
      }
      const parsed = parseAssignmentCsv(text);
      if (!active.current) return;
      const rows = parsed.some((row) => row.issue)
        ? parsed.map((row) => ({ ...row, teacherId: null, teacherName: null, classId: null, sectionId: null, subjectId: null }))
        : await repository.previewImport(schoolId, year.id, parsed);
      if (active.current) setPreview({ fileName: file.name, requestId: crypto.randomUUID(), rows });
    } catch (error: unknown) {
      if (active.current) {
        setFeedback({ message: error instanceof Error ? error.message : "The CSV file could not be checked." });
      }
    } finally {
      readingFile.current = false;
      if (active.current) setReading(false);
    }
  }

  const matches = preview?.rows.filter((row): row is MatchedAssignmentImportRow =>
    row.issue === null && Boolean(row.teacherId && row.classId && row.sectionId && row.subjectId),
  ) ?? [];
  const ready = preview && matches.length === preview.rows.length;
  const canSubmit = ready && !disabled && !reading && !importing && (!feedback || feedback.retryable);

  async function submit() {
    if (!preview || !canSubmit || submitting.current) return;
    submitting.current = true;
    setImporting(true);
    setFeedback(undefined);
    onBusyChange(true);
    try {
      const count = await repository.confirmImport(schoolId, year.id, preview.requestId, matches);
      if (active.current) {
        setPreview(undefined);
        onImported(count);
      }
    } catch (error: unknown) {
      if (active.current) {
        setFeedback({
          message: error instanceof Error ? error.message : "The import could not be confirmed. Retry from this same preview.",
          retryable: !(error instanceof AssignmentImportRejected),
        });
      }
    } finally {
      submitting.current = false;
      if (active.current) {
        setImporting(false);
        onBusyChange(false);
      }
    }
  }

  return (
    <details className="card p-4 sm:p-6">
      <summary className="cursor-pointer text-lg font-semibold">Import teaching assignments from CSV</summary>
      <div className="mt-4 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-xl space-y-1 text-sm muted">
            <p>Review up to {maxAssignmentImportRows} assignments for the current academic year, {year.name}.</p>
            <p>Use the teacher’s employee ID and the exact class, section and subject names from this school. Use true for a class-teacher duty and false for a subject assignment.</p>
          </div>
          <a className="text-sm font-semibold text-[var(--primary)] underline-offset-4 hover:underline"
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(assignmentCsvTemplate)}`}
            download="teaching-assignments-template.csv">Download assignment CSV template</a>
        </div>
        <label className={`inline-flex items-center ${action} focus-within:ring-2 focus-within:ring-[var(--primary)] ${disabled || reading || importing ? "opacity-60" : "cursor-pointer"}`}>
          <span>Choose assignment CSV file</span>
          <input type="file" accept=".csv,text/csv" disabled={disabled || reading || importing} aria-label="Teaching assignment CSV file"
            className="sr-only" onChange={(event) => void selectFile(event)} />
        </label>
        {reading && <p role="status" className="text-sm muted">Reading CSV and checking assignments…</p>}
        {preview && (
          <div className="space-y-3">
            <p className="break-words text-sm font-semibold">{preview.fileName} · {matches.length} of {preview.rows.length} ready</p>
            {!ready && <p role="alert" className="text-sm text-danger">Correct the rows below and upload the file again. All rows must be ready before importing.</p>}
            <div tabIndex={0} role="region" aria-label="Teaching assignment CSV preview"
              className="max-h-72 overflow-auto rounded-xl border border-[var(--border)]">
              <table className="w-full min-w-[44rem] text-left text-sm">
                <thead className="border-b border-[var(--border)]">
                  <tr>
                    {["Data row", "Employee ID", "Matched teacher", "Class", "Section", "Subject", "Duty", "Check"].map((title) =>
                      <th key={title} scope="col" className="px-3 py-2">{title}</th>,
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {preview.rows.map((row) => (
                    <tr key={row.rowNumber}>
                      <th scope="row" className="px-3 py-2 font-medium">{row.rowNumber}</th>
                      <td className="max-w-36 break-words px-3 py-2">{row.employeeId || "—"}</td>
                      <td className="max-w-40 break-words px-3 py-2 font-medium">{row.teacherName || (row.teacherId ? row.employeeId : "—")}</td>
                      <td className="max-w-32 break-words px-3 py-2">{row.className || "—"}</td>
                      <td className="max-w-32 break-words px-3 py-2">{row.sectionName || "—"}</td>
                      <td className="max-w-36 break-words px-3 py-2">{row.subjectName || "—"}</td>
                      <td className="px-3 py-2">{row.isClassTeacher ? "Class teacher" : "Subject teacher"}</td>
                      <td className={`px-3 py-2 ${row.issue ? "text-danger" : "muted"}`}>
                        {row.issue || (row.teacherId ? "Ready" : "Match pending CSV corrections")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="button" disabled={!canSubmit} onClick={() => void submit()} className="btn btn-primary">
              {importing ? "Importing assignments…" : feedback?.retryable ? "Retry same assignment import"
                : `Import ${preview.rows.length} teaching assignment${preview.rows.length === 1 ? "" : "s"}`}
            </button>
          </div>
        )}
        {feedback && <p role="alert" className="text-sm text-danger">{feedback.message}</p>}
      </div>
    </details>
  );
}
