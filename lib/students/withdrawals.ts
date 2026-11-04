import type { SupabaseClient } from "@supabase/supabase-js";
import type { AttendanceContext } from "@/lib/attendance/types";

export type RosterWithdrawal = {
  enrollment_id: string;
  student_name: string;
  admission_no: string;
  reason: string;
  withdrawn_by_name: string;
  withdrawn_at: string;
};

function scopeParameters(context: AttendanceContext) {
  return {
    p_school_id: context.schoolId,
    p_academic_year_id: context.academicYearId,
    p_class_id: context.classId,
    p_section_id: context.sectionId,
  };
}

export async function withdrawRosterStudent(
  client: SupabaseClient,
  context: AttendanceContext,
  studentId: string,
  reason: string,
) {
  const { data, error } = await client.rpc("withdraw_roster_enrollment", {
    ...scopeParameters(context),
    p_student_id: studentId,
    p_reason: reason.trim(),
  });
  if (error?.code === "42501") throw new Error("You cannot withdraw students for this school.");
  if (error?.code === "22023") throw new Error("Check the reason and reload the current roster. The enrollment may no longer be active.");
  if (error || typeof data !== "string" || !data) {
    throw new Error("The withdrawal could not be confirmed. Retry with the same reason or reload the roster.");
  }
}

export async function listRosterWithdrawals(client: SupabaseClient, context: AttendanceContext) {
  const { data, error } = await client.rpc("list_roster_withdrawals", scopeParameters(context));
  if (error || !Array.isArray(data)) throw new Error("Withdrawal history could not be loaded. Reload the roster to try again.");
  return data as RosterWithdrawal[];
}
