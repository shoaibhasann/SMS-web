import type { SupabaseClient } from "@supabase/supabase-js";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudentDetailsDialog } from "@/components/admin/student-roster-details";
import { admitRosterStudent, importRosterStudents } from "@/lib/students/roster";

const { bound } = vi.hoisted(() => ({ bound: vi.fn() }));
vi.mock("@/lib/auth/staff-mfa", () => ({ boundMfaSession: bound }));
const studentId = "10000000-0000-4000-8000-000000000001";
const context = { schoolId: "school-a", academicYearId: "year-a", classId: "class-a", sectionId: "section-a" };
const showModal = HTMLDialogElement.prototype.showModal;

function api(rpcResult: { data: unknown; error: { code: string; message?: string } | null }) {
  const query = { setHeader: vi.fn(), abortSignal: vi.fn(async () => rpcResult) };
  query.setHeader.mockReturnValue(query);
  const rpc = vi.fn(() => query);
  const read = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(async () => ({ data: {
    id: studentId, first_name: "Asha", middle_name: null, last_name: "Singh", dob: null, registered_mobile: null,
  }, error: null })) };
  read.select.mockReturnValue(read); read.eq.mockReturnValue(read);
  const from = vi.fn(() => read);
  return { client: { rpc, from } as unknown as SupabaseClient, rpc, from, read };
}
beforeEach(() => {
  vi.resetAllMocks();
  bound.mockResolvedValue({ access_token: "owner-token", user: { id: "owner-a" } });
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
    this.close = () => { this.open = false; this.dispatchEvent(new Event("close")); };
  };
});
afterEach(() => { HTMLDialogElement.prototype.showModal = showModal; });

describe("pupil DOB and registered mobile", () => {
  it("sends DOB and mobile with an admission and CSV import only when filled", async () => {
    const one = api({ data: studentId, error: null });
    await admitRosterStudent(one.client, context, { admissionNumber: "QA-1", firstName: "Asha", lastName: "", dateOfBirth: "2014-06-15", registeredMobile: " 9876543210 " }, { userId: "owner-a" });
    expect(one.rpc).toHaveBeenCalledWith("admit_roster_student", expect.objectContaining({ p_dob: "2014-06-15", p_registered_mobile: "9876543210" }));
    const batch = api({ data: 2, error: null });
    await importRosterStudents(batch.client, context, "request-a", [
      { admissionNumber: "QA-2", firstName: "Meera", lastName: "", dateOfBirth: "2013-01-02", registeredMobile: "9123456780" },
      { admissionNumber: "QA-3", firstName: "Ravi", lastName: "" },
    ], { userId: "owner-a" });
    expect(batch.rpc).toHaveBeenCalledWith("import_roster_students", expect.objectContaining({ p_students: [
      { admissionNumber: "QA-2", firstName: "Meera", lastName: "", dateOfBirth: "2013-01-02", registeredMobile: "9123456780" },
      { admissionNumber: "QA-3", firstName: "Ravi", lastName: "" },
    ] }));
  });

  it("shows the server's DOB or mobile message for an invalid admission", async () => {
    const one = api({ data: null, error: { code: "22023", message: "Enter a valid 10-digit mobile number." } });
    await expect(admitRosterStudent(one.client, context, { admissionNumber: "QA-1", firstName: "Asha", lastName: "", registeredMobile: "123" }, { userId: "owner-a" }))
      .rejects.toThrow("Enter a valid 10-digit mobile number.");
  });

  it("edits the pupil name, DOB and mobile through the governed RPC with the owner session", async () => {
    const user = userEvent.setup();
    const { client, rpc, read } = api({ data: studentId, error: null });
    const onSaved = vi.fn(), onBusyChange = vi.fn();
    render(<StudentDetailsDialog client={client} userId="owner-a" schoolId="school-a"
      student={{ id: studentId, first_name: "Asha", last_name: "Singh", admission_no: "QA-101", roll_no: "1" }}
      onClose={vi.fn()} onBusyChange={onBusyChange} onSaved={onSaved} />);
    const dialog = within(screen.getByRole("dialog", { name: "Edit details for Asha Singh" }));
    await waitFor(() => expect(dialog.getByLabelText("First name")).toHaveValue("Asha"));
    expect(read.eq).toHaveBeenCalledWith("school_id", "school-a");
    await user.type(dialog.getByLabelText("Middle name (optional)"), "Kumari");
    await user.type(dialog.getByLabelText("Date of birth"), "2014-06-15");
    await user.type(dialog.getByLabelText("Registered mobile"), "98765 43210");
    await user.click(dialog.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(rpc).toHaveBeenCalledWith("update_roster_student_details", {
      p_school_id: "school-a", p_student_id: studentId, p_first_name: "Asha", p_middle_name: "Kumari", p_last_name: "Singh",
      p_dob: "2014-06-15", p_registered_mobile: "98765 43210",
    });
    expect(bound).toHaveBeenCalledWith(client, "owner-a", expect.any(AbortSignal));
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("keeps the dialog open with the error when the server rejects the details", async () => {
    const user = userEvent.setup();
    const { client } = api({ data: null, error: { code: "22023", message: "Enter a valid date of birth." } });
    const onSaved = vi.fn();
    render(<StudentDetailsDialog client={client} userId="owner-a" schoolId="school-a"
      student={{ id: studentId, first_name: "Asha", last_name: "Singh", admission_no: "QA-101", roll_no: "1" }}
      onClose={vi.fn()} onBusyChange={vi.fn()} onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByLabelText("First name")).toHaveValue("Asha"));
    await user.click(screen.getByRole("button", { name: "Save details" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a valid date of birth.");
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
