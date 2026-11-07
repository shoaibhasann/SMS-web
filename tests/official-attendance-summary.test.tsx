import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OfficialAttendanceSummary } from "@/components/family/official-attendance-summary";
import { FamilyAttendanceSummaryError, type FamilyAttendanceSummary } from "@/lib/attendance/family-summary";
import { attendanceSummaryFixture as fixture, summaryOwner as uid, summaryStudent as student, summaryId as id, summaryPeriod, emptySummaryPeriod, attendanceReportContextFixture as contextFixture, previousAttendanceSummaryFixture as previousFixture, previousSummaryYear } from "./attendance-summary-fixture";
const { load, context, report } = vi.hoisted(() => ({ load: vi.fn(), context: vi.fn(), report: vi.fn() }));
vi.mock("@/lib/attendance/family-summary", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/attendance/family-summary")>(), loadFamilyAttendanceSummary: load, loadFamilyAttendanceReportContext: context, loadFamilyAttendanceReport: report }));
let authChanged: (event: string, session: Session | null) => void;
const unsubscribe = vi.fn();
const client = { auth: { onAuthStateChange: (callback: typeof authChanged) => { authChanged = callback; return { data: { subscription: { unsubscribe } } }; } } } as unknown as SupabaseClient;
const props = { client, userId: uid, student, role: "parent" as const };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; }); return { promise, resolve };
}
beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); load.mockReset().mockResolvedValue(fixture()); context.mockReset().mockResolvedValue(contextFixture()); report.mockReset().mockResolvedValue(previousFixture()); unsubscribe.mockClear(); });
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
    context.mockResolvedValue(contextFixture({ current_session_state: session_state, current_year_id: session_state === "unsupported" ? id(4) : null, years: [previousSummaryYear] }));
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
    context.mockResolvedValueOnce(contextFixture({ student_id: id(8) }));
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
  it("selects an enrolled previous year, resets its month and labels the completed reporting cutoff", async () => {
    render(<OfficialAttendanceSummary {...props} />); await screen.findByRole("article", { name: "Monthly attendance" });
    fireEvent.change(screen.getByRole("combobox", { name: "Academic year" }), { target: { value: previousSummaryYear.id } });
    expect(screen.queryAllByText("70%")).toHaveLength(0); expect(screen.queryByText(/2026–2027 · Through/)).not.toBeInTheDocument();
    await screen.findByText(/2025–2026 · Previous academic year · Through year end 31 Mar 2026/);
    expect(report).toHaveBeenCalledWith(client, uid, student, "parent", previousSummaryYear.id, null, expect.any(AbortSignal));
    expect(screen.getByRole("combobox", { name: "Reporting month" })).toHaveValue("2026-03-01");
    expect(within(screen.getByRole("combobox", { name: "Reporting month" })).queryByText("November 2026")).not.toBeInTheDocument();
    expect(screen.getByText(/Previous-year reports reflect the current verified school records/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Academic year" }), { target: { value: "" } });
    await screen.findByText(/2026–2027 · Through 7 Nov 2026/); expect(load).toHaveBeenLastCalledWith(client, uid, student, "parent", null, expect.any(AbortSignal));
  });
  it("leaves a missing current session explicit while letting the user select previous enrolled years", async () => {
    context.mockResolvedValue(contextFixture({ current_year_id: null, current_session_state: "missing", years: [previousSummaryYear] }));
    load.mockResolvedValue(fixture({ session_state: "missing", year: null, month_summary: null, year_summary: null }));
    render(<OfficialAttendanceSummary {...props} />); expect(await screen.findByText(/no current academic session/)).toBeInTheDocument();
    expect(report).not.toHaveBeenCalled(); expect(screen.getByRole("combobox", { name: "Academic year" })).toHaveValue("");
    fireEvent.change(screen.getByRole("combobox", { name: "Academic year" }), { target: { value: previousSummaryYear.id } });
    expect(await screen.findByText(/Through year end 31 Mar 2026/)).toBeInTheDocument();
  });
  it("aborts a pending previous-year read on rapid year switch and suppresses its late result", async () => {
    render(<OfficialAttendanceSummary {...props} />); await screen.findByRole("article", { name: "Monthly attendance" });
    const old = deferred<FamilyAttendanceSummary>(); report.mockReturnValueOnce(old.promise);
    fireEvent.change(screen.getByRole("combobox", { name: "Academic year" }), { target: { value: previousSummaryYear.id } });
    const signal = report.mock.calls[0][6] as AbortSignal;
    fireEvent.change(screen.getByRole("combobox", { name: "Academic year" }), { target: { value: "" } });
    expect(signal.aborted).toBe(true); await screen.findByText(/2026–2027 · Through/);
    await act(async () => old.resolve(previousFixture())); expect(screen.queryByText(/Through year end/)).not.toBeInTheDocument();
  });
  it("hides the previous report label and percentage on a refresh error and omits the self history link", async () => {
    render(<OfficialAttendanceSummary {...props} showHistoryLink={false} />); await screen.findByRole("article", { name: "Monthly attendance" });
    load.mockRejectedValueOnce(new FamilyAttendanceSummaryError("Report unavailable.")); fireEvent.click(screen.getByRole("button", { name: "Refresh official attendance" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Report unavailable."); expect(screen.queryAllByText("70%")).toHaveLength(0);
    expect(screen.queryByText(/2026–2027 · Through/)).not.toBeInTheDocument(); expect(screen.queryByRole("link", { name: "View attendance history" })).not.toBeInTheDocument();
  });
  it("keeps a separately verified catalog available when the current report is unavailable", async () => {
    load.mockRejectedValueOnce(new FamilyAttendanceSummaryError("Current report unavailable.")); render(<OfficialAttendanceSummary {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Current report unavailable.");
    fireEvent.change(screen.getByRole("combobox", { name: "Academic year" }), { target: { value: previousSummaryYear.id } });
    expect(await screen.findByText(/Through year end 31 Mar 2026/)).toBeInTheDocument();
  });
  it("clears the catalog after report access denial and suppresses a later catalog success", async () => {
    const pending = deferred<ReturnType<typeof contextFixture>>(); context.mockReturnValueOnce(pending.promise);
    load.mockRejectedValueOnce(new FamilyAttendanceSummaryError("Child access revoked.", "access")); render(<OfficialAttendanceSummary {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Child access revoked.");
    const signal = context.mock.calls[0][4] as AbortSignal; expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(contextFixture())); expect(screen.queryByRole("combobox", { name: "Academic year" })).not.toBeInTheDocument(); expect(screen.queryAllByText("70%")).toHaveLength(0);
  });
  it("shows selection unavailable rather than falling back if a previous year disappears", async () => {
    render(<OfficialAttendanceSummary {...props} />); await screen.findByRole("article", { name: "Monthly attendance" });
    context.mockResolvedValueOnce(contextFixture({ years: contextFixture().years.filter(year => year.is_current) }));
    fireEvent.change(screen.getByRole("combobox", { name: "Academic year" }), { target: { value: previousSummaryYear.id } });
    expect(await screen.findByRole("alert")).toHaveTextContent("selected academic year changed"); expect(screen.queryAllByText("70%")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Use current session month" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Academic year" })).toHaveValue(previousSummaryYear.id); expect(screen.getByRole("option", { name: "Selected year unavailable" })).toBeInTheDocument();
  });
  it("rejects a current-year activation race between the catalog and report without showing old rates", async () => {
    context.mockResolvedValue(contextFixture({ current_year_id: id(9), years: [{ ...fixture().year!, id: id(9), is_current: true }, previousSummaryYear] }));
    render(<OfficialAttendanceSummary {...props} />); expect(await screen.findByRole("alert")).toHaveTextContent("selected academic year changed");
    expect(screen.queryAllByText("70%")).toHaveLength(0); expect(screen.queryByText(/Through 7 Nov/)).not.toBeInTheDocument();
  });
  it("rejects contradictory current-session outcomes but keeps valid archive choices", async () => {
    context.mockResolvedValue(contextFixture({ current_year_id: null, current_session_state: "missing", years: [previousSummaryYear] }));
    render(<OfficialAttendanceSummary {...props} />); expect(await screen.findByRole("alert")).toHaveTextContent("selected academic year changed");
    expect(screen.queryAllByText("70%")).toHaveLength(0); expect(screen.getByRole("option", { name: /2025–2026/ })).toBeInTheDocument();
  });
  it("preserves the legacy future-current not-started report while excluding future month choices", async () => {
    const year = { ...fixture().year!, start_date: "2027-04-01", end_date: "2028-03-31" }, empty = emptySummaryPeriod("not_started");
    context.mockResolvedValue(contextFixture({ years: [previousSummaryYear] })); load.mockResolvedValue(fixture({ year, month: "2027-04-01", month_summary: empty, year_summary: empty }));
    render(<OfficialAttendanceSummary {...props} />); expect(await screen.findAllByText("No elapsed school days")).toHaveLength(2);
    expect(screen.getByRole("combobox", { name: "Reporting month" })).toBeDisabled(); expect(screen.getByRole("option", { name: "No elapsed reporting months" })).toBeInTheDocument(); expect(report).not.toHaveBeenCalled();
  });
  it("restores only the explicitly chosen previous year on hard remount and clears it when Current is chosen", async () => {
    const first = render(<OfficialAttendanceSummary {...props} />); await screen.findByRole("article", { name: "Monthly attendance" });
    fireEvent.change(screen.getByRole("combobox", { name: "Academic year" }), { target: { value: previousSummaryYear.id } });
    await screen.findByText(/Through year end 31 Mar 2026/); first.unmount(); const legacyCalls = load.mock.calls.length;
    const second = render(<OfficialAttendanceSummary {...props} />); await screen.findByText(/Through year end 31 Mar 2026/);
    expect(load).toHaveBeenCalledTimes(legacyCalls); expect(report).toHaveBeenLastCalledWith(client, uid, student, "parent", previousSummaryYear.id, null, expect.any(AbortSignal));
    fireEvent.change(screen.getByRole("combobox", { name: "Academic year" }), { target: { value: "" } }); await screen.findByText(/2026–2027 · Through/); second.unmount();
    render(<OfficialAttendanceSummary {...props} />); await screen.findByText(/2026–2027 · Through/); expect(load).toHaveBeenCalledTimes(legacyCalls + 2);
  });
  it("never inherits a stored year from another child or account", async () => {
    const first = render(<OfficialAttendanceSummary {...props} />); await screen.findByRole("article", { name: "Monthly attendance" });
    fireEvent.change(screen.getByRole("combobox", { name: "Academic year" }), { target: { value: previousSummaryYear.id } }); await screen.findByText(/Through year end/); first.unmount();
    const otherStudent = { ...student, id: id(8) }; context.mockResolvedValue(contextFixture({ student_id: otherStudent.id })); load.mockResolvedValue(fixture({ student_id: otherStudent.id }));
    const second = render(<OfficialAttendanceSummary {...props} student={otherStudent} />); await screen.findByText(/2026–2027 · Through/); expect(load).toHaveBeenLastCalledWith(client, uid, otherStudent, "parent", null, expect.any(AbortSignal)); second.unmount();
    context.mockResolvedValue(contextFixture({ user_id: id(9) })); load.mockResolvedValue(fixture({ user_id: id(9) })); render(<OfficialAttendanceSummary {...props} userId={id(9)} />);
    await screen.findByText(/2026–2027 · Through/); expect(load).toHaveBeenLastCalledWith(client, id(9), student, "parent", null, expect.any(AbortSignal)); expect(report).toHaveBeenCalledTimes(1);
  });
  it("keeps reports usable when session storage reads and writes are denied", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("blocked"); });
    render(<OfficialAttendanceSummary {...props} />); await screen.findByText(/2026–2027 · Through/);
    fireEvent.change(screen.getByRole("combobox", { name: "Academic year" }), { target: { value: previousSummaryYear.id } }); await screen.findByText(/Through year end/);
    fireEvent.change(screen.getByRole("combobox", { name: "Academic year" }), { target: { value: "" } }); expect(await screen.findByText(/2026–2027 · Through/)).toBeInTheDocument();
  });
  it("refreshes the current child's read on refocus without changing inbox read state", async () => {
    render(<OfficialAttendanceSummary {...props} />); await screen.findByRole("article", { name: "Monthly attendance" }); fireEvent.focus(window);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(load.mock.calls.every(call => call[2].id === student.id)).toBe(true);
  });
});
