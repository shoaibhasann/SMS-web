import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TeacherDirectoryWorkspace } from "../components/admin/teacher-directory-workspace";

const api = vi.hoisted(() => ({ access: vi.fn(), teachers: vi.fn(), staff: vi.fn() }));
const userId = "user-1";
const school = { id: "school-1", name: "Kids Corner" };

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }) } }),
}));
vi.mock("@/lib/attendance/repository", () => ({ loadSchoolManagementAccess: api.access }));
vi.mock("@/lib/teachers/directory", () => ({
  listTeachers: api.teachers, listNonTeachingStaff: api.staff, listTeacherInvitations: vi.fn(async () => []),
  createTeacherRecord: vi.fn(), issueTeacherInvitation: vi.fn(), revokeTeacherInvitation: vi.fn(),
}));
vi.mock("@/components/admin/staff-csv-import", () => ({ StaffCsvImport: () => null }));

describe("TeacherDirectoryWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.access.mockResolvedValue({ userId, schools: [school] });
    api.teachers.mockResolvedValue([
      { id: "t1", employee_id: "T-1", full_name: "Asha Rao", profile_id: "p1" },
      { id: "t2", employee_id: "T-2", full_name: "Ravi Kumar", profile_id: null },
    ]);
    api.staff.mockResolvedValue([]);
  });

  it("retries a failed school access check", async () => {
    api.access.mockRejectedValueOnce(new Error("School access could not be loaded."));
    render(<TeacherDirectoryWorkspace userId={userId} />);
    expect(await screen.findByRole("alert")).toHaveClass("text-danger");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Asha Rao")).toBeInTheDocument();
    expect(api.access).toHaveBeenCalledTimes(2);
  });

  it("retries a failed staff list and colours link status", async () => {
    api.staff.mockRejectedValueOnce(new Error("offline"));
    render(<TeacherDirectoryWorkspace userId={userId} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The staff directory could not be loaded.");
    expect(screen.getByText("Linked")).toHaveClass("badge", "text-success");
    expect(screen.getByText("Awaiting link")).toHaveClass("badge", "text-warning");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No non-teaching staff have been added to this school.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
