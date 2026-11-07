import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boundMfaSession, createBoundMfaClient, enrollAuthenticator, listAuthenticators, mfaPath, parseStaffMfaStatus,
  readStaffMfaStatus, refreshMfaSession, removeAuthenticator, safeMfaNext, verifyAuthenticator, type StaffMfaStatus } from "@/lib/auth/staff-mfa";

const mocks = vi.hoisted(() => ({ create: vi.fn(), bind: vi.fn(), list: vi.fn(), enroll: vi.fn(), verify: vi.fn(), remove: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.create }));
const user = { id: "owner", email_confirmed_at: "2026-11-07T00:00:00Z" };
const session = { user, access_token: "captured-owner-token", refresh_token: "captured-owner-refresh" } as Session;
const status: StaffMfaStatus = { user_id: "owner", profile_school_id: "school", roles: [{ role: "teacher", school_id: "school" }],
  required: true, allowed: false, action: "challenge", current_aal: "aal1", verified_totp_count: 1, staff: true, policy_required: true };
function primary() {
  const reply = { data: status, error: null };
  const query = { setHeader: vi.fn().mockReturnThis(), abortSignal: vi.fn(async () => reply) };
  return { auth: { getSession: vi.fn(async () => ({ data: { session }, error: null })), getUser: vi.fn(async () => ({ data: { user }, error: null })),
    refreshSession: vi.fn(async () => ({ data: { user, session }, error: null })), setSession: vi.fn() }, rpc: vi.fn(() => query), query, reply };
}
function isolated() { return { auth: { setSession: mocks.bind, mfa: { listFactors: mocks.list, enroll: mocks.enroll, challengeAndVerify: mocks.verify, unenroll: mocks.remove } } }; }
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co"); vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  mocks.create.mockReturnValue(isolated()); mocks.bind.mockResolvedValue({ data: { user, session }, error: null });
  mocks.list.mockResolvedValue({ data: { all: [{ id: "pending", factor_type: "totp", status: "unverified" }], totp: [{ id: "verified", created_at: "2026-11-07" }] }, error: null });
  mocks.verify.mockResolvedValue({ data: {}, error: null }); mocks.remove.mockResolvedValue({ data: {}, error: null });
  mocks.enroll.mockResolvedValue({ data: { id: "own-pending", type: "totp", totp: { secret: "IN-MEMORY-ONLY", qr_code: "data:image/svg+xml;utf-8,test" } }, error: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("authoritative MFA bootstrap", () => {
  it("accepts a family account without factors and a zero-role pre-enrollment identity", () => {
    expect(parseStaffMfaStatus({ ...status, required: false, allowed: true, action: "none", verified_totp_count: 0, roles: [], staff: false, policy_required: false }, "owner").allowed).toBe(true);
  });
  it.each([{ user_id: "another" }, { allowed: true }, { current_aal: "aal3" }, { roles: [{ role: "teacher", school_id: 42 }] },
    { verified_totp_count: -1 }, { required: false }, { action: "enroll" }, { verified_totp_count: 0 },
    { required: true, allowed: true, action: "none", current_aal: "aal1" }])("fails closed on malformed or mismatched bootstrap %j", (patch) => {
    expect(() => parseStaffMfaStatus({ ...status, ...patch }, "owner")).toThrow(/could not be verified/);
  });
  it("pins the safe bootstrap to the captured independently verified token", async () => {
    const client = primary();
    expect(await readStaffMfaStatus(client as unknown as SupabaseClient)).toEqual(status);
    expect(client.auth.getUser).toHaveBeenCalledWith(session.access_token);
    expect(client.rpc).toHaveBeenCalledWith("get_my_staff_mfa_status");
    expect(client.query.setHeader).toHaveBeenCalledWith("Authorization", `Bearer ${session.access_token}`);
  });
  it("does not invoke a data API for absent or switched accounts", async () => {
    const client = primary(); client.auth.getSession.mockResolvedValueOnce({ data: { session: null as unknown as Session }, error: null });
    expect(await readStaffMfaStatus(client as unknown as SupabaseClient)).toBeNull(); expect(client.rpc).not.toHaveBeenCalled();
    await expect(boundMfaSession(client as unknown as SupabaseClient, "someone-else")).rejects.toThrow(/account changed/);
    expect(client.auth.getUser).not.toHaveBeenCalled();
  });
  it("refreshes the current primary without explicit isolated tokens then rechecks native bootstrap", async () => {
    const client = primary();
    await refreshMfaSession(client as unknown as SupabaseClient, "owner");
    expect(client.auth.refreshSession).toHaveBeenCalledWith();
    expect(client.auth.setSession).not.toHaveBeenCalled(); expect(client.rpc).toHaveBeenCalledOnce();
  });
  it("will not acknowledge another account's refreshed session", async () => {
    const client = primary(); client.auth.refreshSession.mockResolvedValueOnce({ data: { user: { ...user, id: "account-b" }, session }, error: null });
    await expect(refreshMfaSession(client as unknown as SupabaseClient, "owner")).rejects.toThrow(/account changed/);
    expect(client.rpc).not.toHaveBeenCalled(); expect(client.auth.setSession).not.toHaveBeenCalled();
  });
});
describe("isolated authenticator operations", () => {
  it("binds an ephemeral client and never writes its session into the primary", async () => {
    const client = primary(), controller = new AbortController();
    await createBoundMfaClient(client as unknown as SupabaseClient, "owner", controller.signal);
    expect(mocks.create).toHaveBeenCalledWith("https://example.supabase.co", "publishable-key", expect.objectContaining({ auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: expect.stringMatching(/^staff-mfa-/) } }));
    expect(mocks.bind).toHaveBeenCalledWith({ access_token: session.access_token, refresh_token: session.refresh_token });
    expect(client.auth.setSession).not.toHaveBeenCalled();
    const abortable = mocks.create.mock.calls[0][2].global.fetch;
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    controller.abort(); await abortable("https://example.supabase.co/auth/v1/test", { method: "POST" });
    expect(fetch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ signal: controller.signal })); fetch.mockRestore();
  });
  it("returns only verified TOTP factors, not pending enrollments", async () => {
    expect(await listAuthenticators(isolated() as unknown as SupabaseClient)).toEqual([{ id: "verified", created_at: "2026-11-07" }]);
  });
  it("rejects invalid enrollment names and codes before any Auth mutation", async () => {
    await expect(enrollAuthenticator(isolated() as unknown as SupabaseClient, "x")).rejects.toThrow(/device name/);
    await expect(verifyAuthenticator(isolated() as unknown as SupabaseClient, "factor", "12345")).rejects.toThrow(/six-digit/);
    expect(mocks.enroll).not.toHaveBeenCalled(); expect(mocks.verify).not.toHaveBeenCalled();
  });
  it.each(["mfa_verification_failed", "mfa_challenge_expired", "over_request_rate_limit", "insufficient_aal"])("bounds provider feedback for %s", async (code) => {
    mocks.verify.mockResolvedValueOnce({ data: null, error: { code, message: "PRIVATE INTERNAL PROVIDER DETAILS" } });
    const call = verifyAuthenticator(isolated() as unknown as SupabaseClient, "factor", "123456");
    await expect(call).rejects.toThrow(); await expect(call).rejects.not.toThrow(/PRIVATE INTERNAL/);
  });
  it("removes only the explicitly supplied factor", async () => {
    await removeAuthenticator(isolated() as unknown as SupabaseClient, "flow-owned-pending-factor");
    expect(mocks.remove).toHaveBeenCalledWith({ factorId: "flow-owned-pending-factor" });
  });
});
describe("MFA continuations", () => {
  it.each(["https://evil.example/", "//evil.example", "/auth/callback", "/update-password", "/mfa", "/api/push/dispatch", "/%2f%2fevil.example"])("rejects unsafe or looping continuation %s", (next) => {
    expect(safeMfaNext(next)).toBe("/dashboard");
  });
  it("preserves guardian scope and keeps invitation bearer fragments out of HTTP queries", () => {
    expect(safeMfaNext("/modules/attendance?view=guardian&child=own-child")).toBe("/modules/attendance?view=guardian&child=own-child");
    expect(mfaPath("/teacher-invite#token=private-bearer")).toBe("/mfa?next=%2Fteacher-invite");
  });
});
