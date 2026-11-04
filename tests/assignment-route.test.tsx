import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ModulePage from "../app/(dashboard)/modules/[module]/page";

const { getUser, readRoles } = vi.hoisted(() => ({ getUser: vi.fn(), readRoles: vi.fn() }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ module: "teacher-assignments" }),
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

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: "actor" } }, error: null });
  readRoles.mockResolvedValue({ data: [{ role: "school_admin" }], error: null });
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
