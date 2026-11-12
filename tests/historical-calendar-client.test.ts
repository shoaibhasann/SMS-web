import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importHistoricalCalendar, loadHistoricalCalendarContext, parseHistoricalCalendarContext, parseHistoricalCalendarPreview, previewHistoricalCalendar, type HistoricalCalendarImportIntent } from "@/lib/attendance/historical-calendar-import";
import { calendarId as id, calendarOwner as uid, calendarSchool as schoolId } from "./school-calendar-fixture";
const { bound } = vi.hoisted(() => ({ bound: vi.fn() }));
vi.mock("@/lib/auth/staff-mfa", () => ({ boundMfaSession: bound }));
import { historicalContext, historicalPreview, historicalRows, previewToken, yearId } from "./historical-calendar-fixture";
const intent = (): HistoricalCalendarImportIntent => ({ schoolId, academicYearId: yearId, rows: historicalRows, expectedRevision: 2, previewToken, acknowledgeImpact: true, reason: "Office reviewed original calendar record", requestId: id(7) });
const ack = () => ({ user_id: uid, school_id: schoolId, academic_year_id: yearId, request_id: id(7), revision: 3, imported_rows: 2, working_rows: 1, holiday_rows: 1, replayed: false });
const signal = () => new AbortController().signal;
function client(data: unknown, error: { code: string } | null = null) {
  const query = Object.assign(Promise.resolve({ data, error }), { setHeader: vi.fn(), abortSignal: vi.fn() });
  query.setHeader.mockReturnValue(query); query.abortSignal.mockReturnValue(query); const rpc = vi.fn().mockReturnValue(query);
  return { rpc, query, client: { rpc } as unknown as SupabaseClient };
}
beforeEach(() => { bound.mockReset().mockResolvedValue({ access_token: "original" }); });
describe("historical school calendar RPC contract", () => {
  it("pins native actor/school and verifies access before and after loading context", async () => {
    const saved = client(historicalContext()), abort = signal();
    expect(await loadHistoricalCalendarContext(saved.client, uid, schoolId, abort)).toEqual(historicalContext());
    expect(saved.rpc).toHaveBeenCalledWith("get_historical_attendance_calendar_context", { p_school_id: schoolId });
    expect(saved.query.setHeader).toHaveBeenCalledWith("Authorization", "Bearer original"); expect(saved.query.abortSignal).toHaveBeenCalledWith(abort); expect(bound).toHaveBeenCalledTimes(2);
  });
  it.each([{ user_id: id(9) }, { school_id: id(9) }, { timezone: "UTC" }, { revision: -1 }, { server_today: "2026-02-30" }, { years: [{ ...historicalContext().years[0], end_date: "2027-04-02" }] }, { history_limit: 20 }])("rejects incomplete or foreign context", patch => {
    expect(() => parseHistoricalCalendarContext({ ...historicalContext(), ...patch }, uid, schoolId)).toThrow("could not be verified");
  });
  it("validates bounded retained receipt counts and actor, allowing deleted year display fallback", () => {
    const receipt = { request_id: id(7), academic_year_id: id(8), revision: 2, imported_rows: 2, working_rows: 1, holiday_rows: 1, reason: "Office approved original calendar", actor_id: uid, actor_name: "Asha Admin", created_at: "2026-11-07T10:00:00Z" };
    expect(parseHistoricalCalendarContext({ ...historicalContext(), history: [receipt] }, uid, schoolId).history).toHaveLength(1);
    expect(() => parseHistoricalCalendarContext({ ...historicalContext(), history: [{ ...receipt, imported_rows: 1 }] }, uid, schoolId)).toThrow();
    expect(() => parseHistoricalCalendarContext({ ...historicalContext(), history: [receipt, receipt] }, uid, schoolId)).toThrow();
    expect(parseHistoricalCalendarContext({ ...historicalContext(), history: [{ ...receipt, actor_name: null }] }, uid, schoolId).history[0].actor_name).toBeNull();
    for (const actor_name of [undefined, 7, "x".repeat(161)]) expect(() => parseHistoricalCalendarContext({ ...historicalContext(), history: [{ ...receipt, actor_name }] }, uid, schoolId)).toThrow();
    // SQL trims actor names to 160 code points; an astral-character name of that length is 320 UTF-16 units.
    expect(parseHistoricalCalendarContext({ ...historicalContext(), history: [{ ...receipt, actor_name: "\u{1F600}".repeat(160) }] }, uid, schoolId).history[0].actor_name).toBe("\u{1F600}".repeat(160));
    expect(() => parseHistoricalCalendarContext({ ...historicalContext(), history: [{ ...receipt, actor_name: "\u{1F600}".repeat(161) }] }, uid, schoolId)).toThrow();
  });
  it("accepts authoritative preview counts with distinct pupils across dates", async () => {
    const saved = client(historicalPreview());
    expect((await previewHistoricalCalendar(saved.client, uid, schoolId, yearId, historicalRows, signal())).summary).toEqual(historicalPreview().summary);
    expect(saved.rpc).toHaveBeenCalledWith("preview_historical_attendance_calendar", { p_school_id: schoolId, p_academic_year_id: yearId, p_rows: historicalRows });
  });
  it("allows blocking row issues while requiring whole-file validation", () => {
    const preview = historicalPreview(); const value = { ...preview, can_import: false, rows: [{ ...preview.rows[0], issue: "Date already configured" }, preview.rows[1]], summary: { ...preview.summary, valid_rows: 1 } };
    expect(parseHistoricalCalendarPreview(value, uid, schoolId, yearId, historicalRows).can_import).toBe(false);
    expect(() => parseHistoricalCalendarPreview({ ...value, can_import: true }, uid, schoolId, yearId, historicalRows)).toThrow();
  });
  it.each([
    { academic_year_id: id(9) }, { preview_token: "a" }, { rows: [] }, { rows: [{ ...historicalPreview().rows[0], day: "2026-11-06" }, historicalPreview().rows[1]] },
    { rows: [{ ...historicalPreview().rows[0], present_count: 3 }, historicalPreview().rows[1]] }, { rows: [{ ...historicalPreview().rows[0], row_number: 2 }, historicalPreview().rows[1]] },
    { summary: { ...historicalPreview().summary, attendance_records: 999 } }, { summary: { ...historicalPreview().summary, pupils_with_marks: 5 } },
  ])("rejects mismapped preview rows or invented counts", patch => {
    expect(() => parseHistoricalCalendarPreview({ ...historicalPreview(), ...patch }, uid, schoolId, yearId, historicalRows)).toThrow("could not be verified");
  });
  it("requires exact acknowledgement, preserves supplied rows and sends a frozen request", async () => {
    const saved = client(ack()), value = intent();
    expect(await importHistoricalCalendar(saved.client, uid, value, signal())).toEqual({ revision: 3, importedRows: 2, workingRows: 1, holidayRows: 1, replayed: false });
    expect(saved.rpc).toHaveBeenCalledWith("import_historical_attendance_calendar", { p_school_id: schoolId, p_academic_year_id: yearId, p_rows: historicalRows, p_expected_revision: 2,
      p_preview_token: previewToken, p_acknowledge_impact: true, p_reason: value.reason, p_request_id: id(7) });
    expect(value.rows).toBe(historicalRows); expect(bound).toHaveBeenCalledTimes(2);
  });
  it.each([{ acknowledgeImpact: false }, { reason: "bad" }, { expectedRevision: -1 }, { previewToken: "unknown" }, { rows: [...historicalRows, historicalRows[0]] }])("rejects invalid intents before network use", async patch => {
    const saved = client(ack()); await expect(importHistoricalCalendar(saved.client, uid, { ...intent(), ...patch } as HistoricalCalendarImportIntent, signal())).rejects.toMatchObject({ code: "validation" });
    expect(saved.rpc).not.toHaveBeenCalled();
  });
  it.each([{ user_id: id(9) }, { school_id: id(9) }, { academic_year_id: id(9) }, { request_id: id(9) }, { revision: 4 }, { working_rows: 2 }, { imported_rows: 1 }])("never acknowledges mismapped saves", async patch => {
    await expect(importHistoricalCalendar(client({ ...ack(), ...patch }).client, uid, intent(), signal())).rejects.toThrow("acknowledgement");
  });
  it.each([["PT409", "conflict"], ["22023", "validation"], ["42501", "access"], ["503", "unconfirmed"]])("distinguishes %s outcome", async (code, outcome) => {
    await expect(importHistoricalCalendar(client(null, { code }).client, uid, intent(), signal())).rejects.toMatchObject({ code: outcome });
  });
  it("rejects account changes before dispatch and after receiving a save", async () => {
    const saved = client(ack()); bound.mockRejectedValueOnce(new Error("switched"));
    await expect(importHistoricalCalendar(saved.client, uid, intent(), signal())).rejects.toMatchObject({ code: "access" }); expect(saved.rpc).not.toHaveBeenCalled();
    bound.mockResolvedValueOnce({ access_token: "old" }).mockRejectedValueOnce(new Error("switched"));
    await expect(importHistoricalCalendar(saved.client, uid, intent(), signal())).rejects.toMatchObject({ code: "access" });
  });
});
