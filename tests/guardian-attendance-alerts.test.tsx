import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GuardianAttendanceAlerts } from "../components/family/guardian-attendance-alerts";
import { FamilyNotificationInbox } from "../components/family/family-notification-inbox";
import { FamilyNotificationBell } from "../components/notifications/family-notification-bell";
import { familyNotificationsChangedEvent, type FamilyNotification, type FamilyNotificationInbox as Inbox } from "@/lib/notifications/family";

const { load, count, mark, bulk, subscribe, unsubscribe } = vi.hoisted(() => ({ load: vi.fn(), count: vi.fn(), mark: vi.fn(), bulk: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { onAuthStateChange: subscribe } }) }));
vi.mock("@/lib/notifications/family", async (original) => ({ ...await original<typeof import("@/lib/notifications/family")>(), loadFamilyNotificationInbox: load, loadFamilyNotificationUnreadCount: count, markFamilyNotificationRead: mark, markAllFamilyNotificationsRead: bulk }));

const uid = "00000000-0000-4000-8000-000000000001";
const readAt = "2026-11-06T12:00:00Z";
const first: FamilyNotification = { id: "00000000-0000-4000-8000-000000000010", kind: "absence", student_id: "00000000-0000-4000-8000-000000000002", student_name: "First pupil", created_at: "2026-11-06T10:00:00Z", read_at: null, event_date: "2026-11-06", source_id: "00000000-0000-4000-8000-000000000011", status: "absent", title: "Marked absent", assessment_id: null };
const second: FamilyNotification = { ...first, id: "00000000-0000-4000-8000-000000000020", student_name: "Second pupil", kind: "result_published", status: "published", title: "Term results published", assessment_id: "00000000-0000-4000-8000-000000000021" };
const third: FamilyNotification = { ...first, id: "00000000-0000-4000-8000-000000000030", kind: "leave_decision", status: "approved", title: "Leave approved" };
function inbox(notifications: FamilyNotification[], unread_count = notifications.filter((row) => row.read_at === null).length, next_cursor: Inbox["next_cursor"] = null): Inbox { return { notifications, unread_count, next_cursor }; }
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>((complete) => { resolve = complete; }), resolve: (value: T) => resolve(value) }; }
let authChanged: (event: string, session: { user: { id: string } } | null) => void;
beforeEach(() => {
  vi.resetAllMocks();
  subscribe.mockImplementation((callback) => { authChanged = callback; return { data: { subscription: { unsubscribe } } }; });
  load.mockResolvedValue(inbox([])); count.mockResolvedValue(0); mark.mockResolvedValue(readAt); bulk.mockResolvedValue(0);
});

describe("family notification inbox", () => {
  it("updates the matching header bell from a fresh server count after a successful mark", async () => {
    load.mockResolvedValueOnce(inbox([first, second], 2)).mockResolvedValueOnce(inbox([{ ...first, read_at: readAt }, second], 1));
    count.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    const user = userEvent.setup();
    render(<><FamilyNotificationBell userId={uid} role="parent" className="" /><GuardianAttendanceAlerts userId={uid} /></>);
    await screen.findByRole("link", { name: "Open notifications, 2 unread" });
    await user.click(await screen.findByRole("button", { name: /Mark as read: First pupil/ }));
    expect(await screen.findByRole("link", { name: "Open notifications, 1 unread" })).toBeInTheDocument();
    expect(await screen.findByText("1 unread")).toBeInTheDocument(); expect(count).toHaveBeenCalledTimes(2);
  });
  it("shows a five-row mixed summary and links to authorized guardian destinations", async () => {
    const rows = [first, second, third, { ...first, id: "00000000-0000-4000-8000-000000000040" }, { ...second, id: "00000000-0000-4000-8000-000000000050" }];
    load.mockResolvedValue(inbox(rows, 42));
    render(<GuardianAttendanceAlerts userId={uid} summary />);
    const card = within(screen.getByRole("region", { name: "School updates" }));
    expect(await card.findAllByRole("listitem")).toHaveLength(5);
    expect(card.getByText("42 unread")).toBeInTheDocument();
    expect(load.mock.calls[0][1]).toEqual({ role: "parent", unreadOnly: false, cursor: null, limit: 5 });
    expect(card.getAllByRole("link", { name: /Marked absent First pupil/ })[0]).toHaveAttribute("href", `/modules/attendance?child=${first.student_id}&view=guardian`);
    expect(card.getAllByRole("link", { name: /Term results published Second pupil/ })[0]).toHaveAttribute("href", `/modules/results?child=${first.student_id}&view=guardian&assessment=${second.assessment_id}`);
    expect(card.getByRole("link", { name: "View all notifications" })).toHaveAttribute("href", "/modules/notifications?view=guardian");
    expect(card.queryByRole("group", { name: "Filter notifications" })).not.toBeInTheDocument();
    expect(card.queryByRole("button", { name: "Mark all as read" })).not.toBeInTheDocument();
  });

  it("uses server unread filtering, older cursors and replacement pages, resetting the cursor for filters", async () => {
    const cursor = { id: first.id, kind: first.kind, created_at: first.created_at };
    load.mockResolvedValueOnce(inbox([first], 40, cursor)).mockResolvedValueOnce(inbox([second], 40)).mockResolvedValueOnce(inbox([third], 40));
    const user = userEvent.setup(); render(<FamilyNotificationInbox userId={uid} role="student" />);
    await screen.findByText(first.title);
    await user.click(screen.getByRole("button", { name: "Older notifications" }));
    expect(await screen.findByText(second.title)).toBeInTheDocument();
    expect(screen.queryByText(first.title)).not.toBeInTheDocument();
    expect(load.mock.calls[1][1]).toMatchObject({ role: "student", cursor, unreadOnly: false, limit: 30 });
    await user.click(screen.getByRole("button", { name: "Unread" }));
    await screen.findByText(third.title);
    expect(load.mock.calls[2][1]).toMatchObject({ role: "student", cursor: null, unreadOnly: true });
    expect(screen.getByRole("button", { name: "Unread" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "Latest notifications" })).not.toBeInTheDocument();
  });

  it("clears old records during a refresh and ignores a stale pending response", async () => {
    const stale = deferred<Inbox>(), fresh = deferred<Inbox>();
    load.mockResolvedValueOnce(inbox([first])).mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
    render(<GuardianAttendanceAlerts userId={uid} />); await screen.findByText(first.title);
    fireEvent.click(screen.getByRole("button", { name: "Refresh notifications" }));
    expect(screen.queryByText(first.title)).not.toBeInTheDocument();
    const oldSignal = load.mock.calls[1][2] as AbortSignal;
    fireEvent(window, new Event("focus"));
    expect(oldSignal.aborted).toBe(true);
    await act(async () => fresh.resolve(inbox([])));
    expect(screen.getByText("No notifications available.")).toBeInTheDocument();
    await act(async () => stale.resolve(inbox([first])));
    expect(screen.queryByText(first.title)).not.toBeInTheDocument();
  });

  it("marks one kind-scoped row once, refreshes the saved count and retains read state after remount", async () => {
    const saved = inbox([{ ...first, read_at: readAt }, second], 31), pending = deferred<string | null>();
    load.mockResolvedValueOnce(inbox([first, second], 32)).mockResolvedValue(saved); mark.mockReturnValue(pending.promise);
    const user = userEvent.setup(); const view = render(<GuardianAttendanceAlerts userId={uid} />);
    const button = await screen.findByRole("button", { name: /Mark as read: First pupil/ });
    await user.click(button); fireEvent.click(button);
    expect(mark).toHaveBeenCalledTimes(1); expect(mark.mock.calls[0].slice(1, 4)).toEqual(["parent", "absence", first.id]);
    await act(async () => pending.resolve(readAt));
    expect(await screen.findByText("31 unread")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Notifications" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: /Mark as read: First pupil/ })).not.toBeInTheDocument();
    view.unmount(); render(<GuardianAttendanceAlerts userId={uid} />);
    await screen.findByText("31 unread"); expect(screen.queryByRole("button", { name: /Mark as read: First pupil/ })).not.toBeInTheDocument();
  });

  it("atomically marks all beyond the page and refetches the selected unread filter", async () => {
    load.mockResolvedValueOnce(inbox([first], 150)).mockResolvedValueOnce(inbox([first], 150)).mockResolvedValueOnce(inbox([], 0)); bulk.mockResolvedValue(150);
    const user = userEvent.setup(); render(<GuardianAttendanceAlerts userId={uid} />); await screen.findByText("150 unread");
    await user.click(screen.getByRole("button", { name: "Unread" })); await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Mark all as read" }));
    expect(await screen.findByText("0 unread")).toBeInTheDocument(); expect(bulk).toHaveBeenCalledTimes(1);
    expect(bulk.mock.calls[0][1]).toBe("parent"); expect(mark).not.toHaveBeenCalled();
    expect(load.mock.calls[2][1]).toMatchObject({ unreadOnly: true, cursor: null });
    expect(screen.getByText("No unread notifications.")).toBeInTheDocument();
  });

  it("keeps saved count and permits retry after a failed write; unavailable rows force a new authorized read", async () => {
    load.mockResolvedValueOnce(inbox([first])).mockResolvedValueOnce(inbox([])); mark.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(null);
    const user = userEvent.setup(); render(<GuardianAttendanceAlerts userId={uid} />);
    const button = await screen.findByRole("button", { name: /Mark as read: First pupil/ }); await user.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not mark the notification as read.");
    expect(screen.getByText("1 unread")).toBeInTheDocument(); expect(button).toBeEnabled();
    await user.click(button); await screen.findByText("0 unread");
    expect(screen.getByRole("alert")).toHaveTextContent("This notification is no longer available.");
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("retries a failed bulk operation without claiming an unsaved zero", async () => {
    load.mockResolvedValueOnce(inbox([first], 151)).mockResolvedValueOnce(inbox([], 0)); bulk.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(0);
    const user = userEvent.setup(); render(<GuardianAttendanceAlerts userId={uid} />); await screen.findByText("151 unread");
    await user.click(screen.getByRole("button", { name: "Mark all as read" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not mark all notifications as read."); expect(screen.getByText("151 unread")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mark all as read" })); expect(await screen.findByText("0 unread")).toBeInTheDocument();
  });

  it("accepts refresh hints only for the current user and role, never their proposed counts", async () => {
    load.mockResolvedValue(inbox([first], 7)); render(<FamilyNotificationInbox userId={uid} role="student" />); await screen.findByText("7 unread");
    fireEvent(window, new CustomEvent(familyNotificationsChangedEvent, { detail: { userId: "other", role: "student", count: 0 } }));
    fireEvent(window, new CustomEvent(familyNotificationsChangedEvent, { detail: { userId: uid, role: "parent", count: 0 } }));
    expect(load).toHaveBeenCalledTimes(1);
    fireEvent(window, new CustomEvent(familyNotificationsChangedEvent, { detail: { userId: uid, role: "student", count: 0 } }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2)); expect(await screen.findByText("7 unread")).toBeInTheDocument();
  });

  it("aborts pending writes and hides the old account records immediately on a session change", async () => {
    const pending = deferred<string | null>(); load.mockResolvedValue(inbox([first])); mark.mockReturnValue(pending.promise);
    const user = userEvent.setup(); const view = render(<GuardianAttendanceAlerts userId={uid} />);
    await user.click(await screen.findByRole("button", { name: /Mark as read: First pupil/ }));
    const signal = mark.mock.calls[0][4] as AbortSignal;
    act(() => authChanged("SIGNED_IN", { user: { id: "other" } })); expect(signal.aborted).toBe(true);
    expect(screen.queryByText(first.title)).not.toBeInTheDocument(); expect(screen.getByRole("alert")).toHaveTextContent("Your sign-in changed.");
    await act(async () => pending.resolve(readAt)); expect(load).toHaveBeenCalledTimes(1);
    view.unmount(); expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("drops old rows on owner or role prop change before new reads complete", async () => {
    const pending = deferred<Inbox>(); load.mockResolvedValueOnce(inbox([first])).mockReturnValue(pending.promise);
    const view = render(<FamilyNotificationInbox userId={uid} role="parent" />); await screen.findByText(first.title);
    view.rerender(<FamilyNotificationInbox userId={uid} role="student" />);
    expect(screen.queryByText(first.title)).not.toBeInTheDocument();
    expect(load.mock.calls[1][1]).toMatchObject({ role: "student" });
    await act(async () => pending.resolve(inbox([second])));
    expect(await screen.findByRole("link", { name: /Term results published/ })).toHaveAttribute("href", `/modules/results?child=${first.student_id}&assessment=${second.assessment_id}`);
  });
});
