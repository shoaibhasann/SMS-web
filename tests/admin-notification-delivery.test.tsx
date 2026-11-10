import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminNotificationDelivery } from "../components/admin/admin-notification-delivery";

const { rpc, boundMfaSession } = vi.hoisted(() => ({ rpc: vi.fn(), boundMfaSession: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc }) }));
vi.mock("@/lib/auth/staff-mfa", async (original) => ({ ...await original<typeof import("@/lib/auth/staff-mfa")>(), boundMfaSession }));

const counts = { queued: 3, leased: 1, accepted: 8, failed: 2, cancelled: 4 };
const snapshot = { data: { counts }, error: null };
const setupError = { data: null, error: { code: "42501", message: "Verify your authenticator to view mobile push delivery." } };
const fetchStatus = vi.fn();

function rpcResponse(result: unknown) {
  const abortSignal = vi.fn().mockResolvedValue(result);
  const setHeader = vi.fn().mockReturnValue({ abortSignal });
  rpc.mockReturnValueOnce({ setHeader });
  return { setHeader, abortSignal };
}

beforeEach(() => {
  vi.resetAllMocks();
  boundMfaSession.mockImplementation(async (_client, userId: string) => ({ access_token: `token-${userId}` }));
  fetchStatus.mockImplementation(async () => Response.json({ configured: false, nativeAppRequired: true }));
  vi.stubGlobal("fetch", fetchStatus);
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("school mobile delivery monitor", () => {
  it("reads school totals with the verified token and clears them if refresh fails", async () => {
    const { setHeader } = rpcResponse(snapshot);
    render(<AdminNotificationDelivery userId="actor" schoolId="school" />);
    expect(await screen.findByText("Sender setup pending")).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith("get_school_push_delivery_summary", { p_school_id: "school" });
    expect(setHeader).toHaveBeenCalledWith("Authorization", "Bearer token-actor");
    expect(screen.getByText("Accepted by Firebase").parentElement).toHaveTextContent("8");
    expect(screen.getByText("Phone receipt is verified separately")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Notices & Circulars" })).toHaveAttribute("href", "/modules/notices");

    rpcResponse({ data: null, error: { code: "XX000", message: "internal error" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(screen.queryByText("Accepted by Firebase")).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded");
    expect(screen.queryByText("internal error")).not.toBeInTheDocument();
  });

  it("shows authenticator setup without loading readiness for an AAL1 session", async () => {
    rpcResponse(setupError);
    render(<AdminNotificationDelivery userId="actor" schoolId="school" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(setupError.error.message);
    expect(screen.getByRole("link", { name: "Set up authenticator" })).toHaveAttribute("href", "/mfa?next=%2Fmodules%2Fnotifications&setup=1");
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  it("ignores a late result after the workspace switches accounts", async () => {
    let resolve!: (value: typeof snapshot) => void;
    const oldRequest = new Promise<typeof snapshot>((finish) => { resolve = finish; });
    const { abortSignal } = rpcResponse(oldRequest);
    const view = render(<AdminNotificationDelivery key="old" userId="old" schoolId="school" />);
    await waitFor(() => expect(abortSignal).toHaveBeenCalledOnce());
    const signal = abortSignal.mock.calls[0][0] as AbortSignal;

    rpcResponse(setupError);
    view.rerender(<AdminNotificationDelivery key="new" userId="new" schoolId="other-school" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(setupError.error.message);
    expect(signal.aborted).toBe(true);
    await act(async () => { resolve(snapshot); });
    expect(screen.queryByText("Accepted by Firebase")).not.toBeInTheDocument();
    expect(fetchStatus).not.toHaveBeenCalled();
  });
});
