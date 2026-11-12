import { describe, expect, it } from "vitest";
import { readCsvRows } from "@/lib/csv";
import { parseHistoricalCalendarCsv } from "@/lib/attendance/historical-calendar-csv";
import { parseRosterCsv } from "@/lib/students/roster-csv";
import { parseStaffCsv } from "@/lib/teachers/staff-csv";

describe("spreadsheet comma-only rows", () => {
  it("drops rows whose cells are all blank, like blank lines", () => {
    expect(readCsvRows("a,b,c\n1,2,3\n,,\n , ,\r\n\n,,")).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
  });
  it("keeps a row with any non-blank cell so it is still validated", () => {
    expect(readCsvRows("a,b,c\n,,x\n")).toEqual([["a", "b", "c"], ["", "", "x"]]);
    expect(parseStaffCsv("employee_id,full_name,staff_type\n,,teacher\n")[0].issue).toBeTruthy();
  });
  it("imports roster, staff and calendar files that end with Excel ',,' rows", () => {
    expect(parseRosterCsv("admission_number,first_name,last_name\nA-1,Asha,S\n,,\n,,\n")).toHaveLength(1);
    const staff = parseStaffCsv("employee_id,full_name,staff_type\nT-1,Asha Sharma,teacher\n,,\n,,\n");
    expect(staff).toHaveLength(1); expect(staff[0].issue).toBeUndefined();
    const calendar = parseHistoricalCalendarCsv("date,status,label\n2025-04-14,holiday,Ambedkar Jayanti\n,,\n");
    expect(calendar).toHaveLength(1); expect(calendar[0].issue).toBeUndefined();
  });
});
