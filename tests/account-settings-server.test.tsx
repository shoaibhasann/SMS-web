import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AccountSettingsPage from "../app/(dashboard)/account/settings/page";

const { getUser, profile, roles } = vi.hoisted(() => ({ getUser: vi.fn(), profile: vi.fn(), roles: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser },
  from: (table: string) => ({ select: () => ({ eq: () => table === "profiles" ? { maybeSingle: profile } : roles() }) }) }) }));
vi.mock("@/components/layout/app-shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock("@/components/account/account-settings", () => ({ AccountSettings: ({ userId, role, hasGuardianRole }: {
  userId: string; role: string; hasGuardianRole: boolean;
}) => <section aria-label="Verified own settings">{userId}/{role}/{String(hasGuardianRole)}</section> }));
beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: "owner", user_metadata: { role: "super_admin" } } }, error: null });
  profile.mockResolvedValue({ data: { is_active: true, school_id: "school" }, error: null });
  roles.mockResolvedValue({ data: [{ role: "student", school_id: "school" }], error: null });
});

describe("account settings server authority", () => {
  it.each([["school_admin", "admin"], ["principal", "principal"], ["teacher", "teacher"], ["accountant", "finance"],
    ["reception_staff", "reception"], ["student", "student"], ["parent", "parent"], ["super_admin", "admin"]])("allows own settings for verified %s", async (dbRole, uiRole) => {
    roles.mockResolvedValueOnce({ data: [{ role: dbRole, school_id: dbRole === "super_admin" ? null : "school" }], error: null });
    render(await AccountSettingsPage());
    expect(screen.getByRole("region", { name: "Verified own settings" })).toHaveTextContent(`owner/${uiRole}/${dbRole === "parent"}`);
  });

  it("redirects an unauthenticated request before rendering account details", async () => {
    getUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    await expect(AccountSettingsPage()).rejects.toThrow("redirect:/login"); expect(profile).not.toHaveBeenCalled();
  });

  it.each([false, null])("does not render account controls for inactive or missing profile (%s)", async (active) => {
    profile.mockResolvedValueOnce({ data: active === null ? null : { is_active: active }, error: null });
    render(await AccountSettingsPage());
    expect(screen.getByRole("alert")).toHaveTextContent("active school account could not be verified");
    expect(screen.queryByRole("region", { name: "Verified own settings" })).not.toBeInTheDocument();
  });

  it("does not trust user-editable role metadata", async () => {
    render(await AccountSettingsPage());
    expect(screen.getByRole("region", { name: "Verified own settings" })).toHaveTextContent("owner/student/false");
  });

  it("redirects a role-less identity to school activation", async () => {
    roles.mockResolvedValueOnce({ data: [], error: null });
    await expect(AccountSettingsPage()).rejects.toThrow("redirect:/activate");
  });

  it("does not expose internal query errors or controls for anonymous Auth", async () => {
    getUser.mockResolvedValueOnce({ data: { user: { id: "owner", is_anonymous: true } }, error: null });
    render(await AccountSettingsPage());
    expect(screen.queryByRole("region", { name: "Verified own settings" })).not.toBeInTheDocument();
    expect(profile).not.toHaveBeenCalled();
  });
});
