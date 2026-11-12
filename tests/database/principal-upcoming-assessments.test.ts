// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite;
const principal = randomUUID(), finance = randomUUID();
type Page = { total_count: number; rows: { id: string; name: string; assessment_date: string }[] };

async function actor<T>(user: string, sql: string, args: unknown[] = []) {
  await db.exec("begin");
  try {
    await db.exec("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [user, JSON.stringify({ sub: user, session_id: user, role: "authenticated" })]);
    return (await db.query<T>(sql, args)).rows;
  } finally { await db.exec("rollback"); }
}
const upcoming = async (user: string, school = id.schoolA, from = "2026-11-04", to = "2026-11-11") =>
  (await actor<{ value: Page }>(user, "select public.list_principal_upcoming_assessments($1,$2::date,$3::date) as value", [school, from, to]))[0].value;

beforeAll(async () => {
  db = await createRecoveryDatabase(); await seedRecoveryData(db);
  for (const [user, role] of [[principal, "principal"], [finance, "accountant"]]) {
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [user, `${role}@upcoming.invalid`]);
    await db.query("update public.profiles set school_id=$2 where id=$1", [user, id.schoolA]);
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,$3)", [user, id.schoolA, role]);
  }
  await db.exec("insert into auth.sessions(id,user_id) select id,id from auth.users on conflict do nothing");
  await db.query(`insert into public.teacher_assessments(school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,name,assessment_date,maximum_marks)
    select $1,$2,$3,$4,$5,$6,'Weekly quiz '||n,'2026-11-04'::date+(n%7),20 from generate_series(1,11) n`,
  [id.schoolA, id.yearA, id.classA, id.sectionA, id.subjectA, id.teacherRecordA]);
}, 60_000);
afterAll(async () => { await db?.close(); });

describe("principal dashboard upcoming assessments", () => {
  it("gives the school's principal the real count and the first ten in date order, without raw mark access", async () => {
    const page = await upcoming(principal);
    expect(page.total_count).toBe(12);
    expect(page.rows).toHaveLength(10);
    expect(page.rows.map((row) => row.assessment_date)).toEqual([...page.rows.map((row) => row.assessment_date)].sort());
    expect(page.rows.some((row) => row.id === id.assessmentA)).toBe(true);
    expect(await actor(principal, "select id from public.teacher_assessments")).toEqual([]);
    expect(await actor(principal, "select id from public.teacher_assessment_marks")).toEqual([]);
  });

  it("keeps the window bounded and other roles and schools out", async () => {
    expect((await upcoming(principal, id.schoolA, "2026-11-06", "2026-11-06")).total_count).toBeGreaterThan(0);
    await expect(upcoming(principal, id.schoolA, "2026-11-11", "2026-11-04")).rejects.toMatchObject({ code: "22023" });
    await expect(upcoming(principal, id.schoolA, "2026-11-01", "2027-01-01")).rejects.toMatchObject({ code: "22023" });
    // "At most 31 days" counts both ends: Nov 1..Dec 1 is 31 days, Nov 1..Dec 2 is 32.
    expect((await upcoming(principal, id.schoolA, "2026-11-01", "2026-12-01")).total_count).toBe(12);
    await expect(upcoming(principal, id.schoolA, "2026-11-01", "2026-12-02")).rejects.toMatchObject({ code: "22023", message: expect.stringContaining("31 days") });
    await expect(upcoming(principal, id.schoolB)).rejects.toMatchObject({ code: "42501" });
    for (const user of [finance, id.teacherA, id.guardianA, id.studentUserA, id.adminB]) await expect(upcoming(user)).rejects.toMatchObject({ code: "42501" });
  });
});
