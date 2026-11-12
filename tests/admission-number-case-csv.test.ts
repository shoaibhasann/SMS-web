import { describe, expect, it } from "vitest";
import { parseGuardianCsv } from "@/lib/guardian-invitations/guardian-csv";
import { parseRosterCsv } from "@/lib/students/roster-csv";

describe("CSV admission numbers are case-insensitive", () => {
  it("rejects roster rows that repeat an admission number in another case", () => {
    expect(() => parseRosterCsv("admission_number,first_name,last_name\nADM-7,Asha,Sharma\nadm-7,Ravi,Kumar\n"))
      .toThrow("Student row 2 repeats an admission number from this file.");
  });
  it("rejects roster rows that differ only by invisible format marks the import strips", () => {
    expect(() => parseRosterCsv("admission_number,first_name,last_name\nADM-1,Asha,Sharma\n⁦adm-1‎,Ravi,Kumar\n"))
      .toThrow("Student row 2 repeats an admission number from this file.");
  });
  it("flags guardian rows that repeat a pupil/email pair in another case", () => {
    const rows = parseGuardianCsv("admission_number,guardian_email\nADM-7,parent@example.test\nadm-7,Parent@Example.test\n");
    expect(rows[1].error).toBe("This student and email already appear in row 1.");
  });
});
