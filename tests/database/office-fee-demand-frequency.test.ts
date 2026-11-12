// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS, STAFF_ROWS } from "./staff-scope-fixture";

type Database = Awaited<ReturnType<typeof createStaffScopeDatabase>>;

describe("single fee demands respect the fee structure frequency", () => {
  let db: Database;
  const { A } = STAFF_ROWS;
  const { schoolA, accountantA } = STAFF_IDS;
  const yearly = randomUUID(), quarterly = randomUUID(), halfYearly = randomUUID(), otherPupil = randomUUID();

  beforeAll(async () => {
    db = await createStaffScopeDatabase();
    const directory = new URL("../../supabase/migrations/", import.meta.url);
    const files = await readdir(directory);
    for (const suffix of ["_record_office_fee_payment.sql", "_close_office_fee_day.sql", "_office_fee_day_optimistic_conflict_http_status.sql",
      "_office_fee_batches_and_opening_balances.sql", "_guard_office_fee_demand_periods.sql"]) {
      const matches = files.filter((name) => name.endsWith(suffix));
      expect(matches).toHaveLength(1);
      await db.exec(await readFile(new URL(matches[0], directory), "utf8"));
    }
    await db.query(
      `insert into public.fee_structures(id,school_id,academic_year_id,class_id,name,frequency,amount) values
        ($1,$4,$5,$6,'Annual Fee','yearly',5000),($2,$4,$5,$6,'Term Fee','quarterly',3000),($3,$4,$5,$6,'Lab Fee','half_yearly',800)`,
      [yearly, quarterly, halfYearly, schoolA, A.year, A.class],
    );
    await db.query("insert into public.students(id,school_id,admission_no,first_name) values($1,$2,'FREQ-OTHER','Other pupil')", [otherPupil, schoolA]);
    await db.query("insert into public.enrollments(student_id,academic_year_id,class_id,section_id) values($1,$2,$3,$4)", [otherPupil, A.year, A.class, A.section]);
  }, 30000);
  afterAll(async () => { await db?.close(); });

  const issue = async (structure: string, period: string, student: string = A.student, due: string | null = null) =>
    (await asStaffActor<{ id: string }>(db, accountantA, "select public.issue_office_fee_demand($1,$2,$3,$4,$5) as id",
      [schoolA, student, structure, period, due])).rows[0].id;
  const count = async (structure: string, student: string = A.student) =>
    (await db.query<{ n: number }>("select count(*)::int as n from public.student_fees where student_id=$1 and fee_structure_id=$2", [student, structure])).rows[0].n;

  it("issues a yearly fee once per pupil and session, keeping exact retries idempotent", async () => {
    const first = await issue(yearly, "2026-04");
    expect(await issue(yearly, "2026-04")).toBe(first);
    await expect(issue(yearly, "2026-05")).rejects.toMatchObject({ code: "23505" });
    await expect(issue(yearly, "2027-03")).rejects.toMatchObject({ code: "23505" });
    expect(await count(yearly)).toBe(1);
    await issue(yearly, "2026-05", otherPupil);
    expect(await count(yearly, otherPupil)).toBe(1);
  });

  it("issues quarterly and half-yearly fees once per period counted from the session start", async () => {
    await issue(quarterly, "2026-04");
    await expect(issue(quarterly, "2026-06")).rejects.toMatchObject({ code: "23505" });
    await issue(quarterly, "2026-07");
    expect(await count(quarterly)).toBe(2);
    await issue(halfYearly, "2026-05");
    await expect(issue(halfYearly, "2026-09")).rejects.toMatchObject({ code: "23505" });
    await issue(halfYearly, "2026-10");
    expect(await count(halfYearly)).toBe(2);
  });

  it("keeps monthly fees one demand per month", async () => {
    await issue(A.structure, "2026-04");
    await issue(A.structure, "2026-05");
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.student_fees where student_id=$1 and fee_structure_id=$2 and billing_period in ('2026-04','2026-05')", [A.student, A.structure])).rows[0].n).toBe(2);
  });
});
