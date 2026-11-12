// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS, STAFF_ROWS } from "./staff-scope-fixture";

type Database = Awaited<ReturnType<typeof createStaffScopeDatabase>>;
type Preview = {
  preview_token: string; can_post: boolean;
  rows: { student_id: string | null; demand_id: string | null; amount: number | null; status: string; message: string }[];
  summary: { ready_count: number; existing_count: number; error_count: number };
};

describe("fee heads after a mid-month class move", () => {
  let db: Database;
  const { A } = STAFF_ROWS;
  const { schoolA, accountantA, adminA } = STAFF_IDS;
  const newClass = STAFF_ROWS.privateClassA;
  const tuitionB = randomUUID(), transportA = randomUUID(), transportB = randomUUID(), otherA = randomUUID(), otherB = randomUUID();
  const annualA = randomUUID(), annualB = randomUUID(), examFee = randomUUID();
  let period = "", nextPeriod = "", tuitionADemand = "";

  beforeAll(async () => {
    db = await createStaffScopeDatabase({ includeTeachingRpcs: true, applyGovernance: true, includeGuardianInvitations: true });
    const directory = new URL("../../supabase/migrations/", import.meta.url);
    const files = await readdir(directory);
    const suffixes = ["_repair_school_policy_helper.sql", "_guardian_invitations.sql", "_govern_attendance_corrections.sql",
      "_withdraw_roster_enrollment.sql", "_change_roster_placement.sql", "_record_office_fee_payment.sql", "_close_office_fee_day.sql",
      "_office_fee_day_optimistic_conflict_http_status.sql", "_office_fee_batches_and_opening_balances.sql", "_guard_office_fee_demand_periods.sql"];
    const selected = suffixes.map((suffix) => {
      const matches = files.filter((name) => name.endsWith(suffix));
      expect(matches).toHaveLength(1);
      return matches[0];
    }).sort();
    for (const file of selected) await db.exec(await readFile(new URL(file, directory), "utf8"));
    const { rows: [dates] } = await db.query<{ today: string; period: string; next_period: string }>(
      `select d::text as today, to_char(d,'YYYY-MM') as period, to_char(d + interval '1 month','YYYY-MM') as next_period
        from (select (now() at time zone 'Asia/Kolkata')::date d) x`);
    ({ period, next_period: nextPeriod } = dates);
    // The office move RPC needs the session in progress today and no attendance from today on.
    await db.query("update public.academic_years set start_date=$1::date-30,end_date=$1::date+90 where id=$2", [dates.today, A.year]);
    await db.query("update public.attendance set attendance_date=$1::date-1 where student_id=$2", [dates.today, A.student]);
    // Fee heads come from the office Fee Category list; names compare case- and space-insensitively.
    await db.query("update public.fee_structures set name='Tuition Fee',frequency='monthly' where id=$1", [A.structure]);
    await db.query(
      `insert into public.fee_structures(id,school_id,academic_year_id,class_id,name,frequency,amount) values
        ($1,$9,$10,$12,' tuition fee ','monthly',1200),($2,$9,$10,$11,'Transport','monthly',300),($3,$9,$10,$12,'Transport','monthly',350),
        ($4,$9,$10,$11,'Other','monthly',200),($5,$9,$10,$12,'Other','monthly',250),
        ($6,$9,$10,$11,'Annual Fee','yearly',5000),($7,$9,$10,$12,'Annual Fee','yearly',5500),($8,$9,$10,null,'Exam Fee','monthly',100)`,
      [tuitionB, transportA, transportB, otherA, otherB, annualA, annualB, examFee, schoolA, A.year, A.class, newClass],
    );
  }, 30000);
  afterAll(async () => { await db?.close(); });

  const due = (month: string) => `${month}-28`;
  const payload = (structure: string, month = period) =>
    ({ academic_year_id: A.year, fee_structure_id: structure, billing_period: month, due_date: due(month), class_id: null, section_id: null });
  const preview = async (structure: string, month?: string) =>
    (await asStaffActor<{ value: Preview }>(db, accountantA, "select public.preview_office_fee_batch($1,'monthly',$2::jsonb) as value",
      [schoolA, JSON.stringify(payload(structure, month))])).rows[0].value;
  const post = async (structure: string, token: string) =>
    (await asStaffActor<{ value: { created_count: number; existing_count: number } }>(db, accountantA,
      "select public.post_office_fee_batch($1,'monthly',$2::jsonb,$3,$4) as value",
      [schoolA, JSON.stringify(payload(structure)), token, randomUUID()])).rows[0].value;
  const issue = async (structure: string, month = period) =>
    (await asStaffActor<{ id: string }>(db, accountantA, "select public.issue_office_fee_demand($1,$2,$3,$4,$5) as id",
      [schoolA, A.student, structure, month, due(month)])).rows[0].id;
  const monthDemands = async () => (await db.query<{ name: string; amount: string }>(
    `select fs.name,sf.amount from public.student_fees sf join public.fee_structures fs on fs.id=sf.fee_structure_id
      where sf.student_id=$1 and sf.billing_period=$2 order by fs.name,sf.amount`, [A.student, period])).rows;
  const pupilRow = (result: Preview) => result.rows.find((item) => item.student_id === A.student);

  it("bills the old class, then moves the pupil with the office placement RPC", async () => {
    const before = await preview(A.structure);
    expect(await post(A.structure, before.preview_token)).toMatchObject({ created_count: 1 });
    tuitionADemand = (await db.query<{ id: string }>("select id from public.student_fees where student_id=$1 and billing_period=$2",
      [A.student, period])).rows[0].id;
    await issue(otherA);
    await issue(annualA);

    await asStaffActor(db, adminA, "select public.change_roster_placement($1,$2,$3,$4,$5,$6,$7,$8,$9) as id",
      [schoolA, A.enrollment, A.class, A.section, A.year, newClass, STAFF_ROWS.privateSectionA, "Moved to the new class", randomUUID()]);
    expect((await db.query<{ class_id: string }>("select class_id from public.enrollments where id=$1", [A.enrollment])).rows[0].class_id).toBe(newClass);
  });

  it("keeps the same head at one demand but bills a different class-wise head in the move month", async () => {
    const tuition = await preview(tuitionB);
    expect(pupilRow(tuition)).toMatchObject({ status: "existing", demand_id: tuitionADemand, amount: 1000 });
    expect(pupilRow(tuition)?.message).toContain("Tuition Fee");
    expect(tuition.summary).toMatchObject({ ready_count: 1, existing_count: 1, error_count: 0 });
    expect(await post(tuitionB, tuition.preview_token)).toMatchObject({ created_count: 1, existing_count: 1 });

    const transport = await preview(transportB);
    expect(pupilRow(transport)).toMatchObject({ status: "ready", demand_id: null, amount: 350 });
    expect(await post(transportB, transport.preview_token)).toMatchObject({ created_count: 2, existing_count: 0 });
    const transportDemand = (await db.query<{ id: string }>(
      "select id from public.student_fees where student_id=$1 and fee_structure_id=$2 and billing_period=$3", [A.student, transportB, period])).rows[0].id;
    expect(await issue(transportB)).toBe(transportDemand);
    const items = await db.query<{ student_fee_id: string; was_created: boolean }>(
      "select student_fee_id,was_created from app_private.office_fee_batch_items where snapshot->>'student_id'=$1 order by student_fee_id", [A.student]);
    expect(items.rows.filter((item) => item.student_fee_id === transportDemand)).toEqual([{ student_fee_id: transportDemand, was_created: true }]);

    await expect(issue(tuitionB)).rejects.toMatchObject({ code: "23505" });
    expect((await monthDemands()).filter((item) => ["Transport", "Tuition Fee"].includes(item.name)))
      .toEqual([{ name: "Transport", amount: "350.00" }, { name: "Tuition Fee", amount: "1000.00" }]);
  });

  it("never treats 'Other' as a duplicate and keeps a yearly head once per session across classes", async () => {
    await issue(otherB);
    await expect(issue(annualB)).rejects.toMatchObject({ code: "23505" });
    expect(await monthDemands()).toEqual([
      { name: "Annual Fee", amount: "5000.00" }, { name: "Other", amount: "200.00" }, { name: "Other", amount: "250.00" },
      { name: "Transport", amount: "350.00" }, { name: "Tuition Fee", amount: "1000.00" },
    ]);
  });

  it("still bills school-wide heads and later months under the new class", async () => {
    await issue(examFee);
    const next = await preview(tuitionB, nextPeriod);
    expect(pupilRow(next)).toMatchObject({ status: "ready", amount: 1200 });
    await issue(tuitionB, nextPeriod);
    await issue(transportB, nextPeriod);
  });
});
