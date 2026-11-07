import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadFamilyAttendanceSummary, parseFamilyAttendanceSummary, loadFamilyAttendanceReport, loadFamilyAttendanceReportContext, parseFamilyAttendanceReportContext, restoreFamilyReportYear, rememberFamilyReportYear } from "@/lib/attendance/family-summary";
import { attendanceSummaryFixture as fixture, summaryOwner as uid, summaryStudent as student, summaryId as id, summaryPeriod, emptySummaryPeriod, attendanceReportContextFixture as contextFixture, previousAttendanceSummaryFixture as previousFixture, previousSummaryYear } from "./attendance-summary-fixture";
const { bound } = vi.hoisted(() => ({ bound: vi.fn() }));
vi.mock("@/lib/auth/staff-mfa", () => ({ boundMfaSession: bound }));
function setup(data: unknown = fixture(), error: { code: string } | null = null) {
  const query = Object.assign(Promise.resolve({ data, error }), { setHeader: vi.fn(), abortSignal: vi.fn() });
  query.setHeader.mockReturnValue(query); query.abortSignal.mockReturnValue(query);
  const rpc = vi.fn().mockReturnValue(query);
  return { client: { rpc } as unknown as SupabaseClient, rpc, query };
}
const signal = () => new AbortController().signal;
beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); bound.mockReset().mockResolvedValue({ user: { id: uid }, access_token: "captured-summary-token" }); });
describe("official family attendance client", () => {
  it("pins role, child, school and native owner while using the server's bounded default month", async () => {
    const mock = setup(), abort = signal();
    expect((await loadFamilyAttendanceSummary(mock.client, uid, student, "parent", null, abort)).month_summary?.percentage).toBe(70);
    expect(mock.rpc).toHaveBeenCalledWith("get_family_attendance_summary", { p_role: "parent", p_student_id: student.id, p_month: null });
    expect(mock.query.setHeader).toHaveBeenCalledWith("Authorization", "Bearer captured-summary-token");
    expect(mock.query.abortSignal).toHaveBeenCalledWith(abort); expect(bound).toHaveBeenCalledTimes(2);
  });
  it("uses an explicit civil reporting month and never requests a raw attendance page", async () => {
    const mock = setup(fixture({ role: "student" }));
    await loadFamilyAttendanceSummary(mock.client, uid, student, "student", "2026-11-01", signal());
    expect(mock.rpc).toHaveBeenCalledWith("get_family_attendance_summary", { p_role: "student", p_student_id: student.id, p_month: "2026-11-01" });
  });
  it.each([{ user_id: id(9) }, { student_id: id(9) }, { school_id: id(9) }, { role: "student" }, { timezone: "UTC" }, { formula: "saved-rows-v0" }, { calendar_revision: -1 }, { month: "2026-11-02" }])("rejects mismapped or unsupported authority snapshots", patch => {
    expect(() => parseFamilyAttendanceSummary(fixture(patch as never), uid, student, "parent", "2026-11-01")).toThrow("could not be verified");
  });
  it.each([{ percentage: 75 }, { percentage: Number.NaN }, { earned_days: 4 }, { working_days: 6 }, { marked_days: 3 }, { half_days: 0.5 }, { from: "2026-10-31" }, { to: "2026-11-08" }, { unmarked_days: 1 }, { state: "attendance_incomplete" }])("rejects contradictory official counts, rates or date scopes", patch => {
    expect(() => parseFamilyAttendanceSummary(fixture({ month_summary: summaryPeriod(patch as never) }), uid, student, "parent", null)).toThrow();
  });
  it("preserves unknown calendars and missing marks without publishing an invented percentage", () => {
    const unmarked = summaryPeriod({ state: "attendance_incomplete", marked_days: 4, unmarked_days: 1, present_days: 1, earned_days: 2.5, percentage: null });
    const calendar = summaryPeriod({ state: "calendar_unconfigured", working_days: 4, marked_days: 4, present_days: 1, earned_days: 2.5, unconfigured_days: 1, percentage: null });
    expect(parseFamilyAttendanceSummary(fixture({ month_summary: unmarked, year_summary: unmarked }), uid, student, "parent", null).month_summary?.percentage).toBeNull();
    expect(parseFamilyAttendanceSummary(fixture({ month_summary: calendar, year_summary: calendar }), uid, student, "parent", null).year_summary?.percentage).toBeNull();
    expect(() => parseFamilyAttendanceSummary(fixture({ month_summary: { ...unmarked, percentage: 50 } }), uid, student, "parent", null)).toThrow();
  });
  it("accepts legitimate complete zero and half-day rates, without dividing an empty period", () => {
    const absent = summaryPeriod({ present_days: 0, late_days: 0, half_days: 0, leave_days: 2, absent_days: 3, earned_days: 0, percentage: 0 });
    expect(parseFamilyAttendanceSummary(fixture({ month_summary: absent, year_summary: absent }), uid, student, "parent", null).month_summary?.percentage).toBe(0);
    const empty = summaryPeriod({ state: "no_working_days", working_days: 0, closed_days: 7, marked_days: 0, present_days: 0, late_days: 0, half_days: 0, absent_days: 0, earned_days: 0, percentage: null });
    expect(parseFamilyAttendanceSummary(fixture({ month_summary: empty, year_summary: empty }), uid, student, "parent", null).month_summary?.percentage).toBeNull();
    expect(() => parseFamilyAttendanceSummary(fixture({ month_summary: { ...empty, percentage: 0 } }), uid, student, "parent", null)).toThrow();
  });
  it.each(["missing", "ambiguous", "unsupported"] as const)("keeps the %s current-session outcome explicit", session_state => {
    expect(parseFamilyAttendanceSummary(fixture({ session_state, year: null, month_summary: null, year_summary: null }), uid, student, "parent", null).session_state).toBe(session_state);
  });
  it("accepts a bounded unsupported long year but denies a partial active year response", () => {
    const year = { id: id(4), name: "Long session", start_date: "2025-01-01", end_date: "2026-12-31" };
    expect(parseFamilyAttendanceSummary(fixture({ year, session_state: "unsupported", month_summary: null, year_summary: null }), uid, student, "parent", null).session_state).toBe("unsupported");
    expect(() => parseFamilyAttendanceSummary(fixture({ month_summary: null }), uid, student, "parent", null)).toThrow();
  });
  it("rejects unexplained enrollment gaps and monthly totals outside the verified session", () => {
    const shorter = summaryPeriod({ to: "2026-11-06", enrollment_days: 6, closed_days: 1 });
    expect(() => parseFamilyAttendanceSummary(fixture({ year_summary: shorter }), uid, student, "parent", null)).toThrow();
    expect(() => parseFamilyAttendanceSummary(fixture({ month_summary: summaryPeriod({ to: "2026-11-06" }) }), uid, student, "parent", null)).toThrow();
    expect(() => parseFamilyAttendanceSummary(fixture({ year_summary: emptySummaryPeriod("enrollment_unverified") }), uid, student, "parent", null)).toThrow();
  });
  it.each(["enrollment_unverified", "not_enrolled", "not_started"] as const)("accepts the %s null-bound outcome without inventing a denominator", state => {
    const empty = emptySummaryPeriod(state);
    expect(parseFamilyAttendanceSummary(fixture({ month_summary: empty, year_summary: empty }), uid, student, "parent", null).month_summary?.percentage).toBeNull();
    expect(() => parseFamilyAttendanceSummary(fixture({ month_summary: { ...empty, from: "2026-11-01" }, year_summary: empty }), uid, student, "parent", null)).toThrow();
  });
  it.each(["2026-02-30", "2026-11-02", "0000-01-01", "2026-13-01"])("rejects invalid month %s before reading auth/data", async month => {
    const mock = setup(); await expect(loadFamilyAttendanceSummary(mock.client, uid, student, "parent", month, signal())).rejects.toMatchObject({ code: "validation" });
    expect(bound).not.toHaveBeenCalled(); expect(mock.rpc).not.toHaveBeenCalled();
  });
  it("does not expose a late response after account change or cancellation", async () => {
    const mock = setup(); bound.mockResolvedValueOnce({ access_token: "first-owner" }).mockRejectedValueOnce(new Error("switched"));
    await expect(loadFamilyAttendanceSummary(mock.client, uid, student, "parent", null, signal())).rejects.toMatchObject({ code: "access" });
    const cancelled = new AbortController(); cancelled.abort(); bound.mockImplementation(() => { cancelled.signal.throwIfAborted(); });
    await expect(loadFamilyAttendanceSummary(mock.client, uid, student, "parent", null, cancelled.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
  it.each([["42501", "access"], ["PGRST301", "access"], ["22023", "validation"], ["503", "unavailable"]])("keeps %s failures visible instead of rendering zero", async (code, expected) => {
    await expect(loadFamilyAttendanceSummary(setup(null, { code }).client, uid, student, "parent", null, signal())).rejects.toMatchObject({ code: expected });
  });
});

describe("family previous-year report contract", () => {
  it("loads a native owner/child-bound year catalog without querying raw enrollments", async () => {
    const mock = setup(contextFixture()), abort = signal();
    expect((await loadFamilyAttendanceReportContext(mock.client, uid, student, "parent", abort)).years).toHaveLength(2);
    expect(mock.rpc).toHaveBeenCalledWith("get_family_attendance_report_context", { p_role: "parent", p_student_id: student.id });
    expect(mock.query.setHeader).toHaveBeenCalledWith("Authorization", "Bearer captured-summary-token"); expect(mock.query.abortSignal).toHaveBeenCalledWith(abort); expect(bound).toHaveBeenCalledTimes(2);
  });
  it.each([{ user_id: id(9) }, { student_id: id(9) }, { school_id: id(9) }, { role: "student" }, { timezone: "UTC" }, { current_year_id: id(9) },
    { current_session_state: "missing" }, { years: [previousSummaryYear, previousSummaryYear] },
    { years: [{ ...previousSummaryYear, end_date: "2026-11-07" }] }, { years: [{ ...previousSummaryYear, end_date: "2026-04-02" }] }])("rejects malformed, foreign, future or contradictory catalogs", patch => {
    expect(() => parseFamilyAttendanceReportContext({ ...contextFixture(), ...patch }, uid, student, "parent")).toThrow("could not be verified");
  });
  it.each(["missing", "ambiguous", "unsupported"] as const)("retains enrolled archives while %s current selection stays explicit", current_session_state => {
    const context = contextFixture({ current_session_state, current_year_id: current_session_state === "unsupported" ? id(4) : null, years: [previousSummaryYear] });
    expect(parseFamilyAttendanceReportContext(context, uid, student, "parent").current_year_id).toBe(context.current_year_id);
  });
  it("reads an explicit completed academic year through the new exact RPC and validates year identity", async () => {
    const mock = setup(previousFixture());
    expect((await loadFamilyAttendanceReport(mock.client, uid, student, "parent", previousSummaryYear.id, null, signal())).year?.id).toBe(previousSummaryYear.id);
    expect(mock.rpc).toHaveBeenCalledWith("get_family_attendance_report", { p_role: "parent", p_student_id: student.id, p_academic_year_id: previousSummaryYear.id, p_month: null });
    await expect(loadFamilyAttendanceReport(setup(fixture()).client, uid, student, "parent", previousSummaryYear.id, null, signal())).rejects.toThrow("could not be verified");
  });
  it("preserves explicit archive month and rejects out-of-year payloads", async () => {
    const mock = setup(previousFixture()); await loadFamilyAttendanceReport(mock.client, uid, student, "parent", previousSummaryYear.id, "2026-03-01", signal());
    expect(mock.rpc).toHaveBeenCalledWith("get_family_attendance_report", expect.objectContaining({ p_month: "2026-03-01" }));
    await expect(loadFamilyAttendanceReport(setup(previousFixture()).client, uid, student, "parent", previousSummaryYear.id, "2026-02-01", signal())).rejects.toThrow("could not be verified");
  });
  it("allows null year for API compatibility without changing the legacy three-argument loader", async () => {
    const mock = setup(); await loadFamilyAttendanceReport(mock.client, uid, student, "parent", null, null, signal());
    expect(mock.rpc).toHaveBeenCalledWith("get_family_attendance_report", expect.objectContaining({ p_academic_year_id: null }));
  });
  it.each([["invalid", null], [id(5), "2026-02-30"], [id(5), "2026-03-02"]])("rejects invalid explicit selections before Auth or RPC", async (year, month) => {
    const mock = setup(); await expect(loadFamilyAttendanceReport(mock.client, uid, student, "parent", year, month, signal())).rejects.toMatchObject({ code: "validation" });
    expect(bound).not.toHaveBeenCalled(); expect(mock.rpc).not.toHaveBeenCalled();
  });
  it("suppresses report and catalog acknowledgements after owner change", async () => {
    bound.mockResolvedValueOnce({ access_token: "old" }).mockRejectedValueOnce(new Error("switched"));
    await expect(loadFamilyAttendanceReportContext(setup(contextFixture()).client, uid, student, "parent", signal())).rejects.toMatchObject({ code: "access" });
    bound.mockResolvedValueOnce({ access_token: "old" }).mockRejectedValueOnce(new Error("switched"));
    await expect(loadFamilyAttendanceReport(setup(previousFixture()).client, uid, student, "parent", previousSummaryYear.id, null, signal())).rejects.toMatchObject({ code: "access" });
  });
  it.each([["42501", "access"], ["22023", "validation"], ["503", "unavailable"]])("keeps %s archive read errors explicit", async (code, outcome) => {
    await expect(loadFamilyAttendanceReport(setup(null, { code }).client, uid, student, "parent", previousSummaryYear.id, null, signal())).rejects.toMatchObject({ code: outcome });
  });
});

describe("family attendance selected-year preference", () => {
  it("stores only a year identifier in the exact user, role, school and pupil scope", () => {
    expect(rememberFamilyReportYear(uid, "parent", student, previousSummaryYear.id)).toBe(true);
    expect(restoreFamilyReportYear(uid, "parent", student)).toBe(previousSummaryYear.id);
    expect(restoreFamilyReportYear(uid, "student", student)).toBeNull(); expect(restoreFamilyReportYear(id(9), "parent", student)).toBeNull();
    expect(restoreFamilyReportYear(uid, "parent", { ...student, id: id(8) })).toBeNull(); expect(restoreFamilyReportYear(uid, "parent", { ...student, school_id: id(8) })).toBeNull();
    expect(sessionStorage.length).toBe(1); expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(previousSummaryYear.id);
    expect(rememberFamilyReportYear(uid, "parent", student, null)).toBe(true); expect(restoreFamilyReportYear(uid, "parent", student)).toBeNull(); expect(sessionStorage.length).toBe(0);
  });
  it("ignores malformed stored identifiers and refuses invalid scope or year writes", () => {
    rememberFamilyReportYear(uid, "parent", student, previousSummaryYear.id); const key = sessionStorage.key(0)!; sessionStorage.setItem(key, "not-a-uuid");
    expect(restoreFamilyReportYear(uid, "parent", student)).toBeNull(); expect(rememberFamilyReportYear(uid, "parent", student, "not-a-uuid")).toBe(false);
    expect(rememberFamilyReportYear("wrong-user", "parent", student, previousSummaryYear.id)).toBe(false); expect(restoreFamilyReportYear("wrong-user", "parent", student)).toBeNull();
  });
});
