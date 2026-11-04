import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AttendanceEditor } from "../components/academic/attendance-editor";
import {
  attendanceContextKey,
  schoolDate,
  type AttendanceChange,
  type AttendanceContext,
  type AttendanceEntry,
  type AttendanceRepository,
  type AttendanceSaveResult,
  type AttendanceSnapshot,
} from "../lib/attendance/types";

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => { throw new Error("Attendance tests must use the injected repository."); },
}));

const context: AttendanceContext = {
  schoolId: "school-a",
  academicYearId: "year-a",
  classId: "class-a",
  sectionId: "section-a",
};
const otherContext = { ...context, classId: "class-b", sectionId: "section-b" };
const userId = "teacher-a";

function initialSnapshot(): AttendanceSnapshot {
  return {
    students: [
      { id: "a", first_name: "Aarav", admission_no: "A-1", roll_no: "1" },
      { id: "b", first_name: "Anaya", admission_no: "A-2", roll_no: "2" },
      { id: "c", first_name: "Kabir", admission_no: "A-3", roll_no: "3" },
      { id: "d", first_name: "Diya", admission_no: "A-4", roll_no: "4" },
    ],
    entries: {
      a: { student_id: "a", status: "absent", remarks: "Guardian informed" },
      b: { student_id: "b", status: "holiday", remarks: null },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** A persisted, context/date-scoped fake, rather than a canned save success. */
function persistedRepository() {
  const store = new Map<string, AttendanceSnapshot>();
  const key = (scope: AttendanceContext, date: string) => `${attendanceContextKey(scope)}:${date}`;
  function read(scope: AttendanceContext, date: string) {
    if (!store.has(key(scope, date))) store.set(key(scope, date), initialSnapshot());
    return structuredClone(store.get(key(scope, date))!);
  }
  function commit(scope: AttendanceContext, date: string, changes: AttendanceChange[]): AttendanceSaveResult {
    const snapshot = read(scope, date);
    const saved: AttendanceEntry[] = [];
    const failures: AttendanceSaveResult["failures"] = [];
    for (const change of changes) {
      if (JSON.stringify(snapshot.entries[change.studentId] ?? null) !== JSON.stringify(change.expected)) {
        failures.push({ studentId: change.studentId, message: "This record changed. Reload before correcting it." });
        continue;
      }
      const entry = {
        student_id: change.studentId,
        status: change.status,
        remarks: change.expected?.remarks ?? null,
      };
      snapshot.entries[change.studentId] = entry;
      saved.push(structuredClone(entry));
    }
    store.set(key(scope, date), structuredClone(snapshot));
    return { saved, failures };
  }
  const repository = {
    load: vi.fn<AttendanceRepository["load"]>(async (scope, date) => read(scope, date)),
    save: vi.fn<AttendanceRepository["save"]>(async (scope, date, _actor, changes) => commit(scope, date, changes)),
  };
  return { repository, read, commit, store, key };
}

function ParentControls({ repository }: { repository: AttendanceRepository }) {
  const [locked, setLocked] = useState(false);
  const [scope, setScope] = useState(context);
  const [visible, setVisible] = useState(true);
  return (
    <>
      <button disabled={locked} onClick={() => setScope(otherContext)}>Change class</button>
      <button disabled={locked} onClick={() => setVisible(false)}>Cancel editor</button>
      {visible && <AttendanceEditor context={scope} userId={userId} repository={repository} onLockChange={setLocked} />}
    </>
  );
}

function register() {
  return screen.getByRole("region", { name: "Attendance editor" });
}

function attendance(name: string) {
  return screen.getByRole("combobox", { name: `Attendance for ${name}` });
}

async function loaded() {
  await screen.findByRole("combobox", { name: "Attendance for Aarav" });
}

describe("AttendanceEditor", () => {
  it("submits one historical correction with a reason and reuses the request ID after an interrupted response", async () => {
    const user = userEvent.setup();
    const { repository: currentDay } = persistedRepository();
    const requestCorrection = vi.fn<NonNullable<AttendanceRepository["requestCorrection"]>>()
      .mockRejectedValueOnce(new Error("Connection interrupted."))
      .mockResolvedValue(undefined);
    const repository = { ...currentDay, requestCorrection };
    render(<AttendanceEditor context={context} userId={userId} repository={repository} />);
    await loaded();

    const pastDay = schoolDate(new Date(Date.now() - 86_400_000));
    fireEvent.change(screen.getByLabelText("Attendance date"), { target: { value: pastDay } });
    await loaded();
    await user.selectOptions(attendance("Aarav"), "late");
    expect(attendance("Anaya")).toBeDisabled();
    const submit = screen.getByRole("button", { name: "Request correction" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("Correction reason"), "Gate register confirms late arrival.");
    await user.click(submit);
    await screen.findByText(/Connection interrupted/);
    await user.click(submit);
    await screen.findByText(/Correction requested/);

    expect(requestCorrection.mock.calls).toHaveLength(2);
    expect(requestCorrection.mock.calls[0]).toEqual(requestCorrection.mock.calls[1]);
    expect(requestCorrection.mock.calls[0].slice(0, 4)).toEqual([
      context, pastDay, { studentId: "a", status: "late", expected: { student_id: "a", status: "absent", remarks: "Guardian informed" } },
      "Gate register confirms late arrival.",
    ]);
    expect(attendance("Aarav")).toHaveValue("absent");
    expect(currentDay.save).not.toHaveBeenCalled();
  });

  it("loads saved absence/holiday and leaves missing rows explicitly unmarked without writing", async () => {
    const { repository, read } = persistedRepository();
    render(<AttendanceEditor context={context} userId={userId} repository={repository} />);
    await loaded();

    expect(attendance("Aarav")).toHaveValue("absent");
    expect(attendance("Anaya")).toHaveValue("holiday");
    expect(attendance("Kabir")).toHaveValue("");
    expect(attendance("Diya")).toHaveValue("");
    expect(screen.getByText("4 students · 2 marked · 2 unmarked. Only changed records are saved.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Attendance" })).toBeDisabled();
    expect(repository.save).not.toHaveBeenCalled();
    expect(read(context, schoolDate()).entries.a.remarks).toBe("Guardian informed");
  });

  it("submits only changed records and drops an edit reverted to its saved status", async () => {
    const user = userEvent.setup();
    const { repository, read } = persistedRepository();
    render(<AttendanceEditor context={context} userId={userId} repository={repository} />);
    await loaded();

    await user.selectOptions(attendance("Aarav"), "late");
    await user.selectOptions(attendance("Anaya"), "present");
    await user.selectOptions(attendance("Anaya"), "holiday");
    await user.click(screen.getByRole("button", { name: "Save Attendance" }));

    await screen.findByText("Attendance saved for 1 student.");
    expect(repository.save).toHaveBeenCalledExactlyOnceWith(context, schoolDate(), userId, [{
      studentId: "a",
      status: "late",
      expected: { student_id: "a", status: "absent", remarks: "Guardian informed" },
    }]);
    expect(read(context, schoolDate()).entries).toEqual({
      a: { student_id: "a", status: "late", remarks: "Guardian informed" },
      b: { student_id: "b", status: "holiday", remarks: null },
    });
    expect(screen.getByRole("button", { name: "Save Attendance" })).toBeDisabled();
  });

  it("bulk present fills only unmarked students and preserves persisted and draft absences/holidays", async () => {
    const user = userEvent.setup();
    const { repository, read } = persistedRepository();
    render(<AttendanceEditor context={context} userId={userId} repository={repository} />);
    await loaded();
    await user.selectOptions(attendance("Diya"), "absent");
    await user.click(screen.getByRole("button", { name: "Mark unmarked present" }));

    expect(attendance("Aarav")).toHaveValue("absent");
    expect(attendance("Anaya")).toHaveValue("holiday");
    expect(attendance("Kabir")).toHaveValue("present");
    expect(attendance("Diya")).toHaveValue("absent");
    await user.click(screen.getByRole("button", { name: "Save Attendance" }));
    await screen.findByText("Attendance saved for 2 students.");
    expect(repository.save.mock.calls[0][3].map((change) => change.studentId).sort()).toEqual(["c", "d"]);
    expect(read(context, schoolDate()).entries.a.status).toBe("absent");
    expect(read(context, schoolDate()).entries.b.status).toBe("holiday");
  });

  it("locks date/class/cancel while dirty and discards by reloading persisted records", async () => {
    const user = userEvent.setup();
    const { repository } = persistedRepository();
    render(<ParentControls repository={repository} />);
    await loaded();
    await waitFor(() => expect(screen.getByRole("button", { name: "Change class" })).toBeEnabled());
    const date = schoolDate();
    await user.selectOptions(attendance("Aarav"), "present");

    expect(screen.getByLabelText("Attendance date")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Change class" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel editor" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Attendance date"), { target: { value: "2026-10-01" } });
    expect(screen.getByLabelText("Attendance date")).toHaveValue(date);
    const leaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);

    await user.click(screen.getByRole("button", { name: "Discard changes and reload" }));
    await waitFor(() => expect(attendance("Aarav")).toHaveValue("absent"));
    expect(repository.save).not.toHaveBeenCalled();
    expect(repository.load).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("Attendance date")).toBeEnabled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Change class" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Cancel editor" })).toBeEnabled();
    const cleanLeaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanLeaving);
    expect(cleanLeaving.defaultPrevented).toBe(false);
    fireEvent.change(screen.getByLabelText("Attendance date"), { target: { value: "2026-10-01" } });
    await waitFor(() => expect(repository.load).toHaveBeenLastCalledWith(context, "2026-10-01"));
  });

  it("retains the correction and dirty lock when saving rejects", async () => {
    const user = userEvent.setup();
    const { repository, read } = persistedRepository();
    repository.save.mockRejectedValueOnce(new Error("Connection interrupted."));
    render(<AttendanceEditor context={context} userId={userId} repository={repository} />);
    await loaded();
    await user.selectOptions(attendance("Aarav"), "late");
    await user.click(screen.getByRole("button", { name: "Save Attendance" }));
    await screen.findByText(/Connection interrupted.*Your edits are kept/);

    expect(attendance("Aarav")).toHaveValue("late");
    expect(screen.getByLabelText("Attendance date")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save Attendance" })).toBeEnabled();
    expect(read(context, schoolDate()).entries.a.status).toBe("absent");
    await user.click(screen.getByRole("button", { name: "Save Attendance" }));
    await screen.findByText("Attendance saved for 1 student.");
    expect(read(context, schoolDate()).entries.a.status).toBe("late");
  });

  it("guards duplicate save and locks every edit/context/discard control during the write", async () => {
    const user = userEvent.setup();
    const { repository, commit } = persistedRepository();
    const pending = deferred<AttendanceSaveResult>();
    repository.save.mockImplementationOnce(() => pending.promise);
    render(<ParentControls repository={repository} />);
    await loaded();
    await user.selectOptions(attendance("Aarav"), "late");
    const save = screen.getByRole("button", { name: "Save Attendance" });
    act(() => {
      fireEvent.click(save);
      fireEvent.click(save);
    });

    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Attendance date")).toBeDisabled();
    for (const select of screen.getAllByRole("combobox")) expect(select).toBeDisabled();
    for (const name of ["Mark unmarked present", "Mark holiday", "Discard changes and reload", "Change class", "Cancel editor", "Saving attendance…"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    expect(register()).toHaveAttribute("aria-busy", "true");

    await act(async () => {
      pending.resolve(commit(context, schoolDate(), repository.save.mock.calls[0][3]));
    });
    await screen.findByText("Attendance saved for 1 student.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Change class" })).toBeEnabled());
    expect(attendance("Aarav")).toBeEnabled();
    expect(screen.getByLabelText("Attendance date")).toBeEnabled();
  });

  it("ignores an older load resolving after the selected date has changed", async () => {
    const { repository } = persistedRepository();
    const older = deferred<AttendanceSnapshot>();
    const newer = deferred<AttendanceSnapshot>();
    repository.load.mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
    render(<AttendanceEditor context={context} userId={userId} repository={repository} />);
    fireEvent.change(screen.getByLabelText("Attendance date"), { target: { value: "2026-10-01" } });
    await waitFor(() => expect(repository.load).toHaveBeenCalledTimes(2));
    const latest = initialSnapshot();
    latest.entries.a.status = "late";
    await act(async () => { newer.resolve(latest); });
    await loaded();
    expect(attendance("Aarav")).toHaveValue("late");

    const stale = initialSnapshot();
    stale.entries.a.status = "holiday";
    await act(async () => { older.resolve(stale); });
    expect(screen.getByLabelText("Attendance date")).toHaveValue("2026-10-01");
    expect(attendance("Aarav")).toHaveValue("late");
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("does not enable writes on load failure and can recover by explicitly reloading", async () => {
    const user = userEvent.setup();
    const { repository } = persistedRepository();
    repository.load.mockRejectedValueOnce(new Error("Register unavailable."));
    render(<AttendanceEditor context={context} userId={userId} repository={repository} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Saving is disabled until the register loads successfully.");
    expect(screen.getByRole("button", { name: "Save Attendance" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Mark unmarked present" })).toBeDisabled();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reload register" }));
    await loaded();
    expect(attendance("Aarav")).toHaveValue("absent");
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("stages a holiday explicitly and can correct a persisted holiday without changing the other pupils", async () => {
    const user = userEvent.setup();
    const { repository, read } = persistedRepository();
    render(<AttendanceEditor context={context} userId={userId} repository={repository} />);
    await loaded();
    await user.click(screen.getByRole("button", { name: "Mark holiday" }));
    expect(repository.save).not.toHaveBeenCalled();
    expect(read(context, schoolDate()).entries.a.status).toBe("absent");
    for (const name of ["Aarav", "Anaya", "Kabir", "Diya"]) expect(attendance(name)).toHaveValue("holiday");
    await user.click(screen.getByRole("button", { name: "Save Attendance" }));
    await screen.findByText("Attendance saved for 3 students.");
    expect(repository.save.mock.calls[0][3].map((change) => change.studentId).sort()).toEqual(["a", "c", "d"]);

    await user.selectOptions(attendance("Kabir"), "present");
    await user.click(screen.getByRole("button", { name: "Save Attendance" }));
    await screen.findByText("Attendance saved for 1 student.");
    expect(repository.save.mock.calls[1][3]).toEqual([{
      studentId: "c", status: "present", expected: { student_id: "c", status: "holiday", remarks: null },
    }]);
    expect(read(context, schoolDate()).entries.c.status).toBe("present");
    expect(read(context, schoolDate()).entries.a.status).toBe("holiday");
    expect(read(context, schoolDate()).entries.b.status).toBe("holiday");
  });

  it("keeps failed edits but never resubmits rows that a partial save already committed", async () => {
    const user = userEvent.setup();
    const { repository, commit, read } = persistedRepository();
    repository.save.mockImplementationOnce(async (scope, date, _actor, changes) => ({
      ...commit(scope, date, changes.filter((change) => change.studentId === "a")),
      failures: [{ studentId: "b", message: "This record changed. Reload before correcting it." }],
    }));
    render(<AttendanceEditor context={context} userId={userId} repository={repository} />);
    await loaded();
    await user.selectOptions(attendance("Aarav"), "late");
    await user.selectOptions(attendance("Anaya"), "absent");
    await user.click(screen.getByRole("button", { name: "Save Attendance" }));
    await screen.findByText(/1 saved; 1 could not be saved.*Your remaining edits are kept/);
    expect(read(context, schoolDate()).entries.a.status).toBe("late");
    expect(read(context, schoolDate()).entries.b.status).toBe("holiday");
    expect(attendance("Anaya")).toHaveValue("absent");
    expect(screen.getByText(/1 unsaved change\./)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save Attendance" }));
    await screen.findByText("Attendance saved for 1 student.");
    expect(repository.save.mock.calls[1][3]).toEqual([{
      studentId: "b", status: "absent", expected: { student_id: "b", status: "holiday", remarks: null },
    }]);
    expect(read(context, schoolDate()).entries.b.status).toBe("absent");
  });

  it("does not discard the current loaded roster when a refresh completes during a save", async () => {
    const user = userEvent.setup();
    const { repository, commit, store, key } = persistedRepository();
    const pending = deferred<AttendanceSaveResult>();
    repository.save.mockImplementationOnce(() => pending.promise);
    const view = render(<AttendanceEditor context={context} userId={userId} repository={repository} />);
    await loaded();
    await user.selectOptions(attendance("Aarav"), "late");
    await user.click(screen.getByRole("button", { name: "Save Attendance" }));
    const freshRoster = initialSnapshot();
    freshRoster.students.push({ id: "e", first_name: "Reyansh", admission_no: "A-5" });
    store.set(key(context, schoolDate()), structuredClone(freshRoster));
    repository.load.mockResolvedValueOnce(freshRoster);
    view.rerender(<AttendanceEditor context={context} userId={userId} repository={repository} rosterVersion={1} />);
    await screen.findByRole("combobox", { name: "Attendance for Reyansh" });
    await act(async () => { pending.resolve(commit(context, schoolDate(), repository.save.mock.calls[0][3])); });
    await screen.findByRole("combobox", { name: "Attendance for Reyansh" });
    expect(screen.queryByText("Loading attendance register…")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Attendance for Reyansh" })).toBeInTheDocument();
    expect(attendance("Aarav")).toHaveValue("late");
  });
});

describe("schoolDate", () => {
  it.each([
    ["2026-11-01T18:29:59.000Z", "2026-11-01"],
    ["2026-11-01T18:30:00.000Z", "2026-11-02"],
    ["2026-11-01T23:59:59.000Z", "2026-11-02"],
    ["2026-12-31T18:30:00.000Z", "2027-01-01"],
  ])("uses the Indian school day for %s regardless of host timezone", (instant, expected) => {
    expect(schoolDate(new Date(instant))).toBe(expected);
  });
});
