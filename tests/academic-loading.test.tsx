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
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  unsubscribe: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  teacherId: vi.fn(),
  assignments: vi.fn(),
  logs: vi.fn(),
  activities: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { getUser: mocks.getUser, getSession: mocks.getSession, onAuthStateChange: mocks.onAuthStateChange }, from: mocks.from, rpc: mocks.rpc }),
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

type Result = { data: unknown; error: Error | null; count?: number | null };
type Query = { table: string; action: "read" | "delete" | "insert" | "update"; filters: Record<string, unknown>; payload?: Record<string, unknown>; range?: [number, number] };
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
    updated_at: "parent-loaded",
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
  if (query.table === "enrollments") return { data: [{ id: "enrollment-a", student_id: "student-a", section_id: "section-a" }], error: null };
  if (query.table === "students") return { data: [{ id: "student-a", admission_no: "1001", first_name: "Asha", middle_name: null, last_name: "Student", roll_no: 1 }], error: null };
  if (query.table === "teacher_assessment_marks") return { data: [{ id: "mark-a", assessment_id: Array.isArray(query.filters.assessment_id) ? query.filters.assessment_id[0] : query.filters.assessment_id, student_id: "student-a", marks_obtained: 12, remarks: null, updated_at: "2026-11-01T10:00:00Z" }], error: null };
  return { data: [], error: null };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  queries = [];
  assessments = [assessment("exam-a", "First test"), assessment("exam-b", "Second test")];
  read = defaultRead;
  const profileUser = { id: "auth-teacher", email: "teacher@example.test", is_anonymous: false };
  mocks.getUser.mockResolvedValue({ data: { user: profileUser }, error: null });
  mocks.getSession.mockResolvedValue({ data: { session: { user: profileUser, access_token: "teacher-profile-jwt" } }, error: null });
  mocks.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: mocks.unsubscribe } } });
  mocks.teacherId.mockResolvedValue("teacher-a");
  mocks.assignments.mockResolvedValue(assignments);
  mocks.logs.mockResolvedValue([]);
  mocks.activities.mockResolvedValue([]);
  mocks.rpc.mockResolvedValue({ data: [], error: null });
  mocks.from.mockImplementation((table: string) => {
    const query: Query = { table, action: "read", filters: {} };
    queries.push(query);
    const execute = async () => {
      const result = await read(query);
      return Array.isArray(result.data) && query.action === "read"
        ? { ...result, count: result.count ?? result.data.length, data: query.range ? result.data.slice(query.range[0], query.range[1] + 1) : result.data }
        : result;
    };
    return {
      select() { return this; },
      delete() { query.action = "delete"; return this; },
      insert(payload: Record<string, unknown>) { query.action = "insert"; query.payload = payload; return this; },
      update(payload: Record<string, unknown>) { query.action = "update"; query.payload = payload; return this; },
      is(column: string, value: unknown) { query.filters[column] = value; return this; },
      range(from: number, to: number) { query.range = [from, to]; return this; },
      eq(column: string, value: unknown) { query.filters[column] = value; return this; },
      in(column: string, value: unknown) { query.filters[column] = value; return this; },
      order() { return this; },
      limit() { return this; },
      setHeader() { return this; },
      abortSignal() { return this; },
      single: execute,
      maybeSingle: execute,
      then(resolve: (result: Result) => unknown, reject?: (error: unknown) => unknown) { return execute().then(resolve, reject); },
    };
  });
  window.history.replaceState({}, "", "/");
});

describe("teacher account settings handoff", () => {
  it("keeps teacher profile information and routes password management to the verified shared flow", async () => {
    render(<TeacherModuleView module="profile" />);
    expect(await screen.findByRole("heading", { name: "Priya Sharma" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "My Classes & Responsibilities" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open account settings" })).toHaveAttribute("href", "/account/settings");
    expect(screen.queryByLabelText("Current Password")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change Password" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset Password" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Log Out" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Phone" })).toBeInTheDocument();
  });
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

  it("opens the marks editor with focused context and returns focus to the exam action on close", async () => {
    const user = userEvent.setup();
    render(<TeacherModuleView module="exams" />);
    const exam = await screen.findByRole("button", { name: /First test.*Open/ });
    await user.click(exam);
    expect(exam).toHaveFocus();

    const enterMarks = screen.getByRole("button", { name: "Enter Marks" });
    await user.click(enterMarks);
    const editor = screen.getByRole("dialog", { name: "First test" });
    const heading = within(editor).getByRole("heading", { name: "First test" });
    expect(heading).toHaveFocus();

    fireEvent(editor, new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(enterMarks).toHaveFocus();

    await user.click(enterMarks);
    expect(within(screen.getByRole("dialog")).getByRole("heading", { name: "First test" })).toHaveFocus();
  });

  it("preserves unsaved marks when deleting a different assessment refreshes the record list", async () => {
    const user = userEvent.setup();
    render(<TeacherModuleView module="exams" />);
    await user.click(await screen.findByRole("button", { name: /First test.*Open/ }));
    await user.click(screen.getByRole("button", { name: "Enter Marks" }));
    const studentRow = await screen.findByRole("row", { name: /Asha Student/ });
    fireEvent.change(within(studentRow).getByRole("spinbutton"), { target: { value: "18" } });
    await user.click(screen.getByRole("button", { name: "Close marks editor" }));
    await user.click(screen.getByRole("button", { name: /Second test.*Open/ }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await screen.findByText("Assessment deleted.");
    await waitFor(() => expect(screen.queryByRole("button", { name: /Second test.*Open/ })).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /First test.*Open/ }));
    await user.click(screen.getByRole("button", { name: "Enter Marks" }));
    const retainedRow = screen.getByRole("row", { name: /Asha Student/ });
    expect(within(retainedRow).getByRole("spinbutton")).toHaveValue(18);
    expect(queries.filter((query) => query.table === "teacher_assessment_marks")).toHaveLength(1);
  });
});

describe("mark-save conflict feedback", () => {
  function editableMarks() {
    const marks = ["a", "b"].map((suffix) => ({ id: `mark-${suffix}`, assessment_id: "exam-a", student_id: `student-${suffix}`, marks_obtained: 12, remarks: null as string | null, updated_at: "loaded" }));
    read = (query) => {
      if (query.table === "enrollments") return { data: ["a", "b"].map((suffix) => ({ id: `enrollment-${suffix}`, student_id: `student-${suffix}`, section_id: "section-a" })), error: null };
      if (query.table === "students") return { data: ["a", "b"].map((suffix) => ({ id: `student-${suffix}`, first_name: suffix === "a" ? "Asha" : "Bina", admission_no: `100${suffix === "a" ? 1 : 2}`, middle_name: null, last_name: "Student", roll_no: suffix })), error: null };
      if (query.table !== "teacher_assessment_marks") return defaultRead(query);
      if (query.action === "read") return { data: marks.map((mark) => ({ ...mark })), error: null };
      const mark = marks.find((row) => Object.entries(query.filters).every(([key, value]) => String(row[key as keyof typeof row]) === String(value)));
      if (!mark) return { data: null, error: null };
      Object.assign(mark, query.payload, { updated_at: "saved" });
      return { data: { ...mark }, error: null };
    };
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name !== "save_assessment_mark") return { data: [], error: null };
      const parent = assessments.find((row) => row.id === args.p_assessment_id);
      if (!parent || parent.updated_at !== args.p_expected_assessment_updated_at) return { data: null, error: { code: "40001", message: "Assessment changed" } };
      const query: Query = { table: "teacher_assessment_marks", action: args.p_mark_id ? "update" : "insert", filters: {}, payload: {
        assessment_id: args.p_assessment_id, student_id: args.p_student_id, marks_obtained: args.p_marks, remarks: args.p_remarks,
      } };
      if (args.p_mark_id) query.filters = { id: args.p_mark_id, assessment_id: args.p_assessment_id, student_id: args.p_student_id,
        updated_at: args.p_expected_mark_updated_at, marks_obtained: args.p_expected_marks, remarks: args.p_expected_remarks };
      queries.push(query);
      return read(query);
    });
    return marks;
  }

  // Marks render as a desktop table and a phone list (both in jsdom); scope queries to the table copy.
  const marksTable = async () => within(await screen.findByRole("table"));

  async function openMarks() {
    const user = userEvent.setup();
    render(<TeacherModuleView module="exams" />);
    await user.click(await screen.findByRole("button", { name: /First test.*Open/ }));
    await user.click(screen.getByRole("button", { name: "Enter Marks" }));
    await (await marksTable()).findByRole("spinbutton", { name: "Marks for Asha 1001" });
    return user;
  }

  it("stacks marks entry on phones with the same draft as the md+ table and labels status and date", async () => {
    editableMarks();
    await openMarks();
    const table = screen.getByRole("table");
    expect(table.parentElement).toHaveClass("hidden", "md:block");
    expect(within(table).getAllByRole("columnheader").every((heading) => heading.getAttribute("scope") === "col")).toBe(true);
    const list = screen.getByRole("list", { name: "Student marks" });
    expect(list).toHaveClass("md:hidden");
    const phoneMarks = within(list).getByRole("spinbutton", { name: "Marks for Bina 1002" });
    expect(phoneMarks).toHaveAttribute("inputmode", "decimal");
    expect(phoneMarks.closest("label")).toHaveTextContent("Marks (max 20)");
    expect(within(list).getByRole("textbox", { name: "Remarks for Bina 1002" }).closest("label")).toHaveTextContent("Remarks");
    fireEvent.change(phoneMarks, { target: { value: "17" } });
    expect(within(table).getByRole("spinbutton", { name: "Marks for Bina 1002" })).toHaveValue(17);
    const editor = within(screen.getByRole("dialog", { name: "First test" }));
    expect(editor.getByText("Scheduled", { selector: ".badge" })).toHaveClass("text-warning");
    expect(editor.getByText("2 Nov 2026")).toHaveAttribute("datetime", "2026-11-02");
  });

  it("focuses Cancel in the delete dialog, keeps Delete reachable by Tab, and closes on Escape", async () => {
    editableMarks();
    const user = await openMarks();
    await user.click(screen.getByRole("button", { name: "Close marks editor" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete Exam / Test?" });
    expect(dialog).toHaveAccessibleDescription("“First test” and its marks will be permanently removed.");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.tab();
    expect(within(dialog).getByRole("button", { name: "Delete" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(queries.some((query) => query.action === "delete")).toBe(false);
  });

  it("saves only the changed pupil and reloads another session's accepted mark", async () => {
    const server = editableMarks();
    const user = await openMarks();
    fireEvent.change(within(screen.getByRole("table")).getByRole("spinbutton", { name: "Marks for Bina 1002" }), { target: { value: "16" } });
    Object.assign(server[0], { marks_obtained: 19, updated_at: "other-session" });
    await user.click(screen.getByRole("button", { name: "Save Marks" }));
    const editor = screen.getByRole("dialog", { name: "First test" });
    expect(await within(editor).findByRole("status")).toHaveTextContent("1 changed mark saved.");
    expect(within(editor).getByRole("link", { name: "Result publication" })).toHaveAttribute("href", "/modules/published-results");
    expect(server.map((mark) => mark.marks_obtained)).toEqual([19, 16]);
    expect(queries.filter((query) => query.table === "teacher_assessment_marks" && query.action === "update")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Reload marks" }));
    expect(await (await marksTable()).findByRole("spinbutton", { name: "Marks for Asha 1001" })).toHaveValue(19);
    expect(within(screen.getByRole("table")).getByRole("spinbutton", { name: "Marks for Bina 1002" })).toHaveValue(16);
  });

  it("retains a conflicted draft, reports partial success, and requires explicit discard/reload", async () => {
    const server = editableMarks();
    const user = await openMarks();
    fireEvent.change(within(screen.getByRole("table")).getByRole("spinbutton", { name: "Marks for Asha 1001" }), { target: { value: "18" } });
    fireEvent.change(within(screen.getByRole("table")).getByRole("spinbutton", { name: "Marks for Bina 1002" }), { target: { value: "16" } });
    Object.assign(server[0], { marks_obtained: 19, updated_at: "other-session" });
    await user.click(screen.getByRole("button", { name: "Save Marks" }));
    await screen.findByText("1 changed mark saved.");
    expect(screen.getByRole("alert")).toHaveTextContent("1 mark was not confirmed");
    expect(within(screen.getByRole("table")).getByRole("spinbutton", { name: "Marks for Asha 1001" })).toHaveValue(18);
    expect(screen.getByRole("button", { name: "Save Marks" })).toBeDisabled();
    expect(server.map((mark) => mark.marks_obtained)).toEqual([19, 16]);
    await user.click(screen.getByRole("button", { name: "Discard changes and reload marks" }));
    expect(await (await marksTable()).findByRole("spinbutton", { name: "Marks for Asha 1001" })).toHaveValue(19);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("rejects clearing a saved score without deleting it or discarding the draft", async () => {
    const server = editableMarks();
    const user = await openMarks();
    fireEvent.change(within(screen.getByRole("table")).getByRole("spinbutton", { name: "Marks for Asha 1001" }), { target: { value: "" } });
    await user.click(screen.getByRole("button", { name: "Save Marks" }));
    expect(screen.getByRole("alert")).toHaveTextContent("cannot be cleared here");
    expect(server[0].marks_obtained).toBe(12);
    expect(queries.some((query) => query.table === "teacher_assessment_marks" && query.action !== "read")).toBe(false);
  });

  it("recovers from an unseen parent change by refreshing its version before reloading marks", async () => {
    const server = editableMarks();
    const user = await openMarks();
    fireEvent.change(within(screen.getByRole("table")).getByRole("spinbutton", { name: "Marks for Asha 1001" }), { target: { value: "18" } });
    assessments[0] = { ...assessments[0], maximum_marks: 25, updated_at: "parent-newer" };
    await user.click(screen.getByRole("button", { name: "Save Marks" }));
    await screen.findByRole("alert");
    expect(server[0].marks_obtained).toBe(12);
    expect(within(screen.getByRole("table")).getByRole("spinbutton", { name: "Marks for Asha 1001" })).toHaveValue(18);
    expect(mocks.rpc).toHaveBeenLastCalledWith("save_assessment_mark", expect.objectContaining({ p_expected_assessment_updated_at: "parent-loaded" }));
    await user.click(screen.getByRole("button", { name: "Discard changes and reload marks" }));
    const refreshed = await (await marksTable()).findByRole("spinbutton", { name: "Marks for Asha 1001" });
    expect(refreshed).toHaveValue(12);
    expect(refreshed).toHaveAttribute("max", "25");
    fireEvent.change(refreshed, { target: { value: "19" } });
    await user.click(screen.getByRole("button", { name: "Save Marks" }));
    await screen.findByText("1 changed mark saved.");
    expect(server[0].marks_obtained).toBe(19);
    expect(mocks.rpc).toHaveBeenLastCalledWith("save_assessment_mark", expect.objectContaining({ p_expected_assessment_updated_at: "parent-newer" }));
  });

  it("keeps a copyable draft when an unrelated refresh finds the selected assessment removed", async () => {
    editableMarks();
    const user = await openMarks();
    fireEvent.change(within(screen.getByRole("table")).getByRole("spinbutton", { name: "Marks for Asha 1001" }), { target: { value: "18" } });
    assessments = assessments.filter((row) => row.id !== "exam-a");
    await user.click(screen.getByRole("button", { name: "Close marks editor" }));
    await user.click(screen.getByRole("button", { name: /Second test.*Open/ }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    const retained = await screen.findByRole("alert");
    expect(retained).toHaveTextContent("assessment is no longer available");
    expect(retained).toHaveTextContent("Asha · 1001: 18");
    await user.click(screen.getByRole("button", { name: "Discard unavailable assessment draft" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("retains an ungraded draft but blocks saving after an observed subject relocation", async () => {
    editableMarks().splice(0);
    const user = await openMarks();
    fireEvent.change(within(screen.getByRole("table")).getByRole("spinbutton", { name: "Marks for Asha 1001" }), { target: { value: "18" } });
    assessments[0] = { ...assessments[0], subject_id: "subject-b" };
    await user.click(screen.getByRole("button", { name: "Close marks editor" }));
    await user.click(screen.getByRole("button", { name: /Second test.*Open/ }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await screen.findByText("Assessment deleted.");
    await user.click(screen.getByRole("button", { name: /First test.*Open/ }));
    await user.click(screen.getByRole("button", { name: "Enter Marks" }));
    expect(await (await marksTable()).findByRole("spinbutton", { name: "Marks for Asha 1001" })).toHaveValue(18);
    expect(screen.getByRole("alert")).toHaveTextContent("assessment context changed");
    expect(screen.getByRole("button", { name: "Save Marks" })).toBeDisabled();
    expect(queries.some((query) => query.table === "teacher_assessment_marks" && query.action !== "read")).toBe(false);
  });
});

describe("result report scope", () => {
  it("queries selected class before marks and ignores an older filter response", async () => {
    const user = userEvent.setup();
    const oldClass = deferred<Result>();
    assessments[1] = { ...assessments[1], class_id: "class-b", section_id: "section-b" };
    const storedMarks = ["a", "b"].map((suffix) => ({ id: `mark-${suffix}`, assessment_id: `exam-${suffix}`, student_id: `student-${suffix}`, marks_obtained: 12, remarks: null, updated_at: "loaded" }));
    read = (query) => {
      if (query.table === "teacher_assessments") return { data: assessments.filter((row) => Object.entries(query.filters).every(([key, value]) => row[key as keyof typeof row] === value)), error: null };
      if (query.table === "teacher_assessment_marks") {
        const ids = query.filters.assessment_id as string[];
        if (ids.length === 1 && ids[0] === "exam-a") return oldClass.promise;
        return { data: storedMarks.filter((row) => ids.includes(row.assessment_id)), error: null };
      }
      if (query.table === "students") {
        const ids = query.filters.id as string[];
        return { data: ["a", "b"].filter((suffix) => ids.includes(`student-${suffix}`)).map((suffix) => ({ id: `student-${suffix}`, first_name: suffix === "a" ? "Asha" : "Bina", admission_no: `100${suffix === "a" ? 1 : 2}`, middle_name: null, last_name: "Student", roll_no: suffix })), error: null };
      }
      return defaultRead(query);
    };
    // The report resolves marked pupils through the assessment-scoped RPC; serve it from the same pupil rows.
    mocks.rpc.mockImplementation((name: string, args: { p_assessment_ids: string[] }) => name === "list_assessment_result_students"
      ? mocks.from("students").in("id", args.p_assessment_ids.map((id) => id.replace("exam-", "student-")))
      : Promise.resolve({ data: [], error: null }));
    render(<TeacherModuleView module="results" />);
    await screen.findAllByText("Asha Student");
    await user.selectOptions(screen.getByRole("combobox", { name: "Class" }), "class-a");
    await waitFor(() => expect(queries.some((query) => query.table === "teacher_assessments" && query.filters.class_id === "class-a")).toBe(true));
    await user.selectOptions(screen.getByRole("combobox", { name: "Class" }), "class-b");
    await screen.findAllByText("Bina Student");
    expect(screen.queryAllByText("Asha Student")).toHaveLength(0);
    await act(async () => { oldClass.resolve({ data: [storedMarks[0]], error: null }); });
    expect(screen.queryAllByText("Asha Student")).toHaveLength(0);
    expect(screen.getAllByText("Bina Student").length).toBeGreaterThan(0);
    expect(queries.some((query) => query.table === "teacher_assessment_marks" && JSON.stringify(query.filters.assessment_id) === '["exam-b"]')).toBe(true);
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
