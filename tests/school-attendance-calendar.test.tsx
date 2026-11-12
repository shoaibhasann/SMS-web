import type { SupabaseClient } from "@supabase/supabase-js";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SchoolAttendanceCalendar } from "@/components/admin/school-attendance-calendar";
import { SchoolCalendarError, type SchoolAttendanceCalendar as CalendarRecord } from "@/lib/attendance/calendar";
import { calendarFixture, calendarId as id, calendarOwner as uid, calendarSchool as schoolId } from "./school-calendar-fixture";
const { load, save, subscribe, unsubscribe } = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }));
vi.mock("@/lib/attendance/calendar", async original => ({ ...await original<typeof import("@/lib/attendance/calendar")>(), loadSchoolAttendanceCalendar: load, saveSchoolAttendanceCalendar: save }));
const client = { auth: { onAuthStateChange: subscribe } } as unknown as SupabaseClient, onLock = vi.fn();
const policy = { revision: 1, effective_from: "2026-11-08", working_days: [1, 2, 3, 4, 5], correction_window_days: 7, reason: "Existing approved weekly policy", actor_id: uid, created_at: "2026-11-07T10:00:00Z" };
const configured = (patch: Partial<CalendarRecord> = {}) => calendarFixture({ revision: 1, policy_count: 1, policies: [policy], ...patch });
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(complete => { resolve = complete; }), resolve }; }
let changed: (event: string, session: { user: { id: string } } | null) => void;
beforeEach(() => {
  vi.resetAllMocks(); load.mockResolvedValue(calendarFixture()); save.mockResolvedValue({ revision: 1, replayed: false });
  subscribe.mockImplementation(callback => { changed = callback; return { data: { subscription: { unsubscribe } } }; });
});
const element = (userId = uid, selectedSchool = schoolId) => <SchoolAttendanceCalendar client={client} userId={userId} schoolId={selectedSchool} onLock={onLock} />;
async function policyDraft(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Set weekly rules" }));
  fireEvent.change(screen.getByLabelText("Effective from"), { target: { value: "2026-11-08" } });
  await user.click(screen.getByRole("checkbox", { name: "Monday" }));
  fireEvent.change(screen.getByLabelText("Teacher correction window (calendar days)"), { target: { value: "0" } });
  fireEvent.change(screen.getByLabelText("Change reason"), { target: { value: "Approved weekly attendance schedule" } });
}
describe("school attendance calendar manager", () => {
  it("renders complete resolved days without guessed default rules or attendance rates", async () => {
    render(element()); const grid = await screen.findByRole("table", { name: "School working and closed days" });
    expect(grid).toHaveClass("min-w-[26rem]"); expect(grid.parentElement).toHaveClass("overflow-x-auto");
    expect(screen.getAllByText("Not set")).toHaveLength(30); expect(screen.getByText("No weekly policy configured.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add dated exception" })).toBeDisabled();
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Set weekly rules" }));
    expect(screen.getAllByRole("checkbox").every(input => !(input as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByLabelText("Teacher correction window (calendar days)")).toHaveValue(null);
    expect(screen.getByLabelText("Effective from")).toHaveAttribute("min", "2026-11-07");
    expect(onLock).toHaveBeenLastCalledWith(true);
  });
  it("lets the verified Principal calendar capability edit independently of profile-details authority", async () => {
    const principal = id(3); load.mockResolvedValue(calendarFixture({ user_id: principal, can_edit: true })); render(element(principal));
    await userEvent.click(await screen.findByRole("button", { name: "Set weekly rules" }));
    expect(screen.getByRole("form", { name: "School weekly attendance rules" })).toBeInTheDocument();
    expect(load.mock.calls[0].slice(1, 3)).toEqual([principal, schoolId]);
  });
  it("keeps month correction reachable after an empty month without starting an invalid request", async () => {
    render(element()); await screen.findByRole("table", { name: "School working and closed days" });
    fireEvent.change(screen.getByLabelText("Calendar month"), { target: { value: "" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a valid calendar month."); expect(load).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText("Calendar month"), { target: { value: "2026-11" } });
    expect(await screen.findByRole("table", { name: "School working and closed days" })).toBeInTheDocument(); expect(load).toHaveBeenCalledTimes(2);
  });
  it("keeps a Teacher/read-only calendar out of holiday and weekly mutations", async () => {
    load.mockResolvedValue(configured({ user_id: id(4), can_edit: false })); render(element(id(4)));
    expect(await screen.findByRole("button", { name: "Set weekly rules" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Add dated exception" })).toBeDisabled();
    expect(screen.getByText(/Changes require a School Admin or Principal with a verified authenticator session/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Account security" })).toHaveAttribute("href", "/account/settings");
    expect(screen.queryByRole("form")).not.toBeInTheDocument(); expect(save).not.toHaveBeenCalled();
  });
  it("warns before unloading a pending draft and removes the warning after explicit cancellation", async () => {
    const user = userEvent.setup(); render(element()); await policyDraft(user);
    const pending = new Event("beforeunload", { cancelable: true }); fireEvent(window, pending); expect(pending.defaultPrevented).toBe(true);
    await user.click(screen.getByRole("button", { name: "Cancel calendar edit" }));
    const cancelled = new Event("beforeunload", { cancelable: true }); fireEvent(window, cancelled); expect(cancelled.defaultPrevented).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
  it("saves one future policy with an explicit zero-day correction window and reloads its history", async () => {
    load.mockResolvedValueOnce(calendarFixture()).mockResolvedValueOnce(configured());
    const user = userEvent.setup(); render(element()); await policyDraft(user);
    await user.click(screen.getByRole("button", { name: "Save calendar change" }));
    expect(await screen.findByText("School calendar saved. Existing attendance is unchanged.")).toBeInTheDocument();
    expect(save.mock.calls[0][2]).toMatchObject({ kind: "policy", schoolId, expectedRevision: 0, effectiveFrom: "2026-11-08", workingDays: [1], correctionWindowDays: 0, reason: "Approved weekly attendance schedule" });
    expect(save.mock.calls[0][2].requestId).toMatch(/^[0-9a-f-]{36}$/i); expect(load).toHaveBeenCalledTimes(2);
    expect(onLock).toHaveBeenLastCalledWith(false);
  });
  it.each(["holiday", "working"] as const)("saves a dated %s decision under the current shared school revision", async mode => {
    load.mockResolvedValue(configured()); const user = userEvent.setup(); render(element());
    await user.click(await screen.findByRole("button", { name: "Add dated exception" }));
    fireEvent.change(screen.getByLabelText("Exception date"), { target: { value: "2026-11-15" } });
    await user.selectOptions(screen.getByLabelText("Day decision"), mode);
    fireEvent.change(screen.getByLabelText("Calendar label"), { target: { value: "School approved day" } });
    fireEvent.change(screen.getByLabelText("Change reason"), { target: { value: "School office approved this dated decision" } });
    await user.click(screen.getByRole("button", { name: "Save calendar change" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce()); expect(save.mock.calls[0][2]).toMatchObject({ kind: "exception", mode, label: "School approved day", day: "2026-11-15", expectedRevision: 1 });
  });
  it("clears an exception label for an explicit inherit decision", async () => {
    load.mockResolvedValue(configured()); const user = userEvent.setup(); render(element());
    await user.click(await screen.findByRole("button", { name: "Add dated exception" }));
    fireEvent.change(screen.getByLabelText("Exception date"), { target: { value: "2026-11-15" } });
    await user.selectOptions(screen.getByLabelText("Day decision"), "working");
    fireEvent.change(screen.getByLabelText("Calendar label"), { target: { value: "Extra teaching day" } });
    await user.selectOptions(screen.getByLabelText("Day decision"), "inherit");
    expect(screen.queryByLabelText("Calendar label")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Change reason"), { target: { value: "Follow the approved weekly schedule" } });
    await user.click(screen.getByRole("button", { name: "Save calendar change" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce()); expect(save.mock.calls[0][2]).toMatchObject({ kind: "exception", mode: "inherit", label: null, day: "2026-11-15", expectedRevision: 1 });
  });
  it("keeps an unknown save frozen and retries the exact intent once without allowing another editor", async () => {
    save.mockRejectedValueOnce(new SchoolCalendarError("Unknown calendar outcome.")).mockResolvedValueOnce({ revision: 1, replayed: true });
    const user = userEvent.setup(); render(element()); await policyDraft(user); await user.click(screen.getByRole("button", { name: "Save calendar change" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unknown calendar outcome.");
    const pending = save.mock.calls[0][2]; expect(screen.getByLabelText("Effective from")).toBeDisabled(); expect(screen.getByRole("button", { name: "Reload calendar" })).toBeDisabled();
    const leaving = new Event("beforeunload", { cancelable: true }); fireEvent(window, leaving); expect(leaving.defaultPrevented).toBe(true);
    expect(screen.queryByRole("button", { name: "Add dated exception" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry same calendar save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2)); expect(save.mock.calls[1][2]).toBe(pending);
    expect(await screen.findByText("The previous calendar save is confirmed. Reloading saved rules.")).toBeInTheDocument();
  });
  it("requires a fresh calendar before explicitly reusing a conflicted draft against a new revision", async () => {
    save.mockRejectedValueOnce(new SchoolCalendarError("Calendar changed.", "conflict"));
    load.mockResolvedValueOnce(calendarFixture()).mockResolvedValueOnce(configured({ revision: 3 }));
    const user = userEvent.setup(); render(element()); await policyDraft(user); await user.click(screen.getByRole("button", { name: "Save calendar change" }));
    const compare = await screen.findByRole("button", { name: "Use displayed revision for this draft" }); expect(compare).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Reload calendar" }));
    const fresh = await screen.findByRole("button", { name: "Use displayed revision for this draft" }); expect(fresh).toBeEnabled();
    expect(screen.getByLabelText("Effective from")).toHaveValue("2026-11-08"); await user.click(fresh);
    await user.click(screen.getByRole("button", { name: "Save calendar change" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2)); expect(save.mock.calls[1][2].expectedRevision).toBe(3); expect(save.mock.calls[1][2].requestId).not.toBe(save.mock.calls[0][2].requestId);
  });
  it("aborts a write and drops the old editor immediately when the account changes", async () => {
    const pending = deferred<{ revision: number; replayed: boolean }>(); save.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup(); render(element()); await policyDraft(user); await user.click(screen.getByRole("button", { name: "Save calendar change" }));
    const signal = save.mock.calls[0][3] as AbortSignal; act(() => changed("SIGNED_IN", { user: { id: id(8) } }));
    expect(signal.aborted).toBe(true); expect(screen.queryByRole("form")).not.toBeInTheDocument(); expect(screen.getByRole("alert")).toHaveTextContent("Your sign-in changed");
    await act(async () => pending.resolve({ revision: 1, replayed: false })); expect(load).toHaveBeenCalledOnce();
  });
  it("does not keep an old school's calendar while a different school read is pending", async () => {
    const pending = deferred<CalendarRecord>(); load.mockResolvedValueOnce(configured()).mockReturnValueOnce(pending.promise);
    const view = render(element()); await screen.findByText("Weekly policy versions"); view.rerender(element(uid, id(8)));
    expect(screen.queryByText("Existing approved weekly policy")).not.toBeInTheDocument();
    expect((load.mock.calls[0][5] as AbortSignal).aborted).toBe(true); expect(load.mock.calls[1][2]).toBe(id(8));
    await act(async () => pending.resolve(calendarFixture({ school_id: id(8) }))); expect(screen.getByText("No weekly policy configured.")).toBeInTheDocument();
  });
});
