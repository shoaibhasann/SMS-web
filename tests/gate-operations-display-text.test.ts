import { describe, expect, it } from "vitest";
import { parseGateEvents, parseGatePupils, parseGateSetup } from "@/lib/attendance/gate-operations";

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const user = id(1), school = id(2), deviceId = id(3), pupil = id(4), date = "2026-11-07T09:00:00+05:30";
const marked = { student_name: "⁨Ayaan⁩ Khan", admission_no: "QA‎-01" };
const device = { device_id: deviceId, name: "Main gate", late_after: "08:10", working_days: [1, 2, 3, 4, 5], created_at: date, revoked_at: null };
const setup = () => ({ user_id: user, school_id: school, timezone: "Asia/Kolkata", page_size: 100, offset: 0, device_count: 1, devices: [{ ...device }], mapping_count: 1,
  mappings: [{ mapping_id: id(5), device_id: deviceId, subject_id: "CARD:001", student_id: pupil, valid_from: "2026-11-07", revoked_at: null, ...marked }] });
const event = (patch: Record<string, unknown> = {}) => ({ receipt_id: id(6), device_id: deviceId, event_id: "EV:01", subject_id: "CARD:001", direction: "IN", occurred_at: date, received_at: date,
  student_id: pupil, attendance_id: null, attendance_status: null, status: "held_review", reason: "future_clock", device_name: "Main gate", ...marked, ...patch });
const events = (patch: Record<string, unknown> = {}) => ({ user_id: user, school_id: school, offset: 0, page_size: 100, device_count: 1, total_count: 1, events: [event(patch)] });

describe("gate display text from stored pupil records", () => {
  it("strips invisible bidi/isolate marks from pupil names and admission numbers instead of blocking the workspace", () => {
    expect(parseGateSetup(setup(), user, school, 0).mappings[0]).toMatchObject({ student_name: "Ayaan Khan", admission_no: "QA-01" });
    expect(parseGateEvents(events(), user, school, 0).events[0]).toMatchObject({ student_name: "Ayaan Khan", admission_no: "QA-01" });
    expect(parseGateEvents(events({ student_name: null, admission_no: null }), user, school, 0).events[0]).toMatchObject({ student_name: null, admission_no: null });
    const pupils = { user_id: user, school_id: school, query: "Ayaan", offset: 0, page_size: 25, total_count: 1, pupils: [{ student_id: pupil, ...marked }] };
    expect(parseGatePupils(pupils, user, school, "Ayaan", 0).pupils[0]).toMatchObject({ student_name: "Ayaan Khan", admission_no: "QA-01" });
  });
  it("still rejects marks in admin-entered device names and pupil names that are only marks", () => {
    expect(() => parseGateEvents(events({ device_name: "Bad‮Name" }), user, school, 0)).toThrow();
    expect(() => parseGateEvents(events({ student_name: "⁨⁩" }), user, school, 0)).toThrow();
  });
});
