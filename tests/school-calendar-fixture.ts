import { calendarMonthRange, type SchoolAttendanceCalendar } from "@/lib/attendance/calendar";
export const calendarId = (n: number) => `c7000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const calendarOwner = calendarId(1), calendarSchool = calendarId(2);
export function calendarFixture(patch: Partial<SchoolAttendanceCalendar> = {}, month = "2026-11"): SchoolAttendanceCalendar {
  const { from, to } = calendarMonthRange(month), start = Date.parse(`${from}T00:00:00Z`);
  const count = (Date.parse(`${to}T00:00:00Z`) - start) / 86400000 + 1;
  return { user_id: calendarOwner, school_id: calendarSchool, revision: 0, can_edit: true, server_today: "2026-11-07", timezone: "Asia/Kolkata",
    from, to, history_limit: 50, policy_count: 0, exception_count: 0, policies: [], exceptions: [],
    days: Array.from({ length: count }, (_, index) => ({ day: new Date(start + index * 86400000).toISOString().slice(0, 10), configured: false,
      is_working: null, source: "unconfigured", label: null, policy_revision: null, exception_revision: null, correction_window_days: null })), ...patch };
}
