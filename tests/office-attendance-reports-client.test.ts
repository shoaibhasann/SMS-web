import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadOfficeAttendanceContext, loadOfficeAttendanceReport, parseOfficeAttendanceContext, parseOfficeAttendanceReport } from "@/lib/attendance/office-reports";
import { emptyOfficePeriod, emptyOfficeScope as scope, officeContext, officeId as id, officePeriod, officeReport, officeSchool as school, officeUser as user, officeYear as year } from "./office-attendance-fixture";
const { bound } = vi.hoisted(() => ({ bound: vi.fn() }));
vi.mock("@/lib/auth/staff-mfa", () => ({ boundMfaSession: bound }));
function client(data: unknown, error: { code: string } | null = null) {
  const query = { setHeader: vi.fn(), abortSignal: vi.fn().mockResolvedValue({ data, error }) }; query.setHeader.mockReturnValue(query);
  const rpc = vi.fn().mockReturnValue(query); return { client: { rpc } as unknown as SupabaseClient, rpc, query };
}
beforeEach(() => { vi.restoreAllMocks(); bound.mockReset().mockResolvedValue({ user: { id: user }, access_token: "native-test-only" }); });
describe("official Office report contract", () => {
  it("validates actual weighted pupil-days greater than a single pupil's seven-day range", () => {
    expect(parseOfficeAttendanceReport(officeReport(), user, scope).month_summary.percentage).toBe(90);
    expect(parseOfficeAttendanceContext(officeContext(), user, null).school_id).toBe(school);
  });
  it("accepts a bounded 5,000-pupil aggregate beyond the single-pupil 366-day counters", () => {
    const totals = officePeriod({ pupil_count: 5000, complete_pupils: 5000, enrollment_days: 35000, working_days: 35000, closed_days: 0,
      marked_days: 35000, present_days: 30000, half_days: 0, absent_days: 5000, earned_days: 30000, percentage: 85.71 });
    expect(parseOfficeAttendanceReport(officeReport({ pupil_count: 5000, month_summary: totals, year_summary: totals }), user, scope).year_summary.percentage).toBe(85.71);
  });
  it.each([
    { pupils: 100, working: 400, present: 100, half: 1, earned: 100.5, percentage: 25.13, wrong: 25.12 },
    { pupils: 2000, working: 10000, present: 1, half: 1, earned: 1.5, percentage: 0.02, wrong: 0.01 },
  ])("matches Postgres half-up rounding for large aggregate denominator $working", ({ pupils, working, present, half, earned, percentage, wrong }) => {
    const totals = officePeriod({ pupil_count: pupils, complete_pupils: pupils, enrollment_days: working, working_days: working, closed_days: 0,
      marked_days: working, present_days: present, half_days: half, absent_days: working - present - half, earned_days: earned, percentage });
    expect(parseOfficeAttendanceReport(officeReport({ pupil_count: pupils, month_summary: totals, year_summary: totals }), user, scope).month_summary.percentage).toBe(percentage);
    expect(() => parseOfficeAttendanceReport(officeReport({ pupil_count: pupils, month_summary: { ...totals, percentage: wrong }, year_summary: totals }), user, scope)).toThrow("could not be verified");
  });
  it.each([
    { user_id: id(90) }, { school_id: id(90) }, { school_name: "" }, { timezone: "UTC" }, { formula: "average-of-percentages" },
    { month: "2026-10-01" }, { year: { ...year, id: id(90) } }, { scope: { class_id: id(5), class_name: "Grade 6", section_id: null, section_name: null } },
    { pupil_count: 5001 }, { calendar_revision: -1 },
  ])("rejects mismatched report identity, scope and unsafe metadata %j", patch => {
    expect(() => parseOfficeAttendanceReport(officeReport(patch as never), user, scope)).toThrow();
  });
  it.each([
    { percentage: 99 }, { working_days: 16 }, { present_days: 14 }, { earned_days: 13 }, { unmarked_days: 1 }, { pupil_count: 2 },
    { incomplete_pupils: 1 }, { unverified_pupils: 1 }, { complete_pupils: 2 }, { from: "2026-10-01" }, { to: "2026-11-08" },
  ])("rejects inconsistent aggregate arithmetic or date boundaries %j", patch => {
    expect(() => parseOfficeAttendanceReport(officeReport({ month_summary: officePeriod(patch) }), user, scope)).toThrow();
  });
  it("withholds missing pupil marks and unverified enrollment rather than allowing partial percentages", () => {
    const missing = officePeriod({ state: "attendance_incomplete", complete_pupils: 2, incomplete_pupils: 1, marked_days: 14, unmarked_days: 1, absent_days: 0, percentage: null });
    expect(parseOfficeAttendanceReport(officeReport({ month_summary: missing, year_summary: missing }), user, scope).month_summary.percentage).toBeNull();
    const unverified = emptyOfficePeriod("enrollment_unverified", { pupil_count: 1, incomplete_pupils: 1, unverified_pupils: 1 });
    expect(parseOfficeAttendanceReport(officeReport({ pupil_count: 1, month_summary: unverified, year_summary: unverified }), user, scope).year_summary.state).toBe("enrollment_unverified");
    expect(() => parseOfficeAttendanceReport(officeReport({ month_summary: { ...missing, percentage: 96.43 }, year_summary: missing }), user, scope)).toThrow();
  });
  it("distinguishes no candidates, no elapsed days and verified closed-only pupil-days", () => {
    const empty = emptyOfficePeriod("no_pupils");
    expect(parseOfficeAttendanceReport(officeReport({ pupil_count: 0, month_summary: empty, year_summary: empty }), user, scope).year_summary.state).toBe("no_pupils");
    const later = emptyOfficePeriod("not_started");
    expect(parseOfficeAttendanceReport(officeReport({ month_summary: later }), user, scope).month_summary.pupil_count).toBe(0);
    const closed = officePeriod({ from: "2026-11-01", to: "2026-11-01", state: "no_working_days", pupil_count: 1, complete_pupils: 1,
      enrollment_days: 1, working_days: 0, closed_days: 1, marked_days: 0, present_days: 0, half_days: 0, absent_days: 0, earned_days: 0, percentage: null });
    expect(parseOfficeAttendanceReport(officeReport({ month_summary: closed }), user, scope).month_summary.state).toBe("no_working_days");
  });
  it("rejects duplicate, future, foreign and incoherent catalog entries", () => {
    for (const patch of [{ years: [year, year] }, { schools: [{ id: id(90), name: "Office QA School" }] }, { current_year_id: id(90) },
      { sections: [{ id: id(8), class_id: id(90), name: "B" }] }, { years: [{ ...year, start_date: "2027-04-01", end_date: "2028-03-31" }] }]) {
      expect(() => parseOfficeAttendanceContext(officeContext(patch), user, school)).toThrow();
    }
  });
  it("permits unavailable current metadata alongside a valid completed year without silently selecting it", () => {
    const catalog = officeContext({ current_year_id: id(99), years: officeContext().years.filter(option => !option.is_current) });
    expect(parseOfficeAttendanceContext(catalog, user, school).years).toHaveLength(1);
  });
  it("pins native user/token/school/filter scope around every RPC", async () => {
    const mock = client(officeReport()), signal = new AbortController().signal;
    await loadOfficeAttendanceReport(mock.client, user, scope, signal);
    expect(mock.rpc).toHaveBeenCalledWith("get_office_attendance_report", { p_school_id: school, p_academic_year_id: year.id, p_month: "2026-11-01", p_class_id: null, p_section_id: null });
    expect(mock.query.setHeader).toHaveBeenCalledWith("Authorization", "Bearer native-test-only"); expect(mock.query.abortSignal).toHaveBeenCalledWith(signal); expect(bound).toHaveBeenCalledTimes(2);
    const context = client(officeContext()); await loadOfficeAttendanceContext(context.client, user, null, signal);
    expect(context.rpc).toHaveBeenCalledWith("get_office_attendance_report_context", { p_school_id: null });
  });
  it.each(["42501", "PGRST301", "PGRST302"])("returns access failure for %s rather than exposing raw server errors", async code => {
    await expect(loadOfficeAttendanceReport(client(null, { code }).client, user, scope, new AbortController().signal)).rejects.toMatchObject({ code: "access" });
  });
  it("does not promise that a smaller class avoids a school-year cohort failure", async () => {
    await expect(loadOfficeAttendanceReport(client(null, { code: "57014" }).client, user, scope, new AbortController().signal)).rejects.toThrow("contact the school office");
    await expect(loadOfficeAttendanceReport(client(null, { code: "54000" }).client, user, scope, new AbortController().signal)).rejects.toThrow("5,000-pupil school cohort");
  });
  it("handles bounded scope errors, invalid input and canceled/session-switched results", async () => {
    await expect(loadOfficeAttendanceReport(client(null, { code: "54000" }).client, user, scope, new AbortController().signal)).rejects.toThrow("5,000");
    const mock = client(officeReport()); await expect(loadOfficeAttendanceReport(mock.client, user, { ...scope, sectionId: id(8) }, new AbortController().signal)).rejects.toMatchObject({ code: "validation" }); expect(mock.rpc).not.toHaveBeenCalled();
    bound.mockResolvedValueOnce({ access_token: "before" }).mockRejectedValueOnce(new Error("another native user"));
    await expect(loadOfficeAttendanceReport(mock.client, user, scope, new AbortController().signal)).rejects.toMatchObject({ code: "access" });
    const controller = new AbortController(); controller.abort(); await expect(loadOfficeAttendanceReport(mock.client, user, scope, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
