import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import DashboardPage from "@/app/(dashboard)/dashboard/page";
import { StaffMfaError } from "@/lib/auth/staff-mfa";

const { readActiveSchoolAccess, signOut, replace, refresh } = vi.hoisted(() => ({
  readActiveSchoolAccess: vi.fn(), signOut: vi.fn(), replace: vi.fn(), refresh: vi.fn(),
}));
vi.mock("@/lib/auth/access", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/auth/access")>(), readActiveSchoolAccess: readActiveSchoolAccess }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { signOut } }) }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); }, useRouter: () => ({ replace, refresh }) }));
vi.mock("@/components/dashboard/role-dashboard", () => ({ RoleDashboard: () => <section aria-label="Authorized dashboard" /> }));

it("offers a way back to sign in when the session was revoked server-side", async () => {
  readActiveSchoolAccess.mockRejectedValue(new StaffMfaError("Your account changed or signed out. Sign in again.", "access"));
  render(await DashboardPage());
  expect(screen.getByRole("heading", { name: "Dashboard could not load" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Return to sign in" })).toHaveAttribute("href", "/login");
  expect(screen.queryByRole("region", { name: "Authorized dashboard" })).not.toBeInTheDocument();
});

beforeEach(() => { vi.clearAllMocks(); signOut.mockResolvedValue({ error: null }); });

it("lets a user who only wants to leave sign out locally from the error card", async () => {
  readActiveSchoolAccess.mockRejectedValue(new Error("offline"));
  render(await DashboardPage());
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await waitFor(() => expect(replace).toHaveBeenCalledExactlyOnceWith("/login"));
  expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
  expect(refresh).toHaveBeenCalledOnce();
});

it("keeps the user on the error card with a message when sign out fails", async () => {
  readActiveSchoolAccess.mockRejectedValue(new Error("offline"));
  signOut.mockResolvedValue({ error: { message: "network" } });
  render(await DashboardPage());
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Sign out failed. Please try again.");
  expect(replace).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
});
