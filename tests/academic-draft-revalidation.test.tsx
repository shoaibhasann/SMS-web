import type { ReactNode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcademicWorkspace } from "../components/academic/academic-workspace";
import { TeacherAcademicActivityWorkspace } from "../components/academic/teacher-activity-workspace";

// Same supabase/academic mocks as academic-history-ui.test.tsx, but the revalidation hook runs for real.
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), getUser: vi.fn(), logs: vi.fn(), activities: vi.fn(), assignments: vi.fn(), teacherId: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: mocks.from, rpc: mocks.rpc, auth: { getUser: mocks.getUser } }) }));
vi.mock("@/lib/academic", async (original) => ({ ...await original<typeof import("../lib/academic")>(),
  loadAcademicLogs: mocks.logs, loadAcademicActivities: mocks.activities, getCurrentTeacherAssignments: mocks.assignments, getCurrentTeacherId: mocks.teacherId }));
vi.mock("@/components/layout/app-shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/academic/homework-grading", () => ({ TeacherHomeworkGrading: () => null }));

const assignment = { id: "assignment-a", teacher_id: "teacher-a", academic_year_id: "year-a", class_id: "class-a", section_id: "section-a",
  subject_id: "subject-a", is_class_teacher: true, class_name: "Class 6", section_name: "A", subject_name: "Maths" };
const science = { ...assignment, id: "assignment-science", subject_id: "subject-b", subject_name: "Science", is_class_teacher: false };
const source = { id: "log-a", school_id: "school-a", academic_year_id: "year-a", class_id: "class-a", section_id: "section-a",
  subject_id: "subject-a", teacher_id: "teacher-a", log_date: "2026-11-05", topic: "Original lesson", summary: "Homework was submitted.",
  teacher_remark: null, status: "published", published_at: null, updated_at: "2026-11-05T12:00:00Z" };
const homework = { id: "homework-a", class_log_id: "log-a", activity_type: "homework", title: "Original task", description: "Homework", due_date: null, max_marks: null };

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  window.history.replaceState({}, "", "/");
  mocks.getUser.mockResolvedValue({ data: { user: { id: "teacher-login", email: "qa@example.test" } }, error: null });
  mocks.teacherId.mockResolvedValue("teacher-a");
  mocks.assignments.mockResolvedValue([assignment]);
  mocks.logs.mockResolvedValue([source]);
  mocks.activities.mockResolvedValue([homework]);
  mocks.rpc.mockImplementation(async (name: string) => ({ data: name === "save_academic_log" ? "log-a" : [{ id: "teacher-a", full_name: "Teacher A" }], error: null }));
  const data: Record<string, unknown> = {
    user_roles: [{ role: "teacher", school_id: "school-a" }], teachers: { school_id: "school-a", full_name: "Teacher A" },
    academic_years: [{ id: "year-a", name: "2026-27", is_current: true }], classes: [{ id: "class-a", name: "Class 6" }],
    sections: [{ id: "section-a", class_id: "class-a", name: "A" }], subjects: [{ id: "subject-a", name: "Maths" }, { id: "subject-b", name: "Science" }], class_logs: source,
  };
  mocks.from.mockImplementation((table: string) => {
    const execute = async () => ({ data: data[table] ?? [], error: null });
    const builder = { select() { return builder; }, order() { return builder; }, limit() { return builder; }, eq() { return builder; }, in() { return builder; },
      single: execute, maybeSingle: execute,
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) { return execute().then(resolve, reject); } };
    return builder;
  });
});

const refocus = () => act(async () => { window.dispatchEvent(new Event("focus")); });

async function homeworkDraft() {
  const user = userEvent.setup();
  render(<TeacherAcademicActivityWorkspace module="homework" />);
  await user.click(await screen.findByRole("button", { name: /Original task/ }));
  await user.click(screen.getByRole("button", { name: "Edit" }));
  const details = screen.getByRole("textbox", { name: "Homework Details" });
  await user.clear(details); await user.type(details, "Long homework draft typed by teacher");
  return () => screen.queryByRole("textbox", { name: "Homework Details" });
}

async function classLogDraft() {
  const user = userEvent.setup();
  render(<AcademicWorkspace module="class-logs" />);
  const topic = await screen.findByRole("textbox", { name: "Topic / Chapter *" });
  await user.type(topic, "Fractions draft typed by teacher");
  return () => screen.queryByRole("textbox", { name: "Topic / Chapter *" });
}

describe("homework draft during access re-checks", () => {
  it("keeps the draft and blocks saving when one re-check fails", async () => {
    const details = await homeworkDraft();
    mocks.assignments.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await refocus();
    await screen.findByText(/Teaching access could not be verified/);
    expect(details()).toHaveValue("Long homework draft typed by teacher");
    await refocus();
    await waitFor(() => expect(mocks.assignments.mock.calls.length).toBeGreaterThanOrEqual(4));
    await waitFor(() => expect(details()).toHaveValue("Long homework draft typed by teacher"));
  });

  it("keeps the draft when an unrelated assignment is added", async () => {
    const details = await homeworkDraft();
    mocks.assignments.mockResolvedValue([assignment, science]);
    await refocus();
    await screen.findByText(/re-checked/);
    await waitFor(() => expect(details()).toHaveValue("Long homework draft typed by teacher"));
  });

  it("clears the draft when its own assignment is removed", async () => {
    const details = await homeworkDraft();
    mocks.assignments.mockResolvedValue([science]);
    await refocus();
    await screen.findByText(/Your teaching assignments changed/);
    await waitFor(() => expect(details()).toHaveValue(""));
  });
});

describe("Daily Log draft during access re-checks", () => {
  it("keeps the draft when one re-check fails", async () => {
    const topic = await classLogDraft();
    mocks.assignments.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await refocus();
    await screen.findByText(/Teaching access could not be verified/);
    await refocus();
    await waitFor(() => expect(topic()).toHaveValue("Fractions draft typed by teacher"));
  });

  it("keeps the draft and its class when an unrelated assignment is added", async () => {
    const topic = await classLogDraft();
    mocks.assignments.mockResolvedValue([assignment, science]);
    await refocus();
    await screen.findByText(/re-checked/);
    await waitFor(() => expect(topic()).toHaveValue("Fractions draft typed by teacher"));
    expect(screen.getByRole("combobox", { name: "Class / Section / Subject" })).toHaveValue("assignment-a");
  });

  it("clears the draft when its own assignment is removed instead of moving it to another class", async () => {
    const topic = await classLogDraft();
    mocks.assignments.mockResolvedValue([science]);
    await refocus();
    await screen.findByText(/Your teaching assignments changed/);
    await waitFor(() => expect(topic()).toHaveValue(""));
  });
});
