// @vitest-environment node
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readGuardianContactProviders, setGuardianAppPassword, SpentGuardianCodeError } from "@/lib/guardian-invitations/contact";

const mocks = vi.hoisted(() => ({ security: vi.fn(), bound: vi.fn(), boundUpdate: vi.fn() }));
vi.mock("@/lib/auth/staff-mfa", async (original) => ({ ...await original<typeof import("@/lib/auth/staff-mfa")>(),
  readStaffMfaStatus: mocks.security, createBoundMfaClient: mocks.bound }));

const owner = "owner", phone = "+919876540001";
const phoneOnly = { id: owner, phone: "919876540001", phone_confirmed_at: "2026-11-06T12:00:00Z" };
const primary = { auth: { getUser: vi.fn(), getSession: vi.fn() } };
const verifier = { auth: { verifyOtp: vi.fn(), signOut: vi.fn(), updateUser: vi.fn() } };
const input = { code: "123456", newPassword: "Guardian app password1", confirmation: "Guardian app password1" };
const setPassword = (value = input) => setGuardianAppPassword(primary as unknown as SupabaseClient, verifier as unknown as SupabaseClient, owner, value);

beforeEach(() => {
  vi.clearAllMocks();
  primary.auth.getUser.mockResolvedValue({ data: { user: phoneOnly }, error: null });
  primary.auth.getSession.mockResolvedValue({ data: { session: { user: { id: owner } } }, error: null });
  verifier.auth.verifyOtp.mockResolvedValue({ data: { session: {}, user: phoneOnly }, error: null });
  verifier.auth.signOut.mockResolvedValue({ error: null });
  mocks.security.mockResolvedValue({ allowed: true, required: false, current_aal: "aal1" });
  mocks.boundUpdate.mockResolvedValue({ data: { user: { id: owner } }, error: null });
  mocks.bound.mockResolvedValue({ auth: { updateUser: mocks.boundUpdate } });
});

describe("phone-only guardian app password", () => {
  it("proves the current mobile, then sets the password through the browser's own session", async () => {
    expect(await setPassword()).toBe(phone);
    expect(verifier.auth.verifyOtp).toHaveBeenCalledWith({ phone, token: "123456", type: "sms" });
    expect(mocks.bound).toHaveBeenCalledWith(primary, owner, undefined);
    expect(mocks.boundUpdate).toHaveBeenCalledWith({ password: input.newPassword });
    expect(verifier.auth.updateUser).not.toHaveBeenCalled();
    expect(verifier.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("refuses email-backed accounts, which keep Change password", async () => {
    primary.auth.getUser.mockResolvedValue({ data: { user: { ...phoneOnly, email: "g@example.test", email_confirmed_at: "2026-11-06" } }, error: null });
    await expect(setPassword()).rejects.toThrow(/verified current mobile is required/);
    expect(verifier.auth.verifyOtp).not.toHaveBeenCalled(); expect(mocks.boundUpdate).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...input, code: "12345" }, /six-digit code/],
    [{ ...input, newPassword: "short", confirmation: "short" }, /at least 8 characters/],
    [{ ...input, newPassword: "seven77", confirmation: "seven77" }, /at least 8 characters/],
    [{ ...input, newPassword: " ".repeat(8), confirmation: " ".repeat(8) }, /at least 8 characters/],
    [{ ...input, newPassword: "x".repeat(73), confirmation: "x".repeat(73) }, /too long/],
    [{ ...input, confirmation: "Different app password" }, /do not match/],
  ])("validates the form before any Auth request %#", async (value, message) => {
    await expect(setPassword(value)).rejects.toThrow(message);
    expect(verifier.auth.verifyOtp).not.toHaveBeenCalled();
  });

  it("accepts an 8-character app password", async () => {
    expect(await setPassword({ ...input, newPassword: "eight888", confirmation: "eight888" })).toBe(phone);
    expect(mocks.boundUpdate).toHaveBeenCalledExactlyOnceWith({ password: "eight888" });
  });

  it("does not set a password when the current-mobile code is rejected", async () => {
    verifier.auth.verifyOtp.mockResolvedValueOnce({ data: { session: null, user: null }, error: { code: "otp_expired" } });
    await expect(setPassword()).rejects.toThrow(/code could not be verified/);
    expect(mocks.boundUpdate).not.toHaveBeenCalled(); expect(verifier.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it.each([
    [{ data: { session: {}, user: { ...phoneOnly, id: "other" } }, error: null }],
    [{ data: { session: {}, user: { ...phoneOnly, phone: "919876540002" } }, error: null }],
    [{ data: { session: null, user: phoneOnly }, error: null }],
  ])("treats an accepted code that does not match this account as spent %#", async (result) => {
    verifier.auth.verifyOtp.mockResolvedValueOnce(result);
    const call = setPassword();
    await expect(call).rejects.toBeInstanceOf(SpentGuardianCodeError);
    await expect(call).rejects.toThrow("The current-mobile code did not match this account. Request a new current-mobile code to try again.");
    expect(mocks.boundUpdate).not.toHaveBeenCalled(); expect(verifier.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("requires a satisfied authenticator and the same browser owner", async () => {
    mocks.security.mockResolvedValueOnce({ allowed: false, required: true, current_aal: "aal1" });
    await expect(setPassword()).rejects.toThrow(/Verify your authenticator/);
    primary.auth.getSession.mockResolvedValueOnce({ data: { session: { user: { id: "other" } } }, error: null });
    await expect(setPassword()).rejects.toThrow(/account changed/);
    expect(mocks.boundUpdate).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 429 }, /Too many attempts/],
    [{ code: "weak_password" }, /stronger password/],
    [{ code: "reauthentication_needed" }, /sign in again with your mobile code/],
    [{ code: "unexpected", message: "SECRET" }, /could not be confirmed/],
  ])("maps provider failures without leaking details %#", async (error, message) => {
    mocks.boundUpdate.mockResolvedValueOnce({ data: { user: null }, error });
    const call = setPassword();
    await expect(call).rejects.toThrow(message); await expect(call).rejects.not.toThrow(/SECRET/);
  });

  it("marks the code as spent once verified, whatever fails next, and asks for a new code", async () => {
    mocks.boundUpdate.mockResolvedValueOnce({ data: { user: null }, error: { code: "unexpected" } });
    await expect(setPassword()).rejects.toThrow(SpentGuardianCodeError);
    mocks.security.mockResolvedValueOnce({ allowed: false, required: true, current_aal: "aal1" });
    const call = setPassword();
    await expect(call).rejects.toThrow(SpentGuardianCodeError); await expect(call).rejects.toThrow(/Request a new current-mobile code/);
  });

  it("gives an unconfirmed update one coherent message instead of a contradictory retry hint", async () => {
    mocks.boundUpdate.mockResolvedValueOnce({ data: { user: null }, error: { code: "unexpected" } });
    const call = setPassword();
    await expect(call).rejects.toBeInstanceOf(SpentGuardianCodeError);
    await expect(call).rejects.toThrow("The app password could not be confirmed. Try signing in to the app with it; if that fails, request a new current-mobile code and set it again.");
  });

  it("keeps the code usable when it was never verified", async () => {
    verifier.auth.verifyOtp.mockResolvedValueOnce({ data: { session: null, user: null }, error: { code: "otp_expired" } });
    const call = setPassword();
    await expect(call).rejects.toThrow(/code could not be verified/); await expect(call).rejects.not.toBeInstanceOf(SpentGuardianCodeError);
  });
});

describe("guardian contact providers", () => {
  const settings = { external: { email: true, phone: true }, mailer_autoconfirm: false, phone_autoconfirm: false };
  const reply = (body: unknown, ok = true) => ({ ok, json: async () => body });
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://demo.supabase.test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "publishable");
  });

  it("reports a real SMS-disabled school as sms:false", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => String(url) === "/auth/phone/status"
      ? reply({ enabled: false, captchaSiteKey: null }) : reply(settings)));
    await expect(readGuardianContactProviders()).resolves.toEqual({ email: true, sms: false, captchaSiteKey: null });
  });

  it("treats a failed mobile status read as unavailable, not as SMS disabled", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => String(url) === "/auth/phone/status" ? reply({}, false) : reply(settings)));
    await expect(readGuardianContactProviders()).rejects.toThrow("Contact verification settings are temporarily unavailable.");
  });

  it("gives up on a hung Auth settings read after a timeout", async () => {
    const timeout = new AbortController();
    const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    vi.stubGlobal("fetch", vi.fn((_url: string | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })));
    const call = readGuardianContactProviders();
    expect(spy).toHaveBeenCalledWith(10_000);
    timeout.abort(new DOMException("timed out", "TimeoutError"));
    await expect(call).rejects.toThrow("Contact verification settings are temporarily unavailable.");
    spy.mockRestore();
  });
});
