import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ModulePage from "../app/(dashboard)/modules/[module]/page";
import { RoleDashboard } from "../components/dashboard/role-dashboard";
import { canAccessModule, getNavigationModules, getTeacherNavigationModules, getVisibleModules, modules, resolveModuleRole } from "../lib/modules";
import { resolveUiRole } from "../lib/auth/roles";

const { getUser, readRoles, readProfile, onAuthStateChange, routeSecurity, replace } = vi.hoisted(() => ({
  getUser: vi.fn(), readRoles: vi.fn(), readProfile: vi.fn(), onAuthStateChange: vi.fn(), routeSecurity: vi.fn(), replace: vi.fn(),
}));
let currentModule = "";
vi.mock("@/lib/auth/staff-mfa", async (original) => ({ ...await original<typeof import("@/lib/auth/staff-mfa")>(), readStaffMfaStatus: routeSecurity }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ module: currentModule }),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace }),
  notFound: () => { throw new Error("NEXT_HTTP_ERROR_FALLBACK;404"); },
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getUser, onAuthStateChange },
    from: (table: string) => ({ select: () => ({ eq: (...args: unknown[]) => table === "profiles"
      ? { maybeSingle: () => readProfile(...args) }
      : Promise.resolve(readRoles(...args)) }) }),
  }),
}));
vi.mock("@/components/layout/app-shell", () => ({
  AppShell: ({ role, children }: { role: string; children: ReactNode }) => <main aria-label={`${role} shell`}>{children}</main>,
}));
vi.mock("@/components/teacher/teacher-views", () => ({
  TeacherModuleView: ({ module }: { module: string }) => <section aria-label="Teacher module view">{module}</section>,
}));
vi.mock("@/components/admin/admin-finance-workspace", () => ({
  AdminFinanceWorkspace: ({ mode }: { mode: string }) => <section aria-label="Office finance workspace">{mode}</section>,
}));
vi.mock("@/components/notices/notice-inbox", () => ({ NoticeInbox: () => <section aria-label="Notice inbox" /> }));

function rolesFor(...roles: string[]) {
  readRoles.mockResolvedValue({ data: roles.map((role) => ({ role, school_id: "school" })), error: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  routeSecurity.mockResolvedValue({ user_id: "actor", allowed: true });
  getUser.mockResolvedValue({ data: { user: { id: "actor" } }, error: null });
  readProfile.mockResolvedValue({ data: { is_active: true, school_id: "school" }, error: null });
  onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
});

const keys = (role: Parameters<typeof getVisibleModules>[0]) => getVisibleModules(role).map((module) => module.key);
const principalUnbuilt = ["exams", "results", "events", "library", "transport", "inventory", "hr-payroll", "leave", "profile", "documents"];

describe("role navigation lists only implemented workspaces", () => {
  it("drops modules with no working page for the role", () => {
    expect(keys("principal")).toEqual(modules.map((module) => module.key).filter((key) => !principalUnbuilt.includes(key)));
    expect(keys("finance")).toEqual(["fees", "advance-credit", "invoices", "finance-reports", "notices"]);
    expect(keys("reception")).toEqual(["notices"]);
    for (const role of ["student", "parent"] as const) {
      expect(keys(role)).not.toContain("fees");
      expect(keys(role)).not.toContain("events");
      expect(keys(role)).toContain("invoices");
    }
    expect(keys("student")).not.toContain("profile");
    expect(keys("parent")).toContain("profile");
  });

  it.each([
    ["reception_staff", "students"], ["reception_staff", "events"], ["reception_staff", "documents"],
    ["principal", "library"], ["principal", "exams"], ["accountant", "students"], ["accountant", "reports"],
    ["student", "fees"], ["student", "profile"], ["parent", "events"],
  ])("sends %s on /modules/%s to the dashboard instead of the dead-end placeholder", async (role, module) => {
    rolesFor(role); currentModule = module;
    render(<ModulePage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"));
    expect(screen.queryByRole("main", { name: /shell$/ })).not.toBeInTheDocument();
    expect(screen.queryByText("This module is ready for its dedicated management screen.")).not.toBeInTheDocument();
  });

  it("hands an unknown /modules slug to the app 404 before any auth read", () => {
    currentModule = "not-a-module";
    expect(() => render(<ModulePage />)).toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(routeSecurity).not.toHaveBeenCalled();
    expect(getUser).not.toHaveBeenCalled();
    expect(onAuthStateChange).not.toHaveBeenCalled();
  });

  it("shows Reception only working dashboard tiles", () => {
    render(<RoleDashboard role="reception" schoolId="school" userId="reception-user" />);
    const hrefs = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(hrefs).toContain("/modules/notices");
    for (const href of hrefs) expect(href === null || canAccessModule("reception", href.replace(/^\/modules\//, "").split("?")[0]) || href === "/dashboard").toBe(true);
  });
});

describe("teacher fee module", () => {
  it("is not offered to teachers, who have no fee read access", () => {
    expect(canAccessModule("teacher", "fees")).toBe(false);
    expect(keys("teacher")).not.toContain("fees");
    expect(getTeacherNavigationModules().map((module) => module.key)).not.toContain("fees");
    for (const role of ["admin", "principal", "finance"] as const) expect(canAccessModule(role, "fees")).toBe(true);
  });

  it("denies /modules/fees for a teacher instead of claiming there are no records", async () => {
    rolesFor("teacher"); currentModule = "fees";
    render(<ModulePage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"));
    expect(screen.queryByRole("region", { name: "Teacher module view" })).not.toBeInTheDocument();
  });
});

describe("staff with several roles", () => {
  it("resolves the landing role independently of user_roles row order", () => {
    const rows = [{ role: "accountant" }, { role: "reception_staff" }];
    expect(resolveUiRole(rows)).toBe("finance");
    expect(resolveUiRole([...rows].reverse())).toBe("finance");
    expect(resolveUiRole([{ role: "parent" }, { role: "student" }])).toBe(resolveUiRole([{ role: "student" }, { role: "parent" }]));
  });

  it("gives each staff role's modules to the same school account", () => {
    const rows = (...roles: string[]) => roles.map((role) => ({ role, school_id: "school" }));
    expect(resolveModuleRole(rows("teacher", "accountant"), "school", "invoices")).toBe("finance");
    expect(resolveModuleRole(rows("teacher", "accountant"), "school", "finance-reports")).toBe("finance");
    expect(resolveModuleRole(rows("teacher", "accountant"), "school", "attendance")).toBe("teacher");
    expect(resolveModuleRole([{ role: "teacher", school_id: "school" }, { role: "accountant", school_id: "other" }], "school", "invoices")).toBe("teacher");
    expect(resolveModuleRole(rows("teacher", "parent"), "school", "invoices")).toBe("teacher");
    expect(resolveModuleRole(rows("school_admin", "accountant"), "school", "attendance")).toBe("admin");
    const nav = getNavigationModules("teacher", ["teacher", "finance"]).map((module) => module.key);
    expect(nav).toEqual(expect.arrayContaining(["attendance", "invoices", "finance-reports", "fees"]));
    expect(new Set(nav).size).toBe(nav.length);
    expect(getNavigationModules("parent", ["parent", "teacher"]).map((module) => module.key)).toEqual(keys("parent"));
  });

  it("gives a principal who also teaches the teacher modules principal lacks", () => {
    const rows = (...roles: string[]) => roles.map((role) => ({ role, school_id: "school" }));
    for (const key of ["exams", "results", "result-report", "profile"]) {
      expect(resolveModuleRole(rows("principal", "teacher"), "school", key)).toBe("teacher");
      expect(resolveModuleRole(rows("principal"), "school", key)).toBe("principal");
    }
    expect(resolveModuleRole(rows("principal", "teacher"), "school", "attendance")).toBe("principal");
    expect(resolveModuleRole([{ role: "principal", school_id: "school" }, { role: "teacher", school_id: "other" }], "school", "exams")).toBe("principal");
    const nav = getNavigationModules("principal", ["principal", "teacher"]).map((module) => module.key);
    expect(nav).toEqual(expect.arrayContaining(["students", "attendance", "exams", "results", "profile"]));
    expect(new Set(nav).size).toBe(nav.length);
    expect(getNavigationModules("principal", ["principal"]).map((module) => module.key)).toEqual(keys("principal"));
    expect(getNavigationModules("teacher", ["teacher", "principal"]).map((module) => module.key)).toEqual(expect.arrayContaining(["exams", "students"]));
  });

  it.each([["exams", "Teacher module view", "teacher"], ["results", "Teacher module view", "teacher"], ["profile", "Teacher module view", "teacher"]])(
    "opens /modules/%s for a principal who also teaches", async (module, region, shell) => {
      rolesFor("principal", "teacher"); currentModule = module;
      render(<ModulePage />);
      expect(await screen.findByRole("region", { name: region })).toHaveTextContent(module);
      expect(screen.getByRole("main", { name: `${shell} shell` })).toBeInTheDocument();
    });

  it("still denies /modules/exams to a principal who does not teach", async () => {
    rolesFor("principal"); currentModule = "exams";
    render(<ModulePage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"));
    expect(screen.queryByRole("main", { name: /shell$/ })).not.toBeInTheDocument();
  });

  it.each([["invoices", "Office finance workspace", "finance"], ["fees", "Office finance workspace", "finance"], ["exams", "Teacher module view", "teacher"]])(
    "opens /modules/%s for a teacher who is also the accountant", async (module, region, shell) => {
      rolesFor("teacher", "accountant"); currentModule = module;
      render(<ModulePage />);
      expect(await screen.findByRole("region", { name: region })).toBeInTheDocument();
      expect(screen.getByRole("main", { name: `${shell} shell` })).toBeInTheDocument();
    });
});
