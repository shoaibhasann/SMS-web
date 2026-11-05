import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ModulePage from "../app/(dashboard)/modules/[module]/page";
import { canAccessModule, getTeacherNavigationModules, getVisibleModules } from "../lib/modules";

const { getUser, readRoles } = vi.hoisted(() => ({ getUser: vi.fn(), readRoles: vi.fn() }));

let currentModule: string;
let searchParams: URLSearchParams;

vi.mock("next/navigation", () => ({
  useParams: () => ({ module: currentModule }),
  useSearchParams: () => searchParams,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getUser },
    from: () => ({ select: () => ({ eq: readRoles }) }),
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
  currentModule = "teacher-assignments";
  searchParams = new URLSearchParams();
  getUser.mockResolvedValue({ data: { user: { id: "actor" } }, error: null });
  readRoles.mockResolvedValue({ data: [{ role: "school_admin" }], error: null });
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
