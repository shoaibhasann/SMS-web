// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

// gap3#1: a class/section/teacher notice keeps the cohort of the year current at
// publication; activating the next year must not hand it to the incoming cohort.
let db: PGlite;
const nextYear = randomUUID();
const classSeven = randomUUID();
const sectionSeven = randomUUID();
const classFive = randomUUID();
const sectionFive = randomUUID();
const incomingPupil = randomUUID();
const incomingGuardian = randomUUID();
const incomingParent = randomUUID();
const notices: Record<string, string> = {};
type Role = "parent" | "student";

async function asActor<T>(user: string, sql: string, params: unknown[] = [], aal = "aal1"): Promise<T[]> {
  await db.exec("begin");
  try {
    await db.exec("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [user, JSON.stringify({ sub: user, session_id: user, aal, role: "authenticated" })]);
    const { rows } = await db.query<T>(sql, params);
    await db.exec("commit");
    return rows;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

async function publish(key: string, audience: unknown, publishedAt = "now() - interval '1 day'") {
  const { rows } = await db.query<{ id: string }>(`insert into public.notices(school_id,title,content,audience,published_at,created_by)
    values($1,$2,'Only for the intended cohort',$3::jsonb,${publishedAt},$4) returning id`,
  [id.schoolA, key, JSON.stringify(audience), id.adminA]);
  notices[key] = rows[0].id;
}

const family = { roles: ["parent", "student"] };
const inboxIds = async (user: string, role: Role) => (await asActor<{ value: { notifications: { id: string; kind: string }[] } }>(user,
  "select public.get_family_notification_inbox_v8($1,false,50,null,null,null) as value", [role]))[0].value.notifications
  .filter(({ kind }) => kind === "announcement").map(({ id: noticeId }) => noticeId);
const detail = async (user: string, role: Role, notice: string) => (await asActor<{ value: unknown }>(user,
  "select public.get_family_announcement($1,$2) as value", [role, notice]))[0].value;
const board = async (user: string) => (await asActor<{ id: string }>(user, "select id from public.notices")).map((row) => row.id);
const pushRecipients = async (notice: string) => (await db.query<{ user_id: string }>(
  "select user_id from app_private.family_notice_push_recipients($1,null,null) order by user_id", [notice])).rows.map((row) => row.user_id);
const keysIn = (ids: string[]) => Object.entries(notices).filter(([, noticeId]) => ids.includes(noticeId)).map(([key]) => key).sort();

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal2' from auth.users");
  const today = (await db.query<{ today: string }>("select ((now() at time zone 'Asia/Kolkata')::date)::text as today")).rows[0].today;
  await db.query("update public.academic_years set start_date=$1::date-200,end_date=$1::date-1 where id=$2", [today, id.yearA]);
  await db.query(`insert into public.academic_years(id,school_id,name,start_date,end_date,is_current)
    values($1,$2,'Next session',$3::date,$3::date+300,false)`, [nextYear, id.schoolA, today]);
  await db.query("insert into public.classes(id,school_id,name) values($1,$3,'Class 7'),($2,$3,'Class 5')", [classSeven, classFive, id.schoolA]);
  await db.query("insert into public.sections(id,school_id,class_id,name) values($1,$3,$4,'A'),($2,$3,$5,'A')",
    [sectionSeven, sectionFive, id.schoolA, classSeven, classFive]);

  // A Class 5 pupil whose guardian has a family device and account.
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'incoming-guardian@recovery.invalid',now())", [incomingGuardian]);
  await db.query(`insert into public.profiles(id,school_id,full_name,email) values($1,$2,'Incoming guardian','incoming-guardian@recovery.invalid')
    on conflict(id) do update set school_id=excluded.school_id`, [incomingGuardian, id.schoolA]);
  await db.query("insert into auth.sessions(id,user_id,aal) values($1,$1,'aal1')", [incomingGuardian]);
  await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'parent')", [incomingGuardian, id.schoolA]);
  await db.query(`insert into public.students(id,school_id,admission_no,first_name,dob,registered_mobile)
    values($1,$2,'REC-A-005','Incoming pupil','2015-06-15','0000000000')`, [incomingPupil, id.schoolA]);
  await db.query("insert into public.enrollments(student_id,academic_year_id,class_id,section_id) values($1,$2,$3,$4)",
    [incomingPupil, id.yearA, classFive, sectionFive]);
  await db.query("insert into public.parents(id,school_id,profile_id) values($1,$2,$3)", [incomingParent, id.schoolA, incomingGuardian]);
  await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [incomingPupil, incomingParent]);
  for (const [user, role] of [[id.guardianA, "parent"], [id.studentUserA, "student"], [incomingGuardian, "parent"]]) {
    await db.query(`insert into app_private.family_push_devices
      (installation_id,installation_hash,user_id,recipient_role,school_id,session_id,device_fid,fid_hash,platform,label)
      select gen_random_uuid(),sha256(gen_random_uuid()::text::bytea),$1,$3,$2,$1,f,sha256(f::bytea),'android','QA phone'
      from (select gen_random_uuid()::text as f) fid`, [user, id.schoolA, role]);
    await db.query(`insert into app_private.family_push_preferences(user_id,recipient_role,enabled) values($1,$2,true)
      on conflict(user_id,recipient_role) do update set enabled=true`, [user, role]);
  }

  // Published to the outgoing Class 6 cohort before the session changes.
  await publish("class", { ...family, class_id: id.classA });
  await publish("section", { ...family, class_id: id.classA, section_id: id.sectionA });
  await publish("teacher", { ...family, teacher_id: id.teacherRecordA });
  await publish("everyone", family);

  // Promotion: the Class 6 pupils move to Class 7 and the Class 5 pupil moves INTO Class 6.
  await db.query(`insert into public.enrollments(student_id,academic_year_id,class_id,section_id,status)
    values($1,$4,$5,$6,'staged'),($2,$4,$5,$6,'staged'),($3,$4,$7,$8,'staged')`,
  [id.pupilA, id.unlinkedPupilA, incomingPupil, nextYear, classSeven, sectionSeven, id.classA, id.sectionA]);
  await db.query(`insert into public.teacher_subject_assignments(teacher_id,academic_year_id,class_id,section_id,subject_id,is_class_teacher)
    values($1,$2,$3,$4,$5,true)`, [id.teacherRecordA, nextYear, id.classA, id.sectionA, id.subjectA]);
  expect(keysIn(await inboxIds(incomingGuardian, "parent"))).toEqual(["everyone"]);

  await asActor(id.adminA, "select public.activate_academic_year($1,$2,$3,'Year-end rollover') as id",
    [id.schoolA, id.yearA, nextYear], "aal2");
  await publish("after", { ...family, class_id: id.classA }, "clock_timestamp()");
}, 120_000);
afterAll(async () => { await db?.close(); });

describe("notice audience year snapshot", () => {
  it("keeps targeted notices with the cohort they were published to after year activation", async () => {
    expect(keysIn(await inboxIds(id.guardianA, "parent"))).toEqual(["class", "everyone", "section", "teacher"]);
    expect(keysIn(await inboxIds(id.studentUserA, "student"))).toEqual(["class", "everyone", "section", "teacher"]);
    expect(await detail(id.guardianA, "parent", notices.class)).toMatchObject({ id: notices.class });
    expect(keysIn(await board(id.guardianA))).toEqual(["class", "everyone", "section", "teacher"]);
    expect(await pushRecipients(notices.class)).toEqual([id.guardianA, id.studentUserA].sort());
  });

  it("does not hand last cohort's targeted notices to the incoming class", async () => {
    expect(keysIn(await inboxIds(incomingGuardian, "parent"))).toEqual(["after", "everyone"]);
    expect(await detail(incomingGuardian, "parent", notices.class)).toBeNull();
    expect(await detail(incomingGuardian, "parent", notices.teacher)).toBeNull();
    expect(keysIn(await board(incomingGuardian))).toEqual(["after", "everyone"]);
    for (const key of ["class", "section", "teacher"]) expect(await pushRecipients(notices[key])).not.toContain(incomingGuardian);
  });

  it("targets notices published after activation at the new cohort", async () => {
    expect(await pushRecipients(notices.after)).toEqual([incomingGuardian]);
    expect(await detail(id.guardianA, "parent", notices.after)).toBeNull();
    expect(await pushRecipients(notices.everyone)).toEqual([id.guardianA, id.studentUserA, incomingGuardian].sort());
  });

  // Runs last: withdrawal only closes the current-year enrollment; the old-year one stays 'active'.
  it("drops old targeted notices for a pupil withdrawn after activation", async () => {
    await db.query("update public.enrollments set status='withdrawn' where student_id=$1 and academic_year_id=$2", [id.pupilA, nextYear]);
    expect(await inboxIds(id.guardianA, "parent")).toEqual([]);
    expect(await inboxIds(id.studentUserA, "student")).toEqual([]);
    for (const key of ["class", "section", "teacher"]) {
      expect(await detail(id.guardianA, "parent", notices[key])).toBeNull();
      expect(await pushRecipients(notices[key])).toEqual([]);
    }
    expect(keysIn(await board(id.guardianA))).toEqual(["everyone"]);
    expect(keysIn(await board(id.studentUserA))).toEqual(["everyone"]);
  });
});
