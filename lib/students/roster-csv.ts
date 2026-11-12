import { csvCalendarDate } from "@/lib/attendance/calendar";
import { schoolDate } from "@/lib/attendance/types";
import { normalizeIndianMobile } from "@/lib/auth/phone";
import { readCsvRows, validCsvCell } from "@/lib/csv";
import { plainRosterText, type RosterAdmission } from "./roster";

export const maxRosterImportStudents = 50;
export const maxRosterCsvBytes = 64 * 1024;
const legacyHeader = "admission_number,first_name,last_name";
const header = `${legacyHeader},date_of_birth,registered_mobile`;
export const rosterCsvTemplate = `${header}\nEXAMPLE-001,Asha,Sharma,2014-06-15,9876543210\n`;

export function parseRosterCsv(text: string): RosterAdmission[] {
  if (new TextEncoder().encode(text).byteLength > maxRosterCsvBytes) {
    throw new Error("Choose a CSV file that is 64 KB or smaller.");
  }
  const [columns, ...rows] = readCsvRows(text);
  const columnNames = columns?.map((value) => value.trim()).join(",");
  const width = columns?.length;
  // Files made from the older three-column template still import, without DOB and mobile.
  if (!(width === 5 && columnNames === header) && !(width === 3 && columnNames === legacyHeader)) {
    throw new Error("Use the template columns in this order: admission_number, first_name, last_name, date_of_birth, registered_mobile.");
  }
  if (rows.length < 1 || rows.length > maxRosterImportStudents) {
    throw new Error(`Include between 1 and ${maxRosterImportStudents} student rows.`);
  }

  const seen = new Set<string>();
  const today = schoolDate(); // the server rejects a DOB before 1900 or after today in IST
  return rows.map((row, index) => {
    const rowNumber = index + 1;
    if (row.length !== width) throw new Error(`Student row ${rowNumber} needs ${width === 3 ? "three" : "five"} columns. Leave optional values blank if unused.`);
    const [admissionNumber, firstName, lastName, dobCell = "", mobile = ""] = row.map((value) => value.trim());
    if (!admissionNumber || !firstName
      || !validCsvCell(admissionNumber, 64) || !validCsvCell(firstName, 100) || !validCsvCell(lastName, 100)) {
      throw new Error(`Student row ${rowNumber} needs a valid admission number and first name. Check field lengths and line breaks.`);
    }
    const key = plainRosterText(admissionNumber).toLowerCase(); // the server key: format marks stripped, case-insensitive
    if (seen.has(key)) throw new Error(`Student row ${rowNumber} repeats an admission number from this file.`);
    seen.add(key);
    const dateOfBirth = dobCell && csvCalendarDate(dobCell);
    if (dateOfBirth === undefined) throw new Error(`Student row ${rowNumber} needs date_of_birth as YYYY-MM-DD or DD-MM-YYYY, or blank.`);
    if (dateOfBirth && (dateOfBirth < "1900-01-01" || dateOfBirth > today)) {
      throw new Error(`Student row ${rowNumber} needs a date_of_birth from 1900-01-01 to today, or blank.`);
    }
    const registeredMobile = mobile ? normalizeIndianMobile(mobile)?.slice(3) : "";
    if (registeredMobile === undefined) throw new Error(`Student row ${rowNumber} needs a valid 10-digit registered_mobile, or blank.`);
    return { admissionNumber, firstName, lastName, ...(dateOfBirth ? { dateOfBirth } : {}), ...(registeredMobile ? { registeredMobile } : {}) };
  });
}
