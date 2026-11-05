// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCreditDatabase, type CreditFixture, type Change, type Credit } from "./advance-credit-fixture";
import { asStaffActor, STAFF_IDS, STAFF_ROWS } from "./staff-scope-fixture";

describe("credit authorization, fresh-state checks and immutable history", () => {
  let f: CreditFixture;
  beforeAll(async () => { f = await createCreditDatabase(); }, 30000);
  afterAll(async () => { await f?.db.close(); });
  it("preserves old fee fingerprints until a real allocation affects that fee", async () => {
    expect((await f.ledger()).rows[0].financial_token).toBe(f.preCreditToken);
    await f.receipt("1000.00");
    expect((await f.ledger()).rows[0].financial_token).toBe(f.preCreditToken);
  });
  it("rejects invalid money, printable proof, reason and cross-pupil allocation inputs", async () => {
    for (const amount of ["0", "-1", "1.001", "NaN", "Infinity", "10000000000"])
      await expect(f.receipt(amount)).rejects.toMatchObject({ code: "22023" });
    for (const reference of ["", "aa", "line\nbreak", "x".repeat(121)]) await expect(f.receipt("1", reference)).rejects.toMatchObject({ code: "22023" });
    await expect(f.value("select public.record_office_credit_receipt($1,$2,1,'cash','PROOF','no',$3) as value", [STAFF_IDS.schoolA, STAFF_ROWS.A.student, randomUUID()])).rejects.toMatchObject({ code: "22023" });
    await expect(f.value("select public.allocate_office_credit($1,$2,$3,1,$4,$5,'Coherent allocation attempt',$6) as value", [STAFF_IDS.schoolA, STAFF_ROWS.A.student, STAFF_ROWS.B.fee, (await f.credit()).financial_token, (await f.ledger()).rows[0].financial_token, randomUUID()])).rejects.toMatchObject({ code: "42501" });
  });
  it("ties request retries to the original actor and immutable payload", async () => {
    const id = randomUUID(), token = (await f.credit()).financial_token;
    const args = [STAFF_IDS.schoolA, STAFF_ROWS.A.student, "refund", null, "10.00", token, null, "Identical refund request reason", id];
    const sql = "select public.request_office_credit_change($1,$2,$3,$4,$5,$6,$7,$8,$9) as value";
    const pending = await f.value<Change>(sql, args);
    expect(await f.value<Change>(sql, args)).toEqual(pending);
    await expect(f.value(sql, args, STAFF_IDS.adminA)).rejects.toMatchObject({ code: "23505" });
    await expect(f.value(sql, [...args.slice(0, 4), "11.00", ...args.slice(5)])).rejects.toMatchObject({ code: "23505" });
    await f.review(id, "rejected");
    expect((await f.value<Change>(sql, args)).state).toBe("rejected");
    const own = await f.request("refund", "10.00", null, randomUUID(), STAFF_IDS.principalA);
    await expect(f.review(own.id)).rejects.toMatchObject({ code: "42501" });
    await f.review(own.id, "rejected", STAFF_IDS.adminA);
  });
  it("detects a payment changing only the fee snapshot before an allocation return approval", async () => {
    const allocation = await f.allocate("100.00"), req = await f.request("allocation_return", "10.00", allocation.id);
    await f.db.query("update public.student_fees set status='partial' where id=$1", [STAFF_ROWS.A.fee]);
    const rawBefore = (await f.db.query<{ status: string }>("select status from public.student_fees where id=$1", [STAFF_ROWS.A.fee])).rows[0];
    await f.value("select public.record_office_fee_payment($1,$2,50,'cash',$3,null) as value", [STAFF_IDS.schoolA, STAFF_ROWS.A.fee, randomUUID()]);
    expect((await f.db.query<{ status: string }>("select status from public.student_fees where id=$1", [STAFF_ROWS.A.fee])).rows[0]).toEqual({ status: "partial" });
    expect(rawBefore.status).toBe("partial");
    await expect(f.review(req.id)).rejects.toMatchObject({ code: "PT409" });
    expect((await f.db.query<{ state: string }>("select state from app_private.office_credit_change_requests where id=$1", [req.id])).rows[0].state).toBe("pending");
    await f.review(req.id, "rejected");
    const fresh = await f.request("allocation_return", "10.00", allocation.id); await f.review(fresh.id);
    expect((await f.ledger()).rows[0]).toMatchObject({ paid_amount: "240.00", advance_applied_amount: "90.00" });
  });
  it("keeps ordinary payment reversals isolated from the credit liability", async () => {
    const before = await f.credit(), token = (await f.ledger()).rows[0].financial_token;
    const req = await f.value<{ id: string }>("select public.request_office_fee_change($1,$2,'payment_reversal',null,$3,'Ordinary receipt book correction',$4,$5) as value", [STAFF_IDS.schoolA, STAFF_ROWS.A.fee, STAFF_ROWS.A.payment, token, randomUUID()]);
    await f.value("select public.review_office_fee_change($1,'approved','Independently verified ordinary payment') as value", [req.id], STAFF_IDS.principalA);
    expect(await f.credit()).toEqual(before);
    expect((await f.ledger()).rows[0]).toMatchObject({ paid_amount: "140.00", advance_applied_amount: "90.00" });
    expect(await f.day(f.legacyDay)).toEqual(f.oldClosed);
  });
  it("retains live link authorization and paginates activity separately from full totals", async () => {
    const first = await f.value<Credit>("select public.get_family_student_credit($1,1,0) as value", [STAFF_ROWS.A.student], STAFF_IDS.parentA);
    const second = await f.value<Credit>("select public.get_family_student_credit($1,1,1) as value", [STAFF_ROWS.A.student], STAFF_IDS.studentA);
    expect(first.activities).toHaveLength(1); expect(second.activities).toHaveLength(1);
    expect(first.activities[0].id).not.toBe(second.activities[0].id); expect(first.summary).toEqual(second.summary);
    await f.db.query("delete from public.student_parents where student_id=$1 and parent_id=$2", [STAFF_ROWS.A.student, STAFF_ROWS.A.parent]);
    await expect(f.value("select public.get_family_student_credit($1) as value", [STAFF_ROWS.A.student], STAFF_IDS.parentA)).rejects.toMatchObject({ code: "42501" });
    expect((await f.value<Credit>("select public.get_family_student_credit($1) as value", [STAFF_ROWS.A.student], STAFF_IDS.studentA)).summary).toEqual(first.summary);
  });
  it("denies anonymous and all direct private table/function access; entries cannot be mutated", async () => {
    for (const table of ["office_student_credit_accounts", "office_student_credit_entries", "office_credit_change_requests"]) {
      for (const role of [STAFF_IDS.adminA, STAFF_IDS.parentA]) {
        await expect(asStaffActor(f.db, role, `select * from app_private.${table}`)).rejects.toMatchObject({ code: "42501" });
        await expect(asStaffActor(f.db, role, `delete from app_private.${table}`)).rejects.toMatchObject({ code: "42501" });
      }
      const acl = (await f.db.query<{ authenticated: boolean; anon: boolean; service: boolean; rls: boolean }>("select has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE,SELECT') as authenticated,has_table_privilege('anon',c.oid,'INSERT,UPDATE,DELETE,SELECT') as anon,has_table_privilege('service_role',c.oid,'INSERT,UPDATE,DELETE,SELECT') as service,c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app_private' and c.relname=$1", [table])).rows[0];
      expect(acl).toEqual({ authenticated: false, anon: false, service: false, rls: true });
    }
    await expect(asStaffActor(f.db, STAFF_IDS.parentA, "select app_private.office_student_credit_state($1,$2)", [STAFF_IDS.schoolA, STAFF_ROWS.A.student])).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(f.db, null, "select public.get_office_student_credit($1,$2)", [STAFF_IDS.schoolA, STAFF_ROWS.A.student], "anon")).rejects.toMatchObject({ code: "42501" });
    for (const mutation of ["update app_private.office_student_credit_entries set amount=1", "delete from app_private.office_student_credit_entries"]) {
      await f.db.exec("begin");
      await f.db.query("select set_config('request.jwt.claim.sub',$1,true)", [STAFF_IDS.adminA]);
      await expect(f.db.exec(mutation)).rejects.toMatchObject({ code: "42501" });
      await f.db.exec("rollback");
    }
    const fresh = (await f.db.query<{ proname: string; provolatile: string }>("select proname,provolatile from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' and proname in ('locked_office_student_credit_state','locked_office_fee_financial_state')")).rows;
    expect(fresh).toHaveLength(2); expect(fresh.every((row) => row.provolatile === "v")).toBe(true);
  });
});

describe("trusted corrupt credit source is withheld from family and financial totals", () => {
  let f: CreditFixture;
  beforeAll(async () => { f = await createCreditDatabase(); }, 30000);
  afterAll(async () => { await f?.db.close(); });
  it("excludes an incoherent pupil-to-fee activity and marks an underfunded fee unreconciled", async () => {
    const bad = randomUUID(), underfunded = randomUUID();
    for (const [id, fee, ref] of [[bad, STAFF_ROWS.B.fee, "BAD-SCOPE"], [underfunded, STAFF_ROWS.A.fee, "NO-FUNDING"]]) {
      await f.db.query("insert into app_private.office_student_credit_entries(id,school_id,student_id,kind,amount,reference,fee_id,actor_id,actor_name,reason,intent) values($1,$2,$3,'allocation',5,$4,$5,$6,'Trusted corruption fixture','Source validation regression','{}')", [id, STAFF_IDS.schoolA, STAFF_ROWS.A.student, ref, fee, STAFF_IDS.accountantA]);
    }
    const own = await f.credit(); expect(own.summary).toMatchObject({ invalid: true, available_amount: null }); expect(own.financial_token).toBeNull();
    const family = await f.value<Credit>("select public.get_family_student_credit($1) as value", [STAFF_ROWS.A.student], STAFF_IDS.parentA);
    expect(family.activities.map((row) => row.id)).toEqual([underfunded]); expect(family.activity_count).toBe(1);
    expect((await f.ledger()).rows[0]).toMatchObject({ invalid: true, paid_amount: null, balance: null, financial_token: null });
    const summary = await f.value<{ paid_amount: string | null; invalid_count: number; advance: { invalid_count: number } }>("select public.get_office_finance_summary($1) as value", [STAFF_IDS.schoolA]);
    expect(summary.invalid_count).toBeGreaterThan(0); expect(summary.paid_amount).toBeNull(); expect(summary.advance.invalid_count).toBe(1);
  });
});
