import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminAttendanceWorkspace } from "../components/admin/admin-attendance-workspace";
import type { AttendanceContext } from "../lib/attendance/types";

const { client, from, getUser, editor } = vi.hoisted(() => {
  const from = vi.fn();
  const getUser = vi.fn();
  return { client: { from, auth: { getUser } }, from, getUser, editor: vi.fn() };
});

vi.mock("@/lib/supabase/client", () => ({ createClient: () => client }));
vi.mock("@/components/admin/attendance-submission-monitor", () => ({ AttendanceSubmissionMonitor: () => null }));

type EditorProps = {
  context: AttendanceContext;
  userId: string;
  studentSearch: boolean;
  onLockChange: (locked: boolean) => void;
};

vi.mock("@/components/academic/attendance-editor", () => ({
  AttendanceEditor(props: EditorProps) {
    editor(props);
    return (
      <div role="group" aria-label="Attendance editor">
        <button type="button" onClick={() => props.onLockChange(true)}>Edit attendance</button>
        <button type="button" onClick={() => props.onLockChange(false)}>Discard edits</button>
      </div>
    );
  },
}));

type Row = Record<string, string | boolean | null>;
let rows: Record<string, Row[]>;

const adminId = "admin-user";
const northContext = {
  schoolId: "north", academicYearId: "north-year", classId: "north-six", sectionId: "north-six-a",
};

beforeEach(() => {
  rows = {
    user_roles: [
      { id: "role-1", user_id: adminId, school_id: "north", role: "school_admin" },
      { id: "role-2", user_id: adminId, school_id: "south", role: "principal" },
      { id: "role-3", user_id: "other-user", school_id: "south", role: "school_admin" },
    ],
    schools: [{ id: "north", name: "North School" }, { id: "south", name: "South School" }],
    academic_years: [
      { id: "north-year", school_id: "north", name: "2026–27", is_current: true, start_date: "2026-04-01", end_date: "2027-03-31" },
      { id: "north-old-year", school_id: "north", name: "2025–26", is_current: false, start_date: "2025-04-01", end_date: "2026-03-31" },
      { id: "north-staged-year", school_id: "north", name: "2098–99", is_current: false, start_date: "2098-04-01", end_date: "2099-03-31" },
      { id: "south-year", school_id: "south", name: "2026–27", is_current: true, start_date: "2026-04-01", end_date: "2027-03-31" },
    ],
    classes: [
      { id: "north-six", school_id: "north", name: "Class 6" },
      { id: "south-seven", school_id: "south", name: "Class 7" },
    ],
    sections: [
      { id: "north-six-a", school_id: "north", class_id: "north-six", name: "North 6A" },
      { id: "south-seven-a", school_id: "south", class_id: "south-seven", name: "South 7A" },
    ],
  };

  getUser.mockResolvedValue({ data: { user: { id: adminId } }, error: null });
  from.mockImplementation((table: string) => {
    if (!rows[table]) throw new Error(`Unexpected read from ${table}`);
    const predicates: ((row: Row) => boolean)[] = [];
    return {
      select() { return this; },
      order() { return this; },
      eq(column: string, value: Row[string]) {
        predicates.push((row) => row[column] === value);
        return this;
      },
      in(column: string, values: Row[string][]) {
        predicates.push((row) => values.includes(row[column]));
        return this;
      },
      async range(start: number, end: number) {
        const matches = rows[table].filter((row) => predicates.every((predicate) => predicate(row)));
        return { data: matches.slice(start, end + 1), count: matches.length, error: null };
      },
    };
  });
});

function allowBothSchools() {
  rows.user_roles.push({ id: "role-4", user_id: adminId, school_id: "south", role: "school_admin" });
}

describe("AdminAttendanceWorkspace", () => {
  it("opens the register when the administrator has one school, class, and section", async () => {
    render(<AdminAttendanceWorkspace />);

    await screen.findByRole("group", { name: "Attendance editor" });
    const school = screen.getByRole("combobox", { name: "School" });
    expect(school).toHaveValue("north");
    expect(school).toBeDisabled();
    expect(within(school).queryByRole("option", { name: "South School" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Academic year" })).toHaveValue("north-year");
    expect(editor).toHaveBeenLastCalledWith(expect.objectContaining({
      context: northContext,
      userId: adminId,
      studentSearch: true,
    }));
  });

  it("opens a prior session read-only and keeps the staged future session out of the register", async () => {
    const user = userEvent.setup();
    render(<AdminAttendanceWorkspace />);

    const years = await screen.findByRole("combobox", { name: "Academic year" });
    expect(within(years).queryByRole("option", { name: "2098–99" })).not.toBeInTheDocument();
    await user.selectOptions(years, "north-old-year");
    expect(editor).toHaveBeenLastCalledWith(expect.objectContaining({
      context: { ...northContext, academicYearId: "north-old-year" },
      dateLimits: { start: "2025-04-01", end: "2026-03-31" },
      readOnly: true,
    }));
    await user.selectOptions(years, "north-year");
    expect(editor).toHaveBeenLastCalledWith(expect.objectContaining({ context: northContext, readOnly: false }));
  });

  it("waits for explicit school selection before opening a register for an administrator of multiple schools", async () => {
    allowBothSchools();
    const user = userEvent.setup();
    render(<AdminAttendanceWorkspace />);

    const school = await screen.findByRole("combobox", { name: "School" });
    expect(school).toHaveValue("");
    expect(editor).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalledWith("academic_years");

    await user.selectOptions(school, "south");
    await screen.findByRole("group", { name: "Attendance editor" });
    expect(editor).toHaveBeenLastCalledWith(expect.objectContaining({
      context: { schoolId: "south", academicYearId: "south-year", classId: "south-seven", sectionId: "south-seven-a" },
    }));
  });

  it("offers sections from the selected class and locks all scope controls while the editor has a draft", async () => {
    allowBothSchools();
    rows.classes.push({ id: "north-seven", school_id: "north", name: "Class 7" });
    rows.sections.push(
      { id: "north-six-b", school_id: "north", class_id: "north-six", name: "North 6B" },
      { id: "north-seven-a", school_id: "north", class_id: "north-seven", name: "North 7A" },
    );
    const user = userEvent.setup();
    render(<AdminAttendanceWorkspace />);

    const school = await screen.findByRole("combobox", { name: "School" });
    await user.selectOptions(school, "north");
    const classPicker = await screen.findByRole("combobox", { name: "Class" });
    const section = screen.getByRole("combobox", { name: "Section" });
    expect(section).toBeDisabled();

    await user.selectOptions(classPicker, "north-six");
    expect(within(section).queryByRole("option", { name: "North 7A" })).not.toBeInTheDocument();
    expect(section).toHaveValue("");
    expect(editor).not.toHaveBeenCalled();
    await user.selectOptions(section, "north-six-b");

    await user.click(screen.getByRole("button", { name: "Edit attendance" }));
    expect(school).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Academic year" })).toBeDisabled();
    expect(classPicker).toBeDisabled();
    expect(section).toBeDisabled();
    expect(editor).toHaveBeenLastCalledWith(expect.objectContaining({
      context: { ...northContext, sectionId: "north-six-b" },
    }));

    await user.click(screen.getByRole("button", { name: "Discard edits" }));
    expect(school).toBeEnabled();
    expect(classPicker).toBeEnabled();
    expect(section).toBeEnabled();
    await user.selectOptions(classPicker, "north-seven");
    expect(section).toHaveValue("north-seven-a");
    expect(within(section).queryByRole("option", { name: "North 6B" })).not.toBeInTheDocument();
    expect(editor).toHaveBeenLastCalledWith(expect.objectContaining({
      context: { ...northContext, classId: "north-seven", sectionId: "north-seven-a" },
    }));
  });

  it.each([
    { scenario: "no current year", currentYears: [] },
    { scenario: "multiple current years", currentYears: ["north-year-1", "north-year-2"] },
  ])("keeps the register closed with $scenario", async ({ currentYears }) => {
    rows.academic_years = rows.academic_years.filter((row) => row.id !== "north-year");
    rows.academic_years.push(...currentYears.map((id) => ({ id, school_id: "north", name: id, is_current: true })));

    render(<AdminAttendanceWorkspace />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Set exactly one current academic year for this school");
    expect(screen.getByRole("button", { name: "Retry school setup" })).toBeEnabled();
    expect(editor).not.toHaveBeenCalled();
  });
});
