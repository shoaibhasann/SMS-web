import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { calendarMonthRange, loadSchoolAttendanceCalendar, parseSchoolAttendanceCalendar, saveSchoolAttendanceCalendar,
  validateSchoolCalendarIntent, type SchoolCalendarIntent } from "@/lib/attendance/calendar";
import { calendarFixture, calendarId as id, calendarOwner as uid, calendarSchool as schoolId } from "./school-calendar-fixture";
const { bound } = vi.hoisted(() => ({ bound: vi.fn() }));
vi.mock("@/lib/auth/staff-mfa", () => ({ boundMfaSession: bound }));
const intent = (): SchoolCalendarIntent => ({ kind: "policy", schoolId, requestId: id(3), expectedRevision: 0, reason: "School approved new weekly rules", effectiveFrom: "2026-11-08", workingDays: [1, 2, 3, 4, 5], correctionWindowDays: 0 });
function client(data: unknown, error: { code: string } | null = null) {
  const query = Object.assign(Promise.resolve({ data, error }), { setHeader: vi.fn(), abortSignal: vi.fn() });
  query.setHeader.mockReturnValue(query); query.abortSignal.mockReturnValue(query); const rpc = vi.fn().mockReturnValue(query);
  return { rpc, query, client: { rpc } as unknown as SupabaseClient };
}
const signal = () => new AbortController().signal;
function ack(value = intent()) {
  return value.kind === "policy" ? { user_id: uid, school_id: schoolId, request_id: value.requestId, revision: 1, kind: "policy", effective_from: value.effectiveFrom,
    working_days: [...value.workingDays].sort((a, b) => a - b), correction_window_days: value.correctionWindowDays, replayed: false }
    : { user_id: uid, school_id: schoolId, request_id: value.requestId, revision: 1, kind: "exception", day: value.day, mode: value.mode, label: value.label, replayed: false };
}
beforeEach(() => { bound.mockReset().mockResolvedValue({ user: { id: uid }, access_token: "captured-token" }); });
describe("school calendar client contract", () => {
  it("uses civil UTC dates for leap/year boundaries without browser-timezone drift", () => {
    expect(calendarMonthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(calendarMonthRange("2026-12")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(() => calendarMonthRange("2026-13")).toThrow(); expect(() => calendarMonthRange("0000-01")).toThrow();
  });
  it("pins read owner/school/range and retains explicit unconfigured state", async () => {
    const saved = client(calendarFixture()), abort = signal();
    const result = await loadSchoolAttendanceCalendar(saved.client, uid, schoolId, "2026-11-01", "2026-11-30", abort);
    expect(result.days.every(day => !day.configured && day.is_working === null)).toBe(true);
    expect(saved.rpc).toHaveBeenCalledWith("get_school_attendance_calendar", { p_school_id: schoolId, p_from: "2026-11-01", p_to: "2026-11-30" });
    expect(saved.query.setHeader).toHaveBeenCalledWith("Authorization", "Bearer captured-token"); expect(saved.query.abortSignal).toHaveBeenCalledWith(abort);
  });
  it.each([
    { user_id: id(9) }, { school_id: id(9) }, { timezone: "UTC" }, { days: [] }, { history_limit: 20 }, { policy_count: 1 },
    { days: [calendarFixture().days[0], ...calendarFixture().days.slice(0, -1)] },
    { days: calendarFixture().days.map((day, index) => index ? day : { ...day, correction_window_days: 366 }) },
  ])("rejects partial or mismapped calendar snapshots", patch => {
    expect(() => parseSchoolAttendanceCalendar({ ...calendarFixture(), ...patch }, uid, schoolId, "2026-11-01", "2026-11-30")).toThrow("could not be verified");
  });
  it("validates explicit rules without choosing weekdays or a correction window", () => {
    expect(validateSchoolCalendarIntent(intent())).toBeNull();
    expect(validateSchoolCalendarIntent({ ...intent(), kind: "unknown" } as unknown as SchoolCalendarIntent)).not.toBeNull();
    for (const patch of [{ workingDays: [] }, { workingDays: [1, 1] }, { workingDays: [7] }, { correctionWindowDays: NaN }, { correctionWindowDays: 366 }]) {
      expect(validateSchoolCalendarIntent({ ...intent(), ...patch } as SchoolCalendarIntent)).not.toBeNull();
    }
    expect(validateSchoolCalendarIntent({ kind: "exception", schoolId, requestId: id(3), expectedRevision: 0, reason: "Follow weekly schedule", day: "2026-11-09", mode: "inherit", label: null })).toBeNull();
  });
  it("saves the exact frozen revision/request and rechecks owner without mutating weekdays", async () => {
    const value = { ...intent(), workingDays: [5, 1] } as SchoolCalendarIntent, saved = client(ack(value));
    expect(await saveSchoolAttendanceCalendar(saved.client, uid, value, signal())).toEqual({ revision: 1, replayed: false });
    expect(saved.rpc).toHaveBeenCalledWith("save_school_attendance_policy", expect.objectContaining({ p_school_id: schoolId, p_expected_revision: 0, p_request_id: id(3), p_working_days: [1, 5], p_correction_window_days: 0 }));
    expect(value.kind === "policy" && value.workingDays).toEqual([5, 1]); expect(bound).toHaveBeenCalledTimes(2);
  });
  it.each(["\n", "\t"])("rejects pasted internal control characters before sending a reason or label", async control => {
    const saved = client(ack()), value = { ...intent(), reason: `Approved${control}school calendar` };
    expect(validateSchoolCalendarIntent(value)).not.toBeNull();
    await expect(saveSchoolAttendanceCalendar(saved.client, uid, value, signal())).rejects.toMatchObject({ code: "validation" });
    expect(validateSchoolCalendarIntent({ kind: "exception", schoolId, requestId: id(3), expectedRevision: 0, reason: "School approved extra day", day: "2026-11-09", mode: "holiday", label: `School${control}closed` })).not.toBeNull();
    expect(saved.rpc).not.toHaveBeenCalled(); expect(bound).not.toHaveBeenCalled();
  });
  it("sends a dated inherit exception as a retained null-label decision", async () => {
    const value: SchoolCalendarIntent = { kind: "exception", schoolId, requestId: id(3), expectedRevision: 0, reason: "Restore the weekly schedule", day: "2026-11-09", mode: "inherit", label: null };
    const saved = client({ ...ack(value), replayed: true }); expect((await saveSchoolAttendanceCalendar(saved.client, uid, value, signal())).replayed).toBe(true);
    expect(saved.rpc).toHaveBeenCalledWith("save_school_attendance_exception", expect.objectContaining({ p_day: value.day, p_mode: "inherit", p_label: null }));
  });
  it.each([{ user_id: id(9) }, { school_id: id(9) }, { request_id: id(9) }, { revision: 4 }, { working_days: [1] }])("never acknowledges a mismapped write", async patch => {
    await expect(saveSchoolAttendanceCalendar(client({ ...ack(), ...patch }).client, uid, intent(), signal())).rejects.toThrow("acknowledgement");
  });
  it.each([["PT409", "conflict"], ["22023", "validation"], ["42501", "access"], ["503", "unconfirmed"]])("keeps %s outcomes distinct", async (code, expected) => {
    await expect(saveSchoolAttendanceCalendar(client(null, { code }).client, uid, intent(), signal())).rejects.toMatchObject({ code: expected });
  });
  it("denies switched owners before a request and suppresses late owner acknowledgements", async () => {
    const saved = client(ack()); bound.mockRejectedValueOnce(new Error("switched"));
    await expect(saveSchoolAttendanceCalendar(saved.client, uid, intent(), signal())).rejects.toMatchObject({ code: "access" }); expect(saved.rpc).not.toHaveBeenCalled();
    bound.mockResolvedValueOnce({ access_token: "original" }).mockRejectedValueOnce(new Error("switched"));
    await expect(saveSchoolAttendanceCalendar(saved.client, uid, intent(), signal())).rejects.toMatchObject({ code: "access" });
    expect(saved.query.setHeader).toHaveBeenCalledWith("Authorization", "Bearer original");
  });
});
