import type { SupabaseClient } from "@supabase/supabase-js";
import type { AttendanceStatus } from "./types";

export type FamilyStudent = {
  id: string;
  school_id: string;
  admission_no: string;
  first_name: string;
  middle_name?: string | null;
  last_name?: string | null;
  roll_no?: string | null;
  status: string;
};

export type FamilyAttendanceRow = {
  attendance_date: string;
  academic_year_id: string;
  status: AttendanceStatus;
};

export const guardianAttendancePath = "/modules/attendance?view=guardian";

const studentColumns = "id,school_id,admission_no,first_name,middle_name,last_name,roll_no,status";

export async function loadFamilyStudents(
  client: SupabaseClient,
  role: "student" | "parent",
  userId: string,
): Promise<FamilyStudent[]> {
  if (role === "student") {
    const { data, error } = await client.from("students").select(studentColumns)
      .eq("profile_id", userId).returns<FamilyStudent[]>().maybeSingle();
    if (error) throw new Error("Your student profile could not be loaded. Refresh to try again.");
    return data ? [data] : [];
  }

  const { data: parent, error: parentError } = await client.from("parents").select("id,school_id")
    .eq("profile_id", userId).returns<{ id: string; school_id: string }[]>().maybeSingle();
  if (parentError) throw new Error("Your parent profile could not be loaded. Refresh to try again.");
  if (!parent) throw new Error("No parent profile is linked to this account.");

  const { data: links, error: linksError } = await client.from("student_parents")
    .select("student_id").eq("parent_id", parent.id).returns<{ student_id: string }[]>();
  if (linksError) throw new Error("Your linked children could not be loaded. Refresh to try again.");
  const ids = (links ?? []).map((link) => link.student_id);
  if (!ids.length) return [];

  const { data: students, error: studentsError } = await client.from("students").select(studentColumns)
    .eq("school_id", parent.school_id).in("id", ids).order("first_name").order("id").returns<FamilyStudent[]>();
  if (studentsError || !students?.length) {
    throw new Error("Your linked student profiles could not be loaded. Refresh to try again.");
  }
  return students;
}

export async function loadFamilyAttendance(
  client: SupabaseClient,
  student: FamilyStudent,
  { offset = 0, limit = 60 }: { offset?: number; limit?: number } = {},
): Promise<{ rows: FamilyAttendanceRow[]; count: number; error: boolean }> {
  const { data, count, error } = await client.from("attendance")
    .select("attendance_date,status,academic_year_id", { count: "exact" })
    .eq("school_id", student.school_id).eq("student_id", student.id)
    .order("attendance_date", { ascending: false })
    .range(offset, offset + limit - 1).returns<FamilyAttendanceRow[]>();
  if (error) return { rows: [], count: 0, error: true };
  const rows = data ?? [];
  return { rows, count: count ?? rows.length, error: false };
}

function familyChildKey(userId: string) {
  return `erp:parent-child:${userId}`;
}

export function restoreFamilyChild(userId: string, students: readonly FamilyStudent[]): string {
  let previous: string | null = null;
  try { previous = sessionStorage.getItem(familyChildKey(userId)); } catch { /* Storage may be disabled. */ }
  return students.find((student) => student.id === previous)?.id ?? students[0]?.id ?? "";
}

export function rememberFamilyChild(userId: string, childId: string): boolean {
  try {
    sessionStorage.setItem(familyChildKey(userId), childId);
    return true;
  } catch {
    return false;
  }
}
