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
import { AppShell } from "@/components/layout/app-shell";
import { createClient } from "@/lib/supabase/client";
import { roleLabel, type UiRole } from "@/lib/auth/roles";
import { AttendanceEditor } from "@/components/academic/attendance-editor";
import { AdminFinanceWorkspace } from "@/components/admin/admin-finance-workspace";
import {
  guardianAttendancePath,
  loadFamilyAttendance,
  loadFamilyStudents,
  rememberFamilyChild,
  restoreFamilyChild,
  type FamilyAttendanceRow,
  type FamilyStudent,
} from "@/lib/attendance/family";
import { attendanceLabels, schoolDate } from "@/lib/attendance/types";

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
type NoticeRow = { id: string; title: string; content: string; published_at: string | null; created_at: string | null };
type EnrollmentRow = {
  class_id: string;
  section_id: string | null;
  academic_year_id: string;
  roll_no: string | null;
  classes: { name: string } | null;
  sections: { name: string } | null;
};
type StudentFeeRow = {
  id: string;
  amount: number | string;
  status: string;
  billing_period: string | null;
};
type StudentDashboardData = {
  student: FamilyStudent | null;
  enrollment: EnrollmentRow | null;
  attendance: FamilyAttendanceRow[];
  attendanceError: boolean;
  logs: LogRow[];
  activities: ActivityRow[];
  fees: StudentFeeRow[];
};
const emptyStudentDashboard: StudentDashboardData = {
  student: null, enrollment: null, attendance: [], attendanceError: false, logs: [], activities: [], fees: [],
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
  activeTeachers: number | null;
  classesLoggedToday: number | null;
  upcomingExams: number | null;
  todayCollection: number | null;
  monthCollection: number | null;
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
  return new Date().toISOString().slice(0, 10);
}

function displayDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function Card({
  title,
  icon,
  children,
  right,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <section className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-950">
            {icon ?? <School size={18} />}
          </div>
          <h2 className="font-bold">{title}</h2>
        </div>
        {right}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Stat({ label, value, tone = "blue" }: { label: string; value: string | number; tone?: "blue" | "green" | "orange" | "purple" }) {
  const bg = tone === "green" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950" : tone === "orange" ? "bg-orange-50 text-orange-700 dark:bg-orange-950" : tone === "purple" ? "bg-purple-50 text-purple-700 dark:bg-purple-950" : "bg-blue-50 text-blue-700 dark:bg-blue-950";
  return (
    <div className="card p-5">
      <div className="text-xs muted">{label}</div>
      <div className={`mt-2 inline-flex rounded-xl px-3 py-2 text-2xl font-black ${bg}`}>{value}</div>
    </div>
  );
}

export function RoleDashboard({
  role,
  schoolId,
  userId,
  hasGuardianRole,
}: {
  role: UiRole;
  schoolId: string | null;
  userId: string;
  hasGuardianRole?: boolean;
}) {
  return (
    <AppShell role={role}>
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
        <AdminDashboard key={`${userId}:${schoolId}`} schoolId={schoolId} />
      )}
    </AppShell>
  );
}

function ReceptionDashboard() {
  const links = [
    { href: "/modules/students", label: "Students", detail: "View student records" },
    { href: "/modules/parents", label: "Parents", detail: "View parent contacts" },
    { href: "/modules/admissions", label: "Admissions", detail: "Review admissions" },
    { href: "/modules/notices", label: "Notices", detail: "School notices" },
    { href: "/modules/events", label: "Events", detail: "School calendar" },
    { href: "/modules/documents", label: "Documents", detail: "School documents" },
  ];

  return (
    <div className="space-y-6">
      <Header role="reception" subtitle="Quick access to the student, parent, admissions, and communication tools available to Reception." />
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
  return (
    <div className="gradient mb-6 rounded-[28px] p-6 sm:p-8">
      <div className="text-xs font-bold uppercase tracking-[.18em] text-white/70">{roleLabel(role)} workspace</div>
      <h1 className="mt-2 text-3xl font-black sm:text-4xl">
        {role === "teacher" ? "Teacher Dashboard" : role === "finance" ? "Finance Dashboard" : role === "student" ? "Student Dashboard" : role === "parent" ? "Parent Dashboard" : "School Dashboard"}
      </h1>
      <p className="mt-2 text-sm text-white/80">{subtitle}</p>
    </div>
  );
}

function TeacherDashboard({ userId }: { userId: string }) {
  const [supabase] = useState(createClient);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [teacher, setTeacher] = useState<TeacherRow | null>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [activities, setActivities] = useState<ActivityRow[]>([]);
  const [displayNames, setDisplayNames] = useState<TeacherDisplayNames>({ classes: {}, sections: {}, subjects: {} });
  const [todayAttendanceRows, setTodayAttendanceRows] = useState<AttendanceOverviewRow[]>([]);
  const [attendanceOverviewUnavailable, setAttendanceOverviewUnavailable] = useState(false);
  const [monthlyLogCount, setMonthlyLogCount] = useState<number | null>(null);
  const [monthlyHomeworkCount, setMonthlyHomeworkCount] = useState<number | null>(null);
  const [upcomingAssessments, setUpcomingAssessments] = useState<TeacherAssessmentRow[]>([]);
  const [recentMarks, setRecentMarks] = useState<TeacherMarkActivity[]>([]);
  const [teacherNotices, setTeacherNotices] = useState<NoticeRow[]>([]);
  const [classTeacherAssignments, setClassTeacherAssignments] = useState<Assignment[]>([]);
  const [selectedAssignment, setSelectedAssignment] = useState("");
  const [attendanceLocked, setAttendanceLocked] = useState(false);
  const [noticeTitle, setNoticeTitle] = useState("");
  const [noticeContent, setNoticeContent] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(true);

  const currentAssignment = useMemo(
    () => assignments.find((a) => a.id === selectedAssignment),
    [assignments, selectedAssignment]
  );

  function refresh() {
    setBusy(true);
    setMessage("");
    setReloadVersion((version) => version + 1);
  }

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      const today = schoolDate();
      const { data: t } = await supabase.from("teachers").select("*").eq("profile_id", userId).returns<TeacherRow[]>().maybeSingle();
      if (controller.signal.aborted) return;
      if (!t) {
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
      const classTeacherRows = enriched.filter((x) => x.is_class_teacher);
      setClassTeacherAssignments(classTeacherRows);

      // Attendance belongs to the assigned class teacher, not an arbitrary subject.
      const eligibleAssignments = classTeacherRows.filter((assignment) => assignment.section_id);
      setSelectedAssignment((selected) => eligibleAssignments.some((assignment) => assignment.id === selected)
        ? selected : eligibleAssignments[0]?.id ?? "");

      const { data: recentLogs } = await supabase
        .from("class_logs")
        .select("id,log_date,topic,summary,teacher_remark,class_id,section_id,subject_id,academic_year_id,status")
        .eq("teacher_id", t.id)
        .order("log_date", { ascending: false })
        .limit(200);
      if (controller.signal.aborted) return;
      const recentLogRows = (recentLogs ?? []) as LogRow[];
      setLogs(recentLogRows);

      const logIds = recentLogRows.map((x) => x.id);
      if (logIds.length) {
        const { data: acts } = await supabase
          .from("class_activities")
          .select("id,class_log_id,activity_type,title,description,due_date")
          .in("class_log_id", logIds)
          .limit(500);
        if (controller.signal.aborted) return;
        setActivities((acts ?? []) as ActivityRow[]);
      } else {
        setActivities([]);
      }

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

      const assignedSectionIds = [...new Set(enriched.map((assignment) => assignment.section_id).filter(Boolean))] as string[];
      const assignmentYearIds = [...new Set(enriched.map((assignment) => assignment.academic_year_id))];
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
        setUpcomingAssessments([]);
        setRecentMarks([]);
      } else {
        const teacherAssessments = (assessmentData ?? []) as TeacherAssessmentRow[];
        const weekEndDate = new Date(`${today}T00:00:00.000Z`);
        weekEndDate.setUTCDate(weekEndDate.getUTCDate() + 7);
        const weekEnd = weekEndDate.toISOString().slice(0, 10);
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
          setUpcomingAssessments([]);
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

      const { data: notices } = await supabase
        .from("notices")
        .select("id,title,content,published_at,created_at")
        .eq("created_by", userId)
        .order("created_at", { ascending: false })
        .limit(20).returns<NoticeRow[]>();
      if (controller.signal.aborted) return;
      setTeacherNotices(notices ?? []);

      setBusy(false);
    }
    void load();
    return () => controller.abort();
  }, [supabase, userId, reloadVersion]);

  async function saveNotice() {
    if (!teacher || !noticeTitle.trim() || !noticeContent.trim()) return;
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
  const upcomingTestsThisWeek = upcomingAssessments.filter((assessment) => {
    const daysUntil = (new Date(`${assessment.assessment_date}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime()) / 86400000;
    return daysUntil >= 0 && daysUntil <= 7;
  }).length;
  const nameForClass = (id: string) => displayNames.classes[id] ?? assignments.find((assignment) => assignment.class_id === id)?.className ?? "Class";
  const nameForSection = (id: string | null | undefined) => id ? displayNames.sections[id] ?? assignments.find((assignment) => assignment.section_id === id)?.sectionName ?? "Section" : "Section";
  const nameForSubject = (id: string) => displayNames.subjects[id] ?? assignments.find((assignment) => assignment.subject_id === id)?.subjectName ?? "Subject";
  const formatActivityType = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  const recentLogs = logs.slice(0, 8);

  return (
    <div className="space-y-6">
      <header className="gradient overflow-hidden rounded-[28px] p-6 text-white sm:p-8">
        <p className="text-xs font-bold uppercase tracking-[.18em] text-white/70">Teacher Dashboard</p>
        <h1 className="mt-2 text-3xl font-black sm:text-4xl">Welcome back, {teacher?.full_name || "Teacher"}</h1>
        <p className="mt-2 text-sm text-white/80">Here&apos;s your teaching activity and today&apos;s overview.</p>
      </header>

      {message && (
        <div className={`rounded-2xl border p-4 text-sm ${message.toLowerCase().includes("failed") || message.toLowerCase().includes("could not") || message.toLowerCase().includes("error") ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300" : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"}`}>
          {message}
        </div>
      )}

      <section aria-labelledby="teacher-overview-title">
        <div className="mb-3">
          <h2 id="teacher-overview-title" className="text-lg font-bold">Today&apos;s Overview</h2>
          <p className="mt-1 text-sm muted">A quick look at your classes and recent work.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[
            { label: "My Classes", value: myClassCount, context: "Active teaching assignments", icon: <GraduationCap size={19} />, color: "text-blue-600 bg-blue-50 dark:bg-blue-950" },
            { label: "Academic Logs", value: monthlyLogCount ?? "—", context: monthlyLogCount === null ? "Currently unavailable" : "This month", icon: <BookOpen size={19} />, color: "text-emerald-600 bg-emerald-50 dark:bg-emerald-950" },
            { label: "Homework Given", value: monthlyHomeworkCount ?? "—", context: monthlyHomeworkCount === null ? "Currently unavailable" : "This month", icon: <NotebookPen size={19} />, color: "text-purple-600 bg-purple-50 dark:bg-purple-950" },
            { label: "Upcoming Tests", value: upcomingTestsThisWeek, context: "Next 7 days", icon: <ClipboardList size={19} />, color: "text-orange-600 bg-orange-50 dark:bg-orange-950" },
          ].map((item) => (
            <article key={item.label} className="card flex min-w-0 items-start gap-4 p-5 transition hover:-translate-y-0.5 hover:shadow-md">
              <div className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${item.color}`}>{item.icon}</div>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold muted">{item.label}</h3>
                <p className="mt-1 text-3xl font-black">{item.value}</p>
                <p className="mt-1 text-xs muted">{item.context}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="quick-actions-title" className="card p-5">
        <div className="mb-4">
          <h2 id="quick-actions-title" className="text-lg font-bold">Quick Actions</h2>
          <p className="mt-1 text-sm muted">Go directly to your teaching tools.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            { label: "Add Academic Log", href: "/modules/classwork", icon: <Plus size={17} /> },
            { label: "Give Homework", href: "/modules/homework", icon: <NotebookPen size={17} /> },
            { label: "Create Test", href: "/modules/exams", icon: <FileText size={17} /> },
            { label: "View Attendance", href: "/modules/attendance", icon: <CalendarCheck size={17} /> },
          ].map((action) => (
            <Link key={action.href} href={action.href} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-semibold transition hover:border-blue-500/50 hover:bg-[var(--surface-2)]">
              {action.icon}{action.label}
            </Link>
          ))}
        </div>
      </section>

      <Card title="Today’s Teaching Activity" icon={<BookOpen size={18} />}>
        {todayLogRows.length ? (
          <div className="space-y-3">
            {todayLogRows.map((log) => {
              const logActivities = activities.filter((activity) => activity.class_log_id === log.id);
              return (
                <article key={log.id} className="rounded-xl border border-[var(--border)] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold">{nameForClass(log.class_id)} {nameForSection(log.section_id)} · {nameForSubject(log.subject_id)}</p>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${log.status === "draft" ? "bg-amber-500/10 text-amber-700 dark:text-amber-300" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"}`}>{log.status === "draft" ? "Draft" : "Published"}</span>
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

      <Card title="Recent Academic Activity" icon={<Clock3 size={18} />}>
        {recentLogs.length ? (
          <div className="divide-y divide-[var(--border)]">
            {recentLogs.map((log) => {
              const logActivities = activities.filter((activity) => activity.class_log_id === log.id);
              return (
                <article key={log.id} className="grid gap-2 py-4 first:pt-0 last:pb-0 sm:grid-cols-[130px_1fr_auto] sm:items-start">
                  <time className="text-sm muted">{displayDate(log.log_date)}</time>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{nameForClass(log.class_id)} {nameForSection(log.section_id)} · {nameForSubject(log.subject_id)}</p>
                    <p className="mt-1 text-sm">{log.topic}</p>
                    {logActivities.length > 0 && <p className="mt-1 text-xs muted">{logActivities.map((activity) => `${formatActivityType(activity.activity_type)}: ${activity.title}`).join(" · ")}</p>}
                  </div>
                  <div className="flex flex-wrap gap-2 sm:justify-end">
                    {logActivities.length ? logActivities.slice(0, 2).map((activity) => <span key={activity.id} className="rounded-full bg-blue-500/10 px-2.5 py-1 text-xs font-semibold text-blue-700 dark:text-blue-300">{formatActivityType(activity.activity_type)}</span>) : <span className="rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-xs font-semibold">Academic Log</span>}
                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${log.status === "draft" ? "bg-amber-500/10 text-amber-700 dark:text-amber-300" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"}`}>{log.status === "draft" ? "Draft" : "Published"}</span>
                  </div>
                </article>
              );
            })}
          </div>
        ) : <p className="text-sm muted">Your recent academic activity will appear here.</p>}
      </Card>

      <Card title="Attendance & Missed Work" icon={<CalendarCheck size={18} />}>
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
              <label className="block text-sm font-semibold">Assigned class / subject
                <select
                  value={selectedAssignment}
                  disabled={attendanceLocked || busy}
                  onChange={(e) => setSelectedAssignment(e.target.value)}
                  className="field mt-2"
                >
                  {!selectedAssignment && <option value="">No assigned class teacher section</option>}
                  {classTeacherAssignments.filter((assignment) => assignment.section_id).map((a) => (
                    <option key={a.id} value={a.id}>{a.className} {a.sectionName} · {a.subjectName}</option>
                  ))}
                </select>
              </label>
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
              <fieldset disabled={busy}>
              <AttendanceEditor
                context={teacher?.school_id && currentAssignment?.is_class_teacher && currentAssignment.section_id ? {
                  schoolId: teacher.school_id,
                  academicYearId: currentAssignment.academic_year_id,
                  classId: currentAssignment.class_id,
                  sectionId: currentAssignment.section_id,
                } : null}
                userId={userId}
                onLockChange={setAttendanceLocked}
                onSaved={refresh}
              />
              </fieldset>
            </div>
          </div>
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Upcoming Tests & Recent Marks" icon={<ClipboardList size={18} />}>
          <div className="grid gap-5 md:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold">Upcoming tests</h3>
              <div className="mt-3 space-y-2">
                {upcomingAssessments.slice(0, 3).map((assessment) => {
                  const assignment = assignments.find((item) => item.class_id === assessment.class_id && item.section_id === assessment.section_id && item.subject_id === assessment.subject_id);
                  return (
                    <div key={assessment.id} className="rounded-xl bg-[var(--surface-2)] p-3 text-sm">
                      <div className="font-semibold">{assessment.name}</div>
                      <div className="mt-1 text-xs muted">{displayDate(assessment.assessment_date)} · {assignment?.className ?? nameForClass(assessment.class_id)} {assignment?.sectionName ?? nameForSection(assessment.section_id)} · {assignment?.subjectName ?? nameForSubject(assessment.subject_id)}</div>
                    </div>
                  );
                })}
                {!upcomingAssessments.length && <p className="text-sm muted">No upcoming tests scheduled.</p>}
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
        <Card title="Share a Notice" icon={<FileText size={18} />}>
          <p className="text-sm muted">Publish an update for students and guardians in your assigned classes.</p>
          <div className="mt-4 space-y-3">
            <input value={noticeTitle} onChange={(e) => setNoticeTitle(e.target.value)} placeholder="Notice title" className="field" />
            <textarea value={noticeContent} onChange={(e) => setNoticeContent(e.target.value)} placeholder="Notice content" className="field min-h-24" />
            <button disabled={busy || !noticeTitle.trim() || !noticeContent.trim()} onClick={saveNotice} className="inline-flex items-center gap-2 rounded-xl gradient px-5 py-3 text-sm font-bold disabled:opacity-50"><Plus size={17} /> Publish Notice</button>
          </div>
          <div className="mt-5 border-t border-[var(--border)] pt-4">
            <h3 className="text-sm font-semibold">Recently published</h3>
            <div className="mt-2 space-y-2">
              {teacherNotices.slice(0, 4).map((notice) => (
                <div key={notice.id} className="rounded-xl bg-[var(--surface-2)] p-3">
                  <div className="text-sm font-semibold">{notice.title}</div>
                  <div className="mt-1 text-xs muted">{displayDate((notice.published_at ?? notice.created_at ?? "").slice(0, 10))}</div>
                </div>
              ))}
              {!teacherNotices.length && <p className="text-sm muted">No notices published yet.</p>}
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

async function loadStudentDashboardData(
  supabase: ReturnType<typeof createClient>,
  student: FamilyStudent,
  signal: AbortSignal,
): Promise<StudentDashboardData | null> {
  const [{ data: enrollment }, attendanceResult, { data: fees }] = await Promise.all([
    supabase.from("enrollments").select("class_id,section_id,academic_year_id,roll_no,classes(name),sections(name),academic_years!inner(is_current)")
      .eq("student_id", student.id).eq("status", "active")
      .eq("academic_years.school_id", student.school_id).eq("academic_years.is_current", true)
      .returns<EnrollmentRow[]>().maybeSingle(),
    loadFamilyAttendance(supabase, student),
    supabase.from("student_fees").select("id,amount,discount,late_fee,status,billing_period,due_date")
      .eq("school_id", student.school_id).eq("student_id", student.id)
      .order("created_at", { ascending: false }).limit(30).returns<StudentFeeRow[]>(),
  ]);
  if (signal.aborted) return null;

  let logs: LogRow[] = [];
  let activities: ActivityRow[] = [];
  if (enrollment) {
    let logQuery = supabase.from("class_logs")
      .select("id,log_date,topic,summary,subject_id,class_id,section_id,academic_year_id,teacher_remark,status")
      .eq("class_id", enrollment.class_id)
      .eq("status", "published");
    if (enrollment.academic_year_id) logQuery = logQuery.eq("academic_year_id", enrollment.academic_year_id);
    logQuery = enrollment.section_id
      ? logQuery.or(`section_id.is.null,section_id.eq.${enrollment.section_id}`)
      : logQuery.is("section_id", null);
    const { data } = await logQuery.order("log_date", { ascending: false }).limit(30).returns<LogRow[]>();
    if (signal.aborted) return null;
    logs = data ?? [];
    const ids = logs.map((log) => log.id);
    if (ids.length) {
      const { data } = await supabase.from("class_activities").select("id,activity_type,title,description,due_date,class_log_id").in("class_log_id", ids).order("created_at", { ascending: false }).returns<ActivityRow[]>();
      if (signal.aborted) return null;
      activities = data ?? [];
    }
  }
  return {
    student, enrollment, attendance: attendanceResult.rows,
    attendanceError: attendanceResult.error, fees: fees ?? [], logs, activities,
  };
}

function attendanceRate(rows: FamilyAttendanceRow[]) {
  if (!rows.length) return "—";
  const present = rows.filter((row) => row.status === "present" || row.status === "late").length;
  return `${Math.round(present / rows.length * 100)}%`;
}

function AttendanceHistory({ title, rows, error, loading }: {
  title: string;
  rows: FamilyAttendanceRow[];
  error: boolean;
  loading: boolean;
}) {
  return (
    <Card title={title} icon={<CalendarCheck size={18} />}>
      {loading ? <p role="status" className="text-sm muted">Loading attendance…</p>
        : error ? <p role="alert" className="text-sm text-red-600">Attendance could not be loaded. Refresh to try again.</p>
        : rows.length ? (
          <ul className="space-y-2">
            {rows.map((row) => (
              <li key={row.attendance_date} className="flex items-center justify-between rounded-xl bg-[var(--surface-2)] p-3 text-sm">
                <time dateTime={row.attendance_date}>{displayDate(row.attendance_date)}</time>
                <span className={row.status === "absent" ? "font-semibold text-red-600" : "font-semibold"}>
                  {attendanceLabels[row.status] ?? row.status}
                </span>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm muted">No attendance records available.</p>}
    </Card>
  );
}

function StudentDashboard({ userId }: { userId: string }) {
  const [supabase] = useState(createClient);
  const [data, setData] = useState<StudentDashboardData>(emptyStudentDashboard);
  const { student, enrollment, attendance, attendanceError, logs, activities, fees } = data;
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
    <div className="space-y-6">
      <Header role="student" subtitle="Your school work, attendance, homework, projects, study material, results and fees — read-only from the student account." />
      {message && <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{message}</div>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Attendance" value={attendanceRate(attendance)} tone="green" />
        <Stat label="Class Logs" value={logs.length} />
        <Stat label="Homework / Work" value={activities.length} tone="purple" />
        <Stat label="Fee Records" value={fees.length} tone="orange" />
      </div>
      <Card title="My Profile & Class" icon={<UserRound size={18} />}>
        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <div><div className="text-xs muted">Name</div><div className="mt-1 font-bold">{student ? nameOf(student) : "—"}</div></div>
          <div><div className="text-xs muted">Admission No.</div><div className="mt-1 font-bold">{student?.admission_no ?? "—"}</div></div>
          <div><div className="text-xs muted">Roll No.</div><div className="mt-1 font-bold">{enrollment?.roll_no ?? "—"}</div></div>
          <div><div className="text-xs muted">Class</div><div className="mt-1 font-bold">{enrollment?.classes?.name ?? "—"}</div></div>
          <div><div className="text-xs muted">Section</div><div className="mt-1 font-bold">{enrollment?.sections?.name ?? "—"}</div></div>
          <div><div className="text-xs muted">Status</div><div className="mt-1 font-bold">{student?.status ?? "—"}</div></div>
        </div>
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <AttendanceHistory title="Attendance History" rows={attendance.slice(0, 20)} error={attendanceError} loading={!student && !message} />
        <Card title="Today's Learning" icon={<BookOpen size={18} />}>
          <div className="space-y-2">
            {logs.filter((log) => log.log_date === dateToday()).map((log) => (
              <div key={log.id} className="rounded-xl bg-[var(--surface-2)] p-3">
                <div className="text-xs muted">{log.log_date}</div>
                <div className="mt-1 font-semibold">{log.topic}</div>
                {log.summary && <div className="mt-1 text-sm muted">{log.summary}</div>}
              </div>
            ))}
            {!logs.some((log) => log.log_date === dateToday()) && <div className="text-sm muted">No learning published for today.</div>}
          </div>
        </Card>
        <Card title="Homework · Assignments · Projects · Study Material" icon={<ClipboardList size={18} />}>
          <div className="space-y-2">
            {activities.slice(0, 20).map((a) => (
              <div key={a.id} className="rounded-xl bg-[var(--surface-2)] p-3">
                <div className="text-xs font-bold uppercase text-blue-600">{a.activity_type}</div>
                <div className="mt-1 text-sm font-semibold">{a.title}</div>
                {a.due_date && <div className="mt-1 text-xs muted">Due {a.due_date}</div>}
              </div>
            ))}
          </div>
        </Card>
      </div>
      <Card title="What You Missed" icon={<AlertCircle size={18} />}>
        <div className="space-y-3">
          {logs.filter((log) => attendance.some((record) => record.attendance_date === log.log_date && record.status === "absent" && record.academic_year_id === log.academic_year_id)).map((log) => (
            <div key={log.id} className="rounded-xl border border-[var(--border)] p-4">
              <div className="text-xs muted">{log.log_date}</div>
              <div className="mt-1 font-semibold">{log.topic}</div>
              {log.summary && <p className="mt-1 text-sm muted">{log.summary}</p>}
              {activities.filter((activity) => activity.class_log_id === log.id).map((activity) => <p key={activity.id} className="mt-2 text-sm"><b>{activity.activity_type.replaceAll("_", " ")}:</b> {activity.title}</p>)}
              {log.teacher_remark && <p className="mt-2 text-sm"><b>Teacher Remark:</b> {log.teacher_remark}</p>}
            </div>
          ))}
          {!logs.some((log) => attendance.some((record) => record.attendance_date === log.log_date && record.status === "absent" && record.academic_year_id === log.academic_year_id)) && <div className="text-sm muted">No missed academic work found.</div>}
        </div>
      </Card>
      <Card title="Daily Academic History" icon={<NotebookPen size={18} />}>
        <div className="space-y-2">
          {logs.map((l) => (
            <div key={l.id} className="rounded-xl border border-[var(--border)] p-4">
              <div className="flex justify-between text-xs muted"><span>{l.log_date}</span><span>{l.subject_id?.slice(0, 8)}</span></div>
              <div className="mt-1 font-semibold">{l.topic}</div>
              {l.summary && <div className="mt-1 text-sm muted">{l.summary}</div>}
            </div>
          ))}
        </div>
      </Card>
      <Card title="Fees" icon={<IndianRupee size={18} />}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {fees.map((f) => <div key={f.id} className="rounded-xl bg-[var(--surface-2)] p-4"><div className="text-xs muted">{f.billing_period ?? "Fee"}</div><div className="mt-1 text-xl font-black">₹{f.amount}</div><div className="mt-1 text-xs font-semibold">{f.status}</div></div>)}
        </div>
      </Card>
    </div>
  );
}

function ParentDashboard({ userId }: { userId: string }) {
  const [supabase] = useState(createClient);
  const [children, setChildren] = useState<FamilyStudent[]>([]);
  const [selected, setSelected] = useState("");
  const [childData, setChildData] = useState<{ studentId: string; data: StudentDashboardData } | null>(null);
  // A newly selected child starts with empty data until that child's request finishes.
  const { student: child, attendance, attendanceError, enrollment, logs, activities, fees } =
    childData?.studentId === selected ? childData.data : emptyStudentDashboard;
  const [message, setMessage] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const students = await loadFamilyStudents(supabase, "parent", userId);
        if (controller.signal.aborted) return;
        if (!students.length) {
          setMessage("No child is linked to this parent account yet.");
          return;
        }
        setChildren(students);
        setSelected(restoreFamilyChild(userId, students));
      } catch (error) {
        if (!controller.signal.aborted) {
          setMessage(error instanceof Error ? error.message : "Your parent profile could not be loaded. Refresh to try again.");
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
    setChildData(null);
    setSelected(id);
    rememberFamilyChild(userId, id);
  }

  return (
    <div className="space-y-6">
      <Header role="parent" subtitle="Select your child to see class, section, roll number, attendance, academic work, homework, projects, study material and fee status." />
      {message && <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-700 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300">{message}</div>}
      <Card title="Select Child" icon={<Users size={18} />}>
        <select aria-label="Select child" value={selected} onChange={(e) => selectChild(e.target.value)} className="field max-w-xl" disabled={!children.length}>
          <option value="" disabled>Select child</option>
          {children.map((s) => <option key={s.id} value={s.id}>{nameOf(s)} · {s.admission_no}</option>)}
        </select>
      </Card>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Attendance" value={attendanceRate(attendance)} tone="green" />
        <Stat label="Academic Logs" value={logs.length} />
        <Stat label="Homework / Projects" value={activities.length} tone="purple" />
        <Stat label="Fee Records" value={fees.length} tone="orange" />
      </div>
      <Card title="Child Details" icon={<GraduationCap size={18} />}>
        <div className="grid gap-3 sm:grid-cols-5 text-sm">
          <div><div className="text-xs muted">Name</div><div className="mt-1 font-bold">{child ? nameOf(child) : "—"}</div></div>
          <div><div className="text-xs muted">Admission</div><div className="mt-1 font-bold">{child?.admission_no ?? "—"}</div></div>
          <div><div className="text-xs muted">Roll No.</div><div className="mt-1 font-bold">{enrollment?.roll_no ?? "—"}</div></div>
          <div><div className="text-xs muted">Class</div><div className="mt-1 font-bold">{enrollment?.classes?.name ?? "—"}</div></div>
          <div><div className="text-xs muted">Section</div><div className="mt-1 font-bold">{enrollment?.sections?.name ?? "—"}</div></div>
        </div>
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <AttendanceHistory title="Attendance by Date" rows={attendance.slice(0, 25)} error={attendanceError} loading={!child && !message} />
        <Card title="School Work / What Was Given" icon={<ClipboardList size={18} />}>
          <div className="space-y-2">{activities.slice(0, 25).map((a) => <div key={a.id} className="rounded-xl bg-[var(--surface-2)] p-3"><div className="text-xs font-bold uppercase text-blue-600">{a.activity_type}</div><div className="mt-1 text-sm font-semibold">{a.title}</div>{a.due_date && <div className="mt-1 text-xs muted">Due {a.due_date}</div>}</div>)}</div>
        </Card>
      </div>
      <Card title="Academic History" icon={<BookOpen size={18} />}>
        <div className="space-y-2">{logs.map((l) => <div key={l.id} className="rounded-xl border border-[var(--border)] p-4"><div className="text-xs muted">{l.log_date}</div><div className="mt-1 font-semibold">{l.topic}</div>{l.summary && <div className="mt-1 text-sm muted">{l.summary}</div>}</div>)}</div>
      </Card>
      <Card title="What You Missed" icon={<AlertCircle size={18} />}>
        <div className="space-y-3">
          {logs.filter((log) => attendance.some((record) => record.attendance_date === log.log_date && record.status === "absent" && record.academic_year_id === log.academic_year_id)).map((log) => (
            <div key={log.id} className="rounded-xl border border-[var(--border)] p-4">
              <div className="text-xs muted">{log.log_date}</div>
              <div className="mt-1 font-semibold">{log.topic}</div>
              {log.summary && <p className="mt-1 text-sm muted">{log.summary}</p>}
              {activities.filter((activity) => activity.class_log_id === log.id).map((activity) => <p key={activity.id} className="mt-2 text-sm"><b>{activity.activity_type.replaceAll("_", " ")}:</b> {activity.title}</p>)}
              {log.teacher_remark && <p className="mt-2 text-sm"><b>Teacher Remark:</b> {log.teacher_remark}</p>}
            </div>
          ))}
          {!logs.some((log) => attendance.some((record) => record.attendance_date === log.log_date && record.status === "absent" && record.academic_year_id === log.academic_year_id)) && <div className="text-sm muted">No missed academic work found.</div>}
        </div>
      </Card>
      <Card title="Fees & Payment Status" icon={<IndianRupee size={18} />}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{fees.map((f) => <div key={f.id} className="rounded-xl bg-[var(--surface-2)] p-4"><div className="text-xs muted">{f.billing_period ?? "Fee"}</div><div className="mt-1 text-xl font-black">₹{f.amount}</div><div className="mt-1 text-xs font-semibold">{f.status}</div></div>)}</div>
      </Card>
    </div>
  );
}

function AdminDashboard({ schoolId }: { schoolId: string | null }) {
  const [supabase] = useState(createClient);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [overview, setOverview] = useState<AdminOverview>(emptyAdminOverview);
  const [dashboardLoading, setDashboardLoading] = useState(Boolean(schoolId));
  const [recentSchoolLogs, setRecentSchoolLogs] = useState<AdminOverviewLog[]>([]);
  const [recentSchoolActivities, setRecentSchoolActivities] = useState<AdminOverviewActivity[]>([]);
  const [upcomingSchoolAssessments, setUpcomingSchoolAssessments] = useState<AdminOverviewAssessment[]>([]);
  const [recentSchoolResults, setRecentSchoolResults] = useState<AdminOverviewResult[]>([]);
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
    setSchoolNotices([]);
    setSchoolNames({ classes: {}, sections: {}, subjects: {} });
    setReloadVersion((version) => version + 1);
  }

  useEffect(() => {
    if (!schoolId) return;
    const controller = new AbortController();
    async function load() {

      const today = dateToday();
      const todayStart = new Date(`${today}T00:00:00`).toISOString();
      const tomorrowDate = new Date(`${today}T00:00:00`);
      tomorrowDate.setDate(tomorrowDate.getDate() + 1);
      const tomorrowStart = tomorrowDate.toISOString();
      const monthStartDate = new Date(`${today.slice(0, 7)}-01T00:00:00`);
      const monthStart = monthStartDate.toISOString();
      const weekEndDate = new Date(`${today}T00:00:00`);
      weekEndDate.setDate(weekEndDate.getDate() + 7);
      const weekEnd = weekEndDate.toISOString().slice(0, 10);

      const sumCollection = async (start: string, end: string) => {
        let total = 0;
        for (let offset = 0; ; offset += 500) {
          const { data, error } = await supabase
            .from("fee_payments")
            .select("amount")
            .eq("school_id", schoolId)
            .gte("paid_at", start)
            .lt("paid_at", end)
            .order("paid_at", { ascending: true })
            .range(offset, offset + 499);
          if (error) return { total: 0, error };
          total += (data ?? []).reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
          if ((data ?? []).length < 500) return { total, error: null };
        }
      };
      if (controller.signal.aborted) return;

      const [
        studentsResult,
        teachersResult,
        parentsResult,
        classesResult,
        sectionsResult,
        attendanceResult,
        absentResult,
        todayLogsResult,
        upcomingResult,
        completedAssessmentsResult,
        pendingFeesResult,
        overdueFeesResult,
        recentLogsResult,
        noticesResult,
        todayCollectionResult,
        monthCollectionResult,
      ] = await Promise.all([
        supabase.from("students").select("id", { count: "exact", head: true }).eq("school_id", schoolId),
        supabase.from("teachers").select("id", { count: "exact", head: true }).eq("school_id", schoolId),
        supabase.from("parents").select("id", { count: "exact", head: true }).eq("school_id", schoolId),
        supabase.from("classes").select("id", { count: "exact", head: true }).eq("school_id", schoolId),
        supabase.from("sections").select("id", { count: "exact", head: true }).eq("school_id", schoolId),
        supabase.from("attendance").select("id", { count: "exact", head: true }).eq("school_id", schoolId).eq("attendance_date", today),
        supabase.from("attendance").select("id", { count: "exact", head: true }).eq("school_id", schoolId).eq("attendance_date", today).eq("status", "absent"),
        supabase.from("class_logs").select("id,teacher_id,class_id,section_id").eq("school_id", schoolId).eq("log_date", today),
        supabase.from("teacher_assessments").select("id,name,assessment_date,maximum_marks,class_id,section_id,subject_id", { count: "exact" }).eq("school_id", schoolId).gte("assessment_date", today).lte("assessment_date", weekEnd).order("assessment_date", { ascending: true }).limit(10),
        supabase.from("teacher_assessments").select("id,name,assessment_date,maximum_marks,class_id,section_id,subject_id").eq("school_id", schoolId).lt("assessment_date", today).order("assessment_date", { ascending: false }).limit(20),
        supabase.from("student_fees").select("id", { count: "exact", head: true }).eq("school_id", schoolId).neq("status", "paid"),
        supabase.from("student_fees").select("id", { count: "exact", head: true }).eq("school_id", schoolId).neq("status", "paid").lt("due_date", today),
        supabase.from("class_logs").select("id,log_date,topic,class_id,section_id,subject_id,status").eq("school_id", schoolId).order("log_date", { ascending: false }).limit(10),
        supabase.from("notices").select("id,title,content,created_at").eq("school_id", schoolId).order("created_at", { ascending: false }).limit(5),
        sumCollection(todayStart, tomorrowStart),
        sumCollection(monthStart, tomorrowStart),
      ]);
      if (controller.signal.aborted) return;

      const queryErrors = [
        ["students", studentsResult.error],
        ["teachers", teachersResult.error],
        ["parents", parentsResult.error],
        ["classes", classesResult.error],
        ["sections", sectionsResult.error],
        ["attendance today", attendanceResult.error],
        ["absent students", absentResult.error],
        ["today's class logs", todayLogsResult.error],
        ["upcoming assessments", upcomingResult.error],
        ["completed assessments", completedAssessmentsResult.error],
        ["pending fees", pendingFeesResult.error],
        ["overdue fees", overdueFeesResult.error],
        ["recent academic logs", recentLogsResult.error],
        ["notices", noticesResult.error],
        ["today's fee payments", todayCollectionResult.error],
        ["monthly fee payments", monthCollectionResult.error],
      ] as const;
      const failedQueries = queryErrors.filter(([, error]) => error);
      for (const [queryName, error] of failedQueries) {
        logAdminDashboardQueryError(queryName, error);
      }
      if (failedQueries.length) {
        setDashboardError("Some dashboard data could not be loaded. Please refresh or contact your administrator.");
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
        attendanceToday: attendanceResult.error ? null : attendanceResult.count ?? 0,
        absentToday: absentResult.error ? null : absentResult.count ?? 0,
        activeTeachers: todayLogsResult.error ? null : teacherIdsWithActivity.size,
        classesLoggedToday: todayLogsResult.error ? null : new Set(todayLogs.map((log) => `${log.class_id}:${log.section_id ?? ""}`)).size,
        upcomingExams: upcomingResult.error ? null : upcomingResult.count ?? upcoming.length,
        todayCollection: todayCollectionResult.error ? null : todayCollectionResult.total,
        monthCollection: monthCollectionResult.error ? null : monthCollectionResult.total,
        pendingFees: pendingFeesResult.error ? null : pendingFeesResult.count ?? 0,
        overdueFees: overdueFeesResult.error ? null : overdueFeesResult.count ?? 0,
      });
      setRecentSchoolLogs(logs);
      setUpcomingSchoolAssessments(upcoming);
      setSchoolNotices(noticesResult.error ? [] : noticesResult.data ?? []);

      const completedAssessmentIds = completedAssessments.map((assessment) => assessment.id);
      if (completedAssessmentIds.length) {
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
  }, [schoolId, supabase, reloadVersion]);

  const formatMoney = (amount: number) => `₹${amount.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
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

  return (
    <div className="space-y-6">
      <header className="gradient overflow-hidden rounded-[28px] p-6 text-white sm:p-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[.18em] text-white/70">School Administration</p>
            <h1 className="mt-2 text-3xl font-black sm:text-4xl">School Admin Dashboard</h1>
            <p className="mt-2 text-sm text-white/80">Monitor your school&apos;s people, learning, attendance, and finances.</p>
          </div>
          <button type="button" onClick={refresh} disabled={dashboardLoading} className="inline-flex items-center gap-2 rounded-xl border border-white/30 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10 disabled:opacity-60">
            <RefreshCw size={16} className={dashboardLoading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
      </header>
      {dashboardError && <div role="alert" className="rounded-2xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-600">{dashboardError}</div>}
      <section>
        <div className="mb-3">
          <h2 className="text-lg font-bold">School Overview</h2>
          <p className="mt-1 text-sm muted">Current school-wide records.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {[
            ["Total Students", overview.students],
            ["Total Teachers", overview.teachers],
            ["Total Parents", overview.parents],
            ["Total Classes", overview.classes],
            ["Total Sections", overview.sections],
          ].map(([label, value]) => (
            <article key={label} className="card p-5">
              <p className="text-sm font-semibold muted">{label}</p>
              <p className="mt-2 text-3xl font-black">{dashboardLoading ? "—" : value ?? "—"}</p>
            </article>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-3">
          <h2 className="text-lg font-bold">Today&apos;s Overview</h2>
          <p className="mt-1 text-sm muted">Live operational activity for today.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {[
            ["Today's Attendance", overview.attendanceToday, "Attendance records"],
            ["Absent Students", overview.absentToday, "Marked absent today"],
            ["Teachers Active", overview.activeTeachers, "Teachers with a log today"],
            ["Today's Classes", overview.classesLoggedToday, "Classes with activity today"],
            ["Pending Homework", null, "No records available yet."],
            ["Upcoming Exams", overview.upcomingExams, "Next 7 days"],
          ].map(([label, value, context]) => (
            <article key={label} className="card p-4">
              <p className="text-xs font-semibold muted">{label}</p>
              <p className="mt-2 text-2xl font-black">{dashboardLoading ? "—" : value ?? "—"}</p>
              <p className="mt-1 text-xs muted">{context}</p>
            </article>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-3">
          <h2 className="text-lg font-bold">Finance</h2>
          <p className="mt-1 text-sm muted">Collections and dues from recorded fee transactions.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[
            ["Today's Collection", overview.todayCollection === null ? null : formatMoney(overview.todayCollection)],
            ["This Month Collection", overview.monthCollection === null ? null : formatMoney(overview.monthCollection)],
            ["Pending Fees", overview.pendingFees],
            ["Overdue Fees", overview.overdueFees],
          ].map(([label, value]) => (
            <article key={label} className="card p-5">
              <p className="text-sm font-semibold muted">{label}</p>
              <p className="mt-2 text-2xl font-black">{dashboardLoading ? "—" : value ?? "—"}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <Card title="Recent Academic Logs" icon={<BookOpen size={18} />}>
          <div className="divide-y divide-[var(--border)]">
            {recentSchoolLogs.slice(0, 6).map((log) => (
              <article key={log.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs muted">{displayDate(log.log_date)} · {classLabel(log)} · {schoolNames.subjects[log.subject_id] ?? "Subject"}</p>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${log.status === "draft" ? "bg-amber-500/10 text-amber-700 dark:text-amber-300" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"}`}>{log.status === "draft" ? "Draft" : "Published"}</span>
                </div>
                <p className="mt-1 text-sm font-semibold">{log.topic}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(activityByLog.get(log.id) ?? []).map((activity) => (
                    <span key={activity.id} className="rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-xs">{activity.activity_type.replaceAll("_", " ")} · {activity.title}</span>
                  ))}
                </div>
              </article>
            ))}
            {!dashboardLoading && recentSchoolLogs.length === 0 && <p className="py-2 text-sm muted">No records available yet.</p>}
          </div>
        </Card>
        <Card title="Recent Homework" icon={<NotebookPen size={18} />}>
          <div className="space-y-2">
            {recentHomework.map((activity) => {
              const log = recentSchoolLogs.find((item) => item.id === activity.class_log_id);
              return (
                <article key={activity.id} className="rounded-xl bg-[var(--surface-2)] p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="text-sm font-semibold">{activity.title}</p>
                    {activity.due_date && <span className="text-xs muted">Due {displayDate(activity.due_date)}</span>}
                  </div>
                  {log && <p className="mt-1 text-xs muted">{displayDate(log.log_date)} · {classLabel(log)} · {schoolNames.subjects[log.subject_id] ?? "Subject"}</p>}
                </article>
              );
            })}
            {!dashboardLoading && recentHomework.length === 0 && <p className="text-sm muted">No records available yet.</p>}
          </div>
        </Card>
        <Card title="Upcoming Tests" icon={<ClipboardList size={18} />}>
          <div className="space-y-2">
            {upcomingSchoolAssessments.map((assessment) => (
              <article key={assessment.id} className="rounded-xl bg-[var(--surface-2)] p-3">
                <p className="text-sm font-semibold">{assessment.name}</p>
                <p className="mt-1 text-xs muted">{displayDate(assessment.assessment_date)} · {resultsLabel(assessment)}</p>
              </article>
            ))}
            {!dashboardLoading && upcomingSchoolAssessments.length === 0 && <p className="text-sm muted">No records available yet.</p>}
          </div>
        </Card>
        <Card title="Alerts" icon={<AlertCircle size={18} />}>
          <div className="space-y-3 text-sm">
            <div className="rounded-xl bg-[var(--surface-2)] p-3">
              <p className="font-semibold">Low Attendance</p>
              <p className="mt-1 text-xs muted">No records available yet.</p>
            </div>
            <div className="rounded-xl bg-[var(--surface-2)] p-3">
              <p className="font-semibold">Pending Fees</p>
              <p className="mt-1 text-xs muted">
                {overview.pendingFees === null || overview.overdueFees === null
                  ? "No records available yet."
                  : overview.pendingFees
                  ? `${overview.pendingFees} pending · ${overview.overdueFees} overdue`
                  : "No records available yet."}
              </p>
            </div>
            <div className="rounded-xl bg-[var(--surface-2)] p-3">
              <p className="font-semibold">Important Notices</p>
              {schoolNotices.slice(0, 2).map((notice) => (
                <p key={notice.id} className="mt-1 text-xs muted">
                  {notice.title} · {notice.created_at ? displayDate(notice.created_at.slice(0, 10)) : "Date not recorded"}
                </p>
              ))}
              {!schoolNotices.length && !dashboardLoading && <p className="mt-1 text-xs muted">No records available yet.</p>}
            </div>
            <div className="rounded-xl bg-[var(--surface-2)] p-3">
              <p className="font-semibold">Teacher Activity Issues</p>
              <p className="mt-1 text-xs muted">No records available yet.</p>
            </div>
          </div>
        </Card>
      </section>

      <Card title="Recent Results" icon={<GraduationCap size={18} />}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {recentSchoolResults.map((result) => (
            <article key={result.id} className="rounded-xl bg-[var(--surface-2)] p-4">
              <p className="text-sm font-semibold">{result.studentName}</p>
              <p className="mt-1 text-xs muted">{result.assessmentName} · {schoolNames.classes[result.classId] ?? "Class"} {schoolNames.sections[result.sectionId ?? ""] ?? ""} · {schoolNames.subjects[result.subjectId] ?? "Subject"}</p>
              <p className="mt-3 text-lg font-black">{result.marks} / {result.maximum}</p>
            </article>
          ))}
          {!dashboardLoading && recentSchoolResults.length === 0 && <p className="text-sm muted">No records available yet.</p>}
        </div>
      </Card>

    </div>
  );
}
