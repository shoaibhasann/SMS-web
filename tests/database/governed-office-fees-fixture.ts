import { readFile, readdir } from "node:fs/promises";
import { createStaffScopeDatabase, asStaffActor, STAFF_IDS, STAFF_ROWS } from "./staff-scope-fixture";

type Column = { name: string; type: string; not_null: boolean; default: string | null };
type Relation = { name: string; columns: Column[]; constraints: { name: string; definition: string }[] };
type Policy = { tablename: string; policyname: string; qual: string; with_check: string };
const directory = new URL("../../supabase/migrations/", import.meta.url);
const ident = (value: string) => `"${value.replaceAll('"', '""')}"`;

export async function createGovernedFeeDatabase({ previousMonth = false }: { previousMonth?: boolean } = {}) {
  const db = await createStaffScopeDatabase();
  try {
    const snapshot: { relations: Relation[]; policies: Policy[] } = JSON.parse(await readFile(new URL("../../supabase/schema-snapshots/2026-11-02/schema-metadata.json", import.meta.url), "utf8"));
    for (const relation of snapshot.relations.filter((row) => ["fee_discounts", "fee_refunds"].includes(row.name))) {
      const columns = relation.columns.map((column) => `${ident(column.name)} ${column.type}${column.not_null ? " not null" : ""}${column.default ? ` default ${column.default}` : ""}`);
      await db.exec(`create table public.${ident(relation.name)} (${columns.join(",")})`);
      for (const constraint of relation.constraints) await db.exec(`alter table public.${ident(relation.name)} add constraint ${ident(constraint.name)} ${constraint.definition}`);
      await db.exec(`grant all on public.${ident(relation.name)} to anon,authenticated,service_role; alter table public.${ident(relation.name)} enable row level security`);
    }
    for (const policy of snapshot.policies.filter((row) => ["fee_discounts", "fee_refunds"].includes(row.tablename))) {
      await db.exec(`create policy ${ident(policy.policyname)} on public.${ident(policy.tablename)} for all to public using (${policy.qual}) with check (${policy.with_check})`);
    }
    const files = await readdir(directory);
    for (const suffix of ["_record_office_fee_payment.sql", "_close_office_fee_day.sql", "_office_fee_day_optimistic_conflict_http_status.sql", "_office_fee_batches_and_opening_balances.sql", "_harden_fee_adjustment_record_access.sql"]) {
      const matches = files.filter((name) => name.endsWith(suffix));
      if (matches.length !== 1) throw new Error(`Expected one ${suffix} migration.`);
      await db.exec(await readFile(new URL(matches[0], directory), "utf8"));
    }
    const dates = (await db.query<{ today: string; yesterday: string; previous_month: string }>("select (clock_timestamp() at time zone 'Asia/Kolkata')::date::text as today,((clock_timestamp() at time zone 'Asia/Kolkata')::date-1)::text as yesterday,(date_trunc('month',clock_timestamp() at time zone 'Asia/Kolkata')::date-1)::text as previous_month")).rows[0];
    const legacyDay = previousMonth ? dates.previous_month : dates.yesterday;
    await db.query<Record<string, unknown>>("update public.fee_payments set payment_method='cash',paid_at=($2::date::timestamp at time zone 'Asia/Kolkata')+interval '10 hours' where id=$1", [STAFF_ROWS.A.payment, legacyDay]);
    const before = (await asStaffActor<{ value: { revision: number } }>(db, STAFF_IDS.accountantA, "select public.get_office_fee_day($1,$2) as value", [STAFF_IDS.schoolA, legacyDay])).rows[0].value;
    const closed = (await asStaffActor<{ value: Record<string, unknown> }>(db, STAFF_IDS.accountantA, "select public.close_office_fee_day($1,$2,$3,100,null) as value", [STAFF_IDS.schoolA, legacyDay, before.revision])).rows[0].value;
    const originalFee = (await db.query<Record<string, unknown>>("select to_jsonb(f) as value from public.student_fees f where id=$1", [STAFF_ROWS.A.fee])).rows[0].value;
    const originalReceipt = (await db.query<Record<string, unknown>>("select to_jsonb(p) as value from public.fee_payments p where id=$1", [STAFF_ROWS.A.payment])).rows[0].value;
    const matches = files.filter((name) => name.endsWith("_governed_office_fee_changes.sql"));
    if (matches.length !== 1) throw new Error("Expected one governed-office-fee-changes migration.");
    await db.exec(await readFile(new URL(matches[0], directory), "utf8"));
    return { db, ...dates, legacyDay, oldClosed: closed, originalFee, originalReceipt };
  } catch (error) { await db.close(); throw error; }
}

export type GovernedFeeFixture = Awaited<ReturnType<typeof createGovernedFeeDatabase>>;
