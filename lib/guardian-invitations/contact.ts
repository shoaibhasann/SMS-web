import { createClient as createSupabaseClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { normalizeIndianMobile, phoneAuthError, prepareGuardianPhoneRequest, readGuardianPhoneStatus } from "@/lib/auth/phone";
import { createBoundMfaClient, listAuthenticators, readStaffMfaStatus, StaffMfaError, verifyAuthenticator, type AuthenticatorFactor } from "@/lib/auth/staff-mfa";
import { validateNewPassword } from "@/lib/account/password";

export type GuardianContactProviders = { email: boolean; sms: boolean; captchaSiteKey?: string | null };

const canonicalPhone = /^\+[1-9]\d{7,14}$/;

export function guardianPhone(value: string | null | undefined) {
  if (!value) return "";
  const digits = value.trim().replace(/[\s()-]/g, "");
  const phone = digits.startsWith("+") ? digits : `+${digits}`;
  return canonicalPhone.test(phone) ? phone : "";
}

// Throws when the settings cannot be read (including a hung read past the timeout); a resolved sms:false means SMS is really off.
export async function readGuardianContactProviders(signal: AbortSignal = AbortSignal.timeout(10_000)): Promise<GuardianContactProviders> {
  const unavailable = (): never => { throw new Error("Contact verification settings are temporarily unavailable."); };
  const url = new URL("/auth/v1/settings", process.env.NEXT_PUBLIC_SUPABASE_URL);
  const response = await fetch(url, {
    headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY! },
    cache: "no-store", signal,
  }).catch(unavailable);
  if (!response.ok) unavailable();
  const settings = await response.json().catch(unavailable);
  const mobile = await readGuardianPhoneStatus(signal).catch(unavailable);
  return {
    email: settings?.external?.email === true && settings.mailer_autoconfirm === false,
    sms: settings?.external?.phone === true && settings.phone_autoconfirm === false && mobile.enabled,
    captchaSiteKey: mobile.captchaSiteKey,
  };
}

export async function readGuardianAuthUser(client: SupabaseClient, userId: string): Promise<User> {
  const { data, error } = await client.auth.getUser();
  if (error || !data.user || data.user.id !== userId || data.user.is_anonymous) {
    throw new Error("Sign in again to manage this guardian account.");
  }
  return data.user;
}

export async function syncVerifiedGuardianMobile(client: SupabaseClient, phone: string) {
  const { data, error } = await client.rpc("sync_my_guardian_mobile");
  return !error && guardianPhone(typeof data === "string" ? data : null) === phone;
}

export function createGuardianVerificationClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storageKey: `guardian-contact-${crypto.randomUUID()}`,
      },
    },
  );
}

async function closeTemporarySession(client: SupabaseClient) {
  try {
    await client.auth.signOut({ scope: "local" });
  } catch {
    // The temporary client keeps no browser storage or refresh task.
  }
}

type ContactError = { code?: string; status?: number };

function verificationError(error: ContactError | null, method: "email" | "sms", verifying = false) {
  if (error?.code === "email_exists" || error?.code === "phone_exists" || error?.code === "user_already_exists") {
    return new Error("This contact is already used by an account. Check the details or contact the school office.");
  }
  if (error?.status === 429 || error?.code === "over_email_send_rate_limit" || error?.code === "over_sms_send_rate_limit") {
    return new Error("Too many verification requests. Wait a few minutes and try again.");
  }
  if (method === "email" && error?.code === "email_address_not_authorized") {
    return new Error("The school’s email service could not send to this address. Contact the school office.");
  }
  if (method === "sms" && (error?.code === "phone_provider_disabled" || error?.code === "sms_send_failed")) {
    return new Error("The school’s SMS service could not send a code. Contact the school office or try again later.");
  }
  return new Error(verifying ? "The SMS code could not be verified. Check the code or request a new one."
    : method === "email" ? "Email confirmation could not be started. Check the address or try again later."
      : "The SMS code could not be requested. Check the mobile number or try again later.");
}

export async function requestGuardianEmailChange(client: SupabaseClient, userId: string, email: string, _origin: string, signal?: AbortSignal) {
  const current = await readGuardianAuthUser(client, userId);
  const nextEmail = email.trim().toLowerCase();
  if (!current.email_confirmed_at || !current.email) throw new Error("A verified sign-in email is required. Contact the school office.");
  if (nextEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail) || nextEmail === current.email.toLowerCase()) {
    throw new Error("Enter a different, valid email address.");
  }

  const response = await fetch("/auth/contact/email", { method: "POST", cache: "no-store", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId, email: nextEmail }) });
  if (!response.ok) throw new Error(response.status === 429 ? "Too many verification requests. Wait before trying again."
    : response.status === 409 ? "This email cannot be used for your account. Check the address or contact the school office."
    : response.status === 403 ? "Verify your account and authenticator before changing your email."
      : "Email confirmation could not be confirmed. Refresh contact details before trying again.");
  const updated = await readGuardianAuthUser(client, userId);
  if (signal?.aborted || updated.new_email?.toLowerCase() !== nextEmail) throw new Error("Refresh contact details to check whether email confirmation is pending.");
  return updated;
}

export type GuardianMobileProof = {
  client: SupabaseClient; userId: string; phone: string; previousPhone: string;
  factors: AuthenticatorFactor[]; needsMfa: boolean;
};
function cancelled(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException("Contact verification cancelled.", "AbortError"); }
async function primaryOwner(client: SupabaseClient, userId: string, signal?: AbortSignal) {
  cancelled(signal);
  // This is a UI ownership fence; the separately verified native proof session authorizes the mutation.
  const current = await client.auth.getSession();
  cancelled(signal);
  if (current.error || current.data.session?.user.id !== userId) throw new Error("Your account changed. Reopen contact settings before continuing.");
}
export async function closeGuardianMobileChange(proof: Pick<GuardianMobileProof, "client">) { await closeTemporarySession(proof.client); }

export async function beginGuardianMobileChange(client: SupabaseClient, verificationClient: SupabaseClient, userId: string, phone: string,
  proof: { password?: string; currentCode?: string }, signal?: AbortSignal): Promise<GuardianMobileProof> {
  const current = await readGuardianAuthUser(client, userId);
  cancelled(signal);
  const nextPhone = normalizeIndianMobile(phone), previousPhone = current.phone_confirmed_at ? guardianPhone(current.phone) : "";
  if (!nextPhone || nextPhone === previousPhone) throw new Error("Enter a different Indian mobile number.");
  try {
    if (current.email_confirmed_at && current.email) {
      if (!proof.password) throw new Error("Enter your current password.");
      const result = await verificationClient.auth.signInWithPassword({ email: current.email, password: proof.password });
      if (result.error?.status === 429) throw verificationError(result.error, "sms");
      if (result.error || !result.data.session || result.data.user?.id !== userId) throw new Error("The current password could not be verified.");
    } else {
      if (!previousPhone || !/^\d{6}$/.test(proof.currentCode?.trim() ?? "")) throw new Error("Enter the six-digit code sent to your current mobile.");
      const result = await verificationClient.auth.verifyOtp({ phone: previousPhone, token: proof.currentCode!.trim(), type: "sms" });
      if (result.error || !result.data.session || result.data.user?.id !== userId || !result.data.user.phone_confirmed_at
        || guardianPhone(result.data.user.phone) !== previousPhone) throw new Error(phoneAuthError(result.error, true));
    }
    await primaryOwner(client, userId, signal);
    const fresh = await readGuardianAuthUser(verificationClient, userId);
    if ((fresh.phone_confirmed_at ? guardianPhone(fresh.phone) : "") !== previousPhone) throw new Error("Your current mobile changed. Refresh contact details before continuing.");
    const security = await readStaffMfaStatus(verificationClient, userId, signal);
    if (!security || !security.allowed && security.action !== "challenge") throw new Error("Your account security changed. Sign in and verify it again.");
    const factors = security.action === "challenge" ? await listAuthenticators(verificationClient) : [];
    cancelled(signal);
    if (security.action === "challenge" && !factors.length) throw new Error("Your authenticator could not be loaded. Sign in again.");
    return { client: verificationClient, userId, phone: nextPhone, previousPhone, factors, needsMfa: security.action === "challenge" };
  } catch (error) { await closeTemporarySession(verificationClient); throw error; }
}

export async function completeGuardianMobileChange(client: SupabaseClient, proof: GuardianMobileProof, captchaToken?: string,
  mfa?: { factorId: string; code: string }, signal?: AbortSignal): Promise<User> {
  await primaryOwner(client, proof.userId, signal);
  const security = await readStaffMfaStatus(proof.client, proof.userId, signal);
  if (!security) throw new Error("Your verification session ended. Start again.");
  if (!security.allowed) {
    if (security.action !== "challenge" || !mfa || !proof.factors.some((factor) => factor.id === mfa.factorId)) {
      throw new StaffMfaError("Verify the authenticator for this password or current-mobile session before continuing.", "verification");
    }
    await verifyAuthenticator(proof.client, mfa.factorId, mfa.code);
    const checked = await readStaffMfaStatus(proof.client, proof.userId, signal);
    if (!checked?.allowed) throw new Error("Your account security could not be verified. Start again.");
  }
  await primaryOwner(client, proof.userId, signal);
  const fresh = await readGuardianAuthUser(proof.client, proof.userId);
  if ((fresh.phone_confirmed_at ? guardianPhone(fresh.phone) : "") !== proof.previousPhone) throw new Error("Your current mobile changed. Refresh contact details before continuing.");
  const authorization = await proof.client.rpc("authorize_my_guardian_phone_change", { p_phone: proof.phone });
  cancelled(signal);
  if (authorization.error?.code === "22023") throw new Error("Enter a different mobile number with its country code.");
  if (authorization.error || authorization.data !== true) throw new Error("The mobile change could not be authorized. Start a fresh verification.");
  if (captchaToken !== undefined) await prepareGuardianPhoneRequest(proof.phone, captchaToken);
  await primaryOwner(client, proof.userId, signal);
  const result = await proof.client.auth.updateUser({ phone: proof.phone });
  cancelled(signal);
  if (result.error?.code === "insufficient_aal") throw new StaffMfaError("Your authenticator verification changed. Start a fresh mobile verification.", "access");
  if (result.error || result.data.user?.id !== proof.userId || guardianPhone(result.data.user.new_phone) !== proof.phone) throw verificationError(result.error, "sms");
  return result.data.user;
}

export async function requestGuardianMobileChange(
  client: SupabaseClient, verificationClient: SupabaseClient, userId: string, phone: string, password: string,
  captchaToken?: string,
) {
  const current = await readGuardianAuthUser(client, userId);
  if (!current.email_confirmed_at || !current.email) throw new Error("A verified sign-in email is required. Contact the school office.");
  try {
    const proof = await beginGuardianMobileChange(client, verificationClient, userId, phone, { password });
    return await completeGuardianMobileChange(client, proof, captchaToken);
  } finally {
    await closeTemporarySession(verificationClient);
  }
}

export async function requestGuardianCurrentMobileCode(client: SupabaseClient, userId: string, captchaToken: string) {
  const user = await readGuardianAuthUser(client, userId);
  if (user.email_confirmed_at) throw new Error("Use current-password verification for this email account.");
  const phone = user.phone_confirmed_at && normalizeIndianMobile(user.phone ?? "");
  if (!phone) throw new Error("A verified current mobile is required. Contact the school office.");
  await prepareGuardianPhoneRequest(phone, captchaToken);
  const verificationClient = createGuardianVerificationClient();
  try {
    const { error } = await verificationClient.auth.signInWithOtp({ phone, options: { shouldCreateUser: false } });
    if (error) throw new Error(phoneAuthError(error));
    return phone;
  } finally { await closeTemporarySession(verificationClient); }
}

export async function requestGuardianMobileChangeWithOtp(
  client: SupabaseClient, verificationClient: SupabaseClient, userId: string, phone: string, code: string, captchaToken: string,
) {
  const current = await readGuardianAuthUser(client, userId);
  if (current.email_confirmed_at) throw new Error("Use current-password verification for this email account.");
  const previousPhone = current.phone_confirmed_at && normalizeIndianMobile(current.phone ?? "");
  const nextPhone = normalizeIndianMobile(phone);
  if (!previousPhone) throw new Error("A verified current mobile is required. Contact the school office.");
  if (!nextPhone || nextPhone === previousPhone) throw new Error("Enter a different Indian mobile number.");
  if (!/^\d{6}$/.test(code.trim())) throw new Error("Enter the six-digit code sent to your current mobile.");
  try {
    const proof = await beginGuardianMobileChange(client, verificationClient, userId, nextPhone, { currentCode: code });
    return await completeGuardianMobileChange(client, proof, captchaToken);
  } finally { await closeTemporarySession(verificationClient); }
}

export async function confirmGuardianMobileChange(
  client: SupabaseClient, verificationClient: SupabaseClient, userId: string, pendingPhone: string, code: string,
) {
  const current = await readGuardianAuthUser(client, userId);
  const phone = guardianPhone(pendingPhone);
  if (!phone || guardianPhone(current.new_phone) !== phone) throw new Error("The pending number changed. Refresh contact details and check it.");
  const token = code.trim();
  if (!/^\d{6}$/.test(token)) throw new Error("Enter the six-digit SMS code.");

  try {
    const { data, error } = await verificationClient.auth.verifyOtp({ phone, token, type: "phone_change" });
    if (error || data.user?.id !== userId || !data.user.phone_confirmed_at || guardianPhone(data.user.phone) !== phone) {
      throw verificationError(error, "sms", true);
    }
    const refreshed = await readGuardianAuthUser(client, userId);
    if (!refreshed.phone_confirmed_at || guardianPhone(refreshed.phone) !== phone) throw verificationError(null, "sms", true);
    return refreshed;
  } finally {
    await closeTemporarySession(verificationClient);
  }
}

export class SpentGuardianCodeError extends Error {}

export async function setGuardianAppPassword(client: SupabaseClient, verificationClient: SupabaseClient, userId: string,
  input: { code: string; newPassword: string; confirmation: string }, signal?: AbortSignal) {
  try {
    const current = await readGuardianAuthUser(client, userId);
    const phone = current.phone_confirmed_at && normalizeIndianMobile(current.phone ?? "");
    if (current.email_confirmed_at || !phone) throw new Error("A verified current mobile is required. Contact the school office.");
    const invalid = validateNewPassword(input.newPassword, input.confirmation);
    if (invalid) throw new Error(invalid);
    const code = input.code.trim();
    if (!/^\d{6}$/.test(code)) throw new Error("Enter the six-digit code sent to your current mobile.");
    const proof = await verificationClient.auth.verifyOtp({ phone, token: code, type: "sms" });
    if (proof.error) throw new Error(phoneAuthError(proof.error, true));
    try {
      if (!proof.data.session || proof.data.user?.id !== userId || !proof.data.user.phone_confirmed_at
        || guardianPhone(proof.data.user.phone) !== phone) throw new Error("The current-mobile code did not match this account.");
      await primaryOwner(client, userId, signal);
      const security = await readStaffMfaStatus(client, userId, signal);
      if (!security?.allowed) throw new Error("Verify your authenticator before setting an app password.");
      // Auth keeps only the caller's session after a password change, so mutate through the browser's own session.
      const mutation = await createBoundMfaClient(client, userId, signal).catch(() => {
        throw new Error("Sign in again before setting an app password.");
      });
      const { data, error } = await mutation.auth.updateUser({ password: input.newPassword });
      cancelled(signal);
      if (error?.status === 429 || error?.code === "over_request_rate_limit") throw new Error("Too many attempts. Wait before trying again.");
      if (error?.code === "weak_password") throw new Error("Choose a stronger password and try again.");
      if (error?.code === "reauthentication_needed" || error?.code === "reauthentication_not_valid") {
        throw new Error("Sign out, sign in again with your mobile code, then set the app password.");
      }
      if (error || data.user?.id !== userId) {
        throw new SpentGuardianCodeError("The app password could not be confirmed. Try signing in to the app with it; if that fails, request a new current-mobile code and set it again.");
      }
      return phone;
    } catch (failure) {
      if (failure instanceof SpentGuardianCodeError) throw failure;
      // verifyOtp accepted (and consumed) the single-use code, so a retry needs a fresh one.
      throw new SpentGuardianCodeError(`${failure instanceof Error ? failure.message : "The app password could not be set."} Request a new current-mobile code to try again.`);
    }
  } finally { await closeTemporarySession(verificationClient); }
}
