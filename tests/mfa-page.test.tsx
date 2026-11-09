import { fireEvent, render, screen } from "@testing-library/react";
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
  it("lets an already verified account continue with its invitation fragment while retaining optional backup setup", async () => {
    render(<MfaPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue to workspace" }));
    expect(mocks.replace).toHaveBeenCalledWith(`/teacher-invite#token=${"a".repeat(64)}`);
    expect(screen.getByRole("region", { name: "Own authenticator" })).toHaveTextContent("Setup or add backup");
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });
  it("does not offer a continue shortcut while a code is still required", async () => {
    mocks.status.mockResolvedValue({ user_id: "owner", allowed: false, action: "challenge", current_aal: "aal1", verified_totp_count: 1 });
    render(<MfaPage />);
    await screen.findByRole("region", { name: "Own authenticator" });
    expect(screen.queryByRole("button", { name: "Continue to workspace" })).not.toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();
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
