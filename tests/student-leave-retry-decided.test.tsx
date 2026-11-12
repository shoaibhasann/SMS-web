import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { StudentLeaveWorkspace } from "@/components/family/student-leave-workspace";
import { loadFamilyStudents, type FamilyStudent } from "@/lib/attendance/family";
import type { StudentLeaveRequest } from "@/lib/student-leave";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), getUser: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({
  rpc: mocks.rpc, auth: { getUser: mocks.getUser, onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }) },
}) }));
vi.mock("@/lib/attendance/family", async (original) => ({ ...await original<typeof import("../lib/attendance/family")>(), loadFamilyStudents: vi.fn() }));
vi.mock("@/lib/attendance/repository", () => ({ loadSchoolManagementAccess: vi.fn() }));

const child: FamilyStudent = { id: "20000000-0000-4000-8000-000000000020", school_id: "school-a", admission_no: "QA-01", first_name: "QA Anya", status: "active" };
const leaveId = "20000000-0000-4000-8000-000000000101";

beforeEach(() => {
  sessionStorage.clear(); mocks.rpc.mockReset();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "guardian-a" } }, error: null });
  vi.mocked(loadFamilyStudents).mockResolvedValue([child]);
});

it("shows the office decision when an unconfirmed submit is retried after the request was already rejected", async () => {
  const rows: StudentLeaveRequest[] = [];
  let loseAck = true;
  mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === "list_family_student_leave") return { data: rows.map((row) => ({ ...row, total_count: rows.length })), error: null };
    if (name === "submit_student_leave") {
      if (!rows.length) rows.push({ id: leaveId, school_id: "school-a", student_id: child.id, student_name: "QA Anya", admission_no: "QA-01",
        academic_year_id: "year-a", academic_year_name: "2026–27", class_name: "Class 4", section_name: "A",
        start_date: String(args.p_start_date), end_date: String(args.p_end_date), reason: String(args.p_reason), status: "pending",
        requester_id: "guardian-a", requester_name: "QA Guardian", created_at: "2026-11-06T10:00:00Z",
        reviewed_by: null, reviewer_name: null, review_note: null, reviewed_at: null, total_count: 1 });
      if (loseAck) { loseAck = false; return { data: null, error: { message: "Connection interrupted" } }; }
      return { data: leaveId, error: null };
    }
    if (name === "get_family_notification_leave") {
      const row = rows.find((item) => item.id === args.p_request_id && item.status !== "pending");
      return { data: row ? { ...row, total_count: 1 } : null, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  const user = userEvent.setup();
  render(<StudentLeaveWorkspace role="parent" userId="guardian-a" />);
  await screen.findByLabelText("Leave reason");
  fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-11-15" } });
  fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-11-17" } });
  fireEvent.change(screen.getByLabelText("Leave reason"), { target: { value: "Travel with family" } });
  await user.click(screen.getByRole("button", { name: "Submit leave request" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("could not be confirmed");

  Object.assign(rows[0], { status: "rejected", reviewed_by: "principal-a", reviewer_name: "QA Principal", review_note: "Exam week", reviewed_at: "2026-11-06T12:00:00Z" });
  await user.click(screen.getByRole("button", { name: "Submit leave request" }));

  const notice = await screen.findByText(/already rejected/);
  expect(notice).not.toHaveTextContent("The school will review it");
  expect(mocks.rpc).toHaveBeenCalledWith("get_family_notification_leave", { p_role: "parent", p_student_id: child.id, p_request_id: leaveId });
});
