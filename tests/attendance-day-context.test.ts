import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { boundMfaSession } from "../lib/auth/staff-mfa";
import { loadAttendanceDayContext } from "../lib/attendance/day-context";

vi.mock("../lib/auth/staff-mfa", () => ({ boundMfaSession: vi.fn() }));
const context = { schoolId: "school-a", academicYearId: "year-a", classId: "class-a", sectionId: "section-a" };
const base = { user_id: "teacher-a", school_id: "school-a", academic_year_id: "year-a", class_id: "class-a", section_id: "section-a",
  day: "2026-11-07", server_today: "2026-11-07", timezone: "Asia/Kolkata", revision: 2, configured: true, is_working: false,
  source: "exception", label: "School closure", policy_revision: 1, exception_revision: 2, correction_window_days: 7,
  can_request_correction: false, can_mark_holiday: false };
function client(data: unknown = base, error: { code: string } | null = null) {
  const setHeader = vi.fn(async () => ({ data, error }));
  const rpc = vi.fn(() => ({ setHeader }));
  return { db: { rpc } as unknown as SupabaseClient, rpc, setHeader };
}
beforeEach(() => vi.mocked(boundMfaSession).mockResolvedValue({ access_token: "captured-owner" } as never));

describe("owner-bound server attendance calendar decisions", () => {
  it("pins the captured owner's native JWT and exact register/date before accepting a closed day", async () => {
    const { db, rpc, setHeader } = client();
    expect(await loadAttendanceDayContext(db, "teacher-a", context, base.day)).toMatchObject({ is_working: false, source: "exception", label: "School closure" });
    expect(boundMfaSession).toHaveBeenCalledWith(db, "teacher-a", expect.any(AbortSignal));
    expect(rpc).toHaveBeenCalledWith("get_attendance_day_context", { p_school_id: "school-a", p_year_id: "year-a", p_class_id: "class-a", p_section_id: "section-a", p_day: base.day });
    expect(setHeader).toHaveBeenCalledWith("Authorization", "Bearer captured-owner");
  });
  it("represents an unconfigured school without guessing weekdays or a request window", async () => {
    const { db } = client({ ...base, configured: false, is_working: null, source: "unconfigured", label: null, revision: 0,
      policy_revision: null, exception_revision: null, correction_window_days: null });
    expect(await loadAttendanceDayContext(db, "teacher-a", context, base.day)).toMatchObject({ configured: false, is_working: null, correction_window_days: null });
  });
  it.each([
    { user_id: "another-user" }, { school_id: "another-school" }, { section_id: "another-section" },
    { day: "2026-11-08" }, { server_today: "2026-02-30" }, { timezone: "UTC" },
    { is_working: "false" }, { can_mark_holiday: "true" }, { configured: false }, { label: "Closed\nfor QA" },
    { policy_revision: 3 }, { exception_revision: -1 }, { correction_window_days: 366 },
    { can_request_correction: true },
  ])("rejects malformed, mismatched or stale owner/context metadata: %j", async value => {
    await expect(loadAttendanceDayContext(client({ ...base, ...value }).db, "teacher-a", context, base.day)).rejects.toThrow("could not be verified");
  });
  it("accepts explicit historical import provenance without inventing a weekly policy or correction window", async () => {
    const day = "2026-11-06", imported = { ...base, day, source: "import", is_working: true, label: "Verified historical school day",
      policy_revision: null, exception_revision: null, correction_window_days: null, import_revision: 2, can_request_correction: true };
    expect(await loadAttendanceDayContext(client(imported).db, "teacher-a", context, day)).toMatchObject({ source: "import", import_revision: 2,
      policy_revision: null, correction_window_days: null, can_request_correction: true });
  });
  it.each([{ import_revision: undefined }, { import_revision: 3 }, { policy_revision: 1 }, { correction_window_days: 0 },
    { configured: false }, { day: "2026-11-07" }])("denies invalid imported-day provenance %j", async patch => {
    const imported = { ...base, day: "2026-11-06", source: "import", policy_revision: null, exception_revision: null,
      correction_window_days: null, import_revision: 2, ...patch };
    await expect(loadAttendanceDayContext(client(imported).db, "teacher-a", context, imported.day)).rejects.toThrow("could not be verified");
  });
  it("fails closed without an owner session or after server access denial", async () => {
    const { db, rpc } = client();
    vi.mocked(boundMfaSession).mockResolvedValueOnce(null as never);
    await expect(loadAttendanceDayContext(db, "teacher-a", context, base.day)).rejects.toThrow("Sign in again");
    expect(rpc).not.toHaveBeenCalled();
    await expect(loadAttendanceDayContext(client(null, { code: "42501" }).db, "teacher-a", context, base.day)).rejects.toThrow("access changed");
  });
});
