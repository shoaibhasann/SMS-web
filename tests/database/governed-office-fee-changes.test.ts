// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStaffActor, STAFF_IDS, STAFF_ROWS } from "./staff-scope-fixture";
import { createGovernedFeeDatabase, type GovernedFeeFixture } from "./governed-office-fees-fixture";

type Amounts = { base_net_amount: string; adjustment_amount: string; net_amount: string; gross_paid_amount: string; reversed_amount: string; paid_amount: string; balance: string };
type Change = { id: string; state: string; financial_token: string; before: Amounts; after: Amounts; entry_id: string | null; reference: string | null; effective_day: string | null };
type Ledger = { rows: ({ demand_id: string; financial_token: string | null; amount: string; net_amount: string; paid_amount: string; balance: string; adjustment_amount: string } & Record<string, unknown>)[]; summary: Record<string, unknown> };

describe("governed fee counterentries", () => {
  let fixture: GovernedFeeFixture;
  const { schoolA, schoolB, accountantA, principalA, adminA, adminB, parentA, studentA, teacherA, receptionA } = STAFF_IDS;
  const { A } = STAFF_ROWS;
  beforeAll(async () => { fixture = await createGovernedFeeDatabase(); }, 30000);
  afterAll(async () => { await fixture?.db.close(); });
  async function ledger() {
    return (await asStaffActor<{ value: Ledger }>(fixture.db, accountantA, "select public.get_office_fee_ledger($1,null,$2,50,0) as value", [schoolA, A.student])).rows[0].value;
  }
  async function request(kind: string, amount: string | null, payment: string | null = null, token?: string, requestId = randomUUID(), actor = accountantA) {
    const current = (await ledger()).rows.find((row) => row.demand_id === A.fee)!;
    return (await asStaffActor<{ value: Change }>(fixture.db, actor,
      "select public.request_office_fee_change($1,$2,$3,$4,$5,'Reviewed QA financial correction',$6,$7) as value", [schoolA, A.fee, kind, amount, payment, token ?? current.financial_token, requestId])).rows[0].value;
  }
  async function review(id: string, decision = "approved", reason = "Independent register review completed", actor = principalA) {
    return (await asStaffActor<{ value: Change }>(fixture.db, actor, "select public.review_office_fee_change($1,$2,$3) as value", [id, decision, reason])).rows[0].value;
  }
  async function pay(amount: string, method = "cash", reference: string | null = null, key = randomUUID()) {
    return (await asStaffActor<{ value: { payment_id: string; receipt_no: string } }>(fixture.db, accountantA,
      "select public.record_office_fee_payment($1,$2,$3,$4,$5,$6) as value", [schoolA, A.fee, amount, method, key, reference])).rows[0].value;
  }
  let firstCurrentPayment = "", lastCashPayment = "";
  it("loads canonical ledger state and preserves a previously closed day", async () => {
    expect((await ledger()).rows[0]).toMatchObject({ amount: "1000.00", net_amount: "1000.00", paid_amount: "100.00", balance: "900.00" });
    const oldDay = (await asStaffActor<{ value: unknown }>(fixture.db, accountantA, "select public.get_office_fee_day($1,$2) as value", [schoolA, fixture.yesterday])).rows[0].value;
    expect(oldDay).toEqual(fixture.oldClosed);
  });
  it("requests and independently approves a reduction without rewriting the demand", async () => {
    const change = await request("reduction", "100.00");
    expect(change.state).toBe("pending");
    expect(change.after).toMatchObject({ net_amount: "900.00", paid_amount: "100.00", balance: "800.00" });
    const approved = await review(change.id);
    expect(approved.state).toBe("approved"); expect(approved.entry_id).toBeTruthy(); expect(approved.reference).toMatch(/^ADJ-/);
    expect((await ledger()).rows[0]).toMatchObject({ amount: "1000.00", net_amount: "900.00", paid_amount: "100.00", balance: "800.00" });
    expect((await fixture.db.query<Record<string, unknown>>("select to_jsonb(f) as value from public.student_fees f where id=$1", [A.fee])).rows[0].value).toEqual(fixture.originalFee);
  });
  it("reverses a full old closed-day payment as a negative current-day event", async () => {
    const change = await request("payment_reversal", null, A.payment), approved = await review(change.id);
    expect(approved.state).toBe("approved"); expect(approved.reference).toMatch(/^REV-/); expect(approved.effective_day).toBe(fixture.today);
    expect((await ledger()).rows[0]).toMatchObject({ net_amount: "900.00", paid_amount: "0.00", balance: "900.00" });
    expect((await fixture.db.query<Record<string, unknown>>("select to_jsonb(p) as value from public.fee_payments p where id=$1", [A.payment])).rows[0].value).toEqual(fixture.originalReceipt);
    const today = (await asStaffActor<{ value: Record<string, unknown> }>(fixture.db, accountantA, "select public.get_office_fee_day($1,$2) as value", [schoolA, fixture.today])).rows[0].value;
    expect(today).toMatchObject({ recorded_total: -100, recorded_cash: -100, receipt_count: 0, reversal_count: 1, invalid_count: 0 });
    const oldDay = (await asStaffActor<{ value: unknown }>(fixture.db, accountantA, "select public.get_office_fee_day($1,$2) as value", [schoolA, fixture.yesterday])).rows[0].value;
    expect(oldDay).toEqual(fixture.oldClosed);
  });

  it("recovers exact request and review retries without duplicate entries", async () => {
    const token = (await ledger()).rows[0].financial_token!, key = randomUUID();
    const pending = await request("additional_charge", "50.00", null, token, key);
    expect(await request("additional_charge", "50.00", null, token, key)).toEqual(pending);
    await expect(request("additional_charge", "51.00", null, token, key)).rejects.toMatchObject({ code: "23505" });
    await expect(request("additional_charge", "50.00", null, token, key, adminA)).rejects.toMatchObject({ code: "23505" });
    const approved = await review(pending.id);
    expect(await review(pending.id)).toEqual(approved);
    expect(await request("additional_charge", "50.00", null, token, key)).toEqual(approved);
    await expect(review(pending.id, "approved", "A different review reason")).rejects.toMatchObject({ code: "23505" });
    expect((await fixture.db.query<Record<string, unknown>>("select count(*)::int as count from app_private.office_fee_adjustment_entries where request_id=$1", [pending.id])).rows[0]).toEqual({ count: 1 });
  });

  it("detects a changed payment even when the original fee remains Partial", async () => {
    firstCurrentPayment = (await pay("200.00")).payment_id;
    const token = (await ledger()).rows[0].financial_token!, stale = await request("reduction", "50.00", null, token);
    const rawBefore = (await fixture.db.query<Record<string, unknown>>("select to_jsonb(f) as value from public.student_fees f where id=$1", [A.fee])).rows[0].value;
    await pay("50.00");
    expect((await fixture.db.query<Record<string, unknown>>("select to_jsonb(f) as value from public.student_fees f where id=$1", [A.fee])).rows[0].value).toEqual(rawBefore);
    await expect(review(stale.id)).rejects.toMatchObject({ code: "PT409" });
    const currentRequest = (await fixture.db.query<Record<string, unknown>>("select state,before_position,after_position from app_private.office_fee_change_requests where id=$1", [stale.id])).rows[0];
    expect(currentRequest).toMatchObject({ state: "pending", before_position: stale.before, after_position: stale.after });
    const countBefore = (await fixture.db.query<Record<string, unknown>>("select count(*)::int as count from app_private.office_fee_change_requests")).rows[0];
    await expect(request("additional_charge", "1.00", null, token)).rejects.toMatchObject({ code: "PT409" });
    expect((await fixture.db.query<Record<string, unknown>>("select count(*)::int as count from app_private.office_fee_change_requests")).rows[0]).toEqual(countBefore);
    await review(stale.id, "rejected");
    const fresh = await request("reduction", "50.00"); await review(fresh.id);
    expect((await ledger()).rows[0]).toMatchObject({ net_amount: "900.00", paid_amount: "250.00", balance: "650.00" });
  });

  it("collects an additional approved charge even when the stored demand had been Paid", async () => {
    await pay("650.00", "upi", "QA-SETTLEMENT");
    expect((await fixture.db.query<Record<string, unknown>>("select status from public.student_fees where id=$1", [A.fee])).rows[0]).toEqual({ status: "paid" });
    const debit = await request("additional_charge", "50.00"); await review(debit.id);
    expect((await ledger()).rows[0]).toMatchObject({ net_amount: "950.00", paid_amount: "900.00", balance: "50.00" });
    lastCashPayment = (await pay("50.00")).payment_id;
    expect((await ledger()).rows[0]).toMatchObject({ net_amount: "950.00", paid_amount: "950.00", balance: "0.00" });
    await expect(request("reduction", "0.01")).rejects.toMatchObject({ code: "22023" });
    await expect(pay("0.01")).rejects.toMatchObject({ code: "22023" });
  });

  it("rejects duplicate full reversals and reopens the effective balance without deleting its receipt", async () => {
    await expect(request("payment_reversal", null, A.payment)).rejects.toMatchObject({ code: "22023" });
    const original = (await fixture.db.query<Record<string, unknown>>("select to_jsonb(p) as value from public.fee_payments p where id=$1", [lastCashPayment])).rows[0].value;
    const pending = await request("payment_reversal", null, lastCashPayment), approved = await review(pending.id);
    expect(await review(pending.id)).toEqual(approved);
    expect((await fixture.db.query<Record<string, unknown>>("select to_jsonb(p) as value from public.fee_payments p where id=$1", [lastCashPayment])).rows[0].value).toEqual(original);
    expect((await ledger()).rows[0]).toMatchObject({ net_amount: "950.00", paid_amount: "900.00", balance: "50.00" });
  });

  it("keeps competing proposals pending when an earlier approval changes their frozen snapshot", async () => {
    const token = (await ledger()).rows[0].financial_token!, first = await request("reduction", "10.00", null, token), second = await request("additional_charge", "10.00", null, token);
    await review(first.id);
    await expect(review(second.id)).rejects.toMatchObject({ code: "PT409" });
    expect((await fixture.db.query<Record<string, unknown>>("select state from app_private.office_fee_change_requests where id=$1", [second.id])).rows[0]).toEqual({ state: "pending" });
    await review(second.id, "rejected");
  });

  it("requires a different authorized person rather than a role switch by the requester", async () => {
    const pending = await request("additional_charge", "1.00", null, undefined, randomUUID(), adminA);
    await expect(review(pending.id, "approved", "I approve my own request", adminA)).rejects.toMatchObject({ code: "42501" });
    await expect(review(pending.id, "approved", "Accountant attempted review", accountantA)).rejects.toMatchObject({ code: "42501" });
    await expect(review(pending.id, "approved", "Another school attempted review", adminB)).rejects.toMatchObject({ code: "42501" });
    await review(pending.id, "rejected");
  });

  it("returns canonical all/today/month event totals and original receipts with reversal references", async () => {
    const summary = (await asStaffActor<{ value: { collections: Record<string, string>; net_amount: string; paid_amount: string; balance: string } }>(fixture.db, accountantA, "select public.get_office_finance_summary($1) as value", [schoolA])).rows[0].value;
    expect(summary).toMatchObject({ net_amount: "940.00", paid_amount: "900.00", balance: "40.00" });
    expect(summary.collections).toMatchObject({ gross_amount: "1050.00", reversal_amount: "150.00", net_amount: "900.00", today_gross: "950.00", today_reversal: "150.00", today_net: "800.00" });
    const receipts = (await asStaffActor<{ value: { rows: Record<string, unknown>[]; count: number } }>(fixture.db, accountantA, "select public.list_office_fee_receipts($1,null,200,0) as value", [schoolA])).rows[0].value;
    const original = receipts.rows.find((row) => row.id === A.payment)!;
    expect(original).toMatchObject({ amount: "100.00", recorded_status: "paid", status: "reversed", reversed_amount: "100.00", net_amount: "0.00" });
    expect(String(original.reversal_reference)).toMatch(/^REV-/);
    expect(original.financial_token).toBe((await ledger()).rows[0].financial_token);
  });

  it("limits canonical family balances and receipt history to the own or linked pupil without internal notes", async () => {
    for (const actor of [parentA, studentA]) {
      const family = (await asStaffActor<{ value: Ledger }>(fixture.db, actor, "select public.get_family_fee_ledger($1,30,0) as value", [A.student])).rows[0].value;
      expect(family.rows[0]).toMatchObject({ net_amount: "940.00", paid_amount: "900.00", balance: "40.00" });
      for (const row of family.rows) for (const key of ["financial_token", "reason", "source_reference", "request_reason", "review_reason"]) expect(row).not.toHaveProperty(key);
      const receipts = (await asStaffActor<{ value: { rows: Record<string, unknown>[] } }>(fixture.db, actor, "select public.list_family_fee_receipts($1,30,0) as value", [A.student])).rows[0].value.rows;
      expect(receipts.find((row) => row.id === A.payment)).toMatchObject({ amount: "100.00", status: "reversed", net_amount: "0.00" });
      for (const row of receipts) for (const key of ["financial_token", "request_reason", "review_reason", "reviewer_name", "requester_name"]) expect(row).not.toHaveProperty(key);
      for (const foreign of [STAFF_ROWS.B.student, STAFF_ROWS.privateStudentA]) {
        await expect(asStaffActor(fixture.db, actor, "select public.get_family_fee_ledger($1,30,0)", [foreign])).rejects.toMatchObject({ code: "42501" });
        await expect(asStaffActor(fixture.db, actor, "select public.list_family_fee_receipts($1,30,0)", [foreign])).rejects.toMatchObject({ code: "42501" });
      }
    }
  });

  it("revokes family receipt and balance access immediately with the guardian link", async () => {
    await fixture.db.query<Record<string, unknown>>("delete from public.student_parents where student_id=$1 and parent_id=$2", [A.student, A.parent]);
    await expect(asStaffActor(fixture.db, parentA, "select public.get_family_fee_ledger($1,30,0)", [A.student])).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(fixture.db, parentA, "select public.list_family_fee_receipts($1,30,0)", [A.student])).rejects.toMatchObject({ code: "42501" });
    await fixture.db.query<Record<string, unknown>>("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [A.student, A.parent]);
    await fixture.db.query<Record<string, unknown>>("update public.profiles set is_active=false where id=$1", [parentA]);
    await expect(asStaffActor(fixture.db, parentA, "select public.get_family_fee_ledger($1,30,0)", [A.student])).rejects.toMatchObject({ code: "42501" });
    await fixture.db.query<Record<string, unknown>>("update public.profiles set is_active=true where id=$1", [parentA]);
  });

  it("fails closed on a legacy refund without replaying it as a new reversal", async () => {
    const pending = await request("payment_reversal", null, firstCurrentPayment);
    const legacy = randomUUID();
    await fixture.db.query<Record<string, unknown>>("insert into public.fee_refunds(id,school_id,payment_id,amount,reason) values($1,$2,$3,3,'Legacy fixture only')", [legacy, schoolA, firstCurrentPayment]);
    await expect(review(pending.id)).rejects.toMatchObject({ code: "PT409" });
    const internal = (await fixture.db.query<{ value: { financial_token: string } }>("select app_private.office_fee_financial_state($1,$2) as value", [schoolA, A.fee])).rows[0].value;
    await expect(request("payment_reversal", null, firstCurrentPayment, internal.financial_token)).rejects.toMatchObject({ code: "22023" });
    expect((await fixture.db.query<Record<string, unknown>>("select count(*)::int as count from app_private.office_fee_payment_reversals where payment_id=$1", [firstCurrentPayment])).rows[0]).toEqual({ count: 0 });
    expect((await ledger()).summary).toMatchObject({ invalid_count: 1, net_amount: null, balance: null });
    const summary = (await asStaffActor<{ value: { collections: Record<string, unknown> } }>(fixture.db, accountantA, "select public.get_office_finance_summary($1) as value", [schoolA])).rows[0].value;
    expect(summary.collections).toMatchObject({ net_amount: null, today_net: null, month_net: null });
    const currentDay = (await asStaffActor<{ value: { invalid_count: number; revision: number } }>(fixture.db, accountantA, "select public.get_office_fee_day($1,$2) as value", [schoolA, fixture.today])).rows[0].value;
    expect(currentDay.invalid_count).toBeGreaterThan(0);
    await expect(asStaffActor(fixture.db, accountantA, "select public.close_office_fee_day($1,$2,$3,0,'Legacy refund needs reconciliation')", [schoolA, fixture.today, currentDay.revision])).rejects.toMatchObject({ code: "22023" });
    await review(pending.id, "rejected");
    expect((await fixture.db.query<Record<string, unknown>>("select amount from public.fee_refunds where id=$1", [legacy])).rows[0]).toEqual({ amount: "3.00" });
    await fixture.db.query<Record<string, unknown>>("delete from public.fee_refunds where id=$1", [legacy]);
  });

  it("keeps billed structure identity fixed while allowing future price changes", async () => {
    await fixture.db.query<Record<string, unknown>>("insert into public.academic_years(id,school_id,name,start_date,end_date,is_current) values($1,$2,'Next','2027-04-01','2028-03-31',false)", ["30000000-0000-0000-0000-000000000001", schoolA]);
    const before = (await ledger()).rows[0];
    for (const [column, value] of [["school_id", schoolB], ["academic_year_id", "30000000-0000-0000-0000-000000000001"], ["class_id", STAFF_ROWS.privateClassA]]) {
      await expect(asStaffActor(fixture.db, adminA, `update public.fee_structures set ${column}=$1 where id=$2`, [value, A.structure])).rejects.toMatchObject({ code: "42501" });
    }
    await asStaffActor(fixture.db, adminA, "update public.fee_structures set school_id=school_id,academic_year_id=academic_year_id,class_id=class_id,amount=1200 where id=$1", [A.structure]);
    expect((await ledger()).rows[0]).toEqual(before);
  });

  it("denies unauthorized roles, raw private writes and anonymous RPC execution", async () => {
    for (const actor of [parentA, studentA, teacherA, receptionA, adminB]) {
      await expect(asStaffActor(fixture.db, actor, "select public.get_office_finance_summary($1)", [schoolA])).rejects.toMatchObject({ code: "42501" });
      await expect(asStaffActor(fixture.db, actor, "select public.list_office_fee_changes($1,'all',50,0)", [schoolA])).rejects.toMatchObject({ code: "42501" });
    }
    for (const table of ["office_fee_change_requests", "office_fee_adjustment_entries", "office_fee_payment_reversals"]) {
      await expect(asStaffActor(fixture.db, adminA, `select * from app_private.${table}`)).rejects.toMatchObject({ code: "42501" });
      await expect(asStaffActor(fixture.db, adminA, `delete from app_private.${table}`)).rejects.toMatchObject({ code: "42501" });
    }
    await expect(asStaffActor(fixture.db, null, "select public.get_office_finance_summary($1)", [schoolA], "anon")).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(fixture.db, parentA, "select app_private.office_fee_financial_state($1,$2)", [schoolA, A.fee])).rejects.toMatchObject({ code: "42501" });
    expect((await fixture.db.query<Record<string, unknown>>("select to_jsonb(p) as value from public.fee_payments p where id=$1", [A.payment])).rows[0].value).toEqual(fixture.originalReceipt);
  });

  it("bounds malformed amounts and financial history pagination", async () => {
    for (const value of ["0", "-1", "1.001", "NaN", "Infinity", "10000000000"]) await expect(request("additional_charge", value)).rejects.toMatchObject({ code: "22023" });
    await expect(request("payment_reversal", "1.00", firstCurrentPayment)).rejects.toMatchObject({ code: "22023" });
    await expect(request("reduction", "1.00", firstCurrentPayment)).rejects.toMatchObject({ code: "22023" });
    await expect(asStaffActor(fixture.db, accountantA, "select public.list_office_fee_changes($1,'all',101,0)", [schoolA])).rejects.toMatchObject({ code: "22023" });
    await expect(asStaffActor(fixture.db, parentA, "select public.list_family_fee_receipts($1,101,0)", [A.student])).rejects.toMatchObject({ code: "22023" });
  });

  it("keeps a forged legacy receipt source out of family history and marks the office record unreconciled", async () => {
    const family = async () => (await asStaffActor<{ value: { rows: { id: string }[] } }>(fixture.db, parentA, "select public.list_family_fee_receipts($1,30,0) as value", [A.student])).rows[0].value.rows;
    const before = await family(), forged = randomUUID();
    await fixture.db.query<Record<string, unknown>>("insert into public.fee_payments(id,school_id,student_fee_id,student_id,receipt_no,amount,payment_method,status,paid_at) values($1,$2,$3,$4,'FORGED-GOVERNED-READ',5,'cash','paid',clock_timestamp())", [forged, schoolA, STAFF_ROWS.B.fee, A.student]);
    expect(await family()).toEqual(before);
    const office = (await asStaffActor<{ value: { rows: Record<string, unknown>[] } }>(fixture.db, accountantA, "select public.list_office_fee_receipts($1,null,200,0) as value", [schoolA])).rows[0].value.rows;
    expect(office.find((row) => row.id === forged)).toMatchObject({ amount: "5.00", status: "review_required", net_amount: null, financial_token: null });
    const totals = (await asStaffActor<{ value: { invalid_count: number; collections: Record<string, unknown> } }>(fixture.db, accountantA, "select public.get_office_finance_summary($1) as value", [schoolA])).rows[0].value;
    expect(totals.invalid_count).toBeGreaterThan(0); expect(totals.collections.net_amount).toBeNull();
    const currentDay = (await asStaffActor<{ value: { invalid_count: number; revision: number } }>(fixture.db, accountantA, "select public.get_office_fee_day($1,$2) as value", [schoolA, fixture.today])).rows[0].value;
    expect(currentDay.invalid_count).toBeGreaterThan(0);
    await expect(asStaffActor(fixture.db, accountantA, "select public.close_office_fee_day($1,$2,$3,0,'Invalid original receipt mapping')", [schoolA, fixture.today, currentDay.revision])).rejects.toMatchObject({ code: "22023" });
    await fixture.db.query<Record<string, unknown>>("delete from public.fee_payments where id=$1", [forged]);
    expect(await family()).toEqual(before);
  });

  it("fully reduces an unpaid demand to zero without inventing a payment or replaying dormant discounts", async () => {
    const fee = (await asStaffActor<{ id: string }>(fixture.db, accountantA, "select public.issue_office_fee_demand($1,$2,$3,'2026-12','2026-12-20') as id", [schoolA, A.student, A.structure])).rows[0].id;
    const before = (await ledger()).rows.find((row) => row.demand_id === fee)!;
    const paidRows = (await fixture.db.query<Record<string, unknown>>("select id from public.fee_payments order by id")).rows;
    const change = (await asStaffActor<{ value: Change }>(fixture.db, accountantA, "select public.request_office_fee_change($1,$2,'reduction',1200,null,'Reviewed full fee concession',$3,$4) as value", [schoolA, fee, before.financial_token, randomUUID()])).rows[0].value;
    await review(change.id);
    expect((await ledger()).rows.find((row) => row.demand_id === fee)).toMatchObject({ amount: "1200.00", net_amount: "0.00", paid_amount: "0", balance: "0.00", status: "paid" });
    expect((await fixture.db.query<Record<string, unknown>>("select id from public.fee_payments order by id")).rows).toEqual(paidRows);
    expect((await fixture.db.query<Record<string, unknown>>("select count(*)::int as count from public.fee_discounts")).rows[0]).toEqual({ count: 0 });
    expect((await fixture.db.query<Record<string, unknown>>("select count(*)::int as count from public.fee_refunds")).rows[0]).toEqual({ count: 0 });
  });
});
