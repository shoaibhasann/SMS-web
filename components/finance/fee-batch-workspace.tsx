"use client";

import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CheckCircle2, FileSpreadsheet, Layers3, RefreshCw, ShieldCheck } from "lucide-react";
import { readPages } from "@/lib/attendance/repository";
import { schoolDate } from "@/lib/attendance/types";
import {
  feeMoney, formatFeeMoney, listFeeBatches, maxOpeningBalanceCsvBytes, openingBalanceCsvTemplate, parseOpeningBalanceCsv, postFeeBatch, previewFeeBatch,
  type FeeBatchKind, type FeeBatchPayload, type FeeBatchPreview, type FeeBatchReceipt,
} from "@/lib/finance/fee-batches";

type Structure = { id: string; name: string; amount: number; frequency: string; academic_year_id: string; class_id: string | null };
type ClassOption = { id: string; name: string; is_active: boolean };
type SectionOption = { id: string; name: string; class_id: string };
type PendingBatch = {
  version: 1;
  kind: FeeBatchKind;
  payload: FeeBatchPayload;
  previewToken: string;
  requestId: string;
  readyCount: number;
  existingCount: number;
  amount: string;
};
type ReviewedBatch = { kind: FeeBatchKind; payload: FeeBatchPayload; result: FeeBatchPreview };
type Feedback = { kind: "error" | "retry" | "success"; text: string };
type Props = {
  client: SupabaseClient;
  schoolId: string;
  academicYearId: string;
  userId: string;
  structures: readonly Structure[];
  disabled?: boolean;
  onPosted: () => void;
};

const pageSize = 40;
const buttonClass = "min-h-11 rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold disabled:opacity-50";
const primaryClass = "min-h-11 rounded-xl bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50";
const postedDate = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const openingBalanceGuidance = "Import only outstanding debt not already recorded in this ERP. Reconcile this file against the existing ledger before posting.";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validPayload(value: unknown, kind: FeeBatchKind, yearId: string): value is FeeBatchPayload {
  if (!isObject(value) || value.academic_year_id !== yearId) return false;
  if (kind === "monthly") return typeof value.fee_structure_id === "string" && typeof value.billing_period === "string"
    && (value.due_date === null || typeof value.due_date === "string")
    && (value.class_id === null || typeof value.class_id === "string")
    && (value.section_id === null || typeof value.section_id === "string");
  return typeof value.as_of_date === "string" && typeof value.source_reference === "string" && typeof value.reason === "string"
    && Array.isArray(value.rows) && value.rows.length > 0 && value.rows.length <= 1500
    && value.rows.every((row) => isObject(row) && typeof row.admission_no === "string" && typeof row.amount === "string");
}

function readPending(key: string, yearId: string): { attempt?: PendingBatch; damaged: boolean } {
  try {
    const saved = sessionStorage.getItem(key);
    if (!saved) return { damaged: false };
    const value: unknown = JSON.parse(saved);
    if (isObject(value) && value.version === 1 && (value.kind === "monthly" || value.kind === "opening")
      && validPayload(value.payload, value.kind, yearId)
      && typeof value.requestId === "string" && uuidPattern.test(value.requestId)
      && typeof value.previewToken === "string" && value.previewToken.length > 0 && value.previewToken.length <= 256
      && Number.isSafeInteger(value.readyCount) && Number(value.readyCount) > 0
      && Number.isSafeInteger(value.existingCount) && Number(value.existingCount) >= 0
      && typeof value.amount === "string" && feeMoney(value.amount) === value.amount && BigInt(value.amount.replace(".", "")) > BigInt(0)) {
      return { attempt: value as PendingBatch, damaged: false };
    }
    return { damaged: true };
  } catch {
    return { damaged: true };
  }
}

function writePending(key: string, attempt?: PendingBatch) {
  try {
    if (attempt) sessionStorage.setItem(key, JSON.stringify(attempt));
    else sessionStorage.removeItem(key);
  } catch {
    // The mounted page still retains the same frozen request for retry.
  }
}

function errorCode(error: unknown) {
  return isObject(error) && typeof error.code === "string" ? error.code : "";
}

export function FeeBatchWorkspace(props: Props) {
  return <ScopedFeeBatchWorkspace key={`${props.userId}:${props.schoolId}:${props.academicYearId}`} {...props} />;
}

function ScopedFeeBatchWorkspace({ client, schoolId, academicYearId, userId, structures, disabled = false, onPosted }: Props) {
  const id = useId();
  const storageKey = `kids-corner-fee-batch:v1:${userId}:${schoolId}:${academicYearId}`;
  const [kind, setKind] = useState<FeeBatchKind>("monthly");
  const [classId, setClassId] = useState("");
  const [sectionId, setSectionId] = useState("");
  const [structureId, setStructureId] = useState("");
  const [month, setMonth] = useState(() => schoolDate().slice(0, 7));
  const [dueDate, setDueDate] = useState("");
  const [asOfDate, setAsOfDate] = useState(schoolDate);
  const [source, setSource] = useState("");
  const [reason, setReason] = useState("");
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [sections, setSections] = useState<SectionOption[]>([]);
  const [yearNames, setYearNames] = useState<Record<string, string>>({});
  const [setupLoaded, setSetupLoaded] = useState(false);
  const [setupError, setSetupError] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [damagedRecovery, setDamagedRecovery] = useState(false);
  const [sessionChanged, setSessionChanged] = useState(false);
  const [history, setHistory] = useState<FeeBatchReceipt[]>();
  const [historyError, setHistoryError] = useState(false);
  const [historyPage, setHistoryPage] = useState(0);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [reviewed, setReviewed] = useState<ReviewedBatch>();
  const [previewing, setPreviewing] = useState(false);
  const [reading, setReading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [attempt, setAttempt] = useState<PendingBatch>();
  const [confirming, setConfirming] = useState(false);
  const [checked, setChecked] = useState(false);
  const [previewPage, setPreviewPage] = useState(0);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>();
  const [receipt, setReceipt] = useState<FeeBatchReceipt>();
  const mounted = useRef(true);
  const scopeValid = useRef(true);
  const inFlight = useRef(false);
  const fileRead = useRef(0);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const confirmCheckbox = useRef<HTMLInputElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (reviewed) previewHeading.current?.focus();
  }, [reviewed]);

  useEffect(() => {
    if (confirming) confirmCheckbox.current?.focus();
  }, [confirming]);

  useEffect(() => {
    if (attempt && !posting) retryButton.current?.focus();
  }, [attempt, posting]);

  useEffect(() => {
    let active = true;
    mounted.current = true;
    scopeValid.current = true;
    queueMicrotask(() => {
      if (!active || !mounted.current || !scopeValid.current) return;
      const saved = readPending(storageKey, academicYearId);
      setAttempt(saved.attempt);
      if (saved.attempt) setKind(saved.attempt.kind);
      setDamagedRecovery(saved.damaged);
      setStorageReady(true);
    });
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (!mounted.current || session?.user.id === userId) return;
      scopeValid.current = false;
      setSessionChanged(true);
      setReviewed(undefined);
      setReceipt(undefined);
      setHistory(undefined);
    });
    return () => { active = false; mounted.current = false; scopeValid.current = false; subscription.unsubscribe(); };
  }, [academicYearId, client, storageKey, userId]);

  useEffect(() => {
    let active = true;
    Promise.all([
      readPages<ClassOption>((from, to) => client.from("classes").select("id,name,is_active", { count: "exact" })
        .eq("school_id", schoolId).eq("is_active", true).order("sort_order").order("id").range(from, to), "Fee classes"),
      readPages<SectionOption>((from, to) => client.from("sections").select("id,name,class_id", { count: "exact" })
        .eq("school_id", schoolId).order("name").order("id").range(from, to), "Fee sections"),
      readPages<{ id: string; name: string }>((from, to) => client.from("academic_years").select("id,name", { count: "exact" })
        .eq("school_id", schoolId).order("start_date", { ascending: false }).order("id").range(from, to), "Fee academic years"),
    ]).then(([loadedClasses, loadedSections, years]) => {
      if (!active || !scopeValid.current) return;
      setClasses(loadedClasses); setSections(loadedSections); setYearNames(Object.fromEntries(years.map((year) => [year.id, year.name]))); setSetupLoaded(true); setSetupError(false);
    }, () => { if (active && scopeValid.current) { setSetupError(true); setSetupLoaded(false); } });
    return () => { active = false; };
  }, [client, schoolId]);

  useEffect(() => {
    let active = true;
    listFeeBatches(client, schoolId, 21, historyPage * 20).then((items) => {
      if (!active || !scopeValid.current) return;
      setHistory(items.slice(0, 20)); setHistoryHasMore(items.length > 20); setHistoryError(false);
    }, () => { if (active && scopeValid.current) { setHistory(undefined); setHistoryError(true); } });
    return () => { active = false; };
  }, [client, schoolId, historyPage, historyVersion]);

  function isCurrent() { return mounted.current && scopeValid.current; }

  async function verifySession() {
    const { data: { user }, error } = await client.auth.getUser();
    if (error || user?.id !== userId) {
      if (mounted.current) { scopeValid.current = false; setSessionChanged(true); setReviewed(undefined); setHistory(undefined); setReceipt(undefined); }
      return false;
    }
    return isCurrent();
  }

  function clearPreview() {
    setReviewed(undefined); setConfirming(false); setChecked(false); setFeedback(undefined); setReceipt(undefined);
    setPreviewPage(0); setOnlyIssues(false);
  }

  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || inFlight.current || attempt) return;
    const generation = ++fileRead.current;
    clearPreview(); setReading(true);
    try {
      if (!file.name.toLowerCase().endsWith(".csv")) throw new Error("Choose a UTF-8 .csv file.");
      if (!file.size || file.size > maxOpeningBalanceCsvBytes) throw new Error("Choose a non-empty CSV file up to 256 KB.");
      const bytes = await file.arrayBuffer();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!isCurrent() || generation !== fileRead.current) return;
      setCsv(text); setFileName(file.name);
    } catch (error) {
      if (isCurrent() && generation === fileRead.current) setFeedback({ kind: "error", text: error instanceof Error ? error.message : "The CSV could not be read. Save it as UTF-8 and choose it again." });
    } finally {
      if (isCurrent() && generation === fileRead.current) setReading(false);
    }
  }

  async function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || attempt || damagedRecovery || !storageReady || disabled || !academicYearId) return;
    if (kind === "monthly" && (!structureId || !month || !dueDate)) {
      setFeedback({ kind: "error", text: "Choose a monthly fee structure, billing month and explicit due date before previewing." });
      return;
    }
    inFlight.current = true; setPreviewing(true); clearPreview();
    try {
      if (!await verifySession()) return;
      const payload: FeeBatchPayload = kind === "monthly" ? {
        academic_year_id: academicYearId, fee_structure_id: structureId, billing_period: month,
        due_date: dueDate, class_id: classId || null, section_id: sectionId || null,
      } : {
        academic_year_id: academicYearId, as_of_date: asOfDate, source_reference: source.trim(), reason: reason.trim(),
        rows: parseOpeningBalanceCsv(csv),
      };
      const result = await previewFeeBatch(client, schoolId, kind, payload);
      if (isCurrent()) setReviewed({ kind, payload, result });
    } catch (error) {
      if (isCurrent()) setFeedback({ kind: "error", text: error instanceof Error ? error.message : "The preview could not be loaded. Try again before posting." });
    } finally {
      inFlight.current = false;
      if (isCurrent()) setPreviewing(false);
    }
  }

  async function post() {
    if (inFlight.current || disabled || !storageReady || damagedRecovery) return;
    if (!attempt && (!reviewed?.result.can_post || reviewed.result.summary.ready_count === 0 || !confirming || !checked)) return;
    inFlight.current = true; setPosting(true); setFeedback(undefined);
    let frozen = attempt;
    try {
      if (!await verifySession()) return;
      frozen ??= {
        version: 1, kind: reviewed!.kind, payload: reviewed!.payload, previewToken: reviewed!.result.preview_token,
        requestId: crypto.randomUUID(), readyCount: reviewed!.result.summary.ready_count,
        existingCount: reviewed!.result.summary.existing_count, amount: reviewed!.result.summary.ready_amount,
      };
      writePending(storageKey, frozen); setAttempt(frozen); setConfirming(false); setChecked(false);
      const result = await postFeeBatch(client, schoolId, frozen.kind, frozen.payload, frozen.previewToken, frozen.requestId);
      writePending(storageKey);
      if (!isCurrent()) return;
      setAttempt(undefined); setReviewed(undefined); setReceipt(result);
      setFeedback({ kind: result.created_count > 0 ? "success" : "error", text: result.created_count > 0
        ? `Batch posted. ${result.created_count} new ${result.kind === "opening" ? "opening balances" : "fee demands"} · ${formatFeeMoney(result.total_amount)}. ${result.existing_count} existing records kept.`
        : "No new fee demands were posted. Review the batch history and preview the latest records." });
      setHistoryPage(0); setHistoryVersion((value) => value + 1); onPosted();
    } catch (error) {
      if (!isCurrent()) return;
      if (["PT409", "40001", "22023", "23505", "42501"].includes(errorCode(error))) {
        writePending(storageKey); setAttempt(undefined); setReviewed(undefined); setConfirming(false); setChecked(false);
        setFeedback({ kind: "error", text: ["PT409", "40001"].includes(errorCode(error))
          ? "The roster, fee structure or existing demands changed. Your inputs are kept. Preview the latest records and review again before posting."
          : error instanceof Error ? error.message : "This batch was rejected. Check the inputs and load a fresh preview." });
      } else {
        if (frozen) setAttempt(frozen);
        setFeedback({ kind: "retry", text: "The posting result could not be confirmed. Retry the same frozen batch to recover its result. Do not create another batch." });
      }
    } finally {
      inFlight.current = false;
      if (isCurrent()) setPosting(false);
    }
  }

  const monthlyStructures = structures.filter((item) => item.academic_year_id === academicYearId && item.frequency === "monthly"
    && Number(item.amount) > 0 && (!classId || !item.class_id || item.class_id === classId));
  const locked = disabled || previewing || posting || reading || Boolean(attempt) || damagedRecovery || !storageReady || sessionChanged;
  const rows = reviewed?.result.rows.filter((row) => !onlyIssues || row.status === "error") ?? [];
  const visibleRows = rows.slice(previewPage * pageSize, (previewPage + 1) * pageSize);
  const summary = reviewed?.result.summary;

  return (
    <section aria-label="Bulk fee posting" className="card overflow-hidden">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] p-5 sm:p-6">
        <div className="max-w-2xl">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-blue-700 dark:text-blue-300"><Layers3 size={15} aria-hidden="true" /> Fee preparation</div>
          <h2 className="text-xl font-bold">Bulk demands &amp; opening balances</h2>
          <p className="mt-2 text-sm muted">Preview the complete batch, check existing records, then confirm the new debt to post.</p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/10 px-3 py-1.5 text-xs font-semibold text-blue-800 dark:text-blue-200"><ShieldCheck size={14} aria-hidden="true" /> Review before posting</span>
      </header>
      <div className="space-y-5 p-5 sm:p-6">
        {sessionChanged ? <p role="alert" className="rounded-xl border border-red-500/30 p-4 text-sm text-red-700 dark:text-red-300">Your sign-in changed. Reload Fees to verify your school access before continuing.</p> : <>
        {!academicYearId && <p role="alert" className="text-sm text-amber-800 dark:text-amber-200">A current academic year is required before preparing fee batches.</p>}
        {!storageReady && <p role="status" className="text-sm muted">Checking unfinished fee posting…</p>}
        {damagedRecovery && <div role="alert" className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
          <p>Saved recovery details could not be read. Review recent batches and the ledger before preparing another batch.</p>
          <button type="button" className={buttonClass} onClick={() => { writePending(storageKey); setDamagedRecovery(false); }}>I checked the history; clear unreadable recovery details</button>
        </div>}
        {attempt && <div className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
          <h3 className="font-bold">Unconfirmed {attempt.kind === "monthly" ? "monthly demand" : "opening balance"} batch</h3>
          <p className="text-sm">{attempt.readyCount} new records · {formatFeeMoney(attempt.amount)}. The original request and reviewed values are kept for a safe retry.</p>
          <p className="text-xs muted">{attempt.existingCount} existing records were excluded. New batch controls stay locked until this result is resolved.</p>
          <button ref={retryButton} type="button" className={primaryClass} disabled={posting || disabled} onClick={() => void post()}>{posting ? "Recovering batch…" : "Retry same batch"}</button>
        </div>}
        {!attempt && <>
        <div role="group" aria-label="Fee batch type" className="flex flex-wrap gap-2">
          {([["monthly", "Monthly demands"], ["opening", "Opening balances"]] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={kind === value} disabled={locked}
            onClick={() => { setKind(value); clearPreview(); }} className={`${buttonClass} ${kind === value ? "border-blue-600 bg-blue-500/10 text-blue-800 dark:text-blue-200" : ""}`}>{label}</button>)}
        </div>
        <form onSubmit={(event) => void preview(event)} className="space-y-4">
          <fieldset disabled={locked || !academicYearId} className="space-y-4">
            {kind === "monthly" ? <>
              <div><h3 className="font-bold">Prepare monthly demands</h3><p className="mt-1 text-sm muted">Use a monthly structure for {yearNames[academicYearId] || "the current academic year"}. Class-specific structures include only their assigned class. An existing pupil/structure/month charge is kept unchanged.</p></div>
              {setupError && <p role="alert" className="text-sm text-red-700 dark:text-red-300">Class and section options could not be loaded. Reload Fees to try again.</p>}
              {!setupLoaded && !setupError && <p role="status" className="text-sm muted">Loading class and section options…</p>}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <label htmlFor={`${id}-class`} className="space-y-1.5 text-sm font-semibold"><span>Batch class</span><select id={`${id}-class`} className="field" disabled={!setupLoaded} value={classId} onChange={(event) => { setClassId(event.target.value); setSectionId(""); setStructureId(""); clearPreview(); }}><option value="">All eligible classes</option>{classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                <label htmlFor={`${id}-section`} className="space-y-1.5 text-sm font-semibold"><span>Batch section</span><select id={`${id}-section`} className="field" disabled={!classId || !setupLoaded} value={sectionId} onChange={(event) => { setSectionId(event.target.value); clearPreview(); }}><option value="">All eligible sections</option>{sections.filter((item) => item.class_id === classId).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                <label htmlFor={`${id}-structure`} className="space-y-1.5 text-sm font-semibold"><span>Monthly fee structure</span><select id={`${id}-structure`} required className="field" value={structureId} onChange={(event) => { setStructureId(event.target.value); clearPreview(); }}><option value="">Choose monthly structure</option>{monthlyStructures.map((item) => <option key={item.id} value={item.id}>{item.name} · {formatFeeMoney(item.amount)} · {item.class_id ? classes.find((option) => option.id === item.class_id)?.name || "Assigned class" : "All classes"}</option>)}</select></label>
                <label htmlFor={`${id}-month`} className="space-y-1.5 text-sm font-semibold"><span>Batch billing month</span><input id={`${id}-month`} required type="month" className="field" value={month} onChange={(event) => { setMonth(event.target.value); clearPreview(); }} /></label>
                <label htmlFor={`${id}-due`} className="space-y-1.5 text-sm font-semibold"><span>Batch due date</span><input id={`${id}-due`} required type="date" className="field" value={dueDate} onChange={(event) => { setDueDate(event.target.value); clearPreview(); }} /></label>
              </div>
              {!monthlyStructures.length && setupLoaded && <p className="text-sm muted">Add a positive monthly fee structure above, or choose a matching class.</p>}
            </> : <>
              <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4"><h3 className="font-bold">Bring forward outstanding debt</h3><p className="mt-1 text-sm muted">Enter only the unpaid balance from the school’s approved source. Posting creates a fee demand; it does not record cash or create a payment receipt. One opening balance is allowed per pupil and academic year. Opening amounts are entered per pupil and appear in fee demands and the ledger.</p><p className="mt-3 text-sm font-semibold text-amber-900 dark:text-amber-200">{openingBalanceGuidance}</p></div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label htmlFor={`${id}-asof`} className="space-y-1.5 text-sm font-semibold"><span>Balance as of (IST)</span><input id={`${id}-asof`} required type="date" max={schoolDate()} value={asOfDate} onChange={(event) => { setAsOfDate(event.target.value); clearPreview(); }} className="field" /></label>
                <label htmlFor={`${id}-source`} className="space-y-1.5 text-sm font-semibold"><span>Source reference</span><input id={`${id}-source`} required maxLength={120} value={source} onChange={(event) => { setSource(event.target.value); clearPreview(); }} className="field" placeholder="Approved opening balance register" /></label>
              </div>
              <div className="space-y-1.5"><label htmlFor={`${id}-reason`} className="block text-sm font-semibold">Review reason</label><textarea id={`${id}-reason`} required rows={2} maxLength={500} value={reason} onChange={(event) => { setReason(event.target.value); clearPreview(); }} className="field" placeholder="Explain the source and reconciliation checked by the office" /></div>
              <div className="flex flex-wrap items-center gap-3">
                <label className={`${buttonClass} inline-flex cursor-pointer items-center gap-2 focus-within:ring-2 focus-within:ring-blue-500`}><FileSpreadsheet size={16} aria-hidden="true" /><span>Choose opening balance CSV</span><input aria-label="Opening balance CSV file" type="file" accept=".csv,text/csv" className="sr-only" onChange={(event) => void selectFile(event)} /></label>
                <a className="inline-flex min-h-11 items-center text-sm font-semibold text-blue-700 underline underline-offset-4 dark:text-blue-300" href={`data:text/csv;charset=utf-8,${encodeURIComponent(openingBalanceCsvTemplate)}`} download="opening-balances-template.csv">Download CSV template</a>
              </div>
              {fileName && <p className="break-all text-sm muted">Selected file · {fileName}</p>}
              <div className="space-y-1.5"><label htmlFor={`${id}-csv`} className="block text-sm font-semibold">Opening balance CSV</label><textarea id={`${id}-csv`} required rows={5} className="field font-mono text-sm" spellCheck={false} value={csv} onChange={(event) => { fileRead.current += 1; setCsv(event.target.value); setFileName(""); clearPreview(); }} placeholder={openingBalanceCsvTemplate} /></div>
              <p className="text-xs muted">Headers: admission_no,amount. Use the exact school admission number and an unpaid INR amount with up to two decimal places. Duplicate and invalid rows are shown in the server preview.</p>
            </>}
          </fieldset>
          {reading && <p role="status" className="text-sm muted">Reading opening balance CSV…</p>}
          <button type="submit" disabled={locked || !academicYearId || (kind === "monthly" && (!structureId || !month || !dueDate || !setupLoaded))} className={primaryClass}>{previewing ? "Checking complete batch…" : "Preview complete batch"}</button>
        </form>
        </>}
        {feedback && <p role={feedback.kind === "success" ? "status" : "alert"} className={`break-words rounded-xl p-3 text-sm ${feedback.kind === "success" ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200" : "bg-amber-500/10 text-amber-900 dark:text-amber-200"}`}>{feedback.text}</p>}
        {receipt && <div className="flex flex-wrap items-start gap-2 rounded-xl border border-emerald-500/25 p-4 text-sm"><CheckCircle2 size={18} className="mt-0.5 text-emerald-700 dark:text-emerald-300" aria-hidden="true" /><div><p className="font-bold">Batch recorded</p>{receipt.kind === "monthly" && <p className="mt-1 text-sm">Billing month · {receipt.billing_period || "Unavailable"}</p>}<p className="mt-1 break-all muted">{receipt.batch_id}</p><p className="mt-1 muted">{postedDate.format(new Date(receipt.posted_at))} IST · {receipt.posted_by_name}</p></div></div>}
        {reviewed && summary && <section aria-label="Fee batch preview" className="space-y-4 border-t border-[var(--border)] pt-5">
          <div><h3 ref={previewHeading} tabIndex={-1} className="scroll-mt-24 rounded font-bold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-600">Complete server preview</h3><p className="mt-1 text-sm muted">All {reviewed.result.rows.length} rows were checked. Existing records will stay unchanged.</p></div>
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[["Ready to create", summary.ready_count], ["Already exists", summary.existing_count], ["Needs correction", summary.error_count], ["New debt to post", formatFeeMoney(summary.ready_amount)]].map(([label, value]) => <div key={String(label)} className="min-w-0 rounded-xl bg-[var(--surface-2)] p-3"><dt className="text-xs font-medium muted">{label}</dt><dd className="mt-1 break-words text-lg font-bold tabular-nums">{value}</dd></div>)}</dl>
          {summary.error_count > 0 && <p role="alert" className="text-sm text-red-700 dark:text-red-300">Fix every invalid row and preview again. This batch cannot be posted with row errors.</p>}
          {summary.ready_count === 0 && summary.error_count === 0 && <p className="text-sm muted">Nothing new to post. All matching charges already exist.</p>}
          {summary.error_count > 0 && <label className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={onlyIssues} onChange={(event) => { setOnlyIssues(event.target.checked); setPreviewPage(0); }} />Show rows needing correction only</label>}
          <div role="region" aria-label="Reviewed fee rows" tabIndex={0} className="max-h-96 overflow-y-auto rounded-xl border border-[var(--border)]">
            <ul className="divide-y divide-[var(--border)]">{visibleRows.map((row) => <li key={row.row_number} className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto]">
              <div className="min-w-0"><p className="break-words text-sm font-semibold">{row.student_name || "Unmatched student"}</p><p className="mt-1 break-words text-xs muted">Row {row.row_number} · {row.admission_no || "No admission number"}{row.class_name && ` · ${row.class_name}`}{row.section_name && ` / ${row.section_name}`}</p>{row.message && <p className={`mt-1 break-words text-sm ${row.status === "error" ? "text-red-700 dark:text-red-300" : "muted"}`}>{row.message}</p>}</div>
              <div className="flex flex-wrap items-center justify-between gap-2 sm:items-end sm:justify-start sm:flex-col"><p className="text-sm font-bold tabular-nums">{row.amount === null ? "Invalid amount" : formatFeeMoney(row.amount)}</p><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${row.status === "ready" ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200" : row.status === "existing" ? "bg-blue-500/10 text-blue-800 dark:text-blue-200" : "bg-red-500/10 text-red-800 dark:text-red-200"}`}>{row.status === "ready" ? "Ready" : row.status === "existing" ? "Already issued" : "Needs correction"}</span></div>
            </li>)}</ul>
          </div>
          {rows.length > pageSize && <div className="flex flex-wrap items-center gap-2 text-sm"><button type="button" disabled={previewPage === 0} className={buttonClass} onClick={() => setPreviewPage((value) => value - 1)}>Previous preview rows</button><span className="muted">Rows {previewPage * pageSize + 1}–{Math.min((previewPage + 1) * pageSize, rows.length)} of {rows.length}</span><button type="button" disabled={(previewPage + 1) * pageSize >= rows.length} className={buttonClass} onClick={() => setPreviewPage((value) => value + 1)}>Next preview rows</button></div>}
          {!attempt && !confirming && <button type="button" disabled={locked || !reviewed.result.can_post || summary.ready_count === 0} className={primaryClass} onClick={() => { setConfirming(true); setChecked(false); }}>Review posting</button>}
          {!attempt && confirming && <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4"><p className="text-sm font-semibold">Post {summary.ready_count} new {reviewed.kind === "opening" ? "opening balances" : "fee demands"} totalling {formatFeeMoney(summary.ready_amount)}?</p><p className="text-sm muted">This records outstanding debt. Payments remain a separate office action. Existing charges will not be replaced.</p>{reviewed.kind === "opening" && <p className="text-sm font-semibold">{openingBalanceGuidance}</p>}<label className="flex min-h-11 items-start gap-2 text-sm"><input ref={confirmCheckbox} type="checkbox" className="mt-1" checked={checked} onChange={(event) => setChecked(event.target.checked)} /><span>I checked the complete preview and the source amounts.</span></label><div className="flex flex-wrap gap-2"><button type="button" disabled={locked || !checked} className={primaryClass} onClick={() => void post()}>{posting ? "Posting batch…" : "Confirm fee batch posting"}</button><button type="button" disabled={posting} className={buttonClass} onClick={() => { setConfirming(false); setChecked(false); }}>Back to preview</button></div></div>}
        </section>}
        <section aria-label="Posted fee batches" className="space-y-3 border-t border-[var(--border)] pt-5">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold">Posted batch history</h3><button type="button" disabled={posting} className={`${buttonClass} inline-flex items-center gap-2`} onClick={() => { setHistory(undefined); setHistoryVersion((value) => value + 1); }}><RefreshCw size={14} aria-hidden="true" />Refresh batch history</button></div>
          <p className="text-xs muted">School-wide history across academic years. Posting amounts represent new debt, not collections.</p>
          {historyError ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">Batch history could not be loaded. Refresh batch history to retry.</p> : !history ? <p role="status" className="text-sm muted">Loading posted batches…</p> : !history.length ? <p className="text-sm muted">No posted batches on this page.</p> : <ul className="divide-y divide-[var(--border)]">{history.map((item) => <li key={item.batch_id} className="space-y-1 py-3 text-sm"><div className="flex flex-wrap justify-between gap-2"><span className="font-semibold">{item.kind === "opening" ? "Opening balances" : "Monthly demands"} · {item.created_count} new</span><strong className="tabular-nums">{formatFeeMoney(item.total_amount)}</strong></div>{item.kind === "monthly" && <p className="text-sm">Billing month · {item.billing_period || "Unavailable"}</p>}<p className="break-words text-xs muted">{yearNames[item.academic_year_id] || "Academic year unavailable"} · {postedDate.format(new Date(item.posted_at))} IST · {item.posted_by_name} · {item.existing_count} existing kept</p>{item.source_reference && <p className="break-words text-sm muted">Source · {item.source_reference}</p>}{item.reason && <p className="break-words text-sm muted">Review · {item.reason}</p>}<p className="break-all text-xs muted">Batch · {item.batch_id}</p></li>)}</ul>}
          {(historyPage > 0 || historyHasMore) && <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={posting || historyPage === 0} onClick={() => { setHistory(undefined); setHistoryPage((value) => value - 1); }}>Previous batches</button><button type="button" className={buttonClass} disabled={posting || !historyHasMore} onClick={() => { setHistory(undefined); setHistoryPage((value) => value + 1); }}>Next batches</button></div>}
        </section>
        </>}
      </div>
    </section>
  );
}
