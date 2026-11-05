import type { SupabaseClient } from "@supabase/supabase-js";

export type HomeworkSubmission = {
  id: string;
  activity_id: string;
  student_id: string;
  text_response: string | null;
  file_path: string | null;
  file_name: string | null;
  submitted_at: string;
  status: "submitted" | "graded";
  marks: number | null;
  feedback: string | null;
  revision: number;
};

export type HomeworkRoster = {
  activity: { id: string; title: string; max_marks: number | null };
  students: {
    student_id: string;
    first_name: string;
    middle_name: string | null;
    last_name: string | null;
    admission_no: string | null;
    submission: HomeworkSubmission | null;
  }[];
};

type MutationResult = Pick<HomeworkSubmission, "id" | "revision" | "status">;
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function textOrNull(value: unknown) { return value === null || typeof value === "string"; }
function numberOrNull(value: unknown) { return value === null || (typeof value === "number" && Number.isFinite(value)); }
function isMutationResult(value: unknown): value is MutationResult {
  return record(value) && typeof value.id === "string" && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0
    && (value.status === "submitted" || value.status === "graded");
}
function isSubmission(value: unknown): value is HomeworkSubmission {
  return record(value) && typeof value.activity_id === "string" && typeof value.student_id === "string"
    && textOrNull(value.text_response) && textOrNull(value.file_path) && textOrNull(value.file_name)
    && typeof value.submitted_at === "string" && numberOrNull(value.marks) && textOrNull(value.feedback) && isMutationResult(value);
}

export async function loadMyHomeworkSubmission(client: SupabaseClient, activityId: string, studentId: string, signal?: AbortSignal) {
  const query = client.rpc("list_my_homework_submissions", { p_activity_ids: [activityId] });
  if (signal) query.abortSignal(signal);
  const { data, error } = await query.returns<unknown>();
  if (error) throw error;
  if (!Array.isArray(data) || data.length > 1 || data.some((row) => !isSubmission(row) || row.activity_id !== activityId || row.student_id !== studentId)) {
    throw new Error("Your submission could not be verified. Refresh before submitting work.");
  }
  return (data[0] as HomeworkSubmission | undefined) ?? null;
}

export async function loadHomeworkRoster(client: SupabaseClient, activityId: string, signal?: AbortSignal): Promise<HomeworkRoster> {
  const query = client.rpc("list_homework_submissions_for_grading", { p_activity_id: activityId });
  if (signal) query.abortSignal(signal);
  const { data, error } = await query.returns<unknown>();
  if (error) throw error;
  if (!record(data) || !record(data.activity) || data.activity.id !== activityId || typeof data.activity.title !== "string"
    || !numberOrNull(data.activity.max_marks) || !Array.isArray(data.students) || data.students.length > 2000
    || data.students.some((row) => !record(row) || typeof row.student_id !== "string" || typeof row.first_name !== "string"
      || !textOrNull(row.middle_name) || !textOrNull(row.last_name) || !textOrNull(row.admission_no)
      || (row.submission !== null && (!isSubmission(row.submission) || row.submission.student_id !== row.student_id || row.submission.activity_id !== activityId)))) {
    throw new Error("Homework submissions could not be verified. Refresh teaching access before grading.");
  }
  return data as HomeworkRoster;
}

export async function submitHomework(client: SupabaseClient, input: {
  activityId: string; text: string; filePath: string | null; fileName: string | null; expectedRevision: number | null; requestId: string;
}, signal?: AbortSignal) {
  const query = client.rpc("submit_homework", { p_activity_id: input.activityId, p_text_response: input.text.trim() || null,
    p_file_path: input.filePath, p_file_name: input.fileName, p_expected_revision: input.expectedRevision, p_request_id: input.requestId });
  if (signal) query.abortSignal(signal);
  const { data, error } = await query.returns<unknown>();
  if (error) throw error;
  if (!isMutationResult(data)) throw new Error("Submission was not confirmed. Refresh its status before retrying.");
  return data;
}

export async function gradeHomework(client: SupabaseClient, input: {
  submissionId: string; marks: number | null; feedback: string; expectedRevision: number; requestId: string;
}, signal?: AbortSignal) {
  const query = client.rpc("grade_homework", { p_submission_id: input.submissionId, p_marks: input.marks,
    p_feedback: input.feedback.trim() || null, p_expected_revision: input.expectedRevision, p_request_id: input.requestId });
  if (signal) query.abortSignal(signal);
  const { data, error } = await query.returns<unknown>();
  if (error) throw error;
  if (!isMutationResult(data) || data.id !== input.submissionId || data.status !== "graded") throw new Error("The grade was not confirmed. Refresh before retrying.");
  return data;
}

export function homeworkError(error: unknown, fallback: string) {
  const code = (error as { code?: string } | null)?.code;
  if (code === "42501") return "Your access to this homework changed. Refresh the page before continuing.";
  if (code === "PT409" || code === "40001") return "This submission changed in another session. Your draft is kept; refresh its status before trying again.";
  if (code === "23505") return "This request was already used for different work. Refresh the saved status before trying again.";
  if (code === "22023" || code === "23514") return "Check your response, attachment or marks, then try again.";
  return error instanceof Error ? error.message : fallback;
}
