// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS, STAFF_ROWS } from "./staff-scope-fixture";

type Database = Awaited<ReturnType<typeof createStaffScopeDatabase>>;
type Preview = {
  preview_token: string; can_post: boolean;
  rows: { row_number: number; student_id: string | null; demand_id: string | null; amount: number | null; status: string; message: string }[];
  summary: { ready_count: number; existing_count: number; error_count: number; ready_amount: number; existing_amount: number; total_amount: number };
};
type Receipt = { batch_id: string; created_count: number; existing_count: number; total_amount: number; posted_by_name: string };
type Ledger = { rows: Record<string, unknown>[]; summary: { demand_count: number; invalid_count: number; net_amount: number | null; paid_amount: number | null; balance: number | null; opening_amount: number | null } };

describe("reviewed office fee batches and opening debt", () => {
  let db: Database;
  const { A, B } = STAFF_ROWS;
  const { schoolA, schoolB, adminA, accountantA, principalA, teacherA, parentA, studentA, adminB, receptionA } = STAFF_IDS;
  let today = "";
  const extraStudent = randomUUID(), extraEnrollment = randomUUID();
  let monthlyReceipt: Receipt;
  let openingReceipt: Receipt;
  let openingFee = "";

  beforeAll(async () => {
    db = await createStaffScopeDatabase();
    const directory = new URL("../../supabase/migrations/", import.meta.url);
    const files = await readdir(directory);
    for (const suffix of ["_record_office_fee_payment.sql", "_close_office_fee_day.sql", "_office_fee_day_optimistic_conflict_http_status.sql", "_office_fee_batches_and_opening_balances.sql"]) {
      const matches = files.filter((name) => name.endsWith(suffix));
      expect(matches).toHaveLength(1);
      await db.exec(await readFile(new URL(matches[0], directory), "utf8"));
    }
    today = (await db.query<{ day: string }>("select (statement_timestamp() at time zone 'Asia/Kolkata')::date::text as day")).rows[0].day;
    await db.query("insert into public.students(id,school_id,admission_no,first_name) values($1,$2,'BATCH-EXTRA','Batch extra')", [extraStudent, schoolA]);
    await db.query("insert into public.enrollments(id,student_id,academic_year_id,class_id,section_id) values($1,$2,$3,$4,$5)", [extraEnrollment, extraStudent, A.year, A.class, A.section]);
  }, 30000);
  afterAll(async () => { await db?.close(); });

  const monthly = (period = "2026-11") => ({ academic_year_id: A.year, fee_structure_id: A.structure, billing_period: period, due_date: `${period}-20`, class_id: null, section_id: null });
  const opening = (rows: { admission_no: string; amount: string }[] = [{ admission_no: "STUDENT-A", amount: "500.25" }, { admission_no: "BATCH-EXTRA", amount: "800.00" }]) => ({ academic_year_id: A.year, as_of_date: today, source_reference: "Reviewed opening register 01", reason: "Outstanding only, checked by school office", rows });
  async function preview(kind = "monthly", payload: unknown = monthly(), actor: string | null = accountantA, school = schoolA, role: "authenticated" | "anon" | "service_role" = "authenticated") {
    const result = await asStaffActor<{ value: Preview }>(db, actor, "select public.preview_office_fee_batch($1,$2,$3::jsonb) as value", [school, kind, JSON.stringify(payload)], role);
    return result.rows[0].value;
  }
  async function post(kind: string, payload: unknown, token: string, request = randomUUID(), actor = accountantA, school = schoolA) {
    const result = await asStaffActor<{ value: Receipt }>(db, actor, "select public.post_office_fee_batch($1,$2,$3::jsonb,$4,$5) as value", [school, kind, JSON.stringify(payload), token, request]);
    return result.rows[0].value;
  }
  async function ledger(year: string | null = A.year, student: string | null = null, limit = 50, offset = 0, actor = accountantA, school = schoolA) {
    return (await asStaffActor<{ value: Ledger }>(db, actor, "select public.get_office_fee_ledger($1,$2,$3,$4,$5) as value", [school, year, student, limit, offset])).rows[0].value;
  }

  it("previews the complete eligible roster without creating debt or payments", async () => {
    const result = await preview();
    expect(result.can_post).toBe(true);
    expect(result.summary).toEqual({ ready_count: 2, existing_count: 0, error_count: 0, ready_amount: 2000, existing_amount: 0, total_amount: 2000 });
    expect(result.rows.map((row) => row.student_id).sort()).toEqual([A.student, extraStudent].sort());
    expect(result.preview_token).toMatch(/^[a-f0-9]{64}$/);
    expect((await db.query("select count(*)::int as count from app_private.office_fee_batches")).rows[0]).toEqual({ count: 0 });
    expect((await ledger()).summary).toMatchObject({ net_amount: 1000, paid_amount: 100, balance: 900, opening_amount: 0 });
  });

  it("posts one reviewed monthly batch and replays the same receipt after an uncertain response", async () => {
    const payload = monthly(), reviewed = await preview("monthly", payload), request = randomUUID();
    const originalLegacy = (await db.query("select * from public.fee_payments where id=$1", [A.payment])).rows;
    monthlyReceipt = await post("monthly", payload, reviewed.preview_token, request);
    expect(monthlyReceipt).toMatchObject({ created_count: 2, existing_count: 0, total_amount: 2000, posted_by_name: "accountantA" });
    expect(await post("monthly", payload, reviewed.preview_token, request)).toEqual(monthlyReceipt);
    await expect(post("monthly", { ...payload, due_date: "2026-11-21" }, reviewed.preview_token, request)).rejects.toMatchObject({ code: "23505" });
    await expect(post("monthly", payload, reviewed.preview_token, request, adminA)).rejects.toMatchObject({ code: "23505" });
    expect((await db.query("select * from public.fee_payments where id=$1", [A.payment])).rows).toEqual(originalLegacy);
    expect((await db.query("select count(*)::int as count from app_private.office_fee_batch_items where batch_id=$1", [monthlyReceipt.batch_id])).rows[0]).toEqual({ count: 2 });
  });

  it("marks existing demands and retains their due dates without duplicate billing", async () => {
    const payload = { ...monthly(), due_date: "2026-11-25" }, reviewed = await preview("monthly", payload);
    expect(reviewed.summary).toMatchObject({ ready_count: 0, existing_count: 2, error_count: 0, ready_amount: 0, existing_amount: 2000 });
    expect(reviewed.can_post).toBe(false);
    await expect(post("monthly", payload, reviewed.preview_token)).rejects.toMatchObject({ code: "22023" });
    expect((await db.query("select count(*)::int as count,min(due_date)::text as due from public.student_fees where school_id=$1 and billing_period='2026-11'", [schoolA])).rows[0])
      .toEqual({ count: 2, due: "2026-11-20" });
    const first = reviewed.rows.find((row) => row.student_id === A.student)!;
    const single = await asStaffActor<{ id: string }>(db, principalA, "select public.issue_office_fee_demand($1,$2,$3,'2026-11','2026-11-20') as id", [schoolA, A.student, A.structure]);
    expect(single.rows[0].id).toBe(first.demand_id);
  });

  it("preserves a pre-existing single demand and charges only new pupils in a mixed batch", async () => {
    await asStaffActor(db, principalA, "select public.issue_office_fee_demand($1,$2,$3,'2026-12','2026-12-10')", [schoolA, A.student, A.structure]);
    const payload = monthly("2026-12"), reviewed = await preview("monthly", payload);
    expect(reviewed.summary).toMatchObject({ ready_count: 1, existing_count: 1, ready_amount: 1000 });
    const receipt = await post("monthly", payload, reviewed.preview_token);
    expect(receipt).toMatchObject({ created_count: 1, existing_count: 1, total_amount: 1000 });
  });

  it("rejects stale amounts or roster state without a partial batch", async () => {
    const payload = monthly("2027-01"), reviewed = await preview("monthly", payload);
    await db.query("update public.fee_structures set amount=1200 where id=$1", [A.structure]);
    await expect(post("monthly", payload, reviewed.preview_token)).rejects.toMatchObject({ code: "PT409" });
    await db.query("update public.fee_structures set amount=1000 where id=$1", [A.structure]);
    await db.query("update public.enrollments set status='withdrawn' where id=$1", [extraEnrollment]);
    await expect(post("monthly", payload, reviewed.preview_token)).rejects.toMatchObject({ code: "PT409" });
    await db.query("update public.enrollments set status='active' where id=$1", [extraEnrollment]);
    expect((await db.query("select count(*)::int as count from public.student_fees where billing_period='2027-01'")).rows[0]).toEqual({ count: 0 });
  });

  it("posts outstanding opening debt, never fabricating a cash receipt", async () => {
    const payload = opening(), reviewed = await preview("opening", payload), request = randomUUID();
    expect(reviewed.summary).toMatchObject({ ready_count: 2, ready_amount: 1300.25, error_count: 0 });
    const paymentIds = (await db.query("select id from public.fee_payments order by id")).rows;
    openingReceipt = await post("opening", payload, reviewed.preview_token, request);
    expect(openingReceipt).toMatchObject({ created_count: 2, total_amount: 1300.25 });
    expect(await post("opening", payload, reviewed.preview_token, request)).toEqual(openingReceipt);
    expect((await db.query("select id from public.fee_payments order by id")).rows).toEqual(paymentIds);
    const rows = await db.query<{ student_fee_id: string }>("select student_fee_id from app_private.office_fee_openings where student_id=$1", [A.student]);
    openingFee = rows.rows[0].student_fee_id;
    const openingRow = (await ledger()).rows.find((row) => row.demand_id === openingFee)!;
    expect(openingRow).toMatchObject({ kind: "opening", academic_year_id: A.year, amount: 500.25, paid_amount: 0, balance: 500.25, source_reference: payload.source_reference, as_of_date: today });
    const repeated = await preview("opening", opening());
    expect(repeated.can_post).toBe(false);
    expect(repeated.summary).toMatchObject({ existing_count: 2, ready_count: 0, ready_amount: 0 });
  });

  it("collects opening debt through the existing payment transaction with partial and final receipts", async () => {
    const first = await asStaffActor<{ value: { payment_id: string } }>(db, accountantA, "select public.record_office_fee_payment($1,$2,250.25,'cash',$3,null) as value", [schoolA, openingFee, randomUUID()]);
    expect(first.rows[0].value.payment_id).toBeTruthy();
    expect((await ledger(A.year, A.student)).rows.find((row) => row.demand_id === openingFee)).toMatchObject({ status: "partial", paid_amount: 250.25, balance: 250 });
    await asStaffActor(db, accountantA, "select public.record_office_fee_payment($1,$2,250,'upi',$3,'QA-UPI-OPEN')", [schoolA, openingFee, randomUUID()]);
    expect((await ledger(A.year, A.student)).rows.find((row) => row.demand_id === openingFee)).toMatchObject({ status: "paid", paid_amount: 500.25, balance: 0 });
  });

  it("keeps the opening structure protected and unusable through the ordinary single-demand path", async () => {
    const structure = (await db.query<{ id: string }>("select fee_structure_id as id from app_private.office_fee_opening_structures where school_id=$1 and academic_year_id=$2", [schoolA, A.year])).rows[0].id;
    await expect(asStaffActor(db, adminA, "update public.fee_structures set amount=999 where id=$1", [structure])).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, principalA, "delete from public.fee_structures where id=$1", [structure])).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, accountantA, "select public.issue_office_fee_demand($1,$2,$3,'2027-02','2027-02-10')", [schoolA, A.student, structure])).rejects.toMatchObject({ code: "22023" });
    await expect(preview("monthly", { ...monthly("2027-02"), fee_structure_id: structure })).rejects.toMatchObject({ code: "22023" });
  });

  it("returns row errors for duplicates, malformed amounts and unrelated admission numbers", async () => {
    const result = await preview("opening", opening([
      { admission_no: "STUDENT-A", amount: "1.001" }, { admission_no: "STUDENT-B", amount: "10.00" },
      { admission_no: "BATCH-EXTRA", amount: "NaN" }, { admission_no: "PRIVATE-A", amount: "20.00" },
      { admission_no: "private-a", amount: "21.00" }, { admission_no: "MISSING", amount: "4.00" },
    ]));
    expect(result.summary.error_count).toBe(6);
    expect(result.rows[0].amount).toBeNull();
    expect(result.can_post).toBe(false);
    await expect(post("opening", opening([]), result.preview_token)).rejects.toMatchObject({ code: "22023" });
  });

  it("rolls back all opening rows when one mapping is invalid", async () => {
    const payload = opening([{ admission_no: "PRIVATE-A", amount: "90" }, { admission_no: "MISSING", amount: "10" }]);
    const reviewed = await preview("opening", payload);
    expect(reviewed.summary).toMatchObject({ ready_count: 1, error_count: 1 });
    await expect(post("opening", payload, reviewed.preview_token)).rejects.toMatchObject({ code: "22023" });
    expect((await db.query("select count(*)::int as count from app_private.office_fee_openings where student_id=$1", [STAFF_ROWS.privateStudentA])).rows[0]).toEqual({ count: 0 });
  });

  it("rejects foreign school, year, class and section scopes and unauthorized roles", async () => {
    for (const actor of [teacherA, parentA, studentA, receptionA, adminB]) {
      await expect(preview("monthly", monthly(), actor)).rejects.toMatchObject({ code: "42501" });
      await expect(ledger(A.year, null, 50, 0, actor)).rejects.toMatchObject({ code: "42501" });
    }
    await expect(preview("monthly", monthly(), adminA, schoolB)).rejects.toMatchObject({ code: "42501" });
    await expect(preview("monthly", monthly(), null, schoolA, "anon")).rejects.toMatchObject({ code: "42501" });
    for (const payload of [{ ...monthly(), academic_year_id: B.year }, { ...monthly(), fee_structure_id: B.structure }, { ...monthly(), class_id: B.class }, { ...monthly(), class_id: A.class, section_id: B.section }]) {
      await expect(preview("monthly", payload)).rejects.toMatchObject({ code: "22023" });
    }
    await expect(ledger(B.year)).rejects.toMatchObject({ code: "42501" });
    await expect(ledger(null, B.student)).rejects.toMatchObject({ code: "42501" });
  });

  it("pins the preview to its actor and rejects inactive finance identities", async () => {
    const payload = monthly("2027-02"), reviewed = await preview("monthly", payload, principalA);
    await expect(post("monthly", payload, reviewed.preview_token)).rejects.toMatchObject({ code: "PT409" });
    await db.query("update public.profiles set is_active=false where id=$1", [accountantA]);
    await expect(preview()).rejects.toMatchObject({ code: "42501" });
    await db.query("update public.profiles set is_active=true where id=$1", [accountantA]);
  });

  it("returns complete server totals while paging only the visible ledger rows", async () => {
    const complete = await ledger(), page1 = await ledger(A.year, null, 2, 0), page2 = await ledger(A.year, null, 2, 2);
    expect(complete.summary).toMatchObject({ demand_count: 7, invalid_count: 0, net_amount: 6300.25, paid_amount: 600.25, balance: 5700, opening_amount: 1300.25 });
    expect(page1.rows).toHaveLength(2); expect(page2.rows).toHaveLength(2);
    expect(page1.summary).toEqual(complete.summary); expect(page2.summary).toEqual(complete.summary);
    expect(new Set([...page1.rows, ...page2.rows].map((row) => row.demand_id)).size).toBe(4);
    const history = (await asStaffActor<{ value: Receipt[] }>(db, principalA, "select public.list_office_fee_batches($1,1,0) as value", [schoolA])).rows[0].value;
    expect(history).toHaveLength(1);
    expect(history[0].batch_id).toBe(openingReceipt.batch_id);
  });

  it("reports invalid legacy money as unreconciled instead of publishing fabricated zero balances", async () => {
    await db.query("update public.student_fees set amount='NaN' where id=$1", [A.fee]);
    const result = await ledger();
    expect(result.summary.invalid_count).toBe(1);
    expect(result.summary.net_amount).toBeNull(); expect(result.summary.balance).toBeNull();
    expect(result.rows.find((row) => row.demand_id === A.fee)).toMatchObject({ invalid: true, amount: null, paid_amount: null, balance: null, status: "review_required" });
    await db.query("update public.student_fees set amount=1000 where id=$1", [A.fee]);
  });

  it("exposes no private batch tables or anonymous callable definer functions", async () => {
    for (const table of ["office_fee_batches", "office_fee_batch_items", "office_fee_openings", "office_fee_opening_structures"]) {
      await expect(asStaffActor(db, adminA, `select * from app_private.${table}`)).rejects.toMatchObject({ code: "42501" });
    }
    const functions = await db.query<{ name: string; definer: boolean; search_path: string[]; anon: boolean }>("select p.proname as name,p.prosecdef as definer,p.proconfig as search_path,has_function_privilege('anon',p.oid,'EXECUTE') as anon from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('preview_office_fee_batch','post_office_fee_batch','list_office_fee_batches','get_office_fee_ledger')");
    expect(functions.rows).toHaveLength(4);
    for (const row of functions.rows) { expect(row.definer).toBe(false); expect(row.anon).toBe(false); expect(row.search_path).toEqual(['search_path=""']); }
  });

  it("bounds malformed payloads, dates and ledger/history pages", async () => {
    for (const payload of [{ ...monthly(), billing_period: "2026-13" }, { ...monthly(), due_date: "2026-02-01" }, { ...monthly(), surprise: true }]) {
      await expect(preview("monthly", payload)).rejects.toMatchObject({ code: "22023" });
    }
    await expect(preview("opening", { ...opening(), source_reference: " " })).rejects.toMatchObject({ code: "22023" });
    await expect(preview("opening", { ...opening(), as_of_date: "2099-01-01" })).rejects.toMatchObject({ code: "22023" });
    await expect(preview("opening", opening([]))).rejects.toMatchObject({ code: "22023" });
    await expect(ledger(A.year, null, 201)).rejects.toMatchObject({ code: "22023" });
    await expect(ledger(A.year, null, 50, -1)).rejects.toMatchObject({ code: "22023" });
  });
});
