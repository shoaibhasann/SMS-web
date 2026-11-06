import type { User } from "@supabase/supabase-js";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GuardianContactSettings } from "@/components/family/guardian-contact-settings";
import { guardianEmailContinuation } from "@/lib/auth/redirect";
import { createClient } from "@/lib/supabase/client";
import { requestGuardianCurrentMobileCode, requestGuardianMobileChangeWithOtp } from "@/lib/guardian-invitations/contact";

const { getUser, updateUser, rpc, onAuthStateChange, signInWithPassword, signInWithOtp, verifyOtp, updateVerifiedUser, signOut, makeVerifier, authorizeChange } = vi.hoisted(() => ({
  getUser: vi.fn(), updateUser: vi.fn(), rpc: vi.fn(), onAuthStateChange: vi.fn(),
  signInWithPassword: vi.fn(), signInWithOtp: vi.fn(), verifyOtp: vi.fn(), updateVerifiedUser: vi.fn(), signOut: vi.fn(), makeVerifier: vi.fn(), authorizeChange: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { getUser, updateUser, onAuthStateChange }, rpc }),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: makeVerifier }));
vi.mock("@/components/auth/phone-security-check", () => ({
  PhoneSecurityCheck: ({ onToken }: { onToken: (token: string) => void }) =>
    <button type="button" onClick={() => onToken("fresh-proof")}>Complete security check</button>,
}));

const verifiedAt = "2026-11-04T12:00:00Z";
const guardian = {
  id: "guardian", email: "guardian@example.test", email_confirmed_at: verifiedAt, app_metadata: {},
  user_metadata: {}, aud: "authenticated", created_at: verifiedAt, phone: "919876540001", phone_confirmed_at: verifiedAt,
} satisfies User;
const newEmail = "next@example.test";
const newPhone = "+919876540002";
let current: User;
let phoneProvider: boolean;
let phoneAutoconfirm: boolean;
let authListener: (event: string, session: { user: User } | null) => void;

beforeEach(() => {
  current = { ...guardian };
  phoneProvider = false;
  phoneAutoconfirm = false;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://demo.supabase.test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "publishable");
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => String(url) === "/auth/phone/status"
    ? { ok: true, json: async () => ({ enabled: phoneProvider, captchaSiteKey: phoneProvider ? "public-key" : null }) }
    : String(url) === "/auth/phone/permit" ? { ok: true }
      : { ok: true, json: async () => ({ external: { email: true, phone: phoneProvider }, mailer_autoconfirm: false, phone_autoconfirm: phoneAutoconfirm }) }));
  getUser.mockImplementation(async () => ({ data: { user: current }, error: null }));
  onAuthStateChange.mockImplementation((listener) => {
    authListener = listener;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
  makeVerifier.mockImplementation(() => ({
    auth: { signInWithPassword, signInWithOtp, verifyOtp, updateUser: updateVerifiedUser, signOut }, rpc: authorizeChange,
  }));
  authorizeChange.mockResolvedValue({ data: true, error: null });
  updateUser.mockImplementation(async ({ email }) => {
    current = { ...guardian, new_email: email };
    return { data: { user: current }, error: null };
  });
  signInWithPassword.mockResolvedValue({ data: { user: guardian, session: { access_token: "isolated-session" } }, error: null });
  signInWithOtp.mockResolvedValue({ data: {}, error: null });
  updateVerifiedUser.mockImplementation(async ({ phone }) => {
    current = { ...current, new_phone: phone.slice(1) };
    return { data: { user: current }, error: null };
  });
  verifyOtp.mockImplementation(async ({ type }) => {
    if (type === "sms") return { data: { user: { ...current }, session: { access_token: "isolated-current-phone-session" } }, error: null };
    current = { ...current, phone: newPhone.slice(1), new_phone: undefined, phone_confirmed_at: "2026-11-05T12:00:00Z" };
    return { data: { user: current, session: { access_token: "isolated-confirmation-session" } }, error: null };
  });
  signOut.mockResolvedValue({ error: null });
  rpc.mockResolvedValue({ data: newPhone, error: null });
});

describe("guardian contact settings", () => {
  it("does not let an email-backed guardian replace password proof with current-mobile OTP reauthentication", async () => {
    const client = createClient();
    await expect(requestGuardianCurrentMobileCode(client, "guardian", "fresh-proof")).rejects.toThrow("current-password verification");
    await expect(requestGuardianMobileChangeWithOtp(client, client, "guardian", newPhone, "123456", "fresh-proof"))
      .rejects.toThrow("current-password verification");
    expect(fetch).not.toHaveBeenCalled();
    expect(signInWithOtp).not.toHaveBeenCalled();
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(authorizeChange).not.toHaveBeenCalled();
    expect(updateVerifiedUser).not.toHaveBeenCalled();
  });

  it("shows verified contacts and explicitly disables SMS without a provider", async () => {
    render(<GuardianContactSettings userId="guardian" callbackStatus={null} />);
    expect(await screen.findByText(/SMS verification is unavailable/)).toBeInTheDocument();
    expect(screen.getByText("Verified mobile · +919876540001")).toBeInTheDocument();
    expect(screen.getByText("Verified email · guardian@example.test")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send SMS code" })).not.toBeInTheDocument();
    expect(makeVerifier).not.toHaveBeenCalled();
  });

  it("requests email confirmation through PKCE and retains the old address until provider confirmation", async () => {
    const user = userEvent.setup();
    render(<GuardianContactSettings userId="guardian" callbackStatus={null} />);
    const email = await screen.findByRole("textbox", { name: "New email address" });
    await user.type(email, "Next@Example.Test");
    await user.click(screen.getByRole("button", { name: "Send email confirmation" }));
    expect(await screen.findByText("Confirmation pending for next@example.test.")).toBeInTheDocument();
    expect(screen.getByText("Verified email · guardian@example.test")).toBeInTheDocument();

    const callback = new URL("/auth/callback", window.location.origin);
    callback.searchParams.set("next", guardianEmailContinuation);
    expect(updateUser).toHaveBeenCalledExactlyOnceWith({ email: newEmail }, { emailRedirectTo: callback.href });
    current = { ...guardian, email: newEmail };
    await user.click(screen.getByRole("button", { name: "Refresh contact details" }));
    expect(await screen.findByText("Verified email · next@example.test")).toBeInTheDocument();
    expect(screen.queryByText(/Confirmation pending/)).not.toBeInTheDocument();
  });

  it("does not treat a callback query marker as verification", async () => {
    current = { ...guardian, new_email: newEmail };
    render(<GuardianContactSettings userId="guardian" callbackStatus="email-returned" />);
    expect(await screen.findByText("Confirmation pending for next@example.test.")).toBeInTheDocument();
    expect(screen.getByText("Verified email · guardian@example.test")).toBeInTheDocument();
    expect(screen.queryByText("Verified email · next@example.test")).not.toBeInTheDocument();
  });

  it("reauthenticates the exact account in a nonpersistent client and verifies a new number before syncing", async () => {
    phoneProvider = true;
    const user = userEvent.setup();
    render(<GuardianContactSettings userId="guardian" callbackStatus={null} />);
    await user.type(await screen.findByRole("textbox", { name: "New mobile number" }), newPhone);
    await user.type(screen.getByLabelText("Current password"), "fixture-password");
    await user.click(screen.getByRole("button", { name: "Complete security check" }));
    await user.click(screen.getByRole("button", { name: "Send SMS code" }));
    const mobile = within(await screen.findByRole("region", { name: "Registered mobile" }));
    expect(await mobile.findByText(`SMS verification pending for ${newPhone}.`)).toBeInTheDocument();
    expect(mobile.getByText("Verified mobile · +919876540001")).toBeInTheDocument();
    expect(signInWithPassword).toHaveBeenCalledExactlyOnceWith({ email: guardian.email, password: "fixture-password" });
    expect(makeVerifier).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({
      auth: expect.objectContaining({ persistSession: false, autoRefreshToken: false }),
    }));
    expect(authorizeChange).toHaveBeenCalledExactlyOnceWith("authorize_my_guardian_phone_change", { p_phone: newPhone });
    expect(authorizeChange).toHaveBeenCalledBefore(updateVerifiedUser);
    expect(updateVerifiedUser).toHaveBeenCalledExactlyOnceWith({ phone: newPhone });
    expect(updateUser).not.toHaveBeenCalled();
    expect(mobile.getByLabelText("Current password")).toHaveValue("");
    expect(rpc).not.toHaveBeenCalled();

    await user.type(mobile.getByRole("textbox", { name: "SMS verification code" }), "123456");
    await user.click(mobile.getByRole("button", { name: "Verify mobile number" }));
    expect(await screen.findByText("Mobile number verified and updated.")).toBeInTheDocument();
    expect(verifyOtp).toHaveBeenCalledExactlyOnceWith({ phone: newPhone, token: "123456", type: "phone_change" });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("sync_my_guardian_mobile");
    expect(signOut.mock.calls).toEqual([[{ scope: "local" }], [{ scope: "local" }]]);
    expect(mobile.getByText(`Verified mobile · ${newPhone}`)).toBeInTheDocument();
  });

  it("refuses to start a phone change when the reauthentication returns another account", async () => {
    phoneProvider = true;
    signInWithPassword.mockResolvedValue({ data: { user: { ...guardian, id: "other" }, session: {} }, error: null });
    const user = userEvent.setup();
    render(<GuardianContactSettings userId="guardian" callbackStatus={null} />);
    await user.type(await screen.findByRole("textbox", { name: "New mobile number" }), newPhone);
    await user.type(screen.getByLabelText("Current password"), "fixture-password");
    await user.click(screen.getByRole("button", { name: "Complete security check" }));
    await user.click(screen.getByRole("button", { name: "Send SMS code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The current password could not be verified.");
    expect(authorizeChange).not.toHaveBeenCalled();
    expect(updateVerifiedUser).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("blocks phone updates when the exact-target authorization is rejected", async () => {
    phoneProvider = true;
    authorizeChange.mockResolvedValue({ data: null, error: { code: "42501" } });
    const user = userEvent.setup();
    render(<GuardianContactSettings userId="guardian" callbackStatus={null} />);
    await user.type(await screen.findByRole("textbox", { name: "New mobile number" }), newPhone);
    await user.type(screen.getByLabelText("Current password"), "fixture-password");
    await user.click(screen.getByRole("button", { name: "Complete security check" }));
    await user.click(screen.getByRole("button", { name: "Send SMS code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The mobile change could not be authorized.");
    expect(authorizeChange).toHaveBeenCalledExactlyOnceWith("authorize_my_guardian_phone_change", { p_phone: newPhone });
    expect(updateVerifiedUser).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
  });

  it("fails closed with auto-confirming SMS and clears displayed contacts on account change", async () => {
    phoneProvider = true;
    phoneAutoconfirm = true;
    render(<GuardianContactSettings userId="guardian" callbackStatus={null} />);
    expect(await screen.findByText(/SMS verification is unavailable/)).toBeInTheDocument();
    act(() => authListener("SIGNED_OUT", null));
    expect(screen.getByRole("alert")).toHaveTextContent("Your account changed");
    expect(screen.queryByText("Verified email · guardian@example.test")).not.toBeInTheDocument();
  });

  it("reauthenticates a phone-only guardian on the current number before verifying the new number on the same account", async () => {
    phoneProvider = true;
    current = { ...guardian, email: undefined, email_confirmed_at: undefined };
    const user = userEvent.setup();
    render(<GuardianContactSettings userId="guardian" callbackStatus={null} />);
    const mobile = within(await screen.findByRole("region", { name: "Registered mobile" }));
    expect(await mobile.findByRole("button", { name: "Send code to current mobile" })).toBeDisabled();
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "New email address" })).not.toBeInTheDocument();
    await user.click(mobile.getByRole("button", { name: "Complete security check" }));
    await user.click(mobile.getByRole("button", { name: "Send code to current mobile" }));
    expect(await mobile.findByText("Current-mobile code requested for +919876540001.")).toBeVisible();
    expect(signInWithOtp).toHaveBeenCalledExactlyOnceWith({ phone: "+919876540001", options: { shouldCreateUser: false } });
    expect(signInWithPassword).not.toHaveBeenCalled();
    expect(authorizeChange).not.toHaveBeenCalled();
    await user.type(mobile.getByRole("textbox", { name: "New mobile number" }), newPhone);
    await user.type(mobile.getByRole("textbox", { name: "Current-mobile verification code" }), "123456");
    await user.click(mobile.getByRole("button", { name: "Complete security check" }));
    await user.click(mobile.getByRole("button", { name: "Send SMS code" }));
    expect(await mobile.findByText(`SMS verification pending for ${newPhone}.`)).toBeVisible();
    expect(verifyOtp).toHaveBeenCalledWith({ phone: "+919876540001", token: "123456", type: "sms" });
    expect(authorizeChange).toHaveBeenCalledExactlyOnceWith("authorize_my_guardian_phone_change", { p_phone: newPhone });
    expect(updateVerifiedUser).toHaveBeenCalledExactlyOnceWith({ phone: newPhone });
    expect(mobile.getByText("Verified mobile · +919876540001")).toBeVisible();
    expect(rpc).not.toHaveBeenCalled();
    await user.type(mobile.getByRole("textbox", { name: "SMS verification code" }), "654321");
    await user.click(mobile.getByRole("button", { name: "Verify mobile number" }));
    expect(await screen.findByText("Mobile number verified and updated.")).toBeVisible();
    expect(verifyOtp).toHaveBeenCalledWith({ phone: newPhone, token: "654321", type: "phone_change" });
    expect(current.id).toBe("guardian");
    expect(current.email).toBeUndefined();
    expect(rpc).toHaveBeenCalledExactlyOnceWith("sync_my_guardian_mobile");
    expect(updateUser).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledTimes(3);
    expect(signOut.mock.calls.every(([scope]) => scope.scope === "local")).toBe(true);
  });

  it("rejects a current-mobile OTP resolved for another account before authorizing a phone change", async () => {
    phoneProvider = true;
    current = { ...guardian, email: undefined, email_confirmed_at: undefined };
    verifyOtp.mockResolvedValue({ data: { user: { ...current, id: "another-user" }, session: {} }, error: null });
    const user = userEvent.setup();
    render(<GuardianContactSettings userId="guardian" callbackStatus={null} />);
    const mobile = within(await screen.findByRole("region", { name: "Registered mobile" }));
    await user.click(await mobile.findByRole("button", { name: "Complete security check" }));
    await user.click(mobile.getByRole("button", { name: "Send code to current mobile" }));
    await mobile.findByText("Current-mobile code requested for +919876540001.");
    await user.type(mobile.getByRole("textbox", { name: "New mobile number" }), newPhone);
    await user.type(mobile.getByRole("textbox", { name: "Current-mobile verification code" }), "123456");
    await user.click(mobile.getByRole("button", { name: "Complete security check" }));
    await user.click(mobile.getByRole("button", { name: "Send SMS code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be verified");
    expect(authorizeChange).not.toHaveBeenCalled();
    expect(updateVerifiedUser).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(current.phone).toBe(guardian.phone);
  });
});
