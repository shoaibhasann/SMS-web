import type { SupabaseClient } from "@supabase/supabase-js";

export const auditPageSize = 50;
export const auditModules = [
  { key: "guardians", label: "Guardian access" },
  { key: "attendance", label: "Attendance" },
  { key: "roster", label: "Student roster" },
  { key: "student-leave", label: "Student leave" },
  { key: "results", label: "Result publication" },
  { key: "timetable", label: "Timetable" },
] as const;
export type AuditModule = (typeof auditModules)[number]["key"];
export type AuditFilters = { from: string; to: string; module: AuditModule | null };
export type AuditCursor = { occurred_at: string; key: string };
export type AuditEvent = {
  id: string;
  occurred_at: string;
  actor_name: string | null;
  module: AuditModule;
  action: string;
  record_label: string;
};
export type AuditPage = { events: AuditEvent[]; next_cursor: AuditCursor | null };

export class AuditHistoryError extends Error {
  constructor(message: string, readonly code = "") {
    super(message);
    this.name = "AuditHistoryError";
  }
}

const day = 86_400_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const eventKey = /^[a-z][a-z0-9_-]*:[a-z0-9:_-]+$/;
const isModule = (value: unknown): value is AuditModule => auditModules.some(({ key }) => key === value);
const text = (value: unknown, max = 512): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const timestamp = (value: unknown): value is string => typeof value === "string" && value.length <= 48
  && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && isDate(value.slice(0, 10))
  && Number.isFinite(Date.parse(value));
const key = (value: unknown): value is string => typeof value === "string" && value.length <= 160 && eventKey.test(value);

function isDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function defaultAuditFilters(now = new Date()): AuditFilters {
  const today = new Date(now.valueOf() + 330 * 60_000).toISOString().slice(0, 10);
  return { from: new Date(Date.parse(`${today}T00:00:00Z`) - 29 * day).toISOString().slice(0, 10), to: today, module: null };
}

export function validateAuditFilters(filters: AuditFilters): string | null {
  if (!isDate(filters.from) || !isDate(filters.to) || filters.from > filters.to) {
    return "Choose valid dates with To on or after From.";
  }
  if ((Date.parse(`${filters.to}T00:00:00Z`) - Date.parse(`${filters.from}T00:00:00Z`)) / day > 365) {
    return "Choose a range of 366 days or fewer.";
  }
  return filters.module === null || isModule(filters.module) ? null : "Choose a supported module.";
}

function readPage(data: unknown, filters: AuditFilters): AuditPage {
  const invalid = () => new AuditHistoryError("Audit history could not be verified. Refresh to try again.");
  if (!data || typeof data !== "object" || !("events" in data) || !Array.isArray(data.events)
    || data.events.length > auditPageSize || !("next_cursor" in data)) throw invalid();
  const ids = new Set<string>();
  const events = data.events.map((value: unknown): AuditEvent => {
    const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
    if (!key(row.id) || ids.has(row.id) || !timestamp(row.occurred_at) || !isModule(row.module)
      || !text(row.action, 160) || !text(row.record_label) || !(row.actor_name === null || text(row.actor_name, 320))
      || (filters.module !== null && row.module !== filters.module)) throw invalid();
    const schoolDay = new Date(Date.parse(row.occurred_at) + 330 * 60_000).toISOString().slice(0, 10);
    if (schoolDay < filters.from || schoolDay > filters.to) throw invalid();
    ids.add(row.id);
    return { id: row.id, occurred_at: row.occurred_at, actor_name: row.actor_name,
      module: row.module, action: row.action, record_label: row.record_label };
  });
  let cursor: AuditCursor | null = null;
  if (data.next_cursor !== null) {
    const next = data.next_cursor && typeof data.next_cursor === "object" ? data.next_cursor as Record<string, unknown> : {};
    const last = events.at(-1);
    if (events.length !== auditPageSize || !last || !timestamp(next.occurred_at) || !key(next.key)
      || next.key !== last.id || next.occurred_at !== last.occurred_at) throw invalid();
    cursor = { occurred_at: next.occurred_at, key: next.key };
  }
  return { events, next_cursor: cursor };
}

export async function listSchoolAuditEvents(client: SupabaseClient, schoolId: string, filters: AuditFilters,
  cursor: AuditCursor | null = null, signal?: AbortSignal): Promise<AuditPage> {
  const invalid = validateAuditFilters(filters);
  if (invalid) throw new AuditHistoryError(invalid, "22023");
  if (!uuid.test(schoolId) || (cursor && (!timestamp(cursor.occurred_at) || !key(cursor.key)))) {
    throw new AuditHistoryError("Select a valid school and history page.", "22023");
  }
  const request = client.rpc("list_school_audit_events", {
    p_school_id: schoolId, p_from: filters.from, p_to: filters.to, p_module: filters.module,
    p_cursor_at: cursor?.occurred_at ?? null, p_cursor_key: cursor?.key ?? null, p_limit: auditPageSize,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) {
    const code = error.code ?? "";
    throw new AuditHistoryError(["PGRST202", "42883"].includes(code)
      ? "Audit history needs the latest school update. Contact your administrator."
      : code === "42501" ? "Your school audit access could not be verified. Reload school access."
        : "Audit history could not be loaded. Refresh to try again.", code);
  }
  return readPage(data, filters);
}
