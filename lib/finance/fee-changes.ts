import type { SupabaseClient } from "@supabase/supabase-js";
import { decodeFeeLedger, feeMoney, getOfficeFeeLedger, type FeeLedger, type FeeLedgerRow, type FeeMoney } from "./fee-batches";
import { decodeCreditSummary, type CreditSummary } from "./advance-credit";

export type FeeChangeKind = "reduction" | "additional_charge" | "payment_reversal";
export type FeeChangeState = "pending" | "approved" | "rejected";
export type FeeFinancialState = {
  base_net_amount: FeeMoney;
  adjustment_amount: FeeMoney;
  net_amount: FeeMoney;
  gross_paid_amount: FeeMoney;
  reversed_amount: FeeMoney;
  paid_amount: FeeMoney;
  balance: FeeMoney;
};
export type FeeChange = {
  id: string;
  school_id: string;
  fee_id: string;
  student_id: string;
  admission_no: string;
  student_name: string;
  fee_name: string;
  kind: FeeChangeKind;
  amount: FeeMoney;
  payment_id: string | null;
  receipt_no: string | null;
  request_reason: string;
  requested_by: string;
  requester_name: string;
  requested_at: string;
  state: FeeChangeState;
  before: FeeFinancialState;
  after: FeeFinancialState;
  financial_token: string;
  reviewed_by: string | null;
  reviewer_name: string | null;
  review_reason: string | null;
  reviewed_at: string | null;
  entry_id: string | null;
  reference: string | null;
  effective_day: string | null;
};
export type FeeChangeRequestInput = {
  feeId: string;
  kind: FeeChangeKind;
  amount: string | null;
  paymentId: string | null;
  reason: string;
  expectedToken: string;
  requestId: string;
};
export type FamilyFeeReceipt = {
  id: string;
  student_fee_id: string;
  student_id: string;
  receipt_no: string;
  amount: FeeMoney;
  payment_method: string | null;
  status: string;
  recorded_status: string;
  paid_at: string | null;
  net_amount: FeeMoney | null;
  reversed_amount: FeeMoney;
  reversed_at: string | null;
  reversal_reference: string | null;
};
export type OfficeFeeReceipt = FamilyFeeReceipt & {
  financial_token: string | null;
  legacy_refund: boolean;
};
export type OfficeFinanceSummary = {
  demand_count: number;
  pending_count: number;
  overdue_count: number;
  invalid_count: number;
  net_amount: FeeMoney | null;
  paid_amount: FeeMoney | null;
  balance: FeeMoney | null;
  opening_amount: FeeMoney | null;
  advance?: CreditSummary & { invalid_count: number };
  collections: {
    gross_amount: FeeMoney | null;
    reversal_amount: FeeMoney | null;
    net_amount: FeeMoney | null;
    today_gross: FeeMoney | null;
    today_reversal: FeeMoney | null;
    today_net: FeeMoney | null;
    month_gross: FeeMoney | null;
    month_reversal: FeeMoney | null;
    month_net: FeeMoney | null;
    refund_amount?: FeeMoney | null;
    today_refund?: FeeMoney | null;
    month_refund?: FeeMoney | null;
  };
};

export class FeeChangeError extends Error {
  constructor(message: string, readonly code?: string) { super(message); this.name = "FeeChangeError"; }
}
function invalid(): FeeChangeError { return new FeeChangeError("The financial response could not be confirmed. Refresh the ledger or retry the same unconfirmed request."); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string { if (typeof value !== "string") throw invalid(); return value; }
function identifier(value: unknown): string { const result = text(value); if (!result.trim()) throw invalid(); return result; }
function nullableText(value: unknown): string | null { return value == null ? null : text(value); }
function count(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid(); return value; }
function money(value: unknown): FeeMoney { try { return feeMoney(value); } catch { throw invalid(); } }
function nullableMoney(value: unknown): FeeMoney | null { return value == null ? null : money(value); }
function date(value: unknown): string {
  const result = text(value);
  if (!Number.isFinite(Date.parse(result))) throw invalid();
  return result;
}
function nullableDate(value: unknown): string | null { return value == null ? null : date(value); }

export function normalizeFeeChangeReason(value: string): string {
  const reason = value.trim();
  const length = Array.from(reason).length;
  const containsControl = Array.from(value).some((character) => {
    const code = character.codePointAt(0)!;
    return code < 32 || (code >= 127 && code <= 159);
  });
  if (length < 5 || length > 500 || containsControl) throw new FeeChangeError("Enter a single-line reason of 5 to 500 printable characters.", "22023");
  return reason;
}

function financialState(value: unknown): FeeFinancialState {
  const row = record(value);
  return { base_net_amount: money(row.base_net_amount), adjustment_amount: money(row.adjustment_amount), net_amount: money(row.net_amount),
    gross_paid_amount: money(row.gross_paid_amount), reversed_amount: money(row.reversed_amount), paid_amount: money(row.paid_amount), balance: money(row.balance) };
}
function change(value: unknown): FeeChange {
  const row = record(value);
  if (!["reduction", "additional_charge", "payment_reversal"].includes(String(row.kind))
    || !["pending", "approved", "rejected"].includes(String(row.state))) throw invalid();
  const result: FeeChange = {
    id: identifier(row.id), school_id: identifier(row.school_id), fee_id: identifier(row.fee_id), student_id: identifier(row.student_id),
    admission_no: text(row.admission_no), student_name: text(row.student_name), fee_name: text(row.fee_name), kind: row.kind as FeeChangeKind,
    amount: money(row.amount), payment_id: nullableText(row.payment_id), receipt_no: nullableText(row.receipt_no), request_reason: text(row.request_reason),
    requested_by: identifier(row.requested_by), requester_name: text(row.requester_name), requested_at: date(row.requested_at), state: row.state as FeeChangeState,
    before: financialState(row.before), after: financialState(row.after), financial_token: identifier(row.financial_token),
    reviewed_by: nullableText(row.reviewed_by), reviewer_name: nullableText(row.reviewer_name), review_reason: nullableText(row.review_reason), reviewed_at: nullableDate(row.reviewed_at),
    entry_id: nullableText(row.entry_id), reference: nullableText(row.reference), effective_day: nullableDate(row.effective_day),
  };
  if ((result.kind === "payment_reversal" && (!result.payment_id || !result.receipt_no))
    || (result.state !== "pending" && (!result.reviewed_by || !result.reviewed_at || !result.review_reason))
    || (result.state === "approved" && (!result.entry_id || !result.reference || (result.kind === "payment_reversal" && !result.effective_day)))) throw invalid();
  return result;
}

async function rpc(client: SupabaseClient, name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    const { data, error } = await client.rpc(name, args);
    if (error) {
      const code = typeof error.code === "string" ? error.code : undefined;
      const message = ["PT409", "40001", "22023", "23505", "42501", "55000"].includes(code ?? "")
        ? error.message : "The result could not be confirmed. Retry the same request or decision before creating another one.";
      throw new FeeChangeError(message, code);
    }
    return data;
  } catch (error) {
    if (error instanceof FeeChangeError) throw error;
    throw new FeeChangeError("The result could not be confirmed. Retry the same request or decision before creating another one.");
  }
}

export async function requestFeeChange(client: SupabaseClient, schoolId: string, input: FeeChangeRequestInput): Promise<FeeChange> {
  const reason = normalizeFeeChangeReason(input.reason);
  const result = change(await rpc(client, "request_office_fee_change", {
    p_school_id: schoolId, p_fee_id: input.feeId, p_kind: input.kind, p_amount: input.amount,
    p_payment_id: input.paymentId, p_reason: reason, p_expected_token: input.expectedToken, p_request_id: input.requestId,
  }));
  if (result.id !== input.requestId || result.school_id !== schoolId || result.fee_id !== input.feeId || result.kind !== input.kind || result.payment_id !== input.paymentId
    || result.request_reason !== reason || result.financial_token !== input.expectedToken
    || (input.kind !== "payment_reversal" && result.amount !== money(input.amount))) throw invalid();
  return result;
}

export async function reviewFeeChange(client: SupabaseClient, requestId: string, decision: "approved" | "rejected", reason: string): Promise<FeeChange> {
  const reviewReason = normalizeFeeChangeReason(reason);
  const result = change(await rpc(client, "review_office_fee_change", { p_request_id: requestId, p_decision: decision, p_reason: reviewReason }));
  if (result.id !== requestId || result.state !== decision || result.review_reason !== reviewReason) throw invalid();
  return result;
}

export async function listFeeChanges(client: SupabaseClient, schoolId: string, state: FeeChangeState | "all" = "all", limit = 50, offset = 0): Promise<{ rows: FeeChange[]; total_count: number }> {
  const result = record(await rpc(client, "list_office_fee_changes", { p_school_id: schoolId, p_state: state, p_limit: limit, p_offset: offset }));
  if (!Array.isArray(result.rows)) throw invalid();
  const rows = result.rows.map(change), total = count(result.total_count);
  if (rows.length > limit || rows.length > total || rows.some((row) => row.school_id !== schoolId || (state !== "all" && row.state !== state))) throw invalid();
  return { rows, total_count: total };
}

function receipt(value: unknown): FamilyFeeReceipt {
  const row = record(value);
  return {
    id: identifier(row.id), student_fee_id: identifier(row.student_fee_id), student_id: identifier(row.student_id), receipt_no: identifier(row.receipt_no),
    amount: money(row.amount), payment_method: nullableText(row.payment_method), status: text(row.status), recorded_status: text(row.recorded_status), paid_at: nullableDate(row.paid_at),
    net_amount: nullableMoney(row.net_amount), reversed_amount: money(row.reversed_amount), reversed_at: nullableDate(row.reversed_at), reversal_reference: nullableText(row.reversal_reference),
  };
}

export async function listOfficeFeeReceipts(client: SupabaseClient, schoolId: string, studentId: string | null = null, limit = 200, offset = 0): Promise<{ rows: OfficeFeeReceipt[]; count: number }> {
  const result = record(await rpc(client, "list_office_fee_receipts", { p_school_id: schoolId, p_student_id: studentId, p_limit: limit, p_offset: offset }));
  if (!Array.isArray(result.rows)) throw invalid();
  const rows = result.rows.map((value): OfficeFeeReceipt => {
    const row = record(value);
    if (typeof row.legacy_refund !== "boolean") throw invalid();
    return { ...receipt(value), financial_token: nullableText(row.financial_token), legacy_refund: row.legacy_refund };
  });
  const total = count(result.count);
  if (rows.length > limit || rows.length > total || rows.some((row) => studentId && row.student_id !== studentId)) throw invalid();
  return { rows, count: total };
}

export async function listFamilyFeeReceipts(client: SupabaseClient, studentId: string, limit = 30, offset = 0): Promise<{ rows: FamilyFeeReceipt[]; count: number }> {
  const result = record(await rpc(client, "list_family_fee_receipts", { p_student_id: studentId, p_limit: limit, p_offset: offset }));
  if (!Array.isArray(result.rows)) throw invalid();
  if (result.rows.some((value) => {
    const row = record(value);
    return ["financial_token", "request_reason", "review_reason", "requester_name", "reviewer_name"].some((key) => key in row);
  })) throw invalid();
  const rows = result.rows.map(receipt), total = count(result.count);
  if (rows.length > limit || rows.length > total || rows.some((row) => row.student_id !== studentId)) throw invalid();
  return { rows, count: total };
}

export async function getFamilyFeeLedger(client: SupabaseClient, studentId: string, limit = 30, offset = 0): Promise<FeeLedger> {
  const value = await rpc(client, "get_family_fee_ledger", { p_student_id: studentId, p_limit: limit, p_offset: offset });
  const result = record(value);
  if (!Array.isArray(result.rows) || result.rows.some((value) => {
    const row = record(value);
    return ["financial_token", "request_reason", "review_reason", "reason", "source_reference"].some((key) => key in row);
  })) throw invalid();
  try { return decodeFeeLedger(result, null, studentId, limit); } catch { throw invalid(); }
}

export async function getOfficeFinanceSummary(client: SupabaseClient, schoolId: string): Promise<OfficeFinanceSummary> {
  const row = record(await rpc(client, "get_office_finance_summary", { p_school_id: schoolId })), collections = record(row.collections);
  return {
    demand_count: count(row.demand_count), pending_count: count(row.pending_count), overdue_count: count(row.overdue_count), invalid_count: count(row.invalid_count),
    net_amount: nullableMoney(row.net_amount), paid_amount: nullableMoney(row.paid_amount), balance: nullableMoney(row.balance), opening_amount: nullableMoney(row.opening_amount),
    ...(row.advance === undefined ? {} : { advance: { ...decodeCreditSummary(row.advance), invalid_count: count(record(row.advance).invalid_count) } }),
    collections: { gross_amount: nullableMoney(collections.gross_amount), reversal_amount: nullableMoney(collections.reversal_amount), net_amount: nullableMoney(collections.net_amount),
      today_gross: nullableMoney(collections.today_gross), today_reversal: nullableMoney(collections.today_reversal), today_net: nullableMoney(collections.today_net),
      month_gross: nullableMoney(collections.month_gross), month_reversal: nullableMoney(collections.month_reversal), month_net: nullableMoney(collections.month_net),
      ...(collections.refund_amount === undefined ? {} : { refund_amount: nullableMoney(collections.refund_amount), today_refund: nullableMoney(collections.today_refund), month_refund: nullableMoney(collections.month_refund) }) },
  };
}

/** Full-scope office screens use bounded parallel pages, never a silently capped first page. */
async function allPages<T>(read: (offset: number) => Promise<{ rows: T[]; count: number }>, identity: (row: T) => string): Promise<T[]> {
  const size = 200, first = await read(0), total = first.count;
  if (total > 1000000 || first.rows.length !== Math.min(size, total)) throw invalid();
  const pages: T[][] = [first.rows];
  let next = 1;
  const pageCount = Math.ceil(total / size);
  await Promise.all(Array.from({ length: Math.min(4, Math.max(0, pageCount - 1)) }, async () => {
    while (next < pageCount) {
      const index = next++;
      const page = await read(index * size);
      if (page.count !== total || page.rows.length !== Math.min(size, total - index * size)) {
        throw new FeeChangeError("Financial records changed while loading. Refresh to read the complete ledger again.", "PT409");
      }
      pages[index] = page.rows;
    }
  }));
  const rows = pages.flat();
  if (rows.length !== total || new Set(rows.map(identity)).size !== total) throw invalid();
  return rows;
}

export async function loadOfficeFeePositions(client: SupabaseClient, schoolId: string): Promise<FeeLedgerRow[]> {
  return allPages(async (offset) => {
    const result = await getOfficeFeeLedger(client, schoolId, null, null, 200, offset);
    if (result.rows.some((row) => !row.invalid && (!row.financial_token || row.net_amount === null || row.paid_amount === null || row.balance === null))) throw invalid();
    return { rows: result.rows, count: result.summary.demand_count };
  }, (row) => row.demand_id);
}

export async function loadOfficeFeeReceipts(client: SupabaseClient, schoolId: string): Promise<OfficeFeeReceipt[]> {
  return allPages((offset) => listOfficeFeeReceipts(client, schoolId, null, 200, offset), (row) => row.id);
}
