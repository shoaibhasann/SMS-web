import { beforeEach, describe, expect, it, vi } from "vitest";
import { safeAuthRedirect } from "../lib/auth/redirect";

const { exchangeCodeForSession, createClient } = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

import { GET } from "../app/(auth)/auth/callback/route";

describe("safeAuthRedirect", () => {
  it.each([
    null,
    "",
    "https://attacker.example/path",
    "https://school.example/dashboard",
    "//attacker.example/path",
    "///attacker.example/path",
    "dashboard",
    "javascript:alert(1)",
    "\\\\attacker.example/path",
    "/\\attacker.example/path",
    "/%5cattacker.example/path",
    "/%255cattacker.example/path",
    "/%2fattacker.example/path",
    "/%252fattacker.example/path",
    "/%2e%2e//attacker.example/path",
    "/%00/dashboard",
    "/%0d%0a//attacker.example",
    "/dashboard\n//attacker.example",
    "/%E0%A4%A",
    "/%25252525252fattacker.example",
  ])("falls back for unsafe or missing destination %j", (next) => {
    expect(safeAuthRedirect(next)).toBe("/dashboard");
  });

  it.each([
    "/",
    "/dashboard",
    "/activate",
    "/update-password",
    "/update-password?source=recovery",
    "/modules/homework?view=latest#today",
    "/modules/study-material?returnTo=https%3A%2F%2Fexample.test",
    "/modules/lesson%20one",
  ])("preserves legitimate internal destination %s", (next) => {
    expect(safeAuthRedirect(next)).toBe(next);
  });
});

describe("auth callback", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    createClient.mockResolvedValue({ auth: { exchangeCodeForSession } });
    exchangeCodeForSession.mockResolvedValue({ data: { session: { access_token: "test-token" } }, error: null });
  });

  function request(params: Record<string, string>) {
    const url = new URL("https://school.example/auth/callback");
    url.search = new URLSearchParams(params).toString();
    return new Request(url);
  }

  it("sends a missing code to login without opening an auth client", async () => {
    const response = await GET(request({ next: "https://attacker.example" }));
    expect(response.headers.get("location")).toBe("https://school.example/login?error=auth_callback_missing_code");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("handles provider rejection without exchanging a supplied code", async () => {
    const response = await GET(request({ code: "unused", error: "access_denied", next: "/dashboard" }));
    expect(response.headers.get("location")).toBe("https://school.example/login?error=auth_callback_failed");
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("does not follow next when code exchange fails", async () => {
    exchangeCodeForSession.mockResolvedValue({ data: { session: null }, error: { message: "expired code" } });
    const response = await GET(request({ code: "expired", next: "/modules/homework" }));
    expect(response.headers.get("location")).toBe("https://school.example/login?error=auth_callback_failed");
  });

  it("handles unexpected provider errors without leaking details", async () => {
    exchangeCodeForSession.mockRejectedValue(new Error("private provider diagnostic"));
    const response = await GET(request({ code: "broken", next: "/dashboard" }));
    expect(response.headers.get("location")).toBe("https://school.example/login?error=auth_callback_failed");
  });

  it("requires a session even when the provider returns no error", async () => {
    exchangeCodeForSession.mockResolvedValue({ data: { session: null }, error: null });
    const response = await GET(request({ code: "empty", next: "/dashboard" }));
    expect(response.headers.get("location")).toBe("https://school.example/login?error=auth_callback_failed");
  });

  it.each(["https://attacker.example", "//attacker.example", "/%255cattacker.example"])(
    "keeps successful exchange on the school origin for unsafe next %s",
    async (next) => {
      const response = await GET(request({ code: "valid", next }));
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe("https://school.example/dashboard");
      expect(exchangeCodeForSession).toHaveBeenCalledWith("valid");
    },
  );

  it.each(["/guardian-invite", "/teacher-invite"])("returns to %s after successful email confirmation", async (next) => {
    const response = await GET(request({ code: "signup", next }));
    expect(response.headers.get("location")).toBe(`https://school.example${next}`);
  });

  it("keeps guardian instructions available when the confirmation link opens without its verifier", async () => {
    exchangeCodeForSession.mockResolvedValue({ data: { session: null }, error: { message: "Missing PKCE verifier" } });
    const response = await GET(request({ code: "signup", next: "/guardian-invite" }));
    expect(response.headers.get("location")).toBe("https://school.example/guardian-invite");
  });

  it("uses the dashboard after a successful exchange with no next", async () => {
    const response = await GET(request({ code: "valid" }));
    expect(response.headers.get("location")).toBe("https://school.example/dashboard");
  });
});
