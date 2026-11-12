// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite;
const principal = randomUUID(), newSection = randomUUID(), forgedPupil = randomUUID();
const oldLog = randomUUID(), oldWork = randomUUID(), openWork = randomUUID(), sameDayLog = randomUUID();
const homeworkPath = [id.schoolA, id.yearA, id.classA, id.sectionA, id.subjectA, oldWork, id.pupilA, `${randomUUID()}.pdf`].join("/");
let submission: string;
let forgedSubmission: string;

async function actor<T = Record<string, unknown>>(user: string, sql: string, args: unknown[] = [], operation = "object.get_authenticated") {
  await db.exec("savepoint placement_probe");
  try {
    await db.exec("set local role authenticated");
    await db.query(`select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true),
      set_config('storage.operation',$3,true)`, [user, JSON.stringify({ sub: user, session_id: user, role: "authenticated" }), operation]);
    const result = await db.query<T>(sql, args);
    await db.exec("reset role");
    await db.exec("release savepoint placement_probe");
    return result.rows;
  } catch (error) { await db.exec("rollback to savepoint placement_probe; release savepoint placement_probe"); throw error; }
}
const value = async <T>(user: string, sql: string, args: unknown[] = []) => (await actor<{ value: T }>(user, sql, args))[0].value;
const visible = (user: string, table: string, record: string) => actor(user, `select id from public.${table} where id=$1`, [record]);

beforeAll(async () => {
  db = await createRecoveryDatabase(); await seedRecoveryData(db);
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'principal@placement.invalid',now())", [principal]);
  await db.query("update public.profiles set school_id=$2 where id=$1", [principal, id.schoolA]);
  await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'principal')", [principal, id.schoolA]);
  await db.exec("insert into auth.sessions(id,user_id) select id,id from auth.users");
  // A same-session move needs today inside the current year and no attendance from today onward.
  await db.query(`update public.academic_years set start_date=d-60,end_date=d+60 from (select (now() at time zone 'Asia/Kolkata')::date d) x
    where id in ($1,$2)`, [id.yearA, id.yearB]);
  await db.query("update public.attendance set attendance_date=(now() at time zone 'Asia/Kolkata')::date-5");
  await db.query("insert into public.sections(id,school_id,class_id,name) values($1,$2,$3,'Recovery B')", [newSection, id.schoolA, id.classA]);
  await db.query(`insert into public.class_logs(id,school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,log_date,topic,status)
    values($1,$3,$4,$5,$6,$7,$8,(now() at time zone 'Asia/Kolkata')::date-1,'Before the move','published'),
      ($2,$3,$4,$5,$6,$7,$8,(now() at time zone 'Asia/Kolkata')::date,'On the move day','published')`,
  [oldLog, sameDayLog, id.schoolA, id.yearA, id.classA, id.sectionA, id.subjectA, id.teacherRecordA]);
  await db.query(`insert into public.class_activities(id,class_log_id,activity_type,title,max_marks)
    values($1,$3,'homework','Graded section A homework',10),($2,$3,'homework','Unsubmitted section A homework',10)`, [oldWork, openWork, oldLog]);

  await db.exec("begin");
  await actor(id.studentUserA, "insert into storage.objects(bucket_id,name,owner_id,metadata) values('homework-submissions',$1,$2,'{\"size\":608,\"mimetype\":\"application/pdf\"}')",
    [homeworkPath, id.studentUserA], "object.upload");
  submission = (await value<{ id: string }>(id.studentUserA, "select public.submit_homework($1,'My answer',$2,null,$3,'answer.pdf') as value",
    [oldWork, homeworkPath, randomUUID()])).id;
  await value(id.teacherA, "select public.grade_homework($1,8,'good',0,$2) as value", [submission, randomUUID()]);
  await db.exec("commit");

  const { rows: [enrollment] } = await db.query<{ id: string }>("select id from public.enrollments where student_id=$1 and academic_year_id=$2", [id.pupilA, id.yearA]);
  await db.exec("begin");
  await actor(id.adminA, "select public.change_roster_placement($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [id.schoolA, enrollment.id, id.classA, id.sectionA, id.yearA, id.classA, newSection, "Section rebalancing", randomUUID()]);
  await db.exec("commit");

  // A legacy row for a pupil who was never placed in section A must stay hidden.
  await db.query(`insert into public.students(id,school_id,admission_no,first_name,dob,registered_mobile)
    values($1,$2,'REC-A-009','Never in A','2014-06-15','0000000000')`, [forgedPupil, id.schoolA]);
  await db.query("insert into public.enrollments(student_id,academic_year_id,class_id,section_id) values($1,$2,$3,$4)", [forgedPupil, id.yearA, id.classA, newSection]);
  forgedSubmission = (await db.query<{ id: string }>("insert into public.activity_submissions(activity_id,student_id,text_response,status) values($1,$2,'Forged','submitted') returning id",
    [oldWork, forgedPupil])).rows[0].id;
}, 60_000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

describe("homework history survives a same-session section move", () => {
  it("keeps the move real: the live enrollment is now in the new section", async () => {
    expect((await db.query("select section_id from public.enrollments where student_id=$1 and academic_year_id=$2", [id.pupilA, id.yearA])).rows)
      .toEqual([{ section_id: newSection }]);
  });

  it.each([["pupil", id.studentUserA], ["guardian", id.guardianA], ["teacher", id.teacherA], ["admin", id.adminA], ["principal", principal]])(
    "lets the %s still read the graded submission and its attachment", async (_label, user) => {
      expect(await actor(user, "select id,marks::text,feedback from public.activity_submissions where id=$1", [submission]))
        .toEqual([{ id: submission, marks: "8", feedback: "good" }]);
      expect(await value<{ path: string }>(user, "select public.authorize_private_academic_file('submission',$1) as value", [submission]))
        .toMatchObject({ path: homeworkPath, bucket: "homework-submissions" });
    });

  it("keeps the pupil's own list, the old log and its activity readable by the family", async () => {
    expect(await value<unknown[]>(id.studentUserA, "select public.list_my_homework_submissions($1) as value", [[oldWork]]))
      .toEqual([expect.objectContaining({ id: submission, marks: 8, feedback: "good" })]);
    for (const user of [id.studentUserA, id.guardianA]) {
      expect(await visible(user, "class_logs", oldLog)).toEqual([{ id: oldLog }]);
      expect(await visible(user, "class_activities", oldWork)).toEqual([{ id: oldWork }]);
    }
  });

  it("keeps the moved pupil and their grade on the old section's grading roster", async () => {
    const roster = await value<{ students: { student_id: string; submission: { id: string } | null }[] }>(id.teacherA,
      "select public.list_homework_submissions_for_grading($1) as value", [oldWork]);
    expect(roster.students.find((row) => row.student_id === id.pupilA)?.submission).toMatchObject({ id: submission });
    expect(roster.students.some((row) => row.student_id === id.unlinkedPupilA)).toBe(true);
    expect(roster.students.some((row) => row.student_id === forgedPupil)).toBe(false);
  });

  it("does not open old-section writes, post-move logs, or rows of pupils never placed there", async () => {
    await expect(actor(id.studentUserA, "select public.submit_homework($1,'Late answer',null,null,$2,null)", [openWork, randomUUID()]))
      .rejects.toMatchObject({ code: "42501" });
    for (const user of [id.studentUserA, id.guardianA]) expect(await visible(user, "class_logs", sameDayLog)).toEqual([]);
    for (const user of [id.adminA, principal, id.teacherA]) expect(await visible(user, "activity_submissions", forgedSubmission)).toEqual([]);
  });
});
