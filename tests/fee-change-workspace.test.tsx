import type { SupabaseClient } from "@supabase/supabase-js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeeChangeWorkspace } from "@/components/finance/fee-change-workspace";
import type { FeeChange, FeeChangeRequestInput, FeeFinancialState, OfficeFeeReceipt } from "@/lib/finance/fee-changes";
import type { FeeLedgerRow } from "@/lib/finance/fee-batches";

const api = vi.hoisted(() => ({ list: vi.fn(), request: vi.fn(), review: vi.fn() }));
vi.mock("@/lib/finance/fee-changes", async (original) => ({ ...await original<typeof import("@/lib/finance/fee-changes")>(),
  listFeeChanges: api.list, requestFeeChange: api.request, reviewFeeChange: api.review,
}));

const before: FeeFinancialState = { base_net_amount: "1000.00", adjustment_amount: "0.00", net_amount: "1000.00", gross_paid_amount: "400.00", reversed_amount: "0.00", paid_amount: "400.00", balance: "600.00" };
const fee: FeeLedgerRow = { demand_id: "fee-a", student_id: "pupil-a", admission_no: "QA-001", student_name: "QA Pupil", academic_year_id: "year-a", academic_year_name: "2026–27", fee_name: "Tuition", kind: "monthly", billing_period: "2026-11", due_date: "2026-11-25", amount: "1000.00", discount: "0.00", late_fee: "0.00", status: "partial", ...before, financial_token: "financial-token-a" };
const payment: OfficeFeeReceipt = { id: "payment-a", student_fee_id: "fee-a", student_id: "pupil-a", receipt_no: "QA-RECEIPT-001", amount: "400.00", payment_method: "cash", status: "paid", recorded_status: "paid", paid_at: "2026-11-04T08:00:00Z", net_amount: "400.00", reversed_amount: "0.00", reversed_at: null, reversal_reference: null, financial_token: "financial-token-a", legacy_refund: false };
const reduced: FeeFinancialState = { ...before, adjustment_amount: "-100.00", net_amount: "900.00", balance: "500.00" };
function change(overrides: Partial<FeeChange> = {}): FeeChange {
  return { id: "request-a", school_id: "school-a", fee_id: "fee-a", student_id: "pupil-a", admission_no: "QA-001", student_name: "QA Pupil", fee_name: "Tuition", kind: "reduction", amount: "100.00", payment_id: null, receipt_no: null, request_reason: "Approved concession source checked", requested_by: "requester-a", requester_name: "QA Accountant", requested_at: "2026-11-05T10:00:00Z", state: "pending", before, after: reduced, financial_token: "financial-token-a", reviewed_by: null, reviewer_name: null, review_reason: null, reviewed_at: null, entry_id: null, reference: null, effective_day: null, ...overrides };
}
function reviewed(request: FeeChange, decision: "approved" | "rejected", reason: string): FeeChange {
  return { ...request, state: decision, reviewed_by: "reviewer-a", reviewer_name: "QA Principal", review_reason: reason, reviewed_at: "2026-11-05T11:00:00Z", entry_id: decision === "approved" ? "entry-a" : null, reference: decision === "approved" ? "FC-QA-001" : null };
}
let rows: FeeChange[] = [];
function client(actor = "requester-a") {
  let listener: ((event: string, session: { user: { id: string } } | null) => void) | undefined;
  return { client: { auth: { getUser: vi.fn(async () => ({ data: { user: { id: actor } }, error: null })), onAuthStateChange: (callback: typeof listener) => { listener = callback; return { data: { subscription: { unsubscribe: vi.fn() } } }; } } } as unknown as SupabaseClient,
    switchActor: (id: string) => listener?.("SIGNED_IN", { user: { id } }) };
}
function props(db: ReturnType<typeof client>, actor = "requester-a", canReview = false) {
  return { client: db.client, schoolId: "school-a", userId: actor, canReview, demands: [fee], payments: [payment], onChanged: vi.fn() };
}
async function prepareReduction(user: ReturnType<typeof userEvent.setup>, amount = "100.00") {
  await waitFor(() => expect(screen.getByRole("button", { name: "Reduce fee" })).toBeEnabled());
  await user.selectOptions(screen.getByLabelText("Fee record to change"), "fee-a");
  await user.type(screen.getByLabelText("Reduction amount"), amount);
  await user.type(screen.getByLabelText("Request reason"), "Approved concession source checked");
  await user.click(screen.getByRole("button", { name: "Preview requested change" }));
}
async function submitPrepared(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("checkbox", { name: "I checked the proposed change and the request reason." }));
  await user.click(screen.getByRole("button", { name: "Submit fee change request" }));
}
beforeEach(() => {
  sessionStorage.clear(); rows = [];
  api.list.mockReset().mockImplementation(async (_client, _school, state) => ({ rows: rows.filter((row) => state === "all" || row.state === state), total_count: rows.filter((row) => state === "all" || row.state === state).length }));
  api.request.mockReset().mockImplementation(async (_client, _school, input: FeeChangeRequestInput) => {
    const result = change({ id: input.requestId, amount: input.amount || payment.amount, kind: input.kind, payment_id: input.paymentId, receipt_no: input.paymentId ? payment.receipt_no : null });
    rows.push(result); return result;
  });
  api.review.mockReset().mockImplementation(async (_client, requestId, decision, reason) => {
    const result = reviewed(rows.find((row) => row.id === requestId)!, decision, reason); rows = rows.map((row) => row.id === requestId ? result : row); return result;
  });
});

describe("governed fee change UI", () => {
  it("shows a nonbinding exact-decimal proposal and submits only a pending request after explicit checking", async () => {
    const user = userEvent.setup(), db = client(), inputProps = props(db);
    render(<FeeChangeWorkspace {...inputProps} />);
    await prepareReduction(user);
    const proposal = within(await screen.findByRole("region", { name: "Proposed fee change" }));
    expect(proposal.getByText("₹900.00")).toBeVisible(); expect(proposal.getByText("₹500.00")).toBeVisible();
    expect(proposal.getByText(/server rechecks the financial snapshot/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Submit fee change request" })).toBeDisabled();
    expect(api.request).not.toHaveBeenCalled(); expect(api.review).not.toHaveBeenCalled();
    await submitPrepared(user);
    await screen.findByText("Request submitted. The fee and payment records stay unchanged until a different School Admin or Principal approves it.");
    expect(api.request).toHaveBeenCalledWith(db.client, "school-a", expect.objectContaining({ feeId: "fee-a", kind: "reduction", amount: "100.00", paymentId: null, expectedToken: "financial-token-a" }));
    expect(api.review).not.toHaveBeenCalled(); expect(fee.net_amount).toBe("1000.00"); expect(payment.amount).toBe("400.00");
  });

  it("rejects a reduction below credited payments without sending a request", async () => {
    const user = userEvent.setup(), db = client();
    render(<FeeChangeWorkspace {...props(db)} />);
    await prepareReduction(user, "600.01");
    await screen.findByText("A reduction cannot exceed the outstanding balance. Review any payment-entry correction separately.");
    expect(screen.queryByRole("region", { name: "Proposed fee change" })).not.toBeInTheDocument(); expect(api.request).not.toHaveBeenCalled();
  });

  it("proposes a full reversal with a current-day counter-entry and no editable partial amount or bank-refund promise", async () => {
    const user = userEvent.setup(), db = client();
    render(<FeeChangeWorkspace {...props(db)} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Reverse payment entry" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Reverse payment entry" }));
    await user.selectOptions(screen.getByLabelText("Paid receipt to correct"), "payment-a");
    await user.type(screen.getByLabelText("Request reason"), "Duplicate manual receipt entry verified");
    await user.click(screen.getByRole("button", { name: "Preview requested change" }));
    const proposal = within(await screen.findByRole("region", { name: "Proposed fee change" }));
    expect(proposal.getByText("This corrects a recorded entry; it does not send a bank refund.")).toBeVisible();
    expect(proposal.getByText(/Cash book impact: −₹400.00/)).toBeVisible();
    expect(proposal.getByText(/counter-entry reduces Cash collections/)).toBeVisible();
    expect(screen.queryByLabelText("Reduction amount")).not.toBeInTheDocument();
    await submitPrepared(user); await waitFor(() => expect(api.request).toHaveBeenCalledTimes(1));
    expect(api.request.mock.calls[0][2]).toEqual(expect.objectContaining({ kind: "payment_reversal", amount: null, paymentId: "payment-a" }));
    expect(payment.amount).toBe("400.00"); expect(payment.status).toBe("paid");
  });

  it("prevents self-review even when the requester has school review permission", async () => {
    rows = [change()]; const db = client();
    render(<FeeChangeWorkspace {...props(db, "requester-a", true)} />);
    await screen.findByText("Another School Admin or Principal must review your request.");
    expect(screen.queryByRole("button", { name: "Review fee request" })).not.toBeInTheDocument(); expect(api.review).not.toHaveBeenCalled();
  });

  it("keeps a stale review reason, blocks approval after refresh, and lets the reviewer reject the immutable obsolete request", async () => {
    const user = userEvent.setup(), db = client("reviewer-a"), inputProps = props(db, "reviewer-a", true);
    rows = [change()];
    api.review.mockRejectedValueOnce(Object.assign(new Error("Financial records changed."), { code: "PT409" }));
    render(<FeeChangeWorkspace {...inputProps} />);
    await user.click(await screen.findByRole("button", { name: "Review fee request" }));
    await user.type(screen.getByLabelText("Review reason"), "Checked the office source again");
    await user.click(screen.getByRole("button", { name: "Approve fee change" }));
    await screen.findByText("The financial records changed. Your review reason is kept. Refresh requests, reject this outdated request and ask for a new request based on the latest ledger.");
    expect(screen.getByLabelText("Review reason")).toHaveValue("Checked the office source again");
    expect(screen.getByRole("button", { name: "Approve fee change" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Reject fee change" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Refresh fee requests" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Reject fee change" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Approve fee change" })).toBeDisabled();
    expect(screen.getByLabelText("Review reason")).toHaveValue("Checked the office source again");
    await user.click(screen.getByRole("button", { name: "Reject fee change" }));
    await screen.findByText("Request rejected. The fee and payment records were kept unchanged.");
    expect(api.review.mock.calls[1]).toEqual([db.client, "request-a", "rejected", "Checked the office source again"]);
  });

  it("recovers a lost request after reload with its original target, amount, token and UUID", async () => {
    const user = userEvent.setup(), db = client(), inputProps = props(db);
    let stored: FeeChange;
    api.request.mockImplementationOnce(async (_client, _school, input) => { stored = change({ id: input.requestId }); throw new Error("Lost response after commit"); })
      .mockImplementationOnce(async () => stored!);
    const view = render(<FeeChangeWorkspace {...inputProps} />);
    await prepareReduction(user); await submitPrepared(user);
    await screen.findByRole("button", { name: "Retry same change request" });
    view.unmount(); render(<FeeChangeWorkspace {...inputProps} demands={[{ ...fee, financial_token: "new-current-token", balance: "550.00" }]} />);
    await user.click(await screen.findByRole("button", { name: "Retry same change request" }));
    await screen.findByText("Request submitted. The fee and payment records stay unchanged until a different School Admin or Principal approves it.");
    expect(api.request.mock.calls[1]).toEqual(api.request.mock.calls[0]);
    expect(api.request.mock.calls[0][2]).toEqual(expect.objectContaining({ amount: "100.00", expectedToken: "financial-token-a" }));
  });

  it("recovers an unknown approval after reload with the exact original decision and reason", async () => {
    const user = userEvent.setup(), db = client("reviewer-a"), inputProps = props(db, "reviewer-a", true);
    rows = [change()]; let saved: FeeChange;
    api.review.mockImplementationOnce(async (_client, _id, decision, reason) => { saved = reviewed(rows[0], decision, reason); rows = [saved]; throw new Error("Lost approval response"); })
      .mockImplementationOnce(async () => saved!);
    const view = render(<FeeChangeWorkspace {...inputProps} />);
    await user.click(await screen.findByRole("button", { name: "Review fee request" }));
    await user.type(screen.getByLabelText("Review reason"), "Approved against checked source");
    await user.click(screen.getByRole("button", { name: "Approve fee change" }));
    await screen.findByRole("button", { name: "Retry same fee review" });
    view.unmount(); render(<FeeChangeWorkspace {...inputProps} />);
    await user.click(await screen.findByRole("button", { name: "Retry same fee review" }));
    await screen.findByText("Change approved and posted. The original records and review history are retained.");
    expect(api.review.mock.calls).toEqual([[db.client, "request-a", "approved", "Approved against checked source"], [db.client, "request-a", "approved", "Approved against checked source"]]);
  });

  it("detects an outdated request from a refreshed canonical token without re-enabling approval", async () => {
    const user = userEvent.setup(), db = client("reviewer-a"), inputProps = props(db, "reviewer-a", true);
    rows = [change()]; const view = render(<FeeChangeWorkspace {...inputProps} />);
    await user.click(await screen.findByRole("button", { name: "Review fee request" }));
    await user.type(screen.getByLabelText("Review reason"), "Reason remains while ledger refreshes");
    view.rerender(<FeeChangeWorkspace {...inputProps} demands={[{ ...fee, financial_token: "changed-financial-token" }]} />);
    expect(screen.getByRole("button", { name: "Approve fee change" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Reject fee change" })).toBeEnabled();
    expect(screen.getByLabelText("Review reason")).toHaveValue("Reason remains while ledger refreshes"); expect(api.review).not.toHaveBeenCalled();
  });

  it("suppresses late request results and old student names after an account switch", async () => {
    const user = userEvent.setup(), db = client(), inputProps = props(db);
    let finish!: (value: FeeChange) => void;
    api.request.mockImplementationOnce(() => new Promise<FeeChange>((resolve) => { finish = resolve; }));
    render(<FeeChangeWorkspace {...inputProps} />);
    await prepareReduction(user); await submitPrepared(user);
    await waitFor(() => expect(api.request).toHaveBeenCalledTimes(1));
    act(() => db.switchActor("different-office"));
    await screen.findByText("Your sign-in changed. Reload Fees to verify your school access before continuing.");
    await act(async () => { finish(change()); });
    expect(screen.queryByText(/QA Pupil/)).not.toBeInTheDocument(); expect(inputProps.onChanged).not.toHaveBeenCalled();
  });

  it("rejects a reversal proposal when receipt and ledger came from different financial snapshots", async () => {
    const user = userEvent.setup(), db = client();
    render(<FeeChangeWorkspace {...props(db)} payments={[{ ...payment, financial_token: "different-receipt-token" }]} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Reverse payment entry" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Reverse payment entry" }));
    await user.selectOptions(screen.getByLabelText("Paid receipt to correct"), "payment-a");
    await user.type(screen.getByLabelText("Request reason"), "Duplicate receipt checked");
    await user.click(screen.getByRole("button", { name: "Preview requested change" }));
    await screen.findByText("Receipt and ledger changed while loading; refresh finance records before preparing a reversal.");
    expect(screen.queryByRole("region", { name: "Proposed fee change" })).not.toBeInTheDocument(); expect(api.request).not.toHaveBeenCalled();
  });

  it("requires a printable single-line reason before previewing or reviewing", async () => {
    const user = userEvent.setup(), db = client("reviewer-a"); rows = [change()];
    render(<FeeChangeWorkspace {...props(db, "reviewer-a", true)} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Reduce fee" })).toBeEnabled());
    await user.selectOptions(screen.getByLabelText("Fee record to change"), "fee-a");
    await user.type(screen.getByLabelText("Reduction amount"), "100.00");
    fireEvent.change(screen.getByLabelText("Request reason"), { target: { value: "Line one\nLine two" } });
    expect(screen.getByRole("button", { name: "Preview requested change" })).toBeDisabled();
    fireEvent.submit(screen.getByLabelText("Request reason").closest("form")!);
    await screen.findByText("Use a request reason of 5–500 printable characters on one line.");
    expect(api.request).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Review fee request" }));
    fireEvent.change(screen.getByLabelText("Review reason"), { target: { value: "Tiny" } });
    expect(screen.getByRole("button", { name: "Approve fee change" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Review reason"), { target: { value: "Review\nreason" } });
    expect(screen.getByRole("button", { name: "Reject fee change" })).toBeDisabled(); expect(api.review).not.toHaveBeenCalled();
  });
});
