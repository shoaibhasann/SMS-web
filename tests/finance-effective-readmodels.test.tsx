import type { SupabaseClient } from "@supabase/supabase-js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminFinanceWorkspace } from "@/components/admin/admin-finance-workspace";
import { feeMoney, type FeeLedgerRow } from "@/lib/finance/fee-batches";
import type { OfficeFeeReceipt, OfficeFinanceSummary } from "@/lib/finance/fee-changes";

const api = vi.hoisted(() => ({ create: vi.fn(), positions: vi.fn(), receipts: vi.fn(), page: vi.fn(), summary: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: api.create }));
vi.mock("@/lib/finance/fee-changes", async (original) => ({ ...await original<typeof import("@/lib/finance/fee-changes")>(),
  loadOfficeFeePositions: api.positions, loadOfficeFeeReceipts: api.receipts, listOfficeFeeReceipts: api.page, getOfficeFinanceSummary: api.summary,
}));
vi.mock("@/components/finance/fee-batch-workspace", () => ({ FeeBatchWorkspace: () => null }));
vi.mock("@/components/finance/fee-ledger", () => ({ FeeLedgerWorkspace: () => null }));
vi.mock("@/components/admin/cashier-day-close", () => ({ CashierDayClose: () => null }));
vi.mock("@/components/finance/fee-change-workspace", () => ({ FeeChangeWorkspace: ({ canReview }: { canReview: boolean }) => <p>{canReview ? "School review available" : "School review unavailable"}</p> }));

const position: FeeLedgerRow = { demand_id: "fee-a", student_id: "pupil-a", admission_no: "QA-001", student_name: "QA Pupil", academic_year_id: "year-a", academic_year_name: "2026–27", fee_name: "Tuition", kind: "monthly", billing_period: "2026-11", due_date: "2026-11-25", amount: "1000.00", discount: "0.00", late_fee: "0.00", base_net_amount: "1000.00", adjustment_amount: "-100.00", net_amount: "900.00", gross_paid_amount: "400.00", reversed_amount: "100.00", paid_amount: "300.00", balance: "600.00", status: "partial", financial_token: "financial-a" };
const original: OfficeFeeReceipt = { id: "payment-old", student_fee_id: "fee-a", student_id: "pupil-a", receipt_no: "QA-OLD-100", amount: "100.00", payment_method: "cash", status: "reversed", recorded_status: "paid", paid_at: "2026-11-01T10:00:00Z", net_amount: "0.00", reversed_amount: "100.00", reversed_at: "2026-11-05T10:00:00Z", reversal_reference: "FC-REV-001", financial_token: "financial-a", legacy_refund: false };
const active: OfficeFeeReceipt = { ...original, id: "payment-current", receipt_no: "QA-CURRENT-300", amount: "300.00", paid_at: "2026-11-05T09:00:00Z", net_amount: "300.00", reversed_amount: "0.00", status: "paid", reversed_at: null, reversal_reference: null };
const summary: OfficeFinanceSummary = { demand_count: 1, pending_count: 1, overdue_count: 1, invalid_count: 0, net_amount: "900.00", paid_amount: "300.00", balance: "600.00", opening_amount: "0.00", collections: { gross_amount: "400.00", reversal_amount: "100.00", net_amount: "300.00", today_gross: "300.00", today_reversal: "100.00", today_net: "200.00", month_gross: "400.00", month_reversal: "100.00", month_net: "300.00" } };
let structures: unknown[] = [];
function database() {
  let callback: ((event: string, session: { user: { id: string } } | null) => void) | undefined;
  const rpc = vi.fn(async () => ({ data: { payment_id: "new-payment", receipt_no: "QA-NEW-600" }, error: null }));
  const client = { rpc, auth: { getUser: vi.fn(async () => ({ data: { user: { id: "office-a" } }, error: null })), onAuthStateChange: (listener: typeof callback) => { callback = listener; return { data: { subscription: { unsubscribe: vi.fn() } } }; } },
    from(table: string) {
      let single = false;
      const data = () => table === "user_roles" ? [{ role: "accountant", school_id: "school-a" }, { role: "principal", school_id: "school-b" }]
        : table === "academic_years" ? (single ? { id: "year-a" } : [{ id: "year-a" }])
          : table === "fee_structures" ? structures
          : table === "students" ? [{ id: "pupil-a", first_name: "QA", middle_name: null, last_name: "Pupil", admission_no: "QA-001", enrollments: [{ class_id: "class-a" }] }] : [];
      const query = { select() { return query; }, eq() { return query; }, in() { return query; }, order() { return query; }, range() { return query; }, maybeSingle() { single = true; return query; },
        then<T = unknown, U = never>(yes?: ((value: { data: unknown; count: number; error: null }) => T | PromiseLike<T>) | null, no?: ((reason: unknown) => U | PromiseLike<U>) | null) {
          const result = data(); return Promise.resolve({ data: result, count: Array.isArray(result) ? result.length : 1, error: null }).then(yes, no);
        } };
      return query;
    },
  };
  api.create.mockReturnValue(client);
  return { client: client as unknown as SupabaseClient, rpc, signOut: () => callback?.("SIGNED_OUT", null) };
}
function readBlob(blob: Blob): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(blob); }); }
beforeEach(() => {
  sessionStorage.clear(); structures = [];
  api.positions.mockReset().mockResolvedValue([position]); api.receipts.mockReset().mockResolvedValue([original, active]); api.page.mockReset().mockResolvedValue({ rows: [active, original], count: 2 }); api.summary.mockReset().mockResolvedValue(summary);
});
afterEach(() => vi.unstubAllGlobals());

describe("effective office finance read models", () => {
  it("loads opening balances for the explicitly selected finance school", async () => {
    const db = database();
    render(<AdminFinanceWorkspace mode="fees" requestedSchoolId="school-b" />);
    await screen.findByText("School review available");
    expect(api.positions).toHaveBeenCalledExactlyOnceWith(db.client, "school-b");
    expect(api.receipts).toHaveBeenCalledExactlyOnceWith(db.client, "school-b");
  });

  it("rejects an unassigned school without falling back to another finance school", async () => {
    database();
    render(<AdminFinanceWorkspace mode="fees" requestedSchoolId="unassigned-school" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("not assigned to the selected school");
    expect(api.positions).not.toHaveBeenCalled();
    expect(api.receipts).not.toHaveBeenCalled();
  });

  it("keeps unused advance credit separate from fee dues and shows completed refund outflow from server totals", async () => {
    api.summary.mockResolvedValue({ ...summary, advance: { invalid: false, invalid_count: 0, received_amount: "1000.00", reversed_amount: "0.00", allocated_amount: "600.00", refunded_amount: "150.00", balance_amount: "250.00", reserved_amount: "50.00", available_amount: "200.00" },
      collections: { ...summary.collections, gross_amount: "1400.00", refund_amount: "150.00", today_refund: "150.00", month_refund: "150.00", net_amount: "1150.00" } });
    database(); render(<AdminFinanceWorkspace mode="reports" />);
    const totals = within(await screen.findByRole("region", { name: "School advance credit totals" }));
    expect(totals.getByText("Available student credit").nextElementSibling).toHaveTextContent("₹200.00");
    expect(totals.getByText("Reserved for unpaid refunds").nextElementSibling).toHaveTextContent("₹50.00");
    expect(totals.getByText("Offline refunds paid").nextElementSibling).toHaveTextContent("₹150.00");
    expect(screen.getByText("Net recorded collections").nextElementSibling).toHaveTextContent("₹1,150.00");
    expect(screen.getByText(/Collections include fee payments and money received as advance credit/)).toBeInTheDocument();
  });

  it("reads only the latest receipts page for Finance Reports and labels it as a sample", async () => {
    api.page.mockResolvedValue({ rows: [active, original], count: 57 });
    const db = database(); render(<AdminFinanceWorkspace mode="reports" />);
    const latest = within((await screen.findByRole("heading", { name: "Latest receipts" })).closest("section")!);
    expect(await latest.findByText("QA-CURRENT-300")).toBeInTheDocument();
    expect(latest.getAllByText("QA Pupil")).toHaveLength(2);
    expect(latest.getByText("Showing 2 of 57")).toBeInTheDocument();
    expect(latest.getByRole("link", { name: "All receipts" })).toHaveAttribute("href", "/modules/invoices?tab=receipts&school=school-a");
    expect(screen.queryByText("Student-wise dues")).not.toBeInTheDocument();
    expect(api.page).toHaveBeenCalledExactlyOnceWith(db.client, "school-a", null, 20, 0);
    expect(api.positions).not.toHaveBeenCalled();
    expect(api.receipts).not.toHaveBeenCalled();
  });

  it("uses server net collections and balances, enforces the effective payment cap, and doesn't inherit another school's reviewer role", async () => {
    const user = userEvent.setup(), db = database(); render(<AdminFinanceWorkspace mode="fees" />);
    await screen.findByText("School review unavailable");
    expect(screen.getByText("Today's net collections").nextElementSibling).toHaveTextContent("₹200.00");
    expect(screen.getByText("Monthly net collections").nextElementSibling).toHaveTextContent("₹300.00");
    const record = screen.getByRole("row", { name: /QA Pupil.*QA-001.*Tuition/ });
    expect(within(record).getByText("₹900.00")).toBeVisible(); expect(within(record).getByText("₹300.00")).toBeVisible(); expect(within(record).getByText("₹600.00")).toBeVisible();
    expect(api.summary).toHaveBeenCalledWith(db.client, "school-a");
    await user.click(screen.getByRole("button", { name: "Record payment" }));
    const dialog = within(screen.getByRole("dialog", { name: "Record payment" }));
    expect(dialog.getByRole("option", { name: /balance ₹600.00/ })).toBeVisible();
    await user.selectOptions(dialog.getByRole("combobox", { name: "Student fee record" }), "fee-a");
    await user.type(dialog.getByRole("spinbutton", { name: "Amount" }), "600.01"); await user.click(dialog.getByRole("button", { name: "Save payment" }));
    await dialog.findByText("The amount exceeds the displayed balance. Refresh the fee records."); expect(db.rpc).not.toHaveBeenCalled();
    await user.clear(dialog.getByRole("spinbutton", { name: "Amount" })); await user.type(dialog.getByRole("spinbutton", { name: "Amount" }), "600.00");
    await user.click(dialog.getByRole("button", { name: "Save payment" }));
    expect(db.rpc).not.toHaveBeenCalled();
    await user.click(dialog.getByRole("button", { name: "Confirm and save" }));
    await screen.findByText("QA-NEW-600");
    expect(db.rpc).toHaveBeenCalledWith("record_office_fee_payment", expect.objectContaining({ p_student_fee_id: "fee-a" }));
    expect(feeMoney((db.rpc.mock.calls[0] as unknown as [string, { p_amount: string }])[1].p_amount)).toBe("600.00");
  });

  it("opens directly on the Receipts tab when the All receipts link asks for it", async () => {
    database(); render(<AdminFinanceWorkspace mode="invoices" initialTab="receipts" />);
    expect(await screen.findByPlaceholderText("Search receipts")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "View QA-CURRENT-300" })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Search invoices")).not.toBeInTheDocument();
  });

  it("keeps original receipt amounts readable and exports corrected invoice and receipt values", async () => {
    const user = userEvent.setup(), blobs: Blob[] = []; database();
    const NativeURL = URL;
    class TestURL extends NativeURL { static createObjectURL(blob: Blob | MediaSource) { if (blob instanceof Blob) blobs.push(blob); return "blob:qa"; } static revokeObjectURL() {} }
    vi.stubGlobal("URL", TestURL); vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<AdminFinanceWorkspace mode="invoices" initialReceiptNo="QA-OLD-100" />);
    await user.click(await screen.findByRole("button", { name: "View QA-OLD-100" }));
    const detail = within(screen.getByRole("heading", { name: "Receipt QA-OLD-100" }).closest("section")!);
    expect(detail.getByText("Original receipt amount").nextElementSibling).toHaveTextContent("₹100.00");
    expect(detail.getByText("Credited amount").nextElementSibling).toHaveTextContent("₹0.00");
    expect(detail.getByText("FC-REV-001")).toBeVisible(); expect(detail.getByText(/does not send a bank refund/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Download QA-OLD-100 as CSV" }));
    const receiptCsv = await readBlob(blobs[0]);
    for (const line of ["Original amount,₹100.00", "Credited amount,₹0.00", "Reversed amount,₹100.00", "Reversal reference,FC-REV-001", "Status,reversed"]) expect(receiptCsv).toContain(line);
    await user.click(screen.getByRole("button", { name: /^Invoices$/ }));
    fireEvent.change(screen.getByPlaceholderText("Search invoices"), { target: { value: "" } });
    await user.click(await screen.findByRole("button", { name: "Download invoice as CSV" }));
    const invoiceCsv = await readBlob(blobs[1]);
    for (const line of ["Original subtotal,\"₹1,000.00\"", "Approved fee changes,−₹100.00", "Effective total,₹900.00", "Credited payments,₹300.00", "Pending,₹600.00", "Reversed,₹100.00"]) expect(invoiceCsv).toContain(line);
    expect(original.amount).toBe("100.00"); expect(position.amount).toBe("1000.00");
  });

  it("labels structure frequencies and shows the demand limit only for limited frequencies", async () => {
    structures = [
      { id: "lab", name: "Lab Fee", amount: 800, frequency: "half_yearly", academic_year_id: "year-a", class_id: null },
      { id: "misc", name: "Misc Fee", amount: 50, frequency: "custom", academic_year_id: "year-a", class_id: null },
    ];
    const user = userEvent.setup(); database(); render(<AdminFinanceWorkspace mode="fees" />);
    await screen.findByText("School review unavailable");
    await user.selectOptions(await screen.findByRole("combobox", { name: /Enrolled student/ }), "pupil-a");
    const structureSelect = screen.getByRole("combobox", { name: /Fee structure/ });
    expect(within(structureSelect).getByRole("option", { name: "Lab Fee · Half-yearly · ₹800.00" })).toBeInTheDocument();
    await user.selectOptions(structureSelect, "lab");
    expect(screen.getByText("Half-yearly fees: one demand per pupil per half of the session.")).toBeVisible();
    await user.selectOptions(structureSelect, "misc");
    expect(screen.queryByText(/one demand per pupil/)).not.toBeInTheDocument();
  });

  it("clears old financial names, receipt details and controls immediately on sign-out", async () => {
    const db = database(); render(<AdminFinanceWorkspace mode="fees" />); await screen.findByRole("row", { name: /QA Pupil.*QA-001.*Tuition/ });
    act(() => db.signOut());
    await screen.findByText("Your sign-in changed. Reload this finance page to verify school access.");
    expect(screen.queryByText("QA Pupil")).not.toBeInTheDocument(); expect(screen.queryByText("QA-001")).not.toBeInTheDocument();
    expect(screen.queryByText("School review unavailable")).not.toBeInTheDocument();
  });
});
