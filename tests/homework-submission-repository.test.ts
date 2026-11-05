import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gradeHomework, homeworkError, loadHomeworkRoster, loadMyHomeworkSubmission, submitHomework } from "../lib/homework/submissions";

const rpc = vi.fn();
const result = vi.fn();
const client = { rpc } as unknown as SupabaseClient;
const submission = { id: "submission-a", activity_id: "homework-a", student_id: "student-a", text_response: "My answer", file_path: null,
  file_name: null, submitted_at: "2026-11-05T12:00:00Z", status: "submitted", marks: null, feedback: null, revision: 0 };

beforeEach(() => { vi.resetAllMocks(); rpc.mockReturnValue({ abortSignal() { return this; }, returns: result }); });

describe("homework submission repository contracts", () => {
  it("reads only the requested activity and own student submission", async () => {
    result.mockResolvedValue({ data: [submission], error: null });
    expect(await loadMyHomeworkSubmission(client, "homework-a", "student-a")).toEqual(submission);
    expect(rpc).toHaveBeenCalledWith("list_my_homework_submissions", { p_activity_ids: ["homework-a"] });
    result.mockResolvedValue({ data: [{ ...submission, student_id: "student-b" }], error: null });
    await expect(loadMyHomeworkSubmission(client, "homework-a", "student-a")).rejects.toThrow("could not be verified");
    result.mockResolvedValue({ data: [], error: null });
    expect(await loadMyHomeworkSubmission(client, "homework-a", "student-a")).toBeNull();
  });

  it("rejects a teacher roster whose submission belongs to another pupil or homework", async () => {
    const roster = { activity: { id: "homework-a", title: "Fractions", max_marks: 10 }, students: [{ student_id: "student-a", first_name: "Asha",
      middle_name: null, last_name: "Student", admission_no: "1001", submission }] };
    result.mockResolvedValue({ data: roster, error: null });
    expect(await loadHomeworkRoster(client, "homework-a")).toEqual(roster);
    result.mockResolvedValue({ data: { ...roster, students: [{ ...roster.students[0], submission: { ...submission, activity_id: "private-homework" } }] }, error: null });
    await expect(loadHomeworkRoster(client, "homework-a")).rejects.toThrow("could not be verified");
  });

  it("sends expected revision and retry identity without client supplied ownership or grade fields", async () => {
    result.mockResolvedValue({ data: { id: "submission-a", revision: 1, status: "submitted" }, error: null });
    await submitHomework(client, { activityId: "homework-a", text: " Answer ", filePath: "private/path.pdf", fileName: "answer.pdf", expectedRevision: 0, requestId: "same-request" });
    expect(rpc).toHaveBeenCalledWith("submit_homework", { p_activity_id: "homework-a", p_text_response: "Answer", p_file_path: "private/path.pdf",
      p_file_name: "answer.pdf", p_expected_revision: 0, p_request_id: "same-request" });
    result.mockResolvedValue({ data: null, error: null });
    await expect(submitHomework(client, { activityId: "homework-a", text: "Answer", filePath: null, fileName: null, expectedRevision: null, requestId: "same-request" })).rejects.toThrow("not confirmed");
  });

  it("accepts a confirmed grade only for the targeted submission and propagates optimistic conflicts", async () => {
    result.mockResolvedValue({ data: { id: "wrong-submission", revision: 1, status: "graded" }, error: null });
    const input = { submissionId: "submission-a", marks: 8, feedback: "Good work", expectedRevision: 0, requestId: "grade-request" };
    await expect(gradeHomework(client, input)).rejects.toThrow("not confirmed");
    const conflict = { code: "PT409", message: "Stale revision" };
    result.mockResolvedValue({ data: null, error: conflict });
    await expect(gradeHomework(client, input)).rejects.toBe(conflict);
    expect(homeworkError(conflict, "Generic failure")).toContain("Your draft is kept");
    expect(homeworkError({ code: "40001" }, "Generic failure")).toContain("Your draft is kept");
    expect(rpc).toHaveBeenLastCalledWith("grade_homework", { p_submission_id: "submission-a", p_marks: 8, p_feedback: "Good work", p_expected_revision: 0, p_request_id: "grade-request" });
  });
});
