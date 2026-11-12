import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminAssessmentWorkspace } from "../components/admin/admin-assessment-workspace";
import type { AssessmentMark, AssessmentRecord, AssessmentStudent } from "../lib/assessments";

const { loadAssessments, loadAssessmentMarks, loadAssessmentStudents, update } = vi.hoisted(() => ({
  loadAssessments: vi.fn(), loadAssessmentMarks: vi.fn(), loadAssessmentStudents: vi.fn(), update: vi.fn(),
}));
vi.mock("@/lib/assessments", async () => ({
  ...await vi.importActual<typeof import("../lib/assessments")>("../lib/assessments"),
  loadAssessments, loadAssessmentMarks, loadAssessmentStudents,
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({
  auth: { getUser: async () => ({ data: { user: { id: "admin" } }, error: null }) },
  from: (table: string) => {
    const rows: Record<string, unknown[]> = {
      user_roles: [{ role: "school_admin", school_id: "school" }], schools: [{ id: "school", name: "School" }],
      academic_years: [{ id: "next-year", name: "2027–28", is_current: false }, { id: "current-year", name: "2026–27", is_current: true }],
      classes: [{ id: "class", name: "Class 6" }], subjects: [{ id: "subject", name: "Science" }],
    };
    let payload: { status?: string } = {};
    const query = {
      select: () => query, eq: () => query, in: () => query, order: () => query, range: () => query,
      update: (value: { status?: string }) => { payload = value; update(value); return query; },
      maybeSingle: () => Promise.resolve({ data: { id: "exam-0", status: payload.status, updated_at: "2026-11-11T10:00:00Z" }, error: null }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: null, count: (rows[table] ?? []).length }).then(resolve),
    };
    return query;
  },
}) }));

const exam = (id: string, year: string): AssessmentRecord => ({ id, school_id: "school", academic_year_id: year, class_id: "class",
  section_id: null, subject_id: "subject", teacher_id: "teacher", name: `Exam ${id}`, assessment_date: "2026-11-05",
  maximum_marks: 100, description: null, status: "scheduled", updated_at: "2026-11-06T08:00:00Z" });
const pupils: AssessmentStudent[] = Array.from({ length: 150 }, (_, index) => ({ id: `pupil-${index}`, admission_no: `A-${index}`,
  first_name: `Pupil${index}`, middle_name: null, last_name: null, roll_no: String(index + 1) }));
const marks: AssessmentMark[] = pupils.map((pupil, index) => ({ id: `mark-${index}`, assessment_id: "exam-0", student_id: pupil.id,
  marks_obtained: 50, remarks: null, updated_at: "2026-11-06T08:01:00Z" }));

beforeEach(() => {
  vi.clearAllMocks();
  loadAssessments.mockImplementation(async (_client: unknown, _school: string, filters: { academicYear?: string } = {}) =>
    [exam("exam-0", "current-year"), exam("old", "old-year")].filter((row) => !filters.academicYear || row.academic_year_id === filters.academicYear));
  loadAssessmentMarks.mockImplementation(async (_client: unknown, ids: string[]) => marks.filter((mark) => ids.includes(mark.assessment_id)));
  loadAssessmentStudents.mockImplementation(async () => pupils);
});

describe("admin assessment load scope", () => {
  it("loads only the current year's exams in exams mode, without marks, and patches a status toggle in place", async () => {
    const user = userEvent.setup();
    render(<AdminAssessmentWorkspace mode="exams" />);
    await user.click(await screen.findByRole("button", { name: "Complete" }));
    expect(await screen.findByRole("button", { name: "Reopen" })).toBeInTheDocument();
    expect(update).toHaveBeenCalledExactlyOnceWith({ status: "completed" });
    expect(loadAssessments).toHaveBeenCalledExactlyOnceWith(expect.anything(), "school", { academicYear: "current-year" });
    expect(screen.queryByRole("heading", { name: "Exam old" })).not.toBeInTheDocument();
    expect(loadAssessmentMarks).not.toHaveBeenCalled();
    expect(loadAssessmentStudents).not.toHaveBeenCalled();
  });

  it("reads all years only on explicit opt-in", async () => {
    const user = userEvent.setup();
    render(<AdminAssessmentWorkspace mode="exams" />);
    const year = await screen.findByRole("combobox", { name: "Filter by academic year" });
    await waitFor(() => expect(year).toHaveValue("current-year"));
    await user.selectOptions(year, "All");
    expect(await screen.findByRole("heading", { name: "Exam old" })).toBeInTheDocument();
    expect(loadAssessments).toHaveBeenLastCalledWith(expect.anything(), "school", { academicYear: undefined });
  });

  it("scopes result marks to the current year and pages the table at 100 rows", async () => {
    const user = userEvent.setup();
    render(<AdminAssessmentWorkspace mode="results" />);
    const table = await screen.findByRole("table");
    await within(table).findByText("Pupil0");
    expect(loadAssessments).toHaveBeenCalledWith(expect.anything(), "school", { academicYear: "current-year" });
    expect(loadAssessmentMarks).toHaveBeenCalledExactlyOnceWith(expect.anything(), ["exam-0"]);
    expect(within(table).getAllByRole("row")).toHaveLength(101);
    expect(screen.getByText("Marks Recorded").nextSibling).toHaveTextContent("150");
    await user.click(screen.getByRole("button", { name: "Next results page" }));
    expect(within(table).getAllByRole("row")).toHaveLength(51);
    expect(within(table).getByText("Pupil149")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("Search assessments"), "Exam");
    expect(within(table).getAllByRole("row")).toHaveLength(101);
  });
});
