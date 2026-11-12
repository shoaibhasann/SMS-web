import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminAssessmentWorkspace } from "../components/admin/admin-assessment-workspace";

const { insert, filters } = vi.hoisted(() => ({ insert: vi.fn(), filters: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({
  auth: { getUser: async () => ({ data: { user: { id: "admin" } }, error: null }) },
  from: (table: string) => {
    const rows: Record<string, unknown[]> = {
      user_roles: [{ role: "school_admin", school_id: "school" }], schools: [{ id: "school", name: "School" }],
      academic_years: [{ id: "year", name: "2026–27" }], classes: [{ id: "class", name: "Class 6" }],
      sections: [{ id: "section-a", class_id: "class", name: "A" }], subjects: [{ id: "maths", name: "Maths" }],
      teachers: [{ id: "section-teacher", full_name: "Section teacher" }, { id: "class-teacher", full_name: "Class teacher" }],
      teacher_subject_assignments: [
        { teacher_id: "section-teacher", academic_year_id: "year", class_id: "class", section_id: "section-a", subject_id: "maths" },
        { teacher_id: "class-teacher", academic_year_id: "year", class_id: "class", section_id: null, subject_id: "maths" },
      ],
    };
    const query = {
      select: (columns: string) => { filters(table, "select", columns); return query; },
      eq: (column: string, value: unknown) => { filters(table, "eq", column, value); return query; },
      in: (column: string, values: unknown) => { filters(table, "in", column, values); return query; },
      order: () => query, range: () => query,
      insert: (payload: unknown) => { insert(payload); return query; },
      maybeSingle: () => Promise.resolve({ data: { id: "new" }, error: null }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: null, count: (rows[table] ?? []).length }).then(resolve),
    };
    return query;
  },
}) }));

beforeEach(() => { vi.clearAllMocks(); });

describe("admin assessment teacher scope", () => {
  it("lists only teachers assigned to the chosen scope and blocks an unreachable whole-class exam", async () => {
    const user = userEvent.setup();
    render(<AdminAssessmentWorkspace mode="exams" />);
    const teacher = await screen.findByRole("combobox", { name: "Teacher" });
    await within(screen.getByRole("combobox", { name: "Academic Year" })).findByRole("option", { name: "2026–27" });
    await user.type(screen.getByRole("textbox", { name: "Exam / Test Name" }), "Unit test 1");
    await user.selectOptions(screen.getByRole("combobox", { name: "Academic Year" }), "year");
    await user.selectOptions(teacher, "section-teacher");
    await user.selectOptions(screen.getByRole("combobox", { name: "Class" }), "class");
    await user.selectOptions(screen.getByRole("combobox", { name: "Subject" }), "maths");
    expect(screen.getByRole("combobox", { name: "Section" })).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Create assessment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no teaching assignment for the selected year, class, section and subject");
    expect(insert).not.toHaveBeenCalled();

    await user.selectOptions(teacher, "");
    expect(within(teacher).queryByRole("option", { name: "Section teacher" })).not.toBeInTheDocument();
    expect(within(teacher).getByRole("option", { name: "Class teacher" })).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Section" }), "section-a");
    expect(within(teacher).getByRole("option", { name: "Section teacher" })).toBeInTheDocument();
    await user.selectOptions(teacher, "section-teacher");
    await user.click(screen.getByRole("button", { name: "Create assessment" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Assessment created.");
    expect(insert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ teacher_id: "section-teacher", section_id: "section-a" }));
  });

  it("reads teaching assignments by the school's teacher ids, not an embedded teacher filter", async () => {
    render(<AdminAssessmentWorkspace mode="exams" />);
    await within(await screen.findByRole("combobox", { name: "Teacher" })).findByRole("option", { name: "Class teacher" });
    const assignmentCalls = filters.mock.calls.filter(([table]) => table === "teacher_subject_assignments");
    expect(assignmentCalls).toContainEqual(["teacher_subject_assignments", "in", "teacher_id", ["section-teacher", "class-teacher"]]);
    expect(assignmentCalls).toContainEqual(["teacher_subject_assignments", "select", "teacher_id,academic_year_id,class_id,section_id,subject_id"]);
    expect(assignmentCalls.filter(([, kind]) => kind === "eq")).toEqual([]);
  });
});
