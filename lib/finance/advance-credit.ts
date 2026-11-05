import type { SupabaseClient } from "@supabase/supabase-js";
import { fromPaise, normalizeMoney, positiveMoney, toPaise, type Money } from "./money";
import { isManualPaymentMethod, type ManualPaymentMethod } from "./payment-methods";

export type CreditActivityKind = "receipt" | "allocation" | "allocation_return" | "refund" | "receipt_reversal";
export type CreditChangeKind = "refund" | "allocation_return" | "receipt_reversal";
export type CreditChangeState = "pending" | "approved" | "rejected" | "cancelled" | "paid";
export type CreditSummary = {
  received_amount: Money | null;
  reversed_amount: Money | null;
  allocated_amount: Money | null;
  refunded_amount: Money | null;
  reserved_amount: Money | null;
  balance_amount: Money | null;
  available_amount: Money | null;
  invalid: boolean;
};
export type CreditActivity = {
  id: string;
  kind: CreditActivityKind;
  amount: Money;
  reference: string;
  occurred_at: string;
  payment_method: ManualPaymentMethod | null;
  fee_id: string | null;
  fee_name: string | null;
  related_reference: string | null;
};
export type CreditEntry = CreditActivity & { school_id: string; student_id: string };
export type FamilyCreditAccount = {
  school_id: string;
  student_id: string;
  admission_no: string;
  student_name: string;
  summary: CreditSummary;
  activities: CreditActivity[];
  activity_count: number;
};
export type OfficeCreditAccount = FamilyCreditAccount & { financial_token: string | null };
export type CreditChangeRequest = {
  id: string;
  school_id: string;
  student_id: string;
  admission_no: string;
  student_name: string;
  kind: CreditChangeKind;
  amount: Money;
  entry_target_id: string | null;
  target_reference: string | null;
  fee_id: string | null;
  request_reason: string;
  requested_by: string;
  requester_name: string;
  requested_at: string;
  state: CreditChangeState;
  financial_token: string;
  fee_token: string | null;
  reviewed_by: string | null;
  reviewer_name: string | null;
  review_reason: string | null;
  reviewed_at: string | null;
  entry_id: string | null;
  reference: string | null;
  effective_day: string | null;
  cancelled_by: string | null;
  canceller_name: string | null;
  cancel_reason: string | null;
  cancelled_at: string | null;
};
export type CreditReceiptInput = {
  studentId: string; amount: string; method: ManualPaymentMethod; reference: string; reason: string; requestId: string;
};
export type CreditAllocationInput = {
  studentId: string; feeId: string; amount: string; expectedCreditToken: string; expectedFeeToken: string; reason: string; requestId: string;
};
export type CreditChangeInput = {
  studentId: string; kind: CreditChangeKind; entryId: string | null; amount: string | null;
  expectedCreditToken: string; expectedFeeToken: string | null; reason: string; requestId: string;
};
export type CreditPayoutInput = {
  requestId: string; method: ManualPaymentMethod; reference: string; reason: string; payoutId: string;
};

export class AdvanceCreditError extends Error {
  constructor(message: string, readonly code?: string) { super(message); this.name = "AdvanceCreditError"; }
}
const activityKinds: readonly string[] = ["receipt", "allocation", "allocation_return", "refund", "receipt_reversal"];
const changeKinds: readonly string[] = ["refund", "allocation_return", "receipt_reversal"];
const changeStates: readonly string[] = ["pending", "approved", "rejected", "cancelled", "paid"];
const summaryFields = ["received_amount", "reversed_amount", "allocated_amount", "refunded_amount", "reserved_amount", "balance_amount", "available_amount"] as const;
const familyAccountFields = new Set(["school_id", "student_id", "admission_no", "student_name", "summary", "activities", "activity_count", "limit", "offset"]);
const familyActivityFields = new Set(["id", "kind", "amount", "reference", "occurred_at", "payment_method", "fee_id", "fee_name", "related_reference"]);
function invalid(): AdvanceCreditError { return new AdvanceCreditError("The advance-credit result could not be confirmed. Refresh the account or retry the same unconfirmed operation."); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string { if (typeof value !== "string") throw invalid(); return value; }
function id(value: unknown): string { const result = text(value); if (!result.trim()) throw invalid(); return result; }
function nullableText(value: unknown): string | null { return value == null ? null : text(value); }
function date(value: unknown): string { const result = text(value); if (!Number.isFinite(Date.parse(result))) throw invalid(); return result; }
function nullableDate(value: unknown): string | null { return value == null ? null : date(value); }
function count(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid(); return value; }
function money(value: unknown): Money { try { return normalizeMoney(value); } catch { throw invalid(); } }
function nullableMoney(value: unknown): Money | null { return value == null ? null : money(value); }
function positive(value: string): Money { try { return positiveMoney(value); } catch (error) { throw new AdvanceCreditError(error instanceof Error ? error.message : "Enter a valid positive amount.", "22023"); } }
function printable(value: string, minimum: number, maximum: number, label: string): string {
  const normalized = value.trim(), length = Array.from(normalized).length;
  const control = Array.from(value).some((letter) => { const code = letter.codePointAt(0)!; return code < 32 || (code >= 127 && code <= 159); });
  if (length < minimum || length > maximum || control) throw new AdvanceCreditError(`Enter ${label} with ${minimum}–${maximum} printable characters on one line.`, "22023");
  return normalized;
}
export const normalizeCreditReason = (value: string) => printable(value, 5, 500, "a reason");
export const normalizeCreditReference = (value: string) => printable(value, 3, 120, "a payment reference");

export function decodeCreditSummary(value: unknown): CreditSummary {
  const row = object(value);
  if (typeof row.invalid !== "boolean") throw invalid();
  const result = { invalid: row.invalid } as CreditSummary;
  for (const field of summaryFields) result[field] = nullableMoney(row[field]);
  if (result.invalid) {
    if (summaryFields.some((field) => result[field] !== null)) throw invalid();
  } else {
    if (summaryFields.some((field) => result[field] === null || toPaise(result[field]!) < BigInt(0))) throw invalid();
    const balance = toPaise(result.received_amount!) - toPaise(result.reversed_amount!) - toPaise(result.allocated_amount!) - toPaise(result.refunded_amount!);
    if (fromPaise(balance) !== result.balance_amount || fromPaise(balance - toPaise(result.reserved_amount!)) !== result.available_amount) throw invalid();
  }
  return result;
}
function activity(value: unknown): CreditActivity {
  const row = object(value);
  if (!activityKinds.includes(String(row.kind)) || (row.payment_method != null && !isManualPaymentMethod(row.payment_method))) throw invalid();
  const amount = money(row.amount);
  if (toPaise(amount) <= BigInt(0)) throw invalid();
  return { id: id(row.id), kind: row.kind as CreditActivityKind, amount, reference: id(row.reference), occurred_at: date(row.occurred_at),
    payment_method: row.payment_method == null ? null : row.payment_method as ManualPaymentMethod,
    fee_id: nullableText(row.fee_id), fee_name: nullableText(row.fee_name), related_reference: nullableText(row.related_reference) };
}
function account(value: unknown, studentId: string, limit: number, family: boolean): FamilyCreditAccount {
  const row = object(value);
  if (row.student_id !== studentId || !Array.isArray(row.activities)) throw invalid();
  if (family && (Object.keys(row).some((field) => !familyAccountFields.has(field))
    || Object.keys(object(row.summary)).some((field) => field !== "invalid" && !summaryFields.includes(field as typeof summaryFields[number]))
    || row.activities.some((item) => Object.keys(object(item)).some((field) => !familyActivityFields.has(field))))) throw invalid();
  const activities = row.activities.map(activity), total = count(row.activity_count);
  if (activities.length > limit || activities.length > total || new Set(activities.map((item) => item.id)).size !== activities.length) throw invalid();
  return { school_id: id(row.school_id), student_id: id(row.student_id), admission_no: text(row.admission_no), student_name: text(row.student_name),
    summary: decodeCreditSummary(row.summary), activities, activity_count: total };
}
function change(value: unknown): CreditChangeRequest {
  const row = object(value);
  if (!changeKinds.includes(String(row.kind)) || !changeStates.includes(String(row.state))) throw invalid();
  const result: CreditChangeRequest = {
    id: id(row.id), school_id: id(row.school_id), student_id: id(row.student_id), admission_no: text(row.admission_no), student_name: text(row.student_name),
    kind: row.kind as CreditChangeKind, amount: money(row.amount), entry_target_id: nullableText(row.entry_target_id), target_reference: nullableText(row.target_reference), fee_id: nullableText(row.fee_id),
    request_reason: text(row.request_reason), requested_by: id(row.requested_by), requester_name: text(row.requester_name), requested_at: date(row.requested_at),
    state: row.state as CreditChangeState, financial_token: id(row.financial_token), fee_token: nullableText(row.fee_token),
    reviewed_by: nullableText(row.reviewed_by), reviewer_name: nullableText(row.reviewer_name), review_reason: nullableText(row.review_reason), reviewed_at: nullableDate(row.reviewed_at),
    entry_id: nullableText(row.entry_id), reference: nullableText(row.reference), effective_day: nullableDate(row.effective_day),
    cancelled_by: nullableText(row.cancelled_by), canceller_name: nullableText(row.canceller_name), cancel_reason: nullableText(row.cancel_reason), cancelled_at: nullableDate(row.cancelled_at),
  };
  const posted = result.state === "paid" || (result.state === "approved" && result.kind !== "refund");
  if (toPaise(result.amount) <= BigInt(0) || (result.kind !== "refund" && !result.entry_target_id)
    || (result.state !== "pending" && (!result.reviewed_by || !result.review_reason || !result.reviewed_at || result.reviewed_by === result.requested_by))
    || (posted && (!result.entry_id || !result.reference || (result.kind !== "allocation_return" && !result.effective_day)))
    || (result.state === "approved" && result.kind === "refund" && result.entry_id)
    || (result.state === "paid" && result.kind !== "refund")
    || (result.state === "cancelled" && (result.kind !== "refund" || !result.cancelled_by || !result.cancel_reason || !result.cancelled_at))) throw invalid();
  return result;
}
async function rpc(client: SupabaseClient, name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    const { data, error } = await client.rpc(name, args);
    if (error) throw new AdvanceCreditError(["PT409", "22023", "23505", "42501", "55000"].includes(error.code) ? error.message
      : "The result could not be confirmed. Retry the same saved operation before recording another one.", error.code);
    return data;
  } catch (error) {
    if (error instanceof AdvanceCreditError) throw error;
    throw new AdvanceCreditError("The result could not be confirmed. Retry the same saved operation before recording another one.");
  }
}
function entry(value: unknown, schoolId: string, studentId: string, requestId: string, kind: CreditActivityKind, amount: string): CreditEntry {
  const row = object(value), result = activity(row);
  if (row.school_id !== schoolId || row.student_id !== studentId || result.id !== requestId || result.kind !== kind || result.amount !== amount) throw invalid();
  return { ...result, school_id: schoolId, student_id: studentId };
}

export async function getOfficeStudentCredit(client: SupabaseClient, schoolId: string, studentId: string, limit = 30, offset = 0): Promise<OfficeCreditAccount> {
  const value = await rpc(client, "get_office_student_credit", { p_school_id: schoolId, p_student_id: studentId, p_limit: limit, p_offset: offset });
  const row = object(value), result = account(row, studentId, limit, false), token = nullableText(row.financial_token);
  if (result.school_id !== schoolId || (!result.summary.invalid && !token) || (result.summary.invalid && token !== null)) throw invalid();
  return { ...result, financial_token: token };
}
export async function getFamilyStudentCredit(client: SupabaseClient, studentId: string, limit = 30, offset = 0): Promise<FamilyCreditAccount> {
  return account(await rpc(client, "get_family_student_credit", { p_student_id: studentId, p_limit: limit, p_offset: offset }), studentId, limit, true);
}
export async function recordOfficeCreditReceipt(client: SupabaseClient, schoolId: string, input: CreditReceiptInput): Promise<CreditEntry> {
  const amount = positive(input.amount), reference = normalizeCreditReference(input.reference);
  if (!isManualPaymentMethod(input.method)) throw new AdvanceCreditError("Choose a supported office payment method.", "22023");
  const result = entry(await rpc(client, "record_office_credit_receipt", { p_school_id: schoolId, p_student_id: input.studentId, p_amount: amount,
    p_payment_method: input.method, p_reference: reference, p_reason: normalizeCreditReason(input.reason), p_request_id: input.requestId }), schoolId, input.studentId, input.requestId, "receipt", amount);
  if (result.payment_method !== input.method || result.fee_id !== null || result.reference !== reference) throw invalid();
  return result;
}
export async function allocateOfficeCredit(client: SupabaseClient, schoolId: string, input: CreditAllocationInput): Promise<CreditEntry> {
  const amount = positive(input.amount);
  const result = entry(await rpc(client, "allocate_office_credit", { p_school_id: schoolId, p_student_id: input.studentId, p_fee_id: input.feeId,
    p_amount: amount, p_expected_credit_token: input.expectedCreditToken, p_expected_fee_token: input.expectedFeeToken,
    p_reason: normalizeCreditReason(input.reason), p_request_id: input.requestId }), schoolId, input.studentId, input.requestId, "allocation", amount);
  if (result.fee_id !== input.feeId || result.payment_method !== null) throw invalid();
  return result;
}
export async function requestOfficeCreditChange(client: SupabaseClient, schoolId: string, input: CreditChangeInput): Promise<CreditChangeRequest> {
  const amount = input.kind === "receipt_reversal" ? null : positive(input.amount ?? "");
  const reason = normalizeCreditReason(input.reason);
  const result = change(await rpc(client, "request_office_credit_change", { p_school_id: schoolId, p_student_id: input.studentId, p_kind: input.kind,
    p_entry_id: input.entryId, p_amount: amount, p_expected_credit_token: input.expectedCreditToken, p_expected_fee_token: input.expectedFeeToken,
    p_reason: reason, p_request_id: input.requestId }));
  if (result.id !== input.requestId || result.school_id !== schoolId || result.student_id !== input.studentId || result.kind !== input.kind
    || result.entry_target_id !== input.entryId || result.request_reason !== reason || result.financial_token !== input.expectedCreditToken
    || result.fee_token !== input.expectedFeeToken || (amount !== null && result.amount !== amount)) throw invalid();
  return result;
}
export async function reviewOfficeCreditChange(client: SupabaseClient, requestId: string, decision: "approved" | "rejected", reason: string): Promise<CreditChangeRequest> {
  const normalized = normalizeCreditReason(reason);
  const result = change(await rpc(client, "review_office_credit_change", { p_request_id: requestId, p_decision: decision, p_reason: normalized }));
  const recoveredApproval = decision === "approved" && ["approved", "paid", "cancelled"].includes(result.state);
  if (result.id !== requestId || (!recoveredApproval && result.state !== decision) || result.review_reason !== normalized) throw invalid();
  return result;
}
export async function payOfficeCreditRefund(client: SupabaseClient, input: CreditPayoutInput): Promise<CreditChangeRequest> {
  if (!isManualPaymentMethod(input.method)) throw new AdvanceCreditError("Choose a supported office payment method.", "22023");
  const reference = normalizeCreditReference(input.reference);
  const result = change(await rpc(client, "pay_office_credit_refund", { p_request_id: input.requestId, p_payment_method: input.method,
    p_reference: reference, p_reason: normalizeCreditReason(input.reason), p_payout_id: input.payoutId }));
  if (result.id !== input.requestId || result.state !== "paid" || result.kind !== "refund" || result.entry_id !== input.payoutId || result.reference !== reference) throw invalid();
  return result;
}
export async function cancelOfficeCreditRefund(client: SupabaseClient, requestId: string, reason: string): Promise<CreditChangeRequest> {
  const normalized = normalizeCreditReason(reason);
  const result = change(await rpc(client, "cancel_office_credit_refund", { p_request_id: requestId, p_reason: normalized }));
  if (result.id !== requestId || result.state !== "cancelled" || result.cancel_reason !== normalized) throw invalid();
  return result;
}
export async function listOfficeCreditChanges(client: SupabaseClient, schoolId: string, studentId: string | null = null, state: CreditChangeState | "all" = "all", limit = 50, offset = 0): Promise<{ rows: CreditChangeRequest[]; total_count: number }> {
  const result = object(await rpc(client, "list_office_credit_changes", { p_school_id: schoolId, p_student_id: studentId, p_state: state, p_limit: limit, p_offset: offset }));
  if (!Array.isArray(result.rows)) throw invalid();
  const rows = result.rows.map(change), total = count(result.total_count);
  if (rows.length > limit || rows.length > total || new Set(rows.map((item) => item.id)).size !== rows.length
    || rows.some((item) => item.school_id !== schoolId || (studentId && item.student_id !== studentId) || (state !== "all" && item.state !== state))) throw invalid();
  return { rows, total_count: total };
}
