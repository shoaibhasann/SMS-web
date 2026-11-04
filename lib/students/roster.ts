import type { SupabaseClient } from "@supabase/supabase-js";
import type { AttendanceContext } from "@/lib/attendance/types";

export type RosterAdmission = { admissionNumber: string; firstName: string; lastName: string };

export async function admitRosterStudent(
  client: SupabaseClient,
  context: AttendanceContext,
  fields: RosterAdmission,
) {
  const { data, error } = await client.rpc("admit_roster_student", {
    p_school_id: context.schoolId,
    p_academic_year_id: context.academicYearId,
    p_class_id: context.classId,
    p_section_id: context.sectionId,
    p_admission_no: fields.admissionNumber.trim(),
    p_first_name: fields.firstName.trim(),
    p_last_name: fields.lastName.trim(),
  });

  if (error?.code === "23505") throw new Error("This admission number is already used in this school.");
  if (error?.code === "42501") throw new Error("You cannot admit students for this school.");
  if (error?.code === "22023") throw new Error("Check the student details and the current class and section.");
  if (error || typeof data !== "string" || !data) {
    throw new Error("Admission could not be confirmed. Reload the roster before retrying.");
  }
  return data;
}

export async function importRosterStudents(
  client: SupabaseClient,
  context: AttendanceContext,
  requestId: string,
  students: RosterAdmission[],
) {
  const { data, error } = await client.rpc("import_roster_students", {
    p_school_id: context.schoolId,
    p_academic_year_id: context.academicYearId,
    p_class_id: context.classId,
    p_section_id: context.sectionId,
    p_request_id: requestId,
    p_students: students,
  });

  if (error?.code === "23505") {
    const row = error.message.match(/^Student (\d+) has an admission number already used/);
    throw new Error(row ? `Student row ${row[1]} uses an existing admission number. The batch was not saved.`
      : "The batch contains a duplicate admission number. The batch was not saved.");
  }
  if (error?.code === "42501") throw new Error("You cannot import students for this school.");
  if (error?.code === "22023") throw new Error("Check the student details and current class and section. The batch was not saved.");
  if (error || data !== students.length) {
    throw new Error("The import could not be confirmed. Retry this same preview to check whether it saved.");
  }
  return data as number;
}
