import type { SupabaseClient } from "@supabase/supabase-js";
import { boundMfaSession } from "@/lib/auth/staff-mfa";
import { validCsvCell } from "@/lib/csv";
import { SchoolCalendarError, validCalendarDate } from "./calendar";
import { historicalCalendarCsvMaxRows, type HistoricalCalendarRecord } from "./historical-calendar-csv";

export type HistoricalCalendarYear = { id: string; name: string; start_date: string; end_date: string };
export type HistoricalCalendarReceipt = { request_id: string; academic_year_id: string; revision: number; imported_rows: number; working_rows: number; holiday_rows: number; reason: string; actor_id: string; created_at: string };
export type HistoricalCalendarContext = { user_id: string; school_id: string; server_today: string; timezone: "Asia/Kolkata"; revision: number; can_import: boolean; years: HistoricalCalendarYear[]; history: HistoricalCalendarReceipt[]; history_limit: 10 };
export type HistoricalCalendarPreviewRow = HistoricalCalendarRecord & { row_number: number; issue: string | null; attendance_count: number; present_count: number; absent_count: number; late_count: number; half_day_count: number; leave_count: number; holiday_count: number; pupils_with_marks: number };
export type HistoricalCalendarPreview = Omit<HistoricalCalendarContext, "years" | "history" | "history_limit"> & { academic_year_id: string; preview_token: string; rows: HistoricalCalendarPreviewRow[]; summary: { total_rows: number; valid_rows: number; working_rows: number; holiday_rows: number; attendance_records: number; pupils_with_marks: number } };
export type HistoricalCalendarImportIntent = { schoolId: string; academicYearId: string; rows: HistoricalCalendarRecord[]; expectedRevision: number; previewToken: string; acknowledgeImpact: true; reason: string; requestId: string };
export type HistoricalCalendarImportResult = { revision: number; importedRows: number; workingRows: number; holidayRows: number; replayed: boolean };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
const revision = (value: unknown): value is number => integer(value, 2147483647);
const text = (value: unknown, min: number, max: number): value is string => typeof value === "string" && value.trim().length >= min && validCsvCell(value, max);
const token = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const invalid = () => new SchoolCalendarError("The historical calendar response could not be verified. Reload before importing.");
function base(value: unknown, userId: string, schoolId: string) {
  const row = object(value);
  if (!uuid(userId) || !uuid(schoolId) || row.user_id !== userId || row.school_id !== schoolId || !validCalendarDate(row.server_today)
    || row.timezone !== "Asia/Kolkata" || !revision(row.revision) || typeof row.can_import !== "boolean") throw invalid();
  return row;
}
function validRecords(rows: HistoricalCalendarRecord[]): boolean {
  return Array.isArray(rows) && rows.length > 0 && rows.length <= historicalCalendarCsvMaxRows && rows.every(row => validCalendarDate(row.day)
    && ["working", "holiday"].includes(row.status) && text(row.label, 1, 120)) && new Set(rows.map(row => row.day)).size === rows.length;
}
export function parseHistoricalCalendarContext(value: unknown, userId: string, schoolId: string): HistoricalCalendarContext {
  const row = base(value, userId, schoolId);
  if (row.history_limit !== 10 || !Array.isArray(row.years) || !Array.isArray(row.history) || row.history.length > 10) throw invalid();
  const years = new Set<string>(), requests = new Set<string>(), revisions = new Set<number>();
  for (const value of row.years) {
    const year = object(value);
    if (!uuid(year.id) || years.has(year.id) || !text(year.name, 1, 200) || !validCalendarDate(year.start_date) || !validCalendarDate(year.end_date)
      || year.start_date > year.end_date || Date.parse(year.end_date) - Date.parse(year.start_date) >= 366 * 86400000) throw invalid();
    years.add(year.id);
  }
  for (const value of row.history) {
    const receipt = object(value);
    if (!uuid(receipt.request_id) || requests.has(receipt.request_id) || !uuid(receipt.academic_year_id) || !revision(receipt.revision) || receipt.revision < 1
      || receipt.revision > Number(row.revision) || revisions.has(receipt.revision) || !integer(receipt.imported_rows, 366) || receipt.imported_rows < 1 || !integer(receipt.working_rows, 366)
      || !integer(receipt.holiday_rows, 366) || receipt.imported_rows !== receipt.working_rows + receipt.holiday_rows || !text(receipt.reason, 5, 300)
      || !uuid(receipt.actor_id) || typeof receipt.created_at !== "string" || !receipt.created_at.includes("T") || !Number.isFinite(Date.parse(receipt.created_at))) throw invalid();
    revisions.add(receipt.revision); requests.add(receipt.request_id);
  }
  return value as HistoricalCalendarContext;
}
export function parseHistoricalCalendarPreview(value: unknown, userId: string, schoolId: string, academicYearId: string, submitted: HistoricalCalendarRecord[]): HistoricalCalendarPreview {
  const row = base(value, userId, schoolId), summary = object(row.summary);
  if (!uuid(academicYearId) || row.academic_year_id !== academicYearId || !validRecords(submitted) || !token(row.preview_token)
    || !Array.isArray(row.rows) || row.rows.length !== submitted.length || !integer(summary.total_rows, 366) || summary.total_rows !== submitted.length
    || !integer(summary.valid_rows, 366) || !integer(summary.working_rows, 366) || !integer(summary.holiday_rows, 366)
    || !integer(summary.attendance_records) || !integer(summary.pupils_with_marks)) throw invalid();
  let valid = 0, working = 0, attendance = 0, pupils = 0;
  for (const [index, value] of row.rows.entries()) {
    const entry = object(value), submittedRow = submitted[index];
    if (entry.row_number !== index + 1 || entry.day !== submittedRow.day || entry.status !== submittedRow.status || entry.label !== submittedRow.label
      || !(entry.issue === null || text(entry.issue, 1, 300))) throw invalid();
    const counts = ["attendance_count", "present_count", "absent_count", "late_count", "half_day_count", "leave_count", "holiday_count", "pupils_with_marks"] as const;
    if (!counts.every(key => integer(entry[key])) || Number(entry.attendance_count) !== counts.slice(1, 7).reduce((sum, key) => sum + Number(entry[key]), 0)
      || Number(entry.pupils_with_marks) > Number(entry.attendance_count)) throw invalid();
    if (entry.issue === null) valid++;
    if (entry.status === "working") working++;
    attendance += Number(entry.attendance_count); pupils += Number(entry.pupils_with_marks);
  }
  if (summary.valid_rows !== valid || summary.working_rows !== working || summary.holiday_rows !== submitted.length - working
    || summary.attendance_records !== attendance || Number(summary.pupils_with_marks) > pupils || Number(summary.pupils_with_marks) > attendance
    || row.can_import !== (valid === submitted.length)) throw invalid();
  return value as HistoricalCalendarPreview;
}
function rpcError(error: { code?: string } | null, reading: boolean) {
  if (!error) return;
  if (["42501", "PGRST301", "PGRST302"].includes(error.code ?? "")) throw new SchoolCalendarError("Your import access changed. Reopen settings and complete authenticator verification.", "access");
  if (["PT409", "40001"].includes(error.code ?? "")) throw new SchoolCalendarError("The school calendar changed. Review a fresh server preview before importing; no existing attendance was rewritten.", "conflict");
  if (error.code === "22023") throw new SchoolCalendarError("The import was rejected. Check the year, dated rows, impact acknowledgement and 5–300 character reason.", "validation");
  throw new SchoolCalendarError(reading ? "Historical calendar could not be loaded. Try a fresh server preview." : "The import outcome is unknown. Retry the same frozen import to confirm its result.");
}
async function authorization(client: SupabaseClient, userId: string, signal: AbortSignal) {
  if (!uuid(userId)) throw new SchoolCalendarError("Sign in again to import historical calendar dates.", "access");
  const session = await boundMfaSession(client, userId, signal).catch(() => {
    signal.throwIfAborted(); throw new SchoolCalendarError("Your sign-in changed. Reopen school calendar settings.", "access");
  });
  signal.throwIfAborted();
  if (!session) throw new SchoolCalendarError("Sign in again to import historical calendar dates.", "access");
  return `Bearer ${session.access_token}`;
}
export async function loadHistoricalCalendarContext(client: SupabaseClient, userId: string, schoolId: string, signal: AbortSignal) {
  if (!uuid(schoolId)) throw invalid();
  const header = await authorization(client, userId, signal);
  const { data, error } = await client.rpc("get_historical_attendance_calendar_context", { p_school_id: schoolId }).setHeader("Authorization", header).abortSignal(signal);
  signal.throwIfAborted(); rpcError(error, true);
  await authorization(client, userId, signal);
  return parseHistoricalCalendarContext(data, userId, schoolId);
}
export async function previewHistoricalCalendar(client: SupabaseClient, userId: string, schoolId: string, academicYearId: string, rows: HistoricalCalendarRecord[], signal: AbortSignal) {
  if (!uuid(schoolId) || !uuid(academicYearId) || !validRecords(rows)) throw new SchoolCalendarError("Choose a valid year and fix every CSV row before previewing.", "validation");
  const header = await authorization(client, userId, signal);
  const { data, error } = await client.rpc("preview_historical_attendance_calendar", { p_school_id: schoolId, p_academic_year_id: academicYearId, p_rows: rows }).setHeader("Authorization", header).abortSignal(signal);
  signal.throwIfAborted(); rpcError(error, true); await authorization(client, userId, signal);
  return parseHistoricalCalendarPreview(data, userId, schoolId, academicYearId, rows);
}
export async function importHistoricalCalendar(client: SupabaseClient, userId: string, intent: HistoricalCalendarImportIntent, signal: AbortSignal): Promise<HistoricalCalendarImportResult> {
  if (!uuid(intent.schoolId) || !uuid(intent.academicYearId) || !uuid(intent.requestId) || !validRecords(intent.rows) || !revision(intent.expectedRevision)
    || !token(intent.previewToken) || intent.acknowledgeImpact !== true || !text(intent.reason.trim(), 5, 300)) throw new SchoolCalendarError("Review valid dates, acknowledge the calculation impact and enter a 5–300 character reason.", "validation");
  const header = await authorization(client, userId, signal);
  const { data, error } = await client.rpc("import_historical_attendance_calendar", { p_school_id: intent.schoolId, p_academic_year_id: intent.academicYearId,
    p_rows: intent.rows, p_expected_revision: intent.expectedRevision, p_preview_token: intent.previewToken, p_acknowledge_impact: true,
    p_reason: intent.reason.trim(), p_request_id: intent.requestId }).setHeader("Authorization", header).abortSignal(signal);
  signal.throwIfAborted(); rpcError(error, false); await authorization(client, userId, signal);
  const row = object(data), working = intent.rows.filter(entry => entry.status === "working").length;
  if (row.user_id !== userId || row.school_id !== intent.schoolId || row.academic_year_id !== intent.academicYearId || row.request_id !== intent.requestId
    || row.revision !== intent.expectedRevision + 1 || row.imported_rows !== intent.rows.length || row.working_rows !== working
    || row.holiday_rows !== intent.rows.length - working || typeof row.replayed !== "boolean") throw new SchoolCalendarError("The import acknowledgement could not be verified. Retry the same frozen import.");
  return { revision: Number(row.revision), importedRows: Number(row.imported_rows), workingRows: working, holidayRows: intent.rows.length - working, replayed: row.replayed };
}
