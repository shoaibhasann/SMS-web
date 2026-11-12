import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TeacherAcademicActivityWorkspace } from "../components/academic/teacher-activity-workspace";

const mocks = vi.hoisted(() => ({ from: vi.fn(), getUser: vi.fn(), logs: vi.fn(), activities: vi.fn(), assignments: vi.fn(), teacherId: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: mocks.from, rpc: vi.fn(), auth: { getUser: mocks.getUser } }) }));
vi.mock("@/lib/academic", async (original) => ({ ...await original<typeof import("../lib/academic")>(),
  loadAcademicLogs: mocks.logs, loadAcademicActivities: mocks.activities, getCurrentTeacherAssignments: mocks.assignments, getCurrentTeacherId: mocks.teacherId }));
vi.mock("@/components/layout/app-shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/academic/homework-grading", () => ({ TeacherHomeworkGrading: ({ activityId }: { activityId: string }) => <p>Grading panel {activityId}</p> }));

const assignment = { id: "assignment-a", teacher_id: "teacher-b", academic_year_id: "year-a", class_id: "class-a", section_id: "section-a",
  subject_id: "subject-a", is_class_teacher: true, class_name: "Class 6", section_name: "A", subject_name: "Maths" };
const log = (id: string, teacher: string, subject = "subject-a") => ({ id, school_id: "school-a", academic_year_id: "year-a", class_id: "class-a", section_id: "section-a",
  subject_id: subject, teacher_id: teacher, log_date: "2026-10-01", topic: "Lesson", summary: null, teacher_remark: null, status: "published",
  published_at: null, updated_at: "2026-10-01T12:00:00Z" });
const homework = (id: string, logId: string, title: string) => ({ id, class_log_id: logId, activity_type: "homework", title, description: null, due_date: null, max_marks: 10 });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "teacher-b-login", email: "b@example.test" } }, error: null });
  mocks.teacherId.mockResolvedValue("teacher-b");
  mocks.assignments.mockResolvedValue([assignment]);
  // RLS may also return other logs to an office-capable teacher; only the assigned scope is listed.
  mocks.logs.mockResolvedValue([log("inherited", "teacher-a"), log("office-only", "teacher-c", "subject-z")]);
  mocks.activities.mockResolvedValue([homework("hw-inherited", "inherited", "Handover task"), homework("hw-office", "office-only", "Other subject task")]);
  const data: Record<string, unknown> = {
    teachers: { school_id: "school-a", full_name: "Teacher B" }, academic_years: [{ id: "year-a", name: "2026-27", is_current: true }],
    classes: [{ id: "class-a", name: "Class 6" }], sections: [{ id: "section-a", class_id: "class-a", name: "A" }], subjects: [{ id: "subject-a", name: "Maths" }],
  };
  mocks.from.mockImplementation((table: string) => {
    const execute = async () => ({ data: data[table] ?? [], error: null });
    const builder = { select() { return builder; }, order() { return builder; }, limit() { return builder; }, eq() { return builder; }, in() { return builder; },
      single: execute, maybeSingle: execute,
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) { return execute().then(resolve, reject); } };
    return builder;
  });
});

describe("homework after a teacher handover", () => {
  it("lists the previous teacher's published homework in the current assignment and lets the successor grade it, not edit it", async () => {
    const user = userEvent.setup();
    render(<TeacherAcademicActivityWorkspace module="homework" />);
    await user.click(await screen.findByRole("button", { name: /Handover task/ }));
    expect(screen.getByText("Grading panel hw-inherited")).toBeInTheDocument();
    expect(screen.getByText("Previously assigned teacher")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.queryByText("Other subject task")).not.toBeInTheDocument();
    expect(mocks.logs).toHaveBeenCalledWith(expect.not.objectContaining({ teacherId: expect.anything() }));
  });
});
