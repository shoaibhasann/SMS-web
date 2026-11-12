"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AttendanceContext } from "@/lib/attendance/types";
import { importRosterStudents, listRosterImports, RosterWriteError, type RosterAdmission, type RosterImportHistory } from "@/lib/students/roster";
import { maxRosterCsvBytes, maxRosterImportStudents, parseRosterCsv, rosterCsvTemplate } from "@/lib/students/roster-csv";

type Preview = {
  fileName: string;
  requestId: string;
  students: RosterAdmission[];
};

type ImportNotice = { message: string; error?: boolean };
const historyDate = new Intl.DateTimeFormat("en-IN", {
  day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata",
});

type Props = {
  client: SupabaseClient;
  ownerUserId: string;
  context: AttendanceContext;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onImported: () => void;
};

export function StudentRosterImport(props: Props) {
  const { ownerUserId, context } = props;
  return <RosterImport key={`${ownerUserId}:${context.schoolId}:${context.academicYearId}:${context.classId}:${context.sectionId}`} {...props} />;
}

function RosterImport({ client, ownerUserId, context, disabled, onBusyChange, onImported }: Props) {
  const [preview, setPreview] = useState<Preview>();
  const [reading, setReading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState(false);
  const [notice, setNotice] = useState<ImportNotice>();
  const [uncertain, setUncertain] = useState(false);
  const [sessionChanged, setSessionChanged] = useState(false);
  const [history, setHistory] = useState<{ version: number; items?: RosterImportHistory[]; error?: boolean }>();
  const [historyVersion, setHistoryVersion] = useState(0);
  const readVersion = useRef(0);
  const submitInFlight = useRef(false);
  const mounted = useRef(true), changed = useRef(false), operation = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      if (event !== "INITIAL_SESSION" && session?.user.id !== ownerUserId) {
        changed.current = true; readVersion.current += 1; operation.current?.abort();
        setSessionChanged(true); setPreview(undefined); setNotice(undefined); onBusyChange(false);
      }
    });
    return () => { mounted.current = false; readVersion.current += 1; operation.current?.abort(); subscription.unsubscribe(); onBusyChange(false); };
  }, [client, ownerUserId, onBusyChange]);
  useEffect(() => {
    let active = true;
    listRosterImports(client, context.schoolId).then(
      (items) => { if (active) setHistory({ version: historyVersion, items }); },
      () => { if (active) setHistory({ version: historyVersion, error: true }); },
    );
    return () => { active = false; };
  }, [client, context.schoolId, historyVersion]);
  const currentHistory = history?.version === historyVersion ? history : undefined;
  const currentRead = (version: number) => mounted.current && !changed.current && version === readVersion.current;

  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || changed.current || uncertain || submitInFlight.current) return;

    const version = ++readVersion.current;
    setPreview(undefined);
    setNotice(undefined);
    setImported(false);
    setReading(true);
    try {
      if (!file.name.toLowerCase().endsWith(".csv")) throw new Error("Choose a .csv file.");
      if (file.size > maxRosterCsvBytes) throw new Error("Choose a CSV file that is 64 KB or smaller.");
      const bytes = await file.arrayBuffer();
      let csv: string;
      try {
        csv = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("Save the file as a UTF-8 CSV and try again.");
      }
      const students = parseRosterCsv(csv);
      if (currentRead(version)) {
        setPreview({ fileName: file.name, requestId: crypto.randomUUID(), students });
      }
    } catch (error: unknown) {
      if (currentRead(version)) {
        setNotice({ message: error instanceof Error ? error.message : "The CSV file could not be read.", error: true });
      }
    } finally {
      if (currentRead(version)) setReading(false);
    }
  }

  async function submit() {
    if (!preview || imported || changed.current || disabled && !uncertain || submitInFlight.current) return;

    submitInFlight.current = true;
    onBusyChange(true);
    setImporting(true);
    setNotice(undefined);
    const controller = new AbortController(); operation.current = controller;
    let keepBusy = false;
    try {
      const count = await importRosterStudents(client, context, preview.requestId, preview.students, { userId: ownerUserId, signal: controller.signal });
      if (controller.signal.aborted || !mounted.current || changed.current) return;
      setUncertain(false);
      setImported(true);
      setNotice({ message: `${count} student${count === 1 ? "" : "s"} imported and enrolled.` });
      setHistoryVersion((version) => version + 1);
      onImported();
    } catch (error: unknown) {
      if (controller.signal.aborted || !mounted.current || changed.current) return;
      keepBusy = !(error instanceof RosterWriteError) || error.code === "unconfirmed";
      setUncertain(keepBusy);
      setNotice({ message: error instanceof Error ? error.message : "The import could not be confirmed.", error: true });
    } finally {
      submitInFlight.current = false;
      if (operation.current === controller) operation.current = null;
      if (mounted.current && !changed.current) { setImporting(false); if (!keepBusy) onBusyChange(false); }
    }
  }

  return (
    <details className="card group p-4">
      <summary className="cursor-pointer text-lg font-bold">Import students from CSV</summary>
      <div className="mt-4 space-y-4">
        {sessionChanged && <p role="alert" className="text-sm">Your account changed. Reopen this page before importing students.</p>}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-xl text-sm muted">
            Upload up to {maxRosterImportStudents} students for the selected class and section.
            Review the names and admission numbers before importing. Last name, date of birth (YYYY-MM-DD or DD-MM-YYYY, shown as YYYY-MM-DD) and registered mobile can be blank,
            but a pupil needs both to activate a Student account.
          </p>
          <a className="text-sm font-semibold text-blue-600 underline-offset-4 hover:underline dark:text-blue-400"
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(rosterCsvTemplate)}`}
            download="students-template.csv">Download CSV template</a>
        </div>

        <label className={`inline-flex min-h-11 items-center rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold focus-within:ring-2 focus-within:ring-blue-500 ${disabled || importing ? "opacity-60" : "cursor-pointer"}`}>
          <span>Choose student CSV file</span>
          <input type="file" accept=".csv,text/csv" disabled={disabled || importing || uncertain || sessionChanged}
            aria-label="Student CSV file" className="sr-only" onChange={(event) => void selectFile(event)} />
        </label>

        {reading && <p role="status" className="text-sm muted">Reading file…</p>}
        {preview && (
          <div className="space-y-3">
            <p className="break-words text-sm font-semibold">{preview.fileName} · {preview.students.length} student{preview.students.length === 1 ? "" : "s"}</p>
            <div className="max-h-72 overflow-auto rounded-xl border border-[var(--border)]"
              tabIndex={0} role="region" aria-label="Student CSV preview">
              <table className="w-full min-w-80 text-left text-sm">
                <thead className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--surface-2)]">
                  <tr>
                    <th scope="col" className="px-3 py-2">Admission number</th>
                    <th scope="col" className="px-3 py-2">First name</th>
                    <th scope="col" className="px-3 py-2">Last name</th>
                    <th scope="col" className="px-3 py-2">Date of birth</th>
                    <th scope="col" className="px-3 py-2">Mobile</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {preview.students.map((student) => (
                    <tr key={student.admissionNumber}>
                      <td className="break-all px-3 py-2 font-medium">{student.admissionNumber}</td>
                      <td className="break-words px-3 py-2">{student.firstName}</td>
                      <td className="break-words px-3 py-2">{student.lastName || "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2">{student.dateOfBirth || "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2">{student.registeredMobile || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="button" disabled={disabled && !uncertain || reading || importing || imported || sessionChanged}
              onClick={() => void submit()}
              className="btn btn-primary">
              {importing ? "Importing students…" : imported ? "Imported" : uncertain ? "Retry same import" : `Import ${preview.students.length} student${preview.students.length === 1 ? "" : "s"}`}
            </button>
          </div>
        )}
        {notice && <p role={notice.error ? "alert" : "status"}
          className={notice.error ? "text-sm text-red-700 dark:text-red-400" : "text-sm"}>{notice.message}</p>}

        <section aria-labelledby="student-csv-history" className="space-y-2 border-t border-[var(--border)] pt-4">
          <h3 id="student-csv-history" className="text-sm font-bold">Recent CSV imports</h3>
          {currentHistory?.error ? <p className="text-sm muted">Import history could not be loaded. Reopen this page to retry.</p>
            : !currentHistory?.items ? <p className="text-sm muted">Loading import history…</p>
            : currentHistory.items.length === 0 ? <p className="text-sm muted">No student CSV imports for this school.</p>
            : <ul className="divide-y divide-[var(--border)]">
              {currentHistory.items.map((item) => (
                <li key={item.request_id} className="flex flex-wrap justify-between gap-1 py-2 text-sm">
                  <span>{item.student_count} student{item.student_count === 1 ? "" : "s"}</span>
                  <span className="muted">{item.imported_by_name ?? "Unknown"} · {item.imported_at ? historyDate.format(new Date(item.imported_at)) : "Before import history"}</span>
                </li>
              ))}
            </ul>}
        </section>
      </div>
    </details>
  );
}
