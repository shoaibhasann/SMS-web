// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

// The seeded teacher holds only a 6A section assignment (assignmentA), never the whole class.
let db: PGlite;
const unassignedTeacher = randomUUID();

async function actor<T = Record<string, unknown>>(user: string, sql: string, args: unknown[] = []) {
  await db.exec("savepoint office_scope_probe");
  try {
    await db.exec("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [user, JSON.stringify({ sub: user, session_id: user, role: "authenticated" })]);
    const result = await db.query<T>(sql, args);
    await db.exec("reset role");
    await db.exec("release savepoint office_scope_probe");
    return result.rows;
  } catch (error) { await db.exec("rollback to savepoint office_scope_probe; release savepoint office_scope_probe"); throw error; }
}
const insertExam = (user: string, section: string | null, teacher = id.teacherRecordA) => actor<{ id: string }>(user,
  `insert into public.teacher_assessments(school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,name,assessment_date,maximum_marks)
   values($1,$2,$3,$4,$5,$6,'Unit test','2026-11-20',20) returning id`, [id.schoolA, id.yearA, id.classA, section, id.subjectA, teacher]);

beforeAll(async () => {
  db = await createRecoveryDatabase(); await seedRecoveryData(db);
  await db.query("insert into public.teachers(id,school_id,employee_id,full_name) values($1,$2,'SCOPE-NONE','No assignment')", [unassignedTeacher, id.schoolA]);
  await db.exec("insert into auth.sessions(id,user_id) select id,id from auth.users on conflict do nothing");
}, 60_000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

describe("office exam writes stay inside the chosen teacher's assignment", () => {
  it("rejects an office whole-class exam for a section-only teacher and an exam for an unassigned teacher", async () => {
    await expect(insertExam(id.adminA, null)).rejects.toMatchObject({ code: "22023", message: expect.stringContaining("assigned") });
    await expect(insertExam(id.adminA, id.sectionA, unassignedTeacher)).rejects.toMatchObject({ code: "22023" });
  });

  it("allows the office section exam the teacher can see and mark", async () => {
    const [exam] = await insertExam(id.adminA, id.sectionA);
    expect(await actor(id.teacherA, "select id from public.teacher_assessments where id=$1", [exam.id])).toEqual([exam]);
  });

  it("rejects an office move to an unreachable scope but keeps edits that leave the placement alone", async () => {
    const [exam] = await insertExam(id.adminA, id.sectionA);
    await expect(actor(id.adminA, "update public.teacher_assessments set section_id=null where id=$1", [exam.id]))
      .rejects.toMatchObject({ code: "22023" });
    await expect(actor(id.adminA, "update public.teacher_assessments set teacher_id=$2 where id=$1", [exam.id, unassignedTeacher]))
      .rejects.toMatchObject({ code: "22023" });
    // A legacy row written outside the API stays editable for non-placement fields.
    const legacy = randomUUID();
    await db.query(`insert into public.teacher_assessments(id,school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,name,assessment_date,maximum_marks)
      values($1,$2,$3,$4,null,$5,$6,'Legacy whole class','2026-11-21',20)`, [legacy, id.schoolA, id.yearA, id.classA, id.subjectA, id.teacherRecordA]);
    expect(await actor(id.adminA, "update public.teacher_assessments set name='Legacy renamed' where id=$1 returning name", [legacy]))
      .toEqual([{ name: "Legacy renamed" }]);
  });

  it("leaves teacher self-writes unchanged", async () => {
    expect(await insertExam(id.teacherA, id.sectionA)).toHaveLength(1);
    await expect(insertExam(id.teacherA, null)).rejects.toMatchObject({ code: "42501" });
  });
});
