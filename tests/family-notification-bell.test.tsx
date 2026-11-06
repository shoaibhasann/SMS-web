import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FamilyNotificationBell } from "../components/notifications/family-notification-bell";
import { familyNotificationsChangedEvent } from "@/lib/notifications/family";
const { load, subscribe, unsubscribe } = vi.hoisted(() => ({ load: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { onAuthStateChange: subscribe } }) }));
vi.mock("@/lib/notifications/family", async (original) => ({ ...await original<typeof import("@/lib/notifications/family")>(), loadFamilyNotificationUnreadCount: load }));
const uid = "00000000-0000-4000-8000-000000000001";
let authChanged: (event: string, session: { user: { id: string } } | null) => void;
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>((complete) => { resolve = complete; }), resolve: (value: T) => resolve(value) }; }
beforeEach(() => { vi.resetAllMocks(); load.mockResolvedValue(0); subscribe.mockImplementation((callback) => { authChanged = callback; return { data: { subscription: { unsubscribe } } }; }); });

describe("family notification bell", () => {
  it("links to the own role inbox, caps visual badges and preserves the true accessible count", async () => {
    load.mockResolvedValue(152); render(<FamilyNotificationBell userId={uid} role="parent" className="min-h-11" />);
    const bell = await screen.findByRole("link", { name: "Open notifications, 152 unread" });
    expect(bell).toHaveAttribute("href", "/modules/notifications?view=guardian"); expect(screen.getByText("99+")).toHaveAttribute("aria-hidden", "true");
    expect(bell.className).toContain("inline-flex"); expect(bell.className).not.toContain("hidden");
    expect(load.mock.calls[0][1]).toBe("parent");
  });
  it("has no fake badge when there are zero unread notifications", async () => {
    render(<FamilyNotificationBell userId={uid} role="student" className="min-h-11" />);
    await waitFor(() => expect(load).toHaveBeenCalledOnce());
    const bell = screen.getByRole("link", { name: "Open notifications" }); expect(bell).toHaveAttribute("href", "/modules/notifications"); expect(bell.querySelector("span")).toBeNull();
  });
  it("refreshes only matching hints and never accepts a count passed by the browser", async () => {
    load.mockResolvedValueOnce(4).mockResolvedValueOnce(3);
    render(<FamilyNotificationBell userId={uid} role="student" className="" />); await screen.findByRole("link", { name: "Open notifications, 4 unread" });
    fireEvent(window, new CustomEvent(familyNotificationsChangedEvent, { detail: { userId: "other", role: "student", count: 0 } }));
    fireEvent(window, new CustomEvent(familyNotificationsChangedEvent, { detail: { userId: uid, role: "parent", count: 0 } }));
    expect(load).toHaveBeenCalledOnce();
    fireEvent(window, new CustomEvent(familyNotificationsChangedEvent, { detail: { userId: uid, role: "student", count: 0 } }));
    expect(await screen.findByRole("link", { name: "Open notifications, 3 unread" })).toBeInTheDocument();
  });
  it("drops cached counts while refreshing and ignores aborted responses", async () => {
    const old = deferred<number>(), fresh = deferred<number>(); load.mockResolvedValueOnce(9).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    render(<FamilyNotificationBell userId={uid} role="parent" className="" />); await screen.findByRole("link", { name: "Open notifications, 9 unread" });
    fireEvent(window, new Event("focus")); expect(screen.queryByRole("link", { name: /9 unread/ })).not.toBeInTheDocument();
    const signal = load.mock.calls[1][2] as AbortSignal; fireEvent(document, new Event("visibilitychange")); expect(signal.aborted).toBe(true);
    await act(async () => fresh.resolve(2)); expect(screen.getByRole("link", { name: "Open notifications, 2 unread" })).toBeInTheDocument();
    await act(async () => old.resolve(99)); expect(screen.queryByRole("link", { name: /99 unread/ })).not.toBeInTheDocument();
  });
  it("hides an old account's bell and aborts pending requests on sign out", async () => {
    const pending = deferred<number>(); load.mockReturnValue(pending.promise);
    const view = render(<FamilyNotificationBell userId={uid} role="student" className="" />);
    const signal = load.mock.calls[0][2] as AbortSignal; act(() => authChanged("SIGNED_OUT", null)); expect(signal.aborted).toBe(true);
    expect(screen.queryByRole("link")).not.toBeInTheDocument(); await act(async () => pending.resolve(7)); expect(screen.queryByRole("link")).not.toBeInTheDocument();
    view.unmount(); expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("does not reuse counts across same-user role views or show stale counts after errors", async () => {
    const pending = deferred<number>(); load.mockResolvedValueOnce(8).mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error("network"));
    const view = render(<FamilyNotificationBell userId={uid} role="parent" className="" />); await screen.findByRole("link", { name: "Open notifications, 8 unread" });
    view.rerender(<FamilyNotificationBell userId={uid} role="student" className="" />);
    expect(screen.getByRole("link", { name: "Open notifications" })).toHaveAttribute("href", "/modules/notifications");
    await act(async () => pending.resolve(3)); await screen.findByRole("link", { name: "Open notifications, 3 unread" });
    fireEvent(window, new Event("focus")); await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("link", { name: "Open notifications" })).toBeInTheDocument(); expect(screen.queryByText("3")).not.toBeInTheDocument();
  });
});
