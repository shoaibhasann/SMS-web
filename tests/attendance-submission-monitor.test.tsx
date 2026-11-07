import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttendanceSubmissionMonitor } from "../components/admin/attendance-submission-monitor";

const { rpc, read, save, auth, signal } = vi.hoisted(() => ({
  rpc: vi.fn(), read: vi.fn(), save: vi.fn(), auth: vi.fn(), signal: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ rpc, auth: { onAuthStateChange: auth } }),
}));

const section = {
  section_id: "section", class_name: "Class 6", section_name: "A", expected_count: 2,
  marked_count: 1, unmarked_count: 1, status: "partial", is_pending: false,
};
function monitor(overrides: Record<string, unknown> = {}) {
  return { data: { day: "2026-11-05", as_of: "2026-11-05T02:00:00Z", cutoff_time: null, cutoff_at: null,
    revision: 0, can_edit: true, session_state: "active", roster_issue_count: 0, sections: [section], ...overrides }, error: null };
}

beforeEach(() => {
  vi.resetAllMocks();
  auth.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  signal.mockImplementation(() => ({ returns: read }));
  rpc.mockImplementation((name) => name === "get_attendance_submission_monitor" ? { abortSignal: signal }
    : { abortSignal: () => ({ returns: save }) });
  read.mockResolvedValue(monitor());
  save.mockResolvedValue({ data: { revision: 1, cutoff_time: "10:00" }, error: null });
});

afterEach(() => vi.useRealTimers());

describe("attendance submission monitor", () => {
  it("uses server counts and marks incomplete sections Pending only after the cutoff", async () => {
    read.mockResolvedValueOnce(monitor()).mockResolvedValueOnce(monitor({ cutoff_time: "10:00", sections: [{ ...section, is_pending: true }] }));
    const user = userEvent.setup();
    render(<AttendanceSubmissionMonitor schoolId="school" userId="admin" />);
    expect(await screen.findByText("Partial")).toBeInTheDocument();
    expect(screen.getByText("1 of 2 marked · 1 unmarked")).toBeInTheDocument();
    expect(screen.getByText(/Cutoff not configured/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Configure attendance cutoff" })).not.toBeInTheDocument();
    expect(rpc).toHaveBeenCalledExactlyOnceWith("get_attendance_submission_monitor", { p_school_id: "school" });
    await user.click(screen.getByRole("button", { name: "Refresh attendance progress" }));
    expect(await screen.findByText("Pending")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1 section has pending attendance after cutoff.");
  });

  it("keeps empty/invalid placements out of an all-clear state", async () => {
    read.mockResolvedValue(monitor({ roster_issue_count: 2, sections: [] }));
    render(<AttendanceSubmissionMonitor schoolId="school" userId="admin" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("2 roster records need a valid active class and section");
    expect(screen.getByText("Fix the student placements to see their attendance registers.")).toBeInTheDocument();
    expect(screen.queryByText("No enrolled sections need attendance today.")).not.toBeInTheDocument();
  });

  it("saves a scoped cutoff with the loaded revision and reason, then reloads progress", async () => {
    read.mockResolvedValueOnce(monitor({ revision: 4 })).mockResolvedValue(monitor({ revision: 5, cutoff_time: "10:00" }));
    save.mockResolvedValue({ data: { revision: 5, cutoff_time: "10:00" }, error: null });
    const busy = vi.fn();
    const user = userEvent.setup();
    render(<AttendanceSubmissionMonitor schoolId="school" userId="admin" settings onBusyChange={busy} />);
    await user.click(await screen.findByRole("button", { name: "Configure attendance cutoff" }));
    fireEvent.change(screen.getByLabelText("Daily cutoff (IST)"), { target: { value: "10:00" } });
    await user.type(screen.getByLabelText("Change reason"), "School approved the morning deadline.");
    await user.click(screen.getByRole("button", { name: "Save attendance cutoff" }));
    expect(rpc).toHaveBeenCalledWith("update_attendance_submission_cutoff", {
      p_school_id: "school", p_cutoff_time: "10:00", p_expected_revision: 4, p_reason: "School approved the morning deadline.",
    });
    expect(await screen.findByText(/Daily cutoff 10:00/)).toBeInTheDocument();
    expect(busy.mock.calls.map(([value]) => value)).toEqual([true, false]);
    expect(screen.queryByRole("form", { name: "Attendance cutoff settings" })).not.toBeInTheDocument();
  });

  it("lets the admin disable the cutoff and preserves a draft during background refresh", async () => {
    read.mockResolvedValue(monitor({ cutoff_time: "10:00", revision: 3 }));
    save.mockResolvedValue({ data: { cutoff_time: null, revision: 4 }, error: null });
    const user = userEvent.setup();
    render(<AttendanceSubmissionMonitor schoolId="school" userId="admin" settings />);
    await user.click(await screen.findByRole("button", { name: "Configure attendance cutoff" }));
    fireEvent.change(screen.getByLabelText("Daily cutoff (IST)"), { target: { value: "" } });
    await user.type(screen.getByLabelText("Change reason"), "Disable for the revised school policy.");
    fireEvent(document, new Event("visibilitychange"));
    await screen.findByText(/Daily cutoff 10:00/);
    expect(screen.getByLabelText("Change reason")).toHaveValue("Disable for the revised school policy.");
    await user.click(screen.getByRole("button", { name: "Save attendance cutoff" }));
    expect(rpc).toHaveBeenCalledWith("update_attendance_submission_cutoff", {
      p_school_id: "school", p_cutoff_time: null, p_expected_revision: 3, p_reason: "Disable for the revised school policy.",
    });
  });

  it("accepts an unchanged cutoff without expecting a new revision", async () => {
    read.mockResolvedValue(monitor({ cutoff_time: "10:00", revision: 3 }));
    save.mockResolvedValue({ data: { cutoff_time: "10:00", revision: 3 }, error: null });
    const user = userEvent.setup();
    render(<AttendanceSubmissionMonitor schoolId="school" userId="admin" settings />);
    await user.click(await screen.findByRole("button", { name: "Configure attendance cutoff" }));
    await user.type(screen.getByLabelText("Change reason"), "Confirm the current policy.");
    await user.click(screen.getByRole("button", { name: "Save attendance cutoff" }));
    await screen.findByRole("button", { name: "Configure attendance cutoff" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("refreshes at the upcoming server cutoff without another user action", async () => {
    vi.useFakeTimers();
    read.mockResolvedValueOnce(monitor({ cutoff_time: "07:30", cutoff_at: "2026-11-05T02:00:01Z" }))
      .mockResolvedValue(monitor({ cutoff_time: "07:30", as_of: "2026-11-05T02:00:02Z", cutoff_at: "2026-11-05T02:00:01Z",
        sections: [{ ...section, is_pending: true }] }));
    render(<AttendanceSubmissionMonitor schoolId="school" userId="admin" />);
    await act(async () => {});
    expect(screen.getByText("Partial")).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(1101));
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("keeps principal settings read-only and handles a stale admin revision visibly", async () => {
    const user = userEvent.setup();
    read.mockResolvedValueOnce(monitor({ can_edit: false }));
    const view = render(<AttendanceSubmissionMonitor schoolId="school" userId="principal" settings />);
    await screen.findByText("Partial");
    expect(screen.queryByRole("button", { name: "Configure attendance cutoff" })).not.toBeInTheDocument();
    view.unmount();
    save.mockResolvedValue({ data: null, error: { code: "40001" } });
    render(<AttendanceSubmissionMonitor schoolId="school" userId="admin" settings />);
    await user.click(await screen.findByRole("button", { name: "Configure attendance cutoff" }));
    await user.type(screen.getByLabelText("Change reason"), "Attempt an outdated setting.");
    await user.click(screen.getByRole("button", { name: "Save attendance cutoff" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The cutoff changed elsewhere.");
    expect(screen.getByRole("form", { name: "Attendance cutoff settings" })).toBeInTheDocument();
  });

  it("ignores old-school responses and hides progress after the session changes", async () => {
    let finish!: (result: ReturnType<typeof monitor>) => void;
    read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue(monitor({ sections: [] }));
    let changed!: (event: string, session: { user: { id: string } }) => void;
    auth.mockImplementation((callback) => {
      changed = callback;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });
    const view = render(<AttendanceSubmissionMonitor schoolId="school-one" userId="admin" settings />);
    const firstSignal = signal.mock.calls[0][0] as AbortSignal;
    view.rerender(<AttendanceSubmissionMonitor schoolId="school-two" userId="admin" settings />);
    expect(await screen.findByText("No enrolled sections need attendance today.")).toBeInTheDocument();
    expect(firstSignal.aborted).toBe(true);
    await act(async () => finish(monitor()));
    expect(screen.queryByText("Class 6 · A")).not.toBeInTheDocument();
    act(() => changed("SIGNED_IN", { user: { id: "other-account" } }));
    expect(screen.getByRole("alert")).toHaveTextContent("Your sign-in changed.");
    expect(within(screen.getByRole("region")).queryByRole("button", { name: "Configure attendance cutoff" })).not.toBeInTheDocument();
  });
});

describe("configured school closures", () => {
  it("explains a closed school day without a pending or complete-register claim", async () => {
    const value = monitor({ sections: [], calendar_day: { day: "2026-11-05", configured: true, is_working: false, label: "School holiday" } });
    read.mockResolvedValue(value);
    render(<AttendanceSubmissionMonitor schoolId="school" userId="admin" />);
    expect(await screen.findByText(/School holiday. No daily register is required/)).toHaveAttribute("role", "status");
    expect(screen.queryByText("Complete means every pupil in the current register has a saved mark.")).not.toBeInTheDocument();
    expect(screen.queryByText("Pending")).not.toBeInTheDocument();
  });
  it("rejects inconsistent closed-day metadata that also reports a pending roster", async () => {
    const value = monitor({ calendar_day: { day: "2026-11-05", configured: true, is_working: false, label: "School holiday" } });
    read.mockResolvedValue(value);
    render(<AttendanceSubmissionMonitor schoolId="school" userId="admin" />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("Partial")).not.toBeInTheDocument();
  });
});
