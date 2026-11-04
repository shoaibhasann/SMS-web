"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, BookOpen, Save, Send, Users } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import {
  activityTypes,
  getCurrentTeacherAssignments,
  getCurrentTeacherId,
  loadAcademicActivities,
  loadAcademicLogs,
  publishAcademicLog,
  saveAcademicLog,
  type AcademicActivity,
  type AcademicLogRecord,
  type TeachingAssignment,
} from "@/lib/academic";
import { createClient } from "@/lib/supabase/client";
import { resolveUiRole, toUiRole, type UiRole } from "@/lib/auth/roles";

type EligibleClass = {
  class_id: string;
  section_id: string | null;
  academic_year_id: string;
  student_id?: string;
  student_name?: string;
};

type AcademicLabels = {
  classes: Record<string, string>;
  sections: Record<string, string>;
  subjects: Record<string, string>;
  teachers: Record<string, string>;
};

const emptyLabels: AcademicLabels = { classes: {}, sections: {}, subjects: {}, teachers: {} };

function displayDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString();
}

type WorkspaceAbsence = { student: string; date: string; class_id: string; section_id: string };

async function readAcademicWorkspace() {
  const supabase = createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  if (!user) throw new Error("Please sign in to view academic work.");

  const { data: roleRows, error: roleError } = await supabase
    .from("user_roles")
    .select("role, school_id")
    .eq("user_id", user.id);
  if (roleError) throw roleError;
  const viewerRole = resolveUiRole(roleRows ?? []);
  if (!viewerRole) throw new Error("No recognized role is assigned to this login.");
  const roleRow = roleRows?.find((row) => toUiRole(row.role) === viewerRole);

  let currentTeacherId = "";
  let currentTeacherSchoolId = "";
  let absences: WorkspaceAbsence[] = [];
  let classScope: EligibleClass[] = [];
  let loadedAssignments: TeachingAssignment[] = [];
  let logFilters: Parameters<typeof loadAcademicLogs>[0] = {};
  if (viewerRole === "teacher") {
    const id = await getCurrentTeacherId();
    if (!id) throw new Error("Teacher profile was not found for this login.");
    currentTeacherId = id;
    const { data: teacher, error: teacherError } = await supabase
      .from("teachers")
      .select("school_id")
      .eq("id", id)
      .single();
    if (teacherError) throw teacherError;
    currentTeacherSchoolId = teacher.school_id;
    const ownAssignments = await getCurrentTeacherAssignments();
    loadedAssignments = ownAssignments;
    classScope = ownAssignments.map((assignment) => ({
      class_id: assignment.class_id,
      section_id: assignment.section_id,
      academic_year_id: assignment.academic_year_id,
    }));
    logFilters = { teacherId: id };
  } else if (viewerRole === "student") {
    const { data: student, error: studentError } = await supabase
      .from("students")
      .select("id,first_name,middle_name,last_name")
      .eq("profile_id", user.id)
      .maybeSingle();
    if (studentError) throw studentError;
    if (student) {
      const { data: enrollments, error: enrollmentError } = await supabase
        .from("enrollments")
        .select("class_id, section_id, academic_year_id")
        .eq("student_id", student.id)
        .eq("status", "active")
        .order("enrolled_at", { ascending: false });
      if (enrollmentError) throw enrollmentError;
      const studentName = [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" ");
      classScope = (enrollments ?? []).map((enrollment) => ({
        ...enrollment,
        student_id: student.id,
        student_name: studentName,
      })) as EligibleClass[];
    }
  } else if (viewerRole === "parent") {
    const { data: parent, error: parentError } = await supabase
      .from("parents")
      .select("id")
      .eq("profile_id", user.id)
      .maybeSingle();
    if (parentError) throw parentError;
    if (parent) {
      const { data: childLinks, error: linksError } = await supabase
        .from("student_parents")
        .select("student_id")
        .eq("parent_id", parent.id);
      if (linksError) throw linksError;
      const childIds = (childLinks ?? []).map((link) => link.student_id);
      if (childIds.length) {
        const { data: children, error: childrenError } = await supabase
          .from("students")
          .select("id,first_name,middle_name,last_name")
          .in("id", childIds);
        if (childrenError) throw childrenError;
        const childNames = new Map((children ?? []).map((child) => [
          child.id,
          [child.first_name, child.middle_name, child.last_name].filter(Boolean).join(" "),
        ]));
        const { data: enrollments, error: enrollmentError } = await supabase
          .from("enrollments")
          .select("student_id, class_id, section_id, academic_year_id")
          .in("student_id", childIds)
          .eq("status", "active");
        if (enrollmentError) throw enrollmentError;
        classScope = (enrollments ?? []).map((enrollment) => ({
          ...enrollment,
          student_name: childNames.get(enrollment.student_id) ?? "Student",
        })) as EligibleClass[];
      }
    }
  } else {
    logFilters = { schoolId: roleRow?.school_id ?? undefined };
  }

  if (classScope.length) {
    logFilters = {
      ...logFilters,
      classIds: [...new Set(classScope.map((entry) => entry.class_id))],
      status: viewerRole === "student" || viewerRole === "parent" ? "published" : undefined,
    };
  }
  if ((viewerRole === "student" || viewerRole === "parent") && classScope.length === 0) {
    return { role: viewerRole, teacherId: currentTeacherId, schoolId: currentTeacherSchoolId, assignments: loadedAssignments, logs: [], activities: [], labels: emptyLabels, absences: [] };
  }

  const loadedLogs = await loadAcademicLogs(logFilters);
  const scopedLogs = classScope.length
    ? loadedLogs.filter((log) => classScope.some((entry) =>
      entry.class_id === log.class_id &&
      entry.academic_year_id === log.academic_year_id &&
      (!entry.section_id || !log.section_id || entry.section_id === log.section_id),
    ))
    : loadedLogs;
  const loadedActivities = await loadAcademicActivities(scopedLogs.map((log) => log.id));
  const classIds = [...new Set(scopedLogs.map((log) => log.class_id))];
  const sectionIds = [...new Set(scopedLogs.map((log) => log.section_id).filter(Boolean))] as string[];
  const subjectIds = [...new Set(scopedLogs.map((log) => log.subject_id))];
  const teacherIds = [...new Set(scopedLogs.map((log) => log.teacher_id))];
  const [classesResult, sectionsResult, subjectsResult, teachersResult] = await Promise.all([
    classIds.length ? supabase.from("classes").select("id,name").in("id", classIds) : Promise.resolve({ data: [], error: null }),
    sectionIds.length ? supabase.from("sections").select("id,name").in("id", sectionIds) : Promise.resolve({ data: [], error: null }),
    subjectIds.length ? supabase.from("subjects").select("id,name").in("id", subjectIds) : Promise.resolve({ data: [], error: null }),
    (viewerRole === "admin" || viewerRole === "principal" || viewerRole === "teacher") && teacherIds.length
      ? supabase.from("teachers").select("id,employee_id,full_name").in("id", teacherIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (classesResult.error) throw classesResult.error;
  if (sectionsResult.error) throw sectionsResult.error;
  if (subjectsResult.error) throw subjectsResult.error;
  if (teachersResult.error) throw teachersResult.error;
  const labels: AcademicLabels = {
    classes: Object.fromEntries((classesResult.data ?? []).map((row: { id: string; name: string }) => [row.id, row.name])),
    sections: Object.fromEntries((sectionsResult.data ?? []).map((row: { id: string; name: string }) => [row.id, row.name])),
    subjects: Object.fromEntries((subjectsResult.data ?? []).map((row: { id: string; name: string }) => [row.id, row.name])),
    teachers: Object.fromEntries((teachersResult.data ?? []).map((row: { id: string; full_name: string | null; employee_id: string | null }) => [
      row.id,
      row.full_name || row.employee_id || row.id,
    ])),
  };

  if (viewerRole === "teacher" && ownAssignmentsHaveSections(classScope)) {
    const sectionIdsForTeacher = [...new Set(classScope.map((entry) => entry.section_id).filter(Boolean))] as string[];
    const academicYearIds = [...new Set(classScope.map((entry) => entry.academic_year_id))];
    const { data: attendanceRows, error: attendanceError } = await supabase
      .from("attendance")
      .select("student_id, attendance_date, section_id")
      .in("section_id", sectionIdsForTeacher)
      .in("academic_year_id", academicYearIds)
      .eq("status", "absent")
      .order("attendance_date", { ascending: false })
      .limit(100);
    if (attendanceError) throw attendanceError;
    const rows = attendanceRows ?? [];
    const studentIds = [...new Set(rows.map((row) => row.student_id))];
    const { data: students, error: studentsError } = studentIds.length
      ? await supabase.from("students").select("id,first_name,middle_name,last_name").in("id", studentIds)
      : { data: [], error: null };
    if (studentsError) throw studentsError;
    const studentNames = new Map((students ?? []).map((student: { id: string; first_name: string; middle_name: string | null; last_name: string | null }) => [
      student.id,
      [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" "),
    ]));
    absences = rows.map((row) => ({
      student: studentNames.get(row.student_id) ?? "Student",
      date: row.attendance_date,
      class_id: classScope.find((entry) => entry.section_id === row.section_id)?.class_id ?? "",
      section_id: row.section_id,
    }));
  } else if (viewerRole === "student" || viewerRole === "parent") {
    const studentIds = [...new Set(classScope.map((entry) => entry.student_id).filter(Boolean))] as string[];
    const { data: attendanceRows, error: attendanceError } = studentIds.length
      ? await supabase
        .from("attendance")
        .select("student_id, attendance_date, section_id, academic_year_id")
        .in("student_id", studentIds)
        .eq("status", "absent")
        .order("attendance_date", { ascending: false })
        .limit(100)
      : { data: [], error: null };
    if (attendanceError) throw attendanceError;
    absences = (attendanceRows ?? []).flatMap((row) => {
      const enrolled = classScope.find((entry) =>
        entry.student_id === row.student_id &&
        entry.academic_year_id === row.academic_year_id &&
        entry.section_id === row.section_id,
      );
      return enrolled ? [{
        student: enrolled.student_name ?? "Student",
        date: row.attendance_date,
        class_id: enrolled.class_id,
        section_id: row.section_id,
      }] : [];
    });
  }
  return { role: viewerRole, teacherId: currentTeacherId, schoolId: currentTeacherSchoolId, assignments: loadedAssignments, logs: scopedLogs, activities: loadedActivities, labels, absences };
}

export function AcademicWorkspace({ module }: { module: string }) {
  return <AcademicWorkspaceView key={module} module={module} />;
}

function AcademicWorkspaceView({ module }: { module: string }) {
  const loadVersion = useRef(0);
  const appliedEdit = useRef<string | null>(null);
  const [role, setRole] = useState<UiRole | null>(null);
  const [teacherId, setTeacherId] = useState("");
  const [teacherSchoolId, setTeacherSchoolId] = useState("");
  const [assignments, setAssignments] = useState<TeachingAssignment[]>([]);
  const [logs, setLogs] = useState<AcademicLogRecord[]>([]);
  const [activities, setActivities] = useState<AcademicActivity[]>([]);
  const [labels, setLabels] = useState<AcademicLabels>(emptyLabels);
  const [selectedAssignmentId, setSelectedAssignmentId] = useState("");
  const [editingLogId, setEditingLogId] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [topic, setTopic] = useState("");
  const [summary, setSummary] = useState("");
  const [remark, setRemark] = useState("");
  const [activityValues, setActivityValues] = useState<Record<string, string>>({});
  const [filterClass, setFilterClass] = useState("all");
  const [filterSection, setFilterSection] = useState("all");
  const [filterSubject, setFilterSubject] = useState("all");
  const [filterTeacher, setFilterTeacher] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterDate, setFilterDate] = useState("");
  const [status, setStatus] = useState<"draft" | "published">("draft");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [absences, setAbsences] = useState<WorkspaceAbsence[]>([]);

  const selectedAssignment = useMemo(
    () => assignments.find((assignment) => assignment.id === selectedAssignmentId),
    [assignments, selectedAssignmentId],
  );

  const title = module === "class-logs"
    ? "Daily Academic Log"
    : module === "classwork"
      ? "Classwork"
    : module === "homework"
      ? "Homework"
      : module === "assignments"
        ? "Assignments"
        : module === "projects"
          ? "Projects"
          : module === "study-material"
            ? "Study Material"
            : "What You Missed";

  const loadWorkspace = useCallback(() => {
    const version = ++loadVersion.current;
    return readAcademicWorkspace().then((loaded) => {
      if (version !== loadVersion.current) return;
      setRole(loaded.role);
      setTeacherId(loaded.teacherId);
      setTeacherSchoolId(loaded.schoolId);
      setAssignments(loaded.assignments);
      setSelectedAssignmentId((selected) => selected || loaded.assignments[0]?.id || "");
      setLogs(loaded.logs);
      setActivities(loaded.activities);
      setLabels(loaded.labels);
      setAbsences(loaded.absences);
      const requestedLogId = typeof window === "undefined"
        ? null
        : new URLSearchParams(window.location.search).get("edit");
      if (loaded.role === "teacher" && module === "class-logs" && requestedLogId && appliedEdit.current !== requestedLogId) {
        const requestedLog = loaded.logs.find((log) => log.id === requestedLogId);
        if (requestedLog) {
          appliedEdit.current = requestedLogId;
          setEditingLogId(requestedLog.id);
          setDate(requestedLog.log_date);
          setTopic(requestedLog.topic ?? "");
          setSummary(requestedLog.summary ?? "");
          setRemark(requestedLog.teacher_remark ?? "");
          setStatus(requestedLog.status);
          setActivityValues(Object.fromEntries(
            loaded.activities
              .filter((activity) => activity.class_log_id === requestedLog.id)
              .map((activity) => [activity.activity_type, activity.title]),
          ));
          const assignment = loaded.assignments.find((item) =>
            item.class_id === requestedLog.class_id &&
            item.section_id === requestedLog.section_id &&
            item.subject_id === requestedLog.subject_id,
          );
          if (assignment) setSelectedAssignmentId(assignment.id);
        }
      }

    }).catch((error: unknown) => {
      if (version !== loadVersion.current) return;
      const errorFields = error && typeof error === "object"
        ? error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown }
        : {};
      console.error("Academic workspace load error:", {
        message: errorFields.message ?? (error instanceof Error ? error.message : String(error)),
        details: errorFields.details,
        hint: errorFields.hint,
        code: errorFields.code,
        error,
      });
      setErrorMessage(
        typeof errorFields.message === "string"
          ? errorFields.message
          : error instanceof Error
            ? error.message
            : "Academic work could not be loaded.",
      );
    }).finally(() => {
      if (version === loadVersion.current) setLoading(false);
    });
  }, [module]);

  useEffect(() => {
    void loadWorkspace();
    return () => { loadVersion.current += 1; };
  }, [loadWorkspace]);

  const visibleActivities = useMemo(() => {
    if (module === "classwork") return activities.filter((activity) => activity.activity_type === "classwork");
    if (module === "homework") return activities.filter((activity) => activity.activity_type === "homework");
    if (module === "assignments") return activities.filter((activity) => activity.activity_type === "assignment");
    if (module === "projects") return activities.filter((activity) => activity.activity_type === "project");
    if (module === "study-material") return activities.filter((activity) => activity.activity_type === "study_material");
    return activities;
  }, [activities, module]);

  const resetForm = () => {
    setEditingLogId("");
    setTopic("");
    setSummary("");
    setRemark("");
    setActivityValues({});
    setStatus("draft");
  };

  const beginEdit = (log: AcademicLogRecord) => {
    if (role !== "teacher") return;
    setEditingLogId(log.id);
    setDate(log.log_date);
    setTopic(log.topic ?? "");
    setSummary(log.summary ?? "");
    setRemark(log.teacher_remark ?? "");
    setStatus(log.status);
    const ownActivities = activities.filter((activity) => activity.class_log_id === log.id);
    setActivityValues(Object.fromEntries(ownActivities.map((activity) => [activity.activity_type, activity.title])));
    const assignment = assignments.find((item) =>
      item.class_id === log.class_id && item.section_id === log.section_id && item.subject_id === log.subject_id,
    );
    if (assignment) setSelectedAssignmentId(assignment.id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const deleteLog = async (log: AcademicLogRecord) => {
    if (!window.confirm("Delete this Daily Academic Log and its related activities?")) return;
    setErrorMessage("");
    try {
      const { error } = await createClient().from("class_logs").delete().eq("id", log.id);
      if (error) throw error;
      if (editingLogId === log.id) resetForm();
      setMessage("Academic log deleted.");
      await loadWorkspace();
    } catch (error) {
      console.error("Academic log delete error:", error);
      setErrorMessage(error instanceof Error ? error.message : "Academic log could not be deleted.");
    }
  };

  const save = async (publish: boolean) => {
    if (!selectedAssignment || !teacherId || !teacherSchoolId) {
      setErrorMessage("Select one of your assigned classes and subjects first.");
      return;
    }
    if (!date || !topic.trim() || !summary.trim()) {
      setErrorMessage("Date, Topic / Chapter, and What Was Taught are required.");
      return;
    }
    setSaving(true);
    setErrorMessage("");
    setMessage("");
    try {
      const saved = await saveAcademicLog({
        id: editingLogId || undefined,
        school_id: teacherSchoolId,
        academic_year_id: selectedAssignment.academic_year_id,
        log_date: date,
        class_id: selectedAssignment.class_id,
        section_id: selectedAssignment.section_id,
        subject_id: selectedAssignment.subject_id,
        topic,
        summary,
        teacher_remark: remark,
        activities: activityValues,
        status,
      });
      if (publish) {
        await publishAcademicLog(saved.id);
        setStatus("published");
        setMessage("Published — visible to students and parents.");
      } else {
        setStatus(status);
        setMessage(status === "published" ? "Published academic log updated." : "Draft saved — visible only to you.");
      }
      setEditingLogId(saved.id);
      await loadWorkspace();
    } catch (error) {
      console.error("Academic log save error:", error);
      setErrorMessage(error instanceof Error ? error.message : "Academic log could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const titleForLog = (log: AcademicLogRecord) => {
    const assignment = assignments.find((item) =>
      item.class_id === log.class_id && item.section_id === log.section_id && item.subject_id === log.subject_id,
    );
    return `${labels.classes[log.class_id] ?? assignment?.class_name ?? "Class"} · ${labels.sections[log.section_id] ?? assignment?.section_name ?? "Section"} · ${labels.subjects[log.subject_id] ?? assignment?.subject_name ?? "Subject"}`;
  };

  const logForActivity = (activity: AcademicActivity) => logs.find((log) => log.id === activity.class_log_id);
  const absencesWithWork = absences.filter((absence) =>
    logs.some((log) =>
      log.status === "published" &&
      log.log_date === absence.date &&
      log.class_id === absence.class_id &&
      log.section_id === absence.section_id,
    ),
  );
  const isTeacher = role === "teacher";
  const filteredLogs = module === "class-logs" ? logs.filter((log) =>
    (filterClass === "all" || log.class_id === filterClass) &&
    (filterSection === "all" || log.section_id === filterSection) &&
    (filterSubject === "all" || log.subject_id === filterSubject) &&
    (filterTeacher === "all" || log.teacher_id === filterTeacher) &&
    (filterStatus === "all" || log.status === filterStatus) &&
    (!filterDate || log.log_date === filterDate)
  ) : [];
  const isMissedView = module === "missed-activities";

  if (!role) {
    return (
      <main className="min-h-screen bg-[var(--bg)] p-6">
        <div className="mx-auto max-w-3xl rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
          {loading ? (
            <p className="text-sm muted">Loading your academic workspace...</p>
          ) : (
            <>
              <h1 className="text-xl font-bold">Academic workspace could not load</h1>
              <p role="alert" className="mt-2 text-sm text-red-600">{errorMessage}</p>
            </>
          )}
        </div>
      </main>
    );
  }

  return (
    <AppShell role={role}>
      <div className="space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-widest text-blue-600">Academic Work Engine</div>
            <h1 className="mt-1 text-3xl font-black">{title}</h1>
            <p className="mt-1 text-sm muted">
              {isTeacher
                ? "Daily Academic Log is the single source. Edit related work from its original log."
                : "Published academic work for your permitted classes and students."}
            </p>
          </div>
          {isTeacher && (
            <Link href="/modules/teacher-assignments" className="inline-flex items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold">
              View Teaching Assignments <ArrowRight size={16} />
            </Link>
          )}
        </div>

        {message && <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 text-sm text-emerald-700">{message}</div>}
        {errorMessage && <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-600">{errorMessage}</div>}

        {isTeacher && (
          <section className="card p-5">
            <div className="mb-4 flex items-center gap-2 font-bold"><Users size={18} /> My Teaching Assignments</div>
            {assignments.length ? (
              <div className="grid gap-3 md:grid-cols-2">
                {assignments.map((assignment) => (
                  <button
                    key={assignment.id}
                    type="button"
                    onClick={() => {
                      setSelectedAssignmentId(assignment.id);
                      if (editingLogId) resetForm();
                    }}
                    className={`rounded-2xl border p-4 text-left ${selectedAssignmentId === assignment.id ? "border-blue-500 bg-blue-500/5" : "border-[var(--border)]"}`}
                  >
                    <div className="text-xs muted">{assignment.class_name} — {assignment.section_name}</div>
                    <div className="mt-1 font-bold">{assignment.subject_name}</div>
                    {assignment.is_class_teacher && <div className="mt-2 text-xs text-emerald-600">Class Teacher</div>}
                  </button>
                ))}
              </div>
            ) : <p className="text-sm muted">No teaching assignments found.</p>}
          </section>
        )}

        {isTeacher && module === "class-logs" && (
          <section className="card p-6">
            <div className="mb-5 flex items-center justify-between gap-3">
              <h2 className="text-lg font-bold">{editingLogId ? "Edit Daily Academic Log" : "Create Daily Academic Log"}</h2>
              {editingLogId && <button type="button" onClick={resetForm} className="text-sm font-semibold text-blue-600">New Log / Cancel</button>}
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <label><span className="mb-2 block text-xs font-semibold">Date</span><input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3" /></label>
              <label><span className="mb-2 block text-xs font-semibold">Class / Section / Subject</span><select value={selectedAssignmentId} onChange={(event) => { setSelectedAssignmentId(event.target.value); if (editingLogId) resetForm(); }} className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3">{assignments.map((assignment) => <option key={assignment.id} value={assignment.id}>{assignment.class_name} — {assignment.section_name} — {assignment.subject_name}</option>)}</select></label>
            </div>
            {selectedAssignment && <p className="mt-3 text-sm muted">{selectedAssignment.class_name} · Section {selectedAssignment.section_name} · {selectedAssignment.subject_name}</p>}
            <label className="mt-5 block"><span className="mb-2 block text-xs font-semibold">Topic / Chapter *</span><input value={topic} onChange={(event) => setTopic(event.target.value)} className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3" placeholder="e.g. The Last Lesson" /></label>
            <label className="mt-4 block"><span className="mb-2 block text-xs font-semibold">What Was Taught *</span><textarea value={summary} onChange={(event) => setSummary(event.target.value)} rows={4} className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3" /></label>
            <div className="mt-6"><h3 className="font-bold">Academic Activities</h3><p className="mt-1 text-sm muted">Enter each activity once; the dedicated menus read from this log.</p>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                {activityTypes.map(([key, label]) => <label key={key} className="rounded-2xl border border-[var(--border)] p-4"><span className="mb-2 block text-sm font-semibold">{label}</span><textarea rows={3} value={activityValues[key] ?? ""} onChange={(event) => setActivityValues((current) => ({ ...current, [key]: event.target.value }))} className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-3 text-sm" placeholder={`Enter ${label.toLowerCase()}...`} /></label>)}
              </div>
            </div>
            <label className="mt-5 block"><span className="mb-2 block text-xs font-semibold">Teacher Remark</span><textarea value={remark} onChange={(event) => setRemark(event.target.value)} rows={3} className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3" /></label>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button type="button" disabled={saving || !selectedAssignment} onClick={() => void save(false)} className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] px-5 py-3 text-sm font-bold disabled:opacity-50"><Save size={16} />{saving ? "Saving..." : editingLogId && status === "published" ? "Save Changes" : "Save Draft"}</button>
              {status !== "published" && <button type="button" disabled={saving || !selectedAssignment} onClick={() => void save(true)} className="inline-flex items-center gap-2 rounded-xl gradient px-5 py-3 text-sm font-bold disabled:opacity-50"><Send size={16} />{saving ? "Publishing..." : "Publish for Student/Parent"}</button>}
              <span className={`text-xs font-semibold ${status === "published" ? "text-emerald-600" : "text-amber-600"}`}>{status === "published" ? "Published — visible to students and parents" : "Draft — visible only to teacher"}</span>
            </div>
          </section>
        )}

        {isMissedView ? (
          <section className="card p-5">
            <div className="mb-4 flex items-center gap-2 font-bold"><BookOpen size={18} /> Absences with Published Academic Work</div>
            {loading ? <p className="text-sm muted">Loading attendance and published work...</p> : absencesWithWork.length === 0 ? <p className="text-sm muted">No absences with published academic work were found.</p> : (
              <div className="space-y-4">
                {absencesWithWork.map((absence, index) => {
                  const missedLogs = logs.filter((log) => log.status === "published" && log.log_date === absence.date && log.class_id === absence.class_id && log.section_id === absence.section_id);
                  return <article key={`${absence.student}-${absence.date}-${absence.section_id}-${index}`} className="rounded-xl border border-[var(--border)] p-4"><div className="font-bold">{absence.student} · {displayDate(absence.date)}</div>{missedLogs.map((log) => <div key={log.id} className="mt-3 border-t border-[var(--border)] pt-3"><div className="text-sm font-semibold">{labels.subjects[log.subject_id] ?? "Subject"} · {log.topic}</div><p className="mt-1 text-sm muted">{log.summary}</p>{activities.filter((activity) => activity.class_log_id === log.id).map((activity) => <p key={activity.id} className="mt-2 text-sm"><b>{activity.activity_type.replaceAll("_", " ")}:</b> {activity.title}</p>)}{log.teacher_remark && <p className="mt-2 text-sm"><b>Teacher Remark:</b> {log.teacher_remark}</p>}</div>)}</article>;
                })}
              </div>
            )}
          </section>
        ) : module === "class-logs" ? (
          <section className="card overflow-hidden">
            <div className="border-b border-[var(--border)] p-5"><h2 className="font-bold">{isTeacher ? "My Academic Logs" : "Academic History"}</h2></div>
            {!isTeacher && <div className="grid gap-3 border-b border-[var(--border)] p-5 sm:grid-cols-2 lg:grid-cols-3">
              <select value={filterClass} onChange={(event) => setFilterClass(event.target.value)} className="field"><option value="all">All classes</option>{[...new Set(logs.map((log) => log.class_id))].map((id) => <option key={id} value={id}>{labels.classes[id] ?? id}</option>)}</select>
              <select value={filterSection} onChange={(event) => setFilterSection(event.target.value)} className="field"><option value="all">All sections</option>{[...new Set(logs.map((log) => log.section_id).filter(Boolean))].map((id) => <option key={id} value={id}>{labels.sections[id] ?? id}</option>)}</select>
              <select value={filterSubject} onChange={(event) => setFilterSubject(event.target.value)} className="field"><option value="all">All subjects</option>{[...new Set(logs.map((log) => log.subject_id))].map((id) => <option key={id} value={id}>{labels.subjects[id] ?? id}</option>)}</select>
              <select value={filterTeacher} onChange={(event) => setFilterTeacher(event.target.value)} className="field"><option value="all">All teachers</option>{[...new Set(logs.map((log) => log.teacher_id))].map((id) => <option key={id} value={id}>{labels.teachers[id] ?? id}</option>)}</select>
              <select value={filterStatus} onChange={(event) => setFilterStatus(event.target.value)} className="field"><option value="all">All statuses</option><option value="draft">Draft</option><option value="published">Published</option></select>
              <input type="date" value={filterDate} onChange={(event) => setFilterDate(event.target.value)} className="field" />
            </div>}
            {loading ? <p className="p-5 text-sm muted">Loading academic logs...</p> : filteredLogs.length === 0 ? <p className="p-5 text-sm muted">No academic logs found.</p> : <div className="divide-y divide-[var(--border)]">{filteredLogs.map((log) => <article key={log.id} className="p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-xs muted">{displayDate(log.log_date)} · {titleForLog(log)}</div><h3 className="mt-1 font-bold">{log.topic}</h3><p className="mt-1 whitespace-pre-wrap text-sm muted">{log.summary}</p></div><div className="flex items-center gap-3"><span className={`text-xs font-semibold ${log.status === "published" ? "text-emerald-600" : "text-amber-600"}`}>{log.status === "published" ? "Published — visible to students and parents" : "Draft — visible only to teacher"}</span>{isTeacher && <><button type="button" onClick={() => beginEdit(log)} className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold">Edit source log</button><button type="button" onClick={() => void deleteLog(log)} className="rounded-lg border border-red-500/30 px-3 py-2 text-sm font-semibold text-red-600">Delete</button></>}</div></div>{activities.filter((activity) => activity.class_log_id === log.id).map((activity) => <p key={activity.id} className="mt-2 text-sm"><b>{activity.activity_type.replaceAll("_", " ")}:</b> {activity.title}</p>)}{log.teacher_remark && <p className="mt-2 text-sm"><b>Teacher Remark:</b> {log.teacher_remark}</p>}</article>)}</div>}
          </section>
        ) : (
          <section className="card overflow-hidden">
            <div className="border-b border-[var(--border)] p-5"><h2 className="font-bold">{isTeacher ? `My ${title}` : title}</h2><p className="mt-1 text-sm muted">Derived from published Daily Academic Logs; no duplicate academic record is created here.</p></div>
            {loading ? <p className="p-5 text-sm muted">Loading {title.toLowerCase()}...</p> : visibleActivities.length === 0 ? <p className="p-5 text-sm muted">No {title.toLowerCase()} published yet.</p> : <div className="divide-y divide-[var(--border)]">{visibleActivities.map((activity) => {
              const log = logForActivity(activity);
              if (!log) return null;
              return <article key={activity.id} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-start sm:justify-between"><div><div className="text-xs muted">{displayDate(log.log_date)} · {titleForLog(log)}</div><h3 className="mt-1 font-bold">{log.topic}</h3><p className="mt-2 whitespace-pre-wrap text-sm">{activity.title}</p>{activity.due_date && <p className="mt-1 text-xs muted">Due {activity.due_date}</p>}</div><div className="flex items-center gap-3"><span className={`text-xs font-semibold ${log.status === "published" ? "text-emerald-600" : "text-amber-600"}`}>{log.status === "published" ? "Published — visible to students and parents" : "Draft — visible only to teacher"}</span>{isTeacher && <Link href={`/modules/class-logs?edit=${encodeURIComponent(log.id)}`} className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold">Edit source log</Link>}</div></article>;
            })}</div>}
          </section>
        )}
      </div>
    </AppShell>
  );
}

function ownAssignmentsHaveSections(scope: EligibleClass[]) {
  return scope.some((entry) => Boolean(entry.section_id));
}
