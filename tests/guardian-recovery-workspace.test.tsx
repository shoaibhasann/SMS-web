import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GuardianRecoveryWorkspace } from "@/components/admin/guardian-recovery-workspace";
import { GuardianRecoveryError, type GuardianRecoveryWorkspace as Workspace, type RecoveryIntent } from "@/lib/guardian-invitations/recovery";

const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), status: vi.fn(), subscribe: vi.fn() }));
vi.mock("@/lib/guardian-invitations/recovery", async original => ({ ...await original<typeof import("@/lib/guardian-invitations/recovery")>(), loadGuardianRecovery: mocks.load, saveGuardianRecovery: mocks.save }));
vi.mock("@/lib/auth/staff-mfa", async original => ({ ...await original<typeof import("@/lib/auth/staff-mfa")>(), readStaffMfaStatus: mocks.status }));
const school = "b2000000-0000-0000-0000-000000000001", parent = "b2000000-0000-0000-0000-000000000003", caseId = "b2000000-0000-0000-0000-000000000004";
const date = "2026-11-08T00:00:00.000Z", token = "ab".repeat(32);
const client = { auth: { onAuthStateChange: mocks.subscribe } } as unknown as SupabaseClient;
const busy = vi.fn();
let authChanged: (event: string, session: { user: { id: string } } | null) => void;
function workspace(): Workspace {
  return { school_id: school, guardians: [{ parent_id: parent, name: "QA guardian", linked_children: 2, requires_mfa: true }], cases_limit: 50, total_cases: 75,
    cases: [{ id: caseId, parent_id: parent, guardian_name: "QA guardian", channel: "email", contact: "new@example.test", status: "pending", version: 1, expires_at: date,
      created_at: date, requires_mfa: true, requester_name: "School requester", reviewer_name: null, can_review: true, can_cancel: false }] };
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear();
  mocks.status.mockResolvedValue({ user_id: "owner", allowed: true, current_aal: "aal2", verified_totp_count: 1 });
  mocks.load.mockResolvedValue(workspace()); mocks.save.mockResolvedValue({ id: caseId, status: "pending", version: 1, expires_at: date, token: null });
  mocks.subscribe.mockImplementation(callback => { authChanged = callback; return { data: { subscription: { unsubscribe: vi.fn() } } }; });
});
function mount() { return render(<GuardianRecoveryWorkspace client={client} userId="owner" schoolId={school} busy={false} onBusyChange={busy} />); }
async function request() {
  fireEvent.change(await screen.findByLabelText("New email address"), { target: { value: "NEW@example.test" } });
  fireEvent.change(screen.getByLabelText("School verification reason"), { target: { value: "  Verified admission register  " } });
  fireEvent.submit(screen.getByRole("form", { name: "Request guardian recovery" }));
}
async function approve() {
  fireEvent.click(await screen.findByRole("button", { name: "Review and approve" }));
  fireEvent.change(screen.getByLabelText("Independent review reason"), { target: { value: "Independent record and contact check" } });
  fireEvent.submit(screen.getByRole("form", { name: "Review guardian recovery" }));
}

describe("guardian recovery school workspace", () => {
  it("requires current AAL2 even when ordinary school MFA is optional", async () => {
    mocks.status.mockResolvedValue({ allowed: true, current_aal: "aal1", verified_totp_count: 0 }); mount();
    expect(await screen.findByRole("link", { name: "Verify account security" })).toHaveAttribute("href", "/mfa?next=%2Fmodules%2Fguardian-invitations%3Frecovery%3D1&setup=1");
    expect(mocks.load).not.toHaveBeenCalled(); expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });
  it("fails closed when authorization cannot be verified", async () => {
    mocks.status.mockRejectedValue(new Error("Sign in again before opening school recovery.")); mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign in again");
    expect(mocks.load).not.toHaveBeenCalled(); expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });
  it("searches a pinned school and displays the capped list separately from its total", async () => {
    mount(); await screen.findByLabelText("Student admission number");
    expect(await screen.findByText("Latest 1 of 75")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Student admission number"), { target: { value: "  QA-001  " } });
    fireEvent.submit(screen.getByRole("form", { name: "Find guardian for recovery" }));
    await waitFor(() => expect(mocks.load).toHaveBeenLastCalledWith(client, "owner", school, "QA-001", expect.any(AbortSignal)));
    expect(screen.getByRole("option", { name: /QA guardian · 2 linked children · authenticator required/ })).toBeInTheDocument();
  });
  it("normalizes the selected contact and records one stable request identity", async () => {
    mount(); await request(); await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    expect(mocks.save.mock.calls[0][2]).toEqual({ kind: "request", schoolId: school, parentId: parent, channel: "email", contact: "new@example.test", reason: "Verified admission register", requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(await screen.findByRole("status")).toHaveTextContent("different authorized staff member");
    expect(screen.queryByLabelText("Private recovery link")).not.toBeInTheDocument();
  });
  it("does not offer same-requester approval when only cancellation is authorized", async () => {
    const w = workspace(); w.cases[0].can_review = false; w.cases[0].can_cancel = true; mocks.load.mockResolvedValue(w); mount();
    expect(await screen.findByRole("button", { name: "Cancel recovery" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Review and approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
  });
  it("keeps the exact unknown request and locks all competing actions until retry confirms it", async () => {
    mocks.save.mockRejectedValueOnce(new GuardianRecoveryError("The recovery result is unknown.")); mount(); await request();
    expect(await screen.findByRole("alert")).toHaveTextContent("unknown");
    const original = mocks.save.mock.calls[0][2] as RecoveryIntent;
    expect(screen.getByLabelText("New email address")).toBeDisabled(); expect(screen.getByLabelText("Student admission number")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reload recovery records" })).toBeDisabled(); expect(busy).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry same recovery request" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2)); expect(mocks.save.mock.calls[1][2]).toBe(original);
    expect(await screen.findByRole("status")).toHaveTextContent("request saved");
  });
  it("retains the same approval token and version on uncertain retry, then exposes only a fragment link", async () => {
    mocks.save.mockRejectedValueOnce(new GuardianRecoveryError("The result is unknown."));
    mount(); await approve(); const retry = await screen.findByRole("button", { name: "Retry same recovery request" });
    const original = mocks.save.mock.calls[0][2] as RecoveryIntent;
    expect(original).toMatchObject({ kind: "review", caseId, version: 1, decision: "approve", token: expect.stringMatching(/^[0-9a-f]{64}$/) });
    mocks.save.mockResolvedValueOnce({ id: caseId, status: "approved", version: 2, expires_at: date, token: original.kind === "review" ? original.token : null });
    fireEvent.click(retry); await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
    expect(mocks.save.mock.calls[1][2]).toBe(original);
    const link = await screen.findByLabelText("Private recovery link") as HTMLInputElement;
    expect(new URL(link.value).search).toBe(""); expect(new URL(link.value).pathname).toBe("/guardian-recover");
    expect(new URL(link.value).hash).toBe(`#token=${original.kind === "review" ? original.token : ""}`);
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  });
  it("reloads known conflicts instead of silently repeating or approving stale records", async () => {
    mocks.save.mockRejectedValueOnce(new GuardianRecoveryError("Recovery details changed elsewhere.", "conflict")); mount(); await request();
    expect(await screen.findByRole("alert")).toHaveTextContent("changed elsewhere");
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "Retry same recovery request" })).not.toBeInTheDocument();
    expect(mocks.save).toHaveBeenCalledOnce();
  });
  it("aborts a pending approval on account change and hides its late token", async () => {
    let finish!: (value: unknown) => void; mocks.save.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    mount(); await approve(); await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    const signal = mocks.save.mock.calls[0][3] as AbortSignal;
    act(() => authChanged("SIGNED_IN", { user: { id: "account-b" } }));
    expect(signal.aborted).toBe(true); expect(screen.getByRole("alert")).toHaveTextContent("account changed");
    await act(async () => finish({ id: caseId, status: "approved", version: 2, expires_at: date, token }));
    expect(screen.queryByLabelText("Private recovery link")).not.toBeInTheDocument(); expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });
  it("clears an already-issued private link on account switch", async () => {
    mocks.save.mockResolvedValueOnce({ id: caseId, status: "approved", version: 2, expires_at: date, token }); mount(); await approve();
    await screen.findByLabelText("Private recovery link");
    act(() => authChanged("SIGNED_OUT", null));
    expect(screen.queryByLabelText("Private recovery link")).not.toBeInTheDocument(); expect(screen.getByRole("alert")).toHaveTextContent("account changed");
  });
});
