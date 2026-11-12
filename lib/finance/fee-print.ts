export type FeeDocument = { title: string; schoolName: string; rows: [string, string][] };

export const istDateTime = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
export function formatIstDateTime(value: string | null | undefined) {
  return value ? `${istDateTime.format(new Date(value))} IST` : "—";
}

const schoolDay = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "UTC" });
/** Formats a YYYY-MM-DD school date for display without shifting it across time zones. */
export function formatSchoolDay(value: string | null) {
  return value ? schoolDay.format(new Date(`${value}T00:00:00Z`)) : "—";
}

const tones: Record<string, string> = { paid: "badge text-success", partial: "badge text-warning", pending: "badge text-warning", reversed: "badge text-warning", overdue: "badge text-danger" };
/** Status pill classes shared by the office fee tables, receipts and ledger; unknown statuses stay neutral. */
export function statusTone(status: string) {
  return `${tones[status] ?? "badge bg-[var(--surface-2)]"} capitalize`;
}

/** Opens one receipt or invoice in its own window so Print / Save as PDF never includes the app shell. */
export function printFeeDocument({ title, schoolName, rows }: FeeDocument) {
  const popup = window.open("", "_blank");
  if (!popup) throw new Error("The print window was blocked. Allow popups for this school site and try again.");
  const doc = popup.document;
  doc.title = title;
  const style = doc.createElement("style");
  style.textContent = "body{font:16px/1.6 system-ui,sans-serif;color:#152033;max-width:760px;margin:40px auto;padding:0 24px}h1{font-size:25px;line-height:1.3}body>p:first-child{font-size:18px;font-weight:700;margin:0}dl{display:grid;grid-template-columns:minmax(8rem,38%) 1fr;gap:8px 16px}dt{font-weight:600}dd{margin:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}p{overflow-wrap:anywhere}@media print{body{margin:12mm;max-width:none;padding:0}}";
  doc.head.append(style);
  const school = doc.createElement("p"); school.textContent = schoolName; doc.body.append(school);
  const heading = doc.createElement("h1"); heading.textContent = title; doc.body.append(heading);
  const details = doc.createElement("dl");
  for (const [name, value] of rows) {
    const term = doc.createElement("dt"), description = doc.createElement("dd");
    term.textContent = name; description.textContent = value; details.append(term, description);
  }
  doc.body.append(details);
  const note = doc.createElement("p"); note.textContent = "Generated from SMS records. Times are shown in India Standard Time."; doc.body.append(note);
  popup.opener = null; popup.focus(); popup.print();
}

function csvCell(value: string) {
  // Spreadsheet apps run cells that start with these characters as formulas.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll("\"", "\"\"")}"` : safe;
}

export function feeDocumentCsv({ title, schoolName, rows }: FeeDocument) {
  return [["Field", "Value"], ["School", schoolName], ["Document", title], ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function downloadFeeDocumentCsv(document: FeeDocument, filename: string) {
  const url = URL.createObjectURL(new Blob(["﻿", feeDocumentCsv(document)], { type: "text/csv;charset=utf-8" }));
  const link = window.document.createElement("a");
  link.href = url;
  link.download = filename.replace(/[^\w.-]+/g, "-");
  link.click();
  URL.revokeObjectURL(url);
}
