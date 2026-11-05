import type { SupabaseClient } from "@supabase/supabase-js";

export type EffectiveAttendanceAssignment = {
  id: string;
  teacher_id: string;
  academic_year_id: string;
  class_id: string;
  section_id: string;
  subject_id: string;
  is_class_teacher: true;
  class_name: string;
  section_name: string;
  subject_name: string;
  coverage_id: string | null;
  starts_on: string | null;
  ends_on: string | null;
};

export async function loadEffectiveAttendanceAssignments(client: SupabaseClient, signal?: AbortSignal): Promise<EffectiveAttendanceAssignment[]> {
  const query = client.rpc("list_my_effective_attendance_assignments");
  if (signal) query.abortSignal(signal);
  const { data, error } = await query.returns<unknown>();
  if (error || !Array.isArray(data) || data.some((row) => !row || typeof row.id !== "string"
    || typeof row.teacher_id !== "string" || typeof row.academic_year_id !== "string"
    || typeof row.class_id !== "string" || typeof row.section_id !== "string"
    || typeof row.subject_id !== "string" || typeof row.class_name !== "string"
    || typeof row.section_name !== "string" || typeof row.subject_name !== "string"
    || row.is_class_teacher !== true || (row.coverage_id !== null && typeof row.coverage_id !== "string")
    || (row.starts_on !== null && typeof row.starts_on !== "string")
    || (row.ends_on !== null && typeof row.ends_on !== "string")
    || (row.coverage_id !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(row.starts_on ?? "")
      || !/^\d{4}-\d{2}-\d{2}$/.test(row.ends_on ?? "") || row.starts_on > row.ends_on)))) {
    throw new Error("Your attendance assignments could not be verified. Refresh to check your access.");
  }
  return data;
}
