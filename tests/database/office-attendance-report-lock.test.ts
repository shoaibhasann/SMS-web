// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite, today: string, start: string;
const otherClass = randomUUID();
type Summary = { state: string; enrollment_days: number };
async function asAdmin<T>(sql: string, args: unknown[] = []) {
  await db.exec("set local role authenticated");
  await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
    [id.adminA, JSON.stringify({ sub: id.adminA, session_id: id.adminA, aal: "aal2", role: "authenticated" })]);
  const result = await db.query<{ value: T }>(sql, args);
  await db.exec("reset role");
  return result.rows[0]?.value;
}
const advisoryLocks = async () => (await db.query<{ mode: string }>(
  "select mode from pg_locks where locktype='advisory' and pid=pg_backend_pid() order by mode")).rows.map(row => row.mode);
const attendanceScans = async () => Number((await db.query<{ scans: string }>(
  `select sum(pg_stat_get_xact_numscans(oid)) as scans from(select 'public.attendance'::regclass::oid as oid
   union all select indexrelid from pg_index where indrelid='public.attendance'::regclass) relation`)).rows[0].scans);
async function kernel(classId: string) {
  const cache = (await db.query<{ cache: unknown }>(`select jsonb_build_object('revision',1,'today',$2::date,'year',to_jsonb(y),
    'days',(select jsonb_object_agg(d::date::text,jsonb_build_object('configured',true,'is_working',true)) from generate_series($3::date,$2::date,'1 day') d)) as cache
    from public.academic_years y where id=$1`, [id.yearA, today, start])).rows[0].cache;
  return (await db.query<{ value: { month_summary: Summary; year_summary: Summary } }>(
    "select app_private.calculate_attendance_report_pupil('office',$1,$2,null,$3,$4,null,$5::jsonb) as value",
    [id.pupilA, id.yearA, id.schoolA, classId, JSON.stringify(cache)])).rows[0].value;
}
beforeAll(async () => {
  db = await createRecoveryDatabase(); await seedRecoveryData(db);
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
  const factor = randomUUID(); await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status) values($1,$2,'totp','verified')", [factor, id.adminA]);
  await db.query("update auth.sessions set aal='aal2',factor_id=$1 where user_id=$2", [factor, id.adminA]);
  ({ today, start } = (await db.query<{ today: string; start: string }>(
    "select d::text as today,(d-6)::text as start from(select(now() at time zone 'Asia/Kolkata')::date as d)c")).rows[0]);
  await db.query("update public.academic_years set start_date=$1,end_date=$2::date+30 where id=$3", [start, today, id.yearA]);
  await db.query("update public.students set admission_date=$1 where school_id=$2", [start, id.schoolA]);
  await db.query("update public.attendance set attendance_date=$1", [today]);
  await db.query("insert into public.classes(id,school_id,name) values($1,$2,'Other reporting class')", [otherClass, id.schoolA]);
}, 60_000);
beforeEach(async () => { await db.exec("begin"); }); afterEach(async () => { await db.exec("rollback"); }); afterAll(async () => { await db?.close(); });

describe("Office attendance report does not block attendance capture", () => {
  it("holds only the shared school-calendar fence, never the exclusive one, for the report transaction", async () => {
    const report = await asAdmin<{ school_id: string }>("select public.get_office_attendance_report($1,$2,null,null,null) as value", [id.schoolA, id.yearA]);
    expect(report.school_id).toBe(id.schoolA);
    const modes = await advisoryLocks();
    expect(modes).not.toContain("ExclusiveLock");
    expect(modes).toContain("ShareLock");
  });
  it("skips per-day attendance reads for a pupil whose placement and moves never touch the selected class", async () => {
    const before = await attendanceScans(), outside = await kernel(otherClass), skipped = await attendanceScans();
    expect(outside.month_summary).toMatchObject({ state: "not_started", enrollment_days: 0 });
    expect(outside.year_summary).toMatchObject({ state: "not_started", enrollment_days: 0 });
    expect(skipped - before).toBe(0);
    const inside = await kernel(id.classA);
    expect(inside.year_summary.enrollment_days).toBeGreaterThan(0);
    expect(await attendanceScans()).toBeGreaterThan(skipped);
  });
});
