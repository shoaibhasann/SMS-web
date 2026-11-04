import { readCsvRows, validCsvCell } from "@/lib/csv";

export const maxGuardianImportRows = 50;
export const maxGuardianCsvBytes = 64 * 1024;
export const guardianCsvTemplate = "admission_number,guardian_email\nEXAMPLE-001,guardian@example.test\n";

export type GuardianCsvRow = {
  rowNumber: number;
  admissionNumber: string;
  email: string;
  error: string | null;
};

export function parseGuardianCsv(text: string): GuardianCsvRow[] {
  if (new TextEncoder().encode(text).byteLength > maxGuardianCsvBytes) {
    throw new Error("Choose a CSV file that is 64 KB or smaller.");
  }
  const [header, ...rows] = readCsvRows(text);
  if (header?.length !== 2 || header.map((value) => value.trim()).join(",") !== "admission_number,guardian_email") {
    throw new Error("Use the template columns in this order: admission_number, guardian_email.");
  }
  if (!rows.length || rows.length > maxGuardianImportRows) {
    throw new Error(`Include between 1 and ${maxGuardianImportRows} guardian invitation rows.`);
  }

  const firstRowByPair = new Map<string, number>();
  return rows.map((row, index) => {
    const [admissionNumber = "", recipient = ""] = row.map((value) => value.trim());
    const email = recipient.toLowerCase();
    const rowNumber = index + 1;
    let error = null;

    if (row.length !== 2) error = "Use one admission number and one guardian email per row.";
    else if (!admissionNumber || !validCsvCell(admissionNumber, 64)) error = "Enter a valid admission number up to 64 characters.";
    else if (!validCsvCell(email, 254) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) error = "Enter a valid guardian email address.";
    else {
      const pair = JSON.stringify([admissionNumber, email]);
      const firstRow = firstRowByPair.get(pair);
      if (firstRow) error = `This student and email already appear in row ${firstRow}.`;
      else firstRowByPair.set(pair, rowNumber);
    }

    return { rowNumber, admissionNumber, email, error };
  });
}
