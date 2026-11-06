import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSettings } from "../components/account/account-settings";
import { PasswordChangeError } from "../lib/account/password";

const { authUser, profile, subscribe, change, signOut, eq } = vi.hoisted(() => ({
  authUser: vi.fn(), profile: vi.fn(), subscribe: vi.fn(), change: vi.fn(), signOut: vi.fn(), eq: vi.fn(),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { getUser: authUser, onAuthStateChange: subscribe, signOut },
  from: () => ({ select: () => ({ eq: (...args: unknown[]) => { eq(...args); return { maybeSingle: profile }; } }) }) }) }));
vi.mock("@/lib/account/password", async (original) => ({ ...await original<typeof import("../lib/account/password")>(), changeOwnPassword: change }));
const owner = { id: "owner", email: "owner@example.test", email_confirmed_at: "2026-11-06T00:00:00Z", identities: [{ provider: "email" }], user_metadata: { role: "super_admin" } };
const newPassword = "New secure password12";
function fill() {
  fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "Original password1" } });
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: newPassword } });
  fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: newPassword } });
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  vi.clearAllMocks();
  authUser.mockResolvedValue({ data: { user: owner }, error: null });
  profile.mockResolvedValue({ data: { full_name: "QA Student", is_active: true }, error: null });
  subscribe.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  change.mockResolvedValue({ changed: true, temporarySessionClosed: true });
  signOut.mockResolvedValue({ error: null });
});

describe("own account settings", () => {
  it("shows only verified own fields and the server-provided role, with no editable identity controls", async () => {
    render(<AccountSettings userId="owner" role="student" hasGuardianRole={false} />);
    expect(await screen.findByText("QA Student")).toBeInTheDocument();
    expect(screen.getByText(owner.email)).toBeInTheDocument();
    expect(screen.getByText("Student")).toBeInTheDocument();
    expect(screen.queryByText("Super Admin")).not.toBeInTheDocument();
    expect(eq).toHaveBeenCalledWith("id", "owner");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Verified guardian contact settings" })).not.toBeInTheDocument();
  });

  it("offers the existing verified contact path only to linked Guardian roles", async () => {
    render(<AccountSettings userId="owner" role="teacher" hasGuardianRole />);
    expect(await screen.findByRole("link", { name: "Verified guardian contact settings" })).toHaveAttribute("href", "/modules/profile?view=guardian");
  });

  it("keeps wrong-current-password feedback actionable without calling primary signout", async () => {
    change.mockRejectedValueOnce(new PasswordChangeError("Current password could not be verified. Check it and try again.", "verification_failed"));
    render(<AccountSettings userId="owner" role="student" hasGuardianRole={false} />);
    await screen.findByText(owner.email); fill();
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Current password could not be verified");
    expect(screen.getByLabelText("Current password")).toHaveValue("");
    expect(screen.getByLabelText("New password")).toHaveValue(newPassword);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("validates mismatch before Auth and prevents parallel submit clicks", async () => {
    const pending = deferred<{ changed: true; temporarySessionClosed: boolean }>(); change.mockReturnValueOnce(pending.promise);
    render(<AccountSettings userId="owner" role="student" hasGuardianRole={false} />);
    await screen.findByText(owner.email); fill();
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "Mismatch password12" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("do not match"); expect(change).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: newPassword } });
    fireEvent.submit(screen.getByRole("form", { name: "Change your password" }));
    fireEvent.submit(screen.getByRole("form", { name: "Change your password" }));
    expect(change).toHaveBeenCalledTimes(1); expect(screen.getByLabelText("Current password")).toBeDisabled();
    await act(async () => { pending.resolve({ changed: true, temporarySessionClosed: true }); });
    expect(await screen.findByRole("heading", { name: "Password changed" })).toBeInTheDocument();
  });

  it("acknowledges a confirmed change and clears password fields without signing out the shared browser session", async () => {
    render(<AccountSettings userId="owner" role="student" hasGuardianRole={false} />);
    await screen.findByText(owner.email); fill(); fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("heading", { name: "Password changed" })).toBeInTheDocument();
    expect(signOut).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Use your new password next time you sign in");
    expect(screen.getByRole("link", { name: "Return to dashboard" })).toHaveAttribute("href", "/dashboard");
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not report a confirmed password change as failed when temporary cleanup fails", async () => {
    change.mockResolvedValueOnce({ changed: true, temporarySessionClosed: false });
    render(<AccountSettings userId="owner" role="student" hasGuardianRole={false} />);
    await screen.findByText(owner.email); fill(); fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    await screen.findByRole("heading", { name: "Password changed" });
    expect(await screen.findByText(/temporary session cleanup could not be confirmed/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("waits for isolated temporary cleanup without inventing a failure, then reports an actual cleanup failure honestly", async () => {
    const cleanup = deferred<{ changed: true; temporarySessionClosed: boolean }>();
    change.mockReturnValueOnce(cleanup.promise);
    render(<AccountSettings userId="owner" role="student" hasGuardianRole={false} />);
    await screen.findByText(owner.email); fill();
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(screen.getByRole("button", { name: "Changing password…" })).toBeDisabled();
    expect(screen.queryByText(/temporary session cleanup could not be confirmed/)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Password changed" })).not.toBeInTheDocument();
    expect(signOut).not.toHaveBeenCalled();
    await act(async () => { cleanup.resolve({ changed: true, temporarySessionClosed: false }); });
    expect(screen.getByRole("heading", { name: "Password changed" })).toBeInTheDocument();
    expect(screen.getByText(/temporary session cleanup could not be confirmed/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Return to dashboard" })).toHaveAttribute("href", "/dashboard");
    expect(signOut).not.toHaveBeenCalled();
  });

  it("aborts a pending password request on account change, clears inputs and ignores its completion", async () => {
    const pending = deferred<{ changed: true; temporarySessionClosed: boolean }>(); change.mockReturnValueOnce(pending.promise);
    render(<AccountSettings userId="owner" role="student" hasGuardianRole={false} />);
    await screen.findByText(owner.email); fill(); fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    const signal = change.mock.calls[0][3] as AbortSignal;
    act(() => subscribe.mock.calls[0][0]("SIGNED_IN", { user: { id: "new-owner" } }));
    expect(signal.aborted).toBe(true);
    expect(screen.getByRole("alert")).toHaveTextContent("account changed or signed out");
    await act(async () => { pending.resolve({ changed: true, temporarySessionClosed: true }); });
    expect(signOut).not.toHaveBeenCalled(); expect(screen.queryByText("Password changed")).not.toBeInTheDocument();
  });

  it("retains account B when it signs in after A's password update while isolated cleanup is pending", async () => {
    const updated = deferred<void>();
    const cleanup = deferred<{ changed: true; temporarySessionClosed: boolean }>();
    let activeUser: string | null = "owner";
    signOut.mockImplementation(async () => { activeUser = null; return { error: null }; });
    change.mockImplementationOnce(async () => { await updated.promise; return cleanup.promise; });
    render(<AccountSettings userId="owner" role="student" hasGuardianRole={false} />);
    await screen.findByText(owner.email); fill();
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    await act(async () => { updated.resolve(); });
    act(() => { activeUser = "new-owner"; subscribe.mock.calls[0][0]("SIGNED_IN", { user: { id: "new-owner" } }); });
    await act(async () => { cleanup.resolve({ changed: true, temporarySessionClosed: true }); });
    expect(screen.getByRole("alert")).toHaveTextContent("account changed or signed out");
    expect(activeUser).toBe("new-owner");
    expect(signOut).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Password changed" })).not.toBeInTheDocument();
    expect(screen.queryByText(owner.email)).not.toBeInTheDocument();
    expect(screen.queryByText("QA Student")).not.toBeInTheDocument();
  });

  it("hides account A's completed password confirmation when account B becomes active", async () => {
    render(<AccountSettings userId="owner" role="student" hasGuardianRole={false} />);
    await screen.findByText(owner.email); fill(); fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    await screen.findByRole("heading", { name: "Password changed" });
    act(() => subscribe.mock.calls[0][0]("SIGNED_IN", { user: { id: "account-b" } }));
    expect(screen.getByRole("alert")).toHaveTextContent("account changed or signed out");
    expect(screen.queryByRole("heading", { name: "Password changed" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Return to dashboard" })).not.toBeInTheDocument();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("gives Google-only accounts a recovery path without pretending a local password exists", async () => {
    authUser.mockResolvedValue({ data: { user: { ...owner, identities: [{ provider: "google" }] } }, error: null });
    render(<AccountSettings userId="owner" role="student" hasGuardianRole={false} />);
    expect(await screen.findByText(/If you have not set a school password/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Forgot your password?" })).toHaveAttribute("href", "/forgot-password");
  });

  it("fails closed for inactive profile reads and never shows a password form", async () => {
    profile.mockResolvedValueOnce({ data: { full_name: "Disabled account", is_active: false }, error: null });
    render(<AccountSettings userId="owner" role="student" hasGuardianRole={false} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be verified");
    expect(screen.queryByText("Disabled account")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
  });

  it("aborts a pending change when unmounted", async () => {
    const pending = deferred<{ changed: true; temporarySessionClosed: boolean }>(); change.mockReturnValueOnce(pending.promise);
    const view = render(<AccountSettings userId="owner" role="student" hasGuardianRole={false} />);
    await screen.findByText(owner.email); fill(); fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    const signal = change.mock.calls[0][3] as AbortSignal; view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { pending.resolve({ changed: true, temporarySessionClosed: true }); });
    expect(signOut).not.toHaveBeenCalled();
  });
});
