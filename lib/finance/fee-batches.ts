import type { SupabaseClient } from "@supabase/supabase-js";
import { readCsvRows, validCsvCell } from "@/lib/csv";
import { normalizeMoney, formatMoney, type Money } from "./money";

export type FeeMoney = Money;
export type FeeBatchKind = "monthly" | "opening";
export type MonthlyFeeBatchPayload = {
  academic_year_id: string;
  fee_structure_id: string;
  billing_period: string;
  due_date: string | null;
  class_id: string | null;
  section_id: string | null;
};
export type OpeningBalanceRow = { admission_no: string; amount: string };
export type OpeningFeeBatchPayload = {
  academic_year_id: string;
  as_of_date: string;
  source_reference: string;
  reason: string;
  rows: OpeningBalanceRow[];
};
export type FeeBatchPayload = MonthlyFeeBatchPayload | OpeningFeeBatchPayload;
export type FeeBatchPreviewRow = {
  row_number: number;
  student_id: string | null;
  admission_no: string;
  student_name: string;
  class_name: string;
  section_name: string;
  amount: FeeMoney | null;
  status: "ready" | "existing" | "error";
  message: string;
  demand_id: string | null;
};
export type FeeBatchPreview = {
  kind: FeeBatchKind;
  academic_year_id: string;
  preview_token: string;
  rows: FeeBatchPreviewRow[];
  summary: {
    ready_count: number;
    existing_count: number;
    error_count: number;
    ready_amount: FeeMoney;
    existing_amount: FeeMoney;
    total_amount: FeeMoney;
  };
  can_post: boolean;
};
export type FeeBatchReceipt = {
  batch_id: string;
  kind: FeeBatchKind;
  academic_year_id: string;
  posted_at: string;
  posted_by_name: string;
  created_count: number;
  existing_count: number;
  total_amount: FeeMoney;
  source_reference: string | null;
  reason: string | null;
  billing_period?: string | null;
};
export type FeeLedgerRow = {
  demand_id: string;
  student_id: string;
  admission_no: string;
  student_name: string;
  academic_year_id: string | null;
  academic_year_name: string;
  fee_name: string;
  kind: string;
  billing_period: string | null;
  due_date: string | null;
  amount: FeeMoney | null;
  discount: FeeMoney | null;
  late_fee: FeeMoney | null;
  net_amount: FeeMoney | null;
  paid_amount: FeeMoney | null;
  balance: FeeMoney | null;
  status: string;
  as_of_date?: string | null;
  source_reference?: string | null;
  reason?: string | null;
  invalid?: boolean;
  fee_structure_id?: string | null;
  financial_token?: string | null;
  base_net_amount?: FeeMoney | null;
  adjustment_amount?: FeeMoney | null;
  gross_paid_amount?: FeeMoney | null;
  reversed_amount?: FeeMoney | null;
  advance_applied_amount?: FeeMoney | null;
};
export type FeeLedger = {
  academic_year_id: string | null;
  rows: FeeLedgerRow[];
  summary: {
    demand_count: number;
    net_amount: FeeMoney | null;
    paid_amount: FeeMoney | null;
    balance: FeeMoney | null;
    opening_amount: FeeMoney | null;
    invalid_count: number;
  };
};

export class FeeBatchError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "FeeBatchError";
  }
}

const invalidResponse = () => new FeeBatchError("The server response could not be confirmed. Refresh to check saved records, or retry the same pending batch.");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw invalidResponse();
  return value;
}
function id(value: unknown): string {
  const result = text(value);
  if (!result.trim()) throw invalidResponse();
  return result;
}
function nullableText(value: unknown): string | null {
  return value == null ? null : text(value);
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalidResponse();
  return value;
}
function kind(value: unknown): FeeBatchKind {
  if (value !== "monthly" && value !== "opening") throw invalidResponse();
  return value;
}

/** Keep provider numeric values decimal-safe. Never add monetary JS floats. */
export function feeMoney(value: unknown): FeeMoney {
  try { return normalizeMoney(value); } catch { throw invalidResponse(); }
}
const nullableMoney = (value: unknown) => value == null ? null : feeMoney(value);

export function formatFeeMoney(value: FeeMoney | number): string {
  return formatMoney(feeMoney(value));
}

export function formatFeeBillingPeriod(period: string | null): string {
  if (period && /^OPENING:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(period)) return "Opening balance";
  return period || "—";
}

function preview(value: unknown): FeeBatchPreview {
  const record = object(value), summary = object(record.summary);
  if (!Array.isArray(record.rows) || typeof record.can_post !== "boolean") throw invalidResponse();
  const rows = record.rows.map((value) => {
    const row = object(value);
    if (!["ready", "existing", "error"].includes(String(row.status))) throw invalidResponse();
    return {
      row_number: count(row.row_number), student_id: nullableText(row.student_id), admission_no: text(row.admission_no),
      student_name: nullableText(row.student_name) || "Unmatched pupil", class_name: nullableText(row.class_name) ?? "", section_name: nullableText(row.section_name) ?? "",
      amount: nullableMoney(row.amount), status: row.status as FeeBatchPreviewRow["status"],
      message: text(row.message), demand_id: nullableText(row.demand_id),
    };
  });
  const counts = { ready_count: count(summary.ready_count), existing_count: count(summary.existing_count), error_count: count(summary.error_count) };
  if (rows.length !== counts.ready_count + counts.existing_count + counts.error_count
    || rows.filter((row) => row.status === "ready").length !== counts.ready_count
    || rows.filter((row) => row.status === "existing").length !== counts.existing_count
    || rows.some((row) => row.status !== "error" && (!row.student_id || row.amount === null))
    || (record.can_post && (counts.error_count > 0 || rows.length === 0))) throw invalidResponse();
  return {
    kind: kind(record.kind), academic_year_id: id(record.academic_year_id), preview_token: id(record.preview_token), rows,
    summary: { ...counts, ready_amount: feeMoney(summary.ready_amount), existing_amount: feeMoney(summary.existing_amount), total_amount: feeMoney(summary.total_amount) },
    can_post: record.can_post,
  };
}

function receipt(value: unknown): FeeBatchReceipt {
  const record = object(value);
  const postedAt = text(record.posted_at);
  if (!Number.isFinite(Date.parse(postedAt))) throw invalidResponse();
  return {
    batch_id: id(record.batch_id), kind: kind(record.kind), academic_year_id: id(record.academic_year_id), posted_at: postedAt,
    posted_by_name: text(record.posted_by_name), created_count: count(record.created_count), existing_count: count(record.existing_count),
    total_amount: feeMoney(record.total_amount), source_reference: nullableText(record.source_reference), reason: nullableText(record.reason), billing_period: nullableText(record.billing_period),
  };
}

async function rpc(client: SupabaseClient, name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    const { data, error } = await client.rpc(name, args);
    if (error) {
      const code = typeof error.code === "string" ? error.code : undefined;
      const message = ["PT409", "22023", "23505", "42501"].includes(code ?? "")
        ? error.message : "The result could not be confirmed. Retry the same pending batch or refresh saved records.";
      throw new FeeBatchError(message, code);
    }
    return data;
  } catch (error) {
    if (error instanceof FeeBatchError) throw error;
    throw new FeeBatchError("The result could not be confirmed. Retry the same pending batch or refresh saved records.");
  }
}

export async function previewFeeBatch(client: SupabaseClient, schoolId: string, batchKind: FeeBatchKind, payload: FeeBatchPayload): Promise<FeeBatchPreview> {
  const result = preview(await rpc(client, "preview_office_fee_batch", { p_school_id: schoolId, p_kind: batchKind, p_payload: payload }));
  if (result.kind !== batchKind || result.academic_year_id !== payload.academic_year_id) throw invalidResponse();
  return result;
}

export async function postFeeBatch(client: SupabaseClient, schoolId: string, batchKind: FeeBatchKind, payload: FeeBatchPayload, previewToken: string, requestId: string): Promise<FeeBatchReceipt> {
  const result = receipt(await rpc(client, "post_office_fee_batch", {
    p_school_id: schoolId, p_kind: batchKind, p_payload: payload, p_preview_token: previewToken, p_request_id: requestId,
  }));
  if (result.kind !== batchKind || result.academic_year_id !== payload.academic_year_id) throw invalidResponse();
  return result;
}

export async function listFeeBatches(client: SupabaseClient, schoolId: string, limit = 20, offset = 0): Promise<FeeBatchReceipt[]> {
  const result = await rpc(client, "list_office_fee_batches", { p_school_id: schoolId, p_limit: limit, p_offset: offset });
  if (!Array.isArray(result)) throw invalidResponse();
  return result.map(receipt);
}

export async function getOfficeFeeLedger(client: SupabaseClient, schoolId: string, yearId: string | null = null, studentId: string | null = null, limit = 50, offset = 0): Promise<FeeLedger> {
  return decodeFeeLedger(await rpc(client, "get_office_fee_ledger", {
    p_school_id: schoolId, p_year_id: yearId, p_student_id: studentId, p_limit: limit, p_offset: offset,
  }), yearId, studentId, limit);
}

export function decodeFeeLedger(value: unknown, yearId: string | null, studentId: string | null, limit: number): FeeLedger {
  const result = object(value);
  if (!Array.isArray(result.rows)) throw invalidResponse();
  const summary = object(result.summary);
  const rows: FeeLedgerRow[] = result.rows.map((value) => {
    const row = object(value);
    return {
      demand_id: id(row.demand_id), student_id: id(row.student_id), admission_no: nullableText(row.admission_no) ?? "Unmapped pupil", student_name: nullableText(row.student_name) || "Unmapped pupil",
      academic_year_id: nullableText(row.academic_year_id), academic_year_name: nullableText(row.academic_year_name) ?? "", fee_name: text(row.fee_name), kind: text(row.kind),
      billing_period: nullableText(row.billing_period), due_date: nullableText(row.due_date), amount: nullableMoney(row.amount),
      discount: nullableMoney(row.discount), late_fee: nullableMoney(row.late_fee), net_amount: nullableMoney(row.net_amount),
      paid_amount: nullableMoney(row.paid_amount), balance: nullableMoney(row.balance), status: text(row.status),
      as_of_date: nullableText(row.as_of_date), source_reference: nullableText(row.source_reference), reason: nullableText(row.reason), invalid: row.invalid === true,
      fee_structure_id: nullableText(row.fee_structure_id), financial_token: nullableText(row.financial_token),
      base_net_amount: nullableMoney(row.base_net_amount), adjustment_amount: nullableMoney(row.adjustment_amount),
      gross_paid_amount: nullableMoney(row.gross_paid_amount), reversed_amount: nullableMoney(row.reversed_amount),
      ...(row.advance_applied_amount === undefined ? {} : { advance_applied_amount: nullableMoney(row.advance_applied_amount) }),
    };
  });
  const resolvedYear = nullableText(result.academic_year_id);
  const invalidCount = count(summary.invalid_count);
  if (resolvedYear !== yearId || rows.length > limit || rows.some((row) => (yearId && row.academic_year_id !== yearId
    && !(row.academic_year_id === null && invalidCount > 0)) || (studentId && row.student_id !== studentId))) throw invalidResponse();
  return {
    academic_year_id: resolvedYear, rows,
    summary: { demand_count: count(summary.demand_count), net_amount: nullableMoney(summary.net_amount), paid_amount: nullableMoney(summary.paid_amount),
      balance: nullableMoney(summary.balance), opening_amount: nullableMoney(summary.opening_amount), invalid_count: invalidCount },
  };
}

export const maxOpeningBalanceRows = 1500;
export const maxOpeningBalanceCsvBytes = 256 * 1024;
export const openingBalanceCsvTemplate = "admission_no,amount\nEXAMPLE-001,1500.00\n";

export function parseOpeningBalanceCsv(csv: string): OpeningBalanceRow[] {
  if (new TextEncoder().encode(csv).byteLength > maxOpeningBalanceCsvBytes) throw new Error("Choose a CSV file that is 256 KB or smaller.");
  const [header, ...rows] = readCsvRows(csv);
  if (header?.length !== 2 || header.map((cell) => cell.trim().toLowerCase()).join(",") !== "admission_no,amount") {
    throw new Error("Use the template columns in this order: admission_no, amount.");
  }
  if (!rows.length || rows.length > maxOpeningBalanceRows) throw new Error(`Include between 1 and ${maxOpeningBalanceRows} opening balance rows.`);
  return rows.map((row, index) => {
    if (row.length !== 2) throw new Error(`CSV row ${index + 2} needs exactly two columns: admission_no, amount.`);
    const [admission, amount] = row.map((cell) => cell.trim());
    if (!validCsvCell(admission, 64) || !validCsvCell(amount, 64)) throw new Error(`CSV row ${index + 2} contains an invalid field length or line break.`);
    // Amount and duplicate admission validation belong to the authoritative server preview.
    return { admission_no: admission, amount };
  });
}
