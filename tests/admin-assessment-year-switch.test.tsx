import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminAssessmentWorkspace } from "../components/admin/admin-assessment-workspace";
import type { AssessmentRecord } from "../lib/assessments";

const { loadAssessments, saved } = vi.hoisted(() => ({ loadAssessments: vi.fn(), saved: [] as AssessmentRecord[] }));
vi.mock("@/lib/assessments", async () => ({
  ...await vi.importActual<typeof import("../lib/assessments")>("../lib/assessments"), loadAssessments,
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({
  auth: { getUser: async () => ({ data: { user: { id: "admin" } }, error: null }) },
  from: (table: string) => {
    const rows: Record<string, unknown[]> = {
      user_roles: [{ role: "school_admin", school_id: "school" }], schools: [{ id: "school", name: "School" }],
      academic_years: [{ id: "next-year", name: "2027–28", is_current: false }, { id: "current-year", name: "2026–27", is_current: true }],
      classes: [{ id: "class", name: "Class 6" }], sections: [], subjects: [{ id: "maths", name: "Maths" }],
      teachers: [{ id: "teacher", full_name: "QA Teacher" }],
      teacher_subject_assignments: [{ teacher_id: "teacher", academic_year_id: "next-year", class_id: "class", section_id: null, subject_id: "maths" }],
    };
    let payload: Partial<AssessmentRecord> = {};
    const query = {
      select: () => query, eq: () => query, in: () => query, order: () => query, range: () => query,
      insert: (value: Partial<AssessmentRecord>) => { payload = value; return query; },
      maybeSingle: () => {
        saved.push({ ...payload, id: "new-exam", updated_at: "2026-11-11T10:00:00Z" } as AssessmentRecord);
        return Promise.resolve({ data: { id: "new-exam" }, error: null });
      },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: null, count: (rows[table] ?? []).length }).then(resolve),
    };
    return query;
  },
}) }));

beforeEach(() => {
  vi.clearAllMocks();
  saved.length = 0;
  loadAssessments.mockImplementation(async (_client: unknown, _school: string, filters: { academicYear?: string } = {}) =>
    saved.filter((row) => !filters.academicYear || row.academic_year_id === filters.academicYear));
});

describe("admin assessment year filter after save", () => {
  it("switches the year filter to the year of an exam created outside the shown year", async () => {
    const user = userEvent.setup();
    render(<AdminAssessmentWorkspace mode="exams" />);
    const filter = await screen.findByRole("combobox", { name: "Filter by academic year" });
    await waitFor(() => expect(filter).toHaveValue("current-year"));
    await within(screen.getByRole("combobox", { name: "Academic Year" })).findByRole("option", { name: "2027–28" });
    await user.type(screen.getByRole("textbox", { name: "Exam / Test Name" }), "Next year unit test");
    await user.selectOptions(screen.getByRole("combobox", { name: "Academic Year" }), "next-year");
    await user.selectOptions(screen.getByRole("combobox", { name: "Class" }), "class");
    await user.selectOptions(screen.getByRole("combobox", { name: "Subject" }), "maths");
    await user.selectOptions(screen.getByRole("combobox", { name: "Teacher" }), "teacher");
    await user.click(screen.getByRole("button", { name: "Create assessment" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Assessment created. Showing 2027–28.");
    expect(await screen.findByRole("heading", { name: "Next year unit test" })).toBeInTheDocument();
    expect(filter).toHaveValue("next-year");
    expect(loadAssessments).toHaveBeenLastCalledWith(expect.anything(), "school", { academicYear: "next-year" });
  });
});
