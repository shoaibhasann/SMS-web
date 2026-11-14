 "use client";

 import Link from "next/link";
 import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  BookOpen,
  CalendarCheck,
  ClipboardList,
  Clock3,
  FileText,
  GraduationCap,
  IndianRupee,
  NotebookPen,
  Plus,
  RefreshCw,
  School,
  UserRound,
  Users,
} from "lucide-react";
import "./dashboard.css";
import { DashboardActions, DashboardGreeting, DashboardIdentity, DashboardMetric, DashboardPanel, DashboardViewAll, AttendanceComposition, AttendanceSegments, RecentLogChart, attendanceStatusStyles } from "./dashboard-primitives";
import { AppShell } from "@/components/layout/app-shell";
import { createClient } from "@/lib/supabase/client";
import { roleLabel, type UiRole } from "@/lib/auth/roles";
import { getNavigationModules } from "@/lib/modules";
import { AttendanceEditor } from "@/components/academic/attendance-editor";
import { AttendanceClassBadge, AttendanceClassPicker } from "@/components/academic/attendance-class-choice";
import { loadEffectiveAttendanceAssignments, type EffectiveAttendanceAssignment } from "@/lib/assignments/attendance-coverage";
import { hasAttendanceScope, useAttendanceAccessRevalidation } from "@/lib/assignments/use-attendance-access";
import { AdminFinanceWorkspace } from "@/components/admin/admin-finance-workspace";
import { GuardianAttendanceAlerts } from "@/components/family/guardian-attendance-alerts";
import { OfficialAttendanceSummary } from "@/components/family/official-attendance-summary";
import { AttendanceSubmissionMonitor } from "@/components/admin/attendance-submission-monitor";
import {
  guardianAttendancePath,
  loadFamilyAttendance,
  loadFamilyStudents,
  rememberFamilyChild,
  restoreFamilyChild,
  type FamilyAttendanceRow,
  type FamilyStudent,
} from "@/lib/attendance/family";
import { attendanceLabels, schoolDate, type AttendanceStatus } from "@/lib/attendance/types";
import { loadSchoolAttendanceCounts, type AttendanceCounts } from "@/lib/dashboard/attendance";
import { upcomingAssessmentEndDate } from "@/lib/dashboard/dates";
import { formatFeeBillingPeriod, formatFeeMoney, type FeeLedgerRow, type FeeMoney } from "@/lib/finance/fee-batches";
import { getFamilyFeeLedger, getOfficeFinanceSummary } from "@/lib/finance/fee-changes";
import { LoadingState, Skeleton } from "@/components/ui/skeleton";
import { listResultSubmissions, type PublicationSummary } from "@/lib/result-publication";

type Assignment = {
  id: string;
  academic_year_id: string;
  class_id: string;
  section_id: string | null;
  subject_id: string;
  is_class_teacher: boolean;
  className?: string;
  sectionName?: string;
  subjectName?: string;
  coverage_id?: string | null;
  starts_on?: string | null;
  ends_on?: string | null;
};

type StudentRow = {
  id: string;
  admission_no: string;
  first_name: string;
  middle_name?: string | null;
  last_name?: string | null;
  roll_no?: string | null;
  dob?: string | null;
  status: string;
};

type TeacherRow = { id: string; school_id: string; full_name: string | null };
type NamedRow = { id: string; name: string };
type NoticeRow = { id: string; title: string; content: string; published_at: string | null; created_at: string | null; version: string };
type EnrollmentRow = {
  class_id: string;
  section_id: string | null;
  academic_year_id: string;
  roll_no: string | null;
  classes: { name: string } | null;
  sections: { name: string } | null;
};
type StudentDashboardData = {
  student: FamilyStudent | null;
  enrollment: EnrollmentRow | null;
  attendance: FamilyAttendanceRow[];
  attendanceError: boolean;
  logs: LogRow[];
  logCount: number | null;
  activities: ActivityRow[];
  enrollmentError: boolean;
  learningError: boolean;
  fees: FeeLedgerRow[];
  feesError: boolean;
  feeCount: number | null;
};
const emptyStudentDashboard: StudentDashboardData = {
  student: null, enrollment: null, attendance: [], attendanceError: false, logs: [], logCount: null, activities: [], enrollmentError: false, learningError: false, fees: [], feesError: false, feeCount: null,
};

type LogRow = {
  id: string;
  log_date: string;
  topic: string;
  academic_year_id: string;
  status?: string;
  summary?: string | null;
  teacher_remark?: string | null;
  class_id: string;
  section_id?: string | null;
  subject_id: string;
};

type ActivityRow = {
  id: string;
  class_log_id: string;
  activity_type: string;
  title: string;
  description?: string | null;
  due_date?: string | null;
};

type TeacherAssessmentRow = {
  id: string;
  name: string;
  assessment_date: string;
  maximum_marks: number;
  class_id: string;
  section_id: string | null;
  subject_id: string;
};

type TeacherMarkActivity = {
  id: string;
  assessmentName: string;
  studentName: string;
  marks: number;
  maximum: number;
};

type AttendanceOverviewRow = {
  student_id: string;
  section_id: string;
  academic_year_id: string;
  attendance_date: string;
  status: string;
};

type TeacherDisplayNames = {
  classes: Record<string, string>;
  sections: Record<string, string>;
  subjects: Record<string, string>;
};

type AdminOverviewLog = {
  id: string;
  log_date: string;
  topic: string;
  class_id: string;
  section_id: string | null;
  subject_id: string;
  status: string | null;
};

type AdminOverviewActivity = {
  id: string;
  class_log_id: string;
  activity_type: string;
  title: string;
  due_date: string | null;
};

type AdminOverviewAssessment = {
  id: string;
  name: string;
  assessment_date: string;
  maximum_marks: number;
  class_id: string;
  section_id: string | null;
  subject_id: string;
};

type AssessmentRead = { data: AdminOverviewAssessment[] | null; error: unknown; count?: number | null };

// Principals are denied raw teacher_assessments rows; their schedule comes from a read-only RPC.
async function loadPrincipalUpcoming(supabase: ReturnType<typeof createClient>, schoolId: string, from: string, to: string): Promise<AssessmentRead> {
  const { data, error } = await supabase.rpc("list_principal_upcoming_assessments", { p_school_id: schoolId, p_from: from, p_to: to });
  if (error) return { data: null, error };
  const page = data as { total_count?: unknown; rows?: unknown } | null;
  if (!page || typeof page.total_count !== "number" || !Array.isArray(page.rows)) return { data: null, error: new Error("Upcoming assessments were unreadable.") };
  return { data: page.rows as AdminOverviewAssessment[], error: null, count: page.total_count };
}

type AdminOverviewResult = {
  id: string;
  assessmentName: string;
  studentName: string;
  marks: number;
  maximum: number;
  classId: string;
  sectionId: string | null;
  subjectId: string;
};

type AdminOverview = {
  students: number | null;
  teachers: number | null;
  parents: number | null;
  classes: number | null;
  sections: number | null;
  attendanceToday: number | null;
  absentToday: number | null;
  attendanceStatuses: AttendanceCounts | null;
  activeTeachers: number | null;
  classesLoggedToday: number | null;
  upcomingExams: number | null;
  todayCollection: FeeMoney | null;
  monthCollection: FeeMoney | null;
  pendingFees: number | null;
  overdueFees: number | null;
};

function logAdminDashboardQueryError(queryName: string, error: unknown) {
  const details = error && typeof error === "object"
    ? error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown }
    : null;
  console.error(`[Admin Dashboard] Query failed: ${queryName}`, {
    message: details?.message,
    details: details?.details,
    hint: details?.hint,
    code: details?.code,
  });
}

const emptyAdminOverview: AdminOverview = {
  students: null,
  teachers: null,
  parents: null,
  classes: null,
  sections: null,
  attendanceToday: null,
  absentToday: null,
  attendanceStatuses: null,
  activeTeachers: null,
  classesLoggedToday: null,
  upcomingExams: null,
  todayCollection: null,
  monthCollection: null,
  pendingFees: null,
  overdueFees: null,
};

function nameOf(s: StudentRow) {
  return [s.first_name, s.middle_name, s.last_name].filter(Boolean).join(" ");
}

function dateToday() {
  return schoolDate();
}

const dateOptions = { day: "numeric", month: "short", year: "numeric" } as const;
const schoolDateFormat = new Intl.DateTimeFormat("en-IN", { ...dateOptions, timeZone: "UTC" });
const istTimestampFormat = new Intl.DateTimeFormat("en-IN", { ...dateOptions, timeZone: "Asia/Kolkata" });

function displayDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : schoolDateFormat.format(date);
}

// Timestamps show their IST calendar day, not their UTC date.
function displayTimestamp(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : istTimestampFormat.format(date);
}

const logStatusPill = (status?: string | null) => status === "draft" ? "badge text-warning" : "badge text-success";

function Card({ title, icon, children, right, preview = true }: { title: string; icon?: React.ReactNode; children: React.ReactNode; right?: React.ReactNode; preview?: boolean }) {
  return <DashboardPanel title={title} icon={icon ?? <School size={18} />} right={right} preview={preview}>{children}</DashboardPanel>;
}
function Stat({ label, value, tone = "blue", loading = false, context }: { label: string; value: string | number; tone?: "blue" | "green" | "orange" | "purple"; loading?: boolean; context?: string }) {
  const icon = tone === "green" ? CalendarCheck : tone === "orange" ? IndianRupee : tone === "purple" ? ClipboardList : BookOpen;
  return <DashboardMetric label={label} value={value} icon={icon} loading={loading} tone={tone === "purple" ? "violet" : tone === "orange" ? "amber" : tone} featured={tone === "green"} context={context ?? (tone === "green" ? "Saved record sample (up to 60); not an official rate" : "Available school records")} />;
}

export function RoleDashboard({
  role,
  schoolId,
  userId,
  hasGuardianRole,
  schoolRoles,
}: {
  role: UiRole;
  schoolId: string | null;
  userId: string;
  hasGuardianRole?: boolean;
  /** The account's roles in its profile school, for the same module union the navigation shows. */
  schoolRoles?: readonly (UiRole | null)[];
}) {
  return (
    <AppShell key={userId} userId={userId} role={role}>
      <div className="sms-dashboard">
      {hasGuardianRole && role !== "parent" && (
        <Link href={guardianAttendancePath}
          className="mb-5 inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm font-semibold">
          <CalendarCheck size={18} aria-hidden="true" />
          View guardian attendance
        </Link>
      )}
      {role === "teacher" ? (
        <TeacherDashboard key={`${userId}:${schoolId}`} userId={userId} />
      ) : role === "finance" ? (
        <AdminFinanceWorkspace key={`${userId}:${schoolId}`} mode="fees" />
      ) : role === "student" ? (
        <StudentDashboard key={`${userId}:${schoolId}`} userId={userId} />
      ) : role === "parent" ? (
        <ParentDashboard key={`${userId}:${schoolId}`} userId={userId} />
      ) : role === "reception" ? (
        <ReceptionDashboard />
      ) : (
        <AdminDashboard key={`${userId}:${schoolId}`} schoolId={schoolId} userId={userId} role={role} schoolRoles={schoolRoles} />
      )}
      </div>
    </AppShell>
  );
}

function ReceptionDashboard() {
  const links = [
    { href: "/modules/notices", label: "Notices", detail: "School notices" },
  ];

  return (
    <div className="space-y-6 dashboard-role-flow">
      <Header role="reception" subtitle="Quick access to school notices available to Reception." />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {links.map((link) => (
          <Link key={link.href} href={link.href} className="card p-5 transition hover:-translate-y-0.5 hover:shadow-md">
            <div className="font-bold">{link.label}</div>
            <div className="mt-1 text-sm muted">{link.detail}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function Header({ role, subtitle }: { role: UiRole; subtitle: string }) {
  const titles: Record<UiRole, string> = { teacher: "Teacher Dashboard", finance: "Finance Dashboard", student: "Student Dashboard", parent: "Guardian Dashboard", reception: "School office", principal: "Principal Dashboard", admin: "School Dashboard" };
  return <DashboardGreeting eyebrow={`${roleLabel(role)} workspace`} title={titles[role]} description={subtitle}
    href={role === "student" ? "/modules/homework" : role === "parent" ? guardianAttendancePath : role === "reception" ? "/modules/notices" : "/modules/students"}
    action={role === "student" ? "View homework" : role === "parent" ? "Attendance history" : role === "reception" ? "School notices" : "Student directory"} />;
}

function toAttendanceChoice(item: EffectiveAttendanceAssignment): Assignment & EffectiveAttendanceAssignment {
  return { ...item, className: item.class_name, sectionName: item.section_name, subjectName: item.subject_name };
}

function TeacherDashboard({ userId }: { userId: string }) {
  const [supabase] = useState(createClient);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [teacher, setTeacher] = useState<TeacherRow | null>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [assignmentsUnavailable, setAssignmentsUnavailable] = useState(false);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [activities, setActivities] = useState<ActivityRow[]>([]);
  const [displayNames, setDisplayNames] = useState<TeacherDisplayNames>({ classes: {}, sections: {}, subjects: {} });
  const [todayAttendanceRows, setTodayAttendanceRows] = useState<AttendanceOverviewRow[]>([]);
  const [attendanceOverviewUnavailable, setAttendanceOverviewUnavailable] = useState(false);
  const [monthlyLogCount, setMonthlyLogCount] = useState<number | null>(null);
  const [monthlyHomeworkCount, setMonthlyHomeworkCount] = useState<number | null>(null);
  const [upcomingAssessments, setUpcomingAssessments] = useState<TeacherAssessmentRow[] | null>([]);
  const [recentActivityUnavailable, setRecentActivityUnavailable] = useState(false);
  const [recentMarks, setRecentMarks] = useState<TeacherMarkActivity[]>([]);
  const [teacherNotices, setTeacherNotices] = useState<NoticeRow[] | null>([]);
  const [editingNotice, setEditingNotice] = useState<NoticeRow | null>(null);
  const [classTeacherAssignments, setClassTeacherAssignments] = useState<(Assignment & EffectiveAttendanceAssignment)[]>([]);
  const [selectedAssignment, setSelectedAssignment] = useState("");
  const [attendanceLocked, setAttendanceLocked] = useState(false);
  const [noticeTitle, setNoticeTitle] = useState("");
  const [noticeContent, setNoticeContent] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(true);

  const currentAssignment = useMemo(
    () => classTeacherAssignments.find((a) => a.id === selectedAssignment),
    [classTeacherAssignments, selectedAssignment]
  );
  const attendanceOptions = classTeacherAssignments.filter((assignment) => assignment.section_id)
    .map((a) => ({ id: a.id, label: `${a.className} ${a.sectionName}`, coverage: Boolean(a.coverage_id) }));

  function refresh() {
    setBusy(true);
    setMessage("");
    setReloadVersion((version) => version + 1);
  }

  const attendanceUnverified = useAttendanceAccessRevalidation({ client: supabase, enabled: !busy && Boolean(teacher), assignments: classTeacherAssignments,
    locked: attendanceLocked,
    onChanged: (current) => {
      // Keep the open register (and its draft) when only other scopes changed.
      if (currentAssignment && hasAttendanceScope(current, currentAssignment)) {
        setClassTeacherAssignments(current.filter((item) => item.academic_year_id === currentAssignment.academic_year_id).map(toAttendanceChoice));
        return;
      }
      setClassTeacherAssignments([]); setSelectedAssignment(""); setAttendanceLocked(false); refresh();
    },
    onUnavailable: () => {
      setClassTeacherAssignments([]); setSelectedAssignment(""); setAttendanceLocked(false);
      setTodayAttendanceRows([]); setAttendanceOverviewUnavailable(true);
      setMessage("Attendance access could not be verified. Reopen this page to check your access.");
    },
  });

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      const today = schoolDate();
      const { data: t, error: teacherError } = await supabase.from("teachers").select("*").eq("profile_id", userId).returns<TeacherRow[]>().maybeSingle();
      if (controller.signal.aborted) return;
      if (teacherError) {
        setTeacher(null);
        setMessage("Your teacher profile could not be loaded. Refresh to try again.");
        setBusy(false);
        return;
      }
      if (!t) {
        setTeacher(null);
        setMessage("Teacher profile is not linked to this Google account. Ask the school admin to create/link the teacher record.");
        setBusy(false);
        return;
      }
      setTeacher(t);

      const { data: currentYear, error: currentYearError } = t.school_id
        ? await supabase.from("academic_years").select("id").eq("school_id", t.school_id).eq("is_current", true).maybeSingle()
        : { data: null, error: null };
      if (controller.signal.aborted) return;
      if (currentYearError || !currentYear?.id) {
        setMessage("Attendance is unavailable because the current academic year could not be verified. Ask the school administrator.");
      }
      const { data: a, error: assignmentError } = currentYear?.id && !currentYearError
        ? await supabase.from("teacher_subject_assignments").select("*").eq("teacher_id", t.id).eq("academic_year_id", currentYear.id)
        : { data: [], error: null };
      if (controller.signal.aborted) return;
      if (assignmentError) setMessage("Teacher assignments could not be loaded. Reload before recording attendance.");
      setAssignmentsUnavailable(Boolean(currentYearError || assignmentError));
      const rows = (a ?? []) as Assignment[];
      const classIds = [...new Set(rows.map((x) => x.class_id))];
      const sectionIds = [...new Set(rows.map((x) => x.section_id).filter(Boolean))] as string[];
      const subjectIds = [...new Set(rows.map((x) => x.subject_id))];

      const [{ data: cs }, { data: ss }, { data: subs }] = await Promise.all([
        classIds.length ? supabase.from("classes").select("id,name").in("id", classIds).returns<NamedRow[]>() : Promise.resolve({ data: [] as NamedRow[] }),
        sectionIds.length ? supabase.from("sections").select("id,name").in("id", sectionIds).returns<NamedRow[]>() : Promise.resolve({ data: [] as NamedRow[] }),
        subjectIds.length ? supabase.from("subjects").select("id,name").in("id", subjectIds).returns<NamedRow[]>() : Promise.resolve({ data: [] as NamedRow[] }),
      ]);
      if (controller.signal.aborted) return;
      const cmap = new Map((cs ?? []).map((x) => [x.id, x.name]));
      const smap = new Map((ss ?? []).map((x) => [x.id, x.name]));
      const submap = new Map((subs ?? []).map((x) => [x.id, x.name]));
      const enriched = rows.map((x) => ({
        ...x,
        className: cmap.get(x.class_id) ?? "Class",
        sectionName: x.section_id ? smap.get(x.section_id) ?? "Section" : "All Sections",
        subjectName: submap.get(x.subject_id) ?? "Subject",
      }));
      setAssignments(enriched);
      // Temporary cover applies only to attendance; academics continue using permanent assignments above.
      let eligibleAssignments: (Assignment & EffectiveAttendanceAssignment)[] = [];
      if (currentYear?.id && !currentYearError) {
        try {
          const effective = await loadEffectiveAttendanceAssignments(supabase);
          if (controller.signal.aborted) return;
          eligibleAssignments = effective.filter((item) => item.academic_year_id === currentYear.id).map(toAttendanceChoice);
        } catch {
          if (controller.signal.aborted) return;
          setMessage("Attendance assignments could not be verified. Refresh before recording attendance.");
        }
      }
      setClassTeacherAssignments(eligibleAssignments);
      setSelectedAssignment((selected) => eligibleAssignments.some((assignment) => assignment.id === selected)
        ? selected : eligibleAssignments[0]?.id ?? "");

      const { data: recentLogs, error: recentLogsError } = await supabase
        .from("class_logs")
        .select("id,log_date,topic,summary,teacher_remark,class_id,section_id,subject_id,academic_year_id,status")
        .eq("teacher_id", t.id)
        .order("log_date", { ascending: false })
        .limit(200);
      if (controller.signal.aborted) return;
      const recentLogRows = (recentLogs ?? []) as LogRow[];
      setLogs(recentLogRows);
      let activitiesError: unknown = null;

      const logIds = recentLogRows.map((x) => x.id);
      if (logIds.length) {
        const { data: acts, error: actsError } = await supabase
          .from("class_activities")
          .select("id,class_log_id,activity_type,title,description,due_date")
          .in("class_log_id", logIds)
          .limit(500);
        if (controller.signal.aborted) return;
        activitiesError = actsError;
        setActivities((acts ?? []) as ActivityRow[]);
      } else {
        setActivities([]);
      }
      setRecentActivityUnavailable(Boolean(recentLogsError || activitiesError));

      const logClassIds = [...new Set(recentLogRows.map((log) => log.class_id))];
      const logSectionIds = [...new Set(recentLogRows.map((log) => log.section_id).filter(Boolean))] as string[];
      const logSubjectIds = [...new Set(recentLogRows.map((log) => log.subject_id))];
      const [{ data: logClasses }, { data: logSections }, { data: logSubjects }] = await Promise.all([
        logClassIds.length ? supabase.from("classes").select("id,name").in("id", logClassIds) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
        logSectionIds.length ? supabase.from("sections").select("id,name").in("id", logSectionIds) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
        logSubjectIds.length ? supabase.from("subjects").select("id,name").in("id", logSubjectIds) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
      ]);
      if (controller.signal.aborted) return;
      setDisplayNames({
        classes: Object.fromEntries((logClasses ?? []).map((row) => [row.id, row.name])),
        sections: Object.fromEntries((logSections ?? []).map((row) => [row.id, row.name])),
        subjects: Object.fromEntries((logSubjects ?? []).map((row) => [row.id, row.name])),
      });

      const monthStart = `${today.slice(0, 7)}-01`;
      const { data: monthLogs, count: logCount, error: monthLogsError } = await supabase
        .from("class_logs")
        .select("id", { count: "exact" })
        .eq("teacher_id", t.id)
        .gte("log_date", monthStart)
        .lte("log_date", today);
      if (controller.signal.aborted) return;
      if (monthLogsError) {
        console.error("Teacher dashboard monthly academic logs could not be loaded", monthLogsError);
        setMonthlyLogCount(null);
        setMonthlyHomeworkCount(null);
      } else {
        setMonthlyLogCount(logCount ?? 0);
        const monthLogIds = (monthLogs ?? []).map((log) => log.id);
        if (monthLogIds.length) {
          const { count: homeworkCount, error: homeworkCountError } = await supabase
            .from("class_activities")
            .select("id", { count: "exact", head: true })
            .in("class_log_id", monthLogIds)
            .eq("activity_type", "homework");
          if (controller.signal.aborted) return;
          if (homeworkCountError) {
            console.error("Teacher dashboard monthly homework could not be loaded", homeworkCountError);
            setMonthlyHomeworkCount(null);
          } else {
            setMonthlyHomeworkCount(homeworkCount ?? 0);
          }
        } else {
          setMonthlyHomeworkCount(0);
        }
      }

      const assignedSectionIds = [...new Set(eligibleAssignments.map((assignment) => assignment.section_id).filter(Boolean))] as string[];
      const assignmentYearIds = [...new Set(eligibleAssignments.map((assignment) => assignment.academic_year_id))];
      setAttendanceOverviewUnavailable(false);
      if (assignedSectionIds.length && assignmentYearIds.length) {
        const { data: attendanceRows, error: attendanceError } = await supabase
          .from("attendance")
          .select("student_id,section_id,academic_year_id,attendance_date,status")
          .eq("school_id", t.school_id)
          .eq("marked_by", userId)
          .eq("attendance_date", today)
          .in("section_id", assignedSectionIds)
          .in("academic_year_id", assignmentYearIds)
          .limit(1000);
        if (controller.signal.aborted) return;
        if (attendanceError) {
          console.error("Teacher dashboard attendance summary could not be loaded", attendanceError);
          setTodayAttendanceRows([]);
          setAttendanceOverviewUnavailable(true);
        } else {
          setTodayAttendanceRows((attendanceRows ?? []) as AttendanceOverviewRow[]);
        }
      } else {
        setTodayAttendanceRows([]);
      }

      const { data: assessmentData, error: assessmentError } = await supabase
        .from("teacher_assessments")
        .select("id,name,assessment_date,maximum_marks,class_id,section_id,subject_id")
        .eq("teacher_id", t.id)
        .order("assessment_date", { ascending: false })
        .limit(50);
      if (controller.signal.aborted) return;
      if (assessmentError) {
        setMessage(`Assessment data could not be loaded: ${assessmentError.message}`);
        setUpcomingAssessments(null);
        setRecentMarks([]);
      } else {
        const teacherAssessments = (assessmentData ?? []) as TeacherAssessmentRow[];
        const weekEnd = upcomingAssessmentEndDate(today);
        const { data: upcomingData, error: upcomingError } = await supabase
          .from("teacher_assessments")
          .select("id,name,assessment_date,maximum_marks,class_id,section_id,subject_id")
          .eq("teacher_id", t.id)
          .gte("assessment_date", today)
          .lte("assessment_date", weekEnd)
          .order("assessment_date", { ascending: true })
          .limit(50);
        if (controller.signal.aborted) return;
        if (upcomingError) {
          console.error("Teacher dashboard upcoming tests could not be loaded", upcomingError);
          setUpcomingAssessments(null);
        } else {
          setUpcomingAssessments((upcomingData ?? []) as TeacherAssessmentRow[]);
        }
        const assessmentIds = teacherAssessments.map((assessment) => assessment.id);
        const { data: marksData, error: marksError } = assessmentIds.length
          ? await supabase.from("teacher_assessment_marks")
            .select("id,assessment_id,student_id,marks_obtained")
            .in("assessment_id", assessmentIds)
            .order("updated_at", { ascending: false })
            .limit(10)
          : { data: [], error: null };
        if (controller.signal.aborted) return;
        if (marksError) {
          setMessage(`Recent marks could not be loaded: ${marksError.message}`);
          setRecentMarks([]);
        } else {
          const marksRows = marksData ?? [];
          const markStudentIds = [...new Set(marksRows.map((mark) => mark.student_id))];
          const { data: markStudents, error: markStudentsError } = markStudentIds.length
            ? await supabase.from("students").select("id,first_name,middle_name,last_name").in("id", markStudentIds)
            : { data: [], error: null };
          if (controller.signal.aborted) return;
          if (markStudentsError) {
            setMessage(`Recent marks could not be loaded: ${markStudentsError.message}`);
            setRecentMarks([]);
          } else {
            const studentNames = new Map((markStudents ?? []).map((student) => [
              student.id,
              [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" "),
            ]));
            const assessmentsById = new Map(teacherAssessments.map((assessment) => [assessment.id, assessment]));
            setRecentMarks(marksRows.flatMap((mark) => {
              const assessment = assessmentsById.get(mark.assessment_id);
              return assessment ? [{
                id: mark.id,
                assessmentName: assessment.name,
                studentName: studentNames.get(mark.student_id) ?? "Student",
                marks: Number(mark.marks_obtained),
                maximum: Number(assessment.maximum_marks),
              }] : [];
            }));
          }
        }
      }

      const { data: notices, error: noticesError } = await supabase
        .from("notices")
        .select("id,title,content,published_at,created_at,version")
        .eq("created_by", userId)
        .order("created_at", { ascending: false })
        .limit(20).returns<NoticeRow[]>();
      if (controller.signal.aborted) return;
      setTeacherNotices(noticesError ? null : notices ?? []);

      setBusy(false);
    }
    void load();
    return () => controller.abort();
  }, [supabase, userId, reloadVersion]);

  async function saveNotice() {
    if (!teacher || !noticeTitle.trim() || !noticeContent.trim()) return;
    if (editingNotice) return updateOwnNotice(editingNotice, { title: noticeTitle.trim(), content: noticeContent.trim() }, "Notice updated.");
    setBusy(true);
    const { error } = await supabase.from("notices").insert({
      school_id: teacher.school_id,
      title: noticeTitle.trim(),
      content: noticeContent.trim(),
      audience: { roles: ["student", "parent"], teacher_id: teacher.id },
      published_at: new Date().toISOString(),
      created_by: userId,
    });
    setMessage(error ? error.message : "Notice published.");
    if (!error) {
      setNoticeTitle("");
      setNoticeContent("");
      setReloadVersion((version) => version + 1);
    }
    setBusy(false);
  }

  // RLS notices_teacher_own limits this to the teacher's own notices; the version guard rejects a stale tab.
  async function updateOwnNotice(notice: NoticeRow, changes: { title: string; content: string } | { published_at: null }, success: string) {
    setBusy(true);
    const { data, error } = await supabase.from("notices").update(changes)
      .eq("id", notice.id).eq("created_by", userId).eq("version", notice.version).select("id").maybeSingle();
    setMessage(error ? `Notice could not be saved: ${error.message}`
      : data ? success : "This notice changed since it was loaded and could not be saved. Refresh and try again.");
    if (!error && data) {
      // Withdrawing another notice keeps the edit in progress.
      if (editingNotice?.id === notice.id) {
        setEditingNotice(null);
        setNoticeTitle("");
        setNoticeContent("");
      }
      setReloadVersion((version) => version + 1);
    }
    setBusy(false);
  }

  function withdrawNotice(notice: NoticeRow) {
    if (!window.confirm(`Withdraw "${notice.title}"? It will be removed from family inboxes. Push alerts already delivered to phones cannot be recalled.`)) return;
    void updateOwnNotice(notice, { published_at: null }, "Notice withdrawn. It no longer appears in family inboxes; push alerts already delivered to phones cannot be recalled.");
  }

  function editNotice(notice: NoticeRow) {
    setEditingNotice(notice);
    setNoticeTitle(notice.title);
    setNoticeContent(notice.content);
  }

  const today = schoolDate();
  const todayLogRows = logs.filter((log) => log.log_date === today);
  const myClassCount = new Set(assignments.map((assignment) => `${assignment.class_id}:${assignment.section_id ?? ""}`)).size;
  const absentAttendanceRows = todayAttendanceRows.filter((row) => row.status === "absent");
  const absentStudentCount = new Set(absentAttendanceRows.map((row) => row.student_id)).size;
  const absentClassKeys = new Set(absentAttendanceRows.map((row) => `${row.section_id}:${row.academic_year_id}`));
  const missedLogs = todayLogRows.filter((log) =>
    log.section_id && absentClassKeys.has(`${log.section_id}:${log.academic_year_id}`),
  );
  const missedWorkCount = missedLogs.reduce((count, log) => {
    const logActivities = activities.filter((activity) => activity.class_log_id === log.id);
    return count + Math.max(logActivities.length, 1);
  }, 0);
  const weekEnd = upcomingAssessmentEndDate(today);
  const upcomingTestsThisWeek = upcomingAssessments?.filter((assessment) =>
    assessment.assessment_date >= today && assessment.assessment_date <= weekEnd,
  ).length ?? null;
  const nameForClass = (id: string) => displayNames.classes[id] ?? assignments.find((assignment) => assignment.class_id === id)?.className ?? "Class";
  const nameForSection = (id: string | null | undefined) => id ? displayNames.sections[id] ?? assignments.find((assignment) => assignment.section_id === id)?.sectionName ?? "Section" : "Section";
  const nameForSubject = (id: string) => displayNames.subjects[id] ?? assignments.find((assignment) => assignment.subject_id === id)?.subjectName ?? "Subject";
  const formatActivityType = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  const recentLogs = logs.slice(0, 8);

  if (busy) return <LoadingState variant="dashboard" label="Loading your teaching dashboard…" />;

  const header = <>
      <DashboardGreeting eyebrow="Teacher Dashboard" title={`Welcome back, ${teacher?.full_name || "Teacher"}`} description="Your classes, school work and attendance in one place." href="/modules/attendance" action="Open attendance">
        <button type="button" onClick={refresh} disabled={busy || attendanceLocked} className="dashboard-refresh"><RefreshCw size={15} className={busy ? "animate-spin" : ""} aria-hidden="true" />Refresh</button>
      </DashboardGreeting>

      {message && (
        <div className={`rounded-2xl border p-4 text-sm ${message.toLowerCase().includes("failed") || message.toLowerCase().includes("could not") || message.toLowerCase().includes("error") ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300" : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"}`}>
          {message}
        </div>
      )}
  </>;
  // No teacher record (failed lookup or not linked): show only the message, never 0/"none" metrics or a dead notice form.
  if (!teacher) return <div className="space-y-6 dashboard-role-flow">{header}</div>;

  return (
    <div className="space-y-6 dashboard-role-flow">
      {header}

      <section aria-labelledby="teacher-overview-title">
        <div className="mb-3">
          <h2 id="teacher-overview-title" className="text-lg font-bold">Today&apos;s Overview</h2>
          <p className="mt-1 text-sm muted">A quick look at your classes and recent work.</p>
        </div>
        <div className="dashboard-metrics">
          {[
            { label: "My Classes", value: assignmentsUnavailable ? "—" : myClassCount, context: assignmentsUnavailable ? "Currently unavailable" : "Active teaching assignments", icon: <GraduationCap size={19} />, color: "text-blue-600 bg-blue-50 dark:bg-blue-950" },
            { label: "Academic Logs", value: monthlyLogCount ?? "—", context: monthlyLogCount === null ? "Currently unavailable" : "This month", icon: <BookOpen size={19} />, color: "text-emerald-600 bg-emerald-50 dark:bg-emerald-950" },
            { label: "Homework Given", value: monthlyHomeworkCount ?? "—", context: monthlyHomeworkCount === null ? "Currently unavailable" : "This month", icon: <NotebookPen size={19} />, color: "text-purple-600 bg-purple-50 dark:bg-purple-950" },
            { label: "Upcoming Tests", value: upcomingTestsThisWeek ?? "—", context: upcomingTestsThisWeek === null ? "Currently unavailable" : "Next 7 days", icon: <ClipboardList size={19} />, color: "text-orange-600 bg-orange-50 dark:bg-orange-950" },
          ].map((item) => (
            <DashboardMetric key={item.label} label={item.label} value={busy ? "—" : item.value} context={item.context}
              icon={item.label === "My Classes" ? GraduationCap : item.label === "Academic Logs" ? BookOpen : item.label === "Homework Given" ? NotebookPen : ClipboardList}
              tone={item.label === "Academic Logs" ? "green" : item.label === "Homework Given" ? "violet" : item.label === "Upcoming Tests" ? "amber" : "blue"} featured={item.label === "My Classes"} />
          ))}
        </div>
      </section>

      <div className="dashboard-bento">
        <RecentLogChart logs={logs} loading={busy} unavailable={recentActivityUnavailable} />
        <AttendanceComposition rows={todayAttendanceRows} loading={busy} unavailable={attendanceOverviewUnavailable} title="Today’s attendance" detail="Saved by you across permitted classes" href="/modules/attendance" />
      </div>
      <nav className="dashboard-quick-wide" aria-label="Quick Actions"><DashboardActions actions={[
        { label: "Add academic log", href: "/modules/class-logs", icon: <Plus size={16} /> },
        { label: "Give homework", href: "/modules/homework", icon: <NotebookPen size={16} /> },
        { label: "Create test", href: "/modules/exams", icon: <FileText size={16} /> },
        { label: "My timetable", href: "/modules/timetable", icon: <CalendarCheck size={16} /> },
      ]} /></nav>
      <div className="dashboard-bento-even">
      <Card title="Today’s Teaching Activity" icon={<BookOpen size={18} />}>
        {recentActivityUnavailable ? (
          <p role="alert" className="text-sm text-danger">Today&apos;s teaching activity could not be loaded.</p>
        ) : todayLogRows.length ? (
          <div className="space-y-3">
            {todayLogRows.slice(0, 3).map((log) => {
              const logActivities = activities.filter((activity) => activity.class_log_id === log.id);
              return (
                <article key={log.id} className="rounded-xl border border-[var(--border)] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold">{nameForClass(log.class_id)} {nameForSection(log.section_id)} · {nameForSubject(log.subject_id)}</p>
                    <span className={logStatusPill(log.status)}>{log.status === "draft" ? "Draft" : "Published"}</span>
                  </div>
                  <p className="mt-2 text-sm">{log.topic}</p>
                  {logActivities.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {logActivities.map((activity) => <span key={activity.id} className="rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-xs font-medium">{formatActivityType(activity.activity_type)} · {activity.title}</span>)}
                    </div>
                  )}
                  {log.summary && <p className="mt-2 text-sm muted">{log.summary}</p>}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="rounded-xl bg-[var(--surface-2)] p-5 text-sm muted">No teaching activity recorded for today.</div>
        )}
      </Card>

      <Card title="Recent Academic Activity" icon={<Clock3 size={18} />} right={<DashboardViewAll href="/modules/class-logs" />}>
        {recentActivityUnavailable ? (
          <p role="alert" className="text-sm text-danger">Recent academic activity could not be loaded. Refresh to try again.</p>
        ) : recentLogs.length ? (
          <div className="divide-y divide-[var(--border)]">
            {recentLogs.slice(0, 4).map((log) => {
              const logActivities = activities.filter((activity) => activity.class_log_id === log.id);
              return (
                <article key={log.id} className="grid gap-2 py-4 first:pt-0 last:pb-0">
                  <time className="text-sm muted">{displayDate(log.log_date)}</time>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{nameForClass(log.class_id)} {nameForSection(log.section_id)} · {nameForSubject(log.subject_id)}</p>
                    <p className="mt-1 text-sm">{log.topic}</p>
                    {logActivities.length > 0 && <p className="mt-1 text-xs muted">{logActivities.map((activity) => `${formatActivityType(activity.activity_type)}: ${activity.title}`).join(" · ")}</p>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {logActivities.length ? logActivities.slice(0, 2).map((activity) => <span key={activity.id} className="rounded-full bg-blue-500/10 px-2.5 py-1 text-xs font-semibold text-blue-700 dark:text-blue-300">{formatActivityType(activity.activity_type)}</span>) : <span className="rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-xs font-semibold">Academic Log</span>}
                    <span className={logStatusPill(log.status)}>{log.status === "draft" ? "Draft" : "Published"}</span>
                  </div>
                </article>
              );
            })}
          </div>
        ) : <p className="text-sm muted">Your recent academic activity will appear here.</p>}
      </Card>

      </div>
      <Card title="Attendance & Missed Work" icon={<CalendarCheck size={18} />} preview={false}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            { label: "Today’s attendance activity", value: attendanceOverviewUnavailable ? "—" : todayAttendanceRows.length, context: attendanceOverviewUnavailable ? "Currently unavailable" : "Records saved by you" },
            { label: "Students absent today", value: attendanceOverviewUnavailable ? "—" : absentStudentCount, context: attendanceOverviewUnavailable ? "Currently unavailable" : todayAttendanceRows.length ? "Across your assigned classes" : "No attendance recorded yet" },
            { label: "Missed academic work", value: attendanceOverviewUnavailable ? "—" : missedWorkCount, context: attendanceOverviewUnavailable ? "Currently unavailable" : "Based on today’s class activity" },
            { label: "Pending follow-up", value: attendanceOverviewUnavailable ? "—" : missedWorkCount, context: attendanceOverviewUnavailable ? "Currently unavailable" : "Missed items to review" },
          ].map((item) => (
            <div key={item.label} className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
              <p className="text-xs font-semibold muted">{item.label}</p>
              <p className="mt-2 text-2xl font-black">{item.value}</p>
              <p className="mt-1 text-xs muted">{item.context}</p>
            </div>
          ))}
        </div>
        <div className="mt-4 rounded-xl border border-[var(--border)] p-4 text-sm">
          {attendanceOverviewUnavailable ? (
            <p className="muted">Attendance information could not be loaded right now.</p>
          ) : !todayAttendanceRows.length ? (
            <p className="muted">Today&apos;s attendance has not been recorded yet.</p>
          ) : absentStudentCount === 0 ? (
            <p className="font-medium text-emerald-700 dark:text-emerald-300">All students are accounted for today.</p>
          ) : missedWorkCount === 0 ? (
            <p className="font-medium text-amber-700 dark:text-amber-300">No missed academic activity requires attention.</p>
          ) : (
            <p className="font-medium text-amber-700 dark:text-amber-300">{absentStudentCount} absent student{absentStudentCount === 1 ? "" : "s"} may need to catch up on {missedWorkCount} academic item{missedWorkCount === 1 ? "" : "s"}.</p>
          )}
        </div>

        <div className="mt-6 border-t border-[var(--border)] pt-5">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <div>
              <p className="text-sm font-semibold">Attendance class</p>
              <div className="mt-2">
                {!attendanceOptions.length ? <p className="text-sm muted">No class teacher section is assigned to you yet. Ask the school office.</p>
                  : attendanceOptions.length === 1 ? <AttendanceClassBadge label={attendanceOptions[0].label} coverage={attendanceOptions[0].coverage} />
                    : <AttendanceClassPicker options={attendanceOptions} value={selectedAssignment} disabled={attendanceLocked || busy} onChange={setSelectedAssignment} />}
              </div>
              <div className="mt-3 space-y-2">
                {assignments.slice(0, 6).map((a) => (
                  <div key={a.id} className="flex items-center gap-3 rounded-xl bg-[var(--surface-2)] p-3 text-sm">
                    <GraduationCap size={17} className="shrink-0 text-blue-600" />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">{a.className} {a.sectionName}</div>
                      <div className="text-xs muted">{a.subjectName}{a.is_class_teacher ? " · Class Teacher" : ""}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h3 className="mb-3 font-semibold">Record attendance</h3>
              {attendanceUnverified && <p role="status" className="mb-3 text-sm text-amber-800 dark:text-amber-200">Attendance access could not be re-checked. Your unsaved marks are kept and the check will retry. Save once the connection returns.</p>}
              {currentAssignment?.coverage_id && <p className="mb-3 text-sm muted">Temporary attendance coverage · {currentAssignment.starts_on} through {currentAssignment.ends_on} IST. Previous days are read-only.</p>}
              <fieldset disabled={busy}>
              <AttendanceEditor
                context={teacher?.school_id && currentAssignment?.is_class_teacher && currentAssignment.section_id ? {
                  schoolId: teacher.school_id,
                  academicYearId: currentAssignment.academic_year_id,
                  classId: currentAssignment.class_id,
                  sectionId: currentAssignment.section_id,
                } : null}
                userId={userId}
                reviewOnlyHistory={Boolean(currentAssignment?.coverage_id)}
                dateLimits={currentAssignment?.coverage_id && currentAssignment.starts_on && currentAssignment.ends_on
                  ? { start: currentAssignment.starts_on, end: currentAssignment.ends_on } : undefined}
                onLockChange={setAttendanceLocked}
                onSaved={refresh}
              />
              </fieldset>
            </div>
          </div>
        </div>
      </Card>

        <Card title="Upcoming Tests & Recent Marks" icon={<ClipboardList size={18} />}>
          <div className="grid gap-5 md:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold">Upcoming tests</h3>
              <div className="mt-3 space-y-2">
                {(upcomingAssessments ?? []).slice(0, 3).map((assessment) => {
                  const assignment = assignments.find((item) => item.class_id === assessment.class_id && item.section_id === assessment.section_id && item.subject_id === assessment.subject_id);
                  return (
                    <div key={assessment.id} className="rounded-xl bg-[var(--surface-2)] p-3 text-sm">
                      <div className="font-semibold">{assessment.name}</div>
                      <div className="mt-1 text-xs muted">{displayDate(assessment.assessment_date)} · {assignment?.className ?? nameForClass(assessment.class_id)} {assignment?.sectionName ?? nameForSection(assessment.section_id)} · {assignment?.subjectName ?? nameForSubject(assessment.subject_id)}</div>
                    </div>
                  );
                })}
                {!upcomingAssessments ? <p role="alert" className="text-sm text-danger">Upcoming tests could not be loaded.</p>
                  : !upcomingAssessments.length && <p className="text-sm muted">No upcoming tests scheduled.</p>}
              </div>
            </div>
            <div>
              <h3 className="text-sm font-semibold">Recent marks</h3>
              <div className="mt-3 space-y-2">
                {recentMarks.slice(0, 3).map((mark) => (
                  <div key={mark.id} className="rounded-xl bg-[var(--surface-2)] p-3 text-sm">
                    <div className="font-semibold">{mark.studentName} · {mark.assessmentName}</div>
                    <div className="mt-1 text-xs muted">{mark.marks} / {mark.maximum}</div>
                  </div>
                ))}
                {!recentMarks.length && <p className="text-sm muted">No marks entered yet.</p>}
              </div>
            </div>
          </div>
        </Card>
        <Card title="Share a Notice" icon={<FileText size={18} />} preview={false}>
          <p className="text-sm muted">Notices go live immediately for students and guardians in your assigned classes. You can edit or withdraw your own notices: edits update family inboxes and withdrawing removes the notice, but a push alert already delivered to a phone cannot be recalled.</p>
          <div className="mt-4 space-y-3">
            <input value={noticeTitle} onChange={(e) => setNoticeTitle(e.target.value)} placeholder="Notice title" aria-label="Notice title" className="field" />
            <textarea value={noticeContent} onChange={(e) => setNoticeContent(e.target.value)} placeholder="Notice content" aria-label="Notice content" className="field min-h-24" />
            <div className="flex flex-wrap gap-2">
              <button disabled={busy || attendanceLocked || !noticeTitle.trim() || !noticeContent.trim()} onClick={saveNotice} className="inline-flex items-center gap-2 rounded-xl gradient px-5 py-3 text-sm font-bold disabled:opacity-50"><Plus size={17} aria-hidden="true" /> {editingNotice ? "Save changes" : "Publish Notice"}</button>
              {editingNotice && <button type="button" disabled={busy || attendanceLocked} onClick={() => { setEditingNotice(null); setNoticeTitle(""); setNoticeContent(""); }} className="rounded-xl border border-[var(--border)] px-5 py-3 text-sm font-semibold">Cancel edit</button>}
            </div>
            {attendanceLocked && <p role="status" className="text-sm text-amber-800 dark:text-amber-200">Notice actions are paused while the attendance register is loading, saving or has unsaved marks. Save the attendance first.</p>}
          </div>
          <div className="mt-5 border-t border-[var(--border)] pt-4">
            <h3 className="text-sm font-semibold">Your recent notices</h3>
            {!teacherNotices ? <p role="alert" className="mt-2 text-sm text-danger">Your notices could not be loaded. Refresh to try again.</p> : <ul className="mt-2 space-y-2">
              {teacherNotices.slice(0, 4).map((notice) => (
                <li key={notice.id} className="flex flex-wrap items-start justify-between gap-2 rounded-xl bg-[var(--surface-2)] p-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold">{notice.title}</div>
                    <div className="mt-1 text-xs muted">{notice.published_at ? displayTimestamp(notice.published_at) : "Withdrawn"}</div>
                  </div>
                  {notice.published_at && <div className="flex gap-2">
                    <button type="button" disabled={busy || attendanceLocked} aria-label={`Edit ${notice.title}`} onClick={() => editNotice(notice)} className="rounded-lg border border-[var(--border)] inline-flex min-h-10 items-center px-3 py-1.5 text-xs font-semibold">Edit</button>
                    <button type="button" disabled={busy || attendanceLocked} aria-label={`Withdraw ${notice.title}`} onClick={() => withdrawNotice(notice)} className="rounded-lg border border-[var(--border)] inline-flex min-h-10 items-center px-3 py-1.5 text-xs font-semibold">Withdraw</button>
                  </div>}
                </li>
              ))}
              {!teacherNotices.length && <li className="text-sm muted">No notices published yet.</li>}
            </ul>}
          </div>
        </Card>
    </div>
  );
}

async function loadStudentDashboardData(
  supabase: ReturnType<typeof createClient>,
  student: FamilyStudent,
  signal: AbortSignal,
): Promise<StudentDashboardData | null> {
  const [{ data: enrollment, error: enrollmentReadError }, attendanceResult, feeResult] = await Promise.all([
    supabase.from("enrollments").select("class_id,section_id,academic_year_id,roll_no,classes(name),sections(name),academic_years!inner(is_current)")
      .eq("student_id", student.id).eq("status", "active")
      .eq("academic_years.school_id", student.school_id).eq("academic_years.is_current", true)
      .returns<EnrollmentRow[]>().maybeSingle(),
    loadFamilyAttendance(supabase, student),
    getFamilyFeeLedger(supabase, student.id, 4, 0).then(
      (ledger) => ({ data: ledger, error: false }),
      () => ({ data: null, error: true }),
    ),
  ]);
  if (signal.aborted) return null;

  let logs: LogRow[] = [];
  let activities: ActivityRow[] = [];
  const enrollmentError = Boolean(enrollmentReadError);
  let learningError = enrollmentError;
  let logCount: number | null = enrollmentError ? null : 0;
  if (enrollment) {
    let logQuery = supabase.from("class_logs")
      .select("id,log_date,topic,summary,subject_id,class_id,section_id,academic_year_id,teacher_remark,status", { count: "exact" })
      .eq("class_id", enrollment.class_id)
      .eq("status", "published");
    if (enrollment.academic_year_id) logQuery = logQuery.eq("academic_year_id", enrollment.academic_year_id);
    logQuery = enrollment.section_id
      ? logQuery.or(`section_id.is.null,section_id.eq.${enrollment.section_id}`)
      : logQuery.is("section_id", null);
    // The exact count covers every published log; the 30 rows only feed the previews.
    const { data, count, error } = await logQuery.order("log_date", { ascending: false }).limit(30).returns<LogRow[]>();
    if (signal.aborted) return null;
    logs = data ?? [];
    logCount = error ? null : count ?? null;
    learningError ||= Boolean(error);
    const ids = logs.map((log) => log.id);
    if (ids.length) {
      const { data, error } = await supabase.from("class_activities").select("id,activity_type,title,description,due_date,class_log_id").in("class_log_id", ids).order("created_at", { ascending: false }).returns<ActivityRow[]>();
      if (signal.aborted) return null;
      activities = data ?? [];
      learningError ||= Boolean(error);
    }
  }
  return {
    student, enrollment, enrollmentError, learningError, logCount, attendance: attendanceResult.rows,
    attendanceError: attendanceResult.error, fees: feeResult.data?.rows ?? [], feesError: feeResult.error,
    feeCount: feeResult.data?.summary.demand_count ?? null, logs, activities,
  };
}

function FamilyFeeBalances({ rows, total, error, loading }: {
  rows: FeeLedgerRow[]; total: number | null; error: boolean; loading: boolean;
}) {
  return <Card title="Fee balances" icon={<IndianRupee size={18} />}>
    {loading ? <LoadingState variant="list" className="text-sm muted">Loading fee balances…</LoadingState>
      : error ? <p role="alert" className="text-sm text-danger">Fee balances could not be loaded. Refresh to check the saved records.</p>
        : !rows.length ? <p className="text-sm muted">No fee demands available.</p> : <>
          <p className="mb-3 text-xs muted">Showing {rows.length} of {total} retained demands, outstanding first. Balances include approved fee changes and recorded-payment reversals.</p>
          <ul aria-label="Fee balance preview" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {rows.map((fee) => <li key={fee.demand_id} className="min-w-0 space-y-3 rounded-xl bg-[var(--surface-2)] p-4">
              <div><h3 className="break-words text-sm font-semibold">{fee.fee_name}</h3>
                <p className="mt-1 break-words text-xs muted">{formatFeeBillingPeriod(fee.billing_period)}{fee.academic_year_name ? ` · ${fee.academic_year_name}` : ""}</p>
              </div>
              <dl className="space-y-2 text-sm">
                {[["Net fee", fee.net_amount], ["Payments applied", fee.paid_amount], ["Outstanding", fee.balance]].map(([label, value]) => <div key={label} className="flex flex-wrap justify-between gap-1">
                  <dt className="text-xs muted">{label}</dt><dd className="break-words font-semibold tabular-nums">{value === null ? "Needs review" : formatFeeMoney(value)}</dd>
                </div>)}
              </dl>
              <p className="text-xs font-semibold capitalize">{fee.status.replaceAll("_", " ")}</p>
            </li>)}
          </ul>
        </>}
  </Card>;
}

function attendanceSavedCount(rows: FamilyAttendanceRow[]) {
  if (!rows.length) return "—";
  const present = rows.filter((row) => row.status === "present" || row.status === "late").length;
  return `${present} of ${rows.length}`;
}

function AttendanceHistory({ title, rows, error, loading }: {
  title: string;
  rows: FamilyAttendanceRow[];
  error: boolean;
  loading: boolean;
}) {
  return (
    <Card title={title} icon={<CalendarCheck size={18} />} right={<DashboardViewAll href={title === "Attendance by Date" ? guardianAttendancePath : "/modules/attendance"} />}>
      {loading ? <LoadingState variant="list" className="text-sm muted">Loading attendance…</LoadingState>
        : error ? <p role="alert" className="text-sm text-danger">Attendance could not be loaded. Refresh to try again.</p>
        : rows.length ? (
          <ul className="space-y-2">
            {rows.map((row) => (
              <li key={row.attendance_date} className="flex items-center justify-between rounded-xl bg-[var(--surface-2)] p-3 text-sm">
                <time dateTime={row.attendance_date}>{displayDate(row.attendance_date)}</time>
                <span className={row.status === "absent" ? "font-semibold text-danger" : "font-semibold"}>
                  {attendanceLabels[row.status] ?? row.status}
                </span>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm muted">No attendance records available.</p>}
    </Card>
  );
}

const classWorkUnavailable = <p role="alert" className="dashboard-empty text-danger">Class work could not be loaded. Refresh to try again.</p>;

function FamilyLearningPreview({ logs, activities, loading = false, unavailable = false }: { logs: LogRow[]; activities: ActivityRow[]; loading?: boolean; unavailable?: boolean }) {
  return <Card title="Recent learning & work" icon={<BookOpen size={17} />} right={<DashboardViewAll href="/modules/homework">Homework</DashboardViewAll>}>
    {loading ? <LoadingState variant="list" label="Loading learning and class work…" /> : unavailable ? classWorkUnavailable : <>
    <div className="dashboard-learning-list">{activities.slice(0, 4).map((activity) => <article key={activity.id}><p className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">{activity.activity_type.replaceAll("_", " ")}</p><h3 className="mt-1">{activity.title}</h3>{activity.due_date && <p>Due {displayDate(activity.due_date)}</p>}</article>)}</div>
    {!activities.length && <p className="dashboard-empty">No homework or activities have been shared for this class yet.</p>}
    {logs.length > 0 && <div className="mt-4 border-t border-[var(--border)] pt-4"><p className="dashboard-caption">Latest class lesson</p><h3 className="mt-1 text-sm font-semibold">{logs[0].topic}</h3>{logs[0].summary && <p className="mt-1 text-xs leading-relaxed muted">{logs[0].summary}</p>}<p className="mt-2 text-xs muted">{displayDate(logs[0].log_date)} · {logs.length} recently loaded academic logs</p></div>}
    </>}
  </Card>;
}
function FamilyMissedWork({ logs, activities, attendance, loading = false, unavailable = false }: { logs: LogRow[]; activities: ActivityRow[]; attendance: FamilyAttendanceRow[]; loading?: boolean; unavailable?: boolean }) {
  const missed = logs.filter((log) => attendance.some((record) => record.attendance_date === log.log_date && record.status === "absent" && record.academic_year_id === log.academic_year_id));
  return <Card title="What You Missed" icon={<AlertCircle size={17} />} right={<DashboardViewAll href="/modules/missed-activities" />}>
    {loading ? <LoadingState variant="list" label="Loading missed school work…" /> : unavailable ? classWorkUnavailable : missed.length ? <div className="dashboard-list">{missed.slice(0, 4).map((log) => <article key={log.id} className="dashboard-list-item"><p>{displayDate(log.log_date)}</p><h3>{log.topic}</h3>{log.summary && <p>{log.summary}</p>}{activities.filter((activity) => activity.class_log_id === log.id).map((activity) => <p key={activity.id}><strong>{activity.activity_type.replaceAll("_", " ")}:</strong> {activity.title}</p>)}{log.teacher_remark && <p><strong>Teacher Remark:</strong> {log.teacher_remark}</p>}</article>)}</div> : <p className="dashboard-empty">No missed academic work found.</p>}
  </Card>;
}

function StudentDashboard({ userId }: { userId: string }) {
  const [supabase] = useState(createClient);
  const [summaryStudent, setSummaryStudent] = useState<FamilyStudent | null>(null);
  const [data, setData] = useState<StudentDashboardData>(emptyStudentDashboard);
  const { student, enrollment, enrollmentError, learningError, attendance, attendanceError, logs, logCount, activities, fees, feesError, feeCount } = data;
  const [message, setMessage] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const [student] = await loadFamilyStudents(supabase, "student", userId);
        if (controller.signal.aborted) return;
        if (!student) {
          setMessage("No student profile is linked to this account.");
          return;
        }
        setSummaryStudent(student);
        const data = await loadStudentDashboardData(supabase, student, controller.signal);
        if (data && !controller.signal.aborted) setData(data);
      } catch (error) {
        if (!controller.signal.aborted) {
          setMessage(error instanceof Error ? error.message : "Your student profile could not be loaded. Refresh to try again.");
        }
      }
    }
    void load();
    return () => controller.abort();
  }, [supabase, userId]);

  return (
    <div className="dashboard-role-flow space-y-6">
      <Header role="student" subtitle="Your learning, attendance and school tasks, ready for today." />
      {message && <div role="alert" className="rounded-2xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-700 dark:text-red-300">{message}</div>}
      <DashboardIdentity label="My Profile & Class" loading={!student && !message} name={student ? nameOf(student) : "Student profile"} subtitle={student ? "Your verified school profile" : "Checking your school profile…"}
        details={[{ label: "Admission", value: student?.admission_no ?? "—" }, { label: "Roll No.", value: enrollmentError ? "Unavailable" : enrollment?.roll_no ?? "—" },
          { label: "Class", value: enrollmentError ? "Unavailable" : enrollment?.classes?.name ?? "—" }, { label: "Section", value: enrollmentError ? "Unavailable" : enrollment?.sections?.name ?? "—" }]}
        />
      <OfficialAttendanceSummary client={supabase} userId={userId} student={summaryStudent} role="student" loading={!summaryStudent && !message} />
      <div className="dashboard-metrics">
        <Stat label="Present or late" value={attendanceSavedCount(attendance)} tone="green" loading={!student && !message} />
        <Stat label="Academic logs" value={logCount ?? "—"} context={logCount === null ? "Currently unavailable" : "Published this academic year"} loading={!student && !message} />
        <Stat label="Homework & projects" value={learningError ? "—" : activities.length} context={learningError ? "Currently unavailable" : "From the latest 30 class logs"} tone="purple" loading={!student && !message} />
        <Stat label="Fee records" value={feeCount ?? "—"} context={feesError ? "Currently unavailable" : "Fee demands on record"} tone="orange" loading={!student && !message} />
      </div>
      <div className="dashboard-bento">
        <FamilyLearningPreview logs={logs} activities={activities} loading={!student && !message} unavailable={learningError} />
        <AttendanceComposition rows={attendance} loading={!student && !message} unavailable={attendanceError} detail="Recent retained attendance records" href="/modules/attendance" />
      </div>
      <nav className="dashboard-quick-wide" aria-label="Student quick actions"><DashboardActions actions={[
        { label: "My homework", href: "/modules/homework", icon: <NotebookPen size={16} /> },
        { label: "Class timetable", href: "/modules/timetable", icon: <CalendarCheck size={16} /> },
        { label: "Published results", href: "/modules/published-results", icon: <GraduationCap size={16} /> },
        { label: "Fee receipts", href: "/modules/invoices", icon: <IndianRupee size={16} /> },
      ]} /></nav>
      <div className="dashboard-bento-even">
        <AttendanceHistory title="Attendance History" rows={attendance.slice(0, 5)} error={attendanceError} loading={!student && !message} />
        <FamilyMissedWork logs={logs} activities={activities} attendance={attendance} loading={!student && !message} unavailable={learningError} />
      </div>
      <FamilyFeeBalances rows={fees} total={feeCount} error={feesError || Boolean(message && !student)} loading={!student && !message} />
    </div>
  );
}

function ParentDashboard({ userId }: { userId: string }) {
  const [supabase] = useState(createClient);
  const [children, setChildren] = useState<FamilyStudent[]>([]);
  const [selected, setSelected] = useState("");
  const [childData, setChildData] = useState<{ studentId: string; data: StudentDashboardData } | null>(null);
  // A newly selected child starts with empty data until that child's request finishes.
  const { student: child, attendance, attendanceError, enrollment, enrollmentError, learningError, logs, logCount, activities, fees, feesError, feeCount } =
    childData?.studentId === selected ? childData.data : emptyStudentDashboard;
  const [message, setMessage] = useState("");
  const summaryStudent = children.find(student => student.id === selected) ?? null;

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const students = await loadFamilyStudents(supabase, "parent", userId);
        if (controller.signal.aborted) return;
        if (!students.length) {
          setMessage("No child is linked to this guardian account yet.");
          return;
        }
        setChildren(students);
        setSelected(restoreFamilyChild(userId, students));
      } catch (error) {
        if (!controller.signal.aborted) {
          setMessage(error instanceof Error ? error.message : "Your guardian profile could not be loaded. Refresh to try again.");
        }
      }
    }
    void load();
    return () => controller.abort();
  }, [supabase, userId]);

  useEffect(() => {
    const student = children.find((item) => item.id === selected);
    if (!student) return;
    const controller = new AbortController();
    void loadStudentDashboardData(supabase, student, controller.signal).then((data) => {
      if (data && !controller.signal.aborted) setChildData({ studentId: selected, data });
    });
    return () => controller.abort();
  }, [children, selected, supabase]);

  function selectChild(id: string) {
    if (id === selected || !children.some((student) => student.id === id)) return;
    setChildData(null);
    setSelected(id);
    rememberFamilyChild(userId, id);
  }

  return (
    <div className="dashboard-role-flow space-y-6">
      <Header role="parent" subtitle="A clear view of your child’s school day and the things that need your attention." />
      {message && <div role="alert" className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4 text-sm text-blue-700 dark:text-blue-300">{message}</div>}
      <section className="dashboard-panel flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between" aria-label="Select Child">
        <div className="min-w-0"><h2 className="text-sm font-semibold">Your children</h2><p className="mt-1 text-xs muted">Switch between verified school profiles.</p></div>
        <div className="min-w-0 sm:w-80"><label className="sr-only" htmlFor="dashboard-parent-child">Select child</label><select id="dashboard-parent-child" value={selected} onChange={(e) => selectChild(e.target.value)} className="field" disabled={!children.length}>
          <option value="" disabled>Select child</option>{children.map((student) => <option key={student.id} value={student.id}>{nameOf(student)} · {student.admission_no}</option>)}
        </select></div>
      </section>
      <DashboardIdentity label="Child Details" loading={!child && !message} name={child ? nameOf(child) : "Child profile"} subtitle={child ? "Verified linked student" : "Checking the selected child…"}
        details={[{ label: "Admission", value: child?.admission_no ?? "—" }, { label: "Roll No.", value: enrollmentError ? "Unavailable" : enrollment?.roll_no ?? "—" },
          { label: "Class", value: enrollmentError ? "Unavailable" : enrollment?.classes?.name ?? "—" }, { label: "Section", value: enrollmentError ? "Unavailable" : enrollment?.sections?.name ?? "—" }]}
        />
      <OfficialAttendanceSummary client={supabase} userId={userId} student={summaryStudent} role="parent" loading={!summaryStudent && !message} />
      <div className="dashboard-metrics">
        <Stat label="Present or late" value={attendanceSavedCount(attendance)} tone="green" loading={!child && !message} />
        <Stat label="Academic logs" value={logCount ?? "—"} context={logCount === null ? "Currently unavailable" : "Published this academic year"} loading={!child && !message} />
        <Stat label="Homework & projects" value={learningError ? "—" : activities.length} context={learningError ? "Currently unavailable" : "From the latest 30 class logs"} tone="purple" loading={!child && !message} />
        <Stat label="Fee records" value={feeCount ?? "—"} context={feesError ? "Currently unavailable" : "Fee demands on record"} tone="orange" loading={!child && !message} />
      </div>
      <div className="dashboard-bento">
        <FamilyLearningPreview logs={logs} activities={activities} loading={!child && !message} unavailable={learningError} />
        <AttendanceComposition rows={attendance} loading={!child && !message} unavailable={attendanceError} detail="Selected child · retained records" href={guardianAttendancePath} />
      </div>
      <GuardianAttendanceAlerts key={userId} userId={userId} summary />
      <nav className="dashboard-quick-wide" aria-label="Guardian quick actions"><DashboardActions actions={[
        { label: "Attendance history", href: guardianAttendancePath, icon: <CalendarCheck size={16} /> },
        { label: "Class timetable", href: "/modules/timetable?view=guardian", icon: <Clock3 size={16} /> },
        { label: "Published results", href: "/modules/published-results?view=guardian", icon: <GraduationCap size={16} /> },
        { label: "Fee receipts", href: "/modules/invoices?view=guardian", icon: <IndianRupee size={16} /> },
      ]} /></nav>
      <div className="dashboard-bento-even">
        <AttendanceHistory title="Attendance by Date" rows={attendance.slice(0, 5)} error={attendanceError} loading={!child && !message} />
        <FamilyMissedWork logs={logs} activities={activities} attendance={attendance} loading={!child && !message} unavailable={learningError} />
      </div>
      <FamilyFeeBalances rows={fees} total={feeCount} error={feesError || Boolean(message && !child)} loading={!child && !message} />
    </div>
  );
}

function AdminDashboard({ schoolId, userId, role, schoolRoles }: { schoolId: string | null; userId: string; role: "admin" | "principal"; schoolRoles?: readonly (UiRole | null)[] }) {
  const [supabase] = useState(createClient);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [overview, setOverview] = useState<AdminOverview>(emptyAdminOverview);
  const [dashboardLoading, setDashboardLoading] = useState(Boolean(schoolId));
  const [recentSchoolLogs, setRecentSchoolLogs] = useState<AdminOverviewLog[]>([]);
  const [recentSchoolActivities, setRecentSchoolActivities] = useState<AdminOverviewActivity[]>([]);
  const [upcomingSchoolAssessments, setUpcomingSchoolAssessments] = useState<AdminOverviewAssessment[]>([]);
  const [recentSchoolResults, setRecentSchoolResults] = useState<AdminOverviewResult[]>([]);
  const [publishedResults, setPublishedResults] = useState<PublicationSummary[]>([]);
  const principal = role === "principal";
  const [logsUnavailable, setLogsUnavailable] = useState(false);
  const [noticesUnavailable, setNoticesUnavailable] = useState(false);
  const [schoolNotices, setSchoolNotices] = useState<{ id: string; title: string; content: string; created_at: string | null }[]>([]);
  const [schoolNames, setSchoolNames] = useState<TeacherDisplayNames>({ classes: {}, sections: {}, subjects: {} });
  const [dashboardError, setDashboardError] = useState(schoolId ? "" : "This admin account is not linked to a school.");

  function refresh() {
    if (!schoolId) return;
    setDashboardLoading(true);
    setDashboardError("");
    setOverview(emptyAdminOverview);
    setRecentSchoolLogs([]);
    setRecentSchoolActivities([]);
    setUpcomingSchoolAssessments([]);
    setRecentSchoolResults([]);
    setPublishedResults([]);
    setSchoolNotices([]);
    setLogsUnavailable(false);
    setNoticesUnavailable(false);
    setSchoolNames({ classes: {}, sections: {}, subjects: {} });
    setReloadVersion((version) => version + 1);
  }

  useEffect(() => {
    if (!schoolId) return;
    const activeSchoolId = schoolId;
    const controller = new AbortController();
    async function load() {

      const today = dateToday();
      const weekEnd = upcomingAssessmentEndDate(today);

      if (controller.signal.aborted) return;

      const [
        studentsResult,
        teachersResult,
        parentsResult,
        classesResult,
        sectionsResult,
        attendanceResult,
        todayLogsResult,
        upcomingResult,
        completedAssessmentsResult,
        recentLogsResult,
        noticesResult,
        financeResult,
      ] = await Promise.all([
        supabase.from("students").select("id", { count: "exact", head: true }).eq("school_id", schoolId),
        supabase.from("teachers").select("id", { count: "exact", head: true }).eq("school_id", schoolId),
        supabase.from("parents").select("id", { count: "exact", head: true }).eq("school_id", schoolId),
        supabase.from("classes").select("id", { count: "exact", head: true }).eq("school_id", schoolId),
        supabase.from("sections").select("id", { count: "exact", head: true }).eq("school_id", schoolId),
        loadSchoolAttendanceCounts(supabase, activeSchoolId, today).then(
          (data) => ({ data, error: null }),
          (error: unknown) => ({ data: null, error }),
        ),
        supabase.from("class_logs").select("id,teacher_id,class_id,section_id").eq("school_id", schoolId).eq("log_date", today),
        principal ? loadPrincipalUpcoming(supabase, activeSchoolId, today, weekEnd)
          : supabase.from("teacher_assessments").select("id,name,assessment_date,maximum_marks,class_id,section_id,subject_id", { count: "exact" }).eq("school_id", schoolId).gte("assessment_date", today).lte("assessment_date", weekEnd).order("assessment_date", { ascending: true }).limit(10),
        principal ? Promise.resolve<AssessmentRead>({ data: [], error: null })
          : supabase.from("teacher_assessments").select("id,name,assessment_date,maximum_marks,class_id,section_id,subject_id").eq("school_id", schoolId).lt("assessment_date", today).order("assessment_date", { ascending: false }).limit(20),
        supabase.from("class_logs").select("id,log_date,topic,class_id,section_id,subject_id,status").eq("school_id", schoolId).order("log_date", { ascending: false }).limit(10),
        supabase.from("notices").select("id,title,content,created_at").eq("school_id", schoolId).order("created_at", { ascending: false }).limit(5),
        getOfficeFinanceSummary(supabase, activeSchoolId).then(
          (data) => ({ data, error: null }),
          (error: unknown) => ({ data: null, error }),
        ),
      ]);
      if (controller.signal.aborted) return;

      const queryErrors = [
        ["students", studentsResult.error],
        ["teachers", teachersResult.error],
        ["parents", parentsResult.error],
        ["classes", classesResult.error],
        ["sections", sectionsResult.error],
        ["attendance today", attendanceResult.error],
        ["today's class logs", todayLogsResult.error],
        ["upcoming assessments", upcomingResult.error],
        ["completed assessments", completedAssessmentsResult.error],
        ["recent academic logs", recentLogsResult.error],
        ["notices", noticesResult.error],
        ["finance summary", financeResult.error],
      ] as const;
      const failedQueries = queryErrors.filter(([, error]) => error);
      for (const [queryName, error] of failedQueries) {
        logAdminDashboardQueryError(queryName, error);
      }
      if (failedQueries.length) {
        setDashboardError("Some dashboard data could not be loaded. Please refresh or contact your administrator.");
      } else if (financeResult.data?.invalid_count) {
        setDashboardError("Some fee records need review. Unverified finance totals are unavailable; open Finance Reports to check them.");
      }

      const logs = (recentLogsResult.error ? [] : recentLogsResult.data ?? []) as AdminOverviewLog[];
      const todayLogs = todayLogsResult.data ?? [];
      const upcoming = (upcomingResult.error ? [] : upcomingResult.data ?? []) as AdminOverviewAssessment[];
      const completedAssessments = (completedAssessmentsResult.error ? [] : completedAssessmentsResult.data ?? []) as AdminOverviewAssessment[];
      const teacherIdsWithActivity = new Set(todayLogs.map((log) => log.teacher_id).filter(Boolean));
      setOverview({
        students: studentsResult.error ? null : studentsResult.count ?? 0,
        teachers: teachersResult.error ? null : teachersResult.count ?? 0,
        parents: parentsResult.error ? null : parentsResult.count ?? 0,
        classes: classesResult.error ? null : classesResult.count ?? 0,
        sections: sectionsResult.error ? null : sectionsResult.count ?? 0,
        attendanceToday: attendanceResult.data?.total ?? null,
        absentToday: attendanceResult.data?.statuses.absent ?? null,
        attendanceStatuses: attendanceResult.data?.statuses ?? null,
        activeTeachers: todayLogsResult.error ? null : teacherIdsWithActivity.size,
        classesLoggedToday: todayLogsResult.error ? null : new Set(todayLogs.map((log) => `${log.class_id}:${log.section_id ?? ""}`)).size,
        upcomingExams: upcomingResult.error ? null : upcomingResult.count ?? upcoming.length,
        todayCollection: financeResult.data?.collections.today_net ?? null,
        monthCollection: financeResult.data?.collections.month_net ?? null,
        pendingFees: financeResult.data?.pending_count ?? null,
        overdueFees: financeResult.data?.overdue_count ?? null,
      });
      setRecentSchoolLogs(logs);
      setLogsUnavailable(Boolean(recentLogsResult.error));
      setUpcomingSchoolAssessments(upcoming);
      setSchoolNotices(noticesResult.error ? [] : noticesResult.data ?? []);
      setNoticesUnavailable(Boolean(noticesResult.error));

      const completedAssessmentIds = completedAssessments.map((assessment) => assessment.id);
      if (principal) {
        // Principals see reviewed (published) results, never raw marks.
        try {
          const page = await listResultSubmissions(supabase, activeSchoolId, "published");
          if (controller.signal.aborted) return;
          setPublishedResults(page.rows);
        } catch (error) {
          if (controller.signal.aborted) return;
          console.error("Principal dashboard published results could not be loaded", error);
          setDashboardError("Recent results could not be loaded.");
        }
      } else if (completedAssessmentIds.length) {
        const { data: marks, error: marksError } = await supabase
          .from("teacher_assessment_marks")
          .select("id,assessment_id,student_id,marks_obtained,updated_at")
          .in("assessment_id", completedAssessmentIds)
          .order("updated_at", { ascending: false })
          .limit(10);
        if (controller.signal.aborted) return;
        if (marksError) {
          console.error("Admin dashboard recent results could not be loaded", marksError);
          setDashboardError("Recent results could not be loaded.");
        } else {
          const studentIds = [...new Set((marks ?? []).map((mark) => mark.student_id))];
          const { data: resultStudents, error: resultStudentsError } = studentIds.length
            ? await supabase.from("students").select("id,first_name,middle_name,last_name").eq("school_id", schoolId).in("id", studentIds)
            : { data: [], error: null };
          if (controller.signal.aborted) return;
          if (resultStudentsError) {
            console.error("Admin dashboard result student names could not be loaded", resultStudentsError);
            setDashboardError("Recent results could not be loaded.");
          } else {
            const studentNames = new Map((resultStudents ?? []).map((student) => [
              student.id,
              [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" "),
            ]));
            const assessmentsById = new Map(completedAssessments.map((assessment) => [assessment.id, assessment]));
            setRecentSchoolResults((marks ?? []).flatMap((mark) => {
              const assessment = assessmentsById.get(mark.assessment_id);
              if (!assessment) return [];
              return [{
                id: mark.id,
                assessmentName: assessment.name,
                studentName: studentNames.get(mark.student_id) ?? "Student",
                marks: Number(mark.marks_obtained),
                maximum: Number(assessment.maximum_marks),
                classId: assessment.class_id,
                sectionId: assessment.section_id,
                subjectId: assessment.subject_id,
              }];
            }));
          }
        }
      } else {
        setRecentSchoolResults([]);
      }

      const logIds = logs.map((log) => log.id);
      const [{ data: activities, error: activitiesError }, { data: classes, error: classesError }, { data: sections, error: sectionsError }, { data: subjects, error: subjectsError }] = await Promise.all([
        logIds.length
          ? supabase.from("class_activities").select("id,class_log_id,activity_type,title,due_date").in("class_log_id", logIds).order("created_at", { ascending: false }).limit(30)
          : Promise.resolve({ data: [], error: null }),
        supabase.from("classes").select("id,name").eq("school_id", schoolId),
        supabase.from("sections").select("id,name").eq("school_id", schoolId),
        supabase.from("subjects").select("id,name").eq("school_id", schoolId),
      ]);
      if (controller.signal.aborted) return;
      if (activitiesError || classesError || sectionsError || subjectsError) {
        const error = activitiesError ?? classesError ?? sectionsError ?? subjectsError;
        console.error("Admin dashboard activity labels could not be loaded", error);
        setDashboardError("Some academic activity details could not be loaded.");
      }
      setRecentSchoolActivities((activities ?? []) as AdminOverviewActivity[]);
      setSchoolNames({
        classes: Object.fromEntries((classes ?? []).map((item) => [item.id, item.name])),
        sections: Object.fromEntries((sections ?? []).map((item) => [item.id, item.name])),
        subjects: Object.fromEntries((subjects ?? []).map((item) => [item.id, item.name])),
      });
      setDashboardLoading(false);
    }
    void load();
    return () => controller.abort();
  }, [schoolId, supabase, reloadVersion, principal]);

  const classLabel = (log: AdminOverviewLog) =>
    `${schoolNames.classes[log.class_id] ?? "Class"} ${schoolNames.sections[log.section_id ?? ""] ?? ""}`.trim();
  const resultsLabel = (assessment: AdminOverviewAssessment) =>
    `${schoolNames.classes[assessment.class_id] ?? "Class"} ${schoolNames.sections[assessment.section_id ?? ""] ?? ""} · ${schoolNames.subjects[assessment.subject_id] ?? "Subject"}`.trim();
  const activityByLog = new Map<string, AdminOverviewActivity[]>();
  for (const activity of recentSchoolActivities) {
    const related = activityByLog.get(activity.class_log_id) ?? [];
    related.push(activity);
    activityByLog.set(activity.class_log_id, related);
  }
  const recentHomework = recentSchoolActivities.filter((activity) => activity.activity_type === "homework").slice(0, 6);

  const attendanceUnavailable = overview.attendanceStatuses === null || overview.attendanceToday === null || overview.absentToday === null
    || overview.absentToday > overview.attendanceToday;
  const countValue = (value: number | null) => dashboardLoading ? "—" : value ?? "—";

  return (
    <div className="dashboard-role-flow space-y-6">
      <DashboardGreeting eyebrow={role === "principal" ? "School leadership" : "School administration"}
        title={role === "principal" ? "Principal Dashboard" : "School Admin Dashboard"}
        description="A clear picture of your school, from daily attendance to learning and collections."
        href="/modules/students" action="Manage students">
        <button type="button" onClick={refresh} disabled={dashboardLoading} className="dashboard-refresh"><RefreshCw size={15} className={dashboardLoading ? "animate-spin" : ""} aria-hidden="true" />Refresh</button>
      </DashboardGreeting>
      {dashboardError && <div role="alert" className="rounded-2xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-700 dark:text-red-300">{dashboardError}</div>}
      <section aria-label="School Overview" className="dashboard-metrics dashboard-metrics-five">
        <DashboardMetric label="Total Students" value={countValue(overview.students)} context="All retained student records" icon={Users} featured loading={dashboardLoading} />
        <DashboardMetric label="Total Teachers" value={countValue(overview.teachers)} context="Retained school staff" icon={UserRound} tone="violet" loading={dashboardLoading} />
        <DashboardMetric label="Today's Attendance" value={countValue(overview.attendanceToday)} context="Saved school-day records" icon={CalendarCheck} tone="green" loading={dashboardLoading} />
        <DashboardMetric label="Absent Students" value={countValue(overview.absentToday)} context="Marked absent today" icon={UserRound} tone="rose" loading={dashboardLoading} />
        <DashboardMetric label="This Month Collection" value={dashboardLoading ? "—" : overview.monthCollection === null ? "Unavailable" : formatFeeMoney(overview.monthCollection)} context="Net recorded collections" icon={IndianRupee} tone="amber" loading={dashboardLoading} />
      </section>
      <div className="dashboard-bento">
        <RecentLogChart logs={recentSchoolLogs} loading={dashboardLoading} unavailable={logsUnavailable} />
        <AttendanceSegments title="Today’s attendance" detail="Breakdown of saved attendance records" href="/modules/attendance" loading={dashboardLoading} unavailable={attendanceUnavailable}
          segments={attendanceStatusStyles.map(({ key, color }) => ({ label: attendanceLabels[key as AttendanceStatus], count: overview.attendanceStatuses?.[key as AttendanceStatus] ?? 0, color }))} />
      </div>
      <nav className="dashboard-quick-wide" aria-label="School quick actions"><DashboardActions actions={[
        { label: "Student directory", href: "/modules/students", icon: <Users size={16} /> },
        { label: "School attendance", href: "/modules/attendance", icon: <CalendarCheck size={16} /> },
        { label: "Manage timetable", href: "/modules/timetable", icon: <Clock3 size={16} /> },
        { label: "Review results", href: "/modules/published-results", icon: <GraduationCap size={16} /> },
      ]} /></nav>
      <div className="dashboard-operational-grid">
        <Card title="Recent Academic Logs" icon={<BookOpen size={17} />} right={<DashboardViewAll href="/modules/class-logs" />}>
          {dashboardLoading && <LoadingState label="Loading recent academic logs…" />}
          <div className="dashboard-list">{(!dashboardLoading ? recentSchoolLogs : []).slice(0, 4).map((log) => <article key={log.id} className="dashboard-list-item"><div className="flex flex-wrap items-center justify-between gap-2"><p>{displayDate(log.log_date)} · {classLabel(log)} · {schoolNames.subjects[log.subject_id] ?? "Subject"}</p><span className={logStatusPill(log.status)}>{log.status === "draft" ? "Draft" : "Published"}</span></div><h3 className="mt-1">{log.topic}</h3>
            {(activityByLog.get(log.id) ?? []).length > 0 && <p>{(activityByLog.get(log.id) ?? []).slice(0, 2).map((activity) => `${activity.activity_type.replaceAll("_", " ")}: ${activity.title}`).join(" · ")}</p>}
          </article>)}</div>
          {!dashboardLoading && (logsUnavailable ? <p role="alert" className="dashboard-empty">Recent academic logs could not be loaded. Refresh to try again.</p>
            : recentSchoolLogs.length === 0 && <p className="dashboard-empty">No academic activity has been recorded yet.</p>)}
        </Card>
        <Card title="School Overview" icon={<School size={17} />}><dl className="dashboard-mini-facts">
          {[["Total Guardians", overview.parents], ["Total Classes", overview.classes], ["Total Sections", overview.sections], ["Teachers Active", overview.activeTeachers], ["Upcoming Exams", overview.upcomingExams]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{dashboardLoading ? <Skeleton className="h-6 w-12" /> : value ?? "—"}</dd></div>)}
        </dl><p className="mt-4 text-xs leading-relaxed muted">Teachers active = teachers with an academic log today. Upcoming exams cover today through the next seven days.</p></Card>
        <Card title="Upcoming Tests" icon={<ClipboardList size={17} />} right={getNavigationModules(role, schoolRoles).some((item) => item.key === "exams") ? <DashboardViewAll href="/modules/exams" /> : undefined}><div className="dashboard-list">{dashboardLoading && <LoadingState label="Loading upcoming assessments…" />}{(!dashboardLoading ? upcomingSchoolAssessments : []).slice(0, 4).map((assessment) => <article key={assessment.id} className="dashboard-list-item"><h3>{assessment.name}</h3><p>{displayDate(assessment.assessment_date)} · {resultsLabel(assessment)}</p></article>)}</div>{!dashboardLoading && !upcomingSchoolAssessments.length && <p className="dashboard-empty">{overview.upcomingExams === null ? "Upcoming tests are unavailable right now." : "No tests are scheduled for the next seven days."}</p>}</Card>
        <Card title="Finance" icon={<IndianRupee size={17} />} right={<DashboardViewAll href="/modules/finance-reports">Reports</DashboardViewAll>}><div className="dashboard-mini-facts">
          {[["Today's Collection", overview.todayCollection === null ? "Unavailable" : formatFeeMoney(overview.todayCollection)], ["This Month Collection", overview.monthCollection === null ? "Unavailable" : formatFeeMoney(overview.monthCollection)], ["Pending Fees", overview.pendingFees ?? "Unavailable"], ["Overdue Fees", overview.overdueFees ?? "Unavailable"]].map(([label, value]) => <article key={label}><h3>{label}</h3><p className="break-words">{dashboardLoading ? <Skeleton className="h-6 w-16" /> : value}</p></article>)}
        </div><p className="mt-4 text-xs leading-relaxed muted">Net recorded collections and retained fee demands. Reversals use their approval date.</p></Card>
        <Card title="Recent Homework" icon={<NotebookPen size={17} />} right={<DashboardViewAll href="/modules/homework" />}><div className="dashboard-list">{dashboardLoading && <LoadingState label="Loading recent homework…" />}{(!dashboardLoading ? recentHomework : []).slice(0, 4).map((activity) => {
          const log = recentSchoolLogs.find((item) => item.id === activity.class_log_id);
          return <article key={activity.id} className="dashboard-list-item"><h3>{activity.title}</h3><p>{activity.due_date ? `Due ${displayDate(activity.due_date)}` : "No due date recorded"}{log && ` · ${classLabel(log)}`}</p></article>;
        })}</div>{!dashboardLoading && !recentHomework.length && <p className="dashboard-empty">No homework records available yet.</p>}</Card>
        <Card title="School updates" icon={<FileText size={17} />} right={<DashboardViewAll href="/modules/notices" />}><div className="dashboard-list">{dashboardLoading && <LoadingState label="Loading school notices…" />}{(!dashboardLoading ? schoolNotices : []).slice(0, 3).map((notice) => <article key={notice.id} className="dashboard-list-item"><div className="dashboard-notice-heading"><span className="dashboard-avatar" aria-hidden="true">S</span><div><h3>{notice.title}</h3><p>{notice.created_at ? displayTimestamp(notice.created_at) : "Date not recorded"}</p></div></div></article>)}</div>{!dashboardLoading && (noticesUnavailable ? <p role="alert" className="dashboard-empty">School notices could not be loaded. Refresh to try again.</p> : !schoolNotices.length && <p className="dashboard-empty">No school notices available yet.</p>)}</Card>
      </div>
      {principal ? <Card title="Recent Results" icon={<GraduationCap size={17} />} right={<DashboardViewAll href="/modules/published-results" />}><div className="dashboard-learning-list">{dashboardLoading && <LoadingState label="Loading published results…" />}{(!dashboardLoading ? publishedResults : []).slice(0, 4).map((item) => <article key={item.id}><h3>{item.metadata.name}</h3><p>{[item.metadata.class_name, item.metadata.section_name].filter(Boolean).join(" ")} · {item.metadata.subject_name}</p><p className="mt-2 text-xs muted">Published {item.reviewed_at ? displayTimestamp(item.reviewed_at) : ""}</p></article>)}</div>{!dashboardLoading && !publishedResults.length && <p className="dashboard-empty">No results have been published yet.</p>}</Card>
      : <Card title="Recent Results" icon={<GraduationCap size={17} />} right={<DashboardViewAll href="/modules/results" />}><div className="dashboard-learning-list">{dashboardLoading && <LoadingState label="Loading recent assessment results…" />}{(!dashboardLoading ? recentSchoolResults : []).slice(0, 4).map((result) => <article key={result.id}><div className="flex items-center gap-3"><span className="dashboard-avatar" aria-hidden="true">{result.studentName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("")}</span><div><h3>{result.studentName}</h3><p>{result.assessmentName} · {schoolNames.subjects[result.subjectId] ?? "Subject"}</p></div></div><p className="mt-3 text-lg font-bold">{result.marks} / {result.maximum}</p></article>)}</div>{!dashboardLoading && !recentSchoolResults.length && <p className="dashboard-empty">No marked assessment results available yet.</p>}</Card>}
      {schoolId && <details className="dashboard-panel dashboard-attendance-monitor"><summary>Attendance submissions &amp; school cutoff <span className="text-xs muted">Open monitor</span></summary><AttendanceSubmissionMonitor key={schoolId} schoolId={schoolId} userId={userId} refreshVersion={reloadVersion} /></details>}
    </div>
  );
}
