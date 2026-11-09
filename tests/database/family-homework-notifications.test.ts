// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase, readRecoveryManifest, readRecoverySources } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite;
const migrationPath = "supabase/migrations/20261109144029_family_homework_notifications.sql";
const legacyLog = randomUUID();
const legacyActivity = randomUUID();
const otherSection = randomUUID();
const otherClass = randomUUID();
const otherClassSection = randomUUID();
const otherGuardian = randomUUID();
type Role = "parent" | "student";
type Cursor = { id: string; kind: string; created_at: string };
type Notification = Cursor & { read_at: string | null };
type Inbox = { notifications: Notification[]; unread_count: number; next_cursor: Cursor | null };
type Work = { id?: string; title: string; activity_type: "homework" | "classwork"; description?: string; due_date?: string; max_marks?: number };

beforeAll(async () => {
  db = await createRecoveryDatabase({ applyPending: false });
  const sources = await readRecoverySources(await readRecoveryManifest());
  for (const source of sources) {
    if (source.path === migrationPath) break;
    if (source.kind === "pending") await db.exec(source.sql);
  }
  await seedRecoveryData(db);
  await db.query(`insert into public.class_logs(id,school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,log_date,topic,status)
    values($1,$2,$3,$4,$5,$6,$7,'2026-11-03','Legacy lesson','published')`,
  [legacyLog, id.schoolA, id.yearA, id.classA, id.sectionA, id.subjectA, id.teacherRecordA]);
  await db.query("insert into public.class_activities(id,class_log_id,activity_type,title) values($1,$2,'homework','Legacy homework')",
    [legacyActivity, legacyLog]);
  await db.exec(await readFile(new URL(`../../${migrationPath}`, import.meta.url), "utf8"));
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'other-guardian@homework.invalid',now())", [otherGuardian]);
  await db.query("update public.profiles set school_id=$1 where id=$2", [id.schoolA, otherGuardian]);
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
  await db.query("insert into public.classes(id,school_id,name) values($1,$2,'Other homework class')", [otherClass, id.schoolA]);
  await db.query("insert into public.sections(id,school_id,class_id,name) values($1,$2,$3,'Peer section'),($4,$2,$5,'Peer class section')",
    [otherSection, id.schoolA, id.classA, otherClassSection, otherClass]);
  await db.query(`insert into public.teacher_subject_assignments(teacher_id,academic_year_id,class_id,section_id,subject_id)
    values($1,$2,$3,$4,$5),($1,$2,$6,$7,$5)`,
  [id.teacherRecordA, id.yearA, id.classA, otherSection, id.subjectA, otherClass, otherClassSection]);
}, 60_000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

async function asActor<T>(user: string, sql: string, params: unknown[] = [], session = user): Promise<T> {
  await db.exec("savepoint homework_actor");
  try {
    await db.exec("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [user, JSON.stringify({ sub: user, session_id: session, aal: "aal1", role: "authenticated" })]);
    const result = await db.query<{ value: T }>(sql, params);
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true)");
    await db.exec("release savepoint homework_actor");
    return result.rows[0].value;
  } catch (error) {
    await db.exec("rollback to savepoint homework_actor; release savepoint homework_actor");
    throw error;
  }
}

function inbox(user: string, role: Role, options: {
  limit?: number; cursor?: Cursor | null; unreadOnly?: boolean; version?: 4 | 5; session?: string;
} = {}) {
  const { limit = 30, cursor, unreadOnly = false, version = 5, session } = options;
  return asActor<Inbox>(user, `select public.get_family_notification_inbox_v${version}($1,$2,$3,$4,$5,$6) as value`,
    [role, unreadOnly, limit, cursor?.created_at ?? null, cursor?.kind ?? null, cursor?.id ?? null], session);
}

const assignments = (result: Inbox) => result.notifications.filter(({ kind }) => kind === "homework_assigned");
const mark = (user: string, role: Role, activity: string) => asActor<string | null>(user,
  "select public.mark_family_notification_read_v5($1,'homework_assigned',$2)::text as value", [role, activity]);
const detail = (user: string, role: Role, activity: string) => asActor<Record<string, unknown> | null>(user,
  "select public.get_family_homework($1,$2) as value", [role, activity]);
const homework = (title: string, activityId?: string): Work => ({
  ...(activityId ? { id: activityId } : {}), title, activity_type: "homework",
  description: "Read and solve question two.", due_date: "2026-11-24", max_marks: 10,
});

function logFields(overrides: Record<string, unknown> = {}) {
  return {
    school_id: id.schoolA, academic_year_id: id.yearA, class_id: id.classA, section_id: id.sectionA,
    subject_id: id.subjectA, log_date: "2026-11-09", topic: "Fractions", summary: "QA lesson", status: "published", ...overrides,
  };
}

const save = (activities: Work[], log = logFields(), user = id.teacherA) => asActor<string>(user,
  "select public.save_academic_log($1::jsonb,$2::jsonb) as value", [JSON.stringify(log), JSON.stringify(activities)]);
async function updateFields(log: string, overrides: Record<string, unknown> = {}) {
  const { rows: [row] } = await db.query<Record<string, unknown>>(`select id,school_id,academic_year_id,class_id,section_id,subject_id,
    log_date::text,topic,summary,status,updated_at::text as expected_updated_at from public.class_logs where id=$1`, [log]);
  return logFields({ ...row, ...overrides });
}
async function activities(log: string) {
  return (await db.query<{ id: string; title: string }>("select id,title from public.class_activities where class_log_id=$1 order by title",
    [log])).rows;
}

async function linkGuardian(user: string, student: string) {
  const parent = randomUUID();
  await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'parent')", [user, id.schoolA]);
  await db.query("insert into public.parents(id,school_id,profile_id) values($1,$2,$3)", [parent, id.schoolA, user]);
  await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [student, parent]);
}

describe("family homework notifications", () => {
  it("uses the normal authoring RPC for drafts and publish, without backfilling edits to existing homework", async () => {
    const priorV4 = await inbox(id.guardianA, "parent", { version: 4 });
    await save([homework("Legacy title corrected", legacyActivity)], await updateFields(legacyLog));
    expect(assignments(await inbox(id.guardianA, "parent"))).toEqual([]);
    expect(await detail(id.guardianA, "parent", legacyActivity)).toBeNull();
    expect(await asActor(id.studentUserA, "select id as value from public.class_activities where id=$1", [legacyActivity])).toBe(legacyActivity);

    const log = await save([homework("Draft homework"), { title: "Classwork is separate", activity_type: "classwork" }],
      logFields({ status: "draft" }));
    const [classwork, work] = await activities(log);
    expect(assignments(await inbox(id.studentUserA, "student"))).toEqual([]);
    expect(await detail(id.studentUserA, "student", work.id)).toBeNull();

    const publish = await updateFields(log, { status: "published" });
    expect(await save([homework("Published homework", work.id), { ...classwork, activity_type: "classwork" }], publish)).toBe(log);
    const published = assignments(await inbox(id.studentUserA, "student"));
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ id: work.id, source_id: work.id, title: "Published homework", read_at: null });
    expect(await detail(id.studentUserA, "student", work.id)).toMatchObject({
      id: work.id, title: "Published homework", description: "Read and solve question two.", due_date: "2026-11-24",
      school_id: id.schoolA, academic_year_id: id.yearA, class_id: id.classA, section_id: id.sectionA,
      subject_id: id.subjectA, student_id: id.pupilA, max_marks: 10,
    });
    expect(await detail(id.guardianA, "parent", work.id)).toMatchObject({ id: work.id, student_id: null });
    expect(await detail(id.studentUserA, "student", classwork.id)).toBeNull();
    expect(await inbox(id.guardianA, "parent", { version: 4 })).toEqual(priorV4);

    const edit = await updateFields(log, { topic: "Same homework" });
    await save([homework("Corrected homework", work.id), { ...classwork, activity_type: "classwork" }], edit);
    const current = assignments(await inbox(id.studentUserA, "student"));
    expect(current).toMatchObject([{ id: work.id, title: "Corrected homework", created_at: published[0].created_at }]);
    const readAt = await mark(id.studentUserA, "student", work.id);
    await save([homework("Corrected homework", work.id), { ...classwork, activity_type: "classwork" }],
      await updateFields(log, { status: "draft" }));
    expect(assignments(await inbox(id.studentUserA, "student"))).toEqual([]);
    expect(await detail(id.studentUserA, "student", work.id)).toBeNull();
    await save([homework("Corrected homework", work.id), { ...classwork, activity_type: "classwork" }],
      await updateFields(log, { status: "published" }));
    expect(assignments(await inbox(id.studentUserA, "student"))).toMatchObject([
      { id: work.id, created_at: published[0].created_at, read_at: expect.any(String) },
    ]);
    expect(await mark(id.studentUserA, "student", work.id)).toBe(readAt);
  });

  it("notifies new work on a published legacy log, including a classwork conversion, without adopting reparented work", async () => {
    const original = homework("Legacy homework", legacyActivity);
    await save([original, homework("New homework"), { title: "Classwork to convert", activity_type: "classwork" }],
      await updateFields(legacyLog));
    const [classwork, , newWork] = await activities(legacyLog);
    expect(assignments(await inbox(id.studentUserA, "student"))).toMatchObject([{ id: newWork.id }]);
    await save([original, homework("New homework", newWork.id), homework("Converted homework", classwork.id)],
      await updateFields(legacyLog));
    expect(assignments(await inbox(id.studentUserA, "student")).map(({ id }) => id).sort()).toEqual([newWork.id, classwork.id].sort());
    const movedLog = await save([], logFields({ log_date: "2026-11-10" }));
    await db.query("update public.class_activities set class_log_id=$1 where id in ($2,$3)", [movedLog, legacyActivity, newWork.id]);
    expect(assignments(await inbox(id.studentUserA, "student"))).toMatchObject([{ id: classwork.id }]);
    expect(await detail(id.studentUserA, "student", newWork.id)).toBeNull();
    expect(await detail(id.studentUserA, "student", legacyActivity)).toBeNull();
  });

  it("checks exact selected role, school, class, section and a live session", async () => {
    await linkGuardian(id.studentUserA, id.unlinkedPupilA);
    await db.query("update public.enrollments set section_id=$1 where student_id=$2", [otherSection, id.unlinkedPupilA]);
    const [own] = await activities(await save([homework("Own section")]));
    const [peer] = await activities(await save([homework("Peer section")], logFields({ section_id: otherSection })));
    const [foreignClass] = await activities(await save([homework("Another class")], logFields({ class_id: otherClass, section_id: otherClassSection })));
    const visible = async (user: string, role: Role) => assignments(await inbox(user, role)).map(({ id }) => id);
    expect(await visible(id.studentUserA, "student")).toEqual([own.id]);
    expect(await visible(id.studentUserA, "parent")).toEqual([peer.id]);
    expect(await visible(id.guardianA, "parent")).toEqual([own.id]);
    expect(await visible(id.studentUserB, "student")).toEqual([]);
    for (const activity of [peer, foreignClass]) expect(await detail(id.guardianA, "parent", activity.id)).toBeNull();
    expect(await detail(id.studentUserB, "student", own.id)).toBeNull();
    expect(await mark(id.studentUserA, "parent", own.id)).toBeNull();
    await expect(inbox(id.teacherA, "parent")).rejects.toMatchObject({ code: "42501" });
    await expect(inbox(id.guardianA, "parent", { session: randomUUID() })).rejects.toMatchObject({ code: "42501" });
    await expect(save([homework("Unauthorized publisher")], logFields({ log_date: "2026-11-10" }), id.guardianA))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("deduplicates siblings and keeps reads independent as matching links are removed", async () => {
    await linkGuardian(otherGuardian, id.pupilA);
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [id.unlinkedPupilA, id.parentA]);
    const [work] = await activities(await save([homework("Homework for both siblings")]));
    expect(assignments(await inbox(id.guardianA, "parent"))).toHaveLength(1);
    const firstRead = await mark(id.guardianA, "parent", work.id);
    expect(firstRead).toEqual(expect.any(String));
    expect(await mark(id.guardianA, "parent", work.id)).toBe(firstRead);
    expect(assignments(await inbox(id.guardianA, "parent", { unreadOnly: true }))).toEqual([]);
    expect(assignments(await inbox(otherGuardian, "parent", { unreadOnly: true }))).toMatchObject([{ id: work.id, read_at: null }]);
    expect(assignments(await inbox(id.studentUserA, "student", { unreadOnly: true }))).toMatchObject([{ id: work.id, read_at: null }]);

    await db.query("delete from public.student_parents where parent_id=$1 and student_id=$2", [id.parentA, id.pupilA]);
    expect(assignments(await inbox(id.guardianA, "parent"))).toMatchObject([{ id: work.id, read_at: expect.any(String) }]);
    await db.query("delete from public.student_parents where parent_id=$1 and student_id=$2", [id.parentA, id.unlinkedPupilA]);
    expect(assignments(await inbox(id.guardianA, "parent"))).toEqual([]);
    expect(await detail(id.guardianA, "parent", work.id)).toBeNull();
    expect(await mark(id.guardianA, "parent", work.id)).toBeNull();
    expect(assignments(await inbox(otherGuardian, "parent"))).toMatchObject([{ id: work.id, read_at: null }]);
  });

  it("counts and marks eligible homework beyond the first page without touching another account", async () => {
    const inherited = await inbox(id.studentUserA, "student", { version: 4, unreadOnly: true });
    const works = await activities(await save([homework("One"), homework("Two"), homework("Three")]));
    const first = await inbox(id.studentUserA, "student", { limit: 2, unreadOnly: true });
    const second = await inbox(id.studentUserA, "student", { limit: 2, cursor: first.next_cursor, unreadOnly: true });
    expect(first.next_cursor?.kind).toBe("homework_assigned");
    expect(second.next_cursor).toBeNull();
    const pages = [...first.notifications, ...second.notifications];
    expect(pages.map(({ id }) => id).sort()).toEqual([...works, ...inherited.notifications].map(({ id }) => id).sort());
    expect(first.unread_count).toBe(inherited.unread_count + 3);
    expect(await asActor(id.studentUserA, "select public.get_family_notification_unread_count_v5('student')::int as value")).toBe(first.unread_count);
    expect(await asActor(id.studentUserA, "select public.mark_all_family_notifications_read_v5('student')::int as value")).toBe(first.unread_count);
    expect(await asActor(id.studentUserA, "select public.mark_all_family_notifications_read_v5('student')::int as value")).toBe(0);
    expect((await inbox(id.studentUserA, "student", { unreadOnly: true })).notifications).toEqual([]);
    expect(assignments(await inbox(id.guardianA, "parent", { unreadOnly: true }))).toHaveLength(3);
  });

  it("withholds newly published homework from withdrawn enrollment without removing its existing academic history", async () => {
    const [earlier] = await activities(await save([homework("Earlier homework")]));
    expect(await detail(id.studentUserA, "student", earlier.id)).toMatchObject({ id: earlier.id });
    await asActor(id.adminA, "select public.withdraw_roster_enrollment($1,$2,$3,$4,$5,'Synthetic withdrawal') as value",
      [id.schoolA, id.yearA, id.classA, id.sectionA, id.pupilA]);
    const [later] = await activities(await save([homework("Assigned after withdrawal")], logFields({ log_date: "2026-11-10" })));
    expect(assignments(await inbox(id.studentUserA, "student"))).toEqual([]);
    expect(assignments(await inbox(id.guardianA, "parent"))).toEqual([]);
    expect(await detail(id.studentUserA, "student", later.id)).toBeNull();
    expect(await detail(id.guardianA, "parent", later.id)).toBeNull();
    expect(await asActor(id.studentUserA, "select id as value from public.class_activities where id=$1", [earlier.id])).toBe(earlier.id);
  });
});
