import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { RoleDashboard } from "@/components/dashboard/role-dashboard";
import { DashboardGreeting, DashboardMetric } from "@/components/dashboard/dashboard-primitives";
import { AppShell } from "@/components/layout/app-shell";
import { resolveUiRole, toUiRole } from "@/lib/auth/roles";
import { readActiveSchoolAccess } from "@/lib/auth/access";
import { dashboardStepUpPath, mfaPath, StaffMfaRequiredError } from "@/lib/auth/staff-mfa";

const overviewMetrics = [
  ["students", "Total students"],
  ["teachers", "Total teachers"],
  ["classes", "Classes"],
  ["sections", "Sections"],
  ["attendance_today", "Attendance recorded today"],
  ["absent_today", "Absent today"],
] as const;

export default async function DashboardPage() {
  const supabase = await createClient();
  let access;
  try {
    access = await readActiveSchoolAccess(supabase);
  } catch (error) {
    if (error instanceof StaffMfaRequiredError) {
      const { dashboard_allowed, user_id, profile_school_id } = error.status;
      if (dashboard_allowed && profile_school_id) {
        const { data, error: summaryError } = await supabase.rpc("get_my_school_admin_dashboard_summary");
        if (!summaryError && data && overviewMetrics.every(([key]) => Number.isSafeInteger(data[key]) && data[key] >= 0)) {
          return (
            <AppShell key={user_id} role="admin" userId={user_id} overviewSchoolId={profile_school_id}>
              <div className="space-y-4">
                <DashboardGreeting eyebrow="School administration" title="School Admin Dashboard"
                  description="Your school overview. Verify your authenticator to open records and manage the school."
                  href={dashboardStepUpPath} action="Unlock full workspace" />
                <section aria-label="School overview" className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {overviewMetrics.map(([key, label]) => <DashboardMetric key={key} label={label} value={data[key]} />)}
                </section>
              </div>
            </AppShell>
          );
        }
        redirect(dashboardStepUpPath);
      }
      redirect(mfaPath("/dashboard"));
    }
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
