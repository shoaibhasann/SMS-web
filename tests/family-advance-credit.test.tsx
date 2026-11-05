import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FamilyAdvanceCredit } from "../components/finance/family-advance-credit";
import { getFamilyStudentCredit, type FamilyCreditAccount } from "../lib/finance/advance-credit";
import { loadFamilyStudents, type FamilyStudent } from "../lib/attendance/family";

const { client, auth } = vi.hoisted(() => {
  const auth = { listener: (() => {}) as (event: string, session: { user: { id: string } } | null) => void };
  return { auth, client: { auth: { onAuthStateChange: (listener: typeof auth.listener) => { auth.listener = listener; return { data: { subscription: { unsubscribe: () => {} } } }; } } } };
});
vi.mock("@/lib/supabase/client", () => ({ createClient: () => client }));
vi.mock("@/lib/attendance/family", async (original) => ({ ...await original<typeof import("../lib/attendance/family")>(), loadFamilyStudents: vi.fn() }));
vi.mock("@/lib/finance/advance-credit", async (original) => ({ ...await original<typeof import("../lib/finance/advance-credit")>(), getFamilyStudentCredit: vi.fn() }));

const pupils: FamilyStudent[] = [
  { id: "pupil-a", school_id: "school-a", admission_no: "A-001", first_name: "QA One", status: "active" },
  { id: "pupil-b", school_id: "school-a", admission_no: "A-002", first_name: "QA Two", status: "active" },
];
const account: FamilyCreditAccount = { school_id: "school-a", student_id: "pupil-a", admission_no: "A-001", student_name: "QA One", summary: {
  received_amount: "1000.00", reversed_amount: "0.00", allocated_amount: "600.00", refunded_amount: "0.00", reserved_amount: "150.00", balance_amount: "400.00", available_amount: "250.00", invalid: false,
}, activity_count: 2, activities: [
  { id: "allocation-a", kind: "allocation", amount: "600.00", reference: "APPLY-001", occurred_at: "2026-11-05T08:00:00Z", payment_method: null, fee_id: "fee-a", fee_name: "Tuition", related_reference: null },
  { id: "receipt-a", kind: "receipt", amount: "1000.00", reference: "CASH-ADV-001", occurred_at: "2026-11-05T06:30:00Z", payment_method: "cash", fee_id: null, fee_name: null, related_reference: null },
] };
const students = vi.mocked(loadFamilyStudents), credit = vi.mocked(getFamilyStudentCredit);
beforeEach(() => { sessionStorage.clear(); students.mockReset(); credit.mockReset(); students.mockResolvedValue([pupils[0]]); credit.mockResolvedValue(account); });

describe("family advance statement", () => {
  it("shows available and reserved funds separately without calling an approval a paid refund", async () => {
    render(<FamilyAdvanceCredit role="student" userId="student-a" />);
    const statement = await screen.findByRole("region", { name: "Advance credit statement" });
    await within(statement).findByText("₹250.00");
    expect(within(statement).getByText("₹150.00")).toBeInTheDocument();
    expect(within(statement).getByText(/A reserved refund is awaiting an offline payout record/)).toBeInTheDocument();
    const history = within(statement).getByRole("list", { name: "Advance activity" });
    expect(within(history).getByText("Applied to fee")).toBeInTheDocument();
    expect(within(history).getByText("−₹600.00")).toBeInTheDocument();
    expect(within(history).getByText("+₹1,000.00")).toBeInTheDocument();
    expect(within(history).queryByText("Offline refund recorded")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve|pay|record|refund|apply|receive/i })).not.toBeInTheDocument();
  });
  it("renders completed payout and correction as distinct retained events", async () => {
    credit.mockResolvedValue({ ...account, activities: [
      { ...account.activities[0], id: "refund-a", kind: "refund", amount: "150.00", reference: "CASH-REFUND-001", fee_id: null, fee_name: null, payment_method: "cash" },
      { ...account.activities[1], id: "reversal-a", kind: "receipt_reversal", amount: "100.00", reference: "CORRECT-001", related_reference: "ORIGINAL-ADVANCE" },
    ] });
    render(<FamilyAdvanceCredit role="student" userId="student-a" />);
    await screen.findByText("Offline refund recorded");
    expect(screen.getByText("Advance entry corrected")).toBeInTheDocument();
    expect(screen.getByText(/does not initiate a bank refund/)).toBeInTheDocument();
  });
  it("ignores a previous child's late statement after a switch", async () => {
    const user = userEvent.setup(); students.mockResolvedValue(pupils);
    let finish: (value: FamilyCreditAccount) => void = () => {};
    const pending = new Promise<FamilyCreditAccount>((resolve) => { finish = resolve; });
    credit.mockImplementation((_client, studentId) => studentId === "pupil-a" ? pending : Promise.resolve({ ...account, student_id: "pupil-b", activities: [], activity_count: 0 }));
    render(<FamilyAdvanceCredit role="parent" userId="guardian-a" />);
    await user.selectOptions(await screen.findByRole("combobox", { name: "Select child" }), "pupil-b");
    await screen.findByText("No advance activity on this page.");
    await act(async () => { finish(account); await pending; });
    expect(screen.queryByText("CASH-ADV-001")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Select child" })).toHaveValue("pupil-b");
  });
  it("removes visible financial records when the authenticated account changes", async () => {
    render(<FamilyAdvanceCredit role="student" userId="student-a" />);
    await screen.findByText("CASH-ADV-001");
    await act(async () => { auth.listener("SIGNED_IN", { user: { id: "someone-else" } }); });
    await screen.findByRole("alert");
    expect(screen.queryByText("CASH-ADV-001")).not.toBeInTheDocument();
    expect(screen.queryByText("₹250.00")).not.toBeInTheDocument();
  });
  it("treats revoked or mismapped reads as unavailable and refreshes explicitly", async () => {
    const user = userEvent.setup(); credit.mockRejectedValueOnce(new Error("Guardian link revoked")).mockResolvedValue(account);
    render(<FamilyAdvanceCredit role="parent" userId="guardian-a" />);
    await screen.findByRole("alert");
    expect(screen.queryByText("₹250.00")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh advance account" }));
    await screen.findByText("CASH-ADV-001");
    credit.mockResolvedValue({ ...account, school_id: "school-b" });
    await user.click(screen.getByRole("button", { name: "Refresh advance account" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("CASH-ADV-001")).not.toBeInTheDocument();
  });
  it("paginates activity without replacing complete account totals", async () => {
    const user = userEvent.setup();
    credit.mockResolvedValueOnce({ ...account, activity_count: 31 }).mockResolvedValue({ ...account, activity_count: 31, activities: [{ ...account.activities[0], id: "old-a", reference: "OLDER-ALLOCATION" }] });
    render(<FamilyAdvanceCredit role="student" userId="student-a" />);
    await screen.findByText("CASH-ADV-001");
    await user.click(screen.getByRole("button", { name: "Next activity" }));
    await screen.findByText("OLDER-ALLOCATION");
    expect(screen.getByText("₹250.00")).toBeInTheDocument();
    expect(credit).toHaveBeenLastCalledWith(client, "pupil-a", 30, 30);
  });
});
