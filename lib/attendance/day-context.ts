import type { SupabaseClient } from "@supabase/supabase-js";
import { boundMfaSession } from "@/lib/auth/staff-mfa";
import type { AttendanceContext, AttendanceDayContext } from "./types";

const invalid = () => new Error("The school's attendance rules could not be verified. Reload before recording attendance.");
const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !value.startsWith("0000") && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const revision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export async function loadAttendanceDayContext(client: SupabaseClient, userId: string, context: AttendanceContext, day: string): Promise<AttendanceDayContext> {
  const signal = new AbortController().signal;
  const session = await boundMfaSession(client, userId, signal);
  if (!session) throw new Error("Sign in again before loading school attendance rules.");
  const { data, error } = await client.rpc("get_attendance_day_context", {
    p_school_id: context.schoolId, p_year_id: context.academicYearId, p_class_id: context.classId,
    p_section_id: context.sectionId, p_day: day,
  }).setHeader("Authorization", `Bearer ${session.access_token}`);
  if (error) throw new Error(error.code === "42501" ? "Your register access changed. Reopen attendance after signing in."
    : "School attendance rules could not be loaded. Reload before recording attendance.");
  const row = data as Record<string, unknown> | null;
  if (!row || row.user_id !== userId || row.school_id !== context.schoolId || row.academic_year_id !== context.academicYearId
    || row.class_id !== context.classId || row.section_id !== context.sectionId || row.day !== day || !date(row.day)
    || !date(row.server_today) || row.timezone !== "Asia/Kolkata" || !revision(row.revision)
    || typeof row.configured !== "boolean" || typeof row.can_request_correction !== "boolean" || typeof row.can_mark_holiday !== "boolean"
    || !(row.label === null || typeof row.label === "string" && row.label.trim() && row.label.length <= 120 && !/[\u0000-\u001f\u007f]/.test(row.label))
    || !(row.exception_revision === null || revision(row.exception_revision) && row.exception_revision <= row.revision)
    || (row.can_request_correction && day >= row.server_today)
    || (row.source === "import" ? !row.configured || typeof row.is_working !== "boolean" || day >= row.server_today
      || row.policy_revision !== null || row.exception_revision !== null || row.correction_window_days !== null
      || !revision(row.import_revision) || row.import_revision < 1 || row.import_revision > row.revision
      : row.import_revision !== undefined && row.import_revision !== null)
    || (row.configured ? row.source === "import" ? false : typeof row.is_working !== "boolean" || !["weekday", "exception"].includes(row.source as string)
      || !revision(row.policy_revision) || row.policy_revision > row.revision || !revision(row.correction_window_days) || row.correction_window_days > 365
      : row.is_working !== null || row.source !== "unconfigured" || row.policy_revision !== null || row.correction_window_days !== null)) throw invalid();
  return { day, server_today: row.server_today, revision: row.revision, configured: row.configured, is_working: row.is_working as boolean | null,
    source: row.source as AttendanceDayContext["source"], label: row.label as string | null, policy_revision: row.policy_revision as number | null,
    exception_revision: row.exception_revision as number | null, correction_window_days: row.correction_window_days as number | null,
    can_request_correction: row.can_request_correction, can_mark_holiday: row.can_mark_holiday,
    ...(row.source === "import" ? { import_revision: row.import_revision as number } : {}) };
}
