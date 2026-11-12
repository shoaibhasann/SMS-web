import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminAcademicSetupWorkspace } from "../components/admin/admin-academic-setup-workspace";
import { AdminDemoWorkspace } from "../components/admin/admin-demo-workspace";
import { AdminPeopleWorkspace } from "../components/admin/admin-people-workspace";
import { AdminAssessmentWorkspace } from "../components/admin/admin-assessment-workspace";
import { AdminFinanceWorkspace } from "../components/admin/admin-finance-workspace";
import { AdminNoticesWorkspace } from "../components/admin/admin-notices-workspace";

const clientMock = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: clientMock.create }));

type AuthResult = { data: { user: { id: string } }; error: null };
type Result = { data: unknown; error: null; count?: number };
type Read = { table: string; filters: Record<string, unknown>; single: boolean };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const auth = (id = "admin"): AuthResult => ({ data: { user: { id } }, error: null });
const result = (data: unknown): Result => ({ data, error: null, ...(Array.isArray(data) ? { count: data.length } : {}) });

function database(read: (request: Read) => Promise<Result>) {
  const calls: Read[] = [];
  const getUser = vi.fn(async () => auth());
  const from = vi.fn((table: string) => {
    const request: Read = { table, filters: {}, single: false };
    const query = {
      select() { return query; },
      eq(key: string, value: unknown) { request.filters[key] = value; return query; },
      in(key: string, value: unknown) { request.filters[key] = value; return query; },
      order() { return query; },
      range() { return query; },
      maybeSingle() { request.single = true; return query; },
      then<T = Result, U = never>(yes?: ((value: Result) => T | PromiseLike<T>) | null, no?: ((reason: unknown) => U | PromiseLike<U>) | null) {
        calls.push(request);
        return read(request).then(yes, no);
      },
    };
    return query;
  });
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ table: `rpc:${name}`, filters: { school_id: args.p_school_id }, single: false });
    if (name === "get_office_fee_ledger") return result({ academic_year_id: null, rows: [], summary: {
      demand_count: 0, invalid_count: 0, net_amount: "0.00", paid_amount: "0.00", balance: "0.00", opening_amount: "0.00",
    } });
    if (name === "list_office_fee_receipts") return result({ rows: [], count: 0 });
    if (name === "list_office_fee_changes") return result({ rows: [], total_count: 0 });
    if (name === "get_office_finance_summary") return result({ demand_count: 0, pending_count: 0, overdue_count: 0, invalid_count: 0,
      net_amount: "0.00", paid_amount: "0.00", balance: "0.00", opening_amount: "0.00",
      collections: { gross_amount: "0.00", reversal_amount: "0.00", net_amount: "0.00", today_gross: "0.00", today_reversal: "0.00", today_net: "0.00", month_gross: "0.00", month_reversal: "0.00", month_net: "0.00" } });
    throw new Error(`Unexpected loading RPC ${name}`);
  });
  const client = { auth: { getUser, onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) }, from, rpc };
  clientMock.create.mockReturnValue(client);
  return { client, calls, getUser, from };
}

beforeEach(() => { window.localStorage.clear(); });

it("reads academic setup only for the authorized school and ignores old browser demo data", async () => {
  window.localStorage.setItem("kids-corner-admin-demo:academics", JSON.stringify([
    { id: "demo-year", recordType: "Academic Year", name: "Stored demo year" },
  ]));
  const db = database(async ({ table }) => {
    if (table === "user_roles") return result([{ role: "school_admin", school_id: "school-a" }]);
    if (table === "schools") return result([{ id: "school-a", name: "School A" }]);
    if (table === "academic_years") return result([
      { id: "live-year", name: "Current school year", start_date: "2026-04-01", end_date: "2027-03-31", is_current: true },
    ]);
    return result([]);
  });
  expect(renderToString(<AdminAcademicSetupWorkspace userId="admin" />)).not.toContain("Stored demo year");
  render(<AdminAcademicSetupWorkspace userId="admin" />);
  expect(await screen.findByText("Current school year")).toBeInTheDocument();
  expect(screen.queryByText("Stored demo year")).not.toBeInTheDocument();
  expect(db.calls.filter(({ table }) => ["academic_years", "classes", "sections", "subjects"].includes(table)))
    .toHaveLength(4);
  expect(db.calls.filter(({ table }) => ["academic_years", "classes", "sections", "subjects"].includes(table))
    .every(({ filters }) => filters.school_id === "school-a")).toBe(true);
});

describe("browser demo snapshots", () => {
  it("resets module-specific filters when navigating between demo modules", async () => {
    window.localStorage.setItem("kids-corner-admin-demo:students", JSON.stringify([{ id: "pupil", name: "Saved pupil", status: "Active" }]));
    window.localStorage.setItem("kids-corner-admin-demo:inventory", JSON.stringify([{ id: "desk", name: "Saved desk", status: "In use" }]));
    const view = render(<AdminDemoWorkspace module="students" />);
    await screen.findByRole("cell", { name: "Saved pupil" });
    fireEvent.change(screen.getByPlaceholderText("Search students"), { target: { value: "pupil" } });
    view.rerender(<AdminDemoWorkspace module="inventory" />);
    expect(await screen.findByRole("cell", { name: "Saved desk" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search inventory")).toHaveValue("");
    expect(screen.queryByRole("cell", { name: "Saved pupil" })).not.toBeInTheDocument();
  });
});

const workspaces = [
  { name: "people", render: () => <AdminPeopleWorkspace mode="students" /> },
  { name: "assessments", render: () => <AdminAssessmentWorkspace mode="exams" /> },
  { name: "finance", render: () => <AdminFinanceWorkspace mode="fees" /> },
  { name: "notices", render: () => <AdminNoticesWorkspace /> },
];

describe("school-scoped asynchronous workspace reads", () => {
  it.each(workspaces)("$name ignores superseded auth responses and reads only the current school", async (workspace) => {
    const oldAuth = deferred<AuthResult>();
    const db = database(async (request) => request.table === "user_roles"
      ? result([{ role: "school_admin", school_id: request.filters.user_id === "new-admin" ? "school-b" : "school-a" }])
      : request.table === "schools" ? result([{ id: "school-b", name: "School B" }])
        : result(request.single ? null : []));
    db.getUser.mockImplementationOnce(() => oldAuth.promise).mockResolvedValue(auth("new-admin"));
    render(workspace.render());
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(db.calls.some((request) => request.filters.school_id === "school-b")).toBe(true));
    await act(async () => { oldAuth.resolve(auth("old-admin")); await oldAuth.promise; });
    expect(db.calls.filter((request) => request.table === "user_roles").map((request) => request.filters.user_id)).toEqual(["new-admin"]);
    expect(db.calls.filter((request) => request.filters.school_id).every((request) => request.filters.school_id === "school-b")).toBe(true);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(workspaces)("$name stops an unmounted auth request before issuing school queries", async (workspace) => {
    const pending = deferred<AuthResult>();
    const db = database(async () => result([]));
    db.getUser.mockReturnValue(pending.promise);
    const view = render(workspace.render());
    view.unmount();
    await act(async () => { pending.resolve(auth()); await pending.promise; });
    expect(db.from).not.toHaveBeenCalled();
  });

  it("keeps a newer directory refresh when an earlier query completes late", async () => {
    const old = deferred<Result>(); let requests = 0;
    const pupil = (name: string) => ({ id: name, admission_no: `ADM-${name}`, first_name: name, middle_name: null, last_name: null, roll_no: null, status: "active" });
    const db = database(async (request) => {
      if (request.table === "user_roles") return result([{ role: "school_admin", school_id: "school-a" }]);
      if (request.table === "students") return ++requests === 1 ? old.promise : result([pupil("Latest pupil")]);
      return result([]);
    });
    render(<AdminPeopleWorkspace mode="students" />);
    await waitFor(() => expect(db.calls.some((request) => request.table === "students")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Latest pupil");
    await act(async () => { old.resolve(result([pupil("Stale pupil")])); await old.promise; });
    expect(screen.getByText("Latest pupil")).toBeInTheDocument();
    expect(screen.queryByText("Stale pupil")).not.toBeInTheDocument();
  });

  it("does not show a pending students response in the teachers directory", async () => {
    const old = deferred<Result>();
    const db = database(async (request) => {
      if (request.table === "user_roles") return result([{ role: "school_admin", school_id: "school-a" }]);
      if (request.table === "students") return old.promise;
      return result(request.single ? null : []);
    });
    const view = render(<AdminPeopleWorkspace mode="students" />);
    await waitFor(() => expect(db.calls.some((request) => request.table === "students")).toBe(true));
    view.rerender(<AdminPeopleWorkspace mode="teachers" />);
    await screen.findByText("No teachers & staff found for this school.");
    await act(async () => { old.resolve(result([{ id: "old", first_name: "Old pupil", status: "active" }])); await old.promise; });
    expect(screen.queryByText("Old pupil")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Teachers & Staff" })).toBeInTheDocument();
  });

  it("does not query assignments with an empty year when no current academic year exists", async () => {
    const db = database(async (request) => {
      if (request.table === "user_roles") return result([{ role: "school_admin", school_id: "school-a" }]);
      if (request.table === "teachers") return result([{ id: "teacher", full_name: "Local teacher", employee_id: "T1" }]);
      return result(request.single ? null : []);
    });
    render(<AdminPeopleWorkspace mode="teachers" />);
    expect(await screen.findByText("No current-year assignments")).toBeInTheDocument();
    expect(db.calls.some((request) => request.table === "teacher_subject_assignments")).toBe(false);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the selected assessment roster when an earlier roster completes late", async () => {
    const oldRoster = deferred<Result>();
    const assessment = (id: string) => ({ id, school_id: "school-a", academic_year_id: "year", class_id: id, section_id: null, subject_id: "subject", teacher_id: "teacher", name: `Exam ${id}`, assessment_date: "2026-11-02", maximum_marks: 100, description: null, status: "scheduled", updated_at: "2026-11-02T09:00:00Z" });
    const db = database(async (request) => {
      if (request.table === "user_roles") return result([{ role: "school_admin", school_id: "school-a" }]);
      if (request.table === "schools") return result([{ id: "school-a", name: "School A" }]);
      if (request.table === "teacher_assessments") return result([assessment("A"), assessment("B")].filter((row) => !request.filters.id || request.filters.id === row.id));
      if (request.table === "enrollments") return request.filters.class_id === "A" ? oldRoster.promise : result([{ id: "enrollment-b", student_id: "pupil-b", roll_no: "1" }]);
      if (request.table === "students") return result([{ id: "pupil-b", first_name: "Selected roster pupil", admission_no: "ADM-B", roll_no: "1" }]);
      return result([]);
    });
    render(<AdminAssessmentWorkspace mode="exams" />);
    fireEvent.click(await screen.findByRole("button", { name: "Manage marks for Exam A" }));
    await waitFor(() => expect(db.calls.some((request) => request.table === "enrollments" && request.filters.class_id === "A")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Manage marks for Exam B" }));
    await screen.findByRole("spinbutton", { name: "Marks for Selected roster pupil" });
    await act(async () => { oldRoster.resolve(result([{ id: "old-enrollment", student_id: "stale-pupil", roll_no: "2" }])); await oldRoster.promise; });
    expect(screen.getByRole("heading", { name: "Marks · Exam B" })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Marks for Selected roster pupil" })).toBeInTheDocument();
    expect(db.calls.filter((request) => request.table === "students").map((request) => request.filters.id)).toEqual([["pupil-b"]]);
  });
});
