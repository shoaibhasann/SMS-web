import type { ReactNode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ModulePage from "../app/(dashboard)/modules/[module]/page";
import { FamilyExamSchedule } from "../components/family/family-exam-schedule";
import { getVisibleModules } from "../lib/modules";

const { onAuth, loadExam, loadList, readAccess } = vi.hoisted(() => ({
  onAuth: vi.fn(), loadExam: vi.fn(), loadList: vi.fn(), readAccess: vi.fn(),
}));
const router = { replace: vi.fn() };
let query: URLSearchParams;
vi.mock("next/navigation", () => ({
  useParams: () => ({ module: "exams" }), useSearchParams: () => query, useRouter: () => router,
}));
vi.mock("@/lib/auth/access", () => ({ readActiveSchoolAccess: readAccess }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { onAuthStateChange: onAuth } }) }));
vi.mock("@/lib/notifications/family", async (original) => ({
  ...await original<typeof import("../lib/notifications/family")>(),
  loadFamilyExamSchedule: loadExam, loadFamilyExamSchedules: loadList,
}));
vi.mock("@/components/layout/app-shell", () => ({
  AppShell: ({ role, children }: { role: string; children: ReactNode }) => <main aria-label={`${role} workspace`}>{children}</main>,
}));
vi.mock("@/components/admin/admin-assessment-workspace", () => ({
  AdminAssessmentWorkspace: () => <section aria-label="Office assessment workspace" />,
}));
vi.mock("@/components/teacher/teacher-views", () => ({
  TeacherModuleView: () => <section aria-label="Teacher assessment workspace" />,
}));

const id = (suffix: number) => `10000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const actor = id(1);
const schoolId = id(2);
const exam = {
  id: id(3), name: "Fractions quiz", assessment_date: "2026-11-12", subject_name: "Mathematics",
  class_name: "Class 6", section_name: "A", description: "Bring a ruler.", maximum_marks: 100,
};
const other = { ...exam, id: id(4), name: "Geometry quiz", description: null, section_name: null };

function roleAccess(...roles: string[]) {
  readAccess.mockResolvedValue({
    userId: actor, profileSchoolId: schoolId, roles: roles.map((role) => ({ role, school_id: schoolId })),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  query = new URLSearchParams();
  onAuth.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  loadExam.mockResolvedValue(exam);
  loadList.mockResolvedValue({ rows: [exam], total_count: 1 });
  roleAccess("student");
});

describe("family exam schedule", () => {
  it("opens the upcoming Student schedule at the ordinary module path without exposing marks", async () => {
    render(<ModulePage />);
    expect(await screen.findByRole("heading", { name: exam.name })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Upcoming exams" })).toBeInTheDocument();
    expect(screen.getByText("12 November 2026")).toHaveAttribute("datetime", exam.assessment_date);
    expect(screen.getByText("Class 6 / A")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Fractions quiz/ })).toHaveAttribute("href", `/modules/exams?assessment=${exam.id}`);
    expect(screen.queryByText(/maximum|marks/i)).not.toBeInTheDocument();
    expect(loadList).toHaveBeenCalledWith(expect.anything(), { userId: actor, role: "student", offset: 0 }, expect.any(AbortSignal));
    expect(loadExam).not.toHaveBeenCalled();
    for (const role of ["parent", "student"] as const) {
      expect(getVisibleModules(role)).toContainEqual(expect.objectContaining({ key: "exams", label: "Exam schedule" }));
    }
  });

  it("paginates a mixed-role guardian schedule with scoped detail links", async () => {
    const user = userEvent.setup();
    roleAccess("teacher", "parent");
    query.set("view", "guardian");
    const rows = Array.from({ length: 30 }, (_, index) => ({ ...exam, id: id(index + 20), name: `Exam ${index + 1}` }));
    loadList.mockImplementation(async (_client, options) => ({
      rows: options.offset ? [other] : rows, total_count: 31,
    }));
    render(<ModulePage />);
    expect(await screen.findByText("Showing 1–30 of 31")).toBeInTheDocument();
    expect(screen.getByRole("main", { name: "parent workspace" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Exam 1 / })).toHaveAttribute("href", `/modules/exams?view=guardian&assessment=${rows[0].id}`);
    await user.click(screen.getByRole("button", { name: "Next exams" }));
    expect(await screen.findByText("Showing 31–31 of 31")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Geometry quiz/ })).toHaveAttribute("href", `/modules/exams?view=guardian&assessment=${other.id}`);
    expect(screen.getByRole("button", { name: "Next exams" })).toBeDisabled();
    expect(loadList).toHaveBeenLastCalledWith(expect.anything(), { userId: actor, role: "parent", offset: 30 }, expect.any(AbortSignal));
    await user.click(screen.getByRole("button", { name: "Refresh exam schedule" }));
    expect(await screen.findByText("Showing 1–30 of 31")).toBeInTheDocument();
  });

  it.each([["student", "student"], ["parent", "guardian"]] as const)("opens only the exact %s exam on mixed accounts", async (role, view) => {
    roleAccess("teacher", "student", "parent");
    if (role === "parent") query.set("view", view);
    query.set("assessment", exam.id);
    render(<ModulePage />);
    expect(await screen.findByRole("heading", { name: exam.name })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Requested exam" })).toBeInTheDocument();
    expect(screen.getByRole("main", { name: `${role} workspace` })).toBeInTheDocument();
    expect(screen.getByText(exam.description)).toBeInTheDocument();
    expect(screen.queryByText(/maximum|marks/i)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to exam schedule" })).toHaveAttribute("href", `/modules/exams?view=${view}`);
    expect(loadExam).toHaveBeenCalledWith(expect.anything(), { userId: actor, role, id: exam.id }, expect.any(AbortSignal));
    expect(loadList).not.toHaveBeenCalled();
  });

  it("preserves Student scope when following the explicit Back URL on a mixed account", async () => {
    roleAccess("school_admin", "student");
    query.set("view", "student");
    render(<ModulePage />);
    expect(await screen.findByRole("region", { name: "Upcoming exams" })).toBeInTheDocument();
    expect(screen.getByRole("main", { name: "student workspace" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Office assessment workspace" })).not.toBeInTheDocument();
  });

  it.each(["assessment=", "assessment=invalid", `assessment=${exam.id}&assessment=${other.id}`])(
    "shows an unavailable target for %s without falling back to the list",
    async (value) => {
      query = new URLSearchParams(value);
      render(<ModulePage />);
      expect(await screen.findByText("This exam is no longer available.")).toBeInTheDocument();
      expect(loadList).not.toHaveBeenCalled();
      expect(loadExam).not.toHaveBeenCalled();
    },
  );

  it.each([["teacher", "Teacher assessment workspace"], ["school_admin", "Office assessment workspace"]])(
    "preserves the normal %s exam module and denies its Student deep link",
    async (role, label) => {
      roleAccess(role);
      const mounted = render(<ModulePage />);
      expect(await screen.findByRole("region", { name: label })).toBeInTheDocument();
      query = new URLSearchParams({ assessment: exam.id });
      mounted.rerender(<ModulePage />);
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/dashboard"));
      expect(screen.queryByRole("region", { name: label })).not.toBeInTheDocument();
      expect(loadExam).not.toHaveBeenCalled();
      expect(loadList).not.toHaveBeenCalled();
    },
  );

  it("ignores a stale target and clears revoked data after refresh", async () => {
    const user = userEvent.setup();
    let resolve: (value: typeof exam) => void = () => {};
    loadExam.mockImplementationOnce(() => new Promise((done) => { resolve = done; })).mockResolvedValueOnce(other);
    const mounted = render(<FamilyExamSchedule assessmentId={exam.id} role="parent" userId={actor} />);
    const old = loadExam.mock.calls[0][2] as AbortSignal;
    mounted.rerender(<FamilyExamSchedule assessmentId={other.id} role="parent" userId={actor} />);
    expect(old.aborted).toBe(true);
    expect(await screen.findByRole("heading", { name: other.name })).toBeInTheDocument();
    await act(async () => { resolve(exam); });
    expect(screen.queryByRole("heading", { name: exam.name })).not.toBeInTheDocument();
    loadExam.mockResolvedValueOnce(null);
    await user.click(screen.getByRole("button", { name: "Refresh exam schedule" }));
    expect(await screen.findByText("This exam is no longer available.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: other.name })).not.toBeInTheDocument();
    expect(loadList).not.toHaveBeenCalled();
  });
});
