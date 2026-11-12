// @vitest-environment node
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

async function allRouteHeaders() {
  const rules = (await nextConfig.headers?.()) ?? [];
  const rule = rules.find((r) => r.source === "/:path*");
  return new Map((rule?.headers ?? []).map((h) => [h.key, h.value]));
}

describe("security headers on every route", () => {
  it("blocks framing and sets the baseline hardening headers", async () => {
    const headers = await allRouteHeaders();
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()");
  });

  it("ships the full CSP as Report-Only with the sources the app needs", async () => {
    const csp = (await allRouteHeaders()).get("Content-Security-Policy-Report-Only") ?? "";
    const directive = (name: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? "";
    expect(directive("default-src")).toBe("default-src 'self'");
    expect(directive("script-src")).toContain("https://challenges.cloudflare.com");
    expect(directive("frame-src")).toContain("https://challenges.cloudflare.com");
    expect(directive("connect-src")).toMatch(/supabase\.co/);
    expect(directive("img-src")).toContain("data:");
    expect(directive("object-src")).toBe("object-src 'none'");
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
  });
});
