import { calendarId as id, calendarOwner as uid, calendarSchool as schoolId } from "./school-calendar-fixture";
export const yearId = id(5), previewToken = "a".repeat(64);
export const historicalRows = [{ day: "2026-11-01", status: "working" as const, label: "Approved working day" }, { day: "2026-11-02", status: "holiday" as const, label: "School holiday" }];
export const historicalContext = () => ({ user_id: uid, school_id: schoolId, server_today: "2026-11-07", timezone: "Asia/Kolkata" as const, revision: 2, can_import: true,
  years: [{ id: yearId, name: "2026–27", start_date: "2026-04-01", end_date: "2027-03-31" }], history: [], history_limit: 10 as const });
export const historicalPreview = () => ({ ...historicalContext(), academic_year_id: yearId, preview_token: previewToken,
  rows: historicalRows.map((row, index) => ({ ...row, row_number: index + 1, issue: null, attendance_count: 2, present_count: 1, absent_count: 0, late_count: 0, half_day_count: 0, leave_count: 0, holiday_count: 1, pupils_with_marks: 2 })),
  summary: { total_rows: 2, valid_rows: 2, working_rows: 1, holiday_rows: 1, attendance_records: 4, pupils_with_marks: 2 } });
