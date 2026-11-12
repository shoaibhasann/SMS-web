// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

type Cursor = { id: string; kind: string; created_at: string };
type Notification = Cursor & { source_id: string; event_date: string };
type Inbox = { notifications: Notification[]; next_cursor: Cursor | null };
let db: PGlite;

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users on conflict do nothing");
}, 60_000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

async function inbox(limit: number, cursor: Cursor | null = null) {
  await db.exec("savepoint sort_actor");
  try {
    await db.exec("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [id.guardianA, JSON.stringify({ sub: id.guardianA, session_id: id.guardianA, aal: "aal1", role: "authenticated" })]);
    const { rows: [row] } = await db.query<{ value: Inbox }>(
      "select public.get_family_notification_inbox_v8('parent',false,$1,$2,$3,$4) as value",
      [limit, cursor?.created_at ?? null, cursor?.kind ?? null, cursor?.id ?? null]);
    await db.exec("reset role");
    await db.exec("release savepoint sort_actor");
    return row.value;
  } catch (error) {
    await db.exec("rollback to savepoint sort_actor; release savepoint sort_actor");
    throw error;
  }
}

async function demand(dueDaysAgo: number, createdDaysAgo = 0) {
  const { rows: [row] } = await db.query<{ id: string; created_at: string; due_midnight: string }>(
    `insert into public.student_fees(school_id,student_id,fee_structure_id,due_date,amount,created_at)
     values($1,$2,$3,(statement_timestamp() at time zone 'Asia/Kolkata')::date-$4::integer,1000,now()-make_interval(days=>$5::integer))
     returning id,created_at::text,(due_date::timestamp at time zone 'Asia/Kolkata')::text as due_midnight`,
    [id.schoolA, id.pupilA, id.structureA, dueDaysAgo, createdDaysAgo]);
  return row;
}

const at = (value: string) => new Date(value).getTime();

describe("family fee-due notification sort time", () => {
  it("surfaces a new, already-overdue demand at its creation time on page 1", async () => {
    const fresh = await demand(120);
    const [first] = (await inbox(1)).notifications;
    expect(first).toMatchObject({ kind: "fee_due", source_id: fresh.id, event_date: expect.any(String) });
    expect(at(first.created_at)).toBe(at(fresh.created_at));
    expect(at(first.created_at)).toBeGreaterThan(at(fresh.due_midnight));
  });

  it("keeps a demand created before its due date at the due-date midnight and pages without gaps", async () => {
    const planned = await demand(120, 200);
    const fresh = await demand(90);
    const full = (await inbox(50)).notifications;
    expect(at(full.find(({ source_id }) => source_id === planned.id)!.created_at)).toBe(at(planned.due_midnight));
    expect(full.findIndex(({ source_id }) => source_id === fresh.id)).toBe(0);

    const paged: Notification[] = [];
    let cursor: Cursor | null = null;
    do {
      const page: Inbox = await inbox(2, cursor);
      paged.push(...page.notifications);
      cursor = page.next_cursor;
    } while (cursor);
    expect(paged.map(({ kind, id: rowId }) => `${kind}:${rowId}`)).toEqual(full.map(({ kind, id: rowId }) => `${kind}:${rowId}`));
  });
});
