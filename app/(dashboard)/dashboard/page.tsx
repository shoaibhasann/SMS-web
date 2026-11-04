import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { RoleDashboard } from "@/components/dashboard/role-dashboard";
import { resolveUiRole, toUiRole } from "@/lib/auth/roles";

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: roles, error } = await supabase
    .from("user_roles")
    .select("role,school_id")
    .eq("user_id", user.id);

  if (error) {
    return (
      <main className="min-h-screen grid place-items-center bg-[var(--bg)] p-6">
        <div className="card max-w-xl p-8">
          <h1 className="text-2xl font-black">Dashboard could not load</h1>
          <p className="mt-3 text-sm text-red-600">{error.message}</p>
          <p className="mt-3 text-xs muted">
            Check that the logged-in account has a row in user_roles and that the
            authenticated role has SELECT access to that table.
          </p>
        </div>
      </main>
    );
  }

  if (!roles?.length) redirect("/activate");

  const role = resolveUiRole(roles);
  if (!role) redirect("/activate");
  const roleRow = role === "admin"
    ? roles.find((row) => row.role === "school_admin" && row.school_id)
      ?? roles.find((row) => toUiRole(row.role) === role)
    : roles.find((row) => toUiRole(row.role) === role);

  return <RoleDashboard role={role} schoolId={roleRow?.school_id ?? null} userId={user.id}
    hasGuardianRole={roles.some((row) => row.role === "parent")} />;
}
