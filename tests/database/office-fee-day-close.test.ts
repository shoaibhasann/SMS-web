// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS, STAFF_ROWS } from "./staff-scope-fixture";

type Database = Awaited<ReturnType<typeof createStaffScopeDatabase>>;
type Day = {
  business_date: string; revision: number; receipt_count: number; recorded_total: number; recorded_cash: number;
  closed_at: string | null; counted_cash: number | null; cash_variance: number | null; variance_note: string | null;
  methods: { method: string; receipt_count: number; total: number }[];
};
type Receipt = { payment_id: string; receipt_no: string };

describe("office fee day close", () => {
  const { schoolA, schoolB, adminA, accountantA, adminB, parentA } = STAFF_IDS;
  const { A, B } = STAFF_ROWS;
  const day = "2026-10-15";
  let db: Database;

  beforeAll(async () => {
    db = await createStaffScopeDatabase();
    const directory = new URL("../../supabase/migrations/", import.meta.url);
    const files = await readdir(directory);
    for (const suffix of ["_record_office_fee_payment.sql", "_close_office_fee_day.sql"]) {
      const matches = files.filter((name) => name.endsWith(suffix));
      expect(matches).toHaveLength(1);
      await db.exec(await readFile(new URL(matches[0], directory), "utf8"));
    }
    await db.query("update public.fee_payments set payment_method='cash',paid_at='2026-10-15 18:29:59+00' where id=$1", [A.payment]);
    await db.query("update public.fee_payments set payment_method='cash',paid_at='2026-10-15 18:29:59+00' where id=$1", [B.payment]);
    await importPayment("120.00", "upi", "2026-10-14 18:30:00+00", "paid");
    await importPayment("120.00", "cash", "2026-10-15 18:30:00+00", "paid");
    await importPayment("120.00", "cash", "2026-10-15 10:00:00+00", "pending");
  }, 30000);

  afterAll(async () => { await db?.close(); });

  async function importPayment(amount: string, method: string, date: string, status: string) {
    return db.query(`
      insert into public.fee_payments
      (school_id,student_fee_id,student_id,receipt_no,amount,payment_method,paid_at,status)
      values ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [schoolA, A.fee, A.student, randomUUID(), amount, method, date, status]);
  }

  async function read({ actor = adminA, school = schoolA, date = day }: { actor?: string; school?: string; date?: string } = {}) {
    const { rows } = await asStaffActor<{ day: Day }>(
      db, actor, "select public.get_office_fee_day($1,$2) as day", [school, date],
    );
    return rows[0].day;
  }

  async function close({
    actor = accountantA, school = schoolA, date = day, revision, counted = "100", note = null,
  }: { actor?: string; school?: string; date?: string; revision: number; counted?: string; note?: string | null }) {
    const { rows } = await asStaffActor<{ day: Day }>(
      db, actor, "select public.close_office_fee_day($1,$2,$3,$4,$5) as day",
      [school, date, revision, counted, note],
    );
    return rows[0].day;
  }

  it("uses exact IST boundaries, separates payment methods, and enforces school scope", async () => {
    const preview = await read();
    expect(preview).toMatchObject({
      business_date: day, receipt_count: 2, recorded_total: 220, recorded_cash: 100, closed_at: null,
      methods: [{ method: "cash", receipt_count: 1, total: 100 }, { method: "upi", receipt_count: 1, total: 120 }],
    });
    expect((await read({ date: "2026-10-16" })).recorded_total).toBe(120);
    expect((await read({ actor: adminB, school: schoolB })).recorded_total).toBe(100);
    await expect(read({ actor: adminB })).rejects.toMatchObject({ code: "42501" });
    await expect(close({ actor: parentA, revision: preview.revision })).rejects.toMatchObject({ code: "42501" });
    await expect(read({ date: "9999-01-01" })).rejects.toMatchObject({ code: "22023" });
  });

  it("rejects a stale review, requires an explanation, and freezes the close record", async () => {
    const before = await read();
    await importPayment("20.50", "cash", "2026-10-15 14:00:00+00", "paid");
    await expect(close({ revision: before.revision })).rejects.toMatchObject({ code: "40001" });
    const fresh = await read();
    expect(fresh.recorded_cash).toBe(120.5);
    await expect(close({ revision: fresh.revision })).rejects.toMatchObject({ code: "22023" });

    const saved = await close({ revision: fresh.revision, counted: "120", note: " Small cash shortage " });
    expect(saved).toMatchObject({
      receipt_count: 3, recorded_total: 240.5, recorded_cash: 120.5, counted_cash: 120,
      cash_variance: -0.5, variance_note: "Small cash shortage",
    });
    expect(saved.closed_at).toBeTruthy();
    expect(await read()).toEqual(saved);
    expect(await close({ revision: before.revision, counted: "120", note: "Small cash shortage" })).toEqual(saved);
    await expect(close({ revision: fresh.revision, counted: "120.50" })).rejects.toMatchObject({ code: "23505" });
    await expect(importPayment("5.00", "cash", "2026-10-15 14:00:00+00", "paid"))
      .rejects.toMatchObject({ code: "22023" });
    await expect(db.query("update public.fee_payments set status='refunded' where id=$1", [A.payment]))
      .rejects.toMatchObject({ code: "22023" });
    await expect(db.query("delete from public.fee_payments where id=$1", [A.payment]))
      .rejects.toMatchObject({ code: "22023" });
    await expect(asStaffActor(db, adminA, "update app_private.office_fee_days set closed_at=null"))
      .rejects.toMatchObject({ code: "42501" });
    expect(await read()).toEqual(saved);
    expect((await read({ actor: adminB, school: schoolB })).closed_at).toBeNull();
  });

  it("blocks a new office receipt on a closed day and still returns an earlier retry", async () => {
    const { rows: [{ today }] } = await db.query<{ today: string }>(
      "select ((clock_timestamp() at time zone 'Asia/Kolkata')::date)::text as today",
    );
    const request = randomUUID();
    const pay = (key: string) => asStaffActor<{ receipt: Receipt }>(db, adminA,
      "select public.record_office_fee_payment($1,$2,25,'cash',$3) as receipt", [schoolA, A.fee, key]);
    const payment = await pay(request);
    const review = await read({ date: today });
    await close({ date: today, revision: review.revision, counted: String(review.recorded_cash) });

    expect((await pay(request)).rows).toEqual(payment.rows);
    await expect(pay(randomUUID())).rejects.toThrow("This school day is closed for fee collection.");
    expect(await read({ date: today })).toMatchObject({ receipt_count: 1, recorded_total: 25, counted_cash: 25 });
  });
});
