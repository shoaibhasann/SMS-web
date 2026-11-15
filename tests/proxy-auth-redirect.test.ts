// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { proxy } from "@/proxy";

const { createServerClient, getClaims } = vi.hoisted(() => ({ createServerClient: vi.fn(), getClaims: vi.fn() }));
vi.mock("@supabase/ssr", () => ({ createServerClient }));

const visit = (path: string) => proxy(new NextRequest(`https://sms.test${path}`));

beforeEach(() => {
  getClaims.mockResolvedValue({ data: null, error: null });
  createServerClient.mockReturnValue({ auth: { getClaims } });
});

describe("proxy sign-in redirect", () => {
  it.each([
    ["/modules/homework?activity=a&view=guardian", "https://sms.test/login?next=%2Fmodules%2Fhomework%3Factivity%3Da%26view%3Dguardian"],
    ["/dashboard", "https://sms.test/login"],
    ["/activate", "https://sms.test/login"],
    ["/account/settings", "https://sms.test/login?next=%2Faccount%2Fsettings"],
  ])("sends a signed-out visit to %s to sign-in", async (path, location) => {
    const response = await visit(path);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(location);
  });

  it.each([
    ["a session", { data: { claims: { sub: "owner" } }, error: null }],
    ["a failed session check", { data: null, error: new Error("JWKS unavailable") }],
    ["a thrown non-Auth error", new Error("WebCrypto unavailable")],
  ])("leaves the page to its own gate when getClaims reports %s", async (_case, result) => {
    if (result instanceof Error) getClaims.mockRejectedValue(result); else getClaims.mockResolvedValue(result);
    const response = await visit("/modules/homework");
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it.each([
    "/", "/login", "/mfa", "/forgot-password", "/update-password", "/guardian-invite", "/teacher-invite",
    "/auth/callback", "/api/push/cron", "/robots.txt", "/no-such-page", "/modules/Bad",
  ])("never redirects a signed-out visit to %s", async (path) => {
    const response = await visit(path);
    expect(getClaims).toHaveBeenCalledOnce();
    expect(response.headers.get("location")).toBeNull();
  });

  it("keeps cookies written while checking the session on the redirect", async () => {
    getClaims.mockImplementation(async () => {
      // Supabase clears a stale session through the cookie adapter it was given.
      createServerClient.mock.lastCall![2].cookies.setAll([{ name: "sb-fixture-auth-token", value: "", options: { maxAge: 0, path: "/" } }]);
      return { data: null, error: null };
    });
    const response = await visit("/modules/homework");
    expect(response.headers.get("location")).toBe("https://sms.test/login?next=%2Fmodules%2Fhomework");
    expect(response.cookies.get("sb-fixture-auth-token")).toMatchObject({ value: "", maxAge: 0, path: "/" });
  });
});
