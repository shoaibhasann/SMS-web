export type GuardianPhoneStatus = { enabled: boolean; captchaSiteKey: string | null };

// Mirrors app_private.student_registered_mobile: +91, 91 or a leading 0 drop to the 10-digit number.
// Stricter on '+': it is only accepted as a leading +91, so "+65 9123 4567" never becomes an Indian number.
export function normalizeIndianMobile(value: string): string | null {
  if (!/^[\s0-9+().-]{1,32}$/.test(value)) return null;
  // Check '+' after dropping separators so "(+91) 98765 43210" and "+ 91 98765 43210" still pass.
  const compact = value.replace(/[\s().-]/g, "");
  if (compact.includes("+") && !/^\+91\d*$/.test(compact)) return null;
  const raw = compact.replace(/\D/g, "");
  const digits = raw.length === 12 && raw.startsWith("91") ? raw.slice(2) : raw.length === 11 && raw.startsWith("0") ? raw.slice(1) : raw;
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

export async function readGuardianPhoneStatus(signal?: AbortSignal): Promise<GuardianPhoneStatus> {
  const response = await fetch("/auth/phone/status", { cache: "no-store", signal });
  const status: unknown = await response.json();
  if (!response.ok || !status || typeof status !== "object" || !("enabled" in status)
    || typeof status.enabled !== "boolean" || !("captchaSiteKey" in status)
    || (status.captchaSiteKey !== null && (typeof status.captchaSiteKey !== "string" || status.captchaSiteKey.length > 200))) {
    throw new Error("Mobile sign-in availability could not be checked. Try again.");
  }
  if (status.enabled && !status.captchaSiteKey) throw new Error("Mobile sign-in is unavailable. Contact your school.");
  return status as GuardianPhoneStatus;
}

export async function prepareGuardianPhoneRequest(phone: string, captchaToken: string) {
  if (!normalizeIndianMobile(phone) || !captchaToken || captchaToken.length > 2048) {
    throw new Error("Enter a valid Indian mobile number and complete the security check.");
  }
  const response = await fetch("/auth/phone/permit", {
    method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
    body: JSON.stringify({ phone: normalizeIndianMobile(phone), captchaToken }),
  });
  if (!response.ok) throw new Error(response.status === 429
    ? "Too many code requests. Wait a few minutes before trying again."
    : "The security check could not be confirmed. Try again or contact your school.");
}

export function phoneAuthError(error: { status?: number; code?: string } | null, verifying = false) {
  if (error?.status === 429 || ["over_sms_send_rate_limit", "over_request_rate_limit"].includes(error?.code ?? "")) {
    return "Too many attempts. Wait a few minutes before trying again.";
  }
  return verifying ? "The code could not be verified. Check it or request a new code."
    : "A code could not be requested. Use your school-verified number or contact the school office.";
}
