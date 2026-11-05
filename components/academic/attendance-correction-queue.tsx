"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { attendanceLabels, type AttendanceStatus } from "@/lib/attendance/types";
import type { createClient } from "@/lib/supabase/client";

type Mark = { status: AttendanceStatus; remarks: string | null };
type Correction = {
  id: string;
  requested_by: string;
  student_name: string;
  admission_no: string | null;
  section_name: string;
  attendance_date: string;
  state: "pending" | "approved" | "rejected";
  requested_status: AttendanceStatus;
  request_reason: string;
  review_reason: string | null;
  requester_name: string | null;
  reviewer_name: string | null;
  before_record: Mark | null;
  after_record: Mark | null;
};

type Props = {
  client: ReturnType<typeof createClient>;
  schoolId: string;
  userId: string;
  own?: boolean;
  disabled?: boolean;
  revision?: number;
  onReviewed?: () => void;
};

const pageSize = 20;
const buttonClass = "rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold disabled:opacity-50";

export function AttendanceCorrectionQueue({ client, schoolId, userId, own = false, disabled = false, revision = 0, onReviewed }: Props) {
  const [page, setPage] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ key: string; rows: Correction[]; error: string }>();
  const [selected, setSelected] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [requiresRefresh, setRequiresRefresh] = useState("");
  const [outdated, setOutdated] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState<{ text: string; error: boolean }>();
  const inFlight = useRef(false);
  const queryKey = JSON.stringify([schoolId, userId, own, page, revision, refresh]);
  const activeResult = result?.key === queryKey ? result : undefined;
  const rows = activeResult?.rows.slice(0, pageSize) ?? [];

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const { data, error } = await client.rpc("list_attendance_corrections", {
          p_school_id: schoolId,
          p_offset: page * pageSize,
          p_own: own,
        });
        if (!active) return;
        if (error || !Array.isArray(data)) {
          setResult({ key: queryKey, rows: [], error: "Correction requests could not be loaded. Refresh to try again." });
        } else {
          setResult({ key: queryKey, rows: data as Correction[], error: "" });
        }
      } catch {
        if (active) setResult({ key: queryKey, rows: [], error: "Correction requests could not be loaded. Refresh to try again." });
      }
    }
    void load();
    return () => { active = false; };
  }, [client, own, page, queryKey, schoolId]);

  async function decide(event: FormEvent<HTMLFormElement>, request: Correction) {
    event.preventDefault();
    if (own || disabled || inFlight.current || requiresRefresh === request.id || request.state !== "pending" || request.requested_by === userId || !reason.trim()) return;
    const decision = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value");
    if (decision !== "approved" && decision !== "rejected") return;
    if (decision === "approved" && outdated.has(request.id)) return;
    inFlight.current = true;
    setSaving(true);
    setMessage(undefined);
    try {
      const { data, error } = await client.rpc("review_attendance_correction", {
        p_request_id: request.id,
        p_decision: decision,
        p_reason: reason.trim(),
      });
      if (error || data !== decision) {
        if (error && ["PT409", "40001"].includes(error.code)) {
          setRequiresRefresh(request.id);
          setOutdated((previous) => new Set(previous).add(request.id));
          setMessage({ text: "Attendance changed, so this request cannot be approved. Your review reason is kept. Refresh requests, reject the outdated request with a reason, and ask the teacher to reload and submit a new correction.", error: true });
          return;
        }
        const actionable = error && ["22023", "42501", "23505", "40001"].includes(error.code);
        setMessage({ text: actionable ? error.message : "The review could not be confirmed. Retry with the same reason or refresh.", error: true });
        return;
      }
      setSelected("");
      setReason("");
      setMessage({ text: decision === "approved" ? "Correction approved and attendance updated." : "Correction rejected.", error: false });
      setRefresh((value) => value + 1);
      onReviewed?.();
    } catch {
      setMessage({ text: "The review could not be confirmed. Retry with the same reason or refresh.", error: true });
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <section aria-label={own ? "My attendance correction requests" : "Attendance correction review"} className="card space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-bold">{own ? "My correction requests" : "Attendance correction review"}</h2>
          <p className="mt-1 text-sm muted">{own ? "See the decisions and reasons for your requests." : "Review requests for past attendance dates. Every decision needs a reason."}</p>
        </div>
        <button type="button" disabled={saving} className={buttonClass} onClick={() => { setMessage(undefined); setRequiresRefresh(""); setRefresh((value) => value + 1); }}>Refresh requests</button>
      </div>
      {message && <p role={message.error ? "alert" : "status"} className={`text-sm ${message.error ? "text-red-700 dark:text-red-300" : "text-emerald-700 dark:text-emerald-300"}`}>{message.text}</p>}
      {!activeResult ? <p role="status" className="text-sm muted">Loading correction requests…</p> : activeResult.error ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{activeResult.error}</p> : !rows.length ? <p className="text-sm muted">No correction requests on this page.</p> : (
        <ul className="space-y-3">
          {rows.map((request) => (
            <li key={request.id} className="space-y-3 rounded-xl border border-[var(--border)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold">{request.student_name || "Student"}{request.admission_no && ` · ${request.admission_no}`}</h3>
                  <p className="text-xs muted">{request.attendance_date} IST{request.section_name && ` · ${request.section_name}`}{request.requester_name && ` · ${request.requester_name}`}</p>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${request.state === "pending" ? "bg-amber-500/10 text-amber-700 dark:text-amber-300" : "bg-[var(--surface-2)]"}`}>{request.state}</span>
              </div>
              <p className="text-sm"><strong>{request.before_record ? attendanceLabels[request.before_record.status] : "Unmarked"}</strong> → <strong>{attendanceLabels[request.requested_status]}</strong></p>
              <p className="break-words text-sm muted">Request reason · {request.request_reason}</p>
              {request.before_record?.remarks && <p className="break-words text-sm muted">Original remarks · {request.before_record.remarks}</p>}
              {request.after_record && <p className="text-sm muted">Applied status · {attendanceLabels[request.after_record.status]}</p>}
              {request.review_reason && <p className="break-words text-sm muted">Review reason{request.reviewer_name && ` by ${request.reviewer_name}`} · {request.review_reason}</p>}
              {request.state === "pending" && outdated.has(request.id) && <p className="text-sm muted">This request uses an outdated mark. Reject it with a reason; the teacher must reload and request a new correction.</p>}
              {!own && request.state === "pending" && (request.requested_by === userId
                ? <p className="text-sm muted">Another reviewer must decide your request.</p>
                : selected === request.id ? (
                  <form className="space-y-2" onSubmit={(event) => void decide(event, request)}>
                    <label className="block max-w-lg space-y-1.5 text-sm font-semibold">
                      <span>Review reason</span>
                      <textarea required rows={2} maxLength={500} value={reason} disabled={saving} onChange={(event) => setReason(event.target.value)} className="field" />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <button type="submit" value="approved" disabled={disabled || saving || outdated.has(request.id) || requiresRefresh === request.id || !reason.trim()} className="rounded-xl bg-blue-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Approve correction</button>
                      <button type="submit" value="rejected" disabled={disabled || saving || requiresRefresh === request.id || !reason.trim()} className={buttonClass}>Reject correction</button>
                      <button type="button" disabled={saving} className={buttonClass} onClick={() => { setSelected(""); setReason(""); }}>Cancel</button>
                    </div>
                  </form>
                ) : (
                  <button type="button" disabled={disabled || saving} className={buttonClass} onClick={() => { setSelected(request.id); setReason(""); setMessage(undefined); }}>Review request</button>
                ))}
            </li>
          ))}
        </ul>
      )}
      {(page > 0 || (activeResult?.rows.length ?? 0) > pageSize) && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass} disabled={saving || page === 0} onClick={() => setPage((value) => value - 1)}>Previous</button>
          <button type="button" className={buttonClass} disabled={saving || (activeResult?.rows.length ?? 0) <= pageSize} onClick={() => setPage((value) => value + 1)}>Next</button>
        </div>
      )}
    </section>
  );
}
