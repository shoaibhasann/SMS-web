"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { guardianInvitationUrl } from "@/lib/guardian-invitations/admin";
import {
  importGuardianInvitations, makeGuardianImportRequest, previewGuardianInvitationImport,
  type GuardianBatchInvitation, type GuardianImportMatch, type GuardianImportRow,
} from "@/lib/guardian-invitations/batch";
import {
  guardianCsvTemplate, maxGuardianCsvBytes, maxGuardianImportRows, parseGuardianCsv,
} from "@/lib/guardian-invitations/guardian-csv";

type Preview = {
  fileName: string;
  rows: GuardianImportRow[];
  request: ReturnType<typeof makeGuardianImportRequest>;
};

type Notice = { message: string; error?: boolean };

const button = "min-h-11 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)] disabled:opacity-60";
const expiryFormat = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata",
});

export function GuardianInvitationImport({ client, schoolId, busy, onBusyChange, onImported }: {
  client: SupabaseClient;
  schoolId: string;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onImported: () => void;
}) {
  const [preview, setPreview] = useState<Preview>();
  const [links, setLinks] = useState<GuardianBatchInvitation[]>();
  const [reading, setReading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const [manualCopyId, setManualCopyId] = useState("");
  const active = useRef(false);
  const readVersion = useRef(0);
  const submitInFlight = useRef(false);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  function clearImport() {
    setPreview(undefined);
    setLinks(undefined);
    setNotice(undefined);
    setManualCopyId("");
  }

  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || busy || submitInFlight.current) return;
    const version = ++readVersion.current;
    clearImport();
    setReading(true);
    try {
      if (!file.name.toLowerCase().endsWith(".csv")) throw new Error("Choose a .csv file.");
      if (file.size > maxGuardianCsvBytes) throw new Error("Choose a CSV file that is 64 KB or smaller.");
      const bytes = await file.arrayBuffer();
      let csv: string;
      try {
        csv = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("Save the file as a UTF-8 CSV and try again.");
      }
      const parsed = parseGuardianCsv(csv);
      if (!active.current || version !== readVersion.current) return;
      const rows = parsed.some((row) => row.error)
        ? parsed.map((row) => ({ ...row, studentId: null, studentName: null }))
        : await previewGuardianInvitationImport(client, schoolId, parsed);
      if (active.current && version === readVersion.current) {
        setPreview({ fileName: file.name, rows, request: makeGuardianImportRequest() });
      }
    } catch (error: unknown) {
      if (active.current && version === readVersion.current) {
        setNotice({ message: error instanceof Error ? error.message : "The CSV file could not be read.", error: true });
      }
    } finally {
      if (active.current && version === readVersion.current) setReading(false);
    }
  }

  const matched = preview?.rows.filter((row): row is GuardianImportMatch => row.error === null && Boolean(row.studentId)) ?? [];
  const ready = preview && matched.length === preview.rows.length;

  async function submit() {
    if (!preview || !ready || busy || reading || links || submitInFlight.current) return;
    submitInFlight.current = true;
    onBusyChange(true);
    setImporting(true);
    setNotice(undefined);
    try {
      const result = await importGuardianInvitations(client, schoolId, preview.request, matched);
      if (!active.current) return;
      setLinks(result);
      setNotice({ message: `${result.length} guardian invitation${result.length === 1 ? "" : "s"} created. Copy and share the links privately.` });
      onImported();
    } catch (error: unknown) {
      if (active.current) {
        setNotice({ message: error instanceof Error ? error.message : "The import could not be confirmed.", error: true });
      }
    } finally {
      submitInFlight.current = false;
      if (active.current) {
        setImporting(false);
        onBusyChange(false);
      }
    }
  }

  async function copyLink(link: GuardianBatchInvitation, clickedAt: number) {
    if (Date.parse(link.expires_at) <= clickedAt) {
      setManualCopyId("");
      setNotice({ message: "This link expired. Choose the student below to create a replacement.", error: true });
      return;
    }
    try {
      await navigator.clipboard.writeText(guardianInvitationUrl(link.token, window.location.origin));
      if (active.current) setNotice({ message: `Invitation link copied for ${link.email}.` });
    } catch {
      if (!active.current) return;
      setManualCopyId(link.id);
      setNotice({ message: "Automatic copy is unavailable. Select the displayed link to copy it manually.", error: true });
    }
  }

  return (
    <details className="card p-4">
      <summary className="cursor-pointer text-lg font-bold">Import guardian invitations from CSV</summary>
      <div className="mt-4 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-xl space-y-1 text-sm muted">
            <p>Upload up to {maxGuardianImportRows} invitations for the selected school. Check the admission number and guardian email against the school’s records before confirming.</p>
            <p>Each guardian must sign in with the verified email on their invitation to link the student.</p>
          </div>
          <a className="text-sm font-semibold text-blue-600 underline-offset-4 hover:underline dark:text-blue-400"
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(guardianCsvTemplate)}`}
            download="guardian-invitations-template.csv">Download guardian CSV template</a>
        </div>

        {!links && <label className={`inline-flex items-center ${button} focus-within:ring-2 focus-within:ring-blue-500 ${busy || reading ? "opacity-60" : "cursor-pointer"}`}>
          <span>Choose guardian CSV file</span>
          <input type="file" accept=".csv,text/csv" disabled={busy || reading} aria-label="Guardian CSV file"
            className="sr-only" onChange={(event) => void selectFile(event)} />
        </label>}
        {reading && <p role="status" className="text-sm muted">Reading file and checking student matches…</p>}
        {preview && !links && (
          <div className="space-y-3">
            <p className="break-words text-sm font-semibold">{preview.fileName} · {matched.length} of {preview.rows.length} ready</p>
            {!ready && <p role="alert" className="text-sm text-red-700 dark:text-red-400">Correct the rows below and upload the file again. The entire batch must be ready before invitations can be created.</p>}
            <div className="max-h-72 overflow-auto rounded-xl border border-[var(--border)]"
              tabIndex={0} role="region" aria-label="Guardian CSV preview">
              <table className="w-full min-w-[32rem] text-left text-sm">
                <thead className="border-b border-[var(--border)]">
                  <tr>
                    <th scope="col" className="px-3 py-2">Data row</th>
                    <th scope="col" className="px-3 py-2">Admission number</th>
                    <th scope="col" className="px-3 py-2">Matched student</th>
                    <th scope="col" className="px-3 py-2">Guardian email</th>
                    <th scope="col" className="px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {preview.rows.map((row) => (
                    <tr key={row.rowNumber}>
                      <th scope="row" className="px-3 py-2 font-medium">{row.rowNumber}</th>
                      <td className="break-all px-3 py-2">{row.admissionNumber || "—"}</td>
                      <td className="break-words px-3 py-2">{row.studentName || "—"}</td>
                      <td className="break-all px-3 py-2">{row.email || "—"}</td>
                      <td className={`px-3 py-2 ${row.error ? "text-red-700 dark:text-red-400" : "muted"}`}>
                        {row.error || (row.studentId ? "Ready" : "Match pending corrections to the CSV")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="button" disabled={busy || reading || importing || !ready} onClick={() => void submit()}
              className={`${button} bg-blue-700 text-white`}>
              {importing ? "Creating invitations…" : `Create ${preview.rows.length} guardian invitation${preview.rows.length === 1 ? "" : "s"}`}
            </button>
          </div>
        )}
        {links && (
          <div className="space-y-3" aria-label="Imported guardian invitations" role="region">
            <h2 className="font-bold">Copy guardian invitation links</h2>
            <p className="text-sm muted">Share each link privately with the matching guardian. Copy links before switching schools, reloading or clearing this import. You can create a replacement from the student’s invitation screen.</p>
            <ul className="max-h-96 divide-y divide-[var(--border)] overflow-y-auto rounded-xl border border-[var(--border)] px-3">
              {links.map((link) => (
                <li key={link.id} className="space-y-2 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0 break-words text-sm">
                      <p className="font-semibold">{link.studentName} · {link.admissionNumber}</p>
                      <p>{link.email}</p>
                      <p className="muted">Expires {expiryFormat.format(Date.parse(link.expires_at))} IST</p>
                    </div>
                    <button type="button" className={button} disabled={busy}
                      aria-label={`Copy invitation link for ${link.email} · ${link.admissionNumber}`}
                      onClick={() => void copyLink(link, Date.now())}>Copy link</button>
                  </div>
                  {manualCopyId === link.id && <label className="block space-y-1 text-sm font-semibold">
                    <span>Invitation link for {link.email}</span>
                    <input className="field" readOnly value={guardianInvitationUrl(link.token, window.location.origin)} onFocus={(event) => event.currentTarget.select()} />
                  </label>}
                </li>
              ))}
            </ul>
            <button type="button" className={button} onClick={clearImport} disabled={busy}>Clear import links</button>
          </div>
        )}
        {notice && <p role={notice.error ? "alert" : "status"}
          className={notice.error ? "text-sm text-red-700 dark:text-red-400" : "text-sm"}>{notice.message}</p>}
      </div>
    </details>
  );
}
