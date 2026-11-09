import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountAuthenticator } from "@/components/account/account-authenticator";
import { StaffMfaError, type StaffMfaStatus } from "@/lib/auth/staff-mfa";

const mocks = vi.hoisted(() => ({ status: vi.fn(), bound: vi.fn(), list: vi.fn(), enroll: vi.fn(), verify: vi.fn(), remove: vi.fn(), refresh: vi.fn(), subscribe: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { onAuthStateChange: mocks.subscribe } }) }));
vi.mock("@/lib/auth/staff-mfa", async (original) => ({ ...await original<typeof import("@/lib/auth/staff-mfa")>(), readStaffMfaStatus: mocks.status,
  createBoundMfaClient: mocks.bound, listAuthenticators: mocks.list, enrollAuthenticator: mocks.enroll, verifyAuthenticator: mocks.verify, removeAuthenticator: mocks.remove, refreshMfaSession: mocks.refresh }));
const status: StaffMfaStatus = { user_id: "owner", profile_school_id: "school", roles: [{ role: "teacher", school_id: "school" }], required: false, allowed: true,
  action: "none", current_aal: "aal1", verified_totp_count: 0, staff: true, policy_required: false };
const factor = { id: "verified", friendly_name: "My phone", created_at: "2026-11-07" };
let authChanged: (event: string, session: { user: { id: string } } | null) => void;
beforeEach(() => {
  vi.clearAllMocks(); mocks.status.mockResolvedValue(status); mocks.bound.mockResolvedValue({ id: "isolated-owner-client" }); mocks.list.mockResolvedValue([]);
  mocks.enroll.mockResolvedValue({ id: "own-pending", secret: "PRIVATE-SETUP-SECRET", qr: "data:image/svg+xml;utf-8,%3Csvg%3E%3C/svg%3E" });
  mocks.verify.mockResolvedValue(undefined); mocks.remove.mockResolvedValue(undefined);
  mocks.refresh.mockResolvedValue({ ...status, required: true, allowed: true, current_aal: "aal2", verified_totp_count: 1 });
  mocks.subscribe.mockImplementation((callback) => { authChanged = callback; return { data: { subscription: { unsubscribe: vi.fn() } } }; });
});
async function startSetup() {
  fireEvent.click(await screen.findByRole("button", { name: "Set up authenticator" }));
  fireEvent.change(screen.getByLabelText("Device name"), { target: { value: "My phone" } });
  fireEvent.submit(screen.getByRole("form", { name: "Set up authenticator" }));
  await screen.findByLabelText("Six-digit code");
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

describe("own authenticator UI", () => {
  it("enrolls, verifies and refreshes without storing private setup material", async () => {
    const storage = vi.spyOn(Storage.prototype, "setItem"), verified = vi.fn();
    render(<AccountAuthenticator userId="owner" onVerified={verified} />); await startSetup();
    expect(screen.getByRole("img", { name: /private setup code/ })).toBeInTheDocument();
    expect(screen.getByText("PRIVATE-SETUP-SECRET")).toBeInTheDocument(); expect(storage).not.toHaveBeenCalled();
    mocks.list.mockResolvedValue([factor]);
    fireEvent.change(screen.getByLabelText("Six-digit code"), { target: { value: "123456" } });
    fireEvent.submit(screen.getByRole("form", { name: "Verify authenticator" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Authenticator verified");
    expect(mocks.verify).toHaveBeenCalledWith(expect.anything(), "own-pending", "123456");
    expect(mocks.refresh).toHaveBeenCalledWith(expect.anything(), "owner", expect.any(AbortSignal));
    expect(screen.queryByText("PRIVATE-SETUP-SECRET")).not.toBeInTheDocument(); expect(verified).toHaveBeenCalledOnce(); storage.mockRestore();
  });
  it("cancels only this flow's unverified factor", async () => {
    render(<AccountAuthenticator userId="owner" />); await startSetup();
    fireEvent.click(screen.getByRole("button", { name: "Cancel setup" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(expect.anything(), "own-pending"));
    expect(screen.queryByText("PRIVATE-SETUP-SECRET")).not.toBeInTheDocument(); expect(mocks.enroll).toHaveBeenCalledOnce();
  });
  it("preserves a factor whose verification committed before a lost response instead of cancelling the verified credential", async () => {
    const verified = vi.fn();
    render(<AccountAuthenticator userId="owner" onVerified={verified} />); await startSetup();
    mocks.verify.mockRejectedValueOnce(new StaffMfaError("Verification could not be confirmed."));
    fireEvent.change(screen.getByLabelText("Six-digit code"), { target: { value: "123456" } });
    fireEvent.submit(screen.getByRole("form", { name: "Verify authenticator" }));
    await screen.findByRole("alert");
    mocks.list.mockResolvedValue([{ ...factor, id: "own-pending" }]);
    mocks.refresh.mockResolvedValue({ ...status, required: true, allowed: true, current_aal: "aal2", verified_totp_count: 1, policy_required: true });
    fireEvent.click(screen.getByRole("button", { name: "Cancel setup" }));
    expect(await screen.findByRole("status")).toHaveTextContent("verified device has been kept");
    expect(mocks.remove).not.toHaveBeenCalled(); expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(screen.queryByText("PRIVATE-SETUP-SECRET")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove My phone" })).toBeDisabled(); expect(verified).toHaveBeenCalledOnce();
  });
  it("never enrolls automatically on render or after wrong-code feedback", async () => {
    mocks.status.mockResolvedValue({ ...status, required: true, allowed: false, action: "enroll", policy_required: true });
    render(<AccountAuthenticator userId="owner" />);
    await screen.findByRole("button", { name: "Generate setup code" }); expect(mocks.enroll).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Device name"), { target: { value: "Phone" } }); fireEvent.submit(screen.getByRole("form", { name: "Set up authenticator" }));
    await screen.findByLabelText("Six-digit code"); mocks.verify.mockRejectedValueOnce(new StaffMfaError("That code was not accepted.", "verification"));
    fireEvent.change(screen.getByLabelText("Six-digit code"), { target: { value: "123456" } }); fireEvent.submit(screen.getByRole("form", { name: "Verify authenticator" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not accepted"); expect(mocks.enroll).toHaveBeenCalledOnce(); expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("offers a challenge rather than enrollment for existing verified factors", async () => {
    mocks.status.mockResolvedValue({ ...status, required: true, allowed: false, action: "challenge", verified_totp_count: 1 }); mocks.list.mockResolvedValue([factor]);
    render(<AccountAuthenticator userId="owner" challengeOnly />);
    await screen.findByLabelText("Six-digit code"); expect(screen.queryByLabelText("Device name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
  });
  it("unlocks after an incorrect code, then holds Verify busy through authorized navigation without flashing success", async () => {
    const challenge: StaffMfaStatus = { ...status, required: true, allowed: false, action: "challenge", verified_totp_count: 1 };
    const authorized: StaffMfaStatus = { ...challenge, allowed: true, action: "none", current_aal: "aal2" };
    const refresh = deferred<StaffMfaStatus>();
    const navigate = vi.fn().mockReturnValue(true);
    mocks.status.mockResolvedValue(challenge); mocks.list.mockResolvedValue([factor]);
    mocks.verify.mockRejectedValueOnce(new StaffMfaError("Incorrect code. Try the latest six-digit code.", "verification"));
    mocks.refresh.mockReturnValueOnce(refresh.promise);
    render(<AccountAuthenticator userId="owner" challengeOnly onVerified={navigate} />);
    const input = await screen.findByLabelText("Six-digit code");
    const form = screen.getByRole("form", { name: "Verify authenticator" });

    fireEvent.change(input, { target: { value: "123456" } }); fireEvent.submit(form);
    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect code. Try the latest six-digit code.");
    expect(screen.getByRole("button", { name: "Verify authenticator" })).toBeEnabled();
    expect(navigate).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "654321" } }); fireEvent.submit(form);
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Verifying…" })).toBeDisabled();
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => refresh.resolve(authorized));

    expect(navigate).toHaveBeenCalledExactlyOnceWith(authorized);
    expect(screen.getByRole("button", { name: "Verifying…" })).toBeDisabled();
    expect(form).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText(/Authenticator verified/)).not.toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledOnce();
    fireEvent.submit(form);
    expect(mocks.verify).toHaveBeenCalledTimes(2);
  });
  it("keeps the last school-required factor and allows a backup first", async () => {
    mocks.status.mockResolvedValue({ ...status, required: true, current_aal: "aal2", verified_totp_count: 1, policy_required: true }); mocks.list.mockResolvedValue([factor]);
    render(<AccountAuthenticator userId="owner" />);
    expect(await screen.findByRole("button", { name: "Remove My phone" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add backup authenticator" })).toBeEnabled(); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("aborts and discards setup after an account switch without consuming a late enrollment", async () => {
    const pending = deferred<{ id: string; secret: string; qr: string }>(); mocks.enroll.mockReturnValueOnce(pending.promise);
    render(<AccountAuthenticator userId="owner" />);
    fireEvent.click(await screen.findByRole("button", { name: "Set up authenticator" }));
    fireEvent.change(screen.getByLabelText("Device name"), { target: { value: "Phone" } }); fireEvent.submit(screen.getByRole("form", { name: "Set up authenticator" }));
    await waitFor(() => expect(mocks.enroll).toHaveBeenCalledOnce());
    act(() => authChanged("SIGNED_IN", { user: { id: "account-b" } }));
    await act(async () => pending.resolve({ id: "late-a-factor", secret: "LATE-PRIVATE-SECRET", qr: "" }));
    expect(screen.getByRole("alert")).toHaveTextContent("account changed"); expect(screen.queryByText("LATE-PRIVATE-SECRET")).not.toBeInTheDocument();
    expect(mocks.bound.mock.calls.at(-1)?.[2].aborted).toBe(true); expect(mocks.verify).not.toHaveBeenCalled();
  });
});
