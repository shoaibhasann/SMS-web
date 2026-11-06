import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { formatTimetableTime, getFamilyTimetable, getOfficeTimetable, getTeacherTimetable, getTimetableSetup,
  removeTimetablePeriod, saveTimetablePeriod, timetableTime, validateTimetableDraft,
  type TimetableDraft, type TimetablePeriod, type TimetableSetup } from "@/lib/timetable";

const id = "10000000-0000-4000-8000-000000000001", version = "10000000-0000-4000-8000-000000000002", requestId = "10000000-0000-4000-8000-000000000003";
const row: TimetablePeriod = { id, school_id: "school", academic_year_id: "year", class_id: "class", class_name: "Class 6",
  section_id: "section", section_name: "A", assignment_id: "assignment", subject_id: "subject", subject_name: "Science",
  teacher_id: "teacher", teacher_name: "QA Teacher", day_of_week: 1, period_no: 1, start_time: "08:00:00", end_time: "08:45:00", room: "Lab", version, needs_attention: false };
const view = { school_id: "school", academic_year_id: "year", academic_year_name: "2026–27", class_id: "class", class_name: "Class 6", section_id: "section", section_name: "A", student_id: "child", rows: [row] };
const setup: TimetableSetup = { years: [{ id: "year", name: "2026–27", is_current: true, start_date: "2026-04-01", end_date: "2027-03-31" }],
  classes: [{ id: "class", name: "Class 6" }], sections: [{ id: "section", class_id: "class", name: "A" }],
  assignments: [{ id: "assignment", academic_year_id: "year", class_id: "class", section_id: "section", subject_id: "subject", teacher_id: "teacher", subject_name: "Science", teacher_name: "QA Teacher" }] };
const draft: TimetableDraft = { assignmentId: "assignment", sectionId: "section", day: 1, period: 1, start: "08:00", end: "08:45", room: " Lab " };
function client(data: unknown, error: { code?: string; message: string } | null = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error }); return { rpc, client: { rpc } as unknown as SupabaseClient };
}

describe("timetable checked client", () => {
  it("compares school-clock values without timezone conversion or rounding seconds", () => {
    expect(timetableTime("08:00")).toBe(28800); expect(timetableTime("08:00:30.5")).toBe(28830.5);
    for (const input of [null, "24:00", "8:00", "08:60", "infinity", "08:00Z", "08:00:60"]) expect(timetableTime(input)).toBeNull();
    expect(formatTimetableTime("08:00:00")).toBe("08:00"); expect(formatTimetableTime("08:00:30")).toBe("08:00:30");
    expect(validateTimetableDraft(draft)).toBeNull();
    expect(validateTimetableDraft({ ...draft, end: draft.start })).toMatch(/end after/);
    expect(validateTimetableDraft({ ...draft, end: "08:45:01" })).toMatch(/whole-minute/);
    expect(validateTimetableDraft({ ...draft, day: 8 })).toMatch(/weekday/);
    expect(validateTimetableDraft({ ...draft, period: 0 })).toMatch(/period number/);
    expect(validateTimetableDraft({ ...draft, room: "x".repeat(121) })).toMatch(/120 characters/);
    expect(validateTimetableDraft({ ...draft, room: "x".repeat(120) })).toBeNull();
  });

  it("verifies complete eligible option mappings and rejects duplicates or wrong class links", async () => {
    const api = client(setup); expect(await getTimetableSetup(api.client, "school")).toEqual(setup);
    expect(api.rpc).toHaveBeenCalledWith("get_timetable_setup", { p_school_id: "school" });
    for (const data of [{ ...setup, assignments: [setup.assignments[0], setup.assignments[0]] },
      { ...setup, sections: [{ id: "section", class_id: "other-class", name: "A" }] },
      { ...setup, assignments: [{ ...setup.assignments[0], academic_year_id: "other-year" }] }]) {
      api.rpc.mockResolvedValue({ data, error: null }); await expect(getTimetableSetup(api.client, "school")).rejects.toThrow(/could not be verified/);
    }
  });

  it("scopes school/class/section readers and permits whole-class rows for a selected section", async () => {
    const api = client({ ...view, rows: [{ ...row, section_id: null, section_name: null }] });
    await getOfficeTimetable(api.client, "school", "year", "class", "section");
    expect(api.rpc).toHaveBeenCalledWith("get_office_timetable", { p_school_id: "school", p_year_id: "year", p_class_id: "class", p_section_id: "section" });
    expect((await getFamilyTimetable(api.client, "child", "school")).rows).toHaveLength(1);
    await expect(getFamilyTimetable(api.client, "other-child", "school")).rejects.toThrow(/could not be verified/);
  });

  it.each([{ school_id: "other" }, { academic_year_id: "other" }, { class_id: "other" }, { section_id: "other" },
    { start_time: "24:00" }, { end_time: "07:00" }, { day_of_week: 0 }, { period_no: 0 },
    { version: "unknown" }, { assignment_id: null }, { needs_attention: true }])("fails closed for wrong-scope or invalid family rows %j", async (patch) => {
    const api = client({ ...view, rows: [{ ...row, ...patch }] });
    await expect(getFamilyTimetable(api.client, "child", "school")).rejects.toThrow(/could not be verified/);
  });

  it("exposes legacy unconfigured rows only to the checked office reader", async () => {
    const legacy = { ...row, assignment_id: null, start_time: null, end_time: null, needs_attention: true };
    const api = client({ ...view, rows: [legacy] });
    expect((await getOfficeTimetable(api.client, "school", "year", "class", "section")).rows).toEqual([legacy]);
    await expect(getTeacherTimetable(api.client)).rejects.toThrow(/could not be verified/);
  });

  it("accepts empty current contexts but not rows without an enrollment/year", async () => {
    const api = client({ ...view, academic_year_id: null, academic_year_name: null, class_id: null, class_name: null, section_id: null, section_name: null, rows: [] });
    expect((await getFamilyTimetable(api.client, "child", "school")).rows).toEqual([]);
    api.rpc.mockResolvedValue({ data: { ...view, academic_year_id: null }, error: null });
    await expect(getTeacherTimetable(api.client)).rejects.toThrow(/could not be verified/);
  });

  it("rejects duplicate timetable rows instead of silently rendering an incomplete schedule", async () => {
    const api = client({ ...view, rows: [row, row] }); await expect(getTeacherTimetable(api.client)).rejects.toThrow(/could not be verified/);
  });

  it("sends only canonical mapping, frozen version and actor-bound retry references", async () => {
    const api = client(id);
    expect(await saveTimetablePeriod(api.client, "school", draft, row, requestId)).toBe(id);
    expect(api.rpc).toHaveBeenCalledWith("save_timetable_period", {
      p_school_id: "school", p_period_id: id, p_expected_version: version, p_assignment_id: "assignment", p_section_id: "section",
      p_day_of_week: 1, p_period_no: 1, p_start_time: "08:00", p_end_time: "08:45", p_room: "Lab", p_request_id: requestId,
    });
    await saveTimetablePeriod(api.client, "school", { ...draft, room: "   " }, null, requestId);
    expect(api.rpc.mock.lastCall?.[1]).toMatchObject({ p_period_id: null, p_expected_version: null, p_room: null });
    await removeTimetablePeriod(api.client, "school", row, requestId);
    expect(api.rpc).toHaveBeenCalledWith("remove_timetable_period", { p_school_id: "school", p_period_id: id, p_expected_version: version, p_request_id: requestId });
  });

  it("rejects invalid writes before RPC and treats missing/wrong acknowledgements as unknown", async () => {
    const api = client(null);
    await expect(saveTimetablePeriod(api.client, "school", { ...draft, start: "09:00" }, null, requestId)).rejects.toThrow(/end after/);
    await expect(saveTimetablePeriod(api.client, "school", draft, null, "bad-key")).rejects.toThrow(/reference/);
    expect(api.rpc).not.toHaveBeenCalled();
    await expect(saveTimetablePeriod(api.client, "school", draft, null, requestId)).rejects.toThrow(/could not be confirmed/);
    api.rpc.mockResolvedValue({ data: version, error: null });
    await expect(removeTimetablePeriod(api.client, "school", row, requestId)).rejects.toThrow(/could not be confirmed/);
  });

  it("keeps specific conflict feedback, hides SQL authorization details and flags missing schema", async () => {
    const api = client(null, { code: "PT409", message: "Teacher timing overlaps an existing period." });
    await expect(saveTimetablePeriod(api.client, "school", draft, null, requestId)).rejects.toThrow(/Teacher timing overlaps/);
    api.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "Internal SQL detail" } });
    await expect(getTeacherTimetable(api.client)).rejects.toThrow(/access or teaching assignment changed/);
    api.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Missing procedure" } });
    await expect(getTeacherTimetable(api.client)).rejects.toThrow(/latest school update/);
  });
});
