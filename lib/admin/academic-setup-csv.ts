import { readCsvRows, validCsvCell } from "@/lib/csv";
import type { AcademicSetup } from "./academic-setup";

export const academicCsvMaxRows = 50;
export const academicCsvMaxBytes = 64 * 1024;

export const academicCsvTemplates = {
  classes: {
    label: "Classes", singular: "class", detailLabel: "Display order", header: "name,sort_order",
    sample: "Example Class 6,60",
  },
  sections: {
    label: "Sections", singular: "section", detailLabel: "Class name", header: "class_name,name",
    sample: "Example Class 6,A",
  },
  subjects: {
    label: "Subjects", singular: "subject", detailLabel: "Subject code", header: "name,code",
    sample: "Example Science,SCI",
  },
} as const;

export type AcademicImportKind = keyof typeof academicCsvTemplates;
export type AcademicImportRecord =
  | { name: string; sortOrder: number }
  | { name: string; classId: string; className: string }
  | { name: string; code: string };
type CsvRow = { rowNumber: number; name: string; detail: string; issue?: string };

const keyFor = (value: string) => value.trim().toLowerCase();
const sectionKey = (className: string, name: string) => JSON.stringify([className, keyFor(name)]);

export function parseAcademicSetupCsv(text: string, kind: AcademicImportKind): CsvRow[] {
  if (new TextEncoder().encode(text).byteLength > academicCsvMaxBytes) {
    throw new Error("Choose a CSV file that is 64 KB or smaller.");
  }
  const [header, ...rows] = readCsvRows(text);
  if (header?.length !== 2 || header.map((value) => value.trim()).join(",") !== academicCsvTemplates[kind].header) {
    throw new Error(`Use the template columns in this order: ${academicCsvTemplates[kind].header}.`);
  }
  if (rows.length < 1 || rows.length > academicCsvMaxRows) {
    throw new Error(`Include between 1 and ${academicCsvMaxRows} records.`);
  }

  return rows.map((row, index) => {
    const [first = "", second = ""] = row.map((value) => value.trim());
    const [name, detail] = kind === "sections" ? [second, first] : [first, second];
    let issue: string | undefined;
    if (row.length !== 2) issue = "Expected two columns.";
    else if (!name || !validCsvCell(name, 100)) issue = "Enter a name of up to 100 characters.";
    else if (kind === "classes" && !/^\d{1,3}$/.test(detail)) issue = "Use a display order between 0 and 999.";
    else if (kind === "sections" && (!detail || !validCsvCell(detail, 100))) issue = "Enter the exact active class name.";
    else if (kind === "subjects" && !validCsvCell(detail, 30)) issue = "Use a subject code of up to 30 characters.";
    return { rowNumber: index + 1, name, detail, issue };
  });
}

function countNames(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

export function previewAcademicSetupCsv(kind: AcademicImportKind, rows: CsvRow[], setup: AcademicSetup | undefined) {
  const activeClasses = new Map(setup?.classes.filter((item) => item.is_active).map((item) => [item.name, item.id]));
  const namesInFile = countNames(rows.map((row) => kind === "sections" ? sectionKey(row.detail, row.name) : keyFor(row.name)));
  const codesInFile = countNames(rows.map((row) => keyFor(row.detail)));
  const existingNames = new Set(setup?.[kind].map((row) =>
    "class_id" in row ? sectionKey(row.class_id, row.name) : keyFor(row.name)));
  const existingCodes = new Set(setup?.subjects.flatMap((row) => row.code ? [keyFor(row.code)] : []));

  return rows.map((row): CsvRow & { record?: AcademicImportRecord } => {
    if (row.issue) return row;
    const nameKey = kind === "sections" ? sectionKey(row.detail, row.name) : keyFor(row.name);
    if ((namesInFile.get(nameKey) ?? 0) > 1) return { ...row, issue: "Name repeats in this file." };

    switch (kind) {
      case "sections": {
        const classId = activeClasses.get(row.detail);
        if (!classId) return { ...row, issue: "Use an exact name from the active classes in this school." };
        if (existingNames.has(sectionKey(classId, row.name))) return { ...row, issue: "Name already exists in this class." };
        return { ...row, record: { name: row.name, classId, className: row.detail } };
      }
      case "classes":
        if (existingNames.has(nameKey)) return { ...row, issue: "Name already exists in this school." };
        return { ...row, record: { name: row.name, sortOrder: Number(row.detail) } };
      case "subjects": {
        if (existingNames.has(nameKey)) return { ...row, issue: "Name already exists in this school." };
        const code = keyFor(row.detail);
        if (code && (codesInFile.get(code) ?? 0) > 1) return { ...row, issue: "Subject code repeats in this file." };
        if (code && existingCodes.has(code)) return { ...row, issue: "Subject code already exists in this school." };
        return { ...row, record: { name: row.name, code: row.detail } };
      }
    }
  });
}
