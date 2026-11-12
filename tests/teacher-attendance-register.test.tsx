import { useEffect, useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttendanceContext } from "../lib/attendance/types";
import { TeacherAttendanceRegister } from "../components/academic/teacher-attendance-register";

type EditorProps = {
  context: AttendanceContext;
  userId: string;
  rosterVersion: number;
  onLockChange: (locked: boolean) => void;
  reviewOnlyHistory?: boolean;
  dateLimits?: { start: string; end: string };
};

const { client, getUser, from, rpc, editorBoundary, effectiveAssignments, editorMode } = vi.hoisted(() => {
  const getUser = vi.fn();
  const from = vi.fn();
  const rpc = vi.fn();
  return {
    getUser,
    from,
    rpc,
    // `silent` models an editor that has not reported its lock state yet.
    editorMode: { silent: false },
    editorBoundary: vi.fn(),
    effectiveAssignments: vi.fn(),
    client: { auth: { getUser }, from, rpc },
  };
});

vi.mock("@/lib/supabase/client", () => ({ createClient: () => client }));
vi.mock("@/lib/assignments/attendance-coverage", () => ({ loadEffectiveAttendanceAssignments: effectiveAssignments }));

// Exercise the real parent, with controllable child loading/dirty state.
vi.mock("@/components/academic/attendance-editor", () => ({
  AttendanceEditor: function AttendanceEditorBoundary(props: EditorProps) {
    editorBoundary(props);
    const { onLockChange } = props;
    const [locked, setLocked] = useState(true);
    const [date, setDate] = useState("2026-11-02");
    useEffect(() => {
      if (editorMode.silent) return;
      onLockChange(locked);
      return () => onLockChange(false);
    }, [locked, onLockChange]);
    return (
      <section aria-label="Attendance editor boundary">
        <button type="button" onClick={() => setLocked(false)}>Load saved register</button>
        <button type="button" onClick={() => setLocked(true)}>Edit attendance</button>
        <button type="button" onClick={() => setLocked(false)}>Discard attendance edits</button>
        <label>Selected register date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <output aria-label="Roster revision">{props.rosterVersion}</output>
      </section>
    );
  },
}));

type QueryResult = { data: unknown; error: Error | null };
type ReadQuery = { table: string; columns: string; filters: [string, unknown][]; limit?: number };
let results: Record<string, QueryResult>;
let queries: ReadQuery[];

const expectedContext: AttendanceContext = {
  schoolId: "school-a",
  academicYearId: "current-year",
  classId: "class-a",
  sectionId: "section-a",
};

const permanentAssignment = { id: "assignment-a", teacher_id: "teacher-a", academic_year_id: "current-year",
  class_id: "class-a", section_id: "section-a", subject_id: "subject-a", is_class_teacher: true,
  class_name: "Class 6", section_name: "A", subject_name: "Maths", coverage_id: null, starts_on: null, ends_on: null };
const coverageAssignment = { ...permanentAssignment, id: "covered-assignment", class_id: "class-covered", section_id: "section-covered",
  class_name: "Class 7", section_name: "B", coverage_id: "coverage", starts_on: "2026-11-05", ends_on: "2026-11-07" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  editorMode.silent = false;
  queries = [];
  results = {
    teachers: { data: { id: "teacher-a", school_id: "school-a", full_name: "Priya Sharma" }, error: null },
    academic_years: { data: { id: "current-year" }, error: null },
    teacher_subject_assignments: { data: { class_id: "class-a", section_id: "section-a" }, error: null },
    classes: { data: { name: "Class 6" }, error: null },
    sections: { data: { name: "A" }, error: null },
  };
  effectiveAssignments.mockResolvedValue([permanentAssignment]);
  getUser.mockResolvedValue({ data: { user: { id: "auth-teacher", email: "teacher@example.test" } }, error: null });
  rpc.mockResolvedValue({ error: null });
  from.mockImplementation((table: string) => {
    const query: ReadQuery = { table, columns: "", filters: [] };
    queries.push(query);
    return {
      select(columns: string) { query.columns = columns; return this; },
      eq(column: string, value: unknown) { query.filters.push([column, value]); return this; },
      limit(value: number) { query.limit = value; return this; },
      async maybeSingle() { return results[table]; },
      async single() { return results[table]; },
    };
  });
});
afterEach(() => vi.useRealTimers());

async function openRegistration(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("region", { name: "Attendance editor boundary" });
  await user.click(screen.getByRole("button", { name: "Load saved register" }));
  await user.click(screen.getByRole("button", { name: "Register Student" }));
  return screen.getByRole("textbox", { name: "Student name" });
}

describe("TeacherAttendanceRegister wiring", () => {
  it("passes only the authenticated teacher's current class-teacher school/year/section into the editor", async () => {
    render(<TeacherAttendanceRegister />);
    await screen.findByRole("region", { name: "Attendance editor boundary" });
    expect(editorBoundary).toHaveBeenLastCalledWith(expect.objectContaining({
      context: expectedContext,
      userId: "auth-teacher",
      rosterVersion: 0,
      onLockChange: expect.any(Function),
    }));
    expect(screen.getByText("Priya Sharma · Class 6 / A")).toBeInTheDocument();
    expect(queries.find((query) => query.table === "teachers")?.filters).toEqual([["profile_id", "auth-teacher"]]);
    expect(queries.find((query) => query.table === "academic_years")?.filters).toEqual([["school_id", "school-a"], ["is_current", true]]);
    expect(effectiveAssignments).toHaveBeenCalledWith(client);
    expect(from).not.toHaveBeenCalledWith("teacher_subject_assignments");
    expect(screen.getByRole("button", { name: "Register Student" })).toBeDisabled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["teachers", "A teacher profile is not linked to this account."],
    ["academic_years", "No current academic year is configured."],
  ])("fails closed when %s is missing", async (table, message) => {
    results[table] = { data: null, error: null };
    render(<TeacherAttendanceRegister />);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(editorBoundary).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Register Student" })).not.toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed when no effective class-teacher attendance access remains", async () => {
    effectiveAssignments.mockResolvedValue([]);
    render(<TeacherAttendanceRegister />);
    expect(await screen.findByRole("alert")).toHaveTextContent("An assigned class teacher section is required.");
    expect(editorBoundary).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not mount a usable editor when current attendance access cannot be verified", async () => {
    effectiveAssignments.mockRejectedValue(new Error("Attendance access could not be verified."));
    render(<TeacherAttendanceRegister />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Attendance access could not be verified.");
    expect(editorBoundary).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("gives active substitutes a bounded attendance editor without registration or historical correction actions", async () => {
    effectiveAssignments.mockResolvedValue([coverageAssignment]);
    render(<TeacherAttendanceRegister />);
    await screen.findByRole("region", { name: "Attendance editor boundary" });
    expect(screen.getByText(/Temporary attendance coverage/)).toHaveTextContent("5 Nov 2026 through 7 Nov 2026 IST");
    expect(editorBoundary).toHaveBeenLastCalledWith(expect.objectContaining({
      context: { ...expectedContext, classId: "class-covered", sectionId: "section-covered" },
      reviewOnlyHistory: true, dateLimits: { start: "2026-11-05", end: "2026-11-07" },
    }));
    expect(screen.queryByRole("button", { name: "Register Student" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show my correction requests" })).not.toBeInTheDocument();
  });

  it("selects the intended register without allowing admission into a temporary class", async () => {
    const user = userEvent.setup();
    effectiveAssignments.mockResolvedValue([permanentAssignment, coverageAssignment]);
    render(<TeacherAttendanceRegister />);
    await user.click(await screen.findByRole("button", { name: "Load saved register" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Attendance class" }), "covered-assignment");
    await screen.findByText("Priya Sharma · Class 7 / B");
    expect(editorBoundary).toHaveBeenLastCalledWith(expect.objectContaining({ context: { ...expectedContext, classId: "class-covered", sectionId: "section-covered" } }));
    expect(screen.queryByRole("button", { name: "Register Student" })).not.toBeInTheDocument();
  });

  it("clears a revoked or expired register after access refresh and permits recovery after reassignment", async () => {
    const user = userEvent.setup();
    effectiveAssignments.mockResolvedValueOnce([coverageAssignment]).mockResolvedValueOnce([]).mockResolvedValueOnce([coverageAssignment]);
    render(<TeacherAttendanceRegister />);
    await user.click(await screen.findByRole("button", { name: "Load saved register" }));
    await user.click(screen.getByRole("button", { name: "Refresh attendance access" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("An assigned class teacher section is required.");
    expect(screen.queryByRole("region", { name: "Attendance editor boundary" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh attendance access" }));
    await screen.findByRole("region", { name: "Attendance editor boundary" });
  });

  it("preserves unsaved editor state when focus revalidation returns the same attendance scope", async () => {
    effectiveAssignments.mockResolvedValue([coverageAssignment]);
    render(<TeacherAttendanceRegister />);
    await screen.findByRole("region", { name: "Attendance editor boundary" });
    fireEvent.change(screen.getByLabelText("Selected register date"), { target: { value: "2026-11-06" } });
    fireEvent.focus(window);
    await waitFor(() => expect(effectiveAssignments).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Selected register date")).toHaveValue("2026-11-06");
    expect(screen.getByRole("combobox", { name: "Attendance class" })).toBeDisabled();
  });

  it("clears revoked access on the next periodic check even when attendance edits were open", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    effectiveAssignments.mockResolvedValueOnce([coverageAssignment]).mockResolvedValue([]);
    render(<TeacherAttendanceRegister />);
    await screen.findByRole("region", { name: "Attendance editor boundary" });
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(await screen.findByRole("alert")).toHaveTextContent("An assigned class teacher section is required.");
    expect(screen.queryByRole("region", { name: "Attendance editor boundary" })).not.toBeInTheDocument();
  });

  it("keeps an unsaved draft and retries when one periodic access check fails", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    effectiveAssignments.mockResolvedValueOnce([permanentAssignment])
      .mockRejectedValueOnce(new Error("Attendance access could not be verified."))
      .mockResolvedValue([permanentAssignment]);
    render(<TeacherAttendanceRegister />);
    await screen.findByRole("region", { name: "Attendance editor boundary" });
    fireEvent.change(screen.getByLabelText("Selected register date"), { target: { value: "2026-11-06" } });
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(await screen.findByText(/unsaved marks are kept/)).toHaveAttribute("role", "status");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Selected register date")).toHaveValue("2026-11-06");
    await act(async () => { vi.advanceTimersByTime(30_000); });
    await waitFor(() => expect(screen.queryByText(/unsaved marks are kept/)).not.toBeInTheDocument());
    expect(screen.getByLabelText("Selected register date")).toHaveValue("2026-11-06");
  });

  it("still fails closed when a background check fails with no unsaved attendance", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    effectiveAssignments.mockResolvedValueOnce([permanentAssignment]).mockRejectedValue(new Error("offline"));
    render(<TeacherAttendanceRegister />);
    fireEvent.click(await screen.findByRole("button", { name: "Load saved register" }));
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be verified");
    expect(screen.queryByRole("region", { name: "Attendance editor boundary" })).not.toBeInTheDocument();
  });

  it("fails closed when a periodic check fails before a clean editor reports its lock state", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    editorMode.silent = true;
    effectiveAssignments.mockResolvedValueOnce([permanentAssignment]).mockRejectedValue(new Error("offline"));
    render(<TeacherAttendanceRegister />);
    await screen.findByRole("region", { name: "Attendance editor boundary" });
    expect(screen.getByRole("combobox", { name: "Attendance class" })).toBeDisabled();
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be verified");
    expect(screen.queryByText(/unsaved marks are kept/)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Attendance editor boundary" })).not.toBeInTheDocument();
  });

  it("keeps the register when a periodic check fails while the editor is still loading", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    effectiveAssignments.mockResolvedValueOnce([permanentAssignment]).mockRejectedValue(new Error("offline"));
    render(<TeacherAttendanceRegister />);
    await screen.findByRole("region", { name: "Attendance editor boundary" });
    await act(async () => {}); // let the loading editor report its lock
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(await screen.findByText(/unsaved marks are kept/)).toHaveAttribute("role", "status");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Attendance editor boundary" })).toBeInTheDocument();
  });

  it("keeps the draft when an unrelated coverage is added while the selected register is unchanged", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    effectiveAssignments.mockResolvedValueOnce([permanentAssignment]).mockResolvedValue([permanentAssignment, coverageAssignment]);
    render(<TeacherAttendanceRegister />);
    await screen.findByRole("region", { name: "Attendance editor boundary" });
    fireEvent.change(screen.getByLabelText("Selected register date"), { target: { value: "2026-11-06" } });
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(await screen.findByRole("option", { name: "Class 7 / B · Temporary coverage" })).toBeInTheDocument();
    expect(screen.getByLabelText("Selected register date")).toHaveValue("2026-11-06");
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("blocks registration input, cancel and submit while the editor has unsaved attendance", async () => {
    const user = userEvent.setup();
    render(<TeacherAttendanceRegister />);
    const name = await openRegistration(user);
    await user.type(name, "Reyansh Verma");
    await user.click(screen.getByRole("button", { name: "Edit attendance" }));
    expect(name).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel registration" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Register Student" })).toBeDisabled();
    fireEvent.submit(name.closest("form")!);
    expect(rpc).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Discard attendance edits" }));
    expect(name).toBeEnabled();
    expect(name).toHaveValue("Reyansh Verma");
    expect(screen.getByRole("button", { name: "Register Student" })).toBeEnabled();
  });

  it("submits one registration under duplicate events, freezes the editor, and refreshes the existing dated roster", async () => {
    const user = userEvent.setup();
    const pending = deferred<{ error: null }>();
    rpc.mockReturnValueOnce(pending.promise);
    render(<TeacherAttendanceRegister />);
    const name = await openRegistration(user);
    fireEvent.change(screen.getByLabelText("Selected register date"), { target: { value: "2026-10-01" } });
    await user.type(name, "  Reyansh Verma  ");
    const form = name.closest("form")!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("register_student_for_class_teacher", { p_full_name: "Reyansh Verma" });
    expect(name).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel registration" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Registering…" })).toBeDisabled();
    expect(screen.getByLabelText("Selected register date")).toBeDisabled();

    await act(async () => { pending.resolve({ error: null }); });
    await screen.findByText("Reyansh Verma registered. Reloading the class register.");
    await waitFor(() => expect(screen.getByLabelText("Roster revision")).toHaveTextContent("1"));
    expect(screen.getByLabelText("Selected register date")).toHaveValue("2026-10-01");
    expect(screen.queryByRole("textbox", { name: "Student name" })).not.toBeInTheDocument();
    expect(editorBoundary).toHaveBeenLastCalledWith(expect.objectContaining({ context: expectedContext, userId: "auth-teacher", rosterVersion: 1 }));
  });

  it("retains registration input and selected register date on RPC failure without refreshing the roster", async () => {
    const user = userEvent.setup();
    rpc.mockResolvedValueOnce({ error: new Error("Registration rejected. Check admission details.") });
    render(<TeacherAttendanceRegister />);
    const name = await openRegistration(user);
    fireEvent.change(screen.getByLabelText("Selected register date"), { target: { value: "2026-10-01" } });
    await user.type(name, "Reyansh Verma");
    await user.click(screen.getByRole("button", { name: "Register Student" }));
    await screen.findByText("Registration rejected. Check admission details.");
    expect(screen.getByRole("textbox", { name: "Student name" })).toHaveValue("Reyansh Verma");
    expect(screen.getByLabelText("Selected register date")).toHaveValue("2026-10-01");
    expect(screen.getByLabelText("Roster revision")).toHaveTextContent("0");
    expect(screen.getByRole("button", { name: "Register Student" })).toBeEnabled();
  });
});
