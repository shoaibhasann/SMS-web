import type { SupabaseClient } from "@supabase/supabase-js";
import { boundMfaSession } from "@/lib/auth/staff-mfa";

export type CalendarMode = "holiday" | "working" | "inherit";
export type AttendancePolicyVersion = { revision: number; effective_from: string; working_days: number[]; correction_window_days: number; reason: string; actor_id: string; created_at: string };
export type AttendanceExceptionVersion = { revision: number; day: string; mode: CalendarMode; label: string | null; reason: string; actor_id: string; created_at: string };
export type CalendarDay = { day: string; configured: boolean; is_working: boolean | null; source: "unconfigured" | "weekday" | "exception" | "import";
  label: string | null; policy_revision: number | null; exception_revision: number | null; correction_window_days: number | null; import_revision?: number | null };
export type SchoolAttendanceCalendar = { user_id: string; school_id: string; revision: number; can_edit: boolean; server_today: string;
  timezone: "Asia/Kolkata"; from: string; to: string; history_limit: 50; policy_count: number; exception_count: number;
  policies: AttendancePolicyVersion[]; exceptions: AttendanceExceptionVersion[]; days: CalendarDay[] };
type IntentBase = { schoolId: string; expectedRevision: number; requestId: string; reason: string };
export type SchoolCalendarIntent = IntentBase & ({ kind: "policy"; effectiveFrom: string; workingDays: number[]; correctionWindowDays: number }
  | { kind: "exception"; day: string; mode: CalendarMode; label: string | null });
export class SchoolCalendarError extends Error {
  constructor(message: string, readonly code: "access" | "validation" | "conflict" | "unconfirmed" = "unconfirmed") { super(message); this.name = "SchoolCalendarError"; }
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
const revision = (value: unknown): value is number => integer(value, 2147483647);
const text = (value: unknown, min: number, max: number): value is string => typeof value === "string" && value.trim().length >= min && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
export const validCalendarDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith("0000")
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
// CSV date cells: Excel on an en-IN PC saves typed ISO dates as DD-MM-YYYY; returns the ISO date for real dates only.
export function csvCalendarDate(value: string) {
  const day = value.replace(/^(\d{2})-(\d{2})-(\d{4})$/, "$3-$2-$1");
  return validCalendarDate(day) ? day : undefined;
}
const timestamp = (value: unknown): value is string => typeof value === "string" && value.includes("T") && Number.isFinite(Date.parse(value));
const weekdays = (value: unknown): value is number[] => Array.isArray(value) && value.length >= 1 && value.length <= 7 && value.every(day => integer(day, 6)) && new Set(value).size === value.length;
const modes = ["holiday", "working", "inherit"] as const;
const invalid = () => new SchoolCalendarError("The school calendar could not be verified completely. Reload before editing.");

export function calendarMonthRange(month: string) {
  const from = `${month}-01`;
  if (!validCalendarDate(from)) throw new SchoolCalendarError("Choose a valid calendar month.", "validation");
  const end = new Date(`${from}T00:00:00Z`); end.setUTCMonth(end.getUTCMonth() + 1, 0);
  return { from, to: end.toISOString().slice(0, 10) };
}
function rangeLength(from: string, to: string) {
  if (!validCalendarDate(from) || !validCalendarDate(to) || from > to) throw invalid();
  const count = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
  if (!integer(count, 366) || count < 1) throw invalid();
  return count;
}
export function parseSchoolAttendanceCalendar(value: unknown, userId: string, schoolId: string, from: string, to: string): SchoolAttendanceCalendar {
  const row = object(value), length = rangeLength(from, to);
  if (row.user_id !== userId || row.school_id !== schoolId || !uuid(userId) || !uuid(schoolId) || !revision(row.revision)
    || row.from !== from || row.to !== to || row.timezone !== "Asia/Kolkata" || !validCalendarDate(row.server_today) || typeof row.can_edit !== "boolean"
    || row.history_limit !== 50 || !integer(row.policy_count) || !integer(row.exception_count)
    || !Array.isArray(row.policies) || row.policies.length !== Math.min(row.policy_count, 50)
    || !Array.isArray(row.exceptions) || row.exceptions.length !== Math.min(row.exception_count, 50)
    || !Array.isArray(row.days) || row.days.length !== length) throw invalid();
  const revisions = new Set<number>();
  for (const [kind, rows] of [["policy", row.policies], ["exception", row.exceptions]] as const) {
    let previous = Number(row.revision) + 1;
    for (const value of rows) {
      const entry = object(value);
      if (!revision(entry.revision) || entry.revision < 1 || entry.revision >= previous || revisions.has(entry.revision)
        || !uuid(entry.actor_id) || !timestamp(entry.created_at) || !text(entry.reason, 5, 300)) throw invalid();
      previous = entry.revision; revisions.add(entry.revision);
      if (kind === "policy" ? !validCalendarDate(entry.effective_from) || !weekdays(entry.working_days) || !integer(entry.correction_window_days, 365)
        : !validCalendarDate(entry.day) || !modes.includes(entry.mode as CalendarMode) || !(entry.mode === "inherit" ? entry.label === null : text(entry.label, 1, 120))) throw invalid();
    }
  }
  const start = Date.parse(`${from}T00:00:00Z`);
  for (let index = 0; index < row.days.length; index++) {
    const day = object(row.days[index]);
    if (day.day !== new Date(start + index * 86400000).toISOString().slice(0, 10) || typeof day.configured !== "boolean"
      || !(day.is_working === null || typeof day.is_working === "boolean") || !["unconfigured", "weekday", "exception", "import"].includes(String(day.source))
      || !(day.label === null || text(day.label, 1, 120))
      || ![day.policy_revision, day.exception_revision].every(item => item === null || revision(item) && item > 0 && item <= Number(row.revision))
      || !(day.correction_window_days === null || integer(day.correction_window_days, 365))
      || (day.source === "import" ? !day.configured || typeof day.is_working !== "boolean" || day.day >= row.server_today
        || day.policy_revision !== null || day.exception_revision !== null || day.correction_window_days !== null
        || !revision(day.import_revision) || day.import_revision < 1 || day.import_revision > Number(row.revision)
        : day.import_revision !== undefined && day.import_revision !== null)) throw invalid();
  }
  return value as SchoolAttendanceCalendar;
}
export function validateSchoolCalendarIntent(intent: SchoolCalendarIntent): string | null {
  if (intent.kind !== "policy" && intent.kind !== "exception") return "Choose a supported school calendar change.";
  if (!uuid(intent.schoolId) || !uuid(intent.requestId) || !revision(intent.expectedRevision) || !text(intent.reason.trim(), 5, 300)) return "Use a 5–300 character change reason and a valid saved revision.";
  if (intent.kind === "policy") return validCalendarDate(intent.effectiveFrom) && weekdays(intent.workingDays) && integer(intent.correctionWindowDays, 365)
    ? null : "Choose an effective date, at least one working weekday and a correction window from 0 to 365 days.";
  return validCalendarDate(intent.day) && modes.includes(intent.mode) && (intent.mode === "inherit" ? intent.label === null : text(intent.label, 1, 120))
    ? null : "Choose an exception date and a 1–120 character label, or Inherit without a label.";
}
function rpcError(error: { code?: string } | null, reading = false) {
  if (!error) return;
  if (["42501", "PGRST301", "PGRST302"].includes(error.code ?? "")) throw new SchoolCalendarError("Your current school calendar access changed. Reopen settings and complete authenticator verification.", "access");
  if (["PT409", "40001"].includes(error.code ?? "")) throw new SchoolCalendarError("The calendar changed or this date is locked. Reload saved rules before retrying; existing attendance stays unchanged.", "conflict");
  if (error.code === "22023") throw new SchoolCalendarError("The calendar change was rejected. Check its date, weekdays, label and reason. Today cannot change after saved attendance or gate evidence.", "validation");
  throw new SchoolCalendarError(reading ? "The school calendar could not be loaded. Reload to check the saved rules." : "The calendar save could not be confirmed. Retry the same frozen save to confirm its outcome.");
}
async function authorization(client: SupabaseClient, userId: string, signal: AbortSignal) {
  if (!uuid(userId)) throw new SchoolCalendarError("Sign in again to manage the school calendar.", "access");
  const session = await boundMfaSession(client, userId, signal).catch(() => {
    signal.throwIfAborted(); throw new SchoolCalendarError("Your sign-in changed. Reopen school calendar settings.", "access");
  });
  if (!session) throw new SchoolCalendarError("Sign in again to manage the school calendar.", "access");
  signal.throwIfAborted(); return `Bearer ${session.access_token}`;
}
export async function loadSchoolAttendanceCalendar(client: SupabaseClient, userId: string, schoolId: string, from: string, to: string, signal: AbortSignal) {
  rangeLength(from, to);
  if (!uuid(schoolId)) throw invalid();
  const header = await authorization(client, userId, signal);
  const { data, error } = await client.rpc("get_school_attendance_calendar", { p_school_id: schoolId, p_from: from, p_to: to }).setHeader("Authorization", header).abortSignal(signal);
  signal.throwIfAborted(); rpcError(error, true);
  return parseSchoolAttendanceCalendar(data, userId, schoolId, from, to);
}
export async function saveSchoolAttendanceCalendar(client: SupabaseClient, userId: string, intent: SchoolCalendarIntent, signal: AbortSignal) {
  const validation = validateSchoolCalendarIntent(intent);
  if (validation) throw new SchoolCalendarError(validation, "validation");
  const header = await authorization(client, userId, signal);
  const workingDays = intent.kind === "policy" ? [...intent.workingDays].sort((a, b) => a - b) : null;
  const common = { p_school_id: intent.schoolId, p_expected_revision: intent.expectedRevision, p_reason: intent.reason.trim(), p_request_id: intent.requestId };
  const query = intent.kind === "policy" ? client.rpc("save_school_attendance_policy", { ...common, p_effective_from: intent.effectiveFrom, p_working_days: workingDays, p_correction_window_days: intent.correctionWindowDays })
    : client.rpc("save_school_attendance_exception", { ...common, p_day: intent.day, p_mode: intent.mode, p_label: intent.label });
  const { data, error } = await query.setHeader("Authorization", header).abortSignal(signal);
  signal.throwIfAborted(); rpcError(error); await authorization(client, userId, signal);
  const row = object(data);
  if (row.user_id !== userId || row.school_id !== intent.schoolId || row.request_id !== intent.requestId || row.kind !== intent.kind
    || row.revision !== intent.expectedRevision + 1 || typeof row.replayed !== "boolean"
    || (intent.kind === "policy" ? row.effective_from !== intent.effectiveFrom || JSON.stringify(row.working_days) !== JSON.stringify(workingDays) || row.correction_window_days !== intent.correctionWindowDays
      : row.day !== intent.day || row.mode !== intent.mode || row.label !== intent.label)) throw new SchoolCalendarError("The calendar save acknowledgement could not be verified. Retry the same frozen save.");
  return { revision: Number(row.revision), replayed: row.replayed };
}
