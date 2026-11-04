// @vitest-environment node
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS as ids, STAFF_ROWS as records } from "./staff-scope-fixture";

const directory = new URL("../../supabase/migrations/", import.meta.url);
const email = "qa-teacher@example.test";
let db: Awaited<ReturnType<typeof createStaffScopeDatabase>>;

beforeAll(async () => {
  db = await createStaffScopeDatabase({ includeTeachingRpcs: true, applyGovernance: true, includeGuardianInvitations: true });
  const migrations = await readdir(directory);
  for (const suffix of ["_teacher_assessments_and_profile.sql", "_repair_school_policy_helper.sql", "_guardian_invitations.sql"]) {
    const file = migrations.find((name) => name.endsWith(suffix));
    if (!file) throw new Error(`Missing migration: ${suffix}`);
    await db.exec(await readFile(new URL(file, directory), "utf8"));
  }

  // Reproduce the legacy grants and policy found in the hosted demo.
  await db.exec(`
    create function public.activate_teacher(text,text) returns uuid language sql security definer as 'select null::uuid';
    create function public.activate_accountant(text,text) returns uuid language sql security definer as 'select null::uuid';
    create table public.payroll (school_id uuid not null references public.schools(id), gross_salary numeric not null);
    alter table public.payroll enable row level security;
    grant select, update on public.payroll to authenticated;
    create policy tenant_isolation_payroll on public.payroll for all to authenticated
      using (school_id in (select public.current_user_school_ids()))
      with check (school_id in (select public.current_user_school_ids()));
  `);
  await db.query("insert into public.payroll(school_id,gross_salary) values($1,45000),($2,60000)", [ids.schoolA, ids.schoolB]);
  await db.query("update auth.users set email = $2, email_confirmed_at = now() where id = $1", [ids.outsider, email]);
  await db.query("update auth.users set email = $2, email_confirmed_at = now() where id = $1", [ids.parentB, "outside-school@example.test"]);
  await db.query("update auth.users set email = $2, email_confirmed_at = now() where id = $1", [ids.accountantA, "accountant@example.test"]);
  await db.query("update auth.users set email = $2 where id = $1", [ids.studentA, "unverified@example.test"]);

  const file = migrations.find((name) => name.endsWith("_teacher_invitations.sql"));
  if (!file) throw new Error("Teacher invitation migration is missing.");
  await db.exec(await readFile(new URL(file, directory), "utf8"));
}, 30_000);

afterAll(async () => { await db?.close(); });

async function add(employeeId: string, actor: string = ids.adminA, school: string = ids.schoolA) {
  const { rows } = await asStaffActor<{ id: string }>(db, actor, "select public.create_teacher_record($1,$2,$3) as id", [
    school, employeeId, " QA Teacher ",
  ]);
  return rows[0].id;
}

async function issue(teacherId: string, recipient = email, actor: string = ids.adminA) {
  const { rows } = await asStaffActor<{ invite: { id: string; token: string; expires_at: string } }>(
    db, actor, "select public.issue_teacher_invitation($1,$2) as invite", [teacherId, recipient],
  );
  return rows[0].invite;
}

function accept(actor: string, token: string) {
  return asStaffActor(db, actor, "select public.accept_teacher_invitation($1) as result", [token]);
}

describe("verified teacher onboarding", () => {
  it("permits a scoped active leader to add a teacher and blocks direct account binding", async () => {
    await expect(add(" forbidden ", ids.teacherA)).rejects.toMatchObject({ code: "42501" });
    await expect(add(" forbidden ", ids.adminB)).rejects.toMatchObject({ code: "42501" });
    await expect(add(" invalid\nID ")).rejects.toMatchObject({ code: "22023" });

    const teacherId = await add(" QA-TEACHER-NEW ", ids.principalA);
    expect((await db.query("select full_name,employee_id,profile_id from public.teachers where id = $1", [teacherId])).rows)
      .toEqual([{ full_name: "QA Teacher", employee_id: "QA-TEACHER-NEW", profile_id: null }]);
    await expect(add(" qa-teacher-new ")).rejects.toMatchObject({ code: "23505" });

    await expect(asStaffActor(db, ids.adminA, "insert into public.teachers (school_id,employee_id) values($1,'DIRECT')", [ids.schoolA]))
      .rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, ids.adminA, "update public.teachers set profile_id = $1 where id = $2", [ids.outsider, teacherId]))
      .rejects.toMatchObject({ code: "42501" });
    expect((await asStaffActor(db, ids.adminA, "update public.teachers set department = 'Teaching' where id = $1 returning department", [teacherId])).rows)
      .toEqual([{ department: "Teaching" }]);
    await expect(asStaffActor(db, ids.outsider, "select public.activate_teacher('EMPLOYEE','111')"))
      .rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, ids.outsider, "select public.activate_accountant('EMPLOYEE','111')"))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("keeps invite tokens private and rejects replacement, revoked, expired, and wrong email links", async () => {
    const teacherId = await add("QA-TEACHER-TOKENS");
    await expect(issue(teacherId, email, ids.teacherA)).rejects.toMatchObject({ code: "42501" });
    await expect(issue(teacherId, email, ids.adminB)).rejects.toMatchObject({ code: "42501" });
    await expect(issue(records.A.teacher)).rejects.toMatchObject({ code: "P0001" });
    await expect(issue(teacherId, "invalid")).rejects.toMatchObject({ code: "22023" });

    const invite = await issue(teacherId);
    const listSql = "select public.list_teacher_invitations($1) as invitations";
    const history = (await asStaffActor(db, ids.adminA, listSql, [teacherId])).rows;
    expect(JSON.stringify(history)).toContain(email);
    expect(JSON.stringify(history)).not.toContain(invite.token);
    await expect(asStaffActor(db, ids.adminB, listSql, [teacherId])).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, ids.adminA, "select token_hash from app_private.teacher_invitations")).rejects.toMatchObject({ code: "42501" });
    await expect(accept(ids.teacherA, invite.token)).rejects.toMatchObject({ code: "42501" });

    const unverified = await issue(teacherId, "unverified@example.test");
    await expect(accept(ids.outsider, invite.token)).rejects.toMatchObject({ code: "P0001" });
    await expect(accept(ids.studentA, unverified.token)).rejects.toMatchObject({ code: "42501" });
    const crossSchool = await issue(teacherId, "outside-school@example.test");
    await expect(accept(ids.parentB, crossSchool.token)).rejects.toMatchObject({ code: "42501" });
    const revokeSql = "select public.revoke_teacher_invitation($1) as revoked";
    await expect(asStaffActor(db, ids.adminB, revokeSql, [crossSchool.id])).rejects.toMatchObject({ code: "42501" });
    expect((await asStaffActor(db, ids.adminA, revokeSql, [crossSchool.id])).rows).toEqual([{ revoked: true }]);
    expect((await asStaffActor(db, ids.adminA, revokeSql, [crossSchool.id])).rows).toEqual([{ revoked: false }]);
    const officeAccount = await issue(teacherId, "accountant@example.test");
    await expect(accept(ids.accountantA, officeAccount.token)).rejects.toMatchObject({ code: "42501" });
    const expired = await issue(teacherId);
    await db.query("update app_private.teacher_invitations set created_at = now() - interval '4 days', expires_at = now() - interval '1 day' where id = $1", [expired.id]);
    await expect(accept(ids.outsider, expired.token)).rejects.toMatchObject({ code: "P0001" });
  });

  it("atomically links one teacher and keeps payroll separate from teaching, attendance and family access", async () => {
    const teacherId = await add("QA-TEACHER-ACCEPT");
    const invite = await issue(teacherId, " QA-TEACHER@EXAMPLE.TEST ", ids.principalA);
    const secondTeacher = await add("QA-TEACHER-OTHER");
    const second = await issue(secondTeacher);
    const first = await accept(ids.outsider, invite.token);
    expect(first.rows).toEqual([{ result: { school_id: ids.schoolA, teacher_id: teacherId } }]);
    await expect(accept(ids.outsider, invite.token)).rejects.toMatchObject({ code: "P0001" });
    await expect(accept(ids.outsider, second.token)).rejects.toMatchObject({ code: "42501" });
    expect((await db.query("select id,school_id from public.teachers where profile_id = $1", [ids.outsider])).rows)
      .toEqual([{ id: teacherId, school_id: ids.schoolA }]);
    expect((await asStaffActor(db, ids.outsider, "select role,school_id from public.user_roles")).rows)
      .toEqual([{ role: "teacher", school_id: ids.schoolA }]);
    expect((await asStaffActor(db, ids.outsider, "select id from public.schools")).rows).toEqual([{ id: ids.schoolA }]);
    expect((await asStaffActor(db, ids.outsider, "select id from public.profiles")).rows).toEqual([{ id: ids.outsider }]);
    expect((await asStaffActor(db, ids.studentA, "select id from public.profiles")).rows).toEqual([{ id: ids.studentA }]);
    expect((await asStaffActor(db, ids.outsider, "select gross_salary from public.payroll")).rows).toEqual([]);
    expect((await asStaffActor(db, ids.outsider, "update public.payroll set gross_salary = 1 returning gross_salary")).rows).toEqual([]);
    expect((await asStaffActor(db, ids.studentA, "select gross_salary from public.payroll")).rows).toEqual([]);
    expect((await asStaffActor(db, ids.accountantA, "select gross_salary from public.payroll")).rows)
      .toEqual([{ gross_salary: "45000" }]);

    await db.query("update public.teacher_subject_assignments set teacher_id = $1 where id = $2", [teacherId, records.A.assignment]);
    await db.query(`insert into public.teacher_assessments
      (school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,name,assessment_date,maximum_marks)
      values ($1,$2,$3,$4,$5,$6,'QA assessment','2026-11-04',10)`,
    [ids.schoolA, records.A.year, records.A.class, records.A.section, records.A.subject, teacherId]);
    expect((await asStaffActor(db, ids.outsider, "select name from public.teacher_assessments")).rows).toEqual([{ name: "QA assessment" }]);
    expect((await asStaffActor(db, ids.outsider, "select student_id from public.attendance")).rows).toEqual([{ student_id: records.A.student }]);
    expect((await asStaffActor(db, ids.studentA, "select student_id from public.attendance")).rows).toEqual([{ student_id: records.A.student }]);
    expect((await asStaffActor(db, ids.parentA, "select student_id from public.attendance")).rows).toEqual([{ student_id: records.A.student }]);
  });
});
