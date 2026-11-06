import type { User } from "@supabase/supabase-js";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GuardianMobileInvitePage from "../app/(auth)/guardian-mobile-invite/page";

const { getUser, signOut, rpc, replace } = vi.hoisted(() => ({
  getUser: vi.fn(), signOut: vi.fn(), rpc: vi.fn(), replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { getUser, signOut }, rpc }) }));
vi.mock("@/components/auth/phone-otp-form", () => ({
  GuardianPhoneOtpForm: ({ purpose, onVerified }: { purpose: string; onVerified: (account: User) => void }) =>
    <button type="button" onClick={() => onVerified(guardian)}>Verify invited mobile · {purpose}</button>,
}));

const token = "a".repeat(64);
const student = "00000000-0000-4000-8000-000000000001";
const guardian = {
  id: "mobile-guardian", phone: "919876540001", phone_confirmed_at: "2026-11-06T12:00:00Z", is_anonymous: false,
  aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-11-06T12:00:00Z",
} satisfies User;

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  window.history.replaceState(null, "", `/guardian-mobile-invite#token=${token}`);
  getUser.mockResolvedValue({ data: { user: null }, error: null });
  signOut.mockResolvedValue({ error: null });
  rpc.mockResolvedValue({ data: { student_id: student, school_id: "school" }, error: null });
});

describe("guardian mobile invitation", () => {
  it.each(["", "#token=bad", `#token=${token}&token=duplicate`])("rejects invalid fragments without Auth reads (%s)", (hash) => {
    window.history.replaceState(null, "", `/guardian-mobile-invite${hash}`);
    render(<GuardianMobileInvitePage />);
    expect(screen.getByText(/Open the original mobile invitation/)).toBeVisible();
    expect(getUser).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("waits for explicit acceptance after phone verification and remembers the invited child", async () => {
    render(<GuardianMobileInvitePage />);
    await userEvent.click(await screen.findByRole("button", { name: "Verify invited mobile · invitation" }));
    expect(await screen.findByRole("button", { name: "Accept invitation" })).toBeEnabled();
    expect(rpc).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    getUser.mockResolvedValue({ data: { user: guardian }, error: null });
    await userEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
    expect(rpc).toHaveBeenCalledExactlyOnceWith("accept_guardian_invitation", { p_token: token });
    expect(sessionStorage.getItem(`erp:parent-child:${guardian.id}`)).toBe(student);
    expect(replace).toHaveBeenCalledExactlyOnceWith("/modules/attendance?view=guardian");
    expect(screen.getByRole("link", { name: "Open attendance" })).toBeVisible();
  });

  it("keeps existing email guardians on their account rather than offering another signup", async () => {
    getUser.mockResolvedValue({ data: { user: { ...guardian, phone: undefined, phone_confirmed_at: undefined, email: "existing@example.test" } }, error: null });
    render(<GuardianMobileInvitePage />);
    expect(await screen.findByRole("link", { name: "Open guardian contact settings" })).toHaveAttribute("href", "/modules/profile?view=guardian");
    expect(screen.getByText(/keep your existing child links/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Accept invitation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Verify invited mobile/ })).not.toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("requires review again if the Auth identity changes before acceptance", async () => {
    getUser.mockResolvedValue({ data: { user: guardian }, error: null });
    render(<GuardianMobileInvitePage />);
    const accept = await screen.findByRole("button", { name: "Accept invitation" });
    getUser.mockResolvedValue({ data: { user: { ...guardian, id: "other-user", phone: "919876540002" } }, error: null });
    await userEvent.click(accept);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your sign-in changed");
    expect(screen.getByText("+919876540002")).toBeVisible();
    expect(rpc).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it.each(["42501", "P0001", "unexpected"])("keeps a rejected invitation unlinked (%s)", async (code) => {
    getUser.mockResolvedValue({ data: { user: guardian }, error: null });
    rpc.mockResolvedValue({ data: null, error: { code, message: "private diagnostic" } });
    render(<GuardianMobileInvitePage />);
    await userEvent.click(await screen.findByRole("button", { name: "Accept invitation" }));
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.queryByText("private diagnostic")).not.toBeInTheDocument();
    expect(sessionStorage.getItem(`erp:parent-child:${guardian.id}`)).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it("closes only the current session when switching accounts and preserves the invite", async () => {
    getUser.mockResolvedValue({ data: { user: guardian }, error: null });
    render(<GuardianMobileInvitePage />);
    await userEvent.click(await screen.findByRole("button", { name: "Use a different account" }));
    expect(await screen.findByRole("button", { name: /Verify invited mobile/ })).toBeVisible();
    expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
    expect(window.location.hash).toBe(`#token=${token}`);
  });

  it("prevents duplicate acceptance while the first request is in flight", async () => {
    getUser.mockResolvedValue({ data: { user: guardian }, error: null });
    let finish!: (result: { data: { student_id: string }; error: null }) => void;
    rpc.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<GuardianMobileInvitePage />);
    const accept = await screen.findByRole("button", { name: "Accept invitation" });
    await userEvent.dblClick(accept);
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect(accept).toBeDisabled();
    await act(async () => finish({ data: { student_id: student }, error: null }));
  });
});
