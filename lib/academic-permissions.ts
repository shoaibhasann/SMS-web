import type { AcademicLogRecord, TeachingAssignment } from "./academic";

export type AcademicScope = Pick<AcademicLogRecord, "academic_year_id" | "class_id" | "section_id" | "subject_id">;

export function matchesAcademicScope(assignment: TeachingAssignment, scope: AcademicScope) {
  return assignment.academic_year_id === scope.academic_year_id
    && assignment.class_id === scope.class_id
    && assignment.section_id === scope.section_id
    && assignment.subject_id === scope.subject_id;
}

export function canEditAcademicLog(assignments: TeachingAssignment[], teacherId: string, schoolId: string, log: AcademicLogRecord) {
  return Boolean(teacherId && schoolId && log.teacher_id === teacherId && log.school_id === schoolId
    && assignments.some((assignment) => assignment.teacher_id === teacherId && matchesAcademicScope(assignment, log)));
}

export function academicAssignmentSignature(assignments: TeachingAssignment[]) {
  return JSON.stringify(assignments.map((assignment) => [assignment.id, assignment.teacher_id, assignment.academic_year_id,
    assignment.class_id, assignment.section_id, assignment.subject_id]).sort((left, right) => left[0].localeCompare(right[0])));
}

export function academicAuthoringError(error: unknown, fallback: string) {
  const code = (error as { code?: string } | null)?.code;
  if (code === "42501" || code === "PGRST116") return "Your teaching access changed. Refresh teaching access before trying again.";
  if (code === "23505") return "A log already exists for this class, subject and date. Open its source log to edit it.";
  if (code === "23503") return "This work has student submissions. Keep the work and edit its content instead of deleting it or changing grading settings.";
  if (code === "PT409" || code === "40001") return "This log changed in another session. Your draft is kept; refresh teaching access before editing the latest version.";
  if (code === "22023") return "Check the date, required details and marks before saving.";
  return error instanceof Error && !code ? error.message : fallback;
}
