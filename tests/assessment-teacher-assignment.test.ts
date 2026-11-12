import { describe, expect, it } from "vitest";
import { teacherMatchesAssessmentScope, type TeachingAssignmentScope } from "../lib/assessments";

const assignments: TeachingAssignmentScope[] = [
  { teacher_id: "section-teacher", academic_year_id: "year", class_id: "class", section_id: "section-a", subject_id: "maths" },
  { teacher_id: "class-teacher", academic_year_id: "year", class_id: "class", section_id: null, subject_id: "maths" },
];
const scope = { academic_year_id: "year", class_id: "class", section_id: null as string | null, subject_id: "maths" };

describe("teacher assignment scope for office-created assessments", () => {
  it("does not let a section-assigned teacher own a whole-class assessment", () => {
    expect(teacherMatchesAssessmentScope(assignments, "section-teacher", scope)).toBe(false);
    expect(teacherMatchesAssessmentScope(assignments, "class-teacher", scope)).toBe(true);
  });
  it("accepts the assigned section and a whole-class assignment for any section", () => {
    expect(teacherMatchesAssessmentScope(assignments, "section-teacher", { ...scope, section_id: "section-a" })).toBe(true);
    expect(teacherMatchesAssessmentScope(assignments, "section-teacher", { ...scope, section_id: "section-b" })).toBe(false);
    expect(teacherMatchesAssessmentScope(assignments, "class-teacher", { ...scope, section_id: "section-b" })).toBe(true);
  });
  it("rejects another year or subject and treats unchosen fields as open", () => {
    expect(teacherMatchesAssessmentScope(assignments, "class-teacher", { ...scope, subject_id: "science" })).toBe(false);
    expect(teacherMatchesAssessmentScope(assignments, "class-teacher", { ...scope, academic_year_id: "old" })).toBe(false);
    expect(teacherMatchesAssessmentScope(assignments, "section-teacher", { academic_year_id: "", class_id: "", section_id: null, subject_id: "" })).toBe(true);
    expect(teacherMatchesAssessmentScope(assignments, "nobody", { academic_year_id: "", class_id: "", section_id: null, subject_id: "" })).toBe(false);
  });
});
