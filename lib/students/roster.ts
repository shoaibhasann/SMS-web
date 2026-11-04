import type { SupabaseClient } from "@supabase/supabase-js";
import type { AttendanceContext } from "@/lib/attendance/types";

export async function admitRosterStudent(
  client: SupabaseClient,
  context: AttendanceContext,
  fields: { admissionNumber: string; firstName: string; lastName: string },
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
