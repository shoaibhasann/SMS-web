// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite;
const successorUser = randomUUID(), successorTeacher = randomUUID(), bystanderUser = randomUUID(), bystanderTeacher = randomUUID();
const publishedLog = randomUUID(), draftLog = randomUUID(), homework = randomUUID();
const materialPath = [id.schoolA, id.yearA, id.classA, id.sectionA, id.subjectA, id.teacherRecordA, `${randomUUID()}.txt`].join("/");
const homeworkPath = [id.schoolA, id.yearA, id.classA, id.sectionA, id.subjectA, homework, id.pupilA, `${randomUUID()}.pdf`].join("/");
let submission: string;

async function actor<T = Record<string, unknown>>(user: string, sql: string, args: unknown[] = [], operation = "object.get_authenticated") {
  await db.exec("savepoint handover_probe");
  try {
    await db.exec("set local role authenticated");
    await db.query(`select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true),
      set_config('storage.operation',$3,true)`, [user, JSON.stringify({ sub: user, session_id: user, role: "authenticated" }), operation]);
    const result = await db.query<T>(sql, args);
    await db.exec("reset role");
    await db.exec("release savepoint handover_probe");
    return result;
  } catch (error) { await db.exec("rollback to savepoint handover_probe; release savepoint handover_probe"); throw error; }
}
const value = async <T>(user: string, sql: string, args: unknown[] = []) => (await actor<{ value: T }>(user, sql, args)).rows[0].value;
const visible = async (user: string, table: string, record: string) => (await actor(user, `select id from public.${table} where id=$1`, [record])).rows;
const grade = (user: string, revision = 0) => value<{ status: string }>(user, "select public.grade_homework($1,9,'Checked after handover',$2,$3) as value", [submission, revision, randomUUID()]);
const roster = (user: string) => value<{ students: { student_id: string; submission: { id: string } | null }[] }>(user,
  "select public.list_homework_submissions_for_grading($1) as value", [homework]);

beforeAll(async () => {
  db = await createRecoveryDatabase(); await seedRecoveryData(db);
  for (const [user, teacher, label] of [[successorUser, successorTeacher, "successor"], [bystanderUser, bystanderTeacher, "bystander"]]) {
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [user, `${label}@handover.invalid`]);
    await db.query("update public.profiles set school_id=$2 where id=$1", [user, id.schoolA]);
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'teacher')", [user, id.schoolA]);
    await db.query("insert into public.teachers(id,school_id,profile_id,employee_id,full_name) values($1,$2,$3,$4,$5)",
      [teacher, id.schoolA, user, `HANDOVER-${label}`, `Handover ${label}`]);
  }
  await db.exec("insert into auth.sessions(id,user_id) select id,id from auth.users on conflict do nothing");
  await db.query(`insert into public.class_logs(id,school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,log_date,topic,status)
    values($1,$3,$4,$5,$6,$7,$8,'2026-10-01','Published before handover','published'),
      ($2,$3,$4,$5,$6,$7,$8,'2026-10-02','Unpublished draft','draft')`,
  [publishedLog, draftLog, id.schoolA, id.yearA, id.classA, id.sectionA, id.subjectA, id.teacherRecordA]);
  await db.query("insert into public.class_activities(id,class_log_id,activity_type,title,max_marks,attachment_url) values($1,$2,'homework','Handover homework',10,$3)", [homework, publishedLog, materialPath]);
  await db.query("insert into storage.objects(bucket_id,name,owner_id,metadata) values('study-materials',$1,$2,'{\"size\":78,\"mimetype\":\"text/plain\"}')", [materialPath, id.teacherA]);

  await db.exec("begin");
  await actor(id.studentUserA, "insert into storage.objects(bucket_id,name,owner_id,metadata) values('homework-submissions',$1,$2,'{\"size\":608,\"mimetype\":\"application/pdf\"}')",
    [homeworkPath, id.studentUserA], "object.upload");
  submission = (await value<{ id: string }>(id.studentUserA, "select public.submit_homework($1,'My answer',$2,null,$3,'answer.pdf') as value",
    [homework, homeworkPath, randomUUID()])).id;
  await db.exec("commit");

  // Mid-term staff change: the 6A science assignment now belongs to the successor.
  await db.query("update public.teacher_subject_assignments set teacher_id=$2 where id=$1", [id.assignmentA, successorTeacher]);
}, 60_000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

describe("homework grading after a class-subject teacher handover", () => {
  it("lets the currently assigned teacher see the earlier published homework but not the old teacher's draft", async () => {
    expect(await visible(successorUser, "class_logs", publishedLog)).toEqual([{ id: publishedLog }]);
    expect(await visible(successorUser, "class_activities", homework)).toEqual([{ id: homework }]);
    expect(await visible(successorUser, "class_logs", draftLog)).toEqual([]);
    expect(await visible(successorUser, "activity_submissions", submission)).toEqual([{ id: submission }]);
  });

  it("lets the successor list, open and grade the pending submission", async () => {
    expect((await roster(successorUser)).students.find((row) => row.student_id === id.pupilA)?.submission).toMatchObject({ id: submission });
    expect(await value(successorUser, "select public.authorize_private_academic_file('submission',$1) as value", [submission]))
      .toMatchObject({ path: homeworkPath, bucket: "homework-submissions" });
    expect(await grade(successorUser)).toMatchObject({ status: "graded" });
    expect((await db.query("select marks::text,status from public.activity_submissions where id=$1", [submission])).rows)
      .toEqual([{ marks: "9", status: "graded" }]);
  });

  it("gives the successor the earlier teacher's homework material, through every academic-log read gate", async () => {
    expect(await value(successorUser, "select public.authorize_private_academic_file('activity',$1) as value", [homework]))
      .toMatchObject({ path: materialPath, bucket: "study-materials" });
    expect(await value(successorUser, "select app_private.can_read_academic_log($1) as value", [publishedLog])).toBe(true);
    expect(await value(successorUser, "select app_private.can_read_academic_log($1) as value", [draftLog])).toBe(false);
  });

  it("keeps the log itself owned by its author: the successor cannot edit it", async () => {
    const result = await actor(successorUser, "update public.class_logs set topic='Taken over' where id=$1", [publishedLog]);
    expect(result.affectedRows ?? 0).toBe(0);
    expect((await db.query("select topic from public.class_logs where id=$1", [publishedLog])).rows).toEqual([{ topic: "Published before handover" }]);
  });

  it("cuts off the previous teacher and an unassigned teacher of the same school", async () => {
    for (const user of [id.teacherA, bystanderUser]) {
      await expect(roster(user)).rejects.toMatchObject({ code: "42501" });
      await expect(grade(user)).rejects.toMatchObject({ code: "42501" });
      expect(await visible(user, "class_logs", publishedLog)).toEqual([]);
      expect(await visible(user, "activity_submissions", submission)).toEqual([]);
      await expect(value(user, "select public.authorize_private_academic_file('activity',$1) as value", [homework])).rejects.toMatchObject({ code: "42501" });
      expect(await value(user, "select app_private.can_read_academic_log($1) as value", [publishedLog])).toBe(false);
    }
  });
});
