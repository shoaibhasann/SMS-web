import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AttendanceEditor } from "../components/academic/attendance-editor";
import { schoolDate, type AttendanceContext, type AttendanceRepository, type AttendanceSnapshot } from "../lib/attendance/types";
import { findAttendanceGroup, rowLocked, statusChoice, chooseStatus } from "./attendance-register-helpers";

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => { throw new Error("Attendance tests must use the injected repository."); },
}));

const context: AttendanceContext = { schoolId: "school-a", academicYearId: "year-a", classId: "class-a", sectionId: "section-a" };

function repository(day: Partial<NonNullable<AttendanceSnapshot["day"]>>, entries: AttendanceSnapshot["entries"] = {}) {
  const snapshot: AttendanceSnapshot = {
    day: { day: schoolDate(), server_today: schoolDate(), revision: 0, configured: false, is_working: null,
      source: "unconfigured", label: null, policy_revision: null, exception_revision: null, correction_window_days: null,
      can_request_correction: true, can_mark_holiday: true, ...day },
    students: [
      { id: "a", first_name: "Aarav", admission_no: "A-1", roll_no: "1" },
      { id: "b", first_name: "Anaya", admission_no: "A-2", roll_no: "2" },
      { id: "c", first_name: "Kabir", admission_no: "A-3", roll_no: "3" },
    ],
    entries,
  };
  return {
    load: vi.fn<AttendanceRepository["load"]>(async () => structuredClone(snapshot)),
    save: vi.fn<AttendanceRepository["save"]>(async (_scope, _date, _actor, changes) => ({
      saved: changes.map((change) => ({ student_id: change.studentId, status: change.status, remarks: null })), failures: [],
    })),
  };
}
const workingDay = { configured: true, is_working: true, source: "weekday" as const, label: null, policy_revision: 1, correction_window_days: 2 };

describe("register Holiday controls on a configured school working day", () => {
  it("hides Mark holiday and the Holiday choice and points to the school calendar", async () => {
    const repo = repository(workingDay);
    render(<AttendanceEditor context={context} userId="admin-a" repository={repo} />);
    await screen.findByRole("radiogroup", { name: "Attendance for Aarav" });
    expect(screen.getByRole("button", { name: "Mark unmarked present" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark holiday" })).not.toBeInTheDocument();
    expect(statusChoice("Aarav", "holiday")).not.toBeInTheDocument();
    expect(screen.getByText(/add a holiday exception in Settings > Calendar & daily attendance rules/)).toBeInTheDocument();
  });

  it("still lets Office move a legacy Holiday mark to a real status", async () => {
    const user = userEvent.setup();
    const repo = repository(workingDay, { b: { student_id: "b", status: "holiday", remarks: null } });
    render(<AttendanceEditor context={context} userId="admin-a" repository={repo} />);
    await findAttendanceGroup("Anaya");
    expect(rowLocked("Anaya")).toBe(false);
    await chooseStatus(user, "Anaya", "present");
    await user.click(screen.getByRole("button", { name: "Save Attendance" }));
    await screen.findByText("Attendance saved for 1 student.");
    expect(repo.save.mock.calls[0][3]).toEqual([{ studentId: "b", status: "present", expected: { student_id: "b", status: "holiday", remarks: null } }]);
  });
});

describe("register bulk actions with the Office student search", () => {
  it("marks only the searched pupils present and disables the register-wide Holiday while searching", async () => {
    const user = userEvent.setup();
    const repo = repository({});
    render(<AttendanceEditor context={context} userId="admin-a" repository={repo} studentSearch />);
    await screen.findByRole("radiogroup", { name: "Attendance for Aarav" });
    await user.type(screen.getByRole("searchbox"), "Kabir");
    expect(screen.queryByRole("radiogroup", { name: "Attendance for Aarav" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mark unmarked present" }));
    expect(screen.getByText(/1 unsaved change\./)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save Attendance" }));
    await screen.findByText("Attendance saved for 1 student.");
    expect(repo.save.mock.calls[0][3]).toEqual([{ studentId: "c", status: "present", expected: null }]);
    expect(screen.getByRole("button", { name: "Mark holiday" })).toBeDisabled();
    expect(screen.getByText("Clear the search to mark the whole register as a holiday.")).toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox"));
    expect(screen.getByRole("button", { name: "Mark holiday" })).toBeEnabled();
    expect(screen.queryByText("Clear the search to mark the whole register as a holiday.")).not.toBeInTheDocument();
  });
});

describe("register edges after the working-day Holiday guard", () => {
  it("disables Mark unmarked present when no shown pupil is unmarked", async () => {
    const user = userEvent.setup();
    const repo = repository({}, { a: { student_id: "a", status: "present", remarks: null } });
    render(<AttendanceEditor context={context} userId="admin-a" repository={repo} studentSearch />);
    await screen.findByRole("radiogroup", { name: "Attendance for Aarav" });
    const bulk = screen.getByRole("button", { name: "Mark unmarked present" });
    expect(bulk).toBeEnabled();
    await user.type(screen.getByRole("searchbox"), "Aarav");
    expect(bulk).toBeDisabled();
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "nobody");
    expect(bulk).toBeDisabled();
    await user.clear(screen.getByRole("searchbox"));
    await user.click(bulk);
    expect(bulk).toBeDisabled();
  });

  it("explains a Holiday mark the database refused because the day is a working day", async () => {
    const user = userEvent.setup();
    const repo = repository({});
    repo.save.mockResolvedValueOnce({ saved: [], failures: [{ studentId: "a", message: "new row violates check", code: "22023" }] });
    render(<AttendanceEditor context={context} userId="admin-a" repository={repo} />);
    await findAttendanceGroup("Aarav"); await chooseStatus(user, "Aarav", "holiday");
    await user.click(screen.getByRole("button", { name: "Save Attendance" }));
    expect(await screen.findByText(/Aarav: Holiday can only be marked on a school holiday\. Reload the register\./)).toBeInTheDocument();
  });

  it("shows the correction RPC's own 22023 reason instead of the Holiday working-day message", async () => {
    const user = userEvent.setup();
    const refusal = Object.assign(new Error("Correction reason must be 500 characters or fewer."), { code: "22023" });
    const repo = { ...repository({}), requestCorrection: vi.fn<NonNullable<AttendanceRepository["requestCorrection"]>>().mockRejectedValue(refusal) };
    render(<AttendanceEditor context={context} userId="teacher-a" repository={repo} />);
    await screen.findByRole("radiogroup", { name: "Attendance for Aarav" });
    fireEvent.change(screen.getByLabelText("Attendance date"), { target: { value: schoolDate(new Date(Date.now() - 86_400_000)) } });
    await findAttendanceGroup("Aarav"); await chooseStatus(user, "Aarav", "holiday");
    await user.type(screen.getByLabelText("Correction reason"), "School closed for rain.");
    await user.click(screen.getByRole("button", { name: "Request correction" }));
    expect(await screen.findByText(/Correction reason must be 500 characters or fewer\. Your edits are kept\./)).toBeInTheDocument();
    expect(screen.queryByText(/Holiday can only be marked/)).not.toBeInTheDocument();
    expect(repo.save).not.toHaveBeenCalled();
  });
});
