// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/(auth)/auth/admin-email-code/route";

const mocks = vi.hoisted(() => ({
  after: vi.fn(), createAuth: vi.fn(), createBrowser: vi.fn(), readSecurity: vi.fn(), rpc: vi.fn(),
  sendCode: vi.fn(), verifyCode: vi.fn(), revokeIsolated: vi.fn(),
  readBrowser: vi.fn(), clearBrowser: vi.fn(), installBrowser: vi.fn(),
}));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createAuth }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createBrowser }));
vi.mock("@/lib/auth/staff-mfa", () => ({ readStaffMfaStatus: mocks.readSecurity }));

const origin = "https://school.example";
const email = "admin@school.example";
const user = { id: "fixture-admin", email };
const session = { user, access_token: "fixture-access-token", refresh_token: "fixture-refresh-token" };
const tokens = { access_token: session.access_token, refresh_token: session.refresh_token };
const auth = { auth: { signInWithOtp: mocks.sendCode, verifyOtp: mocks.verifyCode, signOut: mocks.revokeIsolated } };
const browser = { auth: { getSession: mocks.readBrowser, signOut: mocks.clearBrowser, setSession: mocks.installBrowser } };
const challenge = { action: "challenge", current_aal: "aal1" };
const requestCode = { action: "request", email: " ADMIN@School.Example " };
const verifyCode = { action: "verify", email, code: "123456" };

function request(body: object, from = origin) {
  return new Request(`${origin}/auth/admin-email-code`, {
    method: "POST", headers: { origin: from, "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXT_PUBLIC_ADMIN_EMAIL_OTP_ENABLED", "true");
  vi.stubEnv("ADMIN_EMAIL_OTP_ORIGIN", origin);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fixture.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "fixture-public-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fixture-service-key");
  mocks.createAuth.mockImplementation((_url, key) => key === "fixture-service-key" ? { rpc: mocks.rpc } : auth);
  mocks.createBrowser.mockResolvedValue(browser);
  mocks.rpc.mockResolvedValue({ data: user.id, error: null });
  mocks.sendCode.mockResolvedValue({ error: null });
  mocks.verifyCode.mockResolvedValue({ data: { user, session }, error: null });
  mocks.readBrowser.mockResolvedValue({ data: { session: null }, error: null });
  mocks.clearBrowser.mockResolvedValue({ error: null });
  mocks.revokeIsolated.mockResolvedValue({ error: null });
  mocks.installBrowser.mockResolvedValue({ data: { user }, error: null });
  mocks.readSecurity.mockResolvedValue(challenge);
});

afterEach(() => vi.unstubAllEnvs());

describe("admin email code route", () => {
  it("rejects cross-origin posts and does not touch Auth while disabled or missing its server key", async () => {
    expect((await POST(request(requestCode, "https://other.example"))).status).toBe(403);
    vi.stubEnv("NEXT_PUBLIC_ADMIN_EMAIL_OTP_ENABLED", "false");
    expect((await POST(request(requestCode))).status).toBe(503);
    vi.stubEnv("NEXT_PUBLIC_ADMIN_EMAIL_OTP_ENABLED", "true");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect((await POST(request(requestCode))).status).toBe(503);
    expect(mocks.createAuth).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it.each([user.id, null])("responds generically before looking up eligibility (%s)", async (id) => {
    mocks.rpc.mockResolvedValue({ data: id, error: null });
    const response = await POST(request(requestCode));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.createBrowser).not.toHaveBeenCalled();

    expect(mocks.after).toHaveBeenCalledOnce();
    await mocks.after.mock.calls[0][0]();
    expect(mocks.rpc).toHaveBeenCalledWith("find_admin_email_otp_user", { p_email: email });
    if (id) expect(mocks.sendCode).toHaveBeenCalledExactlyOnceWith({ email, options: { shouldCreateUser: false } });
    else expect(mocks.sendCode).not.toHaveBeenCalled();
  });

  it("clears the old browser session before rejecting a wrong email code", async () => {
    mocks.readBrowser.mockResolvedValue({ data: { session: { user: { id: "previous-user" } } }, error: null });
    mocks.verifyCode.mockResolvedValue({ data: { user: null, session: null }, error: { status: 403 } });
    expect((await POST(request(verifyCode))).status).toBe(401);
    expect(mocks.clearBrowser).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
    expect(mocks.clearBrowser.mock.invocationCallOrder[0]).toBeLessThan(mocks.verifyCode.mock.invocationCallOrder[0]);
    expect(mocks.verifyCode).toHaveBeenCalledExactlyOnceWith({ email, token: verifyCode.code, type: "email" });
    expect(mocks.installBrowser).not.toHaveBeenCalled();
    expect(mocks.readSecurity).not.toHaveBeenCalled();
  });

  it.each([
    { eligible: null, security: challenge },
    { eligible: "different-user", security: challenge },
    { eligible: user.id, security: { action: "none", current_aal: "aal1" } },
    { eligible: user.id, security: { action: "challenge", current_aal: "aal2" } },
  ])("revokes the isolated session when the same admin and pending TOTP cannot be confirmed (%j)", async ({ eligible, security }) => {
    mocks.rpc.mockResolvedValue({ data: eligible, error: null });
    mocks.readSecurity.mockResolvedValue(security);
    expect((await POST(request(verifyCode))).status).toBe(401);
    expect(mocks.installBrowser).not.toHaveBeenCalled();
    expect(mocks.revokeIsolated).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
  });

  it("installs the isolated AAL1 session only after both admin eligibility and the MFA challenge are confirmed", async () => {
    let finishLookup!: (value: { data: string; error: null }) => void;
    mocks.rpc.mockReturnValueOnce(new Promise((resolve) => { finishLookup = resolve; }));
    const pending = POST(request(verifyCode));
    await vi.waitFor(() => expect(mocks.readSecurity).toHaveBeenCalledExactlyOnceWith(auth, user.id));
    expect(mocks.installBrowser).not.toHaveBeenCalled();
    finishLookup({ data: user.id, error: null });

    expect((await pending).status).toBe(200);
    expect(mocks.installBrowser).toHaveBeenCalledExactlyOnceWith(tokens);
    expect(mocks.revokeIsolated).not.toHaveBeenCalled();
  });
});
