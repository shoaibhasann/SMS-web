import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { GuardianContactSettings } from "@/components/family/guardian-contact-settings";

const mocks = vi.hoisted(() => ({ readUser: vi.fn(), providers: vi.fn(), requestCode: vi.fn(), setPassword: vi.fn(), verifier: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }) } }) }));
vi.mock("@/lib/guardian-invitations/contact", async (original) => ({ ...await original<typeof import("@/lib/guardian-invitations/contact")>(),
  readGuardianAuthUser: mocks.readUser, readGuardianContactProviders: mocks.providers, requestGuardianCurrentMobileCode: mocks.requestCode,
  setGuardianAppPassword: mocks.setPassword, createGuardianVerificationClient: mocks.verifier }));
vi.mock("@/components/auth/phone-security-check", () => ({
  PhoneSecurityCheck: ({ onToken }: { onToken: (token: string) => void }) => <button type="button" onClick={() => onToken("proof")}>Complete security check</button>,
}));
const phoneOnly = { id: "guardian", phone: "919876540001", phone_confirmed_at: "2026-11-06T12:00:00Z" };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.readUser.mockResolvedValue(phoneOnly);
  mocks.providers.mockResolvedValue({ email: true, sms: true, captchaSiteKey: "site" });
  mocks.requestCode.mockResolvedValue("+919876540001");
  mocks.setPassword.mockResolvedValue("+919876540001");
  mocks.verifier.mockReturnValue({ verifier: true });
});

it("lets a phone-only guardian set an app password with a fresh current-mobile code", async () => {
  const user = userEvent.setup();
  render(<GuardianContactSettings userId="guardian" callbackStatus={null} />);
  const card = within(await screen.findByRole("region", { name: "App password" }));
  const submit = card.getByRole("button", { name: "Set app password" });
  expect(submit).toBeDisabled();
  const mobile = within(screen.getByRole("region", { name: "Registered mobile" }));
  await user.click(mobile.getByRole("button", { name: "Complete security check" }));
  await user.click(mobile.getByRole("button", { name: "Send code to current mobile" }));
  await user.type(card.getByLabelText("Current-mobile code"), "123456");
  await user.type(card.getByLabelText("New app password"), "Guardian app password1");
  await user.type(card.getByLabelText("Confirm app password"), "Guardian app password1");
  await user.click(submit);
  expect(await screen.findByText("App password set. Sign in to the SMS app with +919876540001 and this password.")).toBeVisible();
  expect(mocks.setPassword).toHaveBeenCalledWith(expect.anything(), { verifier: true }, "guardian",
    { code: "123456", newPassword: "Guardian app password1", confirmation: "Guardian app password1" }, expect.any(AbortSignal));
  expect(card.getByLabelText("New app password")).toHaveValue("");
});

it("lets the browser accept an 8-character app password (same minimum as every other password screen)", async () => {
  const user = userEvent.setup();
  render(<GuardianContactSettings userId="guardian" callbackStatus={null} />);
  const card = within(await screen.findByRole("region", { name: "App password" }));
  expect(card.getByLabelText("New app password")).toHaveAttribute("minlength", "8");
  expect(card.getByLabelText("Confirm app password")).toHaveAttribute("minlength", "8");
  const mobile = within(screen.getByRole("region", { name: "Registered mobile" }));
  await user.click(mobile.getByRole("button", { name: "Complete security check" }));
  await user.click(mobile.getByRole("button", { name: "Send code to current mobile" }));
  await user.type(card.getByLabelText("Current-mobile code"), "123456");
  await user.type(card.getByLabelText("New app password"), "eight888");
  await user.type(card.getByLabelText("Confirm app password"), "eight888");
  await user.click(card.getByRole("button", { name: "Set app password" }));
  expect(await screen.findByText("App password set. Sign in to the SMS app with +919876540001 and this password.")).toBeVisible();
  expect(mocks.setPassword).toHaveBeenCalledWith(expect.anything(), { verifier: true }, "guardian",
    { code: "123456", newPassword: "eight888", confirmation: "eight888" }, expect.any(AbortSignal));
});

it("does not offer an app password to an email-backed guardian", async () => {
  mocks.readUser.mockResolvedValue({ ...phoneOnly, email: "g@example.test", email_confirmed_at: "2026-11-06" });
  render(<GuardianContactSettings userId="guardian" callbackStatus={null} />);
  await screen.findByRole("region", { name: "Registered mobile" });
  expect(screen.queryByRole("region", { name: "App password" })).not.toBeInTheDocument();
});

it("disables Set app password once a verified code is spent by a failed update", async () => {
  const { SpentGuardianCodeError } = await vi.importActual<typeof import("@/lib/guardian-invitations/contact")>("@/lib/guardian-invitations/contact");
  mocks.setPassword.mockRejectedValueOnce(new SpentGuardianCodeError("Too many attempts. Wait before trying again. Request a new current-mobile code to try again."));
  const user = userEvent.setup();
  render(<GuardianContactSettings userId="guardian" callbackStatus={null} />);
  const card = within(await screen.findByRole("region", { name: "App password" }));
  const mobile = within(screen.getByRole("region", { name: "Registered mobile" }));
  await user.click(mobile.getByRole("button", { name: "Complete security check" }));
  await user.click(mobile.getByRole("button", { name: "Send code to current mobile" }));
  await user.type(card.getByLabelText("Current-mobile code"), "123456");
  await user.type(card.getByLabelText("New app password"), "Guardian app password1");
  await user.type(card.getByLabelText("Confirm app password"), "Guardian app password1");
  await user.click(card.getByRole("button", { name: "Set app password" }));
  expect(await screen.findByText(/Request a new current-mobile code to try again/)).toBeVisible();
  expect(card.getByRole("button", { name: "Set app password" })).toBeDisabled();
  expect(screen.queryByText(/Current-mobile code requested for/)).not.toBeInTheDocument();
});

it("keeps the code usable when it was rejected before verification", async () => {
  mocks.setPassword.mockRejectedValueOnce(new Error("The code could not be verified. Check it or request a new code."));
  const user = userEvent.setup();
  render(<GuardianContactSettings userId="guardian" callbackStatus={null} />);
  const card = within(await screen.findByRole("region", { name: "App password" }));
  const mobile = within(screen.getByRole("region", { name: "Registered mobile" }));
  await user.click(mobile.getByRole("button", { name: "Complete security check" }));
  await user.click(mobile.getByRole("button", { name: "Send code to current mobile" }));
  await user.type(card.getByLabelText("Current-mobile code"), "123450");
  await user.type(card.getByLabelText("New app password"), "Guardian app password1");
  await user.type(card.getByLabelText("Confirm app password"), "Guardian app password1");
  await user.click(card.getByRole("button", { name: "Set app password" }));
  expect(await screen.findByText(/code could not be verified/)).toBeVisible();
  expect(card.getByRole("button", { name: "Set app password" })).toBeEnabled();
});

it("explains that the school must enable mobile verification when SMS is disabled", async () => {
  mocks.providers.mockResolvedValue({ email: true, sms: false, captchaSiteKey: null });
  render(<GuardianContactSettings userId="guardian" callbackStatus={null} />);
  const card = within(await screen.findByRole("region", { name: "App password" }));
  expect(card.getByText(/school office must enable mobile verification or add a verified email/)).toBeVisible();
  expect(card.queryByRole("form", { name: "Set app password" })).not.toBeInTheDocument();
});

it("shows a neutral retry, not the office copy, when contact settings are only temporarily unavailable", async () => {
  mocks.providers.mockRejectedValueOnce(new Error("Contact verification settings are temporarily unavailable."));
  const user = userEvent.setup();
  render(<GuardianContactSettings userId="guardian" callbackStatus={null} />);
  const card = within(await screen.findByRole("region", { name: "App password" }));
  expect(card.getByText(/App password setup is temporarily unavailable/)).toBeVisible();
  expect(screen.queryByText(/school office must enable mobile verification/)).not.toBeInTheDocument();
  expect(card.queryByRole("form", { name: "Set app password" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Retry verification check" }));
  expect(await screen.findByRole("form", { name: "Set app password" })).toBeVisible();
  expect(mocks.providers).toHaveBeenCalledTimes(2);
});
