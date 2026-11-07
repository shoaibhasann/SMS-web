import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ModulePage from "../app/(dashboard)/modules/[module]/page";
import { canAccessModule, getAdminNavigationModules, getTeacherNavigationModules, getVisibleModules } from "../lib/modules";

const { getUser, readRoles, readProfile, onAuthStateChange, auditRender, replace, routeSecurity } = vi.hoisted(() => ({
  getUser: vi.fn(), readRoles: vi.fn(), readProfile: vi.fn(), onAuthStateChange: vi.fn(), auditRender: vi.fn(), replace: vi.fn(), routeSecurity: vi.fn(),
}));
const routeRouter = { push: vi.fn(), replace };
vi.mock("@/lib/auth/staff-mfa", async (original) => ({ ...await original<typeof import("@/lib/auth/staff-mfa")>(), readStaffMfaStatus: routeSecurity }));

let currentModule: string;
let searchParams: URLSearchParams;

vi.mock("next/navigation", () => ({
  useParams: () => ({ module: currentModule }),
  useSearchParams: () => searchParams,
  useRouter: () => routeRouter,
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getUser, onAuthStateChange },
    from: (table: string) => ({ select: () => ({ eq: (...args: unknown[]) => table === "profiles"
      ? { maybeSingle: () => readProfile(...args) }
      : Promise.resolve(readRoles(...args)).then((result) => ({ ...result, data: result.data?.map((row: { role: string; school_id?: string | null }) => ({
        ...row, school_id: "school_id" in row ? row.school_id : row.role === "super_admin" ? null : "school",
      })) })) }) }),
  }),
}));
vi.mock("@/components/layout/app-shell", () => ({
  AppShell: ({ role, children }: { role: string; children: ReactNode }) => (
    <main aria-label={`${role} shell`}>{children}</main>
  ),
}));
vi.mock("@/components/academic/teaching-assignment-manager", () => ({
  TeachingAssignmentManager: () => <section aria-label="Teaching assignment workspace" />,
}));
vi.mock("@/components/academic/substitute-coverage-workspace", () => ({
  SubstituteCoverageWorkspace: ({ userId }: { userId: string }) => <section aria-label="Substitute attendance workspace">{userId}</section>,
}));
vi.mock("@/components/finance/advance-credit-workspace", () => ({
  AdvanceCreditWorkspace: ({ userId }: { userId: string }) => <section aria-label="Office advance credit">{userId}</section>,
}));
vi.mock("@/components/finance/family-advance-credit", () => ({
  FamilyAdvanceCredit: ({ userId, role }: { userId: string; role: string }) => <section aria-label="Family advance credit">{role} {userId}</section>,
}));
vi.mock("@/components/finance/family-receipts", () => ({
  FamilyReceipts: ({ userId, role }: { userId: string; role: string }) => <section aria-label="Family receipts">{role} {userId}</section>,
}));
vi.mock("@/components/admin/admin-finance-workspace", () => ({
  AdminFinanceWorkspace: () => <section aria-label="Office finance workspace" />,
}));
vi.mock("@/components/admin/audit-history-workspace", () => ({
  AuditHistoryWorkspace: ({ userId }: { userId: string }) => {
    auditRender(userId);
    return <section aria-label="School audit history">{userId}</section>;
  },
}));
vi.mock("@/components/admin/school-settings-workspace", () => ({
  SchoolSettingsWorkspace: ({ userId }: { userId: string }) => <section aria-label="Real school settings">{userId}</section>,
}));
vi.mock("@/components/admin/official-attendance-reports", () => ({
  OfficialAttendanceReports: ({ userId, role }: { userId: string; role: string }) => <section aria-label="Official office attendance reports">{role} {userId}</section>,
}));
vi.mock("@/components/admin/parent-directory-workspace", () => ({
  ParentDirectoryWorkspace: ({ userId }: { userId: string }) => <section aria-label="Real parent directory">{userId}</section>,
}));
vi.mock("@/components/admin/student-roster-workspace", () => ({
  StudentRosterWorkspace: ({ userId, view }: { userId: string; view: string }) => <section aria-label="Real student enrollment">{userId} {view}</section>,
}));
vi.mock("@/components/family/student-leave-workspace", () => ({
  StudentLeaveWorkspace: ({ userId, role }: { userId: string; role: string }) => <section aria-label="Student leave workspace">{role} {userId}</section>,
}));
vi.mock("@/components/academic/result-publication-workspace", () => ({
  ResultPublicationWorkspace: ({ userId, role }: { userId: string; role: string }) => <section aria-label="Result publication workspace">{role} {userId}</section>,
}));
vi.mock("@/components/teacher/teacher-views", () => ({
  TeacherModuleView: ({ module }: { module: string }) => <section aria-label="Teacher raw assessment workspace">{module}</section>,
}));
vi.mock("@/components/admin/admin-assessment-workspace", () => ({
  AdminAssessmentWorkspace: ({ mode }: { mode: string }) => <section aria-label="Admin raw assessment workspace">{mode}</section>,
}));
vi.mock("@/components/academic/timetable-workspace", () => ({
  TimetableWorkspace: ({ userId, role }: { userId: string; role: string }) => <section aria-label="Timetable workspace">{role} {userId}</section>,
}));

vi.mock("@/components/academic/family-attendance-register", () => ({
  FamilyAttendanceRegister: ({ role, initialChildId }: { role: string; initialChildId?: string }) => (
    <section aria-label="Family attendance register">{role} {initialChildId}</section>
  ),
}));
vi.mock("@/components/academic/teacher-attendance-register", () => ({
  TeacherAttendanceRegister: () => <section aria-label="Teacher attendance register" />,
}));
vi.mock("@/components/academic/academic-workspace", () => ({
  AcademicWorkspace: ({ module }: { module: string }) => <section aria-label={`Academic workspace ${module}`} />,
}));
vi.mock("@/components/family/guardian-contact-settings", () => ({
  GuardianContactSettings: ({ userId, callbackStatus }: { userId: string; callbackStatus: string | null }) => (
    <section aria-label="Guardian contact settings">{userId} {callbackStatus}</section>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  routeSecurity.mockImplementation(async () => ({ user_id: (await getUser()).data.user?.id ?? "actor", allowed: true }));
  currentModule = "teacher-assignments";
  searchParams = new URLSearchParams();
  getUser.mockResolvedValue({ data: { user: { id: "actor" } }, error: null });
  readProfile.mockResolvedValue({ data: { is_active: true, school_id: "school" }, error: null });
  onAuthStateChange.mockReset().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  readRoles.mockResolvedValue({ data: [{ role: "school_admin" }], error: null });
});

describe("real office routes", () => {
  it.each(["school_admin", "principal", "super_admin"])("opens Parents and Admissions for %s without a demo fallback", async (role) => {
    currentModule = "parents"; readRoles.mockResolvedValue({ data: [{ role }], error: null });
    const page = render(<ModulePage />);
    expect(await screen.findByRole("region", { name: "Real parent directory" })).toHaveTextContent("actor");
    page.unmount(); currentModule = "admissions"; render(<ModulePage />);
    expect(await screen.findByRole("region", { name: "Real student enrollment" })).toHaveTextContent("actor admissions");
    expect(screen.queryByText("This module is ready for its dedicated management screen.")).not.toBeInTheDocument();
  });
  it.each(["teacher", "accountant", "reception_staff", "student", "parent"])("denies %s the office directory and admissions before mounting", async (role) => {
    readRoles.mockResolvedValue({ data: [{ role }], error: null }); currentModule = "parents";
    const page = render(<ModulePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/does not allow|No recognized role/);
    expect(screen.queryByRole("region", { name: "Real parent directory" })).not.toBeInTheDocument();
    page.unmount(); currentModule = "admissions"; render(<ModulePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/does not allow|No recognized role/);
    expect(screen.queryByRole("region", { name: "Real student enrollment" })).not.toBeInTheDocument();
  });
});

describe("real school settings route", () => {
  it("blocks a mixed-role guardian view behind the same account MFA challenge before protected reads", async () => {
    currentModule = "attendance"; searchParams.set("view", "guardian"); searchParams.set("child", "own-child");
    routeSecurity.mockResolvedValueOnce({ user_id: "actor", allowed: false, required: true, action: "challenge" });
    render(<ModulePage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/mfa?next=%2Fmodules%2Fattendance%3Fview%3Dguardian%26child%3Down-child"));
    expect(readProfile).not.toHaveBeenCalled(); expect(readRoles).not.toHaveBeenCalled();
  });
  it.each(["school_admin", "principal", "super_admin"])("opens real school settings for %s", async (role) => {
    currentModule = "settings"; readRoles.mockResolvedValue({ data: [{ role }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("region", { name: "Real school settings" })).toHaveTextContent("actor");
    expect(screen.queryByText("This module is ready for its dedicated management screen.")).not.toBeInTheDocument();
  });
  it.each(["teacher", "accountant", "reception_staff", "student", "parent"])("denies %s before mounting settings", async (role) => {
    currentModule = "settings"; readRoles.mockResolvedValue({ data: [{ role }], error: null }); render(<ModulePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/does not allow|No recognized role/);
    expect(screen.queryByRole("region", { name: "Real school settings" })).not.toBeInTheDocument();
  });
});

describe("official office attendance report route", () => {
  it.each(["school_admin", "principal"])("opens the verified report workspace for %s", async (role) => {
    currentModule = "reports"; readRoles.mockResolvedValue({ data: [{ role }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("region", { name: "Official office attendance reports" })).toHaveTextContent(`${role === "school_admin" ? "admin" : role} actor`);
  });
  it.each(["teacher", "accountant", "reception_staff", "student", "parent"])("does not mount the office reader for %s", async (role) => {
    currentModule = "reports"; readRoles.mockResolvedValue({ data: [{ role }], error: null });
    render(<ModulePage />);
    if (role === "accountant") expect(await screen.findByRole("heading", { name: /^Reports$/ })).toBeInTheDocument();
    else expect(await screen.findByRole("alert")).toHaveTextContent("Your role does not allow access");
    expect(screen.queryByRole("region", { name: "Official office attendance reports" })).not.toBeInTheDocument();
  });
});

describe("school audit route", () => {
  it.each(["school_admin", "principal", "super_admin"])("opens real read-only history for %s", async (role) => {
    currentModule = "audit-logs";
    readRoles.mockResolvedValue({ data: [{ role }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("region", { name: "School audit history" })).toHaveTextContent("actor");
    expect(auditRender).toHaveBeenCalledWith("actor");
    expect(screen.queryByRole("button", { name: /add|edit|delete/i })).not.toBeInTheDocument();
  });

  it.each(["teacher", "accountant", "reception_staff", "student", "parent"])("denies %s before mounting any audit reader", async (role) => {
    currentModule = "audit-logs";
    readRoles.mockResolvedValue({ data: [{ role }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/does not allow|No recognized role/);
    expect(auditRender).not.toHaveBeenCalled();
  });
});

describe("verified module authority", () => {
  beforeEach(() => { currentModule = "advance-credit"; });

  it.each([false, null])("blocks an inactive or missing profile before mounting office data (%s)", async (active) => {
    readProfile.mockResolvedValue({ data: active === null ? null : { is_active: active, school_id: "school" }, error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("inactive or unavailable");
    expect(screen.queryByRole("region", { name: "Office advance credit" })).not.toBeInTheDocument();
  });

  it.each([
    { role: "school_admin", school_id: null },
    { role: "super_admin", school_id: "school" },
  ])("does not treat malformed role scope as authority ($role / $school_id)", async (row) => {
    readRoles.mockResolvedValue({ data: [row], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("No recognized role");
    expect(screen.queryByRole("region", { name: "Office advance credit" })).not.toBeInTheDocument();
  });

  it("requires the guardian role in the linked profile's actual school", async () => {
    searchParams.set("view", "guardian");
    readRoles.mockResolvedValue({ data: [{ role: "parent", school_id: "other-school" }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("linked guardian account");
    expect(screen.queryByRole("region", { name: "Family advance credit" })).not.toBeInTheDocument();
  });

  it("removes privileged content when a role is revoked before a focus recheck", async () => {
    render(<ModulePage />);
    await screen.findByRole("region", { name: "Office advance credit" });
    readRoles.mockResolvedValue({ data: [{ role: "teacher" }], error: null });
    fireEvent.focus(window);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your role does not allow access");
    expect(screen.queryByRole("region", { name: "Office advance credit" })).not.toBeInTheDocument();
  });

  it("keeps the existing workspace mounted when the same authority is reverified", async () => {
    render(<ModulePage />);
    const office = await screen.findByRole("region", { name: "Office advance credit" });
    fireEvent.focus(window);
    await waitFor(() => expect(readRoles).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("region", { name: "Office advance credit" })).toBe(office);
  });

  it("removes office content when a disabled account returns to a visible tab", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    try {
      render(<ModulePage />);
      await screen.findByRole("region", { name: "Office advance credit" });
      readProfile.mockResolvedValue({ data: { is_active: false, school_id: "school" }, error: null });
      fireEvent(document, new Event("visibilitychange"));
      expect(await screen.findByRole("alert")).toHaveTextContent("inactive or unavailable");
      expect(screen.queryByRole("region", { name: "Office advance credit" })).not.toBeInTheDocument();
    } finally { visibility.mockRestore(); }
  });

  it("clears old privileged content on account change and ignores a late old-role response", async () => {
    let finishOld!: (value: unknown) => void;
    const oldRead = new Promise((resolve) => { finishOld = resolve; });
    render(<ModulePage />);
    await screen.findByRole("region", { name: "Office advance credit" });
    readRoles.mockReturnValueOnce(oldRead);
    fireEvent.focus(window);
    await waitFor(() => expect(readRoles).toHaveBeenCalledTimes(2));
    getUser.mockResolvedValue({ data: { user: { id: "new-account" } }, error: null });
    readRoles.mockResolvedValue({ data: [{ role: "teacher" }], error: null });
    act(() => onAuthStateChange.mock.calls[0][0]("SIGNED_IN", { user: { id: "new-account" } }));
    expect(screen.queryByRole("region", { name: "Office advance credit" })).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Your role does not allow access");
    await act(async () => { finishOld({ data: [{ role: "school_admin" }], error: null }); await oldRead; });
    expect(screen.queryByRole("region", { name: "Office advance credit" })).not.toBeInTheDocument();
  });

  it("clears office content immediately on sign-out and removes listeners on unmount", async () => {
    const mounted = render(<ModulePage />);
    await screen.findByRole("region", { name: "Office advance credit" });
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    act(() => onAuthStateChange.mock.calls[0][0]("SIGNED_OUT", null));
    expect(screen.queryByRole("region", { name: "Office advance credit" })).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Please sign in");
    mounted.unmount();
    const calls = getUser.mock.calls.length;
    fireEvent.focus(window);
    await act(async () => {
      onAuthStateChange.mock.calls[0][0]("SIGNED_IN", { user: { id: "new-account" } });
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(getUser).toHaveBeenCalledTimes(calls);
    expect(onAuthStateChange.mock.results[0].value.data.subscription.unsubscribe).toHaveBeenCalledOnce();
  });
});

describe("advance-credit module access", () => {
  beforeEach(() => { currentModule = "advance-credit"; });

  it.each([["school_admin", "admin"], ["principal", "principal"], ["accountant", "finance"]])("routes %s to the dedicated office credit workspace", async (dbRole, uiRole) => {
    readRoles.mockResolvedValue({ data: [{ role: dbRole }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("region", { name: "Office advance credit" })).toHaveTextContent("actor");
    expect(screen.getByRole("main", { name: `${uiRole} shell` })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Family advance credit" })).not.toBeInTheDocument();
  });

  it.each(["student", "parent"])("routes %s to the read-only family credit view", async (role) => {
    readRoles.mockResolvedValue({ data: [{ role }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("region", { name: "Family advance credit" })).toHaveTextContent(`${role} actor`);
    expect(screen.queryByRole("region", { name: "Office advance credit" })).not.toBeInTheDocument();
  });

  it("uses guardian scope for a parent who is also a school administrator", async () => {
    searchParams.set("view", "guardian");
    readRoles.mockResolvedValue({ data: [{ role: "school_admin" }, { role: "parent" }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("region", { name: "Family advance credit" })).toHaveTextContent("parent actor");
    expect(screen.queryByRole("region", { name: "Office advance credit" })).not.toBeInTheDocument();
  });

  it.each(["teacher", "reception_staff"])("denies credit access to %s", async (role) => {
    readRoles.mockResolvedValue({ data: [{ role }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your role does not allow access");
    expect(screen.queryByRole("region", { name: "Office advance credit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Family advance credit" })).not.toBeInTheDocument();
  });

  it("keeps navigation consistent with office/family permissions", () => {
    for (const role of ["admin", "principal", "finance", "student", "parent"] as const) {
      expect(canAccessModule(role, "advance-credit")).toBe(true);
      expect(getVisibleModules(role).some((module) => module.key === "advance-credit")).toBe(true);
    }
    for (const role of ["teacher", "reception"] as const) {
      expect(canAccessModule(role, "advance-credit")).toBe(false);
      expect(getVisibleModules(role).some((module) => module.key === "advance-credit")).toBe(false);
    }
  });
});

describe("guardian receipts route", () => {
  beforeEach(() => { currentModule = "invoices"; });

  it.each(["teacher", "school_admin", "accountant"])("uses explicit guardian scope for a parent who is also %s", async (role) => {
    searchParams.set("view", "guardian");
    readRoles.mockResolvedValue({ data: [{ role }, { role: "parent" }], error: null });
    render(<ModulePage />);
    const receipts = await screen.findByRole("region", { name: "Family receipts" });
    expect(receipts).toHaveTextContent("parent actor");
    expect(screen.getByRole("main", { name: "parent shell" })).toContainElement(receipts);
    expect(screen.queryByRole("region", { name: "Office finance workspace" })).not.toBeInTheDocument();
  });

  it.each(["teacher", "student", "school_admin"])("requires a verified parent role when %s requests guardian receipts", async (role) => {
    searchParams.set("view", "guardian");
    readRoles.mockResolvedValue({ data: [{ role }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("requires a linked guardian account");
    expect(screen.queryByRole("region", { name: "Family receipts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Office finance workspace" })).not.toBeInTheDocument();
  });

  it("does not grant a teacher staff receipt access when a parent role is also present", async () => {
    readRoles.mockResolvedValue({ data: [{ role: "parent" }, { role: "teacher" }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your role does not allow access");
    expect(screen.queryByRole("region", { name: "Family receipts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Office finance workspace" })).not.toBeInTheDocument();
    expect(canAccessModule("teacher", "invoices")).toBe(false);
    expect(getVisibleModules("teacher").some((module) => module.key === "invoices")).toBe(false);
  });

  it("retains the default office receipt workspace for an administrator with a parent role", async () => {
    readRoles.mockResolvedValue({ data: [{ role: "parent" }, { role: "school_admin" }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("region", { name: "Office finance workspace" })).toBeInTheDocument();
    expect(screen.getByRole("main", { name: "admin shell" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Family receipts" })).not.toBeInTheDocument();
  });
});

describe("student leave request route", () => {
  beforeEach(() => { currentModule = "student-leave"; });

  it.each([
    ["student", "student"], ["parent", "parent"], ["school_admin", "admin"], ["super_admin", "admin"], ["principal", "principal"],
  ])("opens the leave workspace with verified %s scope", async (dbRole, uiRole) => {
    readRoles.mockResolvedValue({ data: [{ role: dbRole }], error: null });
    render(<ModulePage />);
    const workspace = await screen.findByRole("region", { name: "Student leave workspace" });
    expect(workspace).toHaveTextContent(`${uiRole} actor`);
    expect(screen.getByRole("main", { name: `${uiRole} shell` })).toContainElement(workspace);
  });

  it.each(["teacher", "accountant", "reception_staff"])("denies %s access to student leave requests", async (role) => {
    readRoles.mockResolvedValue({ data: [{ role }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your role does not allow access");
    expect(screen.queryByRole("region", { name: "Student leave workspace" })).not.toBeInTheDocument();
  });

  it.each(["teacher", "school_admin"])("opens family leave requests for a mixed %s and guardian account only in explicit guardian view", async (role) => {
    searchParams.set("view", "guardian");
    readRoles.mockResolvedValue({ data: [{ role }, { role: "parent" }], error: null });
    render(<ModulePage />);
    const workspace = await screen.findByRole("region", { name: "Student leave workspace" });
    expect(workspace).toHaveTextContent("parent actor");
    expect(screen.getByRole("main", { name: "parent shell" })).toContainElement(workspace);
  });

  it("does not turn a mixed teacher and guardian account into a leave reviewer by default", async () => {
    readRoles.mockResolvedValue({ data: [{ role: "teacher" }, { role: "parent" }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your role does not allow access");
    expect(screen.queryByRole("region", { name: "Student leave workspace" })).not.toBeInTheDocument();
  });

  it("keeps the office leave review scope by default for a mixed administrator and guardian account", async () => {
    readRoles.mockResolvedValue({ data: [{ role: "parent" }, { role: "school_admin" }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("region", { name: "Student leave workspace" })).toHaveTextContent("admin actor");
    expect(screen.queryByRole("main", { name: "parent shell" })).not.toBeInTheDocument();
  });

  it("requires the parent role for the explicit guardian leave view", async () => {
    searchParams.set("view", "guardian");
    readRoles.mockResolvedValue({ data: [{ role: "school_admin" }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("requires a linked guardian account");
    expect(screen.queryByRole("region", { name: "Student leave workspace" })).not.toBeInTheDocument();
  });

  it("keeps family and office leave navigation aligned with permissions while retaining staff leave", () => {
    for (const role of ["admin", "principal", "student", "parent"] as const) {
      expect(canAccessModule(role, "student-leave")).toBe(true);
      expect(getVisibleModules(role).some((module) => module.key === "student-leave" && module.label === "Leave requests")).toBe(true);
    }
    for (const role of ["teacher", "finance", "reception"] as const) {
      expect(canAccessModule(role, "student-leave")).toBe(false);
      expect(getVisibleModules(role).some((module) => module.key === "student-leave")).toBe(false);
    }
    expect(getAdminNavigationModules().some((module) => module.key === "student-leave")).toBe(true);
    expect(getAdminNavigationModules().some((module) => module.key === "leave")).toBe(true);
  });
});

describe("timetable route", () => {
  beforeEach(() => { currentModule = "timetable"; });

  it.each([
    ["school_admin", "admin"], ["super_admin", "admin"], ["principal", "principal"],
    ["teacher", "teacher"], ["student", "student"], ["parent", "parent"],
  ])("opens the real timetable workspace in the verified %s scope", async (dbRole, uiRole) => {
    readRoles.mockResolvedValue({ data: [{ role: dbRole }], error: null });
    render(<ModulePage />);
    const workspace = await screen.findByRole("region", { name: "Timetable workspace" });
    expect(workspace).toHaveTextContent(`${uiRole} actor`);
    expect(screen.getByRole("main", { name: `${uiRole} shell` })).toContainElement(workspace);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["accountant", "reception_staff"])("does not expose timetable editing to %s", async (role) => {
    readRoles.mockResolvedValue({ data: [{ role }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your role does not allow access");
    expect(screen.queryByRole("region", { name: "Timetable workspace" })).not.toBeInTheDocument();
  });

  it.each(["teacher", "school_admin", "accountant"])("preserves explicit family scope for a mixed %s and guardian login", async (role) => {
    searchParams.set("view", "guardian");
    readRoles.mockResolvedValue({ data: [{ role }, { role: "parent" }], error: null });
    render(<ModulePage />);
    const workspace = await screen.findByRole("region", { name: "Timetable workspace" });
    expect(workspace).toHaveTextContent("parent actor");
    expect(screen.getByRole("main", { name: "parent shell" })).toContainElement(workspace);
    expect(screen.queryByRole("main", { name: "teacher shell" })).not.toBeInTheDocument();
    expect(screen.queryByRole("main", { name: "admin shell" })).not.toBeInTheDocument();
  });

  it.each(["teacher", "student", "school_admin"])("requires the parent role when %s requests guardian timetable", async (role) => {
    searchParams.set("view", "guardian");
    readRoles.mockResolvedValue({ data: [{ role }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("requires a linked guardian account");
    expect(screen.queryByRole("region", { name: "Timetable workspace" })).not.toBeInTheDocument();
  });

  it("keeps a mixed teacher and guardian on their own teacher schedule by default", async () => {
    readRoles.mockResolvedValue({ data: [{ role: "parent" }, { role: "teacher" }], error: null });
    render(<ModulePage />);
    const workspace = await screen.findByRole("region", { name: "Timetable workspace" });
    expect(workspace).toHaveTextContent("teacher actor");
    expect(screen.getByRole("main", { name: "teacher shell" })).toContainElement(workspace);
    expect(screen.queryByRole("main", { name: "parent shell" })).not.toBeInTheDocument();
  });

  it("keeps timetable navigation aligned with the office and read-only role routes", () => {
    for (const role of ["admin", "principal", "teacher", "student", "parent"] as const) {
      expect(canAccessModule(role, "timetable")).toBe(true);
      expect(getVisibleModules(role).some((module) => module.key === "timetable")).toBe(true);
    }
    for (const role of ["finance", "reception"] as const) {
      expect(canAccessModule(role, "timetable")).toBe(false);
      expect(getVisibleModules(role).some((module) => module.key === "timetable")).toBe(false);
    }
    expect(getAdminNavigationModules().some((module) => module.key === "timetable")).toBe(true);
    expect(getTeacherNavigationModules().some((module) => module.key === "timetable")).toBe(true);
  });
});

describe("teaching assignment route", () => {
  it.each([
    ["school_admin", "admin"],
    ["principal", "principal"],
    ["teacher", "teacher"],
  ])("opens the shared workspace in the %s caller's shell", async (dbRole, uiRole) => {
    readRoles.mockResolvedValue({ data: [{ role: dbRole }], error: null });
    render(<ModulePage />);
    await screen.findByRole("region", { name: "Teaching assignment workspace" });
    expect(screen.getByRole("main", { name: `${uiRole} shell` })).toBeInTheDocument();
    if (uiRole === "teacher") expect(screen.queryByRole("region", { name: "Substitute attendance workspace" })).not.toBeInTheDocument();
    else expect(screen.getByRole("region", { name: "Substitute attendance workspace" })).toHaveTextContent("actor");
    expect(readRoles).toHaveBeenCalledWith("user_id", "actor");
  });

  it("keeps parents outside the assignment-management route", async () => {
    readRoles.mockResolvedValue({ data: [{ role: "parent" }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your role does not allow access");
    expect(screen.queryByRole("region", { name: "Teaching assignment workspace" })).not.toBeInTheDocument();
  });

  it("fails closed when roles cannot be verified", async () => {
    readRoles.mockResolvedValue({ data: null, error: new Error("Role lookup unavailable") });
    render(<ModulePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Role lookup unavailable");
    expect(screen.queryByRole("region", { name: "Teaching assignment workspace" })).not.toBeInTheDocument();
  });
});

describe("academic authoring entry routes", () => {
  it.each(["class-logs", "study-material"])("opens %s for a verified teacher", async (moduleName) => {
    currentModule = moduleName;
    readRoles.mockResolvedValue({ data: [{ role: "teacher" }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("region", { name: `Academic workspace ${moduleName}` })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    ["accountant", "class-logs"], ["accountant", "study-material"],
    ["reception_staff", "class-logs"], ["reception_staff", "study-material"],
  ])("denies %s access to %s", async (dbRole, moduleName) => {
    currentModule = moduleName;
    readRoles.mockResolvedValue({ data: [{ role: dbRole }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your role does not allow access");
    expect(screen.queryByRole("region", { name: `Academic workspace ${moduleName}` })).not.toBeInTheDocument();
  });

  it("keeps teacher navigation and route permissions consistent without exposing these tools to office roles", () => {
    for (const key of ["class-logs", "study-material"]) {
      expect(getTeacherNavigationModules().some((module) => module.key === key)).toBe(true);
      expect(getVisibleModules("teacher").some((module) => module.key === key)).toBe(true);
      expect(canAccessModule("teacher", key)).toBe(true);
      for (const role of ["finance", "reception"] as const) {
        expect(canAccessModule(role, key)).toBe(false);
        expect(getVisibleModules(role).some((module) => module.key === key)).toBe(false);
      }
    }
  });
});

describe("guardian attendance route", () => {
  beforeEach(() => {
    currentModule = "attendance";
  });

  it("opens guardian attendance for a parent who is also a teacher", async () => {
    searchParams.set("view", "guardian");
    searchParams.set("child", "requested-child");
    readRoles.mockResolvedValue({ data: [{ role: "teacher" }, { role: "parent" }], error: null });

    render(<ModulePage />);
    const register = await screen.findByRole("region", { name: "Family attendance register" });
    expect(register).toHaveTextContent("parent requested-child");
    expect(screen.getByRole("main", { name: "parent shell" })).toContainElement(register);
    expect(screen.queryByRole("region", { name: "Teacher attendance register" })).not.toBeInTheDocument();
  });

  it("requires a verified parent role for the guardian view", async () => {
    searchParams.set("view", "guardian");
    readRoles.mockResolvedValue({ data: [{ role: "teacher" }], error: null });

    render(<ModulePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("requires a linked guardian account");
    expect(screen.queryByRole("region", { name: "Family attendance register" })).not.toBeInTheDocument();
  });

  it("keeps the main staff role when the parent role is returned first", async () => {
    readRoles.mockResolvedValue({ data: [{ role: "parent" }, { role: "accountant" }], error: null });

    render(<ModulePage />);
    expect(await screen.findByRole("main", { name: "finance shell" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Family attendance register" })).not.toBeInTheDocument();
  });

  it("keeps the teacher register as the default for the same mixed-role account", async () => {
    readRoles.mockResolvedValue({ data: [{ role: "teacher" }, { role: "parent" }], error: null });

    render(<ModulePage />);
    expect(await screen.findByRole("region", { name: "Teacher attendance register" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Family attendance register" })).not.toBeInTheDocument();
  });
});

describe("guardian contact route", () => {
  beforeEach(() => {
    currentModule = "profile";
  });

  it("opens Profile for a guardian and passes callback context to that same account", async () => {
    searchParams.set("contact", "email-returned");
    readRoles.mockResolvedValue({ data: [{ role: "parent" }], error: null });
    render(<ModulePage />);
    const profile = await screen.findByRole("region", { name: "Guardian contact settings" });
    expect(profile).toHaveTextContent("actor email-returned");
    expect(screen.getByRole("main", { name: "parent shell" })).toContainElement(profile);
  });

  it("supports a guardian with a teaching role through the scoped Profile link", async () => {
    searchParams.set("view", "guardian");
    readRoles.mockResolvedValue({ data: [{ role: "teacher" }, { role: "parent" }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("region", { name: "Guardian contact settings" })).toHaveTextContent("actor");
  });

  it("blocks a non-guardian from using the scoped Profile link", async () => {
    searchParams.set("view", "guardian");
    readRoles.mockResolvedValue({ data: [{ role: "student" }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("requires a linked guardian account");
    expect(screen.queryByRole("region", { name: "Guardian contact settings" })).not.toBeInTheDocument();
  });
});


describe("published assessment result routes", () => {
  beforeEach(() => { currentModule = "published-results"; });

  it.each([["school_admin", "admin"], ["super_admin", "admin"], ["principal", "principal"], ["teacher", "teacher"], ["parent", "parent"], ["student", "student"]])("routes %s to the checked publication workspace", async (dbRole, role) => {
    readRoles.mockResolvedValue({ data: [{ role: dbRole }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("region", { name: "Result publication workspace" })).toHaveTextContent(`${role} actor`);
    expect(screen.getByRole("main", { name: `${role} shell` })).toBeInTheDocument();
  });

  it.each(["accountant", "reception_staff"])("does not give %s publication access", async (role) => {
    readRoles.mockResolvedValue({ data: [{ role }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your role does not allow access");
    expect(screen.queryByRole("region", { name: "Result publication workspace" })).not.toBeInTheDocument();
  });

  it.each([["student", "results"], ["parent", "results"], ["student", "result-report"], ["parent", "result-report"]])("routes %s legacy %s to published-only family results", async (role, module) => {
    currentModule = module;
    readRoles.mockResolvedValue({ data: [{ role }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("region", { name: "Result publication workspace" })).toHaveTextContent(`${role} actor`);
    expect(screen.queryByRole("region", { name: "Admin raw assessment workspace" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Teacher raw assessment workspace" })).not.toBeInTheDocument();
  });

  it.each(["results", "result-report", "published-results"])("preserves explicit mixed guardian scope for %s", async (module) => {
    currentModule = module; searchParams.set("view", "guardian");
    readRoles.mockResolvedValue({ data: [{ role: "teacher" }, { role: "parent" }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("region", { name: "Result publication workspace" })).toHaveTextContent("parent actor");
    expect(screen.getByRole("main", { name: "parent shell" })).toBeInTheDocument();
  });

  it.each(["results", "published-results"])("does not infer a guardian role on %s", async (module) => {
    currentModule = module; searchParams.set("view", "guardian");
    readRoles.mockResolvedValue({ data: [{ role: "teacher" }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("requires a linked guardian account");
  });

  it.each([["teacher", "Teacher raw assessment workspace"], ["school_admin", "Admin raw assessment workspace"]])("keeps %s existing results report separate", async (role, label) => {
    currentModule = "results";
    readRoles.mockResolvedValue({ data: [{ role }], error: null });
    render(<ModulePage />);
    expect(await screen.findByRole("region", { name: label })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Result publication workspace" })).not.toBeInTheDocument();
  });

  it("does not duplicate the family results navigation", () => {
    for (const role of ["parent", "student"] as const) {
      expect(canAccessModule(role, "published-results")).toBe(true);
      expect(getVisibleModules(role).filter((item) => item.key === "results")).toEqual([expect.objectContaining({ label: "Published results" })]);
      expect(getVisibleModules(role).some((item) => item.key === "published-results")).toBe(false);
    }
    expect(getTeacherNavigationModules().some((item) => item.key === "published-results")).toBe(true);
    expect(getAdminNavigationModules().some((item) => item.key === "published-results")).toBe(true);
  });
});
