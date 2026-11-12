// @vitest-environment node
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("recovery manifest coverage", () => {
  it("lists every forward migration in the replay plan or the excluded archive", async () => {
    const manifest = JSON.parse(await readFile(new URL("../supabase/recovery/manifest.json", import.meta.url), "utf8")) as {
      plan: { path: string }[]; excluded?: { path: string }[];
    };
    const known = new Set([...manifest.plan, ...(manifest.excluded ?? [])].map((entry) => entry.path));
    const migrations = (await readdir(new URL("../supabase/migrations/", import.meta.url)))
      .filter((file) => file.endsWith(".sql"))
      .map((file) => `supabase/migrations/${file}`);
    expect(migrations.filter((file) => !known.has(file))).toEqual([]);
  });
});
