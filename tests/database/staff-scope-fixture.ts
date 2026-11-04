import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { readRoleHardeningSql } from "./role-fixture";

type Column = { name: string; type: string; not_null: boolean; default: string | null; identity: string; generated: string };
type Relation = {
  schema: string; name: string; kind: string; acl: string[] | null;
  columns: Column[]; constraints: { name: string; definition: string }[];
  indexes: { name: string; definition: string }[]; rls_enabled: boolean; rls_forced: boolean;
};
type Routine = { schema: string; name: string; definition: string; identity_arguments: string; acl: string[] | null };
type Snapshot = {
  enums: { schema: string; name: string; labels: string[] }[];
  schemas: { name: string; acl: string[] | null }[];
  relations: Relation[];
  routines: Routine[];
  triggers: { schema: string; table: string; definition: string }[];
  policies: { schemaname: string; tablename: string; policyname: string; permissive: string; cmd: string; roles: string[]; qual: string | null; with_check: string | null }[];
};

export const STAFF_SCOPE_TABLES = [
  "academic_years", "attendance", "class_activities", "class_logs", "classes", "enrollments",
  "fee_payments", "fee_structures", "notices", "parents", "sections", "student_fees",
  "student_parents", "students", "study_materials", "teacher_subject_assignments", "timetables",
] as const;
const replayTables = new Set<string>([
  ...STAFF_SCOPE_TABLES, "profiles", "schools", "streams", "subjects", "teachers", "user_roles",
]);
const uuid = (number: number) => `10000000-0000-0000-0000-${String(number).padStart(12, "0")}`;
export const STAFF_IDS = {
  schoolA: uuid(1), schoolB: uuid(2), superAdmin: uuid(10), adminA: uuid(11), adminB: uuid(12),
  principalA: uuid(13), accountantA: uuid(14), receptionA: uuid(15), teacherA: uuid(16),
  parentA: uuid(17), studentA: uuid(18), teacherB: uuid(19), parentB: uuid(20), studentB: uuid(21),
  mixedTeacher: uuid(22), mixedParent: uuid(23), outsider: uuid(24),
} as const;

export const STAFF_ROWS = {
  A: { year: uuid(100), class: uuid(110), section: uuid(120), subject: uuid(130), teacher: uuid(140), student: uuid(150), parent: uuid(160), enrollment: uuid(170), assignment: uuid(180), log: uuid(190), activity: uuid(200), structure: uuid(210), fee: uuid(220), payment: uuid(230), notice: uuid(240), material: uuid(250), timetable: uuid(260) },
  B: { year: uuid(101), class: uuid(111), section: uuid(121), subject: uuid(131), teacher: uuid(141), student: uuid(151), parent: uuid(161), enrollment: uuid(171), assignment: uuid(181), log: uuid(191), activity: uuid(201), structure: uuid(211), fee: uuid(221), payment: uuid(231), notice: uuid(241), material: uuid(251), timetable: uuid(261) },
  privateStudentA: uuid(300), privateStudentB: uuid(301), privateClassA: uuid(310), privateClassB: uuid(311),
  privateSectionA: uuid(320), privateSectionB: uuid(321), privateEnrollmentA: uuid(330), privateEnrollmentB: uuid(331),
  privateFeeB: uuid(340), privatePaymentB: uuid(341), mixedTeacher: uuid(350), mixedParent: uuid(351), mixedAssignment: uuid(352),
  draftLogA: uuid(360), draftActivityA: uuid(361),
} as const;

export const SCHOOL_B_PROBES: Record<(typeof STAFF_SCOPE_TABLES)[number], { sql: string; params: unknown[] }> = {
  academic_years: { sql: "select id from public.academic_years where id=$1", params: [STAFF_ROWS.B.year] },
  attendance: { sql: "select student_id from public.attendance where student_id=$1", params: [STAFF_ROWS.B.student] },
  class_activities: { sql: "select id from public.class_activities where id=$1", params: [STAFF_ROWS.B.activity] },
  class_logs: { sql: "select id from public.class_logs where id=$1", params: [STAFF_ROWS.B.log] },
  classes: { sql: "select id from public.classes where id=$1", params: [STAFF_ROWS.B.class] },
  enrollments: { sql: "select id from public.enrollments where id=$1", params: [STAFF_ROWS.B.enrollment] },
  fee_payments: { sql: "select id from public.fee_payments where id=$1", params: [STAFF_ROWS.B.payment] },
  fee_structures: { sql: "select id from public.fee_structures where id=$1", params: [STAFF_ROWS.B.structure] },
  notices: { sql: "select id from public.notices where id=$1", params: [STAFF_ROWS.B.notice] },
  parents: { sql: "select id from public.parents where id=$1", params: [STAFF_ROWS.B.parent] },
  sections: { sql: "select id from public.sections where id=$1", params: [STAFF_ROWS.B.section] },
  student_fees: { sql: "select id from public.student_fees where id=$1", params: [STAFF_ROWS.B.fee] },
  student_parents: { sql: "select student_id from public.student_parents where student_id=$1", params: [STAFF_ROWS.B.student] },
  students: { sql: "select id from public.students where id=$1", params: [STAFF_ROWS.B.student] },
  study_materials: { sql: "select id from public.study_materials where id=$1", params: [STAFF_ROWS.B.material] },
  teacher_subject_assignments: { sql: "select id from public.teacher_subject_assignments where id=$1", params: [STAFF_ROWS.B.assignment] },
  timetables: { sql: "select id from public.timetables where id=$1", params: [STAFF_ROWS.B.timetable] },
};

const migrationDirectory = new URL("../../supabase/migrations/", import.meta.url);
const identifier = (text: string) => `"${text.replaceAll('"', '""')}"`;
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;
const apiRoles = new Set(["anon", "authenticated", "service_role"]);

export async function readStaffScopeSql() {
  const files = (await readdir(migrationDirectory)).filter((name) => /^\d+_staff_school_scope\.sql$/.test(name));
  if (files.length !== 1) throw new Error("Expected exactly one staff-school-scope migration.");
  const sql = await readFile(new URL(files[0], migrationDirectory), "utf8");
  if (!sql.trim()) throw new Error("Staff-school-scope migration is empty.");
  return sql;
}

export async function readTeachingGovernanceSql() {
  const files = (await readdir(migrationDirectory)).filter((name) => /^\d+_govern_teacher_assignments\.sql$/.test(name));
  if (files.length !== 1) throw new Error("Expected exactly one teacher-assignment governance migration.");
  const sql = await readFile(new URL(files[0], migrationDirectory), "utf8");
  if (!sql.trim()) throw new Error("Teacher-assignment governance migration is empty.");
  return sql;
}

/** The first two deployed patches plus the opt-in third governance patch. */
export function createTeachingGovernanceDatabase({ applyMigration = true }: { applyMigration?: boolean } = {}) {
  return createStaffScopeDatabase({ applyMigration: true, includeTeachingRpcs: true, applyGovernance: applyMigration });
}

function aclEntries(acl: string[] | null, defaultPublicExecute = false) {
  return (acl ?? (defaultPublicExecute ? ["=X/postgres"] : [])).flatMap((entry) => {
    const [, grantee, privileges] = /^(.*?)=([^/]*)\//.exec(entry) ?? [];
    if (grantee !== "" && !apiRoles.has(grantee)) return [];
    return [{ grantee: grantee ? identifier(grantee) : "PUBLIC", privileges }];
  });
}

async function insert(db: PGlite, table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  await db.query(`insert into public.${identifier(table)} (${keys.map(identifier).join(",")}) values (${keys.map((_, index) => `$${index + 1}`).join(",")})`, Object.values(row));
}

async function seed(db: PGlite) {
  const users = Object.entries(STAFF_IDS).filter(([name]) => !name.startsWith("school"));
  for (const [, id] of users) await db.query("insert into auth.users(id) values ($1)", [id]);
  await insert(db, "schools", { id: STAFF_IDS.schoolA, name: "Fixture School A" });
  await insert(db, "schools", { id: STAFF_IDS.schoolB, name: "Fixture School B" });
  const schoolBUsers = new Set<string>([STAFF_IDS.adminB, STAFF_IDS.teacherB, STAFF_IDS.parentB, STAFF_IDS.studentB, STAFF_IDS.mixedTeacher, STAFF_IDS.mixedParent]);
  for (const [name, id] of users) await insert(db, "profiles", { id, school_id: name === "superAdmin" || name === "outsider" ? null : schoolBUsers.has(id) ? STAFF_IDS.schoolB : STAFF_IDS.schoolA, full_name: name });

  for (const side of ["A", "B"] as const) {
    const ids = STAFF_ROWS[side];
    const school = side === "A" ? STAFF_IDS.schoolA : STAFF_IDS.schoolB;
    const teacherUser = side === "A" ? STAFF_IDS.teacherA : STAFF_IDS.teacherB;
    const parentUser = side === "A" ? STAFF_IDS.parentA : STAFF_IDS.parentB;
    const studentUser = side === "A" ? STAFF_IDS.studentA : STAFF_IDS.studentB;
    await insert(db, "academic_years", { id: ids.year, school_id: school, name: "2026–27", start_date: "2026-04-01", end_date: "2027-03-31", is_current: true });
    await insert(db, "classes", { id: ids.class, school_id: school, name: "Class 6" });
    await insert(db, "sections", { id: ids.section, school_id: school, class_id: ids.class, name: "A" });
    await insert(db, "subjects", { id: ids.subject, school_id: school, name: "Science" });
    await insert(db, "teachers", { id: ids.teacher, school_id: school, profile_id: teacherUser, employee_id: `TEACHER-${side}`, full_name: `Teacher ${side}` });
    await insert(db, "students", { id: ids.student, school_id: school, profile_id: studentUser, admission_no: `STUDENT-${side}`, first_name: `Student ${side}` });
    await insert(db, "parents", { id: ids.parent, school_id: school, profile_id: parentUser });
    await insert(db, "student_parents", { student_id: ids.student, parent_id: ids.parent, relationship: "guardian" });
    await insert(db, "enrollments", { id: ids.enrollment, student_id: ids.student, academic_year_id: ids.year, class_id: ids.class, section_id: ids.section, roll_no: "1" });
    await insert(db, "teacher_subject_assignments", { id: ids.assignment, teacher_id: ids.teacher, academic_year_id: ids.year, class_id: ids.class, section_id: ids.section, subject_id: ids.subject, is_class_teacher: true });
    await insert(db, "class_logs", { id: ids.log, school_id: school, academic_year_id: ids.year, class_id: ids.class, section_id: ids.section, subject_id: ids.subject, teacher_id: ids.teacher, log_date: "2026-11-02", topic: `Published ${side}`, status: "published" });
    await insert(db, "class_activities", { id: ids.activity, class_log_id: ids.log, activity_type: "homework", title: `Homework ${side}` });
    await insert(db, "attendance", { school_id: school, academic_year_id: ids.year, section_id: ids.section, student_id: ids.student, attendance_date: "2026-11-02", status: "absent", marked_by: teacherUser });
    await insert(db, "fee_structures", { id: ids.structure, school_id: school, academic_year_id: ids.year, class_id: ids.class, name: `Tuition ${side}`, amount: "1000.00" });
    await insert(db, "student_fees", { id: ids.fee, school_id: school, student_id: ids.student, fee_structure_id: ids.structure, amount: "1000.00" });
    await insert(db, "fee_payments", { id: ids.payment, school_id: school, student_id: ids.student, student_fee_id: ids.fee, receipt_no: `RECEIPT-${side}`, amount: "100.00" });
    await insert(db, "notices", { id: ids.notice, school_id: school, title: `Notice ${side}`, content: "Fixture notice", created_by: teacherUser });
    await insert(db, "study_materials", { id: ids.material, school_id: school, class_id: ids.class, section_id: ids.section, subject_id: ids.subject, teacher_id: ids.teacher, title: `Material ${side}`, published_at: "2026-11-02T09:00:00Z" });
    await insert(db, "timetables", { id: ids.timetable, school_id: school, academic_year_id: ids.year, class_id: ids.class, section_id: ids.section, teacher_id: ids.teacher, subject_id: ids.subject, day_of_week: 1, period_no: 1 });

    const privateClass = side === "A" ? STAFF_ROWS.privateClassA : STAFF_ROWS.privateClassB;
    const privateSection = side === "A" ? STAFF_ROWS.privateSectionA : STAFF_ROWS.privateSectionB;
    const privateStudent = side === "A" ? STAFF_ROWS.privateStudentA : STAFF_ROWS.privateStudentB;
    const privateEnrollment = side === "A" ? STAFF_ROWS.privateEnrollmentA : STAFF_ROWS.privateEnrollmentB;
    await insert(db, "classes", { id: privateClass, school_id: school, name: "Unassigned class" });
    await insert(db, "sections", { id: privateSection, school_id: school, class_id: privateClass, name: "A" });
    await insert(db, "students", { id: privateStudent, school_id: school, admission_no: `PRIVATE-${side}`, first_name: `Unrelated ${side}` });
    await insert(db, "enrollments", { id: privateEnrollment, student_id: privateStudent, academic_year_id: ids.year, class_id: privateClass, section_id: privateSection });
  }
  await insert(db, "teachers", { id: STAFF_ROWS.mixedTeacher, school_id: STAFF_IDS.schoolB, profile_id: STAFF_IDS.mixedTeacher, employee_id: "MIXED-B", full_name: "Mixed teacher" });
  await insert(db, "teacher_subject_assignments", { id: STAFF_ROWS.mixedAssignment, teacher_id: STAFF_ROWS.mixedTeacher, academic_year_id: STAFF_ROWS.B.year, class_id: STAFF_ROWS.B.class, section_id: STAFF_ROWS.B.section, subject_id: STAFF_ROWS.B.subject });
  await insert(db, "parents", { id: STAFF_ROWS.mixedParent, school_id: STAFF_IDS.schoolB, profile_id: STAFF_IDS.mixedParent });
  await insert(db, "student_parents", { student_id: STAFF_ROWS.B.student, parent_id: STAFF_ROWS.mixedParent, relationship: "guardian" });
  await insert(db, "student_fees", { id: STAFF_ROWS.privateFeeB, school_id: STAFF_IDS.schoolB, student_id: STAFF_ROWS.privateStudentB, fee_structure_id: STAFF_ROWS.B.structure, amount: "700.00" });
  await insert(db, "fee_payments", { id: STAFF_ROWS.privatePaymentB, school_id: STAFF_IDS.schoolB, student_id: STAFF_ROWS.privateStudentB, student_fee_id: STAFF_ROWS.privateFeeB, receipt_no: "PRIVATE-B", amount: "50.00" });
  await insert(db, "class_logs", { id: STAFF_ROWS.draftLogA, school_id: STAFF_IDS.schoolA, academic_year_id: STAFF_ROWS.A.year, class_id: STAFF_ROWS.A.class, section_id: STAFF_ROWS.A.section, subject_id: STAFF_ROWS.A.subject, teacher_id: STAFF_ROWS.A.teacher, log_date: "2026-11-03", topic: "Private teacher draft", status: "draft" });
  await insert(db, "class_activities", { id: STAFF_ROWS.draftActivityA, class_log_id: STAFF_ROWS.draftLogA, activity_type: "homework", title: "Private draft homework" });
  const roles: [string, string | null, string][] = [
    [STAFF_IDS.superAdmin, null, "super_admin"], [STAFF_IDS.adminA, STAFF_IDS.schoolA, "school_admin"], [STAFF_IDS.adminB, STAFF_IDS.schoolB, "school_admin"],
    [STAFF_IDS.principalA, STAFF_IDS.schoolA, "principal"], [STAFF_IDS.accountantA, STAFF_IDS.schoolA, "accountant"], [STAFF_IDS.receptionA, STAFF_IDS.schoolA, "reception_staff"],
    [STAFF_IDS.teacherA, STAFF_IDS.schoolA, "teacher"], [STAFF_IDS.parentA, STAFF_IDS.schoolA, "parent"], [STAFF_IDS.studentA, STAFF_IDS.schoolA, "student"],
    [STAFF_IDS.teacherB, STAFF_IDS.schoolB, "teacher"], [STAFF_IDS.parentB, STAFF_IDS.schoolB, "parent"], [STAFF_IDS.studentB, STAFF_IDS.schoolB, "student"],
    [STAFF_IDS.mixedTeacher, STAFF_IDS.schoolA, "accountant"], [STAFF_IDS.mixedTeacher, STAFF_IDS.schoolB, "teacher"],
    [STAFF_IDS.mixedParent, STAFF_IDS.schoolA, "accountant"], [STAFF_IDS.mixedParent, STAFF_IDS.schoolB, "parent"],
  ];
  for (const [user_id, school_id, role] of roles) await insert(db, "user_roles", { user_id, school_id, role });
}

/**
 * Exact bounded recovered contract: 17 target tables + six FK/policy dependencies,
 * all 93 coexisting policies, original defaults/constraints/nonconstraint indexes,
 * relevant real helper bodies/ACLs and public triggers. Only Auth's user payload
 * and JWT subject lookup are synthetic. The earlier role-table patch is always
 * applied first, mirroring the user-confirmed deployment sequence.
 */
export async function createStaffScopeDatabase({
  applyMigration = true, includeTeachingRpcs = false, applyGovernance = false,
}: { applyMigration?: boolean; includeTeachingRpcs?: boolean; applyGovernance?: boolean } = {}) {
  if (applyGovernance && !applyMigration) throw new Error("Teaching governance requires the staff-school-scope patch first.");
  const snapshot: Snapshot = JSON.parse(await readFile(new URL("../../supabase/schema-snapshots/2026-11-02/schema-metadata.json", import.meta.url), "utf8"));
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth; create schema app_private;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth to anon, authenticated, service_role;
    `);
    for (const schema of snapshot.schemas) {
      await db.exec(`revoke all on schema ${identifier(schema.name)} from public, anon, authenticated, service_role`);
      for (const grant of aclEntries(schema.acl)) {
        const privileges = [grant.privileges.includes("U") ? "USAGE" : "", grant.privileges.includes("C") ? "CREATE" : ""].filter(Boolean);
        if (privileges.length) await db.exec(`grant ${privileges.join(",")} on schema ${identifier(schema.name)} to ${grant.grantee}`);
      }
    }
    for (const type of snapshot.enums) await db.exec(`create type ${identifier(type.schema)}.${identifier(type.name)} as enum (${type.labels.map(literal).join(",")})`);
    const relations = snapshot.relations.filter((relation) => relation.schema === "public" && replayTables.has(relation.name));
    if (relations.length !== 23 || relations.some((relation) => relation.kind !== "r")) throw new Error("The bounded staff fixture table contract changed.");
    for (const relation of relations) {
      const columns = relation.columns.map((column) => {
        if (column.identity || column.generated) throw new Error("Review newly generated/identity fixture columns explicitly.");
        return `${identifier(column.name)} ${column.type}${column.not_null ? " not null" : ""}${column.default ? ` default ${column.default}` : ""}`;
      });
      await db.exec(`create table public.${identifier(relation.name)} (${columns.join(",")})`);
    }
    // Referenced primary/unique keys must exist before adding any foreign keys.
    for (const foreignKey of [false, true]) {
      for (const relation of relations) {
        for (const constraint of relation.constraints.filter((item) => item.definition.startsWith("FOREIGN KEY") === foreignKey)) {
          await db.exec(`alter table public.${identifier(relation.name)} add constraint ${identifier(constraint.name)} ${constraint.definition}`);
        }
      }
    }
    for (const relation of relations) {
      const constraintNames = new Set(relation.constraints.map((constraint) => constraint.name));
      for (const index of relation.indexes) if (!constraintNames.has(index.name)) await db.exec(index.definition);
      await db.exec(`revoke all on public.${identifier(relation.name)} from public, anon, authenticated, service_role`);
      for (const grant of aclEntries(relation.acl)) {
        const privileges = Object.entries({ a: "INSERT", r: "SELECT", w: "UPDATE", d: "DELETE", D: "TRUNCATE", x: "REFERENCES", t: "TRIGGER", m: "MAINTAIN" })
          .filter(([code]) => grant.privileges.includes(code)).map(([, value]) => value);
        if (privileges.length) await db.exec(`grant ${privileges.join(",")} on public.${identifier(relation.name)} to ${grant.grantee}`);
      }
    }
    const publicHelpers = new Set(["current_user_has_role", "current_user_has_any_role", "current_user_school_ids", "is_school_admin_for_school", "has_role", "set_updated_at", "assign_school_role"]);
    if (includeTeachingRpcs) {
      publicHelpers.add("register_student_for_class_teacher");
      publicHelpers.add("update_my_teacher_phone");
    }
    const routines = snapshot.routines.filter((routine) => routine.schema === "app_private" || routine.schema === "public" && publicHelpers.has(routine.name));
    // SQL-language helper bodies are validated at CREATE time, so create their
    // named dependencies first rather than replacing bodies with fake booleans.
    const priority = ["current_user_has_role", "current_user_has_any_role", "current_user_school_ids", "is_school_admin_for_school", "has_role", "set_updated_at", "current_parent_id", "current_student_id", "current_teacher_id", "current_roles", "is_teacher", "is_school_admin", "is_finance", "teacher_assignment_exists", "assign_school_role"];
    routines.sort((left, right) => priority.indexOf(left.name) - priority.indexOf(right.name));
    for (const routine of routines) {
      await db.exec(routine.definition);
      const signature = `${identifier(routine.schema)}.${identifier(routine.name)}(${routine.identity_arguments})`;
      await db.exec(`revoke all on function ${signature} from public, anon, authenticated, service_role`);
      for (const grant of aclEntries(routine.acl, true)) if (grant.privileges.includes("X")) await db.exec(`grant execute on function ${signature} to ${grant.grantee}`);
    }
    for (const relation of relations) {
      if (relation.rls_enabled) await db.exec(`alter table public.${identifier(relation.name)} enable row level security`);
      if (relation.rls_forced) await db.exec(`alter table public.${identifier(relation.name)} force row level security`);
    }
    const policies = snapshot.policies.filter((policy) => policy.schemaname === "public" && replayTables.has(policy.tablename));
    if (policies.length !== 93) throw new Error("Review changed coexisting policies before updating the bounded staff fixture.");
    for (const policy of policies) await db.exec(`create policy ${identifier(policy.policyname)} on public.${identifier(policy.tablename)} as ${policy.permissive} for ${policy.cmd}
      to ${policy.roles.map((role) => role === "public" ? "PUBLIC" : identifier(role)).join(",")}
      ${policy.qual ? `using (${policy.qual})` : ""} ${policy.with_check ? `with check (${policy.with_check})` : ""}`);
    for (const trigger of snapshot.triggers.filter((trigger) => trigger.schema === "public" && replayTables.has(trigger.table))) await db.exec(trigger.definition);
    await seed(db);
    await db.exec(await readRoleHardeningSql());
    if (applyMigration) await db.exec(await readStaffScopeSql());
    if (applyGovernance) await db.exec(await readTeachingGovernanceSql());
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

export async function asStaffActor<Row extends Record<string, unknown> = Record<string, unknown>>(
  db: PGlite, userId: string | null, sql: string, params: unknown[] = [], role: "authenticated" | "anon" | "service_role" = "authenticated",
) {
  if (!["authenticated", "anon", "service_role"].includes(role)) throw new Error("Unsupported fixture role.");
  await db.exec(`begin; set local role ${identifier(role)}`);
  try {
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId ?? ""]);
    const result = await db.query<Row>(sql, params);
    await db.exec("commit");
    return result;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}
