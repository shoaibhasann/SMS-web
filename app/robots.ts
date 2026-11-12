import type { MetadataRoute } from "next";

// Internal QA checklists in public/qa stay reachable by direct link but must not be indexed.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/qa/" } };
}
