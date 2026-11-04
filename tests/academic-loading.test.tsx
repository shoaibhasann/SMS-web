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
