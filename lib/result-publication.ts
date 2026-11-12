import type { SupabaseClient } from "@supabase/supabase-js";

export const publicationPageSize = 50;
export const publicationStatuses = ["pending", "published", "rejected", "cancelled"] as const;
// Shared by the on-screen cards and the printout so school dates never drift: assessment dates are plain days, times are IST.
export const resultDates = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const resultTimes = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
export type PublicationStatus = (typeof publicationStatuses)[number];
export type PublicationMetadata = {
  assessment_id: string; school_id: string; school_name: string; academic_year_id: string; academic_year_name: string;
  class_id: string; class_name: string; section_id: string | null; section_name: string | null;
  subject_id: string; subject_name: string; teacher_id: string; teacher_name: string; name: string;
  assessment_date: string; maximum_marks: number; assessment_updated_at: string; status: string;
};
export type PublicationPupil = {
  student_id: string; student_name: string; admission_no: string; roll_no: string | null; section_id: string | null;
  section_name: string | null; enrollment_id: string; mark_id: string | null; marks_obtained: number | null;
  remarks: string | null; mark_updated_at: string | null; mark_updated_by: string | null;
};
export type PublicationPreview = { source_token: string; can_submit: boolean; issues: string[]; metadata: PublicationMetadata; pupils: PublicationPupil[] };
export type PublicationSummary = {
  id: string; assessment_id: string; school_id: string; status: PublicationStatus; requested_at: string;
  requester_name: string; reviewed_at: string | null; revision: number | null; metadata: PublicationMetadata;
};
export type PublicationDetail = Omit<PublicationSummary, "metadata"> & {
  source_token: string; requested_by: string; reviewed_by: string | null; reviewer_name: string | null;
  review_note: string | null; source_matches: boolean | null; snapshot: { metadata: PublicationMetadata; pupils: PublicationPupil[] };
  viewer_entered_marks: boolean;
};
export type FamilyAssessmentResult = {
  id: string; assessment_id: string; revision: number; published_at: string; publisher_name: string;
  metadata: PublicationMetadata; student_id: string; student_name: string; admission_no: string; roll_no: string | null;
  marks_obtained: number; maximum_marks: number; percentage: number; remarks: string | null;
};
export type PublicationPage<T> = { rows: T[]; total_count: number; offset: number };
export type FamilyResultPage = PublicationPage<FamilyAssessmentResult> & { student_id: string; school_id: string };
export class ResultPublicationError extends Error {
  constructor(message: string, readonly code = "") { super(message); this.name = "ResultPublicationError"; }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const token = /^[a-f0-9]{64}$/;
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const nullableText = (value: unknown): value is string | null => value === null || typeof value === "string";
const timestamp = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value));
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const invalid = () => new ResultPublicationError("The result records could not be verified. Refresh to try again.");
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
function date(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
function metadata(value: unknown): PublicationMetadata {
  const row = record(value);
  if (![row.assessment_id, row.school_id, row.school_name, row.academic_year_id, row.academic_year_name, row.class_id,
    row.class_name, row.subject_id, row.subject_name, row.teacher_id, row.teacher_name, row.name, row.status].every(text)
    || !nullableText(row.section_id) || !nullableText(row.section_name) || !date(row.assessment_date)
    || !finite(row.maximum_marks) || row.maximum_marks <= 0 || !timestamp(row.assessment_updated_at)) throw invalid();
  return row as PublicationMetadata;
}
function pupils(value: unknown, maximum: number): PublicationPupil[] {
  if (!Array.isArray(value)) throw invalid();
  const seen = new Set<string>();
  return value.map((entry: unknown) => {
    const row = record(entry);
    if (![row.student_id, row.student_name, row.admission_no, row.enrollment_id].every(text)
      || !nullableText(row.roll_no) || !nullableText(row.section_id) || !nullableText(row.section_name)
      || !nullableText(row.mark_id) || !nullableText(row.remarks) || !nullableText(row.mark_updated_by)
      || !(row.mark_updated_at === null || timestamp(row.mark_updated_at))
      || !(row.marks_obtained === null || finite(row.marks_obtained) && row.marks_obtained >= 0 && row.marks_obtained <= maximum)
      || seen.has(row.student_id as string)) throw invalid();
    seen.add(row.student_id as string); return row as PublicationPupil;
  });
}
function rpcError(error: { code?: string; message?: string } | null, write = false) {
  if (!error) return;
  const code = error.code ?? "";
  if (["PGRST202", "42883", "42703"].includes(code)) throw new ResultPublicationError("Published results need the latest school update. Contact your administrator.", code);
  if (code === "42501") throw new ResultPublicationError("Your access or teaching assignment could not be verified. Refresh access before continuing.", code);
  if (["22023", "PT409", "40001", "23505"].includes(code) && error.message) throw new ResultPublicationError(error.message, code);
  throw new ResultPublicationError(write ? "The action could not be confirmed. Your reason and request reference are kept. Retry the same action or refresh the saved status."
    : "Published results could not be loaded. Refresh to try again.", code);
}
function count(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw invalid();
  return parsed;
}
function checkOffset(offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2147483647) throw new ResultPublicationError("Choose a valid results page.", "22023");
}
function readPage<T>(data: unknown, offset: number, parse: (value: unknown) => T & { id: string }): PublicationPage<T> {
  const row = record(data), total = count(row.total_count);
  if (row.offset !== offset || !Array.isArray(row.rows) || row.rows.length > publicationPageSize
    || row.rows.length > 0 && total < offset + row.rows.length) throw invalid();
  const rows = row.rows.map(parse), ids = new Set(rows.map((item) => item.id));
  if (ids.size !== rows.length) throw invalid();
  return { rows, total_count: total, offset };
}
function summary(value: unknown): PublicationSummary {
  const row = record(value), source = metadata(row.metadata);
  if (![row.id, row.assessment_id, row.school_id, row.requester_name].every(text)
    || !publicationStatuses.includes(row.status as PublicationStatus) || !timestamp(row.requested_at)
    || !(row.reviewed_at === null || timestamp(row.reviewed_at)) || !(row.revision === null || positiveInteger(row.revision))
    || row.assessment_id !== source.assessment_id || row.school_id !== source.school_id) throw invalid();
  return { ...row, metadata: source } as PublicationSummary;
}
export async function listPublicationCandidates(client: SupabaseClient) {
  const { data, error } = await client.rpc("list_assessment_publication_candidates"); rpcError(error);
  if (!Array.isArray(data)) throw invalid();
  const rows = data.map(metadata), ids = new Set(rows.map((row) => row.assessment_id));
  if (ids.size !== rows.length) throw invalid();
  return rows;
}
export async function previewPublication(client: SupabaseClient, assessmentId: string): Promise<PublicationPreview> {
  const { data, error } = await client.rpc("preview_assessment_publication", { p_assessment_id: assessmentId }); rpcError(error);
  const row = record(data), source = metadata(row.metadata), roster = pupils(row.pupils, source.maximum_marks);
  if (source.assessment_id !== assessmentId || typeof row.source_token !== "string" || !token.test(row.source_token)
    || typeof row.can_submit !== "boolean" || !Array.isArray(row.issues) || !row.issues.every(text)
    || row.can_submit && (!roster.length || row.issues.length > 0 || roster.some((pupil) => pupil.mark_id === null || pupil.marks_obtained === null))) throw invalid();
  return { source_token: row.source_token, can_submit: row.can_submit, issues: row.issues, metadata: source, pupils: roster };
}
export async function requestPublication(client: SupabaseClient, assessmentId: string, sourceToken: string, requestId: string) {
  if (!token.test(sourceToken) || !uuid.test(requestId)) throw new ResultPublicationError("Refresh the preview before requesting publication.", "22023");
  const { data, error } = await client.rpc("request_assessment_publication", { p_assessment_id: assessmentId, p_expected_source_token: sourceToken, p_request_id: requestId });
  rpcError(error, true);
  if (typeof data !== "string" || !uuid.test(data)) throw new ResultPublicationError("The request could not be confirmed. Retry the same request or refresh its saved status.");
  return data;
}
export async function listResultSubmissions(client: SupabaseClient, schoolId: string | null, status: PublicationStatus | null, offset = 0) {
  checkOffset(offset);
  if (status !== null && !publicationStatuses.includes(status)) throw new ResultPublicationError("Choose a valid publication status.", "22023");
  const { data, error } = await client.rpc("list_assessment_result_submissions", { p_school_id: schoolId, p_status: status, p_offset: offset }); rpcError(error);
  return readPage(data, offset, (value) => {
    const row = summary(value);
    if (schoolId && row.school_id !== schoolId || status && row.status !== status) throw invalid();
    return row;
  });
}
export async function getResultSubmission(client: SupabaseClient, submissionId: string): Promise<PublicationDetail> {
  const { data, error } = await client.rpc("get_assessment_result_submission", { p_submission_id: submissionId }); rpcError(error);
  const row = record(data), snap = record(row.snapshot), source = metadata(snap.metadata), roster = pupils(snap.pupils, source.maximum_marks);
  const base = summary({ ...row, metadata: source });
  if (row.id !== submissionId || !text(row.requested_by) || typeof row.source_token !== "string" || !token.test(row.source_token)
    || !nullableText(row.reviewed_by) || !nullableText(row.reviewer_name) || !nullableText(row.review_note)
    || !(row.source_matches === null || typeof row.source_matches === "boolean") || !roster.length
    || !(row.viewer_entered_marks === undefined || typeof row.viewer_entered_marks === "boolean")
    || roster.some((pupil) => pupil.mark_id === null || pupil.marks_obtained === null)
    || base.status === "pending" && (row.reviewed_by !== null || row.review_note !== null || row.reviewed_at !== null)
    || base.status !== "pending" && (!text(row.reviewed_by) || !text(row.review_note) || !timestamp(row.reviewed_at))) throw invalid();
  const { metadata: _metadata, ...detailBase } = base;
  void _metadata;
  return { ...detailBase, source_token: row.source_token, requested_by: row.requested_by, reviewed_by: row.reviewed_by,
    reviewer_name: row.reviewer_name, review_note: row.review_note, source_matches: row.source_matches,
    viewer_entered_marks: row.viewer_entered_marks === true, snapshot: { metadata: source, pupils: roster } } as PublicationDetail;
}
export function validatePublicationReason(reason: string) {
  return reason.trim().length >= 3 && reason.trim().length <= 1000 ? null : "Enter a reason between 3 and 1,000 characters.";
}
export async function decidePublication(client: SupabaseClient, submissionId: string, decision: "published" | "rejected", reason: string) {
  const invalidReason = validatePublicationReason(reason);
  if (invalidReason || !["published", "rejected"].includes(decision)) throw new ResultPublicationError(invalidReason ?? "Choose a valid review decision.", "22023");
  const { data, error } = await client.rpc("review_assessment_publication", { p_submission_id: submissionId, p_decision: decision, p_reason: reason.trim() }); rpcError(error, true);
  if (data !== submissionId) throw new ResultPublicationError("The review could not be confirmed. Retry the same decision or refresh its saved status.");
  return submissionId;
}
export async function cancelPublication(client: SupabaseClient, submissionId: string, reason: string) {
  const invalidReason = validatePublicationReason(reason);
  if (invalidReason) throw new ResultPublicationError(invalidReason, "22023");
  const { data, error } = await client.rpc("cancel_assessment_result_submission", { p_submission_id: submissionId, p_reason: reason.trim() }); rpcError(error, true);
  if (data !== submissionId) throw new ResultPublicationError("Cancellation could not be confirmed. Retry the same reason or refresh the saved status.");
  return submissionId;
}
function readFamilyResult(value: unknown, studentId: string, schoolId: string): FamilyAssessmentResult {
    const row = record(value), source = metadata(row.metadata);
    if (![row.id, row.assessment_id, row.publisher_name, row.student_name, row.admission_no].every(text)
      || row.student_id !== studentId || source.school_id !== schoolId || source.assessment_id !== row.assessment_id
      || !positiveInteger(row.revision) || !timestamp(row.published_at) || !nullableText(row.roll_no) || !nullableText(row.remarks)
      || !finite(row.marks_obtained) || row.marks_obtained < 0 || !finite(row.maximum_marks) || row.maximum_marks <= 0
      || row.maximum_marks !== source.maximum_marks || row.marks_obtained > row.maximum_marks || !finite(row.percentage)
      || row.percentage < 0 || row.percentage > 100 || Math.abs(row.percentage - row.marks_obtained / row.maximum_marks * 100) > 0.011
      || ["pupils", "snapshot", "rank", "mark_id", "enrollment_id", "review_note"].some((key) => key in row)) throw invalid();
    return { ...row, metadata: source } as FamilyAssessmentResult;
}

export async function getFamilyAssessmentResults(client: SupabaseClient, studentId: string, schoolId: string, offset = 0): Promise<FamilyResultPage> {
  checkOffset(offset);
  const { data, error } = await client.rpc("get_family_assessment_results", { p_student_id: studentId, p_offset: offset }); rpcError(error);
  const context = record(data);
  if (context.student_id !== studentId || context.school_id !== schoolId) throw invalid();
  const page = readPage(data, offset, (value) => readFamilyResult(value, studentId, schoolId));
  const sources = new Set(page.rows.map((row) => row.assessment_id));
  if (sources.size !== page.rows.length) throw invalid();
  return { ...page, student_id: studentId, school_id: schoolId };
}

export async function getFamilyNotificationResult(client: SupabaseClient, role: "parent" | "student", studentId: string, schoolId: string, assessmentId: string): Promise<FamilyAssessmentResult | null> {
  if (!["parent", "student"].includes(role) || !uuid.test(studentId) || !uuid.test(assessmentId)) throw new ResultPublicationError("This result link is invalid.", "22023");
  const { data, error } = await client.rpc("get_family_notification_result", { p_role: role, p_student_id: studentId, p_assessment_id: assessmentId }); rpcError(error);
  if (data === null) return null;
  const result = readFamilyResult(data, studentId, schoolId);
  if (result.assessment_id !== assessmentId) throw invalid();
  return result;
}

export function printPublishedResult(result: FamilyAssessmentResult) {
  const popup = window.open("", "_blank");
  if (!popup) throw new ResultPublicationError("The print window was blocked. Allow popups for this school site and try again.");
  const doc = popup.document;
  doc.title = `${result.metadata.name} — published assessment result`;
  const style = doc.createElement("style");
  style.textContent = "body{font:16px/1.6 system-ui,sans-serif;color:#152033;max-width:760px;margin:40px auto;padding:0 24px}h1{font-size:25px;line-height:1.3}dl{display:grid;grid-template-columns:160px 1fr;gap:8px 16px}dt{font-weight:600}dd{margin:0;overflow-wrap:anywhere}p{white-space:pre-wrap;overflow-wrap:anywhere}@media print{body{margin:12mm;max-width:none;padding:0}}";
  doc.head.append(style);
  const heading = doc.createElement("h1"); heading.textContent = "Published assessment result"; doc.body.append(heading);
  const school = doc.createElement("p"); school.textContent = result.metadata.school_name; doc.body.append(school);
  const details = doc.createElement("dl");
  for (const [name, value] of [["Student", result.student_name], ["Admission number", result.admission_no], ["Roll number", result.roll_no ?? "—"],
    ["Session", result.metadata.academic_year_name], ["Class", [result.metadata.class_name, result.metadata.section_name].filter(Boolean).join(" / ")],
    ["Assessment", result.metadata.name], ["Subject", result.metadata.subject_name], ["Assessment date", resultDates.format(new Date(`${result.metadata.assessment_date}T00:00:00Z`))],
    ["Marks", `${result.marks_obtained} / ${result.maximum_marks}`], ["Percentage", `${result.percentage.toFixed(2)}%`],
    ["Revision", String(result.revision)], ["Published by", result.publisher_name], ["Published at", `${resultTimes.format(new Date(result.published_at))} IST`]]) {
    const term = doc.createElement("dt"), description = doc.createElement("dd"); term.textContent = name; description.textContent = value; details.append(term, description);
  }
  doc.body.append(details);
  if (result.remarks) { const note = doc.createElement("p"); note.textContent = `Teacher remarks: ${result.remarks}`; doc.body.append(note); }
  const help = doc.createElement("p"); help.textContent = "This is a published single-assessment result. School term grades, pass/fail and class rank are not included."; doc.body.append(help);
  popup.opener = null; popup.focus(); popup.print();
}
