import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadEffectiveAttendanceAssignments } from "../lib/assignments/attendance-coverage";

const row = { id: "assignment", teacher_id: "teacher", academic_year_id: "year", class_id: "class", section_id: "section",
  subject_id: "subject", is_class_teacher: true, class_name: "Class 6", section_name: "A", subject_name: "English",
  coverage_id: null, starts_on: null, ends_on: null };
function client(data: unknown, error: unknown = null) {
  const query = { returns: vi.fn().mockResolvedValue({ data, error }), abortSignal: vi.fn() };
  const rpc = vi.fn().mockReturnValue(query);
  return { query, rpc, value: { rpc } as unknown as SupabaseClient };
}

describe("effective attendance assignment reader", () => {
  it("requests authenticated effective attendance scopes, including bounded temporary cover", async () => {
    const rows = [row, { ...row, id: "source", coverage_id: "cover", starts_on: "2026-11-05", ends_on: "2026-11-07" }];
    const api = client(rows); const controller = new AbortController();
    expect(await loadEffectiveAttendanceAssignments(api.value, controller.signal)).toEqual(rows);
    expect(api.rpc).toHaveBeenCalledExactlyOnceWith("list_my_effective_attendance_assignments");
    expect(api.query.abortSignal).toHaveBeenCalledWith(controller.signal);
  });
  it("accepts no current attendance rights", async () => {
    expect(await loadEffectiveAttendanceAssignments(client([]).value)).toEqual([]);
  });
  it.each([null, {}, [{ ...row, section_id: null }], [{ ...row, is_class_teacher: false }],
    [{ ...row, coverage_id: "cover", starts_on: null, ends_on: null }],
    [{ ...row, coverage_id: "cover", starts_on: "2026-11-07", ends_on: "2026-11-05" }],
  ])("rejects incomplete or unusable authorization rows %#", async (data) => {
    await expect(loadEffectiveAttendanceAssignments(client(data).value)).rejects.toThrow("attendance assignments could not be verified");
  });
  it("fails closed instead of returning cached rights after an RPC error", async () => {
    await expect(loadEffectiveAttendanceAssignments(client([row], { code: "42501" }).value)).rejects.toThrow("attendance assignments could not be verified");
  });
});
