import { beforeEach, describe, expect, it, vi } from "vitest";
import { guardianEmailContinuation } from "@/lib/auth/redirect";
import { GET } from "../app/(auth)/auth/callback/route";

const { createClient, finishContact } = vi.hoisted(() => ({
  createClient: vi.fn(), finishContact: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/auth/contact-change", () => ({ finishGuardianEmailChange: finishContact }));

function request(params: Record<string, string>) {
  const url = new URL("https://erp.example.test/auth/callback");
  url.search = new URLSearchParams({ next: guardianEmailContinuation, ...params }).toString();
  return new Request(url);
}

beforeEach(() => {
  vi.clearAllMocks(); finishContact.mockResolvedValue("email-returned");
});

describe("guardian email confirmation callback", () => {
  it("returns to the guardian profile after the first secure confirmation without exchanging a code", async () => {
    finishContact.mockResolvedValue("email-pending");
    const result = await GET(request({ message: "Confirmation link accepted. Please proceed to confirm link sent to the other email" }));
    expect(result.headers.get("location")).toBe("https://erp.example.test/modules/profile?view=guardian&contact=email-pending");
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("referrer-policy")).toBe("no-referrer");
    expect(finishContact).toHaveBeenCalledWith(expect.any(URL), null);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("uses the matching PKCE flow for the final confirmation", async () => {
    const result = await GET(request({ code: "code", sb_flow_id: "aabbccddeeff" }));
    expect(finishContact).toHaveBeenCalledWith(expect.any(URL), "code");
    expect(createClient).not.toHaveBeenCalled();
    expect(result.headers.get("location")).toBe("https://erp.example.test/modules/profile?view=guardian&contact=email-returned");
  });

  it("returns a safe, recoverable status when the link was opened without its verifier", async () => {
    finishContact.mockResolvedValue("email-link-error");
    const result = await GET(request({ code: "code" }));
    expect(result.headers.get("location")).toBe("https://erp.example.test/modules/profile?view=guardian&contact=email-link-error");
    expect(result.headers.get("location")).not.toContain("internal");
  });
});
