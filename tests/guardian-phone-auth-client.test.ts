import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeIndianMobile, phoneAuthError, prepareGuardianPhoneRequest, readGuardianPhoneStatus } from "@/lib/auth/phone";

const fetchMock = vi.fn();
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());

describe("guardian phone authentication client", () => {
  it.each(["9876540001", "98765 40001", "+91 (98765) 40001", "919876540001"])("canonicalizes Indian mobile %s", (input) => {
    expect(normalizeIndianMobile(input)).toBe("+919876540001");
  });

  it.each(["", "1234567890", "987654000", "+12025550100", "+9198765400010", "91-98765-letter"])("rejects unsupported number %s", (input) => {
    expect(normalizeIndianMobile(input)).toBeNull();
  });

  it("reads uncached readiness with the caller's cancellation signal", async () => {
    const signal = new AbortController().signal;
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ enabled: false, captchaSiteKey: null }) });
    await expect(readGuardianPhoneStatus(signal)).resolves.toEqual({ enabled: false, captchaSiteKey: null });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/auth/phone/status", { cache: "no-store", signal });
  });

  it.each([
    null, {}, { enabled: "true", captchaSiteKey: "key" }, { enabled: true, captchaSiteKey: null },
    { enabled: true, captchaSiteKey: "" }, { enabled: true, captchaSiteKey: "x".repeat(201) },
  ])("fails closed on malformed or incomplete provider status (%j)", async (status) => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => status });
    await expect(readGuardianPhoneStatus()).rejects.toThrow();
  });

  it("sends only a canonical destination and CAPTCHA proof to the server permit endpoint", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await prepareGuardianPhoneRequest("98765 40001", "fresh-proof");
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/auth/phone/permit", {
      method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
      body: JSON.stringify({ phone: "+919876540001", captchaToken: "fresh-proof" }),
    });
  });

  it.each([["invalid", "proof"], ["9876540001", ""], ["9876540001", "x".repeat(2049)]])(
    "rejects bad permit input before the network", async (phone, proof) => {
      await expect(prepareGuardianPhoneRequest(phone, proof)).rejects.toThrow("security check");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([[429, /Too many code requests/], [400, /security check could not be confirmed/], [503, /security check could not be confirmed/]])(
    "provides safe actionable permit failure feedback (%s)", async (status, message) => {
      fetchMock.mockResolvedValue({ ok: false, status });
      await expect(prepareGuardianPhoneRequest("9876540001", "proof")).rejects.toThrow(message);
    },
  );

  it("does not expose provider/account details in login or verification errors", () => {
    expect(phoneAuthError({ code: "phone_not_found" })).toContain("school-verified number");
    expect(phoneAuthError({ code: "otp_expired" }, true)).toContain("could not be verified");
    expect(phoneAuthError({ status: 429 }, true)).toContain("Too many attempts");
  });
});
