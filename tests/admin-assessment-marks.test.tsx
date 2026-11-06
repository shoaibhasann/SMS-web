import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminAssessmentWorkspace } from "../components/admin/admin-assessment-workspace";
import type { AssessmentMark, AssessmentRecord, AssessmentStudent } from "../lib/assessments";

const { rpc, loadAssessments, loadAssessmentMarks, loadAssessmentStudents, loadAssessmentRoster, unsafeUpsert } = vi.hoisted(() => ({
  rpc: vi.fn(), loadAssessments: vi.fn(), loadAssessmentMarks: vi.fn(), loadAssessmentStudents: vi.fn(), loadAssessmentRoster: vi.fn(), unsafeUpsert: vi.fn(),
}));
vi.mock("@/lib/assessments", async () => ({
  ...await vi.importActual<typeof import("../lib/assessments")>("../lib/assessments"),
  loadAssessments, loadAssessmentMarks, loadAssessmentStudents, loadAssessmentRoster,
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({
  auth: { getUser: async () => ({ data: { user: { id: "admin" } }, error: null }) }, rpc,
  from: (table: string) => {
    const rows: Record<string, unknown[]> = {
      user_roles: [{ role: "school_admin", school_id: "school" }],
      academic_years: [{ id: "year", name: "2026–27" }], classes: [{ id: "class", name: "Class 6" }],
      sections: [{ id: "section", class_id: "class", name: "A" }], subjects: [{ id: "subject", name: "Science" }],
      teachers: [{ id: "teacher", full_name: "Assigned teacher" }],
    };
    const query = { select: () => query, eq: () => query, order: () => query, upsert: unsafeUpsert,
      then: (resolve: (value: { data: unknown[]; error: null }) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve) };
    return query;
  },
}) }));

let assessment: AssessmentRecord;
let stored: AssessmentMark[];
const roster: AssessmentStudent[] = [
  { id: "student-a", first_name: "Aarav", middle_name: null, last_name: "Sharma", admission_no: "QA-01", roll_no: "1" },
  { id: "student-b", first_name: "Sara", middle_name: null, last_name: "Khan", admission_no: "QA-02", roll_no: "2" },
];
const clone = <T,>(value: T): T => structuredClone(value);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  assessment = { id: "assessment", school_id: "school", academic_year_id: "year", class_id: "class", section_id: "section",
    subject_id: "subject", teacher_id: "teacher", name: "Science unit test", assessment_date: "2026-11-05", maximum_marks: 100,
    description: null, status: "completed", updated_at: "2026-11-06T08:00:00.000001Z" };
  stored = roster.map((student, index) => ({ id: `mark-${index}`, assessment_id: assessment.id, student_id: student.id,
    marks_obtained: index ? 68 : 74, remarks: index ? "Keep Sara feedback" : "Keep Aarav feedback", updated_at: "2026-11-06T08:01:00.000001Z" }));
  loadAssessments.mockImplementation(async () => [clone(assessment)]);
  loadAssessmentMarks.mockImplementation(async () => clone(stored));
  loadAssessmentStudents.mockImplementation(async () => clone(roster));
  loadAssessmentRoster.mockImplementation(async () => ({ students: clone(roster), marks: clone(stored) }));
  rpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => {
    const existing = stored.find((mark) => mark.student_id === args.p_student_id);
    if (args.p_expected_assessment_updated_at !== assessment.updated_at || !existing
      || existing.id !== args.p_mark_id || existing.updated_at !== args.p_expected_mark_updated_at
      || existing.marks_obtained !== args.p_expected_marks || existing.remarks !== args.p_expected_remarks) {
      return { data: null, error: { code: "40001", message: "Changed in another session" } };
    }
    const saved = { ...existing, marks_obtained: Number(args.p_marks), remarks: args.p_remarks as string | null,
      updated_at: "2026-11-06T08:02:00.000001Z" };
    stored = stored.map((mark) => mark.id === existing.id ? saved : mark);
    return { data: clone(saved), error: null };
  });
});

async function open() {
  const user = userEvent.setup();
  render(<AdminAssessmentWorkspace mode="exams" />);
  await user.click(await screen.findByRole("button", { name: "Manage marks for Science unit test" }));
  const aarav = await screen.findByRole("spinbutton", { name: "Marks for Aarav Sharma" });
  const sara = screen.getByRole("spinbutton", { name: "Marks for Sara Khan" });
  return { user, aarav, sara };
}

function change(field: HTMLElement, value: string) { fireEvent.change(field, { target: { value } }); }

describe("admin changed-only assessment marks", () => {
  it("saves only the changed pupil with frozen parent/mark versions and preserves existing remarks", async () => {
    const { user, aarav, sara } = await open();
    const expected = clone(stored[0]);
    stored[1] = { ...stored[1], marks_obtained: 90, updated_at: "2026-11-06T08:03:00.000001Z" };
    change(aarav, "80");
    await user.click(screen.getByRole("button", { name: "Save marks" }));
    expect(await screen.findByRole("status")).toHaveTextContent("1 changed mark saved");
    expect(rpc).toHaveBeenCalledExactlyOnceWith("save_assessment_mark", expect.objectContaining({
      p_assessment_id: assessment.id, p_expected_assessment_updated_at: assessment.updated_at, p_student_id: "student-a",
      p_mark_id: expected.id, p_expected_mark_updated_at: expected.updated_at, p_expected_marks: 74,
      p_expected_remarks: "Keep Aarav feedback", p_marks: 80, p_remarks: "Keep Aarav feedback",
    }));
    expect(stored[1].marks_obtained).toBe(90);
    expect(sara).toHaveValue(68);
    expect(unsafeUpsert).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Reload saved marks" }));
    expect(await screen.findByRole("spinbutton", { name: "Marks for Sara Khan" })).toHaveValue(90);
    expect(screen.getByRole("button", { name: "Save marks" })).toBeDisabled();
  });

  it("retains a stale pupil draft and its loaded version until explicit reconciliation", async () => {
    const { user, aarav } = await open();
    const version = stored[0].updated_at;
    stored[0] = { ...stored[0], marks_obtained: 85, updated_at: "2026-11-06T08:03:00.000001Z" };
    change(aarav, "81");
    await user.click(screen.getByRole("button", { name: "Save marks" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not confirmed");
    expect(aarav).toHaveValue(81);
    expect(stored[0].marks_obtained).toBe(85);
    await user.click(screen.getByRole("button", { name: "Save marks" }));
    expect(rpc.mock.calls[1][1].p_expected_mark_updated_at).toBe(version);
    await user.click(screen.getByRole("button", { name: "Reload saved marks" }));
    expect(window.confirm).toHaveBeenCalled();
    expect(await screen.findByRole("spinbutton", { name: "Marks for Aarav Sharma" })).toHaveValue(85);
  });

  it("does not rebase an open parent scale after a list refresh", async () => {
    const { user, aarav } = await open();
    const version = assessment.updated_at;
    assessment = { ...assessment, maximum_marks: 120, updated_at: "2026-11-06T08:04:00.000001Z" };
    change(aarav, "82");
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(loadAssessments.mock.calls.length).toBeGreaterThanOrEqual(3));
    await user.click(screen.getByRole("button", { name: "Save marks" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not confirmed");
    expect(rpc.mock.calls[0][1].p_expected_assessment_updated_at).toBe(version);
    expect(aarav).toHaveValue(82);
    expect(screen.getByText(/100 maximum marks/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reload saved marks" }));
    await screen.findByText(/120 maximum marks/);
  });

  it("advances only confirmed pupil baselines after a partial save", async () => {
    const { user, aarav, sara } = await open();
    const oldSara = clone(stored[1]);
    stored[1] = { ...stored[1], marks_obtained: 95, updated_at: "2026-11-06T08:03:00.000001Z" };
    change(aarav, "80"); change(sara, "70");
    await user.click(screen.getByRole("button", { name: "Save marks" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("1 mark was not confirmed");
    expect(screen.getByRole("status")).toHaveTextContent("1 changed mark saved");
    expect(aarav).toHaveValue(80); expect(sara).toHaveValue(70);
    await user.click(screen.getByRole("button", { name: "Save marks" }));
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc.mock.calls[2][1]).toMatchObject({ p_student_id: "student-b", p_expected_mark_updated_at: oldSara.updated_at,
      p_expected_marks: 68, p_expected_remarks: oldSara.remarks });
    expect(stored.find((mark) => mark.student_id === "student-a")?.marks_obtained).toBe(80);
  });

  it("blocks duplicate submissions and locks the draft during an outstanding save", async () => {
    const { aarav, sara } = await open();
    let complete!: (result: unknown) => void;
    rpc.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    change(aarav, "80");
    const form = screen.getByRole("button", { name: "Save marks" }).closest("form")!;
    fireEvent.submit(form); fireEvent.submit(form);
    expect(rpc).toHaveBeenCalledOnce();
    expect(aarav).toBeDisabled(); expect(sara).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reload saved marks" })).toBeDisabled();
    await act(async () => complete({ data: { ...stored[0], marks_obtained: 80, updated_at: "2026-11-06T08:04:00.000001Z" }, error: null }));
    await screen.findByRole("status");
  });

  it("does not turn clearing a saved score into deletion or zero", async () => {
    const { user, aarav } = await open();
    change(aarav, "");
    await user.click(screen.getByRole("button", { name: "Save marks" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("cannot be cleared");
    expect(rpc).not.toHaveBeenCalled();
    expect(unsafeUpsert).not.toHaveBeenCalled();
    expect(stored[0].marks_obtained).toBe(74);
  });

  it("preserves the prior draft when explicit reload fails", async () => {
    const { user, aarav } = await open();
    change(aarav, "82");
    loadAssessmentRoster.mockRejectedValueOnce(new Error("Network unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await user.click(screen.getByRole("button", { name: "Reload saved marks" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("prior draft is kept");
    expect(await screen.findByRole("spinbutton", { name: "Marks for Aarav Sharma" })).toHaveValue(82);
    expect(screen.getByRole("button", { name: "Save marks" })).toBeEnabled();
  });

  it("treats a newly entered zero as a score while leaving another pupil unmarked", async () => {
    stored = [];
    const { user, aarav, sara } = await open();
    expect(aarav).toHaveValue(null); expect(sara).toHaveValue(null);
    expect(screen.getByRole("button", { name: "Save marks" })).toBeDisabled();
    rpc.mockImplementationOnce(async (_name: string, args: Record<string, unknown>) => ({ data: {
      id: "new-zero", assessment_id: assessment.id, student_id: args.p_student_id, marks_obtained: 0,
      remarks: null, updated_at: "2026-11-06T08:03:00.000001Z",
    }, error: null }));
    change(aarav, "0");
    await user.click(screen.getByRole("button", { name: "Save marks" }));
    expect(await screen.findByRole("status")).toHaveTextContent("1 changed mark saved");
    expect(rpc).toHaveBeenCalledExactlyOnceWith("save_assessment_mark", expect.objectContaining({
      p_student_id: "student-a", p_mark_id: null, p_expected_mark_updated_at: null, p_expected_marks: null,
      p_expected_remarks: null, p_marks: 0, p_remarks: null,
    }));
    expect(sara).toHaveValue(null);
  });

  it("requires explicit discard before reloading or closing a changed draft", async () => {
    const { user, aarav } = await open();
    change(aarav, "82");
    vi.mocked(window.confirm).mockReturnValue(false);
    const requests = loadAssessmentRoster.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Reload saved marks" }));
    expect(loadAssessmentRoster).toHaveBeenCalledTimes(requests);
    expect(aarav).toHaveValue(82);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("spinbutton", { name: "Marks for Aarav Sharma" })).toHaveValue(82);
    expect(rpc).not.toHaveBeenCalled();
  });

});
