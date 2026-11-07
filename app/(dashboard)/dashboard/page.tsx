import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { RoleDashboard } from "@/components/dashboard/role-dashboard";
import { resolveUiRole, toUiRole } from "@/lib/auth/roles";
import { readActiveSchoolAccess } from "@/lib/auth/access";
import { mfaPath, StaffMfaRequiredError } from "@/lib/auth/staff-mfa";

export default async function DashboardPage() {
  const supabase = await createClient();
  let access;
  try {
    access = await readActiveSchoolAccess(supabase);
  } catch (error) {
    if (error instanceof StaffMfaRequiredError) redirect(mfaPath("/dashboard"));
    return (
      <main className="min-h-screen grid place-items-center bg-[var(--bg)] p-6">
        <div className="card max-w-xl p-8">
          <h1 className="text-2xl font-black">Dashboard could not load</h1>
          <p className="mt-3 text-sm text-red-600">Your active school access could not be verified. Sign in again or contact the school office.</p>
          <p className="mt-3 text-xs muted">
            Your account must be active and have a verified school role.
          </p>
        </div>
      </main>
    );
  }

  if (!access) redirect("/login");
  const { roles, userId } = access;

  if (!roles?.length) redirect("/activate");

  const role = resolveUiRole(roles);
  if (!role) redirect("/activate");
  const roleRow = role === "admin"
    ? roles.find((row) => row.role === "school_admin" && row.school_id)
      ?? roles.find((row) => toUiRole(row.role) === role)
    : roles.find((row) => toUiRole(row.role) === role);

  return <RoleDashboard role={role} schoolId={roleRow?.school_id ?? null} userId={userId}
    hasGuardianRole={roles.some((row) => row.role === "parent" && row.school_id === access.profileSchoolId)} />;
}
