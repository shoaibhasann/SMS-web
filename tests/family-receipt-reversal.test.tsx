import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FamilyReceipts } from "../components/finance/family-receipts";
import { loadFamilyStudents, type FamilyStudent } from "../lib/attendance/family";
import { listFamilyFeeReceipts, type FamilyFeeReceipt } from "../lib/finance/fee-changes";

const { client } = vi.hoisted(() => ({ client: { auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }) } } }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => client }));
vi.mock("@/lib/attendance/family", async (original) => ({ ...await original<typeof import("../lib/attendance/family")>(), loadFamilyStudents: vi.fn() }));
vi.mock("@/lib/finance/fee-changes", async (original) => ({ ...await original<typeof import("../lib/finance/fee-changes")>(), listFamilyFeeReceipts: vi.fn() }));

const pupils: FamilyStudent[] = [
  { id: "pupil-a", school_id: "school-a", admission_no: "A-001", first_name: "QA One", status: "active" },
  { id: "pupil-b", school_id: "school-a", admission_no: "A-002", first_name: "QA Two", status: "active" },
];
const original: FamilyFeeReceipt = { id: "payment-old", student_id: "pupil-a", student_fee_id: "fee-a", receipt_no: "RCPT-ORIGINAL", amount: "100.00", paid_at: "2026-11-04T06:30:00Z", payment_method: "cash", status: "reversed", recorded_status: "paid", reversed_amount: "100.00", net_amount: "0.00", reversed_at: "2026-11-05T06:30:00Z", reversal_reference: "REV-SCHOOL-CORRECTION" };
const active: FamilyFeeReceipt = { ...original, id: "payment-new", receipt_no: "RCPT-NEW", amount: "300.00", status: "paid", net_amount: "300.00", reversed_amount: "0.00", reversed_at: null, reversal_reference: null };
const load = vi.mocked(loadFamilyStudents), receipts = vi.mocked(listFamilyFeeReceipts);
beforeEach(() => { sessionStorage.clear(); load.mockReset(); receipts.mockReset(); load.mockResolvedValue([pupils[0]]); });

describe("family reversed receipt history", () => {
  it("keeps the original receipt visible with a separate correction and effective amount", async () => {
    receipts.mockResolvedValue({ rows: [active, original], count: 2 });
    render(<FamilyReceipts role="student" userId="student-a" />);
    const old = (await screen.findByText("RCPT-ORIGINAL")).closest("li")!;
    expect(within(old).getByText("₹100.00")).toBeInTheDocument();
    expect(within(old).getByText(/Payment entry reversed/)).toBeInTheDocument();
    expect(within(old).getByText(/Effective recorded amount: ₹0.00/)).toBeInTheDocument();
    expect(within(old).getByText(/REV-SCHOOL-CORRECTION/)).toBeInTheDocument();
    expect(within(old).getByText(/Refunds are handled separately by the school/)).toBeInTheDocument();
    expect(screen.getByText("RCPT-NEW")).toBeInTheDocument();
    expect(screen.getByText("₹300.00")).toBeInTheDocument();
    expect(receipts).toHaveBeenCalledWith(client, "pupil-a", 30, 0);
    expect(screen.queryByRole("button", { name: /approve|request|reverse|pay/i })).not.toBeInTheDocument();
  });

  it("labels methods consistently and marks an unknown effective amount as needing review", async () => {
    receipts.mockResolvedValue({ rows: [{ ...original, payment_method: "bank_transfer", net_amount: null }], count: 1 });
    render(<FamilyReceipts role="student" userId="student-a" />);
    const old = (await screen.findByText("RCPT-ORIGINAL")).closest("li")!;
    expect(within(old).getByText("Bank transfer")).toBeInTheDocument();
    expect(within(old).getByText(/Effective recorded amount: Needs review/)).toBeInTheDocument();
    expect(within(old).getByText("Receipt amount").parentElement).toHaveClass("col-span-2", "sm:col-span-1");
  });

  it("ignores the previous child's late financial response after switching child", async () => {
    const user = userEvent.setup();
    load.mockResolvedValue(pupils);
    let finish: (value: { rows: FamilyFeeReceipt[]; count: number }) => void = () => {};
    const pending = new Promise<{ rows: FamilyFeeReceipt[]; count: number }>((resolve) => { finish = resolve; });
    receipts.mockImplementation((_client, studentId) => studentId === "pupil-a" ? pending : Promise.resolve({ rows: [], count: 0 }));
    render(<FamilyReceipts role="parent" userId="guardian-a" />);
    await user.selectOptions(await screen.findByRole("combobox", { name: "Select child" }), "pupil-b");
    await screen.findByText("No receipts on this page.");
    await act(async () => { finish({ rows: [original], count: 1 }); await pending; });
    expect(screen.queryByText("RCPT-ORIGINAL")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Select child" })).toHaveValue("pupil-b");
  });

  it("shows denied financial reads as unavailable rather than an empty or paid history", async () => {
    const user = userEvent.setup();
    receipts.mockRejectedValueOnce(new Error("Linked access removed")).mockResolvedValue({ rows: [active], count: 1 });
    render(<FamilyReceipts role="student" userId="student-a" />);
    expect(await screen.findByText("Receipts could not be loaded.")).toHaveClass("text-danger");
    expect(screen.queryByText("No receipts on this page.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry receipts" }));
    await screen.findByText("RCPT-NEW");
  });
});
