import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  FeeChangeError, getOfficeFinanceSummary, listFamilyFeeReceipts, listFeeChanges,
  loadOfficeFeePositions, requestFeeChange, reviewFeeChange, type FeeChangeRequestInput,
} from "../lib/finance/fee-changes";

const before = { base_net_amount: "1000.00", adjustment_amount: "0.00", net_amount: "1000.00", gross_paid_amount: "400.00", reversed_amount: "0.00", paid_amount: "400.00", balance: "600.00" };
const after = { ...before, adjustment_amount: "-100.00", net_amount: "900.00", balance: "500.00" };
const input: FeeChangeRequestInput = { feeId: "fee-a", kind: "reduction", amount: "100.00", paymentId: null, reason: "Approved scholarship schedule", expectedToken: "financial-snapshot-a", requestId: "change-a" };
function requestRecord(overrides: Record<string, unknown> = {}) {
  return { id: "change-a", school_id: "school-a", fee_id: "fee-a", student_id: "pupil-a", admission_no: "A-001", student_name: "QA One", fee_name: "Tuition", kind: "reduction", amount: "100.00", payment_id: null, receipt_no: null,
    request_reason: "Approved scholarship schedule", requested_by: "accountant-a", requester_name: "QA Accountant", requested_at: "2026-11-05T10:00:00Z", state: "pending", before, after, financial_token: "financial-snapshot-a",
    reviewed_by: null, reviewer_name: null, review_reason: null, reviewed_at: null, entry_id: null, reference: null, effective_day: null, ...overrides };
}
function provider(data: unknown, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}
const receipt = { id: "receipt-a", student_fee_id: "fee-a", student_id: "pupil-a", receipt_no: "RCPT-ORIGINAL", amount: "100.00", payment_method: "cash", status: "reversed", recorded_status: "paid", paid_at: "2026-11-04T10:00:00Z", net_amount: "0.00", reversed_amount: "100.00", reversed_at: "2026-11-05T10:00:00Z", reversal_reference: "REV-CORRECTION" };

describe("governed financial client boundary", () => {
  it("keeps exact amounts, actor intent and loaded token for idempotent request retry", async () => {
    const { client, rpc } = provider(requestRecord());
    const first = await requestFeeChange(client, "school-a", input);
    const second = await requestFeeChange(client, "school-a", input);
    expect(first).toEqual(second);
    expect(rpc).toHaveBeenLastCalledWith("request_office_fee_change", {
      p_school_id: "school-a", p_fee_id: "fee-a", p_kind: "reduction", p_amount: "100.00", p_payment_id: null,
      p_reason: input.reason, p_expected_token: "financial-snapshot-a", p_request_id: "change-a",
    });
    expect(first.before.net_amount).toBe("1000.00"); expect(first.after.net_amount).toBe("900.00");
  });

  it.each([
    { school_id: "school-b" }, { fee_id: "another-fee" }, { kind: "additional_charge" }, { amount: "200.00" },
    { id: "another-request" }, { financial_token: "another-snapshot" }, { request_reason: "Another valid reason" },
  ])("does not treat a mismatched financial response as accepted", async (mismatch) => {
    await expect(requestFeeChange(provider(requestRecord(mismatch)).client, "school-a", input)).rejects.toMatchObject({ name: "FeeChangeError", code: undefined });
  });

  it("sends null for a full reversal amount so the server determines the original receipt amount", async () => {
    const data = requestRecord({ kind: "payment_reversal", payment_id: "receipt-a", receipt_no: "RCPT-ORIGINAL", amount: "400.00", after: { ...before, reversed_amount: "400.00", paid_amount: "0.00", balance: "1000.00" } });
    const { client, rpc } = provider(data);
    await requestFeeChange(client, "school-a", { ...input, kind: "payment_reversal", paymentId: "receipt-a", amount: null });
    expect(rpc.mock.calls[0][1].p_amount).toBeNull();
    expect(rpc.mock.calls[0][1].p_payment_id).toBe("receipt-a");
  });

  it("requires an actual posted entry before accepting an approved response", async () => {
    const data = requestRecord({ state: "approved", reviewed_by: "principal-a", reviewer_name: "QA Principal", review_reason: "Reviewed source", reviewed_at: "2026-11-05T10:30:00Z" });
    await expect(reviewFeeChange(provider(data).client, "change-a", "approved", "Reviewed source")).rejects.toBeInstanceOf(FeeChangeError);
    const complete = { ...data, entry_id: "entry-a", reference: "ADJ-A", effective_day: "2026-11-05" };
    expect((await reviewFeeChange(provider(complete).client, "change-a", "approved", "Reviewed source")).reference).toBe("ADJ-A");
    await expect(reviewFeeChange(provider(complete).client, "another-request", "approved", "Reviewed source")).rejects.toBeInstanceOf(FeeChangeError);
  });

  it.each(["PT409", "42501", "55000", "22023"])("preserves known financial rejection code %s", async (code) => {
    await expect(reviewFeeChange(provider(null, { code, message: "Review cannot be posted." }).client, "change-a", "approved", "Checked"))
      .rejects.toMatchObject({ code, message: "Review cannot be posted." });
  });

  it("does not let an interrupted review masquerade as a rejected or approved result", async () => {
    const client = { rpc: vi.fn().mockRejectedValue(new Error("Connection lost")) } as unknown as SupabaseClient;
    await expect(reviewFeeChange(client, "change-a", "approved", "Same frozen reason")).rejects.toMatchObject({ name: "FeeChangeError", code: undefined });
  });

  it.each(["tiny", "Checked\nnew line", "x".repeat(501)])("rejects an invalid audit reason before sending a request or review", async (reason) => {
    const { client, rpc } = provider(requestRecord());
    await expect(requestFeeChange(client, "school-a", { ...input, reason })).rejects.toMatchObject({ code: "22023" });
    await expect(reviewFeeChange(client, "change-a", "approved", reason)).rejects.toMatchObject({ code: "22023" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("validates school and filter scope on the correction queue", async () => {
    await expect(listFeeChanges(provider({ rows: [requestRecord({ school_id: "school-b" })], total_count: 1 }).client, "school-a")).rejects.toBeInstanceOf(FeeChangeError);
    await expect(listFeeChanges(provider({ rows: [requestRecord()], total_count: 1 }).client, "school-a", "approved")).rejects.toBeInstanceOf(FeeChangeError);
  });

  it("retains the original family receipt amount while displaying the reversed entry separately", async () => {
    const { client, rpc } = provider({ rows: [receipt], count: 1 });
    const result = await listFamilyFeeReceipts(client, "pupil-a");
    expect(result.rows[0]).toMatchObject({ receipt_no: "RCPT-ORIGINAL", amount: "100.00", net_amount: "0.00", status: "reversed", reversal_reference: "REV-CORRECTION" });
    expect(rpc).toHaveBeenCalledWith("list_family_fee_receipts", { p_student_id: "pupil-a", p_limit: 30, p_offset: 0 });
  });

  it("rejects another pupil or internal financial metadata in a family response", async () => {
    await expect(listFamilyFeeReceipts(provider({ rows: [{ ...receipt, student_id: "pupil-b" }], count: 1 }).client, "pupil-a")).rejects.toBeInstanceOf(FeeChangeError);
    await expect(listFamilyFeeReceipts(provider({ rows: [{ ...receipt, review_reason: "Internal review" }], count: 1 }).client, "pupil-a")).rejects.toBeInstanceOf(FeeChangeError);
  });

  it("uses separate server event-date totals and allows a valid negative correction day", async () => {
    const summary = { demand_count: 1, pending_count: 1, overdue_count: 0, invalid_count: 0, net_amount: "1000.00", paid_amount: "0.00", balance: "1000.00", opening_amount: "0.00",
      collections: { gross_amount: "100.00", reversal_amount: "100.00", net_amount: "0.00", today_gross: "0.00", today_reversal: "100.00", today_net: "-100.00", month_gross: "100.00", month_reversal: "100.00", month_net: "0.00" } };
    const result = await getOfficeFinanceSummary(provider(summary).client, "school-a");
    expect(result.collections.today_net).toBe("-100.00");
    expect(result.collections.net_amount).toBe("0.00");
    expect(result.balance).toBe("1000.00");
  });
});

describe("complete canonical office position reads", () => {
  const position = (index: number) => ({ demand_id: `fee-${index}`, student_id: "pupil-a", admission_no: "A-001", student_name: "QA One", academic_year_id: "year-a", academic_year_name: "2026–27", fee_name: "Tuition", kind: "monthly", billing_period: "2026-11", due_date: "2026-11-20", amount: "1000.00", discount: "0.00", late_fee: "0.00", net_amount: "900.00", paid_amount: "400.00", balance: "500.00", status: "partial", financial_token: "snapshot-" + index, base_net_amount: "1000.00", adjustment_amount: "-100.00", gross_paid_amount: "400.00", reversed_amount: "0.00", invalid: false });
  const page = (rows: unknown[], count = 201) => ({ academic_year_id: null, rows, summary: { demand_count: count, net_amount: "180900.00", paid_amount: "80400.00", balance: "100500.00", opening_amount: "0.00", invalid_count: 0 } });

  it("loads beyond one provider page and retains each fee's financial token", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: page(Array.from({ length: 200 }, (_, index) => position(index))), error: null })
      .mockResolvedValueOnce({ data: page([position(200)]), error: null });
    const rows = await loadOfficeFeePositions({ rpc } as unknown as SupabaseClient, "school-a");
    expect(rows).toHaveLength(201); expect(rows[200].financial_token).toBe("snapshot-200");
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_limit: 200, p_offset: 200, p_school_id: "school-a" });
  });

  it("rejects a changing page count instead of silently using a partial ledger", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: page(Array.from({ length: 200 }, (_, index) => position(index))), error: null })
      .mockResolvedValueOnce({ data: page([], 200), error: null });
    await expect(loadOfficeFeePositions({ rpc } as unknown as SupabaseClient, "school-a")).rejects.toMatchObject({ code: "PT409" });
  });

  it("rejects duplicate row IDs across pages", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: page(Array.from({ length: 200 }, (_, index) => position(index))), error: null })
      .mockResolvedValueOnce({ data: page([position(0)]), error: null });
    await expect(loadOfficeFeePositions({ rpc } as unknown as SupabaseClient, "school-a")).rejects.toBeInstanceOf(FeeChangeError);
  });
});
