import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GuardianAttendanceAlerts } from "../components/family/guardian-attendance-alerts";

const { rpc, abortSignal, markSignal, read, mark, onAuthStateChange } = vi.hoisted(() => ({
  rpc: vi.fn(), abortSignal: vi.fn(), markSignal: vi.fn(), read: vi.fn(), mark: vi.fn(), onAuthStateChange: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ rpc, auth: { onAuthStateChange } }),
}));

type Alert = { id: string; student_name: string; attendance_date: string; read_at: string | null };
const firstAlert: Alert = { id: "alert-one", student_name: "First pupil", attendance_date: "2026-11-05", read_at: null };
const secondAlert: Alert = { id: "alert-two", student_name: "Second pupil", attendance_date: "2026-11-04", read_at: null };
const readAt = "2026-11-05T11:00:00Z";
function inbox(alerts: Alert[], unreadCount = alerts.filter((alert) => alert.read_at === null).length) {
  return { data: { alerts, unread_count: unreadCount }, error: null };
}
const noAlerts = inbox([]);

beforeEach(() => {
  vi.resetAllMocks();
  rpc.mockImplementation((name) => ({ abortSignal: name === "mark_guardian_absence_alert_read" ? markSignal : abortSignal }));
  abortSignal.mockReturnValue({ returns: read });
  markSignal.mockReturnValue({ returns: mark });
  onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
});

describe("guardian attendance alerts", () => {
  it("shows a recent summary across children and links to the full guardian inbox", async () => {
    const olderAlerts = Array.from({ length: 4 }, (_, index) => ({
      id: `older-${index}`, student_name: `Older pupil ${index}`, attendance_date: "2026-11-03",
    }));
    read.mockResolvedValue({ data: [firstAlert, secondAlert, ...olderAlerts], error: null });
    render(<GuardianAttendanceAlerts userId="guardian" summary />);

    const card = within(screen.getByRole("region", { name: "Attendance alerts" }));
    const alerts = await card.findAllByRole("listitem");
    expect(alerts).toHaveLength(5);
    expect(alerts[0]).toHaveTextContent("First pupil was marked absent.");
    expect(alerts[0].querySelector("time")).toHaveAttribute("datetime", firstAlert.attendance_date);
    expect(alerts[1]).toHaveTextContent("Second pupil was marked absent.");
    expect(card.getByRole("link", { name: "View all alerts" })).toHaveAttribute("href", "/modules/notifications?view=guardian");
    expect(rpc).toHaveBeenCalledExactlyOnceWith("list_guardian_absence_alerts");
  });

  it("clears the old result while refreshing and shows an empty result after access is revoked", async () => {
    let finishRefresh!: (result: typeof noAlerts) => void;
    read.mockResolvedValueOnce(inbox([firstAlert])).mockImplementationOnce(() =>
      new Promise<typeof noAlerts>((resolve) => { finishRefresh = resolve; }),
    );
    const user = userEvent.setup();
    render(<GuardianAttendanceAlerts userId="guardian" />);
    expect(await screen.findByRole("listitem")).toHaveTextContent("First pupil was marked absent.");

    await user.click(screen.getByRole("button", { name: "Refresh attendance alerts" }));
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
    await act(async () => finishRefresh(noAlerts));
    expect(screen.getByText("No attendance alerts for your linked children.")).toBeInTheDocument();
  });

  it("ignores an older request after the tab returns to the foreground", async () => {
    let finishOldRequest!: (result: ReturnType<typeof inbox>) => void;
    read.mockImplementationOnce(() => new Promise((resolve) => { finishOldRequest = resolve; }))
      .mockResolvedValueOnce(noAlerts);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    try {
      render(<GuardianAttendanceAlerts userId="guardian" />);
      const initialSignal = abortSignal.mock.calls[0][0] as AbortSignal;
      fireEvent(document, new Event("visibilitychange"));
      expect(await screen.findByText("No attendance alerts for your linked children.")).toBeInTheDocument();
      expect(initialSignal.aborted).toBe(true);
      await act(async () => finishOldRequest(inbox([firstAlert])));
      expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
    } finally {
      visibility.mockRestore();
    }
  });

  it("hides loaded alert data if a different account signs in", async () => {
    read.mockResolvedValue(inbox([firstAlert]));
    let finishMark!: (result: { data: string; error: null }) => void;
    mark.mockImplementationOnce(() => new Promise((resolve) => { finishMark = resolve; }));
    const user = userEvent.setup();
    render(<GuardianAttendanceAlerts userId="guardian" />);
    await user.click(await screen.findByRole("button", { name: /Mark as read: First pupil/ }));
    const signal = markSignal.mock.calls[0][0] as AbortSignal;

    const notify = onAuthStateChange.mock.calls[0][0];
    act(() => notify("SIGNED_IN", { user: { id: "different-guardian" } }));
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Your sign-in changed.");
    expect(signal.aborted).toBe(true);
    await act(async () => finishMark({ data: readAt, error: null }));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("marks a single alert and refreshes the unread count and ordering from the server", async () => {
    const savedInbox = inbox([secondAlert, { ...firstAlert, read_at: readAt }], 31);
    read.mockResolvedValueOnce(inbox([firstAlert, secondAlert], 32)).mockResolvedValue(savedInbox);
    let finishMark!: (result: { data: string; error: null }) => void;
    mark.mockImplementationOnce(() => new Promise((resolve) => { finishMark = resolve; }));
    const user = userEvent.setup();
    const { unmount } = render(<GuardianAttendanceAlerts userId="guardian" />);

    expect(await screen.findByText("32 unread")).toBeInTheDocument();
    const firstButton = screen.getByRole("button", { name: /Mark as read: First pupil/ });
    await user.click(firstButton);
    expect(firstButton).toBeDisabled();
    expect(firstButton).toHaveTextContent("Saving…");
    expect(screen.getByRole("button", { name: /Mark as read: Second pupil/ })).toBeDisabled();
    expect(rpc).toHaveBeenCalledWith("mark_guardian_absence_alert_read", { p_alert_id: firstAlert.id });
    expect(mark).toHaveBeenCalledTimes(1);

    await act(async () => finishMark({ data: readAt, error: null }));
    expect(await screen.findByText("31 unread")).toBeInTheDocument();
    const [unread, previouslyRead] = screen.getAllByRole("listitem");
    expect(unread).toHaveTextContent("Second pupil");
    expect(within(unread).getByText("Unread")).toBeInTheDocument();
    expect(previouslyRead).toHaveTextContent("First pupil");
    expect(within(previouslyRead).getByText("Read")).toBeInTheDocument();
    expect(within(previouslyRead).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Attendance alerts" })).toHaveFocus();

    unmount();
    render(<GuardianAttendanceAlerts userId="guardian" />);
    expect(await screen.findByText("31 unread")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Mark as read: First pupil/ })).not.toBeInTheDocument();
  });

  it("allows retry after a write failure and refreshes if the alert is no longer available", async () => {
    read.mockResolvedValueOnce(inbox([firstAlert])).mockResolvedValueOnce(noAlerts);
    mark.mockResolvedValueOnce({ data: null, error: { message: "request failed" } })
      .mockResolvedValueOnce({ data: null, error: null });
    const user = userEvent.setup();
    render(<GuardianAttendanceAlerts userId="guardian" />);

    const button = await screen.findByRole("button", { name: /Mark as read: First pupil/ });
    await user.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not mark the alert as read.");
    expect(screen.getByText("1 unread")).toBeInTheDocument();
    expect(button).toBeEnabled();

    await user.click(button);
    expect(await screen.findByText("0 unread")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("This alert is no longer available.");
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });
});
