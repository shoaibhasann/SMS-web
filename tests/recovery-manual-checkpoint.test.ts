// @vitest-environment node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const source = (path: string) => readFile(new URL(path, root), "utf8");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const groups = ["schemas", "relations", "routines", "policies", "triggers", "enums", "domains", "sequences", "default_privileges"] as const;
type Catalog = Record<(typeof groups)[number], unknown[]>;

function normalize(value: unknown, key = ""): unknown {
  if (typeof value === "string") return value.replaceAll("\r", "");
  if (Array.isArray(value)) {
    // PG18 records NOT NULL as extra named constraints; compare column
    // not_null flags separately, preserving every other constraint exactly.
    const items = value.filter((entry) => key !== "constraints"
      || !entry || typeof entry !== "object" || entry.kind !== "n")
      .map((entry) => normalize(entry));
    return key === "acl" || key === "roles" ? items.sort() : items;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([name, item]) => [name, normalize(item, name)]));
  }
  return value;
}

function ordered(value: unknown[]) {
  return value.map((item) => normalize(item)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

it("reconstructs the complete pre-Nov2 application checkpoint from recorded SQL and explicit recovered manual state", async () => {
  const history = JSON.parse(await source("supabase/recovery/history-provenance.json")) as {
    recovered_missing_files: { version: string; path: string; sha256: string; category: string }[];
  };
  const manual = JSON.parse(await source("supabase/recovery/manual/provenance.json")) as {
    source_file: string; source_sha256: string;
    academic: { file: string; sha256: string };
    legacy_admin: { file: string; sha256: string };
  };
  const snapshotText = await source(manual.source_file);
  expect(sha256(snapshotText)).toBe(manual.source_sha256);
  const expected = JSON.parse(snapshotText) as Catalog;
  const schemaHistory = history.recovered_missing_files.filter((entry) => entry.category === "schema-history");
  expect(schemaHistory).toHaveLength(21);
  expect(schemaHistory.map((entry) => entry.version)).toEqual(schemaHistory.map((entry) => entry.version).toSorted());
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(await source("scripts/database-recovery/platform-contract.sql"));
    for (const entry of schemaHistory) {
      const sql = await source(entry.path);
      expect(sha256(sql), entry.path).toBe(entry.sha256);
      await db.exec(sql);
    }
    const academic = await source(manual.academic.file);
    expect(sha256(academic)).toBe(manual.academic.sha256);
    await db.exec(academic);
    await db.exec(await source("supabase/migrations/20261101_teacher_assessments_and_profile.sql"));
    const legacy = await source(manual.legacy_admin.file);
    expect(sha256(legacy)).toBe(manual.legacy_admin.sha256);
    await db.exec(legacy);

    const result = await db.query<{ schema_export: Catalog }>(await source("supabase/inspection/export-schema-metadata.sql"));
    const actual = result.rows[0].schema_export;
    for (const group of groups) expect(ordered(actual[group]), group).toEqual(ordered(expected[group]));
    expect(actual.relations).toHaveLength(72);
    expect(actual.policies).toHaveLength(178);
    expect(actual.triggers).toHaveLength(24);
    // Tenant-specific historical seeds are archival evidence, not a prerequisite
    // school identity silently inserted into a fresh recovery environment.
    expect((await db.query("select count(*)::int as total from public.schools")).rows).toEqual([{ total: 0 }]);
    expect((await db.query("select count(*)::int as total from auth.users")).rows).toEqual([{ total: 0 }]);
  } finally {
    await db.close();
  }
}, 15_000);
