import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GateAlertPreferences } from "@/components/family/gate-alert-preferences";
import { GateAlertPreferencesError, type GateAlertPreference } from "@/lib/notifications/gate-preferences";
import { familyNotificationsChangedEvent } from "@/lib/notifications/family";

const { load, save, subscribe, unsubscribe } = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { onAuthStateChange: subscribe } }) }));
vi.mock("@/lib/notifications/gate-preferences", async original => ({ ...await original<typeof import("@/lib/notifications/gate-preferences")>(), loadGateAlertPreferences: load, saveGateAlertPreferences: save }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const uid = id(1), first: GateAlertPreference = { student_id: id(2), preference_id: id(3), student_name: "First pupil", arrival: false, exit: false, version: 0 };
const second = { ...first, student_id: id(4), preference_id: id(5), student_name: "Second pupil" };
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; }
let changed: (event: string, session: { user: { id: string } } | null) => void;
beforeEach(() => {
  vi.resetAllMocks(); load.mockResolvedValue([first, second]); save.mockResolvedValue({ ...first, arrival: true, version: 1 });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  subscribe.mockImplementation(callback => { changed = callback; return { data: { subscription: { unsubscribe } } }; });
});
describe("linked-child gate preference card", () => {
  it("shows independent default-OFF choices and keeps absence alerts explicit", async () => {
    render(<GateAlertPreferences userId={uid} />);
    for (const name of ["Arrival alerts for First pupil", "Exit alerts for First pupil", "Arrival alerts for Second pupil", "Exit alerts for Second pupil"]) {
      expect(await screen.findByRole("checkbox", { name })).not.toBeChecked();
    }
    expect(screen.getByText(/Absence alerts continue independently/)).toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: "Save" })) expect(button).toBeDisabled();
    expect(load.mock.calls[0][1]).toBe(uid);
  });
  it("saves one captured child/epoch, verifies fresh choices and refreshes scoped inbox counts", async () => {
    load.mockResolvedValueOnce([first, second]).mockResolvedValue([{ ...first, arrival: true, version: 1 }, second]);
    const hint = vi.fn(); window.addEventListener(familyNotificationsChangedEvent, hint);
    try {
      const user = userEvent.setup(); render(<GateAlertPreferences userId={uid} />);
      await user.click(await screen.findByRole("checkbox", { name: "Arrival alerts for First pupil" }));
      await user.click(within(screen.getByRole("form", { name: "Gate alerts for First pupil" })).getByRole("button", { name: "Save" }));
      expect(await screen.findByRole("status")).toHaveTextContent("Gate preferences saved for First pupil");
      expect(save.mock.calls[0][1]).toBe(uid); expect(save.mock.calls[0][2]).toEqual({ ...first, arrival: true });
      expect(screen.getByRole("checkbox", { name: "Arrival alerts for Second pupil" })).not.toBeChecked();
      expect(hint.mock.calls[0][0].detail).toEqual({ userId: uid, role: "parent" });
    } finally { window.removeEventListener(familyNotificationsChangedEvent, hint); }
  });
  it("preserves another child's unsaved choices only while its saved epoch and version are unchanged", async () => {
    load.mockResolvedValueOnce([first, second]).mockResolvedValue([{ ...first, arrival: true, version: 1 }, second]);
    const user = userEvent.setup(); render(<GateAlertPreferences userId={uid} />);
    await user.click(await screen.findByRole("checkbox", { name: "Arrival alerts for First pupil" }));
    await user.click(screen.getByRole("checkbox", { name: "Exit alerts for Second pupil" }));
    await user.click(within(screen.getByRole("form", { name: "Gate alerts for First pupil" })).getByRole("button", { name: "Save" }));
    await screen.findByRole("status");
    expect(screen.getByRole("checkbox", { name: "Exit alerts for Second pupil" })).toBeChecked();
    expect(within(screen.getByRole("form", { name: "Gate alerts for Second pupil" })).getByRole("button", { name: "Save" })).toBeEnabled();
    expect(within(screen.getByRole("form", { name: "Gate alerts for First pupil" })).getByRole("button", { name: "Save" })).toBeDisabled();
  });
  it.each([{ preference_id: id(9) }, { version: 1 }])("replaces another child's stale draft after its epoch/version changes remotely", async patch => {
    load.mockResolvedValueOnce([first, second]).mockResolvedValue([{ ...first, arrival: true, version: 1 }, { ...second, ...patch }]);
    const user = userEvent.setup(); render(<GateAlertPreferences userId={uid} />);
    await user.click(await screen.findByRole("checkbox", { name: "Arrival alerts for First pupil" }));
    await user.click(screen.getByRole("checkbox", { name: "Exit alerts for Second pupil" }));
    await user.click(within(screen.getByRole("form", { name: "Gate alerts for First pupil" })).getByRole("button", { name: "Save" }));
    await screen.findByRole("status");
    expect(screen.getByRole("checkbox", { name: "Exit alerts for Second pupil" })).not.toBeChecked();
    expect(within(screen.getByRole("form", { name: "Gate alerts for Second pupil" })).getByRole("button", { name: "Save" })).toBeDisabled();
  });
  it("keeps unsaved choices on focus/visibility and confirms an explicit discard", async () => {
    const user = userEvent.setup(); render(<GateAlertPreferences userId={uid} />);
    await user.click(await screen.findByRole("checkbox", { name: "Arrival alerts for First pupil" }));
    fireEvent(window, new Event("focus")); fireEvent(document, new Event("visibilitychange"));
    expect(load).toHaveBeenCalledOnce(); expect(screen.getByRole("checkbox", { name: "Arrival alerts for First pupil" })).toBeChecked();
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await user.click(screen.getByRole("button", { name: "Refresh gate preferences" }));
    expect(load).toHaveBeenCalledOnce(); expect(screen.getByRole("checkbox", { name: "Arrival alerts for First pupil" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Refresh gate preferences" }));
    expect(await screen.findByRole("checkbox", { name: "Arrival alerts for First pupil" })).not.toBeChecked();
    expect(load).toHaveBeenCalledTimes(2);
  });
  it.each(["unconfirmed", "conflict"] as const)("requires a fresh authorized read after an %s save", async code => {
    save.mockRejectedValueOnce(new GateAlertPreferencesError("Refresh saved choices first.", code));
    const user = userEvent.setup(); render(<GateAlertPreferences userId={uid} />);
    const checkbox = await screen.findByRole("checkbox", { name: "Arrival alerts for First pupil" }); await user.click(checkbox);
    const form = within(screen.getByRole("form", { name: "Gate alerts for First pupil" })); await user.click(form.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Refresh saved choices first."); expect(checkbox).toBeChecked(); expect(checkbox).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "Gate alerts for First pupil" })); expect(save).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Refresh gate preferences" }));
    expect(await screen.findByRole("checkbox", { name: "Arrival alerts for First pupil" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Arrival alerts for First pupil" })).toBeEnabled();
  });
  it("hides revoked children on refresh and does not offer an old epoch after re-invitation", async () => {
    load.mockResolvedValueOnce([first]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...first, preference_id: id(9) }]);
    const user = userEvent.setup(); render(<GateAlertPreferences userId={uid} />); await screen.findByRole("checkbox", { name: /Arrival alerts/ });
    await user.click(screen.getByRole("button", { name: "Refresh gate preferences" })); await screen.findByText("No linked children are available for gate preferences.");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh gate preferences" })); await user.click(await screen.findByRole("checkbox", { name: /Arrival alerts/ }));
    await user.click(screen.getByRole("button", { name: "Save" })); await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][2].preference_id).toBe(id(9));
  });
  it("clears all child controls on access denial", async () => {
    save.mockRejectedValueOnce(new GateAlertPreferencesError("Child access changed.", "access"));
    const user = userEvent.setup(); render(<GateAlertPreferences userId={uid} />);
    await user.click(await screen.findByRole("checkbox", { name: /Arrival alerts for First/ }));
    await user.click(within(screen.getByRole("form", { name: /First pupil/ })).getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Child access changed."); expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
  it("aborts a pending write, clears drafts and rejects late saved UI after an account switch", async () => {
    const pending = deferred<GateAlertPreference>(); save.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup(), view = render(<GateAlertPreferences userId={uid} />);
    await user.click(await screen.findByRole("checkbox", { name: /Arrival alerts for First/ }));
    await user.click(within(screen.getByRole("form", { name: /First pupil/ })).getByRole("button", { name: "Save" }));
    const signal = save.mock.calls[0][3] as AbortSignal; act(() => changed("SIGNED_IN", { user: { id: id(9) } }));
    expect(signal.aborted).toBe(true); expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await act(async () => pending.resolve({ ...first, arrival: true, version: 1 })); expect(load).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toHaveTextContent("Your sign-in changed"); view.unmount(); expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("drops old owner data immediately and cancels stale reads on a focus refresh", async () => {
    const old = deferred<GateAlertPreference[]>(), latest = deferred<GateAlertPreference[]>();
    load.mockResolvedValueOnce([first]).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const view = render(<GateAlertPreferences userId={uid} />); await screen.findByRole("checkbox", { name: /Arrival alerts for First/ });
    view.rerender(<GateAlertPreferences userId={id(8)} />); expect(screen.queryByText(first.student_name)).not.toBeInTheDocument();
    const signal = load.mock.calls[1][2] as AbortSignal; fireEvent(window, new Event("focus")); expect(signal.aborted).toBe(true);
    await act(async () => latest.resolve([second])); await act(async () => old.resolve([first]));
    expect(screen.queryByText(first.student_name)).not.toBeInTheDocument(); expect(screen.getByText(second.student_name)).toBeInTheDocument();
  });
});
