import type { SupabaseClient } from "@supabase/supabase-js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CashierDayClose } from "../components/admin/cashier-day-close";
import { schoolDate } from "../lib/attendance/types";

describe("cashier day close business conflicts", () => {
  it("reconciles a reversal-only cash day with nonnegative actual cash and an explained positive variance", async () => {
    const user = userEvent.setup();
    const snapshot = { business_date: schoolDate(), revision: 1, receipt_count: 0, reversal_count: 1,
      recorded_total: "-100.00", recorded_cash: "-100.00", gross_total: "0.00", reversed_total: "100.00", invalid_count: 0,
      methods: [{ method: "cash", receipt_count: 0, reversal_count: 1, gross_total: "0.00", reversed_total: "100.00", total: "-100.00" }],
      closed_at: null, closed_by_name: null, counted_cash: null, cash_variance: null, variance_note: null };
    const rpc = vi.fn(async (name: string) => name === "get_office_fee_day" ? { data: snapshot, error: null }
      : { data: { ...snapshot, closed_at: new Date().toISOString(), closed_by_name: "QA Cashier", counted_cash: 0, cash_variance: 100, variance_note: "Prior-day recorded entry correction; no cash paid out." }, error: null });
    render(<CashierDayClose schoolId="school-a" client={{ rpc } as unknown as SupabaseClient} />);
    const counted = await screen.findByRole("spinbutton", { name: "Counted cash" });
    expect(screen.getByText("Net recorded cash").nextElementSibling).toHaveTextContent("−₹100.00");
    expect(screen.getByText(/0 paid receipts \(0 advance\) · 1 reversal · 0 offline refunds\./)).toBeVisible();
    await user.type(counted, "0");
    expect(screen.getByRole("button", { name: "Review and close day" })).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: /^Variance note/ }), "Prior-day recorded entry correction; no cash paid out.");
    await user.click(screen.getByRole("button", { name: "Review and close day" }));
    expect(rpc.mock.calls.filter(([name]) => name === "close_office_fee_day")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Confirm day close" }));
    await screen.findByText("Close recorded");
    expect(rpc).toHaveBeenLastCalledWith("close_office_fee_day", expect.objectContaining({ p_counted_cash: 0, p_revision: 1,
      p_note: "Prior-day recorded entry correction; no cash paid out." }));
  });

  it("shows advance receipts as part of gross cash and deducts completed offline refunds without counting allocations again", async () => {
    const user = userEvent.setup();
    const snapshot = { business_date: schoolDate(), revision: 4, receipt_count: 2, advance_count: 1, reversal_count: 1, refund_count: 1,
      gross_total: "1200.00", advance_total: "1000.00", reversed_total: "100.00", refunded_total: "150.00", recorded_total: "950.00", recorded_cash: "950.00", invalid_count: 0,
      methods: [{ method: "cash", receipt_count: 2, advance_count: 1, reversal_count: 1, refund_count: 1, gross_total: "1200.00", advance_total: "1000.00", reversed_total: "100.00", refunded_total: "150.00", total: "950.00" }],
      closed_at: null, closed_by_name: null, counted_cash: null, cash_variance: null, variance_note: null };
    const rpc = vi.fn(async (name: string) => ({ data: name === "get_office_fee_day" ? snapshot : { ...snapshot, closed_at: new Date().toISOString(), counted_cash: "950.00", cash_variance: "0.00" }, error: null }));
    render(<CashierDayClose schoolId="school-a" client={{ rpc } as unknown as SupabaseClient} />);
    const counted = await screen.findByRole("spinbutton", { name: "Counted cash" });
    expect(screen.getByText("Gross money received").nextElementSibling).toHaveTextContent("₹1,200.00");
    expect(screen.getByText("Advance receipts included").nextElementSibling).toHaveTextContent("₹1,000.00");
    expect(screen.getByText("Offline refunds paid").nextElementSibling).toHaveTextContent("₹150.00");
    expect(screen.getByText("Net day collections").nextElementSibling).toHaveTextContent("₹950.00");
    expect(screen.getByText(/2 paid receipts \(1 advance\) · 1 reversal · 1 offline refund\./)).toBeVisible();
    await user.type(counted, "950");
    await user.click(screen.getByRole("button", { name: "Review and close day" }));
    await user.click(screen.getByRole("button", { name: "Confirm day close" }));
    await screen.findByText("Close recorded");
    expect(rpc).toHaveBeenLastCalledWith("close_office_fee_day", expect.objectContaining({ p_counted_cash: 950, p_revision: 4 }));
  });

  it.each(["PT409", "40001"])("keeps the cash draft and waits for an explicit refresh before closing changed receipts (%s)", async (code) => {
    const user = userEvent.setup();
    let snapshot = { business_date: schoolDate(), revision: 0, receipt_count: 1, recorded_total: 100, recorded_cash: 100, invalid_count: 0,
      methods: [{ method: "cash", receipt_count: 1, total: 100 }], closed_at: null as string | null, closed_by_name: null as string | null,
      counted_cash: null as number | null, cash_variance: null as number | null, variance_note: null as string | null };
    let closeCalls = 0;
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "get_office_fee_day") return { data: structuredClone(snapshot), error: null };
      if (name !== "close_office_fee_day") throw new Error("Unexpected RPC " + name);
      closeCalls += 1;
      if (closeCalls === 1) return { data: null, error: { code, message: "Receipts changed since this review." } };
      snapshot = { ...snapshot, closed_at: new Date().toISOString(), closed_by_name: "QA Cashier", counted_cash: Number(args.p_counted_cash),
        cash_variance: Number(args.p_counted_cash) - snapshot.recorded_cash, variance_note: String(args.p_note) };
      return { data: structuredClone(snapshot), error: null };
    });
    const client = { rpc } as unknown as SupabaseClient;
    render(<CashierDayClose schoolId="school-a" client={client} />);
    const counted = await screen.findByRole("spinbutton", { name: "Counted cash" });
    await user.type(counted, "120");
    const note = screen.getByRole("textbox", { name: /^Variance note/ });
    await user.type(note, "Till recount checked by office.");
    await user.click(screen.getByRole("button", { name: "Review and close day" }));
    expect(closeCalls).toBe(0);
    await user.click(screen.getByRole("button", { name: "Confirm day close" }));
    await screen.findByText("The day's receipts or close status changed. Your cash count and note are kept. Refresh day and review the latest totals before closing.");
    expect(counted).toHaveValue(120); expect(note).toHaveValue("Till recount checked by office.");
    expect(screen.queryByText("Close recorded")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review and close day" })).toBeDisabled();
    expect(rpc.mock.calls.filter(([name]) => name === "get_office_fee_day")).toHaveLength(1);
    expect(closeCalls).toBe(1);

    snapshot = { ...snapshot, revision: 1, receipt_count: 2, recorded_total: 150, recorded_cash: 150,
      methods: [{ method: "cash", receipt_count: 2, total: 150 }] };
    await user.click(screen.getByRole("button", { name: "Refresh day" }));
    const refreshedCount = await screen.findByRole("spinbutton", { name: "Counted cash" });
    expect(refreshedCount).toHaveValue(120);
    expect(screen.getByRole("textbox", { name: /^Variance note/ })).toHaveValue("Till recount checked by office.");
    await user.click(screen.getByRole("button", { name: "Review and close day" }));
    expect(closeCalls).toBe(1);
    await user.click(screen.getByRole("button", { name: "Confirm day close" }));
    await screen.findByText("Close recorded");
    expect(rpc).toHaveBeenLastCalledWith("close_office_fee_day", { p_school_id: "school-a", p_day: schoolDate(), p_revision: 1,
      p_counted_cash: 120, p_note: "Till recount checked by office." });
    expect(closeCalls).toBe(2);
    expect(snapshot.cash_variance).toBe(-30);
  });

  it("names a cash shortage or overage in text, not only with the minus sign", async () => {
    const user = userEvent.setup();
    const snapshot = { business_date: schoolDate(), revision: 1, receipt_count: 1, recorded_total: "250.00", recorded_cash: "250.00", invalid_count: 0,
      methods: [{ method: "bank_transfer", receipt_count: 1, total: "250.00" }], closed_at: null, closed_by_name: null, counted_cash: null, cash_variance: null, variance_note: null };
    const rpc = vi.fn(async () => ({ data: snapshot, error: null }));
    render(<CashierDayClose schoolId="school-a" client={{ rpc } as unknown as SupabaseClient} />);
    const counted = await screen.findByRole("spinbutton", { name: "Counted cash" });
    expect(screen.getByText("Bank transfer")).toBeInTheDocument();
    await user.type(counted, "0");
    expect(screen.getByText(/^Cash variance/)).toHaveTextContent("Cash variance −₹250.00 · cash short");
    expect(screen.getByText("· cash short", { exact: false })).toHaveClass("text-danger");
    await user.clear(counted);
    await user.type(counted, "300");
    expect(screen.getByText(/^Cash variance/)).toHaveTextContent("Cash variance ₹50.00 · cash over");
    expect(screen.getByText("· cash over", { exact: false })).toHaveClass("text-warning");
    await user.clear(counted);
    await user.type(counted, "250");
    expect(screen.getByText(/^Cash variance/)).toHaveTextContent(/^Cash variance ₹0\.00$/);
  });
});
