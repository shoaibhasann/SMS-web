// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase, readRecoveryManifest, readRecoverySources } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite;
const migrationPath = "supabase/migrations/20261109144911_family_fee_due_notifications.sql";
const principal = randomUUID();
const secondGuardian = randomUUID();
type Role = "parent" | "student";
type Cursor = { id: string; kind: string; created_at: string };
type Notification = Cursor & { read_at: string | null };
type Inbox = { notifications: Notification[]; unread_count: number; next_cursor: Cursor | null };
type FeeDue = { id: string; student_id: string; student_name: string; fee_name: string; due_date: string; balance: string; status: string };

beforeAll(async () => {
  db = await createRecoveryDatabase({ applyPending: false });
  const sources = await readRecoverySources(await readRecoveryManifest());
  for (const source of sources) {
    if (source.path === migrationPath) break;
    if (source.kind === "pending") await db.exec(source.sql);
  }
  await seedRecoveryData(db);
  // Move a preexisting charge into its due window without publishing an alert.
  await db.query(`update public.student_fees set due_date=(statement_timestamp() at time zone 'Asia/Kolkata')::date
    +case when id=$2 then 1 when id=$3 then -1 else 0 end where id in ($1,$2,$3)`, [id.feeA, id.feeUnlinkedA, id.feeB]);
  await db.exec(await readFile(new URL(`../../${migrationPath}`, import.meta.url), "utf8"));
  for (const user of [principal, secondGuardian]) {
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [user, `${user}@fee-due.invalid`]);
    await db.query("update public.profiles set school_id=$1 where id=$2", [id.schoolA, user]);
  }
  await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'principal')", [principal, id.schoolA]);
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
}, 60_000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

async function asActor<T>(user: string, sql: string, params: unknown[] = [], session = user): Promise<T> {
  await db.exec("savepoint fee_due_actor");
  try {
    await db.exec("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [user, JSON.stringify({ sub: user, session_id: session, aal: "aal1", role: "authenticated" })]);
    const result = await db.query<{ value: T }>(sql, params);
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true)");
    await db.exec("release savepoint fee_due_actor");
    return result.rows[0].value;
  } catch (error) {
    await db.exec("rollback to savepoint fee_due_actor; release savepoint fee_due_actor");
    throw error;
  }
}

function inbox(user: string, role: Role, options: {
  limit?: number; cursor?: Cursor | null; unreadOnly?: boolean; version?: 5 | 6; session?: string;
} = {}) {
  const { limit = 30, cursor, unreadOnly = false, version = 6, session } = options;
  return asActor<Inbox>(user, `select public.get_family_notification_inbox_v${version}($1,$2,$3,$4,$5,$6) as value`,
    [role, unreadOnly, limit, cursor?.created_at ?? null, cursor?.kind ?? null, cursor?.id ?? null], session);
}

const dues = (result: Inbox) => result.notifications.filter(({ kind }) => kind === "fee_due");
const mark = (user: string, role: Role, fee = id.feeA) => asActor<string | null>(user,
  "select public.mark_family_notification_read_v6($1,'fee_due',$2)::text as value", [role, fee]);
const detail = (user: string, role: Role, student = id.pupilA, fee = id.feeA) => asActor<FeeDue | null>(user,
  "select public.get_family_fee_due($1,$2,$3) as value", [role, student, fee]);

async function fee(daysFromToday: number | null, amount = "1000", student = id.pupilA) {
  const result = await db.query<{ id: string }>(`insert into public.student_fees(school_id,student_id,fee_structure_id,due_date,amount)
    values($1,$2,$3,(statement_timestamp() at time zone 'Asia/Kolkata')::date+$4::integer,$5) returning id`,
  [id.schoolA, student, id.structureA, daysFromToday, amount]);
  return result.rows[0].id;
}

async function linkGuardian(user: string, student: string) {
  const parent = randomUUID();
  await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'parent')", [user, id.schoolA]);
  await db.query("insert into public.parents(id,school_id,profile_id) values($1,$2,$3)", [parent, id.schoolA, user]);
  await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [student, parent]);
}

const pay = (amount: string) => asActor<{ payment_id: string }>(id.adminA,
  "select public.record_office_fee_payment($1,$2,$3,'cash',$4,null) as value", [id.schoolA, id.feeA, amount, randomUUID()]);
async function feeToken() {
  const ledger = await asActor<{ rows: { demand_id: string; financial_token: string }[] }>(id.adminA,
    "select public.get_office_fee_ledger($1,null,$2) as value", [id.schoolA, id.pupilA]);
  return ledger.rows.find(({ demand_id }) => demand_id === id.feeA)!.financial_token;
}
async function approve(kind: "reduction" | "payment_reversal", amount: string | null, payment: string | null) {
  const request = await asActor<{ id: string }>(id.adminA,
    "select public.request_office_fee_change($1,$2,$3,$4,$5,'Synthetic finance QA change',$6,$7) as value",
    [id.schoolA, id.feeA, kind, amount, payment, await feeToken(), randomUUID()]);
  await asActor(principal, "select public.review_office_fee_change($1,'approved','Independently verified synthetic fee') as value", [request.id]);
}

describe("family fee due notifications", () => {
  it("derives existing due and overdue demands at the IST date boundary without leaking canonical invalid rows or changing v5", async () => {
    const before = await inbox(id.studentUserA, "student", { version: 5 });
    const overdue = await fee(-1);
    const future = await fee(1);
    const undated = await fee(null);
    const invalid = await fee(-1, "-100");
    const zero = await fee(-1, "0");
    const nonfinite = await fee(null);
    await db.query("update public.student_fees set due_date='-infinity' where id=$1", [nonfinite]);
    const { rows: [dates] } = await db.query<{ today: string; yesterday: string; midnight: string }>(`select
      (statement_timestamp() at time zone 'Asia/Kolkata')::date::text as today,
      ((statement_timestamp() at time zone 'Asia/Kolkata')::date-1)::text as yesterday,
      ((statement_timestamp() at time zone 'Asia/Kolkata')::date::timestamp at time zone 'Asia/Kolkata')::text as midnight`);
    const result = await inbox(id.studentUserA, "student");
    expect(dues(result)).toMatchObject([
      { id: id.feeA, source_id: id.feeA, student_id: id.pupilA, event_date: dates.today, status: "due", read_at: null },
      { id: overdue, source_id: overdue, student_id: id.pupilA, event_date: dates.yesterday, status: "overdue", read_at: null },
    ]);
    expect(Date.parse(dues(result)[0].created_at)).toBe(Date.parse(dates.midnight));
    expect(result.unread_count).toBe(before.unread_count + 2);
    expect(await detail(id.studentUserA, "student")).toEqual({
      id: id.feeA, student_id: id.pupilA, student_name: "Synthetic recovery pupil",
      fee_name: "Recovery tuition", due_date: dates.today, balance: "750.00", status: "due",
    });
    for (const hidden of [future, undated, invalid, zero, nonfinite]) {
      expect(await detail(id.studentUserA, "student", id.pupilA, hidden)).toBeNull();
      expect(await mark(id.studentUserA, "student", hidden)).toBeNull();
    }
    expect(await inbox(id.studentUserA, "student", { version: 5 })).toEqual(before);
    await asActor(id.adminA, "select public.withdraw_roster_enrollment($1,$2,$3,$4,$5,'Synthetic withdrawal') as value",
      [id.schoolA, id.yearA, id.classA, id.sectionA, id.pupilA]);
    expect(await detail(id.studentUserA, "student")).toMatchObject({ id: id.feeA, balance: "750.00" });
  });

  it("recalculates a single demand after payment, approved reduction, advance allocation, settlement and reversal", async () => {
    const originalRead = await mark(id.guardianA, "parent");
    expect(originalRead).toEqual(expect.any(String));
    const balance = async (expected: string) => expect(await detail(id.guardianA, "parent")).toMatchObject({ id: id.feeA, balance: expected });
    await balance("750.00");
    await pay("150.00");
    await balance("600.00");
    await approve("reduction", "100.00", null);
    await balance("500.00");
    await asActor(id.adminA, "select public.record_office_credit_receipt($1,$2,100,'cash','QA advance receipt','Synthetic advance credit',$3) as value",
      [id.schoolA, id.pupilA, randomUUID()]);
    await balance("500.00");
    const credit = await asActor<{ financial_token: string }>(id.adminA, "select public.get_office_student_credit($1,$2) as value", [id.schoolA, id.pupilA]);
    await asActor(id.adminA, "select public.allocate_office_credit($1,$2,$3,100,$4,$5,'Apply synthetic advance',$6) as value",
      [id.schoolA, id.pupilA, id.feeA, credit.financial_token, await feeToken(), randomUUID()]);
    await balance("400.00");
    const settlement = await pay("400.00");
    expect(await detail(id.guardianA, "parent")).toBeNull();
    expect(await mark(id.guardianA, "parent")).toBeNull();
    expect(dues(await inbox(id.guardianA, "parent"))).toEqual([]);
    await approve("payment_reversal", null, settlement.payment_id);
    await balance("400.00");
    expect(await mark(id.guardianA, "parent")).toBe(originalRead);
    expect(dues(await inbox(id.guardianA, "parent", { unreadOnly: true }))).toEqual([]);
    expect(dues(await inbox(id.studentUserA, "student", { unreadOnly: true }))).toMatchObject([{ id: id.feeA, read_at: null }]);
  });

  it("isolates the selected role, siblings, foreign school, other accounts and revoked links", async () => {
    const siblingFee = await fee(-1, "250", id.unlinkedPupilA);
    await linkGuardian(id.studentUserA, id.unlinkedPupilA);
    await linkGuardian(secondGuardian, id.pupilA);
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')",
      [id.unlinkedPupilA, id.parentA]);
    expect(dues(await inbox(id.studentUserA, "student"))).toMatchObject([{ id: id.feeA }]);
    expect(dues(await inbox(id.studentUserA, "parent"))).toMatchObject([{ id: siblingFee }]);
    expect(dues(await inbox(id.guardianA, "parent"))).toMatchObject([{ id: id.feeA }, { id: siblingFee }]);
    expect(await detail(id.studentUserA, "parent")).toBeNull();
    expect(await detail(id.guardianA, "parent", id.unlinkedPupilA, id.feeA)).toBeNull();
    expect(await detail(id.guardianA, "parent", id.pupilB, id.feeB)).toBeNull();
    expect(await detail(id.studentUserB, "student")).toBeNull();
    await expect(inbox(id.adminA, "parent")).rejects.toMatchObject({ code: "42501" });
    await expect(inbox(id.guardianA, "parent", { session: randomUUID() })).rejects.toMatchObject({ code: "42501" });
    expect(await mark(id.guardianA, "parent")).toEqual(expect.any(String));
    expect(dues(await inbox(secondGuardian, "parent", { unreadOnly: true }))).toMatchObject([{ id: id.feeA, read_at: null }]);
    await db.query("delete from public.student_parents where parent_id=$1 and student_id=$2", [id.parentA, id.pupilA]);
    expect(dues(await inbox(id.guardianA, "parent"))).toMatchObject([{ id: siblingFee, read_at: null }]);
    expect(await detail(id.guardianA, "parent")).toBeNull();
    expect(await mark(id.guardianA, "parent")).toBeNull();
    expect(await detail(id.studentUserA, "student")).toMatchObject({ id: id.feeA });
    await expect(asActor(id.guardianA, "select count(*) as value from app_private.family_fee_due_reads"))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("marks every eligible page without marking the same demands for other recipients", async () => {
    const before = await inbox(id.studentUserA, "student", { version: 5, unreadOnly: true });
    const extra = [await fee(0), await fee(0), await fee(-1)];
    const first = await inbox(id.studentUserA, "student", { limit: 2, unreadOnly: true });
    const second = await inbox(id.studentUserA, "student", { limit: 2, cursor: first.next_cursor, unreadOnly: true });
    const last = await inbox(id.studentUserA, "student", { limit: 2, cursor: second.next_cursor, unreadOnly: true });
    expect(first.next_cursor).not.toBeNull();
    expect(second.next_cursor).not.toBeNull();
    expect(last.next_cursor).toBeNull();
    expect([...dues(first), ...dues(second), ...dues(last)].map(({ id }) => id).sort()).toEqual([id.feeA, ...extra].sort());
    expect(first.unread_count).toBe(before.unread_count + 4);
    expect(await asActor(id.studentUserA, "select public.get_family_notification_unread_count_v6('student')::int as value")).toBe(first.unread_count);
    expect(await asActor(id.studentUserA, "select public.mark_all_family_notifications_read_v6('student')::int as value")).toBe(first.unread_count);
    expect(await asActor(id.studentUserA, "select public.mark_all_family_notifications_read_v6('student')::int as value")).toBe(0);
    expect((await inbox(id.studentUserA, "student", { unreadOnly: true })).notifications).toEqual([]);
    expect(dues(await inbox(id.guardianA, "parent", { unreadOnly: true }))).toHaveLength(4);
  });
});
