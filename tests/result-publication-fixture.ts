import type { FamilyAssessmentResult, PublicationDetail, PublicationMetadata, PublicationPreview, PublicationPupil, PublicationSummary } from "@/lib/result-publication";
export const resultUuid = (value: number) => `32000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
export const resultToken = "a".repeat(64);
export function resultMetadata(patch: Partial<PublicationMetadata> = {}): PublicationMetadata {
  return { assessment_id: "assessment-a", school_id: "school-a", school_name: "QA School", academic_year_id: "year-a", academic_year_name: "2026–27",
    class_id: "class-a", class_name: "Class 6", section_id: "section-a", section_name: "A", subject_id: "science", subject_name: "Science",
    teacher_id: "teacher-a", teacher_name: "QA Teacher", name: "November science assessment", assessment_date: "2026-11-05", maximum_marks: 100,
    assessment_updated_at: "2026-11-05T08:00:00Z", status: "completed", ...patch };
}
export function resultPupil(patch: Partial<PublicationPupil> = {}): PublicationPupil {
  return { student_id: "child-a", student_name: "QA Anya", admission_no: "QA-1", roll_no: "1", section_id: "section-a", section_name: "A",
    enrollment_id: "enrollment-a", mark_id: "mark-a", marks_obtained: 74, remarks: "Clear reasoning", mark_updated_at: "2026-11-05T09:00:00Z", mark_updated_by: "teacher", ...patch };
}
export function resultPreview(patch: Partial<PublicationPreview> = {}): PublicationPreview {
  return { source_token: resultToken, can_submit: true, issues: [], metadata: resultMetadata(), pupils: [resultPupil(), resultPupil({ student_id: "child-b", student_name: "QA Kabir", admission_no: "QA-2", enrollment_id: "enrollment-b", mark_id: "mark-b", marks_obtained: 0 })], ...patch };
}
export function resultDetail(patch: Partial<PublicationDetail> = {}): PublicationDetail {
  return { id: resultUuid(1), assessment_id: "assessment-a", school_id: "school-a", status: "pending", source_token: resultToken,
    requested_by: "teacher", requester_name: "QA Teacher", requested_at: "2026-11-06T08:00:00Z", reviewed_by: null, reviewer_name: null,
    review_note: null, reviewed_at: null, revision: null, source_matches: true, snapshot: { metadata: resultMetadata(), pupils: resultPreview().pupils }, ...patch };
}
export function resultSummary(detail: PublicationDetail = resultDetail()): PublicationSummary {
  return { id: detail.id, assessment_id: detail.assessment_id, school_id: detail.school_id, status: detail.status,
    requested_at: detail.requested_at, requester_name: detail.requester_name, reviewed_at: detail.reviewed_at, revision: detail.revision, metadata: detail.snapshot.metadata };
}
export function familyResult(patch: Partial<FamilyAssessmentResult> = {}): FamilyAssessmentResult {
  return { id: resultUuid(1), assessment_id: "assessment-a", revision: 1, published_at: "2026-11-06T10:00:00Z", publisher_name: "QA Principal",
    metadata: resultMetadata(), student_id: "child-a", student_name: "QA Anya", admission_no: "QA-1", roll_no: "1", marks_obtained: 74,
    maximum_marks: 100, percentage: 74, remarks: "Clear reasoning", ...patch };
}
