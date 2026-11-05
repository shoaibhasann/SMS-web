import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveAcademicLog, type AcademicActivity, type AcademicLog } from "../lib/academic";
import { canEditAcademicLog } from "../lib/academic-permissions";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => mocks }));

const log: AcademicLog = {
  id: "log-a", expected_updated_at: "2026-11-05T12:00:00Z", school_id: "school-a", academic_year_id: "year-a", class_id: "class-a", section_id: "section-a",
  subject_id: "subject-a", log_date: "2026-11-05", topic: " Fractions ", summary: " Practice ", status: "published", activities: {},
};
const activity = (id: string, type: string, title: string): AcademicActivity => ({
  id, class_log_id: "log-a", activity_type: type, title, description: "Keep this description", due_date: "2026-11-07",
  attachment_url: "https://example.test/worksheet.pdf", max_marks: 20,
});

beforeEach(() => { vi.resetAllMocks(); mocks.rpc.mockResolvedValue({ data: "log-a", error: null }); });

describe("atomic academic authoring client", () => {
  it("preserves single activity identity and submission metadata while changing its title in one RPC", async () => {
    const previous = activity("homework-a", "homework", "Old task");
    expect(await saveAcademicLog({ ...log, activities: { homework: " Updated task " }, existingActivities: [previous] })).toEqual({ id: "log-a" });
    expect(mocks.rpc).toHaveBeenCalledWith("save_academic_log", {
      p_log: expect.objectContaining({ id: "log-a", topic: "Fractions", summary: "Practice", status: "published" }),
      p_activities: [expect.objectContaining({ id: "homework-a", title: "Updated task", description: previous.description,
        due_date: previous.due_date, attachment_url: previous.attachment_url, max_marks: 20 })],
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("preserves multiple homework entries rather than collapsing them into the log form's one field", async () => {
    const first = activity("homework-a", "homework", "Task one");
    const second = activity("homework-b", "homework", "Task two");
    await saveAcademicLog({ ...log, activities: { homework: "Do not replace both" }, existingActivities: [first, second] });
    expect(mocks.rpc.mock.calls[0][1].p_activities).toEqual([
      expect.objectContaining({ id: "homework-a", title: "Task one" }),
      expect.objectContaining({ id: "homework-b", title: "Task two" }),
    ]);
  });

  it("does not report success when the atomic transaction is denied or has no saved id", async () => {
    const denied = { code: "42501", message: "Denied" };
    mocks.rpc.mockResolvedValueOnce({ data: null, error: denied });
    await expect(saveAcademicLog(log)).rejects.toBe(denied);
    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(saveAcademicLog(log)).rejects.toThrow("was not saved");
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("requires the same teacher, school, year, class, section and subject for editor controls", () => {
    const assignment = { id: "assignment-a", teacher_id: "teacher-a", academic_year_id: "year-a", class_id: "class-a",
      section_id: "section-a", subject_id: "subject-a", is_class_teacher: false, class_name: "Class", section_name: "A", subject_name: "Maths" };
    const record = { ...log, id: "log-a", teacher_id: "teacher-a", teacher_remark: null, published_at: null, status: "published" as const };
    expect(canEditAcademicLog([assignment], "teacher-a", "school-a", record)).toBe(true);
    for (const mismatch of [{ teacher_id: "teacher-b" }, { school_id: "school-b" }, { academic_year_id: "year-b" },
      { class_id: "class-b" }, { section_id: "section-b" }, { subject_id: "subject-b" }]) {
      expect(canEditAcademicLog([assignment], "teacher-a", "school-a", { ...record, ...mismatch })).toBe(false);
    }
  });
});
