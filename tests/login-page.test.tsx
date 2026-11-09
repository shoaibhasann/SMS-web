import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import LoginPage from "@/app/(auth)/login/page";

const { auth, router } = vi.hoisted(() => ({
  auth: { signInWithPassword: vi.fn(), signInWithOAuth: vi.fn() },
  router: { replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth }) }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/ui/theme-toggle", () => ({ ThemeToggle: () => null }));

beforeEach(() => {
  auth.signInWithPassword.mockReset().mockResolvedValue({ error: null });
  auth.signInWithOAuth.mockReset().mockResolvedValue({ error: null });
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
  expect(auth.signInWithOAuth).not.toHaveBeenCalled();
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
  expect(requested).toHaveBeenCalledOnce();
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
