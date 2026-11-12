import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TeachingAssignment } from "../lib/academic";
import { TeacherModuleView } from "../components/teacher/teacher-views";

const mocks = vi.hoisted(() => ({ from: vi.fn(), teacherId: vi.fn(), assignments: vi.fn(), inserts: [] as Record<string, unknown>[] }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: mocks.from, rpc: vi.fn() }) }));
vi.mock("@/lib/academic", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/academic")>(),
  getCurrentTeacherId: mocks.teacherId,
  getCurrentTeacherAssignments: mocks.assignments,
}));

const assignment: TeachingAssignment = {
  id: "assignment-a", teacher_id: "teacher-a", academic_year_id: "year-a", class_id: "class-a", section_id: "section-a",
  subject_id: "subject-a", is_class_teacher: true, class_name: "Class A", section_name: "A", subject_name: "English",
};
const rows: Record<string, unknown> = {
  teachers: { school_id: "school-a", full_name: "Priya Sharma" },
  academic_years: [{ id: "year-a", name: "2026-27", is_current: true }],
  classes: [{ id: "class-a", name: "Class A" }],
  subjects: [{ id: "subject-a", name: "English" }],
  sections: [{ id: "section-a", name: "A", class_id: "class-a" }],
  teacher_assessments: [],
};

beforeEach(() => {
  mocks.inserts = [];
  mocks.teacherId.mockResolvedValue("teacher-a");
  mocks.assignments.mockResolvedValue([assignment]);
  mocks.from.mockImplementation((table: string) => {
    let inserted = false;
    const execute = async () => inserted ? { data: { id: "exam-new" }, error: null } : { data: rows[table] ?? [], error: null, count: 0 };
    const query = {
      select: () => query, eq: () => query, in: () => query, is: () => query, order: () => query, range: () => query, limit: () => query,
      insert: (payload: Record<string, unknown>) => { inserted = true; mocks.inserts.push(payload); return query; },
      single: execute, maybeSingle: execute,
      then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) => execute().then(resolve, reject),
    };
    return query;
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T19:30:00Z")); // 01:00 IST on 12 Nov
});
afterEach(() => vi.useRealTimers());

it("defaults and resets the teacher exam date to the IST school date", async () => {
  const user = userEvent.setup();
  render(<TeacherModuleView module="exams" />);
  const date = screen.getByLabelText("Date");
  expect(date).toHaveValue("2026-11-12");

  fireEvent.change(date, { target: { value: "2026-11-20" } });
  await user.type(screen.getByLabelText("Exam / Test Name"), "Unit Test 2");
  await waitFor(() => expect(screen.getByLabelText("Academic Year")).toHaveValue("year-a"));
  await user.selectOptions(screen.getByLabelText("Class"), "class-a");
  await waitFor(() => expect(screen.getByRole("option", { name: "A" })).toBeInTheDocument());
  await user.selectOptions(screen.getByLabelText("Section"), "section-a");
  await user.selectOptions(screen.getByLabelText("Subject"), "subject-a");
  await user.type(screen.getByLabelText("Maximum Marks"), "20");
  await user.click(screen.getByRole("button", { name: "Create Exam" }));

  await screen.findByText("Assessment created.");
  expect(mocks.inserts[0]).toMatchObject({ name: "Unit Test 2", assessment_date: "2026-11-20" });
  expect(screen.getByLabelText("Date")).toHaveValue("2026-11-12");
});
