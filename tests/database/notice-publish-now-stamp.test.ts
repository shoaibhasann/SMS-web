// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

// web-notices#4: "Publish now" sends the office PC clock. A fast clock must not
// silently schedule the notice; the database clock stamps publish-now intent.
let db: PGlite;

async function asActor<T>(user: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const aal = user === id.guardianA ? "aal1" : "aal2";
  await db.exec("begin");
  try {
    await db.exec("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [user, JSON.stringify({ sub: user, session_id: user, aal, role: "authenticated" })]);
    const { rows } = await db.query<T>(sql, params);
    await db.exec("commit");
    return rows;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

const everyone = JSON.stringify({ roles: ["student", "parent", "teacher", "staff"] });
// Inserts as the admin with a client-chosen published_at expression; returns how far
// the stored value is from the database clock (seconds) and the notice id.
async function adminInsert(title: string, publishedAt: string) {
  const [row] = await asActor<{ id: string; ahead: number | null }>(id.adminA, `insert into public.notices(school_id,title,content,audience,published_at,created_by)
    values($1,$2,'Body',$3::jsonb,${publishedAt},$4)
    returning id, extract(epoch from published_at - statement_timestamp())::float8 as ahead`, [id.schoolA, title, everyone, id.adminA]);
  return row;
}
const storedAhead = async (notice: string) => (await db.query<{ ahead: number | null }>(
  "select extract(epoch from published_at - statement_timestamp())::float8 as ahead from public.notices where id=$1", [notice])).rows[0].ahead;
const guardianInbox = async () => (await asActor<{ value: { notifications: { id: string; kind: string }[] } }>(id.guardianA,
  "select public.get_family_notification_inbox_v8('parent',false,50,null,null,null) as value"))[0].value.notifications
  .filter(({ kind }) => kind === "announcement").map(({ id: noticeId }) => noticeId);
// Mirrors role-dashboard saveNotice: the teacher's browser sends new Date().toISOString().
async function teacherInsert(title: string, clockSkewMinutes: number) {
  const { rows: [{ now }] } = await db.query<{ now: Date }>("select statement_timestamp() as now");
  const browserNow = new Date(now.getTime() + clockSkewMinutes * 60_000).toISOString();
  const [row] = await asActor<{ id: string; ahead: number }>(id.teacherA, `insert into public.notices(school_id,title,content,audience,published_at,created_by)
    values($1,$2,'Body',$3::jsonb,$4::timestamptz,$5)
    returning id, extract(epoch from published_at - statement_timestamp())::float8 as ahead`,
  [id.schoolA, title, JSON.stringify({ roles: ["student", "parent"], teacher_id: id.teacherRecordA }), browserNow, id.teacherA]);
  return row;
}

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
  for (const staff of [id.adminA, id.teacherA]) {
    const factor = randomUUID();
    await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status) values($1,$2,'totp','verified')", [factor, staff]);
    await db.query("update auth.sessions set aal='aal2',factor_id=$2 where id=$1", [staff, factor]);
  }
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe("publish-now uses the database clock", () => {
  it("restamps a fast or slow client 'now' and keeps the notice visible to families at once", async () => {
    const fast = await adminInsert("Fast clock", "statement_timestamp() + interval '15 minutes'");
    expect(fast.ahead).toBeLessThanOrEqual(0);
    expect(fast.ahead).toBeGreaterThan(-5);
    expect(await guardianInbox()).toContain(fast.id);

    const slow = await adminInsert("Slow clock", "statement_timestamp() - interval '15 minutes'");
    expect(slow.ahead).toBeLessThanOrEqual(0);
    expect(slow.ahead).toBeGreaterThan(-5);
    // Posted after the fast one, so once both are stamped it is the newer notice.
    expect((await guardianInbox()).filter((notice) => [fast.id, slow.id].includes(notice))).toEqual([slow.id, fast.id]);
  });

  it("stamps a teacher's skewed browser clock so the notice lands at the top of the family inbox", async () => {
    const { rows: [{ id: earlier }] } = await db.query<{ id: string }>(`insert into public.notices(school_id,title,content,audience,published_at,created_by)
      values($1,'Earlier today','Body',$2::jsonb,statement_timestamp() - interval '2 hours',$3) returning id`, [id.schoolA, everyone, id.adminA]);
    const fast = await teacherInsert("Teacher fast clock", 20);
    expect(fast.ahead).toBeLessThanOrEqual(0);
    expect(fast.ahead).toBeGreaterThan(-5);
    expect(await guardianInbox()).toContain(fast.id);

    const slow = await teacherInsert("Teacher slow clock", -20);
    expect(slow.ahead).toBeLessThanOrEqual(0);
    expect(slow.ahead).toBeGreaterThan(-5);
    const order = (await guardianInbox()).filter((notice) => [earlier, fast.id, slow.id].includes(notice));
    expect(order).toEqual([slow.id, fast.id, earlier]);
  });

  it("leaves real schedules, historic dates and drafts unchanged", async () => {
    const scheduled = await adminInsert("Scheduled", "statement_timestamp() + interval '2 hours'");
    expect(scheduled.ahead).toBeGreaterThan(7_000);
    expect(await guardianInbox()).not.toContain(scheduled.id);
    const historic = await adminInsert("Historic", "'2025-06-01T09:00:00+05:30'::timestamptz");
    expect(historic.ahead).toBeLessThan(-1_000_000);
    const draft = await adminInsert("Draft", "null");
    expect(draft.ahead).toBeNull();
  });

  it("restamps the Unpublish then Publish toggle but not an edit that resends the same time", async () => {
    const notice = await adminInsert("Toggle", "null");
    await asActor(id.adminA, "update public.notices set published_at=statement_timestamp()+interval '10 minutes' where id=$1", [notice.id]);
    expect(await storedAhead(notice.id)).toBeLessThanOrEqual(0);
    expect(await guardianInbox()).toContain(notice.id);

    // A copy-only edit resends the stored (still recent) value: it is kept exactly.
    const before = (await db.query<{ at: string }>("select published_at::text as at from public.notices where id=$1", [notice.id])).rows[0].at;
    await asActor(id.adminA, "update public.notices set title='Edited',published_at=$2::timestamptz where id=$1", [notice.id, before]);
    const after = (await db.query<{ at: string }>("select published_at::text as at from public.notices where id=$1", [notice.id])).rows[0].at;
    expect(after).toBe(before);
  });
});
