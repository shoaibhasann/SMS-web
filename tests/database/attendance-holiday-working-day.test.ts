// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite, today: string;
async function actor<T>(user: string, sql: string, args: unknown[] = []) {
  await db.exec("savepoint holiday_actor");
  try {
    await db.exec("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [user, JSON.stringify({ sub: user, session_id: user, aal: "aal2", role: "authenticated" })]);
    const result = await db.query<{ value: T }>(sql, args);
    await db.exec("reset role;release savepoint holiday_actor");
    return result.rows[0]?.value;
  } catch (error) { await db.exec("rollback to savepoint holiday_actor;release savepoint holiday_actor"); throw error; }
}
const policy = () => actor(id.adminA, "select public.save_school_attendance_policy($1,0,$2,array[0,1,2,3,4,5,6],2,'Approved working week',$3) as value",
  [id.schoolA, today, randomUUID()]);
const mark = (status: string) => actor<string>(id.adminA,
  "insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status,marked_by) values($1,$2,$3,$4,$5,$6,$7) returning id as value",
  [id.schoolA, id.yearA, id.sectionA, id.pupilA, today, status, id.adminA]);
const setStatus = (key: string, status: string) => actor<string>(id.adminA,
  "update public.attendance set status=$1,marked_by=$2 where id=$3 returning id as value", [status, id.adminA, key]);
const statusOf = async (key: string) => (await db.query<{ status: string }>("select status from public.attendance where id=$1", [key])).rows[0]?.status;
const todayRows = async () => (await db.query<{ n: number }>("select count(*)::int as n from public.attendance where attendance_date=$1", [today])).rows[0].n;

beforeAll(async () => {
  db = await createRecoveryDatabase(); await seedRecoveryData(db);
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
  const factor = randomUUID();
  await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status) values($1,$2,'totp','verified')", [factor, id.adminA]);
  await db.query("update auth.sessions set aal='aal2',factor_id=$2 where id=$1", [id.adminA, factor]);
  today = (await db.query<{ today: string }>("select (now() at time zone 'Asia/Kolkata')::date::text as today")).rows[0].today;
  await db.query("update public.academic_years set start_date=$1::date-366,end_date=$1::date+366", [today]);
  await db.query("update public.attendance set attendance_date=$1::date-1", [today]);
}, 60000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

describe("pupil Holiday marks on a configured school working day", () => {
  it("rejects an Office-created Holiday mark and points to the calendar", async () => {
    await policy();
    await expect(mark("holiday")).rejects.toMatchObject({ code: "22023", message: expect.stringMatching(/school calendar/) });
    expect(await todayRows()).toBe(0);
  });
  it("rejects changing a saved working-day mark to Holiday", async () => {
    await policy();
    const key = await mark("present");
    await expect(setStatus(key, "holiday")).rejects.toMatchObject({ code: "22023" });
    expect(await statusOf(key)).toBe("present");
  });
  it("still lets Office move an existing legacy Holiday mark to a real status", async () => {
    await policy();
    const key = (await db.query<{ id: string }>(`insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status,marked_by)
      values($1,$2,$3,$4,$5,'holiday',$6) returning id`, [id.schoolA, id.yearA, id.sectionA, id.pupilA, today, id.adminA])).rows[0].id;
    expect(await setStatus(key, "present")).toBe(key);
    expect(await statusOf(key)).toBe("present");
  });
  it("keeps Office Holiday marks on an unconfigured calendar date", async () => {
    const key = await mark("holiday");
    expect(await statusOf(key)).toBe("holiday");
  });
});
