import type { SupabaseClient } from "@supabase/supabase-js";
import { boundMfaSession } from "@/lib/auth/staff-mfa";
import { validCalendarDate } from "./calendar";

export type OfficeAttendanceYear = { id: string; name: string; start_date: string; end_date: string; is_current: boolean };
export type OfficeAttendanceContext = {
  user_id: string; school_id: string; school_name: string; schools: { id: string; name: string }[];
  server_today: string; timezone: "Asia/Kolkata"; calendar_revision: number; current_year_id: string | null;
  years: OfficeAttendanceYear[]; classes: { id: string; name: string }[]; sections: { id: string; class_id: string; name: string }[];
};
export type OfficeAttendancePeriod = {
  from: string | null; to: string | null;
  state: "complete" | "enrollment_unverified" | "inconsistent" | "calendar_unconfigured" | "attendance_incomplete" | "no_working_days" | "not_started" | "no_pupils";
  pupil_count: number; complete_pupils: number; incomplete_pupils: number; unverified_pupils: number;
  enrollment_days: number; working_days: number; closed_days: number; unconfigured_days: number;
  marked_days: number; unmarked_days: number; invalid_days: number; earned_days: number; percentage: number | null;
  present_days: number; late_days: number; half_days: number; leave_days: number; absent_days: number;
};
export type OfficeAttendanceReport = {
  user_id: string; school_id: string; school_name: string; server_today: string; timezone: "Asia/Kolkata"; calendar_revision: number;
  formula: "daily-v1"; month: string; year: Omit<OfficeAttendanceYear, "is_current">;
  scope: { class_id: string | null; class_name: string | null; section_id: string | null; section_name: string | null };
  pupil_count: number; month_summary: OfficeAttendancePeriod; year_summary: OfficeAttendancePeriod;
};
export type OfficeAttendanceScope = { schoolId: string; academicYearId: string; month: string | null; classId: string | null; sectionId: string | null };
export class OfficeAttendanceReportError extends Error {
  constructor(message: string, readonly code: "access" | "validation" | "unavailable" = "unavailable") { super(message); this.name = "OfficeAttendanceReportError"; }
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const officeAttendanceUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const label = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value.length <= 2000 && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);
const count = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
const monthStart = (value: unknown): value is string => validCalendarDate(value) && value.endsWith("-01");
const days = (first: string, last: string) => (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86400000 + 1;
const invalid = () => new OfficeAttendanceReportError("The official school attendance report could not be verified. Refresh the report or ask the school office to review setup.");
const dayCounts = ["enrollment_days", "working_days", "closed_days", "unconfigured_days", "marked_days", "unmarked_days", "invalid_days", "present_days", "late_days", "half_days", "leave_days", "absent_days"] as const;
function year(value: unknown, today: string, currentId?: string | null): value is OfficeAttendanceYear {
  const row = object(value);
  return officeAttendanceUuid(row.id) && label(row.name) && row.name.length <= 200 && validCalendarDate(row.start_date) && validCalendarDate(row.end_date)
    && row.start_date <= row.end_date && days(row.start_date, row.end_date) <= 366 && row.start_date <= today
    && (currentId === undefined || typeof row.is_current === "boolean" && (row.is_current ? row.id === currentId : row.end_date < today && row.id !== currentId));
}
export function parseOfficeAttendanceContext(value: unknown, userId: string, schoolId: string | null): OfficeAttendanceContext {
  const row = object(value);
  if (!officeAttendanceUuid(userId) || schoolId !== null && !officeAttendanceUuid(schoolId) || row.user_id !== userId || !officeAttendanceUuid(row.school_id)
    || schoolId !== null && row.school_id !== schoolId || !label(row.school_name) || row.timezone !== "Asia/Kolkata" || !validCalendarDate(row.server_today)
    || !count(row.calendar_revision, 2147483647) || !(row.current_year_id === null || officeAttendanceUuid(row.current_year_id))
    || !Array.isArray(row.schools) || row.schools.length !== 1 || object(row.schools[0]).id !== row.school_id || object(row.schools[0]).name !== row.school_name
    || !Array.isArray(row.years) || row.years.length > 10000 || !Array.isArray(row.classes) || row.classes.length > 10000 || !Array.isArray(row.sections) || row.sections.length > 20000) throw invalid();
  const ids = new Set<string>(); let current = 0;
  for (const item of row.years) {
    if (!year(item, row.server_today, row.current_year_id) || ids.has(item.id)) throw invalid();
    ids.add(item.id); if (item.is_current) current++;
  }
  if (current > 1) throw invalid();
  const classes = new Set<string>();
  for (const item of row.classes) { const option = object(item); if (!officeAttendanceUuid(option.id) || !label(option.name) || classes.has(option.id)) throw invalid(); classes.add(option.id); }
  const sections = new Set<string>();
  for (const item of row.sections) { const option = object(item); if (!officeAttendanceUuid(option.id) || !officeAttendanceUuid(option.class_id) || !classes.has(option.class_id) || !label(option.name) || sections.has(option.id)) throw invalid(); sections.add(option.id); }
  return value as OfficeAttendanceContext;
}
function period(value: unknown, report: OfficeAttendanceReport, month?: string): OfficeAttendancePeriod {
  const row = object(value), result = row as unknown as OfficeAttendancePeriod;
  if (!["complete", "enrollment_unverified", "inconsistent", "calendar_unconfigured", "attendance_incomplete", "no_working_days", "not_started", "no_pupils"].includes(String(row.state))
    || !["pupil_count", "complete_pupils", "incomplete_pupils", "unverified_pupils"].every(key => count(row[key], report.pupil_count))
    || result.complete_pupils + result.incomplete_pupils !== result.pupil_count || result.unverified_pupils > result.incomplete_pupils
    || !dayCounts.every(key => count(row[key], result.pupil_count * 366)) || typeof row.earned_days !== "number" || !Number.isFinite(row.earned_days)
    || row.earned_days < 0 || row.earned_days > result.working_days || result.earned_days !== result.present_days + result.late_days + result.half_days / 2
    || result.enrollment_days !== result.working_days + result.closed_days + result.unconfigured_days
    || result.working_days !== result.marked_days + result.unmarked_days + result.invalid_days
    || result.marked_days !== result.present_days + result.late_days + result.half_days + result.leave_days + result.absent_days) throw invalid();
  if (row.from === null || row.to === null) {
    if (row.from !== null || row.to !== null || dayCounts.some(key => result[key] !== 0) || !["enrollment_unverified", "not_started", "no_pupils"].includes(result.state)) throw invalid();
  } else if (!validCalendarDate(row.from) || !validCalendarDate(row.to) || row.from > row.to || row.from < report.year.start_date || row.to > report.year.end_date || row.to > report.server_today
    || month && (row.from.slice(0, 7) !== month.slice(0, 7) || row.to.slice(0, 7) !== month.slice(0, 7))
    || result.enrollment_days === 0 || result.enrollment_days > result.pupil_count * days(row.from, row.to)) throw invalid();
  const expectedState = report.pupil_count === 0 ? "no_pupils" : result.unverified_pupils ? "enrollment_unverified" : result.invalid_days ? "inconsistent"
    : result.unconfigured_days ? "calendar_unconfigured" : result.unmarked_days ? "attendance_incomplete" : result.working_days ? "complete" : result.enrollment_days ? "no_working_days" : "not_started";
  if (result.state !== expectedState || (result.state === "complete"
    ? result.incomplete_pupils !== 0 || result.percentage !== Math.floor(((result.earned_days * 2) * 10000 + result.working_days) / (2 * result.working_days)) / 100
    : result.percentage !== null)) throw invalid();
  return result;
}
export function parseOfficeAttendanceReport(value: unknown, userId: string, scope: OfficeAttendanceScope): OfficeAttendanceReport {
  const row = object(value), report = row as unknown as OfficeAttendanceReport;
  validateOfficeAttendanceScope(userId, scope);
  if (row.user_id !== userId || row.school_id !== scope.schoolId || !label(row.school_name) || row.timezone !== "Asia/Kolkata" || !validCalendarDate(row.server_today)
    || !count(row.calendar_revision, 2147483647) || row.formula !== "daily-v1" || !monthStart(row.month) || scope.month !== null && row.month !== scope.month
    || !year(row.year, row.server_today) || object(row.year).id !== scope.academicYearId || !count(row.pupil_count, 5000)) throw invalid();
  if (report.month.slice(0, 7) < report.year.start_date.slice(0, 7) || report.month.slice(0, 7) > (report.year.end_date < report.server_today ? report.year.end_date : report.server_today).slice(0, 7)) throw invalid();
  const selected = object(row.scope);
  if (selected.class_id !== scope.classId || selected.section_id !== scope.sectionId
    || (selected.class_id === null ? selected.class_name !== null : !label(selected.class_name))
    || (selected.section_id === null ? selected.section_name !== null : !label(selected.section_name))) throw invalid();
  const monthly = period(row.month_summary, report, report.month), session = period(row.year_summary, report);
  if (dayCounts.some(key => monthly[key] > session[key]) || monthly.earned_days > session.earned_days || monthly.pupil_count > session.pupil_count
    || monthly.from !== null && (session.from === null || session.to === null || monthly.from < session.from || monthly.to! > session.to)) throw invalid();
  return value as OfficeAttendanceReport;
}
export function validateOfficeAttendanceScope(userId: string, scope: OfficeAttendanceScope) {
  if (![userId, scope.schoolId, scope.academicYearId].every(officeAttendanceUuid) || scope.classId !== null && !officeAttendanceUuid(scope.classId)
    || scope.sectionId !== null && (!officeAttendanceUuid(scope.sectionId) || scope.classId === null)) throw new OfficeAttendanceReportError("Choose an authorized school, academic year, class and section.", "validation");
  if (scope.month !== null && !monthStart(scope.month)) throw new OfficeAttendanceReportError("Choose the first day of a valid reporting month.", "validation");
}
async function authorize(client: SupabaseClient, userId: string, signal: AbortSignal) {
  if (!officeAttendanceUuid(userId)) throw new OfficeAttendanceReportError("Sign in again before loading official school attendance.", "access");
  const session = await boundMfaSession(client, userId, signal).catch(() => { signal.throwIfAborted(); throw new OfficeAttendanceReportError("Your sign-in changed. Reopen Reports after signing in.", "access"); });
  signal.throwIfAborted();
  if (!session) throw new OfficeAttendanceReportError("Sign in again before loading official school attendance.", "access");
  return session.access_token;
}
function fail(error: { code?: string } | null) {
  if (!error) return;
  if (["42501", "PGRST301", "PGRST302"].includes(error.code ?? "")) throw new OfficeAttendanceReportError("Only your school's verified Admin or Principal can access this report. Check account security and reopen Reports.", "access");
  if (error.code === "22023") throw new OfficeAttendanceReportError("Choose an available academic year and a reporting month, class and section within this school.", "validation");
  if (error.code === "54000") throw new OfficeAttendanceReportError("This academic year exceeds the supported 5,000-pupil school cohort. Ask the school office to review the reporting scope; no partial report was returned.", "validation");
  throw new OfficeAttendanceReportError("Official school attendance could not be loaded. Refresh the report or contact the school office to review reporting setup.");
}
export async function loadOfficeAttendanceContext(client: SupabaseClient, userId: string, schoolId: string | null, signal: AbortSignal): Promise<OfficeAttendanceContext> {
  if (schoolId !== null && !officeAttendanceUuid(schoolId)) throw new OfficeAttendanceReportError("Choose an authorized school.", "validation");
  const token = await authorize(client, userId, signal);
  const { data, error } = await client.rpc("get_office_attendance_report_context", { p_school_id: schoolId }).setHeader("Authorization", `Bearer ${token}`).abortSignal(signal);
  signal.throwIfAborted(); fail(error); await authorize(client, userId, signal);
  return parseOfficeAttendanceContext(data, userId, schoolId);
}
export async function loadOfficeAttendanceReport(client: SupabaseClient, userId: string, scope: OfficeAttendanceScope, signal: AbortSignal): Promise<OfficeAttendanceReport> {
  validateOfficeAttendanceScope(userId, scope);
  const token = await authorize(client, userId, signal);
  const { data, error } = await client.rpc("get_office_attendance_report", { p_school_id: scope.schoolId, p_academic_year_id: scope.academicYearId, p_month: scope.month, p_class_id: scope.classId, p_section_id: scope.sectionId })
    .setHeader("Authorization", `Bearer ${token}`).abortSignal(signal);
  signal.throwIfAborted(); fail(error); await authorize(client, userId, signal);
  return parseOfficeAttendanceReport(data, userId, scope);
}
