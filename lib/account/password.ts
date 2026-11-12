import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createBoundMfaClient, readStaffMfaStatus } from "@/lib/auth/staff-mfa";
import { MIN_PASSWORD_LENGTH, passwordProblem } from "@/lib/account/password-rule";

export type PasswordChange = { currentPassword: string; newPassword: string; confirmation: string };
export type PasswordChangeResult = { changed: true; temporarySessionClosed: boolean };
export class PasswordChangeError extends Error {
  constructor(message: string, readonly code = "") { super(message); this.name = "PasswordChangeError"; }
}

export function validateNewPassword(newPassword: string, confirmation: string): string | null {
  const problem = passwordProblem(newPassword);
  if (problem === "too_short") return `Use at least ${MIN_PASSWORD_LENGTH} characters for your new password.`;
  if (problem === "too_long") return "That password is too long. Try a shorter password.";
  if (newPassword !== confirmation) return "New password and confirmation do not match.";
  return null;
}

export function validatePasswordChange(input: PasswordChange): string | null {
  if (!input.currentPassword) return "Enter your current password.";
  const invalid = validateNewPassword(input.newPassword, input.newPassword);
  if (invalid) return invalid;
  if (input.newPassword === input.currentPassword) return "Choose a new password different from your current password.";
  return validateNewPassword(input.newPassword, input.confirmation);
}

function failed(error: { code?: string; status?: number } | null, phase: "verify" | "update") {
  if (!error) return;
  if (error.status === 429 || ["over_request_rate_limit", "over_email_send_rate_limit"].includes(error.code ?? "")) {
    throw new PasswordChangeError("Too many attempts. Wait before trying again.", "rate_limited");
  }
  if (error.code === "weak_password") throw new PasswordChangeError("Choose a stronger new password and try again.", "weak_password");
  if (["reauthentication_needed", "reauthentication_not_valid"].includes(error.code ?? "")) {
    throw new PasswordChangeError("Additional account verification is required. Use password recovery or contact your school.", "reauthentication_needed");
  }
  throw new PasswordChangeError(phase === "verify"
    ? "Current password could not be verified. Check it and try again. If you use Google only, use password recovery first."
    : "The password change could not be confirmed. Try signing in with the new password before retrying.", phase === "verify" ? "verification_failed" : "unconfirmed");
}

function checkOwner(user: { id: string; email?: string; is_anonymous?: boolean } | null, ownerId: string, email?: string, signal?: AbortSignal) {
  if (signal?.aborted || !user || user.is_anonymous || user.id !== ownerId || !user.email || (email !== undefined && user.email !== email)) {
    throw new PasswordChangeError("Your account changed or signed out. Reopen settings before changing a password.", "account_changed");
  }
  return user.email;
}

export async function changeOwnPassword(primary: SupabaseClient, ownerId: string, input: PasswordChange,
  signal?: AbortSignal): Promise<PasswordChangeResult> {
  const invalid = validatePasswordChange(input);
  if (invalid) throw new PasswordChangeError(invalid, "validation");
  const original = await primary.auth.getUser();
  if (original.error) throw new PasswordChangeError("Sign in again before changing your password.", "account_changed");
  const email = checkOwner(original.data.user, ownerId, undefined, signal);
  if (!original.data.user?.email_confirmed_at) throw new PasswordChangeError("Verify your account email before changing your password.", "unverified_email");
  const security = await readStaffMfaStatus(primary, ownerId, signal);
  if (!security?.allowed) throw new PasswordChangeError("Verify your authenticator before changing your password.", "mfa_required");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new PasswordChangeError("Password settings are unavailable. Contact your school.", "configuration");
  // A fresh non-persistent client cannot replace the browser's school session.
  const verifier = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  let temporarySessionClosed = false;
  try {
    const verified = await verifier.auth.signInWithPassword({ email, password: input.currentPassword });
    failed(verified.error, "verify");
    checkOwner(verified.data.user, ownerId, email, signal);
    if (!verified.data.session) throw new PasswordChangeError("Your current password could not be verified. Sign in again.", "verification_failed");
    const current = await primary.auth.getUser();
    if (current.error) throw new PasswordChangeError("Your sign-in changed. Reopen settings before trying again.", "account_changed");
    checkOwner(current.data.user, ownerId, email, signal);
    const currentSecurity = await readStaffMfaStatus(primary, ownerId, signal);
    if (!currentSecurity?.allowed) throw new PasswordChangeError("Verify your authenticator before changing your password.", "mfa_required");
    // Mutate through the browser's own session: Auth keeps only the caller's session after a password change,
    // and it never downgrades AAL2. The verifier only proves the current password.
    const mutationClient = await createBoundMfaClient(primary, ownerId, signal);
    const updated = await mutationClient.auth.updateUser({ password: input.newPassword, current_password: input.currentPassword });
    failed(updated.error, "update");
    if (updated.data.user?.id !== ownerId) throw new PasswordChangeError("The password change could not be confirmed. Try signing in with the new password before retrying.", "unconfirmed");
  } catch (error) {
    if (error instanceof PasswordChangeError) throw error;
    throw new PasswordChangeError("The password change could not be confirmed. Try signing in with the new password before retrying.", "unconfirmed");
  } finally {
    try {
      const closed = await verifier.auth.signOut({ scope: "local" });
      temporarySessionClosed = !closed.error;
    } catch { /* Password confirmation remains valid if temporary cleanup fails. */ }
  }
  return { changed: true, temporarySessionClosed };
}
