"use client";

import { Suspense, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useParams, useSearchParams } from "next/navigation";
import { AcademicWorkspace } from "@/components/academic/academic-workspace";
import { AppShell } from "@/components/layout/app-shell";
import { canAccessModule } from "@/lib/modules";
import { resolveUiRole, type UiRole } from "@/lib/auth/roles";
import { TeacherModuleView } from "@/components/teacher/teacher-views";
import { TeacherAcademicActivityWorkspace } from "@/components/academic/teacher-activity-workspace";
import { AdminModulePlaceholder } from "@/components/admin/admin-module-placeholder";
import { AdminAssessmentWorkspace } from "@/components/admin/admin-assessment-workspace";
import { AdminNoticesWorkspace } from "@/components/admin/admin-notices-workspace";
import { NoticeInbox } from "@/components/notices/notice-inbox";
import { AdminFinanceWorkspace } from "@/components/admin/admin-finance-workspace";
import { AdminAcademicSetupWorkspace } from "@/components/admin/admin-academic-setup-workspace";
import { AdminAttendanceWorkspace } from "@/components/admin/admin-attendance-workspace";
import { GuardianInvitationsWorkspace } from "@/components/admin/guardian-invitations-workspace";
import { StudentRosterWorkspace } from "@/components/admin/student-roster-workspace";
import { AdminDemoWorkspace } from "@/components/admin/admin-demo-workspace";
import type { AdminDemoModule } from "@/lib/admin/admin-demo-service";
import { TeacherAttendanceRegister } from "@/components/academic/teacher-attendance-register";
import { FamilyAttendanceRegister } from "@/components/academic/family-attendance-register";
import { FamilyReceipts } from "@/components/finance/family-receipts";
import { TeachingAssignmentManager } from "@/components/academic/teaching-assignment-manager";

const supabase = createClient();

function ModuleLoading() {
  return <main className="min-h-screen bg-[var(--bg)] p-6 text-sm muted">Checking module access...</main>;
}

export default function ModulePage() {
  return <Suspense fallback={<ModuleLoading />}><ModuleContent /></Suspense>;
}

function ModuleContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const moduleName = String(params?.module || "");
  const guardianView = moduleName === "attendance" && searchParams.get("view") === "guardian";
  const initialChildId = guardianView ? searchParams.get("child") ?? undefined : undefined;
  const accessKey = guardianView ? "attendance?view=guardian" : moduleName;
  const [access, setAccess] = useState<{
    key: string;
    role: UiRole | null;
    userId: string | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    let active = true;
    const loadRole = async () => {
      try {
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError) throw authError;
        if (!user) {
          if (active) setAccess({ key: accessKey, role: null, userId: null, error: "Please sign in to access this module." });
          return;
        }

        const { data: roleRows, error: roleError } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", user.id);
        if (roleError) throw roleError;
        const roles = roleRows ?? [];
        const role = guardianView
          ? roles.some((row) => row.role === "parent") ? "parent" : null
          : resolveUiRole(roles);
        if (active) setAccess({
          key: accessKey,
          role,
          userId: user.id,
          error: role ? null : guardianView
            ? "Guardian attendance requires a linked guardian account."
            : "No recognized role is assigned to this login.",
        });
      } catch (error) {
        if (active) setAccess({
          key: accessKey,
          role: null,
          userId: null,
          error: error instanceof Error ? error.message : "Your access could not be verified.",
        });
      }
    };

    void loadRole();
    return () => {
      active = false;
    };
  }, [accessKey, guardianView]);

  if (!access || access.key !== accessKey) return <ModuleLoading />;
  if (access.error || !access.role || !access.userId) {
    return (
      <main className="min-h-screen bg-[var(--bg)] p-6">
        <div role="alert" className="mx-auto max-w-2xl rounded-2xl border border-red-500/30 bg-[var(--surface)] p-6 text-sm text-red-600">
          {access.error ?? "Your role does not allow access to this module."}
        </div>
      </main>
    );
  }
  if (!canAccessModule(access.role, moduleName)) {
    return (
      <AppShell role={access.role}>
        <div role="alert" className="rounded-2xl border border-red-500/30 bg-[var(--surface)] p-6 text-sm text-red-600">
          Your role does not allow access to this module.
        </div>
      </AppShell>
    );
  }

  if (moduleName === "attendance") {
    if (access.role === "admin") {
      return <AppShell role="admin"><AdminAttendanceWorkspace /></AppShell>;
    }
    if (access.role === "teacher") {
      return <AppShell role="teacher"><TeacherAttendanceRegister /></AppShell>;
    }
    if (access.role === "student" || access.role === "parent") {
      return (
        <AppShell role={access.role}>
          <FamilyAttendanceRegister key={`${access.role}:${access.userId}`} role={access.role} userId={access.userId}
            initialChildId={initialChildId} />
        </AppShell>
      );
    }
    return (
      <AppShell role={access.role}>
        <section className="card space-y-3 p-5">
          <h1 className="text-xl font-bold">Attendance</h1>
          <p className="text-sm muted">Your attendance summary is available on the dashboard. The detailed read-only register is part of the next phase.</p>
          <a href="/dashboard" className="inline-block text-sm font-semibold text-blue-600">View dashboard</a>
        </section>
      </AppShell>
    );
  }

  if ((moduleName === "classwork" || moduleName === "homework") && access.role === "teacher") {
    return (
      <AppShell role="teacher">
        <TeacherAcademicActivityWorkspace module={moduleName} />
      </AppShell>
    );
  }

  if (moduleName === "academics" && (access.role === "admin" || access.role === "principal")) {
    return <AppShell role={access.role}><AdminAcademicSetupWorkspace key={access.userId} userId={access.userId} /></AppShell>;
  }

  if (access.role === "admin" && moduleName === "exams") {
    return <AppShell role="admin"><AdminAssessmentWorkspace mode="exams" /></AppShell>;
  }

  if (access.role === "admin" && (moduleName === "results" || moduleName === "result-report")) {
    return <AppShell role="admin"><AdminAssessmentWorkspace mode="results" /></AppShell>;
  }

  if (moduleName === "notices") {
    return (
      <AppShell role={access.role}>
        {access.role === "admin" || access.role === "principal"
          ? <AdminNoticesWorkspace key={access.userId} />
          : <NoticeInbox key={access.userId} />}
      </AppShell>
    );
  }

  if ((access.role === "admin" || access.role === "principal" || access.role === "finance") && moduleName === "fees") {
    return <AppShell role={access.role}><AdminFinanceWorkspace key={access.userId} mode="fees" /></AppShell>;
  }

  if ((access.role === "admin" || access.role === "principal" || access.role === "finance") && moduleName === "invoices") {
    const receipt = searchParams.get("receipt") ?? "";
    return <AppShell role={access.role}><AdminFinanceWorkspace key={`${access.userId}:${receipt}`} mode="invoices" initialReceiptNo={receipt} /></AppShell>;
  }

  if ((access.role === "admin" || access.role === "principal" || access.role === "finance") && moduleName === "finance-reports") {
    return <AppShell role={access.role}><AdminFinanceWorkspace key={access.userId} mode="reports" /></AppShell>;
  }

  if (moduleName === "invoices" && (access.role === "student" || access.role === "parent")) {
    return (
      <AppShell role={access.role}>
        <FamilyReceipts key={`${access.role}:${access.userId}`} role={access.role} userId={access.userId} />
      </AppShell>
    );
  }

  if (moduleName === "guardian-invitations" && (access.role === "admin" || access.role === "principal")) {
    return (
      <AppShell role={access.role}>
        <GuardianInvitationsWorkspace key={access.userId} userId={access.userId} />
      </AppShell>
    );
  }

  if (moduleName === "students" && (access.role === "admin" || access.role === "principal")) {
    return (
      <AppShell role={access.role}>
        <StudentRosterWorkspace key={access.userId} userId={access.userId} />
      </AppShell>
    );
  }

  if (access.role === "admin" && [
    "parents", "teachers", "admissions", "timetable", "events", "notifications",
    "library", "transport", "inventory", "hr-payroll", "leave", "profile", "documents",
    "reports", "audit-logs", "settings",
  ].includes(moduleName)) {
    return <AppShell role="admin"><AdminDemoWorkspace module={moduleName as AdminDemoModule} /></AppShell>;
  }

  if (["class-logs", "classwork", "homework", "assignments", "projects", "study-material", "missed-activities"].includes(moduleName)) {
    return <AcademicWorkspace module={moduleName} />;
  }

  if (moduleName === "teacher-assignments") {
    return <AppShell role={access.role}><TeachingAssignmentManager /></AppShell>;
  }

  if (access.role === "teacher") {
    const renderTeacherModule = (teacherModule: "exams" | "results" | "fees" | "profile") => (
      <AppShell role="teacher"><TeacherModuleView module={teacherModule} /></AppShell>
    );
    if (moduleName === "exams") return renderTeacherModule("exams");
    if (moduleName === "results" || moduleName === "result-report") return renderTeacherModule("results");
    if (moduleName === "fees") return renderTeacherModule("fees");
    if (moduleName === "profile") return renderTeacherModule("profile");
  }

  if (access.role === "admin") {
    return <AppShell role="admin"><AdminModulePlaceholder moduleName={moduleName} /></AppShell>;
  }

  return <GenericModule moduleName={moduleName} />;
}

/* =========================================================
   GENERIC MODULE
========================================================= */

function GenericModule({
  moduleName,
}: {
  moduleName: string;
}) {
  const title = moduleName
    .replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());

  return (
    <div className="rounded-2xl border border-slate-800 bg-[#0f172a] p-8">
      <h1 className="text-2xl font-bold text-white">
        {title}
      </h1>

      <p className="mt-2 text-sm text-slate-400">
        This module is ready for its dedicated management screen.
      </p>
    </div>
  );
}
