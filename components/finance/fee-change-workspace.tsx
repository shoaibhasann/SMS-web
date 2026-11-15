"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { feeMoney, formatFeeBillingPeriod, formatFeeMoney, type FeeLedgerRow } from "@/lib/finance/fee-batches";
import {
  listFeeChanges, normalizeFeeChangeReason, requestFeeChange, reviewFeeChange,
  type FeeChange, type FeeChangeKind, type FeeChangeRequestInput, type FeeFinancialState, type OfficeFeeReceipt,
} from "@/lib/finance/fee-changes";
import { LoadingState } from "@/components/ui/skeleton";
import { manualPaymentLabel } from "@/lib/finance/payment-methods";
import { SlidingIndicator } from "@/components/ui/sliding-indicator";

type Props = {
  client: SupabaseClient;
  schoolId: string;
  userId: string;
  canReview: boolean;
  demands: readonly FeeLedgerRow[];
  payments: readonly OfficeFeeReceipt[];
  disabled?: boolean;
  onChanged: () => void;
  onBusyChange?: (busy: boolean) => void;
};
type Proposal = {
  kind: FeeChangeKind;
  feeId: string;
  paymentId: string | null;
  token: string;
  amount: string;
  before: FeeFinancialState;
  after: FeeFinancialState;
  label: string;
  method: string | null;
};
type ReviewIntent = { requestId: string; decision: "approved" | "rejected"; reason: string };
type Feedback = { error: boolean; text: string };
const pageSize = 20;
const buttonClass = "min-h-11 rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold disabled:opacity-50";
const primaryClass = "min-h-11 rounded-xl bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50";
const reversalGuidance = "This corrects a recorded entry; it does not send a bank refund.";
const dateLabel = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const kinds: { value: FeeChangeKind; label: string }[] = [
  { value: "reduction", label: "Reduce fee" }, { value: "additional_charge", label: "Add charge" }, { value: "payment_reversal", label: "Reverse payment entry" },
];
const stateFields: [keyof FeeFinancialState, string][] = [
  ["net_amount", "Effective fee"], ["paid_amount", "Credited payments"], ["balance", "Outstanding balance"],
];

function toPaise(value: string) {
  const canonical = feeMoney(value), negative = canonical.startsWith("-");
  const amount = BigInt(canonical.replace(/^-/, "").replace(".", ""));
  return negative ? -amount : amount;
}
function fromPaise(value: bigint) {
  const negative = value < BigInt(0), amount = negative ? -value : value;
  return `${negative ? "-" : ""}${amount / BigInt(100)}.${String(amount % BigInt(100)).padStart(2, "0")}`;
}
function positiveAmount(value: string) {
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(value) || toPaise(value) <= BigInt(0)) throw new Error("Enter a positive INR amount with up to two decimal places.");
  return feeMoney(value);
}
function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function codeOf(error: unknown) { return object(error) && typeof error.code === "string" ? error.code : ""; }
function errorText(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
function validReason(value: string) {
  try { normalizeFeeChangeReason(value); return true; } catch { return false; }
}
function writeRecovery(key: string, value?: unknown) {
  try { if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key); } catch { /* The mounted form retains its frozen retry. */ }
}
function readRecovery(key: string): unknown {
  try { return JSON.parse(sessionStorage.getItem(key) ?? "null"); } catch { return null; }
}
function validRequest(value: unknown): value is FeeChangeRequestInput {
  return object(value) && typeof value.feeId === "string" && kinds.some((kind) => kind.value === value.kind)
    && (value.amount === null || typeof value.amount === "string") && (value.paymentId === null || typeof value.paymentId === "string")
    && typeof value.reason === "string" && validReason(value.reason)
    && typeof value.expectedToken === "string" && value.expectedToken.length > 0
    && typeof value.requestId === "string" && value.requestId.length > 0;
}
function validReview(value: unknown): value is ReviewIntent {
  return object(value) && typeof value.requestId === "string" && (value.decision === "approved" || value.decision === "rejected")
    && typeof value.reason === "string" && validReason(value.reason);
}
function financialState(fee: FeeLedgerRow): FeeFinancialState {
  const fields = ["base_net_amount", "adjustment_amount", "net_amount", "gross_paid_amount", "reversed_amount", "paid_amount", "balance"] as const;
  const entries = fields.map((field) => {
    const value = fee[field];
    if (typeof value !== "string") throw new Error("This fee needs reconciliation before requesting a change. Refresh the ledger and review its flagged records.");
    return [field, feeMoney(value)] as const;
  });
  return Object.fromEntries(entries) as FeeFinancialState;
}
function propose(kind: FeeChangeKind, fee: FeeLedgerRow, input: string, payment?: OfficeFeeReceipt): Proposal {
  if (!fee.financial_token || fee.status === "review_required") throw new Error("Refresh the ledger and resolve this fee's flagged records before requesting a change.");
  const before = financialState(fee), after = { ...before };
  const amount = kind === "payment_reversal" ? feeMoney(payment?.amount ?? "0") : positiveAmount(input);
  const delta = toPaise(amount);
  if (kind === "payment_reversal") {
    if (!payment || payment.student_fee_id !== fee.demand_id || payment.status !== "paid" || payment.legacy_refund
      || !payment.financial_token || delta <= BigInt(0) || toPaise(payment.reversed_amount) !== BigInt(0)) {
      throw new Error("Choose an unreversed paid receipt without an unresolved legacy refund.");
    }
    if (payment.financial_token !== fee.financial_token) throw new Error("Receipt and ledger changed while loading; refresh finance records before preparing a reversal.");
    after.reversed_amount = fromPaise(toPaise(before.reversed_amount) + delta);
    after.paid_amount = fromPaise(toPaise(before.paid_amount) - delta);
    after.balance = fromPaise(toPaise(before.balance) + delta);
    if (toPaise(after.paid_amount) < BigInt(0)) throw new Error("The loaded receipt and fee totals changed. Refresh finance records before requesting a reversal.");
  } else {
    const signed = kind === "reduction" ? -delta : delta;
    after.adjustment_amount = fromPaise(toPaise(before.adjustment_amount) + signed);
    after.net_amount = fromPaise(toPaise(before.net_amount) + signed);
    after.balance = fromPaise(toPaise(before.balance) + signed);
    if (toPaise(after.balance) < BigInt(0) || toPaise(after.net_amount) < BigInt(0)) {
      throw new Error("A reduction cannot exceed the outstanding balance. Review any payment-entry correction separately.");
    }
  }
  return { kind, feeId: fee.demand_id, paymentId: payment?.id ?? null, token: fee.financial_token,
    amount, before, after, label: `${fee.student_name} · ${fee.admission_no} · ${fee.fee_name}${payment ? ` · ${payment.receipt_no}` : ""}`, method: payment?.payment_method ?? null };
}

function StateComparison({ before, after }: { before: FeeFinancialState; after: FeeFinancialState }) {
  return <div className="overflow-hidden rounded-xl border border-[var(--border)]">
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 bg-[var(--surface-2)] p-3 text-xs font-semibold"><span>Ledger</span><span className="text-right">Before</span><span className="text-right">If approved</span></div>
    <dl className="divide-y divide-[var(--border)]">{stateFields.map(([field, label]) => <div key={field} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 p-3 text-xs sm:text-sm"><dt className="break-words font-medium">{label}</dt><dd className="break-words text-right tabular-nums">{formatFeeMoney(before[field])}</dd><dd className="break-words text-right font-semibold tabular-nums">{formatFeeMoney(after[field])}</dd></div>)}</dl>
  </div>;
}

export function FeeChangeWorkspace(props: Props) {
  return <ScopedFeeChangeWorkspace key={`${props.userId}:${props.schoolId}`} {...props} />;
}

function ScopedFeeChangeWorkspace({ client, schoolId, userId, canReview, demands, payments, disabled = false, onChanged, onBusyChange }: Props) {
  const id = useId(), requestKey = `kids-corner-fee-change-request:v1:${userId}:${schoolId}`, reviewKey = `kids-corner-fee-change-review:v1:${userId}:${schoolId}`;
  const [kind, setKind] = useState<FeeChangeKind>("reduction");
  const [search, setSearch] = useState("");
  const [feeId, setFeeId] = useState("");
  const [paymentId, setPaymentId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [proposal, setProposal] = useState<Proposal>();
  const [checked, setChecked] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [pendingRequest, setPendingRequest] = useState<FeeChangeRequestInput>();
  const [pendingReview, setPendingReview] = useState<ReviewIntent>();
  const [storageReady, setStorageReady] = useState(false);
  const [sessionChanged, setSessionChanged] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>();
  const [lastRequest, setLastRequest] = useState<FeeChange>();
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const [page, setPage] = useState(0);
  const [version, setVersion] = useState(0);
  const [queue, setQueue] = useState<{ key: string; rows: FeeChange[]; total: number; error: string }>();
  const [selected, setSelected] = useState("");
  const [reviewReason, setReviewReason] = useState("");
  const [requiresRefresh, setRequiresRefresh] = useState("");
  const [outdated, setOutdated] = useState<Set<string>>(() => new Set());
  const mounted = useRef(true), scopeValid = useRef(true), inFlight = useRef(false);
  const proposalHeading = useRef<HTMLHeadingElement>(null), retryRequest = useRef<HTMLButtonElement>(null), retryReview = useRef<HTMLButtonElement>(null);
  const queryKey = JSON.stringify([schoolId, userId, filter, page, version]);
  const activeQueue = queue?.key === queryKey ? queue : undefined;
  const busy = preparing || requesting || reviewing || Boolean(pendingRequest) || Boolean(pendingReview);
  const locked = disabled || busy || !storageReady || sessionChanged;
  const reviewDirty = Boolean(selected && reviewReason.trim());
  const positions = new Map(demands.map((fee) => [fee.demand_id, fee]));
  const searchKey = search.trim().toLocaleLowerCase();
  const eligibleFees = demands.filter((fee) => Boolean(fee.financial_token) && fee.status !== "review_required");
  const visibleFees = eligibleFees.filter((fee) => `${fee.student_name} ${fee.admission_no} ${fee.fee_name} ${formatFeeBillingPeriod(fee.billing_period)}`.toLocaleLowerCase().includes(searchKey));
  const eligiblePayments = payments.filter((payment) => payment.status === "paid" && !payment.legacy_refund && payment.financial_token
    && positions.get(payment.student_fee_id)?.financial_token);
  const visiblePayments = eligiblePayments.filter((payment) => {
    const fee = positions.get(payment.student_fee_id);
    return `${payment.receipt_no} ${fee?.student_name ?? ""} ${fee?.admission_no ?? ""} ${fee?.fee_name ?? ""}`.toLocaleLowerCase().includes(searchKey);
  });

  useEffect(() => {
    let active = true;
    mounted.current = true; scopeValid.current = true;
    queueMicrotask(() => {
      if (!active || !mounted.current || !scopeValid.current) return;
      const savedRequest = readRecovery(requestKey), savedReview = readRecovery(reviewKey);
      if (validRequest(savedRequest)) setPendingRequest(savedRequest);
      if (validReview(savedReview)) setPendingReview(savedReview);
      setStorageReady(true);
    });
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (!mounted.current || session?.user.id === userId) return;
      scopeValid.current = false; setSessionChanged(true); setProposal(undefined); setQueue(undefined); setLastRequest(undefined);
    });
    return () => { active = false; mounted.current = false; scopeValid.current = false; subscription.unsubscribe(); };
  }, [client, requestKey, reviewKey, userId]);

  useEffect(() => {
    let active = true;
    listFeeChanges(client, schoolId, filter, pageSize, page * pageSize).then((result) => {
      if (active && scopeValid.current) setQueue({ key: queryKey, rows: result.rows, total: result.total_count, error: "" });
    }, () => { if (active && scopeValid.current) setQueue({ key: queryKey, rows: [], total: 0, error: "Fee-change requests could not be loaded. Refresh requests to try again." }); });
    return () => { active = false; };
  }, [client, schoolId, filter, page, queryKey]);

  useEffect(() => { onBusyChange?.(busy); return () => { onBusyChange?.(false); }; }, [busy, onBusyChange]);
  useEffect(() => { if (proposal) proposalHeading.current?.focus(); }, [proposal]);
  useEffect(() => { if (pendingRequest && !requesting) retryRequest.current?.focus(); }, [pendingRequest, requesting]);
  useEffect(() => { if (pendingReview && !reviewing) retryReview.current?.focus(); }, [pendingReview, reviewing]);

  function current() { return mounted.current && scopeValid.current; }
  async function verifySession() {
    const { data: { user }, error } = await client.auth.getUser();
    if (error || user?.id !== userId) {
      if (mounted.current) { scopeValid.current = false; setSessionChanged(true); setProposal(undefined); setQueue(undefined); setLastRequest(undefined); }
      return false;
    }
    return current();
  }
  function clearProposal() { setProposal(undefined); setChecked(false); setFeedback(undefined); setLastRequest(undefined); }
  function refreshQueue() {
    if (requesting || reviewing) return;
    setRequiresRefresh(""); setVersion((value) => value + 1); onChanged();
  }
  async function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked || inFlight.current) return;
    if (!validReason(reason)) { setFeedback({ error: true, text: "Use a request reason of 5–500 printable characters on one line." }); return; }
    inFlight.current = true; setPreparing(true); clearProposal();
    try {
      if (!await verifySession()) return;
      const payment = kind === "payment_reversal" ? payments.find((row) => row.id === paymentId) : undefined;
      const fee = positions.get(payment?.student_fee_id ?? feeId);
      if (!fee) throw new Error("Choose an available fee or paid receipt, then refresh finance records if it is missing.");
      const result = propose(kind, fee, amount, payment);
      if (current()) setProposal(result);
    } catch (error) { if (current()) setFeedback({ error: true, text: errorText(error, "The proposed change could not be prepared. Refresh the ledger and try again.") }); }
    finally { inFlight.current = false; if (current()) setPreparing(false); }
  }
  async function submitRequest() {
    if (disabled || inFlight.current || !storageReady || (!pendingRequest && (!proposal || !checked || !validReason(reason) || pendingReview))) return;
    inFlight.current = true; setRequesting(true); setFeedback(undefined);
    let intent = pendingRequest;
    try {
      if (!await verifySession()) return;
      intent ??= { feeId: proposal!.feeId, kind: proposal!.kind, amount: proposal!.kind === "payment_reversal" ? null : proposal!.amount,
        paymentId: proposal!.paymentId, reason: reason.trim(), expectedToken: proposal!.token, requestId: crypto.randomUUID() };
      writeRecovery(requestKey, intent); setPendingRequest(intent);
      const result = await requestFeeChange(client, schoolId, intent);
      writeRecovery(requestKey);
      if (!current()) return;
      setPendingRequest(undefined); setProposal(undefined); setChecked(false); setLastRequest(result);
      setFeedback({ error: false, text: result.state === "pending" ? "Request submitted. The fee and payment records stay unchanged until a different School Admin or Principal approves it." : `Request recovered as ${result.state}. The saved decision and financial history are shown below.` });
      setPage(0); setVersion((value) => value + 1); onChanged();
    } catch (error) {
      if (!current()) return;
      if (["PT409", "40001", "22023", "23505", "42501", "55000"].includes(codeOf(error))) {
        writeRecovery(requestKey); setPendingRequest(undefined); setProposal(undefined); setChecked(false);
        setFeedback({ error: true, text: ["PT409", "40001"].includes(codeOf(error))
          ? "The fee or receipt changed. Your request inputs are kept. Refresh finance records, preview the latest ledger and submit a new request."
          : errorText(error, "The request was rejected. Review its details and load the current ledger before trying again.") });
      } else {
        if (intent) setPendingRequest(intent);
        setFeedback({ error: true, text: "The request result could not be confirmed. Retry the same saved request to recover its result." });
      }
    } finally { inFlight.current = false; if (current()) setRequesting(false); }
  }
  async function decide(request?: FeeChange, decision?: "approved" | "rejected") {
    if (disabled || inFlight.current || !canReview || !storageReady) return;
    let intent = pendingReview;
    if (!intent) {
      if (!request || !decision || request.state !== "pending" || request.requested_by === userId || !validReason(reviewReason)
        || requiresRefresh === request.id || pendingRequest) return;
      const latest = positions.get(request.fee_id)?.financial_token;
      if (decision === "approved" && (outdated.has(request.id) || (latest && latest !== request.financial_token))) return;
      intent = { requestId: request.id, decision, reason: reviewReason.trim() };
    }
    inFlight.current = true; setReviewing(true); setFeedback(undefined);
    try {
      if (!await verifySession()) return;
      writeRecovery(reviewKey, intent); setPendingReview(intent);
      const result = await reviewFeeChange(client, intent.requestId, intent.decision, intent.reason);
      if (result.state !== intent.decision) throw new Error("The review response did not confirm this decision.");
      writeRecovery(reviewKey);
      if (!current()) return;
      setPendingReview(undefined); setSelected(""); setReviewReason(""); setLastRequest(result);
      setFeedback({ error: false, text: result.state === "approved" ? "Change approved and posted. The original records and review history are retained." : "Request rejected. The fee and payment records were kept unchanged." });
      setVersion((value) => value + 1); onChanged();
    } catch (error) {
      if (!current()) return;
      if (["PT409", "40001", "22023", "23505", "42501", "55000"].includes(codeOf(error))) {
        writeRecovery(reviewKey); setPendingReview(undefined);
        if (["PT409", "40001"].includes(codeOf(error))) {
          setRequiresRefresh(intent.requestId); setOutdated((previous) => new Set(previous).add(intent.requestId));
          setFeedback({ error: true, text: "The financial records changed. Your review reason is kept. Refresh requests, reject this outdated request and ask for a new request based on the latest ledger." });
        } else setFeedback({ error: true, text: errorText(error, "This decision was rejected. Refresh the request and check the current financial records.") });
      } else setFeedback({ error: true, text: "The review result could not be confirmed. Retry the same saved decision and reason before reviewing another request." });
    } finally { inFlight.current = false; if (current()) setReviewing(false); }
  }

  return <section aria-label="Fee changes and payment corrections" className="card overflow-hidden">
    <header className="flex flex-wrap justify-between gap-3 border-b border-[var(--border)] p-5 sm:p-6"><div className="max-w-2xl"><p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-blue-700 dark:text-blue-300"><ShieldCheck size={15} aria-hidden="true" /> Office review</p><h2 className="text-xl font-bold">Fee changes &amp; payment corrections</h2><p className="mt-2 text-sm muted">Request a reduction, additional charge or full payment-entry reversal. A different School Admin or Principal reviews the reason before anything is posted.</p></div><span className="h-fit rounded-full bg-blue-500/10 px-3 py-1.5 text-xs font-semibold text-blue-800 dark:text-blue-200">{canReview ? "School reviewer" : "Request access"}</span></header>
    <div className="space-y-5 p-5 sm:p-6">{sessionChanged ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">Your sign-in changed. Reload Fees to verify your school access before continuing.</p> : <>
      {!storageReady && <LoadingState variant="table" className="text-sm muted">Checking unfinished fee requests and reviews…</LoadingState>}
      {pendingRequest && <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4"><h3 className="font-bold">Unconfirmed change request</h3><p className="text-sm">The original target, amount, reason and request reference are kept. Recover this result before starting another request.</p><button ref={retryRequest} type="button" disabled={requesting || reviewing || disabled} className={primaryClass} onClick={() => void submitRequest()}>{requesting ? "Recovering request…" : "Retry same change request"}</button></div>}
      {pendingReview && <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4"><h3 className="font-bold">Unconfirmed {pendingReview.decision === "approved" ? "approval" : "rejection"}</h3><p className="text-sm">The decision and review reason are frozen for a safe retry.</p><p className="break-words text-sm muted">Review reason · {pendingReview.reason}</p><button ref={retryReview} type="button" disabled={reviewing || requesting || disabled} className={primaryClass} onClick={() => void decide()}>{reviewing ? "Recovering review…" : "Retry same fee review"}</button></div>}
      {!pendingRequest && !pendingReview && <form onSubmit={(event) => void prepare(event)} className="space-y-4">
        <fieldset disabled={locked} className="space-y-4"><div role="group" aria-label="Fee change type" className="flex flex-wrap gap-2"><SlidingIndicator className="rounded-xl border border-blue-600 bg-blue-500/10 [--slider-disabled-opacity:.5]" />{kinds.map((item) => <button type="button" key={item.value} aria-pressed={kind === item.value} className={`${buttonClass} ${kind === item.value ? "border-blue-600 bg-blue-500/10 text-blue-800 dark:text-blue-200" : ""}`} onClick={() => { setKind(item.value); setFeeId(""); setPaymentId(""); setSearch(""); clearProposal(); }}>{item.label}</button>)}</div>
          {kind === "payment_reversal" && <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm"><p className="font-semibold">{reversalGuidance}</p><p className="mt-1 muted">The full original receipt remains readable. Approval creates a separate counter-entry on the actual approval day in IST, while past closed days stay as recorded.</p></div>}
          <div className="grid gap-3 sm:grid-cols-2"><label htmlFor={`${id}-search`} className="space-y-1.5 text-sm font-semibold"><span>Find student, fee or receipt</span><input id={`${id}-search`} value={search} onChange={(event) => { setSearch(event.target.value); setFeeId(""); setPaymentId(""); clearProposal(); }} className="field" placeholder="Name, admission number or receipt" /></label>
            {kind === "payment_reversal" ? <label htmlFor={`${id}-receipt`} className="space-y-1.5 text-sm font-semibold"><span>Paid receipt to correct</span><select id={`${id}-receipt`} required className="field" value={paymentId} onChange={(event) => { setPaymentId(event.target.value); clearProposal(); }}><option value="">Choose unreversed paid receipt</option>{visiblePayments.map((payment) => <option key={payment.id} value={payment.id}>{payment.receipt_no} · {positions.get(payment.student_fee_id)?.student_name} · {formatFeeMoney(payment.amount)}</option>)}</select></label>
              : <label htmlFor={`${id}-fee`} className="space-y-1.5 text-sm font-semibold"><span>Fee record to change</span><select id={`${id}-fee`} required className="field" value={feeId} onChange={(event) => { setFeeId(event.target.value); clearProposal(); }}><option value="">Choose fee record</option>{visibleFees.map((fee) => <option key={fee.demand_id} value={fee.demand_id}>{fee.student_name} · {fee.admission_no} · {fee.fee_name} · {formatFeeBillingPeriod(fee.billing_period)}</option>)}</select></label>}
            {kind !== "payment_reversal" && <label htmlFor={`${id}-amount`} className="space-y-1.5 text-sm font-semibold"><span>{kind === "reduction" ? "Reduction amount" : "Additional charge amount"}</span><input id={`${id}-amount`} required inputMode="decimal" maxLength={13} pattern="[0-9]+(\.[0-9]{1,2})?" value={amount} onChange={(event) => { setAmount(event.target.value); clearProposal(); }} className="field" placeholder="0.00" /></label>}
          </div>
          <div className="space-y-1.5"><label htmlFor={`${id}-reason`} className="block text-sm font-semibold">Request reason</label><textarea id={`${id}-reason`} aria-describedby={`${id}-reason-help`} required rows={2} minLength={5} maxLength={500} value={reason} onChange={(event) => { setReason(event.target.value); clearProposal(); }} className="field" placeholder="Explain the correction and the school record checked" /><p id={`${id}-reason-help`} className="text-xs muted">Use 5–500 printable characters on one line.</p></div>
        </fieldset><button type="submit" disabled={locked || !validReason(reason) || (kind === "payment_reversal" ? !paymentId : !feeId || !amount)} className={primaryClass}>{preparing ? "Preparing proposal…" : "Preview requested change"}</button>
      </form>}
      {proposal && !pendingRequest && !pendingReview && <section aria-label="Proposed fee change" className="space-y-3 rounded-xl border border-blue-500/25 p-4"><h3 ref={proposalHeading} tabIndex={-1} className="scroll-mt-24 rounded font-bold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-600">Loaded-ledger proposal</h3><p className="break-words text-sm font-semibold">{proposal.label}</p><p className="text-sm muted">Calculated from the loaded ledger. The server rechecks the financial snapshot before accepting the request; no money or fee record changes at this step.</p><StateComparison before={proposal.before} after={proposal.after} />
        {proposal.kind === "payment_reversal" && <div className="rounded-xl bg-amber-500/5 p-3 text-sm"><p className="font-semibold">{reversalGuidance}</p><p className="mt-1">If approved, the full {formatFeeMoney(proposal.amount)} counter-entry reduces {proposal.method ? manualPaymentLabel(proposal.method) : "the original payment method's"} collections on the approval day. Cash book impact: {proposal.method === "cash" ? formatFeeMoney(`-${proposal.amount}`) : formatFeeMoney("0.00")}.</p></div>}
        <label className="flex min-h-11 items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={checked} onChange={(event) => setChecked(event.target.checked)} disabled={locked} /><span>I checked the proposed change and the request reason.</span></label><button type="button" disabled={locked || !checked} className={primaryClass} onClick={() => void submitRequest()}>Submit fee change request</button>
      </section>}
      {feedback && <p role={feedback.error ? "alert" : "status"} className={`break-words rounded-xl p-3 text-sm ${feedback.error ? "bg-amber-500/10 text-amber-900 dark:text-amber-200" : "bg-emerald-500/10 text-emerald-900 dark:text-emerald-200"}`}>{feedback.text}</p>}
      {lastRequest && <p className="break-all text-xs muted">Request reference · {lastRequest.id}{lastRequest.reference && ` · Posted entry ${lastRequest.reference}`}</p>}
      <section aria-label="Fee change review queue" className="space-y-4 border-t border-[var(--border)] pt-5"><div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-bold">Requests &amp; review history</h3><p className="mt-1 text-sm muted">{canReview ? "Review the immutable before/after values and record a reason for each decision." : "A School Admin or Principal must review requests before they affect the ledger."}</p></div><button type="button" disabled={requesting || reviewing || Boolean(pendingReview)} className={`${buttonClass} inline-flex items-center gap-2`} onClick={refreshQueue}><RefreshCw size={14} aria-hidden="true" />Refresh fee requests</button></div>
        <div role="group" aria-label="Fee request filter" className="flex flex-wrap gap-2"><SlidingIndicator className="rounded-xl border border-blue-600 bg-blue-500/10 [--slider-disabled-opacity:.5]" />{(["pending", "all"] as const).map((value) => <button type="button" key={value} aria-pressed={filter === value} disabled={requesting || reviewing || Boolean(pendingReview) || reviewDirty} className={`${buttonClass} ${filter === value ? "border-blue-600 bg-blue-500/10 text-blue-800 dark:text-blue-200" : ""}`} onClick={() => { setFilter(value); setPage(0); }}>{value === "pending" ? "Pending requests" : "All requests"}</button>)}</div>
        {!activeQueue ? <LoadingState variant="table" className="text-sm muted">Loading fee-change requests…</LoadingState> : activeQueue.error ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{activeQueue.error}</p> : !activeQueue.rows.length ? <p className="text-sm muted">No {filter === "pending" ? "pending " : ""}fee-change requests on this page.</p> : <ul className="space-y-3">{activeQueue.rows.map((request) => {
          const currentToken = positions.get(request.fee_id)?.financial_token;
          const obsolete = outdated.has(request.id) || Boolean(currentToken && currentToken !== request.financial_token);
          const own = request.requested_by === userId;
          const blocked = disabled || busy || requiresRefresh === request.id;
          return <li key={request.id} className="space-y-3 rounded-xl border border-[var(--border)] p-4"><div className="flex flex-wrap justify-between gap-2"><div className="min-w-0"><h4 className="break-words font-semibold">{request.student_name} · {request.admission_no}</h4><p className="mt-1 break-words text-sm muted">{kinds.find((item) => item.value === request.kind)?.label} · {request.fee_name}{request.receipt_no && ` · ${request.receipt_no}`} · {formatFeeMoney(request.amount)}</p></div><span className={`h-fit rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${request.state === "pending" ? "bg-amber-500/10 text-amber-900 dark:text-amber-200" : request.state === "approved" ? "bg-emerald-500/10 text-emerald-900 dark:text-emerald-200" : "bg-[var(--surface-2)]"}`}>{request.state}</span></div>
            <p className="break-words text-sm">Request reason · {request.request_reason}</p><p className="text-xs muted">{request.requester_name} · {dateLabel.format(new Date(request.requested_at))} IST</p><StateComparison before={request.before} after={request.after} />
            {request.kind === "payment_reversal" && <p className="text-sm font-semibold">{reversalGuidance}</p>}
            {request.review_reason && <p className="break-words text-sm muted">Review reason · {request.review_reason}{request.reviewer_name && ` · ${request.reviewer_name}`}</p>}
            {request.reference && <p className="break-all text-xs muted">Posted entry · {request.reference}{request.effective_day && ` · ${request.effective_day} IST`}</p>}
            {request.state === "pending" && obsolete && <p className="text-sm text-amber-900 dark:text-amber-200">This request uses an outdated financial snapshot. Reject it with a reason; a new request must use the latest ledger.</p>}
            {request.state === "pending" && own && <p className="text-sm muted">Another School Admin or Principal must review your request.</p>}
            {request.state === "pending" && canReview && !own && (selected === request.id ? <div className="space-y-3"><div className="space-y-1.5"><label htmlFor={`${id}-review-${request.id}`} className="block text-sm font-semibold">Review reason</label><textarea id={`${id}-review-${request.id}`} aria-describedby={`${id}-review-help-${request.id}`} rows={2} minLength={5} maxLength={500} required disabled={reviewing || Boolean(pendingReview)} className="field" value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} /><p id={`${id}-review-help-${request.id}`} className="text-xs muted">Use 5–500 printable characters on one line.</p></div><div className="flex flex-wrap gap-2"><button type="button" disabled={blocked || obsolete || !validReason(reviewReason)} className={primaryClass} onClick={() => void decide(request, "approved")}>Approve fee change</button><button type="button" disabled={blocked || !validReason(reviewReason)} className={buttonClass} onClick={() => void decide(request, "rejected")}>Reject fee change</button><button type="button" disabled={reviewing || Boolean(pendingReview)} className={buttonClass} onClick={() => { setSelected(""); setReviewReason(""); }}>Cancel review</button></div></div> : <button type="button" disabled={blocked || reviewDirty} className={buttonClass} onClick={() => { setSelected(request.id); setReviewReason(""); setFeedback(undefined); }}>Review fee request</button>)}
          </li>;
        })}</ul>}
        {activeQueue && (page > 0 || (page + 1) * pageSize < activeQueue.total) && <div className="flex flex-wrap items-center gap-2 text-sm"><button type="button" disabled={busy || reviewDirty || page === 0} className={buttonClass} onClick={() => setPage((value) => value - 1)}>Previous fee requests</button><span className="muted">{activeQueue.total} matching requests</span><button type="button" disabled={busy || reviewDirty || (page + 1) * pageSize >= activeQueue.total} className={buttonClass} onClick={() => setPage((value) => value + 1)}>Next fee requests</button></div>}
      </section>
    </> }</div>
  </section>;
}
