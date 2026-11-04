// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { cookies } = vi.hoisted(() => ({ cookies: vi.fn() }));
vi.mock("next/headers", () => ({ cookies }));

import { POST } from "../app/(auth)/auth/recovery/request/route";
import { sameOriginRecoveryPost } from "../lib/auth/recovery";

type Cookie = { name: string; value: string; options?: { httpOnly: boolean; secure: boolean; sameSite: string; path: string; maxAge: number } };

function browserCookies() {
  const ordinary = { name: "sb-fixture-auth-token", value: "existing-ordinary-session" };
  const values = new Map<string, Cookie>([[ordinary.name, ordinary]]);
  cookies.mockResolvedValue({
    getAll: () => Array.from(values.values()),
    set: (name: string, value: string, options: Cookie["options"]) => values.set(name, { name, value, options }),
  });
  return { ordinary, values };
}

function request(origin = "https://school.example") {
  return new Request(origin + "/auth/recovery/request", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "qa@school.example" }),
  });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fixture.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "fixture-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("recovery PKCE cookie isolation", () => {
  it("uses HTTPS or local loopback and rejects public plaintext origins", () => {
    expect(sameOriginRecoveryPost(request())).toBe("https://school.example");
    expect(sameOriginRecoveryPost(request("http://127.0.0.1:3114"))).toBe("http://127.0.0.1:3114");
    expect(sameOriginRecoveryPost(request("http://school.example"))).toBeNull();
  });

  it("keeps the same observable cookie shape after provider success and rejection", async () => {
    const callProvider = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "Rate limit", code: "over_email_send_rate_limit" }), {
        status: 429, headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", callProvider);

    const shapes = [];
    for (const expectedStatus of [200, 200]) {
      const { ordinary, values } = browserCookies();
      const response = await POST(request());
      expect(response.status).toBe(expectedStatus);
      expect(await response.json()).toEqual({ ok: true });
      expect(values.get(ordinary.name)).toEqual(ordinary);
      const issued = Array.from(values.values()).filter(({ name }) => name !== ordinary.name);
      expect(issued).toHaveLength(3);
      expect(issued.every(({ name, options }) => name.startsWith("__Host-kc-recovery-")
        && options?.httpOnly && options.secure && options.sameSite === "lax" && options.path === "/" && options.maxAge === 3600)).toBe(true);
      shapes.push(issued.map(({ name, value, options }) => ({
        name: name.replace(/-flow-[a-f0-9]+-/, "-flow-generated-"), length: value.length, options,
      })));
    }
    expect(shapes[1]).toEqual(shapes[0]);
    expect(callProvider).toHaveBeenCalledTimes(2);
    const [url, options] = callProvider.mock.calls[0];
    expect(new URL(String(url)).searchParams.get("redirect_to")).toBe("https://school.example/auth/callback?next=%2Fupdate-password");
    expect(JSON.parse(String(options.body))).toMatchObject({ code_challenge_method: "s256" });
  });
});
