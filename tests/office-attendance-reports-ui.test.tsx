import type { Session } from "@supabase/supabase-js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OfficialAttendanceReports } from "@/components/admin/official-attendance-reports";
import { OfficeAttendanceReportError, type OfficeAttendanceReport } from "@/lib/attendance/office-reports";
import { emptyOfficePeriod, officeClass, officeContext, officeId as id, officePeriod, officeReport, officeSchool as school, officeSection, officeUser as user, officeYear as year, oldOfficeYear } from "./office-attendance-fixture";
const { context, report, download, client } = vi.hoisted(() => ({ context: vi.fn(), report: vi.fn(), download: vi.fn(), client: { auth: { onAuthStateChange: vi.fn() } } }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => client }));
vi.mock("@/lib/attendance/office-reports", async original => ({ ...await original<typeof import("@/lib/attendance/office-reports")>(), loadOfficeAttendanceContext: context, loadOfficeAttendanceReport: report }));
vi.mock("@/lib/attendance/office-report-export", async original => ({ ...await original<typeof import("@/lib/attendance/office-report-export")>(), downloadOfficeAttendanceReportPdf: download }));
let changed: (event: string, session: Session | null) => void;
const unsubscribe = vi.fn();
function pending<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const props = { userId: user, role: "admin" as const };
beforeEach(() => {
  vi.restoreAllMocks(); sessionStorage.clear(); context.mockReset().mockResolvedValue(officeContext()); report.mockReset().mockResolvedValue(officeReport()); download.mockReset().mockResolvedValue(undefined); unsubscribe.mockClear();
  client.auth.onAuthStateChange.mockImplementation((callback: typeof changed) => { changed = callback; return { data: { subscription: { unsubscribe } } }; });
});
describe("Office official attendance workspace", () => {
  it("shows own-school current weighted pupil-days with real labels and shared PDF action", async () => {
    render(<OfficialAttendanceReports {...props} />);
    const monthly = await screen.findByRole("article", { name: "Monthly attendance" }); expect(within(monthly).getByText("90%")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "School" })).toBeDisabled(); expect(screen.getByRole("combobox", { name: "School" })).toHaveValue(school);
    expect(screen.getByRole("combobox", { name: "Academic year" })).toHaveValue(year.id); expect(screen.getByRole("combobox", { name: "Reporting month" })).toHaveValue("2026-11-01");
    expect(within(monthly).getByText("Working pupil-days")).toBeInTheDocument(); expect(screen.getAllByText("Closed pupil-days excluded")).toHaveLength(2); expect(screen.getAllByText(/individual percentages are not averaged/)).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" })); await waitFor(() => expect(download).toHaveBeenCalledWith(client, user, officeReport(), expect.any(AbortSignal)));
    expect(await screen.findByRole("status")).toHaveTextContent("PDF download started");
  });
  it("renders neutral skeletons until authorized context and report arrive", () => {
    context.mockReturnValue(new Promise(() => {})); const { container } = render(<OfficialAttendanceReports {...props} />);
    expect(container.querySelector('[data-skeleton="form"]')).toBeInTheDocument(); expect(screen.queryByText("0%")).not.toBeInTheDocument(); expect(report).not.toHaveBeenCalled();
  });
  it("keeps missing calendar/marks and unverified pupils explicit without a partial rate", async () => {
    const missing = officePeriod({ state: "attendance_incomplete", complete_pupils: 2, incomplete_pupils: 1, marked_days: 14, unmarked_days: 1, absent_days: 0, percentage: null });
    report.mockResolvedValue(officeReport({ month_summary: missing, year_summary: missing })); render(<OfficialAttendanceReports {...props} />);
    const monthly = await screen.findByRole("article", { name: "Monthly attendance" }); expect(within(monthly).getByText("Awaiting attendance")).toBeInTheDocument(); expect(within(monthly).getByText("—")).toBeInTheDocument(); expect(within(monthly).queryByText(/%/)).not.toBeInTheDocument();
    expect(within(monthly).getByText(/not assumed Absent/)).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Download PDF" })).toBeEnabled();
  });
  it("switches class and section with fresh explicit scope and clears old totals while waiting", async () => {
    render(<OfficialAttendanceReports {...props} />); await screen.findByRole("article", { name: "Monthly attendance" });
    const next = pending<OfficeAttendanceReport>(); report.mockReturnValueOnce(next.promise);
    fireEvent.change(screen.getByRole("combobox", { name: "Class" }), { target: { value: officeClass.id } }); expect(screen.queryByText("90%")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Section" })).toBeEnabled();
    await act(async () => next.resolve(officeReport({ scope: { class_id: officeClass.id, class_name: officeClass.name, section_id: null, section_name: null } })));
    expect(await screen.findByRole("article", { name: "Monthly attendance" })).toBeInTheDocument();
    report.mockResolvedValueOnce(officeReport({ scope: { class_id: officeClass.id, class_name: officeClass.name, section_id: officeSection.id, section_name: officeSection.name } }));
    fireEvent.change(screen.getByRole("combobox", { name: "Section" }), { target: { value: officeSection.id } });
    await waitFor(() => expect(report).toHaveBeenLastCalledWith(client, user, { schoolId: school, academicYearId: year.id, month: null, classId: officeClass.id, sectionId: officeSection.id }, expect.any(AbortSignal)));
  });
  it("restores scoped year/month/class preferences after refresh without caching totals", async () => {
    const expected = officeReport({ year: oldOfficeYear, month: "2026-03-01", month_summary: officePeriod({ from: "2026-03-01", to: "2026-03-07" }), year_summary: officePeriod({ from: "2026-03-01", to: "2026-03-07" }) });
    report.mockResolvedValue(expected); sessionStorage.setItem(`erp:office-attendance:${user}:admin:${school}`, JSON.stringify({ yearId: oldOfficeYear.id, month: "2026-03-01", classId: null, sectionId: null }));
    const { unmount } = render(<OfficialAttendanceReports {...props} />); await screen.findByRole("article", { name: "Monthly attendance" }); expect(screen.getByRole("combobox", { name: "Academic year" })).toHaveValue(oldOfficeYear.id);
    expect(screen.getByRole("combobox", { name: "Reporting month" })).toHaveValue("2026-03-01"); unmount();
    render(<OfficialAttendanceReports {...props} />); await screen.findByRole("article", { name: "Monthly attendance" }); expect(context).toHaveBeenCalledTimes(2); expect(report).toHaveBeenCalledTimes(2);
  });
  it("does not inherit another role's preferences or a stale school class", async () => {
    sessionStorage.setItem(`erp:office-attendance:${user}:principal:${school}`, JSON.stringify({ yearId: oldOfficeYear.id, month: "2026-03-01", classId: null, sectionId: null }));
    sessionStorage.setItem(`erp:office-attendance:${user}:admin:${school}`, JSON.stringify({ yearId: year.id, month: null, classId: id(99), sectionId: null }));
    render(<OfficialAttendanceReports {...props} />); await screen.findByRole("article", { name: "Monthly attendance" }); expect(screen.getByRole("combobox", { name: "Academic year" })).toHaveValue(year.id); expect(screen.getByRole("combobox", { name: "Class" })).toHaveValue("");
  });
  it("does not automatically choose an archive when current-year setup is unavailable", async () => {
    context.mockResolvedValue(officeContext({ current_year_id: null, years: [oldOfficeYear] })); render(<OfficialAttendanceReports {...props} />);
    expect(await screen.findByText(/Choose an available academic year/)).toBeInTheDocument(); expect(report).not.toHaveBeenCalled(); expect(screen.getByRole("combobox", { name: "Academic year" })).toHaveValue("");
  });
  it("keeps an empty scope explicit instead of showing a made-up zero percent", async () => {
    const empty = emptyOfficePeriod("no_pupils"); report.mockResolvedValue(officeReport({ pupil_count: 0, month_summary: empty, year_summary: empty })); render(<OfficialAttendanceReports {...props} />);
    const monthly = await screen.findByRole("article", { name: "Monthly attendance" }); expect(within(monthly).getByText("No enrolled pupils")).toBeInTheDocument(); expect(within(monthly).getByText("—")).toBeInTheDocument(); expect(within(monthly).queryByText("0%")).not.toBeInTheDocument();
  });
  it("clears catalog and totals when access disappears and offers a fresh check", async () => {
    report.mockRejectedValueOnce(new OfficeAttendanceReportError("Principal access removed", "access")); render(<OfficialAttendanceReports {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Principal access removed"); expect(screen.queryByRole("combobox", { name: "Academic year" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry access check" })); expect(await screen.findByRole("article", { name: "Monthly attendance" })).toBeInTheDocument();
  });
  it("cancels old-user work and removes both report and controls on logout", async () => {
    render(<OfficialAttendanceReports {...props} />); await screen.findByRole("article", { name: "Monthly attendance" });
    const result = pending<void>(); download.mockReturnValue(result.promise); fireEvent.click(screen.getByRole("button", { name: "Download PDF" })); const signal = download.mock.calls[0][3] as AbortSignal;
    act(() => changed("SIGNED_OUT", null)); expect(signal.aborted).toBe(true); expect(screen.getByRole("alert")).toHaveTextContent("Your sign-in changed"); expect(screen.queryByRole("combobox", { name: "Academic year" })).not.toBeInTheDocument();
    await act(async () => result.resolve()); expect(screen.queryByText(/PDF download started/)).not.toBeInTheDocument();
  });
  it("prevents duplicate exports and aborts pending PDF work on month changes", async () => {
    render(<OfficialAttendanceReports {...props} />); await screen.findByRole("article", { name: "Monthly attendance" });
    const result = pending<void>(); download.mockReturnValue(result.promise); fireEvent.click(screen.getByRole("button", { name: "Download PDF" })); fireEvent.click(screen.getByRole("button", { name: "Preparing PDF…" })); expect(download).toHaveBeenCalledTimes(1);
    const signal = download.mock.calls[0][3] as AbortSignal; report.mockResolvedValueOnce(officeReport({ month: "2026-10-01", month_summary: emptyOfficePeriod("not_started") }));
    fireEvent.change(screen.getByRole("combobox", { name: "Reporting month" }), { target: { value: "2026-10-01" } }); expect(signal.aborted).toBe(true);
    await act(async () => result.resolve()); await screen.findByRole("article", { name: "Monthly attendance" }); expect(screen.queryByText(/PDF download started/)).not.toBeInTheDocument();
  });
  it("allows a fresh export after a canceled old export settles late", async () => {
    render(<OfficialAttendanceReports {...props} />); await screen.findByRole("article", { name: "Monthly attendance" });
    const old = pending<void>(), fresh = pending<void>(); download.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" })); const oldSignal = download.mock.calls[0][3] as AbortSignal;
    fireEvent.click(screen.getByRole("button", { name: "Refresh official school attendance" })); await screen.findByRole("article", { name: "Monthly attendance" }); expect(oldSignal.aborted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" })); const newSignal = download.mock.calls[1][3] as AbortSignal;
    await act(async () => old.resolve()); expect(newSignal.aborted).toBe(false); expect(screen.getByRole("button", { name: "Preparing PDF…" })).toBeDisabled();
    await act(async () => fresh.resolve()); expect(await screen.findByRole("status")).toHaveTextContent("PDF download started");
  });
  it("reruns the school report on window focus only once the loaded report is five minutes old", async () => {
    let now = Date.parse("2026-11-11T04:00:00Z"); vi.spyOn(Date, "now").mockImplementation(() => now);
    render(<OfficialAttendanceReports {...props} />); await screen.findByRole("article", { name: "Monthly attendance" });
    expect(context).toHaveBeenCalledTimes(1); expect(report).toHaveBeenCalledTimes(1);
    now += 4 * 60_000; fireEvent.focus(window); fireEvent(document, new Event("visibilitychange"));
    expect(screen.getByRole("article", { name: "Monthly attendance" })).toBeInTheDocument(); expect(context).toHaveBeenCalledTimes(1); expect(report).toHaveBeenCalledTimes(1);
    now += 60_000; fireEvent.focus(window);
    await waitFor(() => expect(report).toHaveBeenCalledTimes(2)); expect(context).toHaveBeenCalledTimes(2);
  });
});
