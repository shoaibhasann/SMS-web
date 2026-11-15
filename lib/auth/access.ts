import type { SupabaseClient } from "@supabase/supabase-js";
import { toUiRole } from "./roles";
import { readStaffMfaStatus, StaffMfaRequiredError } from "./staff-mfa";

export type ActiveSchoolAccess = {
  userId: string;
  profileSchoolId: string | null;
  roles: { role: string; school_id: string | null }[];
};

/** A definite "no" from the access check, as opposed to a read that failed. */
export class SchoolAccessDeniedError extends Error {}

export async function readActiveSchoolAccess(client: SupabaseClient): Promise<ActiveSchoolAccess | null> {
  const security = await readStaffMfaStatus(client);
  if (!security) return null;
  if (!security.allowed) throw new StaffMfaRequiredError(security);
  const { data: { user }, error } = await client.auth.getUser();
  if (error) throw error;
  if (!user) return null;
  if (user.id !== security.user_id) throw new SchoolAccessDeniedError("Your account changed. Reopen the workspace.");
  if (user.is_anonymous) throw new SchoolAccessDeniedError("A verified school account is required.");
  const [profileResult, rolesResult] = await Promise.all([
    client.from("profiles").select("is_active,school_id").eq("id", user.id).maybeSingle(),
    client.from("user_roles").select("role,school_id").eq("user_id", user.id),
  ]);
  if (profileResult.error) throw profileResult.error;
  if (rolesResult.error) throw rolesResult.error;
  if (profileResult.data?.is_active !== true) throw new SchoolAccessDeniedError("Your school account is inactive or unavailable.");
  const roles = (rolesResult.data ?? []).filter((row) => toUiRole(row.role) && (row.role === "super_admin"
    ? row.school_id === null : typeof row.school_id === "string" && row.school_id.length > 0));
  return { userId: user.id, profileSchoolId: profileResult.data.school_id ?? null, roles };
}
