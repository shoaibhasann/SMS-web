import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOfficeAttendanceReportPdf, downloadOfficeAttendanceReportPdf } from "@/lib/attendance/office-report-export";
import { OfficeAttendanceReportError } from "@/lib/attendance/office-reports";
import { officeContext, officeId as id, officePeriod, officeReport, officeUser as user } from "./office-attendance-fixture";
const { report, context, build } = vi.hoisted(() => ({ report: vi.fn(), context: vi.fn(), build: vi.fn() }));
vi.mock("@/lib/attendance/office-reports", async original => ({ ...await original<typeof import("@/lib/attendance/office-reports")>(), loadOfficeAttendanceReport: report, loadOfficeAttendanceContext: context }));
vi.mock("@/lib/attendance/report-pdf", () => ({ buildOfficeAttendanceReportPdf: build, AttendanceReportPdfError: class extends Error {} }));
const client = {} as SupabaseClient, filename = "attendance-school-2026-04-01-2027-03-31-2026-11.pdf";
const bytes = new Uint8Array(Array.from("%PDF-1.7\nsynthetic", character => character.charCodeAt(0)));
const signal = () => new AbortController().signal;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); report.mockReset().mockResolvedValue(officeReport()); context.mockReset().mockResolvedValue(officeContext()); build.mockReset().mockResolvedValue({ bytes, filename }); });
describe("Office verified PDF export", () => {
  it("freezes displayed totals and verifies context/report before and after actual rendering", async () => {
    const abort = signal(), expected = officeReport();
    expect(await createOfficeAttendanceReportPdf(client, user, expected, abort)).toEqual({ bytes, filename });
    expect(report).toHaveBeenCalledTimes(2); expect(context).toHaveBeenCalledTimes(2);
    expect(build).toHaveBeenCalledWith(expected, expect.any(Date), abort);
    expect(report).toHaveBeenCalledWith(client, user, { schoolId: expected.school_id, academicYearId: expected.year.id, month: expected.month, classId: null, sectionId: null }, abort);
    expect(context).toHaveBeenCalledWith(client, user, expected.school_id, abort);
  });
  it("rejects a display identity mismatch or tampered totals before any remote read", async () => {
    await expect(createOfficeAttendanceReportPdf(client, id(99), officeReport(), signal())).rejects.toThrow("could not be verified");
    await expect(createOfficeAttendanceReportPdf(client, user, officeReport({ month_summary: officePeriod({ percentage: 99 }) }), signal())).rejects.toThrow("could not be verified");
    await expect(createOfficeAttendanceReportPdf(client, user, officeReport({ year: null as never }), signal())).rejects.toMatchObject({ code: "validation" });
    expect(report).not.toHaveBeenCalled(); expect(build).not.toHaveBeenCalled();
  });
  it("rejects data changed before click instead of exporting newer figures against a stale screen", async () => {
    report.mockResolvedValue(officeReport({ calendar_revision: 4 })); context.mockResolvedValue(officeContext({ calendar_revision: 4 }));
    await expect(createOfficeAttendanceReportPdf(client, user, officeReport(), signal())).rejects.toThrow("changed since"); expect(build).not.toHaveBeenCalled();
  });
  it.each([
    { school_name: "Renamed school" }, { calendar_revision: 4 }, { server_today: "2026-11-08" }, { years: [] },
    { years: [{ ...officeReport().year, name: "Changed year", is_current: true }] },
  ])("rejects mismatched context without making a PDF %j", async patch => {
    context.mockResolvedValue(officeContext(patch)); await expect(createOfficeAttendanceReportPdf(client, user, officeReport(), signal())).rejects.toThrow("changed"); expect(build).not.toHaveBeenCalled();
  });
  it("rechecks source changes and live access after asynchronous font/PDF work", async () => {
    report.mockResolvedValueOnce(officeReport()).mockResolvedValueOnce(officeReport({ school_name: "Renamed school" }));
    context.mockResolvedValueOnce(officeContext()).mockResolvedValueOnce(officeContext({ school_name: "Renamed school", schools: [{ id: officeReport().school_id, name: "Renamed school" }] }));
    await expect(createOfficeAttendanceReportPdf(client, user, officeReport(), signal())).rejects.toThrow("changed while");
    report.mockReset().mockResolvedValueOnce(officeReport()).mockRejectedValueOnce(new OfficeAttendanceReportError("Office access revoked", "access")); context.mockResolvedValue(officeContext());
    await expect(createOfficeAttendanceReportPdf(client, user, officeReport(), signal())).rejects.toMatchObject({ code: "access" });
  });
  it("leaves explicit missing mark percentages null and still permits a labelled incomplete PDF", async () => {
    const missing = officePeriod({ state: "attendance_incomplete", complete_pupils: 2, incomplete_pupils: 1, marked_days: 14, unmarked_days: 1, absent_days: 0, percentage: null });
    const expected = officeReport({ month_summary: missing, year_summary: missing }); report.mockResolvedValue(expected);
    await createOfficeAttendanceReportPdf(client, user, expected, signal()); expect(build.mock.calls[0][0].month_summary.percentage).toBeNull();
  });
  it("does not release delayed generated bytes after a scope change", async () => {
    const pending = deferred<{ bytes: Uint8Array; filename: string }>(), controller = new AbortController(); build.mockReturnValue(pending.promise);
    const result = createOfficeAttendanceReportPdf(client, user, officeReport(), controller.signal); await vi.waitFor(() => expect(build).toHaveBeenCalled());
    controller.abort(); pending.resolve({ bytes, filename }); await expect(result).rejects.toMatchObject({ name: "AbortError" }); expect(report).toHaveBeenCalledTimes(1);
  });
  it.each([{ bytes: new Uint8Array(8), filename }, { bytes, filename: "wrong.pdf" }])("rejects unverified renderer bytes or filename", async result => {
    build.mockResolvedValue(result); await expect(createOfficeAttendanceReportPdf(client, user, officeReport(), signal())).rejects.toThrow("PDF could not be verified");
  });
  it("downloads one local PDF and cleans its temporary URL without upload or navigation", async () => {
    vi.useFakeTimers(); const createUrl = vi.fn().mockReturnValue("blob:test-only"), revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: createUrl, revokeObjectURL: revoke }); const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      await downloadOfficeAttendanceReportPdf(client, user, officeReport(), signal());
      expect(createUrl.mock.calls[0][0]).toBeInstanceOf(Blob); expect(createUrl.mock.calls[0][0].type).toBe("application/pdf"); expect(click).toHaveBeenCalledTimes(1); expect(document.querySelector('a[download]')).toBeNull();
      vi.advanceTimersByTime(30000); expect(revoke).toHaveBeenCalledWith("blob:test-only");
    } finally { vi.useRealTimers(); }
  });
});
