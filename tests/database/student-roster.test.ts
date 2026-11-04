// @vitest-environment node

import { readFile, readdir } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS, STAFF_ROWS } from "./staff-scope-fixture";

const migrationDirectory = new URL("../../supabase/migrations/", import.meta.url);

describe("student roster admission", () => {
  let db: PGlite;
  const scope = [STAFF_IDS.schoolA, STAFF_ROWS.A.year, STAFF_ROWS.A.class, STAFF_ROWS.A.section];

  beforeAll(async () => {
    db = await createStaffScopeDatabase({ includeTeachingRpcs: true, applyGovernance: true });
    const files = await readdir(migrationDirectory);
    for (const suffix of ["_admit_roster_student.sql", "_import_roster_students.sql"]) {
      const file = files.find((name) => name.endsWith(suffix));
      if (!file) throw new Error(`Student roster migration is missing: ${suffix}`);
      await db.exec(await readFile(new URL(file, migrationDirectory), "utf8"));
    }
  }, 30000);

  afterAll(async () => { await db?.close(); });

  function admit(actor: string, admissionNumber: string, selectedScope: readonly string[] = scope) {
    return asStaffActor<{ id: string }>(db, actor, "select public.admit_roster_student($1,$2,$3,$4,$5,$6,$7) as id",
      [...selectedScope, admissionNumber, " Noor ", " Singh "]);
  }

  it("creates an active student and enrollment that both principal and attendance readers can see", async () => {
    const { rows: [result] } = await admit(STAFF_IDS.principalA, "  NEW-100  ");
    const read = await asStaffActor(db, STAFF_IDS.teacherA, `
      select s.admission_no, s.first_name, s.last_name, s.status, e.status as enrollment_status
      from public.students s join public.enrollments e on e.student_id = s.id
      where s.id = $1 and e.academic_year_id = $2 and e.class_id = $3 and e.section_id = $4
    `, [result.id, ...scope.slice(1)]);
    expect(read.rows).toEqual([{
      admission_no: "NEW-100", first_name: "Noor", last_name: "Singh", status: "active", enrollment_status: "active",
    }]);
    await expect(admit(STAFF_IDS.adminA, "NEW-100")).rejects.toMatchObject({ code: "23505" });
    const count = await db.query<{ count: number }>(
      "select count(*)::int as count from public.enrollments where student_id = $1", [result.id],
    );
    expect(count.rows).toEqual([{ count: 1 }]);
  });

  it("rejects unrelated roles, cross-school scope and mismatched classes or sections", async () => {
    for (const actor of [STAFF_IDS.teacherA, STAFF_IDS.adminB, STAFF_IDS.accountantA, STAFF_IDS.outsider]) {
      await expect(admit(actor, "DENIED")).rejects.toMatchObject({ code: "42501" });
    }
    await expect(admit(STAFF_IDS.adminA, "BAD-SECTION", [scope[0], scope[1], scope[2], STAFF_ROWS.privateSectionA]))
      .rejects.toMatchObject({ code: "22023" });
    await expect(admit(STAFF_IDS.adminA, "BAD-YEAR", [scope[0], STAFF_ROWS.B.year, scope[2], scope[3]]))
      .rejects.toMatchObject({ code: "22023" });
    const { rows } = await db.query(`select id from public.students where admission_no in ('DENIED', 'BAD-SECTION', 'BAD-YEAR')`);
    expect(rows).toEqual([]);
  });

  it("rolls back the student insert if enrollment fails", async () => {
    await db.exec(`
      create function public.reject_test_enrollment() returns trigger language plpgsql as $$
      begin
        if exists (select 1 from public.students where id = new.student_id and admission_no = 'ROLLBACK-001') then
          raise exception 'Test enrollment failure.';
        end if;
        return new;
      end;
      $$;
      create trigger reject_test_enrollment before insert on public.enrollments
        for each row execute function public.reject_test_enrollment();
    `);
    try {
      await expect(admit(STAFF_IDS.adminA, "ROLLBACK-001")).rejects.toMatchObject({ message: "Test enrollment failure." });
      const { rows } = await db.query("select id from public.students where admission_no = 'ROLLBACK-001'");
      expect(rows).toEqual([]);
    } finally {
      await db.exec("drop trigger reject_test_enrollment on public.enrollments; drop function public.reject_test_enrollment();");
    }
  });

  function batch(actor: string, requestId: string, admissionNumbers: string[], selectedScope: readonly string[] = scope) {
    const rows = admissionNumbers.map((admissionNumber) => ({ admissionNumber, firstName: "CSV pupil", lastName: "" }));
    return asStaffActor<{ count: number }>(db, actor, "select public.import_roster_students($1,$2,$3,$4,$5,$6) as count",
      [...selectedScope, requestId, JSON.stringify(rows)]);
  }

  it("imports once and returns the same count on an identical retry", async () => {
    const request = "c53021ef-d7a9-4205-9c50-d40d51456a35";
    const numbers = ["CSV-NEW-001", "CSV-NEW-002"];
    expect((await batch(STAFF_IDS.principalA, request, numbers)).rows).toEqual([{ count: 2 }]);
    expect((await batch(STAFF_IDS.principalA, request, numbers)).rows).toEqual([{ count: 2 }]);
    await expect(batch(STAFF_IDS.principalA, request, ["CSV-NEW-003"])).rejects.toMatchObject({ code: "22023" });
    await expect(batch(STAFF_IDS.adminB, request, numbers)).rejects.toMatchObject({ code: "42501" });
    const { rows } = await db.query(`
      select s.admission_no, e.status
      from public.students s join public.enrollments e on e.student_id = s.id
      where s.admission_no = any($1) and e.academic_year_id = $2 and e.class_id = $3 and e.section_id = $4
      order by s.admission_no
    `, [numbers, ...scope.slice(1)]);
    expect(rows).toEqual(numbers.map((admission_no) => ({ admission_no, status: "active" })));
  });

  it("rejects the whole batch when a later row conflicts or the section is invalid", async () => {
    const request = "e24a7c94-743b-4960-aa2f-2ad0c7b6c748";
    await expect(batch(STAFF_IDS.adminA, request, ["CSV-ROLLBACK", "STUDENT-A"])).rejects.toMatchObject({
      code: "23505", message: "Student 2 has an admission number already used in this school.",
    });
    expect((await db.query("select id from public.students where admission_no = 'CSV-ROLLBACK'")).rows).toEqual([]);
    await expect(batch(STAFF_IDS.adminA, request, ["CSV-BAD-SECTION"],
      [scope[0], scope[1], scope[2], STAFF_ROWS.B.section])).rejects.toMatchObject({ code: "22023" });
    await expect(batch(STAFF_IDS.adminA, request, Array.from({ length: 51 }, (_, index) => `CSV-${index}`)))
      .rejects.toMatchObject({ code: "22023" });
    expect((await batch(STAFF_IDS.adminA, request, ["CSV-ROLLBACK"])).rows).toEqual([{ count: 1 }]);
  });
});
