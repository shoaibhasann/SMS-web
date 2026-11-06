"use client";

import { Suspense, useEffect, useState } from "react";
import { WorkspaceSkeleton } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/client";
import { useParams, useSearchParams } from "next/navigation";
import { AcademicWorkspace } from "@/components/academic/academic-workspace";
import { AppShell } from "@/components/layout/app-shell";
import { canAccessModule } from "@/lib/modules";
import { resolveUiRole, type UiRole } from "@/lib/auth/roles";
import { readActiveSchoolAccess } from "@/lib/auth/access";
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
import { GuardianContactSettings } from "@/components/family/guardian-contact-settings";
import { GuardianAttendanceAlerts } from "@/components/family/guardian-attendance-alerts";
import { TeacherDirectoryWorkspace } from "@/components/admin/teacher-directory-workspace";
import { StudentRosterWorkspace } from "@/components/admin/student-roster-workspace";
import { AdminDemoWorkspace } from "@/components/admin/admin-demo-workspace";
import type { AdminDemoModule } from "@/lib/admin/admin-demo-service";
import { TeacherAttendanceRegister } from "@/components/academic/teacher-attendance-register";
import { FamilyAttendanceRegister } from "@/components/academic/family-attendance-register";
import { FamilyReceipts } from "@/components/finance/family-receipts";
import { AdvanceCreditWorkspace } from "@/components/finance/advance-credit-workspace";
import { FamilyAdvanceCredit } from "@/components/finance/family-advance-credit";
import { TeachingAssignmentManager } from "@/components/academic/teaching-assignment-manager";
import { SubstituteCoverageWorkspace } from "@/components/academic/substitute-coverage-workspace";
import { StudentLeaveWorkspace } from "@/components/family/student-leave-workspace";
import { TimetableWorkspace } from "@/components/academic/timetable-workspace";
import { ResultPublicationWorkspace } from "@/components/academic/result-publication-workspace";

const supabase = createClient();

function ModuleLoading() {
  return <WorkspaceSkeleton />;
}

export default function ModulePage() {
  return <Suspense fallback={<ModuleLoading />}><ModuleContent /></Suspense>;
}

function ModuleContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const moduleName = String(params?.module || "");
  const guardianView = ["attendance", "notifications", "profile", "advance-credit", "invoices", "student-leave", "timetable", "results", "result-report", "published-results"].includes(moduleName) && searchParams.get("view") === "guardian";
  const initialChildId = guardianView && moduleName === "attendance" ? searchParams.get("child") ?? undefined : undefined;
  const accessKey = guardianView ? `${moduleName}?view=guardian` : moduleName;
  const [access, setAccess] = useState<{
    key: string;
    role: UiRole | null;
    userId: string | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    let active = true;
    let generation = 0;
    let currentUserId: string | null = null;
    let authTimer: ReturnType<typeof setTimeout> | undefined;
    const loadRole = async () => {
      if (!active) return;
      const request = ++generation;
      const isCurrent = () => active && request === generation;
      try {
        const verified = await readActiveSchoolAccess(supabase);
        if (!isCurrent()) return;
        if (!verified) {
          currentUserId = null;
          setAccess({ key: accessKey, role: null, userId: null, error: "Please sign in to access this module." });
          return;
        }
        currentUserId = verified.userId;
        const roles = verified.roles;
        const role = guardianView
          ? roles.some((row) => row.role === "parent" && row.school_id === verified.profileSchoolId) ? "parent" : null
          : resolveUiRole(roles);
        setAccess({
          key: accessKey,
          role,
          userId: verified.userId,
          error: role ? null : guardianView
            ? "This view requires a linked guardian account."
            : "No recognized role is assigned to this login.",
        });
      } catch (error) {
        if (isCurrent()) setAccess({
          key: accessKey,
          role: null,
          userId: null,
          error: error instanceof Error ? error.message : "Your access could not be verified.",
        });
      }
    };
    const onFocus = () => { void loadRole(); };
    const onVisible = () => { if (document.visibilityState === "visible") void loadRole(); };
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active || event === "INITIAL_SESSION") return;
      generation += 1;
      if (event === "SIGNED_OUT" || session?.user.id !== currentUserId) {
        currentUserId = session?.user.id ?? null;
        setAccess(null);
      }
      // Supabase auth callbacks must finish before starting another Auth read.
      clearTimeout(authTimer);
      authTimer = setTimeout(() => { void loadRole(); }, 0);
    });
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    void loadRole();
    return () => {
      active = false;
      generation += 1;
      clearTimeout(authTimer);
      subscription.unsubscribe();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
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

  if ((moduleName === "published-results" || ((access.role === "parent" || access.role === "student")
    && (moduleName === "results" || moduleName === "result-report")))
    && (access.role === "admin" || access.role === "principal" || access.role === "teacher" || access.role === "parent" || access.role === "student")) {
    return <AppShell role={access.role}><ResultPublicationWorkspace key={`${access.userId}:${access.role}`} role={access.role} userId={access.userId} /></AppShell>;
  }

  if (moduleName === "student-leave" && (access.role === "student" || access.role === "parent" || access.role === "admin" || access.role === "principal")) {
    return (
      <AppShell role={access.role}>
        <StudentLeaveWorkspace key={`${access.role}:${access.userId}`} role={access.role} userId={access.userId} />
      </AppShell>
    );
  }

  if (moduleName === "timetable" && (access.role === "admin" || access.role === "principal" || access.role === "teacher" || access.role === "parent" || access.role === "student")) {
    return (
      <AppShell role={access.role}>
        <TimetableWorkspace key={`${access.role}:${access.userId}`} role={access.role} userId={access.userId} />
      </AppShell>
    );
  }

  if (moduleName === "attendance") {
    if (access.role === "admin" || access.role === "principal") {
      return <AppShell role={access.role}><AdminAttendanceWorkspace key={`${access.userId}:${access.role}`} principal={access.role === "principal"} /></AppShell>;
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

  if (moduleName === "advance-credit") {
    if (access.role === "admin" || access.role === "principal" || access.role === "finance") {
      return <AppShell role={access.role}><AdvanceCreditWorkspace key={access.userId} userId={access.userId} /></AppShell>;
    }
    if (access.role === "parent" || access.role === "student") {
      return <AppShell role={access.role}><FamilyAdvanceCredit key={`${access.role}:${access.userId}`} role={access.role} userId={access.userId} /></AppShell>;
    }
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

  if (moduleName === "notifications" && access.role === "parent") {
    return (
      <AppShell role="parent">
        <div className="space-y-5">
          <h1 className="text-3xl font-black">Notifications</h1>
          <GuardianAttendanceAlerts key={access.userId} userId={access.userId} />
        </div>
      </AppShell>
    );
  }

  if (moduleName === "profile" && access.role === "parent") {
    return (
      <AppShell role="parent">
        <GuardianContactSettings key={access.userId} userId={access.userId} callbackStatus={searchParams.get("contact")} />
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

  if (moduleName === "teachers" && (access.role === "admin" || access.role === "principal")) {
    return <AppShell role={access.role}><TeacherDirectoryWorkspace key={access.userId} userId={access.userId} /></AppShell>;
  }

  if (access.role === "admin" && [
    "parents", "admissions", "events", "notifications",
    "library", "transport", "inventory", "hr-payroll", "leave", "profile", "documents",
    "reports", "audit-logs", "settings",
  ].includes(moduleName)) {
    return <AppShell role="admin"><AdminDemoWorkspace module={moduleName as AdminDemoModule} /></AppShell>;
  }

  if (["class-logs", "classwork", "homework", "assignments", "projects", "study-material", "missed-activities"].includes(moduleName)) {
    return <AcademicWorkspace module={moduleName} />;
  }

  if (moduleName === "teacher-assignments") {
    return <AppShell role={access.role}><div className="space-y-6">
      {(access.role === "admin" || access.role === "principal") && <SubstituteCoverageWorkspace key={access.userId} userId={access.userId} />}
      <TeachingAssignmentManager />
    </div></AppShell>;
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
