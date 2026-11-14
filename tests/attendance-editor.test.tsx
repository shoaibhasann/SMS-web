import { useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAttendanceRepository } from "../lib/attendance/repository";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AttendanceEditor } from "../components/academic/attendance-editor";
import { statusOf, rowLocked, statusChoice, chooseStatus } from "./attendance-register-helpers";
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

vi.mock("../lib/auth/staff-mfa", () => ({ boundMfaSession: vi.fn(async () => ({ access_token: "captured-owner-token" })) }));

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
    day: { day: schoolDate(), server_today: schoolDate(), revision: 0, configured: false, is_working: null,
      source: "unconfigured", label: null, policy_revision: null, exception_revision: null, correction_window_days: null,
      can_request_correction: true, can_mark_holiday: true },
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


async function loaded() {
  await screen.findByRole("radiogroup", { name: "Attendance for Aarav" });
}

describe("AttendanceEditor", () => {
  it("opens an earlier session at its last date and keeps its attendance read-only", async () => {
    const { repository: currentDay } = persistedRepository();
    const requestCorrection = vi.fn<NonNullable<AttendanceRepository["requestCorrection"]>>();
    const repository = { ...currentDay, requestCorrection };
    const dateLimits = { start: "2025-04-01", end: "2026-03-31" };
    render(<AttendanceEditor context={context} userId={userId} repository={repository} dateLimits={dateLimits} readOnly />);
    await loaded();

    const date = screen.getByLabelText("Attendance date");
    expect(date).toHaveValue(dateLimits.end);
    expect(date).toHaveAttribute("min", dateLimits.start);
    expect(date).toHaveAttribute("max", dateLimits.end);
    expect(repository.load).toHaveBeenLastCalledWith(context, dateLimits.end);
    expect(statusOf("Aarav")).toBe("absent");
    expect(rowLocked("Aarav")).toBe(true);
    expect(screen.queryByRole("button", { name: /Save Attendance|Request correction|Mark holiday/ })).not.toBeInTheDocument();

    fireEvent.change(date, { target: { value: "2025-03-31" } });
    expect(date).toHaveValue(dateLimits.end);
    expect(repository.load).toHaveBeenCalledTimes(1);
    fireEvent.change(date, { target: { value: dateLimits.start } });
    await loaded();
    expect(repository.load).toHaveBeenLastCalledWith(context, dateLimits.start);
    expect(repository.save).not.toHaveBeenCalled();
    expect(requestCorrection).not.toHaveBeenCalled();
  });

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
    await chooseStatus(user, "Aarav", "late");
    expect(rowLocked("Anaya")).toBe(true);
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
    expect(statusOf("Aarav")).toBe("absent");
    expect(currentDay.save).not.toHaveBeenCalled();
  });

  it("loads saved absence/holiday and leaves missing rows explicitly unmarked without writing", async () => {
    const { repository, read } = persistedRepository();
    render(<AttendanceEditor context={context} userId={userId} repository={repository} />);
    await loaded();

    expect(statusOf("Aarav")).toBe("absent");
    expect(statusOf("Anaya")).toBe("holiday");
    expect(statusOf("Kabir")).toBe("");
    expect(statusOf("Diya")).toBe("");
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

    await chooseStatus(user, "Aarav", "late");
    await chooseStatus(user, "Anaya", "present");
    await chooseStatus(user, "Anaya", "holiday");
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
    await chooseStatus(user, "Diya", "absent");
    await user.click(screen.getByRole("button", { name: "Mark unmarked present" }));

    expect(statusOf("Aarav")).toBe("absent");
    expect(statusOf("Anaya")).toBe("holiday");
    expect(statusOf("Kabir")).toBe("present");
    expect(statusOf("Diya")).toBe("absent");
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
    await chooseStatus(user, "Aarav", "present");

    expect(screen.getByLabelText("Attendance date")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Change class" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel editor" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Attendance date"), { target: { value: "2026-10-01" } });
    expect(screen.getByLabelText("Attendance date")).toHaveValue(date);
    const leaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);

    await user.click(screen.getByRole("button", { name: "Discard changes and reload" }));
    await waitFor(() => expect(statusOf("Aarav")).toBe("absent"));
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
    await chooseStatus(user, "Aarav", "late");
    await user.click(screen.getByRole("button", { name: "Save Attendance" }));
    await screen.findByText(/Connection interrupted.*Your edits are kept/);

    expect(statusOf("Aarav")).toBe("late");
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
    await chooseStatus(user, "Aarav", "late");
    const save = screen.getByRole("button", { name: "Save Attendance" });
    act(() => {
      fireEvent.click(save);
      fireEvent.click(save);
    });

    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Attendance date")).toBeDisabled();
    for (const choice of screen.getAllByRole("radio")) expect(choice).toBeDisabled();
    for (const name of ["Mark unmarked present", "Mark holiday", "Discard changes and reload", "Change class", "Cancel editor", "Saving attendance…"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    expect(register()).toHaveAttribute("aria-busy", "true");

    await act(async () => {
      pending.resolve(commit(context, schoolDate(), repository.save.mock.calls[0][3]));
    });
    await screen.findByText("Attendance saved for 1 student.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Change class" })).toBeEnabled());
    expect(rowLocked("Aarav")).toBe(false);
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
    expect(statusOf("Aarav")).toBe("late");

    const stale = initialSnapshot();
    stale.entries.a.status = "holiday";
    await act(async () => { older.resolve(stale); });
    expect(screen.getByLabelText("Attendance date")).toHaveValue("2026-10-01");
    expect(statusOf("Aarav")).toBe("late");
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
    expect(statusOf("Aarav")).toBe("absent");
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("offers a retry next to a load failure", async () => {
    const user = userEvent.setup();
    const { repository } = persistedRepository();
    repository.load.mockRejectedValueOnce(new Error("Register unavailable."));
    render(<AttendanceEditor context={context} userId={userId} repository={repository} />);
    expect(await screen.findByRole("alert")).toHaveClass("notice-error");
    await user.click(screen.getByRole("button", { name: "Retry loading register" }));
    await loaded();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("stages a holiday explicitly and can correct a persisted holiday without changing the other pupils", async () => {
    const user = userEvent.setup();
    const { repository, read } = persistedRepository();
    render(<AttendanceEditor context={context} userId={userId} repository={repository} />);
    await loaded();
    await user.click(screen.getByRole("button", { name: "Mark holiday" }));
    expect(repository.save).not.toHaveBeenCalled();
    expect(read(context, schoolDate()).entries.a.status).toBe("absent");
    for (const name of ["Aarav", "Anaya", "Kabir", "Diya"]) expect(statusOf(name)).toBe("holiday");
    await user.click(screen.getByRole("button", { name: "Save Attendance" }));
    await screen.findByText("Attendance saved for 3 students.");
    expect(repository.save.mock.calls[0][3].map((change) => change.studentId).sort()).toEqual(["a", "c", "d"]);

    await chooseStatus(user, "Kabir", "present");
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
    await chooseStatus(user, "Aarav", "late");
    await chooseStatus(user, "Anaya", "absent");
    await user.click(screen.getByRole("button", { name: "Save Attendance" }));
    const failure = await screen.findByText(/1 saved; 1 could not be saved.*Your remaining edits are kept/);
    expect(failure).toHaveAttribute("role", "alert");
    expect(failure).toHaveClass("notice-error");
    // The result shows inside the pinned Save bar, next to the button that was tapped.
    expect(failure.parentElement).toContainElement(screen.getByRole("button", { name: "Save Attendance" }));
    expect(failure.parentElement).toHaveClass("sticky", "lg:bottom-0");
    expect(read(context, schoolDate()).entries.a.status).toBe("late");
    expect(read(context, schoolDate()).entries.b.status).toBe("holiday");
    expect(statusOf("Anaya")).toBe("absent");
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
    await chooseStatus(user, "Aarav", "late");
    await user.click(screen.getByRole("button", { name: "Save Attendance" }));
    const freshRoster = initialSnapshot();
    freshRoster.students.push({ id: "e", first_name: "Reyansh", admission_no: "A-5" });
    store.set(key(context, schoolDate()), structuredClone(freshRoster));
    repository.load.mockResolvedValueOnce(freshRoster);
    view.rerender(<AttendanceEditor context={context} userId={userId} repository={repository} rosterVersion={1} />);
    await screen.findByRole("radiogroup", { name: "Attendance for Reyansh" });
    await act(async () => { pending.resolve(commit(context, schoolDate(), repository.save.mock.calls[0][3])); });
    await screen.findByRole("radiogroup", { name: "Attendance for Reyansh" });
    expect(screen.queryByText("Loading attendance register…")).not.toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Attendance for Reyansh" })).toBeInTheDocument();
    expect(statusOf("Aarav")).toBe("late");
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

describe("historical correction request conflicts", () => {
  it.each(["PT409", "40001"])("keeps the requested mark and reason until an explicit register reload, then uses the fresh mark revision (%s)", async (code) => {
    const user = userEvent.setup();
    const { repository: base, store, key } = persistedRepository();
    const pastDay = schoolDate(new Date(Date.now() - 86_400_000));
    const previous = initialSnapshot();
    previous.entries.a = { ...previous.entries.a, id: "mark-a", revision: 0 };
    store.set(key(context, pastDay), previous);
    let requests = 0;
    const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => {
      requests += 1;
      if (requests === 1) return { data: null, error: { code, message: "The before record is stale." } };
      return { data: args.p_request_id, error: null };
    });
    const actual = createAttendanceRepository({ rpc: (...args: Parameters<typeof rpc>) => ({ setHeader: () => rpc(...args) }) } as unknown as SupabaseClient, userId);
    const repository = { ...base, requestCorrection: actual.requestCorrection };
    const onCorrectionRequested = vi.fn();
    render(<AttendanceEditor context={context} userId={userId} repository={repository} onCorrectionRequested={onCorrectionRequested} />);
    await loaded();
    fireEvent.change(screen.getByLabelText("Attendance date"), { target: { value: pastDay } });
    await loaded();
    await chooseStatus(user, "Aarav", "late");
    await user.type(screen.getByLabelText("Correction reason"), "Gate register confirms late arrival.");
    await user.click(screen.getByRole("button", { name: "Request correction" }));
    await screen.findByText(/Attendance changed before the correction could be requested/);
    expect(statusOf("Aarav")).toBe("late");
    expect(screen.getByLabelText("Correction reason")).toHaveValue("Gate register confirms late arrival.");
    expect(screen.getByRole("button", { name: "Request correction" })).toBeDisabled();
    expect(onCorrectionRequested).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Correction requested\./)).not.toBeInTheDocument();

    const changed = structuredClone(previous);
    changed.entries.a = { ...changed.entries.a, status: "present", revision: 1 };
    store.set(key(context, pastDay), changed);
    await user.click(screen.getByRole("button", { name: "Discard changes and reload" }));
    await waitFor(() => expect(statusOf("Aarav")).toBe("present"));
    await chooseStatus(user, "Aarav", "late");
    await user.type(screen.getByLabelText("Correction reason"), "New request after checking the latest mark.");
    await user.click(screen.getByRole("button", { name: "Request correction" }));
    await screen.findByText(/Correction requested\./);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_expected_id: "mark-a", p_expected_revision: 0 });
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_expected_id: "mark-a", p_expected_revision: 1, p_reason: "New request after checking the latest mark." });
    expect(rpc.mock.calls[0][1].p_request_id).not.toBe(rpc.mock.calls[1][1].p_request_id);
    expect(onCorrectionRequested).toHaveBeenCalledTimes(1);
    expect(base.save).not.toHaveBeenCalled();
  });
});

describe("server-governed school calendar controls", () => {
  it("keeps retained rows readable on a closed date and exposes no attendance write controls", async () => {
    const { repository } = persistedRepository();
    repository.load.mockImplementation(async () => ({ ...initialSnapshot(), day: { ...initialSnapshot().day!, configured: true,
      is_working: false, source: "exception", label: "School holiday", revision: 2, policy_revision: 1, exception_revision: 2,
      correction_window_days: 7, can_mark_holiday: false, can_request_correction: false } }));
    render(<AttendanceEditor context={context} userId={userId} repository={repository} />);
    await loaded();
    expect(screen.getByText(/School holiday. No daily register is required/)).toBeInTheDocument();
    expect(statusOf("Aarav")).toBe("absent");
    expect(rowLocked("Aarav")).toBe(true);
    expect(screen.queryByRole("button", { name: "Save Attendance" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark holiday" })).not.toBeInTheDocument();
    expect(repository.save).not.toHaveBeenCalled();
  });
  it("does not give a Teacher Holiday controls or permission to replace an existing Holiday", async () => {
    const user = userEvent.setup(), { repository } = persistedRepository();
    repository.load.mockImplementation(async () => ({ ...initialSnapshot(), day: { ...initialSnapshot().day!, can_mark_holiday: false } }));
    render(<AttendanceEditor context={context} userId={userId} repository={repository} />);
    await loaded();
    expect(screen.queryByRole("button", { name: "Mark holiday" })).not.toBeInTheDocument();
    expect(statusOf("Anaya")).toBe("holiday");
    expect(rowLocked("Anaya")).toBe(true);
    expect(statusChoice("Aarav", "holiday")).not.toBeInTheDocument();
    await chooseStatus(user, "Aarav", "present");
    expect(statusOf("Aarav")).toBe("present");
    expect(repository.save).not.toHaveBeenCalled();
  });
  it("renders past history read-only when the server closes the Teacher correction window", async () => {
    const user = userEvent.setup(), { repository } = persistedRepository();
    const requestCorrection = vi.fn();
    repository.load.mockImplementation(async (_scope, selectedDay) => ({ ...initialSnapshot(), day: { ...initialSnapshot().day!,
      day: selectedDay, can_mark_holiday: false, can_request_correction: false } }));
    render(<AttendanceEditor context={context} userId={userId} repository={{ ...repository, requestCorrection }} />);
    await loaded();
    const past = schoolDate(new Date(Date.now() - 86_400_000));
    fireEvent.change(screen.getByLabelText("Attendance date"), { target: { value: past } });
    await screen.findByText(/Teacher correction requests are unavailable under the current school policy/);
    expect(rowLocked("Aarav")).toBe(true);
    expect(screen.queryByRole("button", { name: "Request correction" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reload register" }));
    expect(requestCorrection).not.toHaveBeenCalled();
  });
});
