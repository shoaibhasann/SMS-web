import "regenerator-runtime/runtime.js";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { parseFamilyAttendanceSummary, type AttendanceSummaryPeriod, type FamilyAttendanceSummary } from "./family-summary";

export class AttendanceReportPdfError extends Error {
  constructor(message: string) { super(message); this.name = "AttendanceReportPdfError"; }
}
export type AttendanceReportPdfInput = {
  summary: FamilyAttendanceSummary; schoolName: string; studentName: string; admissionNo: string; generatedAt: Date;
};
const blue = rgb(0.15, 0.28, 0.69), ink = rgb(0.12, 0.16, 0.23), muted = rgb(0.36, 0.41, 0.49), line = rgb(0.85, 0.88, 0.92);
const width = 595.28, height = 841.89, margin = 42, contentWidth = width - margin * 2;
const dateFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const monthFormat = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
const number = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const dateLabel = (date: string) => dateFormat.format(new Date(`${date}T00:00:00Z`));
const stateLabels: Record<AttendanceSummaryPeriod["state"], string> = {
  complete: "Complete register", calendar_unconfigured: "Calendar setup needed", attendance_incomplete: "Awaiting attendance",
  enrollment_unverified: "Enrollment needs review", inconsistent: "Records need review", no_working_days: "No working days",
  not_enrolled: "No enrollment", not_started: "No elapsed school days",
};
function explanation(period: AttendanceSummaryPeriod) {
  if (period.state === "calendar_unconfigured") return `${period.unconfigured_days} enrolled day(s) have no verified school calendar. Percentage withheld.`;
  if (period.state === "attendance_incomplete") return `${period.unmarked_days} working day(s) are unmarked. Missing marks are not counted as Absent. Percentage withheld.`;
  if (period.state === "enrollment_unverified") return "The school must verify enrollment dates. Percentage withheld.";
  if (period.state === "inconsistent") return "Some working-day records do not match the register. Percentage withheld pending school review.";
  if (period.state === "no_working_days") return "There are no school working days in this enrolled period. A percentage does not apply.";
  if (period.state === "not_enrolled") return "No verified enrollment overlaps this period. A percentage does not apply.";
  if (period.state === "not_started") return "No elapsed enrollment days are available in this period. A percentage does not apply.";
  return "Verified working-day attendance for the enrolled period shown below.";
}
function label(value: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 2000 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new AttendanceReportPdfError("School and student details need review before a PDF can be exported.");
  }
  return value.trim();
}
async function readFont(name: string, signal?: AbortSignal) {
  try {
    const response = await fetch(`/fonts/${name}.ttf`, { signal, credentials: "omit", cache: "force-cache" });
    if (!response.ok || response.redirected) throw new Error("Font unavailable");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 1000 || bytes.length > 2_000_000 || ![0, 1, 0, 0].every((value, index) => bytes[index] === value)) throw new Error("Invalid font");
    return bytes;
  } catch {
    signal?.throwIfAborted();
    throw new AttendanceReportPdfError("PDF fonts could not be loaded. Check your connection and try again.");
  }
}

export async function buildAttendanceReportPdf(input: AttendanceReportPdfInput, signal?: AbortSignal): Promise<{ bytes: Uint8Array; filename: string }> {
  signal?.throwIfAborted();
  const { summary, generatedAt } = input;
  parseFamilyAttendanceSummary(summary, summary.user_id, { id: summary.student_id, school_id: summary.school_id }, summary.role, summary.month);
  if (summary.session_state !== "active" || !summary.year || !summary.month_summary || !summary.year_summary || !Number.isFinite(generatedAt.getTime())) {
    throw new AttendanceReportPdfError("Choose a supported academic year and reporting month before exporting.");
  }
  const schoolName = label(input.schoolName), studentName = label(input.studentName), admissionNo = label(input.admissionNo), yearName = label(summary.year.name);
  const generated = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }).format(generatedAt);
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const latin = await doc.embedFont(await readFont("NotoSans-Regular", signal), { subset: true });
  const hindi = /[\u0900-\u097f]/u.test(`${schoolName}${studentName}${admissionNo}${yearName}`)
    ? await doc.embedFont(await readFont("NotoSansDevanagari-Regular", signal), { subset: true }) : undefined;
  const latinSet = new Set(latin.getCharacterSet()), hindiSet = new Set(hindi?.getCharacterSet());
  const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
  function runs(value: string): { text: string; font: PDFFont }[] {
    const result: { text: string; font: PDFFont }[] = [];
    for (const { segment } of graphemes.segment(value)) {
      const codepoints = [...segment].map(character => character.codePointAt(0)!);
      const font = codepoints.every(codepoint => latinSet.has(codepoint)) ? latin
        : hindi && codepoints.every(codepoint => hindiSet.has(codepoint)) ? hindi : undefined;
      if (!font) throw new AttendanceReportPdfError("PDF export supports Latin and Hindi text. Ask the school to review unsupported characters in the school, student or year details.");
      const previous = result.at(-1);
      if (previous?.font === font) previous.text += segment; else result.push({ text: segment, font });
    }
    return result;
  }
  const measure = (value: string, size: number) => runs(value).reduce((sum, run) => sum + run.font.widthOfTextAtSize(run.text, size), 0);
  function wrap(value: string, size: number, maxWidth = contentWidth) {
    const lines: string[] = []; let current = "";
    for (const word of value.split(/\s+/u)) {
      const candidate = current ? `${current} ${word}` : word;
      if (measure(candidate, size) <= maxWidth) { current = candidate; continue; }
      if (current) { lines.push(current); current = ""; }
      if (measure(word, size) <= maxWidth) { current = word; continue; }
      for (const { segment } of graphemes.segment(word)) {
        if (current && measure(current + segment, size) > maxWidth) { lines.push(current); current = ""; }
        current += segment;
      }
    }
    if (current) lines.push(current);
    return lines;
  }
  let page: PDFPage, y = 0;
  function draw(value: string, x: number, baseline: number, size: number, color = ink) {
    for (const run of runs(value)) {
      page.drawText(run.text, { x, y: baseline, size, font: run.font, color });
      x += run.font.widthOfTextAtSize(run.text, size);
    }
  }
  function newPage() {
    signal?.throwIfAborted();
    page = doc.addPage([width, height]);
    page.drawRectangle({ x: 0, y: height - 8, width, height: 8, color: blue });
    draw("SMS  |  OFFICIAL ATTENDANCE", margin, height - 32, 8, blue);
    y = height - 59;
  }
  function reserve(space: number) { if (y - space < 54) newPage(); }
  function paragraph(value: string, size = 10, color = ink, leading = size * 1.55) {
    for (const row of wrap(value, size)) { reserve(leading); draw(row, margin, y, size, color); y -= leading; }
  }
  newPage();
  paragraph(schoolName, 16, ink, 23);
  paragraph("Official attendance report", 21, blue, 31);
  paragraph(`Student: ${studentName}`, 12, ink, 19);
  paragraph(`Admission no.: ${admissionNo}`, 9, muted, 15);
  y -= 6;
  paragraph(`Academic year: ${yearName}`, 10, ink, 16);
  paragraph(`${dateLabel(summary.year.start_date)} - ${dateLabel(summary.year.end_date)} | Reporting month: ${monthFormat.format(new Date(`${summary.month}T00:00:00Z`))}`, 9, muted, 15);
  const cutoff = summary.year.end_date < summary.server_today ? summary.year.end_date : summary.server_today;
  paragraph(`Records through: ${dateLabel(cutoff)} (IST) | Generated: ${generated} IST`, 8, muted, 14);
  y -= 11;
  function period(title: string, value: AttendanceSummaryPeriod) {
    const rows: [string, number, string, number][] = [
      ["Working days", value.working_days, "Closed days excluded", value.closed_days],
      ["Earned days", value.earned_days, "Unmarked working days", value.unmarked_days],
      ["Present", value.present_days, "Late", value.late_days],
      ["Half Day", value.half_days, "Leave", value.leave_days],
      ["Absent", value.absent_days, "Records to review", value.invalid_days],
      ["Calendar unconfigured", value.unconfigured_days, "Enrolled calendar days", value.enrollment_days],
    ];
    const explanationRows = wrap(explanation(value), 8.5);
    reserve(80 + explanationRows.length * 13 + rows.length * 18);
    page.drawLine({ start: { x: margin, y: y + 7 }, end: { x: width - margin, y: y + 7 }, thickness: 0.75, color: line });
    draw(title, margin, y - 7, 12, blue);
    draw(value.percentage === null ? "Not available" : `${number.format(value.percentage)}%`, margin, y - 36, value.percentage === null ? 16 : 24);
    draw(stateLabels[value.state], margin + 240, y - 29, 9, value.state === "complete" ? blue : muted);
    y -= 52;
    paragraph(explanation(value), 8.5, muted, 13);
    paragraph(value.from && value.to ? `${dateLabel(value.from)} - ${dateLabel(value.to)}` : "No verified elapsed reporting range", 8, muted, 13);
    y -= 3;
    for (const [left, leftValue, right, rightValue] of rows) {
      page.drawRectangle({ x: margin, y: y - 8, width: contentWidth, height: 18, color: rgb(0.96, 0.97, 0.99) });
      draw(left, margin + 8, y - 2, 8); draw(number.format(leftValue), margin + 215, y - 2, 9, blue);
      draw(right, margin + 265, y - 2, 8); draw(number.format(rightValue), width - margin - 26, y - 2, 9, blue);
      y -= 18;
    }
    y -= 19;
  }
  period("Monthly attendance", summary.month_summary);
  period("Academic session attendance", summary.year_summary);
  reserve(88);
  paragraph("CALCULATION & RECORD NOTES", 8, blue, 15);
  paragraph("Present/Late = 1 day; Half Day = 0.5; Leave/Absent = 0. School-closed days are excluded. An unmarked working day never becomes an assumed absence. The enrolled period uses verified historical placement and school calendar records.", 8, muted, 12);
  paragraph(`Formula: ${summary.formula} | School calendar revision: ${summary.calendar_revision}`, 8, muted, 14);
  paragraph("This export reflects the verified records available when generated, including approved corrections. It is not a digitally signed certificate. Downloaded files remain available to their holder after account or child-link access changes.", 8, muted, 12);
  for (const [index, item] of doc.getPages().entries()) {
    page = item;
    page.drawLine({ start: { x: margin, y: 39 }, end: { x: width - margin, y: 39 }, thickness: 0.5, color: line });
    draw("SMS | Family attendance report", margin, 25, 7, muted);
    draw(`Page ${index + 1} of ${doc.getPageCount()}`, width - margin - 65, 25, 7, muted);
  }
  doc.setTitle(`Official attendance - ${summary.month.slice(0, 7)}`);
  doc.setAuthor("SMS"); doc.setCreator("SMS School Management System");
  doc.setCreationDate(generatedAt); doc.setModificationDate(generatedAt);
  signal?.throwIfAborted();
  const bytes = await doc.save();
  signal?.throwIfAborted();
  return { bytes, filename: `attendance-${summary.year.start_date}-${summary.year.end_date}-${summary.month.slice(0, 7)}.pdf` };
}
