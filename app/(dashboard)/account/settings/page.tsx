import Link from "next/link";
import { redirect } from "next/navigation";
import { AccountSettings } from "@/components/account/account-settings";
import { AppShell } from "@/components/layout/app-shell";
import { readActiveSchoolAccess } from "@/lib/auth/access";
import { resolveUiRole } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";
import { mfaPath, StaffMfaRequiredError } from "@/lib/auth/staff-mfa";

export default async function AccountSettingsPage() {
  const client = await createClient();
  let access;
  try { access = await readActiveSchoolAccess(client); }
  catch (error) {
    if (error instanceof StaffMfaRequiredError) redirect(mfaPath("/account/settings"));
    return <main className="grid min-h-screen place-items-center bg-[var(--bg)] p-6"><section className="card max-w-xl space-y-4 p-6">
      <h1 className="text-2xl font-bold">Account settings unavailable</h1>
      <p role="alert" className="text-sm muted">Your active school account could not be verified. Sign in again or contact your school.</p>
      <Link href="/login" className="inline-flex min-h-11 items-center text-sm font-semibold text-blue-700 dark:text-blue-300">Return to sign in</Link>
    </section></main>;
  }
  if (!access) redirect("/login");
  const role = resolveUiRole(access.roles);
  if (!role) redirect("/activate");
  return <AppShell key={access.userId} userId={access.userId} role={role}><AccountSettings userId={access.userId} role={role}
    hasGuardianRole={access.roles.some((row) => row.role === "parent" && row.school_id === access.profileSchoolId)}
    hasStudentRole={access.roles.some((row) => row.role === "student" && row.school_id === access.profileSchoolId)} /></AppShell>;
}
