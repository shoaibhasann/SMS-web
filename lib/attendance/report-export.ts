import type { SupabaseClient } from "@supabase/supabase-js";
import { loadFamilyStudents } from "./family";
import { studentName } from "./types";
import { FamilyAttendanceSummaryError, loadFamilyAttendanceReport, loadFamilyAttendanceReportContext, parseFamilyAttendanceSummary, type FamilyAttendanceSummary, type FamilyAttendanceSummaryRole } from "./family-summary";
import { boundMfaSession } from "@/lib/auth/staff-mfa";
import { validCalendarDate } from "./calendar";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 2000 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const changed = () => new FamilyAttendanceSummaryError("The selected report or school records changed. Refresh official attendance before exporting again.");

/** Fresh reads surround rendering so a delayed export cannot acknowledge revoked access or obsolete counts. */
export async function createFamilyAttendanceReportPdf(client: SupabaseClient, userId: string, student: { id: string; school_id: string }, role: FamilyAttendanceSummaryRole, academicYearId: string, month: string, signal: AbortSignal, expectedSummary: FamilyAttendanceSummary) {
  signal.throwIfAborted();
  if (![userId, student.id, student.school_id, academicYearId].every(value => uuid.test(value)) || !["student", "parent"].includes(role)) {
    throw new FamilyAttendanceSummaryError("Sign in again before exporting official attendance.", "access");
  }
  if (!validCalendarDate(month) || !month.endsWith("-01")) throw new FamilyAttendanceSummaryError("Choose a valid reporting month before exporting.", "validation");
  const expected = JSON.stringify(parseFamilyAttendanceSummary(expectedSummary, userId, student, role, month));
  if (expectedSummary.session_state !== "active" || expectedSummary.year?.id !== academicYearId) throw changed();
  async function snapshot() {
    const [summary, context, students, school] = await Promise.all([
      loadFamilyAttendanceReport(client, userId, student, role, academicYearId, month, signal),
      loadFamilyAttendanceReportContext(client, userId, student, role, signal),
      loadFamilyStudents(client, role, userId).catch(() => {
        signal.throwIfAborted();
        throw new FamilyAttendanceSummaryError("Your student or linked-child access could not be verified. Reopen attendance after signing in.", "access");
      }),
      client.from("schools").select("id,name").eq("id", student.school_id).abortSignal(signal).maybeSingle(),
    ]);
    signal.throwIfAborted();
    const session = await boundMfaSession(client, userId, signal).catch(() => { signal.throwIfAborted(); throw new FamilyAttendanceSummaryError("Your sign-in changed. Reopen attendance after signing in.", "access"); });
    if (!session) throw new FamilyAttendanceSummaryError("Sign in again before exporting official attendance.", "access");
    signal.throwIfAborted();
    const year = context.years.find(year => year.id === academicYearId);
    if (!year || summary.session_state !== "active" || !summary.year || !summary.month_summary || !summary.year_summary
      || summary.year.id !== year.id || summary.year.name !== year.name || summary.year.start_date !== year.start_date || summary.year.end_date !== year.end_date
      || context.server_today !== summary.server_today) throw changed();
    const pupil = students.find(pupil => pupil.id === student.id && pupil.school_id === student.school_id);
    if (!pupil) throw new FamilyAttendanceSummaryError("Your attendance report access changed. Reopen attendance after signing in.", "access");
    if (school.error || school.data?.id !== student.school_id) throw new FamilyAttendanceSummaryError("Your school access could not be verified. Reopen attendance after signing in.", "access");
    if (!text(pupil.first_name) || ![pupil.middle_name, pupil.last_name].every(part => part === null || part === undefined || part === "" || text(part))
      || !text(pupil.admission_no) || !text(school.data.name)) {
      throw new FamilyAttendanceSummaryError("School and student details could not be verified. Ask the school office to review them before exporting.");
    }
    return { summary, schoolName: school.data.name, studentName: studentName(pupil), admissionNo: pupil.admission_no };
  }
  const initial = await snapshot();
  signal.throwIfAborted();
  if (JSON.stringify(initial.summary) !== expected) throw changed();
  const { buildAttendanceReportPdf, AttendanceReportPdfError } = await import("./report-pdf");
  signal.throwIfAborted();
  const result = await buildAttendanceReportPdf({ ...initial, generatedAt: new Date() }, signal).catch((error: unknown) => {
    signal.throwIfAborted();
    throw new FamilyAttendanceSummaryError(error instanceof AttendanceReportPdfError ? error.message : "The PDF could not be prepared. Refresh attendance and try again.");
  });
  signal.throwIfAborted();
  const latest = await snapshot();
  signal.throwIfAborted();
  if (JSON.stringify(initial) !== JSON.stringify(latest)) throw changed();
  const filename = `attendance-${initial.summary.year!.start_date}-${initial.summary.year!.end_date}-${month.slice(0, 7)}.pdf`;
  if (!(result.bytes instanceof Uint8Array) || result.bytes.length < 8 || result.bytes.length > 8 * 1024 * 1024
    || String.fromCharCode(...result.bytes.slice(0, 5)) !== "%PDF-" || result.filename !== filename) {
    throw new FamilyAttendanceSummaryError("The PDF could not be verified. Refresh official attendance and try again.");
  }
  return result;
}

export async function downloadFamilyAttendanceReportPdf(...args: Parameters<typeof createFamilyAttendanceReportPdf>) {
  const result = await createFamilyAttendanceReportPdf(...args), signal = args[6];
  signal.throwIfAborted();
  const url = URL.createObjectURL(new Blob([new Uint8Array(result.bytes)], { type: "application/pdf" }));
  const anchor = document.createElement("a");
  try {
    anchor.href = url; anchor.download = result.filename;
    document.body.appendChild(anchor); signal.throwIfAborted(); anchor.click();
  } finally {
    anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
