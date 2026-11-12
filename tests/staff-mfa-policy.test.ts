import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadStaffMfaPolicy, parseStaffMfaPolicy, saveStaffMfaPolicy, type StaffMfaPolicy, type StaffMfaPolicyIntent } from "@/lib/admin/staff-mfa-policy";

const mocks = vi.hoisted(() => ({ status: vi.fn(), session: vi.fn() }));
vi.mock("@/lib/auth/staff-mfa", () => ({ readStaffMfaStatus: mocks.status, boundMfaSession: mocks.session }));
const school = "b2000000-0000-0000-0000-000000000001";
const policy: StaffMfaPolicy = { school_id: school, required: false, revision: 1, can_manage: true, staff_count: 5, enrolled_staff_count: 4,
  enrollment_required_count: 1, history: [{ id: "b2000000-0000-0000-0000-000000000003", revision: 1, required: false, changed_at: "2026-11-07T00:00:00Z", actor_name: "QA Admin" }],
  pending: [{ profile_id: "b2000000-0000-0000-0000-000000000004", full_name: "Asha Teacher", roles: ["teacher"], reason: "not_enrolled" }] };
const pendingRow = policy.pending[0];
const intent: StaffMfaPolicyIntent = { schoolId: school, revision: 1, required: true, requestId: "b2000000-0000-0000-0000-000000000002", reason: "Staff setup verified" };
function client(data: unknown = policy, error: { code: string } | null = null) {
  const query = { setHeader: vi.fn().mockReturnThis(), abortSignal: vi.fn(async () => ({ data, error })) };
  return { rpc: vi.fn(() => query), query };
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.status.mockResolvedValue({ allowed: true, current_aal: "aal2", verified_totp_count: 1 });
  mocks.session.mockResolvedValue({ user: { id: "owner" }, access_token: "verified-owner-token" } as Session);
});
describe("school MFA policy contract", () => {
  it("parses scoped readiness and bounded history", () => {
    expect(parseStaffMfaPolicy(policy, school)).toEqual(policy);
  });
  it.each([{ school_id: "another" }, { enrollment_required_count: 2 }, { revision: -1 }, { can_manage: "yes" },
    { history: [{ ...policy.history[0], revision: 2 }] }, { history: Array(11).fill(policy.history[0]) },
    { pending: [] }, { pending: undefined }, { pending: [{ ...pendingRow, reason: "lazy" }] }, { pending: [{ ...pendingRow, roles: [] }] },
    { pending: [{ ...pendingRow, full_name: "x".repeat(201) }] }, { pending: [{ ...pendingRow, profile_id: "someone" }] },
    { staff_count: 6, enrollment_required_count: 2, pending: [pendingRow, pendingRow] }])("rejects malformed or unscoped status %j", (patch) => {
    expect(() => parseStaffMfaPolicy({ ...policy, ...patch }, school)).toThrow(/could not be verified/);
  });
  it("accepts a pending list capped at 200 rows when more staff still need setup", () => {
    const pending = Array.from({ length: 200 }, (_, index) => ({ ...pendingRow, profile_id: `b3000000-0000-0000-0000-${String(index).padStart(12, "0")}`, full_name: null }));
    const capped = { ...policy, staff_count: 260, enrolled_staff_count: 10, enrollment_required_count: 250, pending };
    expect(parseStaffMfaPolicy(capped, school).pending).toHaveLength(200);
  });
  it("counts names in code points like the SQL 160-character trim", () => {
    const longest = "\u{1D4D0}".repeat(160);
    const accepted = { ...policy, history: [{ ...policy.history[0], actor_name: longest }], pending: [{ ...pendingRow, full_name: longest }] };
    expect(parseStaffMfaPolicy(accepted, school)).toEqual(accepted);
    expect(() => parseStaffMfaPolicy({ ...policy, pending: [{ ...pendingRow, full_name: "x".repeat(161) }] }, school)).toThrow(/could not be verified/);
    expect(() => parseStaffMfaPolicy({ ...policy, history: [{ ...policy.history[0], actor_name: `${longest}x` }] }, school)).toThrow(/could not be verified/);
  });
  it("pins read and write to a verified owner token and preserves exact request IDs", async () => {
    const read = client(); await loadStaffMfaPolicy(read as unknown as SupabaseClient, "owner", school);
    expect(read.rpc).toHaveBeenCalledWith("get_school_staff_mfa_policy", { p_school_id: school });
    expect(read.query.setHeader).toHaveBeenCalledWith("Authorization", "Bearer verified-owner-token");
    const write = client({ revision: 2, required: true, changed: true, replayed: true });
    expect(await saveStaffMfaPolicy(write as unknown as SupabaseClient, "owner", intent)).toEqual({ revision: 2, required: true, changed: true, replayed: true });
    expect(write.rpc).toHaveBeenCalledWith("save_school_staff_mfa_policy", { p_school_id: school, p_expected_revision: 1, p_required: true, p_request_id: intent.requestId, p_reason: intent.reason });
  });
  it.each([{ allowed: false, current_aal: "aal1", verified_totp_count: 1 }, { allowed: true, current_aal: "aal1", verified_totp_count: 0 }, null])("refuses a policy writer without fresh native MFA proof %j", async (status) => {
    mocks.status.mockResolvedValue(status); const write = client();
    await expect(saveStaffMfaPolicy(write as unknown as SupabaseClient, "owner", intent)).rejects.toThrow(/Verify your authenticator/);
    expect(write.rpc).not.toHaveBeenCalled();
  });
  it.each(["PT409", "40001", "42501", "22023", "unexpected"])("bounds %s writer failure details", async (code) => {
    const write = client(null, { code }); await expect(saveStaffMfaPolicy(write as unknown as SupabaseClient, "owner", intent)).rejects.toThrow();
  });
  it("rejects an unconfirmed result so retries retain the original request", async () => {
    const write = client({ revision: 8, required: true, changed: true, replayed: false });
    await expect(saveStaffMfaPolicy(write as unknown as SupabaseClient, "owner", intent)).rejects.toMatchObject({ code: "unconfirmed" });
  });
});
