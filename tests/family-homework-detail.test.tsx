import type { ReactNode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ModulePage from "../app/(dashboard)/modules/[module]/page";
import { FamilyHomeworkDetail } from "../components/family/family-homework-detail";

const { onAuth, load, readAccess, renderSubmission } = vi.hoisted(() => ({
  onAuth: vi.fn(), load: vi.fn(), readAccess: vi.fn(), renderSubmission: vi.fn(),
}));
const router = { replace: vi.fn() };
let query: URLSearchParams;
vi.mock("next/navigation", () => ({
  useParams: () => ({ module: "homework" }), useSearchParams: () => query, useRouter: () => router,
}));
vi.mock("@/lib/auth/access", () => ({ readActiveSchoolAccess: readAccess }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { onAuthStateChange: onAuth } }) }));
vi.mock("@/lib/notifications/family", async (original) => ({
  ...await original<typeof import("../lib/notifications/family")>(), loadFamilyHomework: load,
}));
vi.mock("@/components/layout/app-shell", () => ({
  AppShell: ({ role, children }: { role: string; children: ReactNode }) => <main aria-label={`${role} workspace`}>{children}</main>,
}));
vi.mock("@/components/academic/academic-workspace", () => ({
  AcademicWorkspace: () => <section aria-label="All homework" />,
}));
vi.mock("@/components/academic/teacher-activity-workspace", () => ({
  TeacherAcademicActivityWorkspace: () => <section aria-label="Teacher homework workspace" />,
}));
vi.mock("@/components/academic/homework-submission", () => ({
  StudentHomeworkSubmission: (props: object) => {
    renderSubmission(props);
    return <section aria-label="My homework submission" />;
  },
}));

const id = (suffix: number) => `10000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const actor = id(1);
const schoolId = id(2);
const first = {
  id: id(3), title: "Solve the marked fractions", description: "Show every step.",
  due_date: "2026-11-10", created_at: "2026-11-09T12:00:00Z",
  school_id: schoolId, academic_year_id: id(4), class_id: id(5), section_id: id(6),
  subject_id: id(7), student_id: id(8), max_marks: 10,
};
const other = { ...first, id: id(9), title: "Different homework", description: null };

function roleAccess(...roles: string[]) {
  readAccess.mockResolvedValue({
    userId: actor, profileSchoolId: schoolId, roles: roles.map((role) => ({ role, school_id: schoolId })),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  query = new URLSearchParams();
  onAuth.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  load.mockResolvedValue(first);
  roleAccess("student");
});

describe("exact homework links", () => {
  it("opens the exact homework as Guardian on a mixed-role account without submission controls", async () => {
    roleAccess("teacher", "parent");
    load.mockResolvedValue({ ...first, student_id: null });
    query = new URLSearchParams({ view: "guardian", activity: first.id });
    render(<ModulePage />);
    expect(await screen.findByRole("heading", { name: first.title })).toBeInTheDocument();
    expect(screen.getByRole("main", { name: "parent workspace" })).toBeInTheDocument();
    expect(screen.getByText(first.description!)).toBeInTheDocument();
    expect(screen.getByText("10 November 2026")).toHaveAttribute("datetime", first.due_date);
    expect(screen.getByRole("link", { name: "Back to notifications" })).toHaveAttribute("href", "/modules/notifications?view=guardian");
    expect(screen.queryByRole("region", { name: "Teacher homework workspace" })).not.toBeInTheDocument();
    expect(renderSubmission).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledWith(expect.anything(), { id: first.id, userId: actor, role: "parent" }, expect.any(AbortSignal));
  });

  it("passes only the exact authorized homework to the existing Student submission panel", async () => {
    roleAccess("school_admin", "student");
    query.set("activity", first.id);
    render(<ModulePage />);
    expect(await screen.findByRole("region", { name: "My homework submission" })).toBeInTheDocument();
    expect(screen.getByRole("main", { name: "student workspace" })).toBeInTheDocument();
    expect(load).toHaveBeenCalledWith(expect.anything(), { id: first.id, userId: actor, role: "student" }, expect.any(AbortSignal));
    expect(renderSubmission).toHaveBeenCalledWith({
      userId: actor, maxMarks: 10, scope: {
        schoolId, academicYearId: first.academic_year_id, classId: first.class_id, sectionId: first.section_id,
        subjectId: first.subject_id, activityId: first.id, studentId: first.student_id,
      },
    });
  });

  it("keeps Student homework read-only when the exact submission scope has no section", async () => {
    load.mockResolvedValue({ ...first, section_id: null });
    render(<FamilyHomeworkDetail activityId={first.id} userId={actor} role="student" />);
    expect(await screen.findByText("Submissions are unavailable for this homework.")).toBeInTheDocument();
    expect(renderSubmission).not.toHaveBeenCalled();
  });

  it("shows unavailable for ambiguous links and leaves the ordinary homework route unchanged", async () => {
    query = new URLSearchParams(`activity=${first.id}&activity=${other.id}`);
    const mounted = render(<ModulePage />);
    expect(await screen.findByText("This homework is no longer available.")).toBeInTheDocument();
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "All homework" })).not.toBeInTheDocument();
    query = new URLSearchParams();
    mounted.rerender(<ModulePage />);
    expect(await screen.findByRole("region", { name: "All homework" })).toBeInTheDocument();
  });

  it("does not treat a Student role from another school as authority for the detail", async () => {
    readAccess.mockResolvedValue({
      userId: actor, profileSchoolId: schoolId, roles: [{ role: "student", school_id: id(10) }],
    });
    query.set("activity", first.id);
    render(<ModulePage />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/dashboard"));
    expect(screen.queryByRole("main", { name: /workspace$/ })).not.toBeInTheDocument();
    expect(load).not.toHaveBeenCalled();
  });

  it("ignores a pending result for a different target and refuses a mismatched record", async () => {
    let resolveFirst: (value: typeof first) => void = () => {};
    load.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    load.mockResolvedValueOnce(first);
    const mounted = render(<FamilyHomeworkDetail activityId={first.id} userId={actor} role="student" />);
    const oldSignal = load.mock.calls[0][2] as AbortSignal;
    mounted.rerender(<FamilyHomeworkDetail activityId={other.id} userId={actor} role="student" />);
    expect(oldSignal.aborted).toBe(true);
    expect(await screen.findByText("This homework is no longer available.")).toBeInTheDocument();
    await act(async () => { resolveFirst(first); });
    expect(screen.queryByRole("heading", { name: first.title })).not.toBeInTheDocument();
    expect(renderSubmission).not.toHaveBeenCalled();
  });

  it("refreshes a revoked detail to unavailable and hides content on sign-in changes", async () => {
    const user = userEvent.setup();
    load.mockResolvedValue({ ...first, student_id: null });
    const mounted = render(<FamilyHomeworkDetail activityId={first.id} userId={actor} role="parent" />);
    await screen.findByRole("heading", { name: first.title });
    load.mockResolvedValueOnce(null);
    await user.click(screen.getByRole("button", { name: "Refresh homework" }));
    expect(await screen.findByText("This homework is no longer available.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: first.title })).not.toBeInTheDocument();
    load.mockResolvedValueOnce({ ...other, student_id: null });
    mounted.rerender(<FamilyHomeworkDetail activityId={other.id} userId={actor} role="parent" />);
    await screen.findByRole("heading", { name: other.title });
    const currentAuthCallback = onAuth.mock.calls.at(-1)![0];
    await act(async () => currentAuthCallback("SIGNED_IN", { user: { id: id(11) } }));
    expect(screen.getByRole("alert")).toHaveTextContent("Your sign-in changed.");
    expect(screen.queryByRole("heading", { name: other.title })).not.toBeInTheDocument();
  });

  it("shows sighted refresh feedback and retries a failed load from under the error", async () => {
    const user = userEvent.setup();
    render(<FamilyHomeworkDetail activityId={first.id} userId={actor} role="parent" />);
    await screen.findByRole("heading", { name: first.title });
    let resolve: (value: typeof first) => void = () => {};
    load.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await user.click(screen.getByRole("button", { name: "Refresh homework" }));
    expect(screen.getByRole("button", { name: "Refresh homework" })).toHaveTextContent("Refreshing…");
    await act(async () => { resolve(first); });
    expect(screen.getByRole("button", { name: "Refresh homework" })).toHaveTextContent(/^Refresh$/);
    load.mockRejectedValueOnce(new Error("offline"));
    await user.click(screen.getByRole("button", { name: "Refresh homework" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Homework could not be loaded.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: first.title })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
