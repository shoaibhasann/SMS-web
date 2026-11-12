import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FamilyNotificationInbox } from "@/components/family/family-notification-inbox";
import { familyNotificationsChangedEvent, type FamilyNotification, type FamilyNotificationInbox as Inbox } from "@/lib/notifications/family";

const { load, mark, bulk, subscribe, unsubscribe, client } = vi.hoisted(() => ({ load: vi.fn(), mark: vi.fn(), bulk: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), client: { auth: { onAuthStateChange: vi.fn() } } }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => client }));
vi.mock("@/components/family/gate-alert-preferences", () => ({ GateAlertPreferences: () => <aside aria-label="Existing gate preferences" /> }));
vi.mock("@/lib/notifications/family", async original => ({ ...await original<typeof import("@/lib/notifications/family")>(), loadFamilyNotificationInbox: load, markFamilyNotificationRead: mark, markAllFamilyNotificationsRead: bulk }));
const id = (value: number) => `82000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const userId = id(1), readAt = "2026-11-08T05:30:00Z";
const late = (overrides: Partial<FamilyNotification> = {}): FamilyNotification => ({ id: id(2), kind: "late", status: "late", student_id: id(3), student_name: "Late QA pupil", source_id: id(4), title: "Marked Late", event_date: "2026-11-08", created_at: "2026-11-08T03:30:00Z", read_at: null, occurred_at: null, delayed: false, assessment_id: null, ...overrides });
const inbox = (notifications: FamilyNotification[], unread_count: number, next_cursor: Inbox["next_cursor"] = null): Inbox => ({ notifications, unread_count, next_cursor });
function pending<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(complete => { resolve = complete; }); return { promise, resolve }; }
let changed: (event: string, session: { user: { id: string } } | null) => void;
beforeEach(() => {
  vi.resetAllMocks(); load.mockResolvedValue(inbox([late()], 37)); mark.mockResolvedValue(readAt); bulk.mockResolvedValue(37);
  subscribe.mockImplementation((callback: typeof changed) => { changed = callback; return { data: { subscription: { unsubscribe } } }; }); client.auth.onAuthStateChange.mockImplementation(subscribe);
});

describe("Guardian Late attendance inbox", () => {
  it("labels Late distinctly and opens the exact Guardian child attendance destination", async () => {
    render(<FamilyNotificationInbox userId={userId} role="parent" />); const link = await screen.findByRole("link", { name: "Marked Late Late QA pupil" }); const row = within(link.closest("li")!);
    expect(row.getByText("Late attendance")).toBeInTheDocument(); expect(row.queryByText("Leave")).not.toBeInTheDocument(); expect(link).toHaveAttribute("href", `/modules/attendance?child=${id(3)}&view=guardian`);
    expect(row.getByText("8 Nov 2026")).toHaveAttribute("datetime", "2026-11-08"); expect(row.queryByText("Delayed update")).not.toBeInTheDocument(); expect(screen.getByText("37 unread")).toBeInTheDocument();
    expect(load).toHaveBeenCalledWith(client, { userId, role: "parent", unreadOnly: false, cursor: null, limit: 30 }, expect.any(AbortSignal)); expect(screen.getByRole("complementary", { name: "Existing gate preferences" })).toBeInTheDocument();
  });
  it("uses the Late kind for a guarded read write and waits for authoritative unread/read state", async () => {
    const response = pending<string | null>(); mark.mockReturnValue(response.promise); load.mockResolvedValueOnce(inbox([late()], 37)).mockResolvedValueOnce(inbox([late()], 37)).mockResolvedValueOnce(inbox([late({ read_at: readAt })], 34));
    render(<FamilyNotificationInbox userId={userId} role="parent" />); const button = await screen.findByRole("button", { name: /Mark as read: Late QA pupil, Marked Late/ }); fireEvent.click(button); fireEvent.click(button);
    expect(mark).toHaveBeenCalledOnce(); expect(mark).toHaveBeenCalledWith(client, "parent", "late", id(2), userId, expect.any(AbortSignal)); expect(screen.getByText("37 unread")).toBeInTheDocument(); expect(screen.queryByText("Read")).not.toBeInTheDocument();
    await act(async () => response.resolve(readAt)); await waitFor(() => expect(load).toHaveBeenCalledTimes(2)); expect(await screen.findByRole("button", { name: /Mark as read: Late QA pupil/ })).toBeEnabled(); expect(screen.getByText("37 unread")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh notifications" })); await screen.findByText("34 unread"); expect(screen.getByText("Read")).toBeInTheDocument(); expect(screen.queryByRole("button", { name: /Mark as read: Late QA pupil/ })).not.toBeInTheDocument();
  });
  it("uses server Unread filtering and a Late cursor, replacing pages rather than inventing a local filter", async () => {
    const current = late(), cursor = { id: current.id, kind: current.kind, created_at: current.created_at }, older = late({ id: id(8), student_id: id(9), student_name: "Older Late pupil", source_id: id(10), event_date: "2026-11-07", created_at: "2026-11-07T03:30:00Z" });
    load.mockResolvedValueOnce(inbox([current], 61, cursor)).mockResolvedValueOnce(inbox([older], 61)).mockResolvedValueOnce(inbox([current], 61)); render(<FamilyNotificationInbox userId={userId} role="parent" />); await screen.findByText("61 unread"); fireEvent.click(screen.getByRole("button", { name: "Older notifications" }));
    expect(await screen.findByRole("link", { name: "Marked Late Older Late pupil" })).toHaveAttribute("href", `/modules/attendance?child=${id(9)}&view=guardian`); expect(screen.queryByText("Late QA pupil")).not.toBeInTheDocument(); expect(load.mock.calls[1][1]).toMatchObject({ role: "parent", cursor, unreadOnly: false });
    fireEvent.click(screen.getByRole("button", { name: "Unread" })); await screen.findByRole("link", { name: "Marked Late Late QA pupil" }); expect(load.mock.calls[2][1]).toMatchObject({ role: "parent", cursor: null, unreadOnly: true }); expect(screen.getByRole("button", { name: "Unread" })).toHaveAttribute("aria-pressed", "true"); expect(screen.getByText("61 unread")).toBeInTheDocument();
  });
  it("does not assume Mark all means zero when new unread alerts exist in the fresh server response", async () => {
    const next = late({ id: id(12), source_id: id(13), title: "New Late update" }); load.mockResolvedValueOnce(inbox([late()], 151)).mockResolvedValueOnce(inbox([late()], 151)).mockResolvedValueOnce(inbox([next], 2)); bulk.mockResolvedValue(151);
    render(<FamilyNotificationInbox userId={userId} role="parent" />); await screen.findByText("151 unread"); fireEvent.click(screen.getByRole("button", { name: "Unread" })); await waitFor(() => expect(load).toHaveBeenCalledTimes(2)); fireEvent.click(screen.getByRole("button", { name: "Mark all as read" }));
    await screen.findByText("2 unread"); expect(screen.getByRole("link", { name: "New Late update Late QA pupil" })).toBeInTheDocument(); expect(screen.queryByText("0 unread")).not.toBeInTheDocument(); expect(bulk).toHaveBeenCalledWith(client, "parent", userId, expect.any(AbortSignal)); expect(mark).not.toHaveBeenCalled(); expect(load.mock.calls[2][1]).toMatchObject({ cursor: null, unreadOnly: true });
  });
  it("keeps Late alerts and the last verified count after an unconfirmed bulk write", async () => {
    bulk.mockRejectedValueOnce(new Error("Network failure")); render(<FamilyNotificationInbox userId={userId} role="parent" />); await screen.findByText("37 unread"); fireEvent.click(screen.getByRole("button", { name: "Mark all as read" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not mark all notifications as read"); expect(screen.getByText("37 unread")).toBeInTheDocument(); expect(screen.getByRole("link", { name: "Marked Late Late QA pupil" })).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Mark all as read" })).toBeEnabled(); expect(load).toHaveBeenCalledOnce();
  });
  it("clears a withdrawn Late alert only after the server confirms it is no longer eligible", async () => {
    mark.mockResolvedValueOnce(null); load.mockResolvedValueOnce(inbox([late()], 37)).mockResolvedValueOnce(inbox([], 36)); render(<FamilyNotificationInbox userId={userId} role="parent" />); fireEvent.click(await screen.findByRole("button", { name: /Mark as read: Late QA pupil/ }));
    expect(await screen.findByText("36 unread")).toBeInTheDocument(); expect(screen.queryByText("Marked Late")).not.toBeInTheDocument(); expect(screen.getByRole("alert")).toHaveTextContent("This notification is no longer available");
  });
  it("aborts a delayed Late read write on logout and never publishes its late completion", async () => {
    const response = pending<string | null>(); mark.mockReturnValue(response.promise); render(<FamilyNotificationInbox userId={userId} role="parent" />); fireEvent.click(await screen.findByRole("button", { name: /Mark as read: Late QA pupil/ })); const signal = mark.mock.calls[0][5] as AbortSignal;
    act(() => changed("SIGNED_OUT", null)); expect(signal.aborted).toBe(true); expect(screen.queryByText("Marked Late")).not.toBeInTheDocument(); expect(screen.queryByText("37 unread")).not.toBeInTheDocument(); expect(screen.getByRole("alert")).toHaveTextContent("Your sign-in changed"); await act(async () => response.resolve(readAt)); expect(load).toHaveBeenCalledOnce();
  });
  it("requests a separate Student context, removes Guardian Late rows and aborts the old role's request", async () => {
    const old = pending<string | null>(), student = pending<Inbox>(); mark.mockReturnValue(old.promise); const { rerender } = render(<FamilyNotificationInbox userId={userId} role="parent" />); fireEvent.click(await screen.findByRole("button", { name: /Mark as read: Late QA pupil/ })); const signal = mark.mock.calls[0][5] as AbortSignal;
    load.mockReturnValueOnce(student.promise); rerender(<FamilyNotificationInbox userId={userId} role="student" />); expect(signal.aborted).toBe(true); expect(screen.queryByText("Late attendance")).not.toBeInTheDocument(); expect(screen.queryByRole("complementary", { name: "Existing gate preferences" })).not.toBeInTheDocument(); expect(load.mock.calls[1][1]).toMatchObject({ userId, role: "student", cursor: null });
    await act(async () => student.resolve(inbox([], 0))); await act(async () => old.resolve(readAt)); expect(screen.getByText("0 unread")).toBeInTheDocument(); expect(load).toHaveBeenCalledTimes(2); expect(screen.queryByText("Marked Late")).not.toBeInTheDocument();
  });
  it("uses matched account/role change events as refresh hints without trusting proposed counts", async () => {
    render(<FamilyNotificationInbox userId={userId} role="parent" />); await screen.findByText("37 unread"); fireEvent(window, new CustomEvent(familyNotificationsChangedEvent, { detail: { userId: id(99), role: "parent", count: 0 } })); fireEvent(window, new CustomEvent(familyNotificationsChangedEvent, { detail: { userId, role: "student", count: 0 } })); expect(load).toHaveBeenCalledOnce();
    fireEvent(window, new CustomEvent(familyNotificationsChangedEvent, { detail: { userId, role: "parent", count: 0 } })); await waitFor(() => expect(load).toHaveBeenCalledTimes(2)); expect(await screen.findByText("37 unread")).toBeInTheDocument(); expect(screen.getByRole("link", { name: "Marked Late Late QA pupil" })).toBeInTheDocument();
  });
  it("includes Late in the bounded Guardian dashboard summary without exposing read actions there", async () => {
    render(<FamilyNotificationInbox userId={userId} role="parent" summary />); const region = within(screen.getByRole("region", { name: "School updates" })); await region.findByText("Late attendance"); expect(load.mock.calls[0][1]).toMatchObject({ userId, role: "parent", limit: 5 }); expect(region.getByText("37 unread")).toBeInTheDocument();
    expect(region.getByRole("link", { name: "Marked Late Late QA pupil" })).toHaveAttribute("href", `/modules/attendance?child=${id(3)}&view=guardian`); expect(region.queryByRole("button", { name: /Mark.*read/ })).not.toBeInTheDocument(); expect(screen.queryByRole("complementary", { name: "Existing gate preferences" })).not.toBeInTheDocument();
  });
  it("retries a failed inbox load from a Try again button under the error", async () => {
    load.mockRejectedValueOnce(new Error("offline")); render(<FamilyNotificationInbox userId={userId} role="parent" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Notifications could not be loaded."); fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("37 unread")).toBeInTheDocument(); expect(load).toHaveBeenCalledTimes(2); expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
