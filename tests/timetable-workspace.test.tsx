import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TimetableWorkspace } from "@/components/academic/timetable-workspace";
import { loadFamilyStudents, type FamilyStudent } from "@/lib/attendance/family";
import { loadSchoolManagementAccess } from "@/lib/attendance/repository";
import type { TimetablePeriod, TimetableSetup } from "@/lib/timetable";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), getUser: vi.fn(), listener: (() => {}) as (event: string, session: { user: { id: string } } | null) => void }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc: mocks.rpc, from: mocks.from, auth: {
  getUser: mocks.getUser, onAuthStateChange: (listener: typeof mocks.listener) => { mocks.listener = listener; return { data: { subscription: { unsubscribe: () => {} } } }; },
} }) }));
vi.mock("@/lib/attendance/family", async (original) => ({ ...await original<typeof import("../lib/attendance/family")>(), loadFamilyStudents: vi.fn() }));
vi.mock("@/lib/attendance/repository", () => ({ loadSchoolManagementAccess: vi.fn() }));

const uuid = (value: number) => `20000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const childA: FamilyStudent = { id: "child-a", school_id: "school-a", admission_no: "QA-1", first_name: "QA Anya", status: "active" };
const childB: FamilyStudent = { id: "child-b", school_id: "school-a", admission_no: "QA-2", first_name: "QA Kabir", status: "active" };
const setup: TimetableSetup = {
  years: [{ id: "year-a", name: "2026–27", is_current: true, start_date: "2026-04-01", end_date: "2027-03-31" }],
  classes: [{ id: "class-a", name: "Class 6" }, { id: "class-b", name: "Class 7" }],
  sections: [{ id: "section-a", class_id: "class-a", name: "A" }, { id: "section-b", class_id: "class-b", name: "B" }],
  assignments: [{ id: "assignment-a", academic_year_id: "year-a", class_id: "class-a", section_id: "section-a", subject_id: "science", teacher_id: "teacher-a", subject_name: "Science", teacher_name: "QA Teacher" },
    { id: "assignment-wide", academic_year_id: "year-a", class_id: "class-a", section_id: null, subject_id: "maths", teacher_id: "teacher-b", subject_name: "Mathematics", teacher_name: "QA Math teacher" },
    { id: "assignment-b", academic_year_id: "year-a", class_id: "class-b", section_id: "section-b", subject_id: "english", teacher_id: "teacher-a", subject_name: "English", teacher_name: "QA Teacher" }],
};
function period(patch: Partial<TimetablePeriod> = {}): TimetablePeriod {
  return { id: uuid(1), school_id: "school-a", academic_year_id: "year-a", class_id: "class-a", class_name: "Class 6",
    section_id: "section-a", section_name: "A", assignment_id: "assignment-a", subject_id: "science", subject_name: "Science",
    teacher_id: "teacher-a", teacher_name: "QA Teacher", day_of_week: 1, period_no: 1, start_time: "08:00:00", end_time: "08:45:00", room: "Lab", version: uuid(2), needs_attention: false, ...patch };
}
function timetable(rows: TimetablePeriod[], patch: Record<string, unknown> = {}) {
  return { school_id: "school-a", academic_year_id: "year-a", academic_year_name: "2026–27", class_id: "class-a", class_name: "Class 6", section_id: null, section_name: null, rows, ...patch };
}
type Args = Record<string, unknown>;
type Reply = { data: unknown; error: { code?: string; message: string } | null };
const schoolLoader = vi.mocked(loadSchoolManagementAccess), familyLoader = vi.mocked(loadFamilyStudents);

function store(initial: TimetablePeriod[] = []) {
  const rows = structuredClone(initial), requests = new Map<string, string>();
  let loseSave = false, loseRemove = false, denied = false, nextError: Reply["error"] = null;
  let saveWait: Promise<void> | undefined, sequence = 100;
  mocks.rpc.mockImplementation(async (name: string, args: Args = {}): Promise<Reply> => {
    if (name === "get_timetable_setup") return { data: setup, error: null };
    if (name.startsWith("get_")) {
      if (denied) return { data: null, error: { code: "42501", message: "Revoked" } };
      if (name === "get_office_timetable") return { data: timetable(rows.filter((row) => row.class_id === args.p_class_id
        && (!args.p_section_id || row.section_id === null || row.section_id === args.p_section_id)), { class_id: args.p_class_id,
        class_name: args.p_class_id === "class-b" ? "Class 7" : "Class 6", section_id: args.p_section_id,
        section_name: args.p_section_id ? "A" : null }), error: null };
      if (name === "get_teacher_timetable") return { data: timetable(rows.filter((row) => row.teacher_id === "teacher-a" && !row.needs_attention)), error: null };
      const childBSelected = args.p_student_id === childB.id, classId = childBSelected ? "class-b" : "class-a", sectionId = childBSelected ? "section-b" : "section-a";
      return { data: timetable(rows.filter((row) => row.class_id === classId && (row.section_id === null || row.section_id === sectionId) && !row.needs_attention),
        { student_id: args.p_student_id, class_id: classId, class_name: childBSelected ? "Class 7" : "Class 6", section_id: sectionId, section_name: childBSelected ? "B" : "A" }), error: null };
    }
    await saveWait;
    if (nextError) { const error = nextError; nextError = null; return { data: null, error }; }
    const previous = requests.get(String(args.p_request_id));
    if (previous) return { data: previous, error: null };
    if (name === "save_timetable_period") {
      const existing = rows.find((row) => row.id === args.p_period_id);
      if (args.p_period_id && existing?.version !== args.p_expected_version) return { data: null, error: { code: "PT409", message: "This period changed. Refresh and review the latest timetable." } };
      const assignment = setup.assignments.find((row) => row.id === args.p_assignment_id)!;
      const row = period({ id: existing?.id ?? uuid(++sequence), assignment_id: assignment.id, class_id: assignment.class_id,
        class_name: setup.classes.find((item) => item.id === assignment.class_id)!.name, section_id: args.p_section_id as string | null,
        section_name: args.p_section_id ? setup.sections.find((item) => item.id === args.p_section_id)!.name : null,
        subject_id: assignment.subject_id, subject_name: assignment.subject_name, teacher_id: assignment.teacher_id, teacher_name: assignment.teacher_name,
        day_of_week: Number(args.p_day_of_week), period_no: Number(args.p_period_no), start_time: String(args.p_start_time), end_time: String(args.p_end_time), room: args.p_room as string | null, version: uuid(++sequence) });
      if (existing) Object.assign(existing, row); else rows.push(row);
      requests.set(String(args.p_request_id), row.id);
      if (loseSave) { loseSave = false; return { data: null, error: { message: "Lost acknowledgement" } }; }
      return { data: row.id, error: null };
    }
    if (name === "remove_timetable_period") {
      const index = rows.findIndex((row) => row.id === args.p_period_id);
      if (index < 0 || rows[index].version !== args.p_expected_version) return { data: null, error: { code: "PT409", message: "The period changed before removal." } };
      const [removed] = rows.splice(index, 1); requests.set(String(args.p_request_id), removed.id);
      if (loseRemove) { loseRemove = false; return { data: null, error: { message: "Lost removal acknowledgement" } }; }
      return { data: removed.id, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  return { rows, failNext: (error: NonNullable<Reply["error"]>) => { nextError = error; }, loseSave: () => { loseSave = true; },
    loseRemove: () => { loseRemove = true; }, deny: () => { denied = true; },
    deferSave: () => { let done!: () => void; saveWait = new Promise<void>((resolve) => { done = resolve; }); return done; } };
}

async function newPeriod(assignment = "assignment-a") {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Add period" }));
  await user.selectOptions(screen.getByLabelText("Subject and teacher", { exact: true }), assignment);
  fireEvent.change(screen.getByLabelText("Start time", { exact: true }), { target: { value: "08:00" } });
  fireEvent.change(screen.getByLabelText("End time", { exact: true }), { target: { value: "08:45" } });
  return user;
}
beforeEach(() => {
  sessionStorage.clear(); mocks.rpc.mockReset(); mocks.from.mockReset(); mocks.getUser.mockReset(); familyLoader.mockReset(); schoolLoader.mockReset();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "guardian" } }, error: null }); familyLoader.mockResolvedValue([childA, childB]);
  schoolLoader.mockResolvedValue({ userId: "admin", schools: [{ id: "school-a", name: "QA School" }], schoolAdminIds: ["school-a"] });
});

describe("timetable operational UI", () => {
  it("creates a mapped period, reloads it and keeps exact labels stable after changing values", async () => {
    const saved = store(); render(<TimetableWorkspace role="admin" userId="admin" />); const user = await newPeriod();
    for (const name of ["School", "Academic year", "Class", "View section", "Subject and teacher", "Period section", "Weekday", "Period number", "Room (optional)", "Start time", "End time"]) expect(screen.getByLabelText(name, { exact: true })).toHaveAccessibleName(name);
    expect(screen.getByLabelText("Period section")).toHaveValue("section-a");
    await user.type(screen.getByLabelText("Room (optional)"), "Science lab");
    await user.click(screen.getByRole("button", { name: "Save period" }));
    await screen.findByText(/Period saved and shared/);
    expect(saved.rows).toHaveLength(1); expect(saved.rows[0]).toMatchObject({ assignment_id: "assignment-a", section_id: "section-a", teacher_name: "QA Teacher", room: "Science lab" });
    await user.click(screen.getByRole("button", { name: "Refresh timetable" }));
    expect(await screen.findByRole("region", { name: "Monday periods" })).toHaveTextContent("Science lab");
  });

  it("retains an overlap-rejected draft and blocks duplicate submits/context changes while saving", async () => {
    const saved = store(); const done = saved.deferSave(); render(<TimetableWorkspace role="principal" userId="admin" />);
    await newPeriod(); const form = screen.getByLabelText("Start time").closest("form")!;
    saved.failNext({ code: "PT409", message: "Teacher timing overlaps an existing period." });
    fireEvent.submit(form); fireEvent.submit(form);
    expect(screen.getByLabelText("Class")).toBeDisabled(); expect(screen.getByLabelText("Subject and teacher")).toBeDisabled();
    expect(mocks.rpc.mock.calls.filter(([name]) => name === "save_timetable_period")).toHaveLength(1);
    await act(async () => { done(); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Teacher timing overlaps");
    expect(screen.getByLabelText("Start time")).toHaveValue("08:00"); expect(screen.getByLabelText("Class")).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel draft" })); expect(screen.getByLabelText("Class")).toBeEnabled();
  });

  it("uses the same retry key after an unconfirmed save without creating another period", async () => {
    const saved = store(); saved.loseSave(); render(<TimetableWorkspace role="admin" userId="admin" />); const user = await newPeriod();
    await user.click(screen.getByRole("button", { name: "Save period" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be confirmed");
    await user.click(screen.getByRole("button", { name: "Save period" })); await screen.findByText(/Period saved and shared/);
    const calls = mocks.rpc.mock.calls.filter(([name]) => name === "save_timetable_period");
    expect(calls[0][1].p_request_id).toBe(calls[1][1].p_request_id); expect(saved.rows).toHaveLength(1);
  });

  it("keeps the loaded version frozen across refresh and rejects stale edits instead of rebasing", async () => {
    const saved = store([period()]); render(<TimetableWorkspace role="admin" userId="admin" />); const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit Monday period 1 A" }));
    await user.clear(screen.getByLabelText("Room (optional)")); await user.type(screen.getByLabelText("Room (optional)"), "My draft room");
    saved.rows[0].version = uuid(999); saved.rows[0].room = "Other admin room";
    await user.click(screen.getByRole("button", { name: "Refresh timetable" })); await screen.findByText("Class 6 / A · Other admin room");
    await user.click(screen.getByRole("button", { name: "Save period" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This period changed"); expect(screen.getByLabelText("Room (optional)")).toHaveValue("My draft room");
    expect(mocks.rpc.mock.calls.filter(([name]) => name === "save_timetable_period")[0][1].p_expected_version).toBe(uuid(2));
    expect(saved.rows[0].room).toBe("Other admin room");
  });

  it("removes once through confirmation, retries a lost acknowledgement and stays absent after refresh", async () => {
    const saved = store([period()]); saved.loseRemove(); render(<TimetableWorkspace role="admin" userId="admin" />); const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Remove Monday period 1 A" }));
    expect(screen.getByRole("button", { name: "Keep period" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm remove period" })); expect(await screen.findByRole("alert")).toHaveTextContent("could not be confirmed");
    await user.click(screen.getByRole("button", { name: "Confirm remove period" })); await screen.findByText(/Period removed from/);
    expect(saved.rows).toHaveLength(0); const calls = mocks.rpc.mock.calls.filter(([name]) => name === "remove_timetable_period");
    expect(calls[0][1].p_request_id).toBe(calls[1][1].p_request_id);
    await user.click(screen.getByRole("button", { name: "Refresh timetable" })); await screen.findByText("No shared periods are scheduled for this view.");
  });

  it("requires a class-wide teaching assignment before scheduling a whole-class period", async () => {
    const saved = store(); render(<TimetableWorkspace role="admin" userId="admin" />); const user = await newPeriod("assignment-wide");
    expect(screen.getByLabelText("Period section")).toBeEnabled(); expect(screen.getByLabelText("Period section")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Save period" })); await screen.findByText(/Period saved and shared/);
    expect(saved.rows[0]).toMatchObject({ section_id: null, subject_name: "Mathematics", teacher_name: "QA Math teacher" });
  });

  it("shows legacy rows needing attention only in office and repairs through an eligible assignment", async () => {
    const saved = store([period({ assignment_id: null, start_time: null, end_time: null, needs_attention: true })]);
    render(<TimetableWorkspace role="admin" userId="admin" />); const user = userEvent.setup();
    await screen.findByText(/Needs attention: verify/); await user.click(screen.getByRole("button", { name: "Edit Monday period 1 A" }));
    expect(screen.getByRole("button", { name: "Save period" })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("Subject and teacher"), "assignment-a");
    fireEvent.change(screen.getByLabelText("Start time"), { target: { value: "08:00" } }); fireEvent.change(screen.getByLabelText("End time"), { target: { value: "08:45" } });
    await user.click(screen.getByRole("button", { name: "Save period" })); await screen.findByText(/Period saved and shared/);
    expect(saved.rows[0].needs_attention).toBe(false); expect(screen.queryByText(/Needs attention: verify/)).not.toBeInTheDocument();
  });

  it("offers the office a governed removal of live periods whose teaching assignment no longer exists", async () => {
    const saved = store([
      period({ id: uuid(11), version: uuid(12), assignment_id: "assignment-gone", needs_attention: true }),
      period({ id: uuid(13), version: uuid(14), assignment_id: "assignment-gone", day_of_week: 2, needs_attention: true }),
      period({ id: uuid(15), version: uuid(16), assignment_id: "assignment-a", day_of_week: 3, start_time: null, end_time: null, needs_attention: true }),
      period({ id: uuid(17), version: uuid(18), assignment_id: null, day_of_week: 4, needs_attention: true }),
      period({ id: uuid(19), version: uuid(20), day_of_week: 5 }),
    ]);
    const lookups: string[][] = [];
    mocks.from.mockImplementation((table: string) => ({ select: () => ({ in: async (column: string, ids: string[]) => {
      expect([table, column]).toEqual(["teacher_subject_assignments", "id"]); lookups.push(ids);
      return { data: ids.filter((item) => item !== "assignment-gone").map((item) => ({ id: item })), error: null };
    } }) }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<TimetableWorkspace role="admin" userId="admin" />); const user = userEvent.setup();
    expect(await screen.findByText(/2 periods still use a teaching assignment that was removed/)).toBeInTheDocument();
    expect(lookups[0].sort()).toEqual(["assignment-a", "assignment-gone"]);
    await user.click(screen.getByRole("button", { name: "Remove stale periods" }));
    expect(confirm).toHaveBeenCalledOnce();
    await screen.findByText("2 stale periods removed from the shared timetable.");
    const calls = mocks.rpc.mock.calls.filter(([name]) => name === "remove_timetable_period");
    expect(calls.map(([, args]) => [args.p_period_id, args.p_expected_version])).toEqual([[uuid(11), uuid(12)], [uuid(13), uuid(14)]]);
    expect(new Set(calls.map(([, args]) => args.p_request_id)).size).toBe(2);
    expect(saved.rows.map((row) => row.id)).toEqual([uuid(15), uuid(17), uuid(19)]);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove stale periods" })).not.toBeInTheDocument());
    confirm.mockRestore();
  });

  it("keeps stale periods when the office declines, and reports a partial removal", async () => {
    const saved = store([
      period({ id: uuid(11), version: uuid(12), assignment_id: "assignment-gone", needs_attention: true }),
      period({ id: uuid(13), version: uuid(14), assignment_id: "assignment-gone", day_of_week: 2, needs_attention: true }),
    ]);
    mocks.from.mockReturnValue({ select: () => ({ in: async () => ({ data: [], error: null }) }) });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    render(<TimetableWorkspace role="admin" userId="admin" />); const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Remove stale periods" }));
    expect(mocks.rpc.mock.calls.some(([name]) => name === "remove_timetable_period")).toBe(false);
    saved.rows[1] = { ...saved.rows[1], version: uuid(99) }; // changed elsewhere after the office loaded it
    await user.click(screen.getByRole("button", { name: "Remove stale periods" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("1 of 2 stale periods removed. The period changed before removal.");
    expect(saved.rows.map((row) => row.id)).toEqual([uuid(13)]);
    expect(await screen.findByText(/1 period still uses a teaching assignment that was removed/)).toBeInTheDocument();
    confirm.mockRestore();
  });

  it("switches only linked children, persists selection and provides read-only family schedules", async () => {
    store([period(), period({ id: uuid(3), class_id: "class-b", class_name: "Class 7", section_id: "section-b", section_name: "B", subject_name: "English" })]);
    const user = userEvent.setup(), view = render(<TimetableWorkspace role="parent" userId="guardian" />);
    await screen.findByText("Science"); await user.selectOptions(screen.getByLabelText("Select child", { exact: true }), childB.id);
    await screen.findByText("English"); expect(screen.queryByText("Science")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add period" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Select child", { exact: true })).toHaveAccessibleName("Select child");
    view.unmount(); render(<TimetableWorkspace role="parent" userId="guardian" />);
    await screen.findByText("English"); expect(screen.getByLabelText("Select child")).toHaveValue(childB.id);
  });

  it("hides revoked records on reload and refreshes remaining authorized child links", async () => {
    const saved = store([period()]); render(<TimetableWorkspace role="parent" userId="guardian" />); const user = userEvent.setup();
    await screen.findByText("Science"); saved.deny();
    await user.click(screen.getByRole("button", { name: "Refresh timetable" })); await screen.findByRole("alert");
    expect(screen.queryByText("Science")).not.toBeInTheDocument(); familyLoader.mockResolvedValue([childB]);
    await user.click(screen.getByRole("button", { name: "Refresh linked students" }));
    await waitFor(() => expect(screen.getByLabelText("Select child")).toHaveValue(childB.id));
    expect(within(screen.getByLabelText("Select child")).queryByText(/QA Anya/)).not.toBeInTheDocument();
  });

  it("shows teacher own schedule without mutation controls and student own schedule without child switching", async () => {
    store([period()]); const teacher = render(<TimetableWorkspace role="teacher" userId="teacher" />);
    await screen.findByText("Science"); expect(screen.queryByRole("button", { name: "Add period" })).not.toBeInTheDocument();
    expect(mocks.rpc).toHaveBeenCalledWith("get_teacher_timetable"); teacher.unmount();
    familyLoader.mockResolvedValue([childA]); mocks.getUser.mockResolvedValue({ data: { user: { id: "student" } }, error: null });
    render(<TimetableWorkspace role="student" userId="student" />); await screen.findByText("Science");
    expect(screen.queryByLabelText("Select child")).not.toBeInTheDocument(); expect(mocks.rpc).toHaveBeenCalledWith("get_family_timetable", { p_student_id: childA.id });
  });

  it("ignores a late previous-child response after switching scope", async () => {
    let finish!: (result: Reply) => void; const pending = new Promise<Reply>((resolve) => { finish = resolve; });
    mocks.rpc.mockImplementation((_name, args: Args) => args.p_student_id === childA.id ? pending : Promise.resolve({
      data: timetable([period({ class_id: "class-b", class_name: "Class 7", section_id: "section-b", section_name: "B", subject_name: "Current English" })],
        { student_id: childB.id, class_id: "class-b", class_name: "Class 7", section_id: "section-b", section_name: "B" }), error: null,
    }));
    render(<TimetableWorkspace role="parent" userId="guardian" />); const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("Select child"), childB.id); await screen.findByText("Current English");
    await act(async () => { finish({ data: timetable([period()], { student_id: childA.id, section_id: "section-a", section_name: "A" }), error: null }); await pending; });
    expect(screen.queryByText("Science")).not.toBeInTheDocument();
  });

  it("clears displayed data after session change and rejects mismapped read responses", async () => {
    store([period()]); render(<TimetableWorkspace role="teacher" userId="teacher" />); await screen.findByText("Science");
    act(() => { mocks.listener("SIGNED_OUT", null); }); expect(screen.getByRole("alert")).toHaveTextContent("sign-in changed");
    expect(screen.queryByText("Science")).not.toBeInTheDocument();
  });

  it("ignores a previous class response after the office changes its class scope", async () => {
    store([period(), period({ id: uuid(3), class_id: "class-b", class_name: "Class 7", section_id: "section-b", section_name: "B", subject_name: "Current English" })]);
    const original = mocks.rpc.getMockImplementation()!;
    let finish!: (result: Reply) => void; const pending = new Promise<Reply>((resolve) => { finish = resolve; });
    mocks.rpc.mockImplementation((name: string, args: Args) => name === "get_office_timetable" && args.p_class_id === "class-a" ? pending : original(name, args));
    render(<TimetableWorkspace role="admin" userId="admin" />); const user = userEvent.setup();
    await waitFor(() => expect(screen.getByLabelText("Class", { exact: true })).toHaveValue("class-a"));
    await user.selectOptions(screen.getByLabelText("Class", { exact: true }), "class-b");
    await screen.findByText("Current English");
    await act(async () => { finish({ data: timetable([period()]), error: null }); await pending; });
    expect(screen.queryByText("Science")).not.toBeInTheDocument(); expect(screen.getByLabelText("Class", { exact: true })).toHaveValue("class-b");
  });

  it("shows an explicit empty state for a teacher without a current academic year", async () => {
    mocks.rpc.mockResolvedValue({ data: { school_id: "school-a", academic_year_id: null, academic_year_name: null, rows: [] }, error: null });
    render(<TimetableWorkspace role="teacher" userId="teacher" />);
    await screen.findByText("No current timetable is available for this account or enrollment.");
    expect(screen.queryByRole("button", { name: "Add period" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh timetable" })).toBeEnabled();
  });
});
