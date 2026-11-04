import { readCsvRows, validCsvCell } from "@/lib/csv";
import type { RosterAdmission } from "./roster";

export const maxRosterImportStudents = 50;
export const maxRosterCsvBytes = 64 * 1024;
export const rosterCsvTemplate = "admission_number,first_name,last_name\nEXAMPLE-001,Asha,Sharma\n";

export function parseRosterCsv(text: string): RosterAdmission[] {
  if (new TextEncoder().encode(text).byteLength > maxRosterCsvBytes) {
    throw new Error("Choose a CSV file that is 64 KB or smaller.");
  }
  const [header, ...rows] = readCsvRows(text);
  if (header?.length !== 3 || header.map((value) => value.trim()).join(",") !== "admission_number,first_name,last_name") {
    throw new Error("Use the template columns in this order: admission_number, first_name, last_name.");
  }
  if (rows.length < 1 || rows.length > maxRosterImportStudents) {
    throw new Error(`Include between 1 and ${maxRosterImportStudents} student rows.`);
  }

  const seen = new Set<string>();
  return rows.map((row, index) => {
    const rowNumber = index + 1;
    if (row.length !== 3) throw new Error(`Student row ${rowNumber} needs three columns. Leave last name blank if unused.`);
    const [admissionNumber, firstName, lastName] = row.map((value) => value.trim());
    if (!admissionNumber || !firstName
      || !validCsvCell(admissionNumber, 64) || !validCsvCell(firstName, 100) || !validCsvCell(lastName, 100)) {
      throw new Error(`Student row ${rowNumber} needs a valid admission number and first name. Check field lengths and line breaks.`);
    }
    if (seen.has(admissionNumber)) throw new Error(`Student row ${rowNumber} repeats an admission number from this file.`);
    seen.add(admissionNumber);
    return { admissionNumber, firstName, lastName };
  });
}
