import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGateDeviceIntent, loadGateEvents, loadGateSetup, parseGateEvents, parseGatePupils, parseGateSetup, saveGateOperation, searchGatePupils, type GateOperation } from "@/lib/attendance/gate-operations";

const { bound } = vi.hoisted(() => ({ bound: vi.fn() }));
vi.mock("@/lib/auth/staff-mfa", () => ({ boundMfaSession: bound }));
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const user = id(1), school = id(2), deviceId = id(3), pupil = id(4), mappingId = id(5), date = "2026-11-07T09:00:00+05:30";
const device = { device_id: deviceId, name: "Main gate", late_after: "08:10", working_days: [1, 2, 3, 4, 5], created_at: date, revoked_at: null };
const mapping = { mapping_id: mappingId, device_id: deviceId, subject_id: "CARD:001", student_id: pupil, valid_from: "2026-11-07", revoked_at: null, admission_no: "QA-01", student_name: "Pupil One" };
const setup = () => ({ user_id: user, school_id: school, timezone: "Asia/Kolkata", page_size: 100, offset: 0, device_count: 1, devices: [{ ...device }], mapping_count: 1, mappings: [{ ...mapping }] });
const event = () => ({ receipt_id: id(6), device_id: deviceId, event_id: "EV:01", subject_id: "CARD:001", direction: "IN", occurred_at: date, received_at: date,
  student_id: pupil, attendance_id: null, attendance_status: null, status: "held_review", reason: "future_clock", device_name: "Main gate", student_name: "Pupil One", admission_no: "QA-01" });
const events = () => ({ user_id: user, school_id: school, offset: 0, page_size: 100, device_count: 1, total_count: 1, events: [event()] });
const pupils = () => ({ user_id: user, school_id: school, query: "QA", offset: 0, page_size: 25, total_count: 1, pupils: [{ student_id: pupil, admission_no: "QA-01", student_name: "Pupil One" }] });
function client(data: unknown, error: { code: string } | null = null) {
  const query = { setHeader: vi.fn(), abortSignal: vi.fn().mockResolvedValue({ data, error }) }; query.setHeader.mockReturnValue(query);
  const rpc = vi.fn().mockReturnValue(query); return { client: { rpc } as unknown as SupabaseClient, rpc, query };
}
const signal = () => new AbortController().signal;
beforeEach(() => { vi.restoreAllMocks(); bound.mockReset().mockResolvedValue({ user: { id: user }, access_token: "native-test-only" }); });

describe("gate Office response contracts", () => {
  it("retains current and revoked setup history without credentials", () => {
    const value = setup(); value.devices[0].revoked_at = date as never;
    expect(parseGateSetup(value, user, school, 0).devices[0].revoked_at).toBe(date);
    expect(parseGateEvents(events(), user, school, 0).events[0].reason).toBe("future_clock");
    expect(parseGatePupils(pupils(), user, school, " QA ", 0).pupils[0].student_id).toBe(pupil);
    expect(JSON.stringify(value)).not.toMatch(/secret|password|Bearer/);
  });
  it.each([{ user_id: id(80) }, { school_id: id(80) }, { timezone: "UTC" }, { device_count: 2 }, { mapping_count: 2 }, { offset: 100 }, { page_size: 20 }])("rejects wrong scope or truncated setup %j", patch => {
    expect(() => parseGateSetup({ ...setup(), ...patch }, user, school, 0)).toThrow();
  });
  it("rejects duplicate devices/mappings and multiple active gateways", () => {
    for (const patch of [{ devices: [device, device], device_count: 2 }, { devices: [device, { ...device, device_id: id(81) }], device_count: 2 }, { mappings: [mapping, mapping], mapping_count: 2 }]) {
      expect(() => parseGateSetup({ ...setup(), ...patch }, user, school, 0)).toThrow();
    }
  });
  it.each([{ direction: "AUTO" }, { reason: "unknown-provider-outcome" }, { attendance_id: id(7) }, { student_id: "wrong" }, { device_name: "Bad\u202eName" }, { occurred_at: "yesterday" }])("rejects unverifiable event receipts %j", patch => {
    expect(() => parseGateEvents({ ...events(), events: [{ ...event(), ...patch }] }, user, school, 0)).toThrow();
  });
  it("validates complete pages instead of silently hiding mappings or pupils", () => {
    expect(() => parseGateEvents({ ...events(), total_count: 2 }, user, school, 0)).toThrow();
    expect(() => parseGatePupils({ ...pupils(), total_count: 26 }, user, school, "QA", 0)).toThrow();
    expect(() => parseGatePupils(pupils(), user, school, "other", 0)).toThrow();
    const last = { ...pupils(), offset: 25, total_count: 26 };
    expect(parseGatePupils(last, user, school, "QA", 25).pupils).toHaveLength(1);
  });
});
describe("native-bound gate operations", () => {
  it("loads all three narrow RPCs with a pinned token and a fresh identity recheck", async () => {
    for (const [name, value, action, args] of [
      ["get_gate_setup", setup(), (c: SupabaseClient) => loadGateSetup(c, user, school, 0, signal()), { p_offset: 0 }],
      ["list_gate_events", events(), (c: SupabaseClient) => loadGateEvents(c, user, school, 0, signal()), { p_offset: 0 }],
      ["search_gate_pupils", pupils(), (c: SupabaseClient) => searchGatePupils(c, user, school, " QA ", 0, signal()), { p_query: "QA", p_offset: 0 }],
    ] as const) {
      const api = client(value); bound.mockClear(); await action(api.client);
      expect(api.rpc).toHaveBeenCalledWith(name, { p_school_id: school, ...args });
      expect(api.query.setHeader).toHaveBeenCalledWith("Authorization", "Bearer native-test-only"); expect(bound).toHaveBeenCalledTimes(2);
    }
  });
  it("rejects an account change, cancellation and too-short search before displaying results", async () => {
    const api = client(setup()); bound.mockResolvedValueOnce({ access_token: "old" }).mockRejectedValueOnce(new Error("Changed"));
    await expect(loadGateSetup(api.client, user, school, 0, signal())).rejects.toMatchObject({ code: "access" });
    const controller = new AbortController(); controller.abort();
    await expect(loadGateSetup(api.client, user, school, 0, controller.signal)).rejects.toThrow();
    api.rpc.mockClear(); await expect(searchGatePupils(api.client, user, school, "Q", 0, signal())).rejects.toMatchObject({ code: "validation" }); expect(api.rpc).not.toHaveBeenCalled();
  });
  it.each([["42501", "access"], ["PT409", "conflict"], ["23505", "conflict"], ["22023", "validation"], ["network", "unconfirmed"]])("classifies %s safely as %s", async (code, category) => {
    await expect(loadGateSetup(client(null, { code }).client, user, school, 0, signal())).rejects.toMatchObject({ code: category });
  });
  it("uses cryptographically generated credential intent without choosing defaults", () => {
    const generator = vi.spyOn(crypto, "getRandomValues");
    const weekdays = [5, 1], intent = createGateDeviceIntent(school, " Main gate ", "08:10", weekdays);
    expect(generator).toHaveBeenCalledOnce(); expect(intent.secret).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(intent.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(intent.workingDays).toEqual([1, 5]); expect(weekdays).toEqual([5, 1]); expect(intent.name).toBe("Main gate");
  });
  it("confirms exact create retries, including a retired result without presenting reactivation", async () => {
    const intent = createGateDeviceIntent(school, "Main gate", "08:10", [5, 1]);
    const value = { user_id: user, device_id: intent.deviceId, school_id: school, name: intent.name, timezone: "Asia/Kolkata", late_after: "08:10", working_days: [1, 5], revoked_at: date };
    const api = client(value); expect(await saveGateOperation(api.client, user, intent, signal())).toEqual({ revoked_at: date });
    await saveGateOperation(api.client, user, intent, signal()); expect(api.rpc.mock.calls[0]).toEqual(api.rpc.mock.calls[1]);
    expect(api.rpc).toHaveBeenCalledWith("create_gate_device", expect.objectContaining({ p_secret: intent.secret, p_device_id: intent.deviceId }));
  });
  it("saves and checks exact pupil mapping and revoke acknowledgements", async () => {
    const mapIntent: GateOperation = { kind: "map_student", schoolId: school, deviceId, mappingId, subjectId: "CARD:001", studentId: pupil };
    const mapAck = { ...mapping, user_id: user, school_id: school };
    expect(await saveGateOperation(client(mapAck).client, user, mapIntent, signal())).toEqual({ revoked_at: null });
    for (const kind of ["revoke_device", "revoke_mapping"] as const) {
      const intent = kind === "revoke_device" ? { kind, schoolId: school, deviceId, reason: " Replace device " } : { kind, schoolId: school, mappingId, reason: " Replace card " };
      const ack = kind === "revoke_device" ? { user_id: user, school_id: school, device_id: deviceId, revoked_at: date } : { user_id: user, school_id: school, mapping_id: mappingId, revoked_at: date };
      expect(await saveGateOperation(client(ack).client, user, intent, signal())).toEqual({ revoked_at: date });
      await expect(saveGateOperation(client({ ...ack, revoked_at: null }).client, user, intent, signal())).rejects.toMatchObject({ code: "unconfirmed" });
    }
    for (const patch of [{ student_id: id(80) }, { user_id: id(80) }, { school_id: id(80) }]) await expect(saveGateOperation(client({ ...mapAck, ...patch }).client, user, mapIntent, signal())).rejects.toThrow();
  });
  it.each([{ lateAfter: "24:00" }, { workingDays: [] }, { workingDays: [1, 1] }, { name: "Bad\nDevice" }, { secret: "guessable" }])("rejects unsafe device intent before RPC %j", async patch => {
    const intent = { ...createGateDeviceIntent(school, "Main gate", "08:10", [1]), ...patch }, api = client(null);
    await expect(saveGateOperation(api.client, user, intent, signal())).rejects.toMatchObject({ code: "validation" }); expect(api.rpc).not.toHaveBeenCalled();
  });
});
