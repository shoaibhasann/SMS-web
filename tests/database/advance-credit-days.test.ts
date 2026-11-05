// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCreditDatabase, type CreditFixture, type Change } from "./advance-credit-fixture";
import { STAFF_IDS, STAFF_ROWS } from "./staff-scope-fixture";

describe("advance cashbook close and recorded receipt correction", () => {
  let f: CreditFixture;
  let refund: Change, reversal: Change, allocationReturn: Change;
  let receiptId: string, receiptProof: string, allocationId: string;
  let closed: Record<string, unknown>;
  beforeAll(async () => { f = await createCreditDatabase(); }, 30000);
  afterAll(async () => { await f?.db.close(); });
  it("supports full receipt correction with independent review and no fabricated payout", async () => {
    const row = await f.receipt("100.00");
    const request = await f.request("receipt_reversal", null, row.id);
    const approved = await f.review(request.id);
    expect(approved).toMatchObject({ state: "approved", effective_day: f.today });
    expect(approved.reference).toMatch(/^ADV-REV-/);
    expect(await f.review(request.id)).toEqual(approved);
    await expect(f.request("receipt_reversal", null, row.id)).rejects.toMatchObject({ code: "22023" });
    expect((await f.credit()).summary).toMatchObject({ received_amount: "100.00", reversed_amount: "100.00", refunded_amount: "0", balance_amount: "0.00" });
    expect(await f.day()).toMatchObject({ gross_total: 100, reversed_total: 100, refunded_total: 0, recorded_total: 0, receipt_count: 1, reversal_count: 1, refund_count: 0 });
  });
  it("closes a mixed real-money day and rejects later payout/correction without changing reservations", async () => {
    receiptId = randomUUID(); receiptProof = randomUUID(); await f.receipt("1000.00", receiptProof, receiptId);
    allocationId = (await f.allocate("600.00")).id;
    refund = await f.request("refund", "50.00"); await f.review(refund.id);
    const secondReceipt = await f.receipt("200.00");
    reversal = await f.request("receipt_reversal", null, secondReceipt.id);
    allocationReturn = await f.request("allocation_return", "100.00", allocationId);
    const day = await f.day();
    closed = await f.value("select public.close_office_fee_day($1,$2,$3,$4,null) as value", [STAFF_IDS.schoolA, f.today, day.revision, day.recorded_cash]);
    const before = await f.credit();
    const raw = (await f.db.query<{ value: unknown }>("select to_jsonb(q) as value from app_private.office_credit_change_requests q where id=$1", [refund.id])).rows[0].value;
    await expect(f.payout(refund.id)).rejects.toMatchObject({ code: "22023" });
    await expect(f.review(reversal.id)).rejects.toMatchObject({ code: "22023" });
    expect(await f.credit()).toEqual(before);
    expect((await f.db.query<{ value: unknown }>("select to_jsonb(q) as value from app_private.office_credit_change_requests q where id=$1", [refund.id])).rows[0].value).toEqual(raw);
    expect(await f.day()).toEqual(closed);
    expect((await f.db.query<{ state: string }>("select state from app_private.office_credit_change_requests where id=$1", [reversal.id])).rows[0].state).toBe("pending");
  });
  it("recovers receipt and allocation retries after close before checking the day", async () => {
    expect((await f.receipt("1000.00", receiptProof, receiptId)).id).toBe(receiptId);
    const intent = (await f.db.query<{ intent: { credit_token: string; fee_token: string } }>("select intent from app_private.office_student_credit_entries where id=$1", [allocationId])).rows[0].intent;
    expect((await f.allocate("600.00", allocationId, { credit: intent.credit_token, fee: intent.fee_token })).id).toBe(allocationId);
    expect(await f.day()).toEqual(closed);
    await expect(f.receipt("1.00")).rejects.toMatchObject({ code: "22023" });
  });
  it("permits noncash allocation return and reservation cancellation after close", async () => {
    expect((await f.review(allocationReturn.id)).state).toBe("approved");
    const cancelled = await f.value<Change>("select public.cancel_office_credit_refund($1,'Payout cancelled before money left') as value", [refund.id], STAFF_IDS.principalA);
    expect(cancelled.state).toBe("cancelled");
    expect((await f.credit()).summary).toMatchObject({ reserved_amount: "0", allocated_amount: "500.00", available_amount: "700.00" });
    expect(await f.day()).toEqual(closed); expect(await f.day(f.legacyDay)).toEqual(f.oldClosed);
  });
});

describe("negative-only advance correction day", () => {
  let f: CreditFixture;
  beforeAll(async () => { f = await createCreditDatabase(); }, 30000);
  afterAll(async () => { await f?.db.close(); });
  it("corrects a past closed advance on today and freezes both original close summaries", async () => {
    const id = randomUUID();
    // A trusted historical fixture, never a client write or hosted corruption.
    await f.db.exec("alter table app_private.office_student_credit_entries disable trigger guard_office_credit_cash_day");
    await f.db.query("insert into app_private.office_student_credit_accounts(school_id,student_id) values($1,$2)", [STAFF_IDS.schoolA, STAFF_ROWS.A.student]);
    await f.db.query("insert into app_private.office_student_credit_entries(id,school_id,student_id,kind,amount,reference,payment_method,actor_id,actor_name,reason,intent,occurred_at,business_date) values($1,$2,$3,'receipt',100,'OLD-ADVANCE-QA','cash',$4,'QA Accountant','Historical physical advance','{}',(($5::date-1)::timestamp at time zone 'Asia/Kolkata')+interval '10 hours',$5::date-1)", [id, STAFF_IDS.schoolA, STAFF_ROWS.A.student, STAFF_IDS.accountantA, f.yesterday]);
    await f.db.exec("alter table app_private.office_student_credit_entries enable trigger guard_office_credit_cash_day");
    const oldDate = (await f.db.query<{ day: string }>("select ($1::date-1)::text as day", [f.yesterday])).rows[0].day;
    const old = await f.day(oldDate), oldClosed = await f.value("select public.close_office_fee_day($1,$2,$3,100,null) as value", [STAFF_IDS.schoolA, oldDate, old.revision]);
    const request = await f.request("receipt_reversal", null, id), approved = await f.review(request.id);
    expect(approved.effective_day).toBe(f.today);
    expect(await f.day()).toMatchObject({ recorded_total: -100, recorded_cash: -100, receipt_count: 0, reversal_count: 1, refund_count: 0, invalid_count: 0 });
    const today = await f.day();
    await f.value("select public.close_office_fee_day($1,$2,$3,0,'Negative correction has no physical cash remaining') as value", [STAFF_IDS.schoolA, f.today, today.revision]);
    expect(await f.day(oldDate)).toEqual(oldClosed); expect(await f.day(f.legacyDay)).toEqual(f.oldClosed);
    expect((await f.credit()).summary).toMatchObject({ invalid: false, available_amount: "0.00", reversed_amount: "100.00", refunded_amount: "0" });
    const summary = await f.value<{ collections: Record<string, unknown> }>("select public.get_office_finance_summary($1) as value", [STAFF_IDS.schoolA]);
    expect(summary.collections).toMatchObject({ invalid_count: 0, today_net: "-100.00", refund_amount: "0", reversal_amount: "100.00" });
    expect(await f.review(request.id)).toEqual(approved);
  });
});
