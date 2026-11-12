import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeachingAssignment } from "../lib/academic";
import { AcademicWorkspace } from "../components/academic/academic-workspace";
import { TeacherAcademicActivityWorkspace } from "../components/academic/teacher-activity-workspace";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  teacherId: vi.fn(),
  assignments: vi.fn(),
  logs: vi.fn(),
  activities: vi.fn(),
  saveLog: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { getUser: mocks.getUser, getSession: mocks.getSession, onAuthStateChange: mocks.onAuthStateChange }, from: mocks.from, rpc: mocks.rpc }),
}));
vi.mock("@/lib/academic", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/academic")>(),
  getCurrentTeacherId: mocks.teacherId,
  getCurrentTeacherAssignments: mocks.assignments,
  loadAcademicLogs: mocks.logs,
  loadAcademicActivities: mocks.activities,
  saveAcademicLog: mocks.saveLog,
}));
vi.mock("@/components/layout/app-shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const assignment: TeachingAssignment = {
  id: "assignment-a", teacher_id: "teacher-a", academic_year_id: "year-a", class_id: "class-a", section_id: "section-a",
  subject_id: "subject-a", is_class_teacher: true, class_name: "Class A", section_name: "A", subject_name: "English",
};

function rows(table: string) {
  if (table === "teachers") return { school_id: "school-a", full_name: "Priya Sharma" };
  if (table === "user_roles") return [{ role: "teacher", school_id: "school-a" }];
  if (table === "academic_years") return [{ id: "year-a", name: "2026-27", is_current: true }];
  if (table === "classes") return [{ id: "class-a", name: "Class A" }];
  if (table === "subjects") return [{ id: "subject-a", name: "English" }];
  return [];
}

beforeEach(() => {
  vi.resetAllMocks();
  // 23:30 UTC on 11 Nov is 05:00 IST on 12 Nov: the school day is the 12th.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T23:30:00Z"));
  const user = { id: "auth-teacher", email: "teacher@example.test", is_anonymous: false };
  mocks.getUser.mockResolvedValue({ data: { user }, error: null });
  mocks.getSession.mockResolvedValue({ data: { session: { user, access_token: "jwt" } }, error: null });
  mocks.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  mocks.teacherId.mockResolvedValue("teacher-a");
  mocks.assignments.mockResolvedValue([assignment]);
  mocks.logs.mockResolvedValue([]);
  mocks.activities.mockResolvedValue([]);
  mocks.rpc.mockResolvedValue({ data: [], error: null });
  mocks.from.mockImplementation((table: string) => {
    const execute = async () => {
      const data = rows(table);
      return { data, error: null, count: Array.isArray(data) ? data.length : null };
    };
    const query = {
      select: () => query, is: () => query, range: () => query, eq: () => query, in: () => query, order: () => query,
      limit: () => query, setHeader: () => query, abortSignal: () => query, gte: () => query, lte: () => query,
      single: execute, maybeSingle: execute,
      then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) => execute().then(resolve, reject),
    };
    return query;
  });
});

afterEach(() => { vi.useRealTimers(); });

describe("academic date defaults use the IST school day", () => {
  it("Daily Academic Log defaults its Date to today in IST, not the UTC day", async () => {
    render(<AcademicWorkspace module="class-logs" />);
    await screen.findByRole("textbox", { name: "Topic / Chapter *" });
    expect(screen.getByLabelText("Date")).toHaveValue("2026-11-12");
  });

  it("resets the Daily Academic Log Date to the new IST day after saving a new log past midnight", async () => {
    // 18:00 UTC on 11 Nov is 23:30 IST: the page opens on the 11th.
    vi.setSystemTime(new Date("2026-11-11T18:00:00Z"));
    mocks.saveLog.mockResolvedValue(undefined);
    render(<AcademicWorkspace module="class-logs" />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Topic / Chapter *" }), { target: { value: "The Last Lesson" } });
    fireEvent.change(screen.getByRole("textbox", { name: "What Was Taught *" }), { target: { value: "Reading" } });
    expect(screen.getByLabelText("Date")).toHaveValue("2026-11-11");
    // The page stays open past midnight IST (00:30 IST on the 12th) before the teacher saves.
    vi.setSystemTime(new Date("2026-11-11T19:00:00Z"));
    fireEvent.click(screen.getByRole("button", { name: "Save Draft" }));
    await screen.findByText("Draft saved — visible only to you.");
    expect(mocks.saveLog).toHaveBeenCalledWith(expect.objectContaining({ log_date: "2026-11-11" }));
    await waitFor(() => expect(screen.getByLabelText("Date")).toHaveValue("2026-11-12"));
  });

  it("Homework editor defaults its Date to today in IST", async () => {
    const { container } = render(<TeacherAcademicActivityWorkspace module="homework" />);
    await screen.findAllByRole("combobox", { name: "Class" });
    expect(container.querySelector('input[type="date"][required]')).toHaveValue("2026-11-12");
  });
});
