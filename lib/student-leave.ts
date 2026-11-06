import type { SupabaseClient } from "@supabase/supabase-js";

export const studentLeavePageSize = 50;
export const studentLeaveStatuses = ["pending", "approved", "rejected"] as const;
export type StudentLeaveStatus = (typeof studentLeaveStatuses)[number];
export type StudentLeaveDecision = Exclude<StudentLeaveStatus, "pending">;

export type StudentLeaveRequest = {
  id: string;
  school_id: string;
  student_id: string;
  student_name: string;
  admission_no: string;
  academic_year_id: string;
  academic_year_name: string;
  class_name: string;
  section_name: string | null;
  start_date: string;
  end_date: string;
  reason: string;
  status: StudentLeaveStatus;
  requester_id: string;
  requester_name: string | null;
  created_at: string;
  reviewed_by: string | null;
  reviewer_name: string | null;
  review_note: string | null;
  reviewed_at: string | null;
  total_count: number;
};

export type StudentLeaveSubmission = {
  studentId: string;
  startDate: string;
  endDate: string;
  reason: string;
  idempotencyKey: string;
};

export class StudentLeaveError extends Error {
  constructor(message: string, readonly code: string = "") {
    super(message);
    this.name = "StudentLeaveError";
  }
}

const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const nullableText = (value: unknown): value is string | null => value === null || typeof value === "string";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isLeaveDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const time = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(time.valueOf()) && time.toISOString().slice(0, 10) === value;
}

export function validateStudentLeave(startDate: string, endDate: string, reason: string): string | null {
  if (!isLeaveDate(startDate) || !isLeaveDate(endDate) || startDate > endDate) {
    return "Choose valid dates with the end date on or after the start date.";
  }
  if (reason.trim().length < 3 || reason.trim().length > 1000) return "Enter a reason between 3 and 1,000 characters.";
  return null;
}

function parseCount(value: unknown): number | null {
  const count = typeof value === "number" ? value
    : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function readRows(data: unknown, scope: { studentId?: string; schoolId?: string; status?: StudentLeaveStatus | null }, offset: number): StudentLeaveRequest[] {
  if (!Array.isArray(data) || data.length > studentLeavePageSize) throw new StudentLeaveError("Leave records could not be verified. Refresh to try again.");
  const ids = new Set<string>();
  let total: number | null = null;
  return data.map((value: unknown) => {
    const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const count = parseCount(row.total_count);
    const reviewed = row.status !== "pending";
    if (![row.id, row.school_id, row.student_id, row.student_name, row.admission_no, row.academic_year_id,
      row.academic_year_name, row.class_name, row.requester_id, row.reason, row.created_at].every(nonempty)
      || !nullableText(row.section_name) || !nullableText(row.requester_name) || !nullableText(row.reviewer_name)
      || !nullableText(row.reviewed_by) || !nullableText(row.review_note) || !nullableText(row.reviewed_at)
      || !studentLeaveStatuses.includes(row.status as StudentLeaveStatus)
      || !isLeaveDate(row.start_date) || !isLeaveDate(row.end_date) || row.start_date > row.end_date
      || count === null || count < offset + data.length || (total !== null && count !== total)
      || !Number.isFinite(Date.parse(row.created_at as string))
      || (reviewed ? !nonempty(row.reviewed_by) || !nonempty(row.review_note) || !nonempty(row.reviewed_at)
        || !Number.isFinite(Date.parse(row.reviewed_at)) : row.reviewed_by !== null || row.review_note !== null || row.reviewed_at !== null)
      || (scope.studentId && row.student_id !== scope.studentId)
      || (scope.schoolId && row.school_id !== scope.schoolId)
      || (scope.status && row.status !== scope.status)
      || ids.has(row.id as string)) {
      throw new StudentLeaveError("Leave records could not be verified. Refresh to try again.");
    }
    total = count;
    ids.add(row.id as string);
    return { ...row, total_count: count } as StudentLeaveRequest;
  });
}

function checkedOffset(offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new StudentLeaveError("Choose a valid history page.", "22023");
}

function rpcError(error: { code?: string; message?: string } | null, action: "load" | "submit" | "review") {
  if (!error) return;
  const code = error.code ?? "";
  if (["PGRST202", "42883"].includes(code)) throw new StudentLeaveError("Leave requests need the latest school update. Contact your administrator.", code);
  if (code === "42501") throw new StudentLeaveError("Your access to this student or school could not be verified. Refresh your linked students or school access.", code);
  if (["22023", "23505", "PT409", "40001"].includes(code) && error.message) throw new StudentLeaveError(error.message, code);
  throw new StudentLeaveError(action === "submit"
    ? "The submission could not be confirmed. Your dates and reason are kept. Retry the same request or refresh its saved history."
    : action === "review"
      ? "The review could not be confirmed. Your reason is kept. Retry the same decision or refresh the saved status."
      : "Leave history could not be loaded. Refresh to try again.", code);
}

export async function listFamilyStudentLeave(client: SupabaseClient, studentId: string, schoolId: string, offset = 0) {
  checkedOffset(offset);
  const { data, error } = await client.rpc("list_family_student_leave", { p_student_id: studentId, p_offset: offset });
  rpcError(error, "load");
  return readRows(data, { studentId, schoolId }, offset);
}

export async function getFamilyNotificationLeave(client: SupabaseClient, role: "parent" | "student", studentId: string, schoolId: string, requestId: string): Promise<StudentLeaveRequest | null> {
  if (!["parent", "student"].includes(role) || !uuid.test(studentId) || !uuid.test(requestId)) throw new StudentLeaveError("This leave link is invalid.", "22023");
  const { data, error } = await client.rpc("get_family_notification_leave", { p_role: role, p_student_id: studentId, p_request_id: requestId });
  rpcError(error, "load");
  if (data === null) return null;
  const row = readRows([data], { studentId, schoolId }, 0)[0];
  if (row.id !== requestId || row.status === "pending") throw new StudentLeaveError("Leave decision could not be verified. Refresh to try again.");
  return row;
}

export async function listStudentLeaveReview(client: SupabaseClient, schoolId: string, status: StudentLeaveStatus | null = null, offset = 0) {
  checkedOffset(offset);
  if (status !== null && !studentLeaveStatuses.includes(status)) throw new StudentLeaveError("Choose a valid request status.", "22023");
  const { data, error } = await client.rpc("list_student_leave_review", { p_school_id: schoolId, p_status: status, p_offset: offset });
  rpcError(error, "load");
  return readRows(data, { schoolId, status }, offset);
}

export async function submitStudentLeave(client: SupabaseClient, request: StudentLeaveSubmission) {
  const invalid = validateStudentLeave(request.startDate, request.endDate, request.reason);
  if (invalid) throw new StudentLeaveError(invalid, "22023");
  if (!uuid.test(request.idempotencyKey)) throw new StudentLeaveError("The request reference could not be created. Reload and try again.", "22023");
  const { data, error } = await client.rpc("submit_student_leave", {
    p_student_id: request.studentId, p_start_date: request.startDate, p_end_date: request.endDate,
    p_reason: request.reason.trim(), p_idempotency_key: request.idempotencyKey,
  });
  rpcError(error, "submit");
  if (typeof data !== "string" || !uuid.test(data)) throw new StudentLeaveError("The submission could not be confirmed. Retry the same request or refresh its saved history.");
  return data;
}

export async function reviewStudentLeave(client: SupabaseClient, requestId: string, decision: StudentLeaveDecision, reason: string) {
  if (!["approved", "rejected"].includes(decision) || reason.trim().length < 3 || reason.trim().length > 1000) {
    throw new StudentLeaveError("Choose a decision and enter a review reason between 3 and 1,000 characters.", "22023");
  }
  const { data, error } = await client.rpc("review_student_leave", { p_request_id: requestId, p_decision: decision, p_reason: reason.trim() });
  rpcError(error, "review");
  if (data !== requestId) throw new StudentLeaveError("The review could not be confirmed. Retry the same decision or refresh the saved status.");
  return data as string;
}
