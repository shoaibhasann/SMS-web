// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

// A large synthetic school: a class report must only run the per-pupil kernel for pupils it can touch,
// and must stay byte-identical to the unfiltered report for every scope.
const classes = 12, sectionsPerClass = 2, perSection = 125; // 3,000 regular pupils
const classIds = Array.from({ length: classes }, () => randomUUID());
const sectionIds = classIds.map(() => Array.from({ length: sectionsPerClass }, () => randomUUID()));
const emptyClass = randomUUID(), priorYear = randomUUID();
let db: PGlite, today: string, start: string;

// A sequence survives the report's rollback, so it counts per-pupil kernel calls exactly.
const kernelCalls = async () => Number((await db.query<{ n: string }>("select nextval('public.scale_kernel_calls') as n")).rows[0].n);
async function report(classId: string | null, sectionId: string | null = null) {
  const before = await kernelCalls();
  await db.exec("begin");
  try {
    await db.exec("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [id.adminA, JSON.stringify({ sub: id.adminA, session_id: id.adminA, aal: "aal2", role: "authenticated" })]);
    const started = performance.now();
    const value = (await db.query<{ value: string }>("select public.get_office_attendance_report($1,$2,null,$3,$4)::text as value",
      [id.schoolA, id.yearA, classId, sectionId])).rows[0].value;
    const ms = performance.now() - started;
    await db.exec("reset role");
    return { value, ms, calls: (await kernelCalls()) - before - 1 };
  } finally { await db.exec("rollback"); }
}
// The same report with the pre-kernel scope filter removed: the reference the fix must match byte for byte.
async function unfiltered(classId: string | null, sectionId: string | null = null) {
  const definition = (await db.query<{ def: string }>(
    "select pg_get_functiondef('app_private.get_office_attendance_report(uuid,uuid,date,uuid,uuid)'::regprocedure) as def")).rows[0].def;
  const filter = " where not exists(select 1 from out_of_scope skip where skip.student_id=pupil)";
  if (definition.split(filter).length !== 2) throw new Error("Office report has no pre-kernel scope filter.");
  await db.exec(definition.replace(filter, ""));
  try { return await report(classId, sectionId); } finally { await db.exec(definition); }
}

beforeAll(async () => {
  db = await createRecoveryDatabase(); await seedRecoveryData(db);
  const kernel = (await db.query<{ def: string }>("select pg_get_functiondef('app_private.calculate_attendance_report_pupil(text,uuid,uuid,date,uuid,uuid,uuid,jsonb)'::regprocedure) as def")).rows[0].def;
  const entry = "begin\n -- Reuse the native-session";
  if (kernel.split(entry).length !== 2) throw new Error("Attendance report kernel entry changed.");
  await db.exec("create sequence public.scale_kernel_calls");
  await db.exec(kernel.replace(entry, "begin\n perform nextval('public.scale_kernel_calls');\n -- Reuse the native-session"));
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
  const factor = randomUUID();
  await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status) values($1,$2,'totp','verified')", [factor, id.adminA]);
  await db.query("update auth.sessions set aal='aal2',factor_id=$1 where user_id=$2", [factor, id.adminA]);
  ({ today, start } = (await db.query<{ today: string; start: string }>(
    "select d::text as today,(d-29)::text as start from(select(now() at time zone 'Asia/Kolkata')::date as d)c")).rows[0]);
  await db.query("update public.academic_years set start_date=$1,end_date=$2::date+30 where id=$3", [start, today, id.yearA]);
  await db.query(`insert into public.academic_years(id,school_id,name,start_date,end_date,is_current)
    values($1,$2,'Prior scale year',$3::date-366,$3::date-1,false)`, [priorYear, id.schoolA, start]);
  await db.query("update public.students set admission_date=$1 where school_id=$2", [start, id.schoolA]);
  await db.query("delete from public.attendance where school_id=$1", [id.schoolA]);
  await db.query(`insert into app_private.school_attendance_policy_versions(school_id,revision,effective_from,working_days,correction_window_days,reason,actor_id,request_id)
    values($1,1,$2,array[1,2,3,4,5,6],2,'Verified synthetic school calendar',$3,$4)`, [id.schoolA, start, id.adminA, randomUUID()]);
  await db.query("insert into public.classes(id,school_id,name) select c,$1,'Scale class '||n from unnest($2::uuid[]) with ordinality u(c,n)", [id.schoolA, classIds]);
  await db.query("insert into public.classes(id,school_id,name) values($1,$2,'Scale empty class')", [emptyClass, id.schoolA]);
  for (const [n, classId] of classIds.entries()) {
    await db.query("insert into public.sections(id,school_id,class_id,name) select s,$1,$2,'S'||n from unnest($3::uuid[]) with ordinality u(s,n)",
      [id.schoolA, classId, sectionIds[n]]);
    for (const [m, sectionId] of sectionIds[n].entries()) {
      await db.query(`with pupil as(insert into public.students(school_id,admission_no,first_name,admission_date)
          select $1,'SC-'||$4||'-'||$5||'-'||k,'Scale pupil '||k,$6::date from generate_series(1,$7::int) k returning id)
        insert into public.enrollments(student_id,academic_year_id,class_id,section_id) select id,$2,$3,$8 from pupil`,
      [id.schoolA, id.yearA, classId, n, m, start, perSection, sectionId]);
    }
  }
  // Every pupil is marked on every elapsed school day, in their current section.
  await db.query(`insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status)
    select $1,$2,e.section_id,e.student_id,d::date,(array['present','late','half_day','leave','absent','present'])[1+(abs(hashtext(e.student_id::text||d::text))%6)]::public.attendance_status
    from public.enrollments e join public.students s on s.id=e.student_id and s.school_id=$1
    cross join generate_series($3::date,$4::date,interval '1 day') d
    where e.academic_year_id=$2 and extract(dow from d)<>0`, [id.schoolA, id.yearA, start, today]);

  const pupils = async (classId: string, sectionId: string, limit: number, offset: number) => (await db.query<{ enrollment: string; student: string }>(
    `select e.id as enrollment,e.student_id as student from public.enrollments e join public.students s on s.id=e.student_id
     where e.academic_year_id=$1 and e.class_id=$2 and e.section_id=$3 order by s.admission_no limit $4 offset $5`,
    [id.yearA, classId, sectionId, limit, offset])).rows;
  const change = (kind: "move" | "promotion", row: { enrollment: string; student: string }, source: [string, string, string, string],
    destination: [string, string, string], effective: string) => db.query(`insert into app_private.roster_placement_changes(school_id,request_id,student_id,
      source_enrollment_id,source_year_id,source_class_id,source_section_id,destination_enrollment_id,destination_year_id,destination_class_id,
      destination_section_id,change_kind,effective_date,reason,changed_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Verified scale placement',$14)`,
  [id.schoolA, randomUUID(), row.student, ...source, row.enrollment, ...destination, kind, effective, id.adminA]);
  const [target, targetA, targetB] = [classIds[0], sectionIds[0][0], sectionIds[0][1]];
  const [other, otherA] = [classIds[5], sectionIds[5][0]];
  // Out-of-scope pupils whose kernel state is not provably clean: unverified admissions, staged/withdrawn rows, bad promotions.
  const odd = await pupils(other, otherA, 12, 0);
  await db.query("update public.students set admission_date=null where id=any($1)", [odd.slice(0, 2).map((row) => row.student)]);
  await db.query("update public.students set admission_date='infinity' where id=$1", [odd[2].student]);
  await db.query("update public.enrollments set status='staged' where id=$1", [odd[3].enrollment]);
  await db.query("update public.students set status='withdrawn' where id=$1", [odd[4].student]);
  await db.query("update public.enrollments set status='withdrawn' where id=$1", [odd[5].enrollment]);
  await db.query(`insert into public.students(school_id,admission_no,first_name,admission_date) values($1,'SC-ORPHAN','Orphan mark',$2)`, [id.schoolA, start]);
  await db.query(`insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status)
    select $1,$2,$3,id,$4,'present' from public.students where admission_no='SC-ORPHAN'`, [id.schoolA, id.yearA, otherA, today]);
  // Promoted pupils: valid single promotions (admission date null or set), a double promotion and one outside the year.
  for (const [index, row] of odd.slice(6).entries()) {
    const prior = (await db.query<{ id: string }>(`insert into public.enrollments(student_id,academic_year_id,class_id,section_id,status)
      values($1,$2,$3,$4,'active') returning id`, [row.student, priorYear, classIds[4], sectionIds[4][0]])).rows[0].id;
    if (index < 3) await db.query("update public.students set admission_date=null where id=$1", [row.student]);
    const effective = index === 4 ? `${today}` : start;
    await change("promotion", row, [prior, priorYear, classIds[4], sectionIds[4][0]], [id.yearA, other, otherA], index === 5 ? "2000-01-01" : effective);
    if (index === 4) await change("promotion", row, [prior, priorYear, classIds[4], sectionIds[4][0]], [id.yearA, other, otherA], start);
  }
  // Moves out of, into and around the target class; the attendance on and after the move is in the new section.
  const moved = [...await pupils(target, targetA, 2, 0), ...await pupils(other, otherA, 2, 20)];
  const moves: [typeof moved[number], string, string, string, string][] = [
    [moved[0], target, targetA, other, otherA], [moved[1], target, targetA, target, targetB],
    [moved[2], other, otherA, target, targetB], [moved[3], other, otherA, classIds[6], sectionIds[6][0]]];
  const moveDay = (await db.query<{ day: string }>("select($1::date-5)::text as day", [today])).rows[0].day;
  for (const [row, fromClass, fromSection, toClass, toSection] of moves) {
    await change("move", row, [row.enrollment, id.yearA, fromClass, fromSection], [id.yearA, toClass, toSection], moveDay);
    await db.query("update public.enrollments set class_id=$1,section_id=$2 where id=$3", [toClass, toSection, row.enrollment]);
    await db.query("update public.attendance set section_id=$1 where student_id=$2 and attendance_date>=$3", [toSection, row.student, moveDay]);
  }
  await db.exec("analyze");
}, 600_000);
afterAll(async () => { await db?.close(); });

describe("office class report scope prefilter", () => {
  it.each([
    ["target class", 0, null], ["target section A", 0, 0], ["target section B", 0, 1], ["class with promotions and odd states", 5, null],
    ["move destination class", 6, null], ["untouched class", 9, 1], ["empty class", -1, null], ["whole school", null, null],
  ] as const)("matches the unfiltered report byte for byte: %s", async (_label, classIndex, sectionIndex) => {
    const classId = classIndex === null ? null : classIndex < 0 ? emptyClass : classIds[classIndex];
    const sectionId = classIndex === null || classIndex < 0 || sectionIndex === null ? null : sectionIds[classIndex][sectionIndex];
    const before = await unfiltered(classId, sectionId), after = await report(classId, sectionId);
    expect(after.value).toBe(before.value);
    console.info(`[office report scope] ${_label}: unfiltered ${before.calls} kernel calls ${Math.round(before.ms)} ms; filtered ${after.calls} calls ${Math.round(after.ms)} ms`);
    if (classId !== null) expect(after.calls).toBeLessThan(before.calls);
  }, 300_000);

  it("runs the kernel only for scope pupils plus pupils it cannot prove clean", async () => {
    const section = await report(classIds[0], sectionIds[0][0]), whole = await report(null), klass = await report(classIds[0]);
    for (const [label, run] of [["section", section], ["class", klass], ["whole school", whole]] as const) {
      console.info(`[office report scope] ${label}: ${run.calls} kernel calls ${Math.round(run.ms)} ms`);
    }
    // 125 pupils in section A (one moved to another class, one within the class) plus the 13 odd/promoted/orphan pupils.
    expect(section.calls).toBeLessThanOrEqual(perSection + 2 + 13);
    expect(JSON.parse(section.value)).toMatchObject({ pupil_count: expect.any(Number), scope: { class_id: classIds[0], section_id: sectionIds[0][0] } });
  }, 300_000);
});
