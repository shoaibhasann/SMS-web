import type { User } from "@supabase/supabase-js";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuardianPhoneOtpForm } from "@/components/auth/phone-otp-form";

const { signInWithOtp, verifyOtp, getUser } = vi.hoisted(() => ({ signInWithOtp: vi.fn(), verifyOtp: vi.fn(), getUser: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { signInWithOtp, verifyOtp, getUser } }) }));
vi.mock("@/components/auth/phone-security-check", () => ({
  PhoneSecurityCheck: ({ onToken }: { onToken: (token: string) => void }) =>
    <button type="button" onClick={() => onToken("fresh-proof")}>Complete security check</button>,
}));

const phone = "+919876540001";
const guardian = {
  id: "guardian", phone: phone.slice(1), phone_confirmed_at: "2026-11-06T12:00:00Z", is_anonymous: false,
  aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-11-06T12:00:00Z",
} satisfies User;
const fetchMock = vi.fn();

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { resolve, promise }; }
async function mount(purpose: "login" | "invitation" = "login", onVerified = vi.fn(), onBusyChange = vi.fn()) {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<GuardianPhoneOtpForm purpose={purpose} onVerified={onVerified} onBusyChange={onBusyChange} />); });
  return { ...view, onVerified, onBusyChange };
}
async function requestCode() {
  fireEvent.change(screen.getByRole("textbox", { name: "Mobile number" }), { target: { value: "98765 40001" } });
  fireEvent.click(screen.getByRole("button", { name: "Complete security check" }));
  await act(async () => { fireEvent.submit(screen.getByRole("form", { name: "Request guardian SMS code" })); });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (url: string) => url === "/auth/phone/status"
    ? { ok: true, json: async () => ({ enabled: true, captchaSiteKey: "public-key" }) } : { ok: true });
  signInWithOtp.mockResolvedValue({ data: {}, error: null });
  verifyOtp.mockResolvedValue({ data: { user: guardian, session: { access_token: "session" } }, error: null });
  getUser.mockResolvedValue({ data: { user: guardian }, error: null });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("guardian phone OTP form", () => {
  it("keeps paid SMS unavailable until the server confirms readiness", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ enabled: false, captchaSiteKey: null }) });
    await mount();
    expect(screen.getByText(/Mobile sign-in is not available yet/)).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Mobile number" })).not.toBeInTheDocument();
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  it.each([["login", false], ["invitation", true]] as const)("uses restricted account creation for %s", async (purpose, shouldCreateUser) => {
    await mount(purpose);
    expect(screen.getByRole("button", { name: "Send code" })).toBeDisabled();
    await requestCode();
    expect(signInWithOtp).toHaveBeenCalledExactlyOnceWith({ phone, options: { shouldCreateUser } });
    expect(fetchMock).toHaveBeenCalledWith("/auth/phone/permit", expect.objectContaining({
      body: JSON.stringify({ phone, captchaToken: "fresh-proof" }),
    }));
    expect(screen.getByRole("textbox", { name: "SMS code" })).toHaveAttribute("autocomplete", "one-time-code");
  });

  it("requires six digits and a verified current matching account before continuing", async () => {
    const { onVerified } = await mount();
    await requestCode();
    fireEvent.change(screen.getByRole("textbox", { name: "SMS code" }), { target: { value: "12345" } });
    expect(screen.getByRole("button", { name: "Verify and continue" })).toBeDisabled();
    await act(async () => { fireEvent.submit(screen.getByRole("form", { name: "Verify guardian SMS code" })); });
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("six-digit");
    fireEvent.change(screen.getByRole("textbox", { name: "SMS code" }), { target: { value: "123456" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Verify and continue" })); });
    expect(verifyOtp).toHaveBeenCalledExactlyOnceWith({ phone, token: "123456", type: "sms" });
    expect(onVerified).toHaveBeenCalledExactlyOnceWith(guardian);
    expect(screen.getByRole("textbox", { name: "SMS code" })).toHaveValue("");
  });

  it.each([
    { data: { user: null, session: null }, error: { code: "otp_expired", message: "private diagnostic" } },
    { data: { user: { ...guardian, phone: "919876540002" }, session: {} }, error: null },
    { data: { user: { ...guardian, is_anonymous: true }, session: {} }, error: null },
    { data: { user: { ...guardian, phone_confirmed_at: undefined }, session: {} }, error: null },
    { data: { user: guardian, session: null }, error: null },
  ])("rejects failed or wrong-owner verification without continuing (%j)", async (result) => {
    verifyOtp.mockResolvedValue(result);
    const { onVerified } = await mount();
    await requestCode();
    fireEvent.change(screen.getByRole("textbox", { name: "SMS code" }), { target: { value: "123456" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Verify and continue" })); });
    expect(screen.getByRole("alert")).toHaveTextContent("could not be verified");
    expect(onVerified).not.toHaveBeenCalled();
    expect(getUser).not.toHaveBeenCalled();
    expect(screen.queryByText("private diagnostic")).not.toBeInTheDocument();
  });

  it("does not continue if the browser account changed during OTP verification", async () => {
    getUser.mockResolvedValue({ data: { user: { ...guardian, id: "another-user" } }, error: null });
    const { onVerified } = await mount();
    await requestCode();
    fireEvent.change(screen.getByRole("textbox", { name: "SMS code" }), { target: { value: "123456" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Verify and continue" })); });
    expect(screen.getByRole("alert")).toHaveTextContent("Your sign-in changed");
    expect(onVerified).not.toHaveBeenCalled();
  });

  it("suppresses parallel requests and enforces a fresh CAPTCHA plus 60-second resend cooldown", async () => {
    const permit = deferred<{ ok: boolean }>();
    fetchMock.mockImplementation(async (url: string) => url === "/auth/phone/status"
      ? { ok: true, json: async () => ({ enabled: true, captchaSiteKey: "public-key" }) } : permit.promise);
    const { onBusyChange } = await mount();
    fireEvent.change(screen.getByRole("textbox", { name: "Mobile number" }), { target: { value: phone } });
    fireEvent.click(screen.getByRole("button", { name: "Complete security check" }));
    const form = screen.getByRole("form", { name: "Request guardian SMS code" });
    await act(async () => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(fetchMock.mock.calls.filter(([url]) => url === "/auth/phone/permit")).toHaveLength(1);
    expect(signInWithOtp).not.toHaveBeenCalled();
    await act(async () => permit.resolve({ ok: true }));
    expect(signInWithOtp).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Complete security check" }));
    expect(screen.getByRole("button", { name: "Resend available in 60s" })).toBeDisabled();
    act(() => { vi.advanceTimersByTime(59_000); });
    expect(screen.getByRole("button", { name: "Resend available in 1s" })).toBeDisabled();
    act(() => { vi.advanceTimersByTime(1_000); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resend code" })); });
    expect(signInWithOtp).toHaveBeenCalledTimes(2);
    expect(onBusyChange.mock.calls).toEqual([[true], [false], [true], [false]]);
  });

  it("preserves cooldown when changing the destination", async () => {
    await mount();
    await requestCode();
    fireEvent.click(screen.getByRole("button", { name: "Change number" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete security check" }));
    expect(screen.getByRole("button", { name: "Try again in 60s" })).toBeDisabled();
    await act(async () => { fireEvent.submit(screen.getByRole("form", { name: "Request guardian SMS code" })); });
    expect(signInWithOtp).toHaveBeenCalledTimes(1);
  });

  it("does not start provider Auth when a permit resolves after unmount", async () => {
    const permit = deferred<{ ok: boolean }>();
    fetchMock.mockImplementation(async (url: string) => url === "/auth/phone/status"
      ? { ok: true, json: async () => ({ enabled: true, captchaSiteKey: "public-key" }) } : permit.promise);
    const view = await mount();
    await requestCode();
    view.unmount();
    await act(async () => permit.resolve({ ok: true }));
    expect(signInWithOtp).not.toHaveBeenCalled();
    expect(view.onVerified).not.toHaveBeenCalled();
  });

  it("does not continue after unmounting an in-flight verification or issue duplicate verification calls", async () => {
    const verification = deferred<{ data: { user: User; session: { access_token: string } }; error: null }>();
    verifyOtp.mockReturnValue(verification.promise);
    const view = await mount();
    await requestCode();
    fireEvent.change(screen.getByRole("textbox", { name: "SMS code" }), { target: { value: "123456" } });
    const form = screen.getByRole("form", { name: "Verify guardian SMS code" });
    await act(async () => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(verifyOtp).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => verification.resolve({ data: { user: guardian, session: { access_token: "temporary-session" } }, error: null }));
    expect(view.onVerified).not.toHaveBeenCalled();
  });

  it("keeps failed CAPTCHA permits from reaching the SMS provider and preserves the cooldown", async () => {
    fetchMock.mockImplementation(async (url: string) => url === "/auth/phone/status"
      ? { ok: true, json: async () => ({ enabled: true, captchaSiteKey: "public-key" }) } : { ok: false, status: 429 });
    await mount();
    await requestCode();
    expect(screen.getByRole("alert")).toHaveTextContent("Too many code requests");
    expect(signInWithOtp).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Try again in 60s" })).toBeDisabled();
  });
});
