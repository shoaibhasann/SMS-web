import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StudentHomeworkSubmission } from "../components/academic/homework-submission";
import { TeacherHomeworkGrading } from "../components/academic/homework-grading";
import type { HomeworkRoster, HomeworkSubmission } from "../lib/homework/submissions";

const mocks = vi.hoisted(() => ({ loadMine: vi.fn(), submit: vi.fn(), roster: vi.fn(), grade: vi.fn(), upload: vi.fn(), download: vi.fn(), discard: vi.fn(), auth: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { onAuthStateChange: mocks.auth } }) }));
vi.mock("@/lib/homework/submissions", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/homework/submissions")>(),
  loadMyHomeworkSubmission: mocks.loadMine, submitHomework: mocks.submit, loadHomeworkRoster: mocks.roster, gradeHomework: mocks.grade,
}));
vi.mock("@/lib/homework/files", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/homework/files")>(),
  uploadHomeworkFile: mocks.upload, downloadHomeworkFile: mocks.download, discardPendingHomeworkFile: mocks.discard,
}));

const scope = { schoolId: "school-a", academicYearId: "year-a", classId: "class-a", sectionId: "section-a", subjectId: "subject-a", activityId: "homework-a", studentId: "student-a" };
const submitted = (): HomeworkSubmission => ({ id: "submission-a", activity_id: "homework-a", student_id: "student-a", text_response: "My fraction answer", file_path: null,
  file_name: null, submitted_at: "2026-11-05T12:00:00Z", status: "submitted", marks: null, feedback: null, revision: 0 });
const roster = (): HomeworkRoster => ({ activity: { id: "homework-a", title: "Fractions", max_marks: 10 }, students: [
  { student_id: "student-a", first_name: "Asha", middle_name: null, last_name: "Student", admission_no: "1001", submission: submitted() },
  { student_id: "student-b", first_name: "Pending", middle_name: null, last_name: "Student", admission_no: "1002", submission: null },
] });
let current: HomeworkSubmission | null;
let currentRoster: HomeworkRoster;

beforeEach(() => {
  vi.resetAllMocks();
  current = null; currentRoster = roster();
  mocks.auth.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  mocks.loadMine.mockImplementation(async () => current);
  mocks.roster.mockImplementation(async () => structuredClone(currentRoster));
  mocks.submit.mockResolvedValue({ id: "submission-a", revision: 0, status: "submitted" });
  mocks.grade.mockResolvedValue({ id: "submission-a", revision: 1, status: "graded" });
  mocks.upload.mockResolvedValue({ path: "private/submission.pdf", name: "work.pdf", size: 20, mimeType: "application/pdf" });
  mocks.download.mockResolvedValue(undefined); mocks.discard.mockResolvedValue(undefined);
});

describe("student homework submission UI", () => {
  it("keeps the uploaded file and exact request identity after an unknown response and reloads the actual graded state on retry", async () => {
    const user = userEvent.setup();
    mocks.submit.mockRejectedValueOnce(new Error("Response lost"));
    render(<StudentHomeworkSubmission scope={scope} userId="auth-student" maxMarks={10} />);
    await user.click(screen.getByRole("button", { name: "My submission" }));
    await screen.findByText("Not submitted");
    await user.type(screen.getByRole("textbox", { name: "Your response" }), "My fraction answer");
    await user.upload(screen.getByLabelText("Homework attachment (optional)"), new File(["%PDF-1.4 QA"], "work.pdf", { type: "application/pdf" }));
    await user.click(screen.getByRole("button", { name: "Submit homework" }));
    await screen.findByText("Response lost");
    expect(screen.getByRole("textbox", { name: "Your response" })).toHaveValue("My fraction answer");
    expect(screen.getByText(/Uploaded and ready to submit/)).toBeInTheDocument();
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(mocks.loadMine).toHaveBeenCalledTimes(1);
    current = { ...submitted(), file_path: "private/submission.pdf", file_name: "work.pdf", status: "graded", marks: 8, feedback: "Correct method", revision: 1 };
    await user.click(screen.getByRole("button", { name: "Submit homework" }));
    await screen.findByText("Graded");
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.submit.mock.calls[0][1]).toEqual(mocks.submit.mock.calls[1][1]);
    expect(mocks.submit.mock.calls[1][1]).toMatchObject({ expectedRevision: null, filePath: "private/submission.pdf", fileName: "work.pdf" });
    expect(screen.getByText("Marks: 8 / 10")).toBeInTheDocument();
    expect(screen.getByText("Correct method")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Your response" })).toBeDisabled();
    expect(screen.queryByLabelText("Homework attachment (optional)")).not.toBeInTheDocument();
  });

  it("rejects invalid attachments inline without losing a written response", async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<StudentHomeworkSubmission scope={scope} userId="auth-student" />);
    await user.click(screen.getByRole("button", { name: "My submission" }));
    await screen.findByText("Not submitted");
    await user.type(screen.getByRole("textbox", { name: "Your response" }), "Written answer kept");
    await user.upload(screen.getByLabelText("Homework attachment (optional)"), new File(["executable"], "unsafe.exe", { type: "application/octet-stream" }));
    await screen.findByText("Choose a PDF, JPG or PNG file.");
    expect(screen.getByRole("textbox", { name: "Your response" })).toHaveValue("Written answer kept");
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("offers a fresh authenticated download and no replacement control for an attached submission", async () => {
    const user = userEvent.setup(); current = { ...submitted(), file_path: "private/submission.pdf", file_name: "work.pdf" };
    render(<StudentHomeworkSubmission scope={scope} userId="auth-student" />);
    await user.click(screen.getByRole("button", { name: "My submission" }));
    await user.click(await screen.findByRole("button", { name: "Download attachment · work.pdf" }));
    expect(mocks.download).toHaveBeenCalledWith(expect.anything(), "submission-a", "work.pdf", expect.any(AbortSignal));
    expect(screen.queryByLabelText("Homework attachment (optional)")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove selected attachment" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("does not discard an attachment after uncertain submission when the storage reference guard refuses removal", async () => {
    const user = userEvent.setup(); mocks.submit.mockRejectedValue(new Error("Response lost")); mocks.discard.mockRejectedValue(new Error("Submitted files stay protected"));
    render(<StudentHomeworkSubmission scope={scope} userId="auth-student" />);
    await user.click(screen.getByRole("button", { name: "My submission" })); await screen.findByText("Not submitted");
    await user.upload(screen.getByLabelText("Homework attachment (optional)"), new File(["%PDF-1.4 QA"], "work.pdf", { type: "application/pdf" }));
    await user.click(screen.getByRole("button", { name: "Submit homework" })); await screen.findByText("Response lost");
    await user.click(screen.getByRole("button", { name: "Remove selected attachment" })); await screen.findByText("Submitted files stay protected");
    expect(screen.getByText(/Uploaded and ready to submit/)).toBeInTheDocument();
    expect(mocks.discard).toHaveBeenCalledWith(expect.anything(), "private/submission.pdf");
    await user.click(screen.getByRole("button", { name: "Submit homework" })); await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(2));
    expect(mocks.submit.mock.calls[0][1]).toEqual(mocks.submit.mock.calls[1][1]);
  });

  it("fails closed when the current student's status cannot be verified", async () => {
    const user = userEvent.setup(); mocks.loadMine.mockRejectedValue({ code: "42501" });
    render(<StudentHomeworkSubmission scope={scope} userId="auth-student" />);
    await user.click(screen.getByRole("button", { name: "My submission" }));
    await screen.findByText("Your access to this homework changed. Refresh the page before continuing.");
    expect(screen.getByRole("textbox", { name: "Your response" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Submit homework" })).toBeDisabled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});

describe("teacher homework grading UI", () => {
  it("shows submitted and pending pupils separately and saves marks against the original revision", async () => {
    const user = userEvent.setup();
    mocks.grade.mockImplementation(async () => { currentRoster.students[0].submission = { ...submitted(), status: "graded", marks: 8, feedback: "Good method", revision: 1 }; });
    render(<TeacherHomeworkGrading activityId="homework-a" userId="auth-teacher" />);
    await user.click(screen.getByRole("button", { name: "View submissions" })); await screen.findByText("Asha Student");
    expect(screen.getByText("Pending Student")).toBeInTheDocument(); expect(screen.getAllByRole("button", { name: "Grade submission" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Grade submission" }));
    await user.type(screen.getByRole("spinbutton", { name: "Marks" }), "8"); await user.type(screen.getByRole("textbox", { name: "Feedback" }), "Good method");
    await user.click(screen.getByRole("button", { name: "Save grade" }));
    await screen.findByText("Grade saved. The latest saved result is shown below.");
    expect(mocks.grade).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ submissionId: "submission-a", marks: 8, feedback: "Good method", expectedRevision: 0, requestId: expect.any(String) }), expect.any(AbortSignal));
    expect(screen.getByText("Marks: 8 / 10")).toBeInTheDocument();
  });

  it.each(["PT409", "40001"])("keeps a stale grading draft and requires refresh before sending a new revision (%s)", async (code) => {
    const user = userEvent.setup(); mocks.grade.mockRejectedValueOnce({ code });
    render(<TeacherHomeworkGrading activityId="homework-a" userId="auth-teacher" />);
    await user.click(screen.getByRole("button", { name: "View submissions" })); await user.click(await screen.findByRole("button", { name: "Grade submission" }));
    await user.type(screen.getByRole("spinbutton", { name: "Marks" }), "7"); await user.type(screen.getByRole("textbox", { name: "Feedback" }), "Draft feedback");
    await user.click(screen.getByRole("button", { name: "Save grade" }));
    await screen.findByText(/This submission changed in another session/);
    expect(screen.getByRole("spinbutton", { name: "Marks" })).toHaveValue(7); expect(screen.getByRole("textbox", { name: "Feedback" })).toHaveValue("Draft feedback");
    expect(screen.getByRole("button", { name: "Save grade" })).toBeDisabled();
    currentRoster.students[0].submission = { ...submitted(), revision: 1 };
    await user.click(screen.getByRole("button", { name: "Refresh submissions" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save grade" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Save grade" }));
    await screen.findByText("Grade saved. The latest saved result is shown below.");
    expect(mocks.grade.mock.calls[1][1]).toMatchObject({ expectedRevision: 1, marks: 7, feedback: "Draft feedback" });
    expect(mocks.grade.mock.calls[0][1].requestId).not.toBe(mocks.grade.mock.calls[1][1].requestId);
  });

  it("allows feedback-only grading without inventing a numeric maximum", async () => {
    const user = userEvent.setup(); currentRoster.activity.max_marks = null;
    render(<TeacherHomeworkGrading activityId="homework-a" userId="auth-teacher" />);
    await user.click(screen.getByRole("button", { name: "View submissions" })); await user.click(await screen.findByRole("button", { name: "Grade submission" }));
    expect(screen.getByRole("spinbutton", { name: "Marks" })).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Feedback" }), "Revisit the second answer"); await user.click(screen.getByRole("button", { name: "Save grade" }));
    await screen.findByText("Grade saved. The latest saved result is shown below.");
    expect(mocks.grade.mock.calls[0][1]).toMatchObject({ marks: null, feedback: "Revisit the second answer" });
  });

  it("handles an empty roster and closes grading when teaching access is revoked", async () => {
    const user = userEvent.setup(); currentRoster.students = [];
    render(<TeacherHomeworkGrading activityId="homework-a" userId="auth-teacher" />);
    await user.click(screen.getByRole("button", { name: "View submissions" })); await screen.findByText("No active pupils are enrolled in this homework section.");
    mocks.roster.mockRejectedValue({ code: "42501" }); await user.click(screen.getByRole("button", { name: "Refresh submissions" }));
    await screen.findByText("Your access to this homework changed. Refresh the page before continuing.");
    expect(screen.queryByRole("button", { name: "Grade submission" })).not.toBeInTheDocument();
  });
});

it("aborts a student's private download on account switch and suppresses its late completion", async () => {
  const user = userEvent.setup(); current = { ...submitted(), file_path: "private/submission.pdf", file_name: "work.pdf" };
  let release!: () => void;
  let downloadSignal!: AbortSignal;
  let privateAction = false;
  mocks.download.mockImplementation(async (_client, _submissionId, _name, signal: AbortSignal) => {
    downloadSignal = signal;
    await new Promise<void>((resolve) => { release = resolve; });
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    privateAction = true;
  });
  render(<StudentHomeworkSubmission scope={scope} userId="auth-student" />);
  await user.click(screen.getByRole("button", { name: "My submission" }));
  await user.click(await screen.findByRole("button", { name: "Download attachment · work.pdf" }));
  expect(downloadSignal.aborted).toBe(false);
  const authChanged = mocks.auth.mock.calls.at(-1)?.[0] as (event: string, session: { user: { id: string } } | null) => void;
  await act(async () => { authChanged("SIGNED_IN", { user: { id: "another-student" } }); });
  expect(downloadSignal.aborted).toBe(true);
  await act(async () => { release(); });
  expect(privateAction).toBe(false);
  expect(screen.getByRole("alert")).toHaveTextContent("Your sign-in changed");
  expect(screen.queryByText("Aborted")).not.toBeInTheDocument();
});

it("keeps a teacher's download independent of background reads, then cancels it when the panel closes", async () => {
  const user = userEvent.setup();
  currentRoster.students[0].submission = { ...submitted(), file_path: "private/submission.pdf", file_name: "work.pdf" };
  let release!: () => void;
  let downloadSignal!: AbortSignal;
  let privateAction = false;
  mocks.download.mockImplementation(async (_client, _submissionId, _name, signal: AbortSignal) => {
    downloadSignal = signal;
    await new Promise<void>((resolve) => { release = resolve; });
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    privateAction = true;
  });
  const view = render(<TeacherHomeworkGrading activityId="homework-a" userId="auth-teacher" />);
  await user.click(screen.getByRole("button", { name: "View submissions" }));
  await user.click(await screen.findByRole("button", { name: "Download attachment · work.pdf" }));
  expect(mocks.download).toHaveBeenLastCalledWith(expect.anything(), "submission-a", "work.pdf", expect.any(AbortSignal));
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(downloadSignal.aborted).toBe(false);
  await user.click(screen.getByRole("button", { name: "Hide submissions" }));
  expect(downloadSignal.aborted).toBe(true);
  await act(async () => { release(); });
  expect(privateAction).toBe(false);
  await user.click(screen.getByRole("button", { name: "View submissions" }));
  expect(await screen.findByRole("button", { name: "Download attachment · work.pdf" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Download attachment · work.pdf" }));
  const nextSignal = downloadSignal;
  expect(nextSignal.aborted).toBe(false);
  view.unmount();
  expect(nextSignal.aborted).toBe(true);
  await act(async () => { release(); });
  expect(privateAction).toBe(false);
});

it("keeps a student response on HTTP409 conflict and refreshes its revision before a new submit intent", async () => {
  const user = userEvent.setup(); current = submitted();
  mocks.submit.mockRejectedValueOnce({ code: "PT409" }).mockImplementationOnce(async (_client, input) => {
    current = { ...submitted(), text_response: input.text, revision: 2 };
    return { id: "submission-a", revision: 2, status: "submitted" };
  });
  render(<StudentHomeworkSubmission scope={scope} userId="auth-student" />);
  await user.click(screen.getByRole("button", { name: "My submission" }));
  const response = await screen.findByRole("textbox", { name: "Your response" });
  await waitFor(() => expect(response).toBeEnabled());
  await user.clear(response); await user.type(response, "My corrected answer");
  await user.click(screen.getByRole("button", { name: "Update submission" }));
  await screen.findByText(/This submission changed in another session/);
  expect(response).toHaveValue("My corrected answer");
  expect(screen.getByRole("button", { name: "Update submission" })).toBeDisabled();
  current = { ...submitted(), text_response: "Another device's saved answer", revision: 1 };
  await user.click(screen.getByRole("button", { name: "Refresh submission status" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Update submission" })).toBeEnabled());
  expect(response).toHaveValue("My corrected answer");
  await user.click(screen.getByRole("button", { name: "Update submission" }));
  await screen.findByText("Homework submitted. Your saved status is shown below.");
  expect(mocks.submit.mock.calls[0][1]).toMatchObject({ expectedRevision: 0, text: "My corrected answer" });
  expect(mocks.submit.mock.calls[1][1]).toMatchObject({ expectedRevision: 1, text: "My corrected answer" });
  expect(mocks.submit.mock.calls[0][1].requestId).not.toBe(mocks.submit.mock.calls[1][1].requestId);
});
