import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const inspectionSql = new URL("../../supabase/inspection/export-schema-metadata.sql", import.meta.url);
const sections = ["schemas", "relations", "enums", "domains", "routines", "triggers", "policies", "sequences", "default_privileges"];

function canonical(value) {
  if (typeof value === "string") return value.replaceAll("\r\n", "\n");
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function acl(value) {
  return value == null ? null : [...value].sort();
}

/** Application objects plus app-owned Auth/Storage hooks; no application rows. */
export async function captureCatalog(db) {
  const result = await db.query(await readFile(inspectionSql, "utf8"));
  const catalog = result.rows[0]?.schema_export;
  if (!catalog) throw new Error("The complete application catalog could not be captured.");
  return catalog;
}

export function catalogFingerprint(catalog) {
  if (catalog?.format !== "kids-corner-schema-metadata/v1"
    || sections.some((section) => !Array.isArray(catalog[section]))
    || (catalog.ranges !== undefined && !Array.isArray(catalog.ranges))) {
    throw new Error("Incomplete or unsupported application catalog.");
  }
  const entries = [];
  const add = (kind, identity, value) => entries.push({ key: `${kind}:${JSON.stringify(identity)}`, sha256: hash(value) });
  for (const schema of catalog.schemas) add("schema", [schema.name], { ...schema, acl: acl(schema.acl) });
  for (const relation of catalog.relations) {
    if (!["r", "v"].includes(relation.kind) || relation.parents?.length
      || relation.partition_key || relation.partition_bound) {
      throw new Error(`Unsupported recovery relation kind: ${relation.schema}.${relation.name}.`);
    }
    const columns = [...relation.columns].sort((a, b) => a.position - b.position).map((column) => ({ ...column, acl: acl(column.acl) }));
    // PG18 records NOT NULL constraints separately; column flags already retain
    // the same invariant when comparing the hosted PG17 source with PGlite.
    const constraints = relation.constraints.filter((item) => item.kind !== "n").sort((a, b) => a.name.localeCompare(b.name));
    add("relation", [relation.schema, relation.name], { ...relation, acl: acl(relation.acl),
      options: relation.options == null ? null : [...relation.options].sort(), columns, constraints,
      indexes: [...relation.indexes].sort((a, b) => a.name.localeCompare(b.name)) });
  }
  for (const item of catalog.enums) add("enum", [item.schema, item.name], item);
  for (const item of catalog.domains) add("domain", [item.schema, item.name], item);
  // Older snapshots have no custom ranges. New scheduling exclusions depend
  // on the subtype and range privileges, not only their index definitions.
  for (const item of catalog.ranges ?? []) add("range", [item.schema, item.name], {
    ...item, acl: acl(item.acl), multirange_acl: acl(item.multirange_acl),
  });
  for (const item of catalog.routines) add("routine", [item.schema, item.name, item.identity_arguments], {
    ...item, acl: acl(item.acl), settings: item.settings == null ? null : [...item.settings].sort(),
  });
  for (const item of catalog.triggers) add("trigger", [item.schema, item.table, item.name], item);
  for (const item of catalog.policies) add("policy", [item.schemaname, item.tablename, item.policyname], { ...item, roles: [...item.roles].sort() });
  for (const item of catalog.sequences) add("sequence", [item.schema, item.name], item);
  for (const item of catalog.default_privileges) add("default-privilege", [item.owner, item.schema, item.object_kind], { ...item, acl: acl(item.acl) });
  entries.sort((a, b) => a.key.localeCompare(b.key));
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length) throw new Error("Duplicate catalog identities cannot be verified.");
  return { format: "sms-application-catalog-fingerprint/v1", entries, sha256: hash(entries) };
}

export function validateCatalogFingerprint(value) {
  if (value?.format !== "sms-application-catalog-fingerprint/v1" || !Array.isArray(value.entries)
    || value.entries.some((entry) => typeof entry?.key !== "string" || !entry.key || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? ""))
    || new Set(value.entries.map((entry) => entry.key)).size !== value.entries.length
    || value.sha256 !== hash(value.entries)) {
    throw new Error("Invalid catalog fingerprint or integrity digest.");
  }
  return value;
}

export function compareCatalogFingerprints(expected, actual) {
  validateCatalogFingerprint(expected);
  validateCatalogFingerprint(actual);
  if (actual.format !== expected.format) {
    throw new Error("Unsupported catalog fingerprint format.");
  }
  const before = new Map(expected.entries.map((entry) => [entry.key, entry.sha256]));
  const after = new Map(actual.entries.map((entry) => [entry.key, entry.sha256]));
  return {
    added: [...after.keys()].filter((key) => !before.has(key)),
    removed: [...before.keys()].filter((key) => !after.has(key)),
    changed: [...before.keys()].filter((key) => after.has(key) && after.get(key) !== before.get(key)),
  };
}
