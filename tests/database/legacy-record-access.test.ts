// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asStaffActor as asActor, STAFF_IDS as actor, STAFF_ROWS as school } from "./staff-scope-fixture";
import { createLegacyRecordDatabase, insertLegacyRow, LEGACY_IDS as ids, LEGACY_TABLES as tables, readLegacyRecordSql } from "./legacy-record-fixture";

const rows = async (db: PGlite, user: string | null, table: string) => (await asActor<{ id: string }>(db, user, `select id from public.${table} order by id`)).rows.map((row) => row.id);
const history = async (db: PGlite) => Object.fromEntries(await Promise.all([...tables, "fee_payments"].map(async (table) => [table, (await db.query(`select * from public.${table} order by id`)).rows])));

describe("legacy records use explicit read roles and trusted-only mutations", () => {
  let db: PGlite;
  beforeAll(async () => { db = await createLegacyRecordDatabase(); }, 30_000);
  afterAll(async () => { await db?.close(); });

  it("reproduces deployed reception payroll/marks/audit tampering, then preserves exact history while closing it", async () => {
    const baseline = await createLegacyRecordDatabase({ applyMigration: false });
    try {
      await asActor(baseline, actor.receptionA, "update public.payroll set gross_salary=1 where id=$1", [ids.A.payroll]);
      await asActor(baseline, actor.receptionA, "update public.marks set marks_obtained=1 where id=$1", [ids.A.mark]);
      await asActor(baseline, actor.receptionA, "delete from public.audit_logs where id=$1", [ids.A.audit]);
      expect((await baseline.query("select gross_salary from public.payroll where id=$1", [ids.A.payroll])).rows).toEqual([{ gross_salary: "1.00" }]);
      expect((await baseline.query("select marks_obtained from public.marks where id=$1", [ids.A.mark])).rows).toEqual([{ marks_obtained: "1" }]);
      expect((await baseline.query("select id from public.audit_logs where id=$1", [ids.A.audit])).rows).toEqual([]);
      const before = await history(baseline);
      await baseline.exec(await readLegacyRecordSql());
      expect(await history(baseline)).toEqual(before);
      await expect(asActor(baseline, actor.receptionA, "update public.payroll set gross_salary=999 where id=$1", [ids.A.payroll])).rejects.toThrow(/permission denied/i);
      await expect(asActor(baseline, actor.receptionA, "update public.marks set marks_obtained=99 where id=$1", [ids.A.mark])).rejects.toThrow(/permission denied/i);
      await expect(asActor(baseline, actor.receptionA, "delete from public.audit_logs")).rejects.toThrow(/permission denied/i);
      expect(await history(baseline)).toEqual(before);
    } finally { await baseline.close(); }
  }, 30_000);

  it.each([actor.adminA, actor.principalA, actor.accountantA])("allows approved payroll readers only in their own school: %s", async (user) => {
    expect(await rows(db, user, "payroll")).toEqual([ids.A.payroll]);
  });
  it.each([actor.adminA, actor.principalA])("allows approved marks/audit readers only in their own school: %s", async (user) => {
    expect(await rows(db, user, "marks")).toEqual([ids.A.mark]);
    expect(await rows(db, user, "audit_logs")).toEqual([ids.A.audit]);
  });
  it("separates global and school scope, including NULL-school audit rows", async () => {
    expect(await rows(db, actor.adminB, "payroll")).toEqual([ids.B.payroll]);
    expect(await rows(db, actor.adminB, "marks")).toEqual([ids.B.mark]);
    expect(await rows(db, actor.adminB, "audit_logs")).toEqual([ids.B.audit]);
    expect(await rows(db, actor.superAdmin, "payroll")).toEqual([ids.A.payroll, ids.B.payroll]);
    expect(await rows(db, actor.superAdmin, "marks")).toEqual([ids.A.mark, ids.B.mark]);
    expect(await rows(db, actor.superAdmin, "audit_logs")).toEqual([ids.A.audit, ids.B.audit, ids.platformAudit]);
  });
  it.each([actor.receptionA, actor.teacherA, actor.parentA, actor.studentA, actor.teacherB, actor.outsider])("denies sensitive legacy reads for an unrelated role: %s", async (user) => {
    for (const table of tables) expect(await rows(db, user, table)).toEqual([]);
  });
  it("does not turn accountant or mixed-school family/teacher roles into marks/audit authority", async () => {
    for (const user of [actor.accountantA, actor.mixedTeacher, actor.mixedParent]) {
      expect(await rows(db, user, "payroll")).toEqual([ids.A.payroll]);
      expect(await rows(db, user, "marks")).toEqual([]);
      expect(await rows(db, user, "audit_logs")).toEqual([]);
    }
  });
  it("requires a global NULL-school super-admin membership and a real authenticated identity", async () => {
    for (const table of tables) expect(await rows(db, null, table)).toEqual([]);
    await db.query("update public.user_roles set school_id=$1 where user_id=$2", [actor.schoolA, actor.superAdmin]);
    try { for (const table of tables) expect(await rows(db, actor.superAdmin, table)).toEqual([]); }
    finally { await db.query("update public.user_roles set school_id=null where user_id=$1", [actor.superAdmin]); }
  });
  it("removes access immediately when the profile is inactive or the matching role is revoked", async () => {
    for (const user of [actor.adminA, actor.accountantA, actor.superAdmin]) {
      await db.query("update public.profiles set is_active=false where id=$1", [user]);
      try { for (const table of tables) expect(await rows(db, user, table)).toEqual([]); }
      finally { await db.query("update public.profiles set is_active=true where id=$1", [user]); }
    }
    await db.query("update public.user_roles set role='reception_staff' where user_id=$1", [actor.principalA]);
    try { for (const table of tables) expect(await rows(db, actor.principalA, table)).toEqual([]); }
    finally { await db.query("update public.user_roles set role='principal' where user_id=$1", [actor.principalA]); }
  });
  it("preserves historical reads without current pupil enrollment or an active employee", async () => {
    await db.query("update public.enrollments set status='withdrawn' where student_id=$1", [school.A.student]);
    try {
      expect(await rows(db, actor.adminA, "marks")).toEqual([ids.A.mark]);
      expect(await rows(db, actor.accountantA, "payroll")).toEqual([ids.A.payroll]);
      expect((await asActor(db, actor.accountantA, "select net_salary from public.payroll")).rows).toEqual([{ net_salary: "61000.00" }]);
    } finally { await db.query("update public.enrollments set status='active' where student_id=$1", [school.A.student]); }
  });
  it("hides incoherent employee/pupil/year/class/subject relationships without deleting their history", async () => {
    await insertLegacyRow(db, "payroll", { id: ids.incoherent, school_id: actor.schoolA, employee_id: ids.B.employee, payroll_month: "2025-04-01", gross_salary: "45000.00" });
    await insertLegacyRow(db, "marks", { id: ids.incoherent2, exam_subject_id: ids.A.item, student_id: school.B.student, marks_obtained: "60" });
    try {
      expect(await rows(db, actor.superAdmin, "payroll")).not.toContain(ids.incoherent);
      expect(await rows(db, actor.superAdmin, "marks")).not.toContain(ids.incoherent2);
      for (const [table, column, target, other, own] of [
        ["exams", "academic_year_id", ids.A.exam, school.B.year, school.A.year],
        ["exam_subjects", "class_id", ids.A.item, school.B.class, school.A.class],
        ["exam_subjects", "subject_id", ids.A.item, school.B.subject, school.A.subject],
      ]) {
        await db.query(`update public.${table} set ${column}=$1 where id=$2`, [other, target]);
        try { expect(await rows(db, actor.adminA, "marks")).toEqual([]); }
        finally { await db.query(`update public.${table} set ${column}=$1 where id=$2`, [own, target]); }
      }
      expect((await db.query("select id from public.payroll where id=$1", [ids.incoherent])).rows).toEqual([{ id: ids.incoherent }]);
      expect((await db.query("select id from public.marks where id=$1", [ids.incoherent2])).rows).toEqual([{ id: ids.incoherent2 }]);
    } finally {
      await db.query("delete from public.payroll where id=$1", [ids.incoherent]);
      await db.query("delete from public.marks where id=$1", [ids.incoherent2]);
    }
  });
  it.each(tables)("denies all client writes, truncation and anonymous reads on %s, including admins", async (table) => {
    const before = await history(db);
    const sample = table === "payroll" ? { id: ids.extra, school_id: actor.schoolA, employee_id: ids.A.employee, payroll_month: "2025-05-01", gross_salary: "10" }
      : table === "marks" ? { id: ids.extra, exam_subject_id: ids.A.item, student_id: school.privateStudentA, marks_obtained: "10" }
      : { id: ids.extra, school_id: actor.schoolA, actor_user_id: actor.adminA, action: "forged.client.event" };
    const keys = Object.keys(sample);
    const insertSql = `insert into public.${table} (${keys.join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")})`;
    for (const user of [actor.superAdmin, actor.adminA, actor.principalA, actor.accountantA, actor.receptionA, actor.teacherA, actor.parentA, actor.studentA, null]) {
      await expect(asActor(db, user, insertSql, Object.values(sample))).rejects.toThrow(/permission denied/i);
      await expect(asActor(db, user, `update public.${table} set id=id`)).rejects.toThrow(/permission denied/i);
      await expect(asActor(db, user, `delete from public.${table}`)).rejects.toThrow(/permission denied/i);
      await expect(asActor(db, user, `truncate public.${table}`)).rejects.toThrow(/permission denied/i);
    }
    await expect(asActor(db, null, `select * from public.${table}`, [], "anon")).rejects.toThrow(/permission denied/i);
    await expect(asActor(db, null, insertSql, Object.values(sample), "anon")).rejects.toThrow(/permission denied/i);
    expect(await history(db)).toEqual(before);
  });
  it("keeps trusted service and owner writes working without exposing the old audit RPC", async () => {
    await asActor(db, null, "insert into public.audit_logs(id,school_id,action) values ($1,$2,'server.event')", [ids.extra, actor.schoolA], "service_role");
    await asActor(db, null, "update public.payroll set bonuses=bonuses+1 where id=$1", [ids.A.payroll], "service_role");
    try {
      expect((await asActor(db, null, "select action from public.audit_logs where id=$1", [ids.extra], "service_role")).rows).toEqual([{ action: "server.event" }]);
      expect((await db.query("select net_salary from public.payroll where id=$1", [ids.A.payroll])).rows).toEqual([{ net_salary: "61001.00" }]);
      await db.query("update public.audit_logs set action='owner.event' where id=$1", [ids.extra]);
      expect((await db.query("select action from public.audit_logs where id=$1", [ids.extra])).rows).toEqual([{ action: "owner.event" }]);
      for (const user of [actor.adminA, actor.principalA, actor.superAdmin, actor.parentA]) {
        await expect(asActor(db, user, "select public.write_audit_log($1,'forged','payroll')", [actor.schoolA])).rejects.toThrow(/permission denied/i);
      }
      expect((await db.query("select has_function_privilege('service_role','public.write_audit_log(uuid,text,text,text,uuid,text,jsonb)','EXECUTE') as allowed")).rows).toEqual([{ allowed: true }]);
    } finally {
      await asActor(db, null, "delete from public.audit_logs where id=$1", [ids.extra], "service_role");
      await db.query("update public.payroll set bonuses=bonuses-1 where id=$1", [ids.A.payroll]);
    }
  });
  it("clears table/column grants, keeps SELECT-only policies and is safe to rerun", async () => {
    await db.exec("grant update(gross_salary), references(employee_id) on public.payroll to authenticated; grant select(action), insert(action) on public.audit_logs to anon; grant update(marks_obtained) on public.marks to public");
    const before = await history(db);
    await db.exec(await readLegacyRecordSql());
    expect(await history(db)).toEqual(before);
    const policyRows = (await db.query("select tablename,cmd,roles,with_check from pg_policies where schemaname='public' and tablename in ('payroll','marks','audit_logs') order by tablename")).rows;
    expect(policyRows).toEqual(["audit_logs", "marks", "payroll"].map((tablename) => ({ tablename, cmd: "SELECT", roles: ["authenticated"], with_check: null })));
    for (const table of tables) expect((await db.query("select has_table_privilege('authenticated',$1,'SELECT') as readable,has_any_column_privilege('authenticated',$1,'INSERT,UPDATE,REFERENCES') as writable,has_any_column_privilege('anon',$1,'SELECT,INSERT,UPDATE,REFERENCES') as anonymous", [`public.${table}`])).rows).toEqual([{ readable: true, writable: false, anonymous: false }]);
    const helpers = (await db.query("select prosecdef,proconfig,has_function_privilege('anon',oid,'EXECUTE') as anonymous from pg_proc where pronamespace='app_private'::regnamespace and proname in ('legacy_office_reader','can_read_legacy_payroll','can_read_legacy_mark')")).rows;
    expect(helpers).toHaveLength(3);
    for (const helper of helpers) expect(helper).toEqual({ prosecdef: true, proconfig: ['search_path=""'], anonymous: false });
  });
  it("aborts atomically for an unknown permissive policy or inherited client write access", async () => {
    await db.exec("create policy unexpected on public.marks for all to authenticated using(true) with check(true)");
    try { await expect(db.exec(await readLegacyRecordSql())).rejects.toThrow(/complete legacy policy set/i); }
    finally { await db.exec("rollback; drop policy unexpected on public.marks"); }
    await db.exec("create role inherited_legacy; grant update on public.payroll to inherited_legacy; grant inherited_legacy to authenticated");
    try { await expect(db.exec(await readLegacyRecordSql())).rejects.toThrow(/inherited or column grants/i); }
    finally { await db.exec("rollback; revoke inherited_legacy from authenticated; drop owned by inherited_legacy; drop role inherited_legacy"); }
    expect(await rows(db, actor.adminA, "marks")).toEqual([ids.A.mark]);
    await expect(asActor(db, actor.adminA, "update public.payroll set gross_salary=1")).rejects.toThrow(/permission denied/i);
  });
});
