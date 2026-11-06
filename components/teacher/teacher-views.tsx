"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, KeyRound, LogOut, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  getCurrentTeacherAssignments,
  getCurrentTeacherId,
  type TeachingAssignment,
} from "@/lib/academic";
import { createClient } from "@/lib/supabase/client";
import { readCompletePages } from "@/lib/complete-pages";
import {
  loadAssessments, loadAssessmentRoster, loadAssessmentMarks, loadAssessmentStudents,
  markDraftHasChanges, markChanges, saveChangedMarks, rankAssessmentMarks,
  type AssessmentRecord, type AssessmentMark as AssessmentMarkRecord,
  type AssessmentStudent, type MarkDraft,
} from "@/lib/assessments";
import { LoadingState } from "@/components/ui/skeleton";

type ViewError = { message?: string; details?: unknown; hint?: unknown; code?: unknown };

type AssessmentRoster = {
  assessmentId: string; scope: string; students: AssessmentStudent[]; marks: MarkDraft;
  baseline: AssessmentMarkRecord[]; expectedAssessmentUpdatedAt: string; requiresReload?: boolean;
};

type SchoolOption = { id: string; name: string };
type AcademicYearOption = { id: string; name: string; is_current: boolean };
type SchoolSectionOption = SchoolOption & { class_id: string };

function errorText(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as ViewError).message;
    if (typeof message === "string") return message;
  }
  return fallback;
}

function logSupabaseError(context: string, error: unknown) {
  if (error && typeof error === "object") {
    const details = error as ViewError;
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

function userFacingError(error: unknown, fallback: string) {
  if (error instanceof Error && !(error as Error & { code?: string }).code) return error.message;
  return fallback;
}

function assessmentLabel(assessment: AssessmentRecord, assignments: TeachingAssignment[]) {
  const date = new Date(`${assessment.assessment_date}T00:00:00`).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  return `${assessment.name} · ${assessmentScopeLabel(assessment, assignments)} · ${date}`;
}

function assessmentScopeLabel(assessment: AssessmentRecord, assignments: TeachingAssignment[]) {
  const assignment = assignments.find((item) =>
    item.class_id === assessment.class_id &&
    item.section_id === assessment.section_id &&
    item.subject_id === assessment.subject_id &&
    item.academic_year_id === assessment.academic_year_id,
  );
  return `${assignment?.class_name ?? "Class"} ${assignment?.section_name ?? "Section"} · ${assignment?.subject_name ?? "Subject"}`;
}

function ExamScheduleView() {
  const recordsVersion = useRef(0);
  const marksSaving = useRef(false);
  const [rosterReload, setRosterReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [teacherId, setTeacherId] = useState("");
  const [teacherSchoolId, setTeacherSchoolId] = useState("");
  const [assignments, setAssignments] = useState<TeachingAssignment[]>([]);
  const [records, setRecords] = useState<AssessmentRecord[]>([]);
  const [classes, setClasses] = useState<SchoolOption[]>([]);
  const [academicYears, setAcademicYears] = useState<AcademicYearOption[]>([]);
  const [sections, setSections] = useState<SchoolSectionOption[]>([]);
  const [sectionsLoading, setSectionsLoading] = useState(false);
  const [sectionsError, setSectionsError] = useState("");
  const [subjects, setSubjects] = useState<SchoolOption[]>([]);
  const [selectedAssessmentId, setSelectedAssessmentId] = useState("");
  const [roster, setRoster] = useState<AssessmentRoster | null>(null);
  const [editingAssessmentId, setEditingAssessmentId] = useState("");
  const [expandedAssessmentId, setExpandedAssessmentId] = useState("");
  const [pendingDeleteAssessment, setPendingDeleteAssessment] = useState<AssessmentRecord | null>(null);
  const [name, setName] = useState("");
  const [selectedClassId, setSelectedClassId] = useState("");
  const [selectedSectionId, setSelectedSectionId] = useState("");
  const [selectedSubjectId, setSelectedSubjectId] = useState("");
  const [selectedAcademicYearId, setSelectedAcademicYearId] = useState("");
  const [currentAcademicYearId, setCurrentAcademicYearId] = useState("");
  const [examDate, setExamDate] = useState(new Date().toISOString().slice(0, 10));
  const [maximumMarks, setMaximumMarks] = useState("");
  const [description, setDescription] = useState("");
  const [assessmentStatus, setAssessmentStatus] = useState<AssessmentRecord["status"]>("scheduled");
  const selectedAssessment = records.find((assessment) => assessment.id === selectedAssessmentId);
  const assessmentId = selectedAssessment?.id ?? "";
  const assessmentSchoolId = selectedAssessment?.school_id ?? "";
  const assessmentClassId = selectedAssessment?.class_id ?? "";
  const assessmentYearId = selectedAssessment?.academic_year_id ?? "";
  const assessmentSectionId = selectedAssessment?.section_id ?? "";
  const assessmentUpdatedAt = selectedAssessment?.updated_at ?? "";
  const rosterScope = JSON.stringify([assessmentId, assessmentSchoolId, assessmentClassId, assessmentYearId, assessmentSectionId, selectedAssessment?.subject_id, selectedAssessment?.teacher_id, selectedAssessment?.maximum_marks, selectedAssessment?.updated_at]);
  const currentRoster = roster?.assessmentId === assessmentId ? roster : null;
  const students = currentRoster?.students ?? [];
  const marks = currentRoster?.marks ?? {};
  const marksDirty = Boolean(roster && markDraftHasChanges(roster.students, roster.marks, roster.baseline));
  const unavailableDraft = marksDirty && roster && !records.some((record) => record.id === roster.assessmentId) ? roster : null;
  const marksScopeChanged = Boolean(currentRoster && currentRoster.scope !== rosterScope);
  const rosterLoading = Boolean(assessmentId) && !currentRoster;
  const setMarks = (update: (current: MarkDraft) => MarkDraft) => {
    setRoster((current) => current?.assessmentId === assessmentId ? { ...current, marks: update(current.marks) } : current);
  };
  const reloadMarks = async () => {
    if (marksSaving.current || saving) return;
    marksSaving.current = true;
    setSaving(true);
    setRoster(null);
    setError("");
    setMessage("");
    try {
      const loaded = await loadRecords();
      if (loaded && !loaded.some((record) => record.id === assessmentId)) setError("The selected assessment is no longer available. Choose an available assessment.");
      setRosterReload((value) => value + 1);
    } catch (loadError) {
      setRoster({ assessmentId, scope: rosterScope, students: [], marks: {}, baseline: [], expectedAssessmentUpdatedAt: assessmentUpdatedAt, requiresReload: true });
      setError(errorText(loadError, "The assessment could not be refreshed. Retry reloading before entering marks."));
    } finally {
      marksSaving.current = false;
      setSaving(false);
    }
  };
  const assignmentsForSelectedClass = assignments.filter((assignment) =>
    assignment.class_id === selectedClassId &&
    assignment.academic_year_id === selectedAcademicYearId,
  );
  const selectedAssignment = assignmentsForSelectedClass.find((assignment) =>
    assignment.section_id === selectedSectionId &&
    assignment.subject_id === selectedSubjectId,
  );

  const loadRecords = useCallback(async () => {
    const version = ++recordsVersion.current;
    const [currentTeacherId, currentAssignments] = await Promise.all([
      getCurrentTeacherId(),
      getCurrentTeacherAssignments(),
    ]);
    if (!currentTeacherId) throw new Error("Teacher profile was not found for this login.");
    const { data: teacher, error: teacherError } = await createClient()
      .from("teachers")
      .select("school_id")
      .eq("id", currentTeacherId)
      .single();
    if (teacherError) throw teacherError;
    const [{ data: yearRows, error: yearError }, { data: classRows, error: classError }, { data: subjectRows, error: subjectError }] = await Promise.all([
      createClient().from("academic_years").select("id,name,is_current").eq("school_id", teacher.school_id).order("start_date", { ascending: false }),
      createClient().from("classes").select("id,name").eq("school_id", teacher.school_id).eq("is_active", true).order("sort_order"),
      createClient().from("subjects").select("id,name").eq("school_id", teacher.school_id).order("name"),
    ]);
    if (yearError) throw yearError;
    if (classError) throw classError;
    if (subjectError) throw subjectError;
    const loaded = await loadAssessments(createClient(), teacher.school_id);
    if (version !== recordsVersion.current) return;
    setTeacherId(currentTeacherId);
    setAssignments(currentAssignments);
    setTeacherSchoolId(teacher.school_id);
    const currentYear = yearRows?.find((year) => year.is_current) ?? null;
    setAcademicYears(yearRows ?? []);
    setCurrentAcademicYearId(currentYear?.id ?? "");
    setSelectedAcademicYearId((selected) => yearRows?.some((year) => year.id === selected)
      ? selected
      : currentYear?.id || currentAssignments[0]?.academic_year_id || "");
    setClasses(classRows ?? []);
    setSubjects(subjectRows ?? []);
    setRecords(loaded);
    setSelectedAssessmentId((selected) => loaded.some((assessment) => assessment.id === selected) ? selected : "");
    return loaded;
  }, []);

  useEffect(() => {
    let active = true;
    const loadSections = async () => {
      setSections([]);
      setSectionsError("");
      if (!selectedClassId || !teacherSchoolId) {
        setSectionsLoading(false);
        return;
      }
      setSectionsLoading(true);
      try {
        const { data, error: sectionError } = await createClient()
          .from("sections")
          .select("id,name,class_id")
          .eq("class_id", selectedClassId)
          .order("name");
        if (sectionError) throw sectionError;
        if (active) {
          setSections(data ?? []);
          setSelectedSectionId((current) => data?.some((section) => section.id === current) ? current : "");
        }
      } catch (sectionLoadError) {
        if (active) {
          logSupabaseError("Exam section load failed", sectionLoadError);
          setSectionsError("Error loading sections. Please try again.");
        }
      } finally {
        if (active) setSectionsLoading(false);
      }
    };
    void loadSections();
    return () => { active = false; };
  }, [selectedClassId, teacherSchoolId]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        await loadRecords();
      } catch (loadError) {
        if (active) {
          logSupabaseError("Exam schedule load failed", loadError);
          setError(userFacingError(loadError, "Exam schedule could not be loaded. Please try again."));
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
      recordsVersion.current += 1;
    };
  }, [loadRecords]);

  useEffect(() => {
    if (!assessmentId) return;
    let active = true;
    const loadStudentsAndMarks = async () => {
      try {
        const loaded = await loadAssessmentRoster(createClient(), {
          id: assessmentId, school_id: assessmentSchoolId, class_id: assessmentClassId,
          academic_year_id: assessmentYearId, section_id: assessmentSectionId || null,
        }, () => active);
        if (active) setRoster((current) => {
          // An unrelated record refresh must not replace a mark draft.
          if (current?.assessmentId === assessmentId && markDraftHasChanges(current.students, current.marks, current.baseline)) return current;
          return {
            assessmentId, scope: rosterScope, students: loaded.students, baseline: loaded.marks, expectedAssessmentUpdatedAt: assessmentUpdatedAt,
            marks: Object.fromEntries(loaded.marks.map((mark) => [mark.student_id,
              { value: String(mark.marks_obtained), remarks: mark.remarks ?? "" }])),
          };
        });
      } catch (loadError) {
        if (active) {
          setRoster((current) => current?.assessmentId === assessmentId && markDraftHasChanges(current.students, current.marks, current.baseline)
            ? { ...current, requiresReload: true }
            : { assessmentId, scope: rosterScope, students: [], marks: {}, baseline: [], expectedAssessmentUpdatedAt: assessmentUpdatedAt, requiresReload: true });
          setError(errorText(loadError, "Students and marks could not be loaded completely."));
        }
      }
    };
    void loadStudentsAndMarks();
    return () => { active = false; };
  }, [assessmentClassId, assessmentId, assessmentSchoolId, assessmentSectionId, assessmentUpdatedAt, assessmentYearId, rosterReload, rosterScope]);

  const resetAssessmentForm = () => {
    setEditingAssessmentId("");
    setName("");
    setSelectedClassId("");
    setSelectedSectionId("");
    setSelectedSubjectId("");
    setSelectedAcademicYearId(currentAcademicYearId || assignments[0]?.academic_year_id || "");
    setExamDate(new Date().toISOString().slice(0, 10));
    setMaximumMarks("");
    setDescription("");
    setAssessmentStatus("scheduled");
  };

  const editAssessment = (assessment: AssessmentRecord) => {
    if (assessment.teacher_id !== teacherId) return;
    setEditingAssessmentId(assessment.id);
    setName(assessment.name);
    setSelectedClassId(assessment.class_id);
    setSelectedSectionId(assessment.section_id ?? "");
    setSelectedSubjectId(assessment.subject_id);
    setSelectedAcademicYearId(assessment.academic_year_id);
    setExamDate(assessment.assessment_date);
    setMaximumMarks(String(assessment.maximum_marks));
    setDescription(assessment.description ?? "");
    setAssessmentStatus(assessment.status);
    setError("");
    setMessage("");
  };

  const deleteAssessment = async (assessment: AssessmentRecord) => {
    if (assessment.teacher_id !== teacherId) return;
    if (assessment.id === assessmentId && marksDirty) {
      setError("Save or discard the pending marks before deleting this assessment.");
      return;
    }
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const { data, error: deleteError } = await createClient()
        .from("teacher_assessments")
        .delete()
        .eq("id", assessment.id)
        .eq("teacher_id", teacherId)
        .select("id")
        .maybeSingle();
      if (deleteError) throw deleteError;
      if (!data) throw new Error("Assessment was not deleted; it may no longer be managed by this teacher.");
      if (editingAssessmentId === assessment.id) resetAssessmentForm();
      if (selectedAssessmentId === assessment.id) setSelectedAssessmentId("");
      setPendingDeleteAssessment(null);
      setMessage("Assessment deleted.");
      await loadRecords();
    } catch (deleteError) {
      logSupabaseError("Assessment delete failed", deleteError);
      setError(userFacingError(deleteError, "Assessment could not be deleted. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  const saveAssessment = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (marksDirty || saving) {
      setError("Save or discard the pending marks before changing assessments.");
      return;
    }
    const assignment = assignments.find((item) =>
      item.class_id === selectedClassId &&
      item.section_id === selectedSectionId &&
      item.subject_id === selectedSubjectId &&
      item.academic_year_id === selectedAcademicYearId,
    );
    const max = Number(maximumMarks);
    if (!name.trim()) {
      setError("Please enter an exam or test name.");
      return;
    }
    if (!examDate) {
      setError("Please select an exam date.");
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
    if (!assignment) {
      setError("");
      return;
    }
    if (!Number.isFinite(max) || max <= 0) {
      setError("Maximum marks must be greater than zero.");
      return;
    }
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const { data: teacher, error: teacherError } = await createClient()
        .from("teachers")
        .select("school_id")
        .eq("id", teacherId)
        .single();
      if (teacherError) throw teacherError;
      if (editingAssessmentId) {
        const current = records.find((assessment) => assessment.id === editingAssessmentId);
        const assignmentChanged = current && (
          current.academic_year_id !== assignment.academic_year_id ||
          current.class_id !== assignment.class_id ||
          current.section_id !== assignment.section_id ||
          current.subject_id !== assignment.subject_id
        );
        if (assignmentChanged) {
          const { data: existingMarks, error: marksError } = await createClient()
            .from("teacher_assessment_marks")
            .select("id")
            .eq("assessment_id", editingAssessmentId)
            .limit(1);
          if (marksError) throw marksError;
          if (existingMarks?.length) {
            throw new Error("This assessment already has marks. Its class, section, subject, and academic year cannot be changed.");
          }
        }
        const { data, error: updateError } = await createClient()
          .from("teacher_assessments")
          .update({
            academic_year_id: assignment.academic_year_id,
            class_id: assignment.class_id,
            section_id: assignment.section_id,
            subject_id: assignment.subject_id,
            name: name.trim(),
            assessment_date: examDate,
            maximum_marks: max,
            description: description.trim() || null,
            status: assessmentStatus,
          })
          .eq("id", editingAssessmentId)
          .eq("teacher_id", teacherId)
          .select("id")
          .maybeSingle();
        if (updateError) throw updateError;
        if (!data) throw new Error("Assessment was not updated; verify it is still assigned to you.");
        setSelectedAssessmentId(data.id);
        setMessage("Assessment updated.");
      } else {
        const { data, error: insertError } = await createClient()
          .from("teacher_assessments")
          .insert({
            school_id: teacher.school_id,
            academic_year_id: assignment.academic_year_id,
            class_id: assignment.class_id,
            section_id: assignment.section_id,
            subject_id: assignment.subject_id,
            teacher_id: teacherId,
            name: name.trim(),
            assessment_date: examDate,
            maximum_marks: max,
            description: description.trim() || null,
            status: assessmentStatus,
          })
          .select("id")
          .single();
        if (insertError) throw insertError;
        setSelectedAssessmentId(data.id);
        setMessage("Assessment created.");
      }
      resetAssessmentForm();
      await loadRecords();
    } catch (saveError) {
      logSupabaseError("Assessment save failed", saveError);
      setError(userFacingError(saveError, "Assessment could not be saved. Please verify your assignment and try again."));
    } finally {
      setSaving(false);
    }
  };

  const saveMarks = async () => {
    if (marksSaving.current || saving) return;
    if (!selectedAssessment || selectedAssessment.teacher_id !== teacherId || !currentRoster) {
      setError("Only the teacher who created this assessment can enter or update its marks.");
      return;
    }
    if (marksScopeChanged || currentRoster.requiresReload) {
      setError("Assessment data changed or a previous save was not confirmed. Discard and reload before saving; your draft is retained.");
      return;
    }
    let changes;
    try {
      changes = markChanges(students, marks, currentRoster.baseline, Number(selectedAssessment.maximum_marks));
    } catch (validationError) {
      setError(errorText(validationError, "Check the entered marks."));
      return;
    }
    if (!changes.length) { setMessage("No mark changes to save."); return; }
    marksSaving.current = true;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const result = await saveChangedMarks(createClient(), selectedAssessment.id, currentRoster.expectedAssessmentUpdatedAt, changes);
      setRoster((current) => {
        if (current?.scope !== rosterScope) return current;
        const baseline = new Map(current.baseline.map((mark) => [mark.student_id, mark]));
        for (const mark of result.saved) baseline.set(mark.student_id, mark);
        return { ...current, baseline: [...baseline.values()], requiresReload: result.failed.length > 0 };
      });
      if (result.saved.length) setMessage(`${result.saved.length} changed mark${result.saved.length === 1 ? "" : "s"} saved.`);
      if (result.failed.length) setError(`${result.failed.length} mark${result.failed.length === 1 ? " was" : "s were"} not confirmed. ${result.failed[0].message}`);
    } catch (saveError) {
      setError(errorText(saveError, "Marks could not be confirmed. Your draft is retained; discard and reload before retrying."));
      setRoster((current) => current?.scope === rosterScope ? { ...current, requiresReload: true } : current);
    } finally {
      marksSaving.current = false;
      setSaving(false);
    }
  };

  return (
    <section className="space-y-5">
      <header>
        <p className="text-xs font-semibold uppercase tracking-widest text-blue-600">Assessment</p>
        <h1 className="mt-1 text-3xl font-black">Exam / Test / Marks</h1>
        <p className="mt-2 text-sm muted">Assessments are limited to your teaching assignments. Mark entry is restricted to assessments you created.</p>
      </header>
      {message && <div role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm text-emerald-700">{message}</div>}
      {error && <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-600">{error}</div>}
      {unavailableDraft && <section role="alert" className="rounded-xl border border-amber-500/40 p-4 text-sm">
        <p className="font-semibold">The selected assessment is no longer available. Your unsaved marks are retained below; copy them before discarding.</p>
        <ul className="mt-3 space-y-1">{unavailableDraft.students.map((student) => <li key={student.id}>{student.first_name} · {student.admission_no ?? student.id}: {unavailableDraft.marks[student.id]?.value || "Unmarked"} · {unavailableDraft.marks[student.id]?.remarks || "No remarks"}</li>)}</ul>
        <button type="button" disabled={saving} onClick={() => { setRoster(null); setError(""); }} className="mt-3 rounded-lg border border-[var(--border)] px-3 py-2 font-semibold">Discard unavailable assessment draft</button>
      </section>}
      <form onSubmit={saveAssessment} className="card max-w-5xl space-y-5 p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold">{editingAssessmentId ? "Edit Exam / Test" : "Create Exam / Test"}</h2>
          {editingAssessmentId && <button type="button" onClick={resetAssessmentForm} className="text-sm font-semibold text-blue-600">Cancel</button>}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm font-semibold"><span className="mb-2 block leading-5">Exam / Test Name</span>
            <input required value={name} onChange={(event) => setName(event.target.value)} maxLength={160} placeholder="Unit Test 1" className="field" />
          </label>
          <label className="block text-sm font-semibold"><span className="mb-2 block leading-5">Date</span>
            <input required type="date" value={examDate} onChange={(event) => setExamDate(event.target.value)} className="field" />
          </label>
          <label className="block text-sm font-semibold"><span className="mb-2 block leading-5">Academic Year</span>
            <select required value={selectedAcademicYearId} onChange={(event) => {
              setSelectedAcademicYearId(event.target.value);
              setSelectedClassId("");
              setSelectedSectionId("");
              setSelectedSubjectId("");
              setError("");
            }} className="field" disabled={!teacherSchoolId}>
              <option value="">{!teacherSchoolId ? "Loading academic years..." : "Select academic year"}</option>
              {academicYears.map((year) => <option key={year.id} value={year.id}>{year.name}{year.is_current ? " (Current)" : ""}</option>)}
            </select>
          </label>
          <label className="block text-sm font-semibold"><span className="mb-2 block leading-5">Class</span>
            <select required value={selectedClassId} onChange={(event) => {
              setSelectedClassId(event.target.value);
              setSelectedSectionId("");
              setSelectedSubjectId("");
              setSections([]);
              setSectionsError("");
              setError("");
            }} className="field" disabled={!teacherSchoolId}>
              <option value="">{!teacherSchoolId ? "Loading classes..." : "Select class"}</option>{classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label className="block text-sm font-semibold"><span className="mb-2 block leading-5">Section</span>
            <select required value={selectedSectionId} onChange={(event) => {
              setSelectedSectionId(event.target.value);
              setSelectedSubjectId("");
              setError("");
            }} className="field" disabled={!selectedClassId || sectionsLoading}>
              <option value="">{!selectedClassId ? "Select class first" : sectionsLoading ? "Loading sections..." : sectionsError ? "Error loading sections" : sections.length ? "Select section" : "No sections found for this class"}</option>{sections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            {sectionsError && <span role="alert" className="mt-2 block text-xs font-medium text-red-600">{sectionsError}</span>}
          </label>
          <label className="block text-sm font-semibold"><span className="mb-2 block leading-5">Subject</span>
            <select required value={selectedSubjectId} onChange={(event) => {
              setSelectedSubjectId(event.target.value);
              setError("");
            }} className="field" disabled={!teacherSchoolId}>
              <option value="">{!teacherSchoolId ? "Loading subjects..." : subjects.length ? "Select subject" : "No subjects found"}</option>{subjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label className="block text-sm font-semibold"><span className="mb-2 block leading-5">Maximum Marks</span>
            <input required type="number" min="0.01" step="0.01" value={maximumMarks} onChange={(event) => setMaximumMarks(event.target.value)} placeholder="100" className="field" />
          </label>
          <label className="block text-sm font-semibold"><span className="mb-2 block leading-5">Status</span>
            <select value={assessmentStatus} onChange={(event) => setAssessmentStatus(event.target.value as AssessmentRecord["status"])} className="field">
              <option value="scheduled">Scheduled</option>
              <option value="completed">Completed</option>
            </select>
          </label>
          <label className="block text-sm font-semibold"><span className="mb-2 block leading-5">Instructions</span>
            <textarea rows={6} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Enter exam instructions, chapters, format, or other guidance..." className="field min-h-[140px]" />
          </label>
        </div>
        {selectedClassId && assignmentsForSelectedClass.length === 0 && (
          <p className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm font-medium text-amber-700 dark:text-amber-300">
            This class is not assigned to you. Please select one of your assigned classes.
          </p>
        )}
        {selectedClassId && assignmentsForSelectedClass.length > 0 && selectedSectionId && selectedSubjectId && (
          <p className={`rounded-xl p-3 text-sm font-semibold ${selectedAssignment ? "border border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300" : "border border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300"}`}>
            {selectedAssignment ? "✓ Assigned to you" : "⚠ Not assigned to you"}
          </p>
        )}
        {assignments.length > 0 && (
          <div className="border-t border-[var(--border)] pt-4">
            <h3 className="text-sm font-bold">My Assigned Classes</h3>
            <div className="mt-3 flex flex-wrap gap-2">
              {assignments.map((assignment) => (
                <button key={assignment.id} type="button" onClick={() => {
                  setSelectedAcademicYearId(assignment.academic_year_id);
                  setSelectedClassId(assignment.class_id);
                  setSelectedSectionId(assignment.section_id);
                  setSelectedSubjectId(assignment.subject_id);
                  setSectionsError("");
                  setError("");
                }} className="rounded-full border border-[var(--border)] px-3 py-2 text-left text-xs font-semibold hover:bg-[var(--surface-2)]">
                  {assignment.class_name} • {assignment.section_name} • {assignment.subject_name}
                </button>
              ))}
            </div>
          </div>
        )}
        <button disabled={saving || !selectedAcademicYearId || !assignments.length || !classes.length || !selectedAssignment || sectionsLoading || Boolean(sectionsError)} className="rounded-xl gradient px-5 py-3 text-sm font-bold disabled:opacity-50">{saving ? "Saving..." : editingAssessmentId ? "Update Exam" : "Create Exam"}</button>
      </form>

      <section className="card space-y-4 p-5">
        <h2 className="text-lg font-bold">Submitted Exams / Tests</h2>
        {loading && !records.length ? <LoadingState variant="list" className="text-sm muted">Loading assessments...</LoadingState> : records.length === 0 ? (
          <div className="rounded-xl bg-[var(--surface-2)] p-8 text-center">
            <h3 className="font-bold">No Exams Yet</h3>
            <p className="mt-1 text-sm muted">You haven&apos;t created any exams or tests yet.</p>
            <button type="button" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} className="mt-4 rounded-xl gradient px-4 py-2.5 text-sm font-bold">Create Exam / Test</button>
          </div>
        ) : (
          <>
            <div className="divide-y divide-[var(--border)]">
              {records.map((assessment) => (
                <article key={assessment.id} className="py-3">
                  <button type="button" aria-expanded={expandedAssessmentId === assessment.id} onClick={() => setExpandedAssessmentId((current) => current === assessment.id ? "" : assessment.id)} className="flex w-full items-center justify-between gap-4 rounded-xl p-3 text-left hover:bg-[var(--surface-2)]">
                    <span>
                      <span className="block font-semibold">{assessment.name}</span>
                      <span className="mt-1 block text-xs muted">{assessmentLabel(assessment, assignments)} · Maximum {assessment.maximum_marks}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-xs font-semibold text-blue-600">
                      {expandedAssessmentId === assessment.id ? "Close" : "Open"}
                      {expandedAssessmentId === assessment.id ? <ChevronUp size={19} className="muted" /> : <ChevronDown size={19} className="muted" />}
                    </span>
                  </button>
                  {expandedAssessmentId === assessment.id && (
                    <div className="mt-2 rounded-xl bg-[var(--surface-2)] p-4">
                      <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                        <div><dt className="text-xs muted">Exam / Test Name</dt><dd className="mt-1 font-medium">{assessment.name}</dd></div>
                        <div><dt className="text-xs muted">Date</dt><dd className="mt-1 font-medium">{new Date(`${assessment.assessment_date}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}</dd></div>
                        <div><dt className="text-xs muted">Class / Section / Subject</dt><dd className="mt-1 font-medium">{assessmentScopeLabel(assessment, assignments)}</dd></div>
                        <div><dt className="text-xs muted">Maximum Marks</dt><dd className="mt-1 font-medium">{assessment.maximum_marks}</dd></div>
                        <div><dt className="text-xs muted">Status</dt><dd className="mt-1 font-medium">{assessment.status}</dd></div>
                        <div className="sm:col-span-2 lg:col-span-3"><dt className="text-xs muted">Instructions</dt><dd className="mt-1 whitespace-pre-wrap font-medium">{assessment.description || "—"}</dd></div>
                      </dl>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button type="button" onClick={() => {
                          setSelectedAssessmentId(assessment.id);
                          setExpandedAssessmentId(assessment.id);
                        }} disabled={saving || (marksDirty && assessment.id !== assessmentId)} className="rounded-lg gradient px-4 py-2 text-sm font-semibold disabled:opacity-50">Enter Marks</button>
                        {assessment.teacher_id === teacherId && <>
                          <button type="button" onClick={() => editAssessment(assessment)} className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-semibold">Edit</button>
                          <button type="button" disabled={saving} onClick={() => setPendingDeleteAssessment(assessment)} className="rounded-lg border border-red-500/30 px-4 py-2 text-sm font-semibold text-red-600 disabled:opacity-50">Delete</button>
                        </>}
                      </div>
                    </div>
                  )}
                </article>
              ))}
            </div>
            {selectedAssessment && expandedAssessmentId === selectedAssessment.id && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[var(--surface-2)] p-4 text-sm">
                  <div><b>{selectedAssessment.name}</b> · {selectedAssessment.assessment_date} · Maximum {selectedAssessment.maximum_marks}</div>
                  <span>{selectedAssessment.status}</span>
                </div>
                {selectedAssessment.description && <p className="text-sm muted">{selectedAssessment.description}</p>}
                {selectedAssessment.teacher_id !== teacherId && <p className="text-sm muted">This assessment belongs to another teacher. Marks are view-only.</p>}
                {marksScopeChanged && <p role="alert" className="text-sm text-red-600">The assessment context changed. Your draft is retained; discard and reload before saving.</p>}
                {marksDirty && <p className="text-sm muted">Unsaved marks are retained until you save or explicitly discard them. Saved scores cannot be cleared here.</p>}
                {rosterLoading ? <LoadingState variant="table" className="text-sm muted">Loading students and marks...</LoadingState> : students.length === 0 ? <p className="text-sm muted">No enrolled students found for this class and section.</p> : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[760px] text-left text-sm">
                      <thead className="border-b border-[var(--border)] text-xs muted"><tr>{["Student", "Roll No.", "Admission No.", "Marks", "Remarks"].map((heading) => <th key={heading} className="p-3">{heading}</th>)}</tr></thead>
                      <tbody className="divide-y divide-[var(--border)]">
                        {students.map((student) => (
                          <tr key={student.id}>
                            <td className="p-3 font-semibold">{[student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" ")}</td>
                            <td className="p-3">{student.roll_no ?? "—"}</td>
                            <td className="p-3">{student.admission_no ?? "—"}</td>
                            <td className="p-3"><input aria-label={`Marks for ${student.first_name} ${student.admission_no ?? student.id}`} type="number" min="0" max={selectedAssessment.maximum_marks} step="0.01" disabled={saving || selectedAssessment.teacher_id !== teacherId} value={marks[student.id]?.value ?? ""} onChange={(event) => setMarks((current) => ({ ...current, [student.id]: { value: event.target.value, remarks: current[student.id]?.remarks ?? "" } }))} className="field w-32" /></td>
                            <td className="p-3"><input aria-label={`Remarks for ${student.first_name} ${student.admission_no ?? student.id}`} disabled={saving || selectedAssessment.teacher_id !== teacherId} value={marks[student.id]?.remarks ?? ""} onChange={(event) => setMarks((current) => ({ ...current, [student.id]: { value: current[student.id]?.value ?? "", remarks: event.target.value } }))} className="field" /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="flex flex-wrap gap-3">
                  {selectedAssessment.teacher_id === teacherId && <button type="button" disabled={saving || !students.length || !marksDirty || marksScopeChanged || currentRoster?.requiresReload} onClick={() => void saveMarks()} className="rounded-xl gradient px-5 py-3 text-sm font-bold disabled:opacity-50">{saving ? "Saving..." : "Save Marks"}</button>}
                  <button type="button" disabled={saving} onClick={() => void reloadMarks()} className="rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-semibold disabled:opacity-50">{marksDirty ? "Discard changes and reload marks" : "Reload marks"}</button>
                </div>
              </>
            )}
          </>
        )}
      </section>
      {pendingDeleteAssessment && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
          <section role="alertdialog" aria-modal="true" aria-labelledby="delete-assessment-title" className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl">
            <h2 id="delete-assessment-title" className="text-lg font-bold">Delete Exam / Test?</h2>
            <p className="mt-2 text-sm muted">“{pendingDeleteAssessment.name}” and its marks will be permanently removed.</p>
            <div className="mt-5 flex justify-end gap-3">
              <button type="button" onClick={() => setPendingDeleteAssessment(null)} className="rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold">Cancel</button>
              <button type="button" disabled={saving} onClick={() => void deleteAssessment(pendingDeleteAssessment)} className="rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">Delete</button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

function ResultFilter({
  label,
  value,
  onChange,
  options,
  allLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  allLabel: string;
}) {
  return (
    <label className="block text-sm font-semibold">
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)} className="field mt-2">
        <option value="all">{allLabel}</option>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function ResultReportView() {
  const [loading, setLoading] = useState(true);
  const [setupError, setSetupError] = useState("");
  const [assessments, setAssessments] = useState<AssessmentRecord[]>([]);
  const [yearNames, setYearNames] = useState<Record<string, string>>({});
  const [classes, setClasses] = useState<SchoolOption[]>([]);
  const [sections, setSections] = useState<SchoolSectionOption[]>([]);
  const [subjects, setSubjects] = useState<SchoolOption[]>([]);
  const [context, setContext] = useState<{ schoolId: string; assignments: TeachingAssignment[] } | null>(null);
  const [reportReload, setReportReload] = useState(0);
  type ResultRow = ReturnType<typeof rankAssessmentMarks>[number] & { assignment?: TeachingAssignment };
  const [report, setReport] = useState<{ scope: string; rows: ResultRow[]; loading: boolean; error: string } | null>(null);
  const [academicYear, setAcademicYear] = useState("all");
  const [classId, setClassId] = useState("all");
  const [sectionId, setSectionId] = useState("all");
  const [subjectId, setSubjectId] = useState("all");
  const [assessmentId, setAssessmentId] = useState("all");
  const reportScope = JSON.stringify([context?.schoolId, academicYear, classId, sectionId, subjectId, assessmentId]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [teacherId, assignments] = await Promise.all([getCurrentTeacherId(), getCurrentTeacherAssignments()]);
        if (!teacherId) throw new Error("Teacher profile was not found for this login.");
        const client = createClient();
        const { data: teacher, error: teacherError } = await client.from("teachers").select("school_id").eq("id", teacherId).single();
        if (teacherError) throw teacherError;
        const schoolId = teacher.school_id as string;
        const [classRows, sectionRows, subjectRows, yearRows, allAssessments] = await Promise.all([
          readCompletePages<SchoolOption>((from, to) => client.from("classes").select("id,name", { count: "exact" }).eq("school_id", schoolId).order("sort_order").order("id").range(from, to), "Classes could not be loaded completely"),
          readCompletePages<SchoolSectionOption>((from, to) => client.from("sections").select("id,class_id,name", { count: "exact" }).eq("school_id", schoolId).order("name").order("id").range(from, to), "Sections could not be loaded completely"),
          readCompletePages<SchoolOption>((from, to) => client.from("subjects").select("id,name", { count: "exact" }).eq("school_id", schoolId).order("name").order("id").range(from, to), "Subjects could not be loaded completely"),
          readCompletePages<SchoolOption>((from, to) => client.from("academic_years").select("id,name", { count: "exact" }).eq("school_id", schoolId).order("start_date", { ascending: false }).order("id").range(from, to), "Academic years could not be loaded completely"),
          loadAssessments(client, schoolId),
        ]);
        if (active) {
          setClasses(classRows); setSections(sectionRows); setSubjects(subjectRows);
          setAssessments(allAssessments);
          setYearNames(Object.fromEntries(yearRows.map((row) => [row.id, row.name])));
          setContext({ schoolId, assignments });
        }
      } catch (loadError) {
        if (active) setSetupError(errorText(loadError, "Result setup could not be loaded completely. Please refresh."));
      } finally { if (active) setLoading(false); }
    };
    void load();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!context) return;
    let active = true;
    const load = async () => {
      setReport({ scope: reportScope, rows: [], loading: true, error: "" });
      try {
        const client = createClient();
        const filtered = await loadAssessments(client, context.schoolId, { academicYear, classId, sectionId, subjectId, assessmentId });
        const marks = await loadAssessmentMarks(client, filtered.map((row) => row.id));
        const students = await loadAssessmentStudents(client, context.schoolId, marks.map((row) => row.student_id));
        const key = (row: { class_id: string; section_id: string | null; subject_id: string; academic_year_id: string }) => JSON.stringify([row.class_id, row.section_id, row.subject_id, row.academic_year_id]);
        const assignments = new Map(context.assignments.map((row) => [key(row), row]));
        const rows = rankAssessmentMarks(filtered, marks, students).map((row) => ({ ...row, assignment: assignments.get(key(row.assessment)) }));
        if (active) setReport({ scope: reportScope, rows, loading: false, error: "" });
      } catch (loadError) {
        if (active) setReport({ scope: reportScope, rows: [], loading: false, error: errorText(loadError, "Result report could not be loaded completely. Please retry.") });
      }
    };
    void load();
    return () => { active = false; };
  }, [academicYear, assessmentId, classId, context, reportReload, reportScope, sectionId, subjectId]);

  const error = setupError || (report?.scope === reportScope ? report.error : "");
  const reportLoading = loading || Boolean(context && (report?.scope !== reportScope || report.loading));
  const years = [...new Set(assessments.map((assessment) => assessment.academic_year_id))];
  const visibleSections = sections.filter((section) => classId === "all" || section.class_id === classId);
  const filterOptions = [
    { label: "Academic Year", allLabel: "All Years", value: academicYear, onChange: setAcademicYear, options: years.map((value) => ({ value, label: yearNames[value] ?? value })) },
    { label: "Exam", allLabel: "All Exams", value: assessmentId, onChange: setAssessmentId, options: assessments.map((assessment) => ({ value: assessment.id, label: assessment.name })) },
    { label: "Class", allLabel: "All Classes", value: classId, onChange: (value: string) => { setClassId(value); setSectionId("all"); }, options: classes.map((item) => ({ value: item.id, label: item.name })) },
    { label: "Section", allLabel: "All Sections", value: sectionId, onChange: setSectionId, options: visibleSections.map((item) => ({ value: item.id, label: item.name })) },
    { label: "Subject", allLabel: "All Subjects", value: subjectId, onChange: setSubjectId, options: subjects.map((item) => ({ value: item.id, label: item.name })) },
  ];
  const visibleRows = report?.scope === reportScope ? report.rows : [];

  return (
    <section className="space-y-5">
      <header>
        <p className="text-xs font-semibold uppercase tracking-widest text-blue-600">Assessment</p>
        <h1 className="mt-1 text-3xl font-black">Result Report</h1>
        <button type="button" disabled={loading || reportLoading || !context} onClick={() => setReportReload((value) => value + 1)} className="mt-3 rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-semibold disabled:opacity-50">Reload results</button>
      </header>
      {error && <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-600">{error}</div>}
      <div className="grid gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:grid-cols-2 lg:grid-cols-5">
        {filterOptions.map((filter) => <ResultFilter key={filter.label} {...filter} />)}
      </div>
      <p className="text-sm muted">Pass/fail and division are not shown because no school grading rules are configured. Rank is calculated among students with marks entered for each assessment.</p>
      <section className="card overflow-x-auto">
        {reportLoading ? <LoadingState variant="list" className="p-5 text-sm muted">Loading complete result data...</LoadingState> : error ? <p className="p-5 text-sm muted">No ranks are shown until the full selected report can be loaded.</p> : visibleRows.length === 0 ? (
          <div className="p-8 text-center">
            <h2 className="font-bold">No Results Yet</h2>
            <p className="mt-1 text-sm muted">Results will appear after marks are entered for an exam or test.</p>
            <Link href="/modules/exams" className="mt-4 inline-flex rounded-xl gradient px-4 py-2.5 text-sm font-bold">Open Exam / Marks</Link>
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[1100px] text-left text-sm">
                <thead className="border-b border-[var(--border)] text-xs muted"><tr>{["Student", "Roll No.", "Admission No.", "Class", "Section", "Subject", "Exam", "Marks", "Maximum", "Percentage", "Rank"].map((heading) => <th key={heading} className="p-3">{heading}</th>)}</tr></thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {visibleRows.map(({ assessment, mark, student, assignment, rank, percentage }) => (
                    <tr key={mark.id}>
                      <td className="p-3 font-semibold">{[student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" ")}</td>
                      <td className="p-3">{student.roll_no ?? "—"}</td>
                      <td className="p-3">{student.admission_no ?? "—"}</td>
                      <td className="p-3">{assignment?.class_name ?? classes.find((item) => item.id === assessment.class_id)?.name ?? "—"}</td>
                      <td className="p-3">{assignment?.section_name ?? sections.find((item) => item.id === assessment.section_id)?.name ?? "—"}</td>
                      <td className="p-3">{assignment?.subject_name ?? subjects.find((item) => item.id === assessment.subject_id)?.name ?? "—"}</td>
                      <td className="p-3">{assessment.name}</td>
                      <td className="p-3">{mark.marks_obtained}</td>
                      <td className="p-3">{assessment.maximum_marks}</td>
                      <td className="p-3">{percentage.toFixed(2)}%</td>
                      <td className="p-3">{rank}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="divide-y divide-[var(--border)] md:hidden">
              {visibleRows.map(({ assessment, mark, student, assignment, rank, percentage }) => (
                <article key={mark.id} className="space-y-3 p-4">
                  <div>
                    <h3 className="font-bold">{[student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" ")}</h3>
                    <p className="mt-1 text-xs muted">Roll {student.roll_no ?? "—"} · Admission {student.admission_no ?? "—"} · {assessment.name}</p>
                  </div>
                  <dl className="grid grid-cols-2 gap-3 text-sm">
                    <div><dt className="text-xs muted">Class</dt><dd className="mt-1">{assignment?.class_name ?? classes.find((item) => item.id === assessment.class_id)?.name ?? "—"}</dd></div>
                    <div><dt className="text-xs muted">Section</dt><dd className="mt-1">{assignment?.section_name ?? sections.find((item) => item.id === assessment.section_id)?.name ?? "—"}</dd></div>
                    <div><dt className="text-xs muted">Subject</dt><dd className="mt-1">{assignment?.subject_name ?? subjects.find((item) => item.id === assessment.subject_id)?.name ?? "—"}</dd></div>
                    <div><dt className="text-xs muted">Marks</dt><dd className="mt-1">{mark.marks_obtained} / {assessment.maximum_marks}</dd></div>
                    <div><dt className="text-xs muted">Percentage</dt><dd className="mt-1">{percentage.toFixed(2)}%</dd></div>
                    <div><dt className="text-xs muted">Rank</dt><dd className="mt-1">{rank}</dd></div>
                  </dl>
                </article>
              ))}
            </div>
          </>
        )}
      </section>
    </section>
  );
}

type EnrollmentRow = {
  student_id: string;
  class_id: string;
  section_id: string | null;
  academic_year_id: string;
};

type StudentRecord = {
  id: string;
  admission_no: string | null;
  first_name: string;
  middle_name: string | null;
  last_name: string | null;
  roll_no: string | null;
};

type FeeRecord = {
  id: string;
  student_id: string;
  amount: number;
  discount: number | null;
  late_fee: number | null;
  status: string;
  billing_period: string | null;
  due_date: string | null;
};

type PaymentRecord = {
  student_fee_id: string;
  amount: number;
  status: string;
};

type TeacherFeeRow = {
  fee: FeeRecord;
  student: StudentRecord;
  assignment: TeachingAssignment;
  paid: number;
};

function FeeView() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [rows, setRows] = useState<TeacherFeeRow[]>([]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const assignments = await getCurrentTeacherAssignments({ currentYearOnly: true });
        if (!assignments.length) {
          if (active) setRows([]);
          return;
        }
        const supabase = createClient();
        const classIds = [...new Set(assignments.map((assignment) => assignment.class_id))];
        const yearIds = [...new Set(assignments.map((assignment) => assignment.academic_year_id))];
        const { data: enrollments, error: enrollmentError } = await supabase
          .from("enrollments")
          .select("student_id,class_id,section_id,academic_year_id")
          .in("class_id", classIds)
          .in("academic_year_id", yearIds)
          .eq("status", "active");
        if (enrollmentError) throw enrollmentError;

        const eligibleEnrollments = ((enrollments ?? []) as EnrollmentRow[]).flatMap((enrollment) => {
          const assignment = assignments.find((item) =>
            item.class_id === enrollment.class_id &&
            item.academic_year_id === enrollment.academic_year_id &&
            (!item.section_id || item.section_id === enrollment.section_id),
          );
          return assignment ? [{ enrollment, assignment }] : [];
        });
        const studentIds = [...new Set(eligibleEnrollments.map(({ enrollment }) => enrollment.student_id))];
        if (!studentIds.length) {
          if (active) setRows([]);
          return;
        }

        const [{ data: students, error: studentsError }, { data: fees, error: feesError }] = await Promise.all([
          supabase.from("students").select("id,admission_no,first_name,middle_name,last_name,roll_no").in("id", studentIds),
          supabase.from("student_fees").select("id,student_id,amount,discount,late_fee,status,billing_period,due_date").in("student_id", studentIds).order("created_at", { ascending: false }).limit(500),
        ]);
        if (studentsError) throw studentsError;
        if (feesError) throw feesError;

        const feeRows = (fees ?? []) as FeeRecord[];
        const feeIds = feeRows.map((fee) => fee.id);
        const { data: payments, error: paymentsError } = feeIds.length
          ? await supabase.from("fee_payments").select("student_fee_id,amount,status").in("student_fee_id", feeIds)
          : { data: [], error: null };
        if (paymentsError) throw paymentsError;

        const paymentTotals = new Map<string, number>();
        for (const payment of (payments ?? []) as PaymentRecord[]) {
          if (payment.status !== "paid") continue;
          paymentTotals.set(payment.student_fee_id, (paymentTotals.get(payment.student_fee_id) ?? 0) + Number(payment.amount));
        }
        const studentById = new Map(((students ?? []) as StudentRecord[]).map((student) => [student.id, student]));
        const result = feeRows.flatMap((fee) => {
          const student = studentById.get(fee.student_id);
          const match = eligibleEnrollments.find(({ enrollment }) => enrollment.student_id === fee.student_id);
          const assignment = match?.assignment;
          return student && assignment ? [{
            fee,
            student,
            assignment,
            paid: paymentTotals.get(fee.id) ?? 0,
          }] : [];
        });
        if (active) setRows(result);
      } catch (loadError) {
        if (active) setError(errorText(loadError, "Fee information could not be loaded."));
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  return (
    <section className="space-y-5">
      <header>
        <p className="text-xs font-semibold uppercase tracking-widest text-blue-600">Read-only</p>
        <h1 className="mt-1 text-3xl font-black">Fee</h1>
        <p className="mt-2 text-sm muted">Fee records are limited to students in your assigned classes and sections. Payments cannot be posted here.</p>
      </header>
      {error && <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-600">{error}</div>}
      <section className="card overflow-x-auto">
        {loading ? <LoadingState variant="table" className="p-5 text-sm muted">Loading assigned students&apos; fee status...</LoadingState> : rows.length === 0 ? (
          <p className="p-5 text-sm muted">No records found.</p>
        ) : (
          <table className="w-full min-w-[850px] text-left text-sm">
            <thead className="border-b border-[var(--border)] text-xs muted">
              <tr>{["Student", "Class / Section", "Month", "Fee amount", "Paid", "Pending", "Status"].map((heading) => <th key={heading} className="p-4 font-semibold">{heading}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {rows.map(({ fee, student, assignment, paid }) => {
                const amount = Number(fee.amount) - Number(fee.discount ?? 0) + Number(fee.late_fee ?? 0);
                const pending = Math.max(0, amount - paid);
                const status = pending === 0 ? "Paid" : paid > 0 ? "Partial" : fee.status;
                return (
                  <tr key={fee.id}>
                    <td className="p-4"><div className="font-semibold">{[student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" ")}</div><div className="text-xs muted">{student.admission_no ?? "No admission number"} · Roll {student.roll_no ?? "—"}</div></td>
                    <td className="p-4">{assignment.class_name} · {assignment.section_name}</td>
                    <td className="p-4">{fee.billing_period ?? fee.due_date ?? "—"}</td>
                    <td className="p-4">{amount.toFixed(2)}</td>
                    <td className="p-4">{paid.toFixed(2)}</td>
                    <td className="p-4">{pending.toFixed(2)}</td>
                    <td className="p-4">{status}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </section>
  );
}

type TeacherProfileRecord = {
  full_name: string | null;
  employee_id: string | null;
  designation: string | null;
  department: string | null;
  joining_date: string | null;
  qualification: string | null;
  registered_mobile: string | null;
};

function ProfileView() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [profile, setProfile] = useState<TeacherProfileRecord | null>(null);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [savingPhone, setSavingPhone] = useState(false);
  const [message, setMessage] = useState("");
  const [assignments, setAssignments] = useState<TeachingAssignment[]>([]);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [resettingPassword, setResettingPassword] = useState(false);
  const [showResetPasswordConfirm, setShowResetPasswordConfirm] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const supabase = createClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError) throw authError;
        if (!user) throw new Error("Please sign in to view your profile.");
        const ownAssignments = await getCurrentTeacherAssignments({ currentYearOnly: true });
        const { data, error: profileError } = await supabase
          .from("teachers")
          .select("full_name,employee_id,designation,department,joining_date,qualification,registered_mobile")
          .eq("profile_id", user.id)
          .maybeSingle();
        if (profileError) throw profileError;
        if (active) {
          setProfile(data as TeacherProfileRecord | null);
          setPhone(data?.registered_mobile ?? "");
          setEmail(user.email ?? "");
          setAssignments(ownAssignments);
        }
      } catch (loadError) {
        if (active) setError(errorText(loadError, "Your profile could not be loaded."));
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  const details: [string, string | null][] = [
    ["Name", profile?.full_name ?? null],
    ["Employee ID", profile?.employee_id ?? null],
    ["Email", email || null],
    ["Phone", profile?.registered_mobile ?? null],
    ["Qualification", profile?.qualification ?? null],
    ["Designation", profile?.designation ?? null],
    ["Department", profile?.department ?? null],
    ["Joining date", profile?.joining_date ?? null],
  ];

  const savePhone = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSavingPhone(true);
    setError("");
    setMessage("");
    try {
      const { error: saveError } = await createClient().rpc("update_my_teacher_phone", {
        p_registered_mobile: phone.trim() || null,
      });
      if (saveError) throw saveError;
      setProfile((current) => current ? { ...current, registered_mobile: phone.trim() || null } : current);
      setMessage("Phone number updated.");
    } catch (saveError) {
      logSupabaseError("Teacher phone update failed", saveError);
      setError(userFacingError(saveError, "Phone number could not be updated. Please try again."));
    } finally {
      setSavingPhone(false);
    }
  };

  const changePassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setMessage("");
    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New password and confirmation do not match.");
      return;
    }
    if (!email) {
      setError("Your account email could not be loaded. Sign in again and retry.");
      return;
    }

    setSavingPassword(true);
    try {
      const supabase = createClient();
      const { error: verifyError } = await supabase.auth.signInWithPassword({
        email,
        password: currentPassword,
      });
      if (verifyError) {
        setError("Current password is incorrect.");
        return;
      }
      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
      if (updateError) throw updateError;
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setMessage("Password changed successfully.");
    } catch (passwordError) {
      logSupabaseError("Teacher password change failed", passwordError);
      setError(userFacingError(passwordError, "Password could not be changed. Please try again."));
    } finally {
      setSavingPassword(false);
    }
  };

  const sendPasswordReset = async () => {
    if (!email) {
      setError("Your account email could not be loaded. Sign in again and retry.");
      return;
    }
    setError("");
    setMessage("");
    setResettingPassword(true);
    try {
      const { error: resetError } = await createClient().auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/update-password`,
      });
      if (resetError) throw resetError;
      setShowResetPasswordConfirm(false);
      setMessage("Password reset link sent to your email.");
    } catch (resetError) {
      logSupabaseError("Teacher password reset request failed", resetError);
      setError(userFacingError(resetError, "Password reset email could not be sent. Please try again."));
      setShowResetPasswordConfirm(false);
    } finally {
      setResettingPassword(false);
    }
  };

  const logout = async () => {
    setError("");
    setSigningOut(true);
    try {
      const { error: signOutError } = await createClient().auth.signOut();
      if (signOutError) throw signOutError;
      router.replace("/login");
      router.refresh();
    } catch (signOutError) {
      logSupabaseError("Teacher sign out failed", signOutError);
      setError(userFacingError(signOutError, "Could not log out. Please try again."));
      setSigningOut(false);
    }
  };

  return (
    <section className="space-y-5">
      <header>
        <p className="text-xs font-semibold uppercase tracking-widest text-blue-600">Personal workspace</p>
        <h1 className="mt-1 text-3xl font-black">My Profile</h1>
      </header>
      {error && <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-600">{error}</div>}
      {message && <div role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm text-emerald-700">{message}</div>}
      <section className="card p-5 sm:p-6">
        {loading ? <LoadingState variant="form" className="text-sm muted">Loading your profile...</LoadingState> : !profile ? (
          <p className="text-sm muted">No teacher profile is linked to this login.</p>
        ) : (
          <>
            <div className="mb-5 flex items-center gap-3 border-b border-[var(--border)] pb-5">
              <div className="grid h-12 w-12 place-items-center rounded-2xl gradient text-white"><ShieldCheck size={22} /></div>
              <div><h2 className="text-lg font-bold">{profile.full_name || "Teacher"}</h2><p className="text-sm muted">{profile.designation || "Teacher profile"}</p></div>
            </div>
            <h2 className="mb-3 text-xs font-bold uppercase tracking-widest muted">Personal Information</h2>
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {details.map(([label, value]) => <div key={label}><dt className="text-xs muted">{label}</dt><dd className="mt-1 font-semibold">{value ?? "—"}</dd></div>)}
            </dl>
            <div className="mt-6 border-t border-[var(--border)] pt-4">
              <h2 className="font-bold">My Classes & Responsibilities</h2>
              {assignments.length ? (
                <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                  {assignments.map((assignment) => (
                    <li key={assignment.id} className="rounded-xl bg-[var(--surface-2)] p-3 text-sm">
                      <div className="font-semibold">{assignment.class_name} · {assignment.section_name}</div>
                      <div className="mt-1 text-xs muted">{assignment.subject_name}{assignment.is_class_teacher ? " · Class Teacher" : ""}</div>
                    </li>
                  ))}
                </ul>
              ) : <p className="mt-2 text-sm muted">No records found.</p>}
            </div>
            <form onSubmit={savePhone} className="mt-5 flex flex-col gap-3 border-t border-[var(--border)] pt-4 sm:flex-row sm:items-end">
              <label className="block flex-1 text-xs font-semibold"><span className="mb-2 block">Update phone number</span><input value={phone} onChange={(event) => setPhone(event.target.value)} maxLength={40} className="field" /></label>
              <button disabled={savingPhone} className="rounded-xl gradient px-5 py-3 text-sm font-bold disabled:opacity-50">{savingPhone ? "Saving..." : "Save Phone"}</button>
            </form>
            <p className="mt-3 text-xs muted">Only your own registered phone can be updated. Other profile fields require school administration.</p>
            <div className="mt-6 border-t border-[var(--border)] pt-5">
              <div className="flex items-center gap-2"><KeyRound size={18} className="text-blue-600" /><h2 className="font-bold">Account & Security</h2></div>
              <form onSubmit={changePassword} className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="block text-sm font-semibold"><span className="mb-2 block">Current Password</span><input required type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} className="field" /></label>
                <label className="block text-sm font-semibold"><span className="mb-2 block">New Password</span><input required type="password" autoComplete="new-password" minLength={8} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} className="field" /></label>
                <label className="block text-sm font-semibold"><span className="mb-2 block">Confirm New Password</span><input required type="password" autoComplete="new-password" minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className="field" /></label>
                <div className="flex flex-wrap items-end gap-3">
                  <button disabled={savingPassword} className="rounded-xl gradient px-5 py-3 text-sm font-bold disabled:opacity-50">{savingPassword ? "Changing..." : "Change Password"}</button>
                  <button type="button" onClick={() => {
                    setError("");
                    setShowResetPasswordConfirm(true);
                  }} className="rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-semibold">Reset Password</button>
                </div>
              </form>
              <p className="mt-2 text-xs muted">Use at least 8 characters. Passwords are handled securely by Supabase Auth.</p>
              <button type="button" disabled={signingOut} onClick={() => void logout()} className="mt-5 inline-flex items-center gap-2 rounded-xl border border-red-500/30 px-5 py-3 text-sm font-bold text-red-600 transition hover:bg-red-500/5 disabled:opacity-50">
                <LogOut size={17} />{signingOut ? "Signing out..." : "Log Out"}
              </button>
            </div>
          </>
        )}
      </section>
      {showResetPasswordConfirm && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
          <section role="alertdialog" aria-modal="true" aria-labelledby="reset-password-title" className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl">
            <h2 id="reset-password-title" className="text-lg font-bold">Reset your password?</h2>
            <p className="mt-2 text-sm muted">We&apos;ll send a password reset link to your registered email address{email ? ` (${email})` : ""}.</p>
            <div className="mt-5 flex justify-end gap-3">
              <button type="button" disabled={resettingPassword} onClick={() => setShowResetPasswordConfirm(false)} className="rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold disabled:opacity-50">Cancel</button>
              <button type="button" disabled={resettingPassword} onClick={() => void sendPasswordReset()} className="rounded-xl gradient px-4 py-2.5 text-sm font-semibold disabled:opacity-50">{resettingPassword ? "Sending..." : "Send Reset Link"}</button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

export function TeacherModuleView({ module }: { module: "exams" | "results" | "fees" | "profile" }) {
  if (module === "exams") return <ExamScheduleView />;
  if (module === "results") return <ResultReportView />;
  if (module === "fees") return <FeeView />;
  return <ProfileView />;
}
