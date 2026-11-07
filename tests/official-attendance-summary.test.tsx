import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OfficialAttendanceSummary } from "@/components/family/official-attendance-summary";
import { FamilyAttendanceSummaryError, type FamilyAttendanceSummary } from "@/lib/attendance/family-summary";
import { attendanceSummaryFixture as fixture, summaryOwner as uid, summaryStudent as student, summaryId as id, summaryPeriod, emptySummaryPeriod } from "./attendance-summary-fixture";
const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/attendance/family-summary", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/attendance/family-summary")>(), loadFamilyAttendanceSummary: load }));
let authChanged: (event: string, session: Session | null) => void;
const unsubscribe = vi.fn();
const client = { auth: { onAuthStateChange: (callback: typeof authChanged) => { authChanged = callback; return { data: { subscription: { unsubscribe } } }; } } } as unknown as SupabaseClient;
const props = { client, userId: uid, student, role: "parent" as const };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; }); return { promise, resolve };
}
beforeEach(() => { load.mockReset().mockResolvedValue(fixture()); unsubscribe.mockClear(); });
describe("official family attendance panel", () => {
  it("loads independently and renders authoritative month/session rates with formula and day counts", async () => {
    render(<OfficialAttendanceSummary {...props} />);
    const monthly = await screen.findByRole("article", { name: "Monthly attendance" });
    expect(within(monthly).getByText("70%")).toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "Academic session attendance" })).getByText("70%")).toBeInTheDocument();
    expect(screen.getByText(/Present\/Late = 1 day · Half Day = 0.5 · Leave\/Absent = 0/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Reporting month" })).toHaveValue("2026-11-01");
    expect(load).toHaveBeenCalledWith(client, uid, student, "parent", null, expect.any(AbortSignal));
    expect(screen.getByRole("link", { name: "View attendance history" })).toHaveAttribute("href", "/modules/attendance?view=guardian");
    expect(screen.getByText(/Through 7 Nov 2026 \(IST\)/)).toBeInTheDocument();
  });
  it("keeps neutral skeletons while identity or summary reads are pending", () => {
    const { container, rerender } = render(<OfficialAttendanceSummary {...props} student={null} loading />);
    expect(load).not.toHaveBeenCalled(); expect(container.querySelector('[data-skeleton="cards"]')).toBeInTheDocument();
    load.mockReturnValue(new Promise(() => {})); rerender(<OfficialAttendanceSummary {...props} />);
    expect(screen.queryByText("0%")).not.toBeInTheDocument(); expect(screen.queryByRole("article", { name: "Monthly attendance" })).not.toBeInTheDocument();
    expect(container.querySelector('[data-skeleton="cards"]')).toBeInTheDocument();
  });
  it("shows missing marks as pending and never fabricates absence or a partial percentage", async () => {
    const incomplete = summaryPeriod({ state: "attendance_incomplete", present_days: 1, marked_days: 4, unmarked_days: 1, earned_days: 2.5, percentage: null });
    load.mockResolvedValue(fixture({ month_summary: incomplete })); render(<OfficialAttendanceSummary {...props} />);
    const monthly = await screen.findByRole("article", { name: "Monthly attendance" });
    expect(within(monthly).getByText("Awaiting attendance")).toBeInTheDocument(); expect(within(monthly).getByText("—")).toBeInTheDocument();
    expect(within(monthly).getByText(/1 working day is unmarked/)).toBeInTheDocument(); expect(within(monthly).queryByText(/%/)).not.toBeInTheDocument();
  });
  it.each([
    ["calendar_unconfigured", "Calendar setup needed", /no saved school calendar/], ["enrollment_unverified", "Enrollment needs review", /verify enrollment dates/],
    ["inconsistent", "Records need review", /do not match the school register/], ["no_working_days", "No working days", /percentage does not apply/],
    ["not_enrolled", "No enrollment", /No verified enrollment/], ["not_started", "No elapsed school days", /No elapsed enrollment days/],
  ] as const)("explains %s without an official percentage", async (state, label, copy) => {
    load.mockResolvedValue(fixture({ month_summary: summaryPeriod({ state, percentage: null }) })); render(<OfficialAttendanceSummary {...props} />);
    const monthly = await screen.findByRole("article", { name: "Monthly attendance" });
    expect(within(monthly).getByText(label)).toBeInTheDocument(); expect(within(monthly).getByText(copy)).toBeInTheDocument(); expect(within(monthly).queryByText(/%/)).not.toBeInTheDocument();
  });
  it("publishes a real complete 0% but never uses zero for an unavailable session", async () => {
    load.mockResolvedValue(fixture({ month_summary: summaryPeriod({ present_days: 0, late_days: 0, half_days: 0, absent_days: 5, earned_days: 0, percentage: 0 }) }));
    render(<OfficialAttendanceSummary {...props} />); expect(await screen.findByText("0%")).toBeInTheDocument();
  });
  it.each(["enrollment_unverified", "not_enrolled", "not_started"] as const)("hides unverified zero-day counters for %s", async state => {
    const empty = emptySummaryPeriod(state); load.mockResolvedValue(fixture({ month_summary: empty, year_summary: empty })); render(<OfficialAttendanceSummary {...props} />);
    const monthly = await screen.findByRole("article", { name: "Monthly attendance" });
    expect(within(monthly).getByText("—")).toBeInTheDocument(); expect(within(monthly).queryByText("Working days")).not.toBeInTheDocument();
    expect(within(monthly).queryByText("Calculation details")).not.toBeInTheDocument(); expect(within(monthly).queryByText(/^0/)).not.toBeInTheDocument();
  });
  it.each([["missing", /no current academic session/], ["ambiguous", /multiple current academic sessions/], ["unsupported", /supported, verified date range/]] as const)("keeps a %s session explicit", async (session_state, copy) => {
    load.mockResolvedValue(fixture({ session_state, year: null, month_summary: null, year_summary: null })); render(<OfficialAttendanceSummary {...props} />);
    expect(await screen.findByText(copy)).toBeInTheDocument(); expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });
  it("changes month with bounded server requests and discards the previous rate while loading", async () => {
    render(<OfficialAttendanceSummary {...props} />); await screen.findByText("November 2026");
    const next = deferred<FamilyAttendanceSummary>(); load.mockReturnValueOnce(next.promise);
    fireEvent.change(screen.getByRole("combobox", { name: "Reporting month" }), { target: { value: "2026-10-01" } });
    await waitFor(() => expect(load).toHaveBeenLastCalledWith(client, uid, student, "parent", "2026-10-01", expect.any(AbortSignal)));
    expect(screen.queryAllByText("70%")).toHaveLength(0);
    await act(async () => next.resolve(fixture({ month: "2026-10-01", month_summary: summaryPeriod({ from: "2026-10-01", to: "2026-10-07" }) })));
    expect(await screen.findByRole("article", { name: "Monthly attendance" })).toBeInTheDocument();
  });
  it("retains a recovery path after a changed-session month or unavailable summary", async () => {
    load.mockRejectedValueOnce(new FamilyAttendanceSummaryError("Choose a month within the current academic session.", "validation")); render(<OfficialAttendanceSummary {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a month");
    fireEvent.click(screen.getByRole("button", { name: "Use current session month" }));
    expect(await screen.findByRole("article", { name: "Monthly attendance" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh official attendance" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  });
  it("aborts old-child reads and never shows their late percentage in the newly selected child", async () => {
    const old = deferred<FamilyAttendanceSummary>(); load.mockReturnValueOnce(old.promise);
    const { rerender } = render(<OfficialAttendanceSummary {...props} />);
    const signal = load.mock.calls[0][5] as AbortSignal;
    load.mockResolvedValueOnce(fixture({ student_id: id(8), month_summary: summaryPeriod({ percentage: 20, earned_days: 1, present_days: 1, late_days: 0, half_days: 0, absent_days: 4 }),
      year_summary: summaryPeriod({ percentage: 80, earned_days: 4, present_days: 3, late_days: 1, half_days: 0, absent_days: 1 }) }));
    rerender(<OfficialAttendanceSummary {...props} student={{ id: id(8), school_id: student.school_id }} />);
    expect(signal.aborted).toBe(true); expect(await screen.findByText("20%")).toBeInTheDocument();
    await act(async () => old.resolve(fixture())); expect(screen.queryByText("70%")).not.toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "Monthly attendance" })).getByText("20%")).toBeInTheDocument();
  });
  it("clears the summary on logout/account change and stops future reads until remount", async () => {
    render(<OfficialAttendanceSummary {...props} />); await screen.findByRole("article", { name: "Monthly attendance" });
    act(() => authChanged("SIGNED_OUT", null));
    expect(screen.getByRole("alert")).toHaveTextContent("Your sign-in changed"); expect(screen.queryByText("70%")).not.toBeInTheDocument();
    const count = load.mock.calls.length; fireEvent.focus(window); expect(load).toHaveBeenCalledTimes(count);
  });
  it("refreshes the current child's read on refocus without changing inbox read state", async () => {
    render(<OfficialAttendanceSummary {...props} />); await screen.findByRole("article", { name: "Monthly attendance" }); fireEvent.focus(window);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(load.mock.calls.every(call => call[2].id === student.id)).toBe(true);
  });
});
