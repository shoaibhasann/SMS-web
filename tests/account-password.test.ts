import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeOwnPassword, validatePasswordChange } from "../lib/account/password";

const { create, verify, update, close, getUser, security, boundClient, securedUpdate } = vi.hoisted(() => ({
  create: vi.fn(), verify: vi.fn(), update: vi.fn(), close: vi.fn(), getUser: vi.fn(), security: vi.fn(), boundClient: vi.fn(), securedUpdate: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: create }));
vi.mock("@/lib/auth/staff-mfa", () => ({ readStaffMfaStatus: security, createBoundMfaClient: boundClient }));
const owner = { id: "owner", email: "owner@example.test", email_confirmed_at: "2026-11-06T00:00:00Z" };
const input = { currentPassword: "Current secure password1", newPassword: "Different secure password2", confirmation: "Different secure password2" };
const primary = { auth: { getUser } } as unknown as SupabaseClient;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-publishable-key");
  getUser.mockResolvedValue({ data: { user: owner }, error: null });
  verify.mockResolvedValue({ data: { user: owner, session: {} }, error: null });
  update.mockResolvedValue({ data: { user: owner }, error: null });
  close.mockResolvedValue({ error: null });
  create.mockReturnValue({ auth: { signInWithPassword: verify, updateUser: update, signOut: close } });
  security.mockResolvedValue({ allowed: true, required: false, current_aal: "aal1" });
  securedUpdate.mockResolvedValue({ data: { user: owner }, error: null });
  boundClient.mockResolvedValue({ auth: { updateUser: securedUpdate } });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("verified own password changes", () => {
  it("keeps password confirmation AAL1 separate from the validated current AAL2 mutation", async () => {
    security.mockResolvedValue({ allowed: true, required: true, current_aal: "aal2" });
    await changeOwnPassword(primary, "owner", input);
    expect(verify).toHaveBeenCalledWith({ email: owner.email, password: input.currentPassword });
    expect(update).not.toHaveBeenCalled();
    expect(boundClient).toHaveBeenCalledWith(primary, "owner", undefined);
    expect(securedUpdate).toHaveBeenCalledWith({ password: input.newPassword, current_password: input.currentPassword });
    expect(close).toHaveBeenCalledWith({ scope: "local" });
  });
  it("mutates an AAL1 account without MFA through the browser's own session so Auth keeps it signed in", async () => {
    security.mockResolvedValue({ allowed: true, required: false, current_aal: "aal1" });
    await changeOwnPassword(primary, "owner", input);
    expect(boundClient).toHaveBeenCalledWith(primary, "owner", undefined);
    expect(securedUpdate).toHaveBeenCalledWith({ password: input.newPassword, current_password: input.currentPassword });
    expect(update).not.toHaveBeenCalled();
  });
  it("rejects a newly required MFA challenge before password mutation", async () => {
    security.mockResolvedValueOnce({ allowed: true, required: false, current_aal: "aal1" }).mockResolvedValueOnce({ allowed: false, required: true, current_aal: "aal1" });
    await expect(changeOwnPassword(primary, "owner", input)).rejects.toThrow(/Verify your authenticator/);
    expect(update).not.toHaveBeenCalled(); expect(securedUpdate).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith({ scope: "local" });
  });
  it("enforces eight characters, bounded UTF-8 bytes, a new value and matching confirmation", () => {
    for (const patch of [{ currentPassword: "" }, { newPassword: "short", confirmation: "short" },
      { newPassword: "seven77", confirmation: "seven77" }, { newPassword: "😀".repeat(7), confirmation: "😀".repeat(7) },
      { newPassword: " ".repeat(8), confirmation: " ".repeat(8) }, { newPassword: " ".repeat(12), confirmation: " ".repeat(12) },
      { newPassword: "x".repeat(73), confirmation: "x".repeat(73) },
      { newPassword: "😀".repeat(19), confirmation: "😀".repeat(19) },
      { newPassword: input.currentPassword, confirmation: input.currentPassword }, { confirmation: "Different value" }]) {
      expect(validatePasswordChange({ ...input, ...patch })).not.toBeNull();
    }
    expect(validatePasswordChange({ ...input, newPassword: "seven77", confirmation: "seven77" })).toBe("Use at least 8 characters for your new password.");
    expect(validatePasswordChange({ ...input, newPassword: "x".repeat(73), confirmation: "x".repeat(73) })).toBe("That password is too long. Try a shorter password.");
    expect(validatePasswordChange({ ...input, newPassword: "eight888", confirmation: "eight888" })).toBeNull();
    expect(validatePasswordChange({ ...input, newPassword: "😀".repeat(8), confirmation: "😀".repeat(8) })).toBeNull();
    expect(validatePasswordChange({ ...input, newPassword: "x".repeat(72), confirmation: "x".repeat(72) })).toBeNull();
  });

  it("changes to an 8-character password and refuses a 7-character one before any Auth request", async () => {
    await expect(changeOwnPassword(primary, "owner", { ...input, newPassword: "seven77", confirmation: "seven77" })).rejects.toThrow(/at least 8 characters/);
    expect(getUser).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    expect(await changeOwnPassword(primary, "owner", { ...input, newPassword: "eight888", confirmation: "eight888" })).toEqual({ changed: true, temporarySessionClosed: true });
    expect(securedUpdate).toHaveBeenCalledExactlyOnceWith({ password: "eight888", current_password: input.currentPassword });
  });

  it("rejects invalid form values before any Auth request", async () => {
    await expect(changeOwnPassword(primary, "owner", { ...input, confirmation: "wrong" })).rejects.toThrow(/do not match/);
    expect(getUser).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });

  it("reauthenticates only the verified owner in a non-persistent isolated client", async () => {
    expect(await changeOwnPassword(primary, "owner", input)).toEqual({ changed: true, temporarySessionClosed: true });
    expect(create).toHaveBeenCalledWith("https://example.supabase.co", "test-publishable-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    expect(verify).toHaveBeenCalledWith({ email: owner.email, password: input.currentPassword });
    expect(getUser).toHaveBeenCalledTimes(2);
    expect(securedUpdate).toHaveBeenCalledWith({ password: input.newPassword, current_password: input.currentPassword });
    expect(update).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith({ scope: "local" });
  });

  it.each([null, { ...owner, id: "other" }, { ...owner, is_anonymous: true }, { ...owner, email: undefined }])("does not verify another or invalid identity %j", async (user) => {
    getUser.mockResolvedValue({ data: { user }, error: null });
    await expect(changeOwnPassword(primary, "owner", input)).rejects.toThrow(/account changed/);
    expect(create).not.toHaveBeenCalled(); expect(securedUpdate).not.toHaveBeenCalled();
  });

  it("requires a verified account email before creating temporary Auth", async () => {
    getUser.mockResolvedValue({ data: { user: { ...owner, email_confirmed_at: undefined } }, error: null });
    await expect(changeOwnPassword(primary, "owner", input)).rejects.toThrow(/Verify your account email/);
    expect(create).not.toHaveBeenCalled();
  });

  it("cannot use a valid password for a different returned user", async () => {
    verify.mockResolvedValue({ data: { user: { ...owner, id: "another" }, session: {} }, error: null });
    await expect(changeOwnPassword(primary, "owner", input)).rejects.toThrow(/account changed/);
    expect(securedUpdate).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledWith({ scope: "local" });
  });

  it.each([{ ...owner, id: "another" }, { ...owner, email: "changed@example.test" }, null])("rechecks original browser identity immediately before writing %j", async (user) => {
    getUser.mockResolvedValueOnce({ data: { user: owner }, error: null }).mockResolvedValueOnce({ data: { user }, error: null });
    await expect(changeOwnPassword(primary, "owner", input)).rejects.toThrow(/account changed/);
    expect(securedUpdate).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledWith({ scope: "local" });
  });

  it("aborts account changes before sending an update while still closing temporary Auth", async () => {
    const controller = new AbortController();
    verify.mockImplementationOnce(async () => { controller.abort(); return { data: { user: owner, session: {} }, error: null }; });
    await expect(changeOwnPassword(primary, "owner", input, controller.signal)).rejects.toThrow(/account changed/);
    expect(securedUpdate).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledWith({ scope: "local" });
  });

  it.each([
    { phase: "verify", code: "invalid_credentials", expected: /Current password could not be verified/ },
    { phase: "verify", code: "over_request_rate_limit", expected: /Too many attempts/ },
    { phase: "update", code: "weak_password", expected: /stronger new password/ },
    { phase: "update", code: "reauthentication_needed", expected: /Additional account verification/ },
    { phase: "update", code: "unexpected", expected: /could not be confirmed/ },
  ])("returns bounded feedback for $phase/$code without exposing server details", async ({ phase, code, expected }) => {
    (phase === "verify" ? verify : securedUpdate).mockResolvedValueOnce({ data: { user: null, session: null }, error: { code, message: "SECRET PROVIDER DETAIL" } });
    const call = changeOwnPassword(primary, "owner", input);
    await expect(call).rejects.toThrow(expected);
    await expect(call).rejects.not.toThrow(/SECRET/);
    expect(close).toHaveBeenCalledWith({ scope: "local" });
    if (phase === "verify") expect(securedUpdate).not.toHaveBeenCalled();
  });

  it("does not let local cleanup failure turn a confirmed password change into a failure", async () => {
    close.mockRejectedValueOnce(new Error("Network unavailable"));
    expect(await changeOwnPassword(primary, "owner", input)).toEqual({ changed: true, temporarySessionClosed: false });
  });

  it("closes only isolated Auth and retains account B if it signs in while A's temporary cleanup is pending", async () => {
    let resolveCleanup!: (value: { error: null }) => void;
    const cleanup = new Promise<{ error: null }>((resolve) => { resolveCleanup = resolve; });
    close.mockReturnValueOnce(cleanup);
    let activeUser: typeof owner | null = owner;
    const sharedSignOut = vi.fn(async () => { activeUser = null; return { error: null }; });
    const shared = { auth: { getUser: vi.fn(async () => ({ data: { user: activeUser }, error: null })), signOut: sharedSignOut } } as unknown as SupabaseClient;
    const change = changeOwnPassword(shared, "owner", input);
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith({ scope: "local" }));
    expect(securedUpdate).toHaveBeenCalledWith({ password: input.newPassword, current_password: input.currentPassword });
    activeUser = { ...owner, id: "account-b", email: "b@example.test" };
    resolveCleanup({ error: null });
    expect(await change).toEqual({ changed: true, temporarySessionClosed: true });
    expect(activeUser?.id).toBe("account-b");
    expect(sharedSignOut).not.toHaveBeenCalled();
  });

  it("does not acknowledge an update without the correct returned owner", async () => {
    securedUpdate.mockResolvedValueOnce({ data: { user: null }, error: null });
    await expect(changeOwnPassword(primary, "owner", input)).rejects.toThrow(/could not be confirmed/);
    expect(close).toHaveBeenCalledWith({ scope: "local" });
  });
});
