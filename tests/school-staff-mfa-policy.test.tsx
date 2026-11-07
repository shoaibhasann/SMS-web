import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SchoolStaffMfaPolicy } from "@/components/admin/school-staff-mfa-policy";
import { StaffMfaPolicyError, type StaffMfaPolicy, type StaffMfaPolicyIntent } from "@/lib/admin/staff-mfa-policy";

const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), status: vi.fn(), subscribe: vi.fn() }));
vi.mock("@/lib/admin/staff-mfa-policy", async (original) => ({ ...await original<typeof import("@/lib/admin/staff-mfa-policy")>(), loadStaffMfaPolicy: mocks.load, saveStaffMfaPolicy: mocks.save }));
vi.mock("@/lib/auth/staff-mfa", async (original) => ({ ...await original<typeof import("@/lib/auth/staff-mfa")>(), readStaffMfaStatus: mocks.status }));
const client = { auth: { onAuthStateChange: mocks.subscribe } } as unknown as SupabaseClient;
const school = "b2000000-0000-0000-0000-000000000001";
const policy: StaffMfaPolicy = { school_id: school, required: false, revision: 1, can_manage: true, staff_count: 5, enrolled_staff_count: 5, enrollment_required_count: 0, history: [] };
const locked = vi.fn();
let authChanged: (event: string, session: { user: { id: string } } | null) => void;
beforeEach(() => {
  vi.clearAllMocks(); mocks.load.mockResolvedValue(policy); mocks.save.mockResolvedValue({ revision: 2, required: true, changed: true, replayed: false });
  mocks.status.mockResolvedValue({ user_id: "owner", allowed: true, current_aal: "aal2", verified_totp_count: 1 });
  mocks.subscribe.mockImplementation((callback) => { authChanged = callback; return { data: { subscription: { unsubscribe: vi.fn() } } }; });
});
function mount() { return render(<SchoolStaffMfaPolicy client={client} userId="owner" schoolId={school} onLock={locked} />); }
async function save() {
  fireEvent.change(await screen.findByLabelText("Reason for enabling"), { target: { value: "All staff verified their devices" } });
  fireEvent.submit(screen.getByRole("form", { name: "Change staff authenticator policy" }));
}
describe("school authenticator policy UI", () => {
  it("keeps Principal access read-only", async () => {
    mocks.load.mockResolvedValue({ ...policy, can_manage: false }); mount();
    await screen.findByText(/Read-only access/);
    expect(screen.queryByRole("form")).not.toBeInTheDocument(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("requires each active staff member to enroll before enabling", async () => {
    mocks.load.mockResolvedValue({ ...policy, enrolled_staff_count: 4, enrollment_required_count: 1 }); mount();
    expect(await screen.findByRole("button", { name: "Require authenticator for staff" })).toBeDisabled();
    expect(screen.getByText(/Ask remaining staff/)).toBeInTheDocument(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("links an unenrolled Admin to explicit own setup rather than changing policy at AAL1", async () => {
    mocks.status.mockResolvedValue({ allowed: true, current_aal: "aal1", verified_totp_count: 0 }); mount();
    expect(await screen.findByRole("link", { name: /Set up and verify/ })).toHaveAttribute("href", "/mfa?next=%2Fmodules%2Fsettings&setup=1");
    expect(screen.queryByRole("form")).not.toBeInTheDocument(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("retains the exact intent after an unknown save and locks school switching until confirmed", async () => {
    mocks.save.mockRejectedValueOnce(new StaffMfaPolicyError("The save could not be confirmed.")); mount(); await save();
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be confirmed");
    const original = mocks.save.mock.calls[0][2] as StaffMfaPolicyIntent;
    expect(screen.getByLabelText("Reason for enabling")).toBeDisabled(); expect(screen.getByRole("button", { name: "Reload saved policy" })).toBeDisabled();
    expect(locked).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry same policy save" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
    expect(mocks.save.mock.calls[1][2]).toBe(original);
    expect(await screen.findByRole("status")).toHaveTextContent("policy saved");
  });
  it("requires reload after a revision conflict without auto-overwriting the other administrator", async () => {
    mocks.save.mockRejectedValueOnce(new StaffMfaPolicyError("Policy changed elsewhere.", "conflict")); mount(); await save();
    expect(await screen.findByRole("alert")).toHaveTextContent("changed elsewhere");
    expect(screen.getByRole("button", { name: "Require authenticator for staff" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reload saved policy" })).toBeEnabled(); expect(mocks.save).toHaveBeenCalledOnce();
  });
  it("removes policy controls on account switch", async () => {
    mount(); await screen.findByLabelText("Reason for enabling");
    act(() => authChanged("SIGNED_IN", { user: { id: "account-b" } }));
    expect(screen.getByRole("alert")).toHaveTextContent("account changed"); expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });
});
