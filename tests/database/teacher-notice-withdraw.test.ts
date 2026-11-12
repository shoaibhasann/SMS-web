// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

// web-notices#2: the teacher dashboard edits and withdraws the teacher's own notice with a plain
// version-guarded update; the existing RLS, inbox source and push triggers must honour it.
let db: PGlite;

async function asActor<T>(user: string, sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec("begin");
  try {
    await db.exec("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [user, JSON.stringify({ sub: user, session_id: user, aal: user === id.guardianA ? "aal1" : "aal2", role: "authenticated" })]);
    const { rows } = await db.query<T>(sql, params);
    await db.exec("commit");
    return rows;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

const inbox = async () => (await asActor<{ value: { notifications: { id: string; kind: string; title: string }[] } }>(id.guardianA,
  "select public.get_family_notification_inbox_v8('parent',false,50,null,null,null) as value"))[0].value.notifications
  .filter(({ kind }) => kind === "announcement");
const versionOf = async (notice: string) => (await db.query<{ version: string }>("select version::text from public.notices where id=$1", [notice])).rows[0].version;
const teacherUpdate = (notice: string, set: string, version: string) => asActor<{ id: string }>(id.teacherA,
  `update public.notices set ${set} where id=$1 and created_by=$2 and version=$3::uuid returning id`, [notice, id.teacherA, version]);
const pushStatuses = async (notice: string) => (await db.query<{ status: string }>(
  "select status from app_private.family_push_jobs where kind='announcement' and event_id=$1", [notice])).rows.map(({ status }) => status);

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
  const factor = randomUUID();
  await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status) values($1,$2,'totp','verified')", [factor, id.teacherA]);
  await db.query("update auth.sessions set aal='aal2',factor_id=$2 where id=$1", [id.teacherA, factor]);
  await db.query(`insert into app_private.family_push_devices
    (installation_id,installation_hash,user_id,recipient_role,school_id,session_id,device_fid,fid_hash,platform,label)
    select gen_random_uuid(),sha256(gen_random_uuid()::text::bytea),$1,'parent',$2,$1,f,sha256(f::bytea),'android','QA phone'
    from (select gen_random_uuid()::text as f) fid`, [id.guardianA, id.schoolA]);
  await db.query(`insert into app_private.family_push_preferences(user_id,recipient_role,enabled) values($1,'parent',true)
    on conflict(user_id,recipient_role) do update set enabled=true`, [id.guardianA]);
}, 120_000);
afterAll(async () => { await db?.close(); });

describe("teacher notice edit and withdraw", () => {
  it("lets the teacher edit and withdraw only their own notice, removing it from family inboxes and the push queue", async () => {
    const [{ id: notice }] = await asActor<{ id: string }>(id.teacherA, `insert into public.notices(school_id,title,content,audience,published_at,created_by)
      values($1,'Trip on Friday','Bring lunch',$2::jsonb,now() - interval '1 minute',$3) returning id`,
    [id.schoolA, JSON.stringify({ roles: ["student", "parent"], teacher_id: id.teacherRecordA }), id.teacherA]);
    expect((await inbox()).map(({ id: noticeId }) => noticeId)).toContain(notice);
    expect(await pushStatuses(notice)).toEqual(["queued"]);

    const loaded = await versionOf(notice);
    expect(await teacherUpdate(notice, "title='Trip on Saturday'", loaded)).toEqual([{ id: notice }]);
    expect((await inbox()).find(({ id: noticeId }) => noticeId === notice)?.title).toBe("Trip on Saturday");
    // A stale tab (old version) matches nothing.
    expect(await teacherUpdate(notice, "published_at=null", loaded)).toEqual([]);

    expect(await teacherUpdate(notice, "published_at=null", await versionOf(notice))).toEqual([{ id: notice }]);
    expect((await inbox()).map(({ id: noticeId }) => noticeId)).not.toContain(notice);
    expect(await pushStatuses(notice)).toEqual(["cancelled"]);
    // The withdrawn row stays readable to its author (dashboard shows it as Withdrawn).
    expect(await asActor(id.teacherA, "select id from public.notices where id=$1", [notice])).toEqual([{ id: notice }]);
  });

  it("does not let a teacher withdraw an admin's notice", async () => {
    const { rows: [{ id: notice }] } = await db.query<{ id: string }>(`insert into public.notices(school_id,title,content,audience,published_at,created_by)
      values($1,'School notice','For everyone','{"roles":["parent","student"]}'::jsonb,now() - interval '1 minute',$2) returning id`, [id.schoolA, id.adminA]);
    expect(await asActor(id.teacherA, "update public.notices set published_at=null where id=$1 returning id", [notice])).toEqual([]);
    expect((await inbox()).map(({ id: noticeId }) => noticeId)).toContain(notice);
  });
});
