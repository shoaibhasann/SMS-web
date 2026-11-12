// The one password length rule for every screen and route that sets a password. Dependency-free on purpose:
// it is imported by client components and by the recovery route handler.
// Hosted Supabase Auth has its own "Minimum password length" setting; it must be this value or lower.
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_BYTES = 72; // bcrypt ignores anything after 72 bytes

export type PasswordProblem = "too_short" | "too_long";

/** Characters are counted as code points (an emoji is one); a whitespace-only password is never long enough. */
export function passwordProblem(password: string): PasswordProblem | null {
  if ([...password].length < MIN_PASSWORD_LENGTH || !password.trim()) return "too_short";
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) return "too_long";
  return null;
}
