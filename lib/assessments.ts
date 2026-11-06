import type { SupabaseClient } from "@supabase/supabase-js";
import { readCompletePages } from "@/lib/complete-pages";

export type AssessmentRecord = {
  id: string; school_id: string; academic_year_id: string; class_id: string;
  section_id: string | null; subject_id: string; teacher_id: string; name: string;
  assessment_date: string; maximum_marks: number; description: string | null;
  status: "scheduled" | "completed"; updated_at: string;
};
export type AssessmentMark = {
  id: string; assessment_id: string; student_id: string; marks_obtained: number;
  remarks: string | null; updated_at: string;
};
export type AssessmentStudent = {
  id: string; admission_no: string | null; first_name: string; middle_name: string | null;
  last_name: string | null; roll_no: string | null;
};
export type MarkDraft = Record<string, { value: string; remarks: string }>;
export type AssessmentFilters = {
  academicYear?: string; classId?: string; sectionId?: string; subjectId?: string; assessmentId?: string;
};
const ASSESSMENT_COLUMNS = "id,school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,name,assessment_date,maximum_marks,description,status,updated_at";
export const MARK_COLUMNS = "id,assessment_id,student_id,marks_obtained,remarks,updated_at";
const STUDENT_COLUMNS = "id,admission_no,first_name,middle_name,last_name,roll_no";
const CHUNK_SIZE = 100;

export function loadAssessments(client: SupabaseClient, schoolId: string, filters: AssessmentFilters = {}) {
  return readCompletePages<AssessmentRecord>((from, to) => {
    let query = client.from("teacher_assessments").select(ASSESSMENT_COLUMNS, { count: "exact" }).eq("school_id", schoolId);
    for (const [column, value] of [
      ["academic_year_id", filters.academicYear], ["class_id", filters.classId],
      ["section_id", filters.sectionId], ["subject_id", filters.subjectId], ["id", filters.assessmentId],
    ]) if (value && value !== "all") query = query.eq(column!, value);
    return query.order("assessment_date", { ascending: false }).order("id").range(from, to);
  }, "Assessments could not be loaded completely");
}

export async function loadAssessmentMarks(client: SupabaseClient, assessmentIds: string[]) {
  const records: AssessmentMark[] = [];
  const ids = [...new Set(assessmentIds)];
  for (let offset = 0; offset < ids.length; offset += CHUNK_SIZE) {
    records.push(...await readCompletePages<AssessmentMark>((from, to) => client.from("teacher_assessment_marks")
      .select(MARK_COLUMNS, { count: "exact" }).in("assessment_id", ids.slice(offset, offset + CHUNK_SIZE))
      .order("id").range(from, to), "Marks could not be loaded completely"));
  }
  const requested = new Set(ids);
  const seenIds = new Set<string>();
  const seenPupils = new Set<string>();
  for (const row of records) {
    const pupilKey = JSON.stringify([row.assessment_id, row.student_id]);
    if (!requested.has(row.assessment_id) || seenIds.has(row.id) || seenPupils.has(pupilKey)) {
      throw new Error("Marks changed while loading. Refresh before calculating results.");
    }
    seenIds.add(row.id); seenPupils.add(pupilKey);
  }
  return records;
}

export async function loadAssessmentStudents(client: SupabaseClient, schoolId: string, studentIds: string[]) {
  const students: AssessmentStudent[] = [];
  const ids = [...new Set(studentIds)];
  for (let offset = 0; offset < ids.length; offset += CHUNK_SIZE) {
    students.push(...await readCompletePages<AssessmentStudent>((from, to) => client.from("students")
      .select(STUDENT_COLUMNS, { count: "exact" }).eq("school_id", schoolId)
      .in("id", ids.slice(offset, offset + CHUNK_SIZE)).order("id").range(from, to), "Student details could not be loaded completely"));
  }
  const requested = new Set(ids);
  const seen = new Set(students.map((row) => row.id));
  if (students.length !== ids.length || seen.size !== ids.length || students.some((row) => !requested.has(row.id))) {
    throw new Error("Some student details are unavailable. Refresh or contact your school; a partial result cannot be shown.");
  }
  return students;
}

export async function loadAssessmentRoster(client: SupabaseClient, assessment: Pick<AssessmentRecord, "id" | "school_id" | "academic_year_id" | "class_id" | "section_id">, isCurrent: () => boolean = () => true) {
  const enrollments = await readCompletePages<{ id: string; student_id: string }>((from, to) => {
    let query = client.from("enrollments").select("id,student_id", { count: "exact" })
      .eq("academic_year_id", assessment.academic_year_id).eq("class_id", assessment.class_id).eq("status", "active");
    if (assessment.section_id) query = query.eq("section_id", assessment.section_id);
    return query.order("id").range(from, to);
  }, "Assessment enrollment could not be loaded completely");
  if (!isCurrent()) throw new Error("The selected assessment changed while loading its roster.");
  const [students, marks] = await Promise.all([
    loadAssessmentStudents(client, assessment.school_id, enrollments.map((row) => row.student_id)),
    loadAssessmentMarks(client, [assessment.id]),
  ]);
  students.sort((a, b) => String(a.roll_no ?? "").localeCompare(String(b.roll_no ?? ""), undefined, { numeric: true }) || a.id.localeCompare(b.id));
  return { students, marks };
}

export function markDraftHasChanges(students: AssessmentStudent[], draft: MarkDraft, baseline: AssessmentMark[]) {
  const saved = new Map(baseline.map((mark) => [mark.student_id, mark]));
  return students.some((student) => {
    const entry = draft[student.id];
    const before = saved.get(student.id);
    const value = entry?.value.trim() ?? "";
    const remarks = entry?.remarks.trim() || null;
    return before ? !value || Number(value) !== Number(before.marks_obtained) || remarks !== before.remarks : Boolean(value || remarks);
  });
}

export type MarkChange = { studentId: string; before: AssessmentMark | null; score: number; remarks: string | null };
export function markChanges(students: AssessmentStudent[], draft: MarkDraft, baseline: AssessmentMark[], maximum: number): MarkChange[] {
  if (!Number.isFinite(maximum) || maximum <= 0) throw new Error("The assessment maximum is invalid. Reload before entering marks.");
  const saved = new Map(baseline.map((mark) => [mark.student_id, mark]));
  return students.flatMap((student) => {
    const before = saved.get(student.id) ?? null;
    const value = draft[student.id]?.value.trim() ?? "";
    const remarks = draft[student.id]?.remarks.trim() || null;
    const label = [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" ");
    if (!value) {
      if (before) throw new Error(`Saved marks for ${label} cannot be cleared here. Restore the score or discard your draft.`);
      if (remarks) throw new Error(`Enter a score for ${label} before adding remarks.`);
      return [];
    }
    const score = Number(value);
    if (!Number.isFinite(score) || score < 0 || score > maximum || Math.abs(score * 100 - Math.round(score * 100)) > 0.000001) {
      throw new Error(`Marks for ${label} must be between 0 and ${maximum}, with at most two decimal places.`);
    }
    if (before && Number(before.marks_obtained) === score && before.remarks === remarks) return [];
    return [{ studentId: student.id, before, score, remarks }];
  });
}

export async function saveChangedMarks(client: SupabaseClient, assessmentId: string, expectedAssessmentUpdatedAt: string, changes: MarkChange[]) {
  const saved: AssessmentMark[] = [];
  const failed: { studentId: string; message: string }[] = [];
  for (const [index, change] of changes.entries()) {
    try {
      const { data, error } = await client.rpc("save_assessment_mark", {
        p_assessment_id: assessmentId, p_expected_assessment_updated_at: expectedAssessmentUpdatedAt,
        p_student_id: change.studentId, p_mark_id: change.before?.id ?? null,
        p_expected_mark_updated_at: change.before?.updated_at ?? null,
        p_expected_marks: change.before?.marks_obtained ?? null,
        p_expected_remarks: change.before?.remarks ?? null,
        p_marks: change.score, p_remarks: change.remarks,
      });
      if (error) throw error;
      const mark = data as AssessmentMark | null;
      if (!mark || mark.assessment_id !== assessmentId || mark.student_id !== change.studentId
        || typeof mark.id !== "string" || !mark.id || typeof mark.updated_at !== "string" || !mark.updated_at
        || Number(mark.marks_obtained) !== change.score || mark.remarks !== change.remarks) {
        throw new Error("The saved row could not be confirmed. It may have changed in another session.");
      }
      saved.push(mark);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code === "PGRST202" || code === "42883") {
        for (const pending of changes.slice(index)) failed.push({ studentId: pending.studentId,
          message: "This environment is missing the assessment save update. Your draft is retained. Ask an administrator to complete the database update, then reload." });
        break;
      }
      failed.push({ studentId: change.studentId, message: code === "23505"
        ? "Another session has already entered this mark. Discard and reload before retrying."
        : "This mark was not confirmed; it may have changed or access may have been removed. Your draft is retained. Discard and reload before retrying." });
    }
  }
  return { saved, failed };
}

export function rankAssessmentMarks(assessments: AssessmentRecord[], marks: AssessmentMark[], students: AssessmentStudent[]) {
  const assessmentById = new Map(assessments.map((row) => [row.id, row]));
  const studentById = new Map(students.map((row) => [row.id, row]));
  const groups = new Map<string, AssessmentMark[]>();
  const seenIds = new Set<string>();
  const seenPupils = new Set<string>();
  for (const mark of marks) {
    const assessment = assessmentById.get(mark.assessment_id);
    const pupilKey = JSON.stringify([mark.assessment_id, mark.student_id]);
    if (!assessment || !studentById.has(mark.student_id) || !Number.isFinite(Number(mark.marks_obtained))
      || !Number.isFinite(Number(assessment.maximum_marks)) || Number(assessment.maximum_marks) <= 0
      || Number(mark.marks_obtained) < 0 || Number(mark.marks_obtained) > Number(assessment.maximum_marks)
      || seenIds.has(mark.id) || seenPupils.has(pupilKey)) {
      throw new Error("Result data is incomplete or inconsistent. Refresh or contact your school; no partial ranks are shown.");
    }
    seenIds.add(mark.id); seenPupils.add(pupilKey);
    const group = groups.get(mark.assessment_id) ?? [];
    group.push(mark);
    groups.set(mark.assessment_id, group);
  }
  const rankById = new Map<string, number>();
  for (const group of groups.values()) {
    group.sort((a, b) => Number(b.marks_obtained) - Number(a.marks_obtained) || a.id.localeCompare(b.id));
    let rank = 0;
    for (let index = 0; index < group.length; index++) {
      if (index === 0 || Number(group[index].marks_obtained) !== Number(group[index - 1].marks_obtained)) rank = index + 1;
      rankById.set(group[index].id, rank);
    }
  }
  return marks.map((mark) => {
    const assessment = assessmentById.get(mark.assessment_id)!;
    return { assessment, mark, student: studentById.get(mark.student_id)!, rank: rankById.get(mark.id)!, percentage: Number(mark.marks_obtained) / Number(assessment.maximum_marks) * 100 };
  });
}
