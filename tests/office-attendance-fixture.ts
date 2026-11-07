import type { OfficeAttendanceContext, OfficeAttendancePeriod, OfficeAttendanceReport } from "@/lib/attendance/office-reports";
export const officeId = (last: number) => `70000000-0000-4000-8000-${String(last).padStart(12, "0")}`;
export const officeUser = officeId(1), officeSchool = officeId(2), officeYear = { id: officeId(3), name: "2026-27", start_date: "2026-04-01", end_date: "2027-03-31", is_current: true };
export const oldOfficeYear = { id: officeId(4), name: "2025-26", start_date: "2025-04-01", end_date: "2026-03-31", is_current: false };
export const officeClass = { id: officeId(5), name: "Grade 6" }, officeSection = { id: officeId(6), class_id: officeId(5), name: "A" };
export const emptyOfficeScope = { schoolId: officeSchool, academicYearId: officeYear.id, month: "2026-11-01", classId: null, sectionId: null };
export function officePeriod(patch: Partial<OfficeAttendancePeriod> = {}): OfficeAttendancePeriod {
  return { from: "2026-11-01", to: "2026-11-07", state: "complete", pupil_count: 3, complete_pupils: 3, incomplete_pupils: 0, unverified_pupils: 0,
    enrollment_days: 18, working_days: 15, closed_days: 3, unconfigured_days: 0, marked_days: 15, unmarked_days: 0, invalid_days: 0,
    present_days: 13, late_days: 0, half_days: 1, leave_days: 0, absent_days: 1, earned_days: 13.5, percentage: 90, ...patch };
}
export function officeReport(patch: Partial<OfficeAttendanceReport> = {}): OfficeAttendanceReport {
  return { user_id: officeUser, school_id: officeSchool, school_name: "Office QA School", server_today: "2026-11-07", timezone: "Asia/Kolkata", calendar_revision: 3,
    formula: "daily-v1", month: "2026-11-01", year: officeYear, scope: { class_id: null, class_name: null, section_id: null, section_name: null }, pupil_count: 3,
    month_summary: officePeriod(), year_summary: officePeriod(), ...patch };
}
export function officeContext(patch: Partial<OfficeAttendanceContext> = {}): OfficeAttendanceContext {
  return { user_id: officeUser, school_id: officeSchool, school_name: "Office QA School", schools: [{ id: officeSchool, name: "Office QA School" }],
    server_today: "2026-11-07", timezone: "Asia/Kolkata", calendar_revision: 3, current_year_id: officeYear.id, years: [officeYear, oldOfficeYear], classes: [officeClass], sections: [officeSection], ...patch };
}
export function emptyOfficePeriod(state: "not_started" | "no_pupils" | "enrollment_unverified", patch: Partial<OfficeAttendancePeriod> = {}): OfficeAttendancePeriod {
  return officePeriod({ from: null, to: null, state, pupil_count: 0, complete_pupils: 0, incomplete_pupils: 0, unverified_pupils: 0,
    enrollment_days: 0, working_days: 0, closed_days: 0, unconfigured_days: 0, marked_days: 0, unmarked_days: 0, invalid_days: 0, present_days: 0, late_days: 0, half_days: 0, leave_days: 0, absent_days: 0, earned_days: 0, percentage: null, ...patch });
}
