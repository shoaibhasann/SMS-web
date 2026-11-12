import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FamilyNotificationInbox } from "@/components/family/family-notification-inbox";
import { notifyFamilyNotificationsChanged, type FamilyNotification, type FamilyNotificationInbox as Inbox } from "@/lib/notifications/family";

const { load, mark, bulk, client } = vi.hoisted(() => ({ load: vi.fn(), mark: vi.fn(), bulk: vi.fn(), client: { auth: { onAuthStateChange: vi.fn() } } }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => client }));
vi.mock("@/components/family/gate-alert-preferences", () => ({ GateAlertPreferences: () => null }));
vi.mock("@/lib/notifications/family", async original => ({ ...await original<typeof import("@/lib/notifications/family")>(), loadFamilyNotificationInbox: load, markFamilyNotificationRead: mark, markAllFamilyNotificationsRead: bulk }));

const id = (value: number) => `83000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const userId = id(1);
const row = (n: number, name: string): FamilyNotification => ({ id: id(n), kind: "late", status: "late", student_id: id(n + 100), student_name: name, source_id: id(n + 200), title: "Marked Late", event_date: "2026-11-08", created_at: `2026-11-0${n}T03:30:00Z`, read_at: null, occurred_at: null, delayed: false, assessment_id: null });
const newest = row(9, "Newest pupil"), older = row(2, "Older pupil");
const cursor = { id: newest.id, kind: newest.kind, created_at: newest.created_at };
const page = (notifications: FamilyNotification[], next_cursor: Inbox["next_cursor"] = null): Inbox => ({ notifications, unread_count: 2, next_cursor });

beforeEach(() => {
  vi.resetAllMocks();
  client.auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  load.mockImplementation((_c, options: { cursor: unknown }) => Promise.resolve(options.cursor ? page([older]) : page([newest], cursor)));
  mark.mockResolvedValue("2026-11-08T05:30:00Z"); bulk.mockResolvedValue(2);
});

async function openOlderPage() {
  render(<FamilyNotificationInbox userId={userId} role="parent" />);
  fireEvent.click(await screen.findByRole("button", { name: "Older notifications" }));
  await screen.findByRole("button", { name: /Mark as read: Older pupil/ });
}

describe("Family notification inbox paging after marking read", () => {
  it("keeps the Older notifications page after marking one row read", async () => {
    await openOlderPage();
    fireEvent.click(screen.getByRole("button", { name: /Mark as read: Older pupil/ }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    expect(load.mock.calls[2][1]).toMatchObject({ cursor });
    expect(await screen.findByRole("link", { name: "Marked Late Older pupil" })).toBeInTheDocument();
    expect(screen.queryByText("Newest pupil")).not.toBeInTheDocument();
  });
  it("keeps the Older notifications page after a gate alert preference save", async () => {
    await openOlderPage();
    act(() => notifyFamilyNotificationsChanged(userId, "parent", { keepCursor: true }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    expect(load.mock.calls[2][1]).toMatchObject({ cursor });
    expect(await screen.findByRole("link", { name: "Marked Late Older pupil" })).toBeInTheDocument();
    expect(screen.queryByText("Newest pupil")).not.toBeInTheDocument();
  });
  it("still returns to the newest page after Mark all as read", async () => {
    await openOlderPage();
    fireEvent.click(screen.getByRole("button", { name: "Mark all as read" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    expect(load.mock.calls[2][1]).toMatchObject({ cursor: null });
    expect(await screen.findByRole("link", { name: "Marked Late Newest pupil" })).toBeInTheDocument();
  });
});
