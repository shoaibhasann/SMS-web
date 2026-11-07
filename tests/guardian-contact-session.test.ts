// @vitest-environment node
import type { Session } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createContactChangeClient, finishGuardianEmailChange, requestContactEmail, sameOriginContactPost } from "@/lib/auth/contact-change";
import { POST } from "@/app/(auth)/auth/contact/email/route";

const mocks = vi.hoisted(() => ({ cookies: vi.fn(), create: vi.fn(), primary: vi.fn(), bound: vi.fn(), security: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.create }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.primary }));
vi.mock("@/lib/auth/staff-mfa", async (original) => ({ ...await original<typeof import("@/lib/auth/staff-mfa")>(), boundMfaSession: mocks.bound, readStaffMfaStatus: mocks.security }));

const owner = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const sourceSession = "33333333-3333-4333-8333-333333333333", newSession = "44444444-4444-4444-8444-444444444444";
const nextEmail = "next@example.test", flow = "aabbccddeeff00112233445566778899";
const session = { user: { id: owner }, access_token: "private-primary-access", refresh_token: "private-primary-refresh" } as Session;
type Cookie = { name: string; value: string; options?: Record<string, unknown> };
type Adapter = { getAll(): Cookie[]; setAll(changes: Cookie[]): void };
let values: Map<string, Cookie>, writes: Cookie[], adapter: Adapter;
let providerUser: { id: string; email?: string; new_email?: string; email_confirmed_at?: string; is_anonymous?: boolean };
let callbackSessionId: string;
const native = {
  setSession: vi.fn(), updateUser: vi.fn(), exchangeCodeForSession: vi.fn(), getUser: vi.fn(), getClaims: vi.fn(), signOut: vi.fn(),
};
const primary = { auth: { getClaims: vi.fn(), getUser: vi.fn() } };

function request(body: unknown, requestOrigin = "https://school.example") {
  return new Request("https://school.example/auth/contact/email", { method: "POST", headers: { origin: requestOrigin, "content-type": "application/json" }, body: JSON.stringify(body) });
}
function callback(extra: Record<string, string> = {}) {
  const url = new URL("https://school.example/auth/callback");
  url.search = new URLSearchParams({ next: "/modules/profile?view=guardian&contact=email", sb_flow_id: flow, ...extra }).toString();
  return url;
}
async function started() { await requestContactEmail(primary as never, session, nextEmail, "https://school.example"); }
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fixture.supabase.co"); vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "publishable");
  values = new Map([["sb-fixture-auth-token", { name: "sb-fixture-auth-token", value: "UNCHANGED-PRIMARY-B" }]]); writes = [];
  mocks.cookies.mockResolvedValue({ getAll: () => [...values.values()], get: (name: string) => values.get(name), set: (name: string, value: string, options: Cookie["options"]) => {
    const cookie = { name, value, options }; writes.push(cookie); values.set(name, cookie);
  } });
  mocks.create.mockImplementation((_url, _key, options) => { adapter = options.cookies; return { auth: native }; });
  mocks.primary.mockResolvedValue(primary); mocks.bound.mockResolvedValue(session);
  mocks.security.mockResolvedValue({ user_id: owner, allowed: true, profile_school_id: "school", roles: [{ role: "parent", school_id: "school" }] });
  primary.auth.getClaims.mockResolvedValue({ data: { claims: { sub: owner, session_id: sourceSession } }, error: null });
  primary.auth.getUser.mockResolvedValue({ data: { user: { id: owner, email: "old@example.test", email_confirmed_at: "2026-11-07" } }, error: null });
  native.setSession.mockImplementation(async () => { adapter.setAll([{ name: "__Host-kc-contact", value: JSON.stringify(session), options: {} }]); return { data: { user: { id: owner } }, error: null }; });
  native.updateUser.mockImplementation(async () => {
    adapter.setAll([{ name: `__Host-kc-contact-flow-${flow}-code-verifier`, value: "PRIVATE-PKCE-VERIFIER", options: {} }, { name: "__Host-kc-contact", value: "COPIED-TOKENS", options: {} }]);
    return { data: { user: { id: owner, new_email: nextEmail } }, error: null };
  });
  providerUser = { id: owner, email: nextEmail, email_confirmed_at: "2026-11-07" }; callbackSessionId = newSession;
  native.exchangeCodeForSession.mockImplementation(async () => { adapter.setAll([{ name: "__Host-kc-contact", value: "NEW-CONTACT-TOKENS", options: {} }]); return { data: { session: { access_token: "new-contact-token" }, user: providerUser }, error: null }; });
  native.getUser.mockImplementation(async () => ({ data: { user: providerUser }, error: null }));
  native.getClaims.mockImplementation(async () => ({ data: { claims: { sub: providerUser.id, session_id: callbackSessionId } }, error: null }));
  native.signOut.mockResolvedValue({ error: null });
});

describe("guardian contact session isolation", () => {
  it("persists only HttpOnly per-flow PKCE/context and never copied primary tokens", async () => {
    await started();
    expect(native.setSession).toHaveBeenCalledWith({ access_token: session.access_token, refresh_token: session.refresh_token });
    expect(native.updateUser).toHaveBeenCalledWith({ email: nextEmail }, { emailRedirectTo: "https://school.example/auth/callback?next=%2Fmodules%2Fprofile%3Fview%3Dguardian%26contact%3Demail" });
    expect(writes).toHaveLength(2); expect(writes.every(({ name, options }) => name.startsWith(`__Host-kc-contact-flow-${flow}-`) && options?.httpOnly && options.secure && options.maxAge === 900)).toBe(true);
    expect(JSON.stringify(writes)).not.toContain("private-primary"); expect(values.get("sb-fixture-auth-token")?.value).toBe("UNCHANGED-PRIMARY-B");
    expect(native.signOut).not.toHaveBeenCalled();
  });
  it("exchanges and closes only its new contact session while a different primary remains untouched", async () => {
    await started();
    expect(await finishGuardianEmailChange(callback(), "real-code")).toBe("email-returned");
    expect(native.exchangeCodeForSession).toHaveBeenCalledWith("real-code", { flowId: flow });
    expect(native.getUser).toHaveBeenCalledWith("new-contact-token"); expect(native.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(values.get("sb-fixture-auth-token")?.value).toBe("UNCHANGED-PRIMARY-B");
    expect(writes.some(({ value }) => value === "NEW-CONTACT-TOKENS")).toBe(false);
    expect(values.get(`__Host-kc-contact-flow-${flow}-context`)?.options?.maxAge).toBe(0);
  });
  it("does not sign out a provider-returned original primary native session", async () => {
    await started(); callbackSessionId = sourceSession;
    expect(await finishGuardianEmailChange(callback(), "code")).toBe("email-returned"); expect(native.signOut).not.toHaveBeenCalled();
  });
  it("keeps the verifier for first inbox confirmation without treating its message as account proof", async () => {
    await started();
    expect(await finishGuardianEmailChange(callback({ message: "Confirmation link accepted. Confirm the other inbox" }), null)).toBe("email-pending");
    expect(native.exchangeCodeForSession).not.toHaveBeenCalled(); expect(native.signOut).not.toHaveBeenCalled();
    expect(values.get(`__Host-kc-contact-flow-${flow}-code-verifier`)?.value).toBe("PRIVATE-PKCE-VERIFIER");
  });
  it("rejects missing, malformed and expired flow context before any code exchange", async () => {
    expect(await finishGuardianEmailChange(callback(), "code")).toBe("email-link-error");
    await started();
    for (const value of ["not-json", Buffer.from(JSON.stringify({ userId: owner, email: nextEmail, sessionId: sourceSession, issuedAt: Math.floor(Date.now() / 1000) - 901 })).toString("base64url")]) {
      values.set(`__Host-kc-contact-flow-${flow}-context`, { name: "context", value });
      expect(await finishGuardianEmailChange(callback(), "code")).toBe("email-link-error");
    }
    expect(await finishGuardianEmailChange(callback({ sb_flow_id: "../ordinary" }), "code")).toBe("email-link-error");
    expect(native.exchangeCodeForSession).not.toHaveBeenCalled();
  });
  it("rejects forged owner metadata or a different verified email and closes only a new returned session", async () => {
    await started(); providerUser = { id: other, email: nextEmail, email_confirmed_at: "2026-11-07" };
    expect(await finishGuardianEmailChange(callback(), "code-for-other-owner")).toBe("email-link-error"); expect(native.signOut).toHaveBeenCalledWith({ scope: "local" });
    await started(); providerUser = { id: owner, email: "another@example.test", email_confirmed_at: "2026-11-07" };
    expect(await finishGuardianEmailChange(callback(), "code-for-different-email")).toBe("email-link-error");
  });
  it("never accepts attacker-chosen owner routing metadata as proof for another account", async () => {
    await started();
    const key = `__Host-kc-contact-flow-${flow}-context`, stored = values.get(key)!;
    const binding = JSON.parse(Buffer.from(stored.value, "base64url").toString()); binding.userId = other;
    values.set(key, { ...stored, value: Buffer.from(JSON.stringify(binding)).toString("base64url") });
    expect(await finishGuardianEmailChange(callback(), "native-code-still-belongs-to-original-owner")).toBe("email-link-error");
    expect(native.signOut).toHaveBeenCalledWith({ scope: "local" }); expect(values.get("sb-fixture-auth-token")?.value).toBe("UNCHANGED-PRIMARY-B");
  });
  it("never reads ordinary cookies in the contact adapter", async () => {
    values.set("__Host-kc-contact", { name: "__Host-kc-contact", value: "UNTRUSTED-COOKIE-SESSION" });
    await createContactChangeClient(true); expect(adapter.getAll().some(({ name }) => name.startsWith("sb-") || name === "__Host-kc-contact")).toBe(false);
  });
});

describe("guardian email change endpoint", () => {
  it("checks same-origin, verified owner and MFA before requesting native confirmation", async () => {
    expect(sameOriginContactPost(request({}))).toBe("https://school.example");
    expect((await POST(request({ userId: owner, email: nextEmail }, "https://attacker.example"))).status).toBe(403);
    expect(native.updateUser).not.toHaveBeenCalled();
    mocks.security.mockResolvedValueOnce({ allowed: false });
    expect((await POST(request({ userId: owner, email: nextEmail }))).status).toBe(403); expect(native.updateUser).not.toHaveBeenCalled();
    const response = await POST(request({ userId: owner, email: nextEmail }));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true }); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(native.updateUser).toHaveBeenCalledOnce();
  });
  it("rejects non-parent roles and invalid targets without exposing provider diagnostics", async () => {
    expect((await POST(request({ userId: owner, email: "invalid" }))).status).toBe(400);
    mocks.security.mockResolvedValueOnce({ allowed: true, profile_school_id: "school", roles: [{ role: "teacher", school_id: "school" }] });
    expect((await POST(request({ userId: owner, email: nextEmail }))).status).toBe(403);
    native.updateUser.mockResolvedValueOnce({ error: { status: 429, message: "PRIVATE-DIAGNOSTIC" } });
    const limited = await POST(request({ userId: owner, email: nextEmail })); expect(limited.status).toBe(429); expect(await limited.text()).not.toContain("PRIVATE-DIAGNOSTIC");
    native.updateUser.mockResolvedValueOnce({ error: { status: 422, code: "email_exists", message: "PRIVATE-DUPLICATE-OWNER" } });
    const collision = await POST(request({ userId: owner, email: nextEmail })); expect(collision.status).toBe(409); expect(await collision.json()).toEqual({ error: "contact_unavailable" });
  });
});
