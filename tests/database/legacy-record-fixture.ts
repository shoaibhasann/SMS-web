import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { createStaffScopeDatabase, STAFF_IDS as actors, STAFF_ROWS as school } from "./staff-scope-fixture";

type Snapshot = {
  relations: {
    schema: string; name: string; kind: string; acl: string[];
    columns: { name: string; type: string; not_null: boolean; default: string | null; generated: string; identity: string }[];
    constraints: { name: string; definition: string }[];
    indexes: { name: string; definition: string }[];
    rls_enabled: boolean; rls_forced: boolean;
  }[];
  policies: { schemaname: string; tablename: string; policyname: string; permissive: string; cmd: string; roles: string[]; qual: string | null; with_check: string | null }[];
  routines: { schema: string; name: string; definition: string; identity_arguments: string; acl: string[] }[];
};
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const tables = ["employees", "exams", "exam_subjects", "payroll", "marks", "audit_logs"];
export const LEGACY_TABLES = ["payroll", "marks", "audit_logs"] as const;
const uuid = (number: number) => `20000000-0000-0000-0000-${String(number).padStart(12, "0")}`;
export const LEGACY_IDS = {
  A: { employee: uuid(1), payroll: uuid(2), exam: uuid(3), item: uuid(4), mark: uuid(5), audit: uuid(6) },
  B: { employee: uuid(11), payroll: uuid(12), exam: uuid(13), item: uuid(14), mark: uuid(15), audit: uuid(16) },
  platformAudit: uuid(20), extra: uuid(30), incoherent: uuid(31), incoherent2: uuid(32),
};

export async function readLegacyRecordSql() {
  return readFile(new URL("../../supabase/migrations/20261105184935_freeze_legacy_client_mutations.sql", import.meta.url), "utf8");
}

function replayAcl(acl: string[], object: string, functionAcl = false) {
  return acl.flatMap((entry) => {
    const [, grantee, codes] = /^(.*?)=([^/]*)\//.exec(entry) ?? [];
    if (grantee !== "" && !["anon", "authenticated", "service_role"].includes(grantee)) return [];
    const privileges = functionAcl ? (codes.includes("X") ? ["EXECUTE"] : [])
      : Object.entries({ a: "INSERT", r: "SELECT", w: "UPDATE", d: "DELETE", D: "TRUNCATE", x: "REFERENCES", t: "TRIGGER", m: "MAINTAIN" })
        .filter(([code]) => codes.includes(code)).map(([, privilege]) => privilege);
    return privileges.length ? [`grant ${privileges.join(",")} on ${functionAcl ? "function" : "table"} ${object} to ${grantee ? identifier(grantee) : "PUBLIC"};`] : [];
  }).join("\n");
}

export async function insertLegacyRow(db: PGlite, table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  return db.query(`insert into public.${identifier(table)} (${keys.map(identifier).join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(row));
}

/** Replays real recovered schemas, generated salary, all FKs/policies/ACLs;
 * the office helper uses the latest deployed source body checked against the
 * read-only 2026-11-06 catalog. No simplified policy or authorization stubs. */
export async function createLegacyRecordDatabase({ applyMigration = true, database }: { applyMigration?: boolean; database?: PGlite } = {}) {
  const db = database ?? await createStaffScopeDatabase();
  try {
    const snapshot: Snapshot = JSON.parse(await readFile(new URL("../../supabase/schema-snapshots/2026-11-02/schema-metadata.json", import.meta.url), "utf8"));
    const relations = snapshot.relations.filter((relation) => relation.schema === "public" && tables.includes(relation.name));
    if (relations.length !== 6 || relations.some((relation) => relation.kind !== "r")) throw new Error("Review changed legacy table contract.");
    for (const relation of relations) {
      const columns = relation.columns.map((column) => {
        if (column.identity || (column.generated && column.generated !== "s")) throw new Error("Review changed legacy identity/generated column.");
        return `${identifier(column.name)} ${column.type}${column.generated ? ` generated always as (${column.default}) stored` : column.default ? ` default ${column.default}` : ""}${column.not_null ? " not null" : ""}`;
      });
      await db.exec(`create table public.${identifier(relation.name)} (${columns.join(",")})`);
    }
    for (const foreign of [false, true]) for (const relation of relations) {
      for (const constraint of relation.constraints.filter((item) => item.definition.startsWith("FOREIGN KEY") === foreign)) {
        await db.exec(`alter table public.${identifier(relation.name)} add constraint ${identifier(constraint.name)} ${constraint.definition}`);
      }
    }
    for (const relation of relations) {
      const constraints = new Set(relation.constraints.map((item) => item.name));
      for (const index of relation.indexes) if (!constraints.has(index.name)) await db.exec(index.definition);
      await db.exec(`revoke all on public.${identifier(relation.name)} from public,anon,authenticated,service_role`);
      await db.exec(replayAcl(relation.acl, `public.${identifier(relation.name)}`));
      if (relation.rls_enabled) await db.exec(`alter table public.${identifier(relation.name)} enable row level security`);
      if (relation.rls_forced) await db.exec(`alter table public.${identifier(relation.name)} force row level security`);
    }
    const officeSql = await readFile(new URL("../../supabase/migrations/20261104132141_teacher_invitations.sql", import.meta.url), "utf8");
    const officeHelper = officeSql.match(/create or replace function public\.current_user_school_ids\(\)[\s\S]*?\$\$;/gi);
    if (officeHelper?.length !== 1) throw new Error("Review changed deployed office helper.");
    await db.exec(officeHelper[0]);
    await db.exec("revoke all on function public.current_user_school_ids() from public,anon; grant execute on function public.current_user_school_ids() to authenticated,service_role");
    const auditWriter = snapshot.routines.find((routine) => routine.schema === "public" && routine.name === "write_audit_log");
    if (!auditWriter) throw new Error("Recovered audit writer missing.");
    await db.exec(auditWriter.definition);
    await db.exec(replayAcl(auditWriter.acl, `public.write_audit_log(${auditWriter.identity_arguments})`, true));
    const policies = snapshot.policies.filter((policy) => policy.schemaname === "public" && tables.includes(policy.tablename));
    if (policies.length !== 8) throw new Error("Review changed complete legacy policy set.");
    for (const policy of policies) await db.exec(`create policy ${identifier(policy.policyname)} on public.${identifier(policy.tablename)} as ${policy.permissive} for ${policy.cmd}
      to ${policy.roles.map((role) => role === "public" ? "PUBLIC" : identifier(role)).join(",")}
      ${policy.qual ? `using (${policy.qual})` : ""} ${policy.with_check ? `with check (${policy.with_check})` : ""}`);
    for (const side of ["A", "B"] as const) {
      const ids = LEGACY_IDS[side]; const tenant = side === "A" ? actors.schoolA : actors.schoolB;
      await insertLegacyRow(db, "employees", { id: ids.employee, school_id: tenant, employee_id: `EMP-${side}`, salary: "62000.00", status: "inactive" });
      await insertLegacyRow(db, "payroll", { id: ids.payroll, school_id: tenant, employee_id: ids.employee, payroll_month: "2025-03-01", gross_salary: "62000.00", deductions: "2000.00", bonuses: "1000.00", status: "paid", paid_at: "2025-03-31T10:00:00Z" });
      await insertLegacyRow(db, "exams", { id: ids.exam, school_id: tenant, academic_year_id: school[side].year, name: `Legacy draft ${side}`, exam_type: "term", status: "draft" });
      await insertLegacyRow(db, "exam_subjects", { id: ids.item, exam_id: ids.exam, subject_id: school[side].subject, class_id: school[side].class, max_marks: "100", pass_marks: "33" });
      await insertLegacyRow(db, "marks", { id: ids.mark, exam_subject_id: ids.item, student_id: school[side].student, marks_obtained: "79.5", grade: "B", remarks: "Historical private result" });
      await insertLegacyRow(db, "audit_logs", { id: ids.audit, school_id: tenant, actor_user_id: side === "A" ? actors.adminA : actors.adminB, action: "legacy.seed", entity_type: "payroll", entity_id: ids.payroll, old_data: { status: "draft" }, new_data: { status: "paid" }, ip_address: "127.0.0.1", created_at: "2025-03-31T10:00:00Z" });
    }
    await insertLegacyRow(db, "audit_logs", { id: LEGACY_IDS.platformAudit, school_id: null, action: "platform.seed" });
    if (applyMigration) await db.exec(await readLegacyRecordSql());
    return db;
  } catch (error) {
    if (!database) await db.close();
    throw error;
  }
}
