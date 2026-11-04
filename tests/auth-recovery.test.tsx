import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createRecoveryClient, createOrdinaryClient, auth, clearSession } = vi.hoisted(() => ({
  createRecoveryClient: vi.fn(),
  createOrdinaryClient: vi.fn(),
  clearSession: vi.fn(),
  auth: {
    resetPasswordForEmail: vi.fn(),
    exchangeCodeForSession: vi.fn(),
    getClaims: vi.fn(),
    getUser: vi.fn(),
    updateUser: vi.fn(),
    signOut: vi.fn(),
  },
}));

vi.mock("@/lib/auth/recovery", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/auth/recovery")>(),
  createRecoveryClient,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: createOrdinaryClient }));

import { GET } from "../app/(auth)/auth/callback/route";
import { POST as requestRecovery } from "../app/(auth)/auth/recovery/request/route";
import { POST as completeRecovery } from "../app/(auth)/auth/recovery/complete/route";
import UpdatePasswordPage from "../app/(auth)/update-password/page";

const origin = "https://school.example";
const userId = "e0299e29-f65f-418b-82d5-963c37ebf097";
const sessionId = "bf950a64-92a4-484b-8358-4282b41305a1";
const issuedAt = () => Math.floor(Date.now() / 1000);

function setClaims(method = "recovery", timestamp = issuedAt()) {
  auth.getClaims.mockResolvedValue({
    data: { claims: { sub: userId, session_id: sessionId, role: "authenticated", amr: [{ method, timestamp }] } },
    error: null,
  });
}

function post(path: string, payload: unknown, requestOrigin = origin) {
  return new Request(origin + "/auth/recovery/" + path, {
    method: "POST", headers: { Origin: requestOrigin, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function callback(params: Record<string, string> = {}) {
  const url = new URL("/auth/callback", origin);
  url.search = new URLSearchParams({ next: "/update-password", ...params }).toString();
  return new Request(url);
}

beforeEach(() => {
  vi.resetAllMocks();
  createRecoveryClient.mockResolvedValue({ supabase: { auth }, clearSession });
  auth.exchangeCodeForSession.mockResolvedValue({
    data: { session: { access_token: "signed-credential" }, user: { id: userId }, redirectType: "recovery" },
    error: null,
  });
  auth.getUser.mockResolvedValue({ data: { user: { id: userId, is_anonymous: false } }, error: null });
  auth.updateUser.mockResolvedValue({ error: null });
  auth.signOut.mockResolvedValue({ error: null });
  setClaims();
});

describe("requesting a password reset", () => {
  it("keeps the same response for provider success, unknown user and delivery failure", async () => {
    auth.resetPasswordForEmail.mockResolvedValueOnce({ error: null });
    auth.resetPasswordForEmail.mockResolvedValueOnce({ error: { message: "User does not exist" } });
    auth.resetPasswordForEmail.mockRejectedValueOnce(new Error("Internal mail delivery diagnostic"));
    for (const email of ["present@school.example", "missing@school.example", "disabled@school.example"]) {
      const response = await requestRecovery(post("request", { email, redirectTo: "https://attacker.example" }));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ ok: true });
    }
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith("present@school.example", {
      redirectTo: origin + "/auth/callback?next=%2Fupdate-password",
    });
    expect(createRecoveryClient).toHaveBeenCalledWith(true, true);
    expect(createOrdinaryClient).not.toHaveBeenCalled();
  });

  it("rejects cross-origin requests before contacting the provider", async () => {
    expect((await requestRecovery(post("request", { email: "present@school.example" }, "https://attacker.example"))).status).toBe(403);
    expect((await requestRecovery(post("request", { email: "invalid" }))).status).toBe(400);
    expect(createRecoveryClient).not.toHaveBeenCalled();
  });
});

describe("recovery callback and form", () => {
  it("accepts a recent provider recovery claim and cleans the callback URL", async () => {
    const response = await GET(callback({ code: "recovery-code", sb_flow_id: "aabbccddeeff" }));
    expect(response.headers.get("location")).toBe(origin + "/update-password");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith("recovery-code", { flowId: "aabbccddeeff" });
    expect(auth.getClaims).toHaveBeenCalledWith("signed-credential");
    expect(auth.getUser).toHaveBeenCalledWith("signed-credential");
    expect(createOrdinaryClient).not.toHaveBeenCalled();
    expect(renderToString(await UpdatePasswordPage())).toContain("New password");
  });

  it.each(["password", "oauth", "otp"])("rejects %s sessions even with a forged recovery hint", async (method) => {
    setClaims(method);
    const response = await GET(callback({ code: "unrelated-code", type: "recovery" }));
    expect(response.headers.get("location")).toBe(origin + "/forgot-password?error=invalid_recovery");
    expect(clearSession).toHaveBeenCalledOnce();
    expect(createOrdinaryClient).not.toHaveBeenCalled();
    const html = renderToString(await UpdatePasswordPage());
    expect(html).toContain("Request a reset link");
    expect(html).not.toContain("New password");
  });

  it("rejects missing/expired codes and out-of-date or mismatched recovery sessions", async () => {
    expect((await GET(callback())).headers.get("location")).toBe(origin + "/forgot-password?error=invalid_recovery");
    expect(createRecoveryClient).not.toHaveBeenCalled();
    auth.exchangeCodeForSession.mockResolvedValueOnce({ data: { session: null }, error: { message: "Expired" } });
    expect((await GET(callback({ code: "expired" }))).headers.get("location")).toBe(origin + "/forgot-password?error=invalid_recovery");
    setClaims("recovery", issuedAt() - 901);
    expect((await GET(callback({ code: "stale" }))).headers.get("location")).toBe(origin + "/forgot-password?error=invalid_recovery");
    setClaims();
    auth.getUser.mockResolvedValue({ data: { user: { id: "another-user" } }, error: null });
    expect((await GET(callback({ code: "wrong-account" }))).headers.get("location")).toBe(origin + "/forgot-password?error=invalid_recovery");
  });
});

describe("completing a password reset", () => {
  const password = "example-strong-123!";

  it("updates only the verified form session, then closes that recovery session", async () => {
    const response = await completeRecovery(post("complete", { password, sessionId }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(auth.updateUser).toHaveBeenCalledOnce();
    expect(auth.updateUser).toHaveBeenCalledWith({ password });
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(clearSession).toHaveBeenCalledOnce();
    expect(createOrdinaryClient).not.toHaveBeenCalled();
  });

  it("denies regular login, another tab's session, stale recovery and cross-origin POST", async () => {
    expect((await completeRecovery(post("complete", { password, sessionId }, "https://attacker.example"))).status).toBe(403);
    expect((await completeRecovery(post("complete", { password, sessionId: "other-tab" }))).status).toBe(403);
    setClaims("password");
    expect((await completeRecovery(post("complete", { password, sessionId }))).status).toBe(403);
    setClaims("recovery", issuedAt() - 901);
    expect((await completeRecovery(post("complete", { password, sessionId }))).status).toBe(403);
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it("allows retry after password validation and returns success if signout fails after the update", async () => {
    expect((await completeRecovery(post("complete", { password: "short", sessionId }))).status).toBe(400);
    auth.updateUser.mockResolvedValueOnce({ error: { code: "same_password", message: "Internal provider message" } });
    const invalid = await completeRecovery(post("complete", { password, sessionId }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_password" });
    expect(clearSession).not.toHaveBeenCalled();
    auth.signOut.mockRejectedValueOnce(new Error("temporary provider error"));
    expect((await completeRecovery(post("complete", { password, sessionId }))).status).toBe(200);
    expect(clearSession).toHaveBeenCalledOnce();
  });
});
