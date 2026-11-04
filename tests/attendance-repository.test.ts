import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createAttendanceRepository } from "../lib/attendance/repository";
import type { AttendanceChange, AttendanceContext, AttendanceEntry, AttendanceStatus } from "../lib/attendance/types";

type Row = Record<string, unknown>;
type Table = "students" | "enrollments" | "attendance";
type Filter = { column: string; operator: "eq" | "in" | "is"; value: unknown };
type Query = {
  table: Table;
  action: "select" | "insert" | "update";
  filters: Filter[];
  payload?: Row;
  fields: string;
  count: boolean;
  from: number;
  to: number;
  order?: { column: string; ascending: boolean };
};
type DbError = { message: string; code?: string };

/** A small in-memory PostgREST fake: query filters actually control reads and writes. */
class FakeDatabase {
  rows: Record<Table, Row[]> = { students: [], enrollments: [], attendance: [] };
  calls: Query[] = [];
  cap = Infinity;
  failure?: (query: Query) => DbError | null;
  beforeExecute?: (query: Query) => Promise<void>;
  activeWrites = 0;
  maximumActiveWrites = 0;

  client() {
    return { from: (table: Table) => new FakeQuery(this, table) } as unknown as SupabaseClient;
  }

  async execute(query: Query) {
    this.calls.push(structuredClone(query));
    const writing = query.action !== "select";
    if (writing) {
      this.activeWrites++;
      this.maximumActiveWrites = Math.max(this.maximumActiveWrites, this.activeWrites);
    }
    try {
      await this.beforeExecute?.(query);
      const error = this.failure?.(query);
      if (error) return { data: null, error, count: null };
      const matches = (row: Row) => query.filters.every(({ column, operator, value }) =>
        operator === "in" ? (value as unknown[]).includes(row[column]) : row[column] === value,
      );
      let rows = this.rows[query.table].filter(matches);
      if (query.action === "insert") {
        const payload = structuredClone(query.payload!);
        if (this.rows.attendance.some((row) => row.student_id === payload.student_id && row.attendance_date === payload.attendance_date)) {
          return { data: null, error: { message: "Duplicate student/date", code: "23505" }, count: null };
        }
        this.rows[query.table].push(payload);
        rows = [payload];
      } else if (query.action === "update") {
        for (const row of rows) Object.assign(row, query.payload);
      }
      const count = query.count ? rows.length : null;
      if (query.order) {
        const { column, ascending } = query.order;
        rows = [...rows].sort((left, right) => String(left[column]).localeCompare(String(right[column])) * (ascending ? 1 : -1));
      }
      rows = rows.slice(query.from, Math.min(query.to + 1, query.from + this.cap));
      const fields = query.fields.split(",");
      return {
        data: rows.map((row) => Object.fromEntries(fields.map((field) => [field, row[field] ?? null]))),
        error: null,
        count,
      };
    } finally {
      if (writing) this.activeWrites--;
    }
  }
}

class FakeQuery implements PromiseLike<Awaited<ReturnType<FakeDatabase["execute"]>>> {
  query: Query;
  constructor(private db: FakeDatabase, table: Table) {
    this.query = { table, action: "select", filters: [], fields: "*", count: false, from: 0, to: Infinity };
  }
  select(fields: string, options?: { count: string }) {
    this.query.fields = fields;
    this.query.count = options?.count === "exact";
    return this;
  }
  eq(column: string, value: unknown) { this.query.filters.push({ column, operator: "eq", value }); return this; }
  is(column: string, value: unknown) { this.query.filters.push({ column, operator: "is", value }); return this; }
  in(column: string, value: unknown[]) { this.query.filters.push({ column, operator: "in", value }); return this; }
  order(column: string, options?: { ascending: boolean }) { this.query.order = { column, ascending: options?.ascending ?? true }; return this; }
  range(from: number, to: number) { this.query.from = from; this.query.to = to; return this; }
  update(payload: Row) { this.query.action = "update"; this.query.payload = payload; return this; }
  insert(payload: Row) { this.query.action = "insert"; this.query.payload = payload; return this; }
  then<TResult1 = Awaited<ReturnType<FakeDatabase["execute"]>>, TResult2 = never>(
    resolve?: ((value: Awaited<ReturnType<FakeDatabase["execute"]>>) => TResult1 | PromiseLike<TResult1>) | null,
    reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.db.execute(this.query).then(resolve, reject);
  }
}

const context: AttendanceContext = {
  schoolId: "school-a", academicYearId: "year-a", classId: "class-a", sectionId: "section-a",
};
const date = "2026-11-02";

function addStudent(db: FakeDatabase, id: string, roll = id, overrides: Row = {}) {
  db.rows.students.push({ id, school_id: context.schoolId, first_name: `Pupil ${id}`, middle_name: null, last_name: "Example", admission_no: `ADM-${id}`, roll_no: "old-roll", ...overrides });
  db.rows.enrollments.push({ id: `enrollment-${id}`, student_id: id, academic_year_id: context.academicYearId, class_id: context.classId, section_id: context.sectionId, status: "active", roll_no: roll });
}
function addEntry(db: FakeDatabase, id: string, status: AttendanceStatus, remarks: string | null = null, overrides: Row = {}) {
  const entry = { student_id: id, status, remarks };
  db.rows.attendance.push({ ...entry, school_id: context.schoolId, academic_year_id: context.academicYearId, section_id: context.sectionId, attendance_date: date, marked_by: "someone-else", ...overrides });
  return entry;
}
function writes(db: FakeDatabase) { return db.calls.filter((query) => query.action !== "select"); }
function change(studentId: string, status: AttendanceStatus, expected: AttendanceEntry | null): AttendanceChange {
  return { studentId, status, expected };
}

describe("attendance repository load", () => {
  it("hydrates all six statuses, retains remarks and keeps missing pupils unmarked without writes", async () => {
    const db = new FakeDatabase();
    const statuses: AttendanceStatus[] = ["present", "absent", "late", "half_day", "leave", "holiday"];
    statuses.forEach((status, index) => { addStudent(db, String(index), String(index + 1)); addEntry(db, String(index), status, status === "holiday" ? "School/Class Holiday" : null); });
    addStudent(db, "missing", "7");

    const snapshot = await createAttendanceRepository(db.client()).load(context, date);

    expect(snapshot.students).toHaveLength(7);
    expect(Object.values(snapshot.entries).map((row) => row.status).sort()).toEqual([...statuses].sort());
    expect(snapshot.entries["5"].remarks).toBe("School/Class Holiday");
    expect(snapshot.entries.missing).toBeUndefined();
    expect(snapshot.students[0].roll_no).toBe("1");
    expect(writes(db)).toEqual([]);
    expect(db.calls.flatMap((query) => query.filters).some((filter) => filter.column === "marked_by")).toBe(false);
  });

  it("paginates enrollments, chunked students and attendance even below the requested server row cap", async () => {
    const db = new FakeDatabase();
    db.cap = 37;
    for (let index = 0; index < 407; index++) {
      const id = String(index).padStart(4, "0");
      addStudent(db, id, String(index + 1));
      addEntry(db, id, "present");
    }
    // These are not in the requested school/year/section/day.
    addEntry(db, "other-school", "absent", null, { school_id: "school-b" });
    addEntry(db, "other-year", "absent", null, { academic_year_id: "year-b" });
    addEntry(db, "other-section", "absent", null, { section_id: "section-b" });
    addEntry(db, "other-date", "absent", null, { attendance_date: "2026-11-03" });
    const snapshot = await createAttendanceRepository(db.client()).load(context, date);
    expect(snapshot.students).toHaveLength(407);
    expect(Object.keys(snapshot.entries)).toHaveLength(407);
    expect(snapshot.students[406].roll_no).toBe("407");
    expect(db.calls.filter((query) => query.table === "enrollments")).toHaveLength(11);
    expect(db.calls.filter((query) => query.table === "attendance")).toHaveLength(11);
    expect(db.calls.every((query) => query.order)).toBe(true);
    expect(db.calls.filter((query) => query.table === "students").every((query) =>
      query.filters.some((filter) => filter.column === "school_id" && filter.value === context.schoolId),
    )).toBe(true);
  });

  it("filters active year/class/section enrollment and uses enrollment roll numbers", async () => {
    const db = new FakeDatabase();
    addStudent(db, "active", "2");
    addStudent(db, "inactive", "1"); db.rows.enrollments[1].status = "inactive";
    addStudent(db, "wrong-section", "1"); db.rows.enrollments[2].section_id = "section-b";
    addStudent(db, "wrong-year", "1"); db.rows.enrollments[3].academic_year_id = "year-b";
    addStudent(db, "wrong-class", "1"); db.rows.enrollments[4].class_id = "class-b";
    const snapshot = await createAttendanceRepository(db.client()).load(context, date);
    expect(snapshot.students.map((student) => [student.id, student.roll_no])).toEqual([["active", "2"]]);
  });

  it.each(["missing", "foreign-school"])("fails closed for an inaccessible enrolled pupil (%s)", async (mode) => {
    const db = new FakeDatabase();
    addStudent(db, "pupil");
    if (mode === "missing") db.rows.students = [];
    else db.rows.students[0].school_id = "school-b";
    await expect(createAttendanceRepository(db.client()).load(context, date)).rejects.toThrow("Some enrolled students could not be accessed");
    expect(writes(db)).toEqual([]);
  });

  it.each(["unknown-status", "duplicate-entry", "duplicate-enrollment"])("fails closed for invalid register data (%s)", async (mode) => {
    const db = new FakeDatabase();
    addStudent(db, "pupil");
    addEntry(db, "pupil", "present");
    if (mode === "unknown-status") db.rows.attendance[0].status = "unmarked";
    if (mode === "duplicate-entry") addEntry(db, "pupil", "absent");
    if (mode === "duplicate-enrollment") db.rows.enrollments.push({ ...db.rows.enrollments[0], id: "duplicate" });
    await expect(createAttendanceRepository(db.client()).load(context, date)).rejects.toThrow(/unsupported|duplicate/);
    expect(writes(db)).toEqual([]);
  });

  it.each(["enrollments", "students", "attendance"] as Table[])("throws instead of treating %s errors as an empty register", async (table) => {
    const db = new FakeDatabase();
    addStudent(db, "pupil");
    db.failure = (query) => query.table === table ? { message: "Network unavailable" } : null;
    await expect(createAttendanceRepository(db.client()).load(context, date)).rejects.toThrow("Network unavailable");
  });

  it("rejects pagination that becomes incomplete while loading", async () => {
    const db = new FakeDatabase();
    db.cap = 1;
    addStudent(db, "1"); addStudent(db, "2");
    db.beforeExecute = async (query) => {
      if (query.table === "enrollments" && query.from > 0) db.rows.enrollments.pop();
    };
    await expect(createAttendanceRepository(db.client()).load(context, date)).rejects.toThrow("records changed while loading");
  });
});

describe("attendance repository save", () => {
  it("conditionally updates only the changed pupil, preserving untouched statuses and all remarks", async () => {
    const db = new FakeDatabase();
    addStudent(db, "edited"); addStudent(db, "holiday"); addStudent(db, "leave");
    const original = addEntry(db, "edited", "absent", "Parent informed");
    addEntry(db, "holiday", "holiday", "School/Class Holiday");
    addEntry(db, "leave", "leave", "Approved");
    const untouched = structuredClone(db.rows.attendance.slice(1));

    const result = await createAttendanceRepository(db.client()).save(context, date, "teacher", [change("edited", "late", original)]);

    expect(result).toEqual({ saved: [{ student_id: "edited", status: "late", remarks: "Parent informed" }], failures: [] });
    expect(db.rows.attendance.slice(1)).toEqual(untouched);
    const [write] = writes(db);
    expect(write.action).toBe("update");
    expect(write.payload).toEqual({ status: "late", marked_by: "teacher" });
    expect(write.filters).toEqual(expect.arrayContaining([
      { column: "school_id", operator: "eq", value: context.schoolId },
      { column: "academic_year_id", operator: "eq", value: context.academicYearId },
      { column: "section_id", operator: "eq", value: context.sectionId },
      { column: "student_id", operator: "eq", value: "edited" },
      { column: "attendance_date", operator: "eq", value: date },
      { column: "status", operator: "eq", value: "absent" },
      { column: "remarks", operator: "eq", value: "Parent informed" },
    ]));
  });

  it.each(["status", "remarks", "school", "year", "section", "date", "deleted"])("does not overwrite an existing row changed since load (%s)", async (mode) => {
    const db = new FakeDatabase();
    addStudent(db, "pupil");
    const original = addEntry(db, "pupil", "absent");
    if (mode === "status") db.rows.attendance[0].status = "leave";
    if (mode === "remarks") db.rows.attendance[0].remarks = "New note";
    if (mode === "school") db.rows.attendance[0].school_id = "school-b";
    if (mode === "year") db.rows.attendance[0].academic_year_id = "year-b";
    if (mode === "section") db.rows.attendance[0].section_id = "section-b";
    if (mode === "date") db.rows.attendance[0].attendance_date = "2026-11-03";
    if (mode === "deleted") db.rows.attendance = [];
    const before = structuredClone(db.rows.attendance);
    const result = await createAttendanceRepository(db.client()).save(context, date, "teacher", [change("pupil", "present", original)]);
    expect(result.saved).toEqual([]);
    expect(result.failures).toEqual([{ studentId: "pupil", message: expect.stringContaining("changed elsewhere") }]);
    expect(db.rows.attendance).toEqual(before);
    expect(writes(db)[0].filters).toContainEqual({ column: "remarks", operator: "is", value: null });
  });

  it("uses INSERT for a new explicit mark and rejects a duplicate that appeared after load", async () => {
    const db = new FakeDatabase();
    addStudent(db, "new"); addStudent(db, "race");
    addEntry(db, "race", "leave", "Recorded in another tab");
    const result = await createAttendanceRepository(db.client()).save(context, date, "teacher", [
      change("new", "absent", null), change("race", "present", null),
    ]);
    expect(result.saved).toEqual([{ student_id: "new", status: "absent", remarks: null }]);
    expect(result.failures).toEqual([{ studentId: "race", message: expect.stringContaining("recorded elsewhere") }]);
    expect(writes(db).map((query) => query.action)).toEqual(["insert", "insert"]);
    expect(db.rows.attendance.find((row) => row.student_id === "race")?.status).toBe("leave");
    expect(db.rows.attendance.find((row) => row.student_id === "new")).toMatchObject({
      school_id: context.schoolId, academic_year_id: context.academicYearId, section_id: context.sectionId,
      attendance_date: date, marked_by: "teacher", status: "absent",
    });
  });

  it("returns partial success while retaining conflicts, policy errors and rejected requests as failures", async () => {
    const db = new FakeDatabase();
    for (const id of ["ok", "conflict", "policy", "network"]) addStudent(db, id);
    const original = addEntry(db, "conflict", "absent");
    db.rows.attendance[0].status = "leave";
    db.failure = (query) => query.payload?.student_id === "policy" ? { message: "Row access denied", code: "42501" } : null;
    db.beforeExecute = async (query) => { if (query.payload?.student_id === "network") throw new Error("Connection interrupted"); };
    const result = await createAttendanceRepository(db.client()).save(context, date, "teacher", [
      change("ok", "present", null), change("conflict", "present", original), change("policy", "late", null), change("network", "absent", null),
    ]);
    expect(result.saved.map((entry) => entry.student_id)).toEqual(["ok"]);
    expect(result.failures.map((entry) => entry.studentId)).toEqual(["conflict", "policy", "network"]);
    expect(result.failures[1].message).toBe("Row access denied");
    expect(result.failures[2].message).toBe("Connection interrupted");
  });

  it("checks current active enrollment and school before writing a formerly loaded pupil", async () => {
    const db = new FakeDatabase();
    addStudent(db, "good"); addStudent(db, "withdrawn"); addStudent(db, "moved"); addStudent(db, "foreign");
    db.rows.enrollments[1].status = "withdrawn";
    db.rows.enrollments[2].section_id = "other-section";
    db.rows.students[3].school_id = "other-school";
    const result = await createAttendanceRepository(db.client()).save(context, date, "teacher", [
      ...["good", "withdrawn", "moved", "foreign"].map((id) => change(id, "present", null)),
    ]);
    expect(result.saved.map((entry) => entry.student_id)).toEqual(["good"]);
    expect(result.failures.map((entry) => entry.studentId)).toEqual(["withdrawn", "moved", "foreign"]);
    expect(writes(db)).toHaveLength(1);
  });

  it("does not write when all submitted statuses are unchanged, or changes are empty", async () => {
    const db = new FakeDatabase();
    addStudent(db, "pupil");
    const original = addEntry(db, "pupil", "holiday", "School/Class Holiday");
    const repository = createAttendanceRepository(db.client());
    expect(await repository.save(context, date, "teacher", [])).toEqual({ saved: [], failures: [] });
    expect(await repository.save(context, date, "teacher", [change("pupil", "holiday", original)])).toEqual({ saved: [original], failures: [] });
    expect(writes(db)).toHaveLength(0);
  });

  it("preserves holiday remarks when correcting its status, without inventing metadata rules", async () => {
    const db = new FakeDatabase();
    addStudent(db, "pupil");
    const original = addEntry(db, "pupil", "holiday", "School/Class Holiday");
    const result = await createAttendanceRepository(db.client()).save(context, date, "teacher", [change("pupil", "present", original)]);
    expect(result.saved[0]).toEqual({ student_id: "pupil", status: "present", remarks: "School/Class Holiday" });
  });

  it.each(["duplicate", "unknown-status", "wrong-expected-student", "unknown-expected-status"])("rejects malformed changes before any writes (%s)", async (mode) => {
    const db = new FakeDatabase();
    addStudent(db, "valid"); addStudent(db, "invalid");
    const changes = [change("valid", "present", null), change("invalid", "absent", null)];
    if (mode === "duplicate") changes[1].studentId = "valid";
    if (mode === "unknown-status") changes[1].status = "unmarked" as AttendanceStatus;
    if (mode === "wrong-expected-student") changes[1].expected = { student_id: "someone-else", status: "late", remarks: null };
    if (mode === "unknown-expected-status") changes[1].expected = { student_id: "invalid", status: "unknown" as AttendanceStatus, remarks: null };
    await expect(createAttendanceRepository(db.client()).save(context, date, "teacher", changes)).rejects.toThrow();
    expect(writes(db)).toHaveLength(0);
  });

  it("aborts before writes if enrollment verification fails", async () => {
    const db = new FakeDatabase();
    addStudent(db, "pupil");
    db.failure = (query) => query.table === "enrollments" ? { message: "Enrollment service unavailable" } : null;
    await expect(createAttendanceRepository(db.client()).save(context, date, "teacher", [change("pupil", "present", null)])).rejects.toThrow("Enrollment service unavailable");
    expect(writes(db)).toHaveLength(0);
  });

  it("bounds concurrent independent pupil writes rather than sending an unbounded batch", async () => {
    const db = new FakeDatabase();
    const releases: (() => void)[] = [];
    for (let index = 0; index < 9; index++) addStudent(db, String(index));
    db.beforeExecute = (query) => query.action === "insert" ? new Promise<void>((resolve) => { releases.push(resolve); }) : Promise.resolve();
    const pending = createAttendanceRepository(db.client()).save(context, date, "teacher", Array.from({ length: 9 }, (_, index) => change(String(index), "present", null)));
    for (let turn = 0; turn < 50; turn++) {
      await Promise.resolve();
      while (releases.length) releases.shift()!();
    }
    const result = await pending;
    expect(result.saved).toHaveLength(9);
    expect(db.maximumActiveWrites).toBe(4);
  });
});

describe("attendance repository scope validation", () => {
  it.each(["", "2026-2-1", "2026-02-30", "not-a-date", "2026-11-02T00:00:00Z"])("rejects invalid date %j before reads or writes", async (invalidDate) => {
    const db = new FakeDatabase();
    const repository = createAttendanceRepository(db.client());
    await expect(repository.load(context, invalidDate)).rejects.toThrow("valid attendance date");
    await expect(repository.save(context, invalidDate, "teacher", [])).rejects.toThrow("valid attendance date");
    expect(db.calls).toHaveLength(0);
  });

  it("rejects incomplete context and missing user before touching data", async () => {
    const db = new FakeDatabase();
    const repository = createAttendanceRepository(db.client());
    await expect(repository.load({ ...context, sectionId: "" }, date)).rejects.toThrow("section");
    await expect(repository.save(context, date, " ", [])).rejects.toThrow("Sign in");
    expect(db.calls).toHaveLength(0);
  });
});
