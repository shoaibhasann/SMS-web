import { readFile } from "node:fs/promises";
import { createStaffScopeDatabase, STAFF_IDS, STAFF_ROWS } from "./staff-scope-fixture";

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const directory = new URL("../../supabase/migrations/", import.meta.url);
type Catalog = {
  relations: {
    schema: string; name: string; acl: string[];
    columns: { name: string; type: string; default: string | null; not_null: boolean }[];
    constraints: { name: string; definition: string }[];
    triggers: { definition: string }[];
  }[];
  routines: { schema: string; name: string; identity_args: string; definition: string; acl: string[] }[];
  policies: { schemaname: string; tablename: string; policyname: string; permissive: string; cmd: string; roles: string[]; qual: string | null; with_check: string | null }[];
};

export const ASSESSMENT_IDS = {
  a: "20000000-0000-0000-0000-000000000001",
  b: "20000000-0000-0000-0000-000000000002",
  mixed: "20000000-0000-0000-0000-000000000003",
};

export function readAssessmentAccessSql() {
  return readFile(new URL("20261105184937_revoke_assessment_access_on_role_removal.sql", directory), "utf8");
}

/** Exact live assessment policies/ACLs and function definitions, not a reduced
 * model: both legacy permissive admin ALL policies exist before the patch.
 * The shared staff fixture provides recovered FK parents, roles and JWT shim.
 */
export async function createAssessmentAccessDatabase({ applyMigration = true } = {}) {
  const db = await createStaffScopeDatabase({ includeTeachingRpcs: true, applyGovernance: true });
  try {
    const catalog: Catalog = JSON.parse(await readFile(new URL("./assessment-access-catalog.json", import.meta.url), "utf8"));
    if (catalog.relations.length !== 2 || catalog.policies.length !== 12 || catalog.routines.length !== 8) {
      throw new Error("Review the live assessment contract before changing this fixture.");
    }
    for (const table of catalog.relations) {
      await db.exec(`create table public.${identifier(table.name)} (${table.columns.map((column) =>
        `${identifier(column.name)} ${column.type}${column.not_null ? " not null" : ""}${column.default ? ` default ${column.default}` : ""}`,
      ).join(",")})`);
    }
    for (const foreignKey of [false, true]) for (const table of catalog.relations) {
      for (const constraint of table.constraints.filter((row) => row.definition.startsWith("FOREIGN KEY") === foreignKey)) {
        await db.exec(`alter table public.${identifier(table.name)} add constraint ${identifier(constraint.name)} ${constraint.definition}`);
      }
    }
    const order = ["teacher_assessment_set_updated_at", "teacher_assessment_is_assigned", "teacher_assessment_is_school_admin",
      "teacher_assessment_can_view", "teacher_assessment_can_manage", "teacher_assessment_student_is_enrolled",
      "teacher_assessment_validate_maximum", "teacher_assessment_validate_marks"];
    for (const routine of [...catalog.routines].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))) {
      await db.exec(routine.definition);
      const signature = `${identifier(routine.schema)}.${identifier(routine.name)}(${routine.identity_args})`;
      await db.exec(`revoke all on function ${signature} from public,anon,authenticated,service_role`);
      for (const acl of routine.acl ?? []) {
        const [, role, privileges] = /^(.*?)=([^/]*)\//.exec(acl) ?? [];
        if (role !== "" && !["anon", "authenticated", "service_role"].includes(role)) continue;
        if (privileges.includes("X")) await db.exec(`grant execute on function ${signature} to ${role === "" ? "PUBLIC" : identifier(role)}`);
      }
    }
    for (const table of catalog.relations) {
      await db.exec(`alter table public.${identifier(table.name)} enable row level security`);
      for (const acl of table.acl) {
        const [, role, privileges] = /^(.*?)=([^/]*)\//.exec(acl) ?? [];
        if (role !== "" && !["anon", "authenticated", "service_role"].includes(role)) continue;
        const rights = Object.entries({ a: "INSERT", r: "SELECT", w: "UPDATE", d: "DELETE", D: "TRUNCATE", x: "REFERENCES", t: "TRIGGER", m: "MAINTAIN" })
          .filter(([code]) => privileges.includes(code)).map(([, right]) => right);
        if (rights.length) await db.exec(`grant ${rights.join(",")} on public.${identifier(table.name)} to ${role === "" ? "PUBLIC" : identifier(role)}`);
      }
      for (const trigger of table.triggers) await db.exec(trigger.definition);
    }
    for (const policy of catalog.policies) await db.exec(`create policy ${identifier(policy.policyname)}
      on public.${identifier(policy.tablename)} as ${policy.permissive} for ${policy.cmd}
      to ${policy.roles.map((role) => role === "public" ? "PUBLIC" : identifier(role)).join(",")}
      ${policy.qual ? `using (${policy.qual})` : ""} ${policy.with_check ? `with check (${policy.with_check})` : ""}`);

    for (const [key, school, placement, teacher] of [
      ["a", STAFF_IDS.schoolA, STAFF_ROWS.A, STAFF_ROWS.A.teacher],
      ["b", STAFF_IDS.schoolB, STAFF_ROWS.B, STAFF_ROWS.B.teacher],
      ["mixed", STAFF_IDS.schoolB, STAFF_ROWS.B, STAFF_ROWS.mixedTeacher],
    ] as const) {
      await db.query(`insert into public.teacher_assessments
        (id,school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,name,assessment_date,maximum_marks)
        values($1,$2,$3,$4,$5,$6,$7,$8,'2026-11-04',50)`, [
        ASSESSMENT_IDS[key], school, placement.year, placement.class, placement.section, placement.subject, teacher, `Assessment ${key}`,
      ]);
      await db.query("insert into public.teacher_assessment_marks(assessment_id,student_id,marks_obtained) values($1,$2,35)", [ASSESSMENT_IDS[key], placement.student]);
    }
    if (applyMigration) await db.exec(await readAssessmentAccessSql());
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}
