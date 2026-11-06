// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite;
const principal = randomUUID(), accountant = randomUUID();
const log = randomUUID(), activity = randomUUID(), material = randomUUID();
const materialPath = [id.schoolA, id.yearA, id.classA, id.sectionA, id.subjectA, id.teacherRecordA, `${randomUUID()}.pdf`].join("/");
const homeworkPath = [id.schoolA, id.yearA, id.classA, id.sectionA, id.subjectA, activity, id.pupilA, `${randomUUID()}.pdf`].join("/");
let submission: string;
const users = [id.guardianA, id.studentUserA, id.teacherA, id.adminA, principal, accountant];

async function actor<Row extends Record<string, unknown> = Record<string, unknown>>(
  user: string | null, sql: string, args: unknown[] = [],
  session: string | null = user, role: "authenticated" | "anon" = "authenticated",
) {
  await db.exec("savepoint session_probe");
  try {
    await db.exec(`set local role ${role}`);
    await db.query(`select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true),
      set_config('storage.operation','object.get_authenticated',true)`, [user ?? "", JSON.stringify({ sub: user, session_id: session })]);
    const result = await db.query<Row>(sql, args);
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true)");
    await db.exec("release savepoint session_probe");
    return result.rows;
  } catch (error) { await db.exec("rollback to savepoint session_probe; release savepoint session_probe"); throw error; }
}
const value = async <T>(user: string, sql: string, args: unknown[] = [], session: string | null = user) =>
  (await actor<{ value: T }>(user, sql, args, session))[0].value;
const denied = (work: Promise<unknown>) => expect(work).rejects.toMatchObject({ code: "42501" });
const source = async () => (await db.query(`select jsonb_build_object(
  'attendance',(select jsonb_agg(to_jsonb(r) order by id) from public.attendance r),
  'fees',(select jsonb_agg(to_jsonb(r) order by id) from public.student_fees r),
  'payments',(select jsonb_agg(to_jsonb(r) order by id) from public.fee_payments r),
  'submissions',(select jsonb_agg(to_jsonb(r) order by id) from public.activity_submissions r),
  'links',(select jsonb_agg(to_jsonb(r) order by student_id,parent_id) from public.student_parents r)) as value`)).rows;

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  for (const [user, role] of [[principal, "principal"], [accountant, "accountant"]]) {
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [user, `${user}@session.invalid`]);
    await db.query("update public.profiles set school_id=$2 where id=$1", [user, id.schoolA]);
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,$3)", [user, id.schoolA, role]);
  }
  await db.exec("insert into auth.sessions(id,user_id) select id,id from auth.users");
  await db.query(`insert into public.class_logs(id,school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,log_date,topic,status)
    values($1,$2,$3,$4,$5,$6,$7,'2026-11-06','Session regression','published')`, [log, id.schoolA, id.yearA, id.classA, id.sectionA, id.subjectA, id.teacherRecordA]);
  await db.query("insert into public.class_activities(id,class_log_id,activity_type,title,max_marks) values($1,$2,'homework','Session homework',10)", [activity, log]);
  await db.query(`insert into public.study_materials(id,school_id,class_id,section_id,subject_id,teacher_id,title,file_url,published_at)
    values($1,$2,$3,$4,$5,$6,'Session notes',$7,now())`, [material, id.schoolA, id.classA, id.sectionA, id.subjectA, id.teacherRecordA, materialPath]);
  for (const [bucket, path, owner] of [["study-materials", materialPath, id.teacherA], ["homework-submissions", homeworkPath, id.studentUserA]]) {
    await db.query("insert into storage.objects(bucket_id,name,owner_id,metadata) values($1,$2,$3,'{\"size\":42,\"mimetype\":\"application/pdf\"}')", [bucket, path, owner]);
  }
  await db.exec("begin");
  submission = (await value<{ id: string }>(id.studentUserA, "select public.submit_homework($1,'Private answer',$2,null,$3,'answer.pdf') as value", [activity, homeworkPath, randomUUID()])).id;
  await db.exec("commit");
}, 60_000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

describe("native session revocation across legacy academic, leave, result and private-file contracts", () => {
  it.each(users)("retains exact authorized academic and private object reads for a live identity %s", async (user) => {
    expect(await actor(user, "select id from public.class_logs where id=$1", [log])).toEqual([{ id: log }]);
    expect(await actor(user, "select id from public.activity_submissions where id=$1", [submission])).toEqual([{ id: submission }]);
    expect(await actor(user, "select name from storage.objects where name in ($1,$2) order by name", [materialPath, homeworkPath])).toHaveLength(2);
  });

  it.each(users)("cuts off revoked identity %s across RLS, files, result/leave reads and writes", async (user) => {
    const original = await source();
    await db.query("delete from auth.sessions where user_id=$1", [user]);
    for (const table of ["class_logs", "class_activities", "study_materials", "activity_submissions"])
      expect(await actor(user, `select id from public.${table}`)).toEqual([]);
    expect(await actor(user, "select name from storage.objects where bucket_id in ('study-materials','homework-submissions')")).toEqual([]);
    await denied(value(user, "select public.get_family_assessment_results($1) as value", [id.pupilA]));
    await denied(value(user, "select public.list_family_student_leave($1) as value", [id.pupilA]));
    await denied(value(user, "select public.submit_student_leave($1,'2026-11-10','2026-11-10','Denied request',$2) as value", [id.pupilA, randomUUID()]));
    expect(await source()).toEqual(original);
  });

  it.each([null, "not-a-uuid", "", randomUUID(), id.guardianA])("fails closed for missing, malformed, absent and other-user sessions %s", async (session) => {
    expect(await actor(id.studentUserA, "select id from public.class_logs", [], session)).toEqual([]);
    expect(await actor(id.studentUserA, "select name from storage.objects where name=$1", [homeworkPath], session)).toEqual([]);
    expect(await value(id.studentUserA, "select public.list_my_homework_submissions($1) as value", [[activity]], session)).toEqual([]);
    await denied(value(id.studentUserA, "select public.get_family_assessment_results($1) as value", [id.pupilA], session));
    await denied(value(id.studentUserA, "select public.list_family_student_leave($1) as value", [id.pupilA], session));
  });

  it("denies expired sessions and immediately restores only a newly authenticated own session", async () => {
    await db.query("update auth.sessions set not_after=statement_timestamp()-interval '1 second' where id=$1", [id.studentUserA]);
    expect(await actor(id.studentUserA, "select id from public.class_logs")).toEqual([]);
    await denied(value(id.studentUserA, "select public.get_family_assessment_results($1) as value", [id.pupilA]));
    const fresh = randomUUID();
    await db.query("insert into auth.sessions(id,user_id,not_after) values($1,$2,statement_timestamp()+interval '1 hour')", [fresh, id.studentUserA]);
    expect(await actor(id.studentUserA, "select id from public.class_logs where id=$1", [log], fresh)).toEqual([{ id: log }]);
    expect(await value<{ rows: unknown[] }>(id.studentUserA, "select public.get_family_assessment_results($1) as value", [id.pupilA], fresh)).toMatchObject({ rows: [] });
    expect(await value(id.studentUserA, "select public.list_my_homework_submissions($1) as value", [[activity]], fresh)).toHaveLength(1);
  });

  it.each(["anonymous", "unverified", "inactive", "banned", "deleted"])("does not upgrade a live session for a %s account", async (state) => {
    if (state === "inactive") await db.query("update public.profiles set is_active=false where id=$1", [id.studentUserA]);
    else await db.query(`update auth.users set ${state === "anonymous" ? "is_anonymous=true" : state === "unverified" ? "email_confirmed_at=null,phone_confirmed_at=null" : state === "banned" ? "banned_until=statement_timestamp()+interval '1 hour'" : "deleted_at=statement_timestamp()"} where id=$1`, [id.studentUserA]);
    expect(await actor(id.studentUserA, "select id from public.class_logs")).toEqual([]);
    expect(await actor(id.studentUserA, "select name from storage.objects")).toEqual([]);
    await denied(value(id.studentUserA, "select public.get_family_assessment_results($1) as value", [id.pupilA]));
  });

  it("retains role, school, child-link and assignment boundaries with otherwise valid native sessions", async () => {
    expect(await actor(id.studentUserB, "select id from public.class_logs")).toEqual([]);
    expect(await actor(id.adminB, "select name from storage.objects")).toEqual([]);
    await denied(value(id.guardianA, "select public.get_family_assessment_results($1) as value", [id.unlinkedPupilA]));
    await db.query("delete from public.student_parents where parent_id=$1", [id.parentA]);
    expect(await actor(id.guardianA, "select id from public.activity_submissions")).toEqual([]);
    await db.query("delete from public.teacher_subject_assignments where id=$1", [id.assignmentA]);
    await denied(value(id.teacherA, "select public.list_homework_submissions_for_grading($1) as value", [activity]));
    expect(await actor(id.teacherA, "select name from storage.objects")).toEqual([]);
  });

  it("denies student submission and teacher grade/roster APIs after revocation without touching the response", async () => {
    const original = await source();
    await db.query("delete from auth.sessions where user_id in ($1,$2)", [id.studentUserA, id.teacherA]);
    expect(await value(id.studentUserA, "select public.list_my_homework_submissions($1) as value", [[activity]])).toEqual([]);
    await denied(value(id.studentUserA, "select public.submit_homework($1,'Overwrite',$2,0,$3,'answer.pdf') as value", [activity, homeworkPath, randomUUID()]));
    await denied(value(id.teacherA, "select public.list_homework_submissions_for_grading($1) as value", [activity]));
    await denied(value(id.teacherA, "select public.grade_homework($1,8,'Forged review',0,$2) as value", [submission, randomUUID()]));
    expect(await source()).toEqual(original);
  });

  it("keeps the new helper private and its definer search path pinned, with anonymous callers denied", async () => {
    expect((await db.query(`select has_function_privilege('anon','app_private.has_live_school_session()','EXECUTE') as anon,
      has_function_privilege('authenticated','app_private.has_live_school_session()','EXECUTE') as member,
      has_function_privilege('service_role','app_private.has_live_school_session()','EXECUTE') as worker,
      prosecdef,proconfig from pg_proc where oid='app_private.has_live_school_session()'::regprocedure`)).rows)
      .toEqual([{ anon: false, member: false, worker: false, prosecdef: true, proconfig: ['search_path=""'] }]);
    await denied(actor(null, "select public.get_family_assessment_results($1)", [id.pupilA], null, "anon"));
    await denied(actor(id.studentUserA, "select app_private.has_live_school_session()"));
  });
});
