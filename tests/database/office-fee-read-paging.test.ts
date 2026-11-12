// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";
import { comparePositionsWithSqlDefinition } from "./fee-positions-reference";

type Row = Record<string, unknown>;
type Ledger = { rows: Row[]; summary: Row };
type Receipts = { rows: Row[]; count: number };

let db: PGlite;
const accountant = randomUUID();

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'accountant@fee-paging.invalid',now())", [accountant]);
  await db.query("update public.profiles set school_id=$2 where id=$1", [accountant, id.schoolA]);
  await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'accountant')", [accountant, id.schoolA]);
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
  // Pupil A: 29 older monthly demands plus the seeded November one (30). The 20 oldest are paid in full,
  // the other 9 older ones carry a part payment, so the seeded payment makes 30 receipts.
  await db.query(`insert into public.student_fees(id,school_id,student_id,fee_structure_id,billing_period,due_date,amount,status)
    select gen_random_uuid(),$1,$2,$3,to_char(date '2024-04-01'+make_interval(months=>n),'YYYY-MM'),
      (date '2024-04-10'+make_interval(months=>n))::date,1000,case when n<20 then 'paid' else 'partial' end::public.payment_status
    from generate_series(0,28) n`, [id.schoolA, id.pupilA, id.structureA]);
  await db.query(`insert into public.fee_payments(id,school_id,student_id,student_fee_id,receipt_no,amount,payment_method,status,paid_at)
    select gen_random_uuid(),f.school_id,f.student_id,f.id,'PAGING-'||f.billing_period,case when f.status='paid' then 1000 else 100 end,'cash','paid',
      f.due_date::timestamp+interval '9 hours'
    from public.student_fees f where f.student_id=$1 and f.id<>$2`, [id.pupilA, id.feeA]);
  // Count the expensive per-row projections the paged readers evaluate.
  for (const [name, args, params, counter] of [
    ["office_fee_financial_state", "p_school_id uuid,p_fee_id uuid", "p_school_id,p_fee_id", "paging.financial_state"],
    ["coherent_office_fee_payment", "p_payment_id uuid", "p_payment_id", "paging.coherent"],
  ] as const) {
    const returns = name === "office_fee_financial_state" ? "jsonb" : "boolean";
    await db.exec(`alter function app_private.${name}(${args.replace(/p_\w+ /g, "")}) rename to ${name}_counted;
      create function app_private.${name}(${args}) returns ${returns} language plpgsql stable set search_path='' as $f$
      begin
        perform pg_catalog.set_config('${counter}',(coalesce(nullif(pg_catalog.current_setting('${counter}',true),''),'0')::integer+1)::text,false);
        return app_private.${name}_counted(${params});
      end $f$;`);
  }
}, 120_000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

async function asActor<T>(user: string, sql: string, params: unknown[] = []): Promise<T> {
  await db.exec("savepoint paging_actor");
  try {
    await db.exec("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [user, JSON.stringify({ sub: user, session_id: user, aal: "aal1", role: "authenticated" })]);
    const result = await db.query<{ value: T }>(sql, params);
    await db.exec("reset role");
    await db.exec("release savepoint paging_actor");
    return result.rows[0].value;
  } catch (error) {
    await db.exec("rollback to savepoint paging_actor; release savepoint paging_actor");
    throw error;
  }
}

async function counted<T>(user: string, sql: string, params: unknown[]) {
  await db.exec("select set_config('paging.financial_state','0',false),set_config('paging.coherent','0',false)");
  const value = await asActor<T>(user, sql, params);
  const calls = (await db.query<{ financial_state: number; coherent: number }>(
    "select current_setting('paging.financial_state')::int as financial_state,current_setting('paging.coherent')::int as coherent")).rows[0];
  return { value, ...calls };
}

const officeLedger = (limit: number, offset: number) =>
  asActor<Ledger>(accountant, "select public.get_office_fee_ledger($1,null,null,$2,$3) as value", [id.schoolA, limit, offset]);
const familyLedger = (user: string, limit: number, offset: number) =>
  asActor<Ledger>(user, "select public.get_family_fee_ledger($1,$2,$3) as value", [id.pupilA, limit, offset]);
const officeReceipts = (limit: number, offset: number) =>
  asActor<Receipts>(accountant, "select public.list_office_fee_receipts($1,null,$2,$3) as value", [id.schoolA, limit, offset]);
const familyReceipts = (user: string, limit: number, offset: number) =>
  asActor<Receipts>(user, "select public.list_family_fee_receipts($1,$2,$3) as value", [id.pupilA, limit, offset]);

async function pagesOf<T extends { rows: Row[] }>(read: (limit: number, offset: number) => Promise<T>, total: number) {
  const rows: Row[] = [];
  for (let offset = 0; offset < total; offset += 7) rows.push(...(await read(7, offset)).rows);
  return rows;
}

describe("office fee readers page before projecting (web-finance#1)", () => {
  it("evaluates the ledger financial token only for the returned page", async () => {
    const full = await officeLedger(200, 0);
    expect(full.rows).toHaveLength(31);
    const page = await counted<Ledger>(accountant, "select public.get_office_fee_ledger($1,null,null,5,25) as value", [id.schoolA]);
    expect(page.value.rows).toEqual(full.rows.slice(25, 30));
    expect(page.value.summary).toEqual(full.summary);
    expect(page.financial_state).toBeLessThanOrEqual(5);
  });

  it("evaluates receipt coherence and the financial token once per returned receipt", async () => {
    const full = await officeReceipts(200, 0);
    expect(full.count).toBe(30);
    const page = await counted<Receipts>(accountant, "select public.list_office_fee_receipts($1,null,5,25) as value", [id.schoolA]);
    expect(page.value.rows).toEqual(full.rows.slice(25, 30));
    expect(page.value.count).toBe(30);
    expect(page.coherent).toBeLessThanOrEqual(5);
    expect(page.financial_state).toBeLessThanOrEqual(5);
  });

  it("keeps paged office and family reads identical to one full page", async () => {
    const ledger = await officeLedger(200, 0), receipts = await officeReceipts(200, 0);
    expect(await pagesOf(officeLedger, 31)).toEqual(ledger.rows);
    expect(await pagesOf(officeReceipts, 30)).toEqual(receipts.rows);
    const family = await familyLedger(id.guardianA, 100, 0), familyPaid = await familyReceipts(id.guardianA, 100, 0);
    expect(family.rows).toHaveLength(30);
    expect(familyPaid.count).toBe(30);
    expect(await pagesOf((limit, offset) => familyLedger(id.guardianA, limit, offset), 30)).toEqual(family.rows);
    expect(await pagesOf((limit, offset) => familyReceipts(id.guardianA, limit, offset), 30)).toEqual(familyPaid.rows);
    expect(receipts.rows.map((row) => row.paid_at)).toEqual([...receipts.rows.map((row) => row.paid_at)].sort().reverse());
  });
});

describe("fee positions are planned with each call's own values", () => {
  it("runs as plpgsql with a custom plan forced, because a SQL function gets one generic plan", async () => {
    const { rows: [fn] } = await db.query<{ lang: string; config: string[] }>(`select l.lanname as lang, p.proconfig as config
      from pg_proc p join pg_language l on l.oid = p.prolang
      where p.oid = 'app_private.office_fee_positions(uuid,uuid,uuid)'::regprocedure`);
    expect(fn.lang).toBe("plpgsql");
    expect(fn.config).toEqual(expect.arrayContaining(['search_path=""', "plan_cache_mode=force_custom_plan"]));
  });

  it("returns what the SQL definition returned for a school, a pupil and a single demand", async () => {
    const result = await comparePositionsWithSqlDefinition(db, [
      [id.schoolA, null, null], [id.schoolB, null, null], [id.schoolA, null, id.pupilA],
      [id.schoolA, id.feeA, null], [id.schoolA, id.feeA, id.pupilA], [id.schoolB, id.feeA, null],
    ]);
    expect(result.differing).toBe(0);
    expect(result.rows).toBeGreaterThan(60);
  });
});

describe("family fee preview and receipts name what was paid (web-finance#7)", () => {
  it.each([["guardian", id.guardianA], ["student", id.studentUserA]])("shows a %s the outstanding demands first", async (_label, user) => {
    const first = await familyLedger(user, 1, 0);
    expect(first.rows[0]).toMatchObject({ billing_period: "2025-12", balance: "900.00" });
    const all = (await familyLedger(user, 100, 0)).rows;
    expect(all.slice(0, 10).every((row) => row.balance !== "0.00")).toBe(true);
    expect(all.slice(10).every((row) => row.balance === "0.00")).toBe(true);
    expect(all.slice(0, 10).map((row) => row.due_date)).toEqual([...all.slice(0, 10).map((row) => row.due_date)].sort());
    expect(all.slice(10).map((row) => row.due_date)).toEqual([...all.slice(10).map((row) => row.due_date)].sort());
  });

  it("keeps the office ledger in due-date order", async () => {
    const rows = (await officeLedger(200, 0)).rows.filter((row) => row.student_id === id.pupilA);
    expect(rows[0]).toMatchObject({ billing_period: "2024-04", balance: "0.00" });
    expect(rows.map((row) => row.due_date)).toEqual([...rows.map((row) => row.due_date)].sort());
  });

  it("labels family and office receipts with the fee head and billing month", async () => {
    const family = (await familyReceipts(id.guardianA, 100, 0)).rows;
    expect(family.find((row) => row.receipt_no === "PAGING-2024-04")).toMatchObject({ fee_name: "Recovery tuition", billing_period: "2024-04" });
    expect(family.find((row) => row.receipt_no === "RECOVERY-RECEIPT-A")).toMatchObject({ fee_name: "Recovery tuition", billing_period: "2026-11" });
    expect(family.every((row) => !("financial_token" in row) && !("legacy_refund" in row))).toBe(true);
    const office = (await officeReceipts(200, 0)).rows;
    expect(office.find((row) => row.receipt_no === "PAGING-2025-12")).toMatchObject({ fee_name: "Recovery tuition", billing_period: "2025-12" });
    expect(office.every((row) => typeof row.financial_token === "string")).toBe(true);
  });
});
