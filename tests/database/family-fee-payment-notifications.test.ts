// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase, readRecoveryManifest, readRecoverySources } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite;
const migrationPath = "supabase/migrations/20261109152742_family_fee_payment_notifications.sql";
const principal = randomUUID();
const secondGuardian = randomUUID();
type Role = "parent" | "student";
type Cursor = { id: string; kind: string; created_at: string };
type Notification = Cursor & { read_at: string | null };
type Inbox = { notifications: Notification[]; unread_count: number; next_cursor: Cursor | null };
type Receipt = { payment_id: string; receipt_no: string };
type PaymentDetail = {
  id: string; student_id: string; student_name: string; fee_name: string; receipt_no: string;
  amount: string; net_amount: string; status: "paid" | "reversed"; paid_at: string;
  payment_method: string | null; reversed_at: string | null; reversal_reference: string | null;
};

beforeAll(async () => {
  db = await createRecoveryDatabase({ applyPending: false });
  const sources = await readRecoverySources(await readRecoveryManifest());
  for (const source of sources) {
    if (source.path === migrationPath) break;
    if (source.kind === "pending") await db.exec(source.sql);
  }
  await seedRecoveryData(db);
  await db.query("update public.student_fees set due_date=(statement_timestamp() at time zone 'Asia/Kolkata')::date where id=$1", [id.feeA]);
  await db.exec(await readFile(new URL(`../../${migrationPath}`, import.meta.url), "utf8"));
  for (const user of [principal, secondGuardian]) {
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [user, `${user}@fee-payment.invalid`]);
    await db.query("update public.profiles set school_id=$1 where id=$2", [id.schoolA, user]);
  }
  await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'principal')", [principal, id.schoolA]);
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
}, 60_000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

async function asActor<T>(user: string, sql: string, params: unknown[] = [], session = user): Promise<T> {
  await db.exec("savepoint fee_payment_actor");
  try {
    await db.exec("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [user, JSON.stringify({ sub: user, session_id: session, aal: "aal1", role: "authenticated" })]);
    const result = await db.query<{ value: T }>(sql, params);
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true)");
    await db.exec("release savepoint fee_payment_actor");
    return result.rows[0].value;
  } catch (error) {
    await db.exec("rollback to savepoint fee_payment_actor; release savepoint fee_payment_actor");
    throw error;
  }
}

function inbox(user: string, role: Role, options: {
  limit?: number; cursor?: Cursor | null; unreadOnly?: boolean; version?: 6 | 7; session?: string;
} = {}) {
  const { limit = 30, cursor, unreadOnly = false, version = 7, session } = options;
  return asActor<Inbox>(user, `select public.get_family_notification_inbox_v${version}($1,$2,$3,$4,$5,$6) as value`,
    [role, unreadOnly, limit, cursor?.created_at ?? null, cursor?.kind ?? null, cursor?.id ?? null], session);
}

const payments = (result: Inbox) => result.notifications.filter(({ kind }) => kind === "fee_payment");
const mark = (user: string, role: Role, payment: string) => asActor<string | null>(user,
  "select public.mark_family_notification_read_v7($1,'fee_payment',$2)::text as value", [role, payment]);
const detail = (user: string, role: Role, payment: string, student = id.pupilA) => asActor<PaymentDetail | null>(user,
  "select public.get_family_fee_payment($1,$2,$3) as value", [role, student, payment]);
const pay = (amount: string, fee = id.feeA, request = randomUUID()) => asActor<Receipt>(id.adminA,
  "select public.record_office_fee_payment($1,$2,$3,'cash',$4,null) as value", [id.schoolA, fee, amount, request]);

async function linkGuardian(user: string, student: string) {
  const parent = randomUUID();
  await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'parent')", [user, id.schoolA]);
  await db.query("insert into public.parents(id,school_id,profile_id) values($1,$2,$3)", [parent, id.schoolA, user]);
  await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [student, parent]);
}

async function reverse(payment: string) {
  const ledger = await asActor<{ rows: { demand_id: string; financial_token: string }[] }>(id.adminA,
    "select public.get_office_fee_ledger($1,null,$2) as value", [id.schoolA, id.pupilA]);
  const token = ledger.rows.find(({ demand_id }) => demand_id === id.feeA)!.financial_token;
  const request = await asActor<{ id: string }>(id.adminA,
    "select public.request_office_fee_change($1,$2,'payment_reversal',null,$3,'Synthetic receipt correction',$4,$5) as value",
    [id.schoolA, id.feeA, payment, token, randomUUID()]);
  return asActor<{ reference: string }>(principal,
    "select public.review_office_fee_change($1,'approved','Independently verified synthetic receipt') as value", [request.id]);
}

describe("family fee payment notifications", () => {
  it("keeps legacy and unconfirmed receipts out, then records one alert for an actual payment and its exact retry", async () => {
    const inherited = await inbox(id.guardianA, "parent", { version: 6 });
    const oldReceipts = await asActor<{ rows: { id: string }[] }>(id.studentUserA,
      "select public.list_family_fee_receipts($1) as value", [id.pupilA]);
    expect(oldReceipts.rows.some(({ id: payment }) => payment === id.paymentA)).toBe(true);
    expect(await detail(id.studentUserA, "student", id.paymentA)).toBeNull();
    await db.query("update public.fee_payments set transaction_id='Legacy reference edit' where id=$1", [id.paymentA]);
    for (const status of ["pending", "failed"]) {
      const { rows: [{ id: payment }] } = await db.query<{ id: string }>(`insert into public.fee_payments
        (school_id,student_fee_id,student_id,receipt_no,amount,payment_method,status,paid_at)
        values($1,$2,$3,$4,50,'cash',$5,null) returning id`, [id.schoolA, id.feeA, id.pupilA, `QA-${status}`, status]);
      expect(await detail(id.guardianA, "parent", payment)).toBeNull();
      expect(await mark(id.guardianA, "parent", payment)).toBeNull();
    }
    expect(payments(await inbox(id.guardianA, "parent"))).toEqual([]);

    const key = randomUUID();
    const receipt = await pay("125.25", id.feeA, key);
    expect(await pay("125.25", id.feeA, key)).toEqual(receipt);
    await expect(pay("125.26", id.feeA, key)).rejects.toMatchObject({ code: "23505" });
    const { rows: [{ day, paid }] } = await db.query<{ day: string; paid: string }>(`select
      (paid_at at time zone 'Asia/Kolkata')::date::text as day,paid_at::text as paid from public.fee_payments where id=$1`, [receipt.payment_id]);
    const parent = await inbox(id.guardianA, "parent");
    expect(payments(parent)).toMatchObject([{ id: receipt.payment_id, source_id: receipt.payment_id, student_id: id.pupilA,
      kind: "fee_payment", event_date: day, title: "Fee payment recorded", status: "paid", read_at: null }]);
    expect(parent.unread_count).toBe(inherited.unread_count + 1);
    const exact = await detail(id.studentUserA, "student", receipt.payment_id);
    expect(exact).toEqual({
      id: receipt.payment_id, student_id: id.pupilA, student_name: "Synthetic recovery pupil", fee_name: "Recovery tuition",
      receipt_no: receipt.receipt_no, amount: "125.25", net_amount: "125.25", status: "paid", paid_at: expect.any(String),
      payment_method: "cash", reversed_at: null, reversal_reference: null,
    });
    expect(Date.parse(exact!.paid_at)).toBe(Date.parse(paid));
    expect(await inbox(id.guardianA, "parent", { version: 6 })).toEqual(inherited);
  });

  it("publishes only the real pending-to-paid transition and retains the original notification after approval reverses a receipt", async () => {
    const { rows: [{ id: transition }] } = await db.query<{ id: string }>(`insert into public.fee_payments
      (school_id,student_fee_id,student_id,receipt_no,amount,payment_method,status,paid_at)
      values($1,$2,$3,'QA payment transition',50,'cash','pending',null) returning id`, [id.schoolA, id.feeA, id.pupilA]);
    expect(await detail(id.studentUserA, "student", transition)).toBeNull();
    await db.query("update public.fee_payments set status='paid',paid_at=statement_timestamp() where id=$1", [transition]);
    await db.query("update public.fee_payments set status='paid' where id=$1", [transition]);
    expect(payments(await inbox(id.studentUserA, "student"))).toMatchObject([{ id: transition, status: "paid" }]);

    const receipt = await pay("100.00");
    const readAt = await mark(id.guardianA, "parent", receipt.payment_id);
    expect(readAt).toEqual(expect.any(String));
    const before = payments(await inbox(id.guardianA, "parent")).find(({ id: payment }) => payment === receipt.payment_id)!;
    const original = await detail(id.guardianA, "parent", receipt.payment_id);
    const reversal = await reverse(receipt.payment_id);
    expect(await detail(id.guardianA, "parent", receipt.payment_id)).toEqual({
      ...original, status: "reversed", net_amount: "0.00", reversed_at: expect.any(String), reversal_reference: reversal.reference,
    });
    const changed = payments(await inbox(id.guardianA, "parent")).filter(({ id: payment }) => payment === receipt.payment_id);
    expect(changed).toEqual([{ ...before, status: "reversed", title: "Payment entry reversed" }]);
    expect(await mark(id.guardianA, "parent", receipt.payment_id)).toBe(readAt);
    expect(payments(await inbox(id.studentUserA, "student", { unreadOnly: true }))).toContainEqual(expect.objectContaining({
      id: receipt.payment_id, status: "reversed", read_at: null,
    }));
  });

  it("keeps role and child ownership exact while preserving siblings and independent recipients", async () => {
    await linkGuardian(id.studentUserA, id.unlinkedPupilA);
    await linkGuardian(secondGuardian, id.pupilA);
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')",
      [id.unlinkedPupilA, id.parentA]);
    const own = await pay("100.00");
    const sibling = await pay("150.00", id.feeUnlinkedA);
    expect(payments(await inbox(id.studentUserA, "student"))).toMatchObject([{ id: own.payment_id }]);
    expect(payments(await inbox(id.studentUserA, "parent"))).toMatchObject([{ id: sibling.payment_id }]);
    expect(payments(await inbox(id.guardianA, "parent")).map(({ id }) => id).sort()).toEqual([own.payment_id, sibling.payment_id].sort());
    expect(await detail(id.studentUserA, "parent", own.payment_id)).toBeNull();
    expect(await detail(id.guardianA, "parent", own.payment_id, id.unlinkedPupilA)).toBeNull();
    expect(await detail(id.studentUserB, "student", own.payment_id)).toBeNull();
    await expect(inbox(id.adminA, "parent")).rejects.toMatchObject({ code: "42501" });
    await expect(inbox(id.guardianA, "parent", { session: randomUUID() })).rejects.toMatchObject({ code: "42501" });
    expect(await mark(id.guardianA, "parent", own.payment_id)).toEqual(expect.any(String));
    expect(payments(await inbox(secondGuardian, "parent", { unreadOnly: true }))).toMatchObject([{ id: own.payment_id, read_at: null }]);
    await db.query("delete from public.student_parents where parent_id=$1 and student_id=$2", [id.parentA, id.pupilA]);
    expect(payments(await inbox(id.guardianA, "parent"))).toMatchObject([{ id: sibling.payment_id, read_at: null }]);
    expect(await detail(id.guardianA, "parent", own.payment_id)).toBeNull();
    expect(await mark(id.guardianA, "parent", own.payment_id)).toBeNull();
    expect(await detail(id.studentUserA, "student", own.payment_id)).toMatchObject({ id: own.payment_id });
  });

  it("preserves v6 on reads and marks all eligible event pages only for the selected recipient", async () => {
    const prior = await inbox(id.studentUserA, "student", { version: 6, unreadOnly: true });
    const receipts = [await pay("100.00"), await pay("100.00"), await pay("100.00")];
    const pages: Inbox[] = [];
    let cursor: Cursor | null = null;
    do {
      const page = await inbox(id.studentUserA, "student", { limit: 2, cursor, unreadOnly: true });
      pages.push(page);
      expect(pages.length).toBeLessThan(5);
      cursor = page.next_cursor;
    } while (cursor);
    expect(pages.flatMap(payments).map(({ id }) => id).sort()).toEqual(receipts.map(({ payment_id }) => payment_id).sort());
    expect(await inbox(id.studentUserA, "student", { version: 6, unreadOnly: true })).toEqual(prior);
    expect(await asActor(id.studentUserA, "select public.get_family_notification_unread_count_v7('student')::int as value")).toBe(prior.unread_count + 3);
    expect(await asActor(id.studentUserA, "select public.mark_all_family_notifications_read_v7('student')::int as value")).toBe(prior.unread_count + 3);
    expect(await asActor(id.studentUserA, "select public.mark_all_family_notifications_read_v7('student')::int as value")).toBe(0);
    expect((await inbox(id.studentUserA, "student", { unreadOnly: true })).notifications).toEqual([]);
    expect(payments(await inbox(id.guardianA, "parent", { unreadOnly: true }))).toHaveLength(3);
  });
});
