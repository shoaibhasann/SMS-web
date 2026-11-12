import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GuardianRecoveryPage from "../app/(auth)/guardian-recover/page";
import { GuardianRecoveryError } from "@/lib/guardian-invitations/recovery";

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), signIn: vi.fn(), signUp: vi.fn(), signOut: vi.fn(), subscribe: vi.fn(), rpc: vi.fn(), replace: vi.fn(), refresh: vi.fn(), claim: vi.fn(), accept: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }) }));
const client = { auth: { getUser: mocks.getUser, signInWithPassword: mocks.signIn, signUp: mocks.signUp, signOut: mocks.signOut, onAuthStateChange: mocks.subscribe }, rpc: mocks.rpc };
vi.mock("@/lib/supabase/client", () => ({ createClient: () => client }));
vi.mock("@/lib/guardian-invitations/recovery", async original => ({ ...await original<typeof import("@/lib/guardian-invitations/recovery")>(), loadGuardianRecoveryClaim: mocks.claim, acceptGuardianRecovery: mocks.accept }));
vi.mock("@/components/auth/phone-otp-form", () => ({ GuardianPhoneOtpForm: ({ purpose, onVerified }: { purpose: string; onVerified(value: { id: string; email: string }): void }) => <div><p>Phone flow: {purpose}</p><button onClick={() => onVerified({ id: "guardian", email: "new@example.test" })}>Verify QA phone</button></div> }));

const token = "ab".repeat(32), guardian = { id: "guardian", email: "new@example.test" }, date = "2026-11-08T00:00:00.000Z";
let authChanged: (event: string, session: { user: { id: string } } | null) => void;
beforeEach(() => {
  vi.resetAllMocks(); sessionStorage.clear(); localStorage.clear();
  window.history.replaceState(null, "", `/guardian-recover#token=${token}`);
  mocks.getUser.mockResolvedValue({ data: { user: guardian }, error: null });
  mocks.claim.mockResolvedValue({ school_name: "QA School", requires_mfa: true, linked_children: 2, expires_at: date });
  mocks.accept.mockResolvedValue({ schoolId: "school", parentId: "parent", linkedChildren: 2, replayed: false });
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.subscribe.mockImplementation(callback => { authChanged = callback; return { data: { subscription: { unsubscribe: vi.fn() } } }; });
});
function credentials() {
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: guardian.email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "qa-password-123" } });
}

describe("public guardian account recovery claim", () => {
  it.each(["", "#token=bad", `#token=${token}&token=${token}`])("does not access Auth or recovery for malformed fragment %j", hash => {
    window.history.replaceState(null, "", `/guardian-recover${hash}`); render(<GuardianRecoveryPage />);
    expect(screen.getByText(/Open the private recovery link your school shared with you/)).toBeInTheDocument();
    expect(screen.queryByText(/original invitation/)).not.toBeInTheDocument();
    expect(mocks.getUser).not.toHaveBeenCalled(); expect(mocks.claim).not.toHaveBeenCalled(); expect(mocks.accept).not.toHaveBeenCalled();
  });
  it("uses recovery wording while the server-rendered page waits for the link fragment", () => {
    const html = renderToString(<GuardianRecoveryPage />);
    expect(html).toContain("Opening recovery link…"); expect(html).not.toMatch(/invitation/i);
  });
  it("loads only a preview and preserves existing child state until explicit acceptance", async () => {
    sessionStorage.setItem("erp:parent-child:guardian", "existing-child-id"); render(<GuardianRecoveryPage />);
    expect(await screen.findByText(/QA School · 2 linked children/)).toHaveTextContent("verified authenticator is required");
    expect(mocks.claim).toHaveBeenCalledExactlyOnceWith(client, guardian.id, token, expect.any(AbortSignal));
    expect(screen.getByRole("button", { name: "Accept account recovery" })).toBeEnabled(); expect(mocks.accept).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("erp:parent-child:guardian")).toBe("existing-child-id"); expect(mocks.replace).not.toHaveBeenCalled();
  });
  it("puts a recovery continuation token only in the MFA URL fragment", async () => {
    render(<GuardianRecoveryPage />);
    const link = await screen.findByRole("link", { name: "Set up or verify account security" });
    const url = new URL(link.getAttribute("href")!, window.location.origin);
    expect(url.pathname).toBe("/mfa"); expect(url.searchParams.get("next")).toBe("/guardian-recover");
    expect(url.searchParams.get("setup")).toBe("1"); expect(url.search).not.toContain(token); expect(url.hash).toBe(`#token=${token}`);
    expect(sessionStorage.length).toBe(0); expect(localStorage.length).toBe(0);
  });
  it("keeps acceptance disabled when the preview cannot verify the recipient", async () => {
    mocks.claim.mockRejectedValue(new GuardianRecoveryError("Verify the correct recipient and authenticator.", "access")); render(<GuardianRecoveryPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("correct recipient");
    expect(screen.getByRole("button", { name: "Accept account recovery" })).toBeDisabled(); expect(mocks.accept).not.toHaveBeenCalled();
  });
  it("rechecks the owner, explicitly accepts once, then refreshes the preserved guardian workspace", async () => {
    render(<GuardianRecoveryPage />); await screen.findByText(/QA School · 2 linked children/);
    fireEvent.click(screen.getByRole("button", { name: "Accept account recovery" }));
    await waitFor(() => expect(mocks.accept).toHaveBeenCalledOnce());
    expect(mocks.accept).toHaveBeenCalledWith(client, guardian.id, token, expect.stringMatching(/^[a-f0-9-]{36}$/), expect.any(AbortSignal));
    expect(mocks.getUser).toHaveBeenCalledTimes(2); expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith("/modules/attendance?view=guardian"); expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(sessionStorage.length).toBe(0);
  });
  it("does not accept for a different account that became current before the click", async () => {
    render(<GuardianRecoveryPage />); await screen.findByText(/QA School · 2 linked children/);
    mocks.getUser.mockResolvedValue({ data: { user: { id: "other", email: "other@example.test" } }, error: null });
    fireEvent.click(screen.getByRole("button", { name: "Accept account recovery" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your sign-in changed"); expect(mocks.accept).not.toHaveBeenCalled(); expect(mocks.replace).not.toHaveBeenCalled();
  });
  it("reuses the exact claim request ID after an unknown result instead of creating a second acceptance", async () => {
    mocks.accept.mockRejectedValueOnce(new GuardianRecoveryError("The recovery result is unknown. Retry the exact request."));
    render(<GuardianRecoveryPage />); await screen.findByText(/QA School · 2 linked children/);
    fireEvent.click(screen.getByRole("button", { name: "Accept account recovery" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("result is unknown"); const first = mocks.accept.mock.calls[0];
    fireEvent.click(screen.getByRole("button", { name: "Accept account recovery" }));
    await waitFor(() => expect(mocks.accept).toHaveBeenCalledTimes(2)); expect(mocks.accept.mock.calls[1].slice(0, 4)).toEqual(first.slice(0, 4));
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith("/modules/attendance?view=guardian");
  });
  it("aborts pending acceptance on account switch and ignores its late success", async () => {
    let finish!: (value: unknown) => void; mocks.accept.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<GuardianRecoveryPage />); await screen.findByText(/QA School · 2 linked children/);
    fireEvent.click(screen.getByRole("button", { name: "Accept account recovery" })); await waitFor(() => expect(mocks.accept).toHaveBeenCalledOnce());
    const signal = mocks.accept.mock.calls[0][4] as AbortSignal;
    act(() => authChanged("SIGNED_IN", { user: { id: "other" } })); expect(signal.aborted).toBe(true);
    await act(async () => finish({ schoolId: "school", parentId: "parent", linkedChildren: 2, replayed: false }));
    expect(screen.getByRole("alert")).toHaveTextContent("Your sign-in changed"); expect(mocks.replace).not.toHaveBeenCalled(); expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("ignores INITIAL_SESSION notifications rather than cancelling a valid preview", async () => {
    render(<GuardianRecoveryPage />); await screen.findByText(/QA School · 2 linked children/);
    act(() => authChanged("INITIAL_SESSION", null));
    expect(screen.getByRole("button", { name: "Accept account recovery" })).toBeEnabled(); expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("requires explicit acceptance after password sign-in", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null }); mocks.signIn.mockResolvedValue({ data: { user: guardian, session: { access_token: "qa-session" } }, error: null });
    render(<GuardianRecoveryPage />); await screen.findByRole("button", { name: "Sign in" }); credentials();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText(/QA School · 2 linked children/); expect(mocks.accept).not.toHaveBeenCalled(); expect(mocks.replace).not.toHaveBeenCalled();
  });
  it("keeps phone verification separate from the final explicit school claim", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null }); render(<GuardianRecoveryPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Mobile OTP" }));
    expect(screen.getByText("Phone flow: recovery")).toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: "Verify QA phone" }));
    await screen.findByText(/QA School · 2 linked children/); expect(mocks.accept).not.toHaveBeenCalled(); expect(mocks.replace).not.toHaveBeenCalled();
  });
  it("marks the active replacement method and uses a singular child count", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null }); render(<GuardianRecoveryPage />);
    const phone = await screen.findByRole("button", { name: "Mobile OTP" });
    expect(screen.getByRole("button", { name: "Email and password" })).toHaveAttribute("aria-pressed", "true"); expect(phone).toHaveAttribute("aria-pressed", "false");
    mocks.claim.mockResolvedValue({ school_name: "QA School", requires_mfa: false, linked_children: 1, expires_at: date });
    fireEvent.click(phone); expect(phone).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Verify QA phone" }));
    expect(await screen.findByText("QA School · 1 linked child.")).toBeInTheDocument();
  });
  it("keeps signup email callback free of the recovery token and requires confirmation plus reopening the original link", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null }); mocks.signUp.mockResolvedValue({ data: { user: guardian, session: null }, error: null });
    render(<GuardianRecoveryPage />); fireEvent.click(await screen.findByRole("button", { name: "Create the replacement account" })); credentials();
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("reopen the private recovery link your school shared");
    expect(status).not.toHaveTextContent(/invitation/i);
    expect(mocks.signUp).toHaveBeenCalledExactlyOnceWith({ email: guardian.email, password: "qa-password-123", options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=%2Fguardian-recover` } });
    expect(mocks.claim).not.toHaveBeenCalled(); expect(mocks.accept).not.toHaveBeenCalled(); expect(mocks.replace).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0); expect(localStorage.length).toBe(0);
  });
});
