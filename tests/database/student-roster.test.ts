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
    const file = (await readdir(migrationDirectory)).find((name) => name.endsWith("_admit_roster_student.sql"));
    if (!file) throw new Error("Student roster admission migration is missing.");
    await db.exec(await readFile(new URL(file, migrationDirectory), "utf8"));
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
});
