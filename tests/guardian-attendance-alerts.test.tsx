import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GuardianAttendanceAlerts } from "../components/family/guardian-attendance-alerts";

const { rpc, abortSignal, read, onAuthStateChange } = vi.hoisted(() => ({
  rpc: vi.fn(), abortSignal: vi.fn(), read: vi.fn(), onAuthStateChange: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ rpc, auth: { onAuthStateChange } }),
}));

const firstAlert = { id: "alert-one", student_name: "First pupil", attendance_date: "2026-11-05" };
const secondAlert = { id: "alert-two", student_name: "Second pupil", attendance_date: "2026-11-04" };
const noAlerts = { data: [], error: null };

beforeEach(() => {
  vi.resetAllMocks();
  rpc.mockReturnValue({ abortSignal });
  abortSignal.mockReturnValue({ returns: read });
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
    read.mockResolvedValueOnce({ data: [firstAlert], error: null }).mockImplementationOnce(() =>
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
    let finishOldRequest!: (result: { data: typeof firstAlert[]; error: null }) => void;
    read.mockImplementationOnce(() => new Promise((resolve) => { finishOldRequest = resolve; }))
      .mockResolvedValueOnce(noAlerts);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    try {
      render(<GuardianAttendanceAlerts userId="guardian" />);
      const initialSignal = abortSignal.mock.calls[0][0] as AbortSignal;
      fireEvent(document, new Event("visibilitychange"));
      expect(await screen.findByText("No attendance alerts for your linked children.")).toBeInTheDocument();
      expect(initialSignal.aborted).toBe(true);
      await act(async () => finishOldRequest({ data: [firstAlert], error: null }));
      expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
    } finally {
      visibility.mockRestore();
    }
  });

  it("hides loaded alert data if a different account signs in", async () => {
    read.mockResolvedValue({ data: [firstAlert], error: null });
    render(<GuardianAttendanceAlerts userId="guardian" />);
    expect(await screen.findByRole("listitem")).toBeInTheDocument();

    const notify = onAuthStateChange.mock.calls[0][0];
    act(() => notify("SIGNED_IN", { user: { id: "different-guardian" } }));
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Your sign-in changed.");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
