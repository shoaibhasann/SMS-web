import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { safeAuthRedirect } from "./redirect";

export type StaffMfaStatus = {
  user_id: string; profile_school_id: string | null; roles: { role: string; school_id: string | null }[];
  required: boolean; allowed: boolean; action: "none" | "enroll" | "challenge" | "sign_in";
  current_aal: "aal1" | "aal2"; verified_totp_count: number; staff: boolean; policy_required: boolean;
  dashboard_allowed?: boolean;
};
export class StaffMfaError extends Error {
  constructor(message: string, readonly code: "access" | "verification" | "rate_limited" | "unconfirmed" = "unconfirmed") {
    super(message); this.name = "StaffMfaError";
  }
}
export class StaffMfaRequiredError extends StaffMfaError {
  constructor(readonly status: StaffMfaStatus) { super("Complete authenticator verification before opening your workspace.", "access"); }
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 100;

export function parseStaffMfaStatus(value: unknown, userId: string): StaffMfaStatus {
  const row = object(value);
  if (row.user_id !== userId || !id(row.user_id) || !(row.profile_school_id === null || id(row.profile_school_id))
    || !Array.isArray(row.roles) || row.roles.length > 100 || !row.roles.every((item) => {
      const role = object(item); return id(role.role) && (role.school_id === null || id(role.school_id));
    }) || !["none", "enroll", "challenge", "sign_in"].includes(String(row.action))
    || !["aal1", "aal2"].includes(String(row.current_aal)) || !Number.isSafeInteger(row.verified_totp_count) || Number(row.verified_totp_count) < 0
    || !["required", "allowed", "staff", "policy_required"].every((key) => typeof row[key] === "boolean")
    || row.allowed !== (row.action === "none") || (row.required && row.allowed && row.current_aal !== "aal2")
    || (Number(row.verified_totp_count) > 0 && row.required !== true) || (row.policy_required && row.required !== true)
    || (row.allowed && row.current_aal === "aal2" && Number(row.verified_totp_count) < 1)
    || (row.action === "challenge" && Number(row.verified_totp_count) < 1) || (row.action === "enroll" && Number(row.verified_totp_count) > 0)) {
    throw new StaffMfaError("Your account security could not be verified. Sign in again or retry.");
  }
  const status = value as StaffMfaStatus;
  if ((row.dashboard_allowed !== undefined && typeof row.dashboard_allowed !== "boolean")
    || (status.dashboard_allowed && (
      !status.required || status.allowed || !status.staff || status.action !== "challenge"
      || status.current_aal !== "aal1" || !status.profile_school_id || status.roles.length !== 1
      || status.roles[0].role !== "school_admin" || status.roles[0].school_id !== status.profile_school_id
    ))) {
    throw new StaffMfaError("Your account security could not be verified. Sign in again or retry.");
  }
  return status;
}

function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Request cancelled.", "AbortError");
}
export async function boundMfaSession(client: SupabaseClient, userId?: string, signal?: AbortSignal): Promise<Session | null> {
  cancelled(signal);
  const current = await client.auth.getSession();
  cancelled(signal);
  if (current.error) throw new StaffMfaError("Sign in again to verify account security.", "access");
  const session = current.data.session;
  if (!session) return null;
  if (userId && session.user.id !== userId) throw new StaffMfaError("Your account changed. Reopen account security.", "access");
  const verified = await client.auth.getUser(session.access_token);
  cancelled(signal);
  if (verified.error || !verified.data.user || verified.data.user.is_anonymous || verified.data.user.id !== session.user.id) {
    throw new StaffMfaError("Your account changed or signed out. Sign in again.", "access");
  }
  return session;
}

/** Read the database's current MFA decision using the verified session. */
export async function readStaffMfaStatus(client: SupabaseClient, userId?: string, signal?: AbortSignal): Promise<StaffMfaStatus | null> {
  const session = await boundMfaSession(client, userId, signal);
  if (!session) return null;
  const result = await client.rpc("get_my_staff_mfa_status").setHeader("Authorization", `Bearer ${session.access_token}`)
    .abortSignal(signal ?? new AbortController().signal);
  cancelled(signal);
  if (result.error) throw new StaffMfaError("Account security could not be checked. Retry or sign in again.", "access");
  return parseStaffMfaStatus(result.data, session.user.id);
}

/** MFA continuations are a small allowlist, including existing verified invitation/contact routes. */
export function safeMfaNext(next: string | null): string {
  // Invitation bearer fragments must never become an encoded HTTP query parameter.
  const value = safeAuthRedirect(next).split("#", 1)[0];
  const pathname = value.split(/[?#]/, 1)[0];
  return pathname === "/dashboard" || pathname === "/account/settings" || pathname === "/activate"
    || pathname === "/guardian-invite" || pathname === "/guardian-mobile-invite" || pathname === "/teacher-invite" || pathname === "/guardian-recover" || /^\/modules\/[a-z0-9-]+$/.test(pathname)
    ? value : "/dashboard";
}
export const mfaPath = (next: string) => `/mfa?next=${encodeURIComponent(safeMfaNext(next))}`;
export const dashboardStepUpPath = `${mfaPath("/dashboard")}&stepup=1`;

function providerError(error: { code?: string; status?: number } | null, fallback = "Authenticator verification could not be confirmed. Retry verification before continuing.") {
  if (!error) return;
  if (error.status === 429 || /rate_limit/.test(error.code ?? "")) throw new StaffMfaError("Too many attempts. Wait before trying again.", "rate_limited");
  if (error.code === "mfa_challenge_expired") {
    throw new StaffMfaError("Code expired. Use the latest six-digit code.", "verification");
  }
  if (["mfa_verification_failed", "validation_failed"].includes(error.code ?? "")) {
    throw new StaffMfaError("Incorrect code. Try the latest six-digit code.", "verification");
  }
  if (["insufficient_aal", "mfa_factor_not_found", "session_not_found", "refresh_token_not_found"].includes(error.code ?? "")) {
    throw new StaffMfaError("Your security session changed. Sign in and verify your authenticator again.", "access");
  }
  throw new StaffMfaError(fallback);
}

/** Own-session client: late MFA responses must never replace another browser account's session. */
export async function createBoundMfaClient(primary: SupabaseClient, userId: string, signal?: AbortSignal): Promise<SupabaseClient> {
  const session = await boundMfaSession(primary, userId, signal);
  if (!session) throw new StaffMfaError("Sign in again to manage your authenticator.", "access");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new StaffMfaError("Authenticator settings are unavailable. Contact your school.");
  const isolated = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: `staff-mfa-${crypto.randomUUID()}` },
    global: signal ? { fetch: (input, init) => fetch(input, { ...init, signal }) } : undefined,
  });
  const bound = await isolated.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  cancelled(signal);
  providerError(bound.error);
  if (bound.data.user?.id !== userId) throw new StaffMfaError("Your account changed. Sign in again.", "access");
  return isolated;
}

export type AuthenticatorFactor = { id: string; friendly_name?: string; created_at: string };
export async function listAuthenticators(client: SupabaseClient): Promise<AuthenticatorFactor[]> {
  const result = await client.auth.mfa.listFactors();
  providerError(result.error, "Your authenticators could not be loaded. Retry to check their status.");
  return result.data?.totp ?? [];
}
export async function enrollAuthenticator(client: SupabaseClient, friendlyName: string) {
  const name = friendlyName.trim();
  if (name.length < 2 || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) throw new StaffMfaError("Use a 2–60 character device name.", "verification");
  const result = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: name, issuer: "SMS School" });
  providerError(result.error, "Setup could not be confirmed. Refresh the authenticator list before starting another setup.");
  if (!result.data || result.data.type !== "totp") throw new StaffMfaError("Authenticator setup could not be confirmed.");
  return { id: result.data.id, secret: result.data.totp.secret, qr: result.data.totp.qr_code };
}
export async function verifyAuthenticator(client: SupabaseClient, factorId: string, code: string) {
  if (!/^\d{6}$/.test(code)) throw new StaffMfaError("Enter the six-digit code from your authenticator app.", "verification");
  const result = await client.auth.mfa.challengeAndVerify({ factorId, code });
  providerError(result.error);
}
export async function removeAuthenticator(client: SupabaseClient, factorId: string) {
  const result = await client.auth.mfa.unenroll({ factorId });
  providerError(result.error, "Removal could not be confirmed. Reload your authenticators before trying again.");
}
export async function refreshMfaSession(primary: SupabaseClient, userId: string, signal?: AbortSignal): Promise<StaffMfaStatus> {
  cancelled(signal);
  const before = await boundMfaSession(primary, userId, signal);
  if (!before) throw new StaffMfaError("Sign in again to verify account security.", "access");
  // Let Auth refresh the CURRENT browser session, with its own stale-response guards. Never adopt isolated A tokens.
  const refreshed = await primary.auth.refreshSession();
  cancelled(signal);
  providerError(refreshed.error);
  if (refreshed.data.user?.id !== userId) throw new StaffMfaError("Your account changed. Reopen account security.", "access");
  const status = await readStaffMfaStatus(primary, userId, signal);
  if (!status) throw new StaffMfaError("Sign in again to verify account security.", "access");
  return status;
}
