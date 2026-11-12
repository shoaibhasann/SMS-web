import type { ReactNode } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoleDashboard } from "../components/dashboard/role-dashboard";

// web-shell#3 / web-shell#5: dashboard tiles say exactly what they count, and a failed read
// shows an unavailable state instead of 0 or an empty-state claim (DASHBOARD-QA D-06, UI-02).
const { from, client, familyFeeLedger } = vi.hoisted(() => {
  const from = vi.fn();
  return {
    from,
    familyFeeLedger: vi.fn(),
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
vi.mock("@/lib/assignments/attendance-coverage", () => ({ loadEffectiveAttendanceAssignments: async () => [] }));
vi.mock("@/components/family/official-attendance-summary", () => ({ OfficialAttendanceSummary: () => null }));
vi.mock("@/components/family/guardian-attendance-alerts", () => ({ GuardianAttendanceAlerts: () => null }));
vi.mock("@/lib/finance/fee-changes", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/finance/fee-changes")>(),
  getFamilyFeeLedger: familyFeeLedger,
}));

type Query = { table: string; columns: string; countMode?: string; filters: Record<string, unknown> };
type Result = { data: unknown; error: { message: string } | null; count?: number | null };
let resolveQuery: (query: Query) => Result;
const ok = (data: unknown, count: number | null = null): Result => ({ data, error: null, count });
const failed: Result = { data: null, error: { message: "read rejected" } };

function student(id: string) {
  return { id, school_id: "school", admission_no: `admission-${id}`, first_name: `Student ${id}`, last_name: null, status: "active" };
}

function familyResult(query: Query): Result {
  if (query.table === "parents") return ok({ id: "parent", school_id: "school" });
  if (query.table === "student_parents") return ok([{ student_id: "a" }]);
  if (query.table === "students") return query.filters.profile_id ? ok(student("current")) : ok([student("a")]);
  if (query.table === "enrollments") return ok({ class_id: "class", section_id: null, academic_year_id: "year", roll_no: "7",
    classes: { name: "Class Six" }, sections: { name: "Section A" } });
  if (query.table === "class_logs") return ok(Array.from({ length: 30 }, (_, index) => ({
    id: `log-${index}`, class_id: "class", academic_year_id: "year", log_date: "2026-11-02", topic: `Lesson ${index}`, subject_id: "subject",
  })), 45);
  if (query.table === "class_activities") return ok([{ id: "act", class_log_id: "log-0", activity_type: "homework", title: "Read chapter 4" }]);
  return ok([]);
}

function teacherResult(query: Query): Result {
  if (query.table === "teachers") return ok({ id: "teacher", school_id: "school", full_name: "Asha Teacher" });
  if (query.table === "academic_years") return ok({ id: "year" });
  return ok([], 0);
}

// Like PostgREST, a total comes back only when { count: "exact" } is requested.
function respond(query: Query): Result {
  const result = resolveQuery(query);
  return query.countMode === "exact" ? result : { ...result, count: null };
}

beforeEach(() => {
  familyFeeLedger.mockReset().mockResolvedValue({ academic_year_id: null, rows: [], summary: { demand_count: 0, invalid_count: 0,
    net_amount: "0.00", paid_amount: "0.00", balance: "0.00", opening_amount: "0.00" } });
  from.mockImplementation((table: string) => {
    const query: Query = { table, columns: "", filters: {} };
    const builder = {
      select(columns: string, options?: { count?: string }) { query.columns = columns; query.countMode = options?.count; return builder; },
      eq(column: string, value: unknown) { query.filters[column] = value; return builder; },
      in(column: string, value: unknown) { query.filters[column] = value; return builder; },
      gte(column: string, value: unknown) { query.filters[`gte:${column}`] = value; return builder; },
      lte: () => builder, order: () => builder, limit: () => builder, returns: () => builder, or: () => builder, is: () => builder,
      range: () => builder, lt: () => builder, neq: () => builder,
      maybeSingle: () => Promise.resolve(respond(query)),
      then: (onFulfilled: (value: Result) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(respond(query)).then(onFulfilled, onRejected),
    };
    return builder;
  });
});

const expectOnlyTeacherProfileMessage = () => {
  expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  for (const label of ["My Classes", "Upcoming Tests", "Academic Logs", "Homework Given"]) expect(screen.queryByRole("heading", { name: label })).not.toBeInTheDocument();
  for (const copy of ["No upcoming tests scheduled.", "No notices published yet.", "Your recent academic activity will appear here.", "No teaching activity recorded for today."]) expect(screen.queryByText(copy)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Publish Notice/ })).not.toBeInTheDocument();
};
const tile = (label: string) => within(screen.getByRole("heading", { name: label }).closest("article")!);

describe("family dashboard counts and failed reads", () => {
  it.each([
    { role: "student", logs: "Academic logs", work: "Homework & projects" },
    { role: "parent", logs: "Academic logs", work: "Homework & projects" },
  ] as const)("shows the exact published-log total and labels the $role work tile as a sample", async ({ role, logs, work }) => {
    resolveQuery = familyResult;
    render(<RoleDashboard role={role} schoolId="school" userId={`${role}-user`} />);
    expect(await screen.findByText("Read chapter 4")).toBeInTheDocument();
    expect(tile(logs).getByText("45")).toBeInTheDocument();
    expect(tile(logs).getByText("Published this academic year")).toBeInTheDocument();
    expect(tile(work).getByText("1")).toBeInTheDocument();
    expect(tile(work).getByText("From the latest 30 class logs")).toBeInTheDocument();
    expect(tile(logs).queryByText("Available school records")).not.toBeInTheDocument();
    expect(tile(work).queryByText("Available school records")).not.toBeInTheDocument();
  });

  it.each(["student", "parent"] as const)("shows unavailable, not zero or 'no homework', when the %s class-log read fails", async (role) => {
    resolveQuery = (query) => query.table === "class_logs" ? failed : familyResult(query);
    render(<RoleDashboard role={role} schoolId="school" userId={`${role}-user`} />);
    expect(await screen.findAllByText("Class work could not be loaded. Refresh to try again.")).toHaveLength(2);
    const [logs, work] = ["Academic logs", "Homework & projects"];
    expect(tile(logs).getByText("—")).toBeInTheDocument();
    expect(tile(logs).getByText("Currently unavailable")).toBeInTheDocument();
    expect(tile(work).getByText("—")).toBeInTheDocument();
    expect(tile(work).queryByText("0")).not.toBeInTheDocument();
    expect(screen.queryByText("No homework or activities have been shared for this class yet.")).not.toBeInTheDocument();
    expect(screen.queryByText("No missed academic work found.")).not.toBeInTheDocument();
  });

  it("shows the class as unavailable when the student's enrollment read fails", async () => {
    resolveQuery = (query) => query.table === "enrollments" ? failed : familyResult(query);
    render(<RoleDashboard role="student" schoolId="school" userId="student-user" />);
    expect(await screen.findAllByText("Class work could not be loaded. Refresh to try again.")).toHaveLength(2);
    expect(screen.getAllByText("Unavailable")).toHaveLength(3);
    for (const label of ["Roll No.", "Class", "Section"]) expect(screen.getByText(label, { selector: "dt" }).nextElementSibling).toHaveTextContent("Unavailable");
    expect(tile("Academic logs").getByText("Currently unavailable")).toBeInTheDocument();
  });

  it("shows the roll number as unavailable when the guardian's child enrollment read fails", async () => {
    resolveQuery = (query) => query.table === "enrollments" ? failed : familyResult(query);
    render(<RoleDashboard role="parent" schoolId="school" userId="parent-user" />);
    expect(await screen.findAllByText("Class work could not be loaded. Refresh to try again.")).toHaveLength(2);
    for (const label of ["Roll No.", "Class", "Section"]) expect(screen.getByText(label, { selector: "dt" }).nextElementSibling).toHaveTextContent("Unavailable");
  });
});

describe("admin dashboard failed reads", () => {
  it("says recent academic logs could not be loaded instead of 'none recorded' when the class_logs read fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    resolveQuery = (query) => query.table === "class_logs" ? failed : ok([], 0);
    try {
      render(<RoleDashboard role="admin" schoolId="school" userId="admin-user" />);
      expect(await screen.findByText("Recent academic logs could not be loaded. Refresh to try again.")).toHaveAttribute("role", "alert");
      expect(screen.getByText("Recent learning activity could not be loaded.")).toBeInTheDocument();
      expect(screen.queryByText("No academic activity has been recorded yet.")).not.toBeInTheDocument();
      expect(screen.getByText("No school notices available yet.")).toBeInTheDocument();
    } finally { logged.mockRestore(); }
  });
});

describe("teacher dashboard failed reads", () => {
  it("shows My Classes as unavailable instead of 0 when the teaching-assignment read fails", async () => {
    resolveQuery = (query) => query.table === "teacher_subject_assignments" ? failed : teacherResult(query);
    render(<RoleDashboard role="teacher" schoolId="school" userId="teacher-user" />);
    expect(await screen.findByText("Teacher assignments could not be loaded. Reload before recording attendance.")).toBeInTheDocument();
    expect(tile("My Classes").getByText("—")).toBeInTheDocument();
    expect(tile("My Classes").getByText("Currently unavailable")).toBeInTheDocument();
    expect(tile("My Classes").queryByText("0")).not.toBeInTheDocument();
  });

  it("shows upcoming tests as unavailable instead of 0 when that read fails", async () => {
    resolveQuery = (query) => query.table === "teacher_assessments" && query.filters["gte:assessment_date"] ? failed : teacherResult(query);
    render(<RoleDashboard role="teacher" schoolId="school" userId="teacher-user" />);
    expect(await screen.findByText("Upcoming tests could not be loaded.")).toBeInTheDocument();
    expect(tile("Upcoming Tests").getByText("—")).toBeInTheDocument();
    expect(tile("Upcoming Tests").getByText("Currently unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No upcoming tests scheduled.")).not.toBeInTheDocument();
  });

  it("shows recent academic activity as unavailable when the recent class-log read fails", async () => {
    resolveQuery = (query) => query.table === "class_logs" && !query.filters["gte:log_date"] ? failed : teacherResult(query);
    render(<RoleDashboard role="teacher" schoolId="school" userId="teacher-user" />);
    expect(await screen.findByText("Recent academic activity could not be loaded. Refresh to try again.")).toBeInTheDocument();
    expect(screen.getByText("Today's teaching activity could not be loaded.")).toBeInTheDocument();
    expect(screen.getByText("Recent learning activity could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByText("Your recent academic activity will appear here.")).not.toBeInTheDocument();
    expect(screen.queryByText("No teaching activity recorded for today.")).not.toBeInTheDocument();
  });

  it("says the teacher profile could not be loaded instead of 'not linked' when that read fails", async () => {
    resolveQuery = (query) => query.table === "teachers" ? failed : teacherResult(query);
    render(<RoleDashboard role="teacher" schoolId="school" userId="teacher-user" />);
    expect(await screen.findByText("Your teacher profile could not be loaded. Refresh to try again.")).toBeInTheDocument();
    expect(screen.queryByText(/not linked/)).not.toBeInTheDocument();
    expectOnlyTeacherProfileMessage();
  });

  it("clears an earlier teacher dashboard when a refresh fails at the teacher profile lookup", async () => {
    resolveQuery = teacherResult;
    render(<RoleDashboard role="teacher" schoolId="school" userId="teacher-user" />);
    expect(await screen.findByRole("heading", { name: "My Classes" })).toBeInTheDocument();
    resolveQuery = (query) => query.table === "teachers" ? failed : teacherResult(query);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Your teacher profile could not be loaded. Refresh to try again.")).toBeInTheDocument();
    expectOnlyTeacherProfileMessage();
  });

  it("shows the teacher's notices as unavailable instead of 'none published' when that read fails", async () => {
    resolveQuery = (query) => query.table === "notices" ? failed : teacherResult(query);
    render(<RoleDashboard role="teacher" schoolId="school" userId="teacher-user" />);
    expect(await screen.findByText("Your notices could not be loaded. Refresh to try again.")).toBeInTheDocument();
    expect(screen.queryByText("No notices published yet.")).not.toBeInTheDocument();
  });
});

// Owner decision 12 Nov 2026: a pupil's family adult is always called Guardian in visible text.
describe("guardian wording on dashboards", () => {
  it("titles the family adult's dashboard Guardian Dashboard", async () => {
    resolveQuery = familyResult;
    render(<RoleDashboard role="parent" schoolId="school" userId="parent-user" />);
    expect(await screen.findByRole("heading", { name: "Guardian Dashboard" })).toBeInTheDocument();
    expect(screen.getByText("Guardian workspace")).toBeInTheDocument();
    expect(screen.queryByText(/\bParents?\b/)).not.toBeInTheDocument();
  });

  it.each([
    ["the profile read fails", (query: Query) => query.table === "parents" ? failed : familyResult(query), "Your guardian profile could not be loaded. Refresh to try again."],
    ["no profile is linked", (query: Query) => query.table === "parents" ? ok(null) : familyResult(query), "No guardian profile is linked to this account."],
    ["no child is linked", (query: Query) => query.table === "student_parents" ? ok([]) : familyResult(query), "No child is linked to this guardian account yet."],
  ] as const)("says guardian, not parent, when %s", async (_case, resolver, copy) => {
    resolveQuery = resolver;
    render(<RoleDashboard role="parent" schoolId="school" userId="parent-user" />);
    expect(await screen.findByText(copy)).toBeInTheDocument();
    expect(screen.queryByText(/\bparent\b/i)).not.toBeInTheDocument();
  });

  it("labels the admin count of family adults Total Guardians", async () => {
    resolveQuery = (query) => ok([], query.table === "parents" ? 7 : 0);
    render(<RoleDashboard role="admin" schoolId="school" userId="admin-user" />);
    expect(await screen.findByText("Total Guardians")).toBeInTheDocument();
    expect(screen.queryByText("Total Parents")).not.toBeInTheDocument();
  });
});
