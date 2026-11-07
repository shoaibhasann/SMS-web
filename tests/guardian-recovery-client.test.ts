import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptGuardianRecovery, guardianRecoveryUrl, GuardianRecoveryError, loadGuardianRecovery,
  loadGuardianRecoveryClaim, newGuardianRecoveryToken, parseRecoveryWorkspace, recoveryContact,
  saveGuardianRecovery, type GuardianRecoveryWorkspace, type RecoveryIntent, type RecoveryReview,
} from "@/lib/guardian-invitations/recovery";

const school = "b2000000-0000-0000-0000-000000000001";
const owner = "b2000000-0000-0000-0000-000000000002";
const parent = "b2000000-0000-0000-0000-000000000003";
const caseId = "b2000000-0000-0000-0000-000000000004";
const requestId = "b2000000-0000-0000-0000-000000000005";
const token = "ab".repeat(32);
const date = "2026-11-08T00:00:00.000Z";
const getSession = vi.fn(), getUser = vi.fn(), rpc = vi.fn(), setHeader = vi.fn(), abortSignal = vi.fn();
const client = { auth: { getSession, getUser }, rpc } as unknown as SupabaseClient;
function workspace(): GuardianRecoveryWorkspace {
  return { school_id: school, guardians: [{ parent_id: parent, name: "QA guardian", linked_children: 2, requires_mfa: true }],
    cases: [{ id: caseId, parent_id: parent, guardian_name: "QA guardian", channel: "email", contact: "new@example.test", status: "pending", version: 1,
      expires_at: date, requires_mfa: true, created_at: date, requester_name: "Requester", reviewer_name: null, can_review: false, can_cancel: true }], cases_limit: 50, total_cases: 70 };
}
const intent = (): RecoveryIntent => ({ kind: "request", schoolId: school, parentId: parent, channel: "email", contact: "new@example.test", reason: "Verified school record", requestId });
const review = (): RecoveryReview => ({ kind: "review", caseId, version: 1, decision: "approve", reason: "Independent verification", requestId, token });
const receipt = () => ({ id: caseId, status: "pending", version: 1, expires_at: date, token: null });
function response(data: unknown, error: unknown = null) { abortSignal.mockResolvedValue({ data, error }); }
beforeEach(() => {
  vi.resetAllMocks();
  getSession.mockResolvedValue({ data: { session: { access_token: "captured-owner-token", user: { id: owner } } }, error: null });
  getUser.mockResolvedValue({ data: { user: { id: owner, is_anonymous: false } }, error: null });
  rpc.mockReturnValue({ setHeader }); setHeader.mockReturnValue({ abortSignal }); response(workspace());
});

describe("guardian recovery RPC trust boundary", () => {
  it("pins the verified owner's captured token and school, and trims only the admission lookup", async () => {
    const controller = new AbortController();
    expect(await loadGuardianRecovery(client, owner, school, " QA-001 ", controller.signal)).toEqual(workspace());
    expect(getUser).toHaveBeenCalledExactlyOnceWith("captured-owner-token");
    expect(rpc).toHaveBeenCalledExactlyOnceWith("get_guardian_recovery_workspace", { p_school_id: school, p_admission_no: "QA-001" });
    expect(setHeader).toHaveBeenCalledExactlyOnceWith("Authorization", "Bearer captured-owner-token");
    expect(abortSignal).toHaveBeenCalledExactlyOnceWith(controller.signal);
  });
  it("does not call a recovery RPC after an account switch or sign-out", async () => {
    getSession.mockResolvedValueOnce({ data: { session: { access_token: "b-token", user: { id: "account-b" } } }, error: null });
    await expect(loadGuardianRecovery(client, owner, school, "QA-001")).rejects.toThrow(/account changed/);
    getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    await expect(loadGuardianRecovery(client, owner, school, "QA-001")).rejects.toMatchObject({ code: "access" });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("rejects a late RPC result after cancellation", async () => {
    const controller = new AbortController();
    abortSignal.mockImplementation(async () => { controller.abort(); return { data: workspace(), error: null }; });
    await expect(loadGuardianRecovery(client, owner, school, "QA-001", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
  it.each([["42501", "access"], ["PGRST301", "access"], ["22023", "validation"], ["PT409", "conflict"], ["40001", "conflict"], ["55000", "unavailable"], ["P0001", "unavailable"], ["XX000", "unconfirmed"]])("maps %s without exposing provider diagnostics", async (code, expected) => {
    response(null, { code, message: "private database contact and diagnostic" });
    const failure = await loadGuardianRecovery(client, owner, school, "QA-001").catch(error => error);
    expect(failure).toBeInstanceOf(GuardianRecoveryError); expect(failure.code).toBe(expected);
    expect(failure.message).not.toContain("private database");
  });
  it("keeps claim secrets in URL fragments, never query parameters or persistent storage", () => {
    const generated = newGuardianRecoveryToken(); expect(generated).toMatch(/^[a-f0-9]{64}$/);
    expect(newGuardianRecoveryToken()).not.toBe(generated);
    const url = new URL(guardianRecoveryUrl(token, "https://school.example/base?previous=1"));
    expect(url.pathname).toBe("/guardian-recover"); expect(url.search).toBe(""); expect(url.hash).toBe(`#token=${token}`);
    expect(() => guardianRecoveryUrl("invalid", url.origin)).toThrow(GuardianRecoveryError);
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  });
  it("normalizes only valid Indian phone and email contacts", () => {
    expect(recoveryContact("phone", "98765 43210")).toBe("+919876543210");
    expect(recoveryContact("email", " NEW@Example.Test ")).toBe("new@example.test");
    expect(recoveryContact("phone", "+12025550123")).toBeNull(); expect(recoveryContact("email", "not-email")).toBeNull();
  });
});

describe("recovery workspace DTO", () => {
  it("accepts capped lists with a larger total and independent permissions", () => {
    expect(parseRecoveryWorkspace(workspace(), school)).toEqual(workspace());
    expect(parseRecoveryWorkspace({ ...workspace(), guardians: [], cases: [], total_cases: 0 }, school).cases).toEqual([]);
  });
  it.each([
    ["wrong school", (w: GuardianRecoveryWorkspace) => ({ ...w, school_id: parent })],
    ["wrong cap", (w: GuardianRecoveryWorkspace) => ({ ...w, cases_limit: 100 })],
    ["invalid total", (w: GuardianRecoveryWorkspace) => ({ ...w, total_cases: 0 })],
    ["too many rows", (w: GuardianRecoveryWorkspace) => ({ ...w, cases: Array.from({ length: 51 }, (_, i) => ({ ...w.cases[0], id: `b2000000-0000-0000-0000-${String(i).padStart(12, "0")}` })) })],
    ["duplicate cases", (w: GuardianRecoveryWorkspace) => ({ ...w, cases: [w.cases[0], w.cases[0]] })],
    ["duplicate guardians", (w: GuardianRecoveryWorkspace) => ({ ...w, guardians: [w.guardians[0], w.guardians[0]] })],
    ["too many guardians", (w: GuardianRecoveryWorkspace) => ({ ...w, guardians: Array.from({ length: 21 }, (_, i) => ({ ...w.guardians[0], parent_id: `b2000000-0000-0000-0000-${String(i).padStart(12, "0")}` })) })],
    ["no linked children", (w: GuardianRecoveryWorkspace) => ({ ...w, guardians: [{ ...w.guardians[0], linked_children: 0 }] })],
    ["string permission", (w: GuardianRecoveryWorkspace) => ({ ...w, cases: [{ ...w.cases[0], can_review: "true" }] })],
    ["unknown status", (w: GuardianRecoveryWorkspace) => ({ ...w, cases: [{ ...w.cases[0], status: "ready" }] })],
    ["version zero", (w: GuardianRecoveryWorkspace) => ({ ...w, cases: [{ ...w.cases[0], version: 0 }] })],
    ["noncanonical contact", (w: GuardianRecoveryWorkspace) => ({ ...w, cases: [{ ...w.cases[0], contact: "New@example.test" }] })],
    ["invalid date", (w: GuardianRecoveryWorkspace) => ({ ...w, cases: [{ ...w.cases[0], expires_at: "tomorrow" }] })],
    ["control characters", (w: GuardianRecoveryWorkspace) => ({ ...w, guardians: [{ ...w.guardians[0], name: "guardian\nprivate" }] })],
  ])("rejects %s rather than rendering unverified records", (_name, mutate) => {
    expect(() => parseRecoveryWorkspace(mutate(workspace()), school)).toThrow(GuardianRecoveryError);
  });
});

describe("recovery mutations and claim receipts", () => {
  it("submits the exact request identity and receives only a pending case", async () => {
    response(receipt()); expect(await saveGuardianRecovery(client, owner, intent())).toEqual(receipt());
    expect(rpc).toHaveBeenCalledExactlyOnceWith("request_guardian_account_recovery", { p_school_id: school, p_parent_id: parent, p_channel: "email", p_contact: "new@example.test", p_reason: "Verified school record", p_request_id: requestId });
  });
  it("pins the reviewed case version and one-use token", async () => {
    response({ ...receipt(), status: "approved", version: 2, token });
    expect(await saveGuardianRecovery(client, owner, review())).toMatchObject({ id: caseId, status: "approved", version: 2, token });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("review_guardian_account_recovery", { p_case_id: caseId, p_expected_version: 1, p_decision: "approve", p_reason: "Independent verification", p_request_id: requestId, p_claim_token: token });
  });
  it.each([
    { ...intent(), kind: "other" }, { ...intent(), schoolId: "invalid" }, { ...intent(), reason: "tiny" },
    { ...intent(), reason: "private\nrecord" }, { ...intent(), requestId: "not-uuid" }, { ...intent(), contact: "NEW@example.test" },
    { ...review(), version: 0 }, { ...review(), version: 1.5 }, { ...review(), token: "bad" }, { ...review(), decision: "cancel", token },
  ])("does not send malformed mutation %#", async malformed => {
    await expect(saveGuardianRecovery(client, owner, malformed as RecoveryIntent)).rejects.toBeInstanceOf(GuardianRecoveryError); expect(rpc).not.toHaveBeenCalled();
  });
  it.each([
    { ...receipt(), status: "accepted" }, { ...receipt(), id: "bad" }, { ...receipt(), version: 0 }, { ...receipt(), expires_at: "bad" }, { ...receipt(), token },
  ])("rejects an unverified request receipt %#", async malformed => {
    response(malformed); await expect(saveGuardianRecovery(client, owner, intent())).rejects.toBeInstanceOf(GuardianRecoveryError);
  });
  it.each([
    { ...receipt(), status: "rejected", version: 2, token }, { ...receipt(), status: "approved", version: 3, token },
    { ...receipt(), status: "approved", version: 2, token: "cd".repeat(32) }, { ...receipt(), id: parent, status: "approved", version: 2, token },
  ])("rejects mismatched review receipts %#", async malformed => {
    response(malformed); await expect(saveGuardianRecovery(client, owner, review())).rejects.toBeInstanceOf(GuardianRecoveryError);
  });
  it.each(["reject", "cancel"] as const)("does not accept a private token in a %s receipt", async decision => {
    response({ ...receipt(), status: decision === "reject" ? "rejected" : "cancelled", version: 2, token });
    await expect(saveGuardianRecovery(client, owner, { ...review(), decision, token: null })).rejects.toBeInstanceOf(GuardianRecoveryError);
  });
  it("validates claim details before allowing acceptance", async () => {
    const claim = { school_name: "QA school", requires_mfa: true, linked_children: 2, expires_at: date }; response(claim);
    expect(await loadGuardianRecoveryClaim(client, owner, token)).toEqual(claim);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("get_my_guardian_recovery_claim", { p_token: token });
    response({ ...claim, requires_mfa: "yes" }); await expect(loadGuardianRecoveryClaim(client, owner, token)).rejects.toBeInstanceOf(GuardianRecoveryError);
    response({ ...claim, linked_children: 0 }); await expect(loadGuardianRecoveryClaim(client, owner, token)).rejects.toBeInstanceOf(GuardianRecoveryError);
  });
  it("passes an unchanged idempotency key and validates preserved parent identity on claim replay", async () => {
    response({ school_id: school, parent_id: parent, linked_children: 2, replayed: true });
    expect(await acceptGuardianRecovery(client, owner, token, requestId)).toEqual({ schoolId: school, parentId: parent, linkedChildren: 2, replayed: true });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("accept_guardian_account_recovery", { p_token: token, p_request_id: requestId });
    response({ school_id: school, parent_id: "bad", linked_children: 2, replayed: true }); await expect(acceptGuardianRecovery(client, owner, token, requestId)).rejects.toBeInstanceOf(GuardianRecoveryError);
  });
});
