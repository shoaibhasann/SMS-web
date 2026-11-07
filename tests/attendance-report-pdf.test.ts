// @vitest-environment node
import { readFile } from "node:fs/promises";
import { PDFDocument, PDFPage } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttendanceReportPdfError, buildAttendanceReportPdf, type AttendanceReportPdfInput } from "@/lib/attendance/report-pdf";
import { attendanceSummaryFixture, emptySummaryPeriod, previousAttendanceSummaryFixture, summaryPeriod } from "./attendance-summary-fixture";

const at = new Date("2026-11-07T14:30:00Z");
const input = (patch: Partial<AttendanceReportPdfInput> = {}): AttendanceReportPdfInput => ({
  summary: attendanceSummaryFixture(), schoolName: "SMS QA School", studentName: "Aadhya Sharma", admissionNo: "QA-001", generatedAt: at, ...patch,
});
const drawn = () => vi.mocked(PDFPage.prototype.drawText).mock.calls.map(call => call[0]).join("\n");
beforeEach(() => {
  vi.spyOn(PDFPage.prototype, "drawText");
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    expect(["/fonts/NotoSans-Regular.ttf", "/fonts/NotoSansDevanagari-Regular.ttf"]).toContain(path);
    return new Response(await readFile(new URL(`../public${path}`, import.meta.url)));
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("official attendance PDF", () => {
  it("creates a valid A4 PDF with selected scope, verified counts, IST generation and non-PII filename", async () => {
    const result = await buildAttendanceReportPdf(input());
    expect(new TextDecoder().decode(result.bytes.slice(0, 5))).toBe("%PDF-");
    const document = await PDFDocument.load(result.bytes);
    expect(document.getPageCount()).toBe(1);
    expect(document.getPage(0).getWidth()).toBeCloseTo(595.28);
    expect(document.getPage(0).getHeight()).toBeCloseTo(841.89);
    expect(document.getTitle()).toBe("Official attendance - 2026-11");
    expect(document.getCreationDate()).toEqual(at);
    expect(result.filename).toBe("attendance-2026-04-01-2027-03-31-2026-11.pdf");
    expect(drawn()).toContain("Student: Aadhya Sharma");
    expect(drawn()).toContain("Admission no.: QA-001");
    expect(drawn()).toContain("Reporting month: November 2026");
    expect(drawn()).toContain("Generated: 7 Nov 2026, 20:00 IST");
    expect(drawn()).toContain("70%");
    expect(drawn()).toContain("School calendar revision: 3");
    expect(drawn()).toContain("Half Day = 0.5");
    expect(drawn()).toContain("not a digitally signed certificate");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the archive year, selected month and year-end cutoff instead of using today's current year", async () => {
    const period = summaryPeriod({ from: "2026-03-25", to: "2026-03-31", working_days: 6, closed_days: 1, marked_days: 6,
      present_days: 2, late_days: 1, half_days: 1, leave_days: 1, absent_days: 1, percentage: 58.33 });
    const summary = previousAttendanceSummaryFixture({ month_summary: period, year_summary: period });
    const result = await buildAttendanceReportPdf(input({ summary }));
    expect(result.filename).toBe("attendance-2025-04-01-2026-03-31-2026-03.pdf");
    expect(drawn()).toContain("Reporting month: March 2026");
    expect(drawn()).toContain("Records through: 31 Mar 2026 (IST)");
    expect(drawn().match(/58\.33%/g)).toHaveLength(2);
    expect(drawn()).not.toContain("Records through: 7 Nov 2026");
  });

  it.each([
    ["attendance_incomplete", summaryPeriod({ state: "attendance_incomplete", percentage: null, marked_days: 4, unmarked_days: 1, absent_days: 0 })],
    ["calendar_unconfigured", summaryPeriod({ state: "calendar_unconfigured", percentage: null, enrollment_days: 8, unconfigured_days: 1, to: "2026-11-08" })],
    ["enrollment_unverified", emptySummaryPeriod("enrollment_unverified")],
  ] as const)("withholds misleading percentages for %s", async (_state, period) => {
    const summary = attendanceSummaryFixture({ server_today: "2026-11-08", month_summary: period, year_summary: period });
    await buildAttendanceReportPdf(input({ summary }));
    expect(drawn()).toContain("Not available");
    expect(drawn()).toContain("Percentage withheld");
    expect(drawn()).not.toContain("0%");
    expect(drawn()).not.toContain("70%");
  });

  it("renders Hindi and Latin labels through embedded subset fonts", async () => {
    const result = await buildAttendanceReportPdf(input({ schoolName: "नवभारत SMS School", studentName: "Aadhya शर्मा", admissionNo: "कक्षा-01" }));
    const document = await PDFDocument.load(result.bytes);
    expect(document.getPageCount()).toBe(1);
    expect(drawn()).toContain("नवभारत");
    expect(drawn()).toContain("शर्मा");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.bytes.length).toBeLessThan(150_000);
  });

  it("wraps long names and unbroken admission numbers over clean numbered pages without dropping the ending", async () => {
    const result = await buildAttendanceReportPdf(input({ schoolName: "Navbharat School ".repeat(70) + "SCHOOL-END",
      studentName: "विद्यार्थी ".repeat(100) + "NAME-END", admissionNo: "A".repeat(1300) + "ADMISSION-END" }));
    const document = await PDFDocument.load(result.bytes);
    expect(document.getPageCount()).toBeGreaterThan(1);
    expect(document.getPageCount()).toBeLessThan(8);
    expect(drawn()).toContain("SCHOOL-END");
    expect(drawn()).toContain("NAME-END");
    expect(drawn()).toContain("ADMISSION-END");
    expect(drawn()).toContain(`Page ${document.getPageCount()} of ${document.getPageCount()}`);
    for (const [, options] of vi.mocked(PDFPage.prototype.drawText).mock.calls) {
      expect(options?.y).toBeGreaterThanOrEqual(25);
      expect(options?.y).toBeLessThan(842);
    }
  });

  it("rejects unsupported glyphs rather than silently replacing a student's name", async () => {
    await expect(buildAttendanceReportPdf(input({ studentName: "Student 🏫" }))).rejects.toThrow("unsupported characters");
  });
  it.each(["A\nB", "Student\u202eName", "A".repeat(2001), " "])("rejects control or unbounded identity labels", async studentName => {
    await expect(buildAttendanceReportPdf(input({ studentName }))).rejects.toBeInstanceOf(AttendanceReportPdfError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects malformed summary totals before rendering", async () => {
    const summary = attendanceSummaryFixture({ month_summary: summaryPeriod({ working_days: 200 }) });
    await expect(buildAttendanceReportPdf(input({ summary }))).rejects.toThrow("could not be verified");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not export a missing academic setup or invalid generated timestamp", async () => {
    const summary = attendanceSummaryFixture({ session_state: "missing", year: null, month_summary: null, year_summary: null });
    await expect(buildAttendanceReportPdf(input({ summary }))).rejects.toThrow("Choose a supported academic year");
    await expect(buildAttendanceReportPdf(input({ generatedAt: new Date("bad") }))).rejects.toThrow("Choose a supported academic year");
  });
  it("gives actionable font failure and rejects cancelled work", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("not a font"));
    await expect(buildAttendanceReportPdf(input())).rejects.toThrow("PDF fonts could not be loaded");
    vi.mocked(fetch).mockClear();
    const controller = new AbortController(); controller.abort();
    await expect(buildAttendanceReportPdf(input(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
