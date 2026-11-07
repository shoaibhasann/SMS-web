// @vitest-environment node
import { readFile } from "node:fs/promises";
import { PDFDocument, PDFPage } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOfficeAttendanceReportPdf } from "@/lib/attendance/report-pdf";
import { emptyOfficePeriod, officePeriod, officeReport } from "./office-attendance-fixture";
const at = new Date("2026-11-07T14:30:00Z"), drawn = () => vi.mocked(PDFPage.prototype.drawText).mock.calls.map(call => call[0]).join("\n");
beforeEach(() => { vi.spyOn(PDFPage.prototype, "drawText"); vi.stubGlobal("fetch", vi.fn(async (path: string) => new Response(await readFile(new URL(`../public${path}`, import.meta.url))))); });
afterEach(() => vi.unstubAllGlobals());
describe("Office official PDF", () => {
  it("exports the selected school/year/month and weighted pupil-day totals without family identity fields", async () => {
    const result = await buildOfficeAttendanceReportPdf(officeReport(), at), document = await PDFDocument.load(result.bytes);
    expect(document.getPage(0).getWidth()).toBeCloseTo(595.28); expect(document.getPage(0).getHeight()).toBeCloseTo(841.89); expect(document.getPageCount()).toBeLessThanOrEqual(2);
    expect(result.filename).toBe("attendance-school-2026-04-01-2027-03-31-2026-11.pdf");
    expect(drawn()).toContain("Scope: Whole school"); expect(drawn()).toContain("Reporting month: November 2026"); expect(drawn()).toContain("Generated: 7 Nov 2026, 20:00 IST");
    expect(drawn()).toContain("Working pupil-days"); expect(drawn()).toContain("Closed pupil-days excluded"); expect(drawn()).toContain("Earned pupil-days"); expect(drawn()).toContain("Pupils requiring review");
    expect(drawn().match(/90%/g)).toHaveLength(2); expect(drawn()).toContain("individual percentages are not averaged"); expect(drawn()).not.toContain("Admission no."); expect(drawn()).not.toContain("Student:");
  });
  it("exports class/section labels and filename without pupil identifiers, with Hindi labels embedded", async () => {
    const expected = officeReport({ school_name: "नवभारत School", scope: { class_id: "70000000-0000-4000-8000-000000000005", class_name: "कक्षा छह", section_id: "70000000-0000-4000-8000-000000000006", section_name: "A" } });
    const result = await buildOfficeAttendanceReportPdf(expected, at);
    expect(result.filename).toBe("attendance-section-2026-04-01-2027-03-31-2026-11.pdf"); expect(drawn()).toContain("कक्षा"); expect(drawn()).toContain("छह"); expect(drawn()).toContain("नवभारत"); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("exports incomplete coverage without a fabricated percentage", async () => {
    const period = officePeriod({ state: "attendance_incomplete", complete_pupils: 2, incomplete_pupils: 1, marked_days: 14, unmarked_days: 1, absent_days: 0, percentage: null });
    await buildOfficeAttendanceReportPdf(officeReport({ month_summary: period, year_summary: period }), at);
    expect(drawn()).toContain("Awaiting attendance"); expect(drawn()).toContain("Not available"); expect(drawn()).toContain("1 working pupil-days are unmarked"); expect(drawn()).not.toContain("0%"); expect(drawn()).not.toContain("90%");
  });
  it("exports no-pupil and before-admission states without inventing a denominator", async () => {
    const empty = emptyOfficePeriod("no_pupils"); await buildOfficeAttendanceReportPdf(officeReport({ pupil_count: 0, month_summary: empty, year_summary: empty }), at);
    expect(drawn()).toContain("No enrolled pupils"); expect(drawn()).toContain("Not available"); expect(drawn()).not.toContain("0%");
  });
  it("keeps large real aggregate counts inside both A4 table columns", async () => {
    const yearly = officePeriod({ from: "2023-04-01", to: "2024-03-31", pupil_count: 1500, complete_pupils: 1500,
      enrollment_days: 549000, working_days: 549000, closed_days: 0, marked_days: 549000, present_days: 548999,
      half_days: 1, absent_days: 0, earned_days: 548999.5, percentage: 100 });
    const monthly = officePeriod({ from: "2024-03-01", to: "2024-03-31", pupil_count: 1500, complete_pupils: 1500,
      enrollment_days: 46500, working_days: 46500, closed_days: 0, marked_days: 46500, present_days: 46500,
      half_days: 0, absent_days: 0, earned_days: 46500, percentage: 100 });
    const result = await buildOfficeAttendanceReportPdf(officeReport({ pupil_count: 1500, month: "2024-03-01",
      year: { id: "70000000-0000-4000-8000-000000000008", name: "2023-24", start_date: "2023-04-01", end_date: "2024-03-31" }, month_summary: monthly, year_summary: yearly }), at);
    const document = await PDFDocument.load(result.bytes); expect(document.getPageCount()).toBe(1);
    expect(document.getPage(0).getWidth()).toBeCloseTo(595.28); expect(document.getPage(0).getHeight()).toBeCloseTo(841.89);
    expect(drawn()).toContain("5,49,000"); expect(drawn()).toContain("5,48,999.5");
    const numericCalls = vi.mocked(PDFPage.prototype.drawText).mock.calls.filter(([text]) => /^[0-9][0-9,]*(\.[0-9]+)?$/.test(text));
    expect(numericCalls.length).toBeGreaterThan(20);
    for (const [text, options] of numericCalls) {
      const right = options!.x! + options!.font!.widthOfTextAtSize(text, options!.size!);
      expect(right).toBeLessThanOrEqual(595.28 - 42 - 8 + 0.001);
      expect(options!.x).toBeGreaterThanOrEqual(42);
      if (options!.x! < 307) expect(right).toBeLessThanOrEqual(42 + 245 + 0.001);
    }
  });
  it("rejects unverified totals, unsupported glyphs and canceled work", async () => {
    await expect(buildOfficeAttendanceReportPdf(officeReport({ month_summary: officePeriod({ percentage: 22 }) }), at)).rejects.toThrow("could not be verified"); expect(fetch).not.toHaveBeenCalled();
    await expect(buildOfficeAttendanceReportPdf(officeReport({ school_name: "School 🏫" }), at)).rejects.toThrow("unsupported characters");
    const controller = new AbortController(); controller.abort(); await expect(buildOfficeAttendanceReportPdf(officeReport(), at, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
