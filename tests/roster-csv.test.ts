import { describe, expect, it } from "vitest";
import { parseRosterCsv } from "@/lib/students/roster-csv";

// Legacy three-column files keep importing; the five-column template is covered in roster-csv-identity.test.ts.
const header = "admission_number,first_name,last_name";

describe("student CSV preview", () => {
  it("parses a spreadsheet export with BOM, CRLF, escaped quotes and optional last names", () => {
    const csv = `\uFEFF${header}\r\nQA-001,"Asha, ""Ash""",Sharma\r\nQA-002,  Meera  ,\r\n\r\n`;
    expect(parseRosterCsv(csv)).toEqual([
      { admissionNumber: "QA-001", firstName: 'Asha, "Ash"', lastName: "Sharma" },
      { admissionNumber: "QA-002", firstName: "Meera", lastName: "" },
    ]);
  });

  it("rejects malformed fields, missing headers and repeated admission numbers before import", () => {
    expect(() => parseRosterCsv(`${header}\nA,"Missing quote,`)).toThrow(/closing quote/);
    expect(() => parseRosterCsv(`${header}\nA,"Quote"suffix,`)).toThrow(/malformed/);
    expect(() => parseRosterCsv(`first_name,admission_number,last_name\nAsha,A,Sharma`)).toThrow(/template columns/);
    expect(() => parseRosterCsv(`${header}\nA,Asha\n`)).toThrow(/three columns/);
    expect(() => parseRosterCsv(`${header}\nA,Asha,\n A ,Meera,`)).toThrow(/Student row 2 repeats/);
    expect(() => parseRosterCsv(`${header}\nA,"First\nName",`)).toThrow(/valid admission number and first name/);
  });

  it("limits the number of rows and file bytes", () => {
    expect(() => parseRosterCsv(header)).toThrow(/between 1 and 50/);
    expect(() => parseRosterCsv(`${header}\n${Array.from({ length: 51 }, (_, index) => `${index},Name,`).join("\n")}`))
      .toThrow(/between 1 and 50/);
    expect(() => parseRosterCsv("x".repeat(65537))).toThrow(/64 KB/);
  });
});
