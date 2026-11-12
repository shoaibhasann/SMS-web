import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GuardianInvitePage from "../app/(auth)/guardian-invite/page";
import GuardianMobileInvitePage from "../app/(auth)/guardian-mobile-invite/page";
import { mfaPath, safeMfaNext, type StaffMfaStatus } from "@/lib/auth/staff-mfa";

const { getUser, signOut, rpc, replace, status } = vi.hoisted(() => ({
  getUser: vi.fn(), signOut: vi.fn(), rpc: vi.fn(), replace: vi.fn(), status: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { getUser, signOut }, rpc }) }));
vi.mock("@/lib/auth/staff-mfa", async (original) => ({ ...await original<typeof import("@/lib/auth/staff-mfa")>(), readStaffMfaStatus: status }));

const token = "b".repeat(64);
const emailGuardian = { id: "guardian", email: "guardian@example.test" };
const phoneGuardian = { id: "mobile-guardian", phone: "919876540001", phone_confirmed_at: "2026-11-06T12:00:00Z", is_anonymous: false };
const challenge: StaffMfaStatus = {
  user_id: "guardian", profile_school_id: null, roles: [{ role: "parent", school_id: "school" }], required: true, allowed: false,
  action: "challenge", current_aal: "aal1", verified_totp_count: 1, staff: false, policy_required: false,
};

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  signOut.mockResolvedValue({ error: null });
  rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "Complete authenticator verification before accessing school data" } });
});

describe("TOTP-enrolled guardian on the email invite page", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", `/guardian-invite#token=${token}`);
    getUser.mockResolvedValue({ data: { user: emailGuardian }, error: null });
  });

  it("sends an aal1 rejection to the authenticator step and keeps the token in the fragment", async () => {
    status.mockResolvedValue(challenge);
    render(<GuardianInvitePage />);
    await userEvent.click(await screen.findByRole("button", { name: "Accept invitation" }));
    expect(status).toHaveBeenCalledWith(expect.anything(), emailGuardian.id);
    expect(replace).toHaveBeenCalledExactlyOnceWith(`/mfa?next=%2Fguardian-invite#token=${token}`);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    ["an allowed status", () => status.mockResolvedValue({ ...challenge, allowed: true, action: "none", current_aal: "aal2" })],
    ["a failed status read", () => status.mockRejectedValue(new Error("offline"))],
  ])("keeps the wrong-account message for %s", async (_label, arrange) => {
    arrange();
    render(<GuardianInvitePage />);
    await userEvent.click(await screen.findByRole("button", { name: "Accept invitation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/confirmed email your school invited/);
    expect(replace).not.toHaveBeenCalled();
  });

  it("offers the account-security link before accepting", async () => {
    render(<GuardianInvitePage />);
    expect(await screen.findByRole("link", { name: "set up account security" }))
      .toHaveAttribute("href", `/mfa?next=%2Fguardian-invite&setup=1#token=${token}`);
  });
});

describe("TOTP-enrolled guardian on the mobile invite page", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", `/guardian-mobile-invite#token=${token}`);
    getUser.mockResolvedValue({ data: { user: phoneGuardian }, error: null });
  });

  it("sends an aal1 rejection to the authenticator step and returns to the mobile invite", async () => {
    status.mockResolvedValue({ ...challenge, user_id: phoneGuardian.id });
    render(<GuardianMobileInvitePage />);
    await userEvent.click(await screen.findByRole("button", { name: "Accept invitation" }));
    expect(status).toHaveBeenCalledWith(expect.anything(), phoneGuardian.id);
    expect(replace).toHaveBeenCalledExactlyOnceWith(`/mfa?next=%2Fguardian-mobile-invite#token=${token}`);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the wrong-account message when the status says access is allowed", async () => {
    status.mockResolvedValue({ ...challenge, user_id: phoneGuardian.id, allowed: true, action: "none", current_aal: "aal2" });
    render(<GuardianMobileInvitePage />);
    await userEvent.click(await screen.findByRole("button", { name: "Accept invitation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/verified mobile your school invited/);
    expect(replace).not.toHaveBeenCalled();
  });

  it("offers the account-security link next to acceptance", async () => {
    render(<GuardianMobileInvitePage />);
    expect(await screen.findByRole("link", { name: "verify account security" }))
      .toHaveAttribute("href", `/mfa?next=%2Fguardian-mobile-invite&setup=1#token=${token}`);
  });

  it("allows the mobile invite as an MFA continuation without leaking the bearer token", () => {
    expect(safeMfaNext("/guardian-mobile-invite")).toBe("/guardian-mobile-invite");
    expect(mfaPath(`/guardian-mobile-invite#token=${token}`)).toBe("/mfa?next=%2Fguardian-mobile-invite");
  });
});

describe("shared authenticator-step helper", () => {
  it("is the single decision both invite pages use, so tests can mock it", async () => {
    vi.resetModules();
    vi.doMock("@/lib/auth/authenticator-step", () => ({ needsAuthenticatorStep: vi.fn().mockResolvedValue(true) }));
    const { default: EmailInvite } = await import("../app/(auth)/guardian-invite/page");
    const { default: MobileInvite } = await import("../app/(auth)/guardian-mobile-invite/page");
    status.mockResolvedValue({ ...challenge, allowed: true, action: "none", current_aal: "aal2" });

    window.history.replaceState(null, "", `/guardian-invite#token=${token}`);
    getUser.mockResolvedValue({ data: { user: emailGuardian }, error: null });
    const { unmount } = render(<EmailInvite />);
    await userEvent.click(await screen.findByRole("button", { name: "Accept invitation" }));
    expect(replace).toHaveBeenLastCalledWith(`/mfa?next=%2Fguardian-invite#token=${token}`);
    unmount();

    window.history.replaceState(null, "", `/guardian-mobile-invite#token=${token}`);
    getUser.mockResolvedValue({ data: { user: phoneGuardian }, error: null });
    render(<MobileInvite />);
    await userEvent.click(await screen.findByRole("button", { name: "Accept invitation" }));
    expect(replace).toHaveBeenLastCalledWith(`/mfa?next=%2Fguardian-mobile-invite#token=${token}`);
    expect(status).not.toHaveBeenCalled();
    vi.doUnmock("@/lib/auth/authenticator-step");
  });
});

describe("needsAuthenticatorStep", () => {
  it.each([
    [{ ...challenge }, true],
    [{ ...challenge, action: "enroll", verified_totp_count: 0 }, true],
    [{ ...challenge, allowed: true, action: "none", current_aal: "aal2" }, false],
    [{ ...challenge, action: "sign_in" }, false],
    [null, false],
  ] as const)("decides from the database MFA status (%j)", async (value, expected) => {
    const { needsAuthenticatorStep } = await vi.importActual<typeof import("@/lib/auth/authenticator-step")>("@/lib/auth/authenticator-step");
    status.mockResolvedValue(value);
    await expect(needsAuthenticatorStep({} as never, "guardian")).resolves.toBe(expected);
  });
  it("treats a failed status read as no authenticator step", async () => {
    const { needsAuthenticatorStep } = await vi.importActual<typeof import("@/lib/auth/authenticator-step")>("@/lib/auth/authenticator-step");
    status.mockRejectedValue(new Error("offline"));
    await expect(needsAuthenticatorStep({} as never, "guardian")).resolves.toBe(false);
  });
});
