import type { SupabaseClient } from "@supabase/supabase-js";
import { readPages } from "@/lib/attendance/repository";
import { isInvitationList, isIssuedInvitation } from "@/lib/invitations/model";

export type TeacherRecord = {
  id: string;
  full_name: string | null;
  employee_id: string;
  profile_id: string | null;
};

export function listTeachers(client: SupabaseClient, schoolId: string) {
  return readPages<TeacherRecord>((from, to) => client.from("teachers")
    .select("id,full_name,employee_id,profile_id", { count: "exact" })
    .eq("school_id", schoolId).order("full_name").order("id").range(from, to),
  "Teachers could not be loaded");
}

export async function createTeacherRecord(client: SupabaseClient, schoolId: string, employeeId: string, fullName: string) {
  const { data, error } = await client.rpc("create_teacher_record", {
    p_school_id: schoolId, p_employee_id: employeeId, p_full_name: fullName,
  });
  if (error?.code === "23505") throw new Error("This employee ID is already used in the selected school.");
  if (error?.code === "22023") throw new Error("Enter a valid employee ID and teacher name.");
  if (error || typeof data !== "string") throw new Error("The teacher could not be added. Check your school access and try again.");
  return data;
}

export async function listTeacherInvitations(client: SupabaseClient, teacherId: string) {
  const { data, error } = await client.rpc("list_teacher_invitations", { p_teacher_id: teacherId });
  if (error || !isInvitationList(data)) throw new Error("The invitation history could not be loaded.");
  return data;
}

export async function issueTeacherInvitation(client: SupabaseClient, teacherId: string, email: string) {
  const { data, error } = await client.rpc("issue_teacher_invitation", { p_teacher_id: teacherId, p_email: email });
  if (error?.code === "22023") throw new Error("Enter a valid teacher email address.");
  if (error?.code === "P0001") throw new Error("This teacher already has a linked account. Refresh the directory.");
  if (error || !isIssuedInvitation(data)) throw new Error("The invitation could not be created. Check your school access and try again.");
  return data;
}

export async function revokeTeacherInvitation(client: SupabaseClient, invitationId: string) {
  const { data, error } = await client.rpc("revoke_teacher_invitation", { p_invitation_id: invitationId });
  if (error || typeof data !== "boolean") throw new Error("The invitation could not be revoked.");
  return data;
}

export type NonTeachingStaffRecord = {
  id: string;
  full_name: string | null;
  employee_id: string;
  designation: string | null;
  department: string | null;
};

export function listNonTeachingStaff(client: SupabaseClient, schoolId: string) {
  return readPages<NonTeachingStaffRecord>((from, to) => client.from("staff")
    .select("id,full_name,employee_id,designation,department", { count: "exact" })
    .eq("school_id", schoolId).order("full_name").order("id").range(from, to),
  "Non-teaching staff could not be loaded");
}
