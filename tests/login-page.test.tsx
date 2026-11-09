import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import LoginPage from "@/app/(auth)/login/page";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import type { StaffMfaStatus } from "@/lib/auth/staff-mfa";

const { client, router, readStatus, unsubscribe } = vi.hoisted(() => ({
  client: { auth: {
    getSession: vi.fn(), onAuthStateChange: vi.fn(), signOut: vi.fn(),
    signInWithPassword: vi.fn(), signInWithOAuth: vi.fn(),
  } },
  router: { replace: vi.fn(), refresh: vi.fn() },
  readStatus: vi.fn(),
  unsubscribe: vi.fn(),
}));
const { auth } = client;
vi.mock("@/lib/supabase/client", () => ({ createClient: () => client }));
vi.mock("@/lib/auth/staff-mfa", async (original) => ({
  ...await original<typeof import("@/lib/auth/staff-mfa")>(), readStaffMfaStatus: readStatus,
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/ui/theme-toggle", () => ({ ThemeToggle: () => null }));

const owner = { id: "owner" };
const ownerSession = { user: owner } as Session;
const challenge: StaffMfaStatus = {
  user_id: owner.id, profile_school_id: "school", roles: [{ role: "teacher", school_id: "school" }],
  required: true, allowed: false, action: "challenge", current_aal: "aal1",
  verified_totp_count: 1, staff: true, policy_required: true,
};
let emitAuth: (event: AuthChangeEvent, session: Session | null) => void;

beforeEach(() => {
  auth.getSession.mockReset().mockResolvedValue({ data: { session: null }, error: null });
  auth.onAuthStateChange.mockReset().mockImplementation((callback: typeof emitAuth) => {
    emitAuth = callback;
    return { data: { subscription: { unsubscribe } } };
  });
  auth.signOut.mockReset().mockResolvedValue({ error: null });
  auth.signInWithPassword.mockReset().mockResolvedValue({ data: { session: ownerSession, user: owner }, error: null });
  auth.signInWithOAuth.mockReset().mockResolvedValue({ error: null });
  readStatus.mockReset().mockResolvedValue(challenge);
});

function enterCredentials() {
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "  office@school.example  " } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: " secret password " } });
}

function submitPassword() {
  fireEvent.submit(screen.getByLabelText("Password").closest("form")!);
}

it("signs in with a trimmed email and the original password, then opens the dashboard", async () => {
  render(<LoginPage />);
  enterCredentials();
  submitPassword();

  await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/dashboard"));
  expect(auth.signInWithPassword).toHaveBeenCalledExactlyOnceWith({
    email: "office@school.example", password: " secret password ",
  });
  expect(router.refresh).toHaveBeenCalledOnce();
  expect(auth.signOut).not.toHaveBeenCalled();
  expect(auth.signInWithOAuth).not.toHaveBeenCalled();
});

it("keeps anonymous sign-in options available without an MFA probe", async () => {
  render(<LoginPage />);
  await act(async () => { emitAuth("INITIAL_SESSION", null); });
  expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Continue with authenticator" })).not.toBeInTheDocument();
  expect(readStatus).not.toHaveBeenCalled();
  expect(router.replace).not.toHaveBeenCalled();
});

it("continues an existing MFA challenge only after the owner explicitly clicks and is revalidated", async () => {
  render(<LoginPage />);
  act(() => { emitAuth("INITIAL_SESSION", ownerSession); });
  const resume = await screen.findByRole("button", { name: "Continue with authenticator" });
  expect(readStatus).toHaveBeenCalledWith(client, owner.id, expect.any(AbortSignal));
  expect(router.replace).not.toHaveBeenCalled();

  fireEvent.click(resume);
  await waitFor(() => expect(router.replace).toHaveBeenCalledExactlyOnceWith("/mfa?next=%2Fdashboard"));
  expect(readStatus).toHaveBeenCalledTimes(2);
  expect(readStatus.mock.lastCall?.slice(0, 2)).toEqual([client, owner.id]);
  expect(auth.signInWithPassword).not.toHaveBeenCalled();
  expect(auth.signOut).not.toHaveBeenCalled();
});

it("does not offer an obsolete challenge when its owner signs out before the status probe finishes", async () => {
  let finishProbe!: (status: StaffMfaStatus) => void;
  readStatus.mockReturnValueOnce(new Promise<StaffMfaStatus>((resolve) => { finishProbe = resolve; }));
  render(<LoginPage />);
  act(() => { emitAuth("INITIAL_SESSION", ownerSession); });
  await waitFor(() => expect(readStatus).toHaveBeenCalledOnce());
  await act(async () => { emitAuth("SIGNED_OUT", null); finishProbe(challenge); });
  expect(screen.queryByRole("button", { name: "Continue with authenticator" })).not.toBeInTheDocument();
  expect(router.replace).not.toHaveBeenCalled();
});

it("does not navigate if the account signs out while resume is checking", async () => {
  render(<LoginPage />);
  act(() => { emitAuth("INITIAL_SESSION", ownerSession); });
  const resume = await screen.findByRole("button", { name: "Continue with authenticator" });
  let finishResume!: (status: StaffMfaStatus) => void;
  readStatus.mockReturnValueOnce(new Promise<StaffMfaStatus>((resolve) => { finishResume = resolve; }));
  fireEvent.click(resume);
  await act(async () => { emitAuth("SIGNED_OUT", null); finishResume(challenge); });
  expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  expect(router.replace).not.toHaveBeenCalled();
});

it("ends the prior session before checking a new password and stays on sign-in when it is wrong", async () => {
  let finishSignOut!: (result: { error: null }) => void;
  auth.getSession.mockResolvedValue({ data: { session: ownerSession }, error: null });
  auth.signOut.mockReturnValueOnce(new Promise<{ error: null }>((resolve) => { finishSignOut = resolve; }));
  auth.signInWithPassword.mockResolvedValueOnce({ error: { code: "invalid_credentials" } });
  render(<LoginPage />);
  act(() => { emitAuth("INITIAL_SESSION", ownerSession); });
  await screen.findByRole("button", { name: "Continue with authenticator" });
  enterCredentials();
  submitPassword();

  await waitFor(() => expect(auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" }));
  expect(auth.signInWithPassword).not.toHaveBeenCalled();
  await act(async () => { emitAuth("SIGNED_OUT", null); finishSignOut({ error: null }); });

  expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect email or password. Please try again.");
  expect(auth.signInWithPassword).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: "Continue with authenticator" })).not.toBeInTheDocument();
  expect(router.replace).not.toHaveBeenCalled();
  expect(router.refresh).not.toHaveBeenCalled();
});

it("keeps sign-in available and skips the password grant when ending the previous session fails", async () => {
  auth.getSession.mockResolvedValue({ data: { session: ownerSession }, error: null });
  auth.signOut.mockResolvedValueOnce({ error: { message: "PRIVATE PROVIDER DETAILS" } });
  render(<LoginPage />);
  enterCredentials();
  submitPassword();

  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t clear the previous sign-in. Please try again.");
  expect(screen.queryByText("PRIVATE PROVIDER DETAILS")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  expect(auth.signInWithPassword).not.toHaveBeenCalled();
  expect(router.replace).not.toHaveBeenCalled();
});

it.each([null, { user: { id: "different-account" } }])("requires a matching fresh session before navigation for %j", async (session) => {
  auth.signInWithPassword.mockResolvedValueOnce({ data: { session, user: owner }, error: null });
  render(<LoginPage />);
  enterCredentials();
  submitPassword();

  expect(await screen.findByRole("alert")).toHaveTextContent("Sign-in couldn’t be completed. Try again or contact your school.");
  expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  expect(router.replace).not.toHaveBeenCalled();
  expect(router.refresh).not.toHaveBeenCalled();
});

it.each([
  { failure: "rejected credentials", error: { code: "invalid_credentials", message: "PRIVATE PROVIDER DETAILS" }, message: "Incorrect email or password. Please try again." },
  { failure: "legacy credential rejection", error: { message: "Invalid login credentials" }, message: "Incorrect email or password. Please try again." },
  { failure: "an unrelated provider error", error: { status: 503, message: "PRIVATE PROVIDER DETAILS" }, message: "Sign-in couldn’t be completed. Try again or contact your school." },
  { failure: "rate limiting", error: { status: 429, message: "PRIVATE PROVIDER DETAILS" }, message: "Too many sign-in attempts. Wait a moment and try again." },
  { failure: "a network exception", error: null, message: "We couldn’t connect. Check your connection and try again." },
])("shows safe feedback for $failure and unlocks both sign-in options", async ({ error, message }) => {
  if (error) auth.signInWithPassword.mockResolvedValueOnce({ error });
  else auth.signInWithPassword.mockRejectedValueOnce(new Error("PRIVATE PROVIDER DETAILS"));
  render(<LoginPage />);
  enterCredentials();
  submitPassword();

  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  expect(screen.queryByText("PRIVATE PROVIDER DETAILS")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
  expect(screen.getByLabelText("Email address")).toBeEnabled();
  expect(screen.getByLabelText("Password")).toBeEnabled();
  expect(router.replace).not.toHaveBeenCalled();
  expect(router.refresh).not.toHaveBeenCalled();
});

it.each(["password", "Google"])("blocks both providers and repeated submissions while %s sign-in is pending", async (provider) => {
  let finish!: (result: { error: { message: string } }) => void;
  const pending = new Promise<{ error: { message: string } }>((resolve) => { finish = resolve; });
  const requested = provider === "password" ? auth.signInWithPassword : auth.signInWithOAuth;
  requested.mockReturnValueOnce(pending);
  render(<LoginPage />);
  enterCredentials();
  const google = screen.getByRole("button", { name: "Continue with Google" });
  if (provider === "password") submitPassword();
  else fireEvent.click(google);

  expect(screen.getByRole("button", { name: provider === "password" ? "Signing in…" : "Sign in" })).toBeDisabled();
  expect(google).toBeDisabled();
  expect(screen.getByLabelText("Email address")).toBeDisabled();
  expect(screen.getByLabelText("Password")).toBeDisabled();
  fireEvent.click(google);
  submitPassword();
  await waitFor(() => expect(requested).toHaveBeenCalledOnce());
  expect(provider === "password" ? auth.signInWithOAuth : auth.signInWithPassword).not.toHaveBeenCalled();

  await act(async () => { finish({ error: { message: "Please retry" } }); });
  expect(await screen.findByRole("alert")).toHaveTextContent(provider === "password"
    ? "Sign-in couldn’t be completed. Try again or contact your school."
    : "Google sign-in couldn’t open. Please try again.");
});

it.each([
  { failure: "a provider error", throws: false },
  { failure: "a thrown exception", throws: true },
])("uses the local OAuth callback and unlocks Google sign-in after $failure", async ({ throws }) => {
  if (throws) auth.signInWithOAuth.mockRejectedValueOnce(new Error("OAuth request failed"));
  else auth.signInWithOAuth.mockResolvedValueOnce({ error: { message: "PRIVATE PROVIDER DETAILS" } });
  render(<LoginPage />);
  fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Google sign-in couldn’t open. Please try again.");
  expect(screen.queryByText("PRIVATE PROVIDER DETAILS")).not.toBeInTheDocument();
  expect(auth.signInWithOAuth).toHaveBeenCalledExactlyOnceWith({
    provider: "google", options: { redirectTo: `${window.location.origin}/auth/callback` },
  });
  expect(screen.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  expect(router.replace).not.toHaveBeenCalled();
  expect(auth.signInWithPassword).not.toHaveBeenCalled();
});

it("reveals and hides the same password and links to password recovery", () => {
  render(<LoginPage />);
  const password = screen.getByLabelText("Password");
  fireEvent.change(password, { target: { value: "my saved password" } });
  expect(password).toHaveAttribute("type", "password");
  fireEvent.click(screen.getByRole("button", { name: "Show password" }));
  expect(password).toHaveAttribute("type", "text");
  expect(password).toHaveValue("my saved password");
  expect(screen.getByRole("button", { name: "Hide password" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
  expect(password).toHaveAttribute("type", "password");
  expect(password).toHaveValue("my saved password");
  expect(screen.getByRole("link", { name: "Forgot password?" })).toHaveAttribute("href", "/forgot-password");
});
