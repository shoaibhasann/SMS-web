// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase, readRecoveryManifest, readRecoverySources } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

const migrationPath = "supabase/migrations/20261109153905_family_exam_schedule_notifications.sql";
const peerSection = randomUUID();
const otherClass = randomUUID();
const otherClassSection = randomUUID();
type Role = "student" | "parent";
type Cursor = { id: string; kind: string; created_at: string };
type Notification = Cursor & { source_id: string; read_at: string | null };
type Inbox = { notifications: Notification[]; unread_count: number; next_cursor: Cursor | null };
type Schedule = {
  id: string; name: string; assessment_date: string; subject_name: string; class_name: string;
  section_name: string | null; description: string | null;
};
let db: PGlite;
let dates: { yesterday: string; today: string; tomorrow: string; later: string; outside: string };

beforeAll(async () => {
  db = await createRecoveryDatabase({ applyPending: false });
  const sources = await readRecoverySources(await readRecoveryManifest());
  for (const source of sources) {
    if (source.path === migrationPath) break;
    if (source.kind === "pending") await db.exec(source.sql);
  }
  await seedRecoveryData(db);
  dates = (await db.query<typeof dates>(`select (d-1)::text as yesterday,d::text as today,(d+1)::text as tomorrow,
    (d+5)::text as later,(d+61)::text as outside from (select (now() at time zone 'Asia/Kolkata')::date as d) calendar`)).rows[0];
  await db.query("update public.academic_years set start_date=$2::date-60,end_date=$2::date+60 where id in ($1,$3)", [id.yearA, dates.today, id.yearB]);
  await db.query("update public.teacher_assessments set assessment_date=$2 where id=$1", [id.assessmentA, dates.tomorrow]);
  await db.exec(await readFile(new URL(`../../${migrationPath}`, import.meta.url), "utf8"));
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
  await db.query("insert into public.classes(id,school_id,name) values($1,$2,'Other exam class')", [otherClass, id.schoolA]);
  await db.query("insert into public.sections(id,school_id,class_id,name) values($1,$2,$3,'Peer section'),($4,$2,$5,'Other class section')",
    [peerSection, id.schoolA, id.classA, otherClassSection, otherClass]);
}, 60_000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

async function asActor<T>(user: string, sql: string, params: unknown[] = [], session = user): Promise<T> {
  await db.exec("savepoint exam_actor");
  try {
    await db.exec("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [user, JSON.stringify({ sub: user, session_id: session, aal: "aal1", role: "authenticated" })]);
    const { rows: [result] } = await db.query<{ value: T }>(sql, params);
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true)");
    await db.exec("release savepoint exam_actor");
    return result.value;
  } catch (error) {
    await db.exec("rollback to savepoint exam_actor; release savepoint exam_actor");
    throw error;
  }
}

function inbox(user: string, role: Role, options: {
  limit?: number; cursor?: Cursor | null; unreadOnly?: boolean; version?: 7 | 8; session?: string;
} = {}) {
  const { limit = 30, cursor, unreadOnly = false, version = 8, session } = options;
  return asActor<Inbox>(user, `select public.get_family_notification_inbox_v${version}($1,$2,$3,$4,$5,$6) as value`,
    [role, unreadOnly, limit, cursor?.created_at ?? null, cursor?.kind ?? null, cursor?.id ?? null], session);
}

const exams = (result: Inbox) => result.notifications.filter(({ kind }) => kind === "exam_schedule");
const mark = (user: string, role: Role, event: string) => asActor<string | null>(user,
  "select public.mark_family_notification_read_v8($1,'exam_schedule',$2)::text as value", [role, event]);
const detail = (user: string, role: Role, assessment: string) => asActor<Schedule | null>(user,
  "select public.get_family_exam_schedule($1,$2) as value", [role, assessment]);
const list = (user: string, role: Role, offset = 0) => asActor<{ rows: Schedule[]; total_count: number }>(user,
  "select public.list_family_exam_schedules($1,$2) as value", [role, offset]);
const write = (name: string, options: {
  user?: string; assessmentDate?: string; section?: string | null; classId?: string; status?: "scheduled" | "completed";
} = {}) => {
  const { user = id.teacherA, assessmentDate = dates.tomorrow, section = id.sectionA, classId = id.classA, status = "scheduled" } = options;
  return asActor<string>(user, `insert into public.teacher_assessments
    (school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,name,assessment_date,maximum_marks,description,status)
    values($1,$2,$3,$4,$5,$6,$7,$8,50,'Bring your notebook.',$9) returning id as value`,
  [id.schoolA, id.yearA, classId, section, id.subjectA, id.teacherRecordA, name, assessmentDate, status]);
};

describe("family exam schedule notifications", () => {
  it("keeps existing upcoming exams in the schedule and versions real schedule edits without duplicating retries", async () => {
    const previous = await inbox(id.guardianA, "parent", { version: 7 });
    expect((await list(id.studentUserA, "student")).rows).toMatchObject([{ id: id.assessmentA, assessment_date: dates.tomorrow }]);
    expect(await detail(id.guardianA, "parent", id.assessmentA)).toMatchObject({ id: id.assessmentA });
    await asActor(id.teacherA, "update public.teacher_assessments set maximum_marks=110 where id=$1 returning id as value", [id.assessmentA]);
    expect(exams(await inbox(id.guardianA, "parent"))).toEqual([]);

    const assessment = await write("Science quiz");
    const firstInbox = await inbox(id.guardianA, "parent");
    expect(firstInbox.unread_count).toBe(previous.unread_count + 1);
    expect(exams(firstInbox)).toHaveLength(1);
    const [first] = exams(firstInbox);
    expect(first).toMatchObject({ source_id: assessment, student_id: null, student_name: null, assessment_id: null,
      kind: "exam_schedule", status: "scheduled", title: "Science quiz", event_date: dates.tomorrow, read_at: null });
    expect(first.id).not.toBe(assessment);
    expect(await detail(id.studentUserA, "student", assessment)).toEqual({
      id: assessment, name: "Science quiz", assessment_date: dates.tomorrow, subject_name: "Recovery science",
      class_name: "Recovery class 6", section_name: "Recovery A", description: "Bring your notebook.",
    });
    const readAt = await mark(id.guardianA, "parent", first.id);
    expect(readAt).toEqual(expect.any(String));
    await asActor(id.teacherA, "update public.teacher_assessments set assessment_date=$2,name=name,maximum_marks=55 where id=$1 returning id as value",
      [assessment, dates.tomorrow]);
    expect(exams(await inbox(id.guardianA, "parent"))).toMatchObject([{ id: first.id, created_at: first.created_at, read_at: expect.any(String) }]);
    expect(await mark(id.guardianA, "parent", first.id)).toBe(readAt);
    expect(exams(await inbox(id.studentUserA, "student", { unreadOnly: true }))).toMatchObject([{ id: first.id, read_at: null }]);

    await asActor(id.adminA, "update public.teacher_assessments set assessment_date=$2 where id=$1 returning id as value", [assessment, dates.later]);
    const [replacement] = exams(await inbox(id.guardianA, "parent", { unreadOnly: true }));
    expect(replacement).toMatchObject({ source_id: assessment, status: "rescheduled", event_date: dates.later, read_at: null });
    expect(replacement.id).not.toBe(first.id);
    expect(await mark(id.guardianA, "parent", first.id)).toBeNull();
    expect(await detail(id.guardianA, "parent", assessment)).toMatchObject({ assessment_date: dates.later });
    expect(await inbox(id.guardianA, "parent", { version: 7 })).toEqual(previous);

    await asActor(id.teacherA, "update public.teacher_assessments set status='completed' where id=$1 returning id as value", [assessment]);
    expect(exams(await inbox(id.guardianA, "parent"))).toEqual([]);
    expect(await detail(id.guardianA, "parent", assessment)).toBeNull();
    expect(await mark(id.guardianA, "parent", replacement.id)).toBeNull();
    await asActor(id.teacherA, "update public.teacher_assessments set status='scheduled' where id=$1 returning id as value", [assessment]);
    const [reopened] = exams(await inbox(id.guardianA, "parent"));
    expect(reopened).toMatchObject({ source_id: assessment, status: "scheduled", read_at: null });
    expect([first.id, replacement.id]).not.toContain(reopened.id);
  });

  it("authorizes exact active class and section by role and tenant, deduplicates siblings and rechecks link revocation", async () => {
    await db.query("update public.enrollments set section_id=$1 where student_id=$2", [peerSection, id.unlinkedPupilA]);
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [id.unlinkedPupilA, id.parentA]);
    const mixedParent = randomUUID();
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'parent')", [id.studentUserA, id.schoolA]);
    await db.query("insert into public.parents(id,school_id,profile_id) values($1,$2,$3)", [mixedParent, id.schoolA, id.studentUserA]);
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [id.unlinkedPupilA, mixedParent]);
    const own = await write("Own section");
    const peer = await write("Peer section", { user: id.adminA, section: peerSection });
    const whole = await write("Whole class", { user: id.adminA, section: null });
    const other = await write("Other class", { user: id.adminA, classId: otherClass, section: otherClassSection });
    await expect(write("Unassigned teacher write", { section: peerSection })).rejects.toMatchObject({ code: "42501" });
    const visible = async (user: string, role: Role) => exams(await inbox(user, role)).map(({ source_id }) => source_id).sort();
    expect(await visible(id.studentUserA, "student")).toEqual([own, whole].sort());
    expect(await visible(id.studentUserA, "parent")).toEqual([peer, whole].sort());
    expect(await visible(id.guardianA, "parent")).toEqual([own, peer, whole].sort());
    expect(await detail(id.guardianA, "parent", whole)).toMatchObject({ id: whole, section_name: null });
    expect(await detail(id.studentUserA, "student", peer)).toBeNull();
    expect(await detail(id.studentUserA, "parent", own)).toBeNull();
    expect(await detail(id.studentUserB, "student", whole)).toBeNull();
    expect(await detail(id.guardianA, "parent", other)).toBeNull();
    await expect(list(id.teacherA, "parent")).rejects.toMatchObject({ code: "42501" });
    await expect(inbox(id.guardianA, "parent", { session: randomUUID() })).rejects.toMatchObject({ code: "42501" });

    const event = exams(await inbox(id.guardianA, "parent")).find(({ source_id }) => source_id === own)!;
    await db.query("delete from public.student_parents where parent_id=$1 and student_id=$2", [id.parentA, id.pupilA]);
    expect(await visible(id.guardianA, "parent")).toEqual([peer, whole].sort());
    expect(await mark(id.guardianA, "parent", event.id)).toBeNull();
    expect(await detail(id.guardianA, "parent", own)).toBeNull();
    await db.query("update public.enrollments set status='withdrawn' where student_id=$1", [id.unlinkedPupilA]);
    expect(await visible(id.guardianA, "parent")).toEqual([]);
    expect(await detail(id.guardianA, "parent", whole)).toBeNull();
    expect(await visible(id.studentUserA, "student")).toEqual([own, whole].sort());
  });

  it("excludes completed, elapsed and out-of-session exams while paging dates and marking beyond a single inbox page", async () => {
    const past = await write("Elapsed exam", { assessmentDate: dates.yesterday });
    const completed = await write("Completed exam", { status: "completed" });
    const outside = await write("Outside academic year", { assessmentDate: dates.outside });
    for (const invalid of [past, completed, outside]) {
      expect(await detail(id.guardianA, "parent", invalid)).toBeNull();
    }
    const today = await write("Today's exam", { assessmentDate: dates.today });
    await asActor(id.adminA, `with written as (
      insert into public.teacher_assessments
        (school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,name,assessment_date,maximum_marks)
      select $1,$2,$3,$4,$5,$6,'Schedule page '||n,$7::date+n/3,50 from generate_series(1,32) as n returning id
    ) select count(*) as value from written`, [id.schoolA, id.yearA, id.classA, id.sectionA, id.subjectA, id.teacherRecordA, dates.tomorrow]);
    const first = await list(id.guardianA, "parent");
    const next = await list(id.guardianA, "parent", 30);
    expect(first.total_count).toBe(34);
    expect(next.total_count).toBe(34);
    expect(first.rows).toHaveLength(30);
    expect(next.rows).toHaveLength(4);
    expect(first.rows[0].id).toBe(today);
    const rows = [...first.rows, ...next.rows];
    expect(new Set(rows.map(({ id }) => id)).size).toBe(34);
    expect(rows.map(({ assessment_date }) => assessment_date)).toEqual(rows.map(({ assessment_date }) => assessment_date).sort());

    const page = await inbox(id.guardianA, "parent", { unreadOnly: true, limit: 1 });
    expect(page.notifications).toHaveLength(1);
    expect(page.next_cursor?.kind).toBe("exam_schedule");
    const second = await inbox(id.guardianA, "parent", { unreadOnly: true, limit: 1, cursor: page.next_cursor });
    expect(second.notifications[0].id).not.toBe(page.notifications[0].id);
    expect(await asActor(id.guardianA, "select public.mark_all_family_notifications_read_v8('parent') as value")).toBe(page.unread_count);
    expect((await inbox(id.guardianA, "parent", { unreadOnly: true })).unread_count).toBe(0);
    expect(exams(await inbox(id.studentUserA, "student", { unreadOnly: true, limit: 50 }))).toHaveLength(33);
  });
});
