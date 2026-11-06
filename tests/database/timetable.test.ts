// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase, readRecoveryManifest, readRecoverySources } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite;
const uuid = (number: number) => `75000000-0000-0000-0000-${String(number).padStart(12, "0")}`;
const extra = {
  principal: uuid(1), finance: uuid(2), teacherUser: uuid(3), globalAdmin: uuid(4), teacherUserB: uuid(5),
  teacherRecord: uuid(10), teacherRecordB: uuid(11), class: uuid(20), siblingSection: uuid(21), section: uuid(22), subject: uuid(30),
  sameSectionAssignment: uuid(40), siblingAssignment: uuid(41), teacherOtherClass: uuid(42), otherTeacherClass: uuid(43),
  wholeClassAssignment: uuid(44), assignmentB: uuid(45),
};
type Period = {
  id: string; school_id: string; academic_year_id: string; class_id: string; class_name: string;
  section_id: string | null; section_name: string | null; assignment_id: string | null;
  subject_id: string | null; subject_name: string | null; teacher_id: string | null; teacher_name: string | null;
  day_of_week: number; period_no: number; start_time: string | null; end_time: string | null;
  room: string | null; version: string; needs_attention: boolean;
};
type Week = {
  school_id: string; academic_year_id: string | null; academic_year_name: string | null;
  student_id?: string; class_id?: string | null; class_name?: string | null;
  section_id?: string | null; section_name?: string | null; rows: Period[];
};
type Setup = {
  years: { id: string; is_current: boolean }[];
  classes: { id: string }[]; sections: { id: string; class_id: string }[];
  assignments: { id: string; academic_year_id: string; class_id: string; section_id: string | null; teacher_id: string; subject_id: string; teacher_name: string }[];
};
type Save = {
  school: string | null; period: string | null; version: string | null; assignment: string | null;
  section: string | null; day: number | null; periodNo: number | null;
  start: string | null; end: string | null; room: string | null; key: string | null;
};

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  for (const [user, role, school] of [
    [extra.principal, "principal", id.schoolA], [extra.finance, "accountant", id.schoolA],
    [extra.teacherUser, "teacher", id.schoolA], [extra.globalAdmin, "super_admin", null],
    [extra.teacherUserB, "teacher", id.schoolB],
  ]) {
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [user, `${user}@timetable.invalid`]);
    await db.query("update public.profiles set school_id=$2,full_name=$3 where id=$1", [user, school, `Timetable ${role}`]);
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,$3)", [user, school, role]);
  }
  await db.query("insert into public.teachers(id,school_id,profile_id,employee_id,full_name) values($1,$2,$3,'TIMETABLE-OTHER','Another teacher'),($4,$5,$6,'TIMETABLE-B','Other school teacher')", [extra.teacherRecord, id.schoolA, extra.teacherUser, extra.teacherRecordB, id.schoolB, extra.teacherUserB]);
  await db.query("insert into public.classes(id,school_id,name) values($1,$2,'Timetable class 7')", [extra.class, id.schoolA]);
  await db.query("insert into public.sections(id,school_id,class_id,name) values($1,$2,$3,'Sibling B'),($4,$2,$5,'Other class A')", [extra.siblingSection, id.schoolA, id.classA, extra.section, extra.class]);
  await db.query("insert into public.subjects(id,school_id,name) values($1,$2,'Timetable mathematics')", [extra.subject, id.schoolA]);
  for (const [assignment, teacher, year, classId, section, subject] of [
    [extra.sameSectionAssignment, extra.teacherRecord, id.yearA, id.classA, id.sectionA, extra.subject],
    [extra.siblingAssignment, extra.teacherRecord, id.yearA, id.classA, extra.siblingSection, extra.subject],
    [extra.teacherOtherClass, id.teacherRecordA, id.yearA, extra.class, extra.section, id.subjectA],
    [extra.otherTeacherClass, extra.teacherRecord, id.yearA, extra.class, extra.section, extra.subject],
    [extra.wholeClassAssignment, id.teacherRecordA, id.yearA, id.classA, null, id.subjectA],
    [extra.assignmentB, extra.teacherRecordB, id.yearB, id.classB, id.sectionB, id.subjectB],
  ]) await db.query("insert into public.teacher_subject_assignments(id,teacher_id,academic_year_id,class_id,section_id,subject_id,is_class_teacher) values($1,$2,$3,$4,$5,$6,false)", [assignment, teacher, year, classId, section, subject]);
  // Explicit synthetic native sessions; the platform auth.jwt() contract stays unchanged.
  await db.exec("insert into auth.sessions(id,user_id) select id,id from auth.users on conflict(id) do nothing");
}, 60_000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

async function actor<Row extends Record<string, unknown> = Record<string, unknown>>(
  user: string | null, sql: string, params: unknown[] = [], role: "authenticated" | "anon" = "authenticated", connection = db,
) {
  await connection.exec("savepoint timetable_actor");
  try {
    await connection.exec(`set local role ${role}`);
    await connection.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [user ?? "", JSON.stringify({ sub: user, session_id: user })]);
    const result = await connection.query<Row>(sql, params);
    await connection.exec("reset role");
    await connection.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true)");
    await connection.exec("release savepoint timetable_actor");
    return result;
  } catch (error) {
    await connection.exec("rollback to savepoint timetable_actor; release savepoint timetable_actor");
    throw error;
  }
}
const saveArgs = (change: Partial<Save> = {}): Save => ({
  school: id.schoolA, period: null, version: null, assignment: id.assignmentA, section: id.sectionA,
  day: 1, periodNo: 1, start: "08:00", end: "09:00", room: "Room 6A", key: randomUUID(), ...change,
});
const save = async (change: Partial<Save> = {}, user = id.adminA) => {
  const p = saveArgs(change);
  return (await actor<{ id: string }>(user, "select public.save_timetable_period($1,$2,$3,$4,$5,$6,$7,$8::time,$9::time,$10,$11) as id", [
    p.school, p.period, p.version, p.assignment, p.section, p.day, p.periodNo, p.start, p.end, p.room, p.key,
  ])).rows[0].id;
};
const office = async (user = id.adminA, school = id.schoolA, year = id.yearA, classId = id.classA, section: string | null = null) =>
  (await actor<{ value: Week }>(user, "select public.get_office_timetable($1,$2,$3,$4) as value", [school, year, classId, section])).rows[0].value;
const teacher = async (user = id.teacherA) => (await actor<{ value: Week }>(user, "select public.get_teacher_timetable() as value")).rows[0].value;
const family = async (user = id.guardianA, student = id.pupilA) =>
  (await actor<{ value: Week }>(user, "select public.get_family_timetable($1) as value", [student])).rows[0].value;
const setup = async (user = id.adminA, school = id.schoolA) =>
  (await actor<{ value: Setup }>(user, "select public.get_timetable_setup($1) as value", [school])).rows[0].value;
const remove = async (period: Period, user = id.adminA, key: string | null = randomUUID(), school = period.school_id, version = period.version) =>
  (await actor<{ id: string }>(user, "select public.remove_timetable_period($1,$2,$3,$4) as id", [school, period.id, version, key])).rows[0].id;
const denied = (result: Promise<unknown>) => expect(result).rejects.toMatchObject({ code: "42501" });
const invalid = (result: Promise<unknown>) => expect(result).rejects.toMatchObject({ code: "22023" });
const conflict = (result: Promise<unknown>) => expect(result).rejects.toMatchObject({ code: "PT409" });

describe("timetable under the complete recovered schema", () => {
  it("saves a mapped period and returns the same fresh schedule to office, assigned teacher and exact child", async () => {
    const beforeAttendance = (await db.query("select to_jsonb(a) as row from public.attendance a order by id")).rows;
    const beforeFees = (await db.query("select to_jsonb(f) as row from public.student_fees f order by id")).rows;
    const beforeRoles = (await db.query("select to_jsonb(r) as row from public.user_roles r order by id")).rows;
    const periodId = await save();
    const saved = (await office()).rows[0];
    expect(saved).toMatchObject({ id: periodId, school_id: id.schoolA, academic_year_id: id.yearA,
      class_id: id.classA, section_id: id.sectionA, teacher_id: id.teacherRecordA, subject_id: id.subjectA,
      assignment_id: id.assignmentA, day_of_week: 1, period_no: 1, room: "Room 6A", needs_attention: false });
    expect(saved.start_time).toMatch(/^08:00/); expect(saved.end_time).toMatch(/^09:00/);
    expect(saved.version).toMatch(/^[\da-f-]{36}$/i);
    expect((await teacher()).rows).toEqual([saved]);
    expect((await family()).rows).toEqual([saved]);
    expect((await family(id.studentUserA)).rows).toEqual([saved]);
    expect((await office(extra.principal)).rows).toEqual([saved]);
    expect((await teacher(extra.teacherUser)).rows).toEqual([]);
    expect((await family(id.studentUserB, id.pupilB)).rows).toEqual([]);
    expect((await db.query("select to_jsonb(a) as row from public.attendance a order by id")).rows).toEqual(beforeAttendance);
    expect((await db.query("select to_jsonb(f) as row from public.student_fees f order by id")).rows).toEqual(beforeFees);
    expect((await db.query("select to_jsonb(r) as row from public.user_roles r order by id")).rows).toEqual(beforeRoles);
  });

  it("loads school-only active setup mappings and permits Principal/global office roles", async () => {
    for (const user of [id.adminA, extra.principal, extra.globalAdmin]) {
      const options = await setup(user);
      expect(options.years.some((year) => year.id === id.yearA && year.is_current)).toBe(true);
      expect(options.classes.some((row) => row.id === id.classA)).toBe(true);
      expect(options.classes.some((row) => row.id === id.classB)).toBe(false);
      expect(options.assignments.some((row) => row.id === id.assignmentA && row.teacher_id === id.teacherRecordA)).toBe(true);
      expect(options.assignments.some((row) => row.id === extra.assignmentB)).toBe(false);
    }
    const other = await save({ school: id.schoolB, assignment: extra.assignmentB, section: id.sectionB }, extra.globalAdmin);
    expect((await office(extra.globalAdmin, id.schoolB, id.yearB, id.classB)).rows[0].id).toBe(other);
    expect((await teacher(extra.teacherUserB)).rows[0].id).toBe(other);
  });

  it.each([null, "   "])("uses the employee ID for a valid teacher whose directory name is %j", async (name) => {
    await db.query("update public.teachers set full_name=$2 where id=$1", [id.teacherRecordA, name]);
    const assignment = (await setup()).assignments.find((row) => row.id === id.assignmentA);
    expect(assignment?.teacher_name).toBe("RECOVERY-TEACHER-A");
    const period = await save();
    expect((await office()).rows[0]).toMatchObject({ id: period, teacher_name: "RECOVERY-TEACHER-A", needs_attention: false });
    expect((await teacher()).rows[0]).toMatchObject({ id: period, teacher_name: "RECOVERY-TEACHER-A", needs_attention: false });
    expect((await family()).rows[0]).toMatchObject({ id: period, teacher_name: "RECOVERY-TEACHER-A", needs_attention: false });
  });

  it("requires an authorized school office actor for setup, reads and mutations", async () => {
    const period = await save(); const row = (await office()).rows[0];
    for (const user of [id.adminB, id.teacherA, id.guardianA, id.studentUserA, extra.finance, id.claimantA]) {
      await denied(setup(user)); await denied(office(user));
      await denied(save({ period, version: row.version }, user)); await denied(remove(row, user));
    }
    await denied(save({ school: id.schoolB }));
    await denied(remove(row, id.adminA, randomUUID(), id.schoolB));
    expect((await office()).rows).toEqual([row]);
  });

  it("does not allow an unrelated account to impersonate a teacher or an unauthenticated actor to read schedules", async () => {
    await save();
    for (const user of [id.adminA, id.guardianA, id.studentUserA, extra.finance, id.claimantA]) await denied(teacher(user));
    await denied(actor(null, "select public.get_teacher_timetable()"));
    await denied(actor(null, "select public.get_family_timetable($1)", [id.pupilA]));
    await denied(actor(null, "select public.get_timetable_setup($1)", [id.schoolA]));
  });

  it("rejects family role-only impersonation, forged cross-school links and unlinked child IDs", async () => {
    await save();
    for (const [user, student] of [[id.guardianA, id.unlinkedPupilA], [id.guardianA, id.pupilB], [id.studentUserA, id.unlinkedPupilA], [id.studentUserA, id.pupilB], [id.teacherA, id.pupilA], [id.adminA, id.pupilA], [id.guardianA, randomUUID()]]) {
      await denied(family(user, student));
    }
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'parent'),($1,$2,'student')", [id.teacherA, id.schoolA]);
    await denied(family(id.teacherA));
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [id.pupilB, id.parentA]);
    await denied(family(id.guardianA, id.pupilB));
  });

  it.each(["office", "teacher", "guardian", "student"])("rechecks active profile and role for %s access", async (kind) => {
    await save();
    const user = kind === "office" ? id.adminA : kind === "teacher" ? id.teacherA : kind === "guardian" ? id.guardianA : id.studentUserA;
    const read = () => kind === "office" ? office(user) : kind === "teacher" ? teacher(user) : family(user);
    await db.query("update public.profiles set is_active=false where id=$1", [user]);
    await denied(read());
    if (kind === "office") await denied(save());
    await db.query("update public.profiles set is_active=true where id=$1", [user]);
    await db.query("delete from public.user_roles where user_id=$1", [user]);
    await denied(read());
    if (kind === "office") await denied(save());
  });

  it.each(["email_confirmed_at=null,phone_confirmed_at=null", "banned_until=now()+interval '1 day'", "deleted_at=now()", "is_anonymous=true"])("denies unusable Auth identities: %s", async (change) => {
    await db.query(`update auth.users set ${change} where id=$1`, [id.adminA]);
    await denied(setup()); await denied(office()); await denied(save());
  });

  it.each([
    { day: 0 }, { day: 8 }, { day: null }, { periodNo: 0 }, { periodNo: -1 }, { periodNo: null },
    { start: null }, { end: null }, { start: "09:00", end: "09:00" }, { start: "10:00", end: "09:00" },
    { start: "23:00", end: "01:00" }, { start: "08:00:01", end: "09:00" },
    { start: "08:00", end: "09:00:01" }, { start: "23:00", end: "24:00" },
    { room: "x".repeat(121) }, { room: "Room\nA" }, { assignment: null }, { key: null },
  ] satisfies Partial<Save>[])("rejects invalid period fields at the RPC boundary: %j", async (change) => {
    await invalid(save(change)); expect((await office()).rows).toEqual([]);
  });

  it("accepts all ISO weekdays, positive period labels and adjacent half-open times", async () => {
    for (let day = 1; day <= 7; day += 1) await save({ day });
    await save({ day: 1, periodNo: 2, start: "09:00", end: "10:00" });
    await save({ day: 1, periodNo: 3, start: "07:00", end: "08:00" });
    expect((await office()).rows).toHaveLength(9);
  });

  it.each([
    ["07:30", "08:30"], ["08:15", "08:45"], ["08:30", "09:30"], ["07:00", "10:00"], ["08:00", "09:00"],
  ])("rejects teacher overlap across classes for %s–%s", async (start, end) => {
    await save();
    await conflict(save({ assignment: extra.teacherOtherClass, section: extra.section, start, end, periodNo: 2 }));
    expect((await office()).rows).toHaveLength(1);
    expect((await office(id.adminA, id.schoolA, id.yearA, extra.class)).rows).toEqual([]);
  });

  it("rejects class-section collisions even with different teachers", async () => {
    await save();
    await conflict(save({ assignment: extra.sameSectionAssignment, periodNo: 2, start: "08:30", end: "09:30" }));
    expect((await office()).rows).toHaveLength(1);
  });

  it("permits different sections in parallel when teachers differ", async () => {
    const a = await save();
    const b = await save({ assignment: extra.siblingAssignment, section: extra.siblingSection });
    expect((await office()).rows.map((row) => row.id).sort()).toEqual([a, b].sort());
    expect((await office(id.adminA, id.schoolA, id.yearA, id.classA, id.sectionA)).rows.map((row) => row.id)).toEqual([a]);
    expect((await office(id.adminA, id.schoolA, id.yearA, id.classA, extra.siblingSection)).rows.map((row) => row.id)).toEqual([b]);
    expect((await family()).rows.map((row) => row.id)).toEqual([a]);
  });

  it("treats a classwide slot as occupying every section in both insertion orders", async () => {
    const wideId = await save({ assignment: extra.wholeClassAssignment, section: null });
    const wide = (await office()).rows[0];
    expect(wide.section_id).toBeNull();
    expect((await family()).rows[0].id).toBe(wideId);
    expect((await office(id.adminA, id.schoolA, id.yearA, id.classA, extra.siblingSection)).rows[0].id).toBe(wideId);
    await conflict(save({ assignment: extra.siblingAssignment, section: extra.siblingSection, periodNo: 2 }));
    await remove(wide);
    await save({ assignment: extra.siblingAssignment, section: extra.siblingSection, periodNo: 2 });
    await conflict(save({ assignment: extra.wholeClassAssignment, section: null, periodNo: 3 }));
  });

  it("blocks duplicate class/day/period identity even if the times no longer overlap", async () => {
    await save();
    await conflict(save({ assignment: extra.sameSectionAssignment, start: "10:00", end: "11:00" }));
    await conflict(save({ assignment: extra.wholeClassAssignment, section: null, start: "10:00", end: "11:00" }));
    await save({ assignment: extra.siblingAssignment, section: extra.siblingSection, start: "10:00", end: "11:00" });
    expect((await office()).rows).toHaveLength(2);
  });

  it("enforces teacher, section timing and period-identity conflicts for trusted raw SQL writers too", async () => {
    await save();
    const conflicts = [
      [extra.class, extra.section, id.subjectA, id.teacherRecordA, extra.teacherOtherClass, 2, "08:30", "09:30"],
      [id.classA, id.sectionA, extra.subject, extra.teacherRecord, extra.sameSectionAssignment, 2, "08:30", "09:30"],
      [id.classA, id.sectionA, extra.subject, extra.teacherRecord, extra.sameSectionAssignment, 1, "10:00", "11:00"],
    ];
    for (const values of conflicts) {
      await db.exec("savepoint trusted_timetable_writer");
      await expect(db.query(`insert into public.timetables(school_id,academic_year_id,class_id,section_id,
        subject_id,teacher_id,assignment_id,day_of_week,period_no,start_time,end_time)
        values($1,$2,$3,$4,$5,$6,$7,1,$8,$9::time,$10::time)`, [id.schoolA, id.yearA, ...values]))
        .rejects.toMatchObject({ code: "23P01" });
      await db.exec("rollback to savepoint trusted_timetable_writer; release savepoint trusted_timetable_writer");
    }
    expect((await office()).rows).toHaveLength(1);
    const exclusions = (await db.query<{ name: string }>(`select conname as name from pg_constraint
      where conrelid='public.timetables'::regclass and contype='x'`)).rows;
    expect(exclusions.length).toBeGreaterThanOrEqual(3);
  });

  it("requires exact subject assignment scope and never promotes a section assignment to whole-class", async () => {
    await denied(save({ assignment: extra.assignmentB }));
    await denied(save({ section: id.sectionB }));
    await denied(save({ section: extra.section }));
    await denied(save({ section: extra.siblingSection }));
    await denied(save({ section: null }));
    await denied(save({ assignment: randomUUID() }));
    const scoped = await save({ assignment: extra.wholeClassAssignment, section: extra.siblingSection });
    expect((await office()).rows[0]).toMatchObject({ id: scoped, section_id: extra.siblingSection, assignment_id: extra.wholeClassAssignment });
  });

  it.each(["teacher", "role", "class", "subject", "assignment"])("omits and refuses an unusable %s mapping", async (kind) => {
    const changes: Record<string, string> = {
      teacher: "update public.profiles set is_active=false where id=$1",
      role: "delete from public.user_roles where user_id=$1 and role='teacher'",
      class: "update public.classes set is_active=false where id=$1",
      subject: "update public.subjects set is_active=false where id=$1",
      assignment: "delete from public.teacher_subject_assignments where id=$1",
    };
    const target = kind === "teacher" || kind === "role" ? id.teacherA : kind === "class" ? id.classA : kind === "subject" ? id.subjectA : id.assignmentA;
    await db.query(changes[kind], [target]);
    expect((await setup()).assignments.some((row) => row.id === id.assignmentA)).toBe(false);
    await denied(save());
  });

  it("removes reader visibility immediately after assignment revocation without granting timetable-derived authority", async () => {
    await save();
    await db.query("delete from public.teacher_subject_assignments where id=$1", [id.assignmentA]);
    expect((await teacher()).rows).toEqual([]);
    expect((await family()).rows).toEqual([]);
    expect((await office()).rows[0]).toMatchObject({ needs_attention: true, assignment_id: id.assignmentA });
    expect((await db.query<{ count: number }>("select count(*)::int as count from public.teacher_subject_assignments where id=$1", [id.assignmentA])).rows[0].count).toBe(0);
  });

  it("atomically updates a period and rejects stale edit/removal without overwriting fresh values", async () => {
    const period = await save(); const old = (await office()).rows[0];
    const edited = await save({ period, version: old.version, start: "09:00", end: "10:00", room: "Changed room" }, extra.principal);
    expect(edited).toBe(period);
    const fresh = (await office()).rows[0];
    expect(fresh.version).not.toBe(old.version); expect(fresh.room).toBe("Changed room");
    await conflict(save({ period, version: old.version, room: "Stale office edit" }));
    await conflict(remove(old));
    expect((await office()).rows[0]).toEqual(fresh);
    expect((await teacher()).rows[0]).toEqual(fresh);
    expect((await family()).rows[0]).toEqual(fresh);
  });

  it("rotates versions for trusted no-op and change-then-restore writes so stale drafts cannot silently rebase", async () => {
    const period = await save(); const original = (await office()).rows[0];
    await db.query("update public.timetables set room=room where id=$1", [period]);
    const noop = (await office()).rows[0];
    expect(noop.version).not.toBe(original.version);
    await conflict(save({ period, version: original.version }));
    await db.query("update public.timetables set room='Temporary backend value' where id=$1", [period]);
    const changed = (await office()).rows[0];
    await db.query("update public.timetables set room=$2 where id=$1", [period, original.room]);
    const restored = (await office()).rows[0];
    expect(restored.room).toBe(original.room);
    expect(new Set([original.version, noop.version, changed.version, restored.version]).size).toBe(4);
    await conflict(remove(original));
  });

  it("checks collisions on editing, including moving a slot into a different teacher/class scope", async () => {
    await save();
    const b = await save({ assignment: extra.otherTeacherClass, section: extra.section, start: "10:00", end: "11:00", periodNo: 2 });
    const old = (await office(id.adminA, id.schoolA, id.yearA, extra.class)).rows[0];
    await conflict(save({ period: b, version: old.version, assignment: extra.teacherOtherClass, section: extra.section, start: "08:30", end: "09:30", periodNo: 2 }));
    expect((await office(id.adminA, id.schoolA, id.yearA, extra.class)).rows[0]).toEqual(old);
  });

  it("binds a save retry to actor and exact payload and does not repeat the mutation", async () => {
    const key = randomUUID(); const p = saveArgs({ key, room: "  Normalized room  " });
    const period = await save(p); const saved = (await office()).rows[0];
    expect(await save({ ...p, room: "Normalized room" })).toBe(period);
    expect((await office()).rows).toEqual([saved]);
    await conflict(save({ ...p, room: "Changed retry payload" }));
    await conflict(save({ ...p, assignment: extra.teacherOtherClass, section: extra.section }));
    const otherActor = await save({ ...p, day: 2 }, extra.principal);
    expect(otherActor).not.toBe(period);
    const edit = saveArgs({ period, version: saved.version, start: "09:00", end: "10:00", key: randomUUID() });
    await save(edit); const fresh = (await office()).rows.find((row) => row.id === period);
    expect(await save(edit)).toBe(period);
    expect((await office()).rows.find((row) => row.id === period)).toEqual(fresh);
    expect(await save({ ...p, room: "Normalized room" })).toBe(period);
  });

  it("soft-removes a slot once, preserves its evidence and frees its time/period identity", async () => {
    const period = await save(); const saved = (await office()).rows[0]; const key = randomUUID();
    expect(await remove(saved, id.adminA, key)).toBe(period);
    expect(await remove(saved, id.adminA, key)).toBe(period);
    expect((await office()).rows).toEqual([]); expect((await teacher()).rows).toEqual([]); expect((await family()).rows).toEqual([]);
    const tombstone = (await db.query<{ deleted_at: string; version: string }>("select deleted_at::text,version from public.timetables where id=$1", [period])).rows[0];
    expect(tombstone.deleted_at).toBeTruthy(); expect(tombstone.version).not.toBe(saved.version);
    await conflict(remove(saved, extra.principal));
    await conflict(save({ period, version: saved.version }));
    const replacement = await save(); expect(replacement).not.toBe(period);
    await conflict(remove((await office()).rows[0], id.adminA, key));
  });

  it("keeps private immutable before/after receipts for create, edit and removal retries", async () => {
    const createKey = randomUUID(); const period = await save({ key: createKey });
    const first = (await office()).rows[0]; const editKey = randomUUID();
    await save({ period, version: first.version, start: "09:00", end: "10:00", key: editKey });
    const edited = (await office()).rows[0]; const removeKey = randomUUID();
    await remove(edited, id.adminA, removeKey);
    const receiptRows = (await db.query<{ value: Record<string, unknown> }>(
      "select to_jsonb(r) as value from app_private.timetable_write_receipts r where period_id=$1 order by created_at,request_id", [period])).rows;
    expect(receiptRows).toHaveLength(3);
    const byKey = new Map(receiptRows.map((row) => [row.value.request_id, row.value]));
    expect(byKey.get(createKey)).toMatchObject({ actor_id: id.adminA, period_id: period, before_record: null,
      after_record: { id: period, version: first.version, deleted_at: null } });
    expect(byKey.get(editKey)).toMatchObject({ actor_id: id.adminA, period_id: period,
      before_record: { version: first.version }, after_record: { version: edited.version } });
    expect(byKey.get(removeKey)).toMatchObject({ actor_id: id.adminA, period_id: period,
      before_record: { version: edited.version } });
    const deletion = byKey.get(removeKey)?.after_record as { deleted_at: unknown };
    expect(deletion.deleted_at).toBeTruthy();
    expect(await remove(edited, id.adminA, removeKey)).toBe(period);
    expect((await db.query<{ value: Record<string, unknown> }>(
      "select to_jsonb(r) as value from app_private.timetable_write_receipts r where period_id=$1 order by created_at,request_id", [period])).rows).toEqual(receiptRows);
    await denied(actor(id.adminA, "select * from app_private.timetable_write_receipts"));
    await denied(actor(id.adminA, "update app_private.timetable_write_receipts set payload='{}'::jsonb"));
  });

  it("does not allow mixed create/update references, missing retry keys or unknown periods", async () => {
    await invalid(save({ period: randomUUID(), version: null }));
    await invalid(save({ version: randomUUID() }));
    const period = await save(); const row = (await office()).rows[0];
    await invalid(remove(row, id.adminA, null));
    await expect(save({ period: randomUUID(), version: randomUUID() })).rejects.toThrow();
    await expect(remove({ ...row, id: randomUUID() })).rejects.toThrow();
    expect((await office()).rows[0].id).toBe(period);
  });

  it("revokes only one guardian-child view and keeps sibling and student access", async () => {
    await save();
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [id.unlinkedPupilA, id.parentA]);
    await db.query("delete from public.student_parents where student_id=$1 and parent_id=$2", [id.pupilA, id.parentA]);
    await denied(family());
    expect((await family(id.guardianA, id.unlinkedPupilA)).rows).toHaveLength(1);
    expect((await family(id.studentUserA)).rows).toHaveLength(1);
    expect((await office()).rows).toHaveLength(1);
  });

  it.each(["withdrawn", "staged", "cancelled"])("does not expose a %s enrollment as the child's current schedule", async (status) => {
    await save();
    await db.query("update public.enrollments set status=$2 where student_id=$1", [id.pupilA, status]);
    const view = await family(); expect(view.rows).toEqual([]); expect(view.academic_year_id).toBeNull();
    expect(view.class_id).toBeNull();
  });

  it("hides withdrawn pupils and exposes no scope for incoherent cross-school enrollment mappings", async () => {
    await save();
    await db.query("update public.students set status='withdrawn' where id=$1", [id.pupilA]);
    expect((await family()).rows).toEqual([]);
    await db.query("update public.students set status='active' where id=$1", [id.pupilA]);
    await db.query("update public.enrollments set class_id=$2,section_id=$3 where student_id=$1", [id.pupilA, id.classB, id.sectionB]);
    expect(await family()).toMatchObject({ academic_year_id: null, class_id: null, section_id: null, rows: [] });
  });

  it("returns empty current context when a school has no active year and never opens a future staged schedule", async () => {
    await save();
    const future = randomUUID();
    await db.query("insert into public.academic_years(id,school_id,name,start_date,end_date,is_current) values($1,$2,'Future timetable year','2027-04-01','2028-03-31',false)", [future, id.schoolA]);
    const assignment = randomUUID();
    await db.query("insert into public.teacher_subject_assignments(id,teacher_id,academic_year_id,class_id,section_id,subject_id) values($1,$2,$3,$4,$5,$6)", [assignment, id.teacherRecordA, future, id.classA, id.sectionA, id.subjectA]);
    await save({ assignment });
    expect((await office(id.adminA, id.schoolA, future)).rows).toHaveLength(1);
    expect((await family()).rows).toHaveLength(1);
    expect((await teacher()).rows).toHaveLength(1);
    await db.query("update public.academic_years set is_current=false where id=$1", [id.yearA]);
    expect((await family()).rows).toEqual([]);
    expect((await teacher()).rows).toEqual([]);
    expect((await teacher()).academic_year_id).toBeNull();
  });

  it("keeps the RPC boundary authenticated and removes direct browser mutation privileges", async () => {
    const permissions = (await db.query(`select
      has_table_privilege('authenticated','public.timetables','INSERT') as insert_allowed,
      has_table_privilege('authenticated','public.timetables','UPDATE') as update_allowed,
      has_table_privilege('authenticated','public.timetables','DELETE') as delete_allowed,
      has_table_privilege('anon','public.timetables','INSERT') as anon_insert,
      has_table_privilege('authenticated','public.timetables','SELECT') as select_allowed`)).rows;
    expect(permissions).toEqual([{ insert_allowed: false, update_allowed: false, delete_allowed: false, anon_insert: false, select_allowed: false }]);
    await denied(actor(id.adminA, "select * from public.timetables"));
    await denied(actor(id.guardianA, "select * from public.timetables"));
    await denied(actor(id.adminA, "insert into public.timetables(school_id,academic_year_id,class_id,day_of_week,period_no) values($1,$2,$3,1,1)", [id.schoolA, id.yearA, id.classA]));
    await denied(actor(id.adminA, "update public.timetables set period_no=99"));
    await denied(actor(id.adminA, "delete from public.timetables"));
    for (const [sql, params] of [
      ["select public.get_timetable_setup($1)", [id.schoolA]],
      ["select public.get_office_timetable($1,$2,$3,null)", [id.schoolA, id.yearA, id.classA]],
      ["select public.get_teacher_timetable()", []], ["select public.get_family_timetable($1)", [id.pupilA]],
      ["select public.save_timetable_period($1,null,null,$2,$3,1,1,'08:00','09:00',null,$4)", [id.schoolA, id.assignmentA, id.sectionA, randomUUID()]],
      ["select public.remove_timetable_period($1,$2,$3,$4)", [id.schoolA, randomUUID(), randomUUID(), randomUUID()]],
    ] as [string, unknown[]][]) await denied(actor(null, sql, params, "anon"));
    const definers = (await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('get_timetable_setup','get_office_timetable','get_teacher_timetable','get_family_timetable','save_timetable_period','remove_timetable_period') and p.prosecdef`)).rows;
    expect(definers).toEqual([]);
  });

  it("retains malformed legacy periods for office repair without inventing times or exposing them to families", async () => {
    const legacy = await createRecoveryDatabase({ applyPending: false });
    try {
      await seedRecoveryData(legacy);
      const period = randomUUID();
      await legacy.query("insert into public.timetables(id,school_id,academic_year_id,class_id,section_id,teacher_id,subject_id,day_of_week,period_no) values($1,$2,$3,$4,$5,$6,$7,1,1)", [period, id.schoolA, id.yearA, id.classA, id.sectionA, id.teacherRecordA, id.subjectA]);
      for (const step of (await readRecoverySources(await readRecoveryManifest())).filter((step) => step.kind === "pending")) await legacy.exec(step.sql);
      await legacy.exec("begin");
      const view = (await actor<{ value: Week }>(id.adminA, "select public.get_office_timetable($1,$2,$3,null) as value", [id.schoolA, id.yearA, id.classA], "authenticated", legacy)).rows[0].value;
      expect(view.rows).toHaveLength(1);
      expect(view.rows[0]).toMatchObject({ id: period, needs_attention: true, start_time: null, end_time: null });
      const child = (await actor<{ value: Week }>(id.guardianA, "select public.get_family_timetable($1) as value", [id.pupilA], "authenticated", legacy)).rows[0].value;
      expect(child.rows).toEqual([]);
      const own = (await actor<{ value: Week }>(id.teacherA, "select public.get_teacher_timetable() as value", [], "authenticated", legacy)).rows[0].value;
      expect(own.rows).toEqual([]);
      await expect(actor(id.adminA,
        "select public.save_timetable_period($1,null,null,$2,$3,1,2,'10:00','11:00',null,$4)",
        [id.schoolA, id.assignmentA, id.sectionA, randomUUID()], "authenticated", legacy)).rejects.toMatchObject({ code: "PT409" });
      const repaired = (await actor<{ id: string }>(id.adminA,
        "select public.save_timetable_period($1,$2,$3,$4,$5,1,1,'08:00','09:00',null,$6) as id",
        [id.schoolA, period, view.rows[0].version, id.assignmentA, id.sectionA, randomUUID()], "authenticated", legacy)).rows[0].id;
      expect(repaired).toBe(period);
      const after = (await actor<{ value: Week }>(id.guardianA, "select public.get_family_timetable($1) as value", [id.pupilA], "authenticated", legacy)).rows[0].value;
      expect(after.rows[0]).toMatchObject({ id: period, needs_attention: false });
      await legacy.exec("rollback");
    } finally { await legacy.close(); }
  }, 30_000);

  it("does not resolve foreign-school names through a forged legacy timetable row", async () => {
    const period = randomUUID();
    await db.query("update public.teachers set full_name='PRIVATE foreign teacher' where id=$1", [extra.teacherRecordB]);
    await db.query("update public.subjects set name='PRIVATE foreign subject' where id=$1", [id.subjectB]);
    await db.query("update public.sections set name='PRIVATE foreign section' where id=$1", [id.sectionB]);
    await db.exec("alter table public.timetables disable trigger guard_timetable_period");
    try {
      await db.query(`insert into public.timetables(id,school_id,academic_year_id,class_id,section_id,
        teacher_id,subject_id,day_of_week,period_no) values($1,$2,$3,$4,$5,$6,$7,7,77)`, [
        period, id.schoolA, id.yearA, id.classA, id.sectionB, extra.teacherRecordB, id.subjectB,
      ]);
    } finally { await db.exec("alter table public.timetables enable trigger guard_timetable_period"); }
    const view = await office();
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ id: period, school_id: id.schoolA, class_id: id.classA,
      needs_attention: true, teacher_name: null, subject_name: null, section_name: null });
    expect(JSON.stringify(view)).not.toContain("PRIVATE foreign");
    expect((await family()).rows).toEqual([]);
    expect((await teacher()).rows).toEqual([]);
    expect((await teacher(extra.teacherUserB)).rows).toEqual([]);
  });
});
