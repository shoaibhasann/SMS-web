import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { applyLaterFeeRedefinitions, createGovernedFeeDatabase, GOVERNED_FEE_MIGRATIONS } from "./governed-office-fees-fixture";
import { asStaffActor, STAFF_IDS, STAFF_ROWS } from "./staff-scope-fixture";

export type Summary = { received_amount: string | null; reversed_amount: string | null; allocated_amount: string | null; refunded_amount: string | null; reserved_amount: string | null; balance_amount: string | null; available_amount: string | null; invalid: boolean };
export type Activity = { id: string; kind: string; amount: string; reference: string; occurred_at: string; payment_method: string | null; fee_id: string | null; fee_name: string | null; related_reference: string | null };
export type Credit = { summary: Summary; financial_token?: string | null; activities: Activity[]; activity_count: number };
export type Change = { id: string; kind: string; amount: string; state: string; financial_token: string; fee_token: string | null; entry_id: string | null; reference: string | null; effective_day: string | null };
export type Ledger = { rows: ({ demand_id: string; financial_token: string | null; net_amount: string | null; paid_amount: string | null; balance: string | null; advance_applied_amount: string | null; invalid: boolean } & Record<string, unknown>)[]; summary: Record<string, unknown> };

export async function createCreditDatabase() {
  const fixture = await createGovernedFeeDatabase();
  try {
    const preCreditToken = (await fixture.db.query<{ token: string }>("select app_private.office_fee_financial_state($1,$2)->>'financial_token' as token", [STAFF_IDS.schoolA, STAFF_ROWS.A.fee])).rows[0].token;
    const directory = new URL("../../supabase/migrations/", import.meta.url);
    const files = (await readdir(directory)).filter((name) => name.endsWith("_office_student_advance_credit.sql"));
    if (files.length !== 1) throw new Error("Expected exactly one advance-credit migration.");
    await fixture.db.exec(await readFile(new URL(files[0], directory), "utf8"));
    await applyLaterFeeRedefinitions(fixture.db, [...GOVERNED_FEE_MIGRATIONS, "_office_student_advance_credit.sql"]);
    const { schoolA, accountantA, principalA } = STAFF_IDS, { A } = STAFF_ROWS;
    const value = async <T = Record<string, unknown>>(sql: string, params: unknown[] = [], actor: string = accountantA) =>
      (await asStaffActor<{ value: T }>(fixture.db, actor, sql, params)).rows[0].value;
    const credit = (actor = accountantA) => value<Credit>("select public.get_office_student_credit($1,$2) as value", [schoolA, A.student], actor);
    const ledger = () => value<Ledger>("select public.get_office_fee_ledger($1,null,$2) as value", [schoolA, A.student]);
    const receipt = (amount = "1000.00", reference: string = randomUUID(), id: string = randomUUID(), actor = accountantA) => value<Activity>("select public.record_office_credit_receipt($1,$2,$3,'cash',$4,'Cash physically received for pupil',$5) as value", [schoolA, A.student, amount, reference, id], actor);
    const allocate = async (amount: string, id: string = randomUUID(), tokens?: { credit: string; fee: string }) => {
      const current = tokens ?? { credit: (await credit()).financial_token!, fee: (await ledger()).rows[0].financial_token! };
      return value<Activity>("select public.allocate_office_credit($1,$2,$3,$4,$5,$6,'Apply available credit to fee',$7) as value", [schoolA, A.student, A.fee, amount, current.credit, current.fee, id]);
    };
    const request = async (kind: string, amount: string | null, target: string | null = null, id: string = randomUUID(), actor = accountantA) => value<Change>("select public.request_office_credit_change($1,$2,$3,$4,$5,$6,$7,'Reviewed correction or return request',$8) as value", [schoolA, A.student, kind, target, amount, (await credit()).financial_token, kind === "allocation_return" ? (await ledger()).rows[0].financial_token : null, id], actor);
    const review = (id: string, decision = "approved", actor = principalA, reason = "Independently verified supporting register") => value<Change>("select public.review_office_credit_change($1,$2,$3) as value", [id, decision, reason], actor);
    const payout = (id: string, key: string = randomUUID(), reference: string = randomUUID()) => value<Change>("select public.pay_office_credit_refund($1,'cash',$2,'Confirmed payout already physically completed',$3) as value", [id, reference, key]);
    const day = (date = fixture.today) => value<Record<string, unknown>>("select public.get_office_fee_day($1,$2) as value", [schoolA, date]);
    return { ...fixture, preCreditToken, value, credit, ledger, receipt, allocate, request, review, payout, day };
  } catch (error) { await fixture.db.close(); throw error; }
}
export type CreditFixture = Awaited<ReturnType<typeof createCreditDatabase>>;
