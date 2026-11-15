"use client";

import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import Link from "next/link";
import { ArrowLeft, Check, FileCheck2, Printer, RefreshCw, Send, X } from "lucide-react";
import { loadFamilyStudents, rememberFamilyChild, restoreFamilyChild, type FamilyStudent } from "@/lib/attendance/family";
import { loadSchoolManagementAccess } from "@/lib/attendance/repository";
import { studentName } from "@/lib/attendance/types";
import { createClient } from "@/lib/supabase/client";
import {
  cancelPublication, decidePublication, getFamilyAssessmentResults, getFamilyNotificationResult, getResultSubmission, listPublicationCandidates,
  listResultSubmissions, previewPublication, printPublishedResult, publicationPageSize, requestPublication,
  resultDates as dates, resultTimes as times, ResultPublicationError, validatePublicationReason,
  type FamilyAssessmentResult, type FamilyResultPage, type PublicationDetail, type PublicationMetadata,
  type PublicationPage, type PublicationPreview, type PublicationPupil, type PublicationStatus, type PublicationSummary,
} from "@/lib/result-publication";
import { LoadingState } from "@/components/ui/skeleton";

type Client = ReturnType<typeof createClient>;
type Role = "teacher" | "admin" | "principal" | "parent" | "student";
type Load<T> = { data: T; error?: never } | { data?: never; error: string };
type Notice = { error: boolean; text: string };
type TeacherPreview = { kind: "source"; source: PublicationPreview } | { kind: "pending" | "published" };
type SchoolAccess = Awaited<ReturnType<typeof loadSchoolManagementAccess>>;
const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold disabled:opacity-50";
const primary = `${button} border-transparent bg-[var(--primary)] text-white dark:text-slate-950`;
const field = "min-w-0 space-y-2 text-sm font-semibold";
const labels: Record<PublicationStatus, string> = { pending: "Pending review", published: "Published", rejected: "Rejected", cancelled: "Cancelled" };
function errorText(error: unknown, fallback: string) { return error instanceof ResultPublicationError ? error.message : fallback; }
function useAlive() {
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  return alive;
}

type ResultLink = { initialChildId?: string; initialAssessmentId?: string };
export function ResultPublicationWorkspace({ role, userId, ...link }: { role: Role; userId: string } & ResultLink) {
  return <ResultSession key={`${userId}:${role}:${link.initialChildId ?? ""}:${link.initialAssessmentId ?? ""}`} role={role} userId={userId} {...link} />;
}
function ResultSession({ role, userId, ...link }: { role: Role; userId: string } & ResultLink) {
  const [client] = useState(createClient), [sessionChanged, setSessionChanged] = useState(false);
  useEffect(() => {
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) setSessionChanged(true);
    });
    return () => subscription.unsubscribe();
  }, [client, userId]);
  if (role === "parent" || role === "student") {
    return sessionChanged ? <ErrorMessage text="Your sign-in changed. Reload this page to verify results access." />
      : <FamilyResultAccess client={client} role={role} userId={userId} {...link} />;
  }
  return <div className="space-y-6">
    <header><p className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-blue-700 dark:text-blue-300"><FileCheck2 size={15} aria-hidden="true" /> Reviewed school results</p>
      <h1 className="mt-2 text-3xl font-black tracking-tight">{role === "teacher" ? "Result publication" : "Published assessment results"}</h1>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed muted">{role === "teacher" ? "Check an exam’s marks, then send them to the principal or office for approval. Families see a result only after it is approved."
        : "Review frozen result snapshots before sharing each pupil’s result with their permitted family."}</p></header>
    {sessionChanged ? <ErrorMessage text="Your sign-in changed. Reload this page to verify results access." />
      : role === "teacher" ? <TeacherPublications client={client} userId={userId} />
        : <OfficeResults client={client} userId={userId} />}
  </div>;
}

function TeacherPublications({ client, userId }: { client: Client; userId: string }) {
  const [attempt, setAttempt] = useState(0), [selected, setSelected] = useState("");
  const [candidates, setCandidates] = useState<{ attempt: number; value: Load<PublicationMetadata[]> }>();
  const [previewRefresh, setPreviewRefresh] = useState(0), [listRefresh, setListRefresh] = useState(0);
  const [preview, setPreview] = useState<{ key: string; value: Load<TeacherPreview> }>();
  const [saving, setSaving] = useState(false), [detailBusy, setDetailBusy] = useState(false), [notice, setNotice] = useState<Notice>();
  const requestsHeading = useRef<HTMLHeadingElement>(null);
  const alive = useAlive(), inFlight = useRef(false), request = useRef<{ payload: string; id: string } | null>(null);
  const currentCandidates = candidates?.attempt === attempt ? candidates.value : undefined;
  const selectedId = currentCandidates?.data?.some((row) => row.assessment_id === selected) ? selected : "";
  const key = `${selectedId}:${previewRefresh}`, currentPreview = preview?.key === key ? preview.value : undefined;
  const source = currentPreview?.data?.kind === "source" ? currentPreview.data.source : undefined;
  useEffect(() => {
    let active = true;
    listPublicationCandidates(client).then((data) => {
      if (!active) return;
      setCandidates({ attempt, value: { data } });
      setSelected((previous) => data.some((row) => row.assessment_id === previous) ? previous : data[0]?.assessment_id ?? "");
    }, (error: unknown) => { if (active) setCandidates({ attempt, value: { error: errorText(error, "Your assessments could not be loaded. Refresh to try again.") } }); });
    return () => { active = false; };
  }, [attempt, client]);
  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    async function loadPreview() {
      try {
        let publishedId: string | undefined;
        for (let offset = 0; active; offset += publicationPageSize) {
          const page = await listResultSubmissions(client, null, null, offset);
          if (!active) return;
          // Requests are ordered newest first, and an assessment can have only one pending request.
          const latest = page.rows.find((row) => row.assessment_id === selectedId && (row.status === "pending" || row.status === "published"));
          if (latest?.status === "pending") {
            setPreview({ key, value: { data: { kind: "pending" } } });
            return;
          }
          if (latest?.status === "published") {
            publishedId = latest.id;
            break;
          }
          if (offset + page.rows.length >= page.total_count) break;
          if (page.rows.length !== publicationPageSize) throw new Error("The request list changed while loading.");
        }
        const [source, published] = await Promise.all([
          previewPublication(client, selectedId),
          publishedId ? getResultSubmission(client, publishedId) : null,
        ]);
        if (!active) return;
        if (published && (published.status !== "published" || published.assessment_id !== selectedId || published.school_id !== source.metadata.school_id)) {
          throw new Error("The published snapshot does not match the selected assessment.");
        }
        const data: TeacherPreview = published?.source_token === source.source_token ? { kind: "published" } : { kind: "source", source };
        setPreview({ key, value: { data } });
      } catch (error) {
        if (active) setPreview({ key, value: { error: errorText(error, "The publication status and source preview could not be checked. Refresh assessments to try again.") } });
      }
    }
    void loadPreview();
    return () => { active = false; };
  }, [client, key, selectedId]);
  useEffect(() => {
    if (!listRefresh) return;
    const heading = requestsHeading.current;
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView?.({ block: "start" });
  }, [listRefresh]);
  function refreshPreview() {
    setPreviewRefresh((value) => value + 1);
    setNotice(undefined);
  }
  async function submit() {
    if (!source?.can_submit || inFlight.current || detailBusy) return;
    const payload = JSON.stringify([source.metadata.assessment_id, source.source_token]);
    inFlight.current = true; setSaving(true); setNotice(undefined);
    try {
      if (request.current?.payload !== payload) request.current = { payload, id: crypto.randomUUID() };
      await requestPublication(client, source.metadata.assessment_id, source.source_token, request.current.id);
      if (!alive.current) return;
      request.current = null;
      setPreview({ key, value: { data: { kind: "pending" } } });
      setListRefresh((value) => value + 1);
      setNotice({ error: false, text: "Publication requested. This snapshot stays private until an independent school reviewer publishes it." });
    } catch (error) { if (alive.current) setNotice({ error: true, text: errorText(error, "The request could not be confirmed. Retry the same preview or refresh saved requests.") }); }
    finally { inFlight.current = false; if (alive.current) setSaving(false); }
  }
  const busy = saving || detailBusy;
  return <>
    <section className="card space-y-4 p-5" aria-label="Assessment publication preview">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div className={`${field} sm:max-w-2xl sm:flex-1`}><label htmlFor="publication-assessment">Assessment</label>
        <select id="publication-assessment" className="field" value={selectedId} disabled={busy || !currentCandidates?.data} onChange={(event) => { setSelected(event.target.value); setNotice(undefined); }}>
          <option value="">Choose assessment</option>{currentCandidates?.data?.map((row) => <option key={row.assessment_id} value={row.assessment_id}>{row.name} · {row.class_name}{row.section_name ? ` / ${row.section_name}` : " / Whole class"} · {row.subject_name}</option>)}</select></div>
        <button type="button" className={button} disabled={busy || !currentCandidates} onClick={() => { setAttempt((value) => value + 1); refreshPreview(); }}><RefreshCw size={15} aria-hidden="true" />Refresh assessments</button></div>
      {notice?.error && <Message notice={notice} />}
      {!currentCandidates ? <LoadingState variant="list" className="text-sm muted">Loading your assessments…</LoadingState> : currentCandidates.error ? <ErrorMessage text={currentCandidates.error} />
        : !currentCandidates.data?.length ? <p className="text-sm muted">No current assigned assessments are available. Enter marks through Exam / Marks first.</p>
          : !selectedId ? <p className="text-sm muted">Choose an assessment to preview its complete roster.</p>
            : !currentPreview ? <LoadingState variant="list" className="text-sm muted">Loading the complete source preview…</LoadingState>
              : currentPreview.error ? <ErrorMessage text={currentPreview.error} /> : source ? <>
                <SourceHeading source={source.metadata} />
                {source.issues.length > 0 && <div role="alert" className="rounded-xl bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200"><p className="font-semibold">Not ready for publication</p><ul className="mt-2 list-disc space-y-1 pl-5">{source.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></div>}
                <PupilSnapshot pupils={source.pupils} maximum={source.metadata.maximum_marks} />
                <p className="text-xs leading-relaxed muted">Review every pupil and score. Missing marks are unmarked; a score of zero is valid.</p>
                <div className="flex flex-wrap gap-3"><button type="button" className={primary} disabled={busy || !source.can_submit} onClick={() => void submit()}><Send size={16} aria-hidden="true" />{saving ? "Requesting publication…" : "Request publication"}</button>
                  <button type="button" className={button} disabled={busy} onClick={refreshPreview}><RefreshCw size={15} aria-hidden="true" />Refresh source preview</button></div>
              </> : <p className="text-sm muted">{currentPreview.data?.kind === "published"
                ? "This assessment is published. Open the saved result in My publication requests below."
                : "This assessment is pending review. Track its status in My publication requests below."}</p>}
    </section>
    <SubmissionList key={listRefresh} client={client} schoolId={null} userId={userId} teacher externalBusy={saving}
      headingRef={requestsHeading} notice={notice?.error === false ? notice : undefined} onBusyChange={setDetailBusy} onRefresh={refreshPreview} />
  </>;
}

function OfficeResults({ client, userId }: { client: Client; userId: string }) {
  const [attempt, setAttempt] = useState(0), [selected, setSelected] = useState(""), [busy, setBusy] = useState(false);
  const [access, setAccess] = useState<{ attempt: number; value: Load<SchoolAccess> }>();
  const current = access?.attempt === attempt ? access.value : undefined;
  useEffect(() => {
    let active = true;
    loadSchoolManagementAccess(client, "result publication", ["school_admin", "principal"]).then((data) => {
      if (active) setAccess({ attempt, value: data.userId === userId ? { data } : { error: "Your sign-in changed. Reload to verify school access." } });
    }, () => { if (active) setAccess({ attempt, value: { error: "School publication access could not be verified. Refresh school access to try again." } }); });
    return () => { active = false; };
  }, [attempt, client, userId]);
  const schools = current?.data?.schools ?? [], schoolId = schools.some((row) => row.id === selected) ? selected : schools.length === 1 ? schools[0].id : "";
  return <><section className="card flex flex-col gap-4 p-5 sm:flex-row sm:items-end sm:justify-between" aria-label="Publication school access"><div className={`${field} sm:max-w-xl sm:flex-1`}><label htmlFor="publication-school">School</label><select id="publication-school" className="field" value={schoolId} disabled={busy || !current?.data || schools.length === 1} onChange={(event) => setSelected(event.target.value)}><option value="">Choose school</option>{schools.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></div>
    <button type="button" className={button} disabled={busy || !current} onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={15} aria-hidden="true" />Refresh school access</button></section>
    {!current ? <LoadingState variant="form" className="text-sm muted">Checking school access…</LoadingState> : current.error ? <ErrorMessage text={current.error} />
      : schoolId ? <SubmissionList key={schoolId} client={client} schoolId={schoolId} userId={userId} onBusyChange={setBusy} /> : <p className="text-sm muted">Choose a school to review result requests.</p>}
  </>;
}

function SubmissionList({ client, schoolId, userId, teacher = false, externalBusy = false, headingRef, notice, onBusyChange, onRefresh }: {
  client: Client; schoolId: string | null; userId: string; teacher?: boolean; externalBusy?: boolean;
  headingRef?: RefObject<HTMLHeadingElement | null>; notice?: Notice; onBusyChange: (busy: boolean) => void; onRefresh?: () => void;
}) {
  const [status, setStatus] = useState<PublicationStatus | "">(teacher ? "" : "pending"), [page, setPage] = useState(0), [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ key: string; value: Load<PublicationPage<PublicationSummary>> }>();
  const [selected, setSelected] = useState(""), [detailBusy, setDetailBusy] = useState(false), [detailRefresh, setDetailRefresh] = useState(0);
  const opener = useRef<HTMLButtonElement>(null);
  const localHeading = useRef<HTMLHeadingElement>(null);
  const listHeading = headingRef ?? localHeading;
  const key = `${schoolId}:${status}:${page}:${refresh}`, current = result?.key === key ? result.value : undefined;
  useEffect(() => {
    let active = true;
    listResultSubmissions(client, schoolId, status || null, page * publicationPageSize).then((data) => { if (active) setResult({ key, value: { data } }); },
      (error: unknown) => { if (active) setResult({ key, value: { error: errorText(error, "Publication requests could not be loaded. Refresh to try again.") } }); });
    return () => { active = false; };
  }, [client, key, page, schoolId, status]);
  useEffect(() => {
    const trigger = opener.current;
    if (selected || !trigger) return;
    opener.current = null;
    const target = trigger.isConnected && !trigger.disabled ? trigger : listHeading.current;
    target?.focus({ preventScroll: true });
  }, [selected, listHeading]);
  function lock(value: boolean) { setDetailBusy(value); onBusyChange(value); }
  function close() { setSelected(""); lock(false); }
  const busy = externalBusy || detailBusy;
  return <section className="space-y-5" aria-label={teacher ? "My publication requests" : "Result publication review"}>
    <div className="card space-y-4 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 ref={listHeading} tabIndex={-1} className="scroll-mt-24 text-lg font-bold">{teacher ? "My publication requests" : "Result publication requests"}</h2><button type="button" className={button} disabled={externalBusy} onClick={() => { setRefresh((value) => value + 1); onRefresh?.(); }}><RefreshCw size={15} aria-hidden="true" />Refresh requests</button></div>
      {notice && <Message notice={notice} />}
      <div className={`${field} max-w-xs`}><label htmlFor="publication-status">Request status</label><select id="publication-status" className="field" value={status} disabled={busy} onChange={(event) => { setStatus(event.target.value as PublicationStatus | ""); setPage(0); }}><option value="">All requests</option><option value="pending">Pending review</option><option value="published">Published</option><option value="rejected">Rejected</option><option value="cancelled">Cancelled</option></select></div>
      {!current ? <LoadingState variant="table" className="text-sm muted">Loading saved publication requests…</LoadingState> : current.error ? <ErrorMessage text={current.error} />
        : !current.data?.rows.length ? <p className="text-sm muted">No publication requests on this page.</p> : <ul className="divide-y divide-[var(--border)]">{current.data.rows.map((row) => <li key={row.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><h3 className="break-words font-semibold">{row.metadata.name}</h3><p className="mt-1 text-xs leading-relaxed muted">{row.metadata.class_name}{row.metadata.section_name && ` / ${row.metadata.section_name}`} · {row.metadata.subject_name} · {row.metadata.academic_year_name}</p><p className="mt-1 text-xs muted">Requested by {row.requester_name} · {times.format(new Date(row.requested_at))} IST</p></div><div className="flex flex-wrap items-center gap-3"><Status status={row.status} revision={row.revision} /><button type="button" className={button} aria-haspopup="dialog" disabled={busy} onClick={(event) => { opener.current = event.currentTarget; setSelected(row.id); setDetailRefresh((value) => value + 1); }}>Open result snapshot</button></div></li>)}</ul>}
      {current?.data && <Pagination page={page} total={current.data.total_count} count={current.data.rows.length} busy={busy} onPage={setPage} />}
    </div>
    {selected && <SubmissionDetail key={selected} client={client} submissionId={selected} refresh={detailRefresh} userId={userId} teacher={teacher}
      pendingFallback={teacher && current?.data?.rows.some((row) => row.id === selected && row.status === "pending") === true} disabled={externalBusy} onBusyChange={lock} onClose={close} onChanged={() => { setRefresh((value) => value + 1); setDetailRefresh((value) => value + 1); onRefresh?.(); }} />}
  </section>;
}

function SubmissionDetail({ client, submissionId, refresh, userId, teacher, pendingFallback = false, disabled, onBusyChange, onClose, onChanged }: {
  client: Client; submissionId: string; refresh: number; userId: string; teacher: boolean; pendingFallback?: boolean; disabled: boolean;
  onBusyChange: (busy: boolean) => void; onClose: () => void; onChanged: () => void;
}) {
  const [attempt, setAttempt] = useState(0), [result, setResult] = useState<{ key: string; value: Load<PublicationDetail>; denied?: boolean }>();
  const [reason, setReason] = useState(""), [saving, setSaving] = useState(false), [notice, setNotice] = useState<Notice>();
  const inFlight = useRef(false), alive = useAlive(), key = `${submissionId}:${attempt}:${refresh}`;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const dialogHeading = useRef<HTMLHeadingElement>(null);
  const current = result?.key === key ? result.value : undefined;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    dialogHeading.current?.focus();
  }, []);
  useEffect(() => {
    let active = true;
    getResultSubmission(client, submissionId).then((data) => { if (active) setResult({ key, value: { data } }); },
      (error: unknown) => { if (active) setResult({ key, value: { error: errorText(error, "The saved result snapshot could not be loaded. Refresh to try again.") },
        denied: error instanceof ResultPublicationError && error.code === "42501" }); });
    return () => { active = false; };
  }, [client, key, submissionId]);
  async function act(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const detail = current?.data, decision = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value");
    // The requester's own pending list row (server-filtered) still allows a cancel when the snapshot is hidden.
    const fallback = teacher && pendingFallback && Boolean(current?.error);
    if (inFlight.current || disabled || (!fallback && (!detail || detail.status !== "pending"))) return;
    const invalid = validatePublicationReason(reason);
    if (invalid) { setNotice({ error: true, text: invalid }); return; }
    if (teacher ? (!fallback && detail?.requested_by !== userId) || decision !== "cancelled" : !detail || !["published", "rejected"].includes(decision ?? "")) return;
    inFlight.current = true; setSaving(true); onBusyChange(true); setNotice(undefined);
    let confirmed = false;
    try {
      if (teacher) await cancelPublication(client, detail?.id ?? submissionId, reason); else await decidePublication(client, detail!.id, decision as "published" | "rejected", reason);
      if (!alive.current) return;
      confirmed = true; setReason(""); onBusyChange(false); onChanged();
      setNotice({ error: false, text: teacher ? "Request cancelled. Refresh the source preview before requesting review again." : decision === "published" ? "Result snapshot published. Each permitted family can now read only their own pupil’s result." : "Publication rejected. The decision and reason are saved privately." });
    } catch (error) { if (alive.current) setNotice({ error: true, text: errorText(error, "The action could not be confirmed. Your review reason is kept. Retry the same action or refresh its saved status.") }); }
    finally { inFlight.current = false; if (alive.current) { setSaving(false); onBusyChange(!confirmed && Boolean(reason.trim())); } }
  }
  function close() {
    if (inFlight.current || disabled) return;
    if (reason.trim() && !window.confirm("Discard the unsaved review reason?")) return;
    dialogRef.current?.close();
    onClose();
  }
  const detail = current?.data, own = detail?.requested_by === userId || detail?.viewer_entered_marks === true || detail?.snapshot.pupils.some((row) => row.mark_updated_by === userId);
  const reasonForm = <form className="space-y-4 rounded-xl bg-[var(--surface-2)] p-4" onSubmit={(event) => void act(event)}>
          <div className={field}><label htmlFor="publication-review-reason">{teacher ? "Cancellation reason" : "Review reason"}</label><textarea id="publication-review-reason" className="field" rows={3} minLength={3} maxLength={1000} required value={reason} disabled={saving || disabled} onChange={(event) => { setReason(event.target.value); onBusyChange(Boolean(event.target.value.trim())); }} /></div>
          <div className="flex flex-wrap gap-3">{teacher ? <button type="submit" value="cancelled" className={button} disabled={saving || disabled}><X size={16} aria-hidden="true" />{saving ? "Cancelling…" : "Cancel publication request"}</button> : <><button type="submit" value="published" className={primary} disabled={saving || disabled || detail?.source_matches !== true}><Check size={16} aria-hidden="true" />{saving ? "Saving review…" : "Publish result snapshot"}</button><button type="submit" value="rejected" className={`${button} text-red-700 dark:text-red-300`} disabled={saving || disabled}><X size={16} aria-hidden="true" />Reject publication</button></>}</div>
          <p className="text-xs leading-relaxed muted">A published snapshot is immutable. Publishing a later reviewed revision replaces the family’s latest view without exposing earlier private snapshots.</p>
        </form>;
  return <dialog
    ref={dialogRef}
    aria-labelledby="result-snapshot-title"
    onCancel={(event) => { event.preventDefault(); close(); }}
    className="fixed inset-0 m-auto h-dvh max-h-none w-full max-w-none overflow-hidden bg-[var(--surface)] text-[var(--text)] backdrop:bg-slate-950/65 backdrop:backdrop-blur-[3px] md:h-fit md:max-h-[calc(100dvh-3rem)] md:w-[min(58rem,calc(100vw-3rem))] md:rounded-2xl md:border md:border-[var(--border)] md:shadow-2xl"
  >
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)_auto] md:h-auto md:max-h-[calc(100dvh-3rem)]">
      <header className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3 sm:px-6 sm:py-4">
        <span className="hidden size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-2)] text-[var(--primary)] sm:flex"><FileCheck2 size={20} aria-hidden="true" /></span>
        <h2 ref={dialogHeading} id="result-snapshot-title" tabIndex={-1} className="min-w-0 flex-1 text-base font-bold tracking-tight sm:text-lg">Saved result snapshot</h2>
        <button type="button" className="btn btn-secondary size-11 shrink-0 p-0" aria-label="Refresh snapshot status" title="Refresh snapshot status" disabled={saving || disabled} onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={16} aria-hidden="true" /></button>
        <button type="button" className="btn btn-secondary size-11 shrink-0 p-0" aria-label="Close result details" title="Close result details" disabled={saving || disabled} onClick={close}><X size={18} aria-hidden="true" /></button>
      </header>
      <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain px-4 pt-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-6 sm:pt-5">
        {!current ? <LoadingState variant="list" className="text-sm muted">Loading the saved snapshot…</LoadingState> : current.error ? <>
          <ErrorMessage text={current.error} />
          {teacher && pendingFallback && <>{result?.denied ? <p className="text-sm muted">Your teaching assignment for this assessment changed, so the frozen snapshot is hidden. You can still cancel your pending request.</p>
            : <div className="flex flex-wrap items-center gap-3"><p className="text-sm muted">The saved snapshot could not be loaded right now. Retry, or cancel your pending request below.</p><button type="button" className={button} disabled={saving || disabled} onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={15} aria-hidden="true" />Retry loading snapshot</button></div>}{reasonForm}</>}
        </> : detail && <>
          <div className="flex flex-wrap items-start justify-between gap-3"><SourceHeading source={detail.snapshot.metadata} /><Status status={detail.status} revision={detail.revision} /></div>
          <PupilSnapshot pupils={detail.snapshot.pupils} maximum={detail.snapshot.metadata.maximum_marks} />
          {detail.reviewed_at && <div className="rounded-xl bg-[var(--surface-2)] p-4 text-sm"><p className="font-semibold">{labels[detail.status]}{detail.reviewer_name && ` by ${detail.reviewer_name}`} · {times.format(new Date(detail.reviewed_at))} IST</p><p className="mt-2 whitespace-pre-wrap break-words">{detail.review_note}</p></div>}
          {detail.status === "pending" && (!teacher || detail.requested_by === userId) && <>
            {detail.source_matches === false && <p role="alert" className="rounded-xl bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">The source marks, roster or assessment changed after this request. It cannot be published. The requester can cancel, refresh the source preview and submit a new snapshot; the school may reject this saved request.</p>}
            {!teacher && own ? <p className="text-sm muted">An independent reviewer must decide a request you submitted or entered marks for.</p> : reasonForm}
          </>}
        </>}
      </div>
      {notice && <footer className="border-t border-[var(--border)] px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6"><Message notice={notice} /></footer>}
    </div>
  </dialog>;
}

function FamilyResultAccess({ client, role, userId, initialChildId, initialAssessmentId }: { client: Client; role: "parent" | "student"; userId: string } & ResultLink) {
  const [attempt, setAttempt] = useState(0), [selected, setSelected] = useState("");
  const [resultRefresh, setResultRefresh] = useState(0);
  const [access, setAccess] = useState<{ attempt: number; value: Load<FamilyStudent[]> }>();
  const current = access?.attempt === attempt ? access.value : undefined;
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const { data: { user }, error } = await client.auth.getUser();
        if (error || user?.id !== userId) throw new Error("Account changed");
        const data = await loadFamilyStudents(client, role, userId);
        if (!active) return;
        setAccess({ attempt, value: { data } });
        setSelected((previous) => data.some((row) => row.id === previous) ? previous : initialChildId !== undefined ? data.find((row) => row.id === initialChildId)?.id ?? "" : role === "parent" ? restoreFamilyChild(userId, data) : data[0]?.id ?? "");
      } catch { if (active) setAccess({ attempt, value: { error: "Your linked students could not be verified. Refresh linked students to try again." } }); }
    }
    void load(); return () => { active = false; };
  }, [attempt, client, role, userId, initialChildId]);
  const students = current?.data ?? [], student = students.find((row) => row.id === selected);
  const assessmentId = student?.id === initialChildId ? initialAssessmentId : undefined;
  const refreshAccess = () => setAttempt((value) => value + 1);
  const childPicker = role === "parent" && (students.length > 1 || (!student && students.length > 0)) ? (
    <div className="flex min-w-0 items-center gap-2">
      <label htmlFor="result-child" className="shrink-0 text-xs font-semibold muted">Select child</label>
      <select id="result-child" className="field min-h-11 min-w-0 max-w-72 py-2" value={selected} onChange={(event) => {
        if (students.some((row) => row.id === event.target.value)) {
          setSelected(event.target.value);
          rememberFamilyChild(userId, event.target.value);
        }
      }}>
        {!student && <option value="">Choose linked child</option>}
        {students.map((row) => <option key={row.id} value={row.id}>{studentName(row)} · {row.admission_no}</option>)}
      </select>
    </div>
  ) : undefined;

  return <section className="space-y-4" aria-label="Student published results">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Published results</h1>
      {(childPicker || student) && <div className="flex min-w-0 flex-wrap items-center gap-2">
        {childPicker}
        {student && assessmentId !== undefined && <Link className="btn btn-secondary" href={`/modules/results?${new URLSearchParams({ ...(role === "parent" ? { view: "guardian" } : {}), child: student.id })}`}>
          <ArrowLeft size={15} aria-hidden="true" />All published results
        </Link>}
        {student && <button type="button" className="btn btn-secondary size-11 shrink-0 p-0" aria-label="Refresh published results" title="Refresh published results"
          onClick={() => setResultRefresh((value) => value + 1)}><RefreshCw size={17} aria-hidden="true" /></button>}
      </div>}
    </header>
    {student ? <FamilyResults key={student.id} client={client} student={student} role={role}
      assessmentId={assessmentId} refresh={resultRefresh} onRefreshAccess={refreshAccess} />
      : !current ? <LoadingState variant="list" className="text-sm muted">Checking linked student access…</LoadingState> : <div className="space-y-3">
      {current.error ? <ErrorMessage text={current.error} /> : <p className="card p-4 text-sm muted">{initialChildId !== undefined
        ? students.length ? "The student in this link is no longer available to this account. Choose a linked child to continue."
          : "The student in this link is no longer available to this account."
        : "No student is currently linked to this account."}</p>}
      <button type="button" className="btn btn-secondary" onClick={refreshAccess}><RefreshCw size={15} aria-hidden="true" />Refresh linked students</button>
    </div>}
  </section>;
}

function FamilyResults({ client, student, role, assessmentId, refresh, onRefreshAccess }: {
  client: Client; student: FamilyStudent; role: "parent" | "student"; assessmentId?: string; refresh: number; onRefreshAccess: () => void;
}) {
  const [page, setPage] = useState(0), [notice, setNotice] = useState<{ key: string; value: Notice }>();
  const [result, setResult] = useState<{ key: string; value: Load<FamilyResultPage> }>();
  const key = `${student.id}:${assessmentId ?? ""}:${page}:${refresh}`, current = result?.key === key ? result.value : undefined;
  useEffect(() => {
    let active = true;
    const request = assessmentId !== undefined
      ? getFamilyNotificationResult(client, role, student.id, student.school_id, assessmentId).then((row) => ({ rows: row ? [row] : [], total_count: row ? 1 : 0, offset: 0, student_id: student.id, school_id: student.school_id }))
      : getFamilyAssessmentResults(client, student.id, student.school_id, page * publicationPageSize);
    request.then((data) => { if (active) setResult({ key, value: { data } }); },
      (error: unknown) => { if (active) setResult({ key, value: { error: errorText(error, "Published results could not be loaded. Refresh to try again.") } }); });
    return () => { active = false; };
  }, [client, key, page, student.id, student.school_id, role, assessmentId]);
  return <>
    {notice?.key === key && <Message notice={notice.value} />}
    {!current ? <LoadingState variant="table" className="text-sm muted">Loading saved published results…</LoadingState> : current.error ? <div className="space-y-3">
      <ErrorMessage text={current.error} />
      <button type="button" className="btn btn-secondary" onClick={onRefreshAccess}><RefreshCw size={15} aria-hidden="true" />Refresh linked students</button>
    </div>
      : !current.data?.rows.length ? <p className="card p-4 text-sm muted">{assessmentId !== undefined ? "This published result is no longer available. Open all published results to see the current history." : "No school-published results on this page."}</p>
        : current.data.rows.map((row) => <FamilyResultCard key={row.id} result={row} onPrint={() => {
          try { printPublishedResult(row); }
          catch (error) { setNotice({ key, value: { error: true, text: errorText(error, "The print window could not be opened. Please try again.") } }); }
        }} />)}
    {current?.data && assessmentId === undefined && (page > 0 || current.data.total_count > publicationPageSize) && <Pagination page={page} total={current.data.total_count} count={current.data.rows.length} busy={false} onPage={setPage} />}
  </>;
}
function FamilyResultCard({ result, onPrint }: { result: FamilyAssessmentResult; onPrint: () => void }) {
  const assessment = result.metadata;
  return <article className="card overflow-hidden" aria-label={`${assessment.name} published result`}>
    <div className="space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h2 className="break-words text-lg font-bold tracking-tight sm:text-xl">{assessment.name}</h2>
          <p className="text-sm muted">{assessment.subject_name} · <time dateTime={assessment.assessment_date}>{dates.format(new Date(`${assessment.assessment_date}T00:00:00Z`))}</time></p>
        </div>
        <Status status="published" revision={result.revision} />
      </div>
      <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] divide-x divide-[var(--border)] rounded-xl bg-[var(--surface-2)] py-3 sm:py-4">
        <div className="min-w-0 px-3 sm:px-5"><dt className="text-xs font-semibold muted">Marks obtained</dt><dd className="mt-1 break-words text-2xl font-black tabular-nums sm:text-3xl">{result.marks_obtained}<span className="text-base font-semibold muted"> / {result.maximum_marks}</span></dd></div>
        <div className="min-w-0 px-3 sm:px-5"><dt className="text-xs font-semibold muted">Percentage</dt><dd className="mt-1 break-words text-2xl font-black tabular-nums sm:text-3xl">{result.percentage.toFixed(2)}%</dd></div>
      </dl>
      <div className="min-w-0 space-y-1 text-sm [overflow-wrap:anywhere]">
        <p><span className="font-semibold">{result.student_name}</span> <span className="muted">· {result.admission_no}{result.roll_no && ` · Roll ${result.roll_no}`}</span></p>
        <p className="text-xs muted">{assessment.class_name}{assessment.section_name ? ` / ${assessment.section_name}` : " / Whole class"} · {assessment.academic_year_name}</p>
      </div>
      {result.remarks && <div><h3 className="text-sm font-semibold">Teacher remarks</h3><p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed">{result.remarks}</p></div>}
    </div>
    <footer className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-[var(--border)] px-4 py-3 sm:px-5">
      <p className="min-w-0 text-xs leading-relaxed muted">Published by {result.publisher_name} · {times.format(new Date(result.published_at))} IST</p>
      <button type="button" className="btn btn-secondary" onClick={onPrint}><Printer size={16} aria-hidden="true" />Print this result</button>
    </footer>
  </article>;
}
function SourceHeading({ source }: { source: PublicationMetadata }) {
  return <div className="min-w-0"><h3 className="break-words font-bold">{source.name}</h3><p className="mt-1 text-sm muted">{source.subject_name} · {source.class_name}{source.section_name ? ` / ${source.section_name}` : " / Whole class"}</p><p className="mt-1 text-xs muted">{source.academic_year_name} · {dates.format(new Date(`${source.assessment_date}T00:00:00Z`))} · Maximum {source.maximum_marks}</p></div>;
}
function PupilSnapshot({ pupils, maximum }: { pupils: PublicationPupil[]; maximum: number }) {
  return <div className="space-y-3" aria-label="Result pupil snapshot"><p className="text-xs font-semibold muted">{pupils.length} {pupils.length === 1 ? "student" : "students"} in this result</p>{!pupils.length ? <p className="text-sm muted">No eligible pupils are in the assessment roster.</p> : <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">{pupils.map((row) => <li key={row.student_id} className="space-y-2 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="break-words font-semibold">{row.student_name}</p><p className="mt-1 text-xs muted">{row.admission_no}{row.roll_no && ` · Roll ${row.roll_no}`}{row.section_name && ` · ${row.section_name}`}</p></div><p className="text-sm font-bold tabular-nums">{row.marks_obtained === null ? "Unmarked" : `${row.marks_obtained} / ${maximum}`}</p></div>{row.remarks && <p className="whitespace-pre-wrap break-words text-sm muted">{row.remarks}</p>}</li>)}</ul>}</div>;
}
function Status({ status, revision }: { status: PublicationStatus; revision?: number | null }) {
  return <span className={`inline-flex shrink-0 items-center rounded-full px-3 py-1.5 text-xs font-semibold ${status === "published" ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300" : status === "pending" ? "bg-amber-500/10 text-amber-900 dark:text-amber-200" : "bg-[var(--surface-2)] muted"}`}>{labels[status]}{revision ? ` · Revision ${revision}` : ""}</span>;
}
function Message({ notice }: { notice: Notice }) { return <p role={notice.error ? "alert" : "status"} className={`rounded-xl p-4 text-sm ${notice.error ? "bg-red-500/10 text-red-700 dark:text-red-300" : "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"}`}>{notice.text}</p>; }
function ErrorMessage({ text }: { text: string }) { return <p role="alert" className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-700 dark:text-red-300">{text}</p>; }
function Pagination({ page, total, count, busy, onPage }: { page: number; total: number; count: number; busy: boolean; onPage: (page: number) => void }) {
  return <footer className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs muted">{count ? `${page * publicationPageSize + 1}–${page * publicationPageSize + count} of ${total}` : `Page ${page + 1} · ${total} records`}</p><div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy || page === 0} onClick={() => onPage(page - 1)}>Previous results</button><button type="button" className={button} disabled={busy || (page + 1) * publicationPageSize >= total} onClick={() => onPage(page + 1)}>Next results</button></div></footer>;
}
