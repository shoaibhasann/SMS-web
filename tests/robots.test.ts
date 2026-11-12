// @vitest-environment node
import { describe, expect, it } from "vitest";
import robots from "../app/robots";
import nextConfig from "../next.config";

describe("internal QA checklists are not indexed", () => {
  it("robots.txt disallows /qa/ without blocking app routes", () => {
    const rules = [robots().rules].flat();
    const disallow = rules.flatMap((rule) => [rule.disallow ?? []].flat());
    expect(disallow).toContain("/qa/");
    expect(disallow).not.toContain("/");
  });

  it("serves X-Robots-Tag noindex on /qa/* only", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const qa = rules.find((rule) => rule.source === "/qa/:path*");
    expect(qa?.headers).toContainEqual({ key: "X-Robots-Tag", value: expect.stringContaining("noindex") });
    expect(rules.filter((rule) => rule.source !== "/qa/:path*").flatMap((rule) => rule.headers.map((h) => h.key))).not.toContain("X-Robots-Tag");
  });
});
