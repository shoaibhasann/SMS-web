import type { SupabaseClient } from "@supabase/supabase-js";
import { boundMfaSession } from "@/lib/auth/staff-mfa";
import { validCalendarDate } from "./calendar";

export type FamilyAttendanceSummaryRole = "student" | "parent";
export type AttendanceSummaryState = "complete" | "calendar_unconfigured" | "attendance_incomplete" | "enrollment_unverified"
  | "inconsistent" | "no_working_days" | "not_enrolled" | "not_started";
export type AttendanceSummaryPeriod = {
  from: string | null; to: string | null; state: AttendanceSummaryState;
  enrollment_days: number; working_days: number; closed_days: number; unconfigured_days: number;
  marked_days: number; unmarked_days: number; invalid_days: number; earned_days: number; percentage: number | null;
  present_days: number; late_days: number; half_days: number; leave_days: number; absent_days: number;
};
export type FamilyAttendanceSummary = {
  user_id: string; student_id: string; school_id: string; role: FamilyAttendanceSummaryRole;
  server_today: string; timezone: "Asia/Kolkata"; month: string; calendar_revision: number; formula: "daily-v1";
  year: { id: string; name: string; start_date: string; end_date: string } | null;
  session_state: "active" | "missing" | "ambiguous" | "unsupported";
  month_summary: AttendanceSummaryPeriod | null; year_summary: AttendanceSummaryPeriod | null;
};
export class FamilyAttendanceSummaryError extends Error {
  constructor(message: string, readonly code: "access" | "validation" | "unavailable" = "unavailable") {
    super(message); this.name = "FamilyAttendanceSummaryError";
  }
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const count = (value: unknown, max = 366): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
const monthStart = (value: unknown): value is string => validCalendarDate(value) && value.endsWith("-01");
const days = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
const invalid = () => new FamilyAttendanceSummaryError("The official attendance summary could not be verified. Refresh to check the school records.");
const counts = ["enrollment_days", "working_days", "closed_days", "unconfigured_days", "marked_days", "unmarked_days", "invalid_days",
  "present_days", "late_days", "half_days", "leave_days", "absent_days"] as const;
function period(value: unknown, year: NonNullable<FamilyAttendanceSummary["year"]>, today: string, month?: string): AttendanceSummaryPeriod {
  const row = object(value);
  if (!counts.every(key => count(row[key])) || typeof row.earned_days !== "number" || !Number.isFinite(row.earned_days)
    || row.earned_days < 0 || row.earned_days > 366 || !["complete", "calendar_unconfigured", "attendance_incomplete", "enrollment_unverified", "inconsistent", "no_working_days", "not_enrolled", "not_started"].includes(String(row.state))) throw invalid();
  const result = row as unknown as AttendanceSummaryPeriod;
  if (result.enrollment_days !== result.working_days + result.closed_days + result.unconfigured_days
    || result.working_days !== result.marked_days + result.unmarked_days + result.invalid_days
    || result.marked_days !== result.present_days + result.late_days + result.half_days + result.leave_days + result.absent_days
    || result.earned_days !== result.present_days + result.late_days + result.half_days / 2) throw invalid();
  if (row.from === null || row.to === null) {
    if (row.from !== null || row.to !== null || !["enrollment_unverified", "not_enrolled", "not_started"].includes(result.state)
      || counts.some(key => result[key] !== 0) || result.earned_days !== 0 || result.percentage !== null) throw invalid();
    return result;
  }
  if (!validCalendarDate(row.from) || !validCalendarDate(row.to) || row.from > row.to || row.from < year.start_date || row.to > year.end_date
    || row.to > today || result.enrollment_days !== days(row.from, row.to) || month && (row.from.slice(0, 7) !== month.slice(0, 7) || row.to.slice(0, 7) !== month.slice(0, 7))) throw invalid();
  const expectedState = result.invalid_days ? "inconsistent" : result.unconfigured_days ? "calendar_unconfigured"
    : result.unmarked_days ? "attendance_incomplete" : result.working_days ? "complete" : "no_working_days";
  if (result.state !== expectedState || (result.state === "complete"
    ? result.percentage !== Math.round(result.earned_days / result.working_days * 10000) / 100
    : result.percentage !== null)) throw invalid();
  return result;
}
export function parseFamilyAttendanceSummary(value: unknown, userId: string, student: { id: string; school_id: string }, role: FamilyAttendanceSummaryRole, month: string | null): FamilyAttendanceSummary {
  const row = object(value);
  if (!uuid(userId) || !uuid(student.id) || !uuid(student.school_id) || row.user_id !== userId || row.student_id !== student.id || row.school_id !== student.school_id || row.role !== role
    || row.timezone !== "Asia/Kolkata" || !validCalendarDate(row.server_today) || !monthStart(row.month) || month !== null && row.month !== month
    || !count(row.calendar_revision, 2147483647) || row.formula !== "daily-v1" || !["active", "missing", "ambiguous", "unsupported"].includes(String(row.session_state))) throw invalid();
  const year = object(row.year);
  if (row.session_state === "missing" || row.session_state === "ambiguous") {
    if (row.year !== null || row.month_summary !== null || row.year_summary !== null) throw invalid();
  } else if (row.session_state === "unsupported" && row.year === null) {
    if (row.month_summary !== null || row.year_summary !== null) throw invalid();
  } else {
    if (!uuid(year.id) || typeof year.name !== "string" || !year.name.trim() || year.name.length > 200 || /[\u0000-\u001f\u007f]/.test(year.name)
      || !validCalendarDate(year.start_date) || !validCalendarDate(year.end_date) || year.start_date > year.end_date) throw invalid();
    if (row.session_state === "unsupported") {
      if (days(year.start_date, year.end_date) <= 366 || row.month_summary !== null || row.year_summary !== null) throw invalid();
    } else {
      if (days(year.start_date, year.end_date) > 366 || row.month.slice(0, 7) < year.start_date.slice(0, 7) || row.month.slice(0, 7) > year.end_date.slice(0, 7)) throw invalid();
      const monthly = period(row.month_summary, year as NonNullable<FamilyAttendanceSummary["year"]>, row.server_today, row.month);
      const session = period(row.year_summary, year as NonNullable<FamilyAttendanceSummary["year"]>, row.server_today);
      if (counts.some(key => monthly[key] > session[key]) || monthly.earned_days > session.earned_days
        || monthly.from !== null && (session.from === null || session.to === null || monthly.from < session.from || monthly.to! > session.to)) throw invalid();
    }
  }
  return value as FamilyAttendanceSummary;
}
export async function loadFamilyAttendanceSummary(client: SupabaseClient, userId: string, student: { id: string; school_id: string }, role: FamilyAttendanceSummaryRole, month: string | null, signal: AbortSignal) {
  if (!uuid(userId) || !uuid(student.id) || !uuid(student.school_id) || !["student", "parent"].includes(role)) throw new FamilyAttendanceSummaryError("Sign in again before loading attendance.", "access");
  if (month !== null && !monthStart(month)) throw new FamilyAttendanceSummaryError("Choose a valid reporting month.", "validation");
  const authorize = async () => {
    const session = await boundMfaSession(client, userId, signal).catch(() => { signal.throwIfAborted(); throw new FamilyAttendanceSummaryError("Your sign-in changed. Reopen your dashboard.", "access"); });
    if (!session) throw new FamilyAttendanceSummaryError("Sign in again to load official attendance.", "access");
    signal.throwIfAborted(); return session.access_token;
  };
  const token = await authorize();
  const { data, error } = await client.rpc("get_family_attendance_summary", { p_role: role, p_student_id: student.id, p_month: month })
    .setHeader("Authorization", `Bearer ${token}`).abortSignal(signal);
  signal.throwIfAborted();
  if (error) throw new FamilyAttendanceSummaryError(error.code === "22023" ? "Choose a month within the current academic session."
    : ["42501", "PGRST301", "PGRST302"].includes(error.code) ? "Your attendance access changed. Reopen your dashboard after signing in."
      : "Official attendance could not be loaded. Refresh to try again.", error.code === "22023" ? "validation" : ["42501", "PGRST301", "PGRST302"].includes(error.code) ? "access" : "unavailable");
  await authorize();
  return parseFamilyAttendanceSummary(data, userId, student, role, month);
}

export type FamilyAttendanceReportYear = NonNullable<FamilyAttendanceSummary["year"]> & { is_current: boolean };
export type FamilyAttendanceReportContext = {
  user_id: string; student_id: string; school_id: string; role: FamilyAttendanceSummaryRole;
  server_today: string; timezone: "Asia/Kolkata"; current_year_id: string | null;
  current_session_state: FamilyAttendanceSummary["session_state"]; years: FamilyAttendanceReportYear[];
};
export function parseFamilyAttendanceReportContext(value: unknown, userId: string, student: { id: string; school_id: string }, role: FamilyAttendanceSummaryRole): FamilyAttendanceReportContext {
  const row = object(value);
  if (!uuid(userId) || !uuid(student.id) || !uuid(student.school_id) || row.user_id !== userId || row.student_id !== student.id || row.school_id !== student.school_id
    || !["student", "parent"].includes(role) || row.role !== role || row.timezone !== "Asia/Kolkata" || !validCalendarDate(row.server_today)
    || !["active", "missing", "ambiguous", "unsupported"].includes(String(row.current_session_state)) || !Array.isArray(row.years)
    || !(row.current_year_id === null || uuid(row.current_year_id))) throw invalid();
  const ids = new Set<string>(); let current = 0;
  for (const value of row.years) {
    const year = object(value);
    if (!uuid(year.id) || ids.has(year.id) || typeof year.name !== "string" || !year.name.trim() || year.name.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(year.name)
      || !validCalendarDate(year.start_date) || !validCalendarDate(year.end_date) || year.start_date > year.end_date || days(year.start_date, year.end_date) > 366
      || typeof year.is_current !== "boolean" || (year.is_current ? year.start_date > row.server_today || year.id !== row.current_year_id : year.end_date >= row.server_today || year.id === row.current_year_id)) throw invalid();
    ids.add(year.id); if (year.is_current) current++;
  }
  if (["missing", "ambiguous"].includes(String(row.current_session_state)) ? row.current_year_id !== null || current !== 0
    : !uuid(row.current_year_id) || current > 1 || row.current_session_state === "unsupported" && current !== 0) throw invalid();
  return value as FamilyAttendanceReportContext;
}
async function reportAuthorization(client: SupabaseClient, userId: string, student: { id: string; school_id: string }, role: FamilyAttendanceSummaryRole, signal: AbortSignal) {
  if (!uuid(userId) || !uuid(student.id) || !uuid(student.school_id) || !["student", "parent"].includes(role)) throw new FamilyAttendanceSummaryError("Sign in again before loading attendance.", "access");
  const session = await boundMfaSession(client, userId, signal).catch(() => { signal.throwIfAborted(); throw new FamilyAttendanceSummaryError("Your sign-in changed. Reopen your dashboard.", "access"); });
  signal.throwIfAborted();
  if (!session) throw new FamilyAttendanceSummaryError("Sign in again to load official attendance.", "access");
  return session.access_token;
}
function reportError(error: { code?: string } | null) {
  if (!error) return;
  if (["42501", "PGRST301", "PGRST302"].includes(error.code ?? "")) throw new FamilyAttendanceSummaryError("Your attendance report access changed. Reopen attendance after signing in.", "access");
  if (error.code === "22023") throw new FamilyAttendanceSummaryError("Choose a supported academic year and a reporting month within that year.", "validation");
  throw new FamilyAttendanceSummaryError("Official attendance reports could not be loaded. Refresh to try again.");
}
export async function loadFamilyAttendanceReportContext(client: SupabaseClient, userId: string, student: { id: string; school_id: string }, role: FamilyAttendanceSummaryRole, signal: AbortSignal) {
  const token = await reportAuthorization(client, userId, student, role, signal);
  const { data, error } = await client.rpc("get_family_attendance_report_context", { p_role: role, p_student_id: student.id })
    .setHeader("Authorization", `Bearer ${token}`).abortSignal(signal);
  signal.throwIfAborted(); reportError(error); await reportAuthorization(client, userId, student, role, signal);
  return parseFamilyAttendanceReportContext(data, userId, student, role);
}
export async function loadFamilyAttendanceReport(client: SupabaseClient, userId: string, student: { id: string; school_id: string }, role: FamilyAttendanceSummaryRole, academicYearId: string | null, month: string | null, signal: AbortSignal) {
  if (academicYearId !== null && !uuid(academicYearId) || month !== null && !monthStart(month)) throw new FamilyAttendanceSummaryError("Choose a supported academic year and reporting month.", "validation");
  const token = await reportAuthorization(client, userId, student, role, signal);
  const { data, error } = await client.rpc("get_family_attendance_report", { p_role: role, p_student_id: student.id, p_academic_year_id: academicYearId, p_month: month })
    .setHeader("Authorization", `Bearer ${token}`).abortSignal(signal);
  signal.throwIfAborted(); reportError(error); await reportAuthorization(client, userId, student, role, signal);
  const summary = parseFamilyAttendanceSummary(data, userId, student, role, month);
  if (academicYearId !== null && (summary.year?.id !== academicYearId || summary.session_state !== "active")) throw invalid();
  return summary;
}

function familyReportYearKey(userId: string, role: FamilyAttendanceSummaryRole, student: { id: string; school_id: string }): string | null {
  return uuid(userId) && uuid(student.id) && uuid(student.school_id) && ["student", "parent"].includes(role)
    ? `erp:attendance-report-year:${userId}:${role}:${student.school_id}:${student.id}` : null;
}
export function restoreFamilyReportYear(userId: string, role: FamilyAttendanceSummaryRole, student: { id: string; school_id: string }): string | null {
  const key = familyReportYearKey(userId, role, student);
  if (!key) return null;
  try { const yearId = sessionStorage.getItem(key); return uuid(yearId) ? yearId : null; } catch { return null; }
}
export function rememberFamilyReportYear(userId: string, role: FamilyAttendanceSummaryRole, student: { id: string; school_id: string }, yearId: string | null): boolean {
  const key = familyReportYearKey(userId, role, student);
  if (!key || yearId !== null && !uuid(yearId)) return false;
  try { if (yearId === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, yearId); return true; } catch { return false; }
}
