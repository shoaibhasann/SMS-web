import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

type Snapshot = {
  enums: { schema: string; name: string; labels: string[] }[];
  relations: {
    schema: string;
    name: string;
    acl: string[];
    columns: { name: string; type: string; not_null: boolean; default: string | null }[];
    constraints: { name: string; definition: string }[];
  }[];
  routines: { schema: string; name: string; definition: string }[];
  policies: {
    schemaname: string;
    tablename: string;
    policyname: string;
    permissive: string;
    cmd: string;
    roles: string[];
    qual: string | null;
    with_check: string | null;
  }[];
};

const uuid = (value: number) => `00000000-0000-0000-0000-${String(value).padStart(12, "0")}`;

export const IDS = {
  schoolA: uuid(1),
  schoolB: uuid(2),
  superAdmin: uuid(10),
  adminA: uuid(11),
  adminB: uuid(12),
  teacherA: uuid(13),
  teacherB: uuid(14),
  parentA: uuid(15),
  studentA: uuid(16),
  targetUser: uuid(17),
} as const;

const migrationDirectory = new URL("../../supabase/migrations/", import.meta.url);
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

export async function readRoleHardeningSql(): Promise<string> {
  const files = (await readdir(migrationDirectory))
    .filter((name) => /^\d+_harden_school_role_assignment\.sql$/.test(name));
  if (files.length !== 1) throw new Error("Expected one role-permission hardening migration.");
  return readFile(new URL(files[0], migrationDirectory), "utf8");
}

/**
 * Replays the supplied role table, enum, relevant helper definitions and RLS.
 * Only auth.users/schools identifiers and JWT subject lookup are synthetic.
 * This is a local PostgreSQL policy test, not an Auth API or deployed-RLS test.
 */
export async function createRoleTestDatabase(
  { applyMigration = true }: { applyMigration?: boolean } = {},
): Promise<PGlite> {
  const snapshot: Snapshot = JSON.parse(await readFile(
    new URL("../../supabase/schema-snapshots/2026-11-02/schema-metadata.json", import.meta.url),
    "utf8",
  ));
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      create schema auth;
      create schema app_private;
      create table auth.users (id uuid primary key);
      create table public.schools (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth, public, app_private to anon, authenticated, service_role;
    `);

    const enumType = snapshot.enums.find((entry) => entry.schema === "public" && entry.name === "app_role");
    const table = snapshot.relations.find((entry) => entry.schema === "public" && entry.name === "user_roles");
    if (!enumType || !table) throw new Error("Snapshot role contract missing.");
    await db.exec(`create type public.app_role as enum (${enumType.labels.map(quoteLiteral).join(",")})`);
    const columns = table.columns.map((column) => {
      const type = column.type === "app_role" ? "public.app_role" : column.type;
      return `${quoteIdentifier(column.name)} ${type}${column.not_null ? " not null" : ""}${column.default ? ` default ${column.default}` : ""}`;
    });
    const constraints = table.constraints.map((constraint) =>
      `constraint ${quoteIdentifier(constraint.name)} ${constraint.definition}`,
    );
    await db.exec(`create table public.user_roles (${[...columns, ...constraints].join(",\n")})`);

    // This exactly matches the snapshot's three API roles' ALL table grants.
    for (const role of ["anon", "authenticated", "service_role"]) {
      if (!table.acl.some((acl) => acl.startsWith(`${role}=arwdDxtm/`))) {
        throw new Error(`Snapshot privileges changed for ${role}; update the fixture deliberately.`);
      }
      await db.exec(`grant all privileges on public.user_roles to ${quoteIdentifier(role)}`);
    }
    const helperNames = [
      "current_user_has_role", "current_user_has_any_role", "current_user_school_ids",
      "is_school_admin_for_school", "assign_school_role",
    ];
    for (const name of helperNames) {
      const routine = snapshot.routines.find((entry) => entry.schema === "public" && entry.name === name);
      if (!routine) throw new Error(`Snapshot routine missing: ${name}`);
      await db.exec(routine.definition);
    }
    await db.exec("alter table public.user_roles enable row level security");
    for (const policy of snapshot.policies.filter((entry) =>
      entry.schemaname === "public" && entry.tablename === "user_roles")) {
      const roles = policy.roles.map((role) => role === "public" ? "PUBLIC" : quoteIdentifier(role));
      await db.exec(`create policy ${quoteIdentifier(policy.policyname)} on public.user_roles
        as ${policy.permissive} for ${policy.cmd} to ${roles.join(",")}
        ${policy.qual ? `using (${policy.qual})` : ""}
        ${policy.with_check ? `with check (${policy.with_check})` : ""}`);
    }
    for (const userId of Object.entries(IDS).filter(([name]) => !name.startsWith("school")).map(([, value]) => value)) {
      await db.query("insert into auth.users(id) values ($1)", [userId]);
    }
    await db.query("insert into public.schools(id) values ($1),($2)", [IDS.schoolA, IDS.schoolB]);
    for (const [userId, schoolId, role] of [
      [IDS.superAdmin, null, "super_admin"],
      [IDS.adminA, IDS.schoolA, "school_admin"],
      [IDS.adminB, IDS.schoolB, "school_admin"],
      [IDS.teacherA, IDS.schoolA, "teacher"],
      [IDS.teacherB, IDS.schoolB, "teacher"],
      [IDS.parentA, IDS.schoolA, "parent"],
      [IDS.studentA, IDS.schoolA, "student"],
    ]) {
      await db.query("insert into public.user_roles(user_id,school_id,role) values ($1,$2,$3)", [userId, schoolId, role]);
    }
    if (applyMigration) await db.exec(await readRoleHardeningSql());
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

export async function asActor<Row extends Record<string, unknown> = Record<string, unknown>>(
  db: PGlite,
  userId: string | null,
  sql: string,
  params: unknown[] = [],
  role: "authenticated" | "anon" = "authenticated",
) {
  if (role !== "authenticated" && role !== "anon") throw new Error("Unsupported fixture role.");
  await db.exec("begin");
  try {
    await db.exec(`set local role ${quoteIdentifier(role)}`);
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId ?? ""]);
    const result = await db.query<Row>(sql, params);
    await db.exec("commit");
    return result;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}
