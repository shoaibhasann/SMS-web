"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { BrandLogo } from "@/components/ui/brand-logo";
import { WorkspaceSkeleton } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/client";
import { notFound, useParams, useRouter, useSearchParams } from "next/navigation";
import { AcademicWorkspace } from "@/components/academic/academic-workspace";
import { AppShell } from "@/components/layout/app-shell";
import { canAccessModule, modules, resolveModuleRole } from "@/lib/modules";
import type { UiRole } from "@/lib/auth/roles";
import { readActiveSchoolAccess } from "@/lib/auth/access";
import { loginPath, mfaPath, StaffMfaRequiredError } from "@/lib/auth/staff-mfa";
import { TeacherModuleView } from "@/components/teacher/teacher-views";
import { TeacherAcademicActivityWorkspace } from "@/components/academic/teacher-activity-workspace";
import { AdminModulePlaceholder } from "@/components/admin/admin-module-placeholder";
import { AdminAssessmentWorkspace } from "@/components/admin/admin-assessment-workspace";
import { AdminNoticesWorkspace } from "@/components/admin/admin-notices-workspace";
import { AdminNotificationDelivery } from "@/components/admin/admin-notification-delivery";
import { NoticeInbox } from "@/components/notices/notice-inbox";
import { AdminFinanceWorkspace } from "@/components/admin/admin-finance-workspace";
import { AdminAcademicSetupWorkspace } from "@/components/admin/admin-academic-setup-workspace";
import { SchoolSettingsWorkspace } from "@/components/admin/school-settings-workspace";
import { AdminAttendanceWorkspace } from "@/components/admin/admin-attendance-workspace";
import { OfficialAttendanceReports } from "@/components/admin/official-attendance-reports";
import { AuditHistoryWorkspace } from "@/components/admin/audit-history-workspace";
import { GuardianInvitationsWorkspace } from "@/components/admin/guardian-invitations-workspace";
import { GuardianContactSettings } from "@/components/family/guardian-contact-settings";
import { FamilyExamSchedule } from "@/components/family/family-exam-schedule";
import { FamilyFeeDueDetail, FamilyFeePaymentDetail } from "@/components/family/family-fee-notification-detail";
import { FamilyHomeworkDetail } from "@/components/family/family-homework-detail";
import { FamilyNotificationInbox } from "@/components/family/family-notification-inbox";
import { TeacherDirectoryWorkspace } from "@/components/admin/teacher-directory-workspace";
import { StudentRosterWorkspace } from "@/components/admin/student-roster-workspace";
import { ParentDirectoryWorkspace } from "@/components/admin/parent-directory-workspace";
import { AdminDemoWorkspace } from "@/components/admin/admin-demo-workspace";
import type { AdminDemoModule } from "@/lib/admin/admin-demo-service";
import { TeacherAttendanceRegister } from "@/components/academic/teacher-attendance-register";
import { FamilyAttendanceRegister } from "@/components/academic/family-attendance-register";
import { FamilyReceipts } from "@/components/finance/family-receipts";
import { AdvanceCreditWorkspace } from "@/components/finance/advance-credit-workspace";
import { FamilyAdvanceCredit } from "@/components/finance/family-advance-credit";
import { TeacherAssignmentsWorkspace } from "@/components/academic/teacher-assignments-workspace";
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
  const router = useRouter();
  const moduleName = String(params?.module || "");
  const exactHomework = moduleName === "homework" && searchParams.has("activity");
  const exactFee = moduleName === "invoices" && searchParams.has("fee");
  const exactPayment = moduleName === "invoices" && searchParams.has("payment");
  const exactInvoice = exactFee || exactPayment;
  const exactExam = moduleName === "exams" && searchParams.has("assessment");
  const studentExamView = moduleName === "exams" && (exactExam || searchParams.get("view") === "student");
  const guardianView = (exactHomework || ["attendance", "notifications", "notices", "profile", "advance-credit", "invoices", "student-leave", "timetable", "exams", "results", "result-report", "published-results",
    "class-logs", "classwork", "homework", "assignments", "projects", "study-material", "missed-activities"].includes(moduleName))
    && searchParams.get("view") === "guardian";
  const scopedRole = guardianView ? "parent" : exactHomework || exactInvoice || studentExamView ? "student" : null;
  const initialChildId = searchParams.get("child") ?? undefined;
  const initialAssessmentId = searchParams.get("assessment") ?? undefined;
  const initialRequestId = searchParams.get("request") ?? undefined;
  const accessKey = guardianView ? `${moduleName}?view=guardian`
    : exactHomework ? `${moduleName}?activity` : exactInvoice || studentExamView ? `${moduleName}?family` : moduleName;
  const [access, setAccess] = useState<{
    key: string;
    role: UiRole | null;
    userId: string | null;
    notificationSchoolId?: string | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    let active = true;
    let generation = 0;
    let currentUserId: string | null = null;
    let authTimer: ReturnType<typeof setTimeout> | undefined;
    const modulePath = `/modules/${moduleName}${searchParams.size ? `?${searchParams.toString()}` : ""}`;
    const loadRole = async () => {
      if (!active) return;
      const request = ++generation;
      const isCurrent = () => active && request === generation;
      try {
        const verified = await readActiveSchoolAccess(supabase);
        if (!isCurrent()) return;
        if (!verified) {
          currentUserId = null;
          setAccess(null);
          router.replace(loginPath(modulePath));
          return;
        }
        currentUserId = verified.userId;
        const roles = verified.roles;
        const role = scopedRole
          ? roles.some((row) => row.role === scopedRole && row.school_id === verified.profileSchoolId) ? scopedRole : null
          : resolveModuleRole(roles, verified.profileSchoolId, moduleName);
        if (!role || !canAccessModule(role, moduleName)) {
          // No role for this module, or a deep link meant for another role: open the account's role-based home.
          setAccess(null);
          router.replace("/dashboard");
          return;
        }
        setAccess({
          key: accessKey,
          role,
          userId: verified.userId,
          notificationSchoolId: moduleName === "notifications" && roles.some((row) =>
            row.school_id === verified.profileSchoolId && (row.role === "school_admin" || row.role === "principal"))
            ? verified.profileSchoolId : null,
          error: null,
        });
      } catch (error) {
        if (isCurrent() && error instanceof StaffMfaRequiredError) {
          setAccess(null);
          router.replace(mfaPath(modulePath));
          return;
        }
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
      if (event === "SIGNED_OUT") {
        // Signing out is not a way back to this page: go to a clean sign-in.
        currentUserId = null;
        setAccess(null);
        clearTimeout(authTimer);
        router.replace("/login");
        return;
      }
      if (session?.user.id !== currentUserId) {
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
  }, [accessKey, moduleName, router, scopedRole, searchParams]);

  // Unknown slugs get the app 404; "result-report" is the legacy alias canAccessModule maps to "results".
  if (moduleName !== "result-report" && !modules.some((module) => module.key === moduleName)) notFound();
  if (!access || access.key !== accessKey) return <ModuleLoading />;
  if (access.error || !access.role || !access.userId) {
    // Same frame as app/not-found.tsx: a failed access check gets a calm page with a way forward.
    return (
      <div className="not-found-page">
        <div className="not-found-frame">
          <header className="login-brand not-found-brand">
            <BrandLogo size={40} />
            <div><p className="login-brand-name">SMS</p><p className="login-brand-caption">School Management System</p></div>
          </header>
          <main className="not-found-main">
            <h1 className="not-found-title">We couldn’t open this page</h1>
            <p role="alert" className="not-found-text">{access.error ?? "Your access could not be verified."}</p>
            <div className="not-found-actions">
              <button type="button" className="login-submit" onClick={() => window.location.reload()}>Try again</button>
              <Link href="/login" className="login-google">Return to sign in</Link>
            </div>
          </main>
        </div>
      </div>
    );
  }
  const verifiedUserId = access.userId;

  if ((moduleName === "published-results" || ((access.role === "parent" || access.role === "student")
    && (moduleName === "results" || moduleName === "result-report")))
    && (access.role === "admin" || access.role === "principal" || access.role === "teacher" || access.role === "parent" || access.role === "student")) {
    return <AppShell key={access.userId} userId={access.userId} role={access.role}><ResultPublicationWorkspace role={access.role} userId={access.userId} initialChildId={initialChildId} initialAssessmentId={initialAssessmentId} /></AppShell>;
  }

  if (moduleName === "student-leave" && (access.role === "student" || access.role === "parent" || access.role === "admin" || access.role === "principal")) {
    return (
      <AppShell key={access.userId} userId={access.userId} role={access.role}>
        <StudentLeaveWorkspace role={access.role} userId={access.userId} initialChildId={initialChildId} initialRequestId={initialRequestId} />
      </AppShell>
    );
  }

  if (moduleName === "timetable" && (access.role === "admin" || access.role === "principal" || access.role === "teacher" || access.role === "parent" || access.role === "student")) {
    return (
      <AppShell key={access.userId} userId={access.userId} role={access.role}>
        <TimetableWorkspace key={`${access.role}:${access.userId}`} role={access.role} userId={access.userId} />
      </AppShell>
    );
  }

  if (moduleName === "attendance") {
    if (access.role === "admin" || access.role === "principal") {
      return <AppShell key={access.userId} userId={access.userId} role={access.role}><AdminAttendanceWorkspace key={`${access.userId}:${access.role}`} principal={access.role === "principal"} /></AppShell>;
    }
    if (access.role === "teacher") {
      return <AppShell key={access.userId} userId={access.userId} role="teacher"><TeacherAttendanceRegister /></AppShell>;
    }
    if (access.role === "student" || access.role === "parent") {
      return (
        <AppShell key={access.userId} userId={access.userId} role={access.role}>
          <FamilyAttendanceRegister key={`${access.role}:${access.userId}`} role={access.role} userId={access.userId}
            initialChildId={initialChildId} />
        </AppShell>
      );
    }
    return (
      <AppShell key={access.userId} userId={access.userId} role={access.role}>
        <section className="card space-y-3 p-5">
          <h1 className="text-xl font-bold">Attendance</h1>
          <p className="text-sm muted">Your attendance summary is available on the dashboard. The detailed read-only register is part of the next phase.</p>
          <a href="/dashboard" className="inline-block text-sm font-semibold text-blue-600">View dashboard</a>
        </section>
      </AppShell>
    );
  }

  if (exactHomework && (access.role === "student" || access.role === "parent")) {
    const activities = searchParams.getAll("activity");
    return (
      <AppShell key={access.userId} userId={access.userId} role={access.role}>
        <FamilyHomeworkDetail activityId={activities.length === 1 ? activities[0] : ""} userId={access.userId} role={access.role} />
      </AppShell>
    );
  }

  if ((moduleName === "classwork" || moduleName === "homework") && access.role === "teacher") {
    return (
      <AppShell key={access.userId} userId={access.userId} role="teacher">
        <TeacherAcademicActivityWorkspace module={moduleName} />
      </AppShell>
    );
  }

  if (moduleName === "academics" && (access.role === "admin" || access.role === "principal")) {
    return <AppShell key={access.userId} userId={access.userId} role={access.role}><AdminAcademicSetupWorkspace key={access.userId} userId={access.userId} /></AppShell>;
  }

  if (moduleName === "exams" && (access.role === "student" || access.role === "parent")) {
    const assessments = searchParams.getAll("assessment");
    const assessmentId = exactExam ? assessments.length === 1 ? assessments[0] : "" : undefined;
    return (
      <AppShell key={access.userId} userId={access.userId} role={access.role}>
        <FamilyExamSchedule assessmentId={assessmentId} userId={access.userId} role={access.role} />
      </AppShell>
    );
  }

  if (access.role === "admin" && moduleName === "exams") {
    return <AppShell key={access.userId} userId={access.userId} role="admin"><AdminAssessmentWorkspace mode="exams" /></AppShell>;
  }

  if (access.role === "admin" && (moduleName === "results" || moduleName === "result-report")) {
    return <AppShell key={access.userId} userId={access.userId} role="admin"><AdminAssessmentWorkspace mode="results" /></AppShell>;
  }

  if (moduleName === "notices") {
    const noticeId = searchParams.get("notice");
    const announcement = noticeId && (access.role === "parent" || access.role === "student")
      ? { id: noticeId, userId: access.userId, role: access.role } : undefined;
    return (
      <AppShell key={access.userId} userId={access.userId} role={access.role}>
        {access.role === "admin" || access.role === "principal"
          ? <AdminNoticesWorkspace key={access.userId} />
          : <NoticeInbox key={`${access.userId}:${access.role}:${announcement?.id ?? ""}`} announcement={announcement} />}
      </AppShell>
    );
  }

  if ((access.role === "admin" || access.role === "principal" || access.role === "finance") && moduleName === "fees") {
    const schoolId = searchParams.get("school") ?? undefined;
    return <AppShell key={access.userId} userId={access.userId} role={access.role}><AdminFinanceWorkspace key={`${access.userId}:${schoolId ?? "default"}`} mode="fees" requestedSchoolId={schoolId} /></AppShell>;
  }

  if (moduleName === "advance-credit") {
    if (access.role === "admin" || access.role === "principal" || access.role === "finance") {
      return <AppShell key={access.userId} userId={access.userId} role={access.role}><AdvanceCreditWorkspace key={access.userId} userId={access.userId} /></AppShell>;
    }
    if (access.role === "parent" || access.role === "student") {
      return <AppShell key={access.userId} userId={access.userId} role={access.role}><FamilyAdvanceCredit key={`${access.role}:${access.userId}`} role={access.role} userId={access.userId} /></AppShell>;
    }
  }

  if (exactInvoice && (access.role === "student" || access.role === "parent")) {
    const targets = searchParams.getAll(exactPayment ? "payment" : "fee");
    const children = searchParams.getAll("child");
    const targetId = targets.length === 1 && !(exactFee && exactPayment) ? targets[0] : "";
    const studentId = children.length === 1 ? children[0] : "";
    return (
      <AppShell key={access.userId} userId={access.userId} role={access.role}>
        {exactPayment
          ? <FamilyFeePaymentDetail paymentId={targetId} studentId={studentId} role={access.role} userId={access.userId} />
          : <FamilyFeeDueDetail feeId={targetId} studentId={studentId} role={access.role} userId={access.userId} />}
      </AppShell>
    );
  }

  if ((access.role === "admin" || access.role === "principal" || access.role === "finance") && moduleName === "invoices") {
    const receipt = searchParams.get("receipt") ?? "";
    const tab = searchParams.get("tab") === "receipts" ? "receipts" : "invoices";
    const schoolId = searchParams.get("school") ?? undefined;
    return <AppShell key={access.userId} userId={access.userId} role={access.role}><AdminFinanceWorkspace key={`${access.userId}:${schoolId ?? "default"}:${receipt}:${tab}`} mode="invoices" initialReceiptNo={receipt} initialTab={tab} requestedSchoolId={schoolId} /></AppShell>;
  }

  if ((access.role === "admin" || access.role === "principal" || access.role === "finance") && moduleName === "finance-reports") {
    const schoolId = searchParams.get("school") ?? undefined;
    return <AppShell key={access.userId} userId={access.userId} role={access.role}><AdminFinanceWorkspace key={`${access.userId}:${schoolId ?? "default"}`} mode="reports" requestedSchoolId={schoolId} /></AppShell>;
  }

  if (moduleName === "invoices" && (access.role === "student" || access.role === "parent")) {
    return (
      <AppShell key={access.userId} userId={access.userId} role={access.role}>
        <FamilyReceipts key={`${access.role}:${access.userId}`} role={access.role} userId={access.userId} />
      </AppShell>
    );
  }

  if (moduleName === "notifications" && (access.role === "parent" || access.role === "student")) {
    return (
      <AppShell key={access.userId} userId={access.userId} role={access.role}>
        <div className="space-y-5">
          <h1 className="text-3xl font-black">Notifications</h1>
          <FamilyNotificationInbox key={`${access.userId}:${access.role}`} userId={access.userId} role={access.role} />
        </div>
      </AppShell>
    );
  }

  if (moduleName === "notifications" && (access.role === "admin" || access.role === "principal")) {
    return <AppShell key={access.userId} userId={access.userId} role={access.role}>
      {access.notificationSchoolId
        ? <AdminNotificationDelivery key={`${access.userId}:${access.notificationSchoolId}`} userId={access.userId} schoolId={access.notificationSchoolId} />
        : <p role="alert" className="card p-5 text-sm">An active school assignment as School Admin or Principal is required to view mobile push delivery.</p>}
    </AppShell>;
  }

  if (moduleName === "profile" && access.role === "parent") {
    return (
      <AppShell key={access.userId} userId={access.userId} role="parent">
        <GuardianContactSettings key={access.userId} userId={access.userId} callbackStatus={searchParams.get("contact")} />
      </AppShell>
    );
  }

  if (moduleName === "guardian-invitations" && (access.role === "admin" || access.role === "principal")) {
    return (
      <AppShell key={access.userId} userId={access.userId} role={access.role}>
        <GuardianInvitationsWorkspace key={access.userId} userId={access.userId} />
      </AppShell>
    );
  }

  if ((moduleName === "students" || moduleName === "admissions") && (access.role === "admin" || access.role === "principal")) {
    return (
      <AppShell key={access.userId} userId={access.userId} role={access.role}>
        <StudentRosterWorkspace key={`${access.userId}:${moduleName}`} userId={access.userId} view={moduleName === "admissions" ? "admissions" : "students"} />
      </AppShell>
    );
  }

  if (moduleName === "parents" && (access.role === "admin" || access.role === "principal")) {
    return <AppShell key={access.userId} userId={access.userId} role={access.role}><ParentDirectoryWorkspace key={access.userId} userId={access.userId} /></AppShell>;
  }

  if (moduleName === "teachers" && (access.role === "admin" || access.role === "principal")) {
    return <AppShell key={access.userId} userId={access.userId} role={access.role}><TeacherDirectoryWorkspace key={access.userId} userId={access.userId} /></AppShell>;
  }

  if (moduleName === "audit-logs" && (access.role === "admin" || access.role === "principal")) {
    return <AppShell key={access.userId} userId={access.userId} role={access.role}><AuditHistoryWorkspace key={access.userId} userId={access.userId} /></AppShell>;
  }

  if (moduleName === "reports" && (access.role === "admin" || access.role === "principal")) {
    return <AppShell key={access.userId} userId={access.userId} role={access.role}><OfficialAttendanceReports key={`${access.userId}:${access.role}`} userId={access.userId} role={access.role} /></AppShell>;
  }

  if (moduleName === "settings" && (access.role === "admin" || access.role === "principal")) {
    return <AppShell key={access.userId} userId={access.userId} role={access.role}><SchoolSettingsWorkspace key={access.userId} userId={access.userId} /></AppShell>;
  }

  if (access.role === "admin" && [
    "events",
    "library", "transport", "inventory", "hr-payroll", "leave", "profile", "documents",
  ].includes(moduleName)) {
    return <AppShell key={access.userId} userId={access.userId} role="admin"><AdminDemoWorkspace module={moduleName as AdminDemoModule} /></AppShell>;
  }

  if (["class-logs", "classwork", "homework", "assignments", "projects", "study-material", "missed-activities"].includes(moduleName)) {
    return <AcademicWorkspace module={moduleName} role={access.role} />;
  }

  if (moduleName === "teacher-assignments") {
    return <AppShell key={access.userId} userId={access.userId} role={access.role}>
      <TeacherAssignmentsWorkspace key={access.userId} userId={access.userId} showCoverage={access.role === "admin" || access.role === "principal"} />
    </AppShell>;
  }

  if (access.role === "teacher") {
    const renderTeacherModule = (teacherModule: "exams" | "results" | "profile") => (
      <AppShell key={verifiedUserId} userId={verifiedUserId} role="teacher"><TeacherModuleView module={teacherModule} /></AppShell>
    );
    if (moduleName === "exams") return renderTeacherModule("exams");
    if (moduleName === "results" || moduleName === "result-report") return renderTeacherModule("results");
    if (moduleName === "profile") return renderTeacherModule("profile");
  }

  if (access.role === "admin") {
    return <AppShell key={access.userId} userId={access.userId} role="admin"><AdminModulePlaceholder moduleName={moduleName} /></AppShell>;
  }

  // Safety net for a key a role lists but no branch implements: stay inside the shell, themed.
  return (
    <AppShell key={access.userId} userId={access.userId} role={access.role}>
      <section className="card p-5">
        <h1 className="text-xl font-bold">{moduleName.replace(/-/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())}</h1>
        <p className="mt-2 text-sm muted">This page is not available for your role yet.</p>
      </section>
    </AppShell>
  );
}
