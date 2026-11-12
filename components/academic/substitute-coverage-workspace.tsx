"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { loadSchoolManagementAccess } from "@/lib/attendance/repository";
import { createClient } from "@/lib/supabase/client";
import { LoadingState } from "@/components/ui/skeleton";

type Setup = {
  year: { id: string; name: string; start_date: string; end_date: string };
  today: string;
  teachers: { id: string; full_name: string | null; employee_id: string | null }[];
  assignments: { id: string; teacher_id: string; teacher_name: string; class_name: string; section_name: string; subject_name: string }[];
  coverages: { id: string; source_assignment_id: string; substitute_teacher_id: string; substitute_teacher_name: string;
    source_teacher_name: string; class_name: string; section_name: string; starts_on: string; ends_on: string;
    reason: string; created_at: string; created_by_name: string | null; revoked_at: string | null;
    revoke_reason: string | null; status: "active" | "scheduled" | "expired" | "revoked" | "invalid" }[];
};
type Access = Awaited<ReturnType<typeof loadSchoolManagementAccess>>;
const button = "min-h-11 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50";
const label = "block min-w-0 space-y-2 text-sm font-semibold";
const statusLabels = { active: "Active", scheduled: "Scheduled", expired: "Expired", revoked: "Revoked", invalid: "Invalid" } as const;
const dateFormat = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "UTC" });
function displayDate(day: string) {
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? day : dateFormat.format(date);
}
function errorText(error: unknown) {
  const { code, message } = (error ?? {}) as { code?: string; message?: string };
  // The RPC's stale-choice checks also use 42501; only actor-permission failures mean access changed.
  if (code === "42501" && message?.startsWith("Choose a ")) return `${message} Refresh coverage to see current choices.`;
  if (code === "42501") return "Your school access changed. Refresh before trying again.";
  if (code === "23505" || code === "23P01") return "Coverage overlaps an existing assignment. Refresh and check the dates.";
  if ((code === "22023" || code === "55000") && message) return message;
  if (code === "22023" || code === "55000") return "Check the current assignment, substitute and dates, then refresh before trying again.";
  return "Coverage could not be saved. Refresh and check its status before retrying.";
}

export function SubstituteCoverageWorkspace({ userId, assignmentRevision = 0 }: { userId: string; assignmentRevision?: number }) {
  const [client] = useState(createClient);
  const [access, setAccess] = useState<Access>();
  const [accessError, setAccessError] = useState("");
  const [schoolId, setSchoolId] = useState("");
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ key: string; setup?: Setup; error?: string }>();
  const [assignmentId, setAssignmentId] = useState("");
  const [substituteId, setSubstituteId] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [reason, setReason] = useState("");
  const [removal, setRemoval] = useState<string>();
  const [revokeReason, setRevokeReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessionChanged, setSessionChanged] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>();
  const inFlight = useRef(false);
  const createRequest = useRef<{ payload: string; id: string } | undefined>(undefined);
  const mutationRequest = useRef<AbortController | undefined>(undefined);
  const headingId = useId();
  const key = `${schoolId}:${revision}:${assignmentRevision}`;
  const setup = result?.key === key ? result.setup : undefined;
  const loadError = result?.key === key ? result.error : undefined;
  const assignment = setup?.assignments.find((item) => item.id === assignmentId);
  const selectedRemoval = setup?.coverages.find((item) => item.id === removal);
  const dirty = Boolean(assignmentId || substituteId || start || end || reason || removal);
  const [checkedSetup, setCheckedSetup] = useState<Setup>();
  if (setup && setup !== checkedSetup) {
    // A reload (e.g. after an assignment change) can drop what the draft or revoke confirmation points at.
    setCheckedSetup(setup);
    if (removal && (!selectedRemoval || selectedRemoval.revoked_at || selectedRemoval.status === "revoked")) {
      setRemoval(undefined); setRevokeReason("");
      setMessage({ text: "The coverage you were revoking changed or is no longer listed. Review the current coverage history." });
    }
    const staleAssignment = Boolean(assignmentId && !assignment);
    const staleSubstitute = Boolean(substituteId && (staleAssignment || substituteId === assignment?.teacher_id
      || !setup.teachers.some((item) => item.id === substituteId)));
    if (staleAssignment || staleSubstitute) {
      if (staleAssignment) setAssignmentId("");
      setSubstituteId("");
      setMessage({ text: "The class-teacher assignment or substitute you chose changed. Choose them again." });
    }
  }

  useEffect(() => {
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) {
        mutationRequest.current?.abort();
        setSessionChanged(true);
      }
    });
    return () => { subscription.unsubscribe(); mutationRequest.current?.abort(); };
  }, [client, userId]);

  useEffect(() => {
    let active = true;
    loadSchoolManagementAccess(client, "substitute attendance coverage", ["school_admin", "principal"]).then((value) => {
      if (!active) return;
      if (value.userId !== userId) { setSessionChanged(true); return; }
      setAccess(value);
      if (value.schools.length === 1) setSchoolId(value.schools[0].id);
    }, () => { if (active) setAccessError("School access could not be loaded. Reopen this page to try again."); });
    return () => { active = false; };
  }, [client, userId]);

  useEffect(() => {
    if (!schoolId || sessionChanged) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const { data, error } = await client.rpc("get_substitute_attendance_setup", { p_school_id: schoolId })
          .abortSignal(controller.signal).returns<unknown>();
        const value = data as Setup | null;
        if (error || !value?.year || typeof value.today !== "string" || !Array.isArray(value.teachers)
          || !Array.isArray(value.assignments) || !Array.isArray(value.coverages)) throw error ?? new Error();
        if (!controller.signal.aborted) setResult({ key, setup: value });
      } catch {
        if (!controller.signal.aborted) setResult({ key, error: "Substitute coverage could not be loaded. Refresh coverage to try again." });
      }
    })();
    return () => controller.abort();
  }, [client, key, schoolId, sessionChanged]);

  function clear() {
    setAssignmentId(""); setSubstituteId(""); setStart(""); setEnd(""); setReason("");
    setRemoval(undefined); setRevokeReason(""); createRequest.current = undefined;
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!setup || !assignment || !substituteId || !start || !end || reason.trim().length < 5 || sessionChanged || inFlight.current) return;
    inFlight.current = true; setBusy(true); setMessage(undefined);
    const controller = new AbortController(); mutationRequest.current = controller;
    const payload = { p_school_id: schoolId, p_source_assignment_id: assignmentId, p_substitute_teacher_id: substituteId,
      p_starts_on: start, p_ends_on: end, p_reason: reason.trim() };
    const encoded = JSON.stringify(payload);
    if (createRequest.current?.payload !== encoded) createRequest.current = { payload: encoded, id: crypto.randomUUID() };
    try {
      const { data, error } = await client.rpc("create_substitute_attendance_coverage", { ...payload, p_request_id: createRequest.current.id }).abortSignal(controller.signal);
      if (error || typeof data !== "string") throw error ?? new Error();
      if (controller.signal.aborted) return;
      clear(); setMessage({ text: "Substitute attendance coverage assigned." }); setRevision((value) => value + 1);
    } catch (error) { if (!controller.signal.aborted) setMessage({ text: errorText(error), error: true }); }
    finally {
      if (mutationRequest.current === controller) { inFlight.current = false; mutationRequest.current = undefined; }
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  async function revoke(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedRemoval || revokeReason.trim().length < 5 || sessionChanged || inFlight.current) return;
    inFlight.current = true; setBusy(true); setMessage(undefined);
    const controller = new AbortController(); mutationRequest.current = controller;
    try {
      const { data, error } = await client.rpc("revoke_substitute_attendance_coverage", {
        p_school_id: schoolId, p_coverage_id: selectedRemoval.id, p_reason: revokeReason.trim(),
      }).abortSignal(controller.signal);
      if (error || typeof data !== "boolean") throw error ?? new Error();
      if (controller.signal.aborted) return;
      clear(); setMessage({ text: data ? "Substitute attendance coverage revoked." : "This coverage was already revoked." });
      setRevision((value) => value + 1);
    } catch (error) { if (!controller.signal.aborted) setMessage({ text: errorText(error), error: true }); }
    finally {
      if (mutationRequest.current === controller) { inFlight.current = false; mutationRequest.current = undefined; }
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <section className="card space-y-4 p-4 sm:p-5" aria-labelledby={headingId}>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 id={headingId} className="text-lg font-bold">Substitute attendance coverage</h2>
        <p className="mt-1 text-sm muted">Assign temporary class-teacher attendance duties for a date range in IST.</p></div>
      <button type="button" className={button} disabled={busy || (dirty && !loadError) || sessionChanged} onClick={() => {
        // A failed reload hides the draft controls, so Refresh is the way out and drops the draft.
        clear(); setMessage(undefined); setRevision((value) => value + 1);
      }}>Refresh coverage</button>
    </header>
    {sessionChanged ? <p role="alert" className="text-sm text-danger">Your sign-in changed. Reopen this page to check coverage access.</p>
      : accessError ? <p role="alert" className="text-sm text-danger">{accessError}</p>
        : !access ? <LoadingState variant="form" className="text-sm muted">Checking coverage access…</LoadingState>
          : <>
            <label className={`${label} max-w-md`}>Coverage school
              <select className="field" value={schoolId} disabled={busy || dirty || access.schools.length === 1} onChange={(event) => {
                clear(); setSchoolId(event.target.value); setMessage(undefined);
              }}><option value="">Select school</option>{access.schools.map((school) => <option key={school.id} value={school.id}>{school.name}</option>)}</select>
            </label>
            {message && <p role={message.error ? "alert" : "status"} className={`text-sm ${message.error ? "text-red-700 dark:text-red-300" : "muted"}`}>{message.text}
              {message.error && dirty && !loadError && <span className="mt-1 block muted">{removal
                ? "Choose Keep coverage to close this confirmation and enable Refresh coverage."
                : "Your draft is kept. Choose Cancel coverage draft to enable Refresh coverage."}</span>}
            </p>}
            {!schoolId ? <p className="text-sm muted">Select a school to manage coverage.</p>
              : loadError ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{loadError}
                {dirty && <span className="mt-1 block muted">Refreshing discards your unsaved coverage draft.</span>}</p>
                : !setup ? <LoadingState variant="list" className="text-sm muted">Loading substitute coverage…</LoadingState>
                  : <>
                    <form aria-label="Assign substitute attendance coverage" onSubmit={create} className="space-y-4 rounded-xl border border-[var(--border)] p-4">
                      <p className="text-sm muted">{setup.year.name} · Coverage starts from today or a later date in this session.</p>
                      <fieldset disabled={busy || Boolean(selectedRemoval)} className="grid gap-4 sm:grid-cols-2">
                        <label className={label}>Class-teacher assignment<select required className="field" value={assignmentId} onChange={(event) => { setAssignmentId(event.target.value); setSubstituteId(""); }}>
                          <option value="">Select class-teacher assignment</option>{setup.assignments.map((item) => <option key={item.id} value={item.id}>{item.class_name} / {item.section_name} · {item.teacher_name}</option>)}
                        </select></label>
                        <label className={label}>Substitute teacher<select required className="field" value={substituteId} disabled={!assignment || busy || Boolean(selectedRemoval)} onChange={(event) => setSubstituteId(event.target.value)}>
                          <option value="">Select substitute teacher</option>{setup.teachers.filter((item) => item.id !== assignment?.teacher_id).map((item) => <option key={item.id} value={item.id}>{item.full_name || item.employee_id || "Teacher"}</option>)}
                        </select></label>
                        <label className={label}>Coverage start date<input type="date" required className="field" min={setup.today} max={setup.year.end_date} value={start} onChange={(event) => setStart(event.target.value)} /></label>
                        <label className={label}>Coverage end date<input type="date" required className="field" min={start || setup.today} max={setup.year.end_date} value={end} onChange={(event) => setEnd(event.target.value)} /></label>
                        <label className={`${label} sm:col-span-2`}>Coverage reason<textarea required minLength={5} maxLength={300} className="field min-h-20" value={reason} onChange={(event) => setReason(event.target.value)} /></label>
                        <div className="flex flex-wrap gap-2 sm:col-span-2"><button type="submit" className={`${button} bg-blue-700 text-white`} disabled={!assignment || !substituteId || !start || !end || reason.trim().length < 5}>Assign substitute</button>
                          {dirty && <button type="button" className={button} onClick={clear}>Cancel coverage draft</button>}</div>
                      </fieldset>
                    </form>
                    <div className="space-y-3"><h3 className="font-bold">Coverage history</h3>
                      {setup.coverages.length === 0 ? <p className="text-sm muted">No substitute attendance coverage recorded for this school.</p>
                        : <ul className="divide-y divide-[var(--border)]">{setup.coverages.map((item) => <li key={item.id} className="space-y-2 py-3">
                          <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="break-words font-semibold">{item.class_name} / {item.section_name} · {item.substitute_teacher_name}</p>
                            <p className="mt-1 text-sm muted">{displayDate(item.starts_on)} – {displayDate(item.ends_on)} IST · Covering {item.source_teacher_name}</p></div>
                            <span className={`badge${item.status === "active" ? " text-success" : ""}`}>{statusLabels[item.status]}</span></div>
                          <p className="break-words text-sm muted">{item.reason}</p>
                          {item.revoke_reason && <p className="break-words text-sm muted">Revoke reason · {item.revoke_reason}</p>}
                          {!item.revoked_at && item.status !== "revoked" && <button type="button" className={button} disabled={busy || dirty} onClick={() => { setRemoval(item.id); setRevokeReason(""); setMessage(undefined); }}>Revoke coverage</button>}
                          {selectedRemoval?.id === item.id && <form aria-label="Revoke substitute coverage" onSubmit={revoke} className="space-y-3 rounded-xl border border-red-300 p-3 dark:border-red-800">
                            <p className="text-sm">End {item.substitute_teacher_name}’s attendance access for this coverage?</p>
                            <label className={label}>Revoke reason<textarea required minLength={5} maxLength={300} className="field min-h-20" value={revokeReason} disabled={busy} onChange={(event) => setRevokeReason(event.target.value)} /></label>
                            <div className="flex flex-wrap gap-2"><button className={button} type="submit" disabled={busy || revokeReason.trim().length < 5}>Confirm revoke coverage</button>
                              <button className={button} type="button" disabled={busy} onClick={() => setRemoval(undefined)}>Keep coverage</button></div>
                          </form>}
                        </li>)}</ul>}
                    </div>
                  </>}
          </>}
  </section>;
}
