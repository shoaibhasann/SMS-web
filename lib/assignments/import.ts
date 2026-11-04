import type { SupabaseClient } from "@supabase/supabase-js";
import type { AssignmentCsvRow, AssignmentImportInput } from "./csv";

export type AssignmentImportRow = AssignmentCsvRow & {
  teacherId: string | null;
  teacherName: string | null;
  classId: string | null;
  sectionId: string | null;
  subjectId: string | null;
};

export type MatchedAssignmentImportRow = AssignmentImportRow & {
  teacherId: string;
  classId: string;
  sectionId: string;
  subjectId: string;
  issue: null;
};

export class AssignmentImportRejected extends Error {}

function input({ employeeId, className, sectionName, subjectName, isClassTeacher }: AssignmentImportInput): AssignmentImportInput {
  return { employeeId, className, sectionName, subjectName, isClassTeacher };
}

export function createAssignmentImportRepository(client: SupabaseClient) {
  return {
    async previewImport(schoolId: string, yearId: string, rows: readonly AssignmentCsvRow[]): Promise<AssignmentImportRow[]> {
      const { data, error } = await client.rpc("preview_teacher_assignment_import", {
        p_school_id: schoolId,
        p_academic_year_id: yearId,
        p_rows: rows.map(input),
      });
      if (error?.code === "42501") throw new Error("You do not have permission to import teaching assignments for this school.");
      if (error?.code === "22023") throw new Error("Check the current academic year and preview the CSV again.");
      if (error || !Array.isArray(data) || data.length !== rows.length) {
        throw new Error("Assignment matches could not be checked. Preview the CSV again.");
      }

      return rows.map((row, index) => {
        const match = data[index];
        if (!match || match.row_number !== row.rowNumber || match.employee_id !== row.employeeId ||
          match.class_name !== row.className || match.section_name !== row.sectionName ||
          match.subject_name !== row.subjectName || match.is_class_teacher !== row.isClassTeacher ||
          (match.error !== null && typeof match.error !== "string") ||
          [match.teacher_id, match.teacher_name, match.class_id, match.section_id, match.subject_id]
            .some((value) => value !== null && typeof value !== "string") ||
          (match.error === null && (!match.teacher_id || !match.class_id || !match.section_id || !match.subject_id))) {
          throw new Error("Assignment matches could not be checked. Preview the CSV again.");
        }

        return {
          ...row,
          issue: match.error,
          teacherId: match.teacher_id,
          teacherName: match.teacher_name,
          classId: match.class_id,
          sectionId: match.section_id,
          subjectId: match.subject_id,
        };
      });
    },

    async confirmImport(schoolId: string, yearId: string, requestId: string, rows: readonly MatchedAssignmentImportRow[]) {
      const { data, error } = await client.rpc("import_teacher_assignments", {
        p_school_id: schoolId,
        p_academic_year_id: yearId,
        p_request_id: requestId,
        p_rows: rows.map((row) => ({
          ...input(row),
          teacherId: row.teacherId,
          classId: row.classId,
          sectionId: row.sectionId,
          subjectId: row.subjectId,
        })),
      });
      if (error?.code === "42501") throw new AssignmentImportRejected("You do not have permission to import teaching assignments for this school.");
      if (error?.code === "22023") {
        const rowError = /^Assignment import row \d+(?::| changed since preview)/.test(error.message);
        throw new AssignmentImportRejected(rowError
          ? error.message : "The import preview is no longer valid. Check the current academic year and preview the CSV again.");
      }
      if (error?.code === "23505") {
        const rowError = /^Assignment import row \d+(?::| changed since preview)/.test(error.message);
        throw new AssignmentImportRejected(rowError
          ? error.message : "An assignment or class-teacher duty changed. Check the assignment list and preview the CSV again.");
      }
      if (error || data?.request_id !== requestId || data?.assignment_count !== rows.length) {
        throw new Error("The import could not be confirmed. Retry from this same preview.");
      }
      return rows.length;
    },
  };
}
