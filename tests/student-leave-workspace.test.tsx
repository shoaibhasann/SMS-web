import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StudentLeaveWorkspace } from "@/components/family/student-leave-workspace";
import { loadFamilyStudents, type FamilyStudent } from "@/lib/attendance/family";
import { loadSchoolManagementAccess } from "@/lib/attendance/repository";
import type { StudentLeaveRequest } from "@/lib/student-leave";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(), getUser: vi.fn(),
  listener: (() => {}) as (event: string, session: { user: { id: string } } | null) => void,
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({
  rpc: mocks.rpc, auth: { getUser: mocks.getUser, onAuthStateChange: (listener: typeof mocks.listener) => {
    mocks.listener = listener;
    return { data: { subscription: { unsubscribe: () => {} } } };
  } },
}) }));
vi.mock("@/lib/attendance/family", async (original) => ({ ...await original<typeof import("../lib/attendance/family")>(), loadFamilyStudents: vi.fn() }));
vi.mock("@/lib/attendance/repository", () => ({ loadSchoolManagementAccess: vi.fn() }));

const childA: FamilyStudent = { id: "child-a", school_id: "school-a", admission_no: "QA-01", first_name: "QA Anya", status: "active" };
const childB: FamilyStudent = { id: "child-b", school_id: "school-a", admission_no: "QA-02", first_name: "QA Kabir", status: "active" };
const requestId = (number: number) => `20000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const familyLoader = vi.mocked(loadFamilyStudents), schoolLoader = vi.mocked(loadSchoolManagementAccess);

function request(patch: Partial<StudentLeaveRequest> = {}): StudentLeaveRequest {
  return { id: requestId(1), school_id: "school-a", student_id: "child-a", student_name: "QA Anya", admission_no: "QA-01",
    academic_year_id: "year-a", academic_year_name: "2026–27", class_name: "Class 4", section_name: "A",
    start_date: "2026-11-10", end_date: "2026-11-12", reason: "Family visit", status: "pending",
    requester_id: "guardian-a", requester_name: "QA Guardian", created_at: "2026-11-06T10:00:00Z",
    reviewed_by: null, reviewer_name: null, review_note: null, reviewed_at: null, total_count: 1, ...patch };
}

type RpcResult = { data: unknown; error: { code?: string; message: string } | null };
type Args = Record<string, unknown>;
function fakeStore(initial: StudentLeaveRequest[] = []) {
  const rows = structuredClone(initial);
  const submissions = new Map<string, string>();
  let sequence = 100;
  let loseSubmitAck = false;
  let loseReviewAck = false;
  let readDenied = false;
  let submitWait: Promise<void> | undefined;
  mocks.rpc.mockImplementation(async (name: string, args: Args): Promise<RpcResult> => {
    if (name === "list_family_student_leave" || name === "list_student_leave_review") {
      if (readDenied) return { data: null, error: { code: "42501", message: "Access denied" } };
      const matching = rows.filter((row) => name === "list_family_student_leave" ? row.student_id === args.p_student_id
        : row.school_id === args.p_school_id && (!args.p_status || row.status === args.p_status));
      const offset = Number(args.p_offset ?? 0);
      return { data: matching.slice(offset, offset + 50).map((row) => ({ ...row, total_count: matching.length })), error: null };
    }
    if (name === "submit_student_leave") {
      await submitWait;
      let id = submissions.get(String(args.p_idempotency_key));
      if (!id) {
        id = requestId(++sequence); submissions.set(String(args.p_idempotency_key), id);
        const child = args.p_student_id === childB.id ? childB : childA;
        rows.unshift(request({ id, student_id: child.id, student_name: child.first_name, admission_no: child.admission_no,
          start_date: String(args.p_start_date), end_date: String(args.p_end_date), reason: String(args.p_reason) }));
      }
      if (loseSubmitAck) { loseSubmitAck = false; return { data: null, error: { message: "Connection interrupted" } }; }
      return { data: id, error: null };
    }
    if (name === "review_student_leave") {
      const row = rows.find((item) => item.id === args.p_request_id)!;
      if (row.status !== "pending" && (row.status !== args.p_decision || row.review_note !== args.p_reason)) {
        return { data: null, error: { code: "23505", message: "This request has already been reviewed. Refresh the saved status." } };
      }
      Object.assign(row, { status: args.p_decision, review_note: args.p_reason, reviewed_by: "principal-a", reviewer_name: "QA Principal", reviewed_at: "2026-11-06T12:00:00Z" });
      if (loseReviewAck) { loseReviewAck = false; return { data: null, error: { message: "Connection interrupted" } }; }
      return { data: row.id, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  return {
    rows,
    loseSubmitAck: () => { loseSubmitAck = true; },
    loseReviewAck: () => { loseReviewAck = true; },
    denyReads: () => { readDenied = true; },
    deferSubmit: () => { let finish!: () => void; submitWait = new Promise<void>((resolve) => { finish = resolve; }); return finish; },
  };
}

function fillRequest(reason = "Travel with family") {
  fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-11-15" } });
  fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-11-17" } });
  fireEvent.change(screen.getByLabelText("Leave reason"), { target: { value: reason } });
}

beforeEach(() => {
  sessionStorage.clear(); mocks.rpc.mockReset(); mocks.getUser.mockReset(); familyLoader.mockReset(); schoolLoader.mockReset();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "guardian-a" } }, error: null });
  familyLoader.mockResolvedValue([childA, childB]);
  schoolLoader.mockResolvedValue({ userId: "principal-a", schools: [{ id: "school-a", name: "QA School" }], schoolAdminIds: [] });
});

describe("student leave workspace", () => {
  it("keeps exact family control names after choosing a child and entering dates and reason", async () => {
    const user = userEvent.setup(); fakeStore();
    render(<StudentLeaveWorkspace role="parent" userId="guardian-a" />);
    await user.selectOptions(await screen.findByRole("combobox", { name: "Select child" }), "child-b");
    expect(screen.getByRole("combobox", { name: "Select child" })).toHaveValue("child-b");
    fireEvent.change(screen.getByLabelText("Start date", { exact: true }), { target: { value: "2026-11-15" } });
    fireEvent.change(screen.getByLabelText("End date", { exact: true }), { target: { value: "2026-11-17" } });
    await user.type(screen.getByRole("textbox", { name: "Leave reason" }), "Travel with the family");
    expect(screen.getByRole("textbox", { name: "Leave reason" })).toHaveValue("Travel with the family");
    expect(screen.getByLabelText("Leave reason", { exact: true })).toHaveAccessibleName("Leave reason");
    expect(screen.getByLabelText("Start date", { exact: true })).toHaveAccessibleName("Start date");
    expect(screen.getByLabelText("End date", { exact: true })).toHaveAccessibleName("End date");
  });

  it("submits for the selected child, reloads the saved record and restores the child after remount", async () => {
    const user = userEvent.setup(); const store = fakeStore();
    const view = render(<StudentLeaveWorkspace role="parent" userId="guardian-a" />);
    await user.selectOptions(await screen.findByLabelText("Select child"), "child-b");
    fillRequest("Guardian requested travel");
    await user.click(screen.getByRole("button", { name: "Submit leave request" }));
    await screen.findByText(/Leave request saved/);
    const list = await screen.findByRole("list", { name: "Saved leave requests" });
    expect(within(list).getByText("Guardian requested travel")).toBeInTheDocument();
    expect(store.rows).toHaveLength(1); expect(store.rows[0].student_id).toBe("child-b");
    expect(screen.getByLabelText("Leave reason")).toHaveValue("");
    view.unmount();
    render(<StudentLeaveWorkspace role="parent" userId="guardian-a" />);
    await screen.findByText("Guardian requested travel");
    expect(screen.getByLabelText("Select child")).toHaveValue("child-b");
    await user.click(screen.getByRole("button", { name: "Refresh leave history" }));
    await screen.findByText("Guardian requested travel");
    expect(screen.queryByText("Family visit")).not.toBeInTheDocument();
  });

  it("retains the same idempotency key after an interrupted acknowledgement and rotates it for a changed payload", async () => {
    const user = userEvent.setup(); const store = fakeStore(); store.loseSubmitAck();
    render(<StudentLeaveWorkspace role="parent" userId="guardian-a" />);
    await screen.findByLabelText("Leave reason"); fillRequest();
    await user.click(screen.getByRole("button", { name: "Submit leave request" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be confirmed");
    expect(screen.getByLabelText("Leave reason")).toHaveValue("Travel with family");
    await user.click(screen.getByRole("button", { name: "Submit leave request" }));
    await screen.findByText(/Leave request saved/);
    expect(store.rows).toHaveLength(1);
    fillRequest("A different family visit");
    await user.click(screen.getByRole("button", { name: "Submit leave request" }));
    await screen.findByText("A different family visit");
    const calls = mocks.rpc.mock.calls.filter(([name]) => name === "submit_student_leave");
    expect(calls).toHaveLength(3);
    expect(calls[0][1].p_idempotency_key).toBe(calls[1][1].p_idempotency_key);
    expect(calls[2][1].p_idempotency_key).not.toBe(calls[1][1].p_idempotency_key);
  });

  it("locks child/context and duplicate submits while saving", async () => {
    const user = userEvent.setup(); const store = fakeStore(); const finish = store.deferSubmit();
    render(<StudentLeaveWorkspace role="parent" userId="guardian-a" />);
    await screen.findByLabelText("Leave reason"); fillRequest();
    const form = screen.getByLabelText("Leave reason").closest("form")!;
    fireEvent.submit(form); fireEvent.submit(form);
    expect(screen.getByLabelText("Select child")).toBeDisabled();
    expect(screen.getByLabelText("Leave reason")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh linked students" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh leave history" })).toBeDisabled();
    expect(mocks.rpc.mock.calls.filter(([name]) => name === "submit_student_leave")).toHaveLength(1);
    await act(async () => { finish(); });
    await screen.findByText(/Leave request saved/);
    await user.selectOptions(screen.getByLabelText("Select child"), "child-b");
    expect(screen.getByLabelText("Leave reason")).toHaveValue("");
  });

  it("ignores a previous child's late history after switching children", async () => {
    const user = userEvent.setup(); let finish!: (value: RpcResult) => void;
    const pending = new Promise<RpcResult>((resolve) => { finish = resolve; });
    mocks.rpc.mockImplementation((_name, args) => args.p_student_id === "child-a" ? pending
      : Promise.resolve({ data: [request({ student_id: "child-b", student_name: "QA Kabir", reason: "Kabir current request" })], error: null }));
    render(<StudentLeaveWorkspace role="parent" userId="guardian-a" />);
    await user.selectOptions(await screen.findByLabelText("Select child"), "child-b");
    await screen.findByText("Kabir current request");
    await act(async () => { finish({ data: [request({ reason: "Anya late private request" })], error: null }); await pending; });
    expect(screen.queryByText("Anya late private request")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Select child")).toHaveValue("child-b");
  });

  it("asks before discarding an unsaved draft for child switching or access refresh", async () => {
    const user = userEvent.setup(); fakeStore();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<StudentLeaveWorkspace role="parent" userId="guardian-a" />);
    await screen.findByLabelText("Leave reason"); fillRequest("Keep this unsaved reason");
    await user.selectOptions(screen.getByLabelText("Select child"), "child-b");
    expect(screen.getByLabelText("Select child")).toHaveValue("child-a");
    expect(screen.getByLabelText("Leave reason")).toHaveValue("Keep this unsaved reason");
    await user.click(screen.getByRole("button", { name: "Refresh linked students" }));
    expect(familyLoader).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Start date")).toHaveValue("2026-11-15");
    confirm.mockReturnValue(true);
    await user.selectOptions(screen.getByLabelText("Select child"), "child-b");
    expect(screen.getByLabelText("Leave reason")).toHaveValue("");
    expect(confirm).toHaveBeenCalledTimes(3);
  });

  it("hides prior records after revoke/read failure and refreshes the authoritative child links", async () => {
    const user = userEvent.setup(); const store = fakeStore([request()]);
    render(<StudentLeaveWorkspace role="parent" userId="guardian-a" />);
    await screen.findByText("Family visit"); store.denyReads();
    await user.click(screen.getByRole("button", { name: "Refresh leave history" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("Family visit")).not.toBeInTheDocument();
    familyLoader.mockResolvedValue([]);
    await user.click(screen.getByRole("button", { name: "Refresh linked students" }));
    await screen.findByText("No student is currently linked to this account.");
    expect(screen.queryByLabelText("Leave reason")).not.toBeInTheDocument();
  });

  it("preserves withdrawn student history while disabling new requests", async () => {
    fakeStore([request()]); familyLoader.mockResolvedValue([{ ...childA, status: "withdrawn" }]);
    mocks.getUser.mockResolvedValue({ data: { user: { id: "student-a" } }, error: null });
    render(<StudentLeaveWorkspace role="student" userId="student-a" />);
    await screen.findByText("Family visit");
    expect(screen.getByText(/New requests are available only for an active student/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit leave request" })).not.toBeInTheDocument();
  });

  it("paginates all saved history with a stable offset", async () => {
    const user = userEvent.setup(); fakeStore(Array.from({ length: 51 }, (_, index) => request({ id: requestId(index + 1), reason: `Saved request ${index + 1}` })));
    render(<StudentLeaveWorkspace role="parent" userId="guardian-a" />);
    await screen.findByText("1–50 of 51 requests");
    await user.click(screen.getByRole("button", { name: "Next requests" }));
    await screen.findByText("Saved request 51");
    expect(screen.queryByText("Saved request 1")).not.toBeInTheDocument();
    expect(mocks.rpc).toHaveBeenLastCalledWith("list_family_student_leave", { p_student_id: "child-a", p_offset: 50 });
    expect(screen.getByRole("button", { name: "Next requests" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Previous requests" }));
    await screen.findByText("Saved request 1");
  });

  it("reviews once and reloads the same persisted decision with its original session snapshot", async () => {
    const user = userEvent.setup(); const store = fakeStore([request()]);
    render(<StudentLeaveWorkspace role="principal" userId="principal-a" />);
    await user.click(await screen.findByRole("button", { name: "Review request" }));
    await user.type(screen.getByLabelText("Review reason"), "Approved with school review");
    await user.click(screen.getByRole("button", { name: "Approve leave" }));
    await screen.findByText(/Leave approved. The decision is saved/);
    await screen.findByText("No leave requests on this page.");
    expect(store.rows[0]).toMatchObject({ status: "approved", review_note: "Approved with school review" });
    await user.selectOptions(screen.getByLabelText("Request status"), "");
    await screen.findByText("Approved with school review");
    expect(screen.getByText("QA-01 · 2026–27 / Class 4 / A")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review request" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh leave history" }));
    await screen.findByText("Approved with school review");
    expect(mocks.rpc.mock.calls.filter(([name]) => name === "review_student_leave")).toHaveLength(1);
  });

  it("keeps exact school, status and review reason names after their values change", async () => {
    const user = userEvent.setup(); fakeStore([request({ school_id: "school-b" })]);
    schoolLoader.mockResolvedValue({ userId: "principal-a", schools: [{ id: "school-a", name: "School A" }, { id: "school-b", name: "School B" }], schoolAdminIds: [] });
    render(<StudentLeaveWorkspace role="principal" userId="principal-a" />);
    await user.selectOptions(await screen.findByRole("combobox", { name: "School" }), "school-b");
    expect(screen.getByRole("combobox", { name: "School" })).toHaveValue("school-b");
    await user.selectOptions(await screen.findByRole("combobox", { name: "Request status" }), "");
    expect(screen.getByRole("combobox", { name: "Request status" })).toHaveValue("");
    await user.click(await screen.findByRole("button", { name: "Review request" }));
    await user.type(screen.getByRole("textbox", { name: "Review reason" }), "Reviewed with the school");
    expect(screen.getByRole("textbox", { name: "Review reason" })).toHaveValue("Reviewed with the school");
    expect(screen.getByLabelText("Review reason", { exact: true })).toHaveAccessibleName("Review reason");
    expect(screen.getByRole("combobox", { name: "School" })).toHaveAccessibleName("School");
    expect(screen.getByRole("combobox", { name: "Request status" })).toHaveAccessibleName("Request status");
  });

  it("keeps the review reason after uncertain acknowledgement and safely retries the same decision", async () => {
    const user = userEvent.setup(); const store = fakeStore([request()]); store.loseReviewAck();
    render(<StudentLeaveWorkspace role="admin" userId="principal-a" />);
    await user.click(await screen.findByRole("button", { name: "Review request" }));
    await user.type(screen.getByLabelText("Review reason"), "Family informed the school");
    await user.click(screen.getByRole("button", { name: "Reject leave" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be confirmed");
    expect(screen.getByLabelText("Review reason")).toHaveValue("Family informed the school");
    await user.click(screen.getByRole("button", { name: "Reject leave" }));
    await screen.findByText(/Leave rejected. The decision and reason are saved/);
    const calls = mocks.rpc.mock.calls.filter(([name]) => name === "review_student_leave");
    expect(calls[0][1]).toEqual(calls[1][1]);
    expect(store.rows[0].status).toBe("rejected");
  });

  it("keeps a stale review reason and reloads another reviewer's decision without overwriting it", async () => {
    const user = userEvent.setup(); const store = fakeStore([request()]);
    render(<StudentLeaveWorkspace role="principal" userId="principal-a" />);
    await user.click(await screen.findByRole("button", { name: "Review request" }));
    await user.type(screen.getByLabelText("Review reason"), "My pending approval note");
    Object.assign(store.rows[0], { status: "rejected", reviewed_by: "other-admin", reviewer_name: "Other reviewer", review_note: "Existing final rejection", reviewed_at: "2026-11-06T11:00:00Z" });
    await user.click(screen.getByRole("button", { name: "Approve leave" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already been reviewed");
    expect(screen.getByLabelText("Review reason")).toHaveValue("My pending approval note");
    expect(store.rows[0].review_note).toBe("Existing final rejection");
    await user.selectOptions(screen.getByLabelText("Request status"), "");
    await screen.findByText("Existing final rejection");
    expect(screen.queryByRole("button", { name: "Approve leave" })).not.toBeInTheDocument();
  });

  it("does not offer a reviewer a decision on their own request", async () => {
    fakeStore([request({ requester_id: "principal-a" })]);
    render(<StudentLeaveWorkspace role="principal" userId="principal-a" />);
    await screen.findByText("Another administrator or principal must review your own request.");
    expect(screen.queryByRole("button", { name: "Review request" })).not.toBeInTheDocument();
    expect(mocks.rpc.mock.calls.some(([name]) => name === "review_student_leave")).toBe(false);
  });

  it("ignores a previous school's late review history", async () => {
    const user = userEvent.setup(); let finish!: (value: RpcResult) => void;
    const pending = new Promise<RpcResult>((resolve) => { finish = resolve; });
    schoolLoader.mockResolvedValue({ userId: "principal-a", schools: [{ id: "school-a", name: "School A" }, { id: "school-b", name: "School B" }], schoolAdminIds: [] });
    mocks.rpc.mockImplementation((_name, args) => args.p_school_id === "school-a" ? pending
      : Promise.resolve({ data: [request({ school_id: "school-b", reason: "School B request" })], error: null }));
    render(<StudentLeaveWorkspace role="principal" userId="principal-a" />);
    await user.selectOptions(await screen.findByLabelText("School"), "school-a");
    await user.selectOptions(screen.getByLabelText("School"), "school-b");
    await screen.findByText("School B request");
    await act(async () => { finish({ data: [request({ reason: "School A late request" })], error: null }); await pending; });
    expect(screen.queryByText("School A late request")).not.toBeInTheDocument();
  });

  it("hides all child records on an account change, including a late read", async () => {
    const store = fakeStore([request()]);
    render(<StudentLeaveWorkspace role="parent" userId="guardian-a" />);
    await screen.findByText("Family visit");
    await act(async () => { mocks.listener("SIGNED_IN", { user: { id: "other-account" } }); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Your sign-in changed");
    expect(screen.queryByText("Family visit")).not.toBeInTheDocument();
    expect(store.rows).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Submit leave request" })).not.toBeInTheDocument();
  });

  it("does not display a mismapped response and retries access errors explicitly", async () => {
    const user = userEvent.setup();
    familyLoader.mockRejectedValueOnce(new Error("Access failed")).mockResolvedValue([childA]);
    mocks.rpc.mockResolvedValue({ data: [request({ student_id: "other-child", reason: "Another child secret" })], error: null });
    render(<StudentLeaveWorkspace role="parent" userId="guardian-a" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be verified");
    await user.click(screen.getByRole("button", { name: "Refresh linked students" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Leave records could not be verified"));
    expect(screen.queryByText("Another child secret")).not.toBeInTheDocument();
  });
});

describe("notification leave links", () => {
  it("opens the selected child’s exact reviewed request beyond history paging and reloads it", async () => {
    const child={...childB,id:requestId(20)};familyLoader.mockResolvedValue([childA,child]);
    const row=request({student_id:child.id,student_name:child.first_name,status:"approved",reviewed_by:"principal-a",reviewer_name:"QA Principal",review_note:"Approved from notification",reviewed_at:"2026-11-06T12:00:00Z"});
    mocks.rpc.mockResolvedValue({data:row,error:null});
    const view=render(<StudentLeaveWorkspace role="parent" userId="guardian-a" initialChildId={child.id} initialRequestId={row.id} />);
    expect(await screen.findByText("Approved from notification")).toBeInTheDocument();
    expect(mocks.rpc).toHaveBeenCalledWith("get_family_notification_leave",{p_role:"parent",p_student_id:child.id,p_request_id:row.id});
    expect(mocks.rpc.mock.calls.some(([name])=>name==="list_family_student_leave")).toBe(false);
    expect(screen.getByRole("link",{name:"All leave history"})).toHaveAttribute("href",`/modules/student-leave?view=guardian&child=${child.id}`);
    view.unmount();render(<StudentLeaveWorkspace role="parent" userId="guardian-a" initialChildId={child.id} initialRequestId={row.id} />);
    expect(await screen.findByText("Approved from notification")).toBeInTheDocument();
  });
  it("does not fetch a different child after the requested child link is revoked", async()=>{
    fakeStore([request()]);render(<StudentLeaveWorkspace role="parent" userId="guardian-a" initialChildId={requestId(99)} initialRequestId={requestId(1)} />);
    expect(await screen.findByText(/student in this link is no longer available/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Student leave history")).not.toBeInTheDocument();expect(mocks.rpc).not.toHaveBeenCalled();
  });
});


it("points a newly submitted request back to complete history when viewing an old notification decision", async () => {
  const child={...childA,id:requestId(20)};familyLoader.mockResolvedValue([child]);
  const row=request({student_id:child.id,status:"approved",reviewed_by:"principal-a",reviewer_name:"QA Principal",review_note:"Approved old request",reviewed_at:"2026-11-06T12:00:00Z"});
  mocks.rpc.mockImplementation(async(name:string)=>({data:name==="submit_student_leave"?requestId(30):row,error:null}));
  render(<StudentLeaveWorkspace role="parent" userId="guardian-a" initialChildId={child.id} initialRequestId={row.id} />);
  await screen.findByText("Approved old request");fillRequest();await userEvent.click(screen.getByRole("button",{name:"Submit leave request"}));
  expect(await screen.findByText(/Open All leave history to follow the new request/)).toBeInTheDocument();
  expect(screen.getByRole("link",{name:"All leave history"})).toHaveAttribute("href",`/modules/student-leave?view=guardian&child=${child.id}`);
});
