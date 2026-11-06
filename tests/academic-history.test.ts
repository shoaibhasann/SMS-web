// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAcademicActivities, loadAcademicLogs, saveAcademicLog, type AcademicActivity, type AcademicLogRecord } from "../lib/academic";

type Query = { table: string; columns: string; countRequested: boolean; filters: Record<string, unknown>; order: { column: string; ascending: boolean }[]; from: number; to: number };
type Row = AcademicLogRecord | AcademicActivity;
type Result = { data: Row[] | null; count?: number | null; error: { message: string } | null };
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => mocks }));
let logs: AcademicLogRecord[];
let activities: AcademicActivity[];
let queries: Query[];
let cap: number;
let alterResult: (query: Query, result: Result) => Result;

const log = (number: number): AcademicLogRecord => ({
  id: `log-${String(number).padStart(4, "0")}`, school_id: "school-a", academic_year_id: "year-a", log_date: "2026-11-01",
  class_id: "class-a", section_id: "section-a", subject_id: "subject-a", teacher_id: "teacher-a", topic: `Lesson ${number}`,
  summary: "Practice", teacher_remark: null, status: "published", published_at: null, updated_at: "2026-11-05T12:00:00Z",
});
const activity = (number: number, source: string): AcademicActivity => ({ id: `activity-${String(number).padStart(5, "0")}`,
  class_log_id: source, activity_type: number % 2 ? "homework" : "classwork", title: `Task ${number}`, description: null, due_date: null });

beforeEach(() => {
  vi.resetAllMocks();
  logs = [];
  activities = [];
  queries = [];
  cap = 200;
  alterResult = (_, result) => result;
  mocks.rpc.mockResolvedValue({ data: "log-0000", error: null });
  mocks.from.mockImplementation((table: string) => {
    const query: Query = { table, columns: "", countRequested: false, filters: {}, order: [], from: 0, to: 199 };
    const builder = {
      select(columns: string, options?: { count: string }) { query.columns = columns; query.countRequested = options?.count === "exact"; return builder; },
      eq(column: string, value: unknown) { query.filters[column] = value; return builder; },
      in(column: string, value: unknown[]) { query.filters[column] = value; return builder; },
      order(column: string, options?: { ascending?: boolean }) { query.order.push({ column, ascending: options?.ascending ?? true }); return builder; },
      range(from: number, to: number) { query.from = from; query.to = to; return builder; },
      returns() { return builder; },
      then(resolve: (result: Result) => unknown, reject: (error: unknown) => unknown) {
        queries.push(query);
        let rows: Row[] = table === "class_logs" ? logs : activities;
        rows = rows.filter((row) => Object.entries(query.filters).every(([column, expected]) => {
          if (column === "class_activities.activity_type") return activities.some((item) => item.class_log_id === row.id && item.activity_type === expected);
          const value = (row as unknown as Record<string, unknown>)[column];
          return Array.isArray(expected) ? expected.includes(value) : value === expected;
        }));
        rows = [...rows].sort((a, b) => {
          for (const { column, ascending } of query.order) {
            const left = (a as unknown as Record<string, string>)[column];
            const right = (b as unknown as Record<string, string>)[column];
            const order = left.localeCompare(right);
            if (order) return ascending ? order : -order;
          }
          return 0;
        });
        return Promise.resolve(alterResult(query, { data: rows.slice(query.from, Math.min(query.to + 1, query.from + cap)), count: rows.length, error: null })).then(resolve, reject);
      },
    };
    return builder;
  });
});

describe("academic history completeness", () => {
  it("reads beyond the old 200-log boundary with deterministic date/id ordering", async () => {
    logs = Array.from({ length: 415 }, (_, id) => log(id));
    expect(await loadAcademicLogs({ teacherId: "teacher-a" })).toEqual(logs);
    expect(queries.map((query) => query.from)).toEqual([0, 200, 400]);
    for (const query of queries) {
      expect(query.countRequested).toBe(true);
      expect(query.order).toEqual([{ column: "log_date", ascending: false }, { column: "id", ascending: true }]);
      expect(query.filters.teacher_id).toBe("teacher-a");
    }
  });

  it("applies selected school/year/date/class/section/subject/status filters on the server query", async () => {
    logs = [log(1), { ...log(2), academic_year_id: "year-b" }];
    expect(await loadAcademicLogs({ schoolId: "school-a", academicYearIds: ["year-a"], logDate: "2026-11-01",
      classIds: ["class-a"], sectionIds: ["section-a"], subjectId: "subject-a", status: "published" })).toEqual([log(1)]);
    expect(queries[0].filters).toEqual({ school_id: "school-a", academic_year_id: ["year-a"], log_date: "2026-11-01",
      class_id: ["class-a"], section_id: ["section-a"], subject_id: "subject-a", status: "published" });
  });

  it("narrows activity views by parent relation but loads all activities for each selected editable log", async () => {
    logs = [log(1), log(2)];
    activities = [activity(1, logs[0].id), activity(2, logs[0].id), activity(4, logs[1].id)];
    const history = await loadAcademicLogs({ activityType: "homework" });
    expect(history).toEqual([logs[0]]);
    expect(queries[0].columns).toContain("class_activities!inner(activity_type)");
    expect(await loadAcademicActivities(history.map((item) => item.id))).toEqual(activities.slice(0, 2));
  });

  it("loads more than 1000 children across bounded log batches even with a smaller server cap", async () => {
    logs = Array.from({ length: 200 }, (_, id) => log(id));
    activities = logs.flatMap((item, index) => Array.from({ length: 6 }, (_, child) => activity(index * 6 + child, item.id)));
    cap = 73;
    expect(await loadAcademicActivities([...logs.map((item) => item.id), logs[0].id])).toEqual(activities);
    expect(activities).toHaveLength(1200);
    expect(queries).toHaveLength(18);
    expect(queries.every((query) => query.countRequested && (query.filters.class_log_id as string[]).length <= 100)).toBe(true);
    expect(queries.every((query) => query.order[0].column === "id")).toBe(true);
  });

  it("fails closed on missing counts instead of offering a partial list to a complete-list save", async () => {
    activities = [activity(1, "log-0001"), activity(2, "log-0001")];
    alterResult = (_, result) => ({ ...result, data: result.data?.slice(0, 1) ?? [], count: null });
    await expect((async () => {
      const existingActivities = await loadAcademicActivities(["log-0001"]);
      return saveAcademicLog({ ...log(1), teacher_remark: undefined, activities: {}, existingActivities, expected_updated_at: log(1).updated_at });
    })()).rejects.toThrow("completeness could not be verified");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects changing totals, duplicate pages and a child returned for an unrelated source", async () => {
    logs = Array.from({ length: 201 }, (_, id) => log(id));
    alterResult = (query, result) => query.from ? { ...result, count: 202 } : result;
    await expect(loadAcademicLogs()).rejects.toThrow("records changed");
    alterResult = (_, result) => ({ ...result, data: [logs[0]], count: 2 });
    await expect(loadAcademicLogs()).rejects.toThrow("records changed");
    alterResult = () => ({ data: [activity(1, "foreign-log")], count: 1, error: null });
    await expect(loadAcademicActivities(["log-0001"])).rejects.toThrow("unexpected source log");
  });

  it("does not widen an explicitly empty school-year/class/section scope", async () => {
    expect(await loadAcademicLogs({ academicYearIds: [] })).toEqual([]);
    expect(await loadAcademicLogs({ classIds: [] })).toEqual([]);
    expect(await loadAcademicLogs({ sectionIds: [] })).toEqual([]);
    expect(await loadAcademicActivities([])).toEqual([]);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("rejects a child that moves between parent batches instead of returning the same ID twice", async () => {
    logs = Array.from({ length: 101 }, (_, id) => log(id));
    alterResult = (query) => ({ data: [{ ...activity(1, (query.filters.class_log_id as string[])[0]), id: "moving-child" }], count: 1, error: null });
    await expect(loadAcademicActivities(logs.map((item) => item.id))).rejects.toThrow("activities changed");
  });

  it("rejects an edit missing its complete source activities before posting anything", async () => {
    await expect(saveAcademicLog({ ...log(1), teacher_remark: undefined, activities: {}, expected_updated_at: log(1).updated_at }))
      .rejects.toThrow("complete activity list");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
