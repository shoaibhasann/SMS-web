// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";
import { createSyntheticSnapshot, restoreSyntheticSnapshot } from "../../scripts/database-recovery/drill.mjs";

const uuid = (suffix: number) => `75000000-0000-0000-0000-${String(suffix).padStart(12, "0")}`;
const principal = uuid(1), finance = uuid(2), globalAdmin = uuid(3), otherTeacher = uuid(4), teacherB = uuid(5);
const otherTeacherRecord = uuid(10), otherAssignment = uuid(11), teacherRecordB = uuid(12), assignmentB = uuid(13);
const assessmentB = uuid(14), secondMark = uuid(15);
let db: PGlite;

type Metadata = {
  assessment_id: string; school_id: string; school_name: string; academic_year_id: string;
  academic_year_name: string; class_id: string; class_name: string; section_id: string | null;
  section_name: string | null; subject_id: string; subject_name: string; teacher_id: string;
  teacher_name: string; name: string; assessment_date: string; maximum_marks: number;
  assessment_updated_at: string; status: string;
};
type Pupil = {
  student_id: string; student_name: string; admission_no: string; roll_no: string | null;
  enrollment_id: string; mark_id: string | null; marks_obtained: number | null; remarks: string | null;
  mark_updated_at: string | null; mark_updated_by: string | null;
};
type Preview = { source_token: string; can_submit: boolean; issues: string[]; metadata: Metadata; pupils: Pupil[] };
type Submission = {
  id: string; assessment_id: string; school_id: string; status: string; source_token: string;
  requested_by: string; requester_name: string; requested_at: string; reviewed_by: string | null;
  reviewer_name: string | null; review_note: string | null; reviewed_at: string | null;
  revision: number | null; snapshot: { metadata: Metadata; pupils: Pupil[] }; source_matches: boolean | null;
};
type Summary = Pick<Submission, "id" | "assessment_id" | "school_id" | "status" | "requested_at" | "requester_name" | "reviewed_at" | "revision"> & { metadata: Metadata };
type FamilyResult = {
  id: string; assessment_id: string; revision: number; published_at: string; publisher_name: string;
  metadata: Metadata; student_id: string; student_name: string; admission_no: string; roll_no: string | null;
  marks_obtained: number; maximum_marks: number; percentage: number; remarks: string | null;
};
type Page<T> = { rows: T[]; total_count: number | string; offset: number };
type FamilyPage = Page<FamilyResult> & { student_id: string; school_id: string };

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  for (const [user, school, role] of [
    [principal, id.schoolA, "principal"], [finance, id.schoolA, "accountant"],
    [globalAdmin, null, "super_admin"], [otherTeacher, id.schoolA, "teacher"], [teacherB, id.schoolB, "teacher"],
  ]) {
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [user, `${user}@result.invalid`]);
    await db.query("update public.profiles set school_id=$2,full_name=$3 where id=$1", [user, school, `Publication ${role}`]);
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,$3)", [user, school, role]);
  }
  for (const [teacherRecord, user, school, assignment, year, klass, section, subject] of [
    [otherTeacherRecord, otherTeacher, id.schoolA, otherAssignment, id.yearA, id.classA, id.sectionA, id.subjectA],
    [teacherRecordB, teacherB, id.schoolB, assignmentB, id.yearB, id.classB, id.sectionB, id.subjectB],
  ]) {
    await db.query("insert into public.teachers(id,school_id,profile_id,employee_id,full_name) values($1,$2,$3,$4,$5)", [teacherRecord, school, user, `PUBLICATION-${teacherRecord}`, "Publication teacher"]);
    await db.query(`insert into public.teacher_subject_assignments(id,teacher_id,academic_year_id,class_id,section_id,subject_id)
      values($1,$2,$3,$4,$5,$6)`, [assignment, teacherRecord, year, klass, section, subject]);
  }
  await db.query("update public.students set first_name='Private peer' where id=$1", [id.unlinkedPupilA]);
  await db.query("update public.teacher_assessments set status='completed' where id=$1", [id.assessmentA]);
  await db.query(`insert into public.teacher_assessments(id,school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,name,assessment_date,maximum_marks,status)
    values($1,$2,$3,$4,$5,$6,$7,'Foreign school result','2026-11-05',100,'completed')`, [assessmentB, id.schoolB, id.yearB, id.classB, id.sectionB, id.subjectB, teacherRecordB]);
  // Explicit synthetic native sessions; the platform auth.jwt() contract stays unchanged.
  await db.exec("insert into auth.sessions(id,user_id) select id,id from auth.users on conflict(id) do nothing");
  await db.exec("begin");
  try {
    await actor(id.teacherA, "update public.teacher_assessment_marks set remarks='Careful work' where id=$1", [id.markA]);
    await actor(id.teacherA, "insert into public.teacher_assessment_marks(id,assessment_id,student_id,marks_obtained,remarks) values($1,$2,$3,88,'Peer private note')", [secondMark, id.assessmentA, id.unlinkedPupilA]);
    await actor(teacherB, "insert into public.teacher_assessment_marks(assessment_id,student_id,marks_obtained) values($1,$2,63)", [assessmentB, id.pupilB]);
    await db.exec("commit");
  } catch (error) { await db.exec("rollback"); throw error; }
}, 60_000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

async function actor<Row extends Record<string, unknown> = Record<string, unknown>>(
  user: string | null, sql: string, params: unknown[] = [], role: "authenticated" | "anon" = "authenticated", connection = db,
) {
  await connection.exec("savepoint publication_actor");
  try {
    await connection.exec(`set local role ${role}`);
    await connection.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [user ?? "", JSON.stringify({ sub: user, session_id: user })]);
    const result = await connection.query<Row>(sql, params);
    await connection.exec("reset role");
    await connection.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true)");
    await connection.exec("release savepoint publication_actor");
    return result;
  } catch (error) { await connection.exec("rollback to savepoint publication_actor; release savepoint publication_actor"); throw error; }
}
const value = async <T>(user: string | null, sql: string, params: unknown[] = [], role: "authenticated" | "anon" = "authenticated", connection = db) =>
  (await actor<{ value: T }>(user, sql, params, role, connection)).rows[0].value;
const preview = (user = id.teacherA, assessment = id.assessmentA) => value<Preview>(user, "select public.preview_assessment_publication($1) as value", [assessment]);
const request = async (user = id.teacherA, assessment = id.assessmentA, token?: string, requestId = randomUUID()) =>
  value<string>(user, "select public.request_assessment_publication($1,$2,$3) as value", [assessment, token ?? (await preview(user, assessment)).source_token, requestId]);
const detail = (submission: string, user = id.teacherA) => value<Submission>(user, "select public.get_assessment_result_submission($1) as value", [submission]);
const queue = (user = id.adminA, school: string | null = id.schoolA, status: string | null = null, offset = 0) =>
  value<Page<Summary>>(user, "select public.list_assessment_result_submissions($1,$2,$3) as value", [school, status, offset]);
const family = (user = id.guardianA, student = id.pupilA, offset = 0) => value<FamilyPage>(user, "select public.get_family_assessment_results($1,$2) as value", [student, offset]);
const review = (submission: string, user = id.adminA, decision = "published", reason = "Reviewed complete assessment results") =>
  value<string>(user, "select public.review_assessment_publication($1,$2,$3) as value", [submission, decision, reason]);
const cancel = (submission: string, user = id.teacherA, reason = "Please revise the source marks") =>
  value<string>(user, "select public.cancel_assessment_result_submission($1,$2) as value", [submission, reason]);
const denied = (operation: Promise<unknown>) => expect(operation).rejects.toMatchObject({ code: "42501" });
const invalid = (operation: Promise<unknown>) => expect(operation).rejects.toMatchObject({ code: "22023" });
const conflict = (operation: Promise<unknown>) => expect(operation).rejects.toMatchObject({ code: "PT409" });
const canonical = async (table: string) => (await db.query(`select to_jsonb(r) as value from ${table} r order by id`)).rows;

async function saveMark(student = id.pupilA, score = 75, user = id.teacherA, remarks: string | null = "Reviewed score") {
  const mark = (await db.query<{ id: string; updated_at: string; marks_obtained: string; remarks: string | null }>(
    "select id,updated_at::text,marks_obtained::text,remarks from public.teacher_assessment_marks where assessment_id=$1 and student_id=$2", [id.assessmentA, student])).rows[0];
  const parent = (await db.query<{ updated_at: string }>("select updated_at::text from public.teacher_assessments where id=$1", [id.assessmentA])).rows[0];
  return value(user, "select public.save_assessment_mark($1,$2,$3,$4,$5,$6,$7,$8,$9) as value", [
    id.assessmentA, parent.updated_at, student, mark?.id ?? null, mark?.updated_at ?? null,
    mark?.marks_obtained ?? null, mark?.remarks ?? null, score, remarks,
  ]);
}

async function published() { const submission = await request(); await review(submission); return submission; }

describe("independently published assessment results under the complete recovered schema", () => {
  it("captures completed source, publishes independently and returns persistent own-pupil results only", async () => {
    const attendance = await canonical("public.attendance"), fees = await canonical("public.student_fees"), receipts = await canonical("public.fee_payments");
    const sourceMarks = await canonical("public.teacher_assessment_marks"), sourceAssessment = await canonical("public.teacher_assessments");
    const source = await preview();
    expect(source).toMatchObject({ can_submit: true, issues: [], metadata: { assessment_id: id.assessmentA, maximum_marks: 100, status: "completed" } });
    expect(source.source_token).toMatch(/^[0-9a-f]{64}$/);
    expect(source.pupils).toHaveLength(2);
    const submission = await request(id.teacherA, id.assessmentA, source.source_token);
    expect((await detail(submission))).toMatchObject({ id: submission, status: "pending", requested_by: id.teacherA, source_matches: true, revision: null });
    expect((await queue()).rows).toEqual([expect.objectContaining({ id: submission, status: "pending" })]);
    expect((await family()).rows).toEqual([]);
    expect(await review(submission, principal)).toBe(submission);
    const first = await family();
    expect(first).toMatchObject({ student_id: id.pupilA, school_id: id.schoolA, total_count: 1, offset: 0 });
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]).toMatchObject({ id: submission, student_id: id.pupilA, marks_obtained: 74, maximum_marks: 100, percentage: 74, revision: 1, remarks: "Careful work" });
    expect((await family(id.studentUserA)).rows).toEqual(first.rows);
    expect((await queue(id.adminA, id.schoolA, "pending")).rows).toEqual([]);
    expect((await detail(submission, principal))).toMatchObject({ status: "published", reviewed_by: principal, revision: 1 });
    expect(await canonical("public.attendance")).toEqual(attendance);
    expect(await canonical("public.student_fees")).toEqual(fees);
    expect(await canonical("public.fee_payments")).toEqual(receipts);
    expect(await canonical("public.teacher_assessment_marks")).toEqual(sourceMarks);
    expect(await canonical("public.teacher_assessments")).toEqual(sourceAssessment);
  });

  it("never includes a class peer, draft/source identifiers, private review notes or ranks in a family payload", async () => {
    const submission = await request();
    await review(submission, id.adminA, "published", "Private office review concerning peer REC-A-002");
    const serialized = JSON.stringify(await family());
    for (const privateValue of [id.unlinkedPupilA, "REC-A-002", "Private peer", "Peer private note", secondMark, "Private office review"]) expect(serialized).not.toContain(privateValue);
    const row = (await family()).rows[0] as unknown as Record<string, unknown>;
    for (const key of ["pupils", "snapshot", "source_token", "mark_id", "mark_updated_by", "review_note", "rank", "class_rank"]) expect(row).not.toHaveProperty(key);
    expect(row).toMatchObject({ student_id: id.pupilA, metadata: { class_name: "Recovery class 6", subject_name: "Recovery science" } });
  });

  it("keeps direct family raw-assessment and raw-mark reads closed before and after publication", async () => {
    for (const user of [id.guardianA, id.studentUserA]) {
      expect((await actor(user, "select id from public.teacher_assessments")).rows).toEqual([]);
      expect((await actor(user, "select id from public.teacher_assessment_marks")).rows).toEqual([]);
    }
    await published();
    for (const user of [id.guardianA, id.studentUserA]) {
      expect((await actor(user, "select id from public.teacher_assessments")).rows).toEqual([]);
      expect((await actor(user, "select id from public.teacher_assessment_marks")).rows).toEqual([]);
    }
  });

  it("limits candidate source and preview to the current assigned owner teacher", async () => {
    const candidates = await value<Metadata[]>(id.teacherA, "select public.list_assessment_publication_candidates() as value");
    expect(candidates.map((row) => row.assessment_id)).toContain(id.assessmentA);
    expect(candidates.map((row) => row.assessment_id)).not.toContain(assessmentB);
    for (const user of [id.adminA, principal, finance, id.guardianA, id.studentUserA, otherTeacher, teacherB, id.claimantA]) {
      await denied(preview(user));
      await denied(request(user, id.assessmentA, (await preview()).source_token));
    }
    await denied(preview(id.teacherA, assessmentB));
    await denied(preview(id.teacherA, randomUUID()));
  });

  it("denies foreign-school or unrelated request details and office queues", async () => {
    const submission = await request();
    for (const user of [id.adminB, finance, id.guardianA, id.studentUserA, otherTeacher, teacherB, id.claimantA]) {
      await denied(detail(submission, user));
      await denied(queue(user));
      await denied(review(submission, user));
    }
    await denied(detail(randomUUID()));
    await denied(queue(id.adminA, id.schoolB));
    expect((await queue(id.teacherA, null)).rows[0].id).toBe(submission);
    expect((await queue(id.teacherA, null)).rows.every((row) => row.assessment_id === id.assessmentA)).toBe(true);
  });

  it("allows a current global Super Admin to review both schools without granting Principal raw marks", async () => {
    const submission = await request();
    await review(submission, globalAdmin);
    const other = await request(teacherB, assessmentB);
    expect((await queue(globalAdmin, id.schoolB)).rows[0].id).toBe(other);
    await review(other, globalAdmin);
    expect((await family(id.studentUserB, id.pupilB)).rows[0].marks_obtained).toBe(63);
    expect((await actor(principal, "select id from public.teacher_assessment_marks")).rows).toEqual([]);
  });

  it("rejects role-only or forged cross-school family ownership", async () => {
    await published();
    for (const [user, student] of [
      [id.guardianA, id.unlinkedPupilA], [id.guardianA, id.pupilB], [id.studentUserA, id.unlinkedPupilA],
      [id.studentUserA, id.pupilB], [id.teacherA, id.pupilA], [id.adminA, id.pupilA], [finance, id.pupilA],
      [id.guardianA, randomUUID()],
    ]) await denied(family(user, student));
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'parent'),($1,$2,'student')", [otherTeacher, id.schoolA]);
    await denied(family(otherTeacher));
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [id.pupilB, id.parentA]);
    await denied(family(id.guardianA, id.pupilB));
  });

  it("removes revoked guardian reads immediately while preserving a sibling and independent student access", async () => {
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [id.unlinkedPupilA, id.parentA]);
    await published();
    expect((await family(id.guardianA, id.unlinkedPupilA)).rows[0].marks_obtained).toBe(88);
    await db.query("delete from public.student_parents where parent_id=$1 and student_id=$2", [id.parentA, id.pupilA]);
    await denied(family());
    expect((await family(id.guardianA, id.unlinkedPupilA)).rows).toHaveLength(1);
    expect((await family(id.studentUserA)).rows).toHaveLength(1);
    expect((await queue()).rows[0].status).toBe("published");
  });

  it.each(["teacher", "reviewer", "guardian", "student"])("requires an active profile and present school role for %s", async (kind) => {
    const submission = await request();
    const user = kind === "teacher" ? id.teacherA : kind === "reviewer" ? id.adminA : kind === "guardian" ? id.guardianA : id.studentUserA;
    const role = kind === "reviewer" ? "school_admin" : kind === "guardian" ? "parent" : kind;
    const call = () => kind === "teacher" ? detail(submission, user) : kind === "reviewer" ? detail(submission, user) : family(user);
    await db.query("update public.profiles set is_active=false where id=$1", [user]); await denied(call());
    await db.query("update public.profiles set is_active=true where id=$1", [user]);
    await db.query("delete from public.user_roles where user_id=$1 and role=$2", [user, role]); await denied(call());
  });

  it.each(["email_confirmed_at=null,phone_confirmed_at=null", "banned_until=now()+interval '1 day'", "deleted_at=now()", "is_anonymous=true"])("denies unverified/inactive Auth state %s", async (state) => {
    const submission = await request();
    for (const user of [id.teacherA, id.adminA, id.guardianA]) {
      await db.query(`update auth.users set ${state} where id=$1`, [user]);
      await denied(user === id.teacherA ? detail(submission, user) : user === id.adminA ? review(submission, user) : family(user));
      await db.query("update auth.users set email_confirmed_at=now(),phone_confirmed_at=null,banned_until=null,deleted_at=null,is_anonymous=false where id=$1", [user]);
    }
  });

  it("requires completed source and refuses missing marks rather than filling them with zero", async () => {
    await db.query("update public.teacher_assessments set status='scheduled' where id=$1", [id.assessmentA]);
    let source = await preview(); expect(source.can_submit).toBe(false); expect(source.issues.length).toBeGreaterThan(0);
    await conflict(request(id.teacherA, id.assessmentA, source.source_token));
    await db.query("update public.teacher_assessments set status='completed' where id=$1", [id.assessmentA]);
    await actor(id.teacherA, "delete from public.teacher_assessment_marks where id=$1", [secondMark]);
    source = await preview(); expect(source.can_submit).toBe(false);
    expect(source.pupils.find((row) => row.student_id === id.unlinkedPupilA)?.marks_obtained).toBeNull();
    await conflict(request(id.teacherA, id.assessmentA, source.source_token));
    expect((await queue()).rows).toEqual([]);
  });

  it("accepts an actual zero score and computes a bounded percentage", async () => {
    await saveMark(id.pupilA, 0);
    const submission = await request(); await review(submission);
    expect((await family()).rows[0]).toMatchObject({ marks_obtained: 0, maximum_marks: 100, percentage: 0 });
  });

  it("changes source tokens for every relevant source edit and rejects the old preview token", async () => {
    const before = await preview();
    await saveMark(id.pupilA, 75, id.teacherA, "Changed remark");
    const current = await preview(); expect(current.source_token).not.toBe(before.source_token);
    await conflict(request(id.teacherA, id.assessmentA, before.source_token));
    expect((await queue()).rows).toEqual([]);
    expect(await request(id.teacherA, id.assessmentA, current.source_token)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([
    ["parent metadata", "update public.teacher_assessments set name=name||' revised' where id=$1", id.assessmentA],
    ["parent ABA version", "update public.teacher_assessments set name=name where id=$1", id.assessmentA],
    ["pupil label", "update public.students set first_name=first_name||' revised' where id=$1", id.pupilA],
    ["class label", "update public.classes set name=name||' revised' where id=$1", id.classA],
    ["year label", "update public.academic_years set name=name||' revised' where id=$1", id.yearA],
    ["subject label", "update public.subjects set name=name||' revised' where id=$1", id.subjectA],
  ])("rejects publication after %s changes while retaining the requested snapshot", async (_name, sql, rowId) => {
    const submission = await request(), frozen = (await detail(submission)).snapshot;
    await db.query(sql, [rowId]);
    expect((await detail(submission, principal)).source_matches).toBe(false);
    await conflict(review(submission, principal));
    expect((await detail(submission)).snapshot).toEqual(frozen);
    expect((await detail(submission)).status).toBe("pending");
    expect((await family()).rows).toEqual([]);
    expect(await review(submission, principal, "rejected", "Source changed; please submit a fresh snapshot")).toBe(submission);
  });

  it.each(["score", "remarks", "mark ABA", "roster placement", "withdrawn pupil"])("will not publish a stale source after %s", async (change) => {
    const submission = await request();
    if (change === "score") await saveMark(id.pupilA, 75);
    if (change === "remarks") await saveMark(id.pupilA, 74, id.teacherA, "Changed only remark");
    if (change === "mark ABA") await actor(id.teacherA, "update public.teacher_assessment_marks set remarks=remarks where id=$1", [id.markA]);
    if (change === "roster placement") {
      const section = uuid(70);
      await db.query("insert into public.sections(id,school_id,class_id,name) values($1,$2,$3,'Moved section')", [section, id.schoolA, id.classA]);
      await db.query("update public.enrollments set section_id=$2 where student_id=$1", [id.unlinkedPupilA, section]);
    }
    if (change === "withdrawn pupil") await db.query("update public.students set status='withdrawn' where id=$1", [id.unlinkedPupilA]);
    await conflict(review(submission));
    expect((await detail(submission)).status).toBe("pending");
  });

  it("keeps published scores, names and class/session evidence immutable after source changes, transfer and withdrawal", async () => {
    const submission = await published(), frozen = (await family()).rows;
    await saveMark(id.pupilA, 82, id.teacherA, "Later unreviewed source correction");
    await db.query("update public.students set first_name='New display name',status='withdrawn' where id=$1", [id.pupilA]);
    const nextClass = uuid(71), nextSection = uuid(72);
    await db.query("insert into public.classes(id,school_id,name) values($1,$2,'Next class')", [nextClass, id.schoolA]);
    await db.query("insert into public.sections(id,school_id,class_id,name) values($1,$2,$3,'Next section')", [nextSection, id.schoolA, nextClass]);
    await db.query("update public.enrollments set class_id=$2,section_id=$3 where student_id=$1", [id.pupilA, nextClass, nextSection]);
    await db.query("update public.classes set name='Renamed original class' where id=$1", [id.classA]);
    expect((await family()).rows).toEqual(frozen);
    expect((await family(id.studentUserA)).rows).toEqual(frozen);
    expect((await detail(submission, principal)).snapshot.metadata.class_name).toBe("Recovery class 6");
  });

  it("preserves published family history after the source teacher loses assignment and role", async () => {
    await published(); const frozen = await family();
    await db.query("delete from public.teacher_subject_assignments where id=$1", [id.assignmentA]);
    await db.query("delete from public.user_roles where user_id=$1 and role='teacher'", [id.teacherA]);
    expect(await family()).toEqual(frozen);
    expect((await family(id.studentUserA)).rows).toEqual(frozen.rows);
  });

  it("shows only the latest reviewed revision per assessment and pupil while retaining older batch evidence", async () => {
    const first = await published(), firstSnapshot = (await detail(first)).snapshot;
    await saveMark(id.pupilA, 91);
    const second = await request();
    expect((await family()).rows[0]).toMatchObject({ id: first, marks_obtained: 74, revision: 1 });
    await review(second, principal);
    const history = await family();
    expect(history.rows).toHaveLength(1); expect(Number(history.total_count)).toBe(1);
    expect(history.rows[0]).toMatchObject({ id: second, marks_obtained: 91, revision: 2 });
    expect((await detail(first, principal)).snapshot).toEqual(firstSnapshot);
    expect((await detail(first, principal)).status).toBe("published");
    expect((await queue(id.adminA, id.schoolA, "published")).rows).toHaveLength(2);
  });

  it("binds submission retry references to the original actor and exact source intent", async () => {
    const token = (await preview()).source_token, key = randomUUID();
    const submission = await request(id.teacherA, id.assessmentA, token, key);
    expect(await request(id.teacherA, id.assessmentA, token, key)).toBe(submission);
    await review(submission);
    expect(await request(id.teacherA, id.assessmentA, token, key)).toBe(submission);
    await saveMark(id.pupilA, 76);
    await conflict(request(id.teacherA, id.assessmentA, (await preview()).source_token, key));
    await denied(request(otherTeacher, id.assessmentA, token, key));
  });

  it("has one pending submission per assessment and permits fresh requests after rejection or cancellation", async () => {
    const first = await request();
    await conflict(request());
    await review(first, principal, "rejected", "Please check the source work");
    const second = await request(); expect(second).not.toBe(first);
    await cancel(second);
    expect((await detail(second)).status).toBe("cancelled");
    const third = await request(); expect(third).not.toBe(second);
    expect((await queue(id.teacherA, null, "pending")).rows.map((row) => row.id)).toEqual([third]);
  });

  it("prevents requester self-review even with a separate office role on the same account", async () => {
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'school_admin')", [id.teacherA, id.schoolA]);
    const submission = await request();
    await denied(review(submission, id.teacherA));
    await denied(review(submission, id.teacherA, "rejected", "My own rejection is not independent"));
    expect((await detail(submission)).status).toBe("pending");
    await review(submission, principal);
  });

  it("does not let an office marker publish their own source mark through a teacher's submission", async () => {
    await saveMark(id.pupilA, 78, id.adminA);
    const submission = await request();
    await denied(review(submission, id.adminA));
    await review(submission, principal);
    expect((await family()).rows[0].marks_obtained).toBe(78);
  });

  it("allows exactly one final independent decision and idempotent identical review retries", async () => {
    const submission = await request();
    expect(await review(submission)).toBe(submission);
    expect(await review(submission)).toBe(submission);
    await conflict(review(submission, principal));
    await conflict(review(submission, id.adminA, "rejected", "Different terminal decision"));
    await conflict(review(submission, id.adminA, "published", "Changed terminal review note"));
    await conflict(cancel(submission));
    expect((await detail(submission)).status).toBe("published");
  });

  it("allows only the requester to cancel pending evidence, with canonical unchanged retries", async () => {
    const submission = await request();
    for (const user of [id.adminA, principal, otherTeacher, id.guardianA]) await denied(cancel(submission, user));
    expect(await cancel(submission, id.teacherA, "  Revise source marks  ")).toBe(submission);
    expect(await cancel(submission, id.teacherA, "Revise source marks")).toBe(submission);
    await conflict(cancel(submission, id.teacherA, "Changed cancellation note"));
    await conflict(review(submission));
    expect((await family()).rows).toEqual([]);
  });

  it.each(["", " ", "\n\t\r\n", "ab", "x".repeat(1001)])("validates bounded nonblank review/cancellation reasons: %j", async (reason) => {
    const submission = await request();
    await invalid(review(submission, principal, "published", reason));
    await invalid(review(submission, principal, "rejected", reason));
    await invalid(cancel(submission, id.teacherA, reason));
    expect((await detail(submission)).status).toBe("pending");
  });

  it("rejects unsupported review decisions and invalid token/request references", async () => {
    const submission = await request();
    await invalid(review(submission, principal, "approved"));
    await invalid(value(id.teacherA, "select public.request_assessment_publication($1,$2,$3) as value", [id.assessmentA, "not-a-source-token", randomUUID()]));
    await invalid(value(id.teacherA, "select public.request_assessment_publication($1,$2,null) as value", [id.assessmentA, (await preview()).source_token]));
    await denied(review(randomUUID(), principal));
    await denied(cancel(randomUUID()));
  });

  it.each([-1, null])("rejects invalid list/history offsets %j", async (offset) => {
    await invalid(value(id.adminA, "select public.list_assessment_result_submissions($1,null,$2) as value", [id.schoolA, offset]));
    await invalid(value(id.guardianA, "select public.get_family_assessment_results($1,$2) as value", [id.pupilA, offset]));
  });

  it("rejects unknown status filters rather than silently widening office scope", async () => {
    await invalid(queue(id.adminA, id.schoolA, "unexpected"));
  });

  it("revokes further source preview/submission when the exact assignment disappears", async () => {
    const submission = await request();
    await db.query("delete from public.teacher_subject_assignments where id=$1", [id.assignmentA]);
    await denied(preview());
    await denied(detail(submission));
    expect((await queue(id.teacherA, null)).rows).toEqual([]);
    await denied(request(id.teacherA, id.assessmentA, (await detail(submission, principal)).source_token));
    await conflict(review(submission));
    expect((await family()).rows).toEqual([]);
    expect(await cancel(submission)).toBe(submission);
  });

  it("does not expose future/staged enrollment evidence or malformed school placement as a publishable roster", async () => {
    await db.query("update public.enrollments set status='staged' where student_id=$1", [id.unlinkedPupilA]);
    const source = await preview();
    expect(source.can_submit).toBe(false);
    await conflict(request(id.teacherA, id.assessmentA, source.source_token));
  });

  it("keeps immutable family evidence when the source assessment and its live marks are removed", async () => {
    await published(); const saved = await family();
    await db.query("delete from public.teacher_assessments where id=$1", [id.assessmentA]);
    expect((await family()).rows).toEqual(saved.rows);
    expect((await family(id.studentUserA)).rows).toEqual(saved.rows);
  });

  it("does not accept anonymous callers or direct client writes/reads on private publication storage", async () => {
    const submission = await request();
    for (const [sql, params] of [
      ["select public.list_assessment_publication_candidates() as value", []],
      ["select public.preview_assessment_publication($1) as value", [id.assessmentA]],
      ["select public.get_assessment_result_submission($1) as value", [submission]],
      ["select public.get_family_assessment_results($1,0) as value", [id.pupilA]],
    ] as [string, unknown[]][]) await denied(value(null, sql, params, "anon"));
    for (const user of [id.teacherA, id.adminA, id.guardianA, principal]) {
      await denied(actor(user, "select * from app_private.assessment_result_submissions"));
      await denied(actor(user, "update app_private.assessment_result_submissions set status='published' where id=$1", [submission]));
      await denied(actor(user, "delete from app_private.assessment_result_submissions where id=$1", [submission]));
    }
    expect((await db.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where oid='app_private.assessment_result_submissions'::regclass")).rows[0].relrowsecurity).toBe(true);
  });

  it("paginates the complete office/requester history with stable non-overlapping 50-row pages", async () => {
    for (let index = 0; index < 51; index++) {
      const submission = await request();
      await cancel(submission, id.teacherA, `Cancelled reviewed draft ${index}`);
    }
    const first = await queue(), second = await queue(id.adminA, id.schoolA, null, 50);
    expect(first.rows).toHaveLength(50); expect(second.rows).toHaveLength(1);
    expect(Number(first.total_count)).toBe(51); expect(Number(second.total_count)).toBe(51);
    const ids = [...first.rows, ...second.rows].map((row) => row.id);
    expect(new Set(ids).size).toBe(51);
    expect((await queue()).rows.map((row) => row.id)).toEqual(first.rows.map((row) => row.id));
    expect((await queue(id.teacherA, null, "cancelled")).rows).toHaveLength(50);
    expect((await queue(id.adminA, id.schoolA, "pending")).rows).toEqual([]);
    expect((await queue(id.adminB, id.schoolB)).rows).toEqual([]);
  });

  it("paginates published own-child results without losing rows or exposing the peer's marks", async () => {
    for (let index = 0; index < 51; index++) {
      const assessment = randomUUID();
      await actor(id.teacherA, `insert into public.teacher_assessments
        (id,school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,name,assessment_date,maximum_marks,status)
        select $1,school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,$2,assessment_date,maximum_marks,'completed'
        from public.teacher_assessments where id=$3`, [assessment, `Published pagination ${index}`, id.assessmentA]);
      await actor(id.teacherA, `insert into public.teacher_assessment_marks(assessment_id,student_id,marks_obtained,remarks)
        select $1,student_id,marks_obtained,remarks from public.teacher_assessment_marks where assessment_id=$2`, [assessment, id.assessmentA]);
      const submission = await request(id.teacherA, assessment);
      await review(submission);
    }
    const first = await family(), second = await family(id.guardianA, id.pupilA, 50);
    expect(first.rows).toHaveLength(50); expect(second.rows).toHaveLength(1);
    expect(Number(first.total_count)).toBe(51); expect(Number(second.total_count)).toBe(51);
    expect(new Set([...first.rows, ...second.rows].map((row) => row.id)).size).toBe(51);
    expect([...first.rows, ...second.rows].every((row) => row.student_id === id.pupilA && row.marks_obtained === 74)).toBe(true);
    expect(JSON.stringify([first, second])).not.toContain("REC-A-002");
    expect((await family()).rows.map((row) => row.id)).toEqual(first.rows.map((row) => row.id));
  });

  it("invalidates a pending publication after trusted source-mark deletion without deleting its frozen evidence", async () => {
    const submission = await request(), snapshot = (await detail(submission)).snapshot;
    await db.query("delete from public.teacher_assessment_marks where id=$1", [id.markA]);
    await conflict(review(submission));
    expect((await detail(submission, principal)).snapshot).toEqual(snapshot);
    expect((await family()).rows).toEqual([]);
  });

  it("restores a published pupil snapshot and its publication gate into a fresh embedded engine", async () => {
    await published();
    const original = await family();
    await db.exec("commit");
    let restored: PGlite | undefined;
    try {
      restored = await restoreSyntheticSnapshot(await createSyntheticSnapshot(db));
      await restored.exec("begin");
      const read = await value<FamilyPage>(id.guardianA, "select public.get_family_assessment_results($1,0) as value", [id.pupilA], "authenticated", restored);
      expect(read).toEqual(original);
      await denied(value(id.guardianA, "select public.get_family_assessment_results($1,0) as value", [id.unlinkedPupilA], "authenticated", restored));
      await denied(actor(id.guardianA, "select * from app_private.assessment_result_submissions", [], "authenticated", restored));
      await restored.exec("rollback");
    } finally {
      await restored?.close();
      await db.exec("begin");
      await db.exec("truncate app_private.assessment_result_submissions cascade");
      await db.exec("commit;begin");
    }
  }, 30_000);
});
