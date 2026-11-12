import type { SupabaseClient } from "@supabase/supabase-js";
import type { AttendanceContext } from "@/lib/attendance/types";

export type PlacementYear = { id: string; name: string; start_date: string; end_date: string; is_current: boolean };

export type RosterPlacementChange = {
  request_id: string;
  student_name: string;
  admission_no: string;
  change_kind: "move" | "promotion";
  destination_year_name: string;
  destination_class_name: string;
  destination_section_name: string;
  effective_date: string;
  reason: string;
  changed_by_name: string | null;
  changed_at: string;
};

export async function changeRosterPlacement(
  client: SupabaseClient,
  source: AttendanceContext,
  sourceEnrollmentId: string,
  destination: Omit<AttendanceContext, "schoolId">,
  reason: string,
  requestId: string,
) {
  const { data, error } = await client.rpc("change_roster_placement", {
    p_school_id: source.schoolId,
    p_source_enrollment_id: sourceEnrollmentId,
    p_expected_class_id: source.classId,
    p_expected_section_id: source.sectionId,
    p_destination_academic_year_id: destination.academicYearId,
    p_destination_class_id: destination.classId,
    p_destination_section_id: destination.sectionId,
    p_reason: reason.trim(),
    p_request_id: requestId,
  });
  if (error?.code === "42501") throw new Error("You cannot change enrollment for this school.");
  if (error?.code === "55000") {
    if (error.message.startsWith("Resolve pending attendance corrections")) {
      throw new Error("Resolve this student’s pending attendance corrections before changing placement.");
    }
    if (error.message.startsWith("Attendance already exists")) {
      throw new Error("Attendance is already marked for today or a later date. Move the student on a day before attendance is marked.");
    }
    throw new Error("This student may have already moved today. Reload the roster and check placement history.");
  }
  if (error?.code === "22023") throw new Error("Check the destination and reload the roster. The current enrollment or academic year may have changed.");
  if (error?.code === "23505") {
    if (error.message === "This pupil already has this staged placement.") {
      throw new Error("This promotion is already staged for this class and section. Choose a different class or section to revise it.");
    }
    throw new Error("A placement already exists in this academic year. Reload the roster and check the placement history.");
  }
  if (error || typeof data !== "string" || !data) {
    throw new Error("The placement could not be confirmed. Retry with the same destination and reason, or check placement history.");
  }
}

export async function stageSectionPromotions(
  client: SupabaseClient,
  source: AttendanceContext,
  enrollmentIds: string[],
  destination: Omit<AttendanceContext, "schoolId">,
  reason: string,
  requestId: string,
) {
  const { data, error } = await client.rpc("stage_section_promotions", {
    p_school_id: source.schoolId,
    p_source_class_id: source.classId,
    p_source_section_id: source.sectionId,
    p_enrollment_ids: enrollmentIds,
    p_destination_academic_year_id: destination.academicYearId,
    p_destination_class_id: destination.classId,
    p_destination_section_id: destination.sectionId,
    p_reason: reason.trim(),
    p_request_id: requestId,
  });
  // The database names the blocking pupil as "Pupil <admission no>: ...".
  const pupil = error?.message.match(/^Pupil ([^:]+):/)?.[1];
  const prefix = pupil ? `Nothing was staged. Pupil ${pupil}: ` : "Nothing was staged. ";
  if (error?.code === "42501") throw new Error("You cannot change enrollment for this school.");
  if (error?.code === "55000") {
    throw new Error(`${prefix}Resolve this student’s pending attendance corrections, or untick the student, and try again.`);
  }
  if (error?.code === "22023") {
    throw new Error(`${prefix}Check the destination and reload the roster. The pupil list, enrollment or academic year may have changed.`);
  }
  if (error?.code === "23505") {
    throw new Error(`${prefix}A placement already exists in the destination year. Untick the student or check the placement history.`);
  }
  const result = data as { staged?: unknown; already_staged?: unknown } | null;
  if (error || typeof result?.staged !== "number" || typeof result.already_staged !== "number") {
    throw new Error("The promotion could not be confirmed. Retry with the same destination and reason, or check placement history.");
  }
  return { staged: result.staged, alreadyStaged: result.already_staged };
}

export async function listRosterPlacementChanges(client: SupabaseClient, source: AttendanceContext) {
  const { data, error } = await client.rpc("list_roster_placement_changes", {
    p_school_id: source.schoolId,
    p_academic_year_id: source.academicYearId,
    p_class_id: source.classId,
    p_section_id: source.sectionId,
  });
  if (error || !Array.isArray(data)) throw new Error("Placement history could not be loaded. Close and reopen to try again.");
  return data as RosterPlacementChange[];
}
