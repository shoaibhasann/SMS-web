// @vitest-environment node
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), rpc: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));

import { allowAuthAttempt } from "@/lib/auth/attempt-throttle";

const key = Buffer.alloc(32, 7);
const request = (headers: Record<string, string> = {}) => new Request("https://school.example/auth/recovery/request", { method: "POST", headers });
const ipHash = (network: string, secret: Buffer | string = key) => createHmac("sha256", secret).update(`auth-throttle-ip:${network}`).digest("hex");
const sentIpHash = () => mocks.rpc.mock.lastCall?.[1].p_ip_hash;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fixture.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fixture-service-key");
  vi.stubEnv("SUPABASE_SMS_HOOK_SECRET", `v1,whsec_${key.toString("base64")}`);
  vi.stubEnv("VERCEL", "1");
  mocks.createClient.mockReturnValue({ rpc: mocks.rpc });
  mocks.rpc.mockReturnValue({ abortSignal: () => Promise.resolve({ data: true, error: null }) });
});
afterEach(() => vi.unstubAllEnvs());

describe("auth attempt throttle", () => {
  it("keys the attempt by an HMAC of Vercel's client IP and the target, and blocks when the database refuses", async () => {
    expect(await allowAuthAttempt(request({ "x-vercel-forwarded-for": "203.0.113.9", "x-forwarded-for": "198.51.100.1" }), "admin_email_verify", "admin@school.example")).toBe(true);
    expect(mocks.createClient).toHaveBeenCalledWith("https://fixture.supabase.co", "fixture-service-key", expect.objectContaining({ auth: expect.objectContaining({ persistSession: false }) }));
    expect(mocks.rpc).toHaveBeenCalledWith("consume_auth_endpoint_attempt", { p_action: "admin_email_verify", p_ip_hash: ipHash("203.0.113.9"), p_subject: "admin@school.example" });
    mocks.rpc.mockReturnValue({ abortSignal: () => Promise.resolve({ data: false, error: null }) });
    expect(await allowAuthAttempt(request({ "x-vercel-forwarded-for": "::ffff:203.0.113.9" }), "recovery_request", "a@b.in")).toBe(false);
    expect(mocks.rpc).toHaveBeenLastCalledWith("consume_auth_endpoint_attempt", { p_action: "recovery_request", p_ip_hash: ipHash("203.0.113.9"), p_subject: "a@b.in" });
  });

  it("never sends the raw client IP to the database and buckets IPv6 clients by /64", async () => {
    await allowAuthAttempt(request({ "x-vercel-forwarded-for": "2001:DB8:1:2::1" }), "recovery_mfa", "user-1");
    const first = sentIpHash();
    await allowAuthAttempt(request({ "x-vercel-forwarded-for": "2001:db8:1:2:ffff::9" }), "recovery_mfa", "user-1");
    expect(sentIpHash()).toBe(first);
    expect(first).toBe(ipHash("2001:db8:1:2::/64"));
    await allowAuthAttempt(request({ "x-vercel-forwarded-for": "2001:db8:1:3::1" }), "recovery_mfa", "user-1");
    expect(sentIpHash()).not.toBe(first);
    for (const [, args] of mocks.rpc.mock.calls) {
      expect(JSON.stringify(args)).not.toMatch(/2001|db8/i);
      expect(args.p_ip_hash).toMatch(/^[a-f0-9]{64}$/);
    }
    vi.stubEnv("SUPABASE_SMS_HOOK_SECRET", "");
    await allowAuthAttempt(request({ "x-vercel-forwarded-for": "203.0.113.9" }), "recovery_mfa", "user-1");
    expect(sentIpHash()).toBe(ipHash("203.0.113.9", "fixture-service-key"));
  });

  it("never trusts caller-set forwarding headers, forwarded lists or malformed addresses", async () => {
    vi.stubEnv("VERCEL", "");
    await allowAuthAttempt(request({ "x-vercel-forwarded-for": "203.0.113.9", "x-forwarded-for": "203.0.113.9" }), "recovery_mfa", "user-1");
    vi.stubEnv("VERCEL", "1");
    await allowAuthAttempt(request({ "x-vercel-forwarded-for": "not-an-ip" }), "recovery_mfa", "user-1");
    await allowAuthAttempt(request({ "x-vercel-forwarded-for": "203.0.113.9, 198.51.100.1" }), "recovery_mfa", "user-1");
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
    for (const call of mocks.rpc.mock.calls) expect(call[1].p_ip_hash).toBeNull();
  });

  it("fails open when the throttle is not configured or unavailable, warning once without request details", async () => {
    vi.resetModules();
    const { allowAuthAttempt: allowFresh } = await import("@/lib/auth/attempt-throttle");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const attempt = () => allowFresh(request({ "x-vercel-forwarded-for": "203.0.113.9" }), "recovery_mfa", "admin@school.example");
    expect(await attempt()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    mocks.rpc.mockReturnValue({ abortSignal: () => Promise.resolve({ data: null, error: { message: "function does not exist" } }) });
    expect(await attempt()).toBe(true);
    mocks.rpc.mockImplementation(() => { throw new Error("network"); });
    expect(await attempt()).toBe(true);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    mocks.createClient.mockClear();
    expect(await attempt()).toBe(true);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/203\.0\.113|admin@|school\.example|fixture/);
  });
});
