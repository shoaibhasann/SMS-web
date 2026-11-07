import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DashboardPage from "@/app/(dashboard)/dashboard/page";
import LegacyAcademicPage from "@/app/(dashboard)/modules/academic/page";

const { getUser, profile, roles, eq, security } = vi.hoisted(() => ({
  getUser: vi.fn(), profile: vi.fn(), roles: vi.fn(), eq: vi.fn(), security: vi.fn(),
}));
vi.mock("@/lib/auth/staff-mfa", async (original) => ({ ...await original<typeof import("@/lib/auth/staff-mfa")>(), readStaffMfaStatus: security }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({
  auth: { getUser },
  from: (table: string) => ({ select: () => ({ eq: (column: string, value: string) => {
    eq(table, column, value);
    return table === "profiles" ? { maybeSingle: profile } : roles();
  } }) }),
}) }));
vi.mock("@/components/dashboard/role-dashboard", () => ({
  RoleDashboard: ({ role, userId, schoolId, hasGuardianRole }: { role: string; userId: string; schoolId: string | null; hasGuardianRole: boolean }) =>
    <section aria-label="Authorized dashboard">{role}/{userId}/{schoolId ?? "global"}/{String(hasGuardianRole)}</section>,
}));

beforeEach(() => {
  vi.clearAllMocks();
  security.mockResolvedValue({ user_id: "verified-user", allowed: true });
  getUser.mockResolvedValue({ data: { user: { id: "verified-user" } }, error: null });
  profile.mockResolvedValue({ data: { is_active: true, school_id: "school-a" }, error: null });
  roles.mockResolvedValue({ data: [{ role: "school_admin", school_id: "school-a" }], error: null });
});

describe("server role gates", () => {
  it.each(["enroll", "challenge", "sign_in"])("redirects MFA %s before reading school profile or roles", async (action) => {
    security.mockResolvedValueOnce({ user_id: "verified-user", allowed: false, action });
    await expect(DashboardPage()).rejects.toThrow("redirect:/mfa?next=%2Fdashboard");
    expect(getUser).not.toHaveBeenCalled(); expect(eq).not.toHaveBeenCalled();
  });
  it("redirects unauthenticated access before querying authority records", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    await expect(DashboardPage()).rejects.toThrow("redirect:/login");
    expect(eq).not.toHaveBeenCalled();
  });

  it.each([false, null])("does not render a privileged dashboard for an inactive/missing profile (%s)", async (active) => {
    profile.mockResolvedValue({ data: active === null ? null : { is_active: active, school_id: "school-a" }, error: null });
    render(await DashboardPage());
    expect(screen.getByText(/active school access could not be verified/i)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Authorized dashboard" })).not.toBeInTheDocument();
  });

  it("does not grant school UI authority to an anonymous Auth identity", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "verified-user", is_anonymous: true } }, error: null });
    render(await DashboardPage());
    expect(screen.queryByRole("region", { name: "Authorized dashboard" })).not.toBeInTheDocument();
    expect(eq).not.toHaveBeenCalled();
  });

  it.each(["profile", "roles"])("fails closed when the %s authority query fails", async (source) => {
    (source === "profile" ? profile : roles).mockResolvedValue({ data: null, error: { message: "internal role policy details" } });
    render(await DashboardPage());
    expect(screen.queryByText(/internal role policy details/)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Authorized dashboard" })).not.toBeInTheDocument();
  });

  it("uses verified rows rather than self-editable metadata and queries only the verified identity", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "verified-user", user_metadata: { role: "super_admin" } } }, error: null });
    roles.mockResolvedValue({ data: [{ role: "student", school_id: "school-a" }], error: null });
    render(await DashboardPage());
    expect(screen.getByRole("region", { name: "Authorized dashboard" })).toHaveTextContent("student/verified-user/school-a/false");
    expect(eq).toHaveBeenCalledWith("profiles", "id", "verified-user");
    expect(eq).toHaveBeenCalledWith("user_roles", "user_id", "verified-user");
  });

  it("accepts only genuinely global Super Admin scope", async () => {
    profile.mockResolvedValue({ data: { is_active: true, school_id: null }, error: null });
    roles.mockResolvedValue({ data: [{ role: "super_admin", school_id: null }], error: null });
    render(await DashboardPage());
    expect(screen.getByRole("region", { name: "Authorized dashboard" })).toHaveTextContent("admin/verified-user/global/false");
  });

  it.each([
    { rows: [{ role: "super_admin", school_id: "school-a" }] },
    { rows: [{ role: "school_admin", school_id: null }] },
    { rows: [] },
  ])("routes absent or malformed role authority to activation: $rows", async ({ rows }) => {
    roles.mockResolvedValue({ data: rows, error: null });
    await expect(DashboardPage()).rejects.toThrow("redirect:/activate");
  });

  it("does not show a Guardian portal from a Parent membership in another profile school", async () => {
    roles.mockResolvedValue({ data: [{ role: "teacher", school_id: "school-a" }, { role: "parent", school_id: "school-b" }], error: null });
    render(await DashboardPage());
    expect(screen.getByRole("region", { name: "Authorized dashboard" })).toHaveTextContent("teacher/verified-user/school-a/false");
  });

  it("routes the old static academic page through the governed module gate", () => {
    expect(() => LegacyAcademicPage()).toThrow("redirect:/modules/academics");
    expect(getUser).not.toHaveBeenCalled();
  });
});
