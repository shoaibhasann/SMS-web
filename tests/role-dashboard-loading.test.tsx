import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoleDashboard } from "../components/dashboard/role-dashboard";
import { loadFamilyAttendance } from "../lib/attendance/family";
import { createClient } from "../lib/supabase/client";

const { from, client } = vi.hoisted(() => {
  const from = vi.fn();
  return {
    from,
    client: {
      from,
      rpc: () => ({ abortSignal: () => ({ returns: async () => ({ data: [], error: null }) }) }),
      auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }) },
    },
  };
});

vi.mock("@/lib/supabase/client", () => ({ createClient: () => client }));
vi.mock("@/components/layout/app-shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/academic/attendance-editor", () => ({ AttendanceEditor: () => null }));
vi.mock("@/components/admin/attendance-submission-monitor", () => ({ AttendanceSubmissionMonitor: () => null }));

type ReadQuery = {
  table: string;
  columns: string;
  filters: Record<string, unknown>;
  countMode?: string;
  order?: { column: string; ascending?: boolean };
  range?: [number, number];
};
type QueryResult = { data: unknown; error: { message: string } | null; count?: number };
type QueryResolver = (query: ReadQuery) => QueryResult | Promise<QueryResult>;

let queries: ReadQuery[];
let resolveQuery: QueryResolver;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function result(data: unknown, count = 0): QueryResult {
  return { data, error: null, count };
}

function student(id: string) {
  return { id, school_id: "school", admission_no: `admission-${id}`, first_name: `Student ${id}`, last_name: null, status: "active" };
}

function academicResult(query: ReadQuery): QueryResult {
  const id = String(query.filters.student_id ?? "");
  if (query.table === "enrollments") return result({ class_id: `class-${id}`, section_id: null,
    academic_year_id: "year", roll_no: id, classes: { name: `Class ${id}` }, sections: { name: `Section ${id}` } });
  if (query.table === "attendance") return result([{ attendance_date: "2026-11-02", academic_year_id: "year", status: "present", remarks: null }]);
  if (query.table === "student_fees") return result([]);
  if (query.table === "class_logs") {
    const classId = String(query.filters.class_id);
    return result([{ id: `log-${classId}`, class_id: classId, academic_year_id: "year", log_date: "2026-11-02", topic: `Lesson ${classId}`, subject_id: "subject" }]);
  }
  return result([]);
}

beforeEach(() => {
  queries = [];
  resolveQuery = academicResult;
  sessionStorage.clear();
  from.mockImplementation((table: string) => {
    const query: ReadQuery = { table, columns: "", filters: {} };
    queries.push(query);
    return {
      select(columns: string, options?: { count?: string }) {
        query.columns = columns;
        query.countMode = options?.count;
        return this;
      },
      eq(column: string, value: unknown) { query.filters[column] = value; return this; },
      in(column: string, value: unknown) { query.filters[column] = value; return this; },
      order(column: string, options?: { ascending?: boolean }) {
        query.order = { column, ascending: options?.ascending };
        return this;
      },
      limit() { return this; },
      returns() { return this; },
      or() { return this; },
      is() { return this; },
      gte(column: string, value: unknown) { query.filters[`gte:${column}`] = value; return this; },
      lte(column: string, value: unknown) { query.filters[`lte:${column}`] = value; return this; },
      lt() { return this; },
      neq() { return this; },
      range(start: number, end: number) { query.range = [start, end]; return this; },
      maybeSingle() { return Promise.resolve(resolveQuery(query)); },
      then(onFulfilled: (value: QueryResult) => unknown, onRejected?: (reason: unknown) => unknown) {
        return Promise.resolve(resolveQuery(query)).then(onFulfilled, onRejected);
      },
    };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function childDetails() {
  return within(screen.getByRole("heading", { name: "Child Details" }).closest("section")!);
}

function parentResolver(query: ReadQuery): QueryResult | Promise<QueryResult> {
  if (query.table === "parents") return result({ id: "parent", school_id: "school" });
  if (query.table === "student_parents") return result([{ student_id: "a" }, { student_id: "b" }]);
  if (query.table === "students") {
    const ids = query.filters.id;
    return result([student("a"), student("b")].filter((item) =>
      Array.isArray(ids) && ids.includes(item.id) && item.school_id === query.filters.school_id,
    ));
  }
  return academicResult(query);
}

function attendanceHistory(title: string) {
  return within(screen.getByRole("heading", { name: title }).closest("section")!);
}

describe("student and parent attendance", () => {
  it("keeps the exact attendance total separate from the requested page", async () => {
    const page = [{ attendance_date: "2026-11-03", academic_year_id: "year", status: "present" }];
    resolveQuery = () => result(page, 41);

    await expect(loadFamilyAttendance(createClient(), student("current"), { offset: 40, limit: 20 }))
      .resolves.toEqual({ rows: page, count: 41, error: false });
    expect(queries[0]).toMatchObject({
      table: "attendance",
      filters: { school_id: "school", student_id: "current" },
      countMode: "exact",
      order: { column: "attendance_date", ascending: false },
      range: [40, 59],
    });
  });

  it.each([
    { role: "student", userId: "student-user", studentId: "current", title: "Attendance History" },
    { role: "parent", userId: "parent-user", studentId: "a", title: "Attendance by Date" },
  ] as const)("loads scoped attendance dates and labels for a $role", async ({ role, userId, studentId, title }) => {
    const history = [
      { status: "late", label: "Late", attendance_date: "2026-11-03" },
      { status: "half_day", label: "Half Day", attendance_date: "2026-11-02" },
      { status: "holiday", label: "Holiday", attendance_date: "2026-11-01" },
    ];
    const attendance = [
      ...history.map(({ status, attendance_date }) => ({
        status, attendance_date, school_id: "school", student_id: studentId, academic_year_id: "year",
      })),
      { status: "absent", attendance_date: "2026-11-05", school_id: "other-school", student_id: studentId, academic_year_id: "year" },
      { status: "leave", attendance_date: "2026-11-04", school_id: "school", student_id: "other-student", academic_year_id: "year" },
    ];
    resolveQuery = (query) => {
      if (query.table === "attendance") {
        return result(attendance.filter((row) => Object.entries(query.filters).every(([column, value]) =>
          row[column as keyof typeof row] === value,
        )));
      }
      if (role === "parent") return parentResolver(query);
      return query.table === "students" ? result(student(studentId)) : academicResult(query);
    };

    render(<RoleDashboard role={role} schoolId="dashboard-school" userId={userId} />);

    const attendanceCard = attendanceHistory(title);
    await attendanceCard.findByText("Half Day");
    expect(screen.getByText(`Class ${studentId}`)).toBeInTheDocument();
    expect(screen.getByText(`Section ${studentId}`)).toBeInTheDocument();
    expect(queries.find((query) => query.table === "attendance")?.filters).toMatchObject({ school_id: "school", student_id: studentId });
    expect(attendanceCard.getAllByRole("listitem")).toHaveLength(history.length);
    for (const { label, attendance_date } of history) {
      const date = attendanceCard.getByText(label).closest("li")?.querySelector("time");
      expect(date).toHaveAttribute("datetime", attendance_date);
      expect(date).not.toBeEmptyDOMElement();
    }
    expect(attendanceCard.queryByText("Absent")).not.toBeInTheDocument();
    expect(attendanceCard.queryByText("Leave")).not.toBeInTheDocument();
  });

  it.each([
    { role: "student", userId: "student-user", pupil: "current", title: "Attendance History" },
    { role: "parent", userId: "parent-user", pupil: "a", title: "Attendance by Date" },
  ] as const)("keeps prior attendance and fees visible to a $role without a current placement", async ({ role, userId, pupil, title }) => {
    resolveQuery = (query) => {
      if (query.table === "enrollments") {
        return query.filters["academic_years.is_current"] ? result(null)
          : result({ class_id: "previous-class", section_id: "previous-section", academic_year_id: "old-year", roll_no: "old-roll" });
      }
      if (query.table === "attendance") return result([
        { attendance_date: "2026-03-02", academic_year_id: "old-year", status: "late" },
      ]);
      if (query.table === "student_fees") return result([
        { id: "old-demand", amount: 600, discount: 0, late_fee: 0, status: "paid", billing_period: "2026-03", due_date: "2026-03-08" },
      ]);
      if (role === "parent") return parentResolver(query);
      if (query.table === "students") return result({ ...student(pupil), roll_no: "legacy-roll" });
      return academicResult(query);
    };

    render(<RoleDashboard role={role} schoolId="school" userId={userId} />);
    await attendanceHistory(title).findByText("Late");
    expect(screen.getByText("2026-03")).toBeInTheDocument();
    expect(screen.queryByText("old-roll")).not.toBeInTheDocument();
    expect(screen.queryByText("legacy-roll")).not.toBeInTheDocument();
    expect(queries.find((query) => query.table === "enrollments")).toMatchObject({
      columns: expect.stringContaining("academic_years!inner"),
      filters: { student_id: pupil, status: "active", "academic_years.school_id": "school", "academic_years.is_current": true },
    });
    expect(queries.find((query) => query.table === "student_fees")?.filters).toEqual({ school_id: "school", student_id: pupil });
    expect(queries.some((query) => query.table === "class_logs")).toBe(false);
  });

  it.each([
    {
      scenario: "a failed fetch",
      response: { data: null, error: { message: "read rejected" } },
      message: "Attendance could not be loaded. Refresh to try again.",
      rate: "—",
    },
    { scenario: "an empty history", response: result([]), message: "No attendance records available.", rate: "—" },
    {
      scenario: "a recorded absence",
      response: result([{ attendance_date: "2026-11-03", academic_year_id: "year", status: "absent" }]),
      message: "Absent",
      rate: "0%",
    },
  ])("shows the correct history and rate for $scenario", async ({ response, message, rate }) => {
    resolveQuery = (query) => {
      if (query.table === "students") return result(student("current"));
      if (query.table === "attendance") return response;
      return academicResult(query);
    };

    render(<RoleDashboard role="student" schoolId="school" userId="student-user" />);

    const history = attendanceHistory("Attendance History");
    const status = await history.findByText(message);
    if (response.error) {
      expect(status).toHaveAttribute("role", "alert");
      expect(history.queryByText("No attendance records available.")).not.toBeInTheDocument();
    } else {
      expect(history.queryByRole("alert")).not.toBeInTheDocument();
    }
    expect(within(screen.getByText("Attendance", { exact: true }).parentElement!).getByText(rate)).toBeInTheDocument();
  });

  it.each([
    { scenario: "still linked", linkedIds: ["a", "b"], expected: "b" },
    { scenario: "no longer linked", linkedIds: ["a"], expected: "a" },
  ])("restores a saved child on remount only when $scenario", async ({ linkedIds, expected }) => {
    const user = userEvent.setup();
    resolveQuery = parentResolver;
    const dashboard = <RoleDashboard role="parent" schoolId="school" userId="parent-user" />;
    const initial = render(dashboard);
    await childDetails().findByText("Student a");
    await user.selectOptions(screen.getByRole("combobox", { name: "Select child" }), "b");
    await childDetails().findByText("Student b");
    initial.unmount();

    queries = [];
    resolveQuery = (query) => query.table === "student_parents"
      ? result(linkedIds.map((id) => ({ student_id: id })))
      : parentResolver(query);
    render(dashboard);

    await childDetails().findByText(`Student ${expected}`);
    expect(screen.getByRole("combobox", { name: "Select child" })).toHaveValue(expected);
    expect(queries.filter((query) => query.table === "attendance").map((query) => query.filters.student_id)).toEqual([expected]);
  });
});

describe("role dashboard request lifetimes", () => {
  it("uses the IST school day for the admin attendance overview after UTC midnight differs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-04T21:30:00Z"));
    resolveQuery = () => result([]);
    render(<RoleDashboard role="admin" schoolId="school" userId="admin" />);
    await waitFor(() => expect(queries.some((query) => query.table === "attendance")).toBe(true));
    expect(queries.filter((query) => query.table === "attendance").every((query) => query.filters.attendance_date === "2026-11-05")).toBe(true);
  });

  it.each([
    ["2026-11-02T18:30:01.000Z", "2026-11-03", "2026-11-01"],
    ["2026-10-31T18:30:00.000Z", "2026-11-01", "2026-11-01"],
  ])("uses the Indian school day for teacher queries and counters at %s", async (instant, schoolDay, monthStart) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(instant));
    const log = {
      class_id: "class", section_id: "section", subject_id: "subject", academic_year_id: "year", status: "published",
    };
    resolveQuery = (query) => {
      if (query.table === "teachers") return result({ id: "teacher", school_id: "school", full_name: "Teacher" });
      if (query.table === "academic_years") return result({ id: "year" });
      if (query.table === "teacher_subject_assignments") return result([{
        id: "assignment", ...log, is_class_teacher: true,
      }]);
      if (query.table === "classes") return result([{ id: "class", name: "Class 6" }]);
      if (query.table === "sections") return result([{ id: "section", name: "A" }]);
      if (query.table === "subjects") return result([{ id: "subject", name: "Science" }]);
      if (query.table === "class_logs" && query.columns !== "id") return result([
        { id: "current-log", ...log, topic: "School-day lesson", log_date: schoolDay },
        { id: "previous-log", ...log, topic: "UTC-day lesson", log_date: instant.slice(0, 10) },
      ]);
      if (query.table === "attendance") return result(query.filters.attendance_date === schoolDay ? [{
        student_id: "student", section_id: "section", academic_year_id: "year", attendance_date: schoolDay, status: "absent",
      }] : []);
      return result([]);
    };

    render(<RoleDashboard role="teacher" schoolId="school" userId="teacher-user" />);
    expect(await screen.findByText("1 absent student may need to catch up on 1 academic item.")).toBeInTheDocument();
    expect(queries.find((query) => query.table === "attendance")?.filters.attendance_date).toBe(schoolDay);
    const monthlyLogs = queries.find((query) => query.table === "class_logs" && query.columns === "id");
    expect(monthlyLogs?.filters).toMatchObject({ "gte:log_date": monthStart, "lte:log_date": schoolDay });
    expect(queries.find((query) => query.table === "teacher_assessments" && query.filters["gte:assessment_date"])?.filters["gte:assessment_date"]).toBe(schoolDay);
    const todayActivity = within(screen.getByRole("heading", { name: "Today’s Teaching Activity" }).closest("section")!);
    expect(todayActivity.getByText("School-day lesson")).toBeInTheDocument();
    expect(todayActivity.queryByText("UTC-day lesson")).not.toBeInTheDocument();
    expect(within(screen.getByText("Today’s attendance activity").parentElement!).getByText("1")).toBeInTheDocument();
  });

  it("clears the old child's data immediately and ignores its late response after another child is selected", async () => {
    const oldEnrollment = deferred<QueryResult>();
    const nextEnrollment = deferred<QueryResult>();
    let firstChildRequests = 0;
    resolveQuery = (query) => {
      if (query.table === "enrollments" && query.filters.student_id === "a") {
        firstChildRequests += 1;
        return firstChildRequests === 1 ? academicResult(query) : oldEnrollment.promise;
      }
      if (query.table === "enrollments" && query.filters.student_id === "b") return nextEnrollment.promise;
      return parentResolver(query);
    };
    render(<RoleDashboard role="parent" schoolId="school" userId="parent-user" />);
    expect(await childDetails().findByText("Student a")).toBeInTheDocument();
    expect(screen.getByText("Lesson class-a")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "b" } });
    expect(childDetails().queryByText("Student a")).not.toBeInTheDocument();
    expect(screen.queryByText("Lesson class-a")).not.toBeInTheDocument();
    await waitFor(() => expect(queries.some((query) => query.table === "enrollments" && query.filters.student_id === "b")).toBe(true));

    // Begin another request for A, then return to B before either finishes.
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "a" } });
    await waitFor(() => expect(firstChildRequests).toBe(2));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "b" } });
    await act(async () => { nextEnrollment.resolve(result({ class_id: "class-b", section_id: null, academic_year_id: "year", roll_no: "b" })); });
    expect(await childDetails().findByText("Student b")).toBeInTheDocument();
    await act(async () => { oldEnrollment.resolve(result({ class_id: "class-a", section_id: null, academic_year_id: "year", roll_no: "a" })); });
    expect(childDetails().getByText("Student b")).toBeInTheDocument();
    expect(screen.getByText("Lesson class-b")).toBeInTheDocument();
    expect(screen.queryByText("Lesson class-a")).not.toBeInTheDocument();
  });

  it("ignores a student profile response from the previous signed-in user", async () => {
    const previous = deferred<QueryResult>();
    resolveQuery = (query) => query.table === "students"
      ? query.filters.profile_id === "old-user" ? previous.promise : result(student("current"))
      : academicResult(query);
    const view = render(<RoleDashboard role="student" schoolId="school" userId="old-user" />);
    view.rerender(<RoleDashboard role="student" schoolId="school" userId="current-user" />);
    expect(await screen.findByText("Student current")).toBeInTheDocument();
    await act(async () => { previous.resolve(result(student("old"))); });
    expect(screen.queryByText("Student old")).not.toBeInTheDocument();
    expect(queries.some((query) => query.table === "enrollments" && query.filters.student_id === "old")).toBe(false);
  });

  it("ignores a teacher profile response after the selected user changes", async () => {
    const previous = deferred<QueryResult>();
    resolveQuery = (query) => {
      if (query.table === "teachers") return query.filters.profile_id === "old-user" ? previous.promise : result({ id: "current", school_id: "school", full_name: "Current Teacher" });
      if (query.table === "academic_years") return result({ id: "year" });
      return result([]);
    };
    const view = render(<RoleDashboard role="teacher" schoolId="school" userId="old-user" />);
    view.rerender(<RoleDashboard role="teacher" schoolId="school" userId="current-user" />);
    expect(await screen.findByRole("heading", { name: "Welcome back, Current Teacher" })).toBeInTheDocument();
    await act(async () => { previous.resolve(result({ id: "old", school_id: "old-school", full_name: "Old Teacher" })); });
    expect(screen.queryByRole("heading", { name: "Welcome back, Old Teacher" })).not.toBeInTheDocument();
    expect(queries.some((query) => query.table === "academic_years" && query.filters.school_id === "old-school")).toBe(false);
  });

  it("keeps the current school overview when an old school's pending query completes", async () => {
    const previous = deferred<QueryResult>();
    resolveQuery = (query) => {
      if (query.table === "students" && query.filters.school_id === "old-school") return previous.promise;
      if (query.table === "students") return result([], 42);
      return result([]);
    };
    const view = render(<RoleDashboard role="admin" schoolId="old-school" userId="admin" />);
    view.rerender(<RoleDashboard role="admin" schoolId="current-school" userId="admin" />);
    expect(await screen.findByText("42")).toBeInTheDocument();
    await act(async () => { previous.resolve(result([], 99)); });
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.queryByText("99")).not.toBeInTheDocument();
    expect(queries.some((query) => query.table === "subjects" && query.filters.school_id === "old-school")).toBe(false);
  });

  it("retains the missing-school error when refresh is clicked", () => {
    render(<RoleDashboard role="admin" schoolId={null} userId="admin" />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(screen.getByRole("alert")).toHaveTextContent("This admin account is not linked to a school.");
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
    expect(from).not.toHaveBeenCalled();
  });
});
