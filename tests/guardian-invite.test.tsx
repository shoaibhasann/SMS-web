import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GuardianInvitePage from "../app/(auth)/guardian-invite/page";
import TeacherInvitePage from "../app/(auth)/teacher-invite/page";

const { getUser, signInWithPassword, signUp, signOut, rpc, replace } = vi.hoisted(() => ({
  getUser: vi.fn(),
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
  signOut: vi.fn(),
  rpc: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { getUser, signInWithPassword, signUp, signOut }, rpc }),
}));

const token = "1a".repeat(32);
const guardian = { id: "guardian", email: "guardian@example.test" };
const session = { access_token: "session-token" };
const student = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  window.history.replaceState(null, "", `/guardian-invite#token=${token}`);
  getUser.mockResolvedValue({ data: { user: null }, error: null });
  signOut.mockResolvedValue({ error: null });
  rpc.mockResolvedValue({ data: { student_id: student, school_id: "school" }, error: null });
});

async function fillCredentials() {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Email address"), guardian.email);
  await user.type(screen.getByLabelText("Password"), "test-password");
  return user;
}

it("opens the teaching dashboard only after the invited teacher explicitly accepts", async () => {
  window.history.replaceState(null, "", `/teacher-invite#token=${token}`);
  const teacher = { id: "teacher", email: "teacher@example.test" };
  getUser.mockResolvedValue({ data: { user: teacher }, error: null });
  rpc.mockResolvedValue({ data: { teacher_id: "teacher-record", school_id: "school" }, error: null });
  render(<TeacherInvitePage />);

  expect(screen.getByRole("heading", { name: "Teacher invitation" })).toBeInTheDocument();
  const accept = await screen.findByRole("button", { name: "Accept invitation" });
  expect(rpc).not.toHaveBeenCalled();
  await userEvent.click(accept);
  expect(rpc).toHaveBeenCalledExactlyOnceWith("accept_teacher_invitation", { p_token: token });
  expect(replace).toHaveBeenCalledExactlyOnceWith("/dashboard");
  expect(sessionStorage.getItem("erp:parent-child:teacher")).toBeNull();
});

describe("guardian invitation", () => {
  it.each(["", "#token=bad", `#token=${token}&token=duplicate`])(
    "requires an original valid invite fragment before loading auth for %j", (hash) => {
      window.history.replaceState(null, "", `/guardian-invite${hash}`);
      render(<GuardianInvitePage />);
      expect(screen.getByText(/Open the original invitation/)).toBeInTheDocument();
      expect(getUser).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it("signs in, waits for explicit acceptance, and opens the invited child history", async () => {
    signInWithPassword.mockResolvedValue({ data: { user: guardian, session }, error: null });
    render(<GuardianInvitePage />);
    const user = await fillCredentials();
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    const accept = await screen.findByRole("button", { name: "Accept invitation" });
    expect(signInWithPassword).toHaveBeenCalledWith({ email: guardian.email, password: "test-password" });
    expect(rpc).not.toHaveBeenCalled();

    getUser.mockResolvedValue({ data: { user: guardian }, error: null });
    await user.click(accept);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("accept_guardian_invitation", { p_token: token });
    expect(sessionStorage.getItem("erp:parent-child:guardian")).toBe(student);
    expect(replace).toHaveBeenCalledExactlyOnceWith("/modules/attendance?view=guardian");
    expect(screen.getByRole("link", { name: "Open attendance" })).toBeInTheDocument();
  });

  it("preserves the invited-child choice when session storage is unavailable", async () => {
    getUser.mockResolvedValue({ data: { user: guardian }, error: null });
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("disabled"); });
    try {
      render(<GuardianInvitePage />);
      await userEvent.click(await screen.findByRole("button", { name: "Accept invitation" }));
      expect(replace).toHaveBeenCalledWith(`/modules/attendance?view=guardian&child=${student}`);
    } finally {
      storage.mockRestore();
    }
  });

  it("creates a new account with a confirmation callback that excludes the invitation token", async () => {
    signUp.mockResolvedValue({ data: { user: guardian, session: null }, error: null });
    render(<GuardianInvitePage />);
    await userEvent.click(await screen.findByRole("button", { name: "Create a guardian account" }));
    const user = await fillCredentials();
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByRole("status")).toHaveTextContent("reopen the original school invitation");
    expect(signUp).toHaveBeenCalledExactlyOnceWith({
      email: guardian.email,
      password: "test-password",
      options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=%2Fguardian-invite` },
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("does not proceed when sign-up skips email confirmation", async () => {
    signUp.mockResolvedValue({ data: { user: guardian, session }, error: null });
    render(<GuardianInvitePage />);
    await userEvent.click(await screen.findByRole("button", { name: "Create a guardian account" }));
    const user = await fillCredentials();
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Email confirmation is required");
    expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("requires review again if the session changed before acceptance", async () => {
    getUser.mockResolvedValue({ data: { user: guardian }, error: null });
    render(<GuardianInvitePage />);
    const accept = await screen.findByRole("button", { name: "Accept invitation" });
    const different = { id: "different", email: "different@example.test" };
    getUser.mockResolvedValue({ data: { user: different }, error: null });
    await userEvent.click(accept);

    expect(await screen.findByRole("alert")).toHaveTextContent("Your sign-in changed");
    expect(screen.getByText(different.email)).toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["42501", /confirmed email your school invited/],
    ["P0001", /expired, revoked, already used/],
    ["unexpected", /Could not complete the invitation/],
  ])("keeps a failed acceptance on the page without exposing database diagnostics (%s)", async (code, message) => {
    getUser.mockResolvedValue({ data: { user: guardian }, error: null });
    rpc.mockResolvedValue({ data: null, error: { code, message: "private diagnostic" } });
    render(<GuardianInvitePage />);
    await userEvent.click(await screen.findByRole("button", { name: "Accept invitation" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText("private diagnostic")).not.toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("erp:parent-child:guardian")).toBeNull();
  });

  it("allows signing out of the wrong account without losing the invite", async () => {
    getUser.mockResolvedValue({ data: { user: guardian }, error: null });
    render(<GuardianInvitePage />);
    await userEvent.click(await screen.findByRole("button", { name: "Use a different account" }));

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
    expect(window.location.hash).toBe(`#token=${token}`);
  });

  it("blocks a second submit while acceptance is pending", async () => {
    getUser.mockResolvedValue({ data: { user: guardian }, error: null });
    rpc.mockReturnValue(new Promise(() => {}));
    render(<GuardianInvitePage />);
    const user = userEvent.setup();
    const accept = await screen.findByRole("button", { name: "Accept invitation" });
    await user.dblClick(accept);
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect(accept).toBeDisabled();
  });
});
