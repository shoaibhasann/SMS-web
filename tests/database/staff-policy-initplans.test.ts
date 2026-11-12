// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

// The 23 staff policy expressions exactly as production had them before 20261112140000 (pg_policies text).
const OLD = [
  { table: "students", policy: "admin_students_all", using: "is_school_admin_for_school(school_id)", check: "is_school_admin_for_school(school_id)" },
  { table: "students", policy: "students_finance_read", using: "app_private.has_school_roles(school_id, ARRAY['accountant'::app_role])", check: null },
  { table: "students", policy: "students_staff_all", using: "app_private.has_school_roles(school_id, ARRAY['school_admin'::app_role, 'principal'::app_role, 'accountant'::app_role, 'reception_staff'::app_role])", check: "app_private.has_school_roles(school_id, ARRAY['school_admin'::app_role, 'principal'::app_role, 'accountant'::app_role, 'reception_staff'::app_role])" },
  { table: "students", policy: "students_substitute_attendance_read", using: "app_private.substitute_roster_access(id, NULL::uuid, NULL::uuid, NULL::uuid)", check: null },
  { table: "students", policy: "students_teacher_assigned_read", using: "(app_private.is_teacher() AND (EXISTS ( SELECT 1 FROM (enrollments e JOIN teacher_subject_assignments a ON (((a.class_id = e.class_id) AND (a.academic_year_id = e.academic_year_id) AND ((a.section_id IS NULL) OR (a.section_id = e.section_id))))) WHERE ((e.student_id = students.id) AND (a.teacher_id = app_private.current_teacher_id())))))", check: null },
  { table: "enrollments", policy: "admin_enrollments_all", using: "app_private.has_school_roles_for_student(student_id, ARRAY['school_admin'::app_role])", check: "app_private.has_school_roles_for_student(student_id, ARRAY['school_admin'::app_role])" },
  { table: "enrollments", policy: "enrollments_staff_all", using: "app_private.has_school_roles_for_student(student_id, ARRAY['school_admin'::app_role, 'principal'::app_role, 'accountant'::app_role, 'reception_staff'::app_role])", check: "app_private.has_school_roles_for_student(student_id, ARRAY['school_admin'::app_role, 'principal'::app_role, 'accountant'::app_role, 'reception_staff'::app_role])" },
  { table: "enrollments", policy: "enrollments_substitute_attendance_read", using: "((status = 'active'::text) AND app_private.substitute_roster_access(student_id, academic_year_id, class_id, section_id))", check: null },
  { table: "enrollments", policy: "enrollments_teacher_assigned_read", using: "((status <> ALL (ARRAY['staged'::text, 'cancelled'::text])) AND app_private.is_teacher() AND (EXISTS ( SELECT 1 FROM teacher_subject_assignments a WHERE ((a.teacher_id = app_private.current_teacher_id()) AND (a.academic_year_id = enrollments.academic_year_id) AND (a.class_id = enrollments.class_id) AND ((a.section_id IS NULL) OR (a.section_id = enrollments.section_id))))))", check: null },
  { table: "attendance", policy: "admin_attendance_all", using: "is_school_admin_for_school(school_id)", check: "is_school_admin_for_school(school_id)" },
  { table: "attendance", policy: "attendance_class_teacher_manage", using: "app_private.teacher_owns_attendance_register_on(school_id, academic_year_id, section_id, student_id, attendance_date)", check: "app_private.teacher_owns_attendance_register_on(school_id, academic_year_id, section_id, student_id, attendance_date)" },
  { table: "attendance", policy: "attendance_staff_all", using: "app_private.has_school_roles(school_id, ARRAY['school_admin'::app_role, 'principal'::app_role, 'accountant'::app_role, 'reception_staff'::app_role])", check: "app_private.has_school_roles(school_id, ARRAY['school_admin'::app_role, 'principal'::app_role, 'accountant'::app_role, 'reception_staff'::app_role])" },
  { table: "student_fees", policy: "admin_student_fees_all", using: "is_school_admin_for_school(school_id)", check: "is_school_admin_for_school(school_id)" },
  { table: "student_fees", policy: "student_fees_admin_all", using: "app_private.has_school_roles(school_id, ARRAY['school_admin'::app_role, 'principal'::app_role, 'accountant'::app_role, 'reception_staff'::app_role])", check: "app_private.has_school_roles(school_id, ARRAY['school_admin'::app_role, 'principal'::app_role, 'accountant'::app_role, 'reception_staff'::app_role])" },
  { table: "student_fees", policy: "student_fees_finance_all", using: "app_private.has_school_roles(school_id, ARRAY['accountant'::app_role])", check: "app_private.has_school_roles(school_id, ARRAY['accountant'::app_role])" },
  { table: "fee_payments", policy: "admin_fee_payments_all", using: "is_school_admin_for_school(school_id)", check: "is_school_admin_for_school(school_id)" },
  { table: "fee_payments", policy: "fee_payments_admin_all", using: "app_private.has_school_roles(school_id, ARRAY['school_admin'::app_role, 'principal'::app_role, 'accountant'::app_role, 'reception_staff'::app_role])", check: "app_private.has_school_roles(school_id, ARRAY['school_admin'::app_role, 'principal'::app_role, 'accountant'::app_role, 'reception_staff'::app_role])" },
  { table: "fee_payments", policy: "fee_payments_finance_all", using: "app_private.has_school_roles(school_id, ARRAY['accountant'::app_role])", check: "app_private.has_school_roles(school_id, ARRAY['accountant'::app_role])" },
  { table: "class_logs", policy: "academic_logs_family", using: "((status = 'published'::text) AND app_private.academic_family_scope(school_id, academic_year_id, class_id, section_id))", check: null },
  { table: "class_logs", policy: "academic_logs_manager", using: "app_private.academic_manager(school_id)", check: "app_private.academic_manager(school_id)" },
  { table: "class_logs", policy: "academic_logs_office_read", using: "app_private.academic_office_read(school_id)", check: null },
  { table: "class_logs", policy: "academic_logs_teacher_read", using: "app_private.teacher_academic_scope(teacher_id, school_id, academic_year_id, class_id, section_id, subject_id, false)", check: null },
  { table: "class_activities", policy: "academic_activities_manager", using: "app_private.academic_log_manager(class_log_id)", check: "app_private.academic_log_manager(class_log_id)" },
] as const;

let db: PGlite;
const extra = {
  principalA: randomUUID(), accountantA: randomUUID(), receptionA: randomUUID(), accountantB: randomUUID(),
  superAdmin: randomUUID(), scopedSuperAdminA: randomUUID(), inactiveAdminA: randomUUID(), principalTeacherB: randomUUID(),
  subjectTeacherA: randomUUID(), substituteA: randomUUID(), ghost: randomUUID(),
};
const callers: [string, string][] = [
  ["admin A", id.adminA], ["admin B", id.adminB], ["class teacher A", id.teacherA], ["guardian A", id.guardianA],
  ["pupil A", id.studentUserA], ["pupil B", id.studentUserB], ["signed-in user without a role", id.claimantA],
  ["principal A", extra.principalA], ["accountant A", extra.accountantA], ["reception A", extra.receptionA],
  ["accountant B", extra.accountantB], ["global super admin", extra.superAdmin], ["super admin row scoped to school A", extra.scopedSuperAdminA],
  ["inactive admin A", extra.inactiveAdminA], ["principal B who also teaches", extra.principalTeacherB],
  ["subject teacher A", extra.subjectTeacherA], ["substitute covering section A today", extra.substituteA], ["unknown user", extra.ghost],
];

async function asCaller<T>(user: string, work: () => Promise<T>, role: string | null = null) {
  await db.exec("begin");
  try {
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [user, JSON.stringify({ sub: user, session_id: user, aal: "aal2", role: "authenticated" })]);
    if (role) await db.exec(`set local role ${role}`);
    return await work();
  } finally { await db.exec("rollback"); }
}

async function addUser(user: string, school: string | null, role: string | null, active = true) {
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [user, `${user}@staff-policy.invalid`]);
  await db.query(`insert into public.profiles(id,school_id,full_name,email,is_active) values($1,$2,'Synthetic staff policy user',$3,$4)
    on conflict(id) do update set school_id=excluded.school_id,is_active=excluded.is_active`, [user, school, `${user}@staff-policy.invalid`, active]);
  if (role) await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,$3)", [user, school, role]);
}

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  // Today's coverage and marks must fall inside the seeded academic years whatever the date the suite runs on.
  await db.query("update public.academic_years set start_date=least(start_date,current_date-30),end_date=greatest(end_date,current_date+30) where id = any($1)", [[id.yearA, id.yearB]]);
  await addUser(extra.principalA, id.schoolA, "principal");
  await addUser(extra.accountantA, id.schoolA, "accountant");
  await addUser(extra.receptionA, id.schoolA, "reception_staff");
  await addUser(extra.accountantB, id.schoolB, "accountant");
  await addUser(extra.superAdmin, null, "super_admin");
  await addUser(extra.scopedSuperAdminA, id.schoolA, "super_admin");
  await addUser(extra.inactiveAdminA, id.schoolA, "school_admin", false);
  await addUser(extra.principalTeacherB, id.schoolB, "principal");
  await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'teacher')", [extra.principalTeacherB, id.schoolB]);
  await addUser(extra.subjectTeacherA, id.schoolA, "teacher");
  await addUser(extra.substituteA, id.schoolA, "teacher");
  const [teacherB, subjectTeacher, substitute] = [randomUUID(), randomUUID(), randomUUID()];
  await db.query("insert into public.teachers(id,school_id,profile_id,employee_id,full_name) values($1,$2,$3,'STAFF-POLICY-B','Synthetic teacher B'),($4,$5,$6,'STAFF-POLICY-A2','Synthetic subject teacher')",
    [teacherB, id.schoolB, extra.principalTeacherB, subjectTeacher, id.schoolA, extra.subjectTeacherA]);
  await db.query("insert into public.teachers(id,school_id,profile_id,employee_id,full_name) values($1,$2,$3,'STAFF-POLICY-SUB','Synthetic substitute')", [substitute, id.schoolA, extra.substituteA]);
  await db.query(`insert into app_private.substitute_attendance_coverages(id,school_id,academic_year_id,class_id,section_id,subject_id,source_assignment_id,source_teacher_id,substitute_teacher_id,starts_on,ends_on,created_by,reason)
    values(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,(statement_timestamp() at time zone 'Asia/Kolkata')::date,(statement_timestamp() at time zone 'Asia/Kolkata')::date,$9,'Synthetic cover for the register')`,
    [id.schoolA, id.yearA, id.classA, id.sectionA, id.subjectA, id.assignmentA, id.teacherRecordA, substitute, id.adminA]);
  await db.query(`insert into public.teacher_subject_assignments(teacher_id,academic_year_id,class_id,section_id,subject_id,is_class_teacher)
    values($1,$2,$3,$4,$5,true),($6,$7,$8,null,$9,false)`, [teacherB, id.yearB, id.classB, id.sectionB, id.subjectB, subjectTeacher, id.yearA, id.classA, id.subjectA]);
  // More rows of each shape: pupils in both schools with enrollments, marks on two days, demands and payments, homework logs.
  for (const [school, year, klass, section, structure, prefix] of [
    [id.schoolA, id.yearA, id.classA, id.sectionA, id.structureA, "SP-A"], [id.schoolB, id.yearB, id.classB, id.sectionB, id.structureB, "SP-B"],
  ] as const) {
    for (let n = 1; n <= 6; n += 1) {
      const pupil = randomUUID(), fee = randomUUID();
      await db.query(`insert into public.students(id,school_id,admission_no,first_name,dob,registered_mobile) values($1,$2,$3,'Synthetic pupil','2014-06-15','0000000000')`, [pupil, school, `${prefix}-${n}`]);
      await db.query("insert into public.enrollments(student_id,academic_year_id,class_id,section_id) values($1,$2,$3,$4)", [pupil, year, klass, n % 3 === 0 ? null : section]);
      for (const day of ["2026-11-05", "2026-11-06", "today"]) {
        await db.query(`insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status)
          values($1,$2,$3,$4,case when $5='today' then (statement_timestamp() at time zone 'Asia/Kolkata')::date else $5::date end,'present')`, [school, year, section, pupil, day]);
      }
      await db.query(`insert into public.student_fees(id,school_id,student_id,fee_structure_id,billing_period,due_date,amount,status) values($1,$2,$3,$4,'2026-11','2026-11-30',1000,'pending')`, [fee, school, pupil, structure]);
      if (n % 2 === 0) await db.query(`insert into public.fee_payments(school_id,student_id,student_fee_id,receipt_no,amount,payment_method,status) values($1,$2,$3,$4,100,'cash','paid')`, [school, pupil, fee, `${prefix}-R${n}`]);
    }
  }
  for (const [status, published, day] of [["published", "now()", "2026-11-05"], ["draft", "null", "2026-11-06"]]) {
    const log = randomUUID();
    await db.query(`insert into public.class_logs(id,school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,log_date,topic,status,published_at)
      values($1,$2,$3,$4,$5,$6,$7,$9,'Synthetic lesson',$8,${published})`, [log, id.schoolA, id.yearA, id.classA, id.sectionA, id.subjectA, id.teacherRecordA, status, day]);
    await db.query("insert into public.class_activities(class_log_id,activity_type,title) values($1,'homework','Synthetic homework'),($1,'homework','Synthetic reading')", [log]);
  }
  // Every caller has a verified authenticator and an aal2 session, so the staff MFA policy lets staff through.
  await db.exec(`insert into auth.mfa_factors(id,user_id,factor_type,status) select gen_random_uuid(),id,'totp','verified' from auth.users;
    insert into auth.sessions(id,user_id,aal,factor_id) select u.id,u.id,'aal2',f.id from auth.users u join auth.mfa_factors f on f.user_id=u.id`);
}, 120_000);
afterAll(async () => { await db?.close(); });

const current = async (table: string, policy: string) => (await db.query<{ qual: string | null; with_check: string | null }>(
  "select qual,with_check from pg_policies where schemaname='public' and tablename=$1 and policyname=$2", [table, policy])).rows[0];

describe("staff policies evaluate role checks once per statement (20261112140000, 20261112150000)", () => {
  it("admit exactly the rows the previous expressions admitted, for every caller, row and check", async () => {
    const admitted = new Map<string, number>();
    for (const [label, user] of callers) {
      await asCaller(user, async () => {
        for (const old of OLD) {
          const now = await current(old.table, old.policy);
          for (const [kind, before, after] of [["using", old.using, now.qual], ["check", old.check, now.with_check]] as const) {
            if (before === null && after === null) continue;
            expect(after, `${old.policy} ${kind}`).not.toBeNull();
            const { rows: [row] } = await db.query<{ differ: number; yes: number; total: number }>(`select
              count(*) filter (where (${before}) is distinct from (${after}))::int as differ,
              count(*) filter (where coalesce((${after}), false))::int as yes, count(*)::int as total from public.${old.table}`);
            expect(row.differ, `${label}: ${old.table}.${old.policy} ${kind}`).toBe(0);
            admitted.set(`${old.policy} ${kind}`, (admitted.get(`${old.policy} ${kind}`) ?? 0) + row.yes);
          }
        }
      });
    }
    // Every rewritten expression admits some row for some caller.
    const never = [...admitted].filter(([, yes]) => yes === 0).map(([key]) => key);
    expect(never).toEqual([]);
  });

  it("show every caller the same rows through the policies as the previous expressions did", async () => {
    const tables = ["students", "enrollments", "attendance", "student_fees", "fee_payments", "class_logs", "class_activities"];
    const visible = async () => {
      const seen: Record<string, string> = {};
      for (const [label, user] of callers) {
        await asCaller(user, async () => {
          for (const table of tables) {
            const { rows: [row] } = await db.query<{ n: number; ids: string }>(`select count(*)::int as n, md5(coalesce(string_agg(id::text, ',' order by id::text), '')) as ids from public.${table}`);
            seen[`${label}: ${table}`] = `${row.n} ${row.ids}`;
          }
        }, "authenticated");
      }
      return seen;
    };
    const now = await visible();
    await db.exec("begin");
    try {
      await db.exec("set local search_path = public, pg_temp");
      for (const old of OLD) {
        await db.exec(`alter policy ${old.policy} on public.${old.table} using (${old.using})${old.check ? ` with check (${old.check})` : ""}`);
      }
      await db.exec("savepoint previous_policies");
      const before: Record<string, string> = {};
      for (const [label, user] of callers) {
        await db.exec("savepoint caller");
        await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
          [user, JSON.stringify({ sub: user, session_id: user, aal: "aal2", role: "authenticated" })]);
        await db.exec("set local role authenticated");
        for (const table of tables) {
          const { rows: [row] } = await db.query<{ n: number; ids: string }>(`select count(*)::int as n, md5(coalesce(string_agg(id::text, ',' order by id::text), '')) as ids from public.${table}`);
          before[`${label}: ${table}`] = `${row.n} ${row.ids}`;
        }
        await db.exec("reset role; rollback to savepoint caller; release savepoint caller");
      }
      expect(now).toEqual(before);
      // Not vacuous: some callers see rows and some see none.
      expect(Object.values(now).some((v) => !v.startsWith("0 "))).toBe(true);
      expect(Object.values(now).some((v) => v.startsWith("0 "))).toBe(true);
    } finally { await db.exec("rollback"); }
  });

  it("keeps the helpers to facts about the caller and closed to anonymous callers", async () => {
    const { rows } = await db.query<{ name: string; definer: boolean; anon: boolean; authenticated: boolean }>(`select p.proname as name, p.prosecdef as definer,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app_private'
      and p.proname in ('caller_is_super_admin','caller_role_school_ids','caller_has_active_attendance_coverage') order by 1`);
    expect(rows).toEqual(["caller_has_active_attendance_coverage", "caller_is_super_admin", "caller_role_school_ids"].map((name) => ({ name, definer: true, anon: false, authenticated: true })));
    const facts = (user: string) => asCaller(user, async () => (await db.query<{ value: Record<string, unknown> }>(`select jsonb_build_object(
      'super', app_private.caller_is_super_admin(), 'schools', app_private.caller_role_school_ids(enum_range(null::public.app_role))) as value`)).rows[0].value, "authenticated");
    expect(await facts(id.adminA)).toEqual({ super: false, schools: [id.schoolA] });
    expect(await facts(extra.superAdmin)).toEqual({ super: true, schools: [] });
    expect(await facts(extra.scopedSuperAdminA)).toEqual({ super: false, schools: [] });
    expect(await facts(extra.inactiveAdminA)).toEqual({ super: false, schools: [] });
    expect(await facts(extra.ghost)).toEqual({ super: false, schools: [] });
    const scopes = (user: string) => asCaller(user, async () => (await db.query<{ value: unknown }>(`select coalesce(jsonb_agg(jsonb_build_array(s.school_id, s.academic_year_id, s.section_id) order by s.section_id), '[]') as value
      from app_private.caller_attendance_register_scopes() s`)).rows[0].value, "authenticated");
    expect(await scopes(id.teacherA)).toEqual([[id.schoolA, id.yearA, id.sectionA]]);
    expect(await scopes(extra.substituteA)).toEqual([[id.schoolA, id.yearA, id.sectionA]]);
    expect(await scopes(extra.subjectTeacherA)).toEqual([]);
    expect(await scopes(id.adminA)).toEqual([]);
    expect(await scopes(extra.ghost)).toEqual([]);
    const { rows: [helper] } = await db.query<{ anon: boolean; authenticated: boolean }>(`select has_function_privilege('anon','app_private.caller_attendance_register_scopes()','EXECUTE') as anon,
      has_function_privilege('authenticated','app_private.caller_attendance_register_scopes()','EXECUTE') as authenticated`);
    expect(helper).toEqual({ anon: false, authenticated: true });
  });
});
