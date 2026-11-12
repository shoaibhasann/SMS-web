import { describe, expect, it } from "vitest";
import { parseHistoricalCalendarCsv } from "@/lib/attendance/historical-calendar-csv";
const csv = (rows: string) => `date,status,label\n${rows}\n`;

describe("historical calendar CSV saved by a spreadsheet", () => {
  it("accepts Excel en-IN DD-MM-YYYY dates and capitalised decisions, normalising them for the server", () => {
    expect(parseHistoricalCalendarCsv(csv("14-04-2025,Holiday,Ambedkar Jayanti\n15-04-2025,WORKING,School day\n,,"))).toEqual([
      { rowNumber: 1, day: "2025-04-14", status: "holiday", label: "Ambedkar Jayanti", issue: undefined },
      { rowNumber: 2, day: "2025-04-15", status: "working", label: "School day", issue: undefined },
    ]);
  });
  it("still rejects impossible DD-MM-YYYY dates and catches the same date written both ways", () => {
    expect(parseHistoricalCalendarCsv(csv("30-02-2025,working,Day"))[0].issue).toMatch(/real date/);
    expect(parseHistoricalCalendarCsv(csv("1-4-2025,working,Day"))[0].issue).toMatch(/real date/);
    expect(parseHistoricalCalendarCsv(csv("14-04-2025,working,Day\n2025-04-14,holiday,Other")).map(row => row.issue)).toEqual(["Date repeats in this file.", "Date repeats in this file."]);
  });
});
