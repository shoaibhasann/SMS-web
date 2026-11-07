import type { SupabaseClient } from "@supabase/supabase-js";
import { loadOfficeAttendanceContext, loadOfficeAttendanceReport, OfficeAttendanceReportError, parseOfficeAttendanceReport, type OfficeAttendanceReport, type OfficeAttendanceScope } from "./office-reports";

export function officeAttendanceReportScope(report: OfficeAttendanceReport): OfficeAttendanceScope {
  return { schoolId: report.school_id, academicYearId: report.year?.id ?? "", month: report.month, classId: report.scope?.class_id ?? null, sectionId: report.scope?.section_id ?? null };
}
export function verifyOfficeAttendanceContext(report: OfficeAttendanceReport, context: Awaited<ReturnType<typeof loadOfficeAttendanceContext>>) {
  const year = context.years.find(option => option.id === report.year.id), selectedClass = context.classes.find(option => option.id === report.scope.class_id), section = context.sections.find(option => option.id === report.scope.section_id);
  if (context.user_id !== report.user_id || context.school_id !== report.school_id || context.school_name !== report.school_name || context.server_today !== report.server_today || context.calendar_revision !== report.calendar_revision
    || !year || year.name !== report.year.name || year.start_date !== report.year.start_date || year.end_date !== report.year.end_date
    || report.scope.class_id !== null && selectedClass?.name !== report.scope.class_name
    || report.scope.section_id !== null && (section?.name !== report.scope.section_name || section.class_id !== report.scope.class_id)) {
    throw new OfficeAttendanceReportError("The school or selected report changed. Refresh official attendance before continuing.");
  }
}
export async function createOfficeAttendanceReportPdf(client: SupabaseClient, userId: string, expectedReport: OfficeAttendanceReport, signal: AbortSignal) {
  const scope = officeAttendanceReportScope(expectedReport), expected = JSON.stringify(parseOfficeAttendanceReport(expectedReport, userId, scope));
  async function snapshot() {
    const [report, context] = await Promise.all([loadOfficeAttendanceReport(client, userId, scope, signal), loadOfficeAttendanceContext(client, userId, scope.schoolId, signal)]);
    signal.throwIfAborted(); verifyOfficeAttendanceContext(report, context);
    return report;
  }
  signal.throwIfAborted();
  const initial = await snapshot();
  if (JSON.stringify(initial) !== expected) throw new OfficeAttendanceReportError("School records changed since this report loaded. Refresh before exporting again.");
  const { buildOfficeAttendanceReportPdf, AttendanceReportPdfError } = await import("./report-pdf");
  signal.throwIfAborted();
  const result = await buildOfficeAttendanceReportPdf(initial, new Date(), signal).catch((error: unknown) => {
    signal.throwIfAborted();
    throw new OfficeAttendanceReportError(error instanceof AttendanceReportPdfError ? error.message : "The PDF could not be prepared. Refresh the report and try again.");
  });
  signal.throwIfAborted();
  if (JSON.stringify(await snapshot()) !== expected) throw new OfficeAttendanceReportError("School records changed while preparing the PDF. Refresh before exporting again.");
  signal.throwIfAborted();
  const filename = `attendance-${initial.scope.section_id ? "section" : initial.scope.class_id ? "class" : "school"}-${initial.year.start_date}-${initial.year.end_date}-${initial.month.slice(0, 7)}.pdf`;
  if (!(result.bytes instanceof Uint8Array) || result.bytes.length < 8 || result.bytes.length > 8 * 1024 * 1024 || String.fromCharCode(...result.bytes.slice(0, 5)) !== "%PDF-" || result.filename !== filename) {
    throw new OfficeAttendanceReportError("The PDF could not be verified. Refresh the report and try again.");
  }
  return result;
}
export async function downloadOfficeAttendanceReportPdf(...args: Parameters<typeof createOfficeAttendanceReportPdf>) {
  const result = await createOfficeAttendanceReportPdf(...args), signal = args[3]; signal.throwIfAborted();
  const url = URL.createObjectURL(new Blob([new Uint8Array(result.bytes)], { type: "application/pdf" })), anchor = document.createElement("a");
  try { anchor.href = url; anchor.download = result.filename; document.body.appendChild(anchor); signal.throwIfAborted(); anchor.click(); }
  finally { anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 30_000); }
}
