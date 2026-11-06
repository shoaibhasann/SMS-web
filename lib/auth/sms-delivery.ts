import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { createClient } from "@supabase/supabase-js";

const indiaMobile = /^\+91[6-9]\d{9}$/;
const responseHeaders = { "Cache-Control": "no-store" };
const unavailable = "The school’s mobile sign-in service is unavailable. Try email sign-in or contact the school office.";

function limit(name: string, maximum: number) {
  const value = process.env[name] ?? "";
  return /^[1-9]\d{0,4}$/.test(value) && Number(value) <= maximum ? Number(value) : null;
}

function configuration() {
  if (process.env.GUARDIAN_PHONE_AUTH_ENABLED !== "true") return null;
  const secret = process.env.SUPABASE_SMS_HOOK_SECRET?.match(/^(?:v1,)?whsec_([A-Za-z0-9+/]+={0,2})$/)?.[1];
  const key = secret ? Buffer.from(secret, "base64") : null;
  const authKey = process.env.MSG91_AUTH_KEY?.trim();
  const templateId = process.env.MSG91_OTP_TEMPLATE_ID?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  const captchaSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim();
  const captchaSecret = process.env.TURNSTILE_SECRET_KEY?.trim();
  const globalLimit = limit("GUARDIAN_SMS_GLOBAL_DAILY_LIMIT", 10_000);
  const schoolLimit = limit("GUARDIAN_SMS_SCHOOL_DAILY_LIMIT", 1_000);
  const phoneLimit = limit("GUARDIAN_SMS_PHONE_DAILY_LIMIT", 10);
  if (!key || key.length < 24 || key.length > 64 || key.toString("base64") !== secret
    || !authKey || !templateId || !serviceKey || !publishableKey || !captchaSiteKey || !captchaSecret
    || !globalLimit || !schoolLimit || !phoneLimit) return null;
  try {
    const supabaseUrl = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    const origin = new URL(process.env.GUARDIAN_PHONE_AUTH_ORIGIN ?? "");
    if (supabaseUrl.protocol !== "https:" || supabaseUrl.username || supabaseUrl.password
      || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/"
      || (origin.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && origin.protocol === "http:"
        && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) return null;
    return { key, authKey, templateId, serviceKey, publishableKey, captchaSiteKey, captchaSecret,
      supabaseUrl, origin, globalLimit, schoolLimit, phoneLimit };
  } catch {
    return null;
  }
}

type Configuration = NonNullable<ReturnType<typeof configuration>>;

function database(config: Configuration) {
  return createClient(config.supabaseUrl.origin, config.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function failure(status: number, message = unavailable) {
  return Response.json({ error: { http_code: status, message } }, { status, headers: responseHeaders });
}

async function boundedBody(request: Request, maximum: number) {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > maximum)) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return Buffer.concat(chunks).toString("utf8");
        size += value.byteLength;
        if (size > maximum) return null;
        chunks.push(value);
      }
    };
    return await Promise.race([read(), new Promise<null>((resolve) => {
      timer = setTimeout(() => { void reader.cancel().catch(() => undefined); resolve(null); }, 1_000);
    })]);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
}

function signedEvent(request: Request, body: string, key: Buffer) {
  const id = request.headers.get("webhook-id") ?? "";
  const timestamp = request.headers.get("webhook-timestamp") ?? "";
  const signatures = request.headers.get("webhook-signature") ?? "";
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id) || !/^\d{1,12}$/.test(timestamp) || signatures.length > 1_024
    || Math.abs(Date.now() / 1_000 - Number(timestamp)) > 300) return null;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  const valid = signatures.split(" ").some((signature) => {
    if (!/^v1,[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
    const actual = Buffer.from(signature.slice(3), "base64");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
  return valid ? id : null;
}

export async function guardianPhoneAuthStatus() {
  const config = configuration();
  if (!config) return { enabled: false, captchaSiteKey: null };
  try {
    const response = await fetch(new URL("/auth/v1/settings", config.supabaseUrl), {
      headers: { apikey: config.publishableKey }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(2_000),
    });
    const settings = response.ok ? await response.json() : null;
    const enabled = settings?.external?.phone === true && settings.phone_autoconfirm === false;
    return { enabled, captchaSiteKey: enabled ? config.captchaSiteKey : null };
  } catch {
    return { enabled: false, captchaSiteKey: null };
  }
}

function trustedIp(request: Request, config: Configuration) {
  if (process.env.VERCEL === "1") {
    const value = request.headers.get("x-vercel-forwarded-for")?.trim() ?? "";
    return isIP(value) ? value : null;
  }
  if (process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1", "[::1]"].includes(config.origin.hostname)) {
    return "127.0.0.1";
  }
  return null;
}

export async function authorizeGuardianSmsRequest(request: Request) {
  const config = configuration();
  if (!config) return failure(503);
  if (request.headers.get("origin") !== config.origin.origin || new URL(request.url).origin !== config.origin.origin
    || request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return failure(403);
  const ip = trustedIp(request, config);
  if (!ip) return failure(403);
  try {
    const raw = await boundedBody(request, 4_096);
    let body;
    try { body = raw === null ? null : JSON.parse(raw); } catch { return failure(400); }
    if (!indiaMobile.test(body?.phone ?? "") || typeof body?.captchaToken !== "string"
      || !body.captchaToken || body.captchaToken.length > 2_048) return failure(400);
    const verification = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: config.captchaSecret, response: body.captchaToken, remoteip: ip }),
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(2_000),
    });
    const result = verification.ok ? await verification.json() : null;
    if (result?.success !== true || result.action !== "guardian-otp" || result.hostname !== config.origin.hostname) return failure(403);
    const ipHash = createHmac("sha256", config.key).update(`guardian-sms-ip:${ip}`).digest("hex");
    const { data, error } = await database(config).rpc("authorize_guardian_sms_request", {
      p_phone: body.phone, p_ip_hash: ipHash,
    }).abortSignal(AbortSignal.timeout(1_500));
    if (error) return failure(503);
    if (data !== true) return failure(429, "Unable to request a code. Wait a minute and try again, or contact the school office.");
    return Response.json({ ok: true }, { headers: responseHeaders });
  } catch {
    return failure(503);
  }
}

export async function sendGuardianSms(request: Request) {
  const config = configuration();
  if (!config) return failure(503);
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return failure(400);
  try {
    const raw = await boundedBody(request, 32_768);
    if (raw === null) return failure(413);
    const eventId = signedEvent(request, raw, config.key);
    if (!eventId) return failure(401);
    let body;
    try { body = JSON.parse(raw); } catch { return failure(400); }
    const canonicalDestination = (value: unknown) => typeof value === "string" && value.startsWith("91") ? `+${value}` : value;
    const hasSmsDestination = Object.hasOwn(body?.sms ?? {}, "phone");
    const phone = canonicalDestination(hasSmsDestination ? body.sms.phone : body?.user?.phone);
    // Older login payloads omit sms.phone; a pending change must never fall back to the old number.
    const pendingPhones = [body?.user?.new_phone, body?.user?.phone_change].filter((value) => value !== undefined && value !== null && value !== "");
    if (!hasSmsDestination && (pendingPhones.length > 0 || body?.sms?.sms_type === "phone_change")) return failure(400);
    const userId = body?.user?.id;
    const otp = body?.sms?.otp;
    if (typeof phone !== "string" || !indiaMobile.test(phone) || typeof userId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)
      || typeof otp !== "string" || !/^\d{6}$/.test(otp) || body.user.is_anonymous === true) return failure(400);
    const { data, error } = await database(config).rpc("reserve_guardian_sms", {
      p_user_id: userId, p_phone: phone, p_webhook_id: eventId,
      p_global_daily_limit: config.globalLimit, p_school_daily_limit: config.schoolLimit, p_phone_daily_limit: config.phoneLimit,
    }).abortSignal(AbortSignal.timeout(1_200));
    if (error) return failure(503);
    if (data?.send === false && data.reason === "duplicate") return Response.json({}, { headers: responseHeaders });
    if (data?.send !== true) return failure(429, "Unable to send a code. Try again later or contact the school office.");

    const endpoint = new URL("https://control.msg91.com/api/v5/otp");
    endpoint.search = new URLSearchParams({ template_id: config.templateId, mobile: phone.slice(1), otp, otp_length: "6" }).toString();
    // Do not log this provider URL: MSG91's API carries the destination/code in query parameters.
    const response = await fetch(endpoint, {
      method: "POST", headers: { authkey: config.authKey, "Content-Type": "application/json" }, body: "{}",
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(2_000),
    });
    const result = response.ok ? await response.json() : null;
    if (result?.type !== "success" || typeof result.request_id !== "string" || !result.request_id) return failure(503);
    return Response.json({}, { headers: responseHeaders });
  } catch {
    return failure(503);
  }
}
