import { readCsvRows, validCsvCell } from "@/lib/csv";
import { validCalendarDate } from "./calendar";

export const historicalCalendarCsvMaxRows = 366;
export const historicalCalendarCsvMaxBytes = 64 * 1024;
export const historicalCalendarCsvHeader = "date,status,label";
export type HistoricalCalendarStatus = "working" | "holiday";
export type HistoricalCalendarRecord = { day: string; status: HistoricalCalendarStatus; label: string };
export type HistoricalCalendarCsvRow = { rowNumber: number; day: string; status: string; label: string; issue?: string };

export function parseHistoricalCalendarCsv(text: string): HistoricalCalendarCsvRow[] {
  if (new TextEncoder().encode(text).byteLength > historicalCalendarCsvMaxBytes) throw new Error("Choose a CSV file that is 64 KB or smaller.");
  const [header, ...source] = readCsvRows(text);
  if (header?.length !== 3 || header.map(value => value.trim()).join(",") !== historicalCalendarCsvHeader) {
    throw new Error(`Use the template columns in this order: ${historicalCalendarCsvHeader}.`);
  }
  if (!source.length || source.length > historicalCalendarCsvMaxRows) throw new Error(`Include between 1 and ${historicalCalendarCsvMaxRows} dated records.`);
  const rows = source.map((cells, index) => {
    const [day = "", status = "", label = ""] = cells.map(value => value.trim());
    let issue: string | undefined;
    if (cells.length !== 3) issue = "Expected three columns.";
    else if (cells.some(value => !validCsvCell(value, historicalCalendarCsvMaxBytes))) issue = "Remove control characters from this row.";
    else if (!validCalendarDate(day)) issue = "Use a real date in YYYY-MM-DD format.";
    else if (status !== "working" && status !== "holiday") issue = "Use working or holiday exactly.";
    else if (!label || !validCsvCell(label, 120)) issue = "Enter a calendar label of 1–120 characters.";
    return { rowNumber: index + 1, day, status, label, issue };
  });
  const dates = new Map<string, number>();
  for (const row of rows) if (validCalendarDate(row.day)) dates.set(row.day, (dates.get(row.day) ?? 0) + 1);
  return rows.map(row => (dates.get(row.day) ?? 0) > 1 ? { ...row, issue: "Date repeats in this file." } : row);
}
