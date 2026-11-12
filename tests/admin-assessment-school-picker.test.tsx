import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminAssessmentWorkspace } from "../components/admin/admin-assessment-workspace";

const clientMock = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: clientMock.create }));

type Read = { table: string; filters: Record<string, unknown> };
const assessment = (school: string) => ({ id: `exam-${school}`, school_id: school, academic_year_id: `year-${school}`, class_id: "class",
  section_id: null, subject_id: "subject", teacher_id: "teacher", name: `Exam of ${school}`, assessment_date: "2026-11-02",
  maximum_marks: 100, description: null, status: "scheduled", updated_at: "2026-11-02T09:00:00Z" });

function database(roles: { role: string; school_id: string | null }[], schools: { id: string; name: string }[]) {
  const calls: Read[] = [];
  const from = vi.fn((table: string) => {
    const request: Read = { table, filters: {} };
    const query = {
      select() { return query; },
      eq(key: string, value: unknown) { request.filters[key] = value; return query; },
      in(key: string, value: unknown) { request.filters[key] = value; return query; },
      order() { return query; },
      range() { return query; },
      then(yes: (value: unknown) => unknown, no?: (reason: unknown) => unknown) {
        calls.push(request);
        const rows = table === "user_roles" ? roles
          : table === "schools" ? schools.filter((row) => !Array.isArray(request.filters.id) || (request.filters.id as string[]).includes(row.id))
            : table === "teacher_assessments" ? [assessment(String(request.filters.school_id))] : [];
        return Promise.resolve({ data: rows, error: null, count: rows.length }).then(yes, no);
      },
    };
    return query;
  });
  clientMock.create.mockReturnValue({ auth: { getUser: async () => ({ data: { user: { id: "admin" } }, error: null }) }, from });
  return calls;
}

beforeEach(() => { vi.clearAllMocks(); });

describe("admin assessment school selection", () => {
  it("asks a two-school admin to choose and then reads only the chosen school", async () => {
    const calls = database([{ role: "school_admin", school_id: "school-b" }, { role: "school_admin", school_id: "school-a" }],
      [{ id: "school-a", name: "School A" }, { id: "school-b", name: "School B" }]);
    const user = userEvent.setup();
    render(<AdminAssessmentWorkspace mode="exams" />);
    const picker = await screen.findByRole("combobox", { name: "School" });
    expect(await screen.findByText("Choose a school to manage assessments.")).toBeInTheDocument();
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(expect.arrayContaining(["School A", "School B"]));
    expect(calls.some((call) => call.table === "teacher_assessments")).toBe(false);
    await user.selectOptions(picker, "school-b");
    expect(await screen.findByRole("heading", { name: "Exam of school-b" })).toBeInTheDocument();
    const scoped = calls.filter((call) => "school_id" in call.filters);
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((call) => call.filters.school_id === "school-b")).toBe(true);
    await user.selectOptions(picker, "school-a");
    expect(await screen.findByRole("heading", { name: "Exam of school-a" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Exam of school-b" })).not.toBeInTheDocument();
  });

  it("auto-selects a single school and disables the picker", async () => {
    database([{ role: "school_admin", school_id: "school-a" }], [{ id: "school-a", name: "School A" }]);
    render(<AdminAssessmentWorkspace mode="results" />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "School" })).toHaveValue("school-a"));
    expect(screen.getByRole("combobox", { name: "School" })).toBeDisabled();
  });
});
