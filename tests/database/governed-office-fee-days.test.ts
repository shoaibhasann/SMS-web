// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStaffActor, STAFF_IDS, STAFF_ROWS } from "./staff-scope-fixture";
import { createGovernedFeeDatabase, type GovernedFeeFixture } from "./governed-office-fees-fixture";

type Day = { revision: number; recorded_total: number; recorded_cash: number; invalid_count: number; closed_at: string | null; cash_variance: number; reversal_count?: number };
type Change = { id: string; state: string; reviewed_at: string | null; effective_day: string | null; entry_id: string | null };
const { schoolA, accountantA, principalA } = STAFF_IDS;
const { A } = STAFF_ROWS;
async function day(f: GovernedFeeFixture, date = f.today) {
  return (await asStaffActor<{ value: Day }>(f.db, accountantA, "select public.get_office_fee_day($1,$2) as value", [schoolA, date])).rows[0].value;
}
async function close(f: GovernedFeeFixture, count: string, note: string | null) {
  const current = await day(f);
  return (await asStaffActor<{ value: Day }>(f.db, accountantA, "select public.close_office_fee_day($1,$2,$3,$4,$5) as value", [schoolA, f.today, current.revision, count, note])).rows[0].value;
}
async function request(f: GovernedFeeFixture, kind = "payment_reversal", amount: string | null = null) {
  const ledger = (await asStaffActor<{ value: { rows: { financial_token: string }[] } }>(f.db, accountantA, "select public.get_office_fee_ledger($1,null,$2,50,0) as value", [schoolA, A.student])).rows[0].value;
  return (await asStaffActor<{ value: Change }>(f.db, accountantA, "select public.request_office_fee_change($1,$2,$3,$4,$5,'Verified cashbook correction',$6,$7) as value",
    [schoolA, A.fee, kind, amount, kind === "payment_reversal" ? A.payment : null, ledger.rows[0].financial_token, randomUUID()])).rows[0].value;
}
async function review(f: GovernedFeeFixture, id: string, decision = "approved") {
  return (await asStaffActor<{ value: Change }>(f.db, principalA, "select public.review_office_fee_change($1,$2,'Independently checked original receipt') as value", [id, decision])).rows[0].value;
}

describe("negative-only recorded-reversal business day", () => {
  let f: GovernedFeeFixture, approved: Change, pendingId: string, savedClose: Day;
  beforeAll(async () => { f = await createGovernedFeeDatabase({ previousMonth: true }); }, 30000);
  afterAll(async () => { await f?.db.close(); });

  it("attributes an old-month reversal to today's cashbook without rewriting either original evidence record", async () => {
    const pending = await request(f); pendingId = pending.id; approved = await review(f, pending.id);
    expect(approved.effective_day).toBe(f.today);
    expect(await day(f)).toMatchObject({ recorded_total: -100, recorded_cash: -100, invalid_count: 0, reversal_count: 1 });
    expect(await day(f, f.legacyDay)).toEqual(f.oldClosed);
    expect(await day(f, f.legacyDay)).not.toHaveProperty("reversal_count");
    expect((await f.db.query<Record<string, unknown>>("select to_jsonb(p) as value from public.fee_payments p where id=$1", [A.payment])).rows[0].value).toEqual(f.originalReceipt);
    const summary = (await asStaffActor<{ value: { collections: Record<string, unknown> } }>(f.db, accountantA, "select public.get_office_finance_summary($1) as value", [schoolA])).rows[0].value;
    expect(summary.collections).toMatchObject({ gross_amount: "100.00", reversal_amount: "100.00", net_amount: "0.00", today_gross: "0", today_reversal: "100.00", today_net: "-100.00", month_gross: "0", month_reversal: "100.00", month_net: "-100.00" });
  });

  it("closes a negative recorded-cash day using a nonnegative physical count and an explained variance", async () => {
    await expect(close(f, "0", null)).rejects.toMatchObject({ code: "22023" });
    await expect(close(f, "-100", "Negative count is not physical cash")).rejects.toMatchObject({ code: "22023" });
    savedClose = await close(f, "0", "Recorded reversal only; no physical cash refund was made");
    expect(savedClose).toMatchObject({ recorded_total: -100, recorded_cash: -100, counted_cash: 0, cash_variance: 100, invalid_count: 0 });
    expect(savedClose.closed_at).toBeTruthy();
    expect(await day(f)).toEqual(savedClose);
    expect(await day(f, f.legacyDay)).toEqual(f.oldClosed);
  });

  it("replays the review after day closing without another negative cash event", async () => {
    expect(await review(f, pendingId)).toEqual(approved);
    expect(await day(f)).toEqual(savedClose);
    expect((await f.db.query<Record<string, unknown>>("select count(*)::int as count from app_private.office_fee_payment_reversals")).rows[0]).toEqual({ count: 1 });
    await expect(asStaffActor(f.db, accountantA, "select public.record_office_fee_payment($1,$2,1,'cash',$3,null)", [schoolA, A.fee, randomUUID()])).rejects.toMatchObject({ code: "22023" });
    expect((await f.db.query<Record<string, unknown>>("select count(*)::int as count from public.fee_payments where school_id=$1", [schoolA])).rows[0]).toEqual({ count: 1 });
  });
});

describe("approval after the current business day closed", () => {
  let f: GovernedFeeFixture, pending: Change, closed: Day;
  beforeAll(async () => { f = await createGovernedFeeDatabase(); }, 30000);
  afterAll(async () => { await f?.db.close(); });

  it("leaves every request field and cashbook record unchanged when today's reversal is blocked", async () => {
    pending = await request(f);
    const before = (await f.db.query<Record<string, unknown>>("select to_jsonb(q) as value from app_private.office_fee_change_requests q where id=$1", [pending.id])).rows[0].value;
    closed = await close(f, "0", null);
    await expect(review(f, pending.id)).rejects.toMatchObject({ code: "22023" });
    expect((await f.db.query<Record<string, unknown>>("select to_jsonb(q) as value from app_private.office_fee_change_requests q where id=$1", [pending.id])).rows[0].value).toEqual(before);
    expect((await f.db.query<Record<string, unknown>>("select count(*)::int as count from app_private.office_fee_payment_reversals")).rows[0]).toEqual({ count: 0 });
    expect(await day(f)).toEqual(closed); expect(await day(f, f.legacyDay)).toEqual(f.oldClosed);
  });

  it("allows a charge-only adjustment on a closed cash day and rejects the now-outdated reversal proposal", async () => {
    const reduction = await request(f, "reduction", "50.00");
    expect((await review(f, reduction.id)).state).toBe("approved");
    expect(await day(f)).toEqual(closed);
    await expect(review(f, pending.id)).rejects.toMatchObject({ code: "PT409" });
    expect((await review(f, pending.id, "rejected")).state).toBe("rejected");
    expect((await f.db.query<Record<string, unknown>>("select to_jsonb(p) as value from public.fee_payments p where id=$1", [A.payment])).rows[0].value).toEqual(f.originalReceipt);
    expect(await day(f, f.legacyDay)).toEqual(f.oldClosed);
  });
});
