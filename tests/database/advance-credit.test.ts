// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCreditDatabase, type CreditFixture, type Credit, type Change } from "./advance-credit-fixture";
import { STAFF_IDS, STAFF_ROWS } from "./staff-scope-fixture";

describe("office pupil advance credit and reviewed refunds", () => {
  let f: CreditFixture;
  let receiptId: string, allocationId: string;
  beforeAll(async () => { f = await createCreditDatabase(); }, 30000);
  afterAll(async () => { await f?.db.close(); });
  it("compiles the additive migration and starts with a valid zero liability", async () => {
    expect((await f.credit()).summary).toMatchObject({ invalid: false, available_amount: "0", received_amount: "0" });
    expect((await f.ledger()).rows[0]).toMatchObject({ net_amount: "1000.00", paid_amount: "100.00", balance: "900.00", advance_applied_amount: "0.00" });
    expect(await f.day(f.legacyDay)).toEqual(f.oldClosed);
  });
  it("records actual money once, with unique normalized proof and actor-bound retries", async () => {
    const key = randomUUID(), proof = "ADV-PHYSICAL-001", before = (await f.ledger()).rows[0].financial_token;
    const row = await f.receipt("1000.00", proof, key); receiptId = row.id;
    expect(await f.receipt("1000.00", proof, key)).toEqual(row);
    await expect(f.receipt("1001.00", proof, key)).rejects.toMatchObject({ code: "23505" });
    await expect(f.receipt("1000.00", proof, key, STAFF_IDS.adminA)).rejects.toMatchObject({ code: "23505" });
    await expect(f.receipt("1000.00", "  adv-physical-001  ")).rejects.toMatchObject({ code: "23505" });
    expect((await f.ledger()).rows[0].financial_token).toBe(before);
    expect((await f.credit()).summary).toMatchObject({ received_amount: "1000.00", available_amount: "1000.00", allocated_amount: "0" });
    expect(await f.day()).toMatchObject({ recorded_total: 1000, receipt_count: 1, advance_count: 1, advance_total: 1000, refund_count: 0 });
  });
  it("allocates without another cash receipt and changes canonical fee paid", async () => {
    const dayBefore = await f.day(), tokens = { credit: (await f.credit()).financial_token!, fee: (await f.ledger()).rows[0].financial_token! }, id = randomUUID();
    const row = await f.allocate("600.00", id, tokens); allocationId = row.id;
    expect(await f.allocate("600.00", id, tokens)).toEqual(row);
    expect(await f.day()).toEqual(dayBefore);
    expect((await f.ledger()).rows[0]).toMatchObject({ net_amount: "1000.00", paid_amount: "700.00", balance: "300.00", advance_applied_amount: "600.00" });
    expect((await f.credit()).summary).toMatchObject({ allocated_amount: "600.00", available_amount: "400.00" });
    await expect(f.allocate("1.00", randomUUID(), tokens)).rejects.toMatchObject({ code: "PT409" });
    await expect(f.allocate("401.00")).rejects.toMatchObject({ code: "22023" });
    expect((await f.db.query<{ count: number }>("select count(*)::int as count from public.fee_payments where school_id=$1", [STAFF_IDS.schoolA])).rows[0].count).toBe(1);
  });
  it("independently reserves a refund without paying cash; reservations cannot be spent", async () => {
    const before = await f.day(), req = await f.request("refund", "150.00");
    expect((await f.credit()).summary.reserved_amount).toBe("0");
    await expect(f.review(req.id, "approved", STAFF_IDS.accountantA)).rejects.toMatchObject({ code: "42501" });
    await expect(f.review(req.id, "approved", STAFF_IDS.adminB)).rejects.toMatchObject({ code: "42501" });
    const approved = await f.review(req.id);
    expect(approved).toMatchObject({ state: "approved", entry_id: null, reference: null, effective_day: null });
    expect((await f.credit()).summary).toMatchObject({ reserved_amount: "150.00", available_amount: "250.00", refunded_amount: "0" });
    expect(await f.day()).toEqual(before);
    await expect(f.allocate("251.00")).rejects.toMatchObject({ code: "22023" });
    const payoutId = randomUUID(), proof = "REFUND-PHYSICAL-001", paid = await f.payout(req.id, payoutId, proof);
    expect(paid).toMatchObject({ state: "paid", entry_id: payoutId, reference: proof, effective_day: f.today });
    expect(await f.payout(req.id, payoutId, proof)).toEqual(paid);
    expect(await f.review(req.id)).toEqual(paid);
    await expect(f.payout(req.id)).rejects.toMatchObject({ code: "22023" });
    expect((await f.credit()).summary).toMatchObject({ reserved_amount: "0", refunded_amount: "150.00", available_amount: "250.00" });
    expect(await f.day()).toMatchObject({ gross_total: 1000, refunded_total: 150, recorded_total: 850, receipt_count: 1, refund_count: 1 });
  });
  it("returns part of an allocation without cash and preserves immutable source history", async () => {
    const before = await f.day(), req = await f.request("allocation_return", "100.00", allocationId), approved = await f.review(req.id);
    expect(approved).toMatchObject({ state: "approved", effective_day: null });
    expect((await f.credit()).summary).toMatchObject({ allocated_amount: "500.00", available_amount: "350.00" });
    expect((await f.ledger()).rows[0]).toMatchObject({ paid_amount: "600.00", balance: "400.00", advance_applied_amount: "500.00" });
    expect(await f.day()).toEqual(before);
    await expect(f.request("allocation_return", "500.01", allocationId)).rejects.toMatchObject({ code: "22023" });
    const second = await f.request("refund", "100.00"); await f.review(second.id); await f.payout(second.id);
    expect((await f.credit()).summary).toMatchObject({ received_amount: "1000.00", allocated_amount: "500.00", refunded_amount: "250.00", available_amount: "250.00" });
    const summary = await f.value<{ collections: Record<string, string>; advance: Record<string, unknown>; paid_amount: string }>("select public.get_office_finance_summary($1) as value", [STAFF_IDS.schoolA]);
    expect(summary).toMatchObject({ paid_amount: "600.00", collections: { gross_amount: "1100.00", refund_amount: "250.00", net_amount: "850.00", today_net: "750.00" }, advance: { available_amount: "250.00" } });
    expect(await f.day(f.legacyDay)).toEqual(f.oldClosed);
    expect((await f.db.query<{ value: unknown }>("select to_jsonb(p) as value from public.fee_payments p where id=$1", [STAFF_ROWS.A.payment])).rows[0].value).toEqual(f.originalReceipt);
  });
  it("releases an unpaid reservation by an audited reviewer cancellation", async () => {
    const req = await f.request("refund", "50.00"); await f.review(req.id); const before = await f.day();
    const cancel = () => f.value<Change>("select public.cancel_office_credit_refund($1,'Original payout no longer required') as value", [req.id], STAFF_IDS.principalA);
    const cancelled = await cancel(); expect(cancelled.state).toBe("cancelled"); expect(await cancel()).toEqual(cancelled);
    expect(await f.review(req.id)).toEqual(cancelled);
    expect((await f.credit()).summary).toMatchObject({ reserved_amount: "0", available_amount: "250.00" });
    expect(await f.day()).toEqual(before); await expect(f.payout(req.id)).rejects.toMatchObject({ code: "22023" });
  });
  it("keeps stale credit proposals pending and permits rejection then a fresh request", async () => {
    const stale = await f.request("refund", "10.00"); await f.receipt("20.00");
    await expect(f.review(stale.id)).rejects.toMatchObject({ code: "PT409" });
    expect((await f.db.query<{ state: string }>("select state from app_private.office_credit_change_requests where id=$1", [stale.id])).rows[0].state).toBe("pending");
    expect((await f.review(stale.id, "rejected")).state).toBe("rejected");
  });
  it("exposes only family-safe own activities and enforces role and school scope", async () => {
    const family = await f.value<Credit>("select public.get_family_student_credit($1) as value", [STAFF_ROWS.A.student], STAFF_IDS.parentA);
    expect(family).not.toHaveProperty("financial_token"); expect(family.summary).toEqual((await f.credit()).summary);
    const keys = ["id", "kind", "amount", "reference", "occurred_at", "payment_method", "fee_id", "fee_name", "related_reference"].sort();
    for (const row of family.activities) expect(Object.keys(row).sort()).toEqual(keys);
    await expect(f.value("select public.get_family_student_credit($1) as value", [STAFF_ROWS.B.student], STAFF_IDS.parentA)).rejects.toMatchObject({ code: "42501" });
    await expect(f.value("select public.get_office_student_credit($1,$2) as value", [STAFF_IDS.schoolA, STAFF_ROWS.A.student], STAFF_IDS.teacherA)).rejects.toMatchObject({ code: "42501" });
    await expect(f.value("select public.get_office_student_credit($1,$2) as value", [STAFF_IDS.schoolB, STAFF_ROWS.B.student], STAFF_IDS.accountantA)).rejects.toMatchObject({ code: "42501" });
    await expect(f.value("select public.record_office_credit_receipt($1,$2,1,'cash','FORBIDDEN','Wrong office actor',$3) as value", [STAFF_IDS.schoolA, STAFF_ROWS.A.student, randomUUID()], STAFF_IDS.parentA)).rejects.toMatchObject({ code: "42501" });
  });
  it("cannot reverse an allocated receipt unless all of its original value is available", async () => {
    await expect(f.request("receipt_reversal", null, receiptId)).rejects.toMatchObject({ code: "22023" });
  });
});
