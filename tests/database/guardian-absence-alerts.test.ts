// @vitest-environment node

import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS as actor, STAFF_ROWS as fixture } from "./staff-scope-fixture";

const migrations = new URL("../../supabase/migrations/", import.meta.url);
const { A } = fixture;
const alertRpc = "select public.list_guardian_absence_alerts() as alerts";
const acceptRpc = "select public.accept_guardian_invitation($1)";
type Alert = { id: string; student_id: string; student_name: string; attendance_date: string; created_at: string };
type Attendance = { id: string; revision: number };

describe("guardian absence alerts", () => {
  let db: Awaited<ReturnType<typeof createStaffScopeDatabase>>;
  let today: string;
  let earlier: string;

  beforeAll(async () => {
    db = await createStaffScopeDatabase({ includeTeachingRpcs: true, applyGovernance: true, includeGuardianInvitations: true });
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
    `);
    const { rows: [dates] } = await db.query<{ today: string; earlier: string }>(`
      select d::text as today, (d - 2)::text as earlier
      from (select (statement_timestamp() at time zone 'Asia/Kolkata')::date as d) dates
    `);
    ({ today, earlier } = dates);
    await db.query("update public.academic_years set start_date=$1::date-30,end_date=$1::date+30 where id=$2", [today, A.year]);
    await db.query("update public.attendance set attendance_date=$1::date-5 where student_id=$2", [today, A.student]);
    const files = await readdir(migrations);
    for (const suffix of [
      "_repair_school_policy_helper.sql", "_guardian_invitations.sql", "_revoke_guardian_access.sql",
      "_govern_attendance_corrections.sql", "_import_guardian_csv.sql", "_govern_guardian_contacts.sql",
      "_reinvite_guardian_access.sql", "_guardian_absence_alerts.sql",
    ]) {
      const file = files.find((entry) => entry.endsWith(suffix));
      if (!file) throw new Error(`Missing migration ${suffix}`);
      await db.exec(await readFile(new URL(file, migrations), "utf8"));
    }
    for (const [user, email] of [[actor.parentA, "parent@example.test"], [actor.outsider, "second-parent@example.test"]]) {
      await db.query("update auth.users set email=$2,email_confirmed_at=now() where id=$1", [user, email]);
    }
    const { rows: [{ invite }] } = await asStaffActor<{ invite: { token: string } }>(
      db, actor.adminA, "select public.issue_guardian_invitation($1,$2,$3) as invite",
      [actor.schoolA, A.student, "second-parent@example.test"],
    );
    await asStaffActor(db, actor.outsider, acceptRpc, [invite.token]);
  }, 30_000);

  afterAll(async () => { await db?.close(); });

  async function read(user: string) {
    const { rows: [{ alerts }] } = await asStaffActor<{ alerts: Alert[] }>(db, user, alertRpc);
    return alerts;
  }

  async function save(status: string, user: string = actor.adminA) {
    const { rows: [mark] } = await asStaffActor<Attendance>(db, user, `
      insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status,marked_by)
      values ($1,$2,$3,$4,$5,$6,$7)
      on conflict (student_id,attendance_date) do update set status=excluded.status,marked_by=excluded.marked_by
      returning id,revision::integer
    `, [actor.schoolA, A.year, A.section, A.student, today, status, user]);
    return mark;
  }

  async function correctEarlier(status: string, current: Attendance | null) {
    const { rows: [{ id }] } = await asStaffActor<{ id: string }>(db, actor.teacherA, `
      select public.request_attendance_correction($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as id
    `, [actor.schoolA, A.year, A.section, A.student, earlier, current?.id ?? null, current?.revision ?? null,
      status, "Checked against the signed register", randomUUID()]);
    await asStaffActor(db, actor.principalA,
      "select public.review_attendance_correction($1,'approved','Verified against the office record')", [id]);
    const { rows: [mark] } = await db.query<Attendance>(
      "select id,revision::integer from public.attendance where student_id=$1 and attendance_date=$2", [A.student, earlier],
    );
    return mark;
  }

  it("creates one alert per linked guardian, denies unrelated reads and removes only the revoked recipient", async () => {
    expect(await read(actor.parentA)).toEqual([]);
    expect(await read(actor.outsider)).toEqual([]);
    const mark = await save("absent", actor.teacherA);
    const firstAlerts = await read(actor.parentA);
    const secondAlerts = await read(actor.outsider);
    for (const alerts of [firstAlerts, secondAlerts]) {
      expect(alerts).toEqual([expect.objectContaining({
        id: expect.any(String), student_id: A.student, student_name: "Student A", attendance_date: today,
      })]);
    }
    expect(firstAlerts[0].id).not.toBe(secondAlerts[0].id);
    expect((await save("absent")).id).toBe(mark.id);
    expect(await read(actor.parentA)).toEqual(firstAlerts);
    expect(await read(actor.outsider)).toEqual(secondAlerts);

    for (const user of [actor.parentB, actor.studentA, actor.adminA]) expect(await read(user)).toEqual([]);
    await expect(asStaffActor(db, null, alertRpc, [], "anon")).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, actor.parentA, "select id from app_private.guardian_absence_alerts")).rejects.toMatchObject({ code: "42501" });

    const { rows: [{ revoked }] } = await asStaffActor<{ revoked: boolean }>(db, actor.adminA,
      "select public.revoke_guardian_access($1,$2,$3,$4) as revoked",
      [actor.schoolA, A.student, A.parent, "Guardian alert access QA check"]);
    expect(revoked).toBe(true);
    expect(await read(actor.parentA)).toEqual([]);
    expect(await read(actor.outsider)).toEqual(secondAlerts);
    expect((await db.query("select id from app_private.guardian_absence_alerts where attendance_id=$1", [mark.id])).rows)
      .toEqual([{ id: secondAlerts[0].id }]);

    await save("present");
    await save("absent");
    expect(await read(actor.parentA)).toEqual([]);
    expect((await read(actor.outsider)).map((alert) => alert.attendance_date)).toEqual([today]);

    const { rows: [{ record }] } = await asStaffActor<{ record: { reinvitable_guardians: { revocation_id: string }[] } }>(
      db, actor.adminA, "select public.lookup_guardian_access($1,'STUDENT-A') as record", [actor.schoolA]);
    const { rows: [{ invite }] } = await asStaffActor<{ invite: { token: string } }>(db, actor.adminA,
      "select public.reinvite_guardian_access($1,$2,$3) as invite",
      [actor.schoolA, A.student, record.reinvitable_guardians[0].revocation_id]);
    await asStaffActor(db, actor.parentA, acceptRpc, [invite.token]);
    await save("absent");
    expect(await read(actor.parentA)).toEqual([]);
    expect((await db.query("select id from public.attendance where id=$1 and status='absent'", [mark.id])).rows)
      .toEqual([{ id: mark.id }]);
  });

  it("publishes an approved absence correction and removes it after a corrected present mark", async () => {
    const created = await correctEarlier("absent", null);
    expect(await read(actor.parentA)).toEqual([expect.objectContaining({ student_id: A.student, attendance_date: earlier })]);
    const corrected = await correctEarlier("present", created);
    expect(corrected.id).toBe(created.id);
    expect(await read(actor.parentA)).toEqual([]);
    expect((await read(actor.outsider)).map((alert) => alert.attendance_date)).not.toContain(earlier);
  });
});
