import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MfaPage from "@/app/(auth)/mfa/page";
import type { StaffMfaStatus } from "@/lib/auth/staff-mfa";

const mocks = vi.hoisted(() => ({ status: vi.fn(), replace: vi.fn(), refresh: vi.fn(), authenticator: vi.fn() }));
const router = { replace: mocks.replace, refresh: mocks.refresh };
let params: URLSearchParams;
vi.mock("next/navigation", () => ({ useRouter: () => router, useSearchParams: () => params }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/auth/staff-mfa", async (original) => ({ ...await original<typeof import("@/lib/auth/staff-mfa")>(), readStaffMfaStatus: mocks.status }));
vi.mock("@/components/account/account-authenticator", () => ({ AccountAuthenticator: (props: { challengeOnly: boolean; onVerified: (status: StaffMfaStatus) => boolean }) => {
  mocks.authenticator(props);
  return <section aria-label="Own authenticator">{props.challengeOnly ? "Challenge" : "Setup or add backup"}</section>;
} }));
beforeEach(() => {
  vi.clearAllMocks(); params = new URLSearchParams("setup=1&next=/teacher-invite");
  mocks.status.mockResolvedValue({ user_id: "owner", allowed: true, action: "none", current_aal: "aal2", verified_totp_count: 1 });
  window.history.replaceState(null, "", `/mfa?${params}#token=${"a".repeat(64)}`);
});
describe("standalone MFA continuation", () => {
  const overviewStatus: StaffMfaStatus = {
    user_id: "owner", profile_school_id: "school", roles: [{ role: "school_admin", school_id: "school" }],
    required: true, allowed: false, action: "challenge", current_aal: "aal1", verified_totp_count: 1,
    staff: true, policy_required: true, dashboard_allowed: true,
  };

  it("returns a dashboard-eligible login from the old OTP continuation without showing a challenge", async () => {
    params = new URLSearchParams("next=%2Fdashboard");
    mocks.status.mockResolvedValue(overviewStatus);
    render(<MfaPage />);

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledExactlyOnceWith("/dashboard"));
    expect(mocks.authenticator).not.toHaveBeenCalled();
  });

  it.each([
    "next=%2Fdashboard&stepup=1",
    "next=%2Fmodules%2Fstudents",
  ])("still challenges the same account before full workspace access (%s)", async (query) => {
    params = new URLSearchParams(query);
    mocks.status.mockResolvedValue(overviewStatus);
    render(<MfaPage />);

    expect(await screen.findByRole("region", { name: "Own authenticator" })).toHaveTextContent("Challenge");
    expect(mocks.replace).not.toHaveBeenCalled();
  });
  it("lets an already verified account continue with its invitation fragment while retaining optional backup setup", async () => {
    render(<MfaPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue to workspace" }));
    expect(mocks.replace).toHaveBeenCalledWith(`/teacher-invite#token=${"a".repeat(64)}`);
    expect(screen.getByRole("region", { name: "Own authenticator" })).toHaveTextContent("Setup or add backup");
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });
  it("returns a verified guardian to the mobile invitation with its token fragment", async () => {
    params = new URLSearchParams("next=/guardian-mobile-invite");
    render(<MfaPage />);
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledExactlyOnceWith(`/guardian-mobile-invite#token=${"a".repeat(64)}`));
  });
  it("does not offer a continue shortcut while a code is still required", async () => {
    mocks.status.mockResolvedValue({ user_id: "owner", allowed: false, action: "challenge", current_aal: "aal1", verified_totp_count: 1 });
    render(<MfaPage />);
    await screen.findByRole("region", { name: "Own authenticator" });
    expect(screen.getByRole("link", { name: "Back to sign-in options" })).toHaveAttribute("href", "/login");
    expect(screen.queryByRole("button", { name: "Continue to workspace" })).not.toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();
  });
  it("gives a guardian without an authenticator a way back to the invitation from setup", async () => {
    params = new URLSearchParams("next=/guardian-invite&setup=1");
    mocks.status.mockResolvedValue({ user_id: "owner", allowed: false, action: "enroll", current_aal: "aal1", verified_totp_count: 0 });
    render(<MfaPage />);
    await screen.findByRole("region", { name: "Own authenticator" });
    expect(screen.getByRole("link", { name: "Back to invitation" })).toHaveAttribute("href", `/guardian-invite#token=${"a".repeat(64)}`);
  });
  it.each([
    ["next=/dashboard&setup=1", `#token=${"a".repeat(64)}`, null],
    ["next=https%3A%2F%2Funtrusted.example%2Fguardian-invite&setup=1", `#token=${"a".repeat(64)}`, null],
    ["next=/guardian-recover&setup=1", "#token=not-a-token", "/guardian-recover"],
  ])("only links back to an allowlisted invitation and drops an invalid fragment (%s %s)", async (query, hash, href) => {
    params = new URLSearchParams(query);
    window.history.replaceState(null, "", `/mfa?${params}${hash}`);
    mocks.status.mockResolvedValue({ user_id: "owner", allowed: false, action: "enroll", current_aal: "aal1", verified_totp_count: 0 });
    render(<MfaPage />);
    await screen.findByRole("region", { name: "Own authenticator" });
    const link = screen.queryByRole("link", { name: "Back to invitation" });
    if (href) expect(link).toHaveAttribute("href", href); else expect(link).not.toBeInTheDocument();
  });
  const signIn = { user_id: "owner", allowed: false, action: "sign_in", current_aal: "aal1", verified_totp_count: 0 };
  it.each([
    // An invitation needs its #token, which never travels through /login, so sign-in starts clean.
    [null, "setup=1&next=/teacher-invite", "/login"],
    [signIn, "setup=1&next=/teacher-invite", "/login"],
    [signIn, "next=%2Fmodules%2Freports", "/login?next=%2Fmodules%2Freports"],
    [signIn, "next=%2Fdashboard", "/login"],
    [null, "next=https%3A%2F%2Funtrusted.example%2F", "/login"],
  ])("returns to login with only the allowlisted continuation, without mounting an authenticator, when fresh sign-in is required (%j %s)", async (status, query, login) => {
    params = new URLSearchParams(query);
    mocks.status.mockResolvedValue(status);
    render(<MfaPage />);

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledExactlyOnceWith(login));
    expect(mocks.authenticator).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Continue to workspace" })).not.toBeInTheDocument();
  });
  it.each([
    ["", "/dashboard"],
    ["/modules/attendance?view=guardian", "/modules/attendance?view=guardian"],
    ["https://untrusted.example/", "/dashboard"],
  ])("navigates straight to the authorized continuation for %j after verification", async (next, destination) => {
    params = new URLSearchParams(next ? { next } : {});
    const challenge: StaffMfaStatus = { user_id: "owner", profile_school_id: "school", roles: [{ role: "teacher", school_id: "school" }],
      required: true, allowed: false, action: "challenge", current_aal: "aal1", verified_totp_count: 1, staff: true, policy_required: true };
    mocks.status.mockResolvedValue(challenge);
    render(<MfaPage />);
    expect(await screen.findByRole("region", { name: "Own authenticator" })).toHaveTextContent("Challenge");
    expect(mocks.replace).not.toHaveBeenCalled();

    const { onVerified } = mocks.authenticator.mock.lastCall![0];
    expect(onVerified({ ...challenge, allowed: true, action: "none", current_aal: "aal2" })).toBe(true);
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith(destination);
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });
});
