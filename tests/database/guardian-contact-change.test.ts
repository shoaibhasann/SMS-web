// @vitest-environment node

import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS as actors, STAFF_ROWS as fixtures } from "./staff-scope-fixture";

const directory = new URL("../../supabase/migrations/", import.meta.url);
const formerEmail = "guardian-original@example.test";
const newEmail = "guardian-changed@example.test";
const oldMobile = "+12025550110";
const newMobile = "+12025550111";
const differentMobile = "+12025550112";
const priorVerifiedMobile = "+12025550113";
const recentSession = randomUUID();
const oldSession = randomUUID();
const nonPasswordSession = randomUUID();
const otherUserSession = randomUUID();
const authorizeSql = "select public.authorize_my_guardian_phone_change($1) as authorized";
const syncSql = "select public.sync_my_guardian_mobile() as mobile";
type Invitation = { id: string; token: string };

describe("guardian Auth contact changes", () => {
  let db: Awaited<ReturnType<typeof createStaffScopeDatabase>>;
  let previousInvite: Invitation;

  beforeAll(async () => {
    db = await createStaffScopeDatabase({ includeTeachingRpcs: true, applyGovernance: true, includeGuardianInvitations: true });
    const files = await readdir(directory);
    async function apply(suffix: string) {
      const file = files.find((name) => name.endsWith(suffix));
      if (!file) throw new Error(`Missing migration ${suffix}`);
      await db.exec(await readFile(new URL(file, directory), "utf8"));
    }
    for (const suffix of ["_repair_school_policy_helper.sql", "_guardian_invitations.sql", "_revoke_guardian_access.sql"]) {
      await apply(suffix);
    }

    // Recreate the Auth fields used by the verified-provider transition. The
    // fixture writes them as the trusted database owner, without any delivery.
    await db.exec(`
      alter table auth.users
        add column deleted_at timestamptz,
        add column email_change text not null default '',
        add column email_change_confirm_status smallint not null default 0,
        add column phone text,
        add column phone_confirmed_at timestamptz,
        add column phone_change text not null default '',
        add column phone_change_token text not null default '',
        add column phone_change_sent_at timestamptz;
      create table auth.sessions (
        id uuid primary key, user_id uuid not null references auth.users(id), not_after timestamptz
      );
      create table auth.mfa_amr_claims (
        session_id uuid not null references auth.sessions(id), authentication_method text not null,
        created_at timestamptz not null
      );
      create function auth.jwt() returns jsonb language sql stable as $$
        select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
      $$;
    `);
    await db.query("update auth.users set email=$2,email_confirmed_at=now(),phone=$3,phone_confirmed_at=now() where id=$1",
      [actors.parentA, formerEmail, oldMobile.slice(1)]);
    await db.query("update auth.users set phone=$2,phone_confirmed_at=now() where id=$1",
      [actors.parentB, priorVerifiedMobile.slice(1)]);
    await db.query("update public.parents set registered_mobile=$2 where id=$1", [fixtures.A.parent, oldMobile]);
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')",
      [fixtures.privateStudentA, fixtures.A.parent]);
    await db.query(`insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status,marked_by)
      values ($1,$2,$3,$4,'2026-11-03','present',$5)`,
    [actors.schoolA, fixtures.A.year, fixtures.privateSectionA, fixtures.privateStudentA, actors.teacherA]);
    await db.query("insert into auth.sessions(id,user_id) values($1,$5),($2,$5),($3,$5),($4,$6)",
      [recentSession, oldSession, nonPasswordSession, otherUserSession, actors.parentA, actors.parentB]);
    await db.query(`insert into auth.mfa_amr_claims(session_id,authentication_method,created_at)
      values($1,'password',now()),($2,'password',now()-interval '8 minutes'),($3,'oauth',now()),($4,'password',now())`,
    [recentSession, oldSession, nonPasswordSession, otherUserSession]);

    previousInvite = await issue(formerEmail);
    await apply("_govern_guardian_contacts.sql");
  }, 30_000);

  afterAll(async () => { await db?.close(); });

  async function issue(email: string, studentId: string = fixtures.A.student) {
    const { rows: [result] } = await asStaffActor<{ invite: Invitation }>(db, actors.adminA,
      "select public.issue_guardian_invitation($1,$2,$3) as invite", [actors.schoolA, studentId, email]);
    return result.invite;
  }

  function accept(actor: string, invite: Invitation) {
    return asStaffActor(db, actor, "select public.accept_guardian_invitation($1) as accepted", [invite.token]);
  }

  async function authorize(session: string, mobile: string = newMobile, actor: string = actors.parentA) {
    return db.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claims',$2,true)",
        [actor, JSON.stringify({ sub: actor, session_id: session })]);
      await tx.exec("set local role authenticated");
      return tx.query(authorizeSql, [mobile]);
    });
  }

  function updateAuth(statement: string, values: unknown[] = []) {
    return db.query(statement, [actors.parentA, ...values]);
  }

  async function registeredMobile(parent: string = fixtures.A.parent) {
    const { rows: [record] } = await db.query<{ registered_mobile: string | null }>(
      "select registered_mobile from public.parents where id=$1", [parent],
    );
    return record.registered_mobile;
  }

  function startPhone(phone: string) {
    return updateAuth(`update auth.users set phone_change=$2,phone_change_token=$3,
      phone_change_sent_at=clock_timestamp() where id=$1`, [phone.slice(1), randomUUID()]);
  }

  function finishPhone(phone: string) {
    return updateAuth(`update auth.users set phone=$2,phone_change='',phone_change_token='',
      phone_confirmed_at=clock_timestamp() where id=$1`, [phone.slice(1)]);
  }

  it("requires both email confirmations, invalidates the old address and preserves the original children", async () => {
    const siblingInvite = await issue(formerEmail, fixtures.privateStudentA);
    const unaffected = await issue("other-guardian@example.test");
    expect((await db.query("select intended_user_id from app_private.guardian_invitations where id=$1", [previousInvite.id])).rows)
      .toEqual([{ intended_user_id: actors.parentA }]);

    await updateAuth("update auth.users set email_change=$2 where id=$1", [newEmail]);
    expect((await db.query("select revoked_at from app_private.guardian_invitations where id=$1", [previousInvite.id])).rows)
      .toEqual([{ revoked_at: null }]);
    const confirmEmail = (email: string) => updateAuth("update auth.users set email=$2,email_change='',email_change_confirm_status=0 where id=$1", [email]);
    await expect(confirmEmail(newEmail)).rejects.toMatchObject({ code: "42501" });
    await updateAuth("update auth.users set email_change_confirm_status=1 where id=$1");
    await expect(confirmEmail("different-address@example.test")).rejects.toMatchObject({ code: "42501" });
    await confirmEmail(newEmail);

    expect((await db.query("select revoked_at from app_private.guardian_invitations where id=any($1)", [[previousInvite.id, siblingInvite.id]])).rows)
      .toEqual([{ revoked_at: expect.any(Date) }, { revoked_at: expect.any(Date) }]);
    expect((await db.query("select revoked_at from app_private.guardian_invitations where id=$1", [unaffected.id])).rows)
      .toEqual([{ revoked_at: null }]);
    expect((await asStaffActor(db, actors.parentA, "select student_id from public.attendance order by student_id")).rows)
      .toEqual([{ student_id: fixtures.A.student }, { student_id: fixtures.privateStudentA }]);
    expect((await asStaffActor(db, actors.parentA, "select id from public.fee_payments")).rows).toEqual([{ id: fixtures.A.payment }]);
    expect((await db.query("select action,revoked_invite_count,actor_id from app_private.guardian_contact_audit")).rows)
      .toEqual([{ action: "email_changed", revoked_invite_count: 2, actor_id: actors.parentA }]);
  });

  it("blocks recycled email from using an old bound link even if concurrent issuance escaped revocation", async () => {
    await db.query("update auth.users set email=$2,email_confirmed_at=now() where id=$1", [actors.outsider, formerEmail]);
    await expect(accept(actors.outsider, previousInvite)).rejects.toMatchObject({ code: "P0001" });

    // A previous address remains safe even if its token row was not visible
    // to the revoke statement's snapshot.
    await db.query("update app_private.guardian_invitations set revoked_at=null where id=$1", [previousInvite.id]);
    await expect(accept(actors.outsider, previousInvite)).rejects.toMatchObject({ code: "42501" });
    expect((await db.query("select id from public.parents where profile_id=$1", [actors.outsider])).rows).toEqual([]);
    expect((await db.query("select role from public.user_roles where user_id=$1", [actors.outsider])).rows).toEqual([]);
    expect((await db.query("select accepted_at from app_private.guardian_invitations where id=$1", [previousInvite.id])).rows)
      .toEqual([{ accepted_at: null }]);
  });

  it("requires recent password proof and matching pending provider confirmation for a new mobile", async () => {
    await expect(startPhone(newMobile)).rejects.toMatchObject({ code: "42501" });
    await expect(finishPhone(newMobile)).rejects.toMatchObject({ code: "42501" });
    for (const session of [oldSession, nonPasswordSession, otherUserSession, randomUUID()]) {
      await expect(authorize(session)).rejects.toMatchObject({ code: "42501" });
    }
    await expect(authorize(recentSession, oldMobile)).rejects.toMatchObject({ code: "22023" });
    await expect(authorize(recentSession, "120")).rejects.toMatchObject({ code: "22023" });
    expect((await authorize(recentSession)).rows).toEqual([{ authorized: true }]);
    await expect(startPhone(differentMobile)).rejects.toMatchObject({ code: "42501" });
    await startPhone(newMobile);
    expect(await registeredMobile()).toBe(oldMobile);
    await expect(startPhone(newMobile)).rejects.toMatchObject({ code: "42501" });
    await expect(updateAuth("update auth.users set phone=$2,phone_change='',phone_change_token='' where id=$1", [newMobile.slice(1)]))
      .rejects.toMatchObject({ code: "42501" });
    await finishPhone(newMobile);
    expect(await registeredMobile()).toBe(newMobile);
    expect((await asStaffActor(db, actors.parentA, syncSql)).rows).toEqual([{ mobile: newMobile }]);
    expect((await db.query("select user_id from app_private.guardian_phone_change_authorizations")).rows).toEqual([]);
    expect((await db.query("select action from app_private.guardian_contact_audit where action like 'mobile_%'")).rows)
      .toEqual([{ action: "mobile_verified" }]);
    expect((await asStaffActor(db, actors.parentA, "select student_id from public.attendance order by student_id")).rows)
      .toEqual([{ student_id: fixtures.A.student }, { student_id: fixtures.privateStudentA }]);
  });

  it("expires mobile authorizations and only reconciles a verified own phone", async () => {
    await authorize(recentSession, differentMobile);
    await db.query("update app_private.guardian_phone_change_authorizations set expires_at=now()-interval '1 second' where user_id=$1",
      [actors.parentA]);
    await expect(startPhone(differentMobile)).rejects.toMatchObject({ code: "42501" });
    await authorize(recentSession, differentMobile);
    await startPhone(differentMobile);
    await db.query("update app_private.guardian_phone_change_authorizations set expires_at=now()-interval '1 second' where user_id=$1",
      [actors.parentA]);
    await expect(finishPhone(differentMobile)).rejects.toMatchObject({ code: "42501" });
    expect(await registeredMobile()).toBe(newMobile);

    await expect(asStaffActor(db, actors.teacherA, syncSql)).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, actors.adminA, syncSql)).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, actors.outsider, syncSql)).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, null, syncSql, [], "anon")).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, actors.parentA, "select * from app_private.guardian_phone_change_authorizations"))
      .rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, actors.parentA, "select * from app_private.guardian_contact_audit"))
      .rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, actors.parentA, "update public.parents set registered_mobile='unverified' where id=$1", [fixtures.A.parent]))
      .rejects.toMatchObject({ code: "42501" });
    expect((await asStaffActor(db, actors.parentB, syncSql)).rows).toEqual([{ mobile: priorVerifiedMobile }]);
    expect(await registeredMobile(fixtures.B.parent)).toBe(priorVerifiedMobile);
    expect(await registeredMobile()).toBe(newMobile);
  });
});
