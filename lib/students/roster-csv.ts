import type { RosterAdmission } from "./roster";

export const maxRosterImportStudents = 50;
export const maxRosterCsvBytes = 64 * 1024;
export const rosterCsvTemplate = "admission_number,first_name,last_name\nEXAMPLE-001,Asha,Sharma\n";

function readCsvRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let mode: "bare" | "quoted" | "closed" = "bare";
  const csv = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

  function finishField() {
    row.push(value);
    value = "";
    mode = "bare";
  }

  function finishRow() {
    finishField();
    if (row.length > 1 || row[0].trim()) rows.push(row);
    row = [];
  }

  for (let position = 0; position < csv.length; position += 1) {
    const character = csv[position];
    if (mode === "quoted") {
      if (character !== '"') value += character;
      else if (csv[position + 1] === '"') {
        value += '"';
        position += 1;
      } else mode = "closed";
      continue;
    }

    if (character === ",") finishField();
    else if (character === "\n") finishRow();
    else if (mode === "closed" || (character === '"' && value)) {
      throw new Error("A quoted CSV field is malformed. Check the file against the template.");
    } else if (character === '"') mode = "quoted";
    else value += character;
  }

  if (mode === "quoted") throw new Error("A quoted CSV field is missing its closing quote.");
  finishRow();
  return rows;
}

function validCell(value: string, maxLength: number) {
  return value.length <= maxLength && !Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  });
}

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
      || !validCell(admissionNumber, 64) || !validCell(firstName, 100) || !validCell(lastName, 100)) {
      throw new Error(`Student row ${rowNumber} needs a valid admission number and first name. Check field lengths and line breaks.`);
    }
    if (seen.has(admissionNumber)) throw new Error(`Student row ${rowNumber} repeats an admission number from this file.`);
    seen.add(admissionNumber);
    return { admissionNumber, firstName, lastName };
  });
}
