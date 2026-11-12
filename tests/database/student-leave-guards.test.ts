// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite;
const principal = "74000000-0000-0000-0000-000000000301";

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'principal@leave-guards.invalid',now())", [principal]);
  await db.query("update public.profiles set school_id=$2,full_name='Leave principal' where id=$1", [principal, id.schoolA]);
  await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'principal')", [principal, id.schoolA]);
  await db.exec("insert into auth.sessions(id,user_id) select id,id from auth.users on conflict(id) do nothing");
}, 60_000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

async function actor(user: string, sql: string, params: unknown[] = []) {
  await db.exec("savepoint leave_actor");
  try {
    await db.exec("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [user, JSON.stringify({ sub: user, session_id: user })]);
    const result = await db.query<{ id: string }>(sql, params);
    await db.exec("reset role");
    await db.exec("release savepoint leave_actor");
    return result.rows[0].id;
  } catch (error) {
    await db.exec("rollback to savepoint leave_actor; release savepoint leave_actor");
    throw error;
  }
}
const submit = (user = id.guardianA, student = id.pupilA, day = "2026-11-10") =>
  actor(user, "select public.submit_student_leave($1,$2::date,$2::date,'Medical appointment',$3::uuid) as id", [student, day, randomUUID()]);
const review = (request: string, user: string) =>
  actor(user, "select public.review_student_leave($1,'approved','Approved by the school office') as id", [request]);
const leaveCount = async () => (await db.query<{ count: number }>("select count(*)::int as count from app_private.student_leave_requests")).rows[0].count;
const placement = (operation: Promise<unknown>) => expect(operation).rejects.toMatchObject({
  code: "PT422", message: expect.stringMatching(/Contact the school office/),
});

describe("student leave placement errors", () => {
  it("reports a missing or broken current-year placement as an office problem, not an access denial", async () => {
    const cases: (string | unknown[])[][] = [
      ["update public.enrollments set status='withdrawn' where student_id=$1", [id.pupilA]],
      ["update public.students set status='withdrawn' where id=$1", [id.pupilA]],
      ["update public.classes set is_active=false where id=$1", [id.classA]],
      ["update public.academic_years set is_current=false where id=$1", [id.yearA]],
      // New current year, pupil not yet placed in it.
      ["update public.academic_years set is_current=false where id=$1", [id.yearA],
        "insert into public.academic_years(school_id,name,start_date,end_date,is_current) values($1,'Next year','2026-04-01','2027-03-31',true)", [id.schoolA]],
      ["update public.enrollments set section_id=$2 where student_id=$1", [id.pupilA, id.sectionB]],
    ];
    for (const steps of cases) {
      await db.exec("savepoint placement_case");
      for (let i = 0; i < steps.length; i += 2) await db.query(steps[i] as string, steps[i + 1] as unknown[]);
      await placement(submit());
      await placement(submit(id.studentUserA));
      await db.exec("rollback to savepoint placement_case; release savepoint placement_case");
    }
    expect(await leaveCount()).toBe(0);
  });

  it("still denies an unlinked or revoked family actor with 42501", async () => {
    await db.query("update public.enrollments set status='withdrawn' where student_id=$1", [id.pupilA]);
    await expect(submit(id.guardianA, id.pupilB)).rejects.toMatchObject({ code: "42501" });
    await db.query("delete from public.student_parents where student_id=$1 and parent_id=$2", [id.pupilA, id.parentA]);
    await expect(submit()).rejects.toMatchObject({ code: "42501" });
    expect(await leaveCount()).toBe(0);
  });
});

describe("student leave reviewer independence", () => {
  it("denies a linked guardian who also holds an office role", async () => {
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'principal')", [id.guardianA, id.schoolA]);
    const request = await submit(id.studentUserA);
    await expect(review(request, id.guardianA)).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/own child/) });
    expect(await review(request, principal)).toBe(request);
  });

  it("flags review queue rows the caller is a guardian or pupil account for", async () => {
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'principal')", [id.guardianA, id.schoolA]);
    const request = await submit(id.studentUserA);
    const flag = async (user: string) => {
      await db.exec("savepoint leave_flag");
      await db.exec("set local role authenticated");
      await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [user, JSON.stringify({ sub: user, session_id: user })]);
      const rows = (await db.query<{ id: string; is_family_reviewer: boolean }>(
        "select id,is_family_reviewer from public.list_student_leave_review($1,'pending')", [id.schoolA])).rows;
      await db.exec("rollback to savepoint leave_flag; release savepoint leave_flag");
      return rows.find((row) => row.id === request)?.is_family_reviewer;
    };
    expect(await flag(id.guardianA)).toBe(true);
    expect(await flag(principal)).toBe(false);
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'school_admin')", [id.studentUserA, id.schoolA]);
    expect(await flag(id.studentUserA)).toBe(true);
  });

  it("denies the pupil's own account holder who also holds an office role", async () => {
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'school_admin')", [id.studentUserA, id.schoolA]);
    const request = await submit(id.guardianA);
    await expect(review(request, id.studentUserA)).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/own child/) });
    expect(await review(request, id.adminA)).toBe(request);
    expect((await db.query<{ status: string; reviewed_by: string }>("select status,reviewed_by from app_private.student_leave_requests where id=$1", [request])).rows[0])
      .toEqual({ status: "approved", reviewed_by: id.adminA });
  });
});
