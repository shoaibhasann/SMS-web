import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { loadSchoolAttendanceCounts } from "@/lib/dashboard/attendance";

function fixture(values: Record<string, unknown>, errorStatus?: string) {
  const calls: Record<string, unknown>[] = [];
  const client = { from(table: string) {
    const filters: Record<string, unknown> = { table }; calls.push(filters);
    return {
      select(column: string, options: unknown) { Object.assign(filters, { column, options }); return this; },
      eq(key: string, value: unknown) { filters[key] = value; return this; },
      then(resolve: (value: unknown) => unknown) { const key = String(filters.status ?? "total"); return Promise.resolve(resolve({ count: values[key], error: key === errorStatus ? { code: "42501" } : null })); },
    };
  } } as unknown as SupabaseClient;
  return { client, calls };
}
const counts = { total: 42, present: 25, absent: 8, late: 3, half_day: 0, leave: 6, holiday: 0 };

describe("complete school attendance counts", () => {
  it("keeps every status separate and scopes all head reads to the school and day", async () => {
    const { client, calls } = fixture(counts);
    const result = await loadSchoolAttendanceCounts(client, "school-a", "2026-11-06");
    expect(result).toEqual({ total: 42, statuses: { present: 25, absent: 8, late: 3, half_day: 0, leave: 6, holiday: 0 } });
    expect(calls).toHaveLength(7);
    for (const call of calls) expect(call).toMatchObject({ table: "attendance", school_id: "school-a", attendance_date: "2026-11-06", options: { head: true, count: "exact" } });
  });
  it.each([null, undefined, -1, 1.5, NaN])("does not turn an unavailable count %s into zero", async (count) => {
    await expect(loadSchoolAttendanceCounts(fixture({ ...counts, present: count }).client, "school", "2026-11-06")).rejects.toThrow();
  });
  it("rejects permission failures and inconsistent results during competing writes", async () => {
    await expect(loadSchoolAttendanceCounts(fixture(counts, "late").client, "school", "2026-11-06")).rejects.toEqual({ code: "42501" });
    await expect(loadSchoolAttendanceCounts(fixture({ ...counts, present: 26 }).client, "school", "2026-11-06")).rejects.toThrow("Attendance changed");
  });
});
