import { readFile, readdir } from "node:fs/promises";
import { createStaffScopeDatabase } from "./staff-scope-fixture";

const directory = new URL("../../supabase/migrations/", import.meta.url);
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
type Relation = {
  schema: string; name: string; acl: string[] | null;
  columns: { name: string; type: string; not_null: boolean; default: string | null }[];
  constraints: { name: string; definition: string }[];
  indexes: { name: string; definition: string }[];
};
type Policy = { schemaname: string; tablename: string; policyname: string; permissive: string; cmd: string; roles: string[]; qual: string | null; with_check: string | null };

export async function readAcademicPermissionSql() {
  const files = (await readdir(directory)).filter((name) => name.endsWith("_harden_academic_assignment_permissions.sql"));
  if (files.length !== 1) throw new Error("Expected exactly one academic permission migration.");
  return readFile(new URL(files[0], directory), "utf8");
}

/** Recovered public contracts, including real submission FKs, original broad
 * policy and API grants; only Auth and JWT lookup use the bounded test shim. */
export async function createAcademicPermissionDatabase({ applyMigration = true } = {}) {
  const db = await createStaffScopeDatabase({ includeTeachingRpcs: true, applyGovernance: true });
  try {
    const snapshot: { relations: Relation[]; policies: Policy[] } = JSON.parse(await readFile(
      new URL("../../supabase/schema-snapshots/2026-11-02/schema-metadata.json", import.meta.url), "utf8"));
    const table = snapshot.relations.find((row) => row.schema === "public" && row.name === "activity_submissions");
    if (!table) throw new Error("Missing recovered submission contract.");
    await db.exec(`create table public.activity_submissions (${table.columns.map((column) => `${identifier(column.name)} ${column.type}${column.not_null ? " not null" : ""}${column.default ? ` default ${column.default}` : ""}`).join(",")})`);
    for (const constraint of table.constraints) await db.exec(`alter table public.activity_submissions add constraint ${identifier(constraint.name)} ${constraint.definition}`);
    const keys = new Set(table.constraints.map((constraint) => constraint.name));
    for (const index of table.indexes) if (!keys.has(index.name)) await db.exec(index.definition);
    for (const entry of table.acl ?? []) {
      const [, role, codes] = /^(.*?)=([^/]*)\//.exec(entry) ?? [];
      if (role !== "" && !["anon", "authenticated", "service_role"].includes(role)) continue;
      const rights = Object.entries({ a: "INSERT", r: "SELECT", w: "UPDATE", d: "DELETE", D: "TRUNCATE", x: "REFERENCES", t: "TRIGGER", m: "MAINTAIN" })
        .filter(([code]) => codes.includes(code)).map(([, value]) => value);
      if (rights.length) await db.exec(`grant ${rights.join(",")} on public.activity_submissions to ${role === "" ? "PUBLIC" : identifier(role)}`);
    }
    await db.exec("alter table public.activity_submissions enable row level security");
    for (const policy of snapshot.policies.filter((row) => row.schemaname === "public" && row.tablename === "activity_submissions")) {
      await db.exec(`create policy ${identifier(policy.policyname)} on public.activity_submissions as ${policy.permissive} for ${policy.cmd}
        to ${policy.roles.map((role) => role === "public" ? "PUBLIC" : identifier(role)).join(",")}
        ${policy.qual ? `using (${policy.qual})` : ""} ${policy.with_check ? `with check (${policy.with_check})` : ""}`);
    }
    const files = await readdir(directory);
    const repair = files.find((name) => name.endsWith("_repair_school_policy_helper.sql"));
    if (!repair) throw new Error("Missing policy helper repair migration.");
    await db.exec(await readFile(new URL(repair, directory), "utf8"));
    if (applyMigration) {
      await db.exec(await readAcademicPermissionSql());
      const refresh = files.find((name) => name.endsWith("_refresh_locked_academic_grading_scope.sql"));
      if (!refresh) throw new Error("Missing locked grading-scope refresh migration.");
      await db.exec(await readFile(new URL(refresh,directory),"utf8"));
      const privileges = files.find((name) => name.endsWith("_restrict_academic_submission_table_privileges.sql"));
      if (!privileges) throw new Error("Missing submission table-privilege hardening migration.");
      await db.exec(await readFile(new URL(privileges,directory),"utf8"));
      const conflict = files.find((name) => name.endsWith("_academic_optimistic_conflict_http_status.sql"));
      if (!conflict) throw new Error("Missing academic optimistic conflict HTTP correction.");
      await db.exec(await readFile(new URL(conflict,directory),"utf8"));
    }
    return db;
  } catch (error) { await db.close(); throw error; }
}
