import type { SupabaseClient } from "@supabase/supabase-js";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HistoricalCalendarImport } from "@/components/admin/historical-calendar-import";
import { SchoolAttendanceCalendar } from "@/components/admin/school-attendance-calendar";
import { SchoolCalendarError } from "@/lib/attendance/calendar";
import { calendarFixture, calendarId as id, calendarOwner as uid, calendarSchool as schoolId } from "./school-calendar-fixture";
import { historicalContext, historicalPreview, historicalRows, previewToken, yearId } from "./historical-calendar-fixture";
const { load, preview, save, calendarLoad, subscribe } = vi.hoisted(() => ({ load: vi.fn(), preview: vi.fn(), save: vi.fn(), calendarLoad: vi.fn(), subscribe: vi.fn() }));
vi.mock("@/lib/attendance/historical-calendar-import", async original => ({ ...await original<typeof import("@/lib/attendance/historical-calendar-import")>(), loadHistoricalCalendarContext: load, previewHistoricalCalendar: preview, importHistoricalCalendar: save }));
vi.mock("@/lib/attendance/calendar", async original => ({ ...await original<typeof import("@/lib/attendance/calendar")>(), loadSchoolAttendanceCalendar: calendarLoad }));
const client = { auth: { onAuthStateChange: subscribe } } as unknown as SupabaseClient, onLock = vi.fn(), onImported = vi.fn();
const csv = "date,status,label\n2026-11-01,working,Approved working day\n2026-11-02,holiday,School holiday";
const callbacks = new Set<(event: string, session: { user: { id: string } } | null) => void>();
function file(text = csv, bytes?: Promise<ArrayBuffer>) {
  const selected = new File([text], "calendar.csv", { type: "text/csv" });
  Object.defineProperty(selected, "arrayBuffer", { value: () => bytes ?? Promise.resolve(new TextEncoder().encode(text).buffer) }); return selected;
}
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(complete => { resolve = complete; }), resolve }; }
const element = (userId = uid, selectedSchool = schoolId) => <HistoricalCalendarImport client={client} userId={userId} schoolId={selectedSchool} disabled={false} onLock={onLock} onImported={onImported} />;
async function draft(user: ReturnType<typeof userEvent.setup>, value = csv) {
  await user.click(await screen.findByRole("button", { name: "Import historical CSV" }));
  await user.selectOptions(await screen.findByLabelText("Historical academic year"), yearId);
  await user.upload(screen.getByLabelText("Calendar CSV file"), file(value));
  await screen.findByText(/calendar.csv/);
}
async function reviewed(user: ReturnType<typeof userEvent.setup>) {
  await draft(user); await user.click(screen.getByRole("button", { name: "Review on server" }));
  await screen.findByLabelText("Server import summary");
}
async function acknowledge(user: ReturnType<typeof userEvent.setup>) {
  fireEvent.change(screen.getByLabelText("Import reason"), { target: { value: "Office approved original dated school records" } });
  await user.click(screen.getByRole("checkbox", { name: /I reviewed the school-wide impact/ }));
}
beforeEach(() => {
  vi.resetAllMocks(); callbacks.clear(); load.mockResolvedValue(historicalContext()); preview.mockResolvedValue(historicalPreview());
  save.mockResolvedValue({ revision: 3, importedRows: 2, workingRows: 1, holidayRows: 1, replayed: false }); calendarLoad.mockResolvedValue(calendarFixture());
  subscribe.mockImplementation(callback => { callbacks.add(callback); return { data: { subscription: { unsubscribe: () => callbacks.delete(callback) } } }; });
});
describe("historical calendar CSV manager", () => {
  it("loads access on demand, previews real server counts and requires explicit impact consent", async () => {
    const user = userEvent.setup(); render(element()); expect(load).not.toHaveBeenCalled(); await reviewed(user);
    expect(preview.mock.calls[0].slice(1, 5)).toEqual([uid, schoolId, yearId, historicalRows]);
    expect(screen.getByText(/4 saved marks · 2 pupils with saved marks/)).toBeInTheDocument();
    expect(screen.getByText(/Legacy Holiday marks need a separate correction/)).toBeInTheDocument();
    expect(screen.getByText(/Existing non-holiday marks stay saved/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm historical import" })).toBeDisabled(); expect(save).not.toHaveBeenCalled();
    await acknowledge(user); await user.click(screen.getByRole("button", { name: "Confirm historical import" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Historical calendar imported: 2 dates");
    expect(save.mock.calls[0][2]).toMatchObject({ schoolId, academicYearId: yearId, rows: historicalRows, expectedRevision: 2, previewToken, acknowledgeImpact: true });
    expect(save.mock.calls[0][2].requestId).toMatch(/^[a-f0-9-]{36}$/i); expect(onImported).toHaveBeenCalledOnce();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2)); expect(onLock).toHaveBeenLastCalledWith(false);
  });
  it("blocks every duplicate and malformed local row without a server preview", async () => {
    const user = userEvent.setup(); render(element()); await draft(user, "date,status,label\n2026-11-01,working,Approved day\n2026-11-01,holiday,Duplicated day\n2026-02-30,holiday,Invalid day");
    expect(screen.getAllByText("Date repeats in this file.")).toHaveLength(2); expect(screen.getByText("Use a real date in YYYY-MM-DD format.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review on server" })).toBeDisabled(); expect(preview).not.toHaveBeenCalled();
  });
  it("shows configured-date server conflicts and never imports a partial valid batch", async () => {
    const result = historicalPreview(); preview.mockResolvedValue({ ...result, can_import: false, rows: [{ ...result.rows[0], issue: "Date already configured" }, result.rows[1]], summary: { ...result.summary, valid_rows: 1 } });
    const user = userEvent.setup(); render(element()); await reviewed(user);
    expect(screen.getByText("Date already configured")).toBeInTheDocument(); expect(screen.getByText(/Nothing has been imported/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm historical import" })).not.toBeInTheDocument(); expect(save).not.toHaveBeenCalled();
  });
  it("freezes an unknown outcome and retries the exact same actor/year/rows/reason/request", async () => {
    save.mockRejectedValueOnce(new SchoolCalendarError("Unknown import outcome.")).mockResolvedValueOnce({ revision: 3, importedRows: 2, workingRows: 1, holidayRows: 1, replayed: true });
    const user = userEvent.setup(); render(element()); await reviewed(user); await acknowledge(user); await user.click(screen.getByRole("button", { name: "Confirm historical import" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unknown import outcome."); const first = save.mock.calls[0][2];
    expect(screen.getByLabelText("Historical academic year")).toBeDisabled(); expect(screen.getByLabelText("Calendar CSV file")).toBeDisabled(); expect(screen.getByLabelText("Import reason")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard import draft" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Reload import" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close import" })).toBeDisabled(); await user.click(screen.getByRole("button", { name: "Retry same frozen import" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Previous import confirmed"); expect(save.mock.calls[1][2]).toBe(first);
  });
  it("requires a fresh preview after a stale calendar conflict, without replacing the original request", async () => {
    save.mockRejectedValueOnce(new SchoolCalendarError("School calendar changed.", "conflict")); const user = userEvent.setup(); render(element()); await reviewed(user); await acknowledge(user);
    await user.click(screen.getByRole("button", { name: "Confirm historical import" })); expect(await screen.findByRole("alert")).toHaveTextContent("School calendar changed.");
    expect(screen.queryByLabelText("Server import summary")).not.toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Confirm historical import" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review on server" })).toBeEnabled(); expect(save).toHaveBeenCalledOnce();
  });
  it("invalidates the server preview and acknowledgement when the year or file changes", async () => {
    const user = userEvent.setup(); render(element()); await reviewed(user); await acknowledge(user);
    await user.selectOptions(screen.getByLabelText("Historical academic year"), ""); expect(screen.queryByLabelText("Server import summary")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Historical academic year"), yearId); await user.click(screen.getByRole("button", { name: "Review on server" })); await screen.findByLabelText("Import reason");
    expect(screen.getByRole("checkbox")).not.toBeChecked(); await user.upload(screen.getByLabelText("Calendar CSV file"), file()); expect(screen.queryByLabelText("Server import summary")).not.toBeInTheDocument();
  });
  it("keeps AAL1 import context read-only with an account-security route", async () => {
    load.mockResolvedValue({ ...historicalContext(), can_import: false }); const user = userEvent.setup(); render(element()); await user.click(screen.getByRole("button", { name: "Import historical CSV" }));
    expect(await screen.findByRole("link", { name: "Account security" })).toHaveAttribute("href", "/account/settings"); expect(screen.queryByLabelText("Calendar CSV file")).not.toBeInTheDocument();
    expect(preview).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it("keeps an uncertain import frozen if renewed MFA access is needed before retry", async () => {
    save.mockRejectedValueOnce(new SchoolCalendarError("Unknown import outcome.")).mockRejectedValueOnce(new SchoolCalendarError("Complete authenticator verification.", "access"));
    const user = userEvent.setup(); render(element()); await reviewed(user); await acknowledge(user); await user.click(screen.getByRole("button", { name: "Confirm historical import" }));
    await screen.findByRole("button", { name: "Retry same frozen import" }); const original = save.mock.calls[0][2]; await user.click(screen.getByRole("button", { name: "Retry same frozen import" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Complete authenticator verification."); expect(save.mock.calls[1][2]).toBe(original);
    expect(screen.getByRole("button", { name: "Discard import draft" })).toBeDisabled(); expect(screen.getByRole("link", { name: "verify account security in a new tab" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("button", { name: "Retry same frozen import" })).toBeEnabled(); expect(onLock).toHaveBeenLastCalledWith(true);
  });
  it("explains unsupported years and displays actor, reason and time in retained history", async () => {
    load.mockResolvedValue({ ...historicalContext(), years: [], history: [{ request_id: id(7), academic_year_id: yearId, revision: 2, imported_rows: 2, working_rows: 1, holiday_rows: 1, reason: "School approved archived calendar", actor_id: uid, created_at: "2026-11-07T10:00:00Z" }] });
    const user = userEvent.setup(); render(element()); await user.click(screen.getByRole("button", { name: "Import historical CSV" }));
    expect(await screen.findByText(/No supported historical academic years/)).toBeInTheDocument(); expect(screen.getByLabelText("Calendar CSV file")).toBeDisabled();
    expect(screen.getByText("Imported by you")).toBeInTheDocument(); expect(screen.getByText("School approved archived calendar")).toBeInTheDocument();
    expect(screen.getByText(/7 Nov 2026,/)).toHaveAttribute("dateTime", "2026-11-07T10:00:00Z");
  });
  it("drops draft data and aborts late preview when the native account changes", async () => {
    const pending = deferred<ReturnType<typeof historicalPreview>>(); preview.mockReturnValueOnce(pending.promise); const user = userEvent.setup(); render(element()); await draft(user);
    await user.click(screen.getByRole("button", { name: "Review on server" })); const signal = preview.mock.calls[0][5] as AbortSignal;
    act(() => callbacks.forEach(callback => callback("SIGNED_IN", { user: { id: id(9) } }))); expect(signal.aborted).toBe(true);
    expect(screen.queryByLabelText("Calendar CSV file")).not.toBeInTheDocument(); expect(screen.queryByText(/calendar.csv/)).not.toBeInTheDocument();
    await act(async () => pending.resolve(historicalPreview())); expect(screen.queryByLabelText("Server import summary")).not.toBeInTheDocument(); expect(onLock).toHaveBeenLastCalledWith(false);
  });
  it("does not leak a slow file read into a different school", async () => {
    const pending = deferred<ArrayBuffer>(); const user = userEvent.setup(); const view = render(element()); await user.click(screen.getByRole("button", { name: "Import historical CSV" }));
    await screen.findByLabelText("Calendar CSV file"); await user.upload(screen.getByLabelText("Calendar CSV file"), file(csv, pending.promise));
    view.rerender(element(uid, id(9))); expect(screen.queryByText(/calendar.csv/)).not.toBeInTheDocument();
    await act(async () => pending.resolve(new TextEncoder().encode(csv).buffer)); expect(screen.queryByLabelText("Historical calendar CSV preview")).not.toBeInTheDocument(); expect(save).not.toHaveBeenCalled();
  });
  it("holds the parent school/calendar lock until discard and keeps success mounted during refresh", async () => {
    const user = userEvent.setup(); render(<SchoolAttendanceCalendar client={client} userId={uid} schoolId={schoolId} onLock={onLock} />);
    await screen.findByRole("button", { name: "Set weekly rules" }); await reviewed(user);
    expect(screen.getByRole("button", { name: "Set weekly rules" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Reload calendar" })).toBeDisabled(); expect(onLock).toHaveBeenLastCalledWith(true);
    const leaving = new Event("beforeunload", { cancelable: true }); fireEvent(window, leaving); expect(leaving.defaultPrevented).toBe(true);
    await acknowledge(user); await user.click(screen.getByRole("button", { name: "Confirm historical import" })); expect(await screen.findByRole("status")).toHaveTextContent("Historical calendar imported");
    await waitFor(() => expect(calendarLoad).toHaveBeenCalledTimes(2)); expect(screen.getByLabelText("Historical academic year")).toBeInTheDocument(); expect(onLock).toHaveBeenLastCalledWith(false);
  });
});
