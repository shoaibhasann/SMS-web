// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite;
const nextYear = "76000000-0000-0000-0000-000000000001";
const oldYearRow = "76000000-0000-0000-0000-000000000002";
const subject = "76000000-0000-0000-0000-000000000003";
const message = "Choose the current academic year for this school.";
const insertSql = `insert into public.teacher_subject_assignments(teacher_id,academic_year_id,class_id,section_id,subject_id,is_class_teacher)
  values($1,$2,$3,$4,$5,false) returning id`;

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  await db.exec("insert into auth.sessions(id,user_id) select id,id from auth.users on conflict(id) do nothing");
}, 60_000);
beforeEach(async () => {
  await db.exec("begin");
  // The admin's tab loaded yearA; another tab then activates the next session.
  await db.query("update public.academic_years set is_current=false where id=$1", [id.yearA]);
  await db.query(`insert into public.academic_years(id,school_id,name,start_date,end_date,is_current)
    values($1,$2,'Next session','2027-04-01','2028-03-31',true)`, [nextYear, id.schoolA]);
  await db.query("insert into public.subjects(id,school_id,name) values($1,$2,'Year guard science')", [subject, id.schoolA]);
});
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

async function asAdmin(sql: string, params: unknown[] = []) {
  await db.exec("savepoint year_actor");
  try {
    await db.exec("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [id.adminA, JSON.stringify({ sub: id.adminA, session_id: id.adminA })]);
    const result = await db.query<{ id: string }>(sql, params);
    await db.exec("reset role; release savepoint year_actor");
    return result.rows;
  } catch (error) {
    await db.exec("rollback to savepoint year_actor; reset role; release savepoint year_actor");
    throw error;
  }
}
const row = (year: string) => [id.teacherRecordA, year, id.classA, id.sectionA, subject];

describe("teaching assignment writes follow the current academic year", () => {
  it("rejects API inserts and updates into a non-current year with a refresh message", async () => {
    await expect(asAdmin(insertSql, row(id.yearA))).rejects.toMatchObject({ code: "22023", message });
    await expect(asAdmin("update public.teacher_subject_assignments set is_class_teacher=false where id=$1 returning id", [id.assignmentA]))
      .rejects.toMatchObject({ code: "22023", message });
    expect((await db.query("select is_class_teacher from public.teacher_subject_assignments where id=$1", [id.assignmentA])).rows)
      .toEqual([{ is_class_teacher: true }]);
  });

  it("still accepts current-year API writes, old-year deletes and trusted backend writes", async () => {
    expect(await asAdmin(insertSql, row(nextYear))).toHaveLength(1);
    await db.query(`insert into public.teacher_subject_assignments(id,teacher_id,academic_year_id,class_id,section_id,subject_id,is_class_teacher)
      values($1,$2,$3,$4,$5,$6,false)`, [oldYearRow, ...row(id.yearA)]);
    expect(await asAdmin("delete from public.teacher_subject_assignments where id=$1 returning id", [oldYearRow])).toEqual([{ id: oldYearRow }]);
  });
});
