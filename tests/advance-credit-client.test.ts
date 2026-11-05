import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  AdvanceCreditError, allocateOfficeCredit, cancelOfficeCreditRefund, decodeCreditSummary,
  getFamilyStudentCredit, getOfficeStudentCredit, listOfficeCreditChanges, payOfficeCreditRefund,
  recordOfficeCreditReceipt, requestOfficeCreditChange, reviewOfficeCreditChange,
  type CreditChangeInput, type CreditReceiptInput,
} from "../lib/finance/advance-credit";
import { fromPaise, normalizeMoney, positiveMoney, toPaise } from "../lib/finance/money";

const summary = { received_amount: "1000.00", reversed_amount: "0.00", allocated_amount: "600.00", refunded_amount: "0.00", reserved_amount: "150.00", balance_amount: "400.00", available_amount: "250.00", invalid: false };
const activity = { id: "receipt-a", school_id: "school-a", student_id: "student-a", kind: "receipt", amount: "1000.00", reference: "CASH-ADV-001", occurred_at: "2026-11-05T10:00:00Z", payment_method: "cash", fee_id: null, fee_name: null, related_reference: null };
const publicActivity = { id: activity.id, kind: activity.kind, amount: activity.amount, reference: activity.reference,
  occurred_at: activity.occurred_at, payment_method: activity.payment_method, fee_id: null, fee_name: null, related_reference: null };
const account = { school_id: "school-a", student_id: "student-a", admission_no: "QA-001", student_name: "QA One", summary, activities: [publicActivity], activity_count: 1 };
const receiptInput: CreditReceiptInput = { studentId: "student-a", amount: "1000", method: "cash", reference: "CASH-ADV-001", reason: "Cash advance physically received", requestId: "receipt-a" };
const changeInput: CreditChangeInput = { studentId: "student-a", kind: "refund", entryId: null, amount: "150", expectedCreditToken: "credit-snapshot", expectedFeeToken: null, reason: "Unused advance requested back", requestId: "change-a" };
const request = { id: "change-a", school_id: "school-a", student_id: "student-a", admission_no: "QA-001", student_name: "QA One", kind: "refund", amount: "150.00", entry_target_id: null, target_reference: null, fee_id: null,
  request_reason: changeInput.reason, requested_by: "finance-a", requester_name: "QA Finance", requested_at: "2026-11-05T10:00:00Z", state: "pending", financial_token: "credit-snapshot", fee_token: null,
  reviewed_by: null, reviewer_name: null, review_reason: null, reviewed_at: null, entry_id: null, reference: null, effective_day: null, cancelled_by: null, canceller_name: null, cancel_reason: null, cancelled_at: null };
const approved = { ...request, state: "approved", reviewed_by: "admin-a", reviewer_name: "QA Admin", review_reason: "Refund checked and authorized", reviewed_at: "2026-11-05T10:10:00Z" };
const paid = { ...approved, state: "paid", entry_id: "payout-a", reference: "CASH-OUT-001", effective_day: "2026-11-05" };
function provider(data: unknown, error: unknown = null) { const rpc = vi.fn().mockResolvedValue({ data, error }); return { client: { rpc } as unknown as SupabaseClient, rpc }; }

describe("advance-credit accounting boundary", () => {
  it("keeps paise exact at normal and large amounts without float addition", () => {
    expect(fromPaise(toPaise("0.10") + toPaise("0.20"))).toBe("0.30");
    expect(normalizeMoney("999999999999999999999999.99")).toBe("999999999999999999999999.99");
    expect(fromPaise(toPaise("-100.01"))).toBe("-100.01");
    expect(normalizeMoney("-000.00")).toBe("0.00");
    expect(() => positiveMoney("0.00")).toThrow();
    expect(() => positiveMoney("1.001")).toThrow();
  });
  it("keeps reserved funds separate from spendable advance", async () => {
    const view = await getOfficeStudentCredit(provider({ ...account, financial_token: "current-credit-token" }).client, "school-a", "student-a");
    expect(view.summary.balance_amount).toBe("400.00"); expect(view.summary.available_amount).toBe("250.00"); expect(view.summary.reserved_amount).toBe("150.00");
  });
  it.each([
    { available_amount: "400.00" }, { balance_amount: "500.00" }, { available_amount: "-1.00" }, { received_amount: null },
  ])("rejects an inconsistent account instead of trusting an available balance", (mismatch) => {
    expect(() => decodeCreditSummary({ ...summary, ...mismatch })).toThrow(AdvanceCreditError);
  });
  it("withholds an invalid account without substituting zero", () => {
    const unknown = Object.fromEntries(Object.keys(summary).map((key) => [key, key === "invalid" ? true : null]));
    expect(decodeCreditSummary(unknown)).toMatchObject({ invalid: true, available_amount: null });
    expect(() => decodeCreditSummary({ ...unknown, received_amount: "0.00" })).toThrow(AdvanceCreditError);
  });
  it.each([
    { ...account, financial_token: "private" },
    { ...account, cancel_reason: "Internal decision" },
    { ...account, summary: { ...summary, actor_name: "Private name" } },
    { ...account, activities: [{ ...publicActivity, review_reason: "Private review" }] },
    { ...account, activities: [{ ...publicActivity, cancelled_by: "another-actor" }] },
  ])("rejects unexpected office metadata in a family projection", async (response) => {
    await expect(getFamilyStudentCredit(provider(response).client, "student-a")).rejects.toBeInstanceOf(AdvanceCreditError);
  });
  it("accepts a safe own-pupil statement and denies a mismapped account", async () => {
    expect((await getFamilyStudentCredit(provider(account).client, "student-a")).activities[0].reference).toBe("CASH-ADV-001");
    await expect(getFamilyStudentCredit(provider({ ...account, student_id: "student-b" }).client, "student-a")).rejects.toBeInstanceOf(AdvanceCreditError);
  });
  it("binds receipt recovery to the same actor intent and manual method", async () => {
    const { client, rpc } = provider(activity);
    expect(await recordOfficeCreditReceipt(client, "school-a", receiptInput)).toEqual(await recordOfficeCreditReceipt(client, "school-a", receiptInput));
    expect(rpc).toHaveBeenLastCalledWith("record_office_credit_receipt", { p_school_id: "school-a", p_student_id: "student-a", p_amount: "1000.00", p_payment_method: "cash", p_reference: "CASH-ADV-001", p_reason: receiptInput.reason, p_request_id: "receipt-a" });
  });
  it.each([{ id: "another-request" }, { amount: "100.00" }, { payment_method: "bank_transfer" }, { fee_id: "fee-a" }, { student_id: "student-b" }, { reference: "DIFFERENT-PROOF" }])("rejects mismatched receipt confirmation", async (mismatch) => {
    await expect(recordOfficeCreditReceipt(provider({ ...activity, ...mismatch }).client, "school-a", receiptInput)).rejects.toBeInstanceOf(AdvanceCreditError);
  });
  it("requires exact wallet and fee snapshots for a noncash allocation", async () => {
    const { client, rpc } = provider({ ...activity, id: "allocation-a", kind: "allocation", amount: "600.00", payment_method: null, fee_id: "fee-a", fee_name: "Tuition" });
    const result = await allocateOfficeCredit(client, "school-a", { studentId: "student-a", feeId: "fee-a", amount: "600", expectedCreditToken: "wallet-version", expectedFeeToken: "fee-version", reason: "Apply saved advance to tuition", requestId: "allocation-a" });
    expect(result.payment_method).toBeNull();
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_amount: "600.00", p_expected_credit_token: "wallet-version", p_expected_fee_token: "fee-version", p_request_id: "allocation-a" });
  });
  it("requests partial unused-credit refunds without claiming they are already paid", async () => {
    const { client, rpc } = provider(request);
    expect((await requestOfficeCreditChange(client, "school-a", changeInput)).state).toBe("pending");
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_kind: "refund", p_amount: "150.00", p_entry_id: null, p_expected_credit_token: "credit-snapshot" });
    expect((await reviewOfficeCreditChange(provider(approved).client, "change-a", "approved", approved.review_reason)).entry_id).toBeNull();
  });
  it("recovers an original approval after its refund was later paid or cancelled", async () => {
    expect((await reviewOfficeCreditChange(provider(paid).client, "change-a", "approved", approved.review_reason)).state).toBe("paid");
    const cancelled = { ...approved, state: "cancelled", cancelled_by: "admin-a", canceller_name: "QA Admin", cancel_reason: "Payout no longer required", cancelled_at: "2026-11-05T10:20:00Z" };
    expect((await reviewOfficeCreditChange(provider(cancelled).client, "change-a", "approved", approved.review_reason)).state).toBe("cancelled");
    expect((await cancelOfficeCreditRefund(provider(cancelled).client, "change-a", cancelled.cancel_reason)).state).toBe("cancelled");
  });
  it("confirms payout only from a saved paid request with the exact payout identifier", async () => {
    const input = { requestId: "change-a", method: "cash" as const, reference: "CASH-OUT-001", reason: "Cash payout already completed", payoutId: "payout-a" };
    const { client, rpc } = provider(paid);
    expect((await payOfficeCreditRefund(client, input)).state).toBe("paid");
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_payout_id: "payout-a", p_payment_method: "cash", p_reference: "CASH-OUT-001" });
    await expect(payOfficeCreditRefund(provider(approved).client, input)).rejects.toBeInstanceOf(AdvanceCreditError);
    await expect(payOfficeCreditRefund(provider({ ...paid, entry_id: "another-payout" }).client, input)).rejects.toBeInstanceOf(AdvanceCreditError);
    await expect(payOfficeCreditRefund(provider({ ...paid, reference: "ANOTHER-PROOF" }).client, input)).rejects.toBeInstanceOf(AdvanceCreditError);
  });
  it.each(["PT409", "22023", "23505", "42501"])("retains a known rejection %s without a false successful result", async (code) => {
    await expect(requestOfficeCreditChange(provider(null, { code, message: "Request could not be posted." }).client, "school-a", changeInput)).rejects.toMatchObject({ code });
  });
  it("keeps interrupted payout outcomes unknown for an exact retry", async () => {
    const client = { rpc: vi.fn().mockRejectedValue(new Error("Disconnected")) } as unknown as SupabaseClient;
    await expect(payOfficeCreditRefund(client, { requestId: "change-a", method: "cash", reference: "CASH-OUT-001", reason: "Cash payout already completed", payoutId: "payout-a" })).rejects.toMatchObject({ name: "AdvanceCreditError", code: undefined });
  });
  it("rejects unsupported provider methods, invalid audit text and invalid amounts before any write", async () => {
    const { client, rpc } = provider(activity);
    for (const patch of [{ method: "razorpay" }, { reason: "bad\nreason" }, { reference: "xy" }, { amount: "1.001" }]) {
      await expect(recordOfficeCreditReceipt(client, "school-a", { ...receiptInput, ...patch } as CreditReceiptInput)).rejects.toMatchObject({ code: "22023" });
    }
    expect(rpc).not.toHaveBeenCalled();
  });
  it("denies foreign-school, wrong-pupil or mismatched-filter queue responses", async () => {
    const { client } = provider({ rows: [{ ...request, school_id: "school-b" }], total_count: 1 });
    await expect(listOfficeCreditChanges(client, "school-a")).rejects.toBeInstanceOf(AdvanceCreditError);
    await expect(listOfficeCreditChanges(provider({ rows: [request], total_count: 1 }).client, "school-a", "student-b")).rejects.toBeInstanceOf(AdvanceCreditError);
    await expect(listOfficeCreditChanges(provider({ rows: [request], total_count: 1 }).client, "school-a", null, "paid")).rejects.toBeInstanceOf(AdvanceCreditError);
  });
});
