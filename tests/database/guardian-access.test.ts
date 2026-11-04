// @vitest-environment node

import { readFile, readdir } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS as actors, STAFF_ROWS as fixtures } from "./staff-scope-fixture";

const migrations = new URL("../../supabase/migrations/", import.meta.url);
const guardianEmail = "guardian-first@example.test";
const alternateEmail = "guardian-after-email-change@example.test";
const otherGuardianEmail = "guardian-second@example.test";
const reason = "School verified updated guardian permission.";
const lookupSql = "select public.lookup_guardian_access($1,$2) as record";
const revokeSql = "select public.revoke_guardian_access($1,$2,$3,$4) as removed";
const acceptSql = "select public.accept_guardian_invitation($1)";

describe("school guardian access removal", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createStaffScopeDatabase({ includeTeachingRpcs: true, applyGovernance: true, includeGuardianInvitations: true });
    const files = await readdir(migrations);
    for (const suffix of [
      "_repair_school_policy_helper.sql", "_guardian_invitations.sql", "_secure_notice_audiences.sql",
      "_scope_student_study_materials.sql", "_revoke_guardian_access.sql",
    ]) {
      const file = files.find((entry) => entry.endsWith(suffix));
      if (!file) throw new Error(`Missing migration ${suffix}`);
      await db.exec(await readFile(new URL(file, migrations), "utf8"));
    }
    await confirmEmail(actors.parentA, guardianEmail);
    await confirmEmail(actors.outsider, otherGuardianEmail);
    await db.query(`
      insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status,marked_by)
      values ($1,$2,$3,$4,'2026-11-03','present',$5)
    `, [actors.schoolA, fixtures.A.year, fixtures.privateSectionA, fixtures.privateStudentA, actors.teacherA]);
    await db.query(`
      insert into public.notices(school_id,title,content,audience,published_at) values
        ($1,'Guardian general','QA',jsonb_build_object('roles',jsonb_build_array('parent')),now()),
        ($1,'Guardian child','QA',jsonb_build_object('roles',jsonb_build_array('parent'),'section_id',$2::text),now()),
        ($1,'Guardian sibling','QA',jsonb_build_object('roles',jsonb_build_array('parent'),'section_id',$3::text),now())
    `, [actors.schoolA, fixtures.A.section, fixtures.privateSectionA]);
    await db.query(`
      insert into public.study_materials (school_id,class_id,section_id,title,published_at)
      values ($1,$2,$3,'Sibling material',now())
    `, [actors.schoolA, fixtures.privateClassA, fixtures.privateSectionA]);
  }, 30_000);

  afterAll(async () => { await db?.close(); });

  function confirmEmail(actor: string, email: string) {
    return db.query("update auth.users set email = $2, email_confirmed_at = now() where id = $1", [actor, email]);
  }

  async function issue(email: string, student: string = fixtures.A.student) {
    const { rows: [result] } = await asStaffActor<{ invite: { id: string; token: string } }>(
      db, actors.adminA, "select public.issue_guardian_invitation($1,$2,$3) as invite", [actors.schoolA, student, email],
    );
    return result.invite;
  }

  function revoke(student: string = fixtures.A.student, parent: string = fixtures.A.parent, note = reason) {
    return asStaffActor(db, actors.adminA, revokeSql, [actors.schoolA, student, parent, note]);
  }

  function readRows(actor: string, sql: string, params: unknown[] = []) {
    return asStaffActor(db, actor, sql, params).then(({ rows }) => rows);
  }

  it("requires a scoped school admin, a coherent pair, and an auditable reason", async () => {
    for (const actor of [actors.parentA, actors.principalA, actors.adminB, actors.superAdmin]) {
      await expect(asStaffActor(db, actor, lookupSql, [actors.schoolA, "STUDENT-A"])).rejects.toMatchObject({ code: "42501" });
      await expect(asStaffActor(db, actor, revokeSql, [actors.schoolA, fixtures.A.student, fixtures.A.parent, reason]))
        .rejects.toMatchObject({ code: "42501" });
    }
    await expect(asStaffActor(db, null, lookupSql, [actors.schoolA, "STUDENT-A"], "anon")).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, actors.adminA, "select * from app_private.guardian_access_audit")).rejects.toMatchObject({ code: "42501" });
    await expect(revoke(fixtures.B.student)).rejects.toMatchObject({ code: "42501" });
    await expect(revoke(fixtures.A.student, fixtures.B.parent)).rejects.toMatchObject({ code: "42501" });
    await expect(revoke(fixtures.A.student, fixtures.A.parent, " no ")).rejects.toMatchObject({ code: "22023" });
    expect(await readRows(actors.adminA, lookupSql, [actors.schoolA, "STUDENT-B"])).toEqual([{ record: null }]);
    expect(await readRows(actors.adminA, lookupSql, [actors.schoolA, " STUDENT-A "])).toEqual([
      { record: expect.objectContaining({ student_id: fixtures.A.student, guardians: [expect.objectContaining({ parent_id: fixtures.A.parent })] }) },
    ]);
  });

  it("revokes attendance, fees, notices and materials for only the selected link and records the actor", async () => {
    await asStaffActor(db, actors.parentA, acceptSql, [(await issue(guardianEmail, fixtures.privateStudentA)).token]);
    await asStaffActor(db, actors.outsider, acceptSql, [(await issue(otherGuardianEmail)).token]);
    const noticeSql = "select title from public.notices where title like 'Guardian %' order by title";
    const materialSql = "select title from public.study_materials order by title";
    const attendanceSql = "select student_id from public.attendance order by student_id";
    expect(await readRows(actors.parentA, noticeSql)).toEqual([
      { title: "Guardian child" }, { title: "Guardian general" }, { title: "Guardian sibling" },
    ]);
    expect(await readRows(actors.parentA, materialSql)).toEqual([{ title: "Material A" }, { title: "Sibling material" }]);
    expect(await readRows(actors.parentA, "select id from public.student_fees")).toEqual([{ id: fixtures.A.fee }]);
    expect(await readRows(actors.parentA, "select id from public.fee_payments")).toEqual([{ id: fixtures.A.payment }]);
    expect(await readRows(actors.parentA, attendanceSql)).toEqual([
      { student_id: fixtures.A.student }, { student_id: fixtures.privateStudentA },
    ]);

    expect((await revoke()).rows).toEqual([{ removed: true }]);
    expect((await revoke()).rows).toEqual([{ removed: false }]);

    expect(await readRows(actors.parentA, attendanceSql)).toEqual([{ student_id: fixtures.privateStudentA }]);
    expect(await readRows(actors.parentA, noticeSql)).toEqual([{ title: "Guardian general" }, { title: "Guardian sibling" }]);
    expect(await readRows(actors.parentA, materialSql)).toEqual([{ title: "Sibling material" }]);
    expect(await readRows(actors.parentA, "select id from public.student_fees")).toEqual([]);
    expect(await readRows(actors.parentA, "select id from public.fee_payments")).toEqual([]);
    expect(await readRows(actors.outsider, attendanceSql)).toEqual([{ student_id: fixtures.A.student }]);
    expect(await readRows(actors.outsider, materialSql)).toEqual([{ title: "Material A" }]);
    expect(await readRows(actors.outsider, "select id from public.student_fees")).toEqual([{ id: fixtures.A.fee }]);

    expect(await readRows(actors.adminA, lookupSql, [actors.schoolA, "STUDENT-A"])).toEqual([
      { record: expect.objectContaining({
        guardians: [expect.objectContaining({ email: otherGuardianEmail })],
        events: [
          expect.objectContaining({ action: "revoked", reason, actor_name: "adminA", guardian_name: "parentA" }),
          expect.objectContaining({ action: "linked", actor_name: "outsider" }),
        ],
      }) },
    ]);

    expect((await revoke(fixtures.privateStudentA)).rows).toEqual([{ removed: true }]);
    expect(await readRows(actors.parentA, "select role from public.user_roles")).toEqual([]);
    expect(await readRows(actors.parentA, noticeSql)).toEqual([]);
    expect(await readRows(actors.parentA, attendanceSql)).toEqual([]);
  });

  it("blocks every older invite for the removed guardian and allows a newly authorized link", async () => {
    await asStaffActor(db, actors.parentA, acceptSql, [(await issue(guardianEmail)).token]);
    const current = await issue(guardianEmail);
    const alternate = await issue(alternateEmail);
    expect((await revoke()).rows).toEqual([{ removed: true }]);
    expect((await db.query("select revoked_at from app_private.guardian_invitations where id = $1", [current.id])).rows)
      .toEqual([{ revoked_at: expect.any(Date) }]);
    await expect(asStaffActor(db, actors.parentA, acceptSql, [current.token])).rejects.toMatchObject({ code: "P0001" });

    await confirmEmail(actors.parentA, alternateEmail);
    await expect(asStaffActor(db, actors.parentA, acceptSql, [alternate.token])).rejects.toMatchObject({ code: "P0001" });
    const fresh = await issue(alternateEmail);
    await asStaffActor(db, actors.parentA, acceptSql, [fresh.token]);
    expect(await readRows(actors.parentA, "select student_id from public.student_parents where parent_id = $1", [fixtures.A.parent]))
      .toEqual([{ student_id: fixtures.A.student }]);
  });

  it("finds and revokes an existing guardian after enrollment withdrawal", async () => {
    await db.query("update public.enrollments set status = 'withdrawn' where id = $1", [fixtures.A.enrollment]);
    await expect(issue("guardian-inactive@example.test")).rejects.toMatchObject({ code: "P0001" });
    expect(await readRows(actors.adminA, lookupSql, [actors.schoolA, "STUDENT-A"])).toEqual([
      { record: expect.objectContaining({
        student_id: fixtures.A.student,
        guardians: expect.arrayContaining([expect.objectContaining({ parent_id: fixtures.A.parent })]),
      }) },
    ]);
    expect((await revoke()).rows).toEqual([{ removed: true }]);
    expect(await readRows(actors.parentA, "select student_id from public.attendance")).toEqual([]);
    expect(await readRows(actors.outsider, "select student_id from public.attendance")).toEqual([{ student_id: fixtures.A.student }]);
  });
});
