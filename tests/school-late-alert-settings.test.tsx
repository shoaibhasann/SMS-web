import type { Session } from "@supabase/supabase-js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SchoolLateAlertSettings } from "@/components/admin/school-late-alert-settings";
import { LateAlertSettingsError, type SchoolLateAlertSettings as Policy } from "@/lib/notifications/late-settings";

const { load, save, client } = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), client: { auth: { onAuthStateChange: vi.fn() } } }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => client }));
vi.mock("@/lib/notifications/late-settings", async original => ({ ...await original<typeof import("@/lib/notifications/late-settings")>(), loadSchoolLateAlertSettings: load, saveSchoolLateAlertSettings: save }));
const id = (value: number) => `81000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const userId = id(1), schoolId = id(2), requestId = id(3), timestamp = "2026-11-08T03:30:00Z", props = { userId, schoolId };
const policy = (overrides: Partial<Policy> = {}): Policy => ({ user_id: userId, school_id: schoolId, enabled: false, version: 0, history: [], ...overrides });
const history = (version = 1, enabled = true) => ({ version, enabled, reason: "School office approved", actor_id: userId, actor_name: "Asha Admin" as string | null, created_at: timestamp });
const ack = (overrides: Record<string, unknown> = {}) => ({ user_id: userId, school_id: schoolId, enabled: true, version: 1, request_id: requestId, replayed: false, ...overrides });
function pending<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
let changed: (event: string, session: Session | null) => void;
const unsubscribe = vi.fn();
const choice = () => screen.getByRole("checkbox", { name: "Send Guardian in-app Late attendance alerts" });
const reason = () => screen.getByRole("textbox", { name: "Late policy change reason" });
async function ready() { await screen.findByRole("form", { name: "Change school Late alert policy" }); }
function edit(nextReason = "School approved Late updates") { fireEvent.click(choice()); fireEvent.change(reason(), { target: { value: nextReason } }); }
beforeEach(() => {
  vi.restoreAllMocks(); load.mockReset().mockResolvedValue(policy()); save.mockReset().mockResolvedValue(ack()); unsubscribe.mockClear();
  client.auth.onAuthStateChange.mockImplementation((callback: typeof changed) => { changed = callback; return { data: { subscription: { unsubscribe } } }; });
  vi.spyOn(crypto, "randomUUID").mockReturnValue(requestId);
});

describe("School-controlled Guardian Late inbox alerts", () => {
  it("shows a skeleton until policy access is verified, without displaying a fabricated Off setting", () => {
    load.mockReturnValue(new Promise(() => {})); const { container } = render(<SchoolLateAlertSettings {...props} />);
    expect(container.querySelector('[data-skeleton="form"]')).toBeInTheDocument(); expect(screen.queryByRole("checkbox")).not.toBeInTheDocument(); expect(screen.queryByText("Saved policy: Off")).not.toBeInTheDocument(); expect(save).not.toHaveBeenCalled();
  });
  it("shows the server's implicit Off baseline and requires an explicit changed choice and reason", async () => {
    render(<SchoolLateAlertSettings {...props} />); await ready(); expect(choice()).not.toBeChecked(); expect(screen.getByText("Version 0")).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Save Late alert policy" })).toBeDisabled();
    expect(screen.getByText(/do not backfill old attendance/)).toBeInTheDocument(); expect(screen.getByText(/Absence alerts and Guardian arrival\/exit choices are separate/)).toBeInTheDocument(); expect(screen.getByText(/does not enable phone push, SMS or email/)).toBeInTheDocument(); expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    fireEvent.click(choice()); fireEvent.change(reason(), { target: { value: "four" } }); expect(screen.getByRole("button", { name: "Save Late alert policy" })).toBeDisabled(); fireEvent.change(reason(), { target: { value: "Ready" } }); expect(screen.getByRole("button", { name: "Save Late alert policy" })).toBeEnabled();
  });
  it("loads a currently enabled policy rather than assuming it is Off for every school", async () => {
    load.mockResolvedValue(policy({ enabled: true, version: 1, history: [history()] })); render(<SchoolLateAlertSettings {...props} />); await ready(); expect(choice()).toBeChecked(); expect(screen.getByText("Saved policy: On")).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Save Late alert policy" })).toBeDisabled();
  });
  it("saves an owner-scoped versioned request and reloads current policy after confirmation", async () => {
    render(<SchoolLateAlertSettings {...props} />); await ready(); edit("  Approved for school pilot  "); load.mockResolvedValue(policy({ enabled: true, version: 1, history: [history()] })); fireEvent.click(screen.getByRole("button", { name: "Save Late alert policy" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(client, userId, { schoolId, expectedVersion: 0, enabled: true, reason: "Approved for school pilot", requestId }, expect.any(AbortSignal)));
    await screen.findByText("Saved policy: On"); expect(reason()).toHaveValue(""); expect(screen.getByRole("status")).toHaveTextContent("Reloading the current saved policy"); expect(load).toHaveBeenCalledTimes(2);
  });
  it("allows disabling a saved enabled policy with an independently recorded reason", async () => {
    load.mockResolvedValue(policy({ enabled: true, version: 5, history: [history(5)] })); save.mockResolvedValue(ack({ enabled: false, version: 6 })); render(<SchoolLateAlertSettings {...props} />); await ready(); edit("Stop new Late updates"); load.mockResolvedValue(policy({ enabled: false, version: 6, history: [history(6, false), history(5)] })); fireEvent.click(screen.getByRole("button", { name: "Save Late alert policy" }));
    await waitFor(() => expect(save.mock.calls[0][2]).toEqual({ schoolId, expectedVersion: 5, enabled: false, reason: "Stop new Late updates", requestId })); await screen.findByText("Version 6"); expect(choice()).not.toBeChecked();
  });
  it("does not append a policy version for an unchanged choice even when a reason was entered", async () => {
    render(<SchoolLateAlertSettings {...props} />); await ready(); edit(); fireEvent.click(choice()); expect(screen.getByRole("button", { name: "Save Late alert policy" })).toBeDisabled(); fireEvent.submit(screen.getByRole("form", { name: "Change school Late alert policy" })); expect(save).not.toHaveBeenCalled();
  });
  it("freezes an unknown save and retries the same request without generating another ID", async () => {
    save.mockRejectedValueOnce(new LateAlertSettingsError("Policy outcome unknown")); render(<SchoolLateAlertSettings {...props} />); await ready(); edit(); fireEvent.click(screen.getByRole("button", { name: "Save Late alert policy" }));
    await screen.findByRole("button", { name: "Retry same Late policy save" }); const original = save.mock.calls[0][2]; expect(choice()).toBeDisabled(); expect(reason()).toBeDisabled(); expect(screen.queryByRole("button", { name: "Discard Late policy draft" })).not.toBeInTheDocument();
    load.mockResolvedValue(policy({ enabled: true, version: 1, history: [history()] })); fireEvent.click(screen.getByRole("button", { name: "Retry same Late policy save" })); await screen.findByText("Saved policy: On"); expect(save.mock.calls[1][2]).toBe(original); expect(crypto.randomUUID).toHaveBeenCalledOnce();
  });
  it("retains the frozen retry after a manual saved-policy check already shows the desired state", async () => {
    save.mockRejectedValueOnce(new LateAlertSettingsError("Unknown outcome")); render(<SchoolLateAlertSettings {...props} />); await ready(); edit(); fireEvent.click(screen.getByRole("button", { name: "Save Late alert policy" })); await screen.findByRole("button", { name: "Retry same Late policy save" });
    const original = save.mock.calls[0][2]; load.mockResolvedValue(policy({ enabled: true, version: 1, history: [history()] })); fireEvent.click(screen.getByRole("button", { name: "Reload saved Late policy" })); await screen.findByText("Saved policy: On"); expect(screen.getByRole("button", { name: "Retry same Late policy save" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry same Late policy save" })); await waitFor(() => expect(save).toHaveBeenCalledTimes(2)); expect(save.mock.calls[1][2]).toBe(original);
  });
  it("does not replace newer server policy with an older replay acknowledgement", async () => {
    load.mockResolvedValueOnce(policy({ version: 3, history: [history(3, false)] })).mockResolvedValueOnce(policy({ enabled: false, version: 5, history: [history(5, false), history(4), history(3, false)] })); save.mockResolvedValue(ack({ version: 4, replayed: true })); render(<SchoolLateAlertSettings {...props} />); await ready(); edit(); fireEvent.click(screen.getByRole("button", { name: "Save Late alert policy" }));
    await screen.findByText("Version 5"); expect(choice()).not.toBeChecked(); expect(screen.getByText("Saved policy: Off")).toBeInTheDocument(); expect(screen.getByRole("status")).toHaveTextContent("previous policy change is confirmed"); expect(save).toHaveBeenCalledOnce();
  });
  it("prevents duplicate writes while a save is in flight", async () => {
    const result = pending<ReturnType<typeof ack>>(); save.mockReturnValue(result.promise); render(<SchoolLateAlertSettings {...props} />); await ready(); edit(); const form = screen.getByRole("form", { name: "Change school Late alert policy" }); fireEvent.submit(form); fireEvent.submit(form);
    expect(save).toHaveBeenCalledOnce(); expect(crypto.randomUUID).toHaveBeenCalledOnce(); expect(screen.getByRole("button", { name: "Saving Late policy…" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Reload saved Late policy" })).toBeDisabled(); await act(async () => result.resolve(ack()));
  });
  it.each(["access", "conflict", "validation"] as const)("clears stale policy, history and draft after a %s failure without rebasing automatically", async code => {
    load.mockResolvedValue(policy({ version: 1, history: [history(1, false)] })); save.mockRejectedValueOnce(new LateAlertSettingsError("Verify current school policy", code)); const onLock = vi.fn(); render(<SchoolLateAlertSettings {...props} onLock={onLock} />); await ready(); edit(); fireEvent.click(screen.getByRole("button", { name: "Save Late alert policy" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Verify current school policy"); expect(screen.queryByRole("checkbox")).not.toBeInTheDocument(); expect(screen.queryByRole("region", { name: "Late alert policy history" })).not.toBeInTheDocument(); expect(onLock).toHaveBeenLastCalledWith(false);
    load.mockResolvedValue(policy({ enabled: true, version: 2, history: [history(2)] })); fireEvent.click(screen.getByRole("button", { name: "Reload saved Late policy" })); await screen.findByText("Version 2"); expect(reason()).toHaveValue(""); expect(screen.getByRole("button", { name: "Save Late alert policy" })).toBeDisabled(); expect(save).toHaveBeenCalledOnce();
  });
  it("treats a generic failed transport as an unknown outcome with a frozen request", async () => {
    save.mockRejectedValueOnce(new Error("Network failed")); render(<SchoolLateAlertSettings {...props} />); await ready(); edit(); fireEvent.click(screen.getByRole("button", { name: "Save Late alert policy" })); expect(await screen.findByRole("alert")).toHaveTextContent("save outcome is unknown"); expect(screen.getByRole("button", { name: "Retry same Late policy save" })).toBeEnabled();
  });
  it("clears all policy data and ignores delayed success after logout", async () => {
    const result = pending<ReturnType<typeof ack>>(); save.mockReturnValue(result.promise); render(<SchoolLateAlertSettings {...props} />); await ready(); edit(); fireEvent.click(screen.getByRole("button", { name: "Save Late alert policy" })); const signal = save.mock.calls[0][3] as AbortSignal;
    act(() => changed("SIGNED_OUT", null)); expect(signal.aborted).toBe(true); expect(screen.getByRole("alert")).toHaveTextContent("Your sign-in changed"); await act(async () => result.resolve(ack())); expect(screen.queryByRole("checkbox")).not.toBeInTheDocument(); expect(screen.queryByRole("status")).not.toBeInTheDocument(); expect(screen.getByRole("button", { name: "Reload saved Late policy" })).toBeDisabled();
  });
  it("remounts for another account and school without publishing the old owner's delayed acknowledgement", async () => {
    const result = pending<ReturnType<typeof ack>>(); save.mockReturnValue(result.promise); const { rerender } = render(<SchoolLateAlertSettings {...props} />); await ready(); edit(); fireEvent.click(screen.getByRole("button", { name: "Save Late alert policy" })); const signal = save.mock.calls[0][3] as AbortSignal;
    load.mockResolvedValue(policy({ user_id: id(8), school_id: id(9) })); rerender(<SchoolLateAlertSettings userId={id(8)} schoolId={id(9)} />); expect(signal.aborted).toBe(true); await ready(); await act(async () => result.resolve(ack())); expect(choice()).not.toBeChecked(); expect(screen.queryByRole("status")).not.toBeInTheDocument(); expect(unsubscribe).toHaveBeenCalled(); expect(load).toHaveBeenLastCalledWith(client, id(8), id(9), expect.any(AbortSignal));
  });
  it("ignores delayed old-school reads after the school scope changes", async () => {
    const old = pending<Policy>(); load.mockReturnValueOnce(old.promise); const { rerender } = render(<SchoolLateAlertSettings {...props} />); const signal = load.mock.calls[0][3] as AbortSignal;
    load.mockResolvedValue(policy({ school_id: id(9) })); rerender(<SchoolLateAlertSettings {...props} schoolId={id(9)} />); await ready(); expect(signal.aborted).toBe(true); await act(async () => old.resolve(policy({ enabled: true, version: 1, history: [history()] }))); expect(choice()).not.toBeChecked();
  });
  it("refreshes on focus and visibly discards only ordinary unsaved drafts", async () => {
    const onLock = vi.fn(); render(<SchoolLateAlertSettings {...props} onLock={onLock} />); await ready(); edit(); expect(onLock).toHaveBeenLastCalledWith(true); act(() => window.dispatchEvent(new Event("focus"))); await ready();
    expect(choice()).not.toBeChecked(); expect(reason()).toHaveValue(""); expect(screen.getByRole("status")).toHaveTextContent("Unsaved Late alert changes were cleared"); expect(onLock).toHaveBeenLastCalledWith(false); expect(load).toHaveBeenCalledTimes(2);
  });
  it("preserves an aborted in-flight request across focus and retries it after a fresh policy check", async () => {
    const old = pending<ReturnType<typeof ack>>(); save.mockReturnValueOnce(old.promise).mockResolvedValueOnce(ack({ replayed: true })); render(<SchoolLateAlertSettings {...props} />); await ready(); edit(); fireEvent.click(screen.getByRole("button", { name: "Save Late alert policy" })); const original = save.mock.calls[0][2], signal = save.mock.calls[0][3] as AbortSignal;
    load.mockResolvedValue(policy({ enabled: true, version: 1, history: [history()] })); act(() => window.dispatchEvent(new Event("focus"))); expect(signal.aborted).toBe(true); await screen.findByText("Saved policy: On"); expect(screen.getByRole("alert")).toHaveTextContent("exact request is retained");
    await act(async () => old.resolve(ack())); expect(screen.getByRole("button", { name: "Retry same Late policy save" })).toBeEnabled(); fireEvent.click(screen.getByRole("button", { name: "Retry same Late policy save" })); await screen.findByRole("status"); expect(save.mock.calls[1][2]).toBe(original);
  });
  it("does not let an aborted old callback unlock a newer retry", async () => {
    const old = pending<ReturnType<typeof ack>>(), fresh = pending<ReturnType<typeof ack>>(); save.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise); render(<SchoolLateAlertSettings {...props} />); await ready(); edit(); fireEvent.click(screen.getByRole("button", { name: "Save Late alert policy" }));
    act(() => window.dispatchEvent(new Event("focus"))); await ready(); fireEvent.click(screen.getByRole("button", { name: "Retry same Late policy save" })); const currentSignal = save.mock.calls[1][3] as AbortSignal; await act(async () => old.resolve(ack())); expect(currentSignal.aborted).toBe(false); expect(screen.getByRole("button", { name: "Saving Late policy…" })).toBeDisabled(); await act(async () => fresh.resolve(ack()));
  });
  it("does not lose a frozen request when its refreshed policy read temporarily fails", async () => {
    save.mockRejectedValueOnce(new LateAlertSettingsError("Unknown save")); render(<SchoolLateAlertSettings {...props} />); await ready(); edit(); fireEvent.click(screen.getByRole("button", { name: "Save Late alert policy" })); await screen.findByRole("button", { name: "Retry same Late policy save" }); const original = save.mock.calls[0][2];
    load.mockRejectedValueOnce(new LateAlertSettingsError("Read temporarily unavailable")); act(() => window.dispatchEvent(new Event("focus"))); await screen.findByText("Read temporarily unavailable"); load.mockResolvedValue(policy()); fireEvent.click(screen.getByRole("button", { name: "Reload saved Late policy" })); await ready(); fireEvent.click(screen.getByRole("button", { name: "Retry same Late policy save" })); await screen.findByRole("status"); expect(save.mock.calls[1][2]).toBe(original);
  });
  it("confirms discarding a dirty draft on manual reload without touching saved policy", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true); render(<SchoolLateAlertSettings {...props} />); await ready(); edit(); fireEvent.click(screen.getByRole("button", { name: "Reload saved Late policy" })); expect(choice()).toBeChecked(); expect(load).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Reload saved Late policy" })); await ready(); expect(choice()).not.toBeChecked(); expect(reason()).toHaveValue(""); expect(confirm).toHaveBeenCalledTimes(2); expect(save).not.toHaveBeenCalled();
  });
  it("locks outer school selection for a draft/frozen request and releases it on cleanup", async () => {
    const onLock = vi.fn(); const { unmount } = render(<SchoolLateAlertSettings {...props} onLock={onLock} />); await ready(); expect(onLock).toHaveBeenLastCalledWith(false); edit(); expect(onLock).toHaveBeenLastCalledWith(true);
    const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); expect(event.defaultPrevented).toBe(true); fireEvent.click(screen.getByRole("button", { name: "Discard Late policy draft" })); expect(onLock).toHaveBeenLastCalledWith(false); unmount(); expect(onLock).toHaveBeenLastCalledWith(false);
  });
  it("labels the bounded history honestly and displays policy actor, reason and IST timestamps", async () => {
    load.mockResolvedValue(policy({ enabled: true, version: 25, history: Array.from({ length: 20 }, (_, index) => history(25 - index, index % 2 === 0)) })); render(<SchoolLateAlertSettings {...props} />); await ready(); const region = screen.getByRole("region", { name: "Late alert policy history" });
    expect(within(region).getByText("Latest 20 saved versions; at most 20 are shown. Earlier policy history is retained.")).toBeInTheDocument(); expect(within(region).getAllByRole("listitem")).toHaveLength(20); expect(within(region).getAllByText("Changed by Asha Admin")).toHaveLength(20); expect(within(region).queryByText(new RegExp(userId))).not.toBeInTheDocument(); expect(within(region).getAllByText(/IST/)).toHaveLength(20); expect(within(region).getAllByText("School office approved")).toHaveLength(20);
  });
  it("shows Unknown user for a removed or other-school policy actor instead of the raw UUID", async () => {
    load.mockResolvedValue(policy({ enabled: true, version: 1, history: [{ ...history(), actor_name: null }] })); render(<SchoolLateAlertSettings {...props} />); await ready();
    const region = screen.getByRole("region", { name: "Late alert policy history" }); expect(within(region).getByText("Changed by Unknown user")).toBeInTheDocument(); expect(within(region).queryByText(new RegExp(userId))).not.toBeInTheDocument();
  });
  it("does not send invalid reasons or create a replacement request if secure UUID generation fails", async () => {
    render(<SchoolLateAlertSettings {...props} />); await ready(); edit("unsafe\u202ereason"); fireEvent.submit(screen.getByRole("form", { name: "Change school Late alert policy" })); expect(screen.getByRole("alert")).toHaveTextContent("without control characters"); expect(save).not.toHaveBeenCalled();
    fireEvent.change(reason(), { target: { value: "School approved" } }); vi.mocked(crypto.randomUUID).mockImplementation(() => { throw new Error("Unavailable"); }); fireEvent.click(screen.getByRole("button", { name: "Save Late alert policy" })); expect(screen.getByRole("alert")).toHaveTextContent("secure change request could not be created"); expect(save).not.toHaveBeenCalled(); expect(screen.queryByRole("button", { name: "Retry same Late policy save" })).not.toBeInTheDocument();
  });
});
