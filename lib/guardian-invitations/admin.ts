import type { SupabaseClient } from "@supabase/supabase-js";

import { isInvitationList, isIssuedInvitation, type IssuedInvitation, type SchoolInvitation } from "@/lib/invitations/model";

export { invitationStatus } from "@/lib/invitations/model";
export type GuardianInvitation = SchoolInvitation;

export async function listGuardianInvitations(client: SupabaseClient, schoolId: string, studentId: string) {
  const { data, error } = await client.rpc("list_guardian_invitations", {
    p_school_id: schoolId,
    p_student_id: studentId,
  });
  if (error || !isInvitationList(data)) throw new Error("Invitation history could not be loaded. Try again.");
  return data;
}

export async function issueGuardianInvitation(
  client: SupabaseClient,
  schoolId: string,
  studentId: string,
  email: string,
): Promise<IssuedInvitation> {
  const { data, error } = await client.rpc("issue_guardian_invitation", {
    p_school_id: schoolId,
    p_student_id: studentId,
    p_email: email,
  });
  if (error) {
    if (error.code === "42501") throw new Error("This student is outside your invitation access. Refresh and check the school and student.");
    if (error.code === "22023") throw new Error("Enter the guardian’s full email address.");
    if (error.code === "P0001") throw new Error("The student needs an active enrollment in the current academic year. Refresh the roster and check the enrollment.");
    throw new Error("The invitation could not be created. Try again.");
  }
  if (!isIssuedInvitation(data)) {
    throw new Error("The link was unavailable. Create a replacement invitation to continue.");
  }
  return data;
}

export async function revokeGuardianInvitation(client: SupabaseClient, invitationId: string) {
  const { data, error } = await client.rpc("revoke_guardian_invitation", { p_invitation_id: invitationId });
  if (error || typeof data !== "boolean") throw new Error("The invitation could not be revoked. Refresh and try again.");
  return data;
}
