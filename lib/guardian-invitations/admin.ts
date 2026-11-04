import type { SupabaseClient } from "@supabase/supabase-js";

export type GuardianInvitation = {
  id: string;
  email: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
};

type IssuedInvitation = Pick<GuardianInvitation, "id" | "expires_at"> & { token: string };

export function invitationStatus(invitation: GuardianInvitation, now: number) {
  if (invitation.accepted_at) return "Accepted";
  if (invitation.revoked_at) return "Revoked";
  return Date.parse(invitation.expires_at) <= now ? "Expired" : "Pending";
}

export async function listGuardianInvitations(client: SupabaseClient, schoolId: string, studentId: string) {
  const { data, error } = await client.rpc("list_guardian_invitations", {
    p_school_id: schoolId,
    p_student_id: studentId,
  });
  if (error || !Array.isArray(data) || data.some((item: Partial<GuardianInvitation> | null) =>
    !item || typeof item.id !== "string" || typeof item.email !== "string" ||
    typeof item.expires_at !== "string" || !Number.isFinite(Date.parse(item.expires_at)),
  )) throw new Error("Invitation history could not be loaded. Try again.");
  return data as GuardianInvitation[];
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
  if (!data || typeof data.id !== "string" || typeof data.token !== "string" || !/^[0-9a-f]{64}$/.test(data.token) ||
      typeof data.expires_at !== "string" || !Number.isFinite(Date.parse(data.expires_at))) {
    throw new Error("The link was unavailable. Create a replacement invitation to continue.");
  }
  return data;
}

export async function revokeGuardianInvitation(client: SupabaseClient, invitationId: string) {
  const { data, error } = await client.rpc("revoke_guardian_invitation", { p_invitation_id: invitationId });
  if (error || typeof data !== "boolean") throw new Error("The invitation could not be revoked. Refresh and try again.");
  return data;
}
