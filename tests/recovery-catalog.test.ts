// @vitest-environment node
import { describe, expect, it } from "vitest";
import { catalogFingerprint, compareCatalogFingerprints, validateCatalogFingerprint } from "../scripts/database-recovery/catalog.mjs";

function catalog() {
  return { format: "kids-corner-schema-metadata/v1", schemas: [{ name: "public", owner: "pg_database_owner", acl: ["anon=U/postgres", "authenticated=U/postgres"] }],
    relations: [{ schema: "public", name: "pupils", kind: "r", owner: "postgres", rls_enabled: true, rls_forced: false, parents: [], partition_key: null, partition_bound: null,
      options: null, acl: ["authenticated=r/postgres"], columns: [{ position: 1, name: "id", type: "uuid", not_null: true, acl: null }], constraints: [], indexes: [] }],
    enums: [], domains: [], routines: [], triggers: [], policies: [], sequences: [], default_privileges: [] };
}

describe("application recovery catalog fingerprints", () => {
  it("is independent of capture time, database/version labels and ACL ordering", () => {
    const original = catalog();
    const reordered = { ...catalog(), captured_at: "later", server_version: "18.6", database: "temporary" };
    reordered.schemas[0].acl.reverse();
    expect(catalogFingerprint(reordered)).toEqual(catalogFingerprint(original));
  });
  it.each(["rls_enabled", "rls_forced"] as const)("detects changed %s rather than matching row counts", (flag) => {
    const original = catalog();
    const changed = catalog();
    changed.relations[0][flag] = !changed.relations[0][flag];
    expect(compareCatalogFingerprints(catalogFingerprint(original), catalogFingerprint(changed)).changed).toHaveLength(1);
  });
  it("detects schema, privilege, column and policy drift", () => {
    const original = catalog();
    const changed = catalog();
    changed.relations[0].acl.push("anon=arwd/postgres");
    changed.relations[0].columns[0].not_null = false;
    changed.schemas[0].acl = [];
    const result = compareCatalogFingerprints(catalogFingerprint(original), catalogFingerprint(changed));
    expect(result.changed).toHaveLength(2);
  });
  it("treats PG18 NOT NULL catalog rows as the already captured column invariant", () => {
    const original = catalog();
    const pg18 = catalog();
    pg18.relations[0].constraints = [{ kind: "n", name: "pupils_id_not_null" }] as never[];
    expect(catalogFingerprint(pg18)).toEqual(catalogFingerprint(original));
  });
  it("fails closed on incomplete input, unsupported relation kinds and duplicate identities", () => {
    expect(() => catalogFingerprint({ format: "kids-corner-schema-metadata/v1" })).toThrow(/Incomplete/);
    const unsupported = catalog(); unsupported.relations[0].kind = "p";
    expect(() => catalogFingerprint(unsupported)).toThrow(/Unsupported/);
    const duplicate = catalog(); duplicate.relations.push({ ...duplicate.relations[0] });
    expect(() => catalogFingerprint(duplicate)).toThrow(/Duplicate/);
  });
  it("reports added and removed objects separately", () => {
    const original = catalog();
    const changed = catalog(); changed.relations[0].name = "receipts";
    const result = compareCatalogFingerprints(catalogFingerprint(original), catalogFingerprint(changed));
    expect(result.added).toHaveLength(1); expect(result.removed).toHaveLength(1); expect(result.changed).toEqual([]);
  });
  it("rejects a fingerprint with altered entries or a forged digest", () => {
    const expected = catalogFingerprint(catalog());
    const altered = structuredClone(expected);
    altered.entries[0].sha256 = "0".repeat(64);
    expect(() => compareCatalogFingerprints(altered, expected)).toThrow(/integrity/);
    expect(() => validateCatalogFingerprint({ ...expected, sha256: "0".repeat(64) })).toThrow(/integrity/);
  });
  it("fingerprints custom range semantics and privileges while retaining older snapshots", () => {
    const range = { schema: "app_private", name: "section_range", owner: "postgres", subtype: "uuid",
      subtype_opclass: "pg_catalog.uuid_ops", canonical: "-", subtype_diff: "-", collation: "-",
      multirange: "app_private.section_multirange", multirange_owner: "postgres", acl: ["postgres=U/postgres"],
      multirange_acl: ["postgres=U/postgres"] };
    const original = { ...catalog(), ranges: [range] };
    expect(catalogFingerprint({ ...catalog(), ranges: [] })).toEqual(catalogFingerprint(catalog()));
    for (const change of [{ subtype: "text" }, { acl: ["=U/postgres"] }, { multirange_acl: ["=U/postgres"] }]) {
      const changed = { ...catalog(), ranges: [{ ...range, ...change }] };
      expect(compareCatalogFingerprints(catalogFingerprint(original), catalogFingerprint(changed)).changed).toHaveLength(1);
    }
    expect(() => catalogFingerprint({ ...catalog(), ranges: null })).toThrow(/Incomplete/);
  });
});
