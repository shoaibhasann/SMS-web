// @vitest-environment node
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  loadAssessments, loadAssessmentMarks, loadAssessmentStudents, markChanges,
  markDraftHasChanges, rankAssessmentMarks, saveChangedMarks,
  type AssessmentMark, type AssessmentRecord, type AssessmentStudent,
} from "../lib/assessments";

type Row = Record<string, unknown>;
type Query = { table: string; action: "read" | "insert" | "update"; filters: [string, unknown][]; payload?: Row; from: number; to: number };
type Result = { data: unknown; error: { code?: string; message: string } | null; count?: number | null };
function client(tables: Record<string, Row[]>, cap = 1000) {
  const calls: Query[] = [];
  let timestamp = 0;
  let alter: ((query: Query, result: Result) => Result) | null = null;
  const mock = {
    rpc(name: string, args: Record<string, unknown>) {
      if (name !== "save_assessment_mark") throw new Error("Unexpected RPC");
      if (args.p_expected_assessment_updated_at !== "parent-loaded") return Promise.resolve({ data: null, error: { code: "40001", message: "Parent changed" } });
      const payload = { assessment_id: args.p_assessment_id, student_id: args.p_student_id, marks_obtained: args.p_marks, remarks: args.p_remarks };
      const request = mock.from("teacher_assessment_marks");
      if (args.p_mark_id) {
        request.update(payload).eq("id", args.p_mark_id).eq("assessment_id", args.p_assessment_id)
          .eq("student_id", args.p_student_id).eq("updated_at", args.p_expected_mark_updated_at)
          .eq("marks_obtained", args.p_expected_marks).eq("remarks", args.p_expected_remarks);
      } else request.insert(payload);
      return request.maybeSingle();
    },
    from(table: string) {
      const query: Query = { table, action: "read", filters: [], from: 0, to: Infinity };
      calls.push(query);
      const matches = (row: Row) => query.filters.every(([key, value]) => Array.isArray(value) ? value.includes(row[key]) : String(row[key]) === String(value));
      const execute = () => {
        const source = tables[table] ?? [];
        let result: Result;
        if (query.action === "read") {
          const filtered = source.filter(matches).sort((a, b) => String(a.id).localeCompare(String(b.id)));
          result = { data: filtered.slice(query.from, Math.min(query.to + 1, query.from + cap)), count: filtered.length, error: null };
        } else if (query.action === "update") {
          const row = source.find(matches);
          if (row) Object.assign(row, query.payload, { updated_at: `saved-${++timestamp}` });
          result = { data: row ? { ...row } : null, error: null };
        } else if (source.some((row) => row.assessment_id === query.payload?.assessment_id && row.student_id === query.payload?.student_id)) {
          result = { data: null, error: { code: "23505", message: "duplicate" } };
        } else {
          const row = { ...query.payload, id: `inserted-${timestamp}`, updated_at: `saved-${++timestamp}` };
          source.push(row); tables[table] = source;
          result = { data: { ...row }, error: null };
        }
        return Promise.resolve(alter ? alter(query, result) : result);
      };
      return {
        select() { return this; },
        update(payload: Row) { query.action = "update"; query.payload = payload; return this; },
        insert(payload: Row) { query.action = "insert"; query.payload = payload; return this; },
        eq(key: string, value: unknown) { query.filters.push([key, value]); return this; },
        is(key: string, value: unknown) { query.filters.push([key, value]); return this; },
        in(key: string, value: unknown[]) { query.filters.push([key, value]); return this; },
        order() { return this; },
        range(from: number, to: number) { query.from = from; query.to = to; return this; },
        maybeSingle: execute,
        then(resolve: (value: Result) => unknown, reject?: (error: unknown) => unknown) { return execute().then(resolve, reject); },
      };
    },
  };
  return { api: mock as unknown as SupabaseClient, calls, alter: (transform: typeof alter) => { alter = transform; } };
}
const pupil = (id = "pupil-a"): AssessmentStudent => ({ id, first_name: id, middle_name: null, last_name: null, admission_no: id, roll_no: "1" });
const mark = (studentId = "pupil-a", score = 12): AssessmentMark => ({ id: `mark-${studentId}`, student_id: studentId, assessment_id: "exam-a", marks_obtained: score, remarks: null, updated_at: "loaded" });
const exam = (id = "exam-a"): AssessmentRecord => ({ id, school_id: "school-a", teacher_id: "teacher-a", academic_year_id: "year-a", class_id: "class-a", section_id: "section-a", subject_id: "subject-a", name: id, maximum_marks: 20, assessment_date: "2026-11-05", description: null, status: "scheduled", updated_at: "parent-loaded" });

describe("changed-only mark saving", () => {
  it("leaves unchanged marks out of the request, including equivalent decimals", () => {
    const students = [pupil(), pupil("pupil-b")];
    const draft = { "pupil-a": { value: "12.00", remarks: "" }, "pupil-b": { value: "", remarks: "" } };
    expect(markDraftHasChanges(students, draft, [mark()])).toBe(false);
    expect(markChanges(students, draft, [mark()], 20)).toEqual([]);
  });

  it("retains another session's changed pupil when saving a different pupil", async () => {
    const baseline = [mark(), mark("pupil-b")];
    const state = { teacher_assessment_marks: [{ ...baseline[0], marks_obtained: 19, updated_at: "newer" }, { ...baseline[1] }] };
    const mock = client(state);
    const changes = markChanges([pupil(), pupil("pupil-b")], { "pupil-a": { value: "12", remarks: "" }, "pupil-b": { value: "16", remarks: "Good" } }, baseline, 20);
    const result = await saveChangedMarks(mock.api, "exam-a", "parent-loaded", changes);
    expect(mock.calls).toHaveLength(1);
    expect(result.saved).toMatchObject([{ student_id: "pupil-b", marks_obtained: 16, remarks: "Good" }]);
    expect(state.teacher_assessment_marks[0].marks_obtained).toBe(19);
  });

  it("detects an existing-row conflict and reports confirmed partial success separately", async () => {
    const baseline = [mark(), mark("pupil-b")];
    const state = { teacher_assessment_marks: [{ ...baseline[0], marks_obtained: 19, updated_at: "newer" }, { ...baseline[1] }] };
    const mock = client(state);
    const result = await saveChangedMarks(mock.api, "exam-a", "parent-loaded", markChanges([pupil(), pupil("pupil-b")], { "pupil-a": { value: "15", remarks: "" }, "pupil-b": { value: "16", remarks: "" } }, baseline, 20));
    expect(result.saved.map((row) => row.student_id)).toEqual(["pupil-b"]);
    expect(result.failed).toMatchObject([{ studentId: "pupil-a" }]);
    expect(mock.calls[0].filters).toEqual(expect.arrayContaining([["id", baseline[0].id], ["updated_at", "loaded"], ["marks_obtained", 12], ["remarks", null]]));
    expect(state.teacher_assessment_marks[0].marks_obtained).toBe(19);
  });

  it("never replaces a competing insert with an upsert", async () => {
    const state = { teacher_assessment_marks: [{ ...mark(), marks_obtained: 18 }] };
    const mock = client(state);
    const result = await saveChangedMarks(mock.api, "exam-a", "parent-loaded", markChanges([pupil()], { "pupil-a": { value: "14", remarks: "" } }, [], 20));
    expect(result.saved).toEqual([]);
    expect(result.failed[0].message).toContain("Another session");
    expect(state.teacher_assessment_marks[0].marks_obtained).toBe(18);
    expect(mock.calls[0].action).toBe("insert");
  });

  it("does not acknowledge a row when a write response is missing", async () => {
    const mock = client({ teacher_assessment_marks: [{ ...mark() }] });
    mock.alter((query, result) => query.action === "update" ? { ...result, data: null } : result);
    const result = await saveChangedMarks(mock.api, "exam-a", "parent-loaded", markChanges([pupil()], { "pupil-a": { value: "14", remarks: "" } }, [mark()], 20));
    expect(result.saved).toEqual([]);
    expect(result.failed).toHaveLength(1);
  });

  it("fails visibly when the save migration is missing and never falls back to direct writes", async () => {
    const mock = client({ teacher_assessment_marks: [{ ...mark() }] });
    const api = { ...mock.api, rpc: () => Promise.resolve({ data: null, error: { code: "PGRST202", message: "Function missing" } }) } as unknown as SupabaseClient;
    const result = await saveChangedMarks(api, "exam-a", "parent-loaded", markChanges([pupil(), pupil("pupil-b")], { "pupil-a": { value: "14", remarks: "" }, "pupil-b": { value: "15", remarks: "" } }, [mark()], 20));
    expect(result.saved).toEqual([]);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0].message).toContain("complete the database update");
    expect(mock.calls).toEqual([]);
  });

  it("rejects clearing saved marks, orphan remarks, out-of-range and overprecision input", () => {
    expect(() => markChanges([pupil()], { "pupil-a": { value: "", remarks: "" } }, [mark()], 20)).toThrow(/cannot be cleared/);
    expect(() => markChanges([pupil()], { "pupil-a": { value: "", remarks: "Comment" } }, [], 20)).toThrow(/before adding remarks/);
    for (const value of ["21", "-1", "NaN", "0.001"]) expect(() => markChanges([pupil()], { "pupil-a": { value, remarks: "" } }, [], 20)).toThrow(/between 0 and 20/);
    for (const maximum of [NaN, Infinity, 0, -1]) expect(() => markChanges([pupil()], { "pupil-a": { value: "10", remarks: "" } }, [], maximum)).toThrow(/maximum is invalid/);
    expect(markChanges([pupil()], { "pupil-a": { value: "0", remarks: " Zero " } }, [], 20)).toMatchObject([{ score: 0, remarks: "Zero" }]);
  });
});

describe("complete filtered result reads", () => {
  it("pages 1,250 marks under a lower 75-row cap before ranking all pupils", async () => {
    const assessments = Array.from({ length: 25 }, (_, index) => ({ ...exam(`exam-${String(index).padStart(3, "0")}`), maximum_marks: 100 }));
    const students = Array.from({ length: 50 }, (_, index) => pupil(`pupil-${String(index).padStart(3, "0")}`));
    const marks = assessments.flatMap((assessment) => students.map((student, index) => ({ ...mark(student.id, index), id: `${assessment.id}-${student.id}`, assessment_id: assessment.id })));
    const mock = client({ teacher_assessment_marks: marks, students }, 75);
    const loaded = await loadAssessmentMarks(mock.api, assessments.map((row) => row.id));
    const roster = await loadAssessmentStudents(mock.api, "school-a", []);
    expect(roster).toEqual([]);
    expect(loaded).toHaveLength(1250);
    const ranked = rankAssessmentMarks(assessments, loaded, students);
    expect(ranked).toHaveLength(1250);
    expect(ranked.find((row) => row.mark.id === "exam-024-pupil-049")?.rank).toBe(1);
    expect(ranked.find((row) => row.mark.id === "exam-024-pupil-000")?.rank).toBe(50);
    expect(mock.calls.filter((query) => query.table === "teacher_assessment_marks").length).toBeGreaterThan(10);
  });

  it("also pages assessment options and chunked pupil mappings under a lower server cap", async () => {
    const assessmentRows = Array.from({ length: 260 }, (_, index) => exam(`exam-${String(index).padStart(3, "0")}`));
    const studentRows = Array.from({ length: 450 }, (_, index) => ({ ...pupil(`pupil-${String(index).padStart(3, "0")}`), school_id: "school-a" }));
    const mock = client({ teacher_assessments: assessmentRows, students: studentRows }, 37);
    expect(await loadAssessments(mock.api, "school-a")).toHaveLength(260);
    expect(await loadAssessmentStudents(mock.api, "school-a", studentRows.map((row) => row.id))).toHaveLength(450);
    expect(mock.calls.some((query) => query.table === "teacher_assessments" && query.from > 0)).toBe(true);
    expect(mock.calls.filter((query) => query.table === "students").length).toBeGreaterThan(5);
  });

  it("applies school, year, class, section, subject and assessment filters before querying marks", async () => {
    const mock = client({ teacher_assessments: [exam()] });
    await loadAssessments(mock.api, "school-a", { academicYear: "year-a", classId: "class-a", sectionId: "section-a", subjectId: "subject-a", assessmentId: "exam-a" });
    expect(mock.calls[0].filters).toEqual(expect.arrayContaining([["school_id", "school-a"], ["academic_year_id", "year-a"], ["class_id", "class-a"], ["section_id", "section-a"], ["subject_id", "subject-a"], ["id", "exam-a"]]));
  });

  it("fails closed when a count cannot be confirmed or a later page disappears", async () => {
    const mock = client({ teacher_assessment_marks: Array.from({ length: 260 }, (_, index) => ({ ...mark(), id: `mark-${index}` })) }, 50);
    mock.alter((query, result) => query.from ? { ...result, data: [] } : result);
    await expect(loadAssessmentMarks(mock.api, ["exam-a"])).rejects.toThrow(/full register/);
    mock.alter((_query, result) => ({ ...result, count: null }));
    await expect(loadAssessmentMarks(mock.api, ["exam-a"])).rejects.toThrow(/completeness could not be verified/i);
  });

  it("rejects incomplete student mappings and uses competition ranks for ties", async () => {
    const mock = client({ students: [{ ...pupil(), school_id: "school-a" }] });
    await expect(loadAssessmentStudents(mock.api, "school-a", ["pupil-a", "pupil-b"])).rejects.toThrow(/student details/);
    const tied = [mark("pupil-a", 18), mark("pupil-b", 18), mark("pupil-c", 12)];
    expect(rankAssessmentMarks([exam()], tied, [pupil(), pupil("pupil-b"), pupil("pupil-c")]).map((row) => row.rank)).toEqual([1, 1, 3]);
    expect(() => rankAssessmentMarks([exam()], tied, [pupil()])).toThrow(/incomplete/);
    expect(() => rankAssessmentMarks([exam()], [tied[0], tied[0]], [pupil()])).toThrow(/incomplete/);
    expect(() => rankAssessmentMarks([exam()], [tied[0], { ...tied[0], id: "other-id" }], [pupil()])).toThrow(/incomplete/);
  });

  it("rejects one mark encountered twice when placement moves between ID chunks", async () => {
    const state = { teacher_assessment_marks: [{ ...mark(), assessment_id: "exam-000" }] };
    const mock = client(state);
    mock.alter((query, result) => {
      const ids = query.filters.find(([key]) => key === "assessment_id")?.[1] as string[];
      if (ids.length === 100) state.teacher_assessment_marks[0] = { ...state.teacher_assessment_marks[0], assessment_id: "exam-100" };
      return result;
    });
    await expect(loadAssessmentMarks(mock.api, Array.from({ length: 101 }, (_, index) => `exam-${String(index).padStart(3, "0")}`)))
      .rejects.toThrow(/changed while loading/);
  });
});
