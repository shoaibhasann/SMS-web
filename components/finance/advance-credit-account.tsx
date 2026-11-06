"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ArrowDownLeft, ArrowUpRight, RefreshCw, ShieldCheck } from "lucide-react";
import { schoolDate } from "@/lib/attendance/types";
import { formatFeeBillingPeriod, getOfficeFeeLedger, type FeeLedgerRow } from "@/lib/finance/fee-batches";
import { formatMoney, fromPaise, positiveMoney, toPaise } from "@/lib/finance/money";
import { isManualPaymentMethod, manualPaymentLabel, manualPaymentMethods, type ManualPaymentMethod } from "@/lib/finance/payment-methods";
import {
  allocateOfficeCredit, cancelOfficeCreditRefund, getOfficeStudentCredit, listOfficeCreditChanges,
  normalizeCreditReason, normalizeCreditReference, payOfficeCreditRefund, recordOfficeCreditReceipt,
  requestOfficeCreditChange, reviewOfficeCreditChange,
  type CreditActivity, type CreditAllocationInput, type CreditChangeInput, type CreditChangeKind,
  type CreditChangeRequest, type CreditPayoutInput, type CreditReceiptInput, type OfficeCreditAccount,
} from "@/lib/finance/advance-credit";
import { LoadingState } from "@/components/ui/skeleton";

type Props = { client: SupabaseClient; schoolId: string; studentId: string; userId: string; canReview: boolean; onLockChange?: (locked: boolean) => void };
type Tab = "receive" | "apply" | "refunds" | "activity";
type Operation = { kind: "receipt"; input: CreditReceiptInput } | { kind: "allocation"; input: CreditAllocationInput }
  | { kind: "request"; input: CreditChangeInput }
  | { kind: "review"; requestId: string; decision: "approved" | "rejected"; reason: string }
  | { kind: "payout"; input: CreditPayoutInput } | { kind: "cancel"; requestId: string; reason: string };
type Confirmation = { operation: Operation; title: string; detail: string; amount: string; cash: string };
type Recovery = { version: 1; schoolId: string; studentId: string; userId: string; confirmation: Confirmation };
type DayStatus = { day: string; open: boolean; error?: string };
type Records = { key: string; account?: OfficeCreditAccount; fees?: FeeLedgerRow[]; requests?: CreditChangeRequest[]; requestCount?: number; day?: DayStatus; error?: string };
const size = 20;
const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50";
const primary = `${button} border-blue-700 bg-blue-700 text-white hover:bg-blue-800`;
const errorClass = "rounded-xl border border-red-500/25 bg-red-500/5 p-4 text-sm text-red-800 dark:text-red-300";
const dateFormat = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const activityLabels: Record<CreditActivity["kind"], string> = { receipt: "Advance received", allocation: "Applied to fee", allocation_return: "Returned to credit", refund: "Offline refund paid", receipt_reversal: "Advance entry reversed" };
const changeLabels: Record<CreditChangeKind, string> = { refund: "Unused-credit refund", allocation_return: "Return applied credit", receipt_reversal: "Reverse advance entry" };
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function code(error: unknown) { return object(error) && typeof error.code === "string" ? error.code : ""; }
function message(error: unknown) { return error instanceof Error ? error.message : "This result could not be confirmed. Retry the saved operation."; }
function displayMoney(value: string | null | undefined) { return value == null ? "Review required" : formatMoney(value); }
function validReason(value: string) { try { normalizeCreditReason(value); return true; } catch { return false; } }
function writeRecovery(key: string, recovery?: Recovery) {
  try { if (recovery) sessionStorage.setItem(key, JSON.stringify(recovery)); else sessionStorage.removeItem(key); } catch { /* The mounted form keeps the same frozen operation if storage is unavailable. */ }
}
function readRecovery(key: string, schoolId: string, studentId: string, userId: string): { recovery?: Recovery; unreadable: boolean } {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw === null) return { unreadable: false };
    const saved: unknown = JSON.parse(raw);
    if (!object(saved) || saved.version !== 1 || saved.schoolId !== schoolId || saved.studentId !== studentId || saved.userId !== userId || !object(saved.confirmation)) return { unreadable: true };
    const confirmation = saved.confirmation, operation = confirmation.operation;
    if (!["title", "detail", "amount", "cash"].every((field) => typeof confirmation[field] === "string") || !object(operation)) return { unreadable: true };
    positiveMoney(confirmation.amount as string);
    if (operation.kind === "review" || operation.kind === "cancel") {
      if (typeof operation.requestId !== "string" || typeof operation.reason !== "string" || !validReason(operation.reason)
        || (operation.kind === "review" && !["approved", "rejected"].includes(String(operation.decision)))) return { unreadable: true };
    } else {
      const input = operation.input;
      if (!object(input) || !["receipt", "allocation", "request", "payout"].includes(String(operation.kind)) || typeof input.reason !== "string" || !validReason(input.reason)) return { unreadable: true };
      if (operation.kind !== "payout" && (input.studentId !== studentId || typeof input.requestId !== "string")) return { unreadable: true };
      if (operation.kind === "receipt" || operation.kind === "payout") {
        if (!isManualPaymentMethod(input.method) || typeof input.reference !== "string") return { unreadable: true };
        normalizeCreditReference(input.reference);
      }
      if (operation.kind === "payout" && (typeof input.requestId !== "string" || typeof input.payoutId !== "string")) return { unreadable: true };
      if (operation.kind === "allocation" && (typeof input.feeId !== "string" || typeof input.expectedCreditToken !== "string" || typeof input.expectedFeeToken !== "string")) return { unreadable: true };
      if (operation.kind === "request" && (!["refund", "allocation_return", "receipt_reversal"].includes(String(input.kind)) || typeof input.expectedCreditToken !== "string"
        || !(input.entryId === null || typeof input.entryId === "string") || !(input.expectedFeeToken === null || typeof input.expectedFeeToken === "string"))) return { unreadable: true };
      if (operation.kind !== "payout" && !(operation.kind === "request" && input.kind === "receipt_reversal")) positiveMoney(String(input.amount));
    }
    return { recovery: saved as Recovery, unreadable: false };
  } catch { return { unreadable: true }; }
}
async function studentFees(client: SupabaseClient, schoolId: string, studentId: string) {
  const fees: FeeLedgerRow[] = [];
  let expected: number | undefined;
  for (let offset = 0; ; offset += 200) {
    const page = await getOfficeFeeLedger(client, schoolId, null, studentId, 200, offset);
    if (expected !== undefined && page.summary.demand_count !== expected) throw new Error("Fee records changed while loading. Refresh this student's account.");
    expected = page.summary.demand_count;
    fees.push(...page.rows);
    if (fees.length === expected) break;
    if (!page.rows.length || fees.length > expected) throw new Error("All student fee records could not be loaded. Refresh this student's account.");
  }
  if (new Set(fees.map((fee) => fee.demand_id)).size !== fees.length) throw new Error("Fee records changed while loading. Refresh this student's account.");
  return fees;
}
function RequestState({ request }: { request: CreditChangeRequest }) {
  const label = request.kind === "refund" && request.state === "approved" ? "Reserved · payout not recorded" : request.state === "paid" ? "Offline payout recorded" : request.state;
  return <span className="inline-flex max-w-full rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-xs font-semibold capitalize">{label}</span>;
}
function savedRequestMessage(request: CreditChangeRequest) {
  if (request.state === "paid") return "This refund's completed offline payout is already recorded. Do not repeat the external payment.";
  if (request.state === "cancelled") return "This unpaid refund was cancelled. Its reserved credit has been released.";
  if (request.state === "rejected") return "Request rejected. No money moved.";
  if (request.state === "approved") return request.kind === "refund" ? "Refund approved. Credit is reserved; payout has not been recorded." : "Credit correction approved and posted.";
  return "Request saved for independent review. No money moved.";
}
function Fields({ id, amount, setAmount, reason, setReason, disabled, amountLabel = "Amount (INR)", hideAmount = false }: {
  id: string; amount: string; setAmount: (value: string) => void; reason: string; setReason: (value: string) => void; disabled: boolean; amountLabel?: string; hideAmount?: boolean;
}) {
  return <div className="grid gap-4 sm:grid-cols-2">
    {!hideAmount && <div><label htmlFor={`${id}-amount`} className="mb-2 block text-sm font-semibold">{amountLabel}</label><input id={`${id}-amount`} className="field" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} onChange={(event) => setAmount(event.target.value)} required disabled={disabled} /></div>}
    <div className={hideAmount ? "sm:col-span-2" : ""}><label htmlFor={`${id}-reason`} className="mb-2 block text-sm font-semibold">Reason</label><input id={`${id}-reason`} className="field" value={reason} onChange={(event) => setReason(event.target.value)} minLength={5} maxLength={500} required disabled={disabled} aria-describedby={`${id}-reason-help`} /><p id={`${id}-reason-help`} className="mt-1 text-xs muted">5–500 printable characters, on one line. Internal school record.</p></div>
  </div>;
}
function MethodFields({ id, method, setMethod, reference, setReference, disabled, prefix = "Payment" }: {
  id: string; method: ManualPaymentMethod; setMethod: (value: ManualPaymentMethod) => void; reference: string; setReference: (value: string) => void; disabled: boolean; prefix?: string;
}) {
  return <div className="grid gap-4 sm:grid-cols-2"><div><label htmlFor={`${id}-method`} className="mb-2 block text-sm font-semibold">{prefix} method</label><select id={`${id}-method`} className="field" value={method} disabled={disabled} onChange={(event) => { if (isManualPaymentMethod(event.target.value)) setMethod(event.target.value); }}>{manualPaymentMethods.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
    <div><label htmlFor={`${id}-reference`} className="mb-2 block text-sm font-semibold">Unique {prefix === "Payment" ? "receipt" : "payout"} / transaction reference</label><input id={`${id}-reference`} className="field" value={reference} onChange={(event) => setReference(event.target.value)} minLength={3} maxLength={120} required disabled={disabled} /><p className="mt-1 text-xs muted">Required for all methods, including cash. Use 3–120 printable characters. Each separate physical receipt or payout needs a different reference; reuse the saved operation to retry the same one.</p></div></div>;
}

export function AdvanceCreditAccount(props: Props) {
  return <ScopedAdvanceCreditAccount key={`${props.userId}:${props.schoolId}:${props.studentId}`} {...props} />;
}

function ScopedAdvanceCreditAccount({ client, schoolId, studentId, userId, canReview, onLockChange }: Props) {
  const id = useId(), recoveryKey = `kids-corner-advance-operation:v1:${userId}:${schoolId}:${studentId}`;
  const [tab, setTab] = useState<Tab>("receive");
  const [activityPage, setActivityPage] = useState(0), [requestPage, setRequestPage] = useState(0);
  const [version, setVersion] = useState(0), [records, setRecords] = useState<Records>();
  const [amount, setAmount] = useState(""), [reason, setReason] = useState("");
  const [method, setMethod] = useState<ManualPaymentMethod>("cash"), [reference, setReference] = useState("");
  const [feeId, setFeeId] = useState("");
  const [correctionKind, setCorrectionKind] = useState<CreditChangeKind>("allocation_return"), [targetId, setTargetId] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation>(), [checked, setChecked] = useState(false);
  const [pending, setPending] = useState<Recovery>(), [storageReady, setStorageReady] = useState(false);
  const [unreadableRetry, setUnreadableRetry] = useState(false), [reconciledRetry, setReconciledRetry] = useState(false);
  const [saving, setSaving] = useState(false), [sessionChanged, setSessionChanged] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean }>();
  const [selectedRequestId, setSelectedRequestId] = useState(""), [reviewReason, setReviewReason] = useState("");
  const [payoutReason, setPayoutReason] = useState(""), [payoutReference, setPayoutReference] = useState("");
  const [payoutMethod, setPayoutMethod] = useState<ManualPaymentMethod>("cash"), [payoutAttested, setPayoutAttested] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [staleRequests, setStaleRequests] = useState<Set<string>>(() => new Set());
  const [requiresRefresh, setRequiresRefresh] = useState(false);
  const scopeValid = useRef(true), mounted = useRef(true), inFlight = useRef(false), confirmationHeading = useRef<HTMLHeadingElement>(null);
  const queryKey = JSON.stringify([schoolId, studentId, activityPage, requestPage, version]);
  const active = records?.key === queryKey ? records : undefined;
  const account = active?.account, fees = active?.fees ?? [], requests = active?.requests ?? [];
  const selectedRequest = requests.find((request) => request.id === selectedRequestId);
  const selectedFee = fees.find((fee) => fee.demand_id === feeId);
  const target = account?.activities.find((activity) => activity.id === targetId);
  const correctionTargets = account?.activities.filter((activity) => activity.kind === (correctionKind === "receipt_reversal" ? "receipt" : "allocation")) ?? [];
  const payableFees = fees.filter((fee) => fee.financial_token && !fee.invalid && fee.balance !== null && toPaise(fee.balance) > BigInt(0));
  const dirty = Boolean(amount || reason || reference || feeId || targetId || reviewReason || payoutReason || payoutReference || cancelReason || confirmation);
  const historyLocked = saving || Boolean(pending) || !storageReady || sessionChanged || Boolean(confirmation);
  const locked = historyLocked || unreadableRetry;
  const dataReady = Boolean(account && !account.summary.invalid && account.financial_token);
  const receiptDayOpen = Boolean(active?.day?.open && active.day.day === schoolDate());
  const pendingStale = Boolean(selectedRequest?.state === "pending" && (staleRequests.has(selectedRequest.id)
    || (account?.financial_token && selectedRequest.financial_token !== account.financial_token)
    || (selectedRequest.kind === "allocation_return" && selectedRequest.fee_token !== fees.find((fee) => fee.demand_id === selectedRequest.fee_id)?.financial_token)));
  const selfReview = selectedRequest?.requested_by === userId;
  const approvalBlocked = !dataReady || pendingStale || requiresRefresh || (selectedRequest?.kind === "receipt_reversal" && (!active?.day?.open || active.day.day !== schoolDate()));
  const currentConfirmation = pending?.confirmation ?? confirmation;

  useEffect(() => {
    mounted.current = true;
    let active = true;
    queueMicrotask(() => { if (active) { const saved = readRecovery(recoveryKey, schoolId, studentId, userId); setPending(saved.recovery); setUnreadableRetry(saved.unreadable); setStorageReady(true); } });
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) { scopeValid.current = false; setSessionChanged(true); setRecords(undefined); setConfirmation(undefined); setFeedback(undefined); }
    });
    return () => { active = false; mounted.current = false; subscription.unsubscribe(); };
  }, [client, recoveryKey, schoolId, studentId, userId]);

  useEffect(() => { onLockChange?.(dirty || locked); }, [dirty, locked, onLockChange]);

  useEffect(() => {
    if (sessionChanged || !storageReady) return;
    let live = true;
    void (async () => {
      try {
        const today = schoolDate();
        const [account, fees, queue, dayResult] = await Promise.all([
          getOfficeStudentCredit(client, schoolId, studentId, size, activityPage * size), studentFees(client, schoolId, studentId),
          listOfficeCreditChanges(client, schoolId, studentId, "all", size, requestPage * size),
          client.rpc("get_office_fee_day", { p_school_id: schoolId, p_day: today }),
        ]);
        const dayData = dayResult.data as { business_date?: string; invalid_count?: number; closed_at?: string | null } | null;
        const day: DayStatus = !dayResult.error && dayData?.business_date === today && Number.isSafeInteger(dayData.invalid_count) && "closed_at" in dayData
          ? { day: today, open: dayData.closed_at === null && dayData.invalid_count === 0 }
          : { day: today, open: false, error: "The current cashier day could not be verified. Refresh before recording a payout." };
        if (live && scopeValid.current) setRecords({ key: queryKey, account, fees, requests: queue.rows, requestCount: queue.total_count, day });
      } catch (issue) { if (live && scopeValid.current) setRecords({ key: queryKey, error: message(issue) }); }
    })();
    return () => { live = false; };
  }, [client, queryKey, schoolId, studentId, activityPage, requestPage, sessionChanged, storageReady]);

  const refresh = useCallback(() => { setRequiresRefresh(false); setPayoutAttested(false); setVersion((value) => value + 1); }, []);
  function clearUnreadableRetry() {
    if (!unreadableRetry || !reconciledRetry || inFlight.current || !scopeValid.current) return;
    try {
      sessionStorage.removeItem(recoveryKey);
      setUnreadableRetry(false); setReconciledRetry(false);
      setFeedback({ text: "Unreadable local retry cleared after your reconciliation. No financial operation was sent." });
    } catch { setFeedback({ text: "This local retry could not be cleared. New financial actions remain blocked; keep the reconciled school records.", error: true }); }
  }
  function resetDraft() {
    setAmount(""); setReason(""); setReference(""); setFeeId(""); setTargetId(""); setConfirmation(undefined); setChecked(false);
    setReviewReason(""); setPayoutReason(""); setPayoutReference(""); setPayoutAttested(false); setCancelReason("");
  }
  function showConfirmation(value: Confirmation) { setFeedback(undefined); setChecked(false); setConfirmation(value); queueMicrotask(() => confirmationHeading.current?.focus()); }
  function prepare(event: FormEvent<HTMLFormElement>, kind: "receipt" | "allocation" | CreditChangeKind) {
    event.preventDefault();
    if (!account || !dataReady || locked || requiresRefresh) return;
    if (kind === "receipt" && !receiptDayOpen) {
      setFeedback({ text: "The current IST cashier day is closed or could not be verified. Refresh before recording a new advance receipt. Your draft is kept.", error: true }); return;
    }
    try {
      const normalizedReason = normalizeCreditReason(reason), normalizedAmount = kind === "receipt_reversal" ? target?.amount : positiveMoney(amount);
      if (!normalizedAmount) throw new Error("Choose an advance receipt from the loaded activity page.");
      const delta = toPaise(normalizedAmount), available = toPaise(account.summary.available_amount!);
      if (kind !== "receipt" && kind !== "allocation_return" && delta > available) throw new Error("This exceeds available credit. Refresh the account before continuing.");
      const requestId = crypto.randomUUID();
      if (kind === "receipt") {
        const normalizedReference = normalizeCreditReference(reference);
        showConfirmation({ operation: { kind: "receipt", input: { studentId, amount: normalizedAmount, method, reference: normalizedReference, reason: normalizedReason, requestId } }, amount: normalizedAmount,
          title: "Confirm advance received", detail: `Record cleared money already received by ${manualPaymentLabel(method)}. Cheque funds must have cleared before they become available credit. This is an office attestation; the ERP does not verify bank clearance. This does not settle a fee until credit is applied. Reference: ${normalizedReference}.`, cash: `Money received: ${formatMoney(normalizedAmount)}` });
      } else if (kind === "allocation") {
        if (!selectedFee?.financial_token || selectedFee.balance === null || delta > toPaise(selectedFee.balance)) throw new Error("Choose a valid fee and an amount within its outstanding balance.");
        showConfirmation({ operation: { kind: "allocation", input: { studentId, feeId: selectedFee.demand_id, amount: normalizedAmount, expectedCreditToken: account.financial_token!, expectedFeeToken: selectedFee.financial_token, reason: normalizedReason, requestId } }, amount: normalizedAmount,
          title: "Confirm credit application", detail: `${selectedFee.fee_name} · ${formatFeeBillingPeriod(selectedFee.billing_period)}. Fee balance becomes ${formatMoney(fromPaise(toPaise(selectedFee.balance) - delta))}; available credit becomes ${formatMoney(fromPaise(available - delta))}. The server rechecks both balances.`, cash: "New money received: ₹0.00" });
      } else {
        const targetFee = kind === "allocation_return" ? fees.find((fee) => fee.demand_id === target?.fee_id) : undefined;
        if (kind !== "refund" && (!target || target.kind !== (kind === "allocation_return" ? "allocation" : "receipt"))) throw new Error("Choose the original entry from this loaded activity page.");
        if (kind === "allocation_return" && (!targetFee?.financial_token || delta > toPaise(target!.amount))) throw new Error("Choose a valid original allocation and an amount no greater than that entry. Previously returned amounts are rechecked by the server.");
        showConfirmation({ operation: { kind: "request", input: { studentId, kind, entryId: kind === "refund" ? null : target!.id, amount: kind === "receipt_reversal" ? null : normalizedAmount, expectedCreditToken: account.financial_token!, expectedFeeToken: targetFee?.financial_token ?? null, reason: normalizedReason, requestId } }, amount: normalizedAmount,
          title: kind === "refund" ? "Confirm refund request" : `Confirm ${changeLabels[kind].toLocaleLowerCase()} request`,
          detail: kind === "refund" ? "A different School Admin or Principal must review this request. Approval only reserves credit; a separate record is required after the offline payout completes."
            : kind === "allocation_return" ? `Returns credit from ${target!.reference} if approved and increases that fee's outstanding balance. This does not receive or send money.`
              : `Reverses the full advance entry ${target!.reference} if approved. This corrects a recorded entry; it does not send a bank refund.`,
          cash: kind === "receipt_reversal" ? `On approval: ${formatMoney(normalizedAmount)} negative book correction` : "Request and approval do not move money" });
      }
    } catch (issue) { setFeedback({ text: message(issue), error: true }); }
  }
  function prepareDecision(decision: "approved" | "rejected") {
    if (!selectedRequest || !canReview || selfReview || locked || (decision === "approved" && approvalBlocked)) return;
    try {
      const normalizedReason = normalizeCreditReason(reviewReason);
      showConfirmation({ operation: { kind: "review", requestId: selectedRequest.id, decision, reason: normalizedReason }, amount: selectedRequest.amount,
        title: decision === "approved" ? selectedRequest.kind === "refund" ? "Confirm credit reservation" : "Confirm credit correction approval" : "Confirm request rejection",
        detail: decision === "rejected" ? "Reject this immutable request without moving money or credit. Its original reason remains in the audit history."
          : selectedRequest.kind === "refund" ? "Reserve this amount for the approved refund. Available credit decreases; no money leaves school and no payout is recorded yet."
            : selectedRequest.kind === "allocation_return" ? "Return applied credit to the student's available balance and reopen the corresponding fee amount. No new money is received."
              : "Post the full advance-entry correction on the current open IST cashier day. This does not send a bank refund.",
        cash: decision === "approved" && selectedRequest.kind === "receipt_reversal" ? `Negative book correction: ${formatMoney(selectedRequest.amount)}` : "Actual money movement: ₹0.00" });
    } catch (issue) { setFeedback({ text: message(issue), error: true }); }
  }
  function preparePayout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedRequest || selectedRequest.state !== "approved" || selectedRequest.kind !== "refund" || !dataReady || !active?.day?.open || active.day.day !== schoolDate() || !payoutAttested || locked || requiresRefresh) return;
    try {
      const normalizedReason = normalizeCreditReason(payoutReason), normalizedReference = normalizeCreditReference(payoutReference);
      showConfirmation({ operation: { kind: "payout", input: { requestId: selectedRequest.id, method: payoutMethod, reference: normalizedReference, reason: normalizedReason, payoutId: crypto.randomUUID() } }, amount: selectedRequest.amount,
        title: "Confirm offline payout record", detail: `Record the already completed ${manualPaymentLabel(payoutMethod)} payout once. Reference: ${normalizedReference}. This screen does not transfer money. The server rechecks the current cashier day.`, cash: `Money already paid out: ${formatMoney(selectedRequest.amount)}` });
    } catch (issue) { setFeedback({ text: message(issue), error: true }); }
  }
  function prepareCancel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedRequest || selectedRequest.state !== "approved" || selectedRequest.kind !== "refund" || !canReview || locked) return;
    try { showConfirmation({ operation: { kind: "cancel", requestId: selectedRequest.id, reason: normalizeCreditReason(cancelReason) }, amount: selectedRequest.amount,
      title: "Confirm refund cancellation", detail: "Cancel the approved but unpaid refund and release its reserved credit. Cancel only when an offline payout has not occurred.", cash: "Actual money movement: ₹0.00" }); }
    catch (issue) { setFeedback({ text: message(issue), error: true }); }
  }
  async function submitConfirmation() {
    if (!currentConfirmation || unreadableRetry || (!pending && !checked) || inFlight.current || !scopeValid.current) return;
    const recovery: Recovery = pending ?? { version: 1, schoolId, studentId, userId, confirmation: currentConfirmation };
    inFlight.current = true; setSaving(true); setFeedback(undefined); setPending(recovery); writeRecovery(recoveryKey, recovery);
    const operation = recovery.confirmation.operation;
    try {
      const { data: { user }, error: authError } = await client.auth.getUser();
      if (authError || user?.id !== userId || !scopeValid.current) {
        scopeValid.current = false; setSessionChanged(true); setRecords(undefined); return;
      }
      let result: CreditActivity | CreditChangeRequest;
      if (operation.kind === "receipt") result = await recordOfficeCreditReceipt(client, schoolId, operation.input);
      else if (operation.kind === "allocation") result = await allocateOfficeCredit(client, schoolId, operation.input);
      else if (operation.kind === "request") result = await requestOfficeCreditChange(client, schoolId, operation.input);
      else if (operation.kind === "review") result = await reviewOfficeCreditChange(client, operation.requestId, operation.decision, operation.reason);
      else if (operation.kind === "payout") result = await payOfficeCreditRefund(client, operation.input);
      else result = await cancelOfficeCreditRefund(client, operation.requestId, operation.reason);
      if (!mounted.current || !scopeValid.current) return;
      writeRecovery(recoveryKey); setPending(undefined); resetDraft();
      const stateMessage = "state" in result ? savedRequestMessage(result)
        : operation.kind === "allocation" ? "Stored credit applied to the fee. No new money received." : "Advance received and recorded. Apply stored credit separately when needed.";
      setFeedback({ text: `${stateMessage}${result.reference ? ` Reference: ${result.reference}.` : ""}` });
      refresh();
    } catch (issue) {
      if (!mounted.current || !scopeValid.current) return;
      const known = ["PT409", "22023", "23505", "42501", "55000"].includes(code(issue));
      if (known) {
        writeRecovery(recoveryKey); setPending(undefined); setConfirmation(undefined); setChecked(false);
        if (code(issue) === "PT409") { setRequiresRefresh(true); if (operation.kind === "review") setStaleRequests((current) => new Set(current).add(operation.requestId)); }
        if (operation.kind === "payout") setRequiresRefresh(true);
        if (code(issue) === "42501") { scopeValid.current = false; setRecords(undefined); setSessionChanged(true); }
      }
      const guidance = code(issue) === "PT409" ? operation.kind === "review" ? " This request's saved snapshot is obsolete. Keep the review reason, refresh, then reject it and create a new request; refreshing cannot change this request's snapshot." : " Your draft is kept. Refresh the account and review a new confirmation."
        : operation.kind === "payout" && known ? " The payout was not recorded. Keep its proof and reconcile with school finance; do not send the money again." : known ? " Your draft is kept." : " The outcome is unknown. Retry the same saved operation below before recording anything else.";
      setFeedback({ text: `${message(issue)}${guidance}`, error: true });
    } finally { inFlight.current = false; if (mounted.current && scopeValid.current) setSaving(false); }
  }

  if (sessionChanged) return <p role="alert" className={errorClass}>Your sign-in changed. Reopen this page to verify access; previous credit records are hidden.</p>;
  return <section aria-label="Student advance credit" className="space-y-5">
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] p-4 sm:p-5">
        <div><h2 className="text-lg font-bold">{account?.student_name ?? "Student credit account"}</h2><p className="mt-1 text-sm muted">{account?.admission_no} · Advance credit is separate from fee dues.</p></div>
        <button type="button" className={button} disabled={saving || Boolean(pending) || Boolean(confirmation) || !storageReady} onClick={refresh}><RefreshCw size={15} aria-hidden="true" /> Refresh credit account</button>
      </div>
      {active?.error ? <p role="alert" className="p-5 text-sm text-red-700 dark:text-red-300">{active.error}</p> : !account ? <LoadingState variant="table" className="p-5 text-sm muted">Loading verified credit and fee records…</LoadingState> : <div className="space-y-3 p-4 sm:p-5">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">{[["Available credit", account.summary.available_amount], ["Reserved for unpaid refunds", account.summary.reserved_amount], ["Total unused credit", account.summary.balance_amount]].map(([label, value]) => <div key={label} className="rounded-xl bg-[var(--surface-2)] p-4"><dt className="text-xs font-medium muted">{label}</dt><dd className="mt-2 break-words text-xl font-bold tabular-nums">{displayMoney(value)}</dd></div>)}</dl>
        <p className="text-xs muted">Received {displayMoney(account.summary.received_amount)} · Applied to fees {displayMoney(account.summary.allocated_amount)} · Refunded {displayMoney(account.summary.refunded_amount)} · Entry corrections {displayMoney(account.summary.reversed_amount)}</p>
        {account.summary.invalid && <p role="alert" className={errorClass}>This credit account needs reconciliation. Financial actions are disabled; ask school finance to review the records.</p>}
      </div>}
    </div>
    {feedback && <p role={feedback.error ? "alert" : "status"} className={feedback.error ? errorClass : "rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-4 text-sm"}>{feedback.text}</p>}
    {unreadableRetry && <section aria-label="Unreadable saved credit operation" className="space-y-4 rounded-xl border border-amber-500/35 bg-amber-500/5 p-4 sm:p-5">
      <p role="alert" className="text-sm text-amber-950 dark:text-amber-200">A saved local operation could not be read. It may already appear in the school records. New financial actions are blocked. Review Activity and Requests with school finance before clearing this local retry.</p>
      <p className="text-sm muted">Clearing affects only this signed-in account, school and student in this browser. It does not retry, record, cancel or refund any money.</p>
      <label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" className="mt-1 size-4 shrink-0" checked={reconciledRetry} onChange={(event) => setReconciledRetry(event.target.checked)} /><span>I checked saved activity/requests and reconciled this operation with school finance</span></label>
      <button type="button" className={button} disabled={!reconciledRetry || saving} onClick={clearUnreadableRetry}>Clear unreadable local retry</button>
    </section>}
    {requiresRefresh && !pending && <p role="alert" className="rounded-xl bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">The account or cashier day changed. Refresh credit account before a new financial action. Draft inputs and review reasons are kept.</p>}
    {currentConfirmation && <section aria-labelledby={`${id}-confirm`} className="card space-y-4 border-blue-500/40 p-4 sm:p-5">
      <h3 id={`${id}-confirm`} ref={confirmationHeading} tabIndex={-1} className="text-lg font-bold">{pending ? "Saved operation needs confirmation" : currentConfirmation.title}</h3>
      <p className="text-sm">{currentConfirmation.detail}</p><p className="text-2xl font-bold tabular-nums">{formatMoney(currentConfirmation.amount)}</p><p className="rounded-xl bg-[var(--surface-2)] p-3 text-sm font-semibold">{currentConfirmation.cash}</p>
      {pending ? <p className="text-sm muted">The previous response could not be confirmed. This retry keeps the original request ID, amount and details. Do not record another receipt or payout.</p>
        : <label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" className="mt-1 size-4 shrink-0" checked={checked} onChange={(event) => setChecked(event.target.checked)} /><span>I checked this student, amount and financial effect.</span></label>}
      <div className="flex flex-wrap gap-2"><button type="button" className={primary} disabled={saving || (!pending && !checked)} onClick={() => void submitConfirmation()}>{saving ? "Saving financial operation…" : pending ? "Retry saved operation" : currentConfirmation.title}</button>
        {!pending && <button type="button" className={button} disabled={saving} onClick={() => { setConfirmation(undefined); setChecked(false); }}>Back to draft</button>}</div>
    </section>}
    <div className="card overflow-hidden">
      <nav aria-label="Advance credit sections" className="grid grid-cols-2 gap-2 border-b border-[var(--border)] p-3 sm:grid-cols-4">{([ ["receive", "Receive"], ["apply", "Apply"], ["refunds", "Refunds"], ["activity", "Activity"] ] as const).map(([value, label]) => <button key={value} type="button" aria-current={tab === value ? "page" : undefined} className={`${button} ${tab === value ? "border-blue-600 bg-blue-500/10 text-blue-800 dark:text-blue-200" : "border-transparent"}`} disabled={historyLocked || (dirty && value !== tab)} onClick={() => { setTab(value); setFeedback(undefined); }}>{label}</button>)}</nav>
      <div className="space-y-5 p-4 sm:p-5">
        {dirty && !pending && !saving && <button type="button" className={button} onClick={resetDraft}>Discard draft and unlock context</button>}
        {tab === "receive" && <form aria-label="Receive advance form" className="space-y-4" onSubmit={(event) => prepare(event, "receipt")}>
          <div><h3 className="text-lg font-bold">Receive advance</h3><p className="mt-1 text-sm muted">Record cleared money already received by the school. Cheque funds must have cleared before they become available credit. UPI, bank, card and cheque entries are manual office attestations; this page does not verify bank clearance or provider settlement.</p></div>
          {account && !receiptDayOpen && <p role="alert" className="rounded-xl bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">{active?.day?.error ?? `Cashier day ${active?.day?.day ?? schoolDate()} (IST) is closed or needs reconciliation. A new advance receipt cannot be recorded. Refresh and verify the day before receiving money; your draft is kept.`}</p>}
          <Fields id={`${id}-receive`} amount={amount} setAmount={setAmount} reason={reason} setReason={setReason} disabled={locked || Boolean(confirmation)} />
          <MethodFields id={`${id}-receive`} method={method} setMethod={setMethod} reference={reference} setReference={setReference} disabled={locked || Boolean(confirmation)} />
          <button className={primary} type="submit" disabled={locked || !dataReady || !receiptDayOpen || requiresRefresh || Boolean(confirmation)}>Review advance receipt</button>
        </form>}
        {tab === "apply" && <form aria-label="Apply advance form" className="space-y-4" onSubmit={(event) => prepare(event, "allocation")}>
          <div><h3 className="text-lg font-bold">Apply stored credit</h3><p className="mt-1 text-sm muted">Reduce this student&apos;s fee balance with available credit. This creates no new cash receipt and does not add to day collections.</p></div>
          <div><label htmlFor={`${id}-fee`} className="mb-2 block text-sm font-semibold">Fee to settle</label><select id={`${id}-fee`} className="field" required value={feeId} disabled={locked || Boolean(confirmation) || !account} onChange={(event) => setFeeId(event.target.value)}><option value="">Choose outstanding fee</option>{payableFees.map((fee) => <option key={fee.demand_id} value={fee.demand_id}>{fee.fee_name} · {formatFeeBillingPeriod(fee.billing_period)} · {fee.academic_year_name} · {displayMoney(fee.balance)}</option>)}</select></div>
          {account && payableFees.length === 0 && <p className="text-sm muted">No valid outstanding fees are available for this student.</p>}
          <Fields id={`${id}-apply`} amount={amount} setAmount={setAmount} reason={reason} setReason={setReason} disabled={locked || Boolean(confirmation)} />
          <button className={primary} type="submit" disabled={locked || !dataReady || requiresRefresh || Boolean(confirmation)}>Review credit application</button>
        </form>}
        {tab === "refunds" && <div className="space-y-6">
          <form aria-label="Request unused-credit refund form" className="space-y-4" onSubmit={(event) => prepare(event, "refund")}>
            <div><h3 className="text-lg font-bold">Request unused-credit refund</h3><p className="mt-1 text-sm muted">A different School Admin or Principal must approve. Approval reserves available credit; recording a completed offline payout is a separate step.</p></div>
            <Fields id={`${id}-refund`} amount={amount} setAmount={setAmount} reason={reason} setReason={setReason} disabled={locked || Boolean(confirmation)} />
            <button className={primary} type="submit" disabled={locked || !dataReady || requiresRefresh || Boolean(confirmation)}>Review refund request</button>
          </form>
          <div className="space-y-4 border-t border-[var(--border)] pt-5">
            <div className="flex items-center gap-2"><ShieldCheck size={18} aria-hidden="true" /><h3 className="text-lg font-bold">Requests and independent review</h3></div>
            <p className="text-sm muted">Includes refund requests, allocation returns and advance-entry corrections. Each request keeps its original financial snapshot.</p>
            {requests.length ? <ul aria-label="Advance credit requests" className="space-y-2">{requests.map((request) => <li key={request.id}><button type="button" aria-label={`View credit request ${request.id}`} className={`w-full rounded-xl border p-3 text-left disabled:opacity-50 ${request.id === selectedRequestId ? "border-blue-600 bg-blue-500/5" : "border-[var(--border)]"}`} disabled={historyLocked || Boolean(selectedRequestId !== request.id && (reviewReason || payoutReason || payoutReference || cancelReason))} onClick={() => { setSelectedRequestId(request.id); setReviewReason(""); setPayoutReason(""); setPayoutReference(""); setPayoutAttested(false); setCancelReason(""); }}>
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-semibold">{changeLabels[request.kind]} · {formatMoney(request.amount)}</span><RequestState request={request} /></div><p className="mt-2 text-xs muted">Request {request.id.slice(0, 8)} · {request.requester_name} · {dateFormat.format(new Date(request.requested_at))} IST</p><p className="mt-1 break-words text-xs muted">{request.request_reason.length > 100 ? `${request.request_reason.slice(0, 100)}…` : request.request_reason}</p></button></li>)}</ul>
              : account && <p className="text-sm muted">No credit change requests for this student.</p>}
            <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs muted">{active?.requestCount ?? 0} requests · Page {requestPage + 1}</p><div className="flex gap-2"><button type="button" className={button} disabled={historyLocked || dirty || requestPage === 0} onClick={() => { setSelectedRequestId(""); setRequestPage((value) => value - 1); }}>Previous requests</button><button type="button" className={button} disabled={historyLocked || dirty || !active || (requestPage + 1) * size >= (active.requestCount ?? 0)} onClick={() => { setSelectedRequestId(""); setRequestPage((value) => value + 1); }}>Next requests</button></div></div>
            {selectedRequest && <section aria-label="Selected credit request" className="space-y-4 rounded-xl border border-[var(--border)] p-4">
              <div><h4 className="font-bold">{changeLabels[selectedRequest.kind]}</h4><p className="mt-1 text-sm font-semibold tabular-nums">{formatMoney(selectedRequest.amount)}</p></div>
              <dl className="space-y-2 text-sm"><div><dt className="muted">Requested by</dt><dd>{selectedRequest.requester_name}</dd></div><div><dt className="muted">Request reason</dt><dd className="break-words">{selectedRequest.request_reason}</dd></div>{selectedRequest.target_reference && <div><dt className="muted">Original entry</dt><dd className="break-all">{selectedRequest.target_reference}</dd></div>}{selectedRequest.reference && <div><dt className="muted">Posted reference</dt><dd className="break-all">{selectedRequest.reference}</dd></div>}{selectedRequest.review_reason && <div><dt className="muted">Review reason</dt><dd className="break-words">{selectedRequest.review_reason}</dd></div>}{selectedRequest.cancel_reason && <div><dt className="muted">Cancellation reason</dt><dd className="break-words">{selectedRequest.cancel_reason}</dd></div>}</dl>
              <RequestState request={selectedRequest} />
              {selectedRequest.state === "pending" && <>
                {selfReview && <p className="text-sm text-amber-800 dark:text-amber-300">You requested this change. A different School Admin or Principal must review it.</p>}
                {pendingStale && <p role="alert" className="text-sm text-amber-800 dark:text-amber-300">This request&apos;s financial snapshot changed. Reject it and create a new request after refreshing. Refreshing cannot make this saved request valid for approval.</p>}
                {selectedRequest.kind === "receipt_reversal" && !active?.day?.open && <p role="alert" className="text-sm text-amber-800 dark:text-amber-300">An open, reconciled current IST cashier day is required to approve this book correction. The request can still be rejected.</p>}
                {canReview && !selfReview && <div className="space-y-3"><label htmlFor={`${id}-review-reason`} className="block text-sm font-semibold">Credit review reason</label><input id={`${id}-review-reason`} className="field" value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} minLength={5} maxLength={500} disabled={locked || Boolean(confirmation)} /><div className="flex flex-wrap gap-2"><button type="button" className={primary} disabled={locked || !validReason(reviewReason) || approvalBlocked || Boolean(confirmation)} onClick={() => prepareDecision("approved")}>{selectedRequest.kind === "refund" ? "Review credit reservation" : "Review correction approval"}</button><button type="button" className={button} disabled={locked || !validReason(reviewReason) || Boolean(confirmation)} onClick={() => prepareDecision("rejected")}>Review request rejection</button></div></div>}
              </>}
              {selectedRequest.state === "approved" && selectedRequest.kind === "refund" && <div className="space-y-5">
                <p className="rounded-xl bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">Credit is reserved. No payout has been recorded. This page never transfers money.</p>
                <form aria-label="Record completed offline payout form" className="space-y-4" onSubmit={preparePayout}>
                  <h5 className="font-bold">Record completed offline payout</h5><p className="text-sm muted">Verify the cashier day is open before the school completes its offline payment process. Then record that completed payout once and keep its proof.</p>
                  <p role={active?.day?.open ? "status" : "alert"} className="text-sm">{active?.day?.error ?? (active?.day?.open ? `Cashier day ${active.day.day} (IST) is open. Refresh immediately before payout.` : `Cashier day ${active?.day?.day ?? schoolDate()} (IST) is closed or needs reconciliation. Payout recording is disabled.`)}</p>
                  <MethodFields id={`${id}-payout`} method={payoutMethod} setMethod={setPayoutMethod} reference={payoutReference} setReference={setPayoutReference} disabled={locked || Boolean(confirmation)} prefix="Payout" />
                  <div><label htmlFor={`${id}-payout-reason`} className="mb-2 block text-sm font-semibold">Payout reason</label><input id={`${id}-payout-reason`} className="field" value={payoutReason} onChange={(event) => setPayoutReason(event.target.value)} minLength={5} maxLength={500} required disabled={locked || Boolean(confirmation)} /></div>
                  <label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" className="mt-1 size-4 shrink-0" checked={payoutAttested} onChange={(event) => setPayoutAttested(event.target.checked)} disabled={locked || Boolean(confirmation) || !active?.day?.open} /><span>I verified the open cashier day and this offline payout has already completed. I will record it only once.</span></label>
                  <button type="submit" className={primary} disabled={locked || !dataReady || !active?.day?.open || active.day.day !== schoolDate() || !payoutAttested || requiresRefresh || Boolean(confirmation)}>Review offline payout record</button>
                </form>
                {canReview && <form aria-label="Cancel unpaid refund form" className="space-y-3 border-t border-[var(--border)] pt-4" onSubmit={prepareCancel}><h5 className="font-bold">Cancel unpaid refund</h5><p className="text-sm muted">Only cancel if no offline payout occurred. Cancellation releases this reservation for future use.</p><label htmlFor={`${id}-cancel-reason`} className="block text-sm font-semibold">Refund cancellation reason</label><input id={`${id}-cancel-reason`} className="field" value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} minLength={5} maxLength={500} required disabled={locked || Boolean(confirmation)} /><button type="submit" className={button} disabled={locked || Boolean(confirmation)}>Review refund cancellation</button></form>}
              </div>}
            </section>}
          </div>
        </div>}
        {tab === "activity" && <div className="space-y-5">
          <div><h3 className="text-lg font-bold">Credit activity</h3><p className="mt-1 text-sm muted">Receipts and payouts move money. Applying or returning credit changes fee balances without another cash receipt.</p></div>
          {account?.activities.length ? <ol aria-label="Credit activity history" className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">{account.activities.map((activity) => <li key={activity.id} className="space-y-2 p-4"><div className="flex flex-wrap items-start justify-between gap-2"><div className="flex min-w-0 items-center gap-2">{["receipt", "allocation_return"].includes(activity.kind) ? <ArrowDownLeft size={16} className="shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden="true" /> : <ArrowUpRight size={16} className="shrink-0 text-blue-700 dark:text-blue-300" aria-hidden="true" />}<span className="text-sm font-semibold">{activityLabels[activity.kind]}</span></div><span className="font-bold tabular-nums">{formatMoney(activity.amount)}</span></div><p className="break-all text-xs font-medium">{activity.reference}</p><p className="text-xs muted">{dateFormat.format(new Date(activity.occurred_at))} IST{activity.payment_method ? ` · ${manualPaymentLabel(activity.payment_method)}` : " · No new money movement"}{activity.fee_name ? ` · ${activity.fee_name}` : ""}</p>{activity.related_reference && <p className="break-all text-xs muted">Related entry: {activity.related_reference}</p>}</li>)}</ol> : account && <p className="text-sm muted">No advance-credit activity yet.</p>}
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs muted">{account?.activity_count ?? 0} entries · Page {activityPage + 1}</p><div className="flex gap-2"><button type="button" className={button} disabled={historyLocked || dirty || activityPage === 0} onClick={() => setActivityPage((value) => value - 1)}>Previous activity</button><button type="button" className={button} disabled={historyLocked || dirty || !account || (activityPage + 1) * size >= account.activity_count} onClick={() => setActivityPage((value) => value + 1)}>Next activity</button></div></div>
          <form aria-label="Request credit correction form" className="space-y-4 border-t border-[var(--border)] pt-5" onSubmit={(event) => prepare(event, correctionKind)}>
            <div><h4 className="font-bold">Request an entry correction</h4><p className="mt-1 text-sm muted">A different School Admin or Principal reviews corrections. A receipt reversal corrects the recorded entry and never sends a bank refund.</p></div>
            <div><label htmlFor={`${id}-correction-kind`} className="mb-2 block text-sm font-semibold">Credit correction type</label><select id={`${id}-correction-kind`} className="field" value={correctionKind} disabled={locked || Boolean(confirmation)} onChange={(event) => { setCorrectionKind(event.target.value as CreditChangeKind); setTargetId(""); }}><option value="allocation_return">Return applied credit to balance</option><option value="receipt_reversal">Reverse full advance receipt entry</option></select></div>
            <div><label htmlFor={`${id}-target`} className="mb-2 block text-sm font-semibold">Original credit entry</label><select id={`${id}-target`} className="field" value={targetId} disabled={locked || Boolean(confirmation)} required onChange={(event) => setTargetId(event.target.value)}><option value="">Choose entry from this activity page</option>{correctionTargets.map((activity) => <option key={activity.id} value={activity.id}>{activity.reference} · {formatMoney(activity.amount)}{activity.fee_name ? ` · ${activity.fee_name}` : ""}</option>)}</select><p className="mt-1 text-xs muted">Use Previous / Next activity to find older entries before starting a draft. The server checks amounts already returned or reversed.</p></div>
            {correctionKind === "receipt_reversal" && target && <p className="text-sm font-semibold">Full original amount: {formatMoney(target.amount)}</p>}
            <Fields id={`${id}-correction`} amount={amount} setAmount={setAmount} reason={reason} setReason={setReason} disabled={locked || Boolean(confirmation)} hideAmount={correctionKind === "receipt_reversal"} amountLabel="Credit to return (INR)" />
            <button type="submit" className={primary} disabled={locked || !dataReady || requiresRefresh || Boolean(confirmation)}>Review credit correction request</button>
          </form>
        </div>}
      </div>
    </div>
  </section>;
}
