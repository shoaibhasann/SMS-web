"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Check, FileCheck2, Printer, RefreshCw, Send, X } from "lucide-react";
import { loadFamilyStudents, rememberFamilyChild, restoreFamilyChild, type FamilyStudent } from "@/lib/attendance/family";
import { loadSchoolManagementAccess } from "@/lib/attendance/repository";
import { studentName } from "@/lib/attendance/types";
import { createClient } from "@/lib/supabase/client";
import {
  cancelPublication, decidePublication, getFamilyAssessmentResults, getFamilyNotificationResult, getResultSubmission, listPublicationCandidates,
  listResultSubmissions, previewPublication, printPublishedResult, publicationPageSize, requestPublication,
  ResultPublicationError, validatePublicationReason,
  type FamilyAssessmentResult, type FamilyResultPage, type PublicationDetail, type PublicationMetadata,
  type PublicationPage, type PublicationPreview, type PublicationPupil, type PublicationStatus, type PublicationSummary,
} from "@/lib/result-publication";
import { LoadingState } from "@/components/ui/skeleton";

type Client = ReturnType<typeof createClient>;
type Role = "teacher" | "admin" | "principal" | "parent" | "student";
type Load<T> = { data: T; error?: never } | { data?: never; error: string };
type Notice = { error: boolean; text: string };
type SchoolAccess = Awaited<ReturnType<typeof loadSchoolManagementAccess>>;
const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold disabled:opacity-50";
const primary = `${button} border-transparent bg-[var(--primary)] text-white dark:text-slate-950`;
const field = "min-w-0 space-y-2 text-sm font-semibold";
const dates = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const times = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
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
  return <div className="space-y-6">
    <header><p className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-blue-700 dark:text-blue-300"><FileCheck2 size={15} aria-hidden="true" /> Reviewed school results</p>
      <h1 className="mt-2 text-3xl font-black tracking-tight">Published assessment results</h1>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed muted">{role === "teacher" ? "Preview a completed assessment, request independent school review and follow its saved decision."
        : role === "admin" || role === "principal" ? "Review frozen result snapshots before sharing each pupil’s result with their permitted family."
          : "Read and print the latest school-published result for each assessment. Original class and session details stay with the saved result."}</p></header>
    {sessionChanged ? <ErrorMessage text="Your sign-in changed. Reload this page to verify results access." />
      : role === "teacher" ? <TeacherPublications client={client} userId={userId} />
        : role === "parent" || role === "student" ? <FamilyResultAccess client={client} role={role} userId={userId} {...link} />
          : <OfficeResults client={client} userId={userId} />}
  </div>;
}

function TeacherPublications({ client, userId }: { client: Client; userId: string }) {
  const [attempt, setAttempt] = useState(0), [selected, setSelected] = useState("");
  const [candidates, setCandidates] = useState<{ attempt: number; value: Load<PublicationMetadata[]> }>();
  const [previewRefresh, setPreviewRefresh] = useState(0), [listRefresh, setListRefresh] = useState(0);
  const [preview, setPreview] = useState<{ key: string; value: Load<PublicationPreview> }>();
  const [saving, setSaving] = useState(false), [detailBusy, setDetailBusy] = useState(false), [notice, setNotice] = useState<Notice>();
  const [sentToken, setSentToken] = useState("");
  const alive = useAlive(), inFlight = useRef(false), request = useRef<{ payload: string; id: string } | null>(null);
  const currentCandidates = candidates?.attempt === attempt ? candidates.value : undefined;
  const selectedId = currentCandidates?.data?.some((row) => row.assessment_id === selected) ? selected : "";
  const key = `${selectedId}:${previewRefresh}`, currentPreview = preview?.key === key ? preview.value : undefined;
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
    previewPublication(client, selectedId).then((data) => { if (active) setPreview({ key, value: { data } }); },
      (error: unknown) => { if (active) setPreview({ key, value: { error: errorText(error, "The source preview could not be loaded. Refresh to try again.") } }); });
    return () => { active = false; };
  }, [client, key, selectedId]);
  async function submit() {
    const source = currentPreview?.data;
    if (!source?.can_submit || inFlight.current || detailBusy) return;
    const payload = JSON.stringify([source.metadata.assessment_id, source.source_token]);
    inFlight.current = true; setSaving(true); setNotice(undefined);
    try {
      if (request.current?.payload !== payload) request.current = { payload, id: crypto.randomUUID() };
      await requestPublication(client, source.metadata.assessment_id, source.source_token, request.current.id);
      if (!alive.current) return;
      request.current = null; setSentToken(payload); setListRefresh((value) => value + 1);
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
        <button type="button" className={button} disabled={busy || !currentCandidates} onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={15} aria-hidden="true" />Refresh assessments</button></div>
      {notice && <Message notice={notice} />}
      {!currentCandidates ? <LoadingState variant="list" className="text-sm muted">Loading your assessments…</LoadingState> : currentCandidates.error ? <ErrorMessage text={currentCandidates.error} />
        : !currentCandidates.data?.length ? <p className="text-sm muted">No current assigned assessments are available. Enter marks through Exam / Marks first.</p>
          : !selectedId ? <p className="text-sm muted">Choose an assessment to preview its complete roster.</p>
            : !currentPreview ? <LoadingState variant="list" className="text-sm muted">Loading the complete source preview…</LoadingState>
              : currentPreview.error ? <ErrorMessage text={currentPreview.error} /> : currentPreview.data && <>
                <SourceHeading source={currentPreview.data.metadata} />
                {currentPreview.data.issues.length > 0 && <div role="alert" className="rounded-xl bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200"><p className="font-semibold">Not ready for publication</p><ul className="mt-2 list-disc space-y-1 pl-5">{currentPreview.data.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></div>}
                <PupilSnapshot pupils={currentPreview.data.pupils} maximum={currentPreview.data.metadata.maximum_marks} />
                <p className="text-xs leading-relaxed muted">Review every pupil and score. Missing marks are unmarked; a score of zero is valid. Preview refresh is explicit and does not publish anything.</p>
                <div className="flex flex-wrap gap-3"><button type="button" className={primary} disabled={busy || !currentPreview.data.can_submit || sentToken === JSON.stringify([selectedId, currentPreview.data.source_token])} onClick={() => void submit()}><Send size={16} aria-hidden="true" />{saving ? "Requesting publication…" : "Request publication"}</button>
                  <button type="button" className={button} disabled={busy} onClick={() => { setPreviewRefresh((value) => value + 1); setNotice(undefined); }}><RefreshCw size={15} aria-hidden="true" />Refresh source preview</button></div>
              </>}
    </section>
    <SubmissionList client={client} schoolId={null} userId={userId} teacher externalRefresh={listRefresh} externalBusy={saving} onBusyChange={setDetailBusy} onChanged={() => { setSentToken(""); setPreviewRefresh((value) => value + 1); }} />
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

function SubmissionList({ client, schoolId, userId, teacher = false, externalRefresh = 0, externalBusy = false, onBusyChange, onChanged }: {
  client: Client; schoolId: string | null; userId: string; teacher?: boolean; externalRefresh?: number; externalBusy?: boolean;
  onBusyChange: (busy: boolean) => void; onChanged?: () => void;
}) {
  const [status, setStatus] = useState<PublicationStatus | "">(teacher ? "" : "pending"), [page, setPage] = useState(0), [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ key: string; value: Load<PublicationPage<PublicationSummary>> }>();
  const [selected, setSelected] = useState(""), [detailBusy, setDetailBusy] = useState(false), [detailRefresh, setDetailRefresh] = useState(0);
  const key = `${schoolId}:${status}:${page}:${refresh}:${externalRefresh}`, current = result?.key === key ? result.value : undefined;
  useEffect(() => {
    let active = true;
    listResultSubmissions(client, schoolId, status || null, page * publicationPageSize).then((data) => { if (active) setResult({ key, value: { data } }); },
      (error: unknown) => { if (active) setResult({ key, value: { error: errorText(error, "Publication requests could not be loaded. Refresh to try again.") } }); });
    return () => { active = false; };
  }, [client, key, page, schoolId, status]);
  function lock(value: boolean) { setDetailBusy(value); onBusyChange(value); }
  function close() { setSelected(""); lock(false); }
  const busy = externalBusy || detailBusy;
  return <section className="space-y-5" aria-label={teacher ? "My publication requests" : "Result publication review"}>
    <div className="card space-y-4 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-bold">{teacher ? "My publication requests" : "Result publication requests"}</h2><button type="button" className={button} disabled={externalBusy} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={15} aria-hidden="true" />Refresh requests</button></div>
      <div className={`${field} max-w-xs`}><label htmlFor="publication-status">Request status</label><select id="publication-status" className="field" value={status} disabled={busy} onChange={(event) => { setStatus(event.target.value as PublicationStatus | ""); setPage(0); }}><option value="">All requests</option><option value="pending">Pending review</option><option value="published">Published</option><option value="rejected">Rejected</option><option value="cancelled">Cancelled</option></select></div>
      {!current ? <LoadingState variant="table" className="text-sm muted">Loading saved publication requests…</LoadingState> : current.error ? <ErrorMessage text={current.error} />
        : !current.data?.rows.length ? <p className="text-sm muted">No publication requests on this page.</p> : <ul className="divide-y divide-[var(--border)]">{current.data.rows.map((row) => <li key={row.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><h3 className="break-words font-semibold">{row.metadata.name}</h3><p className="mt-1 text-xs leading-relaxed muted">{row.metadata.class_name}{row.metadata.section_name && ` / ${row.metadata.section_name}`} · {row.metadata.subject_name} · {row.metadata.academic_year_name}</p><p className="mt-1 text-xs muted">Requested by {row.requester_name} · {times.format(new Date(row.requested_at))} IST</p></div><div className="flex flex-wrap items-center gap-3"><Status status={row.status} revision={row.revision} /><button type="button" className={button} disabled={busy} onClick={() => { setSelected(row.id); setDetailRefresh((value) => value + 1); }}>Open result snapshot</button></div></li>)}</ul>}
      {current?.data && <Pagination page={page} total={current.data.total_count} count={current.data.rows.length} busy={busy} onPage={setPage} />}
    </div>
    {selected && <SubmissionDetail key={selected} client={client} submissionId={selected} refresh={detailRefresh} userId={userId} teacher={teacher} disabled={externalBusy} onBusyChange={lock} onClose={close} onChanged={() => { setRefresh((value) => value + 1); setDetailRefresh((value) => value + 1); onChanged?.(); }} />}
  </section>;
}

function SubmissionDetail({ client, submissionId, refresh, userId, teacher, disabled, onBusyChange, onClose, onChanged }: {
  client: Client; submissionId: string; refresh: number; userId: string; teacher: boolean; disabled: boolean;
  onBusyChange: (busy: boolean) => void; onClose: () => void; onChanged: () => void;
}) {
  const [attempt, setAttempt] = useState(0), [result, setResult] = useState<{ key: string; value: Load<PublicationDetail> }>();
  const [reason, setReason] = useState(""), [saving, setSaving] = useState(false), [notice, setNotice] = useState<Notice>();
  const inFlight = useRef(false), alive = useAlive(), key = `${submissionId}:${attempt}:${refresh}`;
  const current = result?.key === key ? result.value : undefined;
  useEffect(() => {
    let active = true;
    getResultSubmission(client, submissionId).then((data) => { if (active) setResult({ key, value: { data } }); },
      (error: unknown) => { if (active) setResult({ key, value: { error: errorText(error, "The saved result snapshot could not be loaded. Refresh to try again.") } }); });
    return () => { active = false; };
  }, [client, key, submissionId]);
  async function act(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const detail = current?.data, decision = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value");
    if (inFlight.current || disabled || !detail || detail.status !== "pending") return;
    const invalid = validatePublicationReason(reason);
    if (invalid) { setNotice({ error: true, text: invalid }); return; }
    if (teacher ? detail.requested_by !== userId || decision !== "cancelled" : !["published", "rejected"].includes(decision ?? "")) return;
    inFlight.current = true; setSaving(true); onBusyChange(true); setNotice(undefined);
    let confirmed = false;
    try {
      if (teacher) await cancelPublication(client, detail.id, reason); else await decidePublication(client, detail.id, decision as "published" | "rejected", reason);
      if (!alive.current) return;
      confirmed = true; setReason(""); onBusyChange(false); onChanged();
      setNotice({ error: false, text: teacher ? "Request cancelled. Refresh the source preview before requesting review again." : decision === "published" ? "Result snapshot published. Each permitted family can now read only their own pupil’s result." : "Publication rejected. The decision and reason are saved privately." });
    } catch (error) { if (alive.current) setNotice({ error: true, text: errorText(error, "The action could not be confirmed. Your review reason is kept. Retry the same action or refresh its saved status.") }); }
    finally { inFlight.current = false; if (alive.current) { setSaving(false); onBusyChange(!confirmed && Boolean(reason.trim())); } }
  }
  function close() {
    if (reason.trim() && !window.confirm("Discard the unsaved review reason?")) return;
    onClose();
  }
  const detail = current?.data, own = detail?.requested_by === userId || detail?.snapshot.pupils.some((row) => row.mark_updated_by === userId);
  return <section className="card space-y-5 p-5" aria-label="Saved result snapshot"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-bold">Saved result snapshot</h2><div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={saving || disabled} onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={15} aria-hidden="true" />Refresh snapshot status</button><button type="button" className={button} disabled={saving || disabled} onClick={close}><X size={15} aria-hidden="true" />Close result details</button></div></div>
    {notice && <Message notice={notice} />}
    {!current ? <LoadingState variant="list" className="text-sm muted">Loading the saved snapshot…</LoadingState> : current.error ? <ErrorMessage text={current.error} /> : detail && <>
      <div className="flex flex-wrap items-center justify-between gap-3"><SourceHeading source={detail.snapshot.metadata} /><Status status={detail.status} revision={detail.revision} /></div>
      <PupilSnapshot pupils={detail.snapshot.pupils} maximum={detail.snapshot.metadata.maximum_marks} />
      {detail.reviewed_at && <div className="rounded-xl bg-[var(--surface-2)] p-4 text-sm"><p className="font-semibold">{labels[detail.status]}{detail.reviewer_name && ` by ${detail.reviewer_name}`} · {times.format(new Date(detail.reviewed_at))} IST</p><p className="mt-2 whitespace-pre-wrap break-words">{detail.review_note}</p></div>}
      {detail.status === "pending" && (teacher ? detail.requested_by === userId : true) && <>
        {detail.source_matches === false && <p role="alert" className="rounded-xl bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">The source marks, roster or assessment changed after this request. It cannot be published. The requester can cancel, refresh the source preview and submit a new snapshot; the school may reject this saved request.</p>}
        {!teacher && own ? <p className="text-sm muted">An independent reviewer must decide a request you submitted or entered marks for.</p> : <form className="space-y-4 rounded-xl bg-[var(--surface-2)] p-4" onSubmit={(event) => void act(event)}>
          <div className={field}><label htmlFor="publication-review-reason">{teacher ? "Cancellation reason" : "Review reason"}</label><textarea id="publication-review-reason" className="field" rows={3} minLength={3} maxLength={1000} required value={reason} disabled={saving || disabled} onChange={(event) => { setReason(event.target.value); onBusyChange(Boolean(event.target.value.trim())); }} /></div>
          <div className="flex flex-wrap gap-3">{teacher ? <button type="submit" value="cancelled" className={button} disabled={saving || disabled}><X size={16} aria-hidden="true" />{saving ? "Cancelling…" : "Cancel publication request"}</button> : <><button type="submit" value="published" className={primary} disabled={saving || disabled || detail.source_matches !== true}><Check size={16} aria-hidden="true" />{saving ? "Saving review…" : "Publish result snapshot"}</button><button type="submit" value="rejected" className={`${button} text-red-700 dark:text-red-300`} disabled={saving || disabled}><X size={16} aria-hidden="true" />Reject publication</button></>}</div>
          <p className="text-xs leading-relaxed muted">A published snapshot is immutable. Publishing a later reviewed revision replaces the family’s latest view without exposing earlier private snapshots.</p>
        </form>}
      </>}
    </>}
  </section>;
}

function FamilyResultAccess({ client, role, userId, initialChildId, initialAssessmentId }: { client: Client; role: "parent" | "student"; userId: string } & ResultLink) {
  const [attempt, setAttempt] = useState(0), [selected, setSelected] = useState("");
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
  return <><section className="card flex flex-col gap-4 p-5 sm:flex-row sm:items-end sm:justify-between" aria-label="Published result student access">
    {role === "parent" && students.length ? <div className={`${field} sm:max-w-xl sm:flex-1`}><label htmlFor="result-child">Select child</label><select id="result-child" className="field" value={selected} onChange={(event) => { if (students.some((row) => row.id === event.target.value)) { setSelected(event.target.value); rememberFamilyChild(userId, event.target.value); } }}>{!student && <option value="">Choose linked child</option>}{students.map((row) => <option key={row.id} value={row.id}>{studentName(row)} · {row.admission_no}</option>)}</select></div>
      : <div><h2 className="font-bold">{student ? studentName(student) : "Linked student access"}</h2>{student && <p className="mt-1 text-sm muted">{student.admission_no}</p>}</div>}
    <button type="button" className={button} disabled={!current} onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={15} aria-hidden="true" />Refresh linked students</button></section>
    {!current ? <LoadingState variant="form" className="text-sm muted">Checking linked student access…</LoadingState> : current.error ? <ErrorMessage text={current.error} /> : !student ? <p className="card p-5 text-sm muted">{initialChildId !== undefined ? "The student in this link is no longer available to this account. Choose a linked child to continue." : "No student is currently linked to this account."}</p>
      : <FamilyResults key={student.id} client={client} student={student} role={role} assessmentId={student.id === initialChildId ? initialAssessmentId : undefined} />}
  </>;
}
function FamilyResults({ client, student, role, assessmentId }: { client: Client; student: FamilyStudent; role: "parent" | "student"; assessmentId?: string }) {
  const [page, setPage] = useState(0), [refresh, setRefresh] = useState(0), [notice, setNotice] = useState<Notice>();
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
  return <section className="space-y-5" aria-label="Student published results"><div className="card flex flex-wrap items-center justify-between gap-3 p-5"><div><h2 className="text-lg font-bold">{assessmentId !== undefined ? "Result from notification" : "Published result history"}</h2><p className="mt-1 text-xs leading-relaxed muted">Only the latest published revision of each assessment is shown. Unpublished marks and other pupils’ results stay private.</p></div><button type="button" className={button} onClick={() => { setNotice(undefined); setRefresh((value) => value + 1); }}><RefreshCw size={15} aria-hidden="true" />Refresh published results</button></div>
    {assessmentId !== undefined && <Link className={button} href={`/modules/results?${new URLSearchParams({ ...(role === "parent" ? { view: "guardian" } : {}), child: student.id })}`}>All published results</Link>}
    {notice && <Message notice={notice} />}
    {!current ? <LoadingState variant="table" className="text-sm muted">Loading saved published results…</LoadingState> : current.error ? <ErrorMessage text={current.error} />
      : !current.data?.rows.length ? <p className="card p-5 text-sm muted">{assessmentId !== undefined ? "This published result is no longer available. Open all published results to see the current history." : "No school-published results on this page. Marks appear only after school review and publication."}</p>
        : current.data.rows.map((row) => <FamilyResultCard key={row.id} result={row} onPrint={() => { try { printPublishedResult(row); } catch (error) { setNotice({ error: true, text: errorText(error, "The print window could not be opened. Please try again.") }); } }} />)}
    {current?.data && assessmentId === undefined && <div className="card p-5"><Pagination page={page} total={current.data.total_count} count={current.data.rows.length} busy={false} onPage={setPage} /></div>}
  </section>;
}
function FamilyResultCard({ result, onPrint }: { result: FamilyAssessmentResult; onPrint: () => void }) {
  return <article className="card space-y-5 p-5" aria-label={`${result.metadata.name} published result`}><div className="flex flex-wrap items-start justify-between gap-3"><SourceHeading source={result.metadata} /><Status status="published" revision={result.revision} /></div>
    <div className="rounded-xl bg-[var(--surface-2)] p-4"><h3 className="font-bold">{result.student_name}</h3><p className="mt-1 text-xs muted">{result.admission_no}{result.roll_no && ` · Roll ${result.roll_no}`}</p><div className="mt-4 grid grid-cols-2 gap-4"><div><p className="text-xs muted">Marks obtained</p><p className="mt-1 text-2xl font-black tabular-nums">{result.marks_obtained}<span className="text-base font-semibold muted"> / {result.maximum_marks}</span></p></div><div><p className="text-xs muted">Percentage</p><p className="mt-1 text-2xl font-black tabular-nums">{result.percentage.toFixed(2)}%</p></div></div></div>
    {result.remarks && <div><h4 className="text-sm font-semibold">Teacher remarks</h4><p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed">{result.remarks}</p></div>}
    <p className="text-xs leading-relaxed muted">Published by {result.publisher_name} · {times.format(new Date(result.published_at))} IST. Original class/session snapshot · Revision {result.revision}.</p>
    <button type="button" className={button} onClick={onPrint}><Printer size={16} aria-hidden="true" />Print this result</button>
    <p className="text-xs leading-relaxed muted">This is a single-assessment result. Term grades, pass/fail and class rank are not included.</p>
  </article>;
}
function SourceHeading({ source }: { source: PublicationMetadata }) {
  return <div className="min-w-0"><h3 className="break-words font-bold">{source.name}</h3><p className="mt-1 text-sm muted">{source.subject_name} · {source.class_name}{source.section_name ? ` / ${source.section_name}` : " / Whole class"}</p><p className="mt-1 text-xs muted">{source.academic_year_name} · {dates.format(new Date(`${source.assessment_date}T00:00:00Z`))} · Maximum {source.maximum_marks}</p></div>;
}
function PupilSnapshot({ pupils, maximum }: { pupils: PublicationPupil[]; maximum: number }) {
  return <div className="space-y-3" aria-label="Result pupil snapshot"><p className="text-xs font-semibold muted">{pupils.length} pupils in this frozen source preview</p>{!pupils.length ? <p className="text-sm muted">No eligible pupils are in the assessment roster.</p> : <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">{pupils.map((row) => <li key={row.student_id} className="space-y-2 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="break-words font-semibold">{row.student_name}</p><p className="mt-1 text-xs muted">{row.admission_no}{row.roll_no && ` · Roll ${row.roll_no}`}{row.section_name && ` · ${row.section_name}`}</p></div><p className="text-sm font-bold tabular-nums">{row.marks_obtained === null ? "Unmarked" : `${row.marks_obtained} / ${maximum}`}</p></div>{row.remarks && <p className="whitespace-pre-wrap break-words text-sm muted">{row.remarks}</p>}</li>)}</ul>}</div>;
}
function Status({ status, revision }: { status: PublicationStatus; revision?: number | null }) {
  return <span className={`inline-flex shrink-0 items-center rounded-full px-3 py-1.5 text-xs font-semibold ${status === "published" ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300" : status === "pending" ? "bg-amber-500/10 text-amber-900 dark:text-amber-200" : "bg-[var(--surface-2)] muted"}`}>{labels[status]}{revision ? ` · Revision ${revision}` : ""}</span>;
}
function Message({ notice }: { notice: Notice }) { return <p role={notice.error ? "alert" : "status"} className={`rounded-xl p-4 text-sm ${notice.error ? "bg-red-500/10 text-red-700 dark:text-red-300" : "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"}`}>{notice.text}</p>; }
function ErrorMessage({ text }: { text: string }) { return <p role="alert" className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-700 dark:text-red-300">{text}</p>; }
function Pagination({ page, total, count, busy, onPage }: { page: number; total: number; count: number; busy: boolean; onPage: (page: number) => void }) {
  return <footer className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs muted">{count ? `${page * publicationPageSize + 1}–${page * publicationPageSize + count} of ${total}` : `Page ${page + 1} · ${total} records`}</p><div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy || page === 0} onClick={() => onPage(page - 1)}>Previous results</button><button type="button" className={button} disabled={busy || (page + 1) * publicationPageSize >= total} onClick={() => onPage(page + 1)}>Next results</button></div></footer>;
}
