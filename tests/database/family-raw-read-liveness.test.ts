// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite;

async function actor(user: string, sql: string, session: string | null = user) {
  await db.exec("savepoint family_probe");
  try {
    await db.exec("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [user, JSON.stringify({ sub: user, session_id: session })]);
    const result = await db.query<{ reads: Record<string, number> }>(sql);
    await db.exec("reset role");
    await db.exec("release savepoint family_probe");
    return result.rows[0].reads;
  } catch (error) { await db.exec("rollback to savepoint family_probe; release savepoint family_probe"); throw error; }
}

// Every raw table guarded by current_student_id()/current_parent_id() policies, filtered to pupil A.
const reads = (user: string, session: string | null = user) => actor(user, `select jsonb_build_object(
  'students',(select count(*) from public.students where id='${id.pupilA}'),
  'attendance',(select count(*) from public.attendance where student_id='${id.pupilA}'),
  'student_fees',(select count(*) from public.student_fees where student_id='${id.pupilA}'),
  'fee_payments',(select count(*) from public.fee_payments where student_id='${id.pupilA}'),
  'enrollments',(select count(*) from public.enrollments where student_id='${id.pupilA}'),
  'parents',(select count(*) from public.parents where id='${id.parentA}'),
  'student_parents',(select count(*) from public.student_parents where student_id='${id.pupilA}')) as reads`, session);
const family = [["student", id.studentUserA], ["parent", id.guardianA]] as const;
const none = { students: 0, attendance: 0, student_fees: 0, fee_payments: 0, enrollments: 0, parents: 0, student_parents: 0 };

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  await db.exec("insert into auth.sessions(id,user_id) select id,id from auth.users");
}, 60_000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

describe("family raw-table reads require a live, active family account", () => {
  it("keeps pupil A's raw rows readable for the live student and guardian", async () => {
    expect(await reads(id.studentUserA)).toMatchObject({ students: 1, attendance: 1, student_fees: 1, fee_payments: 1, enrollments: 1 });
    expect(await reads(id.guardianA)).toEqual({ students: 1, attendance: 1, student_fees: 1, fee_payments: 1, enrollments: 1, parents: 1, student_parents: 1 });
  });

  it.each(family)("ends raw reads when the %s role is removed (link kept)", async (role, user) => {
    await db.query("delete from public.user_roles where user_id=$1 and role=$2", [user, role]);
    expect(await reads(user)).toEqual(none);
  });

  it.each(family)("ends raw reads when the %s profile is disabled", async (_role, user) => {
    await db.query("update public.profiles set is_active=false where id=$1", [user]);
    expect(await reads(user)).toEqual(none);
  });

  it.each(family)("ends raw reads for a %s whose session is revoked or missing", async (_role, user) => {
    expect(await reads(user, null)).toEqual(none);
    await db.query("delete from auth.sessions where user_id=$1", [user]);
    expect(await reads(user)).toEqual(none);
  });

  it("does not hand a role from another school to the family helpers", async () => {
    await db.query("update public.user_roles set school_id=$2 where user_id=$1 and role='student'", [id.studentUserA, id.schoolB]);
    expect(await reads(id.studentUserA)).toEqual(none);
  });

  it("leaves office and teacher reads unchanged", async () => {
    expect(await reads(id.adminA)).toMatchObject({ students: 1, attendance: 1, student_fees: 1, fee_payments: 1, enrollments: 1 });
    const before = await reads(id.teacherA);
    await db.query("update public.profiles set is_active=false where id=$1", [id.studentUserA]);
    expect(await reads(id.teacherA)).toEqual(before);
  });

  it("evaluates the family helpers once per statement (initPlan), not per row", async () => {
    const { rows } = await db.query<{ policy: string }>(`select tablename || '.' || policyname as policy from pg_policies
      where schemaname = 'public' and regexp_replace(coalesce(qual, '') || coalesce(with_check, ''),
        'SELECT app_private\\.current_(student|parent)_id\\(\\) AS', '', 'g') ~ 'app_private\\.current_(student|parent)_id\\(\\)'`);
    expect(rows).toEqual([]);
    // Staff reads of class_logs skip the per-row family history check behind a family-account gate.
    const { rows: [history] } = await db.query<{ qual: string }>(
      "select qual from pg_policies where schemaname='public' and tablename='class_logs' and policyname='academic_logs_family_history'");
    expect(history.qual).toMatch(/^\(\(\(\( SELECT app_private\.current_student_id\(\) AS current_student_id\) IS NOT NULL\) OR/);
  });
});
