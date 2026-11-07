import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GateAlertPreferencesError, loadGateAlertPreferences, saveGateAlertPreferences, type GateAlertPreference } from "@/lib/notifications/gate-preferences";

const { bound } = vi.hoisted(() => ({ bound: vi.fn() }));
vi.mock("@/lib/auth/staff-mfa", () => ({ boundMfaSession: bound }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const uid = id(1), signal = () => new AbortController().signal;
const wire = { user_id: uid, student_id: id(2), preference_id: id(3), student_name: "First pupil", arrival_enabled: false, exit_enabled: false, version: 0 };
const next: GateAlertPreference = { student_id: id(2), preference_id: id(3), student_name: "First pupil", arrival: true, exit: false, version: 0 };
function client(data: unknown, error: { code: string } | null = null) {
  const request = Object.assign(Promise.resolve({ data, error }), { setHeader: vi.fn(), abortSignal: vi.fn() });
  request.setHeader.mockReturnValue(request); request.abortSignal.mockReturnValue(request);
  const rpc = vi.fn().mockReturnValue(request);
  return { rpc, request, client: { rpc } as unknown as SupabaseClient };
}
beforeEach(() => { bound.mockReset().mockResolvedValue({ user: { id: uid }, access_token: "owner-token" }); });
describe("gate preference owner and link-epoch boundary", () => {
  it("loads complete linked-child defaults with captured-owner header and cancellation", async () => {
    const saved = client({ user_id: uid, children: [wire] }), abort = signal();
    expect(await loadGateAlertPreferences(saved.client, uid, abort)).toEqual([{ ...next, arrival: false }]);
    expect(saved.rpc).toHaveBeenCalledWith("get_my_gate_alert_preferences");
    expect(saved.request.setHeader).toHaveBeenCalledWith("Authorization", "Bearer owner-token");
    expect(saved.request.abortSignal).toHaveBeenCalledWith(abort);
    expect(bound).toHaveBeenCalledWith(saved.client, uid, abort);
  });
  it.each([
    { user_id: id(9), children: [wire] }, { user_id: uid, children: [wire, wire] },
    { user_id: uid, children: [{ ...wire, preference_id: "invalid" }] },
    { user_id: uid, children: [{ ...wire, arrival_enabled: "false" }] },
    { user_id: uid, children: [{ ...wire, version: -1 }] }, { user_id: uid, children: null },
  ])("rejects malformed, wrong-owner and duplicate child data", async data => {
    await expect(loadGateAlertPreferences(client(data).client, uid, signal())).rejects.toThrow("could not be verified");
  });
  it("saves only the immutable link epoch/version and checks acknowledgement plus owner again", async () => {
    const saved = client({ ...wire, arrival_enabled: true, version: 1 });
    expect(await saveGateAlertPreferences(saved.client, uid, next, signal())).toEqual({ ...next, version: 1 });
    expect(saved.rpc).toHaveBeenCalledWith("set_my_gate_alert_preferences", { p_preference_id: next.preference_id, p_expected_version: 0, p_arrival_enabled: true, p_exit_enabled: false });
    expect(bound).toHaveBeenCalledTimes(2);
  });
  it.each([{ preference_id: id(8) }, { user_id: id(8) }, { student_id: id(8) }, { version: 2 }, { arrival_enabled: false }])("rejects stale/mismapped save acknowledgements", async patch => {
    await expect(saveGateAlertPreferences(client({ ...wire, arrival_enabled: true, version: 1, ...patch }).client, uid, next, signal())).rejects.toThrow("could not be verified");
  });
  it.each([["42501", "access"], ["PT409", "conflict"], ["503", "unconfirmed"]])("requires reconciliation on %s", async (code, expected) => {
    await expect(saveGateAlertPreferences(client(null, { code }).client, uid, next, signal())).rejects.toMatchObject({ code: expected });
  });
  it("cannot start a write under another owner or acknowledge a late owner switch", async () => {
    const saved = client({ ...wire, arrival_enabled: true, version: 1 });
    bound.mockRejectedValueOnce(new Error("Account changed"));
    await expect(saveGateAlertPreferences(saved.client, uid, next, signal())).rejects.toBeInstanceOf(GateAlertPreferencesError);
    expect(saved.rpc).not.toHaveBeenCalled();
    bound.mockResolvedValueOnce({ access_token: "old-token" }).mockRejectedValueOnce(new Error("Account changed"));
    await expect(saveGateAlertPreferences(saved.client, uid, next, signal())).rejects.toMatchObject({ code: "access" });
    expect(saved.request.setHeader).toHaveBeenCalledWith("Authorization", "Bearer old-token");
  });
  it("rejects cancelled reads even when a transport mock completes", async () => {
    const abort = new AbortController(); abort.abort();
    await expect(loadGateAlertPreferences(client({ user_id: uid, children: [] }).client, uid, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
