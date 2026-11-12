import type { SupabaseClient } from "@supabase/supabase-js";

export const timetableDays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
export type TimetableAssignment = { id: string; academic_year_id: string; class_id: string; section_id: string | null;
  subject_id: string; teacher_id: string; subject_name: string; teacher_name: string };
export type TimetableSetup = {
  years: { id: string; name: string; is_current: boolean; start_date: string; end_date: string }[];
  classes: { id: string; name: string }[];
  sections: { id: string; class_id: string; name: string }[];
  assignments: TimetableAssignment[];
};
export type TimetablePeriod = {
  id: string; school_id: string; academic_year_id: string; class_id: string; class_name: string;
  section_id: string | null; section_name: string | null; assignment_id: string | null;
  subject_id: string | null; subject_name: string | null; teacher_id: string | null; teacher_name: string | null;
  day_of_week: number; period_no: number; start_time: string | null; end_time: string | null; room: string | null;
  version: string; needs_attention: boolean;
};
export type TimetableView = {
  school_id: string; academic_year_id: string | null; academic_year_name: string | null;
  student_id?: string; class_id?: string | null; class_name?: string | null;
  section_id?: string | null; section_name?: string | null; rows: TimetablePeriod[];
};
export type TimetableDraft = { assignmentId: string; sectionId: string | null; day: number; period: number;
  start: string; end: string; room: string };
export class TimetableError extends Error {
  constructor(message: string, readonly code = "") { super(message); this.name = "TimetableError"; }
}

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const nullableText = (value: unknown): value is string | null => value === null || typeof value === "string";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const invalid = () => new TimetableError("Timetable records could not be verified. Refresh to try again.");

export function timetableTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const matched = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(\.\d+)?)?$/.exec(value);
  return matched ? Number(matched[1]) * 3600 + Number(matched[2]) * 60 + Number(matched[3] ?? 0) + Number(matched[4] ?? 0) : null;
}

export function formatTimetableTime(value: string | null) {
  if (!value || timetableTime(value) === null) return "Time needed";
  return /^\d{2}:\d{2}:00(?:\.0+)?$/.test(value) ? value.slice(0, 5) : value;
}

export function validateTimetableDraft(draft: TimetableDraft): string | null {
  if (!draft.assignmentId) return "Choose an eligible subject and teacher assignment.";
  if (!Number.isInteger(draft.day) || draft.day < 1 || draft.day > 7 || !Number.isInteger(draft.period)
    || draft.period < 1 || draft.period > 2147483647) return "Choose a valid weekday and positive period number.";
  const start = timetableTime(draft.start), end = timetableTime(draft.end);
  if (start === null || end === null || start >= end || start % 60 !== 0 || end % 60 !== 0) return "Enter whole-minute school times with the end after the start.";
  if (draft.room.trim().length > 120) return "Keep the room name within 120 characters.";
  return null;
}

function rpcError(error: { code?: string; message?: string } | null, write = false) {
  if (!error) return;
  const code = error.code ?? "";
  if (["PGRST202", "42883", "42703"].includes(code)) throw new TimetableError("Timetable needs the latest school update. Contact your administrator.", code);
  if (code === "42501") throw new TimetableError("Your timetable access or teaching assignment changed. Refresh access before continuing.", code);
  if (["22023", "PT409", "40001", "23505", "23P01"].includes(code) && error.message) throw new TimetableError(error.message, code);
  throw new TimetableError(write ? "The change could not be confirmed. Your draft is kept. Retry the same change or refresh the saved timetable."
    : "Timetable could not be loaded. Refresh to try again.", code);
}

function checkedArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw invalid();
  const seen = new Set<string>();
  return value.map((item: unknown) => {
    const row = object(item);
    if (!text(row.id) || seen.has(row.id)) throw invalid();
    seen.add(row.id); return row;
  });
}

export async function getTimetableSetup(client: SupabaseClient, schoolId: string): Promise<TimetableSetup> {
  const { data, error } = await client.rpc("get_timetable_setup", { p_school_id: schoolId });
  rpcError(error);
  const value = object(data), years = checkedArray(value.years), classes = checkedArray(value.classes),
    sections = checkedArray(value.sections), assignments = checkedArray(value.assignments);
  const yearIds = new Set(years.map((row) => row.id)), classIds = new Set(classes.map((row) => row.id));
  const sectionClasses = new Map(sections.map((row) => [row.id, row.class_id]));
  if (years.some((row) => !text(row.name) || typeof row.is_current !== "boolean" || !text(row.start_date) || !text(row.end_date))
    || classes.some((row) => !text(row.name)) || sections.some((row) => !text(row.name) || !classIds.has(row.class_id))
    || assignments.some((row) => !yearIds.has(row.academic_year_id)
      || !classIds.has(row.class_id) || !nullableText(row.section_id)
      || (row.section_id !== null && sectionClasses.get(row.section_id) !== row.class_id)
      || ![row.subject_id, row.teacher_id, row.subject_name, row.teacher_name].every(text))) throw invalid();
  return { years, classes, sections, assignments } as TimetableSetup;
}

function readView(data: unknown, scope: { schoolId?: string; yearId?: string; classId?: string; sectionId?: string | null; studentId?: string; office?: boolean }): TimetableView {
  const value = object(data);
  if (!text(value.school_id) || !nullableText(value.academic_year_id) || !nullableText(value.academic_year_name)
    || (value.academic_year_id !== null && (!text(value.academic_year_id) || !text(value.academic_year_name)))
    || (scope.schoolId && value.school_id !== scope.schoolId) || (scope.yearId && value.academic_year_id !== scope.yearId)
    || (scope.classId && value.class_id !== scope.classId) || (scope.studentId && value.student_id !== scope.studentId)
    || (scope.sectionId !== undefined && value.section_id !== scope.sectionId)) throw invalid();
  if (scope.studentId || scope.classId) {
    if (!nullableText(value.class_id) || !nullableText(value.class_name) || !nullableText(value.section_id) || !nullableText(value.section_name)) throw invalid();
  }
  const rows = checkedArray(value.rows).map((row) => {
    const start = timetableTime(row.start_time), end = timetableTime(row.end_time);
    if (![row.school_id, row.academic_year_id, row.class_id, row.class_name, row.version].every(text)
      || !uuid.test(row.version as string) || !nullableText(row.section_id) || !nullableText(row.section_name)
      || !nullableText(row.assignment_id) || !nullableText(row.subject_id) || !nullableText(row.subject_name)
      || !nullableText(row.teacher_id) || !nullableText(row.teacher_name) || !nullableText(row.start_time)
      || !nullableText(row.end_time) || !nullableText(row.room) || typeof row.needs_attention !== "boolean"
      || !Number.isInteger(row.day_of_week) || !Number.isInteger(row.period_no)
      || row.school_id !== value.school_id || row.academic_year_id !== value.academic_year_id
      || (scope.classId && row.class_id !== scope.classId)
      || (scope.studentId && (row.class_id !== value.class_id || (row.section_id !== null && row.section_id !== value.section_id)))
      || (scope.sectionId && row.section_id !== null && row.section_id !== scope.sectionId)
      || (!scope.office && row.needs_attention)
      || (!row.needs_attention && (![row.assignment_id, row.subject_id, row.subject_name, row.teacher_id, row.teacher_name].every(text)
        || Number(row.day_of_week) < 1 || Number(row.day_of_week) > 7 || Number(row.period_no) < 1
        || start === null || end === null || start >= end || start % 60 !== 0 || end % 60 !== 0))) throw invalid();
    return row as TimetablePeriod;
  });
  if ((value.academic_year_id === null || (scope.studentId && value.class_id === null)) && rows.length) throw invalid();
  return { ...value, rows } as TimetableView;
}

export async function getOfficeTimetable(client: SupabaseClient, schoolId: string, yearId: string, classId: string, sectionId: string | null) {
  const { data, error } = await client.rpc("get_office_timetable", { p_school_id: schoolId, p_year_id: yearId, p_class_id: classId, p_section_id: sectionId });
  rpcError(error); return readView(data, { schoolId, yearId, classId, sectionId, office: true });
}
// Periods kept live by an assignment removed before periods retired with it (or by a trusted writer).
// Legacy rows without any assignment stay for repair; only rows pointing at a missing assignment are stale.
export async function findStaleTimetablePeriods(client: SupabaseClient, rows: TimetablePeriod[]) {
  const candidates = rows.filter((row) => row.needs_attention && row.assignment_id);
  const ids = [...new Set(candidates.map((row) => row.assignment_id as string))];
  if (!ids.length) return [];
  const { data, error } = await client.from("teacher_subject_assignments").select("id").in("id", ids);
  if (error || !Array.isArray(data)) throw invalid();
  const live = new Set(data.map((row: { id: unknown }) => row.id));
  return candidates.filter((row) => !live.has(row.assignment_id));
}
export async function getTeacherTimetable(client: SupabaseClient) {
  const { data, error } = await client.rpc("get_teacher_timetable"); rpcError(error); return readView(data, {});
}
export async function getFamilyTimetable(client: SupabaseClient, studentId: string, schoolId: string) {
  const { data, error } = await client.rpc("get_family_timetable", { p_student_id: studentId });
  rpcError(error); return readView(data, { studentId, schoolId });
}

export async function saveTimetablePeriod(client: SupabaseClient, schoolId: string, draft: TimetableDraft,
  baseline: Pick<TimetablePeriod, "id" | "version"> | null, requestId: string) {
  const message = validateTimetableDraft(draft);
  if (message) throw new TimetableError(message, "22023");
  if (!uuid.test(requestId) || (baseline && (!uuid.test(baseline.id) || !uuid.test(baseline.version)))) throw new TimetableError("The change reference could not be verified. Reload and try again.", "22023");
  const { data, error } = await client.rpc("save_timetable_period", { p_school_id: schoolId, p_period_id: baseline?.id ?? null,
    p_expected_version: baseline?.version ?? null, p_assignment_id: draft.assignmentId, p_section_id: draft.sectionId,
    p_day_of_week: draft.day, p_period_no: draft.period, p_start_time: draft.start, p_end_time: draft.end,
    p_room: draft.room.trim() || null, p_request_id: requestId });
  rpcError(error, true);
  if (typeof data !== "string" || !uuid.test(data) || (baseline && data !== baseline.id)) throw new TimetableError("The change could not be confirmed. Retry the same change or refresh the saved timetable.");
  return data;
}
export async function removeTimetablePeriod(client: SupabaseClient, schoolId: string, row: Pick<TimetablePeriod, "id" | "version">, requestId: string) {
  if (![row.id, row.version, requestId].every((id) => uuid.test(id))) throw new TimetableError("The removal reference could not be verified. Reload and try again.", "22023");
  const { data, error } = await client.rpc("remove_timetable_period", { p_school_id: schoolId, p_period_id: row.id,
    p_expected_version: row.version, p_request_id: requestId });
  rpcError(error, true);
  if (data !== row.id) throw new TimetableError("The removal could not be confirmed. Retry the same removal or refresh the saved timetable.");
  return row.id;
}
