// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS, STAFF_ROWS } from "./staff-scope-fixture";

type Database = Awaited<ReturnType<typeof createStaffScopeDatabase>>;
type Receipt = { payment_id: string; receipt_no: string };

describe("office fee collection", () => {
  let db: Database;
  const { schoolA, schoolB, adminA, accountantA, principalA, parentA, mixedParent, receptionA } = STAFF_IDS;
  const { A, B } = STAFF_ROWS;

  beforeAll(async () => {
    db = await createStaffScopeDatabase();
    const directory = new URL("../../supabase/migrations/", import.meta.url);
    const matches = (await readdir(directory)).filter((name) => name.endsWith("_record_office_fee_payment.sql"));
    expect(matches).toHaveLength(1);
    await db.exec(await readFile(new URL(matches[0], directory), "utf8"));
  }, 30000);

  afterAll(async () => { await db?.close(); });

  async function issue(period: string, due: string | null = null, student: string = A.student, actor: string = principalA) {
    const result = await asStaffActor<{ id: string }>(db, actor,
      "select public.issue_office_fee_demand($1,$2,$3,$4,$5) as id",
      [schoolA, student, A.structure, period, due],
    );
    return result.rows[0].id;
  }

  async function pay({
    actor = accountantA, school = schoolA, fee = A.fee, amount = "50",
    request = randomUUID(), method = "cash", reference = null,
  }: { actor?: string; school?: string; fee?: string; amount?: string; request?: string; method?: string; reference?: string | null } = {}) {
    const result = await asStaffActor<{ receipt: Receipt }>(db, actor,
      "select public.record_office_fee_payment($1,$2,$3,$4,$5,$6) as receipt",
      [school, fee, amount, method, request, reference],
    );
    return result.rows[0].receipt;
  }

  it("issues one demand per current-year student, structure and month and reuses it on retry", async () => {
    const first = await issue("2026-11", "2026-11-20");
    expect(await issue("2026-11", "2026-11-20")).toBe(first);
    expect((await db.query("select amount,status,due_date::text from public.student_fees where id=$1", [first])).rows)
      .toEqual([{ amount: "1000.00", status: "pending", due_date: "2026-11-20" }]);
    await expect(issue("2026-11", "2026-11-21")).rejects.toMatchObject({ code: "23505" });
    await expect(issue("2026-03")).rejects.toMatchObject({ code: "22023" });
    await expect(issue("2027-04")).rejects.toMatchObject({ code: "22023" });
    await expect(issue("2026-12", null, B.student)).rejects.toMatchObject({ code: "22023" });
    await expect(issue("2026-12", null, STAFF_ROWS.privateStudentA)).rejects.toMatchObject({ code: "22023" });
    await expect(issue("2026-12", null, A.student, receptionA)).rejects.toMatchObject({ code: "42501" });
  });

  it("keeps legacy receipts in the balance and settles with partial and full payments", async () => {
    const request = randomUUID();
    const receipt = await pay({ amount: "250.25", request });
    expect(receipt.receipt_no).toMatch(/^RCPT-[0-9A-F]{32}$/);
    expect((await db.query("select status from public.student_fees where id=$1", [A.fee])).rows)
      .toEqual([{ status: "partial" }]);
    expect(await pay({ amount: "250.25", request })).toEqual(receipt);
    await expect(pay({ amount: "250.26", request })).rejects.toMatchObject({ code: "23505" });
    await expect(pay({ amount: "649.76" })).rejects.toMatchObject({ code: "22023" });

    await pay({ actor: adminA, amount: "649.75", method: "upi", reference: " QA-UPI-01 " });
    expect((await db.query("select status from public.student_fees where id=$1", [A.fee])).rows)
      .toEqual([{ status: "paid" }]);
    expect(await pay({ amount: "250.25", request })).toEqual(receipt);
    await expect(pay({ amount: "0.01" })).rejects.toMatchObject({ code: "22023" });
    const { rows } = await db.query(
      "select amount,transaction_id,recorded_by from public.fee_payments where student_fee_id=$1 order by amount",
      [A.fee],
    );
    expect(rows).toEqual([
      { amount: "100.00", transaction_id: null, recorded_by: null },
      { amount: "250.25", transaction_id: null, recorded_by: accountantA },
      { amount: "649.75", transaction_id: "QA-UPI-01", recorded_by: adminA },
    ]);
    const familyReceipts = await asStaffActor(db, parentA,
      "select id from public.fee_payments where student_fee_id=$1", [A.fee]);
    expect(familyReceipts.rows).toHaveLength(3);
  });

  it("denies cross-school roles, unsafe inputs and direct writes to the ledger", async () => {
    await expect(pay({ school: schoolB, fee: B.fee })).rejects.toMatchObject({ code: "42501" });
    await expect(pay({ fee: B.fee })).rejects.toMatchObject({ code: "42501" });
    await expect(pay({ actor: mixedParent, school: schoolB, fee: B.fee })).rejects.toMatchObject({ code: "42501" });
    await expect(pay({ actor: parentA })).rejects.toMatchObject({ code: "42501" });
    await expect(pay({ actor: receptionA })).rejects.toMatchObject({ code: "42501" });
    await expect(pay({ amount: "1.001" })).rejects.toMatchObject({ code: "22023" });
    await expect(pay({ amount: "NaN" })).rejects.toMatchObject({ code: "22023" });
    await expect(pay({ method: "bank_transfer" })).rejects.toMatchObject({ code: "22023" });
    await expect(asStaffActor(db, null,
      "select public.record_office_fee_payment($1,$2,1,'cash',$3)", [schoolA, A.fee, randomUUID()], "anon"))
      .rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, adminA, "update public.student_fees set amount = 0 where id=$1", [A.fee]))
      .rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, adminA, "delete from public.fee_payments where id=$1", [A.payment]))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("rolls back the receipt and allocation when the demand update fails", async () => {
    const fee = await issue("2026-12");
    const request = randomUUID();
    await db.exec(`
      create function app_private.fail_fee_status_update() returns trigger language plpgsql
      as $$ begin raise exception 'Synthetic fee update failure'; end; $$;
      create trigger fail_fee_status_update before update on public.student_fees
      for each row execute function app_private.fail_fee_status_update();
    `);
    try {
      await expect(pay({ fee, request })).rejects.toThrow("Synthetic fee update failure");
      expect((await db.query("select id from public.fee_payments where office_request_id=$1", [request])).rows).toEqual([]);
      expect((await db.query("select status from public.student_fees where id=$1", [fee])).rows)
        .toEqual([{ status: "pending" }]);
    } finally {
      await db.exec("drop trigger fail_fee_status_update on public.student_fees");
    }
    const receipt = await pay({ fee, request });
    expect(await pay({ fee, request })).toEqual(receipt);
  });
});
