import { readCsvRows, validCsvCell } from "@/lib/csv";

export const maxStaffCsvBytes = 64 * 1024;
export const maxStaffImportRows = 50;
export const staffCsvTemplate = "employee_id,full_name,staff_type\nEXAMPLE-T01,Asha Sharma,teacher\nEXAMPLE-S01,Ravi Singh,staff\n";

export type StaffImportRow = { employeeId: string; fullName: string; staffType: string };
export type StaffCsvRow = StaffImportRow & { rowNumber: number; issue?: string };

export function staffEmployeeKey(value: string) {
  return value.trim().toLowerCase();
}

export function parseStaffCsv(text: string): StaffCsvRow[] {
  if (new TextEncoder().encode(text).byteLength > maxStaffCsvBytes) {
    throw new Error("Choose a CSV file that is 64 KB or smaller.");
  }
  const [header, ...rows] = readCsvRows(text);
  if (header?.length !== 3 || header.map((value) => value.trim()).join(",") !== "employee_id,full_name,staff_type") {
    throw new Error("Use the template columns in this order: employee_id, full_name, staff_type.");
  }
  if (rows.length < 1 || rows.length > maxStaffImportRows) {
    throw new Error(`Include between 1 and ${maxStaffImportRows} staff records.`);
  }

  const counts = new Map<string, number>();
  const parsed = rows.map((row, index): StaffCsvRow => {
    const [employeeId = "", fullName = "", staffType = ""] = row.map((value) => value.trim());
    const employeeKey = staffEmployeeKey(employeeId);
    if (employeeKey) counts.set(employeeKey, (counts.get(employeeKey) ?? 0) + 1);

    let issue: string | undefined;
    if (row.length !== 3) issue = "Expected three columns.";
    else if (!employeeId || !validCsvCell(employeeId, 64)) issue = "Enter an employee ID of up to 64 characters.";
    else if (!fullName || !validCsvCell(fullName, 160)) issue = "Enter a full name of up to 160 characters.";
    else if (!["teacher", "staff"].includes(staffType.toLowerCase())) issue = "Use teacher or staff.";
    return { employeeId, fullName, staffType: staffType.toLowerCase(), rowNumber: index + 1, issue };
  });

  return parsed.map((row) => !row.issue && (counts.get(staffEmployeeKey(row.employeeId)) ?? 0) > 1
    ? { ...row, issue: "Employee ID repeats in this file." }
    : row);
}
