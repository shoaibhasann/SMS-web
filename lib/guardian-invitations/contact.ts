import { createClient as createSupabaseClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { guardianEmailContinuation } from "@/lib/auth/redirect";
import { normalizeIndianMobile, phoneAuthError, prepareGuardianPhoneRequest, readGuardianPhoneStatus } from "@/lib/auth/phone";

export type GuardianContactProviders = { email: boolean; sms: boolean; captchaSiteKey?: string | null };

const canonicalPhone = /^\+[1-9]\d{7,14}$/;

export function guardianPhone(value: string | null | undefined) {
  if (!value) return "";
  const digits = value.trim().replace(/[\s()-]/g, "");
  const phone = digits.startsWith("+") ? digits : `+${digits}`;
  return canonicalPhone.test(phone) ? phone : "";
}

export async function readGuardianContactProviders(): Promise<GuardianContactProviders> {
  const url = new URL("/auth/v1/settings", process.env.NEXT_PUBLIC_SUPABASE_URL);
  const response = await fetch(url, {
    headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY! },
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Contact verification settings are temporarily unavailable.");
  const settings = await response.json();
  const mobile = await readGuardianPhoneStatus().catch(() => ({ enabled: false, captchaSiteKey: null }));
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
        storageKey: "guardian-contact-verification",
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

export async function requestGuardianEmailChange(client: SupabaseClient, userId: string, email: string, origin: string) {
  const current = await readGuardianAuthUser(client, userId);
  const nextEmail = email.trim().toLowerCase();
  if (!current.email_confirmed_at || !current.email) throw new Error("A verified sign-in email is required. Contact the school office.");
  if (nextEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail) || nextEmail === current.email.toLowerCase()) {
    throw new Error("Enter a different, valid email address.");
  }

  const callback = new URL("/auth/callback", origin);
  callback.searchParams.set("next", guardianEmailContinuation);
  const { data, error } = await client.auth.updateUser({ email: nextEmail }, { emailRedirectTo: callback.href });
  if (error || data.user?.id !== userId || data.user.new_email?.toLowerCase() !== nextEmail) {
    throw verificationError(error, "email");
  }
  return data.user;
}

export async function requestGuardianMobileChange(
  client: SupabaseClient, verificationClient: SupabaseClient, userId: string, phone: string, password: string,
  captchaToken?: string,
) {
  const current = await readGuardianAuthUser(client, userId);
  if (!current.email_confirmed_at || !current.email) throw new Error("A verified sign-in email is required. Contact the school office.");
  const nextPhone = guardianPhone(phone);
  if (!phone.trim().startsWith("+") || !nextPhone || nextPhone === guardianPhone(current.phone)) throw new Error("Enter a different mobile number with its country code.");
  if (!password) throw new Error("Enter your current password.");

  try {
    const { data, error } = await verificationClient.auth.signInWithPassword({ email: current.email, password });
    if (error?.status === 429) throw verificationError(error, "sms");
    if (error || !data.session || data.user?.id !== userId) throw new Error("The current password could not be verified.");
    await readGuardianAuthUser(client, userId);
    const authorization = await verificationClient.rpc("authorize_my_guardian_phone_change", { p_phone: nextPhone });
    if (authorization.error?.code === "22023") throw new Error("Enter a different mobile number with its country code.");
    if (authorization.error || authorization.data !== true) {
      throw new Error("The mobile change could not be authorized. Reenter your password or contact the school office.");
    }
    if (captchaToken !== undefined) await prepareGuardianPhoneRequest(nextPhone, captchaToken);
    const result = await verificationClient.auth.updateUser({ phone: nextPhone });
    if (result.error || result.data.user?.id !== userId || guardianPhone(result.data.user.new_phone) !== nextPhone) {
      throw verificationError(result.error, "sms");
    }
    return result.data.user;
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
    const verified = await verificationClient.auth.verifyOtp({ phone: previousPhone, token: code.trim(), type: "sms" });
    if (verified.error || !verified.data.session || verified.data.user?.id !== userId || !verified.data.user.phone_confirmed_at
      || normalizeIndianMobile(verified.data.user.phone ?? "") !== previousPhone) throw new Error(phoneAuthError(verified.error, true));
    const latest = await readGuardianAuthUser(client, userId);
    if (!latest.phone_confirmed_at || normalizeIndianMobile(latest.phone ?? "") !== previousPhone) {
      throw new Error("Your current mobile changed. Refresh contact details before continuing.");
    }
    const authorization = await verificationClient.rpc("authorize_my_guardian_phone_change", { p_phone: nextPhone });
    if (authorization.error || authorization.data !== true) throw new Error("The mobile change could not be authorized. Request a fresh current-mobile code.");
    await prepareGuardianPhoneRequest(nextPhone, captchaToken);
    const result = await verificationClient.auth.updateUser({ phone: nextPhone });
    if (result.error || result.data.user?.id !== userId || normalizeIndianMobile(result.data.user.new_phone ?? "") !== nextPhone) {
      throw verificationError(result.error, "sms");
    }
    return result.data.user;
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
