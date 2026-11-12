// @vitest-environment node
import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createCreditDatabase } from "./advance-credit-fixture";
import { createGovernedFeeDatabase, GOVERNED_FEE_MIGRATIONS as governed } from "./governed-office-fees-fixture";

const directory = new URL("../../supabase/migrations/", import.meta.url);
const definitions = /create\s+(?:or\s+replace\s+)?function\s+([a-z_]+)\.([a-z_0-9]+)\s*\([\s\S]*?\bas\s+(\$[a-z_]*\$)([\s\S]*?)\3/gi;

// Latest body (filename = replay order) of every function a fee fixture migration defines, taking
// the fixture's own migrations plus everything after advance credit (the last one either fixture names).
async function latestBodies(baseSuffixes: string[]) {
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()
    .filter((file) => file > "20261105170615_office_student_advance_credit.sql" || baseSuffixes.some((suffix) => file.endsWith(suffix)));
  const base = new Set<string>(), latest = new Map<string, { file: string; body: string }>();
  for (const file of files) {
    const sql = await readFile(new URL(file, directory), "utf8");
    for (const [, schema, name, , body] of sql.matchAll(definitions)) {
      const key = `${schema}.${name}`.toLowerCase();
      if (baseSuffixes.some((suffix) => file.endsWith(suffix))) base.add(key);
      latest.set(key, { file, body });
    }
  }
  return [...base].map((key) => ({ key, ...latest.get(key)! }));
}


describe("office fee DB fixtures", () => {
  it.each([
    ["governed office fees", createGovernedFeeDatabase, governed],
    ["advance credit", createCreditDatabase, [...governed, "_office_student_advance_credit.sql"]],
  ] as const)("%s fixture runs on the latest definition of every fee function it creates", async (_name, create, suffixes) => {
    const fixture = await create();
    try {
      const expected = await latestBodies([...suffixes]);
      expect(expected.map((row) => row.file)).toContain("20261111190300_page_office_fee_reads_before_projection.sql");
      for (const { key, file, body } of expected) {
        const [schema, name] = key.split(".");
        const sources = (await fixture.db.query<{ src: string }>("select p.prosrc as src from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1 and p.proname=$2", [schema, name])).rows.map((row) => row.src);
        expect(sources, `${key} should come from ${file}`).toContain(body);
      }
    } finally { await fixture.db.close(); }
  }, 120_000);
});
