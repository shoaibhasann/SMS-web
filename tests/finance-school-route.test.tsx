import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ModulePage from "../app/(dashboard)/modules/[module]/page";

const { getUser, readRoles, readProfile, onAuthStateChange, routeSecurity } = vi.hoisted(() => ({
  getUser: vi.fn(), readRoles: vi.fn(), readProfile: vi.fn(), onAuthStateChange: vi.fn(), routeSecurity: vi.fn(),
}));
let currentModule = "", currentSearch = "";
vi.mock("@/lib/auth/staff-mfa", async (original) => ({ ...await original<typeof import("@/lib/auth/staff-mfa")>(), readStaffMfaStatus: routeSecurity }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ module: currentModule }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getUser, onAuthStateChange },
    from: (table: string) => ({ select: () => ({ eq: (...args: unknown[]) => table === "profiles"
      ? { maybeSingle: () => readProfile(...args) }
      : Promise.resolve(readRoles(...args)) }) }),
  }),
}));
vi.mock("@/components/layout/app-shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock("@/components/admin/admin-finance-workspace", () => ({
  AdminFinanceWorkspace: ({ mode, requestedSchoolId }: { mode: string; requestedSchoolId?: string }) => <section aria-label="Office finance workspace">{mode}:{requestedSchoolId ?? "default"}</section>,
}));

beforeEach(() => {
  vi.clearAllMocks();
  routeSecurity.mockResolvedValue({ user_id: "actor", allowed: true });
  getUser.mockResolvedValue({ data: { user: { id: "actor" } }, error: null });
  readProfile.mockResolvedValue({ data: { is_active: true, school_id: "school-a" }, error: null });
  readRoles.mockResolvedValue({ data: [{ role: "accountant", school_id: "school-a" }, { role: "accountant", school_id: "school-b" }], error: null });
  onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
});

describe("finance routes honour the chosen school", () => {
  it.each([["fees", "fees"], ["invoices", "invoices"], ["finance-reports", "reports"]])("passes ?school= to /modules/%s", async (module, mode) => {
    currentModule = module; currentSearch = "school=school-b";
    render(<ModulePage />);
    expect(await screen.findByRole("region", { name: "Office finance workspace" })).toHaveTextContent(`${mode}:school-b`);
  });
});
