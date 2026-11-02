"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { Download, Pencil, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Assessment = {
  id: string;
  school_id: string;
  academic_year_id: string;
  class_id: string;
  section_id: string | null;
  subject_id: string;
  teacher_id: string;
  name: string;
  assessment_date: string;
  maximum_marks: number;
  description: string | null;
  status: "scheduled" | "completed";
};

type AssessmentMark = {
  id: string;
  assessment_id: string;
  student_id: string;
  marks_obtained: number;
  remarks: string | null;
};

type Option = { id: string; name: string };
type SectionOption = Option & { class_id: string };
type StudentOption = Option & { admission_no: string; roll_no: string | null };
type AssessmentForm = Omit<Assessment, "id" | "school_id" | "teacher_id"> & {
  teacher_id: string;
};

const emptyForm = (): AssessmentForm => ({
  academic_year_id: "",
  class_id: "",
  section_id: null,
  subject_id: "",
  teacher_id: "",
  name: "",
  assessment_date: new Date().toISOString().slice(0, 10),
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
  const supabase = createClient();
  const [schoolId, setSchoolId] = useState("");
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [marks, setMarks] = useState<AssessmentMark[]>([]);
  const [students, setStudents] = useState<StudentOption[]>([]);
  const [years, setYears] = useState<Option[]>([]);
  const [classes, setClasses] = useState<Option[]>([]);
  const [sections, setSections] = useState<SectionOption[]>([]);
  const [subjects, setSubjects] = useState<Option[]>([]);
  const [teachers, setTeachers] = useState<Option[]>([]);
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
  const [markAssessment, setMarkAssessment] = useState<Assessment | null>(null);
  const [markRoster, setMarkRoster] = useState<StudentOption[]>([]);
  const [markValues, setMarkValues] = useState<Record<string, string>>({});
  const [markLoading, setMarkLoading] = useState(false);
  const [markSaving, setMarkSaving] = useState(false);

  const sectionOptions = useMemo(
    () => sections.filter((section) => section.class_id === form.class_id),
    [sections, form.class_id],
  );

  async function load() {
    setLoading(true);
    setError("");
    try {
      const { data: auth, error: authError } = await supabase.auth.getUser();
      if (authError) throw authError;
      if (!auth.user) throw new Error("Please sign in again.");

      const { data: roleRows, error: roleError } = await supabase
        .from("user_roles")
        .select("role,school_id")
        .eq("user_id", auth.user.id);
      if (roleError) throw roleError;

      let resolvedSchoolId = (roleRows ?? []).find((row) =>
        row.role === "school_admin" && row.school_id,
      )?.school_id ?? "";
      if (!resolvedSchoolId && (roleRows ?? []).some((row) => row.role === "super_admin")) {
        const { data: profile, error: profileError } = await supabase
          .from("profiles")
          .select("school_id")
          .eq("id", auth.user.id)
          .maybeSingle();
        if (profileError) throw profileError;
        resolvedSchoolId = profile?.school_id ?? "";
      }
      if (!resolvedSchoolId) throw new Error("Choose a school-linked admin account to manage assessments.");
      setSchoolId(resolvedSchoolId);

      const [
        yearResult,
        classResult,
        sectionResult,
        subjectResult,
        teacherResult,
        assessmentResult,
      ] = await Promise.all([
        supabase.from("academic_years").select("id,name").eq("school_id", resolvedSchoolId).order("start_date", { ascending: false }),
        supabase.from("classes").select("id,name").eq("school_id", resolvedSchoolId).eq("is_active", true).order("sort_order"),
        supabase.from("sections").select("id,name,class_id").eq("school_id", resolvedSchoolId).order("name"),
        supabase.from("subjects").select("id,name").eq("school_id", resolvedSchoolId).eq("is_active", true).order("name"),
        supabase.from("teachers").select("id,full_name").eq("school_id", resolvedSchoolId).order("full_name"),
        supabase.from("teacher_assessments").select("id,school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,name,assessment_date,maximum_marks,description,status").eq("school_id", resolvedSchoolId).order("assessment_date", { ascending: false }),
      ]);
      const failed = [yearResult, classResult, sectionResult, subjectResult, teacherResult, assessmentResult].find((result) => result.error);
      if (failed?.error) throw failed.error;

      const yearRows = yearResult.data ?? [];
      const classRows = classResult.data ?? [];
      const sectionRows = sectionResult.data ?? [];
      const subjectRows = subjectResult.data ?? [];
      const teacherRows = teacherResult.data ?? [];
      const assessmentRows = (assessmentResult.data ?? []) as Assessment[];
      setYears(yearRows);
      setClasses(classRows);
      setSections(sectionRows);
      setSubjects(subjectRows);
      setTeachers(teacherRows.map((row) => ({ id: row.id, name: row.full_name ?? "Teacher" })));
      setClassNames(Object.fromEntries(classRows.map((row) => [row.id, row.name])));
      setSectionNames(Object.fromEntries(sectionRows.map((row) => [row.id, row.name])));
      setSubjectNames(Object.fromEntries(subjectRows.map((row) => [row.id, row.name])));
      setTeacherNames(Object.fromEntries(teacherRows.map((row) => [row.id, row.full_name ?? "Teacher"])));
      setAssessments(assessmentRows);

      const assessmentIds = assessmentRows.map((row) => row.id);
      if (!assessmentIds.length) {
        setMarks([]);
        setStudents([]);
        return;
      }
      const { data: markRows, error: marksError } = await supabase
        .from("teacher_assessment_marks")
        .select("id,assessment_id,student_id,marks_obtained,remarks")
        .in("assessment_id", assessmentIds);
      if (marksError) throw marksError;
      const loadedMarks = (markRows ?? []) as AssessmentMark[];
      setMarks(loadedMarks);
      const studentIds = [...new Set(loadedMarks.map((row) => row.student_id))];
      if (!studentIds.length) {
        setStudents([]);
        return;
      }
      const { data: studentRows, error: studentsError } = await supabase
        .from("students")
        .select("id,first_name,middle_name,last_name,admission_no,roll_no")
        .in("id", studentIds)
        .eq("school_id", resolvedSchoolId);
      if (studentsError) throw studentsError;
      setStudents((studentRows ?? []).map((student) => ({
        id: student.id,
        name: [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" "),
        admission_no: student.admission_no,
        roll_no: student.roll_no ?? null,
      })));
    } catch (loadError) {
      logError("Admin assessment data load failed", loadError);
      setError("Assessment data could not be loaded. Please refresh or contact your administrator.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

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

  async function openMarks(assessment: Assessment) {
    setMarkAssessment(assessment);
    setMarkLoading(true);
    setError("");
    try {
      let enrollmentQuery = supabase
        .from("enrollments")
        .select("student_id,roll_no")
        .eq("class_id", assessment.class_id)
        .eq("academic_year_id", assessment.academic_year_id)
        .eq("status", "active");
      if (assessment.section_id) enrollmentQuery = enrollmentQuery.eq("section_id", assessment.section_id);
      const { data: enrollments, error: enrollmentError } = await enrollmentQuery;
      if (enrollmentError) throw enrollmentError;
      const enrollmentRows = enrollments ?? [];
      const studentIds = [...new Set(enrollmentRows.map((row) => row.student_id))];
      const { data: studentRows, error: studentError } = studentIds.length
        ? await supabase.from("students").select("id,first_name,middle_name,last_name,admission_no,roll_no").eq("school_id", schoolId).in("id", studentIds)
        : { data: [], error: null };
      if (studentError) throw studentError;
      const enrollmentRolls = new Map(enrollmentRows.map((row) => [row.student_id, row.roll_no]));
      const roster = (studentRows ?? []).map((student) => ({
        id: student.id,
        name: [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" "),
        admission_no: student.admission_no,
        roll_no: enrollmentRolls.get(student.id) ?? student.roll_no ?? null,
      })).sort((a, b) => String(a.roll_no ?? "").localeCompare(String(b.roll_no ?? ""), undefined, { numeric: true }));
      const existing = new Map(marks.filter((mark) => mark.assessment_id === assessment.id).map((mark) => [mark.student_id, String(mark.marks_obtained)]));
      setMarkRoster(roster);
      setMarkValues(Object.fromEntries(roster.map((student) => [student.id, existing.get(student.id) ?? ""])));
    } catch (marksLoadError) {
      logError("Admin assessment marks roster load failed", marksLoadError);
      setError("The marks roster could not be loaded. Please try again.");
      setMarkAssessment(null);
    } finally {
      setMarkLoading(false);
    }
  }

  async function saveMarks(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!markAssessment) return;
    const rows: { assessment_id: string; student_id: string; marks_obtained: number; remarks: null }[] = [];
    for (const student of markRoster) {
      const value = markValues[student.id]?.trim();
      if (!value) continue;
      const score = Number(value);
      if (!Number.isFinite(score) || score < 0 || score > Number(markAssessment.maximum_marks)) {
        setError(`Marks for ${student.name} must be between 0 and ${markAssessment.maximum_marks}.`);
        return;
      }
      rows.push({ assessment_id: markAssessment.id, student_id: student.id, marks_obtained: score, remarks: null });
    }
    if (!rows.length) {
      setError("Enter at least one mark before saving.");
      return;
    }
    setMarkSaving(true);
    setError("");
    try {
      const { error: saveError } = await supabase
        .from("teacher_assessment_marks")
        .upsert(rows, { onConflict: "assessment_id,student_id" });
      if (saveError) throw saveError;
      setMessage("Marks saved.");
      await load();
      await openMarks(markAssessment);
    } catch (saveError) {
      logError("Admin assessment marks save failed", saveError);
      setError("Marks could not be saved. Check the marks and school access, then try again.");
    } finally {
      setMarkSaving(false);
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
  const resultPercentage = visibleMarks.length
    ? Math.round(visibleMarks.reduce((sum, mark) => {
        const assessment = assessments.find((row) => row.id === mark.assessment_id);
        return sum + (assessment ? Number(mark.marks_obtained) / Number(assessment.maximum_marks) * 100 : 0);
      }, 0) / visibleMarks.length)
    : 0;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !form.name.trim()) return;
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
      setMessage(editingId ? "Assessment updated." : "Assessment created.");
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

  const studentNames = Object.fromEntries(students.map((student) => [student.id, student]));
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
            <label className="space-y-1.5 text-sm font-medium">Teacher
              <select required value={form.teacher_id} onChange={(event) => setForm({ ...form, teacher_id: event.target.value })} className="field w-full">
                <option value="">Select teacher</option>{teachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.name}</option>)}
              </select>
            </label>
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
                const assessment = assessments.find((row) => row.id === mark.assessment_id);
                const student = students.find((item) => item.id === mark.student_id);
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
            <select value={yearFilter} onChange={(event) => setYearFilter(event.target.value)} className="field"><option value="All">All academic years</option>{years.map((year) => <option key={year.id} value={year.id}>{year.name}</option>)}</select>
            <select value={examFilter} onChange={(event) => setExamFilter(event.target.value)} className="field"><option value="All">All exams</option>{assessments.map((assessment) => <option key={assessment.id} value={assessment.id}>{assessment.name}</option>)}</select>
            <select value={classFilter} onChange={(event) => setClassFilter(event.target.value)} className="field"><option value="All">All classes</option>{classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
            <select value={sectionFilter} onChange={(event) => setSectionFilter(event.target.value)} className="field"><option value="All">All sections</option>{sections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
            <select value={subjectFilter} onChange={(event) => setSubjectFilter(event.target.value)} className="field"><option value="All">All subjects</option>{subjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="field"><option value="All">All statuses</option><option value="scheduled">Scheduled</option><option value="completed">Completed</option></select>
          </div>
        </div>
        {loading ? <p className="p-5 text-sm muted">Loading school assessment records…</p> : assessments.length === 0 ? (
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
                  <button type="button" onClick={() => void openMarks(assessment)} aria-label={`Manage marks for ${assessment.name}`} className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:bg-[var(--surface-2)]">Manage Marks</button>
                  <button type="button" onClick={async () => {
                    try {
                      const status = assessment.status === "completed" ? "scheduled" : "completed";
                      const { error: statusError } = await supabase.from("teacher_assessments").update({ status }).eq("id", assessment.id).eq("school_id", schoolId);
                      if (statusError) throw statusError;
                      await load();
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
                {visibleMarks.map((mark) => {
                  const assessment = assessments.find((row) => row.id === mark.assessment_id);
                  const student = studentNames[mark.student_id];
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
            <button type="button" onClick={() => setMarkAssessment(null)} className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold">Close</button>
          </div>
          {markLoading ? <p className="p-5 text-sm muted">Loading enrolled students…</p> : markRoster.length === 0 ? <p className="p-5 text-sm muted">No active students are enrolled in this assessment class.</p> : (
            <form onSubmit={saveMarks}>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[600px] text-left text-sm">
                  <thead className="bg-[var(--surface-2)] text-xs uppercase muted"><tr><th className="p-3">Student</th><th className="p-3">Admission No.</th><th className="p-3">Roll No.</th><th className="p-3">Marks Obtained</th><th className="p-3">Status</th></tr></thead>
                  <tbody className="divide-y divide-[var(--border)]">{markRoster.map((student) => {
                    const entered = markValues[student.id] ?? "";
                    return <tr key={student.id}>
                      <td className="p-3 font-semibold">{student.name}</td>
                      <td className="p-3">{student.admission_no}</td>
                      <td className="p-3">{student.roll_no ?? "—"}</td>
                      <td className="p-3"><input type="number" min="0" max={markAssessment.maximum_marks} step="0.01" value={entered} onChange={(event) => setMarkValues({ ...markValues, [student.id]: event.target.value })} className="field w-32" aria-label={`Marks for ${student.name}`} /></td>
                      <td className="p-3"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${entered ? "bg-emerald-500/10 text-emerald-700" : "bg-amber-500/10 text-amber-700"}`}>{entered ? "Recorded" : "Missing"}</span></td>
                    </tr>;
                  })}</tbody>
                </table>
              </div>
              <div className="flex justify-end border-t border-[var(--border)] p-4">
                <button disabled={markSaving} className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"><Save size={16} />{markSaving ? "Saving…" : "Save marks"}</button>
              </div>
            </form>
          )}
        </section>
      )}
    </div>
  );
}
