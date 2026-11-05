import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TeachingAssignment } from "../lib/academic";
import { AcademicWorkspace } from "../components/academic/academic-workspace";
import { TeacherAcademicActivityWorkspace } from "../components/academic/teacher-activity-workspace";
import { TeacherModuleView } from "../components/teacher/teacher-views";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  teacherId: vi.fn(),
  assignments: vi.fn(),
  logs: vi.fn(),
  activities: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { getUser: mocks.getUser }, from: mocks.from, rpc: mocks.rpc }),
}));
vi.mock("@/lib/academic", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/academic")>(),
  getCurrentTeacherId: mocks.teacherId,
  getCurrentTeacherAssignments: mocks.assignments,
  loadAcademicLogs: mocks.logs,
  loadAcademicActivities: mocks.activities,
}));
vi.mock("@/components/layout/app-shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

type Result = { data: unknown; error: Error | null };
type Query = { table: string; action: "read" | "delete"; filters: Record<string, unknown> };
let queries: Query[];
let read: (query: Query) => Result | Promise<Result>;
let assessments: ReturnType<typeof assessment>[];

const assignments: TeachingAssignment[] = ["a", "b"].map((suffix) => ({
  id: `assignment-${suffix}`,
  teacher_id: "teacher-a",
  academic_year_id: "year-a",
  class_id: `class-${suffix}`,
  section_id: `section-${suffix}`,
  subject_id: "subject-a",
  is_class_teacher: true,
  class_name: `Class ${suffix.toUpperCase()}`,
  section_name: suffix.toUpperCase(),
  subject_name: "English",
}));

function assessment(id: string, name: string) {
  return {
    id, name,
    school_id: "school-a",
    teacher_id: "teacher-a",
    academic_year_id: "year-a",
    class_id: "class-a",
    section_id: "section-a",
    subject_id: "subject-a",
    assessment_date: "2026-11-02",
    maximum_marks: 20,
    description: null,
    status: "scheduled",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function defaultRead(query: Query): Result {
  if (query.table === "teachers") return { data: { school_id: "school-a", full_name: "Priya Sharma" }, error: null };
  if (query.table === "user_roles") return { data: [{ role: "teacher", school_id: "school-a" }], error: null };
  if (query.table === "academic_years") return { data: [{ id: "year-a", name: "2026-27", is_current: true }], error: null };
  if (query.table === "classes") return { data: assignments.map((item) => ({ id: item.class_id, name: item.class_name })), error: null };
  if (query.table === "subjects") return { data: [{ id: "subject-a", name: "English" }], error: null };
  if (query.table === "sections") return { data: [{ id: "section-a", name: "A", class_id: "class-a" }], error: null };
  if (query.table === "teacher_assessments") {
    if (query.action === "delete") {
      assessments = assessments.filter((item) => item.id !== query.filters.id);
      return { data: { id: query.filters.id }, error: null };
    }
    return { data: [...assessments], error: null };
  }
  if (query.table === "enrollments") return { data: [{ student_id: "student-a", section_id: "section-a" }], error: null };
  if (query.table === "students") return { data: [{ id: "student-a", admission_no: "1001", first_name: "Asha", middle_name: null, last_name: "Student", roll_no: 1 }], error: null };
  if (query.table === "teacher_assessment_marks") return { data: [{ id: "mark-a", assessment_id: query.filters.assessment_id, student_id: "student-a", marks_obtained: 12, remarks: null }], error: null };
  return { data: [], error: null };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  queries = [];
  assessments = [assessment("exam-a", "First test"), assessment("exam-b", "Second test")];
  read = defaultRead;
  mocks.getUser.mockResolvedValue({ data: { user: { id: "auth-teacher", email: "teacher@example.test" } }, error: null });
  mocks.teacherId.mockResolvedValue("teacher-a");
  mocks.assignments.mockResolvedValue(assignments);
  mocks.logs.mockResolvedValue([]);
  mocks.activities.mockResolvedValue([]);
  mocks.rpc.mockResolvedValue({ data: [], error: null });
  mocks.from.mockImplementation((table: string) => {
    const query: Query = { table, action: "read", filters: {} };
    queries.push(query);
    const execute = async () => read(query);
    return {
      select() { return this; },
      delete() { query.action = "delete"; return this; },
      eq(column: string, value: unknown) { query.filters[column] = value; return this; },
      in(column: string, value: unknown) { query.filters[column] = value; return this; },
      order() { return this; },
      limit() { return this; },
      single: execute,
      maybeSingle: execute,
      then(resolve: (result: Result) => unknown, reject?: (error: unknown) => unknown) { return execute().then(resolve, reject); },
    };
  });
  window.history.replaceState({}, "", "/");
});

describe("academic scope loading", () => {
  it("shows teacher names to a student using the safe label RPC", async () => {
    read = (query) => {
      if (query.table === "user_roles") return { data: [{ role: "student", school_id: "school-a" }], error: null };
      if (query.table === "students") return { data: { id: "student-a", first_name: "Asha" }, error: null };
      if (query.table === "enrollments") {
        return { data: [{ class_id: "class-a", section_id: "section-a", academic_year_id: "year-a" }], error: null };
      }
      return defaultRead(query);
    };
    mocks.logs.mockResolvedValue([{
      id: "log-a", school_id: "school-a", academic_year_id: "year-a", log_date: "2026-11-02",
      class_id: "class-a", section_id: "section-a", subject_id: "subject-a", teacher_id: "teacher-a",
      topic: "Published lesson", summary: "", teacher_remark: null, status: "published", published_at: null,
    }]);
    mocks.rpc.mockResolvedValue({ data: [{ id: "teacher-a", full_name: "Priya Sharma" }], error: null });

    render(<AcademicWorkspace module="class-logs" />);
    expect(await screen.findByRole("option", { name: "Priya Sharma" })).toBeInTheDocument();
    expect(mocks.rpc).toHaveBeenCalledWith("academic_teacher_labels", { p_teacher_ids: ["teacher-a"] });
    expect(mocks.from).not.toHaveBeenCalledWith("teachers");
  });

  it("changes the selected teaching assignment without rebooting the workspace or clearing a new draft", async () => {
    const user = userEvent.setup();
    render(<AcademicWorkspace module="class-logs" />);
    const topic = await screen.findByRole("textbox", { name: "Topic / Chapter *" });
    await user.type(topic, "Unsaved topic");
    await user.selectOptions(screen.getByRole("combobox", { name: "Class / Section / Subject" }), "assignment-b");
    expect(topic).toHaveValue("Unsaved topic");
    expect(screen.getByRole("combobox", { name: "Class / Section / Subject" })).toHaveValue("assignment-b");
    expect(mocks.assignments).toHaveBeenCalledTimes(1);
    expect(mocks.logs).toHaveBeenCalledTimes(1);
  });

  it("ignores a late previous-class section response and keeps the current class draft", async () => {
    const user = userEvent.setup();
    const oldSections = deferred<Result>();
    read = (query) => query.table === "sections" && query.filters.class_id === "class-a"
      ? oldSections.promise
      : query.table === "sections" && query.filters.class_id === "class-b"
        ? { data: [{ id: "section-b", name: "B", class_id: "class-b" }], error: null }
        : defaultRead(query);
    render(<TeacherAcademicActivityWorkspace module="homework" />);
    const classSelect = screen.getAllByRole("combobox", { name: "Class" })[0];
    await waitFor(() => expect(classSelect).toBeEnabled());
    await user.selectOptions(classSelect, "class-a");
    await waitFor(() => expect(queries.some((query) => query.table === "sections" && query.filters.class_id === "class-a")).toBe(true));
    await user.selectOptions(classSelect, "class-b");
    const sectionSelect = screen.getAllByRole("combobox", { name: "Section" })[0];
    await waitFor(() => expect(within(sectionSelect).getByRole("option", { name: "B" })).toBeInTheDocument());
    await user.selectOptions(sectionSelect, "section-b");
    await act(async () => { oldSections.resolve({ data: [{ id: "section-a", name: "A", class_id: "class-a" }], error: null }); });
    expect(classSelect).toHaveValue("class-b");
    expect(sectionSelect).toHaveValue("section-b");
    expect(within(sectionSelect).queryByRole("option", { name: "A" })).not.toBeInTheDocument();
  });

  it("preserves unsaved marks when deleting a different assessment refreshes the record list", async () => {
    const user = userEvent.setup();
    render(<TeacherModuleView module="exams" />);
    await user.click(await screen.findByRole("button", { name: /First test.*Open/ }));
    await user.click(screen.getByRole("button", { name: "Enter Marks" }));
    const studentRow = await screen.findByRole("row", { name: /Asha Student/ });
    fireEvent.change(within(studentRow).getByRole("spinbutton"), { target: { value: "18" } });
    await user.click(screen.getByRole("button", { name: /Second test.*Open/ }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await screen.findByText("Assessment deleted.");
    await waitFor(() => expect(screen.queryByRole("button", { name: /Second test.*Open/ })).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /First test.*Open/ }));
    const retainedRow = screen.getByRole("row", { name: /Asha Student/ });
    expect(within(retainedRow).getByRole("spinbutton")).toHaveValue(18);
    expect(queries.filter((query) => query.table === "teacher_assessment_marks")).toHaveLength(1);
  });
});

const authorLog = () => ({
  id: "log-a", school_id: "school-a", academic_year_id: "year-a", log_date: "2026-11-05",
  class_id: "class-a", section_id: "section-a", subject_id: "subject-a", teacher_id: "teacher-a",
  topic: "Assigned lesson", summary: "Practice fractions", teacher_remark: null, status: "published" as const, published_at: null,
});

describe("academic authoring permissions UI", () => {
  it("offers only assigned class, section and subject combinations in Homework", async () => {
    const user = userEvent.setup();
    read = (query) => {
      if (query.table === "classes") return { data: [...assignments.map((item) => ({ id: item.class_id, name: item.class_name })), { id: "class-private", name: "Unassigned class" }], error: null };
      if (query.table === "subjects") return { data: [{ id: "subject-a", name: "English" }, { id: "subject-private", name: "Unassigned subject" }], error: null };
      if (query.table === "sections") return { data: [{ id: "section-a", name: "A" }, { id: "section-private", name: "Unassigned section" }], error: null };
      return defaultRead(query);
    };
    render(<TeacherAcademicActivityWorkspace module="homework" />);
    const classSelect = screen.getAllByRole("combobox", { name: "Class" })[0];
    await waitFor(() => expect(classSelect).toBeEnabled());
    expect(within(classSelect).queryByRole("option", { name: "Unassigned class" })).not.toBeInTheDocument();
    await user.selectOptions(classSelect, "class-a");
    const sectionSelect = screen.getAllByRole("combobox", { name: "Section" })[0];
    await waitFor(() => expect(within(sectionSelect).getByRole("option", { name: "A" })).toBeInTheDocument());
    expect(within(sectionSelect).queryByRole("option", { name: "Unassigned section" })).not.toBeInTheDocument();
    await user.selectOptions(sectionSelect, "section-a");
    const subjectSelect = screen.getAllByRole("combobox", { name: "Subject" })[0];
    expect(within(subjectSelect).getByRole("option", { name: "English" })).toBeInTheDocument();
    expect(within(subjectSelect).queryByRole("option", { name: "Unassigned subject" })).not.toBeInTheDocument();
  });

  it("hides edit and delete controls for an own log outside the exact writable subject", async () => {
    mocks.logs.mockResolvedValue([{ ...authorLog(), subject_id: "subject-private" }]);
    render(<AcademicWorkspace module="class-logs" />);
    await screen.findByText("Assigned lesson");
    expect(screen.queryByRole("button", { name: "Edit source log" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("keeps unchanged drafts on access checks, then clears controls and cached records after assignment revocation", async () => {
    const user = userEvent.setup();
    mocks.logs.mockResolvedValue([authorLog()]);
    render(<AcademicWorkspace module="class-logs" />);
    const topic = await screen.findByRole("textbox", { name: "Topic / Chapter *" });
    await user.type(topic, "Unsaved permitted draft");
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(topic).toHaveValue("Unsaved permitted draft");
    mocks.assignments.mockResolvedValue([]);
    mocks.logs.mockResolvedValue([]);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(topic).toHaveValue(""));
    expect(screen.getByRole("button", { name: "Save Draft" })).toBeDisabled();
    expect(screen.queryByText("Assigned lesson")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit source log" })).not.toBeInTheDocument();
  });

  it("does not show deleted success when a log DELETE returns no authorized row", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.logs.mockResolvedValue([authorLog()]);
    read = (query) => query.table === "class_logs" && query.action === "delete" ? { data: null, error: null } : defaultRead(query);
    render(<AcademicWorkspace module="class-logs" />);
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await screen.findByText("This log was not deleted. Refresh to check your current teaching access.");
    expect(screen.queryByText("Academic log deleted.")).not.toBeInTheDocument();
    expect(screen.getByText("Assigned lesson")).toBeInTheDocument();
    confirm.mockRestore(); consoleError.mockRestore();
  });

  it("locks a log's placement and preserves ambiguous multiple homework entries", async () => {
    const user = userEvent.setup();
    mocks.logs.mockResolvedValue([authorLog()]);
    mocks.activities.mockResolvedValue(["one", "two"].map((id) => ({ id, class_log_id: "log-a", activity_type: "homework", title: id, description: null, due_date: null })));
    render(<AcademicWorkspace module="class-logs" />);
    await user.click(await screen.findByRole("button", { name: "Edit source log" }));
    expect(screen.getByLabelText("Date")).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Class / Section / Subject" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: /Homework/ })).toBeDisabled();
    expect(screen.getByText(/Multiple homework entries are preserved/)).toBeInTheDocument();
  });
});

it("keeps the edited log draft when another session changed its activity snapshot", async () => {
  const user = userEvent.setup();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.logs.mockResolvedValue([{ ...authorLog(), updated_at: "2026-11-05T12:00:00Z" }]);
  mocks.rpc.mockImplementation((name) => Promise.resolve(name === "save_academic_log"
    ? { data: null, error: { code: "PT409", message: "Concurrent change" } }
    : { data: [], error: null }));
  render(<AcademicWorkspace module="class-logs" />);
  await user.click(await screen.findByRole("button", { name: "Edit source log" }));
  const topic = screen.getByRole("textbox", { name: "Topic / Chapter *" });
  await user.clear(topic); await user.type(topic, "My unsaved correction");
  await user.click(screen.getByRole("button", { name: "Save Changes" }));
  await screen.findByText("This log changed in another session. Your draft is kept; refresh teaching access before editing the latest version.");
  expect(topic).toHaveValue("My unsaved correction");
  expect(screen.queryByText("Published academic log updated.")).not.toBeInTheDocument();
  consoleError.mockRestore();
});

it("creates Homework and its parent log through one atomic save rather than separate table writes", async () => {
  const user = userEvent.setup();
  read = (query) => query.table === "class_logs" ? { data: null, error: null } : defaultRead(query);
  mocks.rpc.mockResolvedValue({ data: "new-log", error: null });
  render(<TeacherAcademicActivityWorkspace module="homework" />);
  const classSelect = screen.getAllByRole("combobox", { name: "Class" })[0];
  await waitFor(() => expect(classSelect).toBeEnabled());
  await user.selectOptions(classSelect, "class-a");
  const sectionSelect = screen.getAllByRole("combobox", { name: "Section" })[0];
  await waitFor(() => expect(within(sectionSelect).getByRole("option", { name: "A" })).toBeInTheDocument());
  await user.selectOptions(sectionSelect, "section-a");
  await user.selectOptions(screen.getAllByRole("combobox", { name: "Subject" })[0], "subject-a");
  await user.type(screen.getByRole("textbox", { name: "Homework Details" }), "Practice questions one to five");
  await user.click(screen.getByRole("button", { name: "Submit Homework" }));
  await screen.findByText("Homework submitted successfully.");
  expect(mocks.rpc).toHaveBeenCalledWith("save_academic_log", {
    p_log: expect.objectContaining({ school_id: "school-a", academic_year_id: "year-a", class_id: "class-a", section_id: "section-a", subject_id: "subject-a", status: "published" }),
    p_activities: [expect.objectContaining({ activity_type: "homework", title: "Practice questions one to five" })],
  });
  expect(queries.filter((query) => query.action === "delete")).toEqual([]);
});

it("uses the Homework editor's original snapshot when another device changed the parent log", async () => {
  const user = userEvent.setup();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const source = { ...authorLog(), updated_at: "2026-11-05T12:00:00Z" };
  const homework = { id: "homework-a", class_log_id: "log-a", activity_type: "homework", title: "Original homework", description: "Homework",
    due_date: "2026-11-07", attachment_url: "https://example.test/tasks.pdf", max_marks: 20 };
  mocks.logs.mockResolvedValue([source]);
  mocks.activities.mockResolvedValue([homework]);
  read = (query) => query.table === "class_logs" ? { data: { ...source, updated_at: "2026-11-05T12:01:00Z" }, error: null } : defaultRead(query);
  mocks.rpc.mockResolvedValue({ data: null, error: { code: "40001", message: "Concurrent change" } });
  render(<TeacherAcademicActivityWorkspace module="homework" />);
  await user.click(await screen.findByRole("button", { name: /Original homework.*Open/ }));
  await user.click(screen.getByRole("button", { name: "Edit" }));
  const details = screen.getByRole("textbox", { name: "Homework Details" });
  await user.clear(details); await user.type(details, "My unsaved homework change");
  const update = screen.getByRole("button", { name: "Update Homework" });
  await waitFor(() => expect(update).toBeEnabled());
  await user.click(update);
  await screen.findByText("This log changed in another session. Your draft is kept; refresh teaching access before editing the latest version.");
  expect(details).toHaveValue("My unsaved homework change");
  expect(mocks.rpc).toHaveBeenCalledWith("save_academic_log", {
    p_log: expect.objectContaining({ id: "log-a", expected_updated_at: source.updated_at }),
    p_activities: [expect.objectContaining({ id: "homework-a", title: "My unsaved homework change", attachment_url: homework.attachment_url, max_marks: 20 })],
  });
  expect(screen.queryByText("Homework updated successfully.")).not.toBeInTheDocument();
  consoleError.mockRestore();
});
