import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminFinanceWorkspace } from "@/components/admin/admin-finance-workspace";
import type { FeeLedgerRow } from "@/lib/finance/fee-batches";
import type { OfficeFeeReceipt, OfficeFinanceSummary } from "@/lib/finance/fee-changes";

const api = vi.hoisted(() => ({ create: vi.fn(), positions: vi.fn(), receipts: vi.fn(), page: vi.fn(), summary: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: api.create }));
vi.mock("@/lib/finance/fee-changes", async (original) => ({ ...await original<typeof import("@/lib/finance/fee-changes")>(),
  loadOfficeFeePositions: api.positions, loadOfficeFeeReceipts: api.receipts, listOfficeFeeReceipts: api.page, getOfficeFinanceSummary: api.summary,
}));
vi.mock("@/components/finance/fee-batch-workspace", () => ({ FeeBatchWorkspace: () => null }));
vi.mock("@/components/finance/fee-ledger", () => ({ FeeLedgerWorkspace: () => null }));
vi.mock("@/components/admin/cashier-day-close", () => ({ CashierDayClose: ({ schoolId }: { schoolId: string }) => <p>Day close for {schoolId}</p> }));
vi.mock("@/components/finance/fee-change-workspace", () => ({ FeeChangeWorkspace: () => <p>Fee changes ready</p> }));

const fee = (id: string, student: string, admission: string, period: string, due: string): FeeLedgerRow & { advance_applied_amount: string } => ({
  demand_id: id, student_id: student, admission_no: admission, student_name: "Asha Rao", academic_year_id: "year-a", academic_year_name: "2026–27",
  fee_name: "Tuition", kind: "monthly", billing_period: period, due_date: due, amount: "1000.00", discount: "0.00", late_fee: "0.00", base_net_amount: "1000.00",
  adjustment_amount: "0.00", net_amount: "1000.00", gross_paid_amount: "0.00", reversed_amount: "0.00", advance_applied_amount: "0.00", paid_amount: "0.00", balance: "1000.00",
  status: "pending", financial_token: `token-${id}`,
});
const april = fee("fee-april", "pupil-1", "ADM-1", "2026-04", "2026-04-10");
const may = fee("fee-may", "pupil-1", "ADM-1", "2026-05", "2026-05-10");
const twin = fee("fee-twin", "pupil-2", "ADM-2", "2026-04", "2026-04-10");
const receipt: OfficeFeeReceipt = { id: "payment-1", student_fee_id: "fee-april", student_id: "pupil-1", receipt_no: "RCPT-0001", amount: "400.00", payment_method: "upi",
  status: "paid", recorded_status: "paid", paid_at: "2026-11-01T20:00:00Z", net_amount: "400.00", reversed_amount: "0.00", reversed_at: null, reversal_reference: null,
  financial_token: "token-fee-april", legacy_refund: false };
const summary: OfficeFinanceSummary = { demand_count: 3, pending_count: 3, overdue_count: 0, invalid_count: 0, net_amount: "3000.00", paid_amount: "0.00", balance: "3000.00", opening_amount: "0.00",
  collections: { gross_amount: "0.00", reversal_amount: "0.00", net_amount: "0.00", today_gross: "0.00", today_reversal: "0.00", today_net: "0.00", month_gross: "0.00", month_reversal: "0.00", month_net: "0.00" } };

let roles: { role: string; school_id: string }[] = [];
function database() {
  const rpc = vi.fn(async () => ({ data: { payment_id: "new-payment", receipt_no: "RCPT-NEW" }, error: null }));
  const client = { rpc, auth: { getUser: vi.fn(async () => ({ data: { user: { id: "office-a" } }, error: null })), onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }) },
    from(table: string) {
      let single = false;
      const data = () => table === "user_roles" ? roles
        : table === "schools" ? [{ id: "school-a", name: "Alpha Public School" }, { id: "school-b", name: "Beta Public School" }]
          : table === "academic_years" ? (single ? { id: "year-a" } : [{ id: "year-a" }])
            : table === "students" ? [{ id: "pupil-1", first_name: "Asha", middle_name: null, last_name: "Rao", admission_no: "ADM-1" }, { id: "pupil-2", first_name: "Asha", middle_name: null, last_name: "Rao", admission_no: "ADM-2" }] : [];
      const query = { select() { return query; }, eq() { return query; }, in() { return query; }, order() { return query; }, range() { return query; }, maybeSingle() { single = true; return query; },
        then<T = unknown, U = never>(yes?: ((value: { data: unknown; count: number; error: null }) => T | PromiseLike<T>) | null, no?: ((reason: unknown) => U | PromiseLike<U>) | null) {
          const result = data(); return Promise.resolve({ data: result, count: Array.isArray(result) ? result.length : 1, error: null }).then(yes, no);
        } };
      return query;
    },
  };
  api.create.mockReturnValue(client);
  return { client, rpc };
}
function printWindow() {
  const doc = document.implementation.createHTMLDocument("print");
  const popup = { document: doc, opener: window as unknown, focus: vi.fn(), print: vi.fn() };
  const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  return { doc, popup, open };
}
function readBlob(blob: Blob): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(blob); }); }

beforeEach(() => {
  sessionStorage.clear(); roles = [{ role: "accountant", school_id: "school-a" }];
  api.positions.mockReset().mockResolvedValue([april, may, twin]); api.receipts.mockReset().mockResolvedValue([receipt]);
  api.page.mockReset().mockResolvedValue({ rows: [receipt], count: 1 }); api.summary.mockReset().mockResolvedValue(summary);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("record payment picker and review", () => {
  it("labels each demand with admission number, billing month and due date and does not preselect the oldest demand", async () => {
    const user = userEvent.setup(); database(); render(<AdminFinanceWorkspace mode="fees" />);
    await screen.findByText("Fee changes ready");
    await user.click(screen.getByRole("button", { name: "Record payment" }));
    const dialog = within(screen.getByRole("dialog", { name: "Record payment" }));
    const picker = dialog.getByRole("combobox", { name: "Student fee record" });
    expect(picker).toHaveValue("");
    expect(dialog.getByRole("option", { name: "Asha Rao · ADM-1 · Tuition · 2026-04 · due 2026-04-10 · balance ₹1,000.00" })).toBeInTheDocument();
    expect(dialog.getByRole("option", { name: "Asha Rao · ADM-1 · Tuition · 2026-05 · due 2026-05-10 · balance ₹1,000.00" })).toBeInTheDocument();
    expect(dialog.getByRole("option", { name: "Asha Rao · ADM-2 · Tuition · 2026-04 · due 2026-04-10 · balance ₹1,000.00" })).toBeInTheDocument();
    await user.type(dialog.getByRole("searchbox", { name: "Find student or fee" }), "ADM-2");
    expect(within(picker).getAllByRole("option").map((option) => option.textContent)).toEqual(["Choose fee record", "Asha Rao · ADM-2 · Tuition · 2026-04 · due 2026-04-10 · balance ₹1,000.00"]);
  });

  it("limits the picker to the pupil chosen in the fee table filter", async () => {
    const user = userEvent.setup(); database(); render(<AdminFinanceWorkspace mode="fees" />);
    await screen.findByText("Fee changes ready");
    await user.selectOptions(screen.getAllByRole("combobox").find((select) => within(select).queryByRole("option", { name: "All students" }))!, "pupil-2");
    await user.click(screen.getByRole("button", { name: "Record payment" }));
    const picker = within(screen.getByRole("dialog", { name: "Record payment" })).getByRole("combobox", { name: "Student fee record" });
    expect(picker).toHaveValue("fee-twin");
    expect(within(picker).getAllByRole("option")).toHaveLength(2);
  });

  it("shows a review of pupil, period, method and amount before posting, and posts only on confirm", async () => {
    const user = userEvent.setup(), db = database(); render(<AdminFinanceWorkspace mode="fees" />);
    await screen.findByText("Fee changes ready");
    await user.click(screen.getByRole("button", { name: "Record payment" }));
    const dialog = within(screen.getByRole("dialog", { name: "Record payment" }));
    await user.selectOptions(dialog.getByRole("combobox", { name: "Student fee record" }), "fee-may");
    await user.type(dialog.getByRole("spinbutton", { name: "Amount" }), "250");
    await user.click(dialog.getByRole("button", { name: "Save payment" }));
    const review = within(dialog.getByRole("region", { name: "Review payment" }));
    expect(review.getByText("Admission no.").nextElementSibling).toHaveTextContent("ADM-1");
    expect(review.getByText("Billing period").nextElementSibling).toHaveTextContent("2026-05");
    expect(review.getByText("Due date").nextElementSibling).toHaveTextContent("2026-05-10");
    expect(review.getByText("Method").nextElementSibling).toHaveTextContent("Cash");
    expect(review.getByText("Amount").nextElementSibling).toHaveTextContent("₹250.00");
    expect(db.rpc).not.toHaveBeenCalled();
    await user.click(dialog.getByRole("button", { name: "Edit" }));
    expect(dialog.queryByRole("region", { name: "Review payment" })).not.toBeInTheDocument();
    expect(dialog.getByRole("spinbutton", { name: "Amount" })).toBeEnabled();
    await user.click(dialog.getByRole("button", { name: "Save payment" }));
    await user.click(dialog.getByRole("button", { name: "Confirm and save" }));
    await screen.findByText("RCPT-NEW");
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith("record_office_fee_payment", expect.objectContaining({ p_student_fee_id: "fee-may", p_amount: "250" }));
  });
});

describe("single receipt and invoice documents", () => {
  it("shows receipt times in IST and prints only the selected receipt with the school name", async () => {
    const user = userEvent.setup(); database(); const print = printWindow();
    render(<AdminFinanceWorkspace mode="invoices" initialTab="receipts" />);
    const row = (await screen.findByText("RCPT-0001")).closest("tr")!;
    expect(row).toHaveTextContent("2 Nov 2026");
    expect(row).toHaveTextContent("IST");
    await user.click(within(row).getByRole("button", { name: "Print RCPT-0001" }));
    expect(print.open).toHaveBeenCalledOnce(); expect(print.popup.print).toHaveBeenCalledOnce(); expect(print.popup.opener).toBeNull();
    const text = print.doc.body.textContent ?? "";
    for (const value of ["Alpha Public School", "Fee receipt RCPT-0001", "ADM-1", "Tuition", "2026-04", "2 Nov 2026", "IST", "₹400.00", "UPI"]) expect(text).toContain(value);
    expect(text).not.toContain("RCPT-NEW");
  });

  it("shows the fee head and billing month the server labelled on each receipt row, detail and print", async () => {
    const user = userEvent.setup(); database(); const print = printWindow();
    // A fully paid demand is no longer in the open positions, so only the server label names it.
    const labelled = { ...receipt, student_fee_id: "fee-paid-off", fee_name: "Transport fee", billing_period: "2026-10" };
    api.receipts.mockResolvedValue([labelled]);
    render(<AdminFinanceWorkspace mode="invoices" initialTab="receipts" />);
    const row = (await screen.findByText("RCPT-0001")).closest("tr")!;
    expect(within(row).getByText("Transport fee · 2026-10")).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "View RCPT-0001" }));
    const detail = screen.getByRole("heading", { name: "Receipt RCPT-0001" }).closest("section")!;
    expect(within(detail).getByText("Fee").nextElementSibling).toHaveTextContent("Transport fee");
    expect(within(detail).getByText("Billing period").nextElementSibling).toHaveTextContent("2026-10");
    await user.click(within(row).getByRole("button", { name: "Print RCPT-0001" }));
    const text = print.doc.body.textContent ?? "";
    for (const value of ["Transport fee", "2026-10", "2 Nov 2026", "IST"]) expect(text).toContain(value);
  });

  it("downloads one receipt as CSV instead of a JSON preview", async () => {
    const user = userEvent.setup(), blobs: Blob[] = []; database();
    const NativeURL = URL;
    class TestURL extends NativeURL { static createObjectURL(blob: Blob | MediaSource) { if (blob instanceof Blob) blobs.push(blob); return "blob:qa"; } static revokeObjectURL() {} }
    vi.stubGlobal("URL", TestURL); const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<AdminFinanceWorkspace mode="invoices" initialTab="receipts" />);
    await user.click(await screen.findByRole("button", { name: "Download RCPT-0001 as CSV" }));
    expect(blobs[0].type).toBe("text/csv;charset=utf-8");
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe("RCPT-0001.csv");
    const csv = await readBlob(blobs[0]);
    expect(csv).toContain("School,Alpha Public School"); expect(csv).toContain("Receipt number,RCPT-0001"); expect(csv).toContain("Admission number,ADM-1");
  });

  it("prints one invoice with its billing period and advance-credit line", async () => {
    const user = userEvent.setup(); database(); const print = printWindow();
    render(<AdminFinanceWorkspace mode="invoices" />);
    const row = (await screen.findAllByText("2026-05"))[0].closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Print invoice" }));
    const text = print.doc.body.textContent ?? "";
    for (const value of ["Alpha Public School", "Fee invoice", "ADM-1", "2026-05", "2026-05-10", "Advance credit applied", "₹1,000.00"]) expect(text).toContain(value);
  });

  it("reports a blocked print window instead of failing silently", async () => {
    const user = userEvent.setup(); database(); vi.spyOn(window, "open").mockReturnValue(null);
    render(<AdminFinanceWorkspace mode="invoices" initialTab="receipts" />);
    await user.click(await screen.findByRole("button", { name: "Print RCPT-0001" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("print window was blocked");
  });
});

describe("office finance layout and accessibility", () => {
  it("focuses the search, explains the balance and closes on Escape", async () => {
    const user = userEvent.setup(); database(); render(<AdminFinanceWorkspace mode="fees" />);
    const row = (await screen.findByText("10 May 2026")).closest("tr")!;
    expect(within(row).getByText("pending")).toHaveClass("badge", "text-warning");
    await user.click(screen.getByRole("button", { name: "Record payment" }));
    const dialog = within(screen.getByRole("dialog", { name: "Record payment" }));
    expect(dialog.getByRole("searchbox", { name: "Find student or fee" })).toHaveFocus();
    await user.selectOptions(dialog.getByRole("combobox", { name: "Student fee record" }), "fee-may");
    expect(dialog.getByRole("spinbutton", { name: "Amount" })).toHaveAccessibleDescription("Balance due ₹1,000.00 · INR, up to 2 decimals");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Record payment" })).not.toBeInTheDocument();
  });

  it("names the filters, marks the pressed document type and shows one focused detail at a time", async () => {
    const user = userEvent.setup(); database(); render(<AdminFinanceWorkspace mode="invoices" />);
    const row = (await screen.findAllByText("2026-05"))[0].closest("tr")!;
    const group = within(screen.getByRole("group", { name: "Document type" }));
    expect(group.getByRole("button", { name: "Invoices" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("combobox", { name: "Filter by status" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Filter by student" })).toBeInTheDocument();
    expect(screen.queryByText("Payment month")).not.toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "View invoice" }));
    expect(screen.getByRole("heading", { name: "Invoice detail" })).toHaveFocus();
    await user.click(group.getByRole("button", { name: "Receipts" }));
    expect(group.getByRole("button", { name: "Receipts" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Payment month")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View RCPT-0001" }));
    expect(screen.getByRole("heading", { name: "Receipt RCPT-0001" })).toHaveFocus();
    expect(screen.queryByRole("heading", { name: "Invoice detail" })).not.toBeInTheDocument();
  });
});

describe("multi-school finance users", () => {
  it("defaults to the same school whatever the role row order and offers an explicit school picker", async () => {
    roles = [{ role: "accountant", school_id: "school-b" }, { role: "accountant", school_id: "school-a" }];
    const db = database(); render(<AdminFinanceWorkspace mode="reports" />);
    expect(await screen.findByText("Day close for school-a")).toBeInTheDocument();
    expect(api.summary).toHaveBeenCalledWith(db.client, "school-a");
    const picker = screen.getByRole("combobox", { name: "Finance school" });
    expect(picker).toHaveValue("school-a");
    expect(within(picker).getAllByRole("option").map((option) => option.textContent)).toEqual(["Alpha Public School", "Beta Public School"]);
    const form = picker.closest("form")!;
    let submitted: FormData | undefined;
    form.addEventListener("submit", (event) => { event.preventDefault(); submitted = new FormData(form); });
    await userEvent.setup().selectOptions(picker, "school-b");
    await waitFor(() => expect(submitted?.get("school")).toBe("school-b"));
    expect(form.getAttribute("action")).toBe("/modules/finance-reports");
    expect(form.getAttribute("method")).toBe("get");
  });

  it("loads the requested school on Finance Reports and Invoices", async () => {
    roles = [{ role: "accountant", school_id: "school-a" }, { role: "accountant", school_id: "school-b" }];
    const db = database();
    const view = render(<AdminFinanceWorkspace mode="reports" requestedSchoolId="school-b" />);
    expect(await screen.findByText("Day close for school-b")).toBeInTheDocument();
    view.unmount();
    render(<AdminFinanceWorkspace mode="invoices" requestedSchoolId="school-b" />);
    await waitFor(() => expect(api.receipts).toHaveBeenCalledWith(db.client, "school-b"));
    expect(screen.getByRole("combobox", { name: "Finance school" }).closest("form")).toHaveAttribute("action", "/modules/invoices");
  });

  it("shows no picker to a single-school finance user", async () => {
    database(); render(<AdminFinanceWorkspace mode="reports" />);
    await screen.findByText("Day close for school-a");
    expect(screen.queryByRole("combobox", { name: "Finance school" })).not.toBeInTheDocument();
  });
});
