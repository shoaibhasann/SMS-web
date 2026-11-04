// @vitest-environment node

import { readFile, readdir } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS, STAFF_ROWS } from "./staff-scope-fixture";

type Invitation = { id: string; token: string; expires_at: string };
const guardianEmail = "qa-guardian@example.test";
const migrationDirectory = new URL("../../supabase/migrations/", import.meta.url);

describe("guardian invitation against recovered school and attendance policies", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createStaffScopeDatabase({ includeTeachingRpcs: true, applyGovernance: true, includeGuardianInvitations: true });
    const files = await readdir(migrationDirectory);
    for (const suffix of ["_repair_school_policy_helper.sql", "_guardian_invitations.sql"]) {
      const migration = files.find((file) => file.endsWith(suffix));
      if (!migration) throw new Error(`Missing migration: ${suffix}`);
      await db.exec(await readFile(new URL(migration, migrationDirectory), "utf8"));
    }
    await db.query("update auth.users set email = $2, email_confirmed_at = now() where id = $1", [STAFF_IDS.outsider, guardianEmail]);
    await db.query("update auth.users set email = $2, email_confirmed_at = now() where id = $1", [STAFF_IDS.teacherA, "teacher@example.test"]);
    await db.query("update auth.users set email = $2, email_confirmed_at = now() where id = $1", [STAFF_IDS.parentA, "existing-guardian@example.test"]);
    await db.query("update auth.users set email = $2, email_confirmed_at = now() where id = $1", [STAFF_IDS.parentB, "other-school@example.test"]);
    await db.query("update auth.users set email = $2 where id = $1", [STAFF_IDS.studentA, "unverified@example.test"]);
    await db.query(`
      insert into public.attendance (school_id, academic_year_id, section_id, student_id, attendance_date, status, marked_by)
      values ($1, $2, $3, $4, '2026-11-03', 'present', $5),
             ($6, $7, $8, $9, '2026-11-03', 'absent', $5)
    `, [
      STAFF_IDS.schoolA, STAFF_ROWS.A.year, STAFF_ROWS.privateSectionA, STAFF_ROWS.privateStudentA, STAFF_IDS.teacherA,
      STAFF_IDS.schoolB, STAFF_ROWS.B.year, STAFF_ROWS.B.section, STAFF_ROWS.A.student,
    ]);
    await db.query(`
      insert into public.study_materials (school_id, title, published_at)
      values ($1, 'School-wide A', now()), ($2, 'School-wide B', now())
    `, [STAFF_IDS.schoolA, STAFF_IDS.schoolB]);
  }, 30000);

  afterAll(async () => { await db?.close(); });

  async function issue(email: string, studentId: string = STAFF_ROWS.A.student, actorId: string = STAFF_IDS.adminA) {
    const { rows } = await asStaffActor<{ invite: Invitation }>(
      db, actorId, "select public.issue_guardian_invitation($1,$2,$3) as invite", [STAFF_IDS.schoolA, studentId, email],
    );
    return rows[0].invite;
  }

  function accept(actorId: string, token: string) {
    return asStaffActor<{ result: { school_id: string; student_id: string } }>(
      db, actorId, "select public.accept_guardian_invitation($1) as result", [token],
    );
  }

  it("requires a scoped administrator and a current, active enrolment", async () => {
    await expect(issue(guardianEmail, STAFF_ROWS.A.student, STAFF_IDS.adminB)).rejects.toMatchObject({ code: "42501" });
    await expect(issue(guardianEmail, STAFF_ROWS.A.student, STAFF_IDS.accountantA)).rejects.toMatchObject({ code: "42501" });
    await expect(issue(guardianEmail, STAFF_ROWS.A.student, STAFF_IDS.teacherA)).rejects.toMatchObject({ code: "42501" });
    await expect(issue(guardianEmail, STAFF_ROWS.B.student)).rejects.toMatchObject({ code: "P0001" });
    await expect(issue("invalid email")).rejects.toMatchObject({ code: "22023" });
    const principalInvite = await issue("principal-issued@example.test", STAFF_ROWS.A.student, STAFF_IDS.principalA);
    expect(principalInvite.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stores only the token hash and lets scoped admins list and revoke without the token", async () => {
    const invite = await issue("list-revoke@example.test");
    const { rows: [stored] } = await db.query<{ token_hash: string }>(
      "select encode(token_hash,'hex') as token_hash from app_private.guardian_invitations where id = $1", [invite.id],
    );
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.token_hash).not.toBe(invite.token);
    const listSql = "select public.list_guardian_invitations($1,$2) as invites";
    const args = [STAFF_IDS.schoolA, STAFF_ROWS.A.student];
    const { rows: [listed] } = await asStaffActor<{ invites: unknown[] }>(db, STAFF_IDS.adminA, listSql, args);
    expect(listed.invites).toContainEqual(expect.objectContaining({ id: invite.id, email: "list-revoke@example.test", revoked_at: null }));
    expect(JSON.stringify(listed)).not.toContain(invite.token);
    expect(JSON.stringify(listed)).not.toContain(stored.token_hash);
    await expect(asStaffActor(db, STAFF_IDS.adminB, listSql, args)).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, STAFF_IDS.adminB, "select public.revoke_guardian_invitation($1)", [invite.id])).rejects.toMatchObject({ code: "42501" });
    const revokeSql = "select public.revoke_guardian_invitation($1) as revoked";
    expect((await asStaffActor(db, STAFF_IDS.adminA, revokeSql, [invite.id])).rows).toEqual([{ revoked: true }]);
    expect((await asStaffActor(db, STAFF_IDS.adminA, revokeSql, [invite.id])).rows).toEqual([{ revoked: false }]);
    await expect(accept(STAFF_IDS.outsider, invite.token)).rejects.toMatchObject({ code: "P0001" });
  });

  it("requires the confirmed recipient email and rejects expired, replaced and unverified invitations", async () => {
    const invite = await issue(guardianEmail);
    await expect(accept(STAFF_IDS.teacherA, invite.token)).rejects.toMatchObject({ code: "42501" });
    const unverified = await issue("unverified@example.test");
    await expect(accept(STAFF_IDS.studentA, unverified.token)).rejects.toMatchObject({ code: "42501" });
    const replacement = await issue("  QA-Guardian@EXAMPLE.TEST  ");
    await expect(accept(STAFF_IDS.outsider, invite.token)).rejects.toMatchObject({ code: "P0001" });
    await db.query(`
      update app_private.guardian_invitations
      set created_at = now() - interval '96 hours', expires_at = now() - interval '24 hours'
      where id = $1
    `, [replacement.id]);
    await expect(accept(STAFF_IDS.outsider, replacement.token)).rejects.toMatchObject({ code: "P0001" });
    const { rows } = await db.query("select id from public.parents where profile_id = $1", [STAFF_IDS.outsider]);
    expect(rows).toEqual([]);
  });

  it("links the verified account once and reads only the child's coherent attendance", async () => {
    const invite = await issue(guardianEmail);
    const { rows } = await accept(STAFF_IDS.outsider, invite.token);
    expect(rows).toEqual([{ result: { school_id: STAFF_IDS.schoolA, student_id: STAFF_ROWS.A.student } }]);
    await expect(accept(STAFF_IDS.outsider, invite.token)).rejects.toMatchObject({ code: "P0001" });
    const { rows: parentLinks } = await asStaffActor(
      db, STAFF_IDS.outsider, "select student_id,relationship from public.student_parents",
    );
    expect(parentLinks).toEqual([{ student_id: STAFF_ROWS.A.student, relationship: "guardian" }]);
    const attendance = await asStaffActor(db, STAFF_IDS.outsider, "select school_id,student_id,status from public.attendance");
    expect(attendance.rows).toEqual([{ school_id: STAFF_IDS.schoolA, student_id: STAFF_ROWS.A.student, status: "absent" }]);
    const role = await asStaffActor(db, STAFF_IDS.outsider, "select role,school_id from public.user_roles");
    expect(role.rows).toEqual([{ role: "parent", school_id: STAFF_IDS.schoolA }]);

    const materials = await asStaffActor(db, STAFF_IDS.outsider, "select distinct school_id from public.study_materials");
    expect(materials.rows).toEqual([{ school_id: STAFF_IDS.schoolA }]);
    const schoolIds = await asStaffActor(db, STAFF_IDS.outsider, "select public.current_user_school_ids()");
    expect(schoolIds.rows).toEqual([]);
    const schools = await asStaffActor(db, STAFF_IDS.outsider, "select id from public.schools");
    expect(schools.rows).toEqual([{ id: STAFF_IDS.schoolA }]);
    const profiles = await asStaffActor(db, STAFF_IDS.outsider, "select id from public.profiles");
    expect(profiles.rows).toEqual([{ id: STAFF_IDS.outsider }]);
  });

  it("preserves same-school roles and existing links while rejecting another school", async () => {
    const crossSchool = await issue("other-school@example.test");
    await expect(accept(STAFF_IDS.parentB, crossSchool.token)).rejects.toMatchObject({ code: "42501" });
    const mixed = await issue("teacher@example.test", STAFF_ROWS.privateStudentA);
    await accept(STAFF_IDS.teacherA, mixed.token);
    const teacherRoles = await asStaffActor(db, STAFF_IDS.teacherA, "select role from public.user_roles order by role::text");
    expect(teacherRoles.rows).toEqual([{ role: "parent" }, { role: "teacher" }]);
    const sibling = await issue("existing-guardian@example.test", STAFF_ROWS.privateStudentA);
    await accept(STAFF_IDS.parentA, sibling.token);
    const { rows: children } = await asStaffActor(
      db, STAFF_IDS.parentA, "select student_id from public.student_parents where parent_id = $1 order by student_id", [STAFF_ROWS.A.parent],
    );
    expect(children).toEqual([{ student_id: STAFF_ROWS.A.student }, { student_id: STAFF_ROWS.privateStudentA }]);
    const parentCount = await db.query("select id from public.parents where profile_id = $1", [STAFF_IDS.parentA]);
    expect(parentCount.rows).toEqual([{ id: STAFF_ROWS.A.parent }]);
  });

  it("requires the invitee's enrolment and the issuer's authority to still be valid at acceptance", async () => {
    const invite = await issue("existing-guardian@example.test", STAFF_ROWS.privateStudentA, STAFF_IDS.principalA);
    await db.query("update public.enrollments set status = 'inactive' where id = $1", [STAFF_ROWS.privateEnrollmentA]);
    await expect(accept(STAFF_IDS.parentA, invite.token)).rejects.toMatchObject({ code: "P0001" });
    await db.query("update public.enrollments set status = 'active' where id = $1", [STAFF_ROWS.privateEnrollmentA]);
    await db.query("update public.profiles set is_active = false where id = $1", [STAFF_IDS.principalA]);
    await expect(accept(STAFF_IDS.parentA, invite.token)).rejects.toMatchObject({ code: "P0001" });
    await db.query("update public.profiles set is_active = true where id = $1", [STAFF_IDS.principalA]);
  });

  it("rolls back the binding when a later write fails and lets the recipient retry", async () => {
    const account = "10000000-0000-0000-0000-000000000025";
    const email = "guardian-retry@example.test";
    await db.query("insert into auth.users (id,email,email_confirmed_at) values ($1,$2,now())", [account, email]);
    await db.query("insert into public.profiles (id,email) values ($1,$2)", [account, email]);
    const invite = await issue(email);
    await db.exec(`
      create function app_private.test_reject_parent_role() returns trigger language plpgsql as $$
      begin
        raise check_violation using message = 'Simulated role write failure';
      end;
      $$;
      create trigger test_reject_parent_role before insert on public.user_roles
      for each row execute function app_private.test_reject_parent_role();
    `);
    try {
      await expect(accept(account, invite.token)).rejects.toMatchObject({ code: "23514" });
      expect((await db.query("select id from public.parents where profile_id = $1", [account])).rows).toEqual([]);
      expect((await db.query("select school_id from public.profiles where id = $1", [account])).rows).toEqual([{ school_id: null }]);
      expect((await db.query("select accepted_at from app_private.guardian_invitations where id = $1", [invite.id])).rows).toEqual([{ accepted_at: null }]);
    } finally {
      await db.exec("drop trigger test_reject_parent_role on public.user_roles; drop function app_private.test_reject_parent_role()");
    }
    expect((await accept(account, invite.token)).rows).toEqual([
      { result: { school_id: STAFF_IDS.schoolA, student_id: STAFF_ROWS.A.student } },
    ]);
  });

  it("denies raw invitation reads, anonymous acceptance, and the legacy link and role bypasses", async () => {
    await expect(asStaffActor(db, STAFF_IDS.adminA, "select * from app_private.guardian_invitations")).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, null, "select public.accept_guardian_invitation('x')", [], "anon")).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, STAFF_IDS.outsider, "select public.activate_parent('x','y')")).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, STAFF_IDS.accountantA, "update public.parents set profile_id = $1 where id = $2", [STAFF_IDS.accountantA, STAFF_ROWS.A.parent])).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, STAFF_IDS.adminA, "insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [STAFF_ROWS.privateStudentA, STAFF_ROWS.A.parent])).rejects.toMatchObject({ code: "42501" });
  });
});
