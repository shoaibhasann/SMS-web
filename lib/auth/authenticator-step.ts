import type { SupabaseClient } from "@supabase/supabase-js";
import { readStaffMfaStatus } from "@/lib/auth/staff-mfa";

/** 42501 at aal1 can mean "verify your authenticator"; only the database's own MFA status decides, and a failed read keeps the old message. */
export async function needsAuthenticatorStep(client: SupabaseClient, userId: string) {
  const status = await readStaffMfaStatus(client, userId).catch(() => null);
  return !!status && !status.allowed && (status.action === "challenge" || status.action === "enroll");
}
