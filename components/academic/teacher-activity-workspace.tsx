"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ChevronDown, ChevronUp, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  getCurrentTeacherAssignments,
  getCurrentTeacherId,
  loadAcademicActivities,
  loadAcademicLogs,
  saveAcademicLogWithActivities,
  type AcademicActivity,
  type AcademicLogRecord,
  type AcademicActivityWrite,
  type TeachingAssignment,
} from "@/lib/academic";
import { createClient } from "@/lib/supabase/client";
import { academicAuthoringError, canEditAcademicLog, canGradeAcademicLog, matchesAcademicScope } from "@/lib/academic-permissions";
import { TeacherHomeworkGrading } from "@/components/academic/homework-grading";
import { useAcademicAssignmentRevalidation } from "@/lib/use-academic-access";
import { LoadingState } from "@/components/ui/skeleton";
import { schoolDate } from "@/lib/attendance/types";

type ActivityModule = "classwork" | "homework";

type SubmittedEntry = {
  activity: AcademicActivity;
  log: AcademicLogRecord;
};

type SchoolOption = { id: string; name: string };
type AcademicYearOption = { id: string; name: string; is_current: boolean };
type SupabaseErrorDetails = { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };

function logSupabaseError(context: string, error: unknown) {
  if (error && typeof error === "object") {
    const details = error as SupabaseErrorDetails;
    console.error(context, {
      message: details.message,
      details: details.details,
      hint: details.hint,
      code: details.code,
    });
    return;
  }
  console.error(context, error);
}

function userError(error: unknown, fallback: string) {
  if (error instanceof Error && !(error as Error & { code?: string }).code) return error.message;
  return fallback;
}

function displayDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function activityName(module: ActivityModule) {
  return module === "classwork" ? "Classwork" : "Homework";
}

export function TeacherAcademicActivityWorkspace({ module }: { module: ActivityModule }) {
  return <TeacherAcademicActivityView key={module} module={module} />;
}

function TeacherAcademicActivityView({ module }: { module: ActivityModule }) {
  const loadVersion = useRef(0);
  const historyFilters = useRef({ yearId: "current", date: "", classId: "all", sectionId: "all", subjectId: "all" });
  const label = activityName(module);
  const [teacherId, setTeacherId] = useState("");
  const [teacherSchoolId, setTeacherSchoolId] = useState("");
  const [teacherName, setTeacherName] = useState("Teacher");
  const [teacherEmail, setTeacherEmail] = useState("");
  const [teacherUserId, setTeacherUserId] = useState("");
  const [academicYearId, setAcademicYearId] = useState("");
  const [currentAcademicYearId, setCurrentAcademicYearId] = useState("");
  const [assignments, setAssignments] = useState<TeachingAssignment[]>([]);
  const [academicYears, setAcademicYears] = useState<AcademicYearOption[]>([]);
  const [classes, setClasses] = useState<SchoolOption[]>([]);
  const [sectionResult, setSectionResult] = useState<{ classId: string; rows: SchoolOption[]; error: string } | null>(null);
  const [subjects, setSubjects] = useState<SchoolOption[]>([]);
  const [historySectionResult, setHistorySectionResult] = useState<{ scope: string; rows: SchoolOption[] } | null>(null);
  const [entries, setEntries] = useState<SubmittedEntry[]>([]);
  const [selectedClassId, setSelectedClassId] = useState("");
  const [selectedSectionId, setSelectedSectionId] = useState("");
  const [selectedSubjectId, setSelectedSubjectId] = useState("");
  const [editingActivityId, setEditingActivityId] = useState("");
  const [editingEntry, setEditingEntry] = useState<SubmittedEntry | null>(null);
  const [date, setDate] = useState(() => schoolDate());
  const [details, setDetails] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [maximumMarks, setMaximumMarks] = useState("");
  const [filterDate, setFilterDate] = useState("");
  const [filterYear, setFilterYear] = useState("current");
  const [filterClass, setFilterClass] = useState("all");
  const [filterSection, setFilterSection] = useState("all");
  const [filterSubject, setFilterSubject] = useState("all");
  const [expandedActivityId, setExpandedActivityId] = useState("");
  const [pendingDelete, setPendingDelete] = useState<SubmittedEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const classAssignments = assignments.filter((assignment) => assignment.class_id === selectedClassId && assignment.academic_year_id === academicYearId);
  const workClasses = classes.filter((item) => assignments.some((assignment) => assignment.class_id === item.id && assignment.academic_year_id === academicYearId));
  const workYears = academicYears.filter((item) => assignments.some((assignment) => assignment.academic_year_id === item.id));
  const sections = sectionResult?.classId === selectedClassId ? sectionResult.rows.filter((item) => classAssignments.some((assignment) => assignment.section_id === item.id)) : [];
  const workSubjects = subjects.filter((item) => classAssignments.some((assignment) => assignment.section_id === selectedSectionId && assignment.subject_id === item.id));
  const sectionsLoading = Boolean(selectedClassId) && sectionResult?.classId !== selectedClassId;
  const sectionsError = sectionResult?.classId === selectedClassId ? sectionResult.error : "";
  const historySectionScope = `${teacherSchoolId}:${filterClass}`;
  const filterSections = filterClass !== "all" && historySectionResult?.scope === historySectionScope ? historySectionResult.rows : [];

  const selectedEntry = editingEntry?.activity.id === editingActivityId ? editingEntry : undefined;
  const assignmentsForSelectedClass = assignments.filter((assignment) =>
    assignment.class_id === selectedClassId &&
    assignment.academic_year_id === academicYearId,
  );
  const selectedAssignment = assignmentsForSelectedClass.find((assignment) =>
    assignment.section_id === selectedSectionId &&
    assignment.subject_id === selectedSubjectId,
  );

  const load = useCallback(() => {
    const version = ++loadVersion.current;
    const read = async () => {
      const currentTeacherId = await getCurrentTeacherId();
      if (!currentTeacherId) throw new Error("Teacher profile was not found for this login.");

      const supabase = createClient();
      const [{ data: { user }, error: authError }, { data: teacher, error: teacherError }, ownAssignments] = await Promise.all([
        supabase.auth.getUser(),
        supabase
          .from("teachers")
          .select("school_id,full_name")
          .eq("id", currentTeacherId)
          .single(),
        getCurrentTeacherAssignments({ currentYearOnly: true }),
      ]);
      if (authError) throw authError;
      if (teacherError) throw teacherError;
      const [{ data: yearRows, error: yearError }, { data: classRows, error: classError }, { data: subjectRows, error: subjectError }] = await Promise.all([
        supabase
          .from("academic_years")
          .select("id,name,is_current")
          .eq("school_id", teacher.school_id)
          .order("start_date", { ascending: false }),
        supabase
          .from("classes")
          .select("id,name")
          .eq("school_id", teacher.school_id)
          .eq("is_active", true)
          .order("sort_order"),
        supabase
          .from("subjects")
          .select("id,name")
          .eq("school_id", teacher.school_id)
          .order("name"),
      ]);
      if (yearError) throw yearError;
      if (classError) throw classError;
      if (subjectError) throw subjectError;
      const filters = historyFilters.current;
      const currentYear = yearRows?.find((year) => year.is_current);
      if (filters.yearId === "current" && !currentYear) throw new Error("Select an academic year to load history; no current year is configured.");
      // Own logs plus published logs inherited through a current assignment (RLS); office-readable logs of other scopes are dropped.
      const ownLogs = (await loadAcademicLogs({ schoolId: teacher.school_id,
        academicYearId: filters.yearId === "current" ? currentYear?.id : filters.yearId === "all" ? undefined : filters.yearId,
        logDate: filters.date || undefined,
        classIds: filters.classId === "all" ? undefined : [filters.classId],
        sectionIds: filters.sectionId === "all" ? undefined : [filters.sectionId],
        subjectId: filters.subjectId === "all" ? undefined : filters.subjectId,
        activityType: module,
      })).filter((log) => log.teacher_id === currentTeacherId
        || (log.status === "published" && canGradeAcademicLog(ownAssignments, currentTeacherId, teacher.school_id, log)));
      const ownActivities = await loadAcademicActivities(ownLogs.map((log) => log.id));
      const logsById = new Map(ownLogs.map((log) => [log.id, log]));
      const submitted = ownActivities
        .filter((activity) => activity.activity_type === module)
        .flatMap((activity) => {
          const log = logsById.get(activity.class_log_id);
          return log ? [{ activity, log }] : [];
        })
        .sort((left, right) => right.log.log_date.localeCompare(left.log.log_date));

      return { currentTeacherId, teacher, user, ownAssignments, yearRows, classRows, subjectRows, submitted };
    };
    return read().then(({ currentTeacherId, teacher, user, ownAssignments, yearRows, classRows, subjectRows, submitted }) => {
      if (version !== loadVersion.current) return;
      setTeacherId(currentTeacherId);
      setTeacherSchoolId(teacher.school_id);
      setTeacherName(teacher.full_name || "Teacher");
      setTeacherEmail(user?.email ?? "");
      setTeacherUserId(user?.id ?? "");
      setAssignments(ownAssignments);
      const currentYear = yearRows?.find((year) => year.is_current) ?? null;
      setAcademicYears(yearRows ?? []);
      setAcademicYearId((selected) => ownAssignments.some((assignment) => assignment.academic_year_id === selected)
        ? selected
        : currentYear?.id ?? ownAssignments[0]?.academic_year_id ?? "");
      setCurrentAcademicYearId(currentYear?.id ?? "");
      setClasses(classRows ?? []);
      setSubjects(subjectRows ?? []);
      setEntries(submitted);
    }).catch((loadError: unknown) => {
      if (version !== loadVersion.current) return;
      logSupabaseError(`${label} workspace load failed`, loadError);
      setError(userError(loadError, `${label} could not be loaded. Please try again.`));
    }).finally(() => {
      if (version === loadVersion.current) setLoading(false);
    });
  }, [label, module]);

  useEffect(() => {
    void load();
    return () => { loadVersion.current += 1; };
  }, [load]);

  useEffect(() => {
    if (!selectedClassId) return;
    let active = true;
    const loadSections = async () => {
      try {
        const { data, error: sectionError } = await createClient()
          .from("sections")
          .select("id,name,class_id")
          .eq("class_id", selectedClassId)
          .order("name");
        if (sectionError) throw sectionError;
        if (active) {
          setSectionResult({ classId: selectedClassId, rows: data ?? [], error: "" });
          setSelectedSectionId((current) => data?.some((section) => section.id === current) ? current : "");
        }
      } catch (sectionLoadError) {
        if (active) {
          logSupabaseError(`${label} section load failed`, sectionLoadError);
          setSectionResult({ classId: selectedClassId, rows: [], error: "Error loading sections. Please try again." });
        }
      }
    };
    void loadSections();
    return () => { active = false; };
  }, [label, selectedClassId]);

  useEffect(() => {
    if (filterClass === "all" || !teacherSchoolId) return;
    let active = true;
    const loadHistorySections = async () => {
      const { data, error: sectionError } = await createClient()
        .from("sections")
        .select("id,name")
        .eq("school_id", teacherSchoolId)
        .eq("class_id", filterClass)
        .order("name");
      if (!active) return;
      if (sectionError) {
        logSupabaseError(`${label} history section load failed`, sectionError);
        setError("History filters could not be loaded. Please try again.");
        return;
      }
      setHistorySectionResult({ scope: historySectionScope, rows: data ?? [] });
    };
    void loadHistorySections();
    return () => { active = false; };
  }, [filterClass, historySectionScope, label, teacherSchoolId]);

  const visibleEntries = useMemo(() => entries.filter(({ log }) =>
    (!filterDate || log.log_date === filterDate) &&
    (filterClass === "all" || log.class_id === filterClass) &&
    (filterSection === "all" || log.section_id === filterSection) &&
    (filterSubject === "all" || log.subject_id === filterSubject),
  ), [entries, filterClass, filterDate, filterSection, filterSubject]);

  const resetForm = () => {
    setEditingEntry(null);
    setEditingActivityId("");
    setDate(schoolDate());
    setDetails("");
    setDueDate("");
    setMaximumMarks("");
    setSelectedClassId("");
    setSelectedSectionId("");
    setSelectedSubjectId("");
    setAcademicYearId(currentAcademicYearId);
    setMessage("");
  };

  const editEntry = (entry: SubmittedEntry) => {
    if (!canEditAcademicLog(assignments, teacherId, teacherSchoolId, entry.log)) return;
    setEditingEntry(entry);
    setEditingActivityId(entry.activity.id);
    setDate(entry.log.log_date);
    setDetails(entry.activity.title);
    setDueDate(entry.activity.due_date ?? "");
    setMaximumMarks(entry.activity.max_marks === null || entry.activity.max_marks === undefined ? "" : String(entry.activity.max_marks));
    setAcademicYearId(entry.log.academic_year_id);
    setSelectedClassId(entry.log.class_id);
    setSelectedSectionId(entry.log.section_id);
    setSelectedSubjectId(entry.log.subject_id);
    setMessage("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!date) {
      setError("Please select a date.");
      return;
    }
    if (!selectedClassId) {
      setError("Please select a class.");
      return;
    }
    if (!selectedSectionId) {
      setError("Please select a section.");
      return;
    }
    if (!selectedSubjectId) {
      setError("Please select a subject.");
      return;
    }
    if (module === "homework" && maximumMarks.trim() && (!Number.isFinite(Number(maximumMarks)) || Number(maximumMarks) < 0)) {
      setError("Maximum marks must be zero or a positive number."); return;
    }
    if (!details.trim()) {
      setError(`Please enter ${label.toLowerCase()} details.`);
      return;
    }
    if (!teacherId || !teacherSchoolId) {
      setError("Teacher workspace information could not be loaded. Please reload and try again.");
      return;
    }
    const assignedCombination = assignments.find((assignment) =>
      assignment.class_id === selectedClassId &&
      assignment.section_id === selectedSectionId &&
      assignment.subject_id === selectedSubjectId &&
      assignment.academic_year_id === academicYearId,
    );
    if (!assignedCombination || (selectedEntry && !canEditAcademicLog(assignments, teacherId, teacherSchoolId, selectedEntry.log))) {
      setError("Select one of your current class, section and subject assignments.");
      return;
    }
    setSaving(true);
    setError("");
    setMessage("");
    const supabase = createClient();
    try {
      const current = await getCurrentTeacherAssignments({ currentYearOnly: true });
      if (!current.some((assignment) => assignment.teacher_id === teacherId && matchesAcademicScope(assignment, assignedCombination))
        || (selectedEntry && !canEditAcademicLog(current, teacherId, teacherSchoolId, selectedEntry.log))) {
        throw new Error("Your teaching assignment changed. Refresh before saving work.");
      }
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError) throw authError;
      if (!user) throw new Error("Please sign in before submitting academic work.");

      const { data: destinationLog, error: destinationError } = await supabase
        .from("class_logs")
        .select("id,school_id,academic_year_id,log_date,class_id,section_id,subject_id,teacher_id,topic,summary,teacher_remark,status,published_at,updated_at")
        .eq("teacher_id", teacherId)
        .eq("academic_year_id", assignedCombination.academic_year_id)
        .eq("class_id", selectedClassId)
        .eq("section_id", selectedSectionId)
        .eq("subject_id", selectedSubjectId)
        .eq("log_date", date)
        .maybeSingle();
      if (destinationError) throw destinationError;

      const sourceLogId = selectedEntry?.log.id;
      if (destinationLog && destinationLog.status === "draft" && destinationLog.id !== sourceLogId) {
        throw new Error("A private draft already exists for this class and date. Keep it private or resolve it before submitting new work.");
      }
      if (editingActivityId && (!selectedEntry || destinationLog?.id !== selectedEntry.log.id)) {
        throw new Error("This activity's class and date cannot be changed. Create new work for another class or date.");
      }
      const destinationStatus = destinationLog?.status ?? "published";
      const existingActivities = destinationLog ? await loadAcademicActivities([destinationLog.id]) : [];
      if (editingActivityId && !existingActivities.some((activity) => activity.id === editingActivityId)) {
        throw new Error("The activity was not saved; it may no longer belong to your workspace.");
      }
      const rows: AcademicActivityWrite[] = existingActivities.map((activity) => ({ id: activity.id, activity_type: activity.activity_type,
        title: activity.id === editingActivityId ? details.trim() : activity.title,
        description: activity.description, due_date: activity.id === editingActivityId && module === "homework" ? dueDate || null : activity.due_date,
        attachment_url: activity.attachment_url ?? null, max_marks: activity.id === editingActivityId && module === "homework" ? maximumMarks.trim() ? Number(maximumMarks) : null : activity.max_marks ?? null,
      }));
      if (!editingActivityId) rows.push({ activity_type: module, title: details.trim(),
        description: label, due_date: module === "homework" ? dueDate || null : null, attachment_url: null, max_marks: module === "homework" && maximumMarks.trim() ? Number(maximumMarks) : null });
      await saveAcademicLogWithActivities({
        id: destinationLog?.id, expected_updated_at: editingActivityId ? selectedEntry?.log.updated_at : destinationLog?.updated_at, school_id: teacherSchoolId, academic_year_id: assignedCombination.academic_year_id,
        class_id: selectedClassId, section_id: selectedSectionId, subject_id: selectedSubjectId, log_date: date,
        topic: destinationLog?.topic ?? details.trim().slice(0, 160), summary: destinationLog?.summary ?? `${label} was submitted.`,
        teacher_remark: destinationLog?.teacher_remark ?? undefined, status: destinationStatus,
      }, rows);

      setEditingActivityId("");
      setEditingEntry(null);
      setDetails("");
      setDueDate("");
      setMaximumMarks("");
      setMessage(editingActivityId
        ? destinationStatus === "published" ? `${label} updated successfully.` : `${label} updated. Draft — visible only to teacher.`
        : module === "classwork" ? "Classwork submitted successfully." : "Homework submitted successfully.");
      await load();
    } catch (saveError) {
      logSupabaseError(`${label} save failed`, saveError);
      setError(academicAuthoringError(saveError, `${label} could not be saved. Please verify your assignment and try again.`));
    } finally {
      setSaving(false);
    }
  };

  const deleteEntry = async (entry: SubmittedEntry) => {
    if (!canEditAcademicLog(assignments, teacherId, teacherSchoolId, entry.log) || saving) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const current = await getCurrentTeacherAssignments({ currentYearOnly: true });
      if (!canEditAcademicLog(current, teacherId, teacherSchoolId, entry.log)) throw new Error("Your teaching assignment changed. Refresh before deleting work.");
      const supabase = createClient();
      const { data: deletedActivity, error: deleteError } = await supabase
        .from("class_activities")
        .delete()
        .eq("id", entry.activity.id)
        .eq("class_log_id", entry.log.id)
        .select("id")
        .maybeSingle();
      if (deleteError) throw deleteError;
      if (!deletedActivity) throw new Error("This activity was not deleted; it may no longer belong to your workspace.");

      // Keep the parent: an independent empty check could erase new work added
      // by another session before a cascading parent delete.
      if (editingActivityId === entry.activity.id) resetForm();
      setPendingDelete(null);
      setMessage(`${label} deleted.`);
      await load();
    } catch (deleteError) {
      logSupabaseError(`${label} delete failed`, deleteError);
      setError(academicAuthoringError(deleteError, `${label} could not be deleted. Please try again.`));
    } finally { setSaving(false); }
  };

  const className = (id: string) => classes.find((item) => item.id === id)?.name ?? id;
  const sectionName = (id: string) => [...sections, ...filterSections].find((item) => item.id === id)?.name
    ?? assignments.find((assignment) => assignment.section_id === id)?.section_name
    ?? id;
  const subjectName = (id: string) => subjects.find((item) => item.id === id)?.name
    ?? assignments.find((assignment) => assignment.subject_id === id)?.subject_name
    ?? id;
  const selectAssignment = (assignment: TeachingAssignment) => {
    if (editingActivityId || saving) return;
    setAcademicYearId(assignment.academic_year_id);
    setSelectedClassId(assignment.class_id);
    setSelectedSectionId(assignment.section_id);
    setSelectedSubjectId(assignment.subject_id);
    setError("");
  };

  useAcademicAssignmentRevalidation({ enabled: !loading && Boolean(teacherId), assignments,
    onChanged: (next) => {
      // Keep the typed draft unless the class/section/subject it targets was actually revoked.
      const kept = editingEntry ? canEditAcademicLog(next, teacherId, teacherSchoolId, editingEntry.log)
        : !selectedClassId || next.some((assignment) => assignment.teacher_id === teacherId && assignment.academic_year_id === academicYearId
          && assignment.class_id === selectedClassId && (!selectedSectionId || assignment.section_id === selectedSectionId)
          && (!selectedSubjectId || assignment.subject_id === selectedSubjectId));
      setAssignments([]); setEntries([]); setLoading(true); setPendingDelete(null);
      if (kept) {
        setError(""); setMessage("Your teaching assignments were re-checked. Any unsaved draft is kept.");
      } else {
        resetForm(); setError("Your teaching assignments changed. The workspace is refreshing its access.");
      }
      void load();
    },
    onUnavailable: () => {
      // Clearing assignments blocks saving; the draft stays until a successful check confirms revocation.
      setAssignments([]); setEntries([]); setPendingDelete(null);
      setError("Teaching access could not be verified. Your unsaved draft is kept; saving is blocked until access is re-checked.");
    },
  });

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-widest text-blue-700 dark:text-blue-300">Teacher Workspace</p>
        <h1 className="mt-1 text-2xl font-black sm:text-3xl">{label}</h1>
        <button type="button" disabled={saving || loading} className="mt-3 min-h-11 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold disabled:opacity-50" onClick={() => { setLoading(true); setEntries([]); resetForm(); setPendingDelete(null); setError(""); void load(); }}>Refresh teaching access</button>
      </header>

      {message && <div role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm text-success">{message}</div>}
      {error && <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-danger">{error}</div>}

      <form onSubmit={submit} className="card max-w-5xl space-y-5 p-5 sm:p-6">
        <fieldset disabled={saving} aria-label={`${label} editor`} className="min-w-0 space-y-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold">{editingActivityId ? `Edit ${label}` : `Add ${label}`}</h2>
          {editingActivityId && <button type="button" onClick={resetForm} className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-blue-700 dark:text-blue-300"><X size={16} />Cancel</button>}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block min-w-0 text-sm font-semibold"><span className="mb-2 block leading-5">Date</span>
            <input required type="date" disabled={Boolean(editingActivityId) || saving} value={date} onChange={(event) => setDate(event.target.value)} className="field" />
          </label>
          <label className="block min-w-0 text-sm font-semibold"><span className="mb-2 block leading-5">Academic Year</span>
            <select required value={academicYearId} onChange={(event) => {
              setAcademicYearId(event.target.value);
              setSelectedClassId("");
              setSelectedSectionId("");
              setSelectedSubjectId("");
              setError("");
            }} className="field" disabled={loading || Boolean(editingActivityId) || saving}>
              <option value="">{loading ? "Loading academic years..." : "Select academic year"}</option>
              {workYears.map((year) => <option key={year.id} value={year.id}>{year.name}{year.is_current ? " (Current)" : ""}</option>)}
            </select>
          </label>
          <label className="block min-w-0 text-sm font-semibold"><span className="mb-2 block leading-5">Class</span>
            <select required value={selectedClassId} onChange={(event) => {
              setSelectedClassId(event.target.value);
              setSelectedSectionId("");
              setSelectedSubjectId("");
                        setError("");
            }} className="field" disabled={loading || Boolean(editingActivityId) || saving}>
              <option value="">{loading ? "Loading classes..." : "Select class"}</option>{workClasses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label className="block min-w-0 text-sm font-semibold"><span className="mb-2 block leading-5">Section</span>
            <select required value={selectedSectionId} onChange={(event) => {
              setSelectedSectionId(event.target.value);
              setSelectedSubjectId("");
              setError("");
            }} className="field" disabled={!selectedClassId || sectionsLoading || Boolean(editingActivityId) || saving}>
              <option value="">{!selectedClassId ? "Select class first" : sectionsLoading ? "Loading sections..." : sectionsError ? "Error loading sections" : sections.length ? "Select section" : "No sections found for this class"}</option>{sections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            {sectionsError && <span role="alert" className="mt-2 block text-xs font-medium text-danger">{sectionsError}</span>}
          </label>
          <label className="block min-w-0 text-sm font-semibold"><span className="mb-2 block leading-5">Subject</span>
            <select required value={selectedSubjectId} onChange={(event) => {
              setSelectedSubjectId(event.target.value);
              setError("");
            }} className="field" disabled={loading || !selectedSectionId || Boolean(editingActivityId) || saving}>
              <option value="">{loading ? "Loading subjects..." : workSubjects.length ? "Select subject" : "No assigned subjects"}</option>{workSubjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
        </div>
        {selectedClassId && assignmentsForSelectedClass.length === 0 && (
          <p className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm font-medium text-amber-700 dark:text-amber-300">
            This class is not assigned to you for the selected academic year. Please select one of your assigned classes.
          </p>
        )}
        {selectedClassId && assignmentsForSelectedClass.length > 0 && selectedSectionId && selectedSubjectId && (
          <p className={`rounded-xl p-3 text-sm font-semibold ${selectedAssignment ? "border border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300" : "border border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300"}`}>
            {selectedAssignment ? "✓ Assigned to you" : "⚠ This class / section / subject is not assigned to you."}
          </p>
        )}
        {selectedClassId && assignmentsForSelectedClass.length > 0 && (!selectedSectionId || !selectedSubjectId) && (
          <p className="text-sm muted">Choose a section and subject to verify your teaching assignment.</p>
        )}
        <label className="block text-sm font-semibold"><span className="mb-2 block leading-5">{label} Details</span>
          <textarea required value={details} onChange={(event) => setDetails(event.target.value)} rows={8} className="field min-h-[200px] text-base leading-7" placeholder={module === "classwork" ? "Write what was taught in class today...\nExample:\nChapter 4 - Fractions\nExplained equivalent fractions.\nSolved examples 1-5.\nStudents completed exercise 4.1." : "Enter homework details, questions, chapters, instructions, etc."} />
        </label>
        {module === "homework" && <label className="block max-w-sm text-sm font-semibold"><span className="mb-2 block leading-5">Due Date</span>
          <input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} className="field" />
        </label>}
        {module === "homework" && <label className="block max-w-sm text-sm font-semibold"><span className="mb-2 block leading-5">Maximum marks (optional)</span><input type="number" min={0} step="0.01" value={maximumMarks} onChange={(event) => setMaximumMarks(event.target.value)} className="field w-full" /><span className="mt-2 block text-xs muted">Set a maximum for numeric grades. Without it, submissions can receive written feedback.</span></label>}
        {editingActivityId && <p className="text-sm muted">To use another date, class or subject, create new work.</p>}
        {selectedEntry?.log.status === "draft" && <p className="flex flex-wrap items-center gap-2"><span className="badge text-warning">Draft</span><span className="text-xs muted">Visible only to teacher. Editing will not publish the parent log.</span></p>}
        <button type="submit" disabled={saving || loading || !academicYearId || !assignments.length || !classes.length || !selectedAssignment || sectionsLoading || Boolean(sectionsError)} className="inline-flex items-center gap-2 rounded-xl gradient px-5 py-3 text-sm font-bold disabled:opacity-50">
          {editingActivityId ? <Pencil size={16} /> : <Plus size={16} />}{saving ? "Saving..." : editingActivityId ? `Update ${label}` : `Submit ${label}`}
        </button>
        {module === "homework" && assignments.length > 0 && (
          <div className="border-t border-[var(--border)] pt-4">
            <h3 className="text-sm font-bold">My Assigned Classes</h3>
            <div className="mt-3 flex flex-wrap gap-2">
              {assignments.map((assignment) => (
                <button key={assignment.id} type="button" disabled={Boolean(editingActivityId) || saving} onClick={() => selectAssignment(assignment)}
                  aria-pressed={assignment.id === selectedAssignment?.id}
                  className={`rounded-full border px-3 py-2 text-left text-xs font-semibold transition ${assignment.id === selectedAssignment?.id ? "border-blue-500 bg-blue-500/10 text-blue-700 dark:text-blue-300" : "border-[var(--border)] hover:bg-[var(--surface-2)]"}`}>
                  {assignment.class_name} • {assignment.section_name} • {assignment.subject_name}
                </button>
              ))}
            </div>
          </div>
        )}
        </fieldset>
      </form>

      <section className="card overflow-hidden">
        <div className="border-b border-[var(--border)] p-5">
          <h2 className="font-bold">Submitted {label}</h2>
          <p className="mt-1 text-xs muted">Records are stored in the existing academic log and class activity tables.</p>
        </div>
        <div className="grid gap-4 border-b border-[var(--border)] p-5 sm:grid-cols-2 lg:grid-cols-5">
          <label className="block text-sm font-semibold">History year<select value={filterYear} onChange={(event) => setFilterYear(event.target.value)} className="field mt-2"><option value="current">Current year</option><option value="all">All available years</option>{academicYears.map((year) => <option key={year.id} value={year.id}>{year.name}</option>)}</select></label>
          <label className="block text-sm font-semibold">Date<input type="date" value={filterDate} onChange={(event) => setFilterDate(event.target.value)} className="field mt-2" /></label>
          <label className="block text-sm font-semibold">Class<select value={filterClass} onChange={(event) => { setFilterClass(event.target.value); setFilterSection("all"); }} className="field mt-2"><option value="all">All Classes</option>{classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label className="block text-sm font-semibold">Section<select value={filterSection} onChange={(event) => setFilterSection(event.target.value)} className="field mt-2" disabled={filterClass === "all"}><option value="all">All Sections</option>{filterSections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label className="block text-sm font-semibold">Subject<select value={filterSubject} onChange={(event) => setFilterSubject(event.target.value)} className="field mt-2"><option value="all">All Subjects</option>{subjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <div className="sm:col-span-2 lg:col-span-5"><button type="button" disabled={saving || loading} onClick={() => {
            historyFilters.current = { yearId: filterYear, date: filterDate, classId: filterClass, sectionId: filterSection, subjectId: filterSubject };
            setLoading(true); setEntries([]); setError(""); void load();
          }} className="min-h-11 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold disabled:opacity-50">Apply history filters</button><p className="mt-2 text-xs muted">Apply to load all matching saved work, including older years. Your open draft is kept.</p></div>
        </div>
        {loading ? <LoadingState variant="table" className="p-5 text-sm muted">Loading complete {label.toLowerCase()} history for the selected scope...</LoadingState> : visibleEntries.length === 0 ? (
          <div className="p-8 text-center">
            <h3 className="font-bold">No {label} Yet</h3>
            <p className="mt-1 text-sm muted">You haven&apos;t submitted any {label.toLowerCase()} yet.</p>
            <button type="button" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} className="mt-4 inline-flex items-center gap-2 rounded-xl gradient px-4 py-2.5 text-sm font-bold"><Plus size={16} />Add {label}</button>
          </div>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {visibleEntries.map((entry) => {
              const expanded = expandedActivityId === entry.activity.id;
              return (
                <article key={entry.activity.id} className="p-4 sm:p-5">
                  <button type="button" aria-expanded={expanded} onClick={() => setExpandedActivityId(expanded ? "" : entry.activity.id)} className="flex w-full items-center justify-between gap-4 rounded-xl p-2 text-left transition hover:bg-[var(--surface-2)]">
                    <span className="min-w-0">
                      <span className="block text-xs muted">{displayDate(entry.log.log_date)} · {className(entry.log.class_id)} {sectionName(entry.log.section_id)} · {subjectName(entry.log.subject_id)}</span>
                      <span className="mt-2 block truncate font-semibold">{entry.activity.title}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-xs font-semibold text-blue-700 dark:text-blue-300">
                      {expanded ? "Close" : "Open"}
                      {expanded ? <ChevronUp size={19} className="muted" /> : <ChevronDown size={19} className="muted" />}
                    </span>
                  </button>
                  {expanded && (
                    <div className="mt-3 rounded-xl bg-[var(--surface-2)] p-4">
                      <dl className="grid gap-3 text-sm sm:grid-cols-2">
                        <div><dt className="text-xs muted">Date</dt><dd className="mt-1 font-medium">{displayDate(entry.log.log_date)}</dd></div>
                        <div><dt className="text-xs muted">Class</dt><dd className="mt-1 font-medium">{className(entry.log.class_id)}</dd></div>
                        <div><dt className="text-xs muted">Section</dt><dd className="mt-1 font-medium">{sectionName(entry.log.section_id)}</dd></div>
                        <div><dt className="text-xs muted">Subject</dt><dd className="mt-1 font-medium">{subjectName(entry.log.subject_id)}</dd></div>
                        {module === "homework" && <div><dt className="text-xs muted">Due Date</dt><dd className="mt-1 font-medium">{entry.activity.due_date ? displayDate(entry.activity.due_date) : "—"}</dd></div>}
                        <div><dt className="text-xs muted">Teacher</dt><dd className="mt-1 font-medium">{entry.log.teacher_id === teacherId ? `${teacherName}${teacherEmail ? ` · ${teacherEmail}` : ""}` : "Previously assigned teacher"}</dd></div>
                        <div><dt className="text-xs muted">Status</dt><dd className="mt-1 flex flex-wrap items-center gap-2">{entry.log.status === "published" ? <span className="badge text-success">Published</span> : <><span className="badge text-warning">Draft</span><span className="text-xs muted">Visible only to teacher</span></>}</dd></div>
                        <div className="sm:col-span-2"><dt className="text-xs muted">{label} Details</dt><dd className="mt-1 whitespace-pre-wrap font-medium">{entry.activity.title}</dd></div>
                      </dl>
                      {canEditAcademicLog(assignments, teacherId, teacherSchoolId, entry.log) && <div className="mt-4 flex flex-wrap gap-2">
                        <button type="button" disabled={saving} onClick={() => editEntry(entry)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-semibold"><Pencil size={15} />Edit</button>
                        <button type="button" disabled={saving} onClick={() => setPendingDelete(entry)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-red-500/30 px-4 py-2 text-sm font-semibold text-danger"><Trash2 size={15} />Delete</button>
                      </div>}
                      {module === "homework" && teacherUserId && entry.log.status === "published" && canGradeAcademicLog(assignments, teacherId, teacherSchoolId, entry.log) && <TeacherHomeworkGrading key={`${teacherUserId}:${entry.activity.id}`} userId={teacherUserId} activityId={entry.activity.id} />}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
      {pendingDelete && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
          <section role="alertdialog" aria-modal="true" aria-labelledby="delete-activity-title" aria-describedby="delete-activity-body" onKeyDown={(event) => { if (event.key === "Escape" && !saving) setPendingDelete(null); }} className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl">
            <h2 id="delete-activity-title" className="text-lg font-bold">Delete {label}?</h2>
            <p id="delete-activity-body" className="mt-2 text-sm muted">This {label.toLowerCase()} will be permanently removed.</p>
            <div className="mt-5 flex justify-end gap-3">
              <button type="button" autoFocus onClick={() => setPendingDelete(null)} className="btn btn-secondary">Cancel</button>
              <button type="button" disabled={saving} onClick={() => void deleteEntry(pendingDelete)} className="btn btn-danger-solid">Delete</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
