import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeIndianMobile } from "@/lib/auth/phone";
import { parseRosterCsv, rosterCsvTemplate } from "@/lib/students/roster-csv";

const header = rosterCsvTemplate.split("\n")[0];

describe("student CSV date of birth and registered mobile", () => {
  it("offers a five-column template and keeps only filled optional values", () => {
    expect(header).toBe("admission_number,first_name,last_name,date_of_birth,registered_mobile");
    expect(parseRosterCsv(rosterCsvTemplate)).toEqual([
      { admissionNumber: "EXAMPLE-001", firstName: "Asha", lastName: "Sharma", dateOfBirth: "2014-06-15", registeredMobile: "9876543210" },
    ]);
    expect(parseRosterCsv(`${header}\nQA-1,Asha,,2014-02-28,+91 98765-43210\nQA-2,Meera,,,\n`)).toEqual([
      { admissionNumber: "QA-1", firstName: "Asha", lastName: "", dateOfBirth: "2014-02-28", registeredMobile: "9876543210" },
      { admissionNumber: "QA-2", firstName: "Meera", lastName: "" },
    ]);
  });

  it("accepts spreadsheet DD-MM-YYYY dates of birth and sends them as ISO", () => {
    expect(parseRosterCsv(`${header}\nQA-1,Asha,,15-06-2014,\nQA-2,Meera,,2014-06-16,\n`).map(student => student.dateOfBirth)).toEqual(["2014-06-15", "2014-06-16"]);
    expect(() => parseRosterCsv(`${header}\nQA-1,Asha,,30-02-2014,\n`)).toThrow(/DD-MM-YYYY/);
    expect(() => parseRosterCsv(`${header}\nQA-1,Asha,,5-6-2014,\n`)).toThrow(/DD-MM-YYYY/);
    expect(() => parseRosterCsv(`${header}\nQA-1,Asha,,31-12-1899,\n`)).toThrow(/from 1900-01-01 to today/);
  });

  it("rejects bad dates, bad mobiles and short rows before import", () => {
    expect(() => parseRosterCsv(`${header}\nQA-1,Asha,,28/02/2014,\n`)).toThrow("Student row 1 needs date_of_birth as YYYY-MM-DD or DD-MM-YYYY, or blank.");
    expect(() => parseRosterCsv(`${header}\nQA-1,Asha,,2014-02-30,\n`)).toThrow(/YYYY-MM-DD/);
    expect(() => parseRosterCsv(`${header}\nQA-1,Asha,,,12345\n`)).toThrow("Student row 1 needs a valid 10-digit registered_mobile, or blank.");
    expect(() => parseRosterCsv(`${header}\nQA-1,Asha,\n`)).toThrow(/five columns/);
    expect(() => parseRosterCsv(`"admission_number,first_name",last_name\nA,B\n`)).toThrow(/template columns/);
  });

  describe("matches the server's DOB and mobile rules", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("rejects a DOB before 1900 or after today in IST, naming the row", () => {
      vi.useFakeTimers({ now: new Date("2026-11-11T20:00:00Z"), toFake: ["Date"] }); // 01:30 on 12 Nov in IST
      expect(parseRosterCsv(`${header}\nQA-1,Asha,,1900-01-01,\nQA-2,Meera,,2026-11-12,\n`)).toHaveLength(2);
      expect(() => parseRosterCsv(`${header}\nQA-1,Asha,,2014-02-28,\nQA-2,Meera,,1899-12-31,\n`))
        .toThrow("Student row 2 needs a date_of_birth from 1900-01-01 to today, or blank.");
      expect(() => parseRosterCsv(`${header}\nQA-1,Asha,,2026-11-13,\n`)).toThrow(/row 1 needs a date_of_birth from 1900-01-01 to today/);
    });

    it("accepts the same mobile formats the server stores as 10 digits", () => {
      const mobiles = ["09876543210", "919876543210", "+91 (98765) 43210", "98765.43210", "(+91) 98765 43210", "+ 91 98765 43210"];
      expect(parseRosterCsv(`${header}\n${mobiles.map((mobile, index) => `QA-${index},Asha,,,${mobile}`).join("\n")}\n`)
        .map(student => student.registeredMobile)).toEqual(mobiles.map(() => "9876543210"));
      for (const mobile of ["5876543210", "call 9876543210", "+44 9876543210", "+65 9123 4567", "+9876543210", "009876543210"]) {
        expect(() => parseRosterCsv(`${header}\nQA-1,Asha,,,${mobile}\n`)).toThrow("Student row 1 needs a valid 10-digit registered_mobile, or blank.");
      }
      // One shared normaliser: the roster and the sign-in/activation forms accept exactly the same mobiles.
      for (const mobile of [...mobiles, "+9876543210", "98765 43210", "5876543210", "+44 9876543210", "009876543210", "9".repeat(33)]) {
        let roster: string | null;
        try { roster = parseRosterCsv(`${header}\nQA-1,Asha,,,${mobile}\n`)[0].registeredMobile ?? null; } catch { roster = null; }
        expect(roster).toBe(normalizeIndianMobile(mobile)?.slice(3) ?? null);
      }
    });
  });
});
