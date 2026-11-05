import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  FeeBatchError, feeMoney, formatFeeBillingPeriod, formatFeeMoney, getOfficeFeeLedger, maxOpeningBalanceRows,
  parseOpeningBalanceCsv, postFeeBatch, previewFeeBatch, type MonthlyFeeBatchPayload,
} from "../lib/finance/fee-batches";

const payload: MonthlyFeeBatchPayload = {
  academic_year_id: "year-a", fee_structure_id: "tuition-a", billing_period: "2026-11", due_date: "2026-11-20", class_id: null, section_id: null,
};
function client(data: unknown, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { provider: { rpc } as unknown as SupabaseClient, rpc };
}
const previewRow = { row_number: 1, student_id: "student-a", admission_no: "A-001", student_name: "QA One", class_name: "Grade 6", section_name: "A", amount: "1000.00", status: "ready", message: "Ready", demand_id: null };
function previewResult() {
  return { kind: "monthly", academic_year_id: "year-a", preview_token: "reviewed-snapshot", rows: [previewRow],
    summary: { ready_count: 1, existing_count: 0, error_count: 0, ready_amount: 1000, existing_amount: 0, total_amount: 1000 }, can_post: true };
}

describe("fee batch client boundary", () => {
  it("uses server totals and keeps the exact reviewed scope in RPC arguments", async () => {
    const { provider, rpc } = client(previewResult());
    const result = await previewFeeBatch(provider, "school-a", "monthly", payload);
    expect(rpc).toHaveBeenCalledWith("preview_office_fee_batch", { p_school_id: "school-a", p_kind: "monthly", p_payload: payload });
    expect(result.summary.ready_amount).toBe("1000.00");
    expect(result.rows[0].amount).toBe("1000.00");
  });

  it.each(["kind", "academic_year_id"])("rejects a preview returned for another %s", async (field) => {
    const data = { ...previewResult(), [field]: field === "kind" ? "opening" : "year-b" };
    await expect(previewFeeBatch(client(data).provider, "school-a", "monthly", payload)).rejects.toBeInstanceOf(FeeBatchError);
  });

  it("does not allow a truncated or contradictory preview to become postable", async () => {
    const truncated = { ...previewResult(), summary: { ...previewResult().summary, ready_count: 1500 } };
    await expect(previewFeeBatch(client(truncated).provider, "school-a", "monthly", payload)).rejects.toBeInstanceOf(FeeBatchError);
    const invalid = { ...previewResult(), rows: [{ ...previewRow, status: "error", amount: null }],
      summary: { ready_count: 0, existing_count: 0, error_count: 1, ready_amount: 0, existing_amount: 0, total_amount: 0 } };
    await expect(previewFeeBatch(client(invalid).provider, "school-a", "monthly", payload)).rejects.toBeInstanceOf(FeeBatchError);
    invalid.can_post = false;
    expect((await previewFeeBatch(client(invalid).provider, "school-a", "monthly", payload)).rows[0].amount).toBeNull();
  });

  it("retains the caller's request ID and preview token for receipt recovery", async () => {
    const receipt = { batch_id: "batch-a", kind: "monthly", academic_year_id: "year-a", posted_at: "2026-11-05T10:00:00Z", posted_by_name: "QA Office", created_count: 1, existing_count: 0, total_amount: "1000.00", source_reference: null, reason: null };
    const { provider, rpc } = client(receipt);
    expect(await postFeeBatch(provider, "school-a", "monthly", payload, "snapshot-a", "request-a")).toMatchObject(receipt);
    expect(rpc).toHaveBeenCalledWith("post_office_fee_batch", { p_school_id: "school-a", p_kind: "monthly", p_payload: payload, p_preview_token: "snapshot-a", p_request_id: "request-a" });
  });

  it("preserves known business rejection codes and treats an unconfirmed success as unknown", async () => {
    await expect(postFeeBatch(client(null, { code: "PT409", message: "The reviewed roster changed." }).provider, "school-a", "monthly", payload, "old", "same-request"))
      .rejects.toMatchObject({ code: "PT409", message: "The reviewed roster changed." });
    await expect(postFeeBatch(client({ batch_id: "maybe-saved" }).provider, "school-a", "monthly", payload, "old", "same-request"))
      .rejects.toMatchObject({ name: "FeeBatchError", code: undefined });
    const broken = { rpc: vi.fn().mockRejectedValue(new Error("Network interrupted")) } as unknown as SupabaseClient;
    await expect(postFeeBatch(broken, "school-a", "monthly", payload, "old", "same-request")).rejects.toMatchObject({ name: "FeeBatchError", code: undefined });
  });

  it("retains whole-scope ledger totals while requesting only one page", async () => {
    const { provider, rpc } = client({ academic_year_id: "year-a", rows: [], summary: { demand_count: 1500, net_amount: "1500000.00", paid_amount: "500000.00", balance: "1000000.00", opening_amount: "250000.00", invalid_count: 0 } });
    const ledger = await getOfficeFeeLedger(provider, "school-a", "year-a", null, 25, 25);
    expect(rpc).toHaveBeenCalledWith("get_office_fee_ledger", { p_school_id: "school-a", p_year_id: "year-a", p_student_id: null, p_limit: 25, p_offset: 25 });
    expect(ledger.summary.demand_count).toBe(1500);
    expect(ledger.summary.balance).toBe("1000000.00");
  });

  it("accepts withheld totals for invalid legacy records without converting them to zero", async () => {
    const ledger = { academic_year_id: "year-a", rows: [], summary: { demand_count: 1, net_amount: null, paid_amount: null, balance: null, opening_amount: null, invalid_count: 1 } };
    expect((await getOfficeFeeLedger(client(ledger).provider, "school-a", "year-a")).summary.balance).toBeNull();
  });
});

describe("decimal-safe fee amounts", () => {
  it("keeps internal opening-balance session markers out of invoice display and CSV labels", () => {
    expect(formatFeeBillingPeriod("OPENING:6b72d6c8-d328-4e55-b7e4-ff87d1245db2")).toBe("Opening balance");
    expect(formatFeeBillingPeriod("2026-11")).toBe("2026-11");
    expect(formatFeeBillingPeriod(null)).toBe("—");
  });
  it("normalizes exact paise and formats amounts above JS safe cents without losing paise", () => {
    expect(feeMoney("00010.2")).toBe("10.20");
    expect(feeMoney("-0.00")).toBe("0.00");
    expect(formatFeeMoney("90071992547409.93")).toBe("₹9,00,71,99,25,47,409.93");
    expect(formatFeeMoney("-1234.01")).toBe("−₹1,234.01");
  });
  it.each([NaN, Infinity, "1.001", "NaN", "1e6", "1,000.00", undefined])("rejects unsupported monetary value %s", (value) => {
    expect(() => feeMoney(value)).toThrow(FeeBatchError);
  });
});

describe("opening balance CSV boundaries", () => {
  it("reads quoted/BOM CSV and preserves duplicate or invalid amounts for server row errors", () => {
    expect(parseOpeningBalanceCsv('\uFEFFadmission_no,amount\r\n"A,001",100.25\r\n"A,001",-20\r\nA-002,not-money\r\n')).toEqual([
      { admission_no: "A,001", amount: "100.25" }, { admission_no: "A,001", amount: "-20" }, { admission_no: "A-002", amount: "not-money" },
    ]);
  });
  it.each(["amount,admission_no\n100,A-001", "admission_no,amount\nA-001,100,extra", 'admission_no,amount\n"A-001,100', "admission_no,amount\n", "admission_no,amount\nA-001,100\u0000"])("rejects structural CSV errors", (csv) => {
    expect(() => parseOpeningBalanceCsv(csv)).toThrow();
  });
  it("bounds row count without silently truncating pupils", () => {
    const csv = "admission_no,amount\n" + Array.from({ length: maxOpeningBalanceRows + 1 }, (_, index) => `A-${index},1.00`).join("\n");
    expect(() => parseOpeningBalanceCsv(csv)).toThrow("1500");
  });
});
