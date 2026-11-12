import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSchoolLateAlertSettings, parseSchoolLateAlertSettings, saveSchoolLateAlertSettings, type SchoolLateAlertSettingsIntent } from "@/lib/notifications/late-settings";

const { bound } = vi.hoisted(() => ({ bound: vi.fn() }));
vi.mock("@/lib/auth/staff-mfa", () => ({ boundMfaSession: bound }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const uid = id(1), school = id(2), signal = () => new AbortController().signal;
const empty = { user_id: uid, school_id: school, enabled: false, version: 0, history: [] };
const history = { version: 1, enabled: true, reason: "Pilot Late alerts", actor_id: uid, actor_name: "Asha Admin", created_at: "2026-11-07T15:00:00+00:00" };
const saved = { ...empty, enabled: true, version: 1, history: [history] };
const intent: SchoolLateAlertSettingsIntent = { schoolId: school, expectedVersion: 0, enabled: true, reason: "Pilot Late alerts", requestId: id(3) };
const ack = { user_id: uid, school_id: school, enabled: true, version: 1, request_id: id(3), replayed: false };
function client(data: unknown, error: { code: string } | null = null) {
  const request = Object.assign(Promise.resolve({ data, error }), { setHeader: vi.fn(), abortSignal: vi.fn() });
  request.setHeader.mockReturnValue(request); request.abortSignal.mockReturnValue(request);
  const rpc = vi.fn().mockReturnValue(request);
  return { rpc, request, client: { rpc } as unknown as SupabaseClient };
}
beforeEach(() => bound.mockReset().mockResolvedValue({ access_token: "owner-token" }));
describe("school Late policy client boundary", () => {
  it("accepts default OFF and complete newest-first history", () => {
    expect(parseSchoolLateAlertSettings(empty, uid, school)).toEqual(empty);
    expect(parseSchoolLateAlertSettings(saved, uid, school)).toEqual(saved);
    expect(parseSchoolLateAlertSettings({ ...saved, history: [{ ...history, actor_name: null }] }, uid, school).history[0].actor_name).toBeNull();
    const page = Array.from({ length: 20 }, (_, i) => ({ ...history, version: 30 - i }));
    expect(parseSchoolLateAlertSettings({ ...saved, version: 30, history: page }, uid, school).history).toHaveLength(20);
  });
  it.each([
    { user_id: id(9) }, { school_id: id(9) }, { version: "1" }, { version: -1 }, { version: Number.MAX_SAFE_INTEGER + 1 },
    { history: [] }, { history: [history, history] }, { history: [{ ...history, version: 2 }] },
    { history: [{ ...history, enabled: false }] }, { history: [{ ...history, actor_id: "bad" }] }, { history: [{ ...history, actor_name: undefined }] }, { history: [{ ...history, actor_name: 7 }] }, { history: [{ ...history, actor_name: "x".repeat(161) }] },
    { history: [{ ...history, created_at: "2026-11-07T15:00:00" }] }, { history: [{ ...history, reason: "bad\u202e reason" }] },
  ])("rejects foreign, incomplete or malformed saved policy", patch => {
    expect(() => parseSchoolLateAlertSettings({ ...saved, ...patch }, uid, school)).toThrow("could not be verified");
  });
  it("counts actor names in code points like the server's 160-character trim", () => {
    const name = "\u{1F600}".repeat(160); // 320 UTF-16 units
    expect(parseSchoolLateAlertSettings({ ...saved, history: [{ ...history, actor_name: name }] }, uid, school).history[0].actor_name).toBe(name);
    expect(() => parseSchoolLateAlertSettings({ ...saved, history: [{ ...history, actor_name: `${name}\u{1F600}` }] }, uid, school)).toThrow("could not be verified");
  });
  it("does not accept ON for an implicit no-policy state", () => {
    expect(() => parseSchoolLateAlertSettings({ ...empty, enabled: true }, uid, school)).toThrow();
  });
  it("pins reads to captured owner and checks the returned owner/school", async () => {
    const api = client(saved), abort = signal();
    expect(await loadSchoolLateAlertSettings(api.client, uid, school, abort)).toEqual(saved);
    expect(api.rpc).toHaveBeenCalledWith("get_school_late_alert_settings", { p_school_id: school });
    expect(api.request.setHeader).toHaveBeenCalledWith("Authorization", "Bearer owner-token");
    expect(api.request.abortSignal).toHaveBeenCalledWith(abort); expect(bound).toHaveBeenCalledTimes(2);
  });
  it("saves a frozen request and accepts its original replay acknowledgement", async () => {
    const api = client({ ...ack, replayed: true });
    expect(await saveSchoolLateAlertSettings(api.client, uid, intent, signal())).toEqual({ ...ack, replayed: true });
    expect(api.rpc).toHaveBeenCalledWith("set_school_late_alert_settings", { p_school_id: school, p_expected_version: 0, p_enabled: true, p_reason: intent.reason, p_request_id: intent.requestId });
    expect(api.request.setHeader).toHaveBeenCalledWith("Authorization", "Bearer owner-token"); expect(bound).toHaveBeenCalledTimes(2);
  });
  it.each([{ user_id: id(9) }, { school_id: id(9) }, { request_id: id(9) }, { enabled: false }, { version: 2 }, { replayed: "yes" }])("does not acknowledge another intent or version", async patch => {
    await expect(saveSchoolLateAlertSettings(client({ ...ack, ...patch }).client, uid, intent, signal())).rejects.toThrow("could not be verified");
  });
  it.each([{ expectedVersion: -1 }, { expectedVersion: Number.MAX_SAFE_INTEGER }, { requestId: "bad" }, { enabled: "true" }, { reason: "bad\nreason" }, { reason: null }])("rejects invalid intent before a request", async patch => {
    const api = client(ack);
    await expect(saveSchoolLateAlertSettings(api.client, uid, { ...intent, ...patch } as SchoolLateAlertSettingsIntent, signal())).rejects.toMatchObject({ code: "validation" });
    expect(api.rpc).not.toHaveBeenCalled();
  });
  it.each([["42501", "access"], ["PGRST301", "access"], ["PT409", "conflict"], ["40001", "conflict"], ["22023", "validation"], ["503", "unconfirmed"]])("maps %s without losing an unknown-write outcome", async (code, expected) => {
    await expect(saveSchoolLateAlertSettings(client(null, { code }).client, uid, intent, signal())).rejects.toMatchObject({ code: expected });
  });
  it("blocks switched owners before request and after a write/read response", async () => {
    const api = client(ack);
    bound.mockRejectedValueOnce(new Error("Changed"));
    await expect(saveSchoolLateAlertSettings(api.client, uid, intent, signal())).rejects.toMatchObject({ code: "access" }); expect(api.rpc).not.toHaveBeenCalled();
    bound.mockResolvedValueOnce({ access_token: "old-owner" }).mockRejectedValueOnce(new Error("Changed"));
    await expect(saveSchoolLateAlertSettings(api.client, uid, intent, signal())).rejects.toMatchObject({ code: "access" });
    bound.mockResolvedValueOnce({ access_token: "old-owner" }).mockResolvedValueOnce(null);
    await expect(loadSchoolLateAlertSettings(client(saved).client, uid, school, signal())).rejects.toMatchObject({ code: "access" });
  });
  it("never acknowledges an aborted request even when transport completes", async () => {
    const abort = new AbortController(); abort.abort();
    await expect(loadSchoolLateAlertSettings(client(saved).client, uid, school, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(saveSchoolLateAlertSettings(client(ack).client, uid, intent, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
