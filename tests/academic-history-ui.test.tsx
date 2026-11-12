import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcademicWorkspace } from "../components/academic/academic-workspace";
import { TeacherAcademicActivityWorkspace } from "../components/academic/teacher-activity-workspace";

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), getUser: vi.fn(), logs: vi.fn(), activities: vi.fn(), assignments: vi.fn(), teacherId: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: mocks.from, rpc: mocks.rpc, auth: { getUser: mocks.getUser } }) }));
vi.mock("@/lib/academic", async (original) => ({ ...await original<typeof import("../lib/academic")>(),
  loadAcademicLogs: mocks.logs, loadAcademicActivities: mocks.activities, getCurrentTeacherAssignments: mocks.assignments, getCurrentTeacherId: mocks.teacherId }));
vi.mock("@/components/layout/app-shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/lib/use-academic-access", () => ({ useAcademicAssignmentRevalidation: () => {} }));
vi.mock("@/components/academic/homework-grading", () => ({ TeacherHomeworkGrading: () => null }));

const assignment = { id: "assignment-a", teacher_id: "teacher-a", academic_year_id: "year-a", class_id: "class-a", section_id: "section-a",
  subject_id: "subject-a", is_class_teacher: true, class_name: "Class 6", section_name: "A", subject_name: "Maths" };
const source = { id: "log-a", school_id: "school-a", academic_year_id: "year-a", class_id: "class-a", section_id: "section-a",
  subject_id: "subject-a", teacher_id: "teacher-a", log_date: "2026-11-05", topic: "Original lesson", summary: "Homework was submitted.",
  teacher_remark: null, status: "published", published_at: null, updated_at: "2026-11-05T12:00:00Z" };
const homework = { id: "homework-a", class_log_id: "log-a", activity_type: "homework", title: "Original task", description: "Homework", due_date: null, max_marks: null };
type Query = { table: string; action: "read" | "delete"; filters: Record<string, unknown> };
let queries: Query[];
let read: (query: Query) => { data: unknown; error: null };

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  window.history.replaceState({}, "", "/");
  queries = [];
  mocks.getUser.mockResolvedValue({ data: { user: { id: "teacher-login", email: "qa@example.test" } }, error: null });
  mocks.teacherId.mockResolvedValue("teacher-a");
  mocks.assignments.mockResolvedValue([assignment]);
  mocks.logs.mockResolvedValue([source]);
  mocks.activities.mockResolvedValue([homework]);
  mocks.rpc.mockImplementation(async (name: string) => ({ data: name === "save_academic_log" ? "log-a" : [{ id: "teacher-a", full_name: "Teacher A" }], error: null }));
  read = ({ table, action, filters }) => {
    if (action === "delete") return { data: { id: filters.id }, error: null };
    const data: Record<string, unknown> = {
      user_roles: [{ role: "teacher", school_id: "school-a" }], teachers: { school_id: "school-a", full_name: "Teacher A" },
      academic_years: [{ id: "year-a", name: "2026-27", is_current: true }, { id: "year-old", name: "2025-26", is_current: false }],
      classes: [{ id: "class-a", name: "Class 6" }], sections: [{ id: "section-a", class_id: "class-a", name: "A" }],
      subjects: [{ id: "subject-a", name: "Maths" }], class_logs: source,
    };
    return { data: data[table] ?? [], error: null };
  };
  mocks.from.mockImplementation((table: string) => {
    const query: Query = { table, action: "read", filters: {} };
    const execute = async () => { queries.push(query); return read(query); };
    const builder = { select() { return builder; }, order() { return builder; }, limit() { return builder; },
      eq(column: string, value: unknown) { query.filters[column] = value; return builder; },
      in(column: string, value: unknown) { query.filters[column] = value; return builder; },
      delete() { query.action = "delete"; return builder; },
      single: execute, maybeSingle: execute,
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) { return execute().then(resolve, reject); } };
    return builder;
  });
});

describe("academic history and draft safety", () => {
  it("defaults to current-year scope and applies older year/date at the data boundary", async () => {
    const user = userEvent.setup();
    render(<AcademicWorkspace module="class-logs" />);
    await screen.findByText("My Academic Logs");
    expect(mocks.logs).toHaveBeenLastCalledWith(expect.objectContaining({ teacherId: "teacher-a", academicYearIds: ["year-a"] }));
    await user.selectOptions(screen.getByRole("combobox", { name: "History year" }), "year-old");
    fireEvent.change(screen.getByLabelText("History date"), { target: { value: "2025-11-01" } });
    await user.click(screen.getByRole("button", { name: "Apply history filters" }));
    await waitFor(() => expect(mocks.logs).toHaveBeenLastCalledWith(expect.objectContaining({ academicYearId: "year-old", logDate: "2025-11-01" })));
  });

  it("keeps a moved pupil's same-year logs from the section they left for the family", async () => {
    const families = { user_roles: [{ role: "parent", school_id: "school-a" }], parents: { id: "parent-a" },
      student_parents: [{ student_id: "student-a" }], students: [{ id: "student-a", first_name: "Asha", middle_name: null, last_name: null }],
      enrollments: [{ student_id: "student-a", class_id: "class-a", section_id: "section-b", academic_year_id: "year-a" }] };
    const base = read;
    read = (query) => query.table in families ? { data: families[query.table as keyof typeof families], error: null } : base(query);
    mocks.logs.mockResolvedValue([source, { ...source, id: "log-other-year", academic_year_id: "year-old", topic: "Other session lesson" }]);
    render(<AcademicWorkspace module="class-logs" />);
    await screen.findByText("Original lesson");
    expect(screen.queryByText("Other session lesson")).not.toBeInTheDocument();
    expect(mocks.logs).toHaveBeenLastCalledWith(expect.objectContaining({ status: "published", classIds: undefined }));
  });

  it("keeps a draft's original version and children through a newer history reload", async () => {
    const user = userEvent.setup();
    render(<AcademicWorkspace module="class-logs" />);
    await user.click(await screen.findByRole("button", { name: "Edit source log" }));
    const topic = screen.getByRole("textbox", { name: "Topic / Chapter *" });
    await user.clear(topic); await user.type(topic, "My pending correction");
    mocks.logs.mockResolvedValue([{ ...source, updated_at: "2026-11-05T13:00:00Z", topic: "New external lesson" }]);
    mocks.activities.mockResolvedValue([homework, { ...homework, id: "homework-b", title: "External task" }]);
    await user.click(screen.getByRole("button", { name: "Apply history filters" }));
    await screen.findByText("New external lesson");
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "PT409", message: "Changed" } });
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await screen.findByText(/Your draft is kept/);
    expect(topic).toHaveValue("My pending correction");
    expect(mocks.rpc).toHaveBeenCalledWith("save_academic_log", expect.objectContaining({
      p_log: expect.objectContaining({ expected_updated_at: source.updated_at }),
      p_activities: [expect.objectContaining({ id: "homework-a" })],
    }));
  });

  it("resets a committed editor rather than rebasing old fields onto a newer post-save snapshot", async () => {
    const user = userEvent.setup();
    render(<AcademicWorkspace module="class-logs" />);
    await user.click(await screen.findByRole("button", { name: "Edit source log" }));
    const topic = screen.getByRole("textbox", { name: "Topic / Chapter *" });
    await user.clear(topic); await user.type(topic, "Committed change");
    mocks.logs.mockResolvedValue([{ ...source, topic: "A later external save", updated_at: "2026-11-05T14:00:00Z" }]);
    let finishSave!: (result: { data: string; error: null }) => void;
    mocks.rpc.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(topic).toBeDisabled();
    await act(async () => { finishSave({ data: "log-a", error: null }); });
    await screen.findByText("A later external save");
    expect(topic).toHaveValue("");
    expect(screen.getByText("Create Daily Academic Log")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument();
  });

  it("keeps homework input and sends no save when full source children cannot be loaded", async () => {
    const user = userEvent.setup();
    render(<TeacherAcademicActivityWorkspace module="homework" />);
    await user.click(await screen.findByRole("button", { name: /Original task/ }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const details = screen.getByRole("textbox", { name: "Homework Details" });
    await user.clear(details); await user.type(details, "My preserved work");
    mocks.activities.mockRejectedValueOnce(new Error("Academic activities: completeness could not be verified."));
    await user.click(screen.getByRole("button", { name: "Update Homework" }));
    await screen.findByText(/completeness could not be verified/);
    expect(details).toHaveValue("My preserved work");
    expect(mocks.rpc).not.toHaveBeenCalledWith("save_academic_log", expect.anything());
  });

  it("deletes only the selected activity and leaves a concurrently added sibling and its generated parent", async () => {
    const user = userEvent.setup();
    render(<TeacherAcademicActivityWorkspace module="homework" />);
    await user.click(await screen.findByRole("button", { name: /Original task/ }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    mocks.activities.mockResolvedValue([{ ...homework, id: "sibling-b", title: "New sibling task" }]);
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await screen.findByRole("button", { name: /New sibling task/ });
    expect(queries.filter((query) => query.action === "delete")).toEqual([{ table: "class_activities", action: "delete", filters: { id: "homework-a", class_log_id: "log-a" } }]);
  });

  it("keeps the homework editor's original version when filtering reloads a newer parent", async () => {
    const user = userEvent.setup();
    render(<TeacherAcademicActivityWorkspace module="homework" />);
    await user.click(await screen.findByRole("button", { name: /Original task/ }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const details = screen.getByRole("textbox", { name: "Homework Details" });
    await user.clear(details); await user.type(details, "Still my draft");
    mocks.logs.mockResolvedValue([{ ...source, updated_at: "2026-11-05T15:00:00Z" }]);
    mocks.activities.mockResolvedValue([{ ...homework, title: "External saved work" }]);
    await user.selectOptions(screen.getByRole("combobox", { name: "History year" }), "all");
    await user.click(screen.getByRole("button", { name: "Apply history filters" }));
    await screen.findByRole("button", { name: /External saved work/ });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "PT409", message: "Changed" } });
    await user.click(screen.getByRole("button", { name: "Update Homework" }));
    await screen.findByText(/Your draft is kept/);
    expect(details).toHaveValue("Still my draft");
    expect(mocks.rpc).toHaveBeenCalledWith("save_academic_log", expect.objectContaining({ p_log: expect.objectContaining({ expected_updated_at: source.updated_at }) }));
  });
  it("names the family history filters and shows log status as a text badge with an en-IN date", async () => {
    const families = { user_roles: [{ role: "parent", school_id: "school-a" }], parents: { id: "parent-a" },
      student_parents: [{ student_id: "student-a" }], students: [{ id: "student-a", first_name: "Asha", middle_name: null, last_name: null }],
      enrollments: [{ student_id: "student-a", class_id: "class-a", section_id: "section-a", academic_year_id: "year-a" }] };
    const base = read;
    read = (query) => query.table in families ? { data: families[query.table as keyof typeof families], error: null } : base(query);
    render(<AcademicWorkspace module="class-logs" />);
    await screen.findByText("Original lesson");
    for (const name of ["Class", "Section", "Subject", "Teacher", "Status"]) expect(screen.getByRole("combobox", { name })).toBeInTheDocument();
    expect(screen.getByText("Published", { selector: "span" })).toHaveClass("badge", "text-success");
    expect(screen.getByText(/5 Nov 2026/)).toBeInTheDocument();
  });

  it("focuses Cancel in the homework delete dialog and closes it with Escape", async () => {
    const user = userEvent.setup();
    render(<TeacherAcademicActivityWorkspace module="homework" />);
    await user.click(await screen.findByRole("button", { name: /Original task/ }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete Homework?" });
    expect(dialog).toHaveAccessibleDescription("This homework will be permanently removed.");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(queries.some((query) => query.action === "delete")).toBe(false);
  });
});
