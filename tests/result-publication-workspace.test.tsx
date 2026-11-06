import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResultPublicationWorkspace } from "@/components/academic/result-publication-workspace";
import { loadFamilyStudents, type FamilyStudent } from "@/lib/attendance/family";
import { loadSchoolManagementAccess } from "@/lib/attendance/repository";
import type { PublicationDetail } from "@/lib/result-publication";
import { familyResult, resultDetail, resultPreview, resultSummary, resultToken, resultUuid } from "./result-publication-fixture";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), getUser: vi.fn(), listener: (() => {}) as (event: string, session: { user: { id: string } } | null) => void }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc: mocks.rpc, auth: { getUser: mocks.getUser,
  onAuthStateChange: (listener: typeof mocks.listener) => { mocks.listener = listener; return { data: { subscription: { unsubscribe: () => {} } } }; },
} }) }));
vi.mock("@/lib/attendance/family", async (original) => ({ ...await original<typeof import("../lib/attendance/family")>(), loadFamilyStudents: vi.fn() }));
vi.mock("@/lib/attendance/repository", () => ({ loadSchoolManagementAccess: vi.fn() }));
const childA: FamilyStudent = { id: "child-a", school_id: "school-a", admission_no: "QA-1", first_name: "QA Anya", status: "active" };
const childB: FamilyStudent = { id: "child-b", school_id: "school-a", admission_no: "QA-2", first_name: "QA Kabir", status: "active" };
type Reply = { data: unknown; error: { code?: string; message: string } | null };
function store(initial: PublicationDetail[] = []) {
  const submissions = structuredClone(initial), requests = new Map<string, string>();
  let source = resultPreview(), loseRequest = false, loseReview = false, denyChild = "", nextRequestError: Reply["error"] = null;
  mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown> = {}): Promise<Reply> => {
    const data = (value: unknown): Reply => ({ data: structuredClone(value), error: null });
    if (name === "list_assessment_publication_candidates") return data([source.metadata]);
    if (name === "preview_assessment_publication") return data(source);
    if (name === "list_assessment_result_submissions") {
      const rows = submissions.filter((row) => (!args.p_school_id || row.school_id === args.p_school_id) && (!args.p_status || row.status === args.p_status));
      return data({ rows: rows.slice(Number(args.p_offset), Number(args.p_offset) + 50).map(resultSummary), total_count: rows.length, offset: args.p_offset });
    }
    if (name === "get_assessment_result_submission") return data(submissions.find((row) => row.id === args.p_submission_id));
    if (name === "request_assessment_publication") {
      if (nextRequestError) return { data: null, error: nextRequestError };
      const prior = requests.get(String(args.p_request_id)); if (prior) return data(prior);
      if (args.p_expected_source_token !== source.source_token) return { data: null, error: { code: "PT409", message: "Source changed. Refresh your preview." } };
      const row = resultDetail({ id: resultUuid(submissions.length + 1), snapshot: { metadata: source.metadata, pupils: source.pupils }, source_token: source.source_token });
      submissions.push(row); requests.set(String(args.p_request_id), row.id);
      if (loseRequest) { loseRequest = false; return { data: null, error: { message: "Lost acknowledgement" } }; }
      return data(row.id);
    }
    if (name === "review_assessment_publication" || name === "cancel_assessment_result_submission") {
      const row = submissions.find((item) => item.id === args.p_submission_id)!;
      row.status = name === "cancel_assessment_result_submission" ? "cancelled" : args.p_decision as "published" | "rejected";
      row.reviewed_by = row.status === "cancelled" ? "teacher" : "admin"; row.reviewer_name = row.status === "cancelled" ? "QA Teacher" : "QA Principal";
      row.review_note = String(args.p_reason); row.reviewed_at = "2026-11-06T10:00:00Z"; row.revision = row.status === "published" ? 1 : null; row.source_matches = null;
      if (loseReview) { loseReview = false; return { data: null, error: { message: "Lost review acknowledgement" } }; }
      return data(row.id);
    }
    if (name === "get_family_assessment_results") {
      if (args.p_student_id === denyChild) return { data: null, error: { code: "42501", message: "Revoked" } };
      const rows = submissions.filter((row) => row.status === "published").map((row) => familyResult({ id: row.id, student_id: String(args.p_student_id),
        student_name: args.p_student_id === "child-b" ? "QA Kabir" : "QA Anya", admission_no: args.p_student_id === "child-b" ? "QA-2" : "QA-1",
        marks_obtained: args.p_student_id === "child-b" ? 0 : 74, percentage: args.p_student_id === "child-b" ? 0 : 74 }));
      return data({ student_id: args.p_student_id, school_id: "school-a", rows: rows.slice(Number(args.p_offset), Number(args.p_offset) + 50), total_count: rows.length, offset: args.p_offset });
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  return { submissions, changeSource: () => { source = resultPreview({ source_token: "b".repeat(64) }); }, loseRequest: () => { loseRequest = true; },
    loseReview: () => { loseReview = true; }, deny: (child: string) => { denyChild = child; },
    failRequest: (error: NonNullable<Reply["error"]>) => { nextRequestError = error; }, ineligible: () => { source = resultPreview({ can_submit: false, issues: ["Assessment must be completed"] }); } };
}
function published() { return resultDetail({ status: "published", reviewed_by: "admin", reviewer_name: "QA Principal", review_note: "Every score reviewed", reviewed_at: "2026-11-06T10:00:00Z", revision: 1, source_matches: null }); }
beforeEach(() => {
  sessionStorage.clear(); mocks.rpc.mockReset(); mocks.getUser.mockResolvedValue({ data: { user: { id: "guardian" } }, error: null });
  vi.mocked(loadFamilyStudents).mockReset().mockResolvedValue([childA, childB]);
  vi.mocked(loadSchoolManagementAccess).mockReset().mockResolvedValue({ userId: "admin", schools: [{ id: "school-a", name: "QA School" }], schoolAdminIds: ["school-a"] });
});

describe("independent result publication UI", () => {
  it("previews all pupils including zero and requests a private result snapshot that survives refresh", async () => {
    const saved = store(); render(<ResultPublicationWorkspace role="teacher" userId="teacher" />); const user = userEvent.setup();
    await screen.findByText("0 / 100"); expect(screen.getByLabelText("Assessment", { exact: true })).toHaveAccessibleName("Assessment");
    await user.click(screen.getByRole("button", { name: "Request publication" })); await screen.findByText(/Publication requested/);
    expect(saved.submissions).toHaveLength(1); expect(screen.getByRole("button", { name: "Request publication" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Refresh requests" })); expect((await screen.findAllByText("Pending review")).length).toBeGreaterThan(1);
  });
  it("retries a lost request acknowledgement with the same source and intent", async () => {
    const saved = store(); saved.loseRequest(); render(<ResultPublicationWorkspace role="teacher" userId="teacher" />); const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Request publication" })); expect(await screen.findByRole("alert")).toHaveTextContent("could not be confirmed");
    await user.click(screen.getByRole("button", { name: "Request publication" })); await screen.findByText(/Publication requested/);
    const calls = mocks.rpc.mock.calls.filter(([name]) => name === "request_assessment_publication");
    expect(calls[0][1].p_request_id).toBe(calls[1][1].p_request_id); expect(calls[0][1].p_expected_source_token).toBe(resultToken); expect(saved.submissions).toHaveLength(1);
  });
  it("blocks ineligible publication and retains a stale preview until explicit reload", async () => {
    const saved = store(); render(<ResultPublicationWorkspace role="teacher" userId="teacher" />); const user = userEvent.setup();
    await screen.findByText("0 / 100"); saved.changeSource(); await user.click(screen.getByRole("button", { name: "Request publication" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Source changed"); expect(saved.submissions).toHaveLength(0);
    saved.ineligible(); await user.click(screen.getByRole("button", { name: "Refresh source preview" })); await screen.findByText("Assessment must be completed"); expect(screen.getByRole("button", { name: "Request publication" })).toBeDisabled();
  });
  it("publishes an independently reviewed snapshot and reloads the terminal decision", async () => {
    const saved = store([resultDetail()]); render(<ResultPublicationWorkspace role="principal" userId="admin" />); const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Open result snapshot" })); await screen.findByRole("button", { name: "Publish result snapshot" });
    await user.type(screen.getByLabelText("Review reason", { exact: true }), "Every pupil score reviewed");
    expect(screen.getByLabelText("Review reason", { exact: true })).toHaveAccessibleName("Review reason"); expect(screen.getByLabelText("School")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Publish result snapshot" })); await screen.findByText(/Result snapshot published/);
    expect(saved.submissions[0]).toMatchObject({ status: "published", reviewed_by: "admin", review_note: "Every pupil score reviewed", revision: 1 });
    expect(screen.getByLabelText("Request status")).toBeEnabled(); await user.selectOptions(screen.getByLabelText("Request status"), "published"); expect((await screen.findAllByText("Published · Revision 1")).length).toBeGreaterThan(0);
  });
  it("keeps the review reason after an unknown acknowledgement and retries the same decision", async () => {
    const saved = store([resultDetail()]); saved.loseReview(); render(<ResultPublicationWorkspace role="admin" userId="admin" />); const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Open result snapshot" })); await user.type(await screen.findByLabelText("Review reason"), "Reviewed independently");
    await user.click(screen.getByRole("button", { name: "Publish result snapshot" })); expect(await screen.findByRole("alert")).toHaveTextContent("could not be confirmed");
    expect(screen.getByLabelText("Review reason")).toHaveValue("Reviewed independently"); await user.click(screen.getByRole("button", { name: "Publish result snapshot" })); await screen.findByText(/Result snapshot published/);
    const calls = mocks.rpc.mock.calls.filter(([name]) => name === "review_assessment_publication"); expect(calls[0][1]).toEqual(calls[1][1]);
  });
  it("hides self-review and prevents publication of an outdated source while allowing rejection", async () => {
    store([resultDetail({ requested_by: "admin" })]); const first = render(<ResultPublicationWorkspace role="admin" userId="admin" />); const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Open result snapshot" })); await screen.findByText(/independent reviewer must decide/); expect(screen.queryByRole("button", { name: "Publish result snapshot" })).not.toBeInTheDocument();
    first.unmount(); store([resultDetail({ source_matches: false })]); render(<ResultPublicationWorkspace role="admin" userId="admin" />);
    await user.click(await screen.findByRole("button", { name: "Open result snapshot" })); expect(await screen.findByRole("button", { name: "Publish result snapshot" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Reject publication" })).toBeEnabled();
  });
  it("cancels an own pending submission without altering marks and permits a fresh source preview", async () => {
    const saved = store([resultDetail()]); render(<ResultPublicationWorkspace role="teacher" userId="teacher" />); const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Open result snapshot" })); await user.type(await screen.findByLabelText("Cancellation reason"), "Refresh the changed source");
    await user.click(screen.getByRole("button", { name: "Cancel publication request" })); await screen.findByText(/Request cancelled/); expect(saved.submissions[0].status).toBe("cancelled");
    expect(await screen.findByRole("button", { name: "Request publication" })).toBeEnabled();
  });
  it("shows only the selected child's published result, persists choice and offers safe print", async () => {
    store([published()]); const user = userEvent.setup(), view = render(<ResultPublicationWorkspace role="parent" userId="guardian" />);
    const first = await screen.findByRole("article", { name: "November science assessment published result" }); expect(first).toHaveTextContent("QA Anya"); expect(first).not.toHaveTextContent("QA Kabir");
    expect(screen.queryByRole("button", { name: "Publish result snapshot" })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Select child", { exact: true }), "child-b"); const second = await screen.findByRole("article", { name: "November science assessment published result" }); expect(second).toHaveTextContent("QA Kabir"); expect(second).toHaveTextContent("0");
    view.unmount(); render(<ResultPublicationWorkspace role="parent" userId="guardian" />); expect(await screen.findByLabelText("Select child")).toHaveValue("child-b");
    const blocked = vi.spyOn(window, "open").mockReturnValue(null); try { await user.click(await screen.findByRole("button", { name: "Print this result" })); expect(await screen.findByRole("alert")).toHaveTextContent("print window was blocked"); } finally { blocked.mockRestore(); }
  });
  it("clears old results after revoke/read denial and keeps an independently linked sibling usable", async () => {
    const saved = store([published()]); render(<ResultPublicationWorkspace role="parent" userId="guardian" />); const user = userEvent.setup();
    await screen.findByRole("article"); saved.deny("child-a"); await user.click(screen.getByRole("button", { name: "Refresh published results" })); expect(await screen.findByRole("alert")).toHaveTextContent("access or teaching assignment"); expect(screen.queryByRole("article")).not.toBeInTheDocument();
    vi.mocked(loadFamilyStudents).mockResolvedValue([childB]); await user.click(screen.getByRole("button", { name: "Refresh linked students" })); expect(await screen.findByRole("article")).toHaveTextContent("QA Kabir");
  });
  it("ignores a late previous-child response and a late response after account change", async () => {
    store([published()]); const original = mocks.rpc.getMockImplementation()!; let resolve!: (value: Reply) => void;
    mocks.rpc.mockImplementation((name: string, args: Record<string, unknown>) => name === "get_family_assessment_results" && args.p_student_id === "child-a" ? new Promise<Reply>((done) => { resolve = done; }) : original(name, args));
    render(<ResultPublicationWorkspace role="parent" userId="guardian" />); const user = userEvent.setup(); await user.selectOptions(await screen.findByLabelText("Select child"), "child-b"); expect(await screen.findByRole("article")).toHaveTextContent("QA Kabir");
    await act(async () => { resolve({ data: { student_id: "child-a", school_id: "school-a", rows: [familyResult()], total_count: 1, offset: 0 }, error: null }); }); expect(screen.getByRole("article")).toHaveTextContent("QA Kabir");
    act(() => mocks.listener("SIGNED_OUT", null)); expect(await screen.findByRole("alert")).toHaveTextContent("sign-in changed"); expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });
  it("does not expose unpublished results or an unverified/mismapped family response", async () => {
    store([resultDetail()]); mocks.getUser.mockResolvedValue({ data: { user: { id: "student" } }, error: null }); render(<ResultPublicationWorkspace role="student" userId="student" />);
    expect(await screen.findByText(/No school-published results/)).toBeInTheDocument(); expect(screen.queryByRole("article")).not.toBeInTheDocument();
    mocks.rpc.mockResolvedValue({ data: { student_id: "child-b", school_id: "school-a", rows: [familyResult({ student_id: "child-b" })], total_count: 1, offset: 0 }, error: null });
    await userEvent.click(screen.getByRole("button", { name: "Refresh published results" })); expect(await screen.findByRole("alert")).toHaveTextContent("could not be verified");
  });
});
