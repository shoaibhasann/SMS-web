import { useEffect, useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AttendanceContext } from "../lib/attendance/types";
import { TeacherAttendanceRegister } from "../components/academic/teacher-attendance-register";

type EditorProps = {
  context: AttendanceContext;
  userId: string;
  rosterVersion: number;
  onLockChange: (locked: boolean) => void;
};

const { client, getUser, from, rpc, editorBoundary } = vi.hoisted(() => {
  const getUser = vi.fn();
  const from = vi.fn();
  const rpc = vi.fn();
  return {
    getUser,
    from,
    rpc,
    editorBoundary: vi.fn(),
    client: { auth: { getUser }, from, rpc },
  };
});

vi.mock("@/lib/supabase/client", () => ({ createClient: () => client }));

// Exercise the real parent, with controllable child loading/dirty state.
vi.mock("@/components/academic/attendance-editor", () => ({
  AttendanceEditor: function AttendanceEditorBoundary(props: EditorProps) {
    editorBoundary(props);
    const { onLockChange } = props;
    const [locked, setLocked] = useState(true);
    const [date, setDate] = useState("2026-11-02");
    useEffect(() => {
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  queries = [];
  results = {
    teachers: { data: { id: "teacher-a", school_id: "school-a", full_name: "Priya Sharma" }, error: null },
    academic_years: { data: { id: "current-year" }, error: null },
    teacher_subject_assignments: { data: { class_id: "class-a", section_id: "section-a" }, error: null },
    classes: { data: { name: "Class 6" }, error: null },
    sections: { data: { name: "A" }, error: null },
  };
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
    expect(screen.getByText("Class Teacher: Priya Sharma · Class 6 / A")).toBeInTheDocument();
    expect(queries.find((query) => query.table === "teachers")?.filters).toEqual([["profile_id", "auth-teacher"]]);
    expect(queries.find((query) => query.table === "academic_years")?.filters).toEqual([["school_id", "school-a"], ["is_current", true]]);
    expect(queries.find((query) => query.table === "teacher_subject_assignments")?.filters).toEqual([
      ["teacher_id", "teacher-a"], ["academic_year_id", "current-year"], ["is_class_teacher", true],
    ]);
    expect(queries.find((query) => query.table === "classes")?.filters).toEqual([["id", "class-a"], ["school_id", "school-a"]]);
    expect(queries.find((query) => query.table === "sections")?.filters).toEqual([
      ["id", "section-a"], ["class_id", "class-a"], ["school_id", "school-a"],
    ]);
    expect(screen.getByRole("button", { name: "Register Student" })).toBeDisabled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["teachers", "A teacher profile is not linked to this account."],
    ["academic_years", "No current academic year is configured."],
    ["teacher_subject_assignments", "An assigned class teacher section is required."],
  ])("fails closed when %s is missing", async (table, message) => {
    results[table] = { data: null, error: null };
    render(<TeacherAttendanceRegister />);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(editorBoundary).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Register Student" })).not.toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a class-teacher assignment without a section", async () => {
    results.teacher_subject_assignments.data = { class_id: "class-a", section_id: null };
    render(<TeacherAttendanceRegister />);
    expect(await screen.findByRole("alert")).toHaveTextContent("An assigned class teacher section is required.");
    expect(editorBoundary).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalledWith("classes");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not mount a usable editor when the school/class-scoped section lookup is rejected", async () => {
    results.sections = { data: null, error: new Error("Section does not belong to this class and school.") };
    render(<TeacherAttendanceRegister />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Section does not belong to this class and school.");
    expect(editorBoundary).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
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
