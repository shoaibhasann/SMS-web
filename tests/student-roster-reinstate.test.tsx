import type { SupabaseClient } from "@supabase/supabase-js";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudentWithdrawalDialog, StudentWithdrawalHistory } from "@/components/admin/student-roster-withdrawals";

const context = { schoolId: "school-a", academicYearId: "year-a", classId: "class-a", sectionId: "section-a" };
const record = {
  enrollment_id: "enrollment-a", student_name: "Asha Singh", admission_no: "QA-101", reason: "Family relocation",
  withdrawn_by_name: "Principal", withdrawn_at: "2026-11-05T04:30:00Z",
};
const showModal = HTMLDialogElement.prototype.showModal;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
    this.close = () => { this.open = false; this.dispatchEvent(new Event("close")); };
  };
});
afterEach(() => { HTMLDialogElement.prototype.showModal = showModal; });

describe("reinstating a withdrawn pupil", () => {
  it("tells the office the withdrawal can be reversed this session", () => {
    render(<StudentWithdrawalDialog client={{ rpc: vi.fn() } as unknown as SupabaseClient} context={context}
      student={{ id: "student-a", first_name: "Asha", last_name: "Singh", admission_no: "QA-101", roll_no: "1" }}
      onClose={vi.fn()} onBusyChange={vi.fn()} onWithdrawn={vi.fn()} />);
    expect(screen.getByRole("dialog")).toHaveTextContent("A School Admin or Principal can reinstate this pupil during the current academic year.");
    expect(screen.getByRole("textbox", { name: "Withdrawal reason" })).toHaveAccessibleDescription("At least 5 characters.");
  });

  it("reinstates the same enrollment with a reason from the withdrawal history", async () => {
    const user = userEvent.setup();
    const rpc = vi.fn(async (name: string) => name === "list_roster_withdrawals"
      ? { data: [record], error: null } : { data: "enrollment-a", error: null });
    const onBusyChange = vi.fn(), onReinstated = vi.fn();
    render(<StudentWithdrawalHistory client={{ rpc } as unknown as SupabaseClient} context={context} currentAcademicYearId="year-a" revision={0}
      busy={false} onBusyChange={onBusyChange} onReinstated={onReinstated} />);
    await user.click(await screen.findByRole("button", { name: "Reinstate Asha Singh" }));
    const dialog = within(screen.getByRole("dialog", { name: "Reinstate Asha Singh?" }));
    const confirm = dialog.getByRole("button", { name: "Confirm reinstatement" });
    await user.type(dialog.getByLabelText("Reinstatement reason"), "oops");
    expect(confirm).toBeDisabled();
    expect(dialog.getByRole("textbox", { name: "Reinstatement reason" })).toHaveAccessibleDescription("At least 5 characters.");
    await user.type(dialog.getByLabelText("Reinstatement reason"), " - withdrawn by mistake");
    await user.click(confirm);
    expect(rpc).toHaveBeenCalledWith("reinstate_roster_enrollment", {
      p_school_id: "school-a", p_enrollment_id: "enrollment-a", p_reason: "oops - withdrawn by mistake",
    });
    expect(onReinstated).toHaveBeenCalledWith(record);
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
  });

  it("keeps the dialog open with a clear message when the session has moved on", async () => {
    const user = userEvent.setup();
    const rpc = vi.fn(async (name: string) => name === "list_roster_withdrawals"
      ? { data: [record], error: null } : { data: null, error: { code: "22023" } });
    const onReinstated = vi.fn();
    render(<StudentWithdrawalHistory client={{ rpc } as unknown as SupabaseClient} context={context} currentAcademicYearId="year-a" revision={0}
      busy={false} onBusyChange={vi.fn()} onReinstated={onReinstated} />);
    await user.click(await screen.findByRole("button", { name: "Reinstate Asha Singh" }));
    const dialog = within(screen.getByRole("dialog", { name: "Reinstate Asha Singh?" }));
    await user.type(dialog.getByLabelText("Reinstatement reason"), "Withdrawn by mistake");
    await user.click(dialog.getByRole("button", { name: "Confirm reinstatement" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("Only a current-year withdrawal can be reinstated");
    expect(onReinstated).not.toHaveBeenCalled();
  });

  it("disables reinstatement while another roster save is running", async () => {
    const rpc = vi.fn(async () => ({ data: [record], error: null }));
    render(<StudentWithdrawalHistory client={{ rpc } as unknown as SupabaseClient} context={context} currentAcademicYearId="year-a" revision={0}
      busy onBusyChange={vi.fn()} onReinstated={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Reinstate Asha Singh" })).toBeDisabled();
  });

  it("offers Reinstate only for the current academic year, as the server allows", async () => {
    const rpc = vi.fn(async () => ({ data: [record], error: null }));
    render(<StudentWithdrawalHistory client={{ rpc } as unknown as SupabaseClient} context={context} currentAcademicYearId="year-b"
      revision={0} busy={false} onBusyChange={vi.fn()} onReinstated={vi.fn()} />);
    expect(await screen.findByText("Family relocation")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reinstate/ })).not.toBeInTheDocument();
  });
});
