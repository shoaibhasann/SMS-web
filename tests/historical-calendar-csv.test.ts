import { describe, expect, it } from "vitest";
import { historicalCalendarCsvMaxBytes, historicalCalendarCsvMaxRows, parseHistoricalCalendarCsv } from "@/lib/attendance/historical-calendar-csv";
const csv = (rows: string) => `date,status,label\n${rows}\n`;
describe("historical school calendar CSV", () => {
  it("parses explicit working and holiday dates with quoted labels, BOM and CRLF", () => {
    expect(parseHistoricalCalendarCsv('\uFEFFdate,status,label\r\n2024-02-29,working,"Extra day, approved"\r\n2024-03-01,holiday,"School \\"break\\""\r\n'.replaceAll('\\"', '""'))).toEqual([
      { rowNumber: 1, day: "2024-02-29", status: "working", label: "Extra day, approved", issue: undefined },
      { rowNumber: 2, day: "2024-03-01", status: "holiday", label: 'School "break"', issue: undefined },
    ]);
  });
  it.each(["2026-02-29", "2026-02-30", "2026-13-01", "0000-01-01", "2026-1-01", "07/11/2026"])("rejects non-civil date %s", day => {
    expect(parseHistoricalCalendarCsv(csv(`${day},working,School day`))[0].issue).toMatch(/real date/);
  });
  it.each(["WORKING", "closed", "leave", "", "inherit"])("rejects unsupported decision %s", status => {
    expect(parseHistoricalCalendarCsv(csv(`2026-10-01,${status},School day`))[0].issue).toMatch(/working or holiday/);
  });
  it("marks every repeated date rather than silently discarding one decision", () => {
    const rows = parseHistoricalCalendarCsv(csv("2026-10-01,working,School day\n2026-10-02,holiday,Break\n2026-10-01,holiday,Contradiction"));
    expect(rows.map(row => row.issue)).toEqual(["Date repeats in this file.", undefined, "Date repeats in this file."]);
  });
  it.each(["", "x".repeat(121), "\tSchool day", "School\u007fday", "School\u0085day", '"School day\n"'])("rejects empty, oversized and control-containing labels", label => {
    expect(parseHistoricalCalendarCsv(csv(`2026-10-01,working,${label}`))[0].issue).toBeTruthy();
  });
  it("trims ordinary spaces, preserves Unicode labels and validates malformed columns/quotes", () => {
    expect(parseHistoricalCalendarCsv(csv(" 2026-10-01 , working , विद्यालय खुला "))[0]).toMatchObject({ day: "2026-10-01", label: "विद्यालय खुला", issue: undefined });
    expect(parseHistoricalCalendarCsv(csv("2026-10-01,working"))[0].issue).toMatch(/three columns/);
    expect(parseHistoricalCalendarCsv(csv("2026-10-01,working,School,extra"))[0].issue).toMatch(/three columns/);
    expect(() => parseHistoricalCalendarCsv(csv('2026-10-01,working,"Unclosed'))).toThrow(/closing quote/);
  });
  it("requires exact template headers and a bounded nonempty file", () => {
    for (const invalid of ["date,status,label\n", "status,date,label\nworking,2026-10-01,Day", "DATE,status,label\n2026-10-01,working,Day"]) expect(() => parseHistoricalCalendarCsv(invalid)).toThrow();
    expect(() => parseHistoricalCalendarCsv(csv(`2026-10-01,working,${"x".repeat(historicalCalendarCsvMaxBytes)}`))).toThrow(/64 KB/);
    expect(() => parseHistoricalCalendarCsv(csv(Array.from({ length: historicalCalendarCsvMaxRows + 1 }, () => "2026-10-01,working,Day").join("\n")))).toThrow(/366/);
  });
});
