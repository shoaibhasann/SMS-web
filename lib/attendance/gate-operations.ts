import type { SupabaseClient } from "@supabase/supabase-js";
import { boundMfaSession } from "@/lib/auth/staff-mfa";
import { validCalendarDate } from "./calendar";
import { attendanceStatuses, type AttendanceStatus } from "./types";

export type GateDevice = { device_id: string; name: string; late_after: string; working_days: number[]; created_at: string; revoked_at: string | null };
export type GateMapping = { mapping_id: string; device_id: string; subject_id: string; student_id: string; valid_from: string; revoked_at: string | null; admission_no: string; student_name: string };
export type GateSetup = { user_id: string; school_id: string; timezone: "Asia/Kolkata"; page_size: 100; offset: number; device_count: number; devices: GateDevice[]; mapping_count: number; mappings: GateMapping[] };
export type GateEvent = { receipt_id: string; device_id: string; event_id: string; subject_id: string; direction: "IN" | "OUT"; occurred_at: string; received_at: string;
  student_id: string | null; attendance_id: string | null; attendance_status: AttendanceStatus | null; status: "accepted" | "held_review"; reason: string;
  device_name: string | null; student_name: string | null; admission_no: string | null };
export type GateEvents = { user_id: string; school_id: string; page_size: 100; offset: number; total_count: number; device_count: number; events: GateEvent[] };
export type GatePupil = { student_id: string; student_name: string; admission_no: string };
export type GatePupils = { user_id: string; school_id: string; query: string; offset: number; page_size: 25; total_count: number; pupils: GatePupil[] };
export type GateOperation =
  | { kind: "create_device"; schoolId: string; deviceId: string; name: string; secret: string; lateAfter: string; workingDays: number[] }
  | { kind: "map_student"; schoolId: string; deviceId: string; mappingId: string; subjectId: string; studentId: string }
  | { kind: "revoke_device"; schoolId: string; deviceId: string; reason: string }
  | { kind: "revoke_mapping"; schoolId: string; mappingId: string; reason: string };
export class GateOperationsError extends Error {
  constructor(message: string, readonly code: "access" | "validation" | "conflict" | "unconfirmed" = "unconfirmed") { super(message); this.name = "GateOperationsError"; }
}
export const gateReasonLabels: Record<string, string> = {
  marked_present: "Present recorded", marked_late: "Late recorded", already_marked: "Existing gate attendance retained", earlier_in_applied: "Earlier arrival applied",
  recorded_out: "Exit recorded; daily attendance retained", unknown_subject: "Student identifier is not mapped", historical_date: "Earlier date requires review", future_clock: "Device time is ahead",
  non_working_day: "School closed for this date", student_inactive: "Pupil is inactive", enrollment_unavailable: "Current enrollment could not be verified",
  roster_date_conflict: "Roster date needs review", approved_leave: "Approved leave retained", reviewed_attendance: "Reviewed attendance retained", manual_or_changed_mark: "Existing manual or changed attendance retained",
};
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
const text = (value: unknown, min: number, max: number): value is string => typeof value === "string" && value.trim().length >= min && value.length <= max && !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(value);
// Stored pupil names/admission numbers are display-only here; strip invisible marks instead of blocking the workspace.
function plainPupilText(row: Record<string, unknown>) {
  for (const key of ["student_name", "admission_no"]) if (typeof row[key] === "string") row[key] = (row[key] as string).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu, "");
  return row;
}
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const time = (value: unknown): value is string => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const timestamp = (value: unknown): value is string => typeof value === "string" && value.includes("T") && Number.isFinite(Date.parse(value));
const revoked = (value: unknown): value is string | null => value === null || timestamp(value);
const weekdays = (value: unknown): value is number[] => Array.isArray(value) && value.length >= 1 && value.length <= 7 && value.every(day => integer(day, 6)) && new Set(value).size === value.length;
const invalid = () => new GateOperationsError("Gate data could not be verified completely. Reload before making changes.");
function page(row: Record<string, unknown>, userId: string, schoolId: string, offset: number, size: number) {
  if (!uuid(userId) || !uuid(schoolId) || row.user_id !== userId || row.school_id !== schoolId || row.offset !== offset || row.page_size !== size || !integer(offset, 1000000)) throw invalid();
}
function unique(rows: unknown[], key: string) { return new Set(rows.map(row => object(row)[key])).size === rows.length; }
export function parseGateSetup(value: unknown, userId: string, schoolId: string, offset: number): GateSetup {
  const row = object(value); page(row, userId, schoolId, offset, 100);
  if (row.timezone !== "Asia/Kolkata" || !integer(row.device_count) || !integer(row.mapping_count)
    || !Array.isArray(row.devices) || row.devices.length !== Math.min(row.device_count, 100) || !unique(row.devices, "device_id")
    || !Array.isArray(row.mappings) || row.mappings.length !== Math.min(Math.max(row.mapping_count - offset, 0), 100) || !unique(row.mappings, "mapping_id")) throw invalid();
  let active = 0;
  for (const value of row.devices) {
    const device = object(value);
    if (!uuid(device.device_id) || !text(device.name, 1, 80) || !time(device.late_after) || !weekdays(device.working_days) || !timestamp(device.created_at) || !revoked(device.revoked_at)) throw invalid();
    if (device.revoked_at === null && ++active > 1) throw invalid();
  }
  for (const value of row.mappings) {
    const mapping = plainPupilText(object(value));
    if (!uuid(mapping.mapping_id) || !uuid(mapping.device_id) || !uuid(mapping.student_id) || !identifier(mapping.subject_id) || !validCalendarDate(mapping.valid_from)
      || !revoked(mapping.revoked_at) || !text(mapping.admission_no, 1, 200) || !text(mapping.student_name, 1, 500)) throw invalid();
  }
  return value as GateSetup;
}
export function parseGateEvents(value: unknown, userId: string, schoolId: string, offset: number): GateEvents {
  const row = object(value); page(row, userId, schoolId, offset, 100);
  if (!integer(row.total_count) || !integer(row.device_count) || !Array.isArray(row.events) || row.events.length !== Math.min(Math.max(row.total_count - offset, 0), 100) || !unique(row.events, "receipt_id")) throw invalid();
  for (const value of row.events) {
    const event = plainPupilText(object(value));
    if (!uuid(event.receipt_id) || !uuid(event.device_id) || !identifier(event.event_id) || !identifier(event.subject_id) || !["IN", "OUT"].includes(String(event.direction))
      || !timestamp(event.occurred_at) || !timestamp(event.received_at) || !["accepted", "held_review"].includes(String(event.status)) || !Object.hasOwn(gateReasonLabels, String(event.reason))
      || !(event.student_id === null || uuid(event.student_id)) || !(event.attendance_id === null || uuid(event.attendance_id))
      || !(event.attendance_status === null || attendanceStatuses.includes(event.attendance_status as AttendanceStatus)) || (event.attendance_id === null) !== (event.attendance_status === null)
      || !(event.device_name === null || text(event.device_name, 1, 80)) || !(event.student_name === null || text(event.student_name, 1, 500)) || !(event.admission_no === null || text(event.admission_no, 1, 200))) throw invalid();
  }
  return value as GateEvents;
}
export function parseGatePupils(value: unknown, userId: string, schoolId: string, query: string, offset: number): GatePupils {
  const row = object(value); page(row, userId, schoolId, offset, 25);
  if (row.query !== query.trim() || !text(row.query, 2, 80) || !integer(row.total_count) || !Array.isArray(row.pupils)
    || row.pupils.length !== Math.min(Math.max(row.total_count - offset, 0), 25) || !unique(row.pupils, "student_id")) throw invalid();
  for (const value of row.pupils) {
    const pupil = plainPupilText(object(value));
    if (!uuid(pupil.student_id) || !text(pupil.student_name, 1, 500) || !text(pupil.admission_no, 1, 200)) throw invalid();
  }
  return value as GatePupils;
}
function rpcError(error: { code?: string } | null, reading: boolean) {
  if (!error) return;
  if (["42501", "PGRST301", "PGRST302"].includes(error.code ?? "")) throw new GateOperationsError("Your gate access changed. Reopen Attendance and verify your authenticator.", "access");
  if (["PT409", "23505", "40001"].includes(error.code ?? "")) throw new GateOperationsError("Gate setup changed or this identifier was already used. Reload before choosing a replacement.", "conflict");
  if (error.code === "22023") throw new GateOperationsError("Check the device name, cutoff, weekdays, student identifier and reason.", "validation");
  throw new GateOperationsError(reading ? "Gate data could not be loaded. Reload to try again." : "The save outcome is unknown. Retry the same frozen action; do not create another credential or mapping.");
}
async function authorization(client: SupabaseClient, userId: string, signal: AbortSignal) {
  if (!uuid(userId)) throw new GateOperationsError("Sign in again to manage the school gate.", "access");
  const session = await boundMfaSession(client, userId, signal).catch(() => { signal.throwIfAborted(); throw new GateOperationsError("Your account changed. Reopen Attendance.", "access"); });
  signal.throwIfAborted();
  if (!session) throw new GateOperationsError("Sign in again to manage the school gate.", "access");
  return `Bearer ${session.access_token}`;
}
async function read(client: SupabaseClient, userId: string, schoolId: string, name: string, args: Record<string, unknown>, signal: AbortSignal) {
  if (!uuid(schoolId) || !integer(args.p_offset, 1000000)) throw invalid();
  const header = await authorization(client, userId, signal);
  const { data, error } = await client.rpc(name, { p_school_id: schoolId, ...args }).setHeader("Authorization", header).abortSignal(signal);
  signal.throwIfAborted(); rpcError(error, true); await authorization(client, userId, signal); return data;
}
export async function loadGateSetup(client: SupabaseClient, userId: string, schoolId: string, offset: number, signal: AbortSignal) {
  return parseGateSetup(await read(client, userId, schoolId, "get_gate_setup", { p_offset: offset }, signal), userId, schoolId, offset);
}
export async function loadGateEvents(client: SupabaseClient, userId: string, schoolId: string, offset: number, signal: AbortSignal) {
  return parseGateEvents(await read(client, userId, schoolId, "list_gate_events", { p_offset: offset }, signal), userId, schoolId, offset);
}
export async function searchGatePupils(client: SupabaseClient, userId: string, schoolId: string, query: string, offset: number, signal: AbortSignal) {
  if (!text(query.trim(), 2, 80)) throw new GateOperationsError("Search by at least two characters of the admission number or pupil name.", "validation");
  return parseGatePupils(await read(client, userId, schoolId, "search_gate_pupils", { p_query: query.trim(), p_offset: offset }, signal), userId, schoolId, query, offset);
}
export function createGateDeviceIntent(schoolId: string, name: string, lateAfter: string, workingDays: number[]): Extract<GateOperation, { kind: "create_device" }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return { kind: "create_device", schoolId, deviceId: crypto.randomUUID(), name: name.trim(), lateAfter, workingDays: [...workingDays].sort((a, b) => a - b),
    secret: btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") };
}
export async function saveGateOperation(client: SupabaseClient, userId: string, intent: GateOperation, signal: AbortSignal): Promise<{ revoked_at: string | null }> {
  if (!uuid(intent.schoolId)) throw new GateOperationsError("Choose a verified school.", "validation");
  let name: string, args: Record<string, unknown>;
  if (intent.kind === "create_device") {
    if (!uuid(intent.deviceId) || !text(intent.name, 1, 80) || intent.name !== intent.name.trim() || !/^[A-Za-z0-9_-]{43}$/.test(intent.secret) || !time(intent.lateAfter) || !weekdays(intent.workingDays)) throw new GateOperationsError("Enter a device name, valid cutoff and explicit fallback weekdays.", "validation");
    name = "create_gate_device"; args = { p_school_id: intent.schoolId, p_device_id: intent.deviceId, p_name: intent.name, p_secret: intent.secret, p_late_after: intent.lateAfter, p_working_days: [...intent.workingDays].sort((a, b) => a - b) };
  } else if (intent.kind === "map_student") {
    if (!uuid(intent.deviceId) || !uuid(intent.mappingId) || !uuid(intent.studentId) || !identifier(intent.subjectId)) throw new GateOperationsError("Select a pupil and enter its exact device identifier.", "validation");
    name = "map_gate_student"; args = { p_device_id: intent.deviceId, p_mapping_id: intent.mappingId, p_subject_id: intent.subjectId, p_student_id: intent.studentId };
  } else if (intent.kind === "revoke_device" || intent.kind === "revoke_mapping") {
    if (!text(intent.reason.trim(), 5, 300) || !(intent.kind === "revoke_device" ? uuid(intent.deviceId) : uuid(intent.mappingId))) throw new GateOperationsError("Use a 5–300 character revocation reason.", "validation");
    name = intent.kind === "revoke_device" ? "revoke_gate_device" : "revoke_gate_student_mapping";
    args = { ...(intent.kind === "revoke_device" ? { p_device_id: intent.deviceId } : { p_mapping_id: intent.mappingId }), p_reason: intent.reason.trim() };
  } else throw new GateOperationsError("Choose a supported gate action.", "validation");
  const header = await authorization(client, userId, signal);
  const { data, error } = await client.rpc(name, args).setHeader("Authorization", header).abortSignal(signal);
  signal.throwIfAborted(); rpcError(error, false); await authorization(client, userId, signal);
  const row = object(data);
  if (row.user_id !== userId || row.school_id !== intent.schoolId || !revoked(row.revoked_at) || (intent.kind === "revoke_device" || intent.kind === "revoke_mapping") && row.revoked_at === null) throw invalid();
  if (intent.kind === "create_device" ? row.device_id !== intent.deviceId || row.school_id !== intent.schoolId || row.name !== intent.name || row.timezone !== "Asia/Kolkata" || row.late_after !== intent.lateAfter || JSON.stringify(row.working_days) !== JSON.stringify(args.p_working_days)
    : intent.kind === "map_student" ? row.mapping_id !== intent.mappingId || row.device_id !== intent.deviceId || row.student_id !== intent.studentId || row.subject_id !== intent.subjectId || !validCalendarDate(row.valid_from)
      : intent.kind === "revoke_device" ? row.device_id !== intent.deviceId : row.mapping_id !== intent.mappingId) throw invalid();
  return { revoked_at: row.revoked_at };
}
