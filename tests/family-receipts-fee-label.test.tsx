import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FamilyReceipts } from "../components/finance/family-receipts";
import { loadFamilyStudents, type FamilyStudent } from "../lib/attendance/family";
import { listFamilyFeeReceipts, type FamilyFeeReceipt } from "../lib/finance/fee-changes";

const { client } = vi.hoisted(() => ({ client: { auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }) } } }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => client }));
vi.mock("@/lib/attendance/family", async (original) => ({ ...await original<typeof import("../lib/attendance/family")>(), loadFamilyStudents: vi.fn() }));
vi.mock("@/lib/finance/fee-changes", async (original) => ({ ...await original<typeof import("../lib/finance/fee-changes")>(), listFamilyFeeReceipts: vi.fn() }));

const pupil: FamilyStudent = { id: "pupil-a", school_id: "school-a", admission_no: "A-001", first_name: "QA One", status: "active" };
const base: FamilyFeeReceipt = { id: "payment-a", student_id: "pupil-a", student_fee_id: "fee-a", receipt_no: "RCPT-APRIL", amount: "1000.00", paid_at: "2026-04-04T06:30:00Z", payment_method: "cash", status: "paid", recorded_status: "paid", reversed_amount: "0.00", net_amount: "1000.00", reversed_at: null, reversal_reference: null };
beforeEach(() => { sessionStorage.clear(); vi.mocked(loadFamilyStudents).mockResolvedValue([pupil]); });

describe("family receipt fee label", () => {
  it("names the fee head and billing month each receipt settled", async () => {
    vi.mocked(listFamilyFeeReceipts).mockResolvedValue({ rows: [{ ...base, fee_name: "Tuition", billing_period: "2026-04" }, { ...base, id: "payment-old", receipt_no: "RCPT-LEGACY" }], count: 2 });
    render(<FamilyReceipts role="student" userId="student-a" />);
    const april = (await screen.findByText("RCPT-APRIL")).closest("li")!;
    expect(within(april).getByText("Tuition · 2026-04")).toBeInTheDocument();
    const legacy = screen.getByText("RCPT-LEGACY").closest("li")!;
    expect(within(legacy).queryByText(/Tuition/)).not.toBeInTheDocument();
  });
});
