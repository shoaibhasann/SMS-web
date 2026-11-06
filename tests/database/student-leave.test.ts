// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";
import { createSyntheticSnapshot, restoreSyntheticSnapshot } from "../../scripts/database-recovery/drill.mjs";

let db: PGlite;
const principal = "74000000-0000-0000-0000-000000000201";
const finance = "74000000-0000-0000-0000-000000000202";
const globalAdmin = "74000000-0000-0000-0000-000000000203";
type LeaveRow = {
  id: string; school_id: string; student_id: string; student_name: string; admission_no: string;
  academic_year_id: string; academic_year_name: string; class_name: string; section_name: string | null;
  start_date: string; end_date: string; reason: string; status: string; requester_id: string;
  requester_name: string; created_at: string; reviewed_by: string | null; reviewer_name: string | null;
  review_note: string | null; reviewed_at: string | null; total_count: number | string;
};

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  for (const [user, role] of [[principal, "principal"], [finance, "accountant"], [globalAdmin, "super_admin"]]) {
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [user, `${role}@leave.invalid`]);
    await db.query("update public.profiles set school_id=$2,full_name=$3 where id=$1", [user, role === "super_admin" ? null : id.schoolA, `Leave ${role}`]);
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,$3)", [user, role === "super_admin" ? null : id.schoolA, role]);
  }
}, 60_000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

async function actor<Row extends Record<string, unknown> = Record<string, unknown>>(
  user: string | null, sql: string, params: unknown[] = [], role: "authenticated" | "anon" = "authenticated",
  connection: PGlite = db,
) {
  await connection.exec("savepoint leave_actor");
  try {
    await connection.exec(`set local role ${role}`);
    await connection.query("select set_config('request.jwt.claim.sub',$1,true)", [user ?? ""]);
    const result = await connection.query<Row>(sql, params);
    await connection.exec("reset role");
    await connection.query("select set_config('request.jwt.claim.sub','',true)");
    await connection.exec("release savepoint leave_actor");
    return result;
  } catch (error) {
    await connection.exec("rollback to savepoint leave_actor; release savepoint leave_actor");
    throw error;
  }
}
const submit = async (
  user = id.guardianA, student = id.pupilA, start = "2026-11-10", end = start,
  reason = "Medical appointment", key = randomUUID(),
) => (await actor<{ id: string }>(user, "select public.submit_student_leave($1,$2::date,$3::date,$4,$5::uuid) as id", [student, start, end, reason, key])).rows[0].id;
const family = async (user = id.guardianA, student = id.pupilA, offset = 0) =>
  (await actor<{ value: LeaveRow }>(user, "select to_jsonb(r) as value from public.list_family_student_leave($1,$2) r", [student, offset])).rows.map((row) => row.value);
const queue = async (user = id.adminA, school = id.schoolA, status: string | null = null, offset = 0) =>
  (await actor<{ value: LeaveRow }>(user, "select to_jsonb(r) as value from public.list_student_leave_review($1,$2,$3) r", [school, status, offset])).rows.map((row) => row.value);
const review = async (request: string, user = id.adminA, decision = "approved", note = "Approved by the school office") =>
  (await actor<{ id: string }>(user, "select public.review_student_leave($1,$2,$3) as id", [request, decision, note])).rows[0].id;
const denied = (operation: Promise<unknown>) => expect(operation).rejects.toMatchObject({ code: "42501" });
const invalid = (operation: Promise<unknown>) => expect(operation).rejects.toMatchObject({ code: "22023" });
const conflict = (operation: Promise<unknown>) => expect(operation).rejects.toMatchObject({ code: "PT409" });

describe("governed student leave under the complete recovered schema", () => {
  it("persists family submit, office decision and fresh reads without changing attendance or fees", async () => {
    const beforeAttendance = (await db.query("select to_jsonb(a) as row from public.attendance a order by id")).rows;
    const beforeFees = (await db.query("select to_jsonb(f) as row from public.student_fees f order by id")).rows;
    const request = await submit();
    expect(await family()).toEqual([expect.objectContaining({
      id: request, student_id: id.pupilA, school_id: id.schoolA, admission_no: "REC-A-001",
      academic_year_id: id.yearA, class_name: "Recovery class 6", section_name: "Recovery A",
      start_date: "2026-11-10", end_date: "2026-11-10", reason: "Medical appointment",
      status: "pending", requester_id: id.guardianA, reviewed_by: null, review_note: null, reviewed_at: null,
    })]);
    expect((await queue(id.adminA, id.schoolA, "pending"))[0].id).toBe(request);
    expect(await review(request)).toBe(request);
    expect(await family(id.studentUserA)).toEqual([expect.objectContaining({
      id: request, status: "approved", reviewed_by: id.adminA,
      review_note: "Approved by the school office", reviewer_name: "Synthetic admin-a",
    })]);
    expect((await family())[0].reviewed_at).toBeTruthy();
    expect(await queue(id.adminA, id.schoolA, "pending")).toEqual([]);
    expect((await queue(id.adminA, id.schoolA, "approved"))[0].id).toBe(request);
    expect((await db.query("select to_jsonb(a) as row from public.attendance a order by id")).rows).toEqual(beforeAttendance);
    expect((await db.query("select to_jsonb(f) as row from public.student_fees f order by id")).rows).toEqual(beforeFees);
  });

  it("permits student-owned submissions and shows the same child history to its linked guardian", async () => {
    const request = await submit(id.studentUserA);
    expect((await family())[0]).toMatchObject({ id: request, requester_id: id.studentUserA });
    await review(request, principal, "rejected", "Please contact the school office");
    expect((await family(id.studentUserA))[0]).toMatchObject({ status: "rejected", reviewed_by: principal });
  });

  it("denies cross-child, cross-school and role-only family impersonation", async () => {
    for (const [user, student] of [
      [id.guardianA, id.unlinkedPupilA], [id.guardianA, id.pupilB],
      [id.studentUserA, id.unlinkedPupilA], [id.studentUserA, id.pupilB],
      [id.teacherA, id.pupilA], [id.adminA, id.pupilA], [finance, id.pupilA],
      [id.claimantA, id.pupilA], [id.guardianA, randomUUID()],
    ]) {
      await denied(family(user, student));
      await denied(submit(user, student));
    }
    expect((await db.query<{ count: number }>("select count(*)::int as count from app_private.student_leave_requests")).rows[0].count).toBe(0);
  });

  it("denies cross-school queue/review and teacher or finance review", async () => {
    const request = await submit();
    for (const user of [id.adminB, id.teacherA, id.guardianA, id.studentUserA, finance]) {
      await denied(queue(user));
      await denied(review(request, user));
    }
    await denied(review(randomUUID()));
    expect((await family())[0].status).toBe("pending");
  });

  it("does not treat a family role alone or a cross-school guardian edge as exact child ownership", async () => {
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'parent'),($1,$2,'student')", [id.teacherA, id.schoolA]);
    await denied(family(id.teacherA));
    await denied(submit(id.teacherA));
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [id.pupilB, id.parentA]);
    await denied(family(id.guardianA, id.pupilB));
    await denied(submit(id.guardianA, id.pupilB));
  });

  it("requires the active family profile to retain its school context", async () => {
    await db.query("update public.profiles set school_id=$2 where id=$1", [id.guardianA, id.schoolB]);
    await denied(family());
    await denied(submit());
  });

  it("allows an active global super admin to review either school", async () => {
    const request = await submit();
    expect((await queue(globalAdmin))[0].id).toBe(request);
    expect(await review(request, globalAdmin)).toBe(request);
    const other = await submit(id.studentUserB, id.pupilB);
    expect((await queue(globalAdmin, id.schoolB))[0].id).toBe(other);
    expect(await review(other, globalAdmin)).toBe(other);
  });

  it.each(["guardian", "student", "reviewer"])("requires an active profile and current role for %s", async (kind) => {
    const request = await submit();
    const user = kind === "guardian" ? id.guardianA : kind === "student" ? id.studentUserA : id.adminA;
    await db.query("update public.profiles set is_active=false where id=$1", [user]);
    if (kind === "reviewer") { await denied(queue(user)); await denied(review(request, user)); }
    else { await denied(family(user)); await denied(submit(user, id.pupilA, "2026-11-12")); }
    await db.query("update public.profiles set is_active=true where id=$1", [user]);
    await db.query("delete from public.user_roles where user_id=$1", [user]);
    if (kind === "reviewer") { await denied(queue(user)); await denied(review(request, user)); }
    else { await denied(family(user)); await denied(submit(user, id.pupilA, "2026-11-12")); }
  });

  it.each([
    "email_confirmed_at=null,phone_confirmed_at=null", "banned_until=now()+interval '1 day'",
    "deleted_at=now()", "is_anonymous=true",
  ])("denies an unusable Auth account (%s) despite a valid family role", async (change) => {
    await db.query(`update auth.users set ${change} where id=$1`, [id.guardianA]);
    await denied(family());
    await denied(submit());
  });

  it("uses an actor-bound idempotency key, preserves the first intent and retries after review", async () => {
    const key = randomUUID();
    const request = await submit(id.guardianA, id.pupilA, "2026-11-10", "2026-11-11", "  Family appointment  ", key);
    expect(await submit(id.guardianA, id.pupilA, "2026-11-10", "2026-11-11", "Family appointment", key)).toBe(request);
    await conflict(submit(id.guardianA, id.pupilA, "2026-11-10", "2026-11-12", "Family appointment", key));
    await conflict(submit(id.guardianA, id.pupilA, "2026-11-10", "2026-11-11", "Changed reason", key));
    await review(request);
    expect(await submit(id.guardianA, id.pupilA, "2026-11-10", "2026-11-11", "Family appointment", key)).toBe(request);
    const own = await submit(id.studentUserA, id.pupilA, "2026-11-15", "2026-11-15", "Different actor intent", key);
    expect(own).not.toBe(request);
    expect(await family()).toHaveLength(2);
  });

  it("serially checks inclusive pending/approved overlaps across guardians and student retries", async () => {
    const request = await submit(id.guardianA, id.pupilA, "2026-11-10", "2026-11-12");
    for (const [start, end] of [["2026-11-09", "2026-11-10"], ["2026-11-11", "2026-11-11"], ["2026-11-12", "2026-11-13"]]) {
      await conflict(submit(id.studentUserA, id.pupilA, start, end));
    }
    await review(request);
    await conflict(submit(id.studentUserA, id.pupilA, "2026-11-10"));
    await submit(id.studentUserA, id.pupilA, "2026-11-13");
    expect(await family()).toHaveLength(2);
  });

  it("rejects using one actor intent key for two linked children", async () => {
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [id.unlinkedPupilA, id.parentA]);
    const key = randomUUID();
    const request = await submit(id.guardianA, id.pupilA, "2026-11-10", "2026-11-10", "Family appointment", key);
    await conflict(submit(id.guardianA, id.unlinkedPupilA, "2026-11-10", "2026-11-10", "Family appointment", key));
    expect((await family())[0].id).toBe(request);
    expect(await family(id.guardianA, id.unlinkedPupilA)).toEqual([]);
  });

  it("allows a rejected range to be submitted with a new intent and never reopens the rejected row", async () => {
    const key = randomUUID();
    const request = await submit(id.guardianA, id.pupilA, "2026-11-10", "2026-11-10", "Original request", key);
    await review(request, id.adminA, "rejected", "Additional explanation required");
    const replacement = await submit(id.guardianA, id.pupilA, "2026-11-10", "2026-11-10", "New explanation");
    expect(replacement).not.toBe(request);
    expect(await submit(id.guardianA, id.pupilA, "2026-11-10", "2026-11-10", "Original request", key)).toBe(request);
    expect((await family()).find((row) => row.id === request)?.status).toBe("rejected");
  });

  it("never allows the requester to approve or reject their own request after receiving an office role", async () => {
    const request = await submit();
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'principal')", [id.guardianA, id.schoolA]);
    await denied(review(request, id.guardianA));
    await denied(review(request, id.guardianA, "rejected", "Trying self review"));
    expect((await family())[0].status).toBe("pending");
  });

  it("makes the terminal review immutable and accepts only an identical same-reviewer retry", async () => {
    const request = await submit();
    expect(await review(request, principal, "approved", "  Approved school absence  ")).toBe(request);
    const saved = (await family())[0];
    expect(await review(request, principal, "approved", "Approved school absence")).toBe(request);
    expect((await family())[0]).toEqual(saved);
    await conflict(review(request, id.adminA, "approved", "Approved school absence"));
    await conflict(review(request, principal, "rejected", "Approved school absence"));
    await conflict(review(request, principal, "approved", "Changed explanation"));
    expect((await family())[0]).toEqual(saved);
  });

  it("normalizes outer whitespace for request and review retries while preserving meaningful line breaks", async () => {
    const key = randomUUID();
    const request = await submit(id.guardianA, id.pupilA, "2026-11-10", "2026-11-10", "\n\t Medical\nappointment \r\n", key);
    expect(await submit(id.guardianA, id.pupilA, "2026-11-10", "2026-11-10", "Medical\nappointment", key)).toBe(request);
    expect((await family())[0].reason).toBe("Medical\nappointment");
    expect(await review(request, principal, "approved", "\n\t Approved\nby office \r\n")).toBe(request);
    const saved = (await family())[0];
    expect(saved.review_note).toBe("Approved\nby office");
    expect(await review(request, principal, "approved", "Approved\nby office")).toBe(request);
    expect((await family())[0]).toEqual(saved);
  });

  it.each([
    ["2026-11-12", "2026-11-11", "Valid reason"], ["2026-03-31", "2026-04-01", "Valid reason"],
    ["2027-03-31", "2027-04-01", "Valid reason"], ["infinity", "infinity", "Valid reason"],
    ["-infinity", "2026-11-11", "Valid reason"], [null, "2026-11-11", "Valid reason"],
    ["2026-11-11", null, "Valid reason"], ["2026-11-11", "2026-11-11", null],
    ["2026-11-11", "2026-11-11", "  a  "], ["2026-11-11", "2026-11-11", "x".repeat(1001)],
    ["2026-11-11", "2026-11-11", "\n\n\n"], ["2026-11-11", "2026-11-11", "\t\r\n \t"],
  ])("rejects invalid request dates/reason (%s, %s)", async (start, end, reason) => {
    await invalid(actor(id.guardianA, "select public.submit_student_leave($1,$2::date,$3::date,$4,$5::uuid)", [id.pupilA, start, end, reason, randomUUID()]));
    expect(await family()).toEqual([]);
  });

  it("requires an idempotency key and validates review decisions/notes without mutating pending state", async () => {
    await invalid(actor(id.guardianA, "select public.submit_student_leave($1,'2026-11-11','2026-11-11','Valid request',null)", [id.pupilA]));
    const request = await submit();
    for (const [decision, note] of [["pending", "Valid reason"], ["cancelled", "Valid reason"], [null, "Valid reason"], ["approved", null], ["approved", "  x "], ["approved", "x".repeat(1001)], ["approved", "\n\n\n"], ["rejected", "\t\r\n \t"]]) {
      await invalid(actor(id.adminA, "select public.review_student_leave($1,$2,$3)", [request, decision, note]));
    }
    expect((await family())[0].status).toBe("pending");
  });

  it("requires a coherent active enrollment for new submissions but retains old history and retry", async () => {
    const key = randomUUID();
    const request = await submit(id.guardianA, id.pupilA, "2026-11-10", "2026-11-10", "Original request", key);
    await db.query("update public.students set status='withdrawn' where id=$1", [id.pupilA]);
    await expect(submit(id.guardianA, id.pupilA, "2026-11-12")).rejects.toThrow();
    expect((await family())[0].id).toBe(request);
    expect(await submit(id.guardianA, id.pupilA, "2026-11-10", "2026-11-10", "Original request", key)).toBe(request);
    await db.query("update public.students set status='active' where id=$1", [id.pupilA]);
    await db.query("update public.enrollments set status='withdrawn' where student_id=$1", [id.pupilA]);
    await expect(submit(id.guardianA, id.pupilA, "2026-11-12")).rejects.toThrow();
    expect((await family(id.studentUserA))[0].id).toBe(request);
  });

  it("rejects a mismatched class/section enrollment instead of opening another school's placement", async () => {
    await db.query("update public.enrollments set class_id=$2,section_id=$3 where student_id=$1", [id.pupilA, id.classB, id.sectionB]);
    await expect(submit()).rejects.toThrow();
    expect(await family()).toEqual([]);
  });

  it("preserves original placement/year labels after class transfer and promotion", async () => {
    const request = await submit();
    const old = (await family())[0];
    const newClass = randomUUID();
    const newYear = randomUUID();
    await db.query("insert into public.classes(id,school_id,name) values($1,$2,'New class after transfer')", [newClass, id.schoolA]);
    await db.query("update public.enrollments set class_id=$2,section_id=null where student_id=$1", [id.pupilA, newClass]);
    await db.query("update public.academic_years set is_current=false where id=$1", [id.yearA]);
    await db.query("insert into public.academic_years(id,school_id,name,start_date,end_date,is_current) values($1,$2,'2027–28','2027-04-01','2028-03-31',true)", [newYear, id.schoolA]);
    await db.query("insert into public.enrollments(student_id,academic_year_id,class_id,status) values($1,$2,$3,'active')", [id.pupilA, newYear, newClass]);
    await db.query("update public.classes set name='Renamed historical class' where id=$1", [id.classA]);
    await db.query("update public.sections set name='Renamed historical section' where id=$1", [id.sectionA]);
    await db.query("update public.academic_years set name='Renamed historical session' where id=$1", [id.yearA]);
    const historical = (await family())[0];
    expect(historical).toMatchObject({ id: request, class_name: old.class_name, section_name: old.section_name, academic_year_name: old.academic_year_name, academic_year_id: id.yearA });
    expect((await queue())[0]).toMatchObject({ id: request, class_name: old.class_name, academic_year_id: id.yearA });
    await review(request);
    expect((await family())[0].status).toBe("approved");
  });

  it("revokes only the removed child edge, keeps sibling access and never deletes leave history", async () => {
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [id.unlinkedPupilA, id.parentA]);
    const request = await submit();
    const sibling = await submit(id.guardianA, id.unlinkedPupilA);
    await db.query("delete from public.student_parents where student_id=$1 and parent_id=$2", [id.pupilA, id.parentA]);
    await denied(family());
    await denied(submit(id.guardianA, id.pupilA, "2026-11-12"));
    expect((await family(id.guardianA, id.unlinkedPupilA))[0].id).toBe(sibling);
    expect((await family(id.studentUserA))[0].id).toBe(request);
    expect(await queue()).toHaveLength(2);
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [id.pupilA, id.parentA]);
    expect((await family())[0].id).toBe(request);
  });

  it("paginates family and office history deterministically with a filtered full count", async () => {
    const first = new Date("2026-04-01T00:00:00Z");
    for (let index = 0; index < 52; index += 1) {
      const date = new Date(first);
      date.setUTCDate(date.getUTCDate() + index);
      const day = date.toISOString().slice(0, 10);
      const request = await submit(id.guardianA, id.pupilA, day);
      if (index % 2 === 0) await review(request, id.adminA, "rejected", "Pagination fixture decision");
    }
    const a = await family();
    const b = await family(id.guardianA, id.pupilA, 50);
    expect(a).toHaveLength(50);
    expect(b).toHaveLength(2);
    expect(Number(a[0].total_count)).toBe(52);
    expect(Number(b[0].total_count)).toBe(52);
    expect(new Set([...a, ...b].map((row) => row.id)).size).toBe(52);
    expect(await family()).toEqual(a);
    const pending = await queue(id.adminA, id.schoolA, "pending");
    expect(pending).toHaveLength(26);
    expect(pending.every((row) => row.status === "pending" && Number(row.total_count) === 26)).toBe(true);
    expect(await family(id.guardianA, id.pupilA, 52)).toEqual([]);
  });

  it("rejects invalid filters/pages at the RPC boundary", async () => {
    await invalid(family(id.guardianA, id.pupilA, -1));
    await invalid(queue(id.adminA, id.schoolA, "unknown"));
    await invalid(queue(id.adminA, id.schoolA, null, -1));
    await invalid(actor(id.guardianA, "select * from public.list_family_student_leave($1,null)", [id.pupilA]));
  });

  it("keeps the backing table and function execution private from anonymous/direct clients", async () => {
    const flags = (await db.query(`select c.relrowsecurity as rls,
      has_table_privilege('authenticated','app_private.student_leave_requests','SELECT') as direct_select,
      has_table_privilege('authenticated','app_private.student_leave_requests','INSERT') as direct_insert,
      has_table_privilege('authenticated','app_private.student_leave_requests','UPDATE') as direct_update,
      has_table_privilege('authenticated','app_private.student_leave_requests','DELETE') as direct_delete
      from pg_class c where c.oid='app_private.student_leave_requests'::regclass`)).rows;
    expect(flags).toEqual([{ rls: true, direct_select: false, direct_insert: false, direct_update: false, direct_delete: false }]);
    await denied(actor(id.guardianA, "select * from app_private.student_leave_requests"));
    await denied(actor(null, "select * from public.list_family_student_leave($1)", [id.pupilA], "anon"));
    await denied(actor(null, "select public.submit_student_leave($1,'2026-11-10','2026-11-10','Reason required',$2)", [id.pupilA, randomUUID()], "anon"));
    await denied(actor(null, "select * from public.list_student_leave_review($1)", [id.schoolA], "anon"));
    await denied(actor(null, "select public.review_student_leave($1,'approved','Not allowed')", [randomUUID()], "anon"));
    await denied(actor(null, "select * from public.list_family_student_leave($1)", [id.pupilA]));
    const publicDefiners = (await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('submit_student_leave','list_family_student_leave','list_student_leave_review','review_student_leave') and p.prosecdef`)).rows;
    expect(publicDefiners).toEqual([]);
  });

  it("restores a committed approved request into a fresh engine with family authorization intact", async () => {
    const source = await createRecoveryDatabase();
    let restored: PGlite | undefined;
    try {
      await seedRecoveryData(source);
      await source.exec("begin");
      const request = (await actor<{ id: string }>(id.guardianA,
        "select public.submit_student_leave($1,'2026-11-10','2026-11-11','Synthetic recovery leave',$2) as id",
        [id.pupilA, randomUUID()], "authenticated", source)).rows[0].id;
      await actor(id.adminA, "select public.review_student_leave($1,'approved','Approved recovery fixture')",
        [request], "authenticated", source);
      await source.exec("commit");
      const saved = (await source.query<{ value: LeaveRow }>(
        "select to_jsonb(r) as value from app_private.student_leave_requests r where id=$1", [request])).rows[0].value;
      restored = await restoreSyntheticSnapshot(await createSyntheticSnapshot(source));
      await restored.exec("begin");
      const rows = (await actor<{ value: LeaveRow }>(id.guardianA,
        "select to_jsonb(r) as value from public.list_family_student_leave($1) r", [id.pupilA], "authenticated", restored)).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].value).toMatchObject({
        id: saved.id, status: "approved", requester_id: id.guardianA, reviewed_by: id.adminA,
        start_date: "2026-11-10", end_date: "2026-11-11", reason: "Synthetic recovery leave",
        review_note: "Approved recovery fixture", created_at: saved.created_at, reviewed_at: saved.reviewed_at,
        class_name: "Recovery class 6", section_name: "Recovery A", academic_year_id: id.yearA,
      });
      await denied(actor(id.guardianA, "select * from public.list_family_student_leave($1)",
        [id.unlinkedPupilA], "authenticated", restored));
      await denied(actor(id.adminB, "select * from public.list_student_leave_review($1)",
        [id.schoolA], "authenticated", restored));
      await denied(actor(id.guardianA, "select * from app_private.student_leave_requests", [], "authenticated", restored));
      await restored.exec("rollback");
    } finally { await restored?.close(); await source.close(); }
  }, 30_000);
});
