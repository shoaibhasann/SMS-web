import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoleDashboard } from "../components/dashboard/role-dashboard";
import { loadFamilyAttendance } from "../lib/attendance/family";
import { createClient } from "../lib/supabase/client";

const { from, client, effectiveAssignments, attendanceEditor, familyFeeLedger, officeFinanceSummary, officialAttendance } = vi.hoisted(() => {
  const from = vi.fn();
  return {
    from,
    effectiveAssignments: vi.fn(),
    attendanceEditor: vi.fn(),
    familyFeeLedger: vi.fn(),
    officeFinanceSummary: vi.fn(),
    officialAttendance: vi.fn(),
    client: {
      from,
      rpc: () => ({ abortSignal: () => ({ returns: async () => ({ data: [], error: null }) }) }),
      auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }) },
    },
  };
});

vi.mock("@/lib/supabase/client", () => ({ createClient: () => client }));
vi.mock("@/components/layout/app-shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/academic/attendance-editor", () => ({ AttendanceEditor: (props: unknown) => { attendanceEditor(props); return null; } }));
vi.mock("@/lib/assignments/attendance-coverage", () => ({ loadEffectiveAttendanceAssignments: effectiveAssignments }));
vi.mock("@/components/admin/attendance-submission-monitor", () => ({ AttendanceSubmissionMonitor: () => null }));
vi.mock("@/components/family/official-attendance-summary", () => ({ OfficialAttendanceSummary: (props: unknown) => { officialAttendance(props); return <section aria-label="Official attendance test panel" />; } }));
vi.mock("@/lib/finance/fee-changes", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/finance/fee-changes")>(),
  getFamilyFeeLedger: familyFeeLedger,
  getOfficeFinanceSummary: officeFinanceSummary,
}));

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

function feeLedger(studentId = "current", overrides: Record<string, unknown> = {}) {
  const row = {
    demand_id: `fee-${studentId}`, student_id: studentId, admission_no: `admission-${studentId}`,
    student_name: `Student ${studentId}`, academic_year_id: "year", academic_year_name: "2026–27",
    fee_name: "Tuition", fee_structure_id: "structure", kind: "monthly", billing_period: "2026-11", due_date: "2026-11-20",
    amount: "1000.00", discount: "0.00", late_fee: "0.00", net_amount: "900.00", paid_amount: "350.00", balance: "550.00", status: "partial", invalid: false,
    ...overrides,
  };
  return { academic_year_id: null, rows: [row], summary: { demand_count: 1, invalid_count: 0, net_amount: row.net_amount,
    paid_amount: row.paid_amount, balance: row.balance, opening_amount: "0.00" } };
}

function emptyFeeLedger() {
  return { academic_year_id: null, rows: [], summary: { demand_count: 0, invalid_count: 0,
    net_amount: "0.00", paid_amount: "0.00", balance: "0.00", opening_amount: "0.00" } };
}

function financeSummary(overrides: Record<string, unknown> = {}) {
  return { demand_count: 2, pending_count: 2, overdue_count: 1, invalid_count: 0, net_amount: "1700.00", paid_amount: "450.00", balance: "1250.00", opening_amount: "0.00",
    collections: { gross_amount: "550.00", reversal_amount: "100.00", net_amount: "450.00", today_gross: "450.00", today_reversal: "100.00", today_net: "350.00", month_gross: "550.00", month_reversal: "100.00", month_net: "450.00" }, ...overrides };
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
  effectiveAssignments.mockResolvedValue([]);
  familyFeeLedger.mockReset().mockResolvedValue(emptyFeeLedger());
  officeFinanceSummary.mockReset().mockResolvedValue(financeSummary());
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

describe("dashboard loading presentation", () => {
  it.each(["student", "parent"] as const)("starts the %s official report without waiting for unrelated fee reads", async role => {
    const fees = deferred<ReturnType<typeof emptyFeeLedger>>(); familyFeeLedger.mockReturnValue(fees.promise);
    resolveQuery = query => role === "parent" ? parentResolver(query) : query.table === "students" ? result(student("current")) : academicResult(query);
    const { container } = render(<RoleDashboard role={role} schoolId="school" userId={`${role}-user`} />);
    const expectedId = role === "parent" ? "a" : "current";
    await waitFor(() => expect(officialAttendance).toHaveBeenLastCalledWith(expect.objectContaining({ userId: `${role}-user`, role,
      student: expect.objectContaining({ id: expectedId, school_id: "school" }), loading: false })));
    expect(container.querySelector('[data-skeleton="form"]')).toBeInTheDocument();
    const identity = within(screen.getByRole("heading", { name: role === "parent" ? "Child Details" : "My Profile & Class" }).closest("section")!);
    expect(identity.queryByText(`Student ${expectedId}`, { exact: true })).not.toBeInTheDocument();
    await act(async () => fees.resolve(emptyFeeLedger()));
    expect(await identity.findByText(`Student ${expectedId}`, { exact: true })).toBeInTheDocument();
  });
  it.each(["student", "parent"] as const)("binds the %s official report separately to the verified profile and role", async role => {
    resolveQuery = query => role === "parent" ? parentResolver(query) : query.table === "students" ? result(student("current")) : academicResult(query);
    render(<RoleDashboard role={role} schoolId="school" userId={`${role}-user`} />);
    await waitFor(() => expect(officialAttendance).toHaveBeenLastCalledWith(expect.objectContaining({ userId: `${role}-user`, role,
      student: expect.objectContaining({ id: role === "parent" ? "a" : "current", school_id: "school" }), loading: false })));
    expect(screen.getByRole("region", { name: "Official attendance test panel" })).toBeInTheDocument();
    if (role === "parent") {
      fireEvent.change(screen.getByRole("combobox", { name: "Select child" }), { target: { value: "b" } });
      await waitFor(() => expect(officialAttendance).toHaveBeenLastCalledWith(expect.objectContaining({ role: "parent", userId: "parent-user", student: expect.objectContaining({ id: "b" }) })));
    }
  });
  it.each(["student", "parent"] as const)("keeps unverified %s values behind skeletons instead of showing zero or empty work", (role) => {
    resolveQuery = () => new Promise<QueryResult>(() => {});
    const { container } = render(<RoleDashboard role={role} schoolId="school" userId="pending-user" />);
    expect(container.querySelector('[data-skeleton="form"]')).toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    expect(screen.queryByText("No missed academic work found.")).not.toBeInTheDocument();
    expect(screen.queryByText("No homework or activities have been shared for this class yet.")).not.toBeInTheDocument();
    expect(screen.queryByText("No fee demands available.")).not.toBeInTheDocument();
    expect(screen.queryByText("Student current")).not.toBeInTheDocument();
  });

  it("does not claim that a teacher has no assignments or saved activity while access is loading", () => {
    resolveQuery = () => new Promise<QueryResult>(() => {});
    const { container } = render(<RoleDashboard role="teacher" schoolId="school" userId="pending-teacher" />);
    expect(container.querySelector('[data-skeleton="dashboard"]')).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading your teaching dashboard");
    expect(screen.queryByText(/No class teacher section is assigned/)).not.toBeInTheDocument();
    expect(screen.queryByText("No teaching activity recorded for today.")).not.toBeInTheDocument();
  });
});

describe("student and parent attendance", () => {
  it("gives substitutes a bounded dashboard register while permanent academic assignments stay unchanged", async () => {
    resolveQuery = (query) => {
      if (query.table === "teachers") return result({ id: "substitute", school_id: "school", full_name: "Substitute Teacher" });
      if (query.table === "academic_years") return result({ id: "year" });
      return result([]);
    };
    effectiveAssignments.mockResolvedValue([{ id: "source", teacher_id: "substitute", academic_year_id: "year", class_id: "covered-class", section_id: "covered-section",
      subject_id: "source-subject", is_class_teacher: true, class_name: "Covered Class", section_name: "A", subject_name: "English",
      coverage_id: "coverage", starts_on: "2026-11-05", ends_on: "2026-11-07" }]);
    render(<RoleDashboard role="teacher" schoolId="school" userId="substitute-user" />);
    await screen.findByText("Covered Class A");
    expect(screen.getByText("Temporary cover")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Attendance class" })).not.toBeInTheDocument();
    await waitFor(() => expect(attendanceEditor).toHaveBeenLastCalledWith(expect.objectContaining({
      context: { schoolId: "school", academicYearId: "year", classId: "covered-class", sectionId: "covered-section" },
      reviewOnlyHistory: true, dateLimits: { start: "2026-11-05", end: "2026-11-07" },
    })));
    expect(queries.find((query) => query.table === "teacher_subject_assignments")?.filters).toMatchObject({ teacher_id: "substitute", academic_year_id: "year" });
    expect(queries.filter((query) => ["classes", "sections", "subjects"].includes(query.table))).toHaveLength(0);
    expect(queries.find((query) => query.table === "attendance")?.filters.section_id).toEqual(["covered-section"]);
    expect(within(screen.getByText("My Classes").parentElement!).getByText("0")).toBeInTheDocument();
  });
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
    familyFeeLedger.mockResolvedValue(feeLedger(pupil, {
      demand_id: "old-demand", academic_year_id: "old-year", academic_year_name: "2025–26", billing_period: "2026-03",
      amount: "600.00", net_amount: "600.00", paid_amount: "600.00", balance: "0.00", status: "paid",
    }));
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
    expect(screen.getByText(/2026-03/)).toBeInTheDocument();
    expect(screen.queryByText("old-roll")).not.toBeInTheDocument();
    expect(screen.queryByText("legacy-roll")).not.toBeInTheDocument();
    expect(queries.find((query) => query.table === "enrollments")).toMatchObject({
      columns: expect.stringContaining("academic_years!inner"),
      filters: { student_id: pupil, status: "active", "academic_years.school_id": "school", "academic_years.is_current": true },
    });
    expect(familyFeeLedger).toHaveBeenCalledWith(client, pupil, 4, 0);
    expect(queries.some((query) => query.table === "student_fees")).toBe(false);
    expect(queries.some((query) => query.table === "class_logs")).toBe(false);
  });

  it.each([
    {
      scenario: "a failed fetch",
      response: { data: null, error: { message: "read rejected" } },
      message: "Attendance could not be loaded. Refresh to try again.",
      savedCount: "—",
    },
    { scenario: "an empty history", response: result([]), message: "No attendance records available.", savedCount: "—" },
    {
      scenario: "a recorded absence",
      response: result([{ attendance_date: "2026-11-03", academic_year_id: "year", status: "absent" }]),
      message: "Absent",
      savedCount: "0 of 1",
    },
  ])("shows the correct history and saved-record count for $scenario", async ({ response, message, savedCount }) => {
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
    expect(within(screen.getByText("Present or late", { exact: true }).parentElement!).getByText(savedCount)).toBeInTheDocument();
  });
  it.each(["student", "parent"] as const)("labels %s attendance as a saved sample instead of an official rate", async role => {
    const rows = ["present", "late", "half_day", "leave", "holiday", "absent"].map((status, index) => ({ status, attendance_date: `2026-11-0${6 - index}`, academic_year_id: "year" }));
    resolveQuery = query => {
      if (query.table === "attendance") return result(rows, 120);
      if (role === "parent") return parentResolver(query);
      return query.table === "students" ? result(student("current")) : academicResult(query);
    };
    render(<RoleDashboard role={role} schoolId="school" userId={`${role}-user`} />);
    await screen.findByText("2 of 6");
    const metric = within(screen.getByText("Present or late", { exact: true }).parentElement!);
    expect(metric.getByText("Saved record sample (up to 60); not an official rate")).toBeInTheDocument();
    expect(metric.queryByText(/%/)).not.toBeInTheDocument();
    expect(metric.queryByText(/120/)).not.toBeInTheDocument();
    expect(queries.find(query => query.table === "attendance")?.range).toEqual([0, 59]);
  });

  it("keeps the selected child's loaded data when the same child is selected again", async () => {
    resolveQuery = parentResolver;
    familyFeeLedger.mockResolvedValue(feeLedger("a"));
    render(<RoleDashboard role="parent" schoolId="school" userId="parent-user" />);
    await childDetails().findByText("Student a");
    await screen.findByText("Lesson class-a");
    expect(screen.getByRole("heading", { name: "Recent learning & work" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Homework" })).toHaveAttribute("href", "/modules/homework");
    expect(childDetails().queryByRole("link")).not.toBeInTheDocument();
    const reads = queries.filter((query) => query.table === "attendance").length;

    fireEvent.change(screen.getByRole("combobox", { name: "Select child" }), { target: { value: "a" } });

    expect(childDetails().getByText("Student a")).toBeInTheDocument();
    expect(screen.getByText("Lesson class-a")).toBeInTheDocument();
    expect(queries.filter((query) => query.table === "attendance")).toHaveLength(reads);
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

describe("teacher dashboard attendance draft", () => {
  const classTeacher = { id: "own", teacher_id: "teacher", academic_year_id: "year", class_id: "class-a", section_id: "section-a",
    subject_id: "subject", is_class_teacher: true, class_name: "Class 6", section_name: "A", subject_name: "Maths",
    coverage_id: null, starts_on: null, ends_on: null };
  const coverage = { ...classTeacher, id: "cover", class_id: "class-b", section_id: "section-b", class_name: "Class 7", section_name: "B",
    coverage_id: "coverage", starts_on: "2026-11-05", ends_on: "2026-11-07" };
  type EditorCall = { context: unknown; onLockChange: (locked: boolean) => void };
  const lastEditor = () => attendanceEditor.mock.lastCall![0] as EditorCall;

  async function openDirtyDraft() {
    resolveQuery = (query) => {
      if (query.table === "teachers") return result({ id: "teacher", school_id: "school", full_name: "Teacher" });
      if (query.table === "academic_years") return result({ id: "year" });
      return result([]);
    };
    render(<RoleDashboard role="teacher" schoolId="school" userId="teacher-user" />);
    await screen.findByText("Class 6 A");
    await waitFor(() => expect(lastEditor().context).not.toBeNull());
    act(() => lastEditor().onLockChange(true));
  }

  it("keeps the editor context and warns when a background check fails during unsaved edits", async () => {
    effectiveAssignments.mockResolvedValueOnce([classTeacher]).mockRejectedValueOnce(new Error("offline"));
    await openDirtyDraft();
    await act(async () => { fireEvent.focus(window); });
    expect(await screen.findByText(/Your register is kept/)).toHaveAttribute("role", "status");
    expect(lastEditor().context).toMatchObject({ classId: "class-a", sectionId: "section-a" });
  });

  it("keeps the draft when a new coverage appears and the selected section is unchanged", async () => {
    effectiveAssignments.mockResolvedValueOnce([classTeacher]).mockResolvedValue([classTeacher, coverage]);
    await openDirtyDraft();
    const teacherReads = queries.filter((query) => query.table === "teachers").length;
    await act(async () => { fireEvent.focus(window); });
    expect(await screen.findByRole("radio", { name: /Class 7 B/ })).toBeInTheDocument();
    expect(lastEditor().context).toMatchObject({ classId: "class-a", sectionId: "section-a" });
    expect(queries.filter((query) => query.table === "teachers")).toHaveLength(teacherReads);
  });
});

describe("role dashboard request lifetimes", () => {
  it.each([
    ["2026-11-04T21:30:00Z", "2026-11-05", "2026-11-12", "2026-11-13"],
    ["2026-10-27T21:30:00Z", "2026-10-28", "2026-11-04", "2026-11-05"],
    ["2026-12-27T21:30:00Z", "2026-12-28", "2027-01-04", "2027-01-05"],
    ["2028-02-25T21:30:00Z", "2028-02-26", "2028-03-04", "2028-03-05"],
    ["2026-03-03T21:30:00Z", "2026-03-04", "2026-03-11", "2026-03-12"],
  ])("includes the seventh school day in admin upcoming exams at %s", async (instant, schoolDay, seventhDay, eighthDay) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(instant));
    resolveQuery = (query) => {
      if (query.table !== "teacher_assessments" || !query.filters["gte:assessment_date"]) return result([]);
      const assessments = [
        { id: "today", name: "Today exam", assessment_date: schoolDay },
        { id: "seventh", name: "Seventh-day exam", assessment_date: seventhDay },
        { id: "eighth", name: "Eighth-day exam", assessment_date: eighthDay },
      ].filter((assessment) => assessment.assessment_date >= String(query.filters["gte:assessment_date"])
        && assessment.assessment_date <= String(query.filters["lte:assessment_date"]));
      return result(assessments, assessments.length);
    };
    render(<RoleDashboard role="admin" schoolId="school" userId="admin" />);
    const upcoming = within(screen.getByRole("heading", { name: "Upcoming Tests" }).closest("section")!);
    expect(await upcoming.findByText("Seventh-day exam")).toBeInTheDocument();
    expect(upcoming.getByText("Today exam")).toBeInTheDocument();
    expect(upcoming.queryByText("Eighth-day exam")).not.toBeInTheDocument();
    expect(queries.find((query) => query.table === "teacher_assessments" && query.filters["gte:assessment_date"])?.filters)
      .toMatchObject({ school_id: "school", "gte:assessment_date": schoolDay, "lte:assessment_date": seventhDay });
    expect(within(screen.getByText("Upcoming Exams").parentElement!).getByText("2")).toBeInTheDocument();
  });

  it.each([
    ["2026-10-27T21:30:00Z", "2026-10-28", "2026-11-04"],
    ["2026-03-03T21:30:00Z", "2026-03-04", "2026-03-11"],
  ])("keeps the teacher seventh-day counter consistent across DST at %s", async (instant, schoolDay, seventhDay) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(instant));
    resolveQuery = (query) => {
      if (query.table === "teachers") return result({ id: "teacher", school_id: "school", full_name: "Teacher" });
      if (query.table === "academic_years") return result({ id: "year" });
      if (query.table === "teacher_assessments" && query.filters["gte:assessment_date"]) {
        return result([{ id: "seventh", name: "Seventh-day exam", assessment_date: seventhDay, maximum_marks: 100 }]);
      }
      return result([]);
    };
    render(<RoleDashboard role="teacher" schoolId="school" userId="teacher-user" />);
    expect(await screen.findByText("Seventh-day exam")).toBeInTheDocument();
    expect(within(screen.getByText("Upcoming Tests", { exact: true }).parentElement!).getByText("1")).toBeInTheDocument();
    expect(queries.find((query) => query.table === "teacher_assessments" && query.filters["gte:assessment_date"])?.filters)
      .toMatchObject({ teacher_id: "teacher", "gte:assessment_date": schoolDay, "lte:assessment_date": seventhDay });
  });

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

    effectiveAssignments.mockResolvedValue([{ id: "assignment", teacher_id: "teacher", academic_year_id: "year", class_id: "class", section_id: "section",
      subject_id: "subject", is_class_teacher: true, class_name: "Class", section_name: "Section", subject_name: "Subject", coverage_id: null, starts_on: null, ends_on: null }]);
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

describe("canonical dashboard finance", () => {
  const feeBalances = () => within(screen.getByRole("heading", { name: "Fee balances" }).closest("section")!);
  const officeFinance = () => within(screen.getByRole("heading", { name: "Finance" }).closest("section")!);
  const financeValue = (label: string) => within(officeFinance().getByText(label, { exact: true }).closest("article")!);

  it.each([
    { role: "student", userId: "student-user", pupil: "current" },
    { role: "parent", userId: "parent-user", pupil: "a" },
  ] as const)("shows effective fee, applied payments and balance to a $role instead of raw demand amounts", async ({ role, userId, pupil }) => {
    familyFeeLedger.mockResolvedValue(feeLedger(pupil));
    resolveQuery = (query) => role === "parent" ? parentResolver(query)
      : query.table === "students" ? result(student(pupil)) : academicResult(query);
    render(<RoleDashboard role={role} schoolId="school" userId={userId} />);
    await feeBalances().findByText("₹900.00");
    expect(feeBalances().getByText("₹350.00")).toBeInTheDocument();
    expect(feeBalances().getByText("₹550.00")).toBeInTheDocument();
    expect(feeBalances().getByText("Net fee")).toBeInTheDocument();
    expect(feeBalances().getByText("partial")).toBeInTheDocument();
    expect(feeBalances().queryByText("₹1,000.00")).not.toBeInTheDocument();
    expect(familyFeeLedger).toHaveBeenCalledWith(client, pupil, 4, 0);
    expect(queries.some((query) => query.table === "student_fees")).toBe(false);
  });

  it("uses the complete verified demand count while rendering a bounded family preview", async () => {
    const first = feeLedger("current");
    familyFeeLedger.mockResolvedValue({ ...first, rows: Array.from({ length: 4 }, (_, index) => ({ ...first.rows[0], demand_id: `fee-${index}`, billing_period: `2026-${String(index + 1).padStart(2, "0")}` })),
      summary: { ...first.summary, demand_count: 81 } });
    resolveQuery = (query) => query.table === "students" ? result(student("current")) : academicResult(query);
    render(<RoleDashboard role="student" schoolId="school" userId="student-user" />);
    await feeBalances().findByText(/Showing 4 of 81 retained demands/);
    expect(feeBalances().getAllByRole("listitem")).toHaveLength(4);
    expect(within(screen.getByText("Fee records", { exact: true }).parentElement!).getByText("81")).toBeInTheDocument();
  });

  it.each([
    { role: "student", userId: "student-user" },
    { role: "parent", userId: "parent-user" },
  ] as const)("shows unavailable family balances after a $role finance read fails", async ({ role, userId }) => {
    familyFeeLedger.mockRejectedValue(new Error("Canonical finance unavailable"));
    resolveQuery = (query) => role === "parent" ? parentResolver(query)
      : query.table === "students" ? result(student("current")) : academicResult(query);
    render(<RoleDashboard role={role} schoolId="school" userId={userId} />);
    await feeBalances().findByRole("alert");
    expect(feeBalances().getByRole("alert")).toHaveTextContent("Fee balances could not be loaded");
    expect(feeBalances().queryByText("No fee demands available.")).not.toBeInTheDocument();
    expect(feeBalances().queryByRole("list")).not.toBeInTheDocument();
    expect(within(screen.getByText("Fee records", { exact: true }).parentElement!).getByText("—")).toBeInTheDocument();
    expect(within(screen.getByText("Fee records", { exact: true }).parentElement!).getByText("Currently unavailable")).toBeInTheDocument();
    expect(screen.getByText(role === "student" ? "Student current" : "Student a")).toBeInTheDocument();
  });

  it("labels an inconsistent family demand for review instead of inventing zero amounts", async () => {
    const inconsistent = feeLedger("current", { net_amount: null, paid_amount: null, balance: null, status: "review_required", invalid: true });
    familyFeeLedger.mockResolvedValue({ ...inconsistent, summary: { ...inconsistent.summary, invalid_count: 1 } });
    resolveQuery = (query) => query.table === "students" ? result(student("current")) : academicResult(query);
    render(<RoleDashboard role="student" schoolId="school" userId="student-user" />);
    await feeBalances().findByText("review required");
    expect(feeBalances().getAllByText("Needs review")).toHaveLength(3);
    expect(feeBalances().queryByText("₹0.00")).not.toBeInTheDocument();
  });

  it("clears the old child's financial cards and ignores a late canonical fee response", async () => {
    const stale = deferred<ReturnType<typeof feeLedger>>();
    const next = deferred<ReturnType<typeof feeLedger>>();
    let aReads = 0;
    familyFeeLedger.mockImplementation((_client, pupil) => pupil === "a"
      ? ++aReads === 1 ? Promise.resolve(feeLedger("a", { net_amount: "911.00" })) : stale.promise
      : next.promise);
    resolveQuery = parentResolver;
    render(<RoleDashboard role="parent" schoolId="school" userId="parent-user" />);
    await feeBalances().findByText("₹911.00");
    fireEvent.change(screen.getByRole("combobox", { name: "Select child" }), { target: { value: "b" } });
    expect(feeBalances().queryByText("₹911.00")).not.toBeInTheDocument();
    expect(feeBalances().getByRole("status")).toHaveTextContent("Loading fee balances");
    fireEvent.change(screen.getByRole("combobox", { name: "Select child" }), { target: { value: "a" } });
    await waitFor(() => expect(aReads).toBe(2));
    fireEvent.change(screen.getByRole("combobox", { name: "Select child" }), { target: { value: "b" } });
    await act(async () => { next.resolve(feeLedger("b", { net_amount: "822.00" })); });
    await feeBalances().findByText("₹822.00");
    await act(async () => { stale.resolve(feeLedger("a", { net_amount: "999.00" })); });
    expect(feeBalances().getByText("₹822.00")).toBeInTheDocument();
    expect(feeBalances().queryByText("₹999.00")).not.toBeInTheDocument();
  });

  it("discards an old student's financial response after the signed-in identity changes", async () => {
    const old = deferred<ReturnType<typeof feeLedger>>();
    familyFeeLedger.mockImplementation((_client, pupil) => pupil === "old" ? old.promise : Promise.resolve(feeLedger("current", { net_amount: "822.00" })));
    resolveQuery = (query) => query.table === "students" ? result(student(query.filters.profile_id === "old-user" ? "old" : "current")) : academicResult(query);
    const view = render(<RoleDashboard role="student" schoolId="school" userId="old-user" />);
    await waitFor(() => expect(familyFeeLedger).toHaveBeenCalledWith(client, "old", 4, 0));
    view.rerender(<RoleDashboard role="student" schoolId="school" userId="current-user" />);
    await feeBalances().findByText("₹822.00");
    await act(async () => { old.resolve(feeLedger("old", { net_amount: "999.00" })); });
    expect(feeBalances().queryByText("₹999.00")).not.toBeInTheDocument();
  });

  it("uses canonical event-date net collections and server pending counts for the school overview", async () => {
    resolveQuery = () => result([]);
    render(<RoleDashboard role="admin" schoolId="school" userId="admin" />);
    await financeValue("Today's Collection").findByText("₹350.00");
    expect(financeValue("This Month Collection").getByText("₹450.00")).toBeInTheDocument();
    expect(financeValue("Pending Fees").getByText("2")).toBeInTheDocument();
    expect(financeValue("Overdue Fees").getByText("1")).toBeInTheDocument();
    expect(officeFinanceSummary).toHaveBeenCalledWith(client, "school");
    expect(queries.some((query) => ["fee_payments", "student_fees"].includes(query.table))).toBe(false);
  });

  it("does not replace a failed office summary with zero or gross raw payments", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    officeFinanceSummary.mockRejectedValue(new Error("Finance service failed"));
    resolveQuery = () => result([]);
    try {
      render(<RoleDashboard role="admin" schoolId="school" userId="admin" />);
      await financeValue("Today's Collection").findByText("Unavailable");
      expect(officeFinance().getAllByText("Unavailable")).toHaveLength(4);
      expect(officeFinance().queryByText("₹0.00")).not.toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent("Some dashboard data could not be loaded");
      expect(queries.some((query) => query.table === "fee_payments")).toBe(false);
    } finally { logged.mockRestore(); }
  });

  it("withholds unknown monetary totals when the canonical office records need review", async () => {
    const summary = financeSummary();
    officeFinanceSummary.mockResolvedValue({ ...summary, invalid_count: 1, net_amount: null, paid_amount: null, balance: null,
      collections: { ...summary.collections, today_net: null, month_net: null } });
    resolveQuery = () => result([]);
    render(<RoleDashboard role="admin" schoolId="school" userId="admin" />);
    await financeValue("Today's Collection").findByText("Unavailable");
    expect(financeValue("This Month Collection").getByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Some fee records need review");
    expect(officeFinance().queryByText("₹0.00")).not.toBeInTheDocument();
  });

  it("dates a school notice by its IST day, so a late-evening UTC timestamp shows the next day", async () => {
    resolveQuery = (query) => query.table === "notices" ? result([{ id: "n1", title: "Holiday notice", content: "Closed", created_at: "2026-11-12T20:00:00Z" }]) : result([]);
    render(<RoleDashboard role="admin" schoolId="school" userId="admin" />);
    expect(await screen.findByText("13 Nov 2026")).toBeInTheDocument();
  });

  it("keeps the current school's canonical totals when a previous school's summary completes late", async () => {
    const previous = deferred<ReturnType<typeof financeSummary>>();
    officeFinanceSummary.mockImplementation((_client, school) => school === "old-school" ? previous.promise : Promise.resolve(financeSummary()));
    resolveQuery = () => result([]);
    const view = render(<RoleDashboard role="admin" schoolId="old-school" userId="admin" />);
    await waitFor(() => expect(officeFinanceSummary).toHaveBeenCalledWith(client, "old-school"));
    view.rerender(<RoleDashboard role="admin" schoolId="current-school" userId="admin" />);
    await financeValue("Today's Collection").findByText("₹350.00");
    const stale = financeSummary();
    await act(async () => { previous.resolve({ ...stale, collections: { ...stale.collections, today_net: "9999.00" } }); });
    expect(financeValue("Today's Collection").getByText("₹350.00")).toBeInTheDocument();
    expect(officeFinance().queryByText("₹9,999.00")).not.toBeInTheDocument();
  });
});

describe("principal dashboard assessments", () => {
  const publicationMetadata = { assessment_id: "assessment-p", school_id: "school", school_name: "School", academic_year_id: "year", academic_year_name: "2026–27",
    class_id: "class", class_name: "Class 6", section_id: "section", section_name: "A", subject_id: "subject", subject_name: "Maths", teacher_id: "teacher",
    teacher_name: "Teacher", name: "Unit test 1", assessment_date: "2026-11-01", maximum_marks: 50, assessment_updated_at: "2026-11-01T10:00:00Z", status: "completed" };
  const originalRpc = client.rpc;
  afterEach(() => { client.rpc = originalRpc; });

  it("shows the real upcoming count and published results instead of empty raw-table reads, with working links", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-04T21:30:00Z"));
    const rpc = vi.fn(async (name: string) => name === "list_principal_upcoming_assessments"
      ? { data: { total_count: 3, rows: [{ id: "exam-1", name: "Science quiz", assessment_date: "2026-11-06", maximum_marks: 20, class_id: "class", section_id: "section", subject_id: "subject" }] }, error: null }
      : { data: { offset: 0, total_count: 1, rows: [{ id: "submission-p", assessment_id: "assessment-p", school_id: "school", status: "published", requested_at: "2026-11-02T10:00:00Z",
        requester_name: "Teacher", reviewed_at: "2026-11-03T10:00:00Z", revision: 1, metadata: publicationMetadata }] }, error: null });
    client.rpc = rpc as unknown as typeof client.rpc;
    resolveQuery = () => result([]);
    render(<RoleDashboard role="principal" schoolId="school" userId="principal" />);
    const upcoming = within(screen.getByRole("heading", { name: "Upcoming Tests" }).closest("section")!);
    expect(await upcoming.findByText("Science quiz")).toBeInTheDocument();
    expect(within(screen.getByText("Upcoming Exams").parentElement!).getByText("3")).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith("list_principal_upcoming_assessments", { p_school_id: "school", p_from: "2026-11-05", p_to: "2026-11-12" });
    const results = within(screen.getByRole("heading", { name: "Recent Results" }).closest("section")!);
    expect(await results.findByText("Unit test 1")).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith("list_assessment_result_submissions", { p_school_id: "school", p_status: "published", p_offset: 0 });
    expect(results.queryByText("No marked assessment results available yet.")).not.toBeInTheDocument();
    expect(results.getByRole("link")).toHaveAttribute("href", "/modules/published-results");
    expect(upcoming.queryByRole("link")).not.toBeInTheDocument();
    expect(queries.some((query) => query.table === "teacher_assessments" || query.table === "teacher_assessment_marks")).toBe(false);
  });

  it("links Upcoming Tests to the exams module for a principal who also teaches in the same school", async () => {
    client.rpc = vi.fn(async () => ({ data: { offset: 0, total_count: 0, rows: [] }, error: null })) as unknown as typeof client.rpc;
    resolveQuery = () => result([]);
    render(<RoleDashboard role="principal" schoolId="school" userId="principal" schoolRoles={["principal", "teacher"]} />);
    const upcoming = within(screen.getByRole("heading", { name: "Upcoming Tests" }).closest("section")!);
    expect(await upcoming.findByRole("link")).toHaveAttribute("href", "/modules/exams");
  });

  it("shows unavailable, not zero, when the principal schedule cannot be read", async () => {
    client.rpc = vi.fn(async (name: string) => name === "list_principal_upcoming_assessments" ? { data: null, error: { code: "42501", message: "denied" } }
      : { data: { offset: 0, total_count: 0, rows: [] }, error: null }) as unknown as typeof client.rpc;
    resolveQuery = () => result([]);
    render(<RoleDashboard role="principal" schoolId="school" userId="principal" />);
    expect(await screen.findByText("Some dashboard data could not be loaded. Please refresh or contact your administrator.")).toBeInTheDocument();
    expect(within(screen.getByText("Upcoming Exams").parentElement!).getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("No tests are scheduled for the next seven days.")).not.toBeInTheDocument();
    expect(screen.getByText("Upcoming tests are unavailable right now.")).toBeInTheDocument();
  });
});
