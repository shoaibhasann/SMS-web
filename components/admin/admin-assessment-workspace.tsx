"use client";

import { FormEvent, useCallback, useEffect, useRef, useMemo, useState } from "react";
import { Download, Pencil, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  loadAssessments, loadAssessmentMarks, loadAssessmentStudents, loadAssessmentRoster,
  markChanges, markDraftHasChanges, saveChangedMarks, teacherMatchesAssessmentScope,
  type AssessmentRecord as Assessment, type AssessmentMark, type AssessmentStudent, type TeachingAssignmentScope,
} from "@/lib/assessments";
import { loadSchoolManagementAccess, readPages } from "@/lib/attendance/repository";
import { schoolDate, studentName } from "@/lib/attendance/types";
import { LoadingState } from "@/components/ui/skeleton";

type Option = { id: string; name: string };
type SectionOption = Option & { class_id: string };
type StudentOption = Option & { admission_no: string; roll_no: string | null };
type AssessmentForm = Omit<Assessment, "id" | "school_id" | "teacher_id" | "updated_at"> & {
  teacher_id: string;
};

const RESULT_PAGE_SIZE = 100;

const emptyForm = (): AssessmentForm => ({
  academic_year_id: "",
  class_id: "",
  section_id: null,
  subject_id: "",
  teacher_id: "",
  name: "",
  assessment_date: schoolDate(),
  maximum_marks: 100,
  description: "",
  status: "scheduled",
});

function logError(context: string, error: unknown) {
  if (error && typeof error === "object") {
    const item = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    console.error(context, {
      message: item.message,
      details: item.details,
      hint: item.hint,
      code: item.code,
    });
  } else {
    console.error(context, error);
  }
}

export function AdminAssessmentWorkspace({ mode }: { mode: "exams" | "results" }) {
  const [supabase] = useState(createClient);
  const latestRequest = useRef(0);
  const latestMarksRequest = useRef(0);
  const mounted = useRef(true);
  const selectedSchool = useRef("");
  // null = not chosen yet, so load() defaults to the school's current academic year.
  const selectedYear = useRef<string | null>(null);
  const [schools, setSchools] = useState<Option[]>([]);
  const [schoolId, setSchoolId] = useState("");
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [marks, setMarks] = useState<AssessmentMark[]>([]);
  const [students, setStudents] = useState<StudentOption[]>([]);
  const [years, setYears] = useState<Option[]>([]);
  const [classes, setClasses] = useState<Option[]>([]);
  const [sections, setSections] = useState<SectionOption[]>([]);
  const [subjects, setSubjects] = useState<Option[]>([]);
  const [teachers, setTeachers] = useState<Option[]>([]);
  const [assignments, setAssignments] = useState<TeachingAssignmentScope[]>([]);
  const [classNames, setClassNames] = useState<Record<string, string>>({});
  const [sectionNames, setSectionNames] = useState<Record<string, string>>({});
  const [subjectNames, setSubjectNames] = useState<Record<string, string>>({});
  const [teacherNames, setTeacherNames] = useState<Record<string, string>>({});
  const [form, setForm] = useState<AssessmentForm>(emptyForm);
  const [editingId, setEditingId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [yearFilter, setYearFilter] = useState("All");
  const [examFilter, setExamFilter] = useState("All");
  const [classFilter, setClassFilter] = useState("All");
  const [sectionFilter, setSectionFilter] = useState("All");
  const [subjectFilter, setSubjectFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState("All");
  const [resultPage, setResultPage] = useState({ key: "", page: 0 });
  const [markAssessment, setMarkAssessment] = useState<Assessment | null>(null);
  const [markRoster, setMarkRoster] = useState<AssessmentStudent[]>([]);
  const [markBaseline, setMarkBaseline] = useState<AssessmentMark[]>([]);
  const markWriteInFlight = useRef(false);
  const [markValues, setMarkValues] = useState<Record<string, string>>({});
  const [markLoading, setMarkLoading] = useState(false);
  const [markSaving, setMarkSaving] = useState(false);

  const sectionOptions = useMemo(
    () => sections.filter((section) => section.class_id === form.class_id),
    [sections, form.class_id],
  );

  const clearSchoolData = useCallback(() => {
    setSchoolId(""); setAssessments([]); setMarks([]); setStudents([]); setYears([]); setClasses([]); setSections([]);
    setSubjects([]); setTeachers([]); setAssignments([]); setClassNames({}); setSectionNames({}); setSubjectNames({}); setTeacherNames({});
  }, []);

  // Office-created exams must stay reachable by their teacher (preview, marks, publication request).
  const teacherOptions = useMemo(
    () => teachers.filter((teacher) => teacher.id === form.teacher_id || teacherMatchesAssessmentScope(assignments, teacher.id, form)),
    [teachers, assignments, form],
  );

  const load = useCallback(() => {
    const request = ++latestRequest.current;
    const isCurrent = () => mounted.current && request === latestRequest.current;
    return supabase.auth.getUser().then(async ({ data: auth, error: authError }) => {
      try {
        if (!isCurrent()) return;
        setLoading(true);
        setError("");
        if (authError) throw authError;
        if (!auth.user) throw new Error("Please sign in again.");

        const access = await loadSchoolManagementAccess(supabase, "assessments", ["school_admin"]);
        if (!isCurrent()) return;
        if (access.userId !== auth.user.id) throw new Error("Your sign-in changed. Reload to verify school access.");
        const chosen = selectedSchool.current;
        const resolvedSchoolId = access.schools.some((school) => school.id === chosen) ? chosen
          : access.schools.length === 1 ? access.schools[0].id : "";
        setSchools(access.schools);
        if (!resolvedSchoolId) { selectedSchool.current = ""; clearSchoolData(); return; }

        const yearResult = await supabase.from("academic_years").select("id,name,is_current").eq("school_id", resolvedSchoolId).order("start_date", { ascending: false });
        if (yearResult.error) throw yearResult.error;
        const yearRows = yearResult.data ?? [];
        const teacherLoad = Promise.resolve(supabase.from("teachers").select("id,full_name").eq("school_id", resolvedSchoolId).order("full_name"));
        const chosenYear = selectedYear.current;
        const year = chosenYear === "All" || yearRows.some((row) => row.id === chosenYear) ? chosenYear!
          : yearRows.find((row) => row.is_current)?.id ?? "All";
        const [
          classResult,
          sectionResult,
          subjectResult,
          teacherResult,
          assignmentRows,
          assessmentRows,
        ] = await Promise.all([
          supabase.from("classes").select("id,name").eq("school_id", resolvedSchoolId).eq("is_active", true).order("sort_order"),
          supabase.from("sections").select("id,name,class_id").eq("school_id", resolvedSchoolId).order("name"),
          supabase.from("subjects").select("id,name").eq("school_id", resolvedSchoolId).eq("is_active", true).order("name"),
          teacherLoad,
          // Same scoping as lib/assignments/repository.ts: assignments of this school's teachers, 100 ids per request.
          teacherLoad.then(async ({ data, error }) => {
            if (error) throw error;
            const teacherIds = (data ?? []).map((row) => row.id);
            const rows: TeachingAssignmentScope[] = [];
            for (let offset = 0; offset < teacherIds.length; offset += 100) {
              rows.push(...await readPages<TeachingAssignmentScope>((from, to) => supabase.from("teacher_subject_assignments")
                .select("teacher_id,academic_year_id,class_id,section_id,subject_id", { count: "exact" })
                .in("teacher_id", teacherIds.slice(offset, offset + 100)).order("id").range(from, to), "Teaching assignments could not be loaded"));
            }
            return rows;
          }),
          loadAssessments(supabase, resolvedSchoolId, { academicYear: year === "All" ? undefined : year }),
        ]);
        const failed = [classResult, sectionResult, subjectResult, teacherResult].find((result) => result.error);
        if (failed?.error) throw failed.error;

        const classRows = classResult.data ?? [];
        const sectionRows = sectionResult.data ?? [];
        const subjectRows = subjectResult.data ?? [];
        const teacherRows = teacherResult.data ?? [];
        const assessmentIds = assessmentRows.map((row) => row.id);
        let loadedMarks: AssessmentMark[] = [];
        let loadedStudents: StudentOption[] = [];
        if (mode === "results" && assessmentIds.length) {
          loadedMarks = await loadAssessmentMarks(supabase, assessmentIds);
          const studentIds = [...new Set(loadedMarks.map((row) => row.student_id))];
          const studentRows = await loadAssessmentStudents(supabase, resolvedSchoolId, studentIds);
          loadedStudents = studentRows.map((student) => ({ id: student.id, name: studentName(student),
            admission_no: student.admission_no ?? "—", roll_no: student.roll_no }));
        }
        if (!isCurrent()) return;
        setSchoolId(resolvedSchoolId);
        selectedYear.current = year;
        setYearFilter(year);
        setYears(yearRows);
        setClasses(classRows);
        setSections(sectionRows);
        setSubjects(subjectRows);
        setTeachers(teacherRows.map((row) => ({ id: row.id, name: row.full_name ?? "Teacher" })));
        setClassNames(Object.fromEntries(classRows.map((row) => [row.id, row.name])));
        setSectionNames(Object.fromEntries(sectionRows.map((row) => [row.id, row.name])));
        setSubjectNames(Object.fromEntries(subjectRows.map((row) => [row.id, row.name])));
        setTeacherNames(Object.fromEntries(teacherRows.map((row) => [row.id, row.full_name ?? "Teacher"])));
        setAssignments(assignmentRows);
        setAssessments(assessmentRows);
        setMarks(loadedMarks);
        setStudents(loadedStudents);
      } catch (loadError) {
        if (!isCurrent()) return;
        logError("Admin assessment data load failed", loadError);
        setError("Assessment data could not be loaded. Please refresh or contact your administrator.");
      } finally {
        if (isCurrent()) setLoading(false);
      }
    }, (loadError: unknown) => {
      if (!isCurrent()) return;
      logError("Admin assessment data load failed", loadError);
      setError("Assessment data could not be loaded. Please refresh or contact your administrator.");
      setLoading(false);
    });
  }, [supabase, clearSchoolData, mode]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; latestRequest.current += 1; latestMarksRequest.current += 1; };
  }, [load]);

  function startEdit(assessment: Assessment) {
    setEditingId(assessment.id);
    setForm({
      academic_year_id: assessment.academic_year_id,
      class_id: assessment.class_id,
      section_id: assessment.section_id,
      subject_id: assessment.subject_id,
      teacher_id: assessment.teacher_id,
      name: assessment.name,
      assessment_date: assessment.assessment_date,
      maximum_marks: Number(assessment.maximum_marks),
      description: assessment.description ?? "",
      status: assessment.status,
    });
    setMessage("");
    setError("");
  }

  const markDraft = useMemo(() => {
    const saved = new Map(markBaseline.map((mark) => [mark.student_id, mark]));
    return Object.fromEntries(markRoster.map((student) => [student.id, {
      value: markValues[student.id] ?? "", remarks: saved.get(student.id)?.remarks ?? "",
    }]));
  }, [markBaseline, markRoster, markValues]);
  const markDirty = markDraftHasChanges(markRoster, markDraft, markBaseline);
  const assessmentById = useMemo(() => new Map(assessments.map((assessment) => [assessment.id, assessment])), [assessments]);
  const studentNames = useMemo(() => new Map(students.map((student) => [student.id, student])), [students]);

  async function openMarks(assessment: Assessment) {
    if (markWriteInFlight.current) return;
    if (markAssessment && markDirty && !window.confirm("Discard unsaved marks and reload the saved assessment?")) return;
    const request = ++latestMarksRequest.current;
    const isCurrent = () => mounted.current && request === latestMarksRequest.current;
    const previous = markAssessment;
    setMarkAssessment(assessment);
    setMarkLoading(true);
    setError("");
    setMessage("");
    try {
      const parents = await loadAssessments(supabase, schoolId, { assessmentId: assessment.id });
      if (!isCurrent()) return;
      const fresh = parents.find((row) => row.id === assessment.id);
      if (parents.length !== 1 || !fresh) throw new Error("The saved assessment is unavailable. Refresh school access.");
      const { students: roster, marks: baseline } = await loadAssessmentRoster(supabase, fresh, isCurrent);
      if (!isCurrent()) return;
      const scores = new Map(baseline.map((mark) => [mark.student_id, String(mark.marks_obtained)]));
      setMarkAssessment(fresh);
      setMarkRoster(roster);
      setMarkBaseline(baseline);
      setMarkValues(Object.fromEntries(roster.map((student) => [student.id, scores.get(student.id) ?? ""])));
    } catch (marksLoadError) {
      if (!isCurrent()) return;
      logError("Admin assessment marks roster load failed", marksLoadError);
      setError("The marks roster could not be loaded. Your prior draft is kept. Retry reload to reconcile saved marks.");
      setMarkAssessment(previous);
    } finally {
      if (isCurrent()) setMarkLoading(false);
    }
  }

  async function saveMarks(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!markAssessment || markLoading || markWriteInFlight.current) return;
    let changes;
    try {
      changes = markChanges(markRoster, markDraft, markBaseline, Number(markAssessment.maximum_marks));
    } catch (validationError) {
      setError(validationError instanceof Error ? validationError.message : "Review the entered marks.");
      return;
    }
    if (!changes.length) { setMessage("No changed marks to save."); return; }
    const source = markAssessment;
    const request = latestMarksRequest.current;
    markWriteInFlight.current = true;
    setMarkSaving(true);
    setError("");
    setMessage("");
    try {
      const result = await saveChangedMarks(supabase, source.id, source.updated_at, changes);
      if (!mounted.current || request !== latestMarksRequest.current) return;
      const savedByPupil = new Map(result.saved.map((mark) => [mark.student_id, mark]));
      setMarkBaseline((before) => [...before.filter((mark) => !savedByPupil.has(mark.student_id)), ...result.saved]);
      setMarks((before) => [...before.filter((mark) => mark.assessment_id !== source.id || !savedByPupil.has(mark.student_id)), ...result.saved]);
      if (result.saved.length) setMessage(`${result.saved.length} changed mark${result.saved.length === 1 ? "" : "s"} saved.`);
      if (result.failed.length) setError(`${result.failed.length} mark${result.failed.length === 1 ? " was" : "s were"} not confirmed. ${result.failed[0].message}`);
    } catch (saveError) {
      if (!mounted.current || request !== latestMarksRequest.current) return;
      logError("Admin assessment marks save failed", saveError);
      setError("Marks could not be confirmed. Your draft and loaded versions are kept. Reload saved marks before retrying.");
    } finally {
      markWriteInFlight.current = false;
      if (mounted.current) setMarkSaving(false);
    }
  }

  const visibleAssessments = assessments.filter((assessment) =>
    (yearFilter === "All" || assessment.academic_year_id === yearFilter) &&
    (examFilter === "All" || assessment.id === examFilter) &&
    (classFilter === "All" || assessment.class_id === classFilter) &&
    (sectionFilter === "All" || (assessment.section_id ?? "none") === sectionFilter) &&
    (subjectFilter === "All" || assessment.subject_id === subjectFilter) &&
    (statusFilter === "All" || assessment.status === statusFilter) &&
    (!search || `${assessment.name} ${classNames[assessment.class_id] ?? ""} ${subjectNames[assessment.subject_id] ?? ""}`.toLowerCase().includes(search.toLowerCase())),
  );
  const visibleAssessmentIds = new Set(visibleAssessments.map((assessment) => assessment.id));
  const visibleMarks = marks.filter((mark) => visibleAssessmentIds.has(mark.assessment_id));
  const resultFilterKey = JSON.stringify([search, yearFilter, examFilter, classFilter, sectionFilter, subjectFilter, statusFilter, schoolId]);
  const resultPageIndex = resultPage.key === resultFilterKey ? Math.min(resultPage.page, Math.max(0, Math.ceil(visibleMarks.length / RESULT_PAGE_SIZE) - 1)) : 0;
  const pagedMarks = visibleMarks.slice(resultPageIndex * RESULT_PAGE_SIZE, (resultPageIndex + 1) * RESULT_PAGE_SIZE);
  const resultPercentage = visibleMarks.length
    ? Math.round(visibleMarks.reduce((sum, mark) => {
        const assessment = assessmentById.get(mark.assessment_id);
        return sum + (assessment ? Number(mark.marks_obtained) / Number(assessment.maximum_marks) * 100 : 0);
      }, 0) / visibleMarks.length)
    : 0;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !form.name.trim()) return;
    const original = assessments.find((row) => row.id === editingId);
    const scopeChanged = !original || (["teacher_id", "academic_year_id", "class_id", "section_id", "subject_id"] as const)
      .some((field) => (original[field] ?? null) !== (form[field] || null));
    if (scopeChanged && !teacherMatchesAssessmentScope(assignments, form.teacher_id, form)) {
      setMessage("");
      setError("This teacher has no teaching assignment for the selected year, class, section and subject, so they could not see this assessment or request publication. Choose an assigned teacher or a matching section.");
      return;
    }
    setSaving(true);
    setError("");
    setMessage("");
    const payload = {
      ...form,
      school_id: schoolId,
      section_id: form.section_id || null,
      name: form.name.trim(),
      description: form.description?.trim() || null,
    };
    try {
      const result = editingId
        ? await supabase.from("teacher_assessments").update(payload).eq("id", editingId).eq("school_id", schoolId).select("id").maybeSingle()
        : await supabase.from("teacher_assessments").insert(payload).select("id").maybeSingle();
      if (result.error) throw result.error;
      if (!result.data) throw new Error("Assessment was not saved. Check your access and try again.");
      // A saved exam outside the shown year would vanish; follow it to its year.
      const savedYear = selectedYear.current !== "All" && selectedYear.current !== form.academic_year_id
        ? years.find((year) => year.id === form.academic_year_id) : undefined;
      if (savedYear) { selectedYear.current = savedYear.id; setExamFilter("All"); }
      setMessage(`${editingId ? "Assessment updated." : "Assessment created."}${savedYear ? ` Showing ${savedYear.name}.` : ""}`);
      setEditingId("");
      setForm(emptyForm());
      await load();
    } catch (saveError) {
      logError("Admin assessment save failed", saveError);
      setError("Assessment could not be saved. Check the selected school data and your access, then try again.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(assessment: Assessment) {
    if (!window.confirm(`Delete "${assessment.name}" and its recorded marks? This cannot be undone.`)) return;
    setError("");
    setMessage("");
    try {
      const { data, error: deleteError } = await supabase
        .from("teacher_assessments")
        .delete()
        .eq("id", assessment.id)
        .eq("school_id", schoolId)
        .select("id")
        .maybeSingle();
      if (deleteError) throw deleteError;
      if (!data) throw new Error("Assessment was not deleted.");
      setMessage("Assessment deleted.");
      if (editingId === assessment.id) {
        setEditingId("");
        setForm(emptyForm());
      }
      await load();
    } catch (deleteError) {
      logError("Admin assessment delete failed", deleteError);
      setError("Assessment could not be deleted. It may be protected by school access policies.");
    }
  }

  function chooseSchool(nextSchoolId: string) {
    if (markWriteInFlight.current || nextSchoolId === schoolId) return;
    if (markAssessment && markDirty && !window.confirm("Discard unsaved marks and switch school?")) return;
    selectedSchool.current = nextSchoolId;
    latestMarksRequest.current += 1;
    setMarkAssessment(null); setMarkRoster([]); setMarkBaseline([]); setMarkValues({});
    selectedYear.current = null;
    setEditingId(""); setForm(emptyForm()); setSearch(""); setYearFilter("All"); setExamFilter("All");
    setClassFilter("All"); setSectionFilter("All"); setSubjectFilter("All"); setStatusFilter("All");
    setMessage("");
    clearSchoolData();
    setSchoolId(nextSchoolId);
    void load();
  }

  const title = mode === "exams" ? "Exam / Marks" : "Result Report";

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-widest text-blue-600">School Administration</p>
        <h1 className="mt-1 text-3xl font-black">{title}</h1>
        <p className="mt-2 text-sm muted">
          {mode === "exams" ? "Manage school assessment schedules using the existing assessment records." : "Review recorded student marks from this school’s assessments."}
        </p>
      </header>

      {error && <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300">{error}</div>}
      {message && <div role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-700 dark:text-emerald-300">{message}</div>}

      <section className="card p-5" aria-label="Assessment school">
        <label className="block max-w-xl space-y-1.5 text-sm font-medium">School
          <select value={schoolId} disabled={loading || markSaving || schools.length <= 1} onChange={(event) => chooseSchool(event.target.value)} className="field w-full">
            <option value="">Choose school</option>{schools.map((school) => <option key={school.id} value={school.id}>{school.name}</option>)}
          </select>
        </label>
      </section>

      {schools.length > 1 && !schoolId ? <p className="card p-5 text-sm muted">Choose a school to manage assessments.</p> : <>

      {mode === "results" && <div className="grid gap-3 sm:grid-cols-3">
        <article className="card p-4"><p className="text-xs font-semibold muted">Assessments</p><p className="mt-2 text-2xl font-black">{visibleAssessments.length}</p></article>
        <article className="card p-4"><p className="text-xs font-semibold muted">Marks Recorded</p><p className="mt-2 text-2xl font-black">{visibleMarks.length}</p></article>
        <article className="card p-4"><p className="text-xs font-semibold muted">Average Percentage</p><p className="mt-2 text-2xl font-black">{resultPercentage}%</p></article>
      </div>}

      {mode === "exams" && (
        <section className="card p-5 sm:p-6">
          <div className="mb-5 flex items-center justify-between gap-3">
            <h2 className="text-lg font-bold">{editingId ? "Edit assessment" : "Create assessment"}</h2>
            <button type="button" onClick={() => void load()} className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold hover:bg-[var(--surface-2)]">
              <RefreshCw size={15} /> Refresh
            </button>
          </div>
          <form onSubmit={save} className="grid gap-4 md:grid-cols-2">
            <label className="space-y-1.5 text-sm font-medium">Exam / Test Name
              <input required maxLength={160} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className="field w-full" />
            </label>
            <label className="space-y-1.5 text-sm font-medium">Date
              <input required type="date" value={form.assessment_date} onChange={(event) => setForm({ ...form, assessment_date: event.target.value })} className="field w-full" />
            </label>
            <label className="space-y-1.5 text-sm font-medium">Academic Year
              <select required value={form.academic_year_id} onChange={(event) => setForm({ ...form, academic_year_id: event.target.value })} className="field w-full">
                <option value="">Select academic year</option>{years.map((year) => <option key={year.id} value={year.id}>{year.name}</option>)}
              </select>
            </label>
            <div className="space-y-1.5"><label className="block space-y-1.5 text-sm font-medium">Teacher
              <select required aria-describedby="assessment-teacher-scope" value={form.teacher_id} onChange={(event) => setForm({ ...form, teacher_id: event.target.value })} className="field w-full">
                <option value="">Select teacher</option>{teacherOptions.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.name}</option>)}
              </select>
            </label>
            <p id="assessment-teacher-scope" className="text-xs muted">Only teachers assigned to the chosen year, class, section and subject are listed.</p></div>
            <label className="space-y-1.5 text-sm font-medium">Class
              <select required value={form.class_id} onChange={(event) => setForm({ ...form, class_id: event.target.value, section_id: null })} className="field w-full">
                <option value="">Select class</option>{classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <label className="space-y-1.5 text-sm font-medium">Section
              <select value={form.section_id ?? ""} onChange={(event) => setForm({ ...form, section_id: event.target.value || null })} className="field w-full">
                <option value="">All sections</option>{sectionOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <label className="space-y-1.5 text-sm font-medium">Subject
              <select required value={form.subject_id} onChange={(event) => setForm({ ...form, subject_id: event.target.value })} className="field w-full">
                <option value="">Select subject</option>{subjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <label className="space-y-1.5 text-sm font-medium">Maximum Marks
              <input required type="number" min="0.01" step="0.01" value={form.maximum_marks} onChange={(event) => setForm({ ...form, maximum_marks: Number(event.target.value) })} className="field w-full" />
            </label>
            <label className="space-y-1.5 text-sm font-medium">Status
              <select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as AssessmentForm["status"] })} className="field w-full">
                <option value="scheduled">Scheduled</option><option value="completed">Completed</option>
              </select>
            </label>
            <label className="space-y-1.5 text-sm font-medium md:col-span-2">Instructions
              <textarea rows={3} value={form.description ?? ""} onChange={(event) => setForm({ ...form, description: event.target.value })} className="field w-full resize-y" />
            </label>
            <div className="flex flex-wrap gap-3 md:col-span-2">
              <button disabled={saving} className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-60">
                {editingId ? <Pencil size={16} /> : <Plus size={16} />}{saving ? "Saving…" : editingId ? "Save changes" : "Create assessment"}
              </button>
              {editingId && <button type="button" onClick={() => { setEditingId(""); setForm(emptyForm()); }} className="rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold">Cancel</button>}
            </div>
          </form>
        </section>
      )}

      <section className="card overflow-hidden">
        <div className="space-y-4 border-b border-[var(--border)] px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold">{mode === "exams" ? "Submitted Exams / Tests" : "Recorded Results"}</h2>
            {mode === "results" && <button type="button" onClick={() => {
              const rows = visibleMarks.map((mark) => {
                const assessment = assessmentById.get(mark.assessment_id);
                const student = studentNames.get(mark.student_id);
                return {
                  assessment: assessment?.name ?? "",
                  student: student?.name ?? "",
                  rollNo: student?.roll_no ?? "",
                  class: assessment ? classNames[assessment.class_id] ?? "" : "",
                  section: assessment?.section_id ? sectionNames[assessment.section_id] ?? "" : "",
                  subject: assessment ? subjectNames[assessment.subject_id] ?? "" : "",
                  marks: mark.marks_obtained,
                  maximum: assessment?.maximum_marks ?? "",
                  percentage: assessment ? (Number(mark.marks_obtained) / Number(assessment.maximum_marks) * 100).toFixed(2) : "",
                };
              });
              const link = document.createElement("a");
              link.href = URL.createObjectURL(new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" }));
              link.download = "school-results-preview.json";
              link.click();
              URL.revokeObjectURL(link.href);
            }} className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold"><Download size={15} /> Export preview</button>}
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search assessments" className="field" />
            <select aria-label="Filter by academic year" value={yearFilter} disabled={loading} onChange={(event) => { selectedYear.current = event.target.value; setYearFilter(event.target.value); setExamFilter("All"); void load(); }} className="field"><option value="All">All academic years</option>{years.map((year) => <option key={year.id} value={year.id}>{year.name}</option>)}</select>
            <select value={examFilter} onChange={(event) => setExamFilter(event.target.value)} className="field"><option value="All">All exams</option>{assessments.map((assessment) => <option key={assessment.id} value={assessment.id}>{assessment.name}</option>)}</select>
            <select value={classFilter} onChange={(event) => setClassFilter(event.target.value)} className="field"><option value="All">All classes</option>{classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
            <select value={sectionFilter} onChange={(event) => setSectionFilter(event.target.value)} className="field"><option value="All">All sections</option>{sections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
            <select value={subjectFilter} onChange={(event) => setSubjectFilter(event.target.value)} className="field"><option value="All">All subjects</option>{subjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="field"><option value="All">All statuses</option><option value="scheduled">Scheduled</option><option value="completed">Completed</option></select>
          </div>
        </div>
        {loading ? <LoadingState variant="table" className="p-5 text-sm muted">Loading school assessment records…</LoadingState> : assessments.length === 0 ? (
          <p className="p-5 text-sm muted">No assessments are available for this school.</p>
        ) : mode === "exams" ? (
          <div className="divide-y divide-[var(--border)]">
            {visibleAssessments.map((assessment) => (
              <article key={assessment.id} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <h3 className="font-bold">{assessment.name}</h3>
                  <p className="mt-1 text-sm muted">
                    {assessment.assessment_date} · {classNames[assessment.class_id] ?? "Class"} {assessment.section_id ? sectionNames[assessment.section_id] ?? "" : "· All sections"} · {subjectNames[assessment.subject_id] ?? "Subject"} · {teacherNames[assessment.teacher_id] ?? "Teacher"}
                  </p>
                  <p className="mt-1 text-xs muted">{assessment.maximum_marks} marks · {assessment.status}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button type="button" disabled={markSaving} onClick={() => void openMarks(assessment)} aria-label={`Manage marks for ${assessment.name}`} className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:bg-[var(--surface-2)]">Manage Marks</button>
                  <button type="button" onClick={async () => {
                    try {
                      const status = assessment.status === "completed" ? "scheduled" : "completed";
                      const { data, error: statusError } = await supabase.from("teacher_assessments").update({ status }).eq("id", assessment.id)
                        .eq("school_id", schoolId).select("id,status,updated_at").maybeSingle();
                      if (statusError) throw statusError;
                      if (!data) throw new Error("Assessment status was not updated.");
                      setAssessments((rows) => rows.map((row) => row.id === data.id ? { ...row, status: data.status, updated_at: data.updated_at } : row));
                    } catch (statusError) {
                      logError("Admin assessment status update failed", statusError);
                      setError("Assessment status could not be updated.");
                    }
                  }} className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:bg-[var(--surface-2)]">{assessment.status === "completed" ? "Reopen" : "Complete"}</button>
                  <button type="button" onClick={() => startEdit(assessment)} aria-label={`Edit ${assessment.name}`} className="rounded-lg border border-[var(--border)] p-2 hover:bg-[var(--surface-2)]"><Pencil size={16} /></button>
                  <button type="button" onClick={() => void remove(assessment)} aria-label={`Delete ${assessment.name}`} className="rounded-lg border border-red-300/50 p-2 text-red-600 hover:bg-red-500/10"><Trash2 size={16} /></button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-[var(--surface-2)] text-xs uppercase muted">
                <tr><th className="p-3">Assessment</th><th className="p-3">Date</th><th className="p-3">Class / Subject</th><th className="p-3">Student</th><th className="p-3">Marks</th><th className="p-3">Remarks</th></tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {pagedMarks.map((mark) => {
                  const assessment = assessmentById.get(mark.assessment_id);
                  const student = studentNames.get(mark.student_id);
                  if (!assessment || !student) return null;
                  return <tr key={mark.id}>
                    <td className="p-3 font-semibold">{assessment.name}</td>
                    <td className="p-3">{assessment.assessment_date}</td>
                    <td className="p-3">{classNames[assessment.class_id] ?? "Class"} {assessment.section_id ? sectionNames[assessment.section_id] ?? "" : ""} · {subjectNames[assessment.subject_id] ?? "Subject"}</td>
                    <td className="p-3">{student.name}<span className="block text-xs muted">{student.roll_no ? `Roll ${student.roll_no} · ` : ""}{student.admission_no}</span></td>
                    <td className="p-3">{mark.marks_obtained} / {assessment.maximum_marks} <span className="block text-xs muted">{(Number(mark.marks_obtained) / Number(assessment.maximum_marks) * 100).toFixed(1)}%</span></td>
                    <td className="p-3">{mark.remarks || "—"}</td>
                  </tr>;
                })}
                {visibleMarks.length === 0 && <tr><td className="p-5 muted" colSpan={6}>No marks have been recorded for these filters.</td></tr>}
              </tbody>
            </table>
            {visibleMarks.length > RESULT_PAGE_SIZE && <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] p-4">
              <p className="text-xs muted">{resultPageIndex * RESULT_PAGE_SIZE + 1}–{resultPageIndex * RESULT_PAGE_SIZE + pagedMarks.length} of {visibleMarks.length} marks</p>
              <div className="flex gap-2">
                <button type="button" aria-label="Previous results page" disabled={resultPageIndex === 0} onClick={() => setResultPage({ key: resultFilterKey, page: resultPageIndex - 1 })} className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold disabled:opacity-60">Previous</button>
                <button type="button" aria-label="Next results page" disabled={(resultPageIndex + 1) * RESULT_PAGE_SIZE >= visibleMarks.length} onClick={() => setResultPage({ key: resultFilterKey, page: resultPageIndex + 1 })} className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold disabled:opacity-60">Next</button>
              </div>
            </div>}
          </div>
        )}
      </section>

      {markAssessment && (
        <section className="card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
            <div>
              <h2 className="font-bold">Marks · {markAssessment.name}</h2>
              <p className="mt-1 text-sm muted">{markAssessment.maximum_marks} maximum marks · {markRoster.filter((student) => !markValues[student.id]).length} missing</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={markSaving} onClick={() => void openMarks(markAssessment)} className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold disabled:opacity-60">Reload saved marks</button>
              <button type="button" disabled={markSaving} onClick={() => {
                if (markWriteInFlight.current || (markDirty && !window.confirm("Discard unsaved marks?"))) return;
                latestMarksRequest.current += 1; setMarkAssessment(null); setMarkRoster([]); setMarkBaseline([]); setMarkValues({});
              }} className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold disabled:opacity-60">Close</button>
            </div>
          </div>
          {markLoading ? <LoadingState variant="table" className="p-5 text-sm muted">Loading enrolled students…</LoadingState> : markRoster.length === 0 ? <p className="p-5 text-sm muted">No active students are enrolled in this assessment class.</p> : (
            <form onSubmit={saveMarks}>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[600px] text-left text-sm">
                  <thead className="bg-[var(--surface-2)] text-xs uppercase muted"><tr><th className="p-3">Student</th><th className="p-3">Admission No.</th><th className="p-3">Roll No.</th><th className="p-3">Marks Obtained</th><th className="p-3">Status</th></tr></thead>
                  <tbody className="divide-y divide-[var(--border)]">{markRoster.map((student) => {
                    const entered = markValues[student.id] ?? "";
                    return <tr key={student.id}>
                      <td className="p-3 font-semibold">{studentName(student)}</td>
                      <td className="p-3">{student.admission_no}</td>
                      <td className="p-3">{student.roll_no ?? "—"}</td>
                      <td className="p-3"><input type="number" min="0" max={markAssessment.maximum_marks} step="0.01" value={entered} disabled={markSaving} onChange={(event) => setMarkValues((previous) => ({ ...previous, [student.id]: event.target.value }))} className="field w-32" aria-label={`Marks for ${studentName(student)}`} /></td>
                      <td className="p-3"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${entered ? "bg-emerald-500/10 text-emerald-700" : "bg-amber-500/10 text-amber-700"}`}>{entered ? "Recorded" : "Missing"}</span></td>
                    </tr>;
                  })}</tbody>
                </table>
              </div>
              <div className="flex justify-end border-t border-[var(--border)] p-4">
                <button disabled={markSaving || !markDirty} className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"><Save size={16} />{markSaving ? "Saving…" : "Save marks"}</button>
              </div>
            </form>
          )}
        </section>
      )}
      </>}
    </div>
  );
}
