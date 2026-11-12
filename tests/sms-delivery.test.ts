// @vitest-environment node

import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, rpc, abortSignal } = vi.hoisted(() => ({
  createClient: vi.fn(), rpc: vi.fn(), abortSignal: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient }));

import { POST as sendSms } from "../app/auth/send-sms/route";
import { POST as permitSms } from "../app/auth/phone/permit/route";
import { GET as status } from "../app/auth/phone/status/route";

const key = Buffer.alloc(32, 23);
const origin = "https://school.example";
const userId = "f683b60e-1dfc-4ded-90e5-1f9056a3611f";
const phone = "+919876543210";
const fixedTime = Date.parse("2026-11-06T14:30:00Z");
const payload = () => ({ user: { id: userId, phone, is_anonymous: false }, sms: { otp: "314159" } });
const fetchMock = vi.fn();

function configure() {
  const values = {
    GUARDIAN_PHONE_AUTH_ENABLED: "true", SUPABASE_SMS_HOOK_SECRET: `v1,whsec_${key.toString("base64")}`,
    MSG91_AUTH_KEY: "private-provider-test-key", MSG91_OTP_TEMPLATE_ID: "private-template-test-id",
    SUPABASE_SERVICE_ROLE_KEY: "private-service-test-key", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "public-test-key",
    NEXT_PUBLIC_SUPABASE_URL: "https://fixture.supabase.co", NEXT_PUBLIC_TURNSTILE_SITE_KEY: "public-captcha-site-key",
    TURNSTILE_SECRET_KEY: "private-captcha-test-key", GUARDIAN_PHONE_AUTH_ORIGIN: origin,
    GUARDIAN_SMS_GLOBAL_DAILY_LIMIT: "500", GUARDIAN_SMS_SCHOOL_DAILY_LIMIT: "200", GUARDIAN_SMS_PHONE_DAILY_LIMIT: "5",
    VERCEL: "1",
  };
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

function webhook(body = JSON.stringify(payload()), overrides: Record<string, string> = {}, timestamp = Math.floor(fixedTime / 1_000)) {
  const id = "msg_test_webhook";
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return new Request(`${origin}/auth/send-sms`, {
    method: "POST", headers: { "Content-Type": "application/json", "webhook-id": id,
      "webhook-timestamp": String(timestamp), "webhook-signature": `v1,${signature}`, ...overrides }, body,
  });
}

function permit(body: unknown = { phone, captchaToken: "single-use-captcha-token" }, headers: Record<string, string> = {}) {
  return new Request(`${origin}/auth/phone/permit`, {
    method: "POST", headers: { "Content-Type": "application/json", origin, "x-vercel-forwarded-for": "203.0.113.7", ...headers },
    body: JSON.stringify(body),
  });
}

function captcha(result: unknown = { success: true, action: "guardian-otp", hostname: "school.example" }) {
  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  configure();
  vi.spyOn(Date, "now").mockReturnValue(fixedTime);
  createClient.mockReturnValue({ rpc });
  rpc.mockReturnValue({ abortSignal });
  abortSignal.mockResolvedValue({ data: { send: true, school_id: "school" }, error: null });
  fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ type: "success", request_id: "provider-request" })));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("signed guardian SMS delivery", () => {
  it("reserves the configured spend limits before forwarding only Supabase's code to MSG91", async () => {
    const response = await sendSms(webhook());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(createClient).toHaveBeenCalledWith("https://fixture.supabase.co", "private-service-test-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("reserve_guardian_sms", {
      p_user_id: userId, p_phone: phone, p_webhook_id: "msg_test_webhook",
      p_global_daily_limit: 500, p_school_daily_limit: 200, p_phone_daily_limit: 5,
    });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url.origin + url.pathname).toBe("https://control.msg91.com/api/v5/otp");
    expect(Object.fromEntries(url.searchParams)).toEqual({ template_id: "private-template-test-id", mobile: phone.slice(1), otp: "314159", otp_length: "6" });
    expect(options).toMatchObject({ method: "POST", headers: { authkey: "private-provider-test-key" }, redirect: "error", cache: "no-store" });
    expect(url.searchParams.has("authkey")).toBe(false);
    expect(abortSignal.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
  });

  it("uses the signed SMS destination, not the old account number during phone change", async () => {
    const body = payload();
    Object.assign(body.sms, { phone: "+919000000001" });
    expect((await sendSms(webhook(JSON.stringify(body)))).status).toBe(200);
    expect(rpc.mock.calls[0][1].p_phone).toBe("+919000000001");
    expect(fetchMock.mock.calls[0][0].searchParams.get("mobile")).toBe("919000000001");
  });

  it.each([false, true])("supports GoTrue's country-code digits without a plus (phone change: %s)", async (changing) => {
    const body = payload();
    body.user.phone = changing ? "+919000000001" : phone.slice(1);
    if (changing) Object.assign(body.sms, { phone: phone.slice(1) });
    expect((await sendSms(webhook(JSON.stringify(body)))).status).toBe(200);
    expect(rpc.mock.calls[0][1].p_phone).toBe(phone);
    expect(fetchMock.mock.calls[0][0].searchParams.get("mobile")).toBe(phone.slice(1));
  });

  it.each(["new_phone", "phone_change"])("rejects legacy phone-change payloads with %s instead of sending to the old number", async (field) => {
    const body = payload();
    Object.assign(body.user, { [field]: "919000000001" });
    expect((await sendSms(webhook(JSON.stringify(body)))).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the explicit current-number login destination even when a stale pending change remains", async () => {
    const body = payload();
    Object.assign(body.user, { new_phone: "919000000001", phone_change: "+919000000001" });
    Object.assign(body.sms, { phone: phone.slice(1) });
    expect((await sendSms(webhook(JSON.stringify(body)))).status).toBe(200);
    expect(rpc.mock.calls[0][1].p_phone).toBe(phone);
    expect(fetchMock.mock.calls[0][0].searchParams.get("mobile")).toBe(phone.slice(1));
  });

  it("lets database eligibility reject an arbitrary explicit destination before paid delivery", async () => {
    const body = payload();
    Object.assign(body.user, { new_phone: "919000000001" });
    Object.assign(body.sms, { phone: "919000000002" });
    abortSignal.mockResolvedValue({ data: { send: false, reason: "ineligible" }, error: null });
    expect((await sendSms(webhook(JSON.stringify(body)))).status).toBe(429);
    expect(rpc.mock.calls[0][1].p_phone).toBe("+919000000002");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never falls back from a present invalid SMS destination or explicit change event", async () => {
    for (const sms of [{ otp: "314159", phone: null }, { otp: "314159", sms_type: "phone_change" }]) {
      expect((await sendSms(webhook(JSON.stringify({ ...payload(), sms })))).status).toBe(400);
    }
    expect(rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a matching rotation signature and a standard whsec secret", async () => {
    vi.stubEnv("SUPABASE_SMS_HOOK_SECRET", `whsec_${key.toString("base64")}`);
    const request = webhook();
    request.headers.set("webhook-signature", `v1,${Buffer.alloc(32).toString("base64")} ${request.headers.get("webhook-signature")}`);
    expect((await sendSms(request)).status).toBe(200);
  });

  it.each([
    ["missing signature", { "webhook-signature": "" }],
    ["unknown signature", { "webhook-signature": "v1,invalid" }],
    ["unsupported version", { "webhook-signature": `v2,${Buffer.alloc(32).toString("base64")}` }],
    ["ambiguous ID", { "webhook-id": "msg.test" }],
    ["tampered ID", { "webhook-id": "msg_other" }],
    ["invalid timestamp", { "webhook-timestamp": "NaN" }],
  ])("rejects %s before any privileged or provider call", async (_name, headers) => {
    expect((await sendSms(webhook(undefined, headers))).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([-301, 301])("rejects a correctly signed timestamp outside tolerance (%i seconds)", async (seconds) => {
    expect((await sendSms(webhook(undefined, {}, Math.floor(fixedTime / 1_000) + seconds))).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("verifies the exact raw body, including whitespace", async () => {
    const raw = JSON.stringify(payload(), null, 2);
    const signed = webhook(raw);
    expect((await sendSms(signed)).status).toBe(200);
    const changed = webhook(raw);
    const tampered = new Request(changed.url, { method: "POST", headers: changed.headers, body: raw + " " });
    expect((await sendSms(tampered)).status).toBe(401);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...payload(), user: { ...payload().user, phone: "+15555550123" } },
    { ...payload(), user: { ...payload().user, phone: "+915555555555" } },
    { ...payload(), user: { ...payload().user, id: "not-a-user-id" } },
    { ...payload(), user: { ...payload().user, is_anonymous: true } },
    { ...payload(), sms: { otp: "1234" } },
    { ...payload(), sms: { otp: "314159", phone: "+15555550123" } },
    { ...payload(), sms: { otp: "314159", phone: "9876543210" } },
  ])("rejects a malformed or unsupported signed recipient/code", async (body) => {
    expect((await sendSms(webhook(JSON.stringify(body)))).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["duplicate", "ineligible", "rate_limited"])("never sends after %s reservation", async (reason) => {
    abortSignal.mockResolvedValue({ data: { send: false, reason }, error: null });
    const response = await sendSms(webhook());
    expect(response.status).toBe(reason === "duplicate" ? 200 : 429);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed on unavailable or malformed reservation", async () => {
    abortSignal.mockResolvedValueOnce({ data: null, error: { message: "private SQL details" } });
    expect((await sendSms(webhook())).status).toBe(503);
    abortSignal.mockResolvedValueOnce({ data: { send: "true" }, error: null });
    expect((await sendSms(webhook())).status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    new Response(JSON.stringify({ type: "error", message: "private provider details" })),
    new Response(JSON.stringify({ type: "success" })),
    new Response("provider unavailable", { status: 503 }),
    new Response("not-json"),
  ])("treats HTTP or body-level provider rejection as failure without leaking payload", async (providerResponse) => {
    fetchMock.mockResolvedValue(providerResponse);
    const response = await sendSms(webhook());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/314159|9876543210|private provider details|service-test-key/);
  });

  it("does not log or return a provider exception containing secrets", async () => {
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    fetchMock.mockRejectedValue(new Error("private-provider-test-key 314159 9876543210"));
    const response = await sendSms(webhook());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/private-provider-test-key|314159|9876543210/);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("bounds the raw payload before dispatch", async () => {
    expect((await sendSms(webhook("x".repeat(32_769)))).status).toBe(413);
    expect((await sendSms(webhook(undefined, { "content-length": "1000000" }))).status).toBe(413);
    expect(rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects correctly signed invalid JSON without dispatch", async () => {
    expect((await sendSms(webhook("not-json"))).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("guardian SMS CAPTCHA permit", () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(captcha());
    abortSignal.mockResolvedValue({ data: true, error: null });
  });

  it("verifies the hostname/action server-side then creates only a hashed-IP permit", async () => {
    const response = await permitSms(permit());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(JSON.parse(options.body)).toEqual({ secret: "private-captcha-test-key", response: "single-use-captcha-token", remoteip: "203.0.113.7" });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("authorize_guardian_sms_request", {
      p_phone: phone, p_ip_hash: createHmac("sha256", key).update("guardian-sms-ip:203.0.113.7").digest("hex"),
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("203.0.113.7");
  });

  it("rate-limits IPv6 clients per /64 and IPv4-mapped addresses as IPv4", async () => {
    fetchMock.mockImplementation(async () => captcha());
    const ipHash = async (address: string) => {
      rpc.mockClear();
      expect((await permitSms(permit(undefined, { "x-vercel-forwarded-for": address }))).status).toBe(200);
      return rpc.mock.calls[0][1].p_ip_hash;
    };
    const bucket = (value: string) => createHmac("sha256", key).update(`guardian-sms-ip:${value}`).digest("hex");
    expect(await ipHash("2001:db8:1:1::1")).toBe(bucket("2001:db8:1:1::/64"));
    expect(await ipHash("2001:0DB8:0001:0001:ffff:aaaa:1.2.3.4")).toBe(bucket("2001:db8:1:1::/64"));
    expect(await ipHash("2001:db8:1:2::1")).toBe(bucket("2001:db8:1:2::/64"));
    expect(await ipHash("::1")).toBe(bucket("0:0:0:0::/64"));
    expect(await ipHash("2001:db8::")).toBe(bucket("2001:db8:0:0::/64"));
    expect(await ipHash("::ffff:cb00:7107")).toBe(bucket("203.0.113.7"));
    expect(await ipHash("::ffff:203.0.113.7")).toBe(bucket("203.0.113.7"));
    expect(JSON.parse(fetchMock.mock.calls.at(-1)?.[1].body).remoteip).toBe("::ffff:203.0.113.7");
  });

  it.each<Record<string, string>>([
    { origin: "https://attacker.example" }, { origin: "" },
    { "content-type": "text/plain" }, { "x-vercel-forwarded-for": "203.0.113.7, 192.0.2.1" },
    { "x-vercel-forwarded-for": "", "x-forwarded-for": "203.0.113.7" },
  ])("rejects an untrusted browser origin/IP/content type", async (headers) => {
    expect((await permitSms(permit(undefined, headers))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    { phone: "+15555550123", captchaToken: "token" },
    { phone, captchaToken: "" }, { phone, captchaToken: "t".repeat(2_049) },
    { phone }, { phone: 919876543210, captchaToken: "token" },
  ])("rejects malformed permit input before CAPTCHA/network spend", async (body) => {
    expect((await permitSms(permit(body))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    { success: false, "error-codes": ["timeout-or-duplicate"] },
    { success: true, action: "other-action", hostname: "school.example" },
    { success: true, action: "guardian-otp", hostname: "attacker.example" },
    { success: true },
  ])("never authorizes an expired, replayed or wrong-site CAPTCHA", async (result) => {
    fetchMock.mockResolvedValue(captcha(result));
    expect((await permitSms(permit())).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("uses one generic limit result and never sends SMS itself", async () => {
    abortSignal.mockResolvedValue({ data: false, error: null });
    const response = await permitSms(permit());
    expect(response.status).toBe(429);
    expect(await response.text()).not.toMatch(/exists|linked|guardian found|9876543210/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed or oversized JSON before verification", async () => {
    const request = permit();
    const malformed = new Request(request.url, { method: "POST", headers: request.headers, body: "not-json" });
    expect((await permitSms(malformed)).status).toBe(400);
    const oversized = await permitSms(permit({ phone, captchaToken: "x".repeat(5_000) }));
    expect(oversized.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed on CAPTCHA/network or permit database failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("secret-captcha-value"));
    expect((await permitSms(permit())).status).toBe(503);
    expect(rpc).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(captcha());
    abortSignal.mockResolvedValue({ data: null, error: { message: "private database error" } });
    expect((await permitSms(permit())).status).toBe(503);
  });
});

describe("phone auth activation status", () => {
  it.each(["false", ""])("keeps phone delivery disabled by default (%s)", async (enabled) => {
    vi.stubEnv("GUARDIAN_PHONE_AUTH_ENABLED", enabled);
    expect(await (await status()).json()).toEqual({ enabled: false, captchaSiteKey: null });
    expect((await sendSms(webhook())).status).toBe(503);
    expect((await permitSms(permit())).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each([
    ["MSG91_AUTH_KEY", ""], ["SUPABASE_SERVICE_ROLE_KEY", ""], ["TURNSTILE_SECRET_KEY", ""],
    ["GUARDIAN_PHONE_AUTH_ORIGIN", "http://school.example"], ["GUARDIAN_PHONE_AUTH_ORIGIN", "https://school.example/path"],
    ["SUPABASE_SMS_HOOK_SECRET", "whsec_invalid"], ["GUARDIAN_SMS_GLOBAL_DAILY_LIMIT", "0"],
    ["GUARDIAN_SMS_SCHOOL_DAILY_LIMIT", "1001"], ["GUARDIAN_SMS_PHONE_DAILY_LIMIT", "11"],
    ["GUARDIAN_SMS_PHONE_DAILY_LIMIT", "1.5"], ["NEXT_PUBLIC_SUPABASE_URL", "http://fixture.supabase.co"],
  ])("rejects missing or unsafe activation setting %s", async (name, value) => {
    vi.stubEnv(name, value);
    expect(await (await status()).json()).toEqual({ enabled: false, captchaSiteKey: null });
    expect((await sendSms(webhook())).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reveals only readiness and the public CAPTCHA site key when verified-phone Auth is ready", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ external: { phone: true }, phone_autoconfirm: false })));
    const response = await status();
    expect(await response.json()).toEqual({ enabled: true, captchaSiteKey: "public-captcha-site-key" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(createClient).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { apikey: "public-test-key" }, cache: "no-store", redirect: "error" });
  });

  it.each([
    { external: { phone: false }, phone_autoconfirm: false },
    { external: { phone: true }, phone_autoconfirm: true },
    { external: { phone: true } }, {},
  ])("does not enable an unavailable or automatically confirmed phone provider", async (settings) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(settings)));
    expect(await (await status()).json()).toEqual({ enabled: false, captchaSiteKey: null });
  });

  it("stays disabled when provider settings are unavailable", async () => {
    fetchMock.mockRejectedValue(new Error("network failure"));
    expect(await (await status()).json()).toEqual({ enabled: false, captchaSiteKey: null });
  });
});
