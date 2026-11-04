// @vitest-environment node

import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS as actor, STAFF_ROWS as fixture } from "./staff-scope-fixture";

const migrations = new URL("../../supabase/migrations/", import.meta.url);
const { A } = fixture;
const inboxSql = "select public.get_guardian_absence_inbox() as inbox";
const markSql = "select public.mark_guardian_absence_alert_read($1)::text as read_at";
const legacySql = "select public.list_guardian_absence_alerts() as alerts";
type Alert = {
  id: string;
  student_id: string;
  student_name: string;
  attendance_date: string;
  created_at: string;
  read_at: string | null;
};
type Inbox = { alerts: Alert[]; unread_count: number };

describe("guardian absence alert read state", () => {
  let db: Awaited<ReturnType<typeof createStaffScopeDatabase>>;

  beforeAll(async () => {
    db = await createStaffScopeDatabase({ includeGuardianInvitations: true });
    const files = await readdir(migrations);
    async function apply(suffix: string) {
      const file = files.find((entry) => entry.endsWith(suffix));
      if (!file) throw new Error(`Missing migration ${suffix}`);
      await db.exec(await readFile(new URL(file, migrations), "utf8"));
    }

    await db.exec("alter table auth.users add column deleted_at timestamptz");
    await apply("_guardian_invitations.sql");
    await apply("_revoke_guardian_access.sql");
    await apply("_guardian_absence_alerts.sql");

    const secondParentId = randomUUID();
    await db.query("insert into public.parents(id,school_id,profile_id) values($1,$2,$3)", [secondParentId, actor.schoolA, actor.outsider]);
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [A.student, secondParentId]);
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'parent')", [actor.outsider, actor.schoolA]);

    // Generate real pre-migration alerts with enough rows to exceed the inbox limit.
    await db.query(`
      insert into public.attendance (school_id,academic_year_id,section_id,student_id,attendance_date,status,marked_by)
      select $1,$2,$3,$4,date '2026-10-01' + d,'absent',$5
      from generate_series(0,31) as d
    `, [actor.schoolA, A.year, A.section, A.student, actor.teacherA]);
    await db.exec(`
      update app_private.guardian_absence_alerts a set created_at = mark.attendance_date
      from public.attendance mark where mark.id = a.attendance_id
    `);
    await apply("_guardian_absence_alert_read_state.sql");
  }, 30_000);

  afterAll(async () => { await db?.close(); });

  async function inbox(user: string) {
    const { rows: [{ inbox }] } = await asStaffActor<{ inbox: Inbox }>(db, user, inboxSql);
    return inbox;
  }

  async function mark(user: string, id: string | null) {
    const { rows: [{ read_at }] } = await asStaffActor<{ read_at: string | null }>(db, user, markSql, [id]);
    return read_at;
  }

  it("starts existing alerts unread, keeps previous Preview response and counts beyond 30", async () => {
    const before = await inbox(actor.parentA);
    expect(before.unread_count).toBe(32);
    expect(before.alerts).toHaveLength(30);
    expect(before.alerts.every(({ read_at }) => read_at === null)).toBe(true);
    expect(before.alerts[0].attendance_date).toBe("2026-11-01");
    expect(before.alerts.at(-1)?.attendance_date).toBe("2026-10-03");
    const { rows: [{ alerts }] } = await asStaffActor<{ alerts: Omit<Alert, "read_at">[] }>(db, actor.parentA, legacySql);
    expect(alerts).toEqual(before.alerts.map((alert) => {
      const { read_at: readAt, ...legacy } = alert;
      expect(readAt).toBeNull();
      return legacy;
    }));

    const first = await mark(actor.parentA, before.alerts[0].id);
    expect(first).toEqual(expect.any(String));
    const updated = await inbox(actor.parentA);
    expect(updated.unread_count).toBe(31);
    expect(updated.alerts[0].attendance_date).toBe("2026-10-31");
    expect(updated.alerts.at(-1)?.attendance_date).toBe("2026-10-02");
    expect(await mark(actor.parentA, before.alerts[0].id)).toBe(first);
  });

  it("persists read status for the recipient without changing another guardian's alert", async () => {
    const beforeA = await inbox(actor.parentA);
    const beforeB = await inbox(actor.outsider);
    const alert = beforeA.alerts[0];
    const otherRecipient = beforeB.alerts.find((entry) => entry.attendance_date === alert.attendance_date);
    expect(otherRecipient?.id).toEqual(expect.any(String));
    expect(otherRecipient?.id).not.toBe(alert.id);

    for (const user of [actor.outsider, actor.parentB, actor.adminA]) expect(await mark(user, alert.id)).toBeNull();
    expect(await mark(actor.parentA, randomUUID())).toBeNull();
    expect(await mark(actor.parentA, null)).toBeNull();
    expect(await inbox(actor.parentA)).toEqual(beforeA);
    expect(await inbox(actor.outsider)).toEqual(beforeB);
    expect(await inbox(actor.parentB)).toEqual({ alerts: [], unread_count: 0 });
    await expect(asStaffActor(db, null, inboxSql, [], "anon")).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, null, markSql, [alert.id], "anon")).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, actor.parentA, "update app_private.guardian_absence_alerts set read_at=now()")).rejects.toMatchObject({ code: "42501" });

    const readAt = await mark(actor.parentA, alert.id);
    expect(readAt).toEqual(expect.any(String));
    const next = await inbox(actor.parentA);
    expect(next.unread_count).toBe(beforeA.unread_count - 1);
    expect(await mark(actor.parentA, alert.id)).toBe(readAt);
    expect(await inbox(actor.outsider)).toEqual(beforeB);

    // Reduce the backlog so recently read rows appear behind the remaining unread rows.
    for (const entry of next.alerts.slice(0, 3)) await mark(actor.parentA, entry.id);
    const afterReload = await inbox(actor.parentA);
    const saved = afterReload.alerts.find((entry) => entry.id === alert.id);
    expect(saved?.read_at).toEqual(expect.any(String));
    expect(new Date(saved!.read_at!).getTime()).toBe(new Date(readAt!).getTime());
  });

  it("rejects stale mark requests after correction and revocation", async () => {
    const beforeA = await inbox(actor.parentA);
    const beforeB = await inbox(actor.outsider);
    const corrected = beforeA.alerts[0];
    await db.query("update public.attendance set status='present' where student_id=$1 and attendance_date=$2", [A.student, corrected.attendance_date]);
    expect(await mark(actor.parentA, corrected.id)).toBeNull();
    expect((await inbox(actor.parentA)).unread_count).toBe(beforeA.unread_count - 1);
    expect((await inbox(actor.outsider)).unread_count).toBe(beforeB.unread_count - 1);

    const afterCorrection = await inbox(actor.parentA);
    const secondGuardian = await inbox(actor.outsider);
    const { rows: [{ revoked }] } = await asStaffActor<{ revoked: boolean }>(db, actor.adminA,
      "select public.revoke_guardian_access($1,$2,$3,$4) as revoked",
      [actor.schoolA, A.student, A.parent, "Guardian unread access QA"]);
    expect(revoked).toBe(true);
    expect(await mark(actor.parentA, afterCorrection.alerts[0].id)).toBeNull();
    expect(await inbox(actor.parentA)).toEqual({ alerts: [], unread_count: 0 });
    expect(await inbox(actor.outsider)).toEqual(secondGuardian);
  });
});
