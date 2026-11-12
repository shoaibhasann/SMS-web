import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { createTeachingAssignmentRepository, type TeachingAssignmentRow } from "../lib/assignments/repository";

type Row = Record<string, unknown>;
function fake(overrides: Record<string, Row[]> = {}, options: { zeroWrites?: boolean; cap?: number; writeError?: { code: string; message: string } } = {}) {
  const tables: Record<string, Row[]> = {
    user_roles: [{ id: "role", role: "school_admin", school_id: "a", user_id: "user" }],
    schools: [{ id: "a", name: "School A" }], teachers: [{ id: "teacher", school_id: "a", profile_id: "user", full_name: "Teacher A" }],
    academic_years: [{ id: "year", school_id: "a", name: "2026", is_current: true }],
    classes: [{ id: "class", school_id: "a", name: "Class 1" }], sections: [{ id: "section", school_id: "a", class_id: "class", name: "A" }],
    subjects: [{ id: "subject", school_id: "a", name: "Math" }], teacher_subject_assignments: [], ...overrides,
  };
  const calls: { table: string; operation: string; select?: string; filters: [string, unknown][] }[] = [];
  const auth = { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user" } }, error: null }) };
  const client = { auth, from(table: string) {
    const call = { table, operation: "read", select: undefined as string | undefined, filters: [] as [string, unknown][] };
    calls.push(call);
    let from = 0; let to = 999; let payload: Row = {}; const filters: ((row: Row) => boolean)[] = [];
    const query = {
      select(columns: string) { call.select = columns; return query; },
      eq(column: string, value: unknown) { call.filters.push([column, value]); filters.push((row) => row[column] === value); return query; },
      is(column: string, value: null) { return query.eq(column, value); },
      in(column: string, values: unknown[]) { call.filters.push([column, values]); filters.push((row) => values.includes(row[column])); return query; },
      match(values: Row) { for (const [column, value] of Object.entries(values)) query.eq(column, value); return query; },
      order() { return query; }, range(start: number, end: number) { from = start; to = end; return query; },
      insert(value: Row) { call.operation = "insert"; payload = value; return query; },
      update(value: Row) { call.operation = "update"; payload = value; return query; },
      delete() { call.operation = "delete"; return query; },
      then(resolve: (result: { data: Row[] | null; count: number; error: { code: string; message: string } | null }) => unknown) {
        if (call.operation !== "read" && options.writeError) return Promise.resolve(resolve({ data: null, count: 0, error: options.writeError }));
        const matched = (tables[table] ?? []).filter((row) => filters.every((filter) => filter(row)));
        let result = matched;
        if (call.operation !== "read" && options.zeroWrites) result = [];
        else if (call.operation === "insert") { result = [{ id: "new-assignment", ...payload }]; tables[table].push(...result); }
        else if (call.operation === "update") { for (const row of matched) Object.assign(row, payload); }
        else if (call.operation === "delete") tables[table] = tables[table].filter((row) => !matched.includes(row));
        const data = call.operation === "read" ? result.slice(from, Math.min(to + 1, from + (options.cap ?? 1000))) : result;
        return Promise.resolve(resolve({ data, count: result.length, error: null }));
      },
    };
    return query;
  } } as unknown as SupabaseClient;
  return { repository: createTeachingAssignmentRepository(client), calls, tables, auth };
}
const draft = { teacher_id: "teacher", class_id: "class", section_id: "section", subject_id: "subject", is_class_teacher: false };
const previous: TeachingAssignmentRow = { id: "assignment", academic_year_id: "year", ...draft };

describe("assignment access and canonical school reads", () => {
  it("pairs each manager role with its school and keeps a second teacher school read-only without profile overrides", async () => {
    const f = fake({ user_roles: [
      { role: "school_admin", school_id: "a", user_id: "user" }, { role: "teacher", school_id: "b", user_id: "user" },
    ], schools: [{ id: "a", name: "A" }, { id: "b", name: "B" }], teachers: [{ id: "teacher-b", school_id: "b", profile_id: "user" }] });
    expect((await f.repository.access()).schools).toEqual([
      { id: "a", name: "A", canManage: true, teacherId: null }, { id: "b", name: "B", canManage: false, teacherId: "teacher-b" },
    ]);
    expect(f.calls.some((call) => call.table === "profiles")).toBe(false);
    await expect(f.repository.save("b", "year", draft, null)).rejects.toThrow(/administrator or principal/);
    expect(f.calls.some((call) => call.operation === "insert")).toBe(false);
  });
  it("preserves NULL-school global-super-admin access to auth-visible schools", async () => {
    const f = fake({ user_roles: [{ role: "super_admin", school_id: null, user_id: "user" }], schools: [{ id: "a", name: "A" }, { id: "b", name: "B" }] });
    expect((await f.repository.access()).schools.map((school) => school.canManage)).toEqual([true, true]);
  });
  it.each(["accountant", "reception_staff", "parent", "student"])("does not expose management for %s", async (role) => {
    await expect(fake({ user_roles: [{ role, school_id: "a", user_id: "user" }] }).repository.access()).rejects.toThrow(/No school administrator/);
  });
  it("paginates below the requested row cap and narrows assignments to the selected school's teachers/year", async () => {
    const f = fake({ teachers: Array.from({ length: 5 }, (_, index) => ({ id: `t${index}`, school_id: "a", full_name: `Teacher ${index}` })),
      teacher_subject_assignments: [{ ...previous, teacher_id: "t4" }, { ...previous, id: "foreign", teacher_id: "foreign" }],
    }, { cap: 2 });
    const loaded = await f.repository.load({ id: "a", name: "A", canManage: true, teacherId: null });
    expect(loaded.teachers).toHaveLength(5); expect(loaded.rows).toEqual([{ ...previous, teacher_id: "t4" }]);
    expect(f.calls.filter((call) => call.table === "teachers")).toHaveLength(3);
  });
  it("rejects missing/ambiguous current years and incoherent section/class references", async () => {
    await expect(fake({ academic_years: [] }).repository.load({ id: "a", name: "A", canManage: true, teacherId: null })).rejects.toThrow(/Exactly one current/);
    const f = fake({ teacher_subject_assignments: [{ ...previous, section_id: "wrong-section" }] });
    await expect(f.repository.load({ id: "a", name: "A", canManage: true, teacherId: null })).rejects.toThrow(/mismatched school/);
  });
  it("never treats an inaccessible own teacher profile as an empty assignment list", async () => {
    await expect(fake({ teachers: [] }).repository.load({ id: "a", name: "A", canManage: false, teacherId: "teacher" })).rejects.toThrow(/no longer accessible/);
  });
});

describe("confirmed, scoped assignment mutations", () => {
  it.each(["school_admin", "principal"])("confirms one returned inserted record for %s", async (role) => {
    const f = fake({ user_roles: [{ role, school_id: "a", user_id: "user" }] });
    await f.repository.save("a", "year", draft, null);
    expect(f.tables.teacher_subject_assignments).toEqual([{ id: "new-assignment", academic_year_id: "year", ...draft }]);
    expect(f.calls.find((call) => call.operation === "insert")?.select).toContain("is_class_teacher");
  });
  it.each(["insert", "update", "delete"])("rejects zero-row %s instead of reporting success", async (operation) => {
    const f = fake({ teacher_subject_assignments: [{ ...previous }] }, { zeroWrites: true });
    const call = operation === "delete" ? f.repository.remove("a", previous) : f.repository.save("a", "year", draft, operation === "update" ? previous : null);
    await expect(call).rejects.toThrow(/No (successful save|removal) was confirmed/);
    expect(f.tables.teacher_subject_assignments).toEqual([previous]);
  });
  it.each(["insert", "update"])("surfaces the server's non-current academic year refusal on %s", async (operation) => {
    const message = "Choose the current academic year for this school.";
    const f = fake({ teacher_subject_assignments: [{ ...previous }] }, { writeError: { code: "22023", message } });
    await expect(f.repository.save("a", "year", draft, operation === "update" ? previous : null)).rejects.toThrow(message);
  });
  it("matches the loaded values and rejects stale UPDATE rather than overwriting a changed assignment", async () => {
    const f = fake({ teacher_subject_assignments: [{ ...previous, subject_id: "changed" }] });
    await expect(f.repository.save("a", "year", draft, previous)).rejects.toThrow(/changed elsewhere/);
    expect(f.tables.teacher_subject_assignments[0].subject_id).toBe("changed");
  });
  it("can remove a legacy NULL-section row with exact expected-value filters", async () => {
    const row = { ...previous, section_id: null }; const f = fake({ teacher_subject_assignments: [{ ...row }] });
    await f.repository.remove("a", row); expect(f.tables.teacher_subject_assignments).toEqual([]);
    expect(f.calls.find((call) => call.operation === "delete")?.filters).toContainEqual(["section_id", null]);
  });
  it("checks current authority again before writing and refuses missing auth", async () => {
    const f = fake(); await f.repository.access();
    f.auth.getUser.mockResolvedValue({ data: { user: null }, error: null });
    await expect(f.repository.save("a", "year", draft, null)).rejects.toThrow(/sign in again/);
    expect(f.calls.some((call) => call.operation === "insert")).toBe(false);
  });
});

describe("assignment timetable periods", () => {
  it("reads the governed RPC and refuses malformed rows", async () => {
    const period = { id: "p1", class_name: "Class 1", section_name: null, day_of_week: 1, period_no: 1, start_time: "08:00:00", end_time: "09:00:00" };
    const rpc = vi.fn().mockResolvedValueOnce({ data: [period], error: null })
      .mockResolvedValueOnce({ data: [{ id: "p2" }], error: null })
      .mockResolvedValueOnce({ data: null, error: { code: "42501", message: "denied" } });
    const repository = createTeachingAssignmentRepository({ rpc } as unknown as SupabaseClient);
    await expect(repository.timetablePeriods("a", "assignment")).resolves.toEqual([period]);
    expect(rpc).toHaveBeenCalledWith("get_assignment_timetable_periods", { p_school_id: "a", p_assignment_id: "assignment" });
    await expect(repository.timetablePeriods("a", "assignment")).rejects.toThrow("could not be checked");
    await expect(repository.timetablePeriods("a", "assignment")).rejects.toThrow("Your permission changed");
  });
});
