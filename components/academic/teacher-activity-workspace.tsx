"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ChevronDown, ChevronUp, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  getCurrentTeacherAssignments,
  getCurrentTeacherId,
  loadAcademicActivities,
  loadAcademicLogs,
  type AcademicActivity,
  type AcademicLogRecord,
  type TeachingAssignment,
} from "@/lib/academic";
import { createClient } from "@/lib/supabase/client";

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

function todayISO() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
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
  const label = activityName(module);
  const [teacherId, setTeacherId] = useState("");
  const [teacherSchoolId, setTeacherSchoolId] = useState("");
  const [teacherName, setTeacherName] = useState("Teacher");
  const [teacherEmail, setTeacherEmail] = useState("");
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
  const [date, setDate] = useState(todayISO());
  const [details, setDetails] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [filterDate, setFilterDate] = useState("");
  const [filterClass, setFilterClass] = useState("all");
  const [filterSection, setFilterSection] = useState("all");
  const [filterSubject, setFilterSubject] = useState("all");
  const [expandedActivityId, setExpandedActivityId] = useState("");
  const [pendingDelete, setPendingDelete] = useState<SubmittedEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const sections = sectionResult?.classId === selectedClassId ? sectionResult.rows : [];
  const sectionsLoading = Boolean(selectedClassId) && sectionResult?.classId !== selectedClassId;
  const sectionsError = sectionResult?.classId === selectedClassId ? sectionResult.error : "";
  const historySectionScope = `${teacherSchoolId}:${filterClass}`;
  const filterSections = filterClass !== "all" && historySectionResult?.scope === historySectionScope ? historySectionResult.rows : [];

  const selectedEntry = entries.find((entry) => entry.activity.id === editingActivityId);
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
      const [{ data: { user }, error: authError }, { data: teacher, error: teacherError }, ownAssignments, ownLogs] = await Promise.all([
        supabase.auth.getUser(),
        supabase
          .from("teachers")
          .select("school_id,full_name")
          .eq("id", currentTeacherId)
          .single(),
        getCurrentTeacherAssignments(),
        loadAcademicLogs({ teacherId: currentTeacherId }),
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
      setAssignments(ownAssignments);
      const currentYear = yearRows?.find((year) => year.is_current) ?? null;
      setAcademicYears(yearRows ?? []);
      setAcademicYearId((selected) => yearRows?.some((year) => year.id === selected)
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
    setEditingActivityId("");
    setDate(todayISO());
    setDetails("");
    setDueDate("");
    setSelectedClassId("");
    setSelectedSectionId("");
    setSelectedSubjectId("");
    setAcademicYearId(currentAcademicYearId);
    setMessage("");
  };

  const editEntry = (entry: SubmittedEntry) => {
    if (entry.log.teacher_id !== teacherId) return;
    setEditingActivityId(entry.activity.id);
    setDate(entry.log.log_date);
    setDetails(entry.activity.title);
    setDueDate(entry.activity.due_date ?? "");
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
    if (!assignedCombination) {
      setError("");
      return;
    }
    setSaving(true);
    setError("");
    setMessage("");
    const supabase = createClient();
    let newlyCreatedLogId = "";
    try {
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError) throw authError;
      if (!user) throw new Error("Please sign in before submitting academic work.");

      const { data: destinationLog, error: destinationError } = await supabase
        .from("class_logs")
        .select("id,status")
        .eq("teacher_id", teacherId)
        .eq("academic_year_id", assignedCombination.academic_year_id)
        .eq("class_id", selectedClassId)
        .eq("section_id", selectedSectionId)
        .eq("subject_id", selectedSubjectId)
        .eq("log_date", date)
        .maybeSingle();
      if (destinationError) throw destinationError;

      const sourceLogId = selectedEntry?.log.id;
      let destinationLogId = destinationLog?.id ?? "";
      let destinationStatus: "draft" | "published" = destinationLog?.status ?? "published";

      if (destinationLog && destinationLog.status === "draft" && destinationLog.id !== sourceLogId) {
        throw new Error("A private draft already exists for this class and date. Keep it private or resolve it before submitting new work.");
      }

      if (!destinationLogId) {
        const { data: insertedLog, error: insertLogError } = await supabase
          .from("class_logs")
          .insert({
            school_id: teacherSchoolId,
            academic_year_id: assignedCombination.academic_year_id,
            class_id: selectedClassId,
            section_id: selectedSectionId,
            subject_id: selectedSubjectId,
            teacher_id: teacherId,
            log_date: date,
            topic: details.trim().slice(0, 160),
            summary: `${label} was submitted.`,
            status: "published",
            published_at: new Date().toISOString(),
            published_by: user.id,
          })
          .select("id")
          .single();
        if (insertLogError) throw insertLogError;
        destinationLogId = insertedLog.id;
        newlyCreatedLogId = insertedLog.id;
        destinationStatus = "published";
      }

      const activityPayload = {
        class_log_id: destinationLogId,
        activity_type: module,
        title: details.trim(),
        description: label,
        due_date: module === "homework" ? dueDate || null : null,
      };
      const activityResult = editingActivityId
        ? await supabase.from("class_activities").update(activityPayload).eq("id", editingActivityId).select("id").maybeSingle()
        : await supabase.from("class_activities").insert(activityPayload).select("id").single();
      if (activityResult.error) {
        if (newlyCreatedLogId) {
          const { error: cleanupError } = await supabase.from("class_logs").delete().eq("id", newlyCreatedLogId);
          if (cleanupError) {
            throw new Error(`${activityResult.error.message} The empty published log could not be cleaned up: ${cleanupError.message}`);
          }
        }
        throw activityResult.error;
      }
      if (!activityResult.data) {
        if (newlyCreatedLogId) {
          const { error: cleanupError } = await supabase.from("class_logs").delete().eq("id", newlyCreatedLogId);
          if (cleanupError) throw new Error(`The activity was not saved. Its empty log could not be cleaned up: ${cleanupError.message}`);
        }
        throw new Error("The activity was not saved; it may no longer belong to your workspace.");
      }

      if (selectedEntry && selectedEntry.log.id !== destinationLogId) {
        const oldLogIsGenerated = selectedEntry.log.summary === `${label} was submitted.`;
        if (oldLogIsGenerated) {
          const { data: remainingActivities, error: remainingError } = await supabase
            .from("class_activities")
            .select("id")
            .eq("class_log_id", selectedEntry.log.id)
            .limit(1);
          if (remainingError) throw remainingError;
          if (!remainingActivities?.length) {
            const { error: oldLogDeleteError } = await supabase
              .from("class_logs")
              .delete()
              .eq("id", selectedEntry.log.id);
            if (oldLogDeleteError) {
              throw new Error(`The ${label.toLowerCase()} was updated, but its previous empty log could not be removed: ${oldLogDeleteError.message}`);
            }
          }
        }
      }

      setEditingActivityId("");
      setDetails("");
      setDueDate("");
      setMessage(editingActivityId
        ? destinationStatus === "published" ? `${label} updated successfully.` : `${label} updated. Draft — visible only to teacher.`
        : module === "classwork" ? "Classwork submitted successfully." : "Homework submitted successfully.");
      await load();
    } catch (saveError) {
      logSupabaseError(`${label} save failed`, saveError);
      setError(userError(saveError, `${label} could not be saved. Please verify your assignment and try again.`));
    } finally {
      setSaving(false);
    }
  };

  const deleteEntry = async (entry: SubmittedEntry) => {
    if (entry.log.teacher_id !== teacherId) return;
    setError("");
    setMessage("");
    try {
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

      const isGeneratedLog = entry.log.summary === `${label} was submitted.`;
      if (isGeneratedLog) {
        const { data: remainingActivities, error: remainingError } = await supabase
          .from("class_activities")
          .select("id")
          .eq("class_log_id", entry.log.id)
          .limit(1);
        if (remainingError) {
          await load();
          throw remainingError;
        }
        if (!remainingActivities?.length) {
          const { data: deletedLog, error: logDeleteError } = await supabase
            .from("class_logs")
            .delete()
            .eq("id", entry.log.id)
            .select("id")
            .maybeSingle();
          if (logDeleteError) {
            await load();
            throw new Error(`The activity was deleted, but its empty log could not be removed: ${logDeleteError.message}`);
          }
          if (!deletedLog) {
            await load();
            throw new Error("The activity was deleted, but its empty log was not removed.");
          }
        }
      }
      if (editingActivityId === entry.activity.id) resetForm();
      setPendingDelete(null);
      setMessage(`${label} deleted.`);
      await load();
    } catch (deleteError) {
      logSupabaseError(`${label} delete failed`, deleteError);
      setError(userError(deleteError, `${label} could not be deleted. Please try again.`));
    }
  };

  const className = (id: string) => classes.find((item) => item.id === id)?.name ?? id;
  const sectionName = (id: string) => [...sections, ...filterSections].find((item) => item.id === id)?.name
    ?? assignments.find((assignment) => assignment.section_id === id)?.section_name
    ?? id;
  const subjectName = (id: string) => subjects.find((item) => item.id === id)?.name
    ?? assignments.find((assignment) => assignment.subject_id === id)?.subject_name
    ?? id;
  const selectAssignment = (assignment: TeachingAssignment) => {
    setAcademicYearId(assignment.academic_year_id);
    setSelectedClassId(assignment.class_id);
    setSelectedSectionId(assignment.section_id);
    setSelectedSubjectId(assignment.subject_id);
    setError("");
  };

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-widest text-blue-600">Teacher Workspace</p>
        <h1 className="mt-1 text-3xl font-black">{label}</h1>
      </header>

      {message && <div role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm text-emerald-700">{message}</div>}
      {error && <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-600">{error}</div>}

      <form onSubmit={submit} className="card max-w-5xl space-y-5 p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold">{editingActivityId ? `Edit ${label}` : `Add ${label}`}</h2>
          {editingActivityId && <button type="button" onClick={resetForm} className="inline-flex items-center gap-2 text-sm font-semibold text-blue-600"><X size={16} />Cancel</button>}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block min-w-0 text-sm font-semibold"><span className="mb-2 block leading-5">Date</span>
            <input required type="date" value={date} onChange={(event) => setDate(event.target.value)} className="h-12 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 text-sm text-[var(--text)]" />
          </label>
          <label className="block min-w-0 text-sm font-semibold"><span className="mb-2 block leading-5">Academic Year</span>
            <select required value={academicYearId} onChange={(event) => {
              setAcademicYearId(event.target.value);
              setSelectedClassId("");
              setSelectedSectionId("");
              setSelectedSubjectId("");
              setError("");
            }} className="h-12 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 pr-9 text-sm text-[var(--text)]" disabled={loading}>
              <option value="">{loading ? "Loading academic years..." : "Select academic year"}</option>
              {academicYears.map((year) => <option key={year.id} value={year.id}>{year.name}{year.is_current ? " (Current)" : ""}</option>)}
            </select>
          </label>
          <label className="block min-w-0 text-sm font-semibold"><span className="mb-2 block leading-5">Class</span>
            <select required value={selectedClassId} onChange={(event) => {
              setSelectedClassId(event.target.value);
              setSelectedSectionId("");
              setSelectedSubjectId("");
                        setError("");
            }} className="h-12 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 pr-9 text-sm text-[var(--text)]" disabled={loading}>
              <option value="">{loading ? "Loading classes..." : "Select class"}</option>{classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label className="block min-w-0 text-sm font-semibold"><span className="mb-2 block leading-5">Section</span>
            <select required value={selectedSectionId} onChange={(event) => {
              setSelectedSectionId(event.target.value);
              setSelectedSubjectId("");
              setError("");
            }} className="h-12 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 pr-9 text-sm text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-60" disabled={!selectedClassId || sectionsLoading}>
              <option value="">{!selectedClassId ? "Select class first" : sectionsLoading ? "Loading sections..." : sectionsError ? "Error loading sections" : sections.length ? "Select section" : "No sections found for this class"}</option>{sections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            {sectionsError && <span role="alert" className="mt-2 block text-xs font-medium text-red-600">{sectionsError}</span>}
          </label>
          <label className="block min-w-0 text-sm font-semibold"><span className="mb-2 block leading-5">Subject</span>
            <select required value={selectedSubjectId} onChange={(event) => {
              setSelectedSubjectId(event.target.value);
              setError("");
            }} className="h-12 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 pr-9 text-sm text-[var(--text)]" disabled={loading}>
              <option value="">{loading ? "Loading subjects..." : subjects.length ? "Select subject" : "No subjects found"}</option>{subjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
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
          <textarea required value={details} onChange={(event) => setDetails(event.target.value)} rows={8} className="min-h-[200px] w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-3 text-base leading-7 text-[var(--text)]" placeholder={module === "classwork" ? "Write what was taught in class today...\nExample:\nChapter 4 - Fractions\nExplained equivalent fractions.\nSolved examples 1-5.\nStudents completed exercise 4.1." : "Enter homework details, questions, chapters, instructions, etc."} />
        </label>
        {module === "homework" && <label className="block max-w-sm text-sm font-semibold"><span className="mb-2 block leading-5">Due Date</span>
          <input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} className="h-12 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 text-sm text-[var(--text)]" />
        </label>}
        {selectedEntry?.log.status === "draft" && <p className="text-xs font-semibold text-amber-600">Draft — visible only to teacher. Editing will not publish the parent log.</p>}
        <button type="submit" disabled={saving || loading || !academicYearId || !assignments.length || !classes.length || !selectedAssignment || sectionsLoading || Boolean(sectionsError)} className="inline-flex items-center gap-2 rounded-xl gradient px-5 py-3 text-sm font-bold disabled:opacity-50">
          {editingActivityId ? <Pencil size={16} /> : <Plus size={16} />}{saving ? "Saving..." : editingActivityId ? `Update ${label}` : `Submit ${label}`}
        </button>
        {module === "homework" && assignments.length > 0 && (
          <div className="border-t border-[var(--border)] pt-4">
            <h3 className="text-sm font-bold">My Assigned Classes</h3>
            <div className="mt-3 flex flex-wrap gap-2">
              {assignments.map((assignment) => (
                <button key={assignment.id} type="button" onClick={() => selectAssignment(assignment)}
                  aria-pressed={assignment.id === selectedAssignment?.id}
                  className={`rounded-full border px-3 py-2 text-left text-xs font-semibold transition ${assignment.id === selectedAssignment?.id ? "border-blue-500 bg-blue-500/10 text-blue-700 dark:text-blue-300" : "border-[var(--border)] hover:bg-[var(--surface-2)]"}`}>
                  {assignment.class_name} • {assignment.section_name} • {assignment.subject_name}
                </button>
              ))}
            </div>
          </div>
        )}
      </form>

      <section className="card overflow-hidden">
        <div className="border-b border-[var(--border)] p-5">
          <h2 className="font-bold">Submitted {label}</h2>
          <p className="mt-1 text-xs muted">Records are stored in the existing academic log and class activity tables.</p>
        </div>
        <div className="grid gap-4 border-b border-[var(--border)] p-5 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block text-sm font-semibold">Date<input type="date" value={filterDate} onChange={(event) => setFilterDate(event.target.value)} className="field mt-2" /></label>
          <label className="block text-sm font-semibold">Class<select value={filterClass} onChange={(event) => { setFilterClass(event.target.value); setFilterSection("all"); }} className="field mt-2"><option value="all">All Classes</option>{classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label className="block text-sm font-semibold">Section<select value={filterSection} onChange={(event) => setFilterSection(event.target.value)} className="field mt-2" disabled={filterClass === "all"}><option value="all">All Sections</option>{filterSections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label className="block text-sm font-semibold">Subject<select value={filterSubject} onChange={(event) => setFilterSubject(event.target.value)} className="field mt-2"><option value="all">All Subjects</option>{subjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        </div>
        {loading ? <p className="p-5 text-sm muted">Loading submitted {label.toLowerCase()}...</p> : visibleEntries.length === 0 ? (
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
                    <span className="flex shrink-0 items-center gap-2 text-xs font-semibold text-blue-600">
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
                        <div><dt className="text-xs muted">Teacher</dt><dd className="mt-1 font-medium">{teacherName}{teacherEmail ? ` · ${teacherEmail}` : ""}</dd></div>
                        <div><dt className="text-xs muted">Status</dt><dd className={`mt-1 font-semibold ${entry.log.status === "published" ? "text-emerald-600" : "text-amber-600"}`}>{entry.log.status === "published" ? "Published" : "Draft — visible only to teacher"}</dd></div>
                        <div className="sm:col-span-2"><dt className="text-xs muted">{label} Details</dt><dd className="mt-1 whitespace-pre-wrap font-medium">{entry.activity.title}</dd></div>
                      </dl>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button type="button" onClick={() => editEntry(entry)} className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-semibold"><Pencil size={15} />Edit</button>
                        <button type="button" onClick={() => setPendingDelete(entry)} className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-4 py-2 text-sm font-semibold text-red-600"><Trash2 size={15} />Delete</button>
                      </div>
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
          <section role="alertdialog" aria-modal="true" aria-labelledby="delete-activity-title" className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl">
            <h2 id="delete-activity-title" className="text-lg font-bold">Delete {label}?</h2>
            <p className="mt-2 text-sm muted">This {label.toLowerCase()} will be permanently removed.</p>
            <div className="mt-5 flex justify-end gap-3">
              <button type="button" onClick={() => setPendingDelete(null)} className="rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold">Cancel</button>
              <button type="button" disabled={saving} onClick={() => void deleteEntry(pendingDelete)} className="rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">Delete</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
