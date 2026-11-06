import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { auditPageSize, defaultAuditFilters, listSchoolAuditEvents, validateAuditFilters,
  type AuditCursor, type AuditFilters } from "../lib/admin/audit-history";

const school = "00000000-0000-4000-8000-000000000001";
const filters: AuditFilters = { from: "2026-11-01", to: "2026-11-06", module: null };
const event = (n = 1) => ({ id: `leave:00000000-0000-4000-8000-${String(n).padStart(12, "0")}:submitted`,
  occurred_at: "2026-11-06T10:00:00.123456+00:00", actor_name: "QA Admin", module: "student-leave",
  action: "Leave requested", record_label: "Leave request reference" });
function client(data: unknown, error: { code: string; message: string } | null = null) {
  const abortSignal = vi.fn();
  const rpc = vi.fn().mockImplementation(() => {
    const response = Object.assign(Promise.resolve({ data, error }), { abortSignal });
    abortSignal.mockReturnValue(response);
    return response;
  });
  return { rpc, abortSignal, client: { rpc } as unknown as SupabaseClient };
}

describe("checked school audit client", () => {
  it("uses the IST day and a thirty-day inclusive default across UTC boundaries", () => {
    expect(defaultAuditFilters(new Date("2026-11-06T18:31:00Z"))).toEqual({ from: "2026-10-09", to: "2026-11-07", module: null });
    expect(defaultAuditFilters(new Date("2026-01-01T00:00:00Z"))).toEqual({ from: "2025-12-03", to: "2026-01-01", module: null });
  });

  it("bounds real inclusive dates and validates module without making a request", async () => {
    expect(validateAuditFilters({ ...filters, from: "2025-11-06" })).toBeNull();
    for (const patch of [{ from: "2025-11-05" }, { from: "2026-02-30" }, { to: "2026-10-30" }, { from: "0000-01-01" }, { module: "finance" }]) {
      const api = client({ events: [], next_cursor: null });
      await expect(listSchoolAuditEvents(api.client, school, { ...filters, ...patch } as AuditFilters)).rejects.toThrow();
      expect(api.rpc).not.toHaveBeenCalled();
    }
  });

  it("sends only the explicit school/filter/cursor and supports aborting reads", async () => {
    const api = client({ events: [event()], next_cursor: null });
    const cursor: AuditCursor = { occurred_at: "2026-11-06T11:00:00Z", key: event().id };
    const controller = new AbortController();
    expect((await listSchoolAuditEvents(api.client, school, filters, cursor, controller.signal)).events).toEqual([event()]);
    expect(api.rpc).toHaveBeenCalledWith("list_school_audit_events", {
      p_school_id: school, p_from: filters.from, p_to: filters.to, p_module: null,
      p_cursor_at: cursor.occurred_at, p_cursor_key: cursor.key, p_limit: auditPageSize,
    });
    expect(api.abortSignal).toHaveBeenCalledWith(controller.signal);
  });

  it("keeps microsecond cursor bytes exact and strips unknown payload fields", async () => {
    const rows = Array.from({ length: auditPageSize }, (_, n) => event(n + 1));
    const last = rows.at(-1)!;
    const next = { occurred_at: last.occurred_at, key: last.id };
    const api = client({ events: rows.map((row) => ({ ...row, payload: "SECRET MARKS", reason: "PRIVATE REASON" })), next_cursor: next, old_data: "SECRET" });
    const result = await listSchoolAuditEvents(api.client, school, filters);
    expect(result).toEqual({ events: rows, next_cursor: next });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE/);
  });

  it.each([null, [], { events: [], next_cursor: undefined }, { events: [event(), event()], next_cursor: null },
    { events: Array.from({ length: 51 }, (_, n) => event(n + 1)), next_cursor: null },
    { events: [event()], next_cursor: { occurred_at: event().occurred_at, key: event().id } }])("rejects malformed, incomplete or duplicate page %j", async (data) => {
    const api = client(data);
    await expect(listSchoolAuditEvents(api.client, school, filters)).rejects.toThrow(/could not be verified/);
  });

  it.each([{ occurred_at: "2026-02-30T10:00:00Z" }, { occurred_at: "2026-11-06T24:00:00Z" }, { occurred_at: "infinity" },
    { occurred_at: "2026-10-30T00:00:00Z" }, { module: "finance" }, { actor_name: 10 }, { record_label: "" }, { id: "unsafe<script>" }])("rejects an invalid event %j", async (patch) => {
    const api = client({ events: [{ ...event(), ...patch }], next_cursor: null });
    await expect(listSchoolAuditEvents(api.client, school, filters)).rejects.toThrow(/could not be verified/);
  });

  it("verifies module filters and IST midnight instead of using UTC date-only", async () => {
    const singleDay = { ...filters, from: "2026-11-06", to: "2026-11-06" };
    const api = client({ events: [{ ...event(), occurred_at: "2026-11-05T18:30:00.000001Z" }], next_cursor: null });
    expect((await listSchoolAuditEvents(api.client, school, singleDay)).events).toHaveLength(1);
    await expect(listSchoolAuditEvents(api.client, school, { ...singleDay, module: "roster" })).rejects.toThrow(/could not be verified/);
    const previous = client({ events: [{ ...event(), occurred_at: "2026-11-05T18:29:59.999999Z" }], next_cursor: null });
    await expect(listSchoolAuditEvents(previous.client, school, singleDay)).rejects.toThrow(/could not be verified/);
  });

  it("requires a continuation to match the exact last returned event", async () => {
    const rows = Array.from({ length: auditPageSize }, (_, n) => event(n + 1));
    const api = client({ events: rows, next_cursor: { occurred_at: rows[0].occurred_at, key: rows[0].id } });
    await expect(listSchoolAuditEvents(api.client, school, filters)).rejects.toThrow(/could not be verified/);
  });

  it.each(["42501", "PGRST202", "XX000"])("hides database details for %s and provides recovery guidance", async (code) => {
    const api = client(null, { code, message: "PRIVATE SQL PAYLOAD" });
    await expect(listSchoolAuditEvents(api.client, school, filters)).rejects.toThrow(code === "42501" ? /Reload school access/ : code === "PGRST202" ? /latest school update/ : /could not be loaded/);
    await expect(listSchoolAuditEvents(api.client, school, filters)).rejects.not.toThrow(/PRIVATE SQL/);
  });

  it("rejects malformed school and cursor references before RPC", async () => {
    const api = client({ events: [], next_cursor: null });
    await expect(listSchoolAuditEvents(api.client, "another school", filters)).rejects.toThrow(/valid school/);
    await expect(listSchoolAuditEvents(api.client, school, filters, { occurred_at: "bad", key: event().id })).rejects.toThrow(/valid school/);
    expect(api.rpc).not.toHaveBeenCalled();
  });
});
