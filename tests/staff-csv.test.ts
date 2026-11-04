import { describe, expect, it } from "vitest";
import { maxStaffCsvBytes, parseStaffCsv, staffCsvTemplate } from "@/lib/teachers/staff-csv";

const header = "employee_id,full_name,staff_type\n";

describe("staff CSV preview", () => {
  it("accepts both staff types, names in Hindi and quoted comma fields", () => {
    expect(parseStaffCsv(staffCsvTemplate)).toHaveLength(2);
    expect(parseStaffCsv("\uFEFF" + header + ' EMP-01 ,"Sharma, Asha",Teacher\r\nEMP-02,रवि सिंह,staff\r\n'))
      .toEqual([
        { employeeId: "EMP-01", fullName: "Sharma, Asha", staffType: "teacher", rowNumber: 1, issue: undefined },
        { employeeId: "EMP-02", fullName: "रवि सिंह", staffType: "staff", rowNumber: 2, issue: undefined },
      ]);
  });

  it("reports invalid rows and case-insensitive duplicates across types", () => {
    expect(parseStaffCsv(header + "EMP-01,Asha,teacher\n emp-01 ,Ravi,staff\nEMP-03,Anu,school_admin\nEMP-04,Salma"))
      .toEqual([
        expect.objectContaining({ rowNumber: 1, issue: "Employee ID repeats in this file." }),
        expect.objectContaining({ rowNumber: 2, issue: "Employee ID repeats in this file." }),
        expect.objectContaining({ rowNumber: 3, issue: "Use teacher or staff." }),
        expect.objectContaining({ rowNumber: 4, issue: "Expected three columns." }),
      ]);
  });

  it("rejects malformed headers, quoting and unbounded uploads", () => {
    expect(() => parseStaffCsv("employee_id,full_name\nEMP,Asha")).toThrow("template columns");
    expect(() => parseStaffCsv(header + 'EMP,"Unclosed,teacher')).toThrow("closing quote");
    expect(() => parseStaffCsv(header + Array.from({ length: 51 }, (_, index) => index + ",Name,staff").join("\n")))
      .toThrow("between 1 and 50");
    expect(() => parseStaffCsv(header + "र".repeat(maxStaffCsvBytes / 2))).toThrow("64 KB");
  });
});
