import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdvanceCreditAccount } from "../components/finance/advance-credit-account";
import { AdvanceCreditError, type CreditActivity, type CreditChangeRequest, type OfficeCreditAccount } from "../lib/finance/advance-credit";
import { schoolDate } from "../lib/attendance/types";

const mocks = vi.hoisted(() => ({
  account: vi.fn(), ledger: vi.fn(), changes: vi.fn(), receive: vi.fn(), allocate: vi.fn(), request: vi.fn(), review: vi.fn(), payout: vi.fn(), cancel: vi.fn(), getUser: vi.fn(), rpc: vi.fn(), subscribe: vi.fn(),
}));
vi.mock("@/lib/finance/advance-credit", async (original) => ({
  ...await original<typeof import("../lib/finance/advance-credit")>(),
  getOfficeStudentCredit: mocks.account, listOfficeCreditChanges: mocks.changes,
  recordOfficeCreditReceipt: mocks.receive, allocateOfficeCredit: mocks.allocate, requestOfficeCreditChange: mocks.request,
  reviewOfficeCreditChange: mocks.review, payOfficeCreditRefund: mocks.payout, cancelOfficeCreditRefund: mocks.cancel,
}));
vi.mock("@/lib/finance/fee-batches", async (original) => ({ ...await original<typeof import("../lib/finance/fee-batches")>(), getOfficeFeeLedger: mocks.ledger }));
let authChanged: (event: string, session: { user: { id: string } } | null) => void;
const client = { auth: { getUser: mocks.getUser, onAuthStateChange: mocks.subscribe }, rpc: mocks.rpc } as unknown as SupabaseClient;
const baseProps = { client, schoolId: "school", studentId: "student", userId: "actor", canReview: true };
const received: CreditActivity = { id: "original", kind: "receipt", amount: "100.00", reference: "CASH-ORIGINAL", occurred_at: "2026-11-05T10:00:00Z", payment_method: "cash", fee_id: null, fee_name: null, related_reference: null };
const allocation: CreditActivity = { ...received, id: "allocation", kind: "allocation", amount: "600.00", reference: "ALLOC-ORIGINAL", payment_method: null, fee_id: "fee", fee_name: "Tuition" };
function account(studentId = "student"): OfficeCreditAccount {
  return { school_id: "school", student_id: studentId, admission_no: studentId === "student" ? "QA-1" : "QA-2", student_name: studentId === "student" ? "QA Child" : "Other Child", financial_token: "credit-v1",
    summary: { invalid: false, received_amount: "1600.00", reversed_amount: "0.00", allocated_amount: "600.00", refunded_amount: "0.00", reserved_amount: "0.00", balance_amount: "1000.00", available_amount: "1000.00" }, activities: [received, allocation], activity_count: 2 };
}
const fee = { demand_id: "fee", student_id: "student", admission_no: "QA-1", student_name: "QA Child", academic_year_id: "year", academic_year_name: "2026–27", fee_name: "Tuition", kind: "monthly", billing_period: "2026-11", due_date: "2026-11-10", amount: "1000.00", discount: "0.00", late_fee: "0.00", net_amount: "1000.00", paid_amount: "600.00", balance: "400.00", status: "partial", financial_token: "fee-v1", invalid: false };
function request(overrides: Partial<CreditChangeRequest> = {}): CreditChangeRequest {
  return { id: "request", school_id: "school", student_id: "student", admission_no: "QA-1", student_name: "QA Child", kind: "refund", amount: "150.00", entry_target_id: null, target_reference: null, fee_id: null, request_reason: "Parent requested refund", requested_by: "finance", requester_name: "QA Finance", requested_at: "2026-11-05T10:00:00Z", state: "pending", financial_token: "credit-v1", fee_token: null, reviewed_by: null, reviewer_name: null, review_reason: null, reviewed_at: null, entry_id: null, reference: null, effective_day: null, cancelled_by: null, canceller_name: null, cancel_reason: null, cancelled_at: null, ...overrides };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function ready() { await screen.findByRole("heading", { name: "QA Child" }); }
function fill(formName: string, amount = "100", reason = "Reviewed school entry") {
  const form = within(screen.getByRole("form", { name: formName }));
  const input = form.queryByLabelText("Amount (INR)") ?? form.queryByLabelText("Credit to return (INR)");
  if (input) fireEvent.change(input, { target: { value: amount } });
  fireEvent.change(form.getByLabelText("Reason"), { target: { value: reason } });
  return form;
}
async function confirm(name: string) {
  fireEvent.click(screen.getByRole("checkbox", { name: "I checked this student, amount and financial effect." }));
  fireEvent.click(screen.getByRole("button", { name }));
}
async function openRefund(row: CreditChangeRequest) {
  mocks.changes.mockResolvedValue({ rows: [row], total_count: 1 });
  render(<AdvanceCreditAccount {...baseProps} />);
  await ready(); fireEvent.click(screen.getByRole("button", { name: "Refunds" }));
  fireEvent.click(screen.getByRole("button", { name: "View credit request request" }));
}

beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "actor" } }, error: null });
  mocks.subscribe.mockImplementation((callback) => { authChanged = callback; return { data: { subscription: { unsubscribe: vi.fn() } } }; });
  mocks.account.mockImplementation((_client, _school, studentId) => Promise.resolve(account(studentId)));
  mocks.ledger.mockResolvedValue({ rows: [fee], summary: { demand_count: 1 } });
  mocks.changes.mockResolvedValue({ rows: [], total_count: 0 });
  mocks.rpc.mockResolvedValue({ data: { business_date: schoolDate(), closed_at: null, invalid_count: 0 }, error: null });
  mocks.receive.mockResolvedValue({ ...received, id: "posted", reference: "QA-RECEIVE" });
  mocks.allocate.mockResolvedValue(allocation);
  mocks.request.mockResolvedValue(request());
  mocks.review.mockResolvedValue(request({ state: "approved", reviewed_by: "actor", reviewer_name: "QA Admin", review_reason: "Checked unused balance", reviewed_at: "2026-11-05T11:00:00Z" }));
  mocks.payout.mockResolvedValue(request({ state: "paid", reference: "PAYOUT-150", entry_id: "payout" }));
  mocks.cancel.mockResolvedValue(request({ state: "cancelled" }));
});

describe("advance-credit cash and allocation boundaries", () => {
  it("keeps new receipts disabled on a closed day while stored-credit application remains available", async () => {
    mocks.rpc.mockResolvedValue({ data: { business_date: schoolDate(), closed_at: "2026-11-05T12:00:00Z", invalid_count: 0 }, error: null });
    render(<AdvanceCreditAccount {...baseProps} />); await ready();
    expect(screen.getByRole("button", { name: "Review advance receipt" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("A new advance receipt cannot be recorded");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    const form = fill("Apply advance form", "100");
    fireEvent.change(form.getByLabelText("Fee to settle"), { target: { value: "fee" } });
    expect(form.getByRole("button", { name: "Review credit application" })).toBeEnabled();
    fireEvent.click(form.getByRole("button", { name: "Review credit application" })); await confirm("Confirm credit application");
    await waitFor(() => expect(mocks.allocate).toHaveBeenCalledOnce());
    expect(mocks.receive).not.toHaveBeenCalled();
  });

  it("requires review and explicit confirmation, submits once, and retains the same unknown receipt across reload", async () => {
    mocks.receive.mockRejectedValueOnce(new AdvanceCreditError("Network result unknown"));
    const view = render(<AdvanceCreditAccount {...baseProps} />); await ready();
    const form = fill("Receive advance form", "1000");
    fireEvent.change(form.getByLabelText("Unique receipt / transaction reference"), { target: { value: "QA-RECEIVE" } });
    fireEvent.click(form.getByRole("button", { name: "Review advance receipt" }));
    expect(mocks.receive).not.toHaveBeenCalled();
    const confirmButton = screen.getByRole("button", { name: "Confirm advance received" });
    expect(confirmButton).toBeDisabled();
    await confirm("Confirm advance received");
    await screen.findByRole("button", { name: "Retry saved operation" });
    const savedInput = mocks.receive.mock.calls[0][2];
    expect(savedInput).toMatchObject({ studentId: "student", amount: "1000.00", reference: "QA-RECEIVE", method: "cash" });
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    view.unmount();
    const result = deferred<CreditActivity>(); mocks.receive.mockReturnValueOnce(result.promise);
    render(<AdvanceCreditAccount {...baseProps} />);
    const retry = await screen.findByRole("button", { name: "Retry saved operation" });
    fireEvent.click(retry); fireEvent.click(retry);
    await waitFor(() => expect(mocks.receive).toHaveBeenCalledTimes(2));
    expect(mocks.receive.mock.calls[1][2]).toEqual(savedInput);
    await act(async () => result.resolve(received));
    expect(await screen.findByText(/Advance received and recorded/)).toBeInTheDocument();
    expect(sessionStorage.getItem("kids-corner-advance-operation:v1:actor:school:student")).toBeNull();
  });

  it("applies exact stored credit with both tokens and never records a new cash receipt", async () => {
    render(<AdvanceCreditAccount {...baseProps} />); await ready(); fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    const form = fill("Apply advance form", "123.45");
    fireEvent.change(form.getByLabelText("Fee to settle"), { target: { value: "fee" } });
    fireEvent.click(form.getByRole("button", { name: "Review credit application" }));
    expect(screen.getByText(/New money received: ₹0.00/)).toBeInTheDocument();
    await confirm("Confirm credit application");
    await waitFor(() => expect(mocks.allocate).toHaveBeenCalledOnce());
    expect(mocks.allocate.mock.calls[0][2]).toMatchObject({ amount: "123.45", feeId: "fee", expectedCreditToken: "credit-v1", expectedFeeToken: "fee-v1" });
    expect(mocks.receive).not.toHaveBeenCalled();
    expect(await screen.findByText(/Stored credit applied/)).toBeInTheDocument();
  });

  it("keeps a stale allocation draft and requires refreshed balances before another confirmation", async () => {
    mocks.allocate.mockRejectedValueOnce(new AdvanceCreditError("Balances changed", "PT409"));
    render(<AdvanceCreditAccount {...baseProps} />); await ready(); fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    const form = fill("Apply advance form", "100");
    fireEvent.change(form.getByLabelText("Fee to settle"), { target: { value: "fee" } });
    fireEvent.click(form.getByRole("button", { name: "Review credit application" })); await confirm("Confirm credit application");
    await screen.findByText(/Balances changed/);
    expect(form.getByLabelText("Amount (INR)")).toHaveValue("100");
    expect(form.getByRole("button", { name: "Review credit application" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh credit account" }));
    await waitFor(() => expect(form.getByRole("button", { name: "Review credit application" })).toBeEnabled());
  });
});

describe("reviewed offline refunds and credit corrections", () => {
  it("saves a refund request without paying and blocks self review", async () => {
    mocks.request.mockResolvedValueOnce(request({ requested_by: "actor" }));
    mocks.changes.mockResolvedValue({ rows: [request({ requested_by: "actor" })], total_count: 1 });
    render(<AdvanceCreditAccount {...baseProps} />); await ready(); fireEvent.click(screen.getByRole("button", { name: "Refunds" }));
    const form = fill("Request unused-credit refund form", "150");
    fireEvent.click(form.getByRole("button", { name: "Review refund request" })); await confirm("Confirm refund request");
    expect(await screen.findByText(/Request saved for independent review/)).toBeInTheDocument();
    expect(mocks.payout).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "View credit request request" }));
    expect(screen.getByText(/You requested this change/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review credit reservation" })).not.toBeInTheDocument();
  });

  it("approves a reservation without claiming that money has been paid out", async () => {
    await openRefund(request());
    fireEvent.change(screen.getByLabelText("Credit review reason"), { target: { value: "Checked unused balance" } });
    fireEvent.click(screen.getByRole("button", { name: "Review credit reservation" }));
    expect(screen.getByText(/Actual money movement: ₹0.00/)).toBeInTheDocument();
    await confirm("Confirm credit reservation");
    expect(await screen.findByText(/Refund approved. Credit is reserved; payout has not been recorded/)).toBeInTheDocument();
    expect(mocks.payout).not.toHaveBeenCalled();
  });

  it("does not turn a recovered paid approval into a new reservation", async () => {
    mocks.review.mockResolvedValueOnce(request({ state: "paid", reference: "PAID-ALREADY" }));
    await openRefund(request());
    fireEvent.change(screen.getByLabelText("Credit review reason"), { target: { value: "Checked unused balance" } });
    fireEvent.click(screen.getByRole("button", { name: "Review credit reservation" })); await confirm("Confirm credit reservation");
    expect(await screen.findByText(/completed offline payout is already recorded/)).toBeInTheDocument();
    expect(screen.queryByText(/Refund approved. Credit is reserved;/)).not.toBeInTheDocument();
  });

  it("blocks approval on an invalid credit account but permits rejecting the obsolete request", async () => {
    const invalid = account(); invalid.financial_token = null;
    invalid.summary = { invalid: true, received_amount: null, reversed_amount: null, allocated_amount: null, refunded_amount: null, reserved_amount: null, balance_amount: null, available_amount: null };
    mocks.account.mockResolvedValue(invalid);
    await openRefund(request());
    fireEvent.change(screen.getByLabelText("Credit review reason"), { target: { value: "Reconcile invalid records first" } });
    expect(screen.getByRole("button", { name: "Review credit reservation" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Review request rejection" })).toBeEnabled();
    expect(mocks.review).not.toHaveBeenCalled();
  });

  it("does not approve an advance receipt book reversal on a closed cashier day", async () => {
    mocks.rpc.mockResolvedValue({ data: { business_date: schoolDate(), closed_at: "2026-11-05T12:00:00Z", invalid_count: 0 }, error: null });
    mocks.changes.mockResolvedValue({ rows: [request({ kind: "receipt_reversal", entry_target_id: "original", target_reference: "CASH-ORIGINAL" })], total_count: 1 });
    render(<AdvanceCreditAccount {...baseProps} />); await ready(); fireEvent.click(screen.getByRole("button", { name: "Refunds" }));
    fireEvent.click(screen.getByRole("button", { name: "View credit request request" }));
    fireEvent.change(screen.getByLabelText("Credit review reason"), { target: { value: "Correction checked by admin" } });
    expect(screen.getByRole("button", { name: "Review correction approval" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Review request rejection" })).toBeEnabled();
  });

  it("preserves a stale review reason and allows rejection but never makes that snapshot approvable by refresh", async () => {
    mocks.review.mockRejectedValueOnce(new AdvanceCreditError("Request snapshot changed", "PT409"));
    await openRefund(request());
    const reason = screen.getByLabelText("Credit review reason");
    fireEvent.change(reason, { target: { value: "Keep original review reason" } });
    fireEvent.click(screen.getByRole("button", { name: "Review credit reservation" })); await confirm("Confirm credit reservation");
    await screen.findByText(/Request snapshot changed/);
    expect(reason).toHaveValue("Keep original review reason");
    fireEvent.click(screen.getByRole("button", { name: "Refresh credit account" }));
    await screen.findByLabelText("Credit review reason");
    expect(screen.getByRole("button", { name: "Review credit reservation" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Review request rejection" })).toBeEnabled();
  });

  it("requires completed-offline-payout attestation and retries a lost payout response with the same payout UUID", async () => {
    mocks.payout.mockRejectedValueOnce(new AdvanceCreditError("Payout response lost"));
    const row = request({ state: "approved", reviewed_by: "principal", review_reason: "Checked unused balance" });
    mocks.changes.mockResolvedValue({ rows: [row], total_count: 1 });
    const view = render(<AdvanceCreditAccount {...baseProps} />); await ready(); fireEvent.click(screen.getByRole("button", { name: "Refunds" }));
    fireEvent.click(screen.getByRole("button", { name: "View credit request request" }));
    const form = within(screen.getByRole("form", { name: "Record completed offline payout form" }));
    fireEvent.change(form.getByLabelText("Unique payout / transaction reference"), { target: { value: "PAYOUT-150" } });
    fireEvent.change(form.getByLabelText("Payout reason"), { target: { value: "Cash handed over with proof" } });
    expect(form.getByRole("button", { name: "Review offline payout record" })).toBeDisabled();
    fireEvent.click(form.getByRole("checkbox", { name: /I verified the open cashier day/ }));
    fireEvent.click(form.getByRole("button", { name: "Review offline payout record" })); await confirm("Confirm offline payout record");
    await screen.findByRole("button", { name: "Retry saved operation" });
    const input = mocks.payout.mock.calls[0][1]; view.unmount();
    render(<AdvanceCreditAccount {...baseProps} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry saved operation" }));
    await waitFor(() => expect(mocks.payout).toHaveBeenCalledTimes(2));
    expect(mocks.payout.mock.calls[1][1]).toEqual(input);
    expect(input).toMatchObject({ requestId: "request", reference: "PAYOUT-150", reason: "Cash handed over with proof" });
    expect(input.payoutId).toEqual(expect.any(String));
    expect(await screen.findByText(/completed offline payout is already recorded/)).toBeInTheDocument();
  });

  it("keeps closed-day payout disabled while a reviewer can cancel an unpaid reservation without cash movement", async () => {
    mocks.rpc.mockResolvedValue({ data: { business_date: schoolDate(), closed_at: "2026-11-05T12:00:00Z", invalid_count: 0 }, error: null });
    await openRefund(request({ state: "approved" }));
    expect(screen.getByRole("button", { name: "Review offline payout record" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /I verified the open cashier day/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Refund cancellation reason"), { target: { value: "No payout made; release reservation" } });
    fireEvent.click(screen.getByRole("button", { name: "Review refund cancellation" })); await confirm("Confirm refund cancellation");
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith(client, "request", "No payout made; release reservation"));
    expect(await screen.findByText(/reserved credit has been released/)).toBeInTheDocument();
    expect(mocks.payout).not.toHaveBeenCalled();
  });

  it("requests a partial allocation return with the fee token and no new cash movement", async () => {
    render(<AdvanceCreditAccount {...baseProps} />); await ready(); fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    const form = fill("Request credit correction form", "100");
    fireEvent.change(form.getByLabelText("Original credit entry"), { target: { value: "allocation" } });
    fireEvent.click(form.getByRole("button", { name: "Review credit correction request" })); await confirm("Confirm return applied credit request");
    await waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
    expect(mocks.request.mock.calls[0][2]).toMatchObject({ kind: "allocation_return", entryId: "allocation", amount: "100.00", expectedCreditToken: "credit-v1", expectedFeeToken: "fee-v1" });
    expect(mocks.receive).not.toHaveBeenCalled(); expect(mocks.payout).not.toHaveBeenCalled();
  });

  it("requests only the full original receipt reversal and keeps it distinct from an actual refund", async () => {
    render(<AdvanceCreditAccount {...baseProps} />); await ready(); fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    fireEvent.change(screen.getByLabelText("Credit correction type"), { target: { value: "receipt_reversal" } });
    const form = fill("Request credit correction form");
    fireEvent.change(form.getByLabelText("Original credit entry"), { target: { value: "original" } });
    expect(form.queryByLabelText("Amount (INR)")).not.toBeInTheDocument();
    fireEvent.click(form.getByRole("button", { name: "Review credit correction request" }));
    expect(screen.getByText(/This corrects a recorded entry; it does not send a bank refund/)).toBeInTheDocument();
    await confirm("Confirm reverse advance entry request");
    await waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
    expect(mocks.request.mock.calls[0][2]).toMatchObject({ kind: "receipt_reversal", amount: null, entryId: "original", expectedFeeToken: null });
    expect(mocks.payout).not.toHaveBeenCalled();
  });
});

describe("advance-credit account isolation", () => {
  it.each([
    ["invalid JSON", "{broken"],
    ["invalid shape", "null"],
    ["invalid confirmation amount", JSON.stringify({ version: 1, schoolId: "school", studentId: "student", userId: "actor", confirmation: {
      title: "Corrupt operation", detail: "Invalid amount", amount: "not money", cash: "Unknown cash", operation: { kind: "receipt", input: { studentId: "student", amount: "100.00", method: "cash", reference: "REFERENCE-123", reason: "Valid original reason", requestId: "saved-request" } },
    } })],
  ])("blocks financial actions for %s while permitting read-only reconciliation and explicit scoped clearing", async (_description, saved) => {
    const key = "kids-corner-advance-operation:v1:actor:school:student";
    sessionStorage.setItem(key, saved);
    sessionStorage.setItem("kids-corner-advance-operation:v1:other-actor:school:student", "other actor retry");
    sessionStorage.setItem("kids-corner-advance-operation:v1:actor:school:other-student", "other student retry");
    mocks.changes.mockResolvedValue({ rows: [request({ state: "approved" })], total_count: 1 });
    render(<AdvanceCreditAccount {...baseProps} />); await ready();
    expect(screen.getByRole("region", { name: "Unreadable saved credit operation" })).toHaveTextContent("New financial actions are blocked");
    expect(screen.queryByRole("button", { name: "Retry saved operation" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review advance receipt" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    expect(screen.getByRole("list", { name: "Credit activity history" })).toHaveTextContent("CASH-ORIGINAL");
    expect(screen.getByRole("button", { name: "Review credit correction request" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refunds" }));
    expect(screen.getByRole("button", { name: "Review refund request" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "View credit request request" }));
    expect(screen.getByRole("region", { name: "Selected credit request" })).toHaveTextContent("Parent requested refund");
    expect(screen.getByRole("button", { name: "Review offline payout record" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Review refund cancellation" })).toBeDisabled();
    const clear = screen.getByRole("button", { name: "Clear unreadable local retry" });
    expect(clear).toBeDisabled(); fireEvent.click(clear);
    expect(sessionStorage.getItem(key)).toBe(saved);
    fireEvent.click(screen.getByRole("checkbox", { name: "I checked saved activity/requests and reconciled this operation with school finance" }));
    fireEvent.click(clear);
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(sessionStorage.getItem("kids-corner-advance-operation:v1:other-actor:school:student")).toBe("other actor retry");
    expect(sessionStorage.getItem("kids-corner-advance-operation:v1:actor:school:other-student")).toBe("other student retry");
    expect(screen.getByRole("button", { name: "Review refund request" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Receive" }));
    expect(screen.getByRole("button", { name: "Review advance receipt" })).toBeEnabled();
    expect(mocks.receive).not.toHaveBeenCalled();
    expect(mocks.allocate).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.review).not.toHaveBeenCalled(); expect(mocks.payout).not.toHaveBeenCalled(); expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("clears the old draft when the student scope changes and ignores the previous private account", async () => {
    const view = render(<AdvanceCreditAccount {...baseProps} />); await ready();
    fill("Receive advance form", "999", "Private old reason");
    view.rerender(<AdvanceCreditAccount {...baseProps} studentId="other-student" />);
    await screen.findByRole("heading", { name: "Other Child" });
    expect(screen.queryByRole("heading", { name: "QA Child" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Amount (INR)")).toHaveValue("");
    expect(screen.getByLabelText("Reason")).toHaveValue("");
  });

  it("hides prior credit information immediately after the signed-in account changes", async () => {
    render(<AdvanceCreditAccount {...baseProps} />); await ready();
    act(() => authChanged("SIGNED_IN", { user: { id: "different-actor" } }));
    expect(screen.getByRole("alert")).toHaveTextContent("Your sign-in changed");
    expect(screen.queryByRole("heading", { name: "QA Child" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review advance receipt" })).not.toBeInTheDocument();
  });
});
