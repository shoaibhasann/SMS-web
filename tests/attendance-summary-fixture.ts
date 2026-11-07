import type { AttendanceSummaryPeriod, FamilyAttendanceSummary } from "@/lib/attendance/family-summary";
export const summaryId = (last: number) => `60000000-0000-4000-8000-${String(last).padStart(12, "0")}`;
export const summaryOwner = summaryId(1), summaryStudent = { id: summaryId(2), school_id: summaryId(3) };
export function summaryPeriod(patch: Partial<AttendanceSummaryPeriod> = {}): AttendanceSummaryPeriod {
  return { from: "2026-11-01", to: "2026-11-07", state: "complete", enrollment_days: 7, working_days: 5, closed_days: 2,
    unconfigured_days: 0, marked_days: 5, unmarked_days: 0, invalid_days: 0, earned_days: 3.5, percentage: 70,
    present_days: 2, late_days: 1, half_days: 1, leave_days: 0, absent_days: 1, ...patch };
}
export function emptySummaryPeriod(state: "enrollment_unverified" | "not_enrolled" | "not_started"): AttendanceSummaryPeriod {
  return summaryPeriod({ from: null, to: null, state, enrollment_days: 0, working_days: 0, closed_days: 0, unconfigured_days: 0,
    marked_days: 0, unmarked_days: 0, invalid_days: 0, earned_days: 0, percentage: null, present_days: 0, late_days: 0, half_days: 0, leave_days: 0, absent_days: 0 });
}
export function attendanceSummaryFixture(patch: Partial<FamilyAttendanceSummary> = {}): FamilyAttendanceSummary {
  return { user_id: summaryOwner, student_id: summaryStudent.id, school_id: summaryStudent.school_id, role: "parent",
    server_today: "2026-11-07", timezone: "Asia/Kolkata", month: "2026-11-01", calendar_revision: 3, formula: "daily-v1",
    year: { id: summaryId(4), name: "2026–2027", start_date: "2026-04-01", end_date: "2027-03-31" }, session_state: "active",
    month_summary: summaryPeriod(), year_summary: summaryPeriod(), ...patch };
}
export const previousSummaryYear = { id: summaryId(5), name: "2025–2026", start_date: "2025-04-01", end_date: "2026-03-31", is_current: false };
export function attendanceReportContextFixture(patch: Partial<import("@/lib/attendance/family-summary").FamilyAttendanceReportContext> = {}): import("@/lib/attendance/family-summary").FamilyAttendanceReportContext {
  return { user_id: summaryOwner, student_id: summaryStudent.id, school_id: summaryStudent.school_id, role: "parent", server_today: "2026-11-07", timezone: "Asia/Kolkata",
    current_year_id: summaryId(4), current_session_state: "active", years: [{ ...attendanceSummaryFixture().year!, is_current: true }, previousSummaryYear], ...patch };
}
export function previousAttendanceSummaryFixture(patch: Partial<FamilyAttendanceSummary> = {}): FamilyAttendanceSummary {
  return attendanceSummaryFixture({ year: previousSummaryYear, month: "2026-03-01", month_summary: summaryPeriod({ from: "2026-03-01", to: "2026-03-07" }),
    year_summary: summaryPeriod({ from: "2026-03-01", to: "2026-03-07" }), ...patch });
}
