import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FamilyAttendanceRegister } from "../components/academic/family-attendance-register";
import { loadFamilyAttendance, loadFamilyStudents, type FamilyStudent } from "../lib/attendance/family";

const { client } = vi.hoisted(() => ({
  client: {
    from: vi.fn(),
    rpc: () => ({ abortSignal: () => ({ returns: async () => ({ data: [], error: null }) }) }),
    auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }) },
  },
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => client }));
vi.mock("@/lib/attendance/family", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/attendance/family")>(),
  loadFamilyStudents: vi.fn(),
  loadFamilyAttendance: vi.fn(),
}));

const loadStudents = vi.mocked(loadFamilyStudents);
const loadHistory = vi.mocked(loadFamilyAttendance);

const pupilOne: FamilyStudent = {
  id: "pupil-one", school_id: "fixture-school", admission_no: "QA-001", first_name: "Pupil One", status: "active",
};
const pupilTwo: FamilyStudent = {
  id: "pupil-two", school_id: "fixture-school", admission_no: "QA-002", first_name: "Pupil Two", status: "active",
};

type History = Awaited<ReturnType<typeof loadFamilyAttendance>>;

function history(status: History["rows"][number]["status"]): History {
  return { rows: [{ attendance_date: "2026-11-03", academic_year_id: "year", status }], count: 1, error: false };
}

function deferredHistory() {
  let resolve!: (value: History) => void;
  const promise = new Promise<History>((complete) => { resolve = complete; });
  return { promise, resolve };
}

beforeEach(() => {
  sessionStorage.clear();
  loadStudents.mockReset();
  loadHistory.mockReset();
});

describe("FamilyAttendanceRegister", () => {
  it.each([
    ["pupil-two", pupilTwo],
    ["unlinked-pupil", pupilOne],
  ])("selects a requested child only if already linked (%s)", async (initialChildId, expected) => {
    loadStudents.mockResolvedValue([pupilOne, pupilTwo]);
    loadHistory.mockResolvedValue(history("late"));

    render(<FamilyAttendanceRegister role="parent" userId="guardian" initialChildId={initialChildId} />);
    expect(await screen.findByRole("combobox", { name: "Select child" })).toHaveValue(expected.id);
    await screen.findByRole("table", { name: "Attendance history" });
    expect(loadHistory).toHaveBeenCalledExactlyOnceWith(client, expected, { offset: 0, limit: 30 });
  });

  it("keeps a student's history scoped to their linked pupil across the 30-record page boundary", async () => {
    const user = userEvent.setup();
    const firstPage: History = {
      rows: Array.from({ length: 30 }, (_, index) => ({
        attendance_date: `2026-11-${String(30 - index).padStart(2, "0")}`,
        academic_year_id: "year",
        status: "late",
      })),
      count: 31,
      error: false,
    };
    loadStudents.mockResolvedValue([pupilOne]);
    loadHistory.mockImplementation(async (_client, _student, options) => options?.offset === 30
      ? { rows: [{ attendance_date: "2026-10-31", academic_year_id: "year", status: "half_day" }], count: 31, error: false }
      : firstPage);

    render(<FamilyAttendanceRegister role="student" userId="student-login" />);

    const table = await screen.findByRole("table", { name: "Attendance history" });
    expect(within(table).getAllByRole("row")).toHaveLength(31);
    expect(screen.getByText("Showing 1–30 of 31 records")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save|mark|edit/i })).not.toBeInTheDocument();
    expect(loadStudents).toHaveBeenCalledExactlyOnceWith(client, "student", "student-login");
    expect(loadHistory).toHaveBeenLastCalledWith(client, pupilOne, { offset: 0, limit: 30 });

    await user.click(screen.getByRole("button", { name: "Next" }));
    const finalRow = await screen.findByRole("row", { name: /half day/i });
    expect(finalRow.querySelector("time")).toHaveAttribute("datetime", "2026-10-31");
    expect(screen.getByText("Showing 31–31 of 31 records")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(loadHistory).toHaveBeenLastCalledWith(client, pupilOne, { offset: 30, limit: 30 });

    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText("Showing 1–30 of 31 records")).toBeInTheDocument();
    expect(loadHistory).toHaveBeenLastCalledWith(client, pupilOne, { offset: 0, limit: 30 });
  });

  it("clears the previous child's rows and ignores a response that arrives after the next switch", async () => {
    const user = userEvent.setup();
    const pending = deferredHistory();
    loadStudents.mockResolvedValue([pupilOne, pupilTwo]);
    loadHistory.mockImplementation(async (_client, student) => student.id === pupilTwo.id ? pending.promise : history("holiday"));
    render(<FamilyAttendanceRegister role="parent" userId="parent-login" />);

    const selection = await screen.findByRole("combobox", { name: "Select child" });
    expect(await screen.findByRole("cell", { name: "Holiday" })).toBeInTheDocument();

    await user.selectOptions(selection, pupilTwo.id);
    expect(screen.getByText("Pupil Two · QA-002", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading attendance");
    expect(screen.queryByRole("table", { name: "Attendance history" })).not.toBeInTheDocument();
    expect(loadHistory).toHaveBeenLastCalledWith(client, pupilTwo, { offset: 0, limit: 30 });

    await user.selectOptions(selection, pupilOne.id);
    expect(await screen.findByRole("cell", { name: "Holiday" })).toBeInTheDocument();
    await act(async () => { pending.resolve(history("absent")); });
    expect(selection).toHaveValue(pupilOne.id);
    expect(screen.getByRole("cell", { name: "Holiday" })).toBeInTheDocument();
    expect(screen.queryByRole("cell", { name: "Absent" })).not.toBeInTheDocument();
  });

  it.each([
    { scenario: "the same account still has that child", nextUser: "parent-login", linked: [pupilOne, pupilTwo], expected: pupilTwo },
    { scenario: "the child is no longer linked", nextUser: "parent-login", linked: [pupilOne], expected: pupilOne },
    { scenario: "a different account signs in", nextUser: "other-parent-login", linked: [pupilOne, pupilTwo], expected: pupilOne },
  ])("restores only a child allowed for the current account on remount when $scenario", async ({ nextUser, linked, expected }) => {
    const user = userEvent.setup();
    loadStudents.mockResolvedValueOnce([pupilOne, pupilTwo]).mockResolvedValueOnce(linked);
    loadHistory.mockResolvedValue(history("present"));
    const view = render(<FamilyAttendanceRegister role="parent" userId="parent-login" />);
    await user.selectOptions(await screen.findByRole("combobox", { name: "Select child" }), pupilTwo.id);
    expect(await screen.findByText("Pupil Two · QA-002", { selector: "p" })).toBeInTheDocument();
    view.unmount();
    loadHistory.mockClear();

    render(<FamilyAttendanceRegister role="parent" userId={nextUser} />);
    expect(await screen.findByRole("combobox", { name: "Select child" })).toHaveValue(expected.id);
    await waitFor(() => expect(loadHistory).toHaveBeenCalledExactlyOnceWith(client, expected, { offset: 0, limit: 30 }));
  });
});
