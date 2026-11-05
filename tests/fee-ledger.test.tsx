import type { SupabaseClient } from "@supabase/supabase-js";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeeLedgerWorkspace } from "../components/finance/fee-ledger";
import * as fees from "../lib/finance/fee-batches";

const row = { demand_id: "demand-a", student_id: "student-a", admission_no: "A-001", student_name: "QA Ledger One", academic_year_id: "year-a", academic_year_name: "2026–27", fee_name: "Opening balance", kind: "opening", billing_period: "2026-11", due_date: "2026-11-05", amount: "1000.00", discount: "0.00", late_fee: "0.00", net_amount: "1000.00", paid_amount: "100.00", balance: "900.00", status: "partial" };
function ledger(): fees.FeeLedger {
  return { academic_year_id: "year-a", rows: [row], summary: { demand_count: 26, net_amount: "26000.00", paid_amount: "100.00", balance: "25900.00", opening_amount: "1000.00", invalid_count: 0 } };
}
function provider() {
  let authEvent: (event: string, session: { user: { id: string } } | null) => void = () => {};
  const client = { auth: {
    getUser: vi.fn().mockResolvedValue({ data: { user: { id: "office-a" } }, error: null }),
    onAuthStateChange: vi.fn((callback) => { authEvent = callback; return { data: { subscription: { unsubscribe: vi.fn() } } }; }),
  } } as unknown as SupabaseClient;
  return { client, authEvent: (event: string, session: { user: { id: string } } | null) => authEvent(event, session) };
}
afterEach(() => { vi.restoreAllMocks(); });

describe("server fee reconciliation ledger", () => {
  it("shows whole-scope totals while paginating only the visible rows", async () => {
    const user = userEvent.setup();
    const read = vi.spyOn(fees, "getOfficeFeeLedger").mockResolvedValueOnce(ledger()).mockResolvedValueOnce({ ...ledger(), rows: [{ ...row, demand_id: "demand-b", student_name: "QA Ledger Last" }] });
    const { client } = provider();
    render(<FeeLedgerWorkspace client={client} schoolId="school-a" academicYearId="year-a" />);
    await screen.findByText("QA Ledger One · A-001");
    expect(screen.getByText("₹25,900.00")).toBeInTheDocument();
    expect(screen.getByText(/Totals cover all 26 demands/)).toBeInTheDocument();
    expect(read).toHaveBeenCalledWith(client, "school-a", "year-a", null, 25, 0);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("QA Ledger Last · A-001");
    expect(read).toHaveBeenLastCalledWith(client, "school-a", "year-a", null, 25, 25);
    expect(screen.getByText("₹25,900.00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("withholds reconciliation totals rather than showing fabricated zero for invalid records", async () => {
    vi.spyOn(fees, "getOfficeFeeLedger").mockResolvedValue({ ...ledger(), summary: { demand_count: 26, net_amount: null, paid_amount: null, balance: null, opening_amount: null, invalid_count: 1 } });
    render(<FeeLedgerWorkspace client={provider().client} schoolId="school-a" academicYearId="year-a" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Reconciliation totals are withheld");
    expect(screen.queryByText("Net demands")).not.toBeInTheDocument();
    expect(screen.queryByText("₹0.00")).not.toBeInTheDocument();
  });

  it("does not render a late ledger response after the account signs out", async () => {
    let complete: (result: fees.FeeLedger) => void = () => {};
    const pending = new Promise<fees.FeeLedger>((resolve) => { complete = resolve; });
    const read = vi.spyOn(fees, "getOfficeFeeLedger").mockReturnValue(pending);
    const { client, authEvent } = provider();
    render(<FeeLedgerWorkspace client={client} schoolId="school-a" academicYearId="year-a" />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    act(() => authEvent("SIGNED_OUT", null));
    await act(async () => { complete(ledger()); await pending; });
    expect(screen.getByRole("alert")).toHaveTextContent("Sign in with a school finance account");
    expect(screen.queryByText("QA Ledger One · A-001")).not.toBeInTheDocument();
    expect(screen.queryByText("₹25,900.00")).not.toBeInTheDocument();
  });
});
