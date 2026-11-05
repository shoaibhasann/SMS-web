import type { SupabaseClient } from "@supabase/supabase-js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeeBatchWorkspace } from "@/components/finance/fee-batch-workspace";

const schoolId = "school-a", userId = "office-a", yearId = "year-a";
const storageKey = `kids-corner-fee-batch:v1:${userId}:${schoolId}:${yearId}`;
const structure = { id: "structure-a", name: "Monthly tuition", amount: 100, frequency: "monthly", academic_year_id: yearId, class_id: null };
const receipt = (overrides = {}) => ({ batch_id: "posted-batch-a", kind: "monthly", academic_year_id: yearId,
  posted_at: "2026-11-05T15:00:00Z", posted_by_name: "QA Accountant", created_count: 1, existing_count: 0,
  total_amount: "100.00", source_reference: null, reason: null, ...overrides });
const row = (overrides = {}) => ({ row_number: 1, student_id: "pupil-a", admission_no: "QA-001", student_name: "Private pupil A",
  class_name: "Grade 6", section_name: "A", amount: "100.00", status: "ready", message: "", demand_id: null, ...overrides });
const preview = (overrides = {}) => ({ kind: "monthly", academic_year_id: yearId, preview_token: "review-token-a", rows: [row()],
  summary: { ready_count: 1, existing_count: 0, error_count: 0, ready_amount: "100.00", existing_amount: "0.00", total_amount: "100.00" },
  can_post: true, ...overrides });
const ok = (data: unknown) => ({ data, error: null });
type Result = { data: unknown; error: { code?: string; message: string } | null };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function database(handler: (name: string, args: Record<string, unknown>) => Result | Promise<Result>, actorId = userId, history: unknown[] = []) {
  let authListener: ((event: string, session: { user: { id: string } } | null) => void) | undefined;
  const rpc = vi.fn((name: string, args: Record<string, unknown>) => Promise.resolve(name === "list_office_fee_batches" ? ok(history) : handler(name, args)));
  const client = {
    rpc,
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: actorId } }, error: null })),
      onAuthStateChange: vi.fn((callback: typeof authListener) => {
        authListener = callback;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
    },
    from(table: string) {
      const records = table === "classes" ? [{ id: "class-a", name: "Grade 6", is_active: true }]
        : table === "sections" ? [{ id: "section-a", name: "A", class_id: "class-a" }]
          : table === "academic_years" ? [{ id: yearId, name: "2026–27" }] : [];
      const query = {
        select() { return query; }, eq() { return query; }, order() { return query; },
        range() { return Promise.resolve({ data: records, count: records.length, error: null }); },
      };
      return query;
    },
  };
  return { client: client as unknown as SupabaseClient, rpc, changeActor: (id: string | null) => authListener?.("SIGNED_IN", id ? { user: { id } } : null) };
}

async function prepareMonthly(user: ReturnType<typeof userEvent.setup>) {
  const structureSelect = await screen.findByRole("combobox", { name: "Monthly fee structure" });
  await waitFor(() => expect(structureSelect).toBeEnabled());
  await user.selectOptions(structureSelect, "structure-a");
  fireEvent.change(screen.getByLabelText("Batch due date"), { target: { value: "2026-11-25" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Preview complete batch" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Preview complete batch" }));
  await screen.findByRole("region", { name: "Fee batch preview" });
}

async function reviewPosting(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Review posting" }));
  expect(screen.getByRole("button", { name: "Confirm fee batch posting" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: "I checked the complete preview and the source amounts." }));
}

beforeEach(() => sessionStorage.clear());

describe("reviewed bulk fee posting", () => {
  it("requires explicit review and confirmation, and guards duplicate clicks while the post is in flight", async () => {
    const user = userEvent.setup(), pending = deferred<Result>();
    const db = database((name) => name === "preview_office_fee_batch" ? ok(preview()) : pending.promise);
    const onPosted = vi.fn();
    render(<FeeBatchWorkspace client={db.client} schoolId={schoolId} userId={userId} academicYearId={yearId} structures={[structure]} onPosted={onPosted} />);
    await prepareMonthly(user);
    expect(db.rpc.mock.calls.filter(([name]) => name === "post_office_fee_batch")).toHaveLength(0);
    await reviewPosting(user);
    const confirm = screen.getByRole("button", { name: "Confirm fee batch posting" });
    fireEvent.click(confirm); fireEvent.click(confirm);
    await waitFor(() => expect(db.rpc.mock.calls.filter(([name]) => name === "post_office_fee_batch")).toHaveLength(1));
    const saved = sessionStorage.getItem(storageKey)!;
    expect(JSON.parse(saved)).toEqual(expect.objectContaining({ kind: "monthly", amount: "100.00", readyCount: 1 }));
    expect(saved).not.toContain("Private pupil A");
    await act(async () => { pending.resolve(ok(receipt())); });
    await screen.findByText("Batch posted. 1 new fee demands · ₹100.00. 0 existing records kept.");
    expect(onPosted).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("recovers a lost posting response after remount with the identical frozen request and preview", async () => {
    const user = userEvent.setup(); let posts = 0;
    const db = database((name) => name === "preview_office_fee_batch" ? ok(preview())
      : ++posts === 1 ? { data: null, error: { message: "connection dropped", code: "" } } : ok(receipt()));
    const onPosted = vi.fn();
    const props = { client: db.client, schoolId, userId, academicYearId: yearId, structures: [structure], onPosted };
    const view = render(<FeeBatchWorkspace {...props} />);
    await prepareMonthly(user); await reviewPosting(user);
    await user.click(screen.getByRole("button", { name: "Confirm fee batch posting" }));
    await screen.findByRole("button", { name: "Retry same batch" });
    expect(screen.queryByRole("combobox", { name: "Monthly fee structure" })).not.toBeInTheDocument();
    expect(onPosted).not.toHaveBeenCalled();
    const frozen = sessionStorage.getItem(storageKey);
    view.unmount();
    render(<FeeBatchWorkspace {...props} structures={[{ ...structure, name: "Renamed after response loss", amount: 200 }]} />);
    await user.click(await screen.findByRole("button", { name: "Retry same batch" }));
    await screen.findByText("Batch posted. 1 new fee demands · ₹100.00. 0 existing records kept.");
    const requests = db.rpc.mock.calls.filter(([name]) => name === "post_office_fee_batch");
    expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
    expect(requests[0][1]).toEqual(expect.objectContaining({ p_preview_token: "review-token-a", p_payload: expect.objectContaining({ fee_structure_id: "structure-a" }) }));
    expect(frozen).not.toBeNull(); expect(sessionStorage.getItem(storageKey)).toBeNull();
    expect(db.rpc.mock.calls.filter(([name]) => name === "preview_office_fee_batch")).toHaveLength(1);
    expect(onPosted).toHaveBeenCalledTimes(1);
  });

  it.each(["PT409", "40001"])("keeps draft inputs and requires a new server preview after a business conflict (%s)", async (code) => {
    const user = userEvent.setup(); let previews = 0;
    const db = database((name) => name === "preview_office_fee_batch" ? ok(preview({ preview_token: `token-${++previews}` }))
      : { data: null, error: { code, message: "Reviewed records changed." } });
    render(<FeeBatchWorkspace client={db.client} schoolId={schoolId} userId={userId} academicYearId={yearId} structures={[structure]} onPosted={vi.fn()} />);
    const month = await screen.findByLabelText("Batch billing month");
    fireEvent.change(month, { target: { value: "2026-11" } });
    fireEvent.change(screen.getByLabelText("Batch due date"), { target: { value: "2026-11-25" } });
    await prepareMonthly(user); await reviewPosting(user);
    await user.click(screen.getByRole("button", { name: "Confirm fee batch posting" }));
    await screen.findByText("The roster, fee structure or existing demands changed. Your inputs are kept. Preview the latest records and review again before posting.");
    expect(screen.getByRole("combobox", { name: "Monthly fee structure" })).toHaveValue("structure-a");
    expect(screen.getByLabelText("Batch billing month")).toHaveValue("2026-11");
    expect(screen.getByLabelText("Batch due date")).toHaveValue("2026-11-25");
    expect(screen.queryByRole("region", { name: "Fee batch preview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm fee batch posting" })).not.toBeInTheDocument();
    expect(sessionStorage.getItem(storageKey)).toBeNull();
    expect(previews).toBe(1);
    await user.click(screen.getByRole("button", { name: "Preview complete batch" }));
    await screen.findByRole("region", { name: "Fee batch preview" });
    expect(previews).toBe(2);
    expect(db.rpc.mock.calls.filter(([name]) => name === "post_office_fee_batch")).toHaveLength(1);
  });

  it("shows server duplicate and amount validation for opening debt and never treats it as collection", async () => {
    const user = userEvent.setup();
    const db = database(() => ok(preview({ kind: "opening", can_post: false,
      rows: [row(), row({ row_number: 2, status: "error", message: "Admission number repeats in this batch." }),
        row({ row_number: 3, student_id: null, admission_no: "QA-003", student_name: "", status: "error", amount: null, message: "Enter a positive amount with up to two decimal places." })],
      summary: { ready_count: 1, existing_count: 0, error_count: 2, ready_amount: "100.00", existing_amount: "0.00", total_amount: "100.00" },
    })));
    render(<FeeBatchWorkspace client={db.client} schoolId={schoolId} userId={userId} academicYearId={yearId} structures={[structure]} onPosted={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Opening balances" }));
    await user.type(screen.getByLabelText("Source reference"), "Approved signed register");
    await user.type(screen.getByLabelText("Review reason"), "Unpaid balances reconciled with office source.");
    fireEvent.change(screen.getByLabelText("Opening balance CSV"), { target: { value: "admission_no,amount\nQA-001,100.00\nQA-001,50.00\nQA-003,oops\n" } });
    await user.click(screen.getByRole("button", { name: "Preview complete batch" }));
    const region = within(await screen.findByRole("region", { name: "Fee batch preview" }));
    expect(region.getByText("Admission number repeats in this batch.")).toBeVisible();
    expect(region.getByText("Invalid amount")).toBeVisible();
    expect(screen.getByRole("button", { name: "Review posting" })).toBeDisabled();
    expect(screen.getByText(/Posting creates a fee demand; it does not record cash/)).toBeVisible();
    expect(db.rpc.mock.calls.find(([name]) => name === "preview_office_fee_batch")?.[1]).toEqual(expect.objectContaining({ p_kind: "opening", p_payload: expect.objectContaining({
      source_reference: "Approved signed register", rows: [{ admission_no: "QA-001", amount: "100.00" }, { admission_no: "QA-001", amount: "50.00" }, { admission_no: "QA-003", amount: "oops" }],
    }) }));
    expect(db.rpc.mock.calls.filter(([name]) => name === "post_office_fee_batch")).toHaveLength(0);
  });

  it("keeps all-existing batches as a no-op even when the server permits an idempotent post", async () => {
    const user = userEvent.setup();
    const db = database(() => ok(preview({ rows: [row({ status: "existing", demand_id: "existing-demand" })],
      summary: { ready_count: 0, existing_count: 1, error_count: 0, ready_amount: "0.00", existing_amount: "100.00", total_amount: "100.00" } })));
    render(<FeeBatchWorkspace client={db.client} schoolId={schoolId} userId={userId} academicYearId={yearId} structures={[structure]} onPosted={vi.fn()} />);
    await prepareMonthly(user);
    expect(screen.getByText("Nothing new to post. All matching charges already exist.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Review posting" })).toBeDisabled();
    expect(db.rpc.mock.calls.filter(([name]) => name === "post_office_fee_batch")).toHaveLength(0);
  });

  it("hides financial names and ignores a late old-session preview after an account switch", async () => {
    const user = userEvent.setup(), pending = deferred<Result>();
    const db = database(() => pending.promise);
    render(<FeeBatchWorkspace client={db.client} schoolId={schoolId} userId={userId} academicYearId={yearId} structures={[structure]} onPosted={vi.fn()} />);
    const structureSelect = await screen.findByRole("combobox", { name: "Monthly fee structure" });
    await waitFor(() => expect(structureSelect).toBeEnabled());
    await user.selectOptions(structureSelect, "structure-a");
    fireEvent.change(screen.getByLabelText("Batch due date"), { target: { value: "2026-11-25" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Preview complete batch" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Preview complete batch" }));
    await waitFor(() => expect(db.rpc.mock.calls.filter(([name]) => name === "preview_office_fee_batch")).toHaveLength(1));
    act(() => db.changeActor("other-office"));
    await screen.findByText("Your sign-in changed. Reload Fees to verify your school access before continuing.");
    await act(async () => { pending.resolve(ok(preview())); });
    expect(screen.queryByText("Private pupil A")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Fee batch preview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Posted fee batches" })).not.toBeInTheDocument();
  });

  it("previews every server row while paginating its visible list without truncating the posted scope", async () => {
    const user = userEvent.setup();
    const allRows = Array.from({ length: 43 }, (_, index) => row({ row_number: index + 1, student_id: `pupil-${index}`, admission_no: `QA-${index}`, student_name: `Pupil ${index + 1}` }));
    const db = database((name) => name === "preview_office_fee_batch" ? ok(preview({ rows: allRows,
      summary: { ready_count: 43, existing_count: 0, error_count: 0, ready_amount: "4300.00", existing_amount: "0.00", total_amount: "4300.00" } }))
      : ok(receipt({ created_count: 43, total_amount: "4300.00" })));
    render(<FeeBatchWorkspace client={db.client} schoolId={schoolId} userId={userId} academicYearId={yearId} structures={[structure]} onPosted={vi.fn()} />);
    await prepareMonthly(user);
    expect(screen.getByText("All 43 rows were checked. Existing records will stay unchanged.")).toBeVisible();
    expect(screen.queryByText("Pupil 43")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next preview rows" }));
    expect(screen.getByText("Pupil 43")).toBeVisible();
    await reviewPosting(user); await user.click(screen.getByRole("button", { name: "Confirm fee batch posting" }));
    await screen.findByText("Batch posted. 43 new fee demands · ₹4,300.00. 0 existing records kept.");
    const post = db.rpc.mock.calls.find(([name]) => name === "post_office_fee_batch")?.[1];
    expect(post?.p_payload).toEqual(expect.objectContaining({ class_id: null, section_id: null }));
    expect(JSON.stringify(post?.p_payload)).not.toContain("pupil-");
  });

  it("requires an explicit due date before any monthly preview and passes the reviewed date unchanged", async () => {
    const user = userEvent.setup();
    const db = database(() => ok(preview()));
    render(<FeeBatchWorkspace client={db.client} schoolId={schoolId} userId={userId} academicYearId={yearId} structures={[structure]} onPosted={vi.fn()} />);
    const structureSelect = await screen.findByRole("combobox", { name: "Monthly fee structure" });
    await waitFor(() => expect(structureSelect).toBeEnabled());
    await user.selectOptions(structureSelect, "structure-a");
    const due = screen.getByLabelText("Batch due date");
    expect(due).toBeRequired(); expect(due).toHaveValue("");
    expect(screen.getByRole("button", { name: "Preview complete batch" })).toBeDisabled();
    fireEvent.submit(due.closest("form")!);
    await screen.findByText("Choose a monthly fee structure, billing month and explicit due date before previewing.");
    expect(db.rpc.mock.calls.filter(([name]) => name === "preview_office_fee_batch")).toHaveLength(0);
    fireEvent.change(due, { target: { value: "2026-11-26" } });
    await user.click(screen.getByRole("button", { name: "Preview complete batch" }));
    await screen.findByRole("region", { name: "Fee batch preview" });
    expect(db.rpc.mock.calls.find(([name]) => name === "preview_office_fee_batch")?.[1]).toEqual(expect.objectContaining({
      p_payload: expect.objectContaining({ due_date: "2026-11-26" }),
    }));
  });

  it("identifies the billing month in posted monthly batch history", async () => {
    const db = database(() => ok(preview()), userId, [receipt({ billing_period: "2026-11" })]);
    render(<FeeBatchWorkspace client={db.client} schoolId={schoolId} userId={userId} academicYearId={yearId} structures={[structure]} onPosted={vi.fn()} />);
    const history = within(await screen.findByRole("region", { name: "Posted fee batches" }));
    expect(await history.findByText("Billing month · 2026-11")).toBeVisible();
  });
});
