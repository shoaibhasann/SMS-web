import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubstituteCoverageWorkspace } from "../components/academic/substitute-coverage-workspace";

const { rpc, loadAccess, sessionListener, setupReply, writeReply } = vi.hoisted(() => ({
  rpc: vi.fn(), loadAccess: vi.fn(),
  sessionListener: { current: undefined as undefined | ((_event: string, session: { user: { id: string } } | null) => void) },
  setupReply: vi.fn(), writeReply: vi.fn(),
}));
vi.mock("@/lib/attendance/repository", () => ({ loadSchoolManagementAccess: loadAccess }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc, auth: {
  onAuthStateChange: (callback: typeof sessionListener.current) => {
    sessionListener.current = callback; return { data: { subscription: { unsubscribe() {} } } };
  },
} }) }));

const coverage = { id: "coverage", source_assignment_id: "source", substitute_teacher_id: "substitute", substitute_teacher_name: "Substitute Teacher",
  source_teacher_name: "Original Teacher", class_name: "Class 6", section_name: "A", starts_on: "2026-11-05", ends_on: "2026-11-07",
  reason: "Original teacher leave", created_at: "2026-11-05T05:00:00Z", created_by_name: "Admin", revoked_at: null, revoke_reason: null, status: "active" };
const setup = {
  year: { id: "year", name: "2026–27", start_date: "2026-04-01", end_date: "2027-03-31" }, today: "2026-11-05",
  teachers: [{ id: "original", full_name: "Original Teacher", employee_id: "T1" }, { id: "substitute", full_name: "Substitute Teacher", employee_id: "T2" }],
  assignments: [{ id: "source", teacher_id: "original", teacher_name: "Original Teacher", class_name: "Class 6", section_name: "A", subject_name: "English" }],
  coverages: [coverage],
};
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(await screen.findByRole("combobox", { name: "Class-teacher assignment" }), "source");
  await user.selectOptions(screen.getByRole("combobox", { name: "Substitute teacher" }), "substitute");
  fireEvent.change(screen.getByLabelText("Coverage start date"), { target: { value: "2026-11-05" } });
  fireEvent.change(screen.getByLabelText("Coverage end date"), { target: { value: "2026-11-07" } });
  await user.type(screen.getByLabelText("Coverage reason"), "  Original teacher leave  ");
}
beforeEach(() => {
  vi.clearAllMocks();
  loadAccess.mockResolvedValue({ userId: "admin", schools: [{ id: "school", name: "School A" }] });
  setupReply.mockResolvedValue({ data: setup, error: null });
  writeReply.mockResolvedValue({ data: "coverage", error: null });
  rpc.mockImplementation((name: string) => {
    const query = {
      abortSignal: vi.fn().mockReturnThis(), returns: () => setupReply(),
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => writeReply(name).then(resolve, reject),
    };
    return query;
  });
});

describe("substitute attendance management", () => {
  it("uses manager-authorized school setup and excludes covering one's own assignment", async () => {
    const user = userEvent.setup(); render(<SubstituteCoverageWorkspace userId="admin" />);
    await user.selectOptions(await screen.findByLabelText("Class-teacher assignment"), "source");
    expect(loadAccess).toHaveBeenCalledWith(expect.anything(), "substitute attendance coverage", ["school_admin", "principal"]);
    expect(rpc).toHaveBeenCalledWith("get_substitute_attendance_setup", { p_school_id: "school" });
    const substitute = screen.getByRole("combobox", { name: "Substitute teacher" });
    expect(substitute).not.toContainElement(screen.queryByRole("option", { name: "Original Teacher" }));
    expect(screen.getByLabelText("Coverage start date")).toHaveAttribute("min", "2026-11-05");
    expect(screen.getByLabelText("Coverage end date")).toHaveAttribute("max", "2027-03-31");
  });
  it("submits exact school, source, substitute and inclusive dates once while frozen", async () => {
    const user = userEvent.setup(); const pending = deferred<unknown>(); writeReply.mockReturnValue(pending.promise);
    render(<SubstituteCoverageWorkspace userId="admin" />); await fill(user);
    const form = screen.getByRole("form", { name: "Assign substitute attendance coverage" });
    fireEvent.submit(form); fireEvent.submit(form);
    expect(rpc.mock.calls.filter(([name]) => name === "create_substitute_attendance_coverage")).toEqual([["create_substitute_attendance_coverage", {
      p_school_id: "school", p_source_assignment_id: "source", p_substitute_teacher_id: "substitute",
      p_starts_on: "2026-11-05", p_ends_on: "2026-11-07", p_reason: "Original teacher leave", p_request_id: expect.any(String),
    }]]);
    expect(screen.getByLabelText("Coverage reason")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh coverage" })).toBeDisabled();
    await act(async () => { pending.resolve({ data: "coverage", error: null }); });
    await screen.findByText("Substitute attendance coverage assigned.");
    await waitFor(() => expect(setupReply).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Coverage reason")).toHaveValue("");
  });
  it("retains failed values and reuses request id for exact retries without claiming success", async () => {
    const user = userEvent.setup(); writeReply.mockResolvedValue({ data: null, error: { code: "23P01" } });
    render(<SubstituteCoverageWorkspace userId="admin" />); await fill(user);
    await user.click(screen.getByRole("button", { name: "Assign substitute" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("overlaps an existing assignment");
    expect(screen.getByRole("alert")).toHaveTextContent("Your draft is kept. Choose Cancel coverage draft to enable Refresh coverage.");
    expect(screen.getByRole("button", { name: "Refresh coverage" })).toBeDisabled();
    expect(screen.getByLabelText("Coverage reason")).toHaveValue("  Original teacher leave  ");
    await user.click(screen.getByRole("button", { name: "Assign substitute" }));
    const writes = rpc.mock.calls.filter(([name]) => name === "create_substitute_attendance_coverage");
    expect(writes[0][1].p_request_id).toBe(writes[1][1].p_request_id);
    expect(screen.queryByText("Substitute attendance coverage assigned.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel coverage draft" }));
    expect(screen.getByRole("button", { name: "Refresh coverage" })).toBeEnabled();
    expect(screen.getByLabelText("Coverage reason")).toHaveValue("");
    expect(screen.queryByText("Your draft is kept. Choose Cancel coverage draft to enable Refresh coverage.")).not.toBeInTheDocument();
  });
  it("requires revoke confirmation/reason and preserves the history while server reload is pending", async () => {
    const user = userEvent.setup(); writeReply.mockResolvedValue({ data: true, error: null });
    render(<SubstituteCoverageWorkspace userId="admin" />);
    await user.click(await screen.findByRole("button", { name: "Revoke coverage" }));
    expect(writeReply).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Confirm revoke coverage" })).toBeDisabled();
    await user.type(screen.getByLabelText("Revoke reason"), "Teacher returned");
    await user.click(screen.getByRole("button", { name: "Confirm revoke coverage" }));
    await screen.findByText("Substitute attendance coverage revoked.");
    expect(rpc).toHaveBeenCalledWith("revoke_substitute_attendance_coverage", {
      p_school_id: "school", p_coverage_id: "coverage", p_reason: "Teacher returned",
    });
    await screen.findByText("Class 6 / A · Substitute Teacher");
  });
  it("allows revoking invalid source snapshots so administrators can replace stale coverage", async () => {
    setupReply.mockResolvedValue({ data: { ...setup, coverages: [{ ...coverage, status: "invalid" }] }, error: null });
    render(<SubstituteCoverageWorkspace userId="admin" />);
    expect(await screen.findByRole("button", { name: "Revoke coverage" })).toBeEnabled();
  });
  it("keeps a failed revoke reason and explains how to re-enable refresh", async () => {
    const user = userEvent.setup(); writeReply.mockResolvedValue({ data: null, error: { code: "42501" } });
    render(<SubstituteCoverageWorkspace userId="admin" />);
    await user.click(await screen.findByRole("button", { name: "Revoke coverage" }));
    await user.type(screen.getByLabelText("Revoke reason"), "Teacher returned");
    await user.click(screen.getByRole("button", { name: "Confirm revoke coverage" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose Keep coverage to close this confirmation and enable Refresh coverage.");
    expect(screen.getByLabelText("Revoke reason")).toHaveValue("Teacher returned");
    expect(screen.getByRole("button", { name: "Refresh coverage" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Keep coverage" }));
    expect(screen.getByRole("button", { name: "Refresh coverage" })).toBeEnabled();
    expect(screen.queryByRole("form", { name: "Revoke substitute coverage" })).not.toBeInTheDocument();
  });
  it("explains stale assignment and session-date rejections with the server's reason", async () => {
    const user = userEvent.setup();
    writeReply.mockResolvedValueOnce({ data: null, error: { code: "42501", message: "Choose a current class-teacher assignment in this school." } })
      .mockResolvedValueOnce({ data: null, error: { code: "22023", message: "Coverage dates must be within the active academic year." } });
    render(<SubstituteCoverageWorkspace userId="admin" />); await fill(user);
    await user.click(screen.getByRole("button", { name: "Assign substitute" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Choose a current class-teacher assignment in this school.");
    expect(alert).not.toHaveTextContent("school access changed");
    await user.type(screen.getByLabelText("Coverage reason"), "x");
    await user.click(screen.getByRole("button", { name: "Assign substitute" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Coverage dates must be within the active academic year."));
  });
  it("reloads coverage choices and statuses when the assignment panel reports a change", async () => {
    const view = render(<SubstituteCoverageWorkspace userId="admin" assignmentRevision={0} />);
    expect(await screen.findByText("Active")).toHaveClass("badge", "text-success");
    setupReply.mockResolvedValue({ data: { ...setup, coverages: [{ ...coverage, status: "invalid" }],
      assignments: [{ ...setup.assignments[0], id: "new-source", teacher_name: "New Class Teacher" }] }, error: null });
    view.rerender(<SubstituteCoverageWorkspace userId="admin" assignmentRevision={1} />);
    expect(await screen.findByText("Invalid")).not.toHaveClass("text-success");
    expect(setupReply).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("option", { name: "Class 6 / A · New Class Teacher" })).toBeInTheDocument();
  });
  it.each([
    ["a coverage draft", async (user: ReturnType<typeof userEvent.setup>) => { await fill(user); }],
    ["a revoke confirmation", async (user: ReturnType<typeof userEvent.setup>) => { await user.click(await screen.findByRole("button", { name: "Revoke coverage" })); }],
  ])("lets Refresh recover when an assignment-change reload fails while %s is open", async (_name, open) => {
    const user = userEvent.setup();
    const view = render(<SubstituteCoverageWorkspace userId="admin" assignmentRevision={0} />);
    await open(user);
    expect(screen.getByRole("button", { name: "Refresh coverage" })).toBeDisabled();
    setupReply.mockResolvedValueOnce({ data: null, error: { code: "XX000" } });
    view.rerender(<SubstituteCoverageWorkspace userId="admin" assignmentRevision={1} />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Substitute coverage could not be loaded");
    expect(alert).toHaveTextContent("Refreshing discards your unsaved coverage draft.");
    const refresh = screen.getByRole("button", { name: "Refresh coverage" });
    expect(refresh).toBeEnabled();
    await user.click(refresh);
    expect(await screen.findByRole("form", { name: "Assign substitute attendance coverage" })).toBeInTheDocument();
    expect(setupReply).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("combobox", { name: "Class-teacher assignment" })).toHaveValue("");
    expect(screen.queryByRole("form", { name: "Revoke substitute coverage" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh coverage" })).toBeEnabled();
  });
  it("closes a revoke confirmation whose coverage disappeared after an assignment-change reload", async () => {
    const user = userEvent.setup();
    const view = render(<SubstituteCoverageWorkspace userId="admin" assignmentRevision={0} />);
    await user.click(await screen.findByRole("button", { name: "Revoke coverage" }));
    await user.type(screen.getByLabelText("Revoke reason"), "Teacher returned");
    setupReply.mockResolvedValue({ data: { ...setup, coverages: [] }, error: null });
    view.rerender(<SubstituteCoverageWorkspace userId="admin" assignmentRevision={1} />);
    expect(await screen.findByText("The coverage you were revoking changed or is no longer listed. Review the current coverage history.")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Revoke substitute coverage" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Class-teacher assignment" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Cancel coverage draft" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh coverage" })).toBeEnabled();
  });
  it("closes a revoke confirmation whose coverage was revoked elsewhere", async () => {
    const user = userEvent.setup();
    const view = render(<SubstituteCoverageWorkspace userId="admin" assignmentRevision={0} />);
    await user.click(await screen.findByRole("button", { name: "Revoke coverage" }));
    setupReply.mockResolvedValue({ data: { ...setup, coverages: [{ ...coverage, status: "revoked", revoked_at: "2026-11-05T06:00:00Z" }] }, error: null });
    view.rerender(<SubstituteCoverageWorkspace userId="admin" assignmentRevision={1} />);
    expect(await screen.findByText("Revoked")).toHaveClass("badge");
    expect(screen.queryByRole("form", { name: "Revoke substitute coverage" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh coverage" })).toBeEnabled();
  });
  it("clears a coverage draft's stale assignment and substitute after an assignment-change reload", async () => {
    const user = userEvent.setup();
    const view = render(<SubstituteCoverageWorkspace userId="admin" assignmentRevision={0} />);
    await fill(user);
    setupReply.mockResolvedValue({ data: { ...setup, teachers: [{ id: "next", full_name: "Next Teacher", employee_id: "T3" }],
      assignments: [{ ...setup.assignments[0], id: "new-source", teacher_name: "New Class Teacher" }] }, error: null });
    view.rerender(<SubstituteCoverageWorkspace userId="admin" assignmentRevision={1} />);
    expect(await screen.findByText("The class-teacher assignment or substitute you chose changed. Choose them again.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Class-teacher assignment" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Substitute teacher" })).toHaveValue("");
    expect(screen.getByLabelText("Coverage reason")).toHaveValue("  Original teacher leave  ");
    const cancel = screen.getByRole("button", { name: "Cancel coverage draft" });
    expect(cancel).toBeEnabled();
    await user.click(cancel);
    expect(screen.getByRole("button", { name: "Refresh coverage" })).toBeEnabled();
  });
  it("clears only a stale substitute when the chosen assignment still exists", async () => {
    const user = userEvent.setup();
    const view = render(<SubstituteCoverageWorkspace userId="admin" assignmentRevision={0} />);
    await fill(user);
    setupReply.mockResolvedValue({ data: { ...setup, teachers: [setup.teachers[0]] }, error: null });
    view.rerender(<SubstituteCoverageWorkspace userId="admin" assignmentRevision={1} />);
    expect(await screen.findByText("The class-teacher assignment or substitute you chose changed. Choose them again.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Class-teacher assignment" })).toHaveValue("source");
    expect(screen.getByRole("combobox", { name: "Substitute teacher" })).toHaveValue("");
  });
  it("shows no form after a permission failure", async () => {
    loadAccess.mockRejectedValue(new Error("denied")); render(<SubstituteCoverageWorkspace userId="admin" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("School access could not be loaded");
    expect(screen.getByRole("alert")).toHaveClass("text-sm", "text-danger");
    expect(screen.queryByRole("form")).not.toBeInTheDocument(); expect(rpc).not.toHaveBeenCalled();
  });
  it("aborts and ignores a pending mutation after sign-in changes", async () => {
    const user = userEvent.setup(); const pending = deferred<unknown>(); writeReply.mockReturnValue(pending.promise);
    render(<SubstituteCoverageWorkspace userId="admin" />); await fill(user);
    fireEvent.submit(screen.getByRole("form", { name: "Assign substitute attendance coverage" }));
    const query = rpc.mock.results.at(-1)!.value;
    act(() => sessionListener.current?.("SIGNED_OUT", null));
    expect(query.abortSignal.mock.calls[0][0].aborted).toBe(true);
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    await act(async () => { pending.resolve({ data: "coverage", error: null }); });
    expect(setupReply).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Substitute attendance coverage assigned.")).not.toBeInTheDocument();
  });
  it("keeps confirmed write success separate from a later reload failure", async () => {
    const user = userEvent.setup(); setupReply.mockResolvedValueOnce({ data: setup, error: null }).mockResolvedValue({ data: null, error: { code: "42501" } });
    render(<SubstituteCoverageWorkspace userId="admin" />); await fill(user);
    await user.click(screen.getByRole("button", { name: "Assign substitute" }));
    await screen.findByText("Substitute attendance coverage assigned.");
    expect(await screen.findByRole("alert")).toHaveTextContent("Substitute coverage could not be loaded");
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });
});
