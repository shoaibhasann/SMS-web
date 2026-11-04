import { beforeEach, describe, expect, it, vi } from "vitest";
import { guardianEmailContinuation } from "@/lib/auth/redirect";
import { GET } from "../app/(auth)/auth/callback/route";

const { createClient, exchangeCodeForSession } = vi.hoisted(() => ({
  createClient: vi.fn(), exchangeCodeForSession: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

function request(params: Record<string, string>) {
  const url = new URL("https://erp.example.test/auth/callback");
  url.search = new URLSearchParams({ next: guardianEmailContinuation, ...params }).toString();
  return new Request(url);
}

beforeEach(() => {
  createClient.mockResolvedValue({ auth: { exchangeCodeForSession } });
  exchangeCodeForSession.mockResolvedValue({ data: { session: { user: { id: "guardian" } } }, error: null });
});

describe("guardian email confirmation callback", () => {
  it("returns to the guardian profile after the first secure confirmation without exchanging a code", async () => {
    const result = await GET(request({ message: "Confirmation link accepted. Please proceed to confirm link sent to the other email" }));
    expect(result.headers.get("location")).toBe("https://erp.example.test/modules/profile?view=guardian&contact=email-pending");
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("referrer-policy")).toBe("no-referrer");
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("uses the matching PKCE flow for the final confirmation", async () => {
    const result = await GET(request({ code: "code", sb_flow_id: "flow" }));
    expect(exchangeCodeForSession).toHaveBeenCalledExactlyOnceWith("code", { flowId: "flow" });
    expect(result.headers.get("location")).toBe("https://erp.example.test/modules/profile?view=guardian&contact=email-returned");
  });

  it("returns a safe, recoverable status when the link was opened without its verifier", async () => {
    exchangeCodeForSession.mockResolvedValue({ data: { session: null }, error: { message: "internal diagnostic" } });
    const result = await GET(request({ code: "code" }));
    expect(result.headers.get("location")).toBe("https://erp.example.test/modules/profile?view=guardian&contact=email-link-error");
    expect(result.headers.get("location")).not.toContain("internal");
  });
});
