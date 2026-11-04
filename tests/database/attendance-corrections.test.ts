// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS, STAFF_ROWS } from "./staff-scope-fixture";

type Database = Awaited<ReturnType<typeof createStaffScopeDatabase>>;
type Mark = { id: string; status: string; remarks: string | null; revision: number };

describe("daily attendance corrections", () => {
  const { schoolA, schoolB, adminA, adminB, teacherA, principalA, parentA } = STAFF_IDS;
  const { A, B } = STAFF_ROWS;
  let db: Database;
  let today: string;
  let yesterday: string;
  let earlier: string;

  beforeAll(async () => {
    db = await createStaffScopeDatabase({ includeTeachingRpcs: true, applyGovernance: true });
    const directory = new URL("../../supabase/migrations/", import.meta.url);
    const files = (await readdir(directory)).filter((name) => name.endsWith("_govern_attendance_corrections.sql"));
    expect(files).toHaveLength(1);
    await db.exec(await readFile(new URL(files[0], directory), "utf8"));
    const { rows: [dates] } = await db.query<{ today: string; yesterday: string; earlier: string }>(`
      select d::text as today, (d - 1)::text as yesterday, (d - 2)::text as earlier
      from (select (statement_timestamp() at time zone 'Asia/Kolkata')::date as d) dates
    `);
    ({ today, yesterday, earlier } = dates);
    await db.query("update public.academic_years set start_date=$1::date-30,end_date=$1::date+30 where id in ($2,$3)", [today, A.year, B.year]);
    await db.query("update public.attendance set attendance_date=$1,remarks='Original attendance note' where student_id=$2", [yesterday, A.student]);
  }, 30000);

  afterAll(async () => { await db?.close(); });

  async function mark(day: string): Promise<Mark | null> {
    const { rows } = await db.query<Mark>(
      "select id,status,remarks,revision::integer from public.attendance where student_id=$1 and attendance_date=$2", [A.student, day],
    );
    return rows[0] ?? null;
  }

  async function request({
    actor = teacherA, school = schoolA, year = A.year, section = A.section, student = A.student,
    day = yesterday, expected = null, status = "late", reason = "Register source confirms late arrival", key = randomUUID(),
  }: { actor?: string; school?: string; year?: string; section?: string; student?: string; day?: string;
    expected?: Mark | null; status?: string; reason?: string; key?: string } = {}) {
    const { rows } = await asStaffActor<{ id: string }>(db, actor, `
      select public.request_attendance_correction($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as id
    `, [school, year, section, student, day, expected?.id ?? null, expected?.revision ?? null, status, reason, key]);
    return rows[0].id;
  }

  async function review(id: string, decision = "approved", reason = "Verified against office record", actor: string = principalA) {
    const { rows } = await asStaffActor<{ state: string }>(
      db, actor, "select public.review_attendance_correction($1,$2,$3) as state", [id, decision, reason],
    );
    return rows[0].state;
  }

  it("keeps current-day teacher and office marking, rejects date moves and historical writes", async () => {
    const insert = (day: string, actor: string = teacherA) => asStaffActor(db, actor, `
      insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status,marked_by)
      values($1,$2,$3,$4,$5,'present',$6) returning id
    `, [schoolA, A.year, A.section, A.student, day, actor]);
    await expect(insert(earlier)).rejects.toMatchObject({ code: "42501" });
    await expect(insert(today, STAFF_IDS.accountantA)).rejects.toMatchObject({ code: "42501" });
    await expect(insert(today, STAFF_IDS.receptionA)).rejects.toMatchObject({ code: "42501" });
    expect((await insert(today)).rows).toHaveLength(1);
    const oldMark = await mark(today);
    const changed = await asStaffActor(db, adminA,
      "update public.attendance set status='late',marked_by=$2,revision=999 where id=$1 returning revision::integer", [oldMark?.id, adminA]);
    expect(changed.rows).toEqual([{ revision: 1 }]);
    await expect(asStaffActor(db, adminA, "delete from public.attendance where id=$1", [oldMark?.id]))
      .rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, adminA, "update public.attendance set attendance_date=$2,marked_by=$3 where id=$1",
      [oldMark?.id, earlier, adminA])).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, teacherA,
      "update public.attendance set status='late',marked_by=$2 where student_id=$1 and attendance_date=$3",
      [A.student, teacherA, yesterday])).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, adminA, "delete from public.attendance where student_id=$1 and attendance_date=$2",
      [A.student, yesterday])).rejects.toMatchObject({ code: "42501" });
  });

  it("requires scope and reasons, saves before/after, and disallows self-review", async () => {
    const original = await mark(yesterday);
    await expect(request({ actor: parentA, expected: original })).rejects.toMatchObject({ code: "42501" });
    await expect(request({ school: schoolB, year: B.year, section: B.section, student: B.student })).rejects.toMatchObject({ code: "42501" });
    await expect(request({ student: STAFF_ROWS.privateStudentA, section: STAFF_ROWS.privateSectionA })).rejects.toMatchObject({ code: "42501" });
    await expect(request({ expected: original, day: today })).rejects.toMatchObject({ code: "22023" });
    await expect(request({ expected: original, reason: " " })).rejects.toMatchObject({ code: "22023" });

    const key = randomUUID();
    const id = await request({ expected: original, key });
    expect(await request({ expected: original, key })).toBe(id);
    await expect(request({ expected: original, key, status: "present" })).rejects.toMatchObject({ code: "23505" });
    await expect(request({ expected: original })).rejects.toMatchObject({ code: "23505" });
    expect(await mark(yesterday)).toEqual(original);
    await expect(review(id, "approved", " ", principalA)).rejects.toMatchObject({ code: "22023" });
    await expect(review(id, "approved", "Cross-school attempt", adminB)).rejects.toMatchObject({ code: "42501" });
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'principal')", [teacherA, schoolA]);
    try {
      await expect(review(id, "approved", "Self approval", teacherA)).rejects.toThrow("Another administrator or principal");
    } finally {
      await db.query("delete from public.user_roles where user_id=$1 and school_id=$2 and role='principal'", [teacherA, schoolA]);
    }
    expect(await review(id)).toBe("approved");
    expect(await review(id)).toBe("approved");
    expect(await request({ expected: original, key })).toBe(id);
    expect(await mark(yesterday)).toMatchObject({
      id: original?.id, status: "late", remarks: "Original attendance note", revision: (original?.revision ?? 0) + 1,
    });

    const { rows: [{ requests }] } = await asStaffActor<{ requests: unknown[] }>(
      db, teacherA, "select public.list_attendance_corrections($1,0,true) as requests", [schoolA],
    );
    expect(requests).toEqual([expect.objectContaining({
      id, state: "approved", request_reason: "Register source confirms late arrival", review_reason: "Verified against office record",
      before_record: expect.objectContaining({ status: "absent", remarks: "Original attendance note" }),
      after_record: expect.objectContaining({ status: "late", remarks: "Original attendance note" }),
    })]);
    await expect(asStaffActor(db, adminB, "select public.list_attendance_corrections($1) as requests", [schoolA]))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("rejects an ABA-stale request and allows audited approval of an unmarked date", async () => {
    const expected = await mark(yesterday);
    const stale = await request({ expected, status: "present" });
    await db.query("update public.attendance set status='holiday' where id=$1", [expected?.id]);
    await db.query("update public.attendance set status='late' where id=$1", [expected?.id]);
    await expect(review(stale)).rejects.toMatchObject({ code: "40001" });
    expect(await review(stale, "rejected", "Attendance changed while pending")).toBe("rejected");

    const newMark = await request({ day: earlier, expected: null, status: "leave" });
    expect(await mark(earlier)).toBeNull();
    expect(await review(newMark)).toBe("approved");
    expect(await mark(earlier)).toMatchObject({ status: "leave", revision: 0 });
  });

  it("prevents approving a pending request after withdrawal and preserves its rejection trail", async () => {
    const expected = await mark(yesterday);
    const pending = await request({ expected, status: "present" });
    await db.query("update public.enrollments set status='withdrawn' where id=$1", [A.enrollment]);
    await expect(review(pending)).rejects.toMatchObject({ code: "42501" });
    expect(await review(pending, "rejected", "Pupil withdrew before review")).toBe("rejected");
    expect(await mark(yesterday)).toEqual(expected);
    await expect(asStaffActor(db, adminA, "delete from public.attendance where student_id=$1 and attendance_date=$2",
      [A.student, today])).rejects.toMatchObject({ code: "42501" });
  });
});
