import type { SupabaseClient } from "@supabase/supabase-js";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StudentPlacementDialog, StudentPlacementHistory } from "@/components/admin/student-roster-placements";

const source = { schoolId: "school-one", academicYearId: "current", classId: "class-one", sectionId: "section-a" };
const currentYear = { id: "current", name: "Current session", start_date: "2000-01-01", end_date: "2090-03-31", is_current: true };
const futureYear = { id: "future", name: "Next session", start_date: "2090-04-01", end_date: "2091-03-31", is_current: false };
const overlapYear = { id: "overlap", name: "Overlapping session", start_date: "2089-04-01", end_date: "2090-04-30", is_current: false };
const previousYear = { id: "previous", name: "Previous session", start_date: "1999-01-01", end_date: "1999-12-31", is_current: false };
const student = { id: "student-one", enrollment_id: "enrollment-one", first_name: "QA", last_name: "Student", admission_no: "QA-101", roll_no: "7" };
const classes = [{ id: "class-one", name: "Class One" }, { id: "class-two", name: "Class Two" }];
const sections = [
  { id: "section-a", class_id: "class-one", name: "Section A" },
  { id: "section-b", class_id: "class-one", name: "Section B" },
  { id: "section-c", class_id: "class-two", name: "Section C" },
];
const reason = "Updated classroom allocation.";
const expectedSource = {
  p_school_id: "school-one", p_source_enrollment_id: "enrollment-one", p_expected_class_id: "class-one",
  p_expected_section_id: "section-a", p_reason: reason, p_request_id: expect.any(String),
};

function renderDialog(rpc: ReturnType<typeof vi.fn>) {
  const client = { rpc } as unknown as SupabaseClient;
  const onPlaced = vi.fn();
  const onClose = vi.fn();
  const onBusyChange = vi.fn();
  const showModal = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
    this.close = () => {
      this.open = false;
      this.dispatchEvent(new Event("close"));
    };
  };
  try {
    render(<StudentPlacementDialog client={client} source={source} currentYear={currentYear}
      years={[currentYear, futureYear, overlapYear, previousYear]} student={student} classes={classes} sections={sections}
      onClose={onClose} onBusyChange={onBusyChange} onPlaced={onPlaced} />);
    return { dialog: within(screen.getByRole("dialog", { name: "Change placement for QA Student" })), onPlaced, onBusyChange };
  } finally {
    HTMLDialogElement.prototype.showModal = showModal;
  }
}

describe("student placement workspace", () => {
  it("previews a same-class section move and confirms the exact enrollment and destination", async () => {
    const user = userEvent.setup();
    const rpc = vi.fn().mockResolvedValue({ data: "enrollment-one", error: null });
    const { dialog, onPlaced, onBusyChange } = renderDialog(rpc);

    expect(dialog.getByText("Current session · Class One · Section A")).toBeInTheDocument();
    await user.selectOptions(dialog.getByLabelText("Destination class"), "class-one");
    expect(dialog.queryByRole("option", { name: "Section A" })).not.toBeInTheDocument();
    await user.selectOptions(dialog.getByLabelText("Destination section"), "section-b");
    expect(dialog.getByText("Current session · Class One · Section B")).toBeInTheDocument();
    expect(dialog.getByText(/destination roll number will be unassigned/i)).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Confirm move" })).toBeDisabled();
    await user.type(dialog.getByLabelText("Reason for placement change"), reason);
    await user.click(dialog.getByRole("button", { name: "Confirm move" }));

    expect(rpc).toHaveBeenCalledExactlyOnceWith("change_roster_placement", {
      ...expectedSource, p_destination_academic_year_id: "current", p_destination_class_id: "class-one", p_destination_section_id: "section-b",
    });
    expect(onPlaced).toHaveBeenCalledWith("move");
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
  });

  it("offers only a nonoverlapping later year, stages promotion, and reuses a retry ID after a dropped response", async () => {
    const user = userEvent.setup();
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: "", message: "Connection lost" } })
      .mockResolvedValueOnce({ data: "future-enrollment", error: null });
    const { dialog, onPlaced } = renderDialog(rpc);

    const years = dialog.getByLabelText("Destination academic year");
    expect(within(years).getAllByRole("option").map((entry) => entry.textContent)).toEqual([
      "Current session (current year)", "Next session (promotion)",
    ]);
    await user.selectOptions(years, "future");
    await user.selectOptions(dialog.getByLabelText("Destination class"), "class-two");
    await user.selectOptions(dialog.getByLabelText("Destination section"), "section-c");
    expect(dialog.getByText("Next session · Class Two · Section C")).toBeInTheDocument();
    expect(dialog.getByText(/after the new academic year is activated/)).toBeInTheDocument();
    expect(dialog.getByText(/choose a different class or section in the same destination year/i)).toBeInTheDocument();
    await user.type(dialog.getByLabelText("Reason for placement change"), reason);
    await user.click(dialog.getByRole("button", { name: "Confirm staged promotion" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent(/retry with the same destination and reason/i);
    expect(onPlaced).not.toHaveBeenCalled();
    await user.click(dialog.getByRole("button", { name: "Confirm staged promotion" }));
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
    expect(rpc).toHaveBeenCalledWith("change_roster_placement", {
      ...expectedSource, p_destination_academic_year_id: "future", p_destination_class_id: "class-two", p_destination_section_id: "section-c",
    });
    expect(onPlaced).toHaveBeenCalledWith("promotion");
  });

  it("explains how to revise a staged promotion after a duplicate destination is rejected", async () => {
    const user = userEvent.setup();
    const rpc = vi.fn().mockResolvedValue({
      data: null, error: { code: "23505", message: "This pupil already has this staged placement." },
    });
    const { dialog, onPlaced } = renderDialog(rpc);
    await user.selectOptions(dialog.getByLabelText("Destination academic year"), "future");
    await user.selectOptions(dialog.getByLabelText("Destination class"), "class-two");
    await user.selectOptions(dialog.getByLabelText("Destination section"), "section-c");
    await user.type(dialog.getByLabelText("Reason for placement change"), reason);
    await user.click(dialog.getByRole("button", { name: "Confirm staged promotion" }));

    expect(await dialog.findByRole("alert")).toHaveTextContent(/already staged.*choose a different class or section/i);
    expect(onPlaced).not.toHaveBeenCalled();
  });

  it("keeps the move open and explains when attendance blocks it", async () => {
    const user = userEvent.setup();
    const rpc = vi.fn().mockResolvedValue({
      data: null, error: { code: "55000", message: "Attendance already exists for today or later." },
    });
    const { dialog, onPlaced } = renderDialog(rpc);
    await user.selectOptions(dialog.getByLabelText("Destination class"), "class-one");
    await user.selectOptions(dialog.getByLabelText("Destination section"), "section-b");
    await user.type(dialog.getByLabelText("Reason for placement change"), reason);
    await user.click(dialog.getByRole("button", { name: "Confirm move" }));

    expect(await dialog.findByRole("alert")).toHaveTextContent(/before attendance is marked/i);
    expect(dialog.getByLabelText("Reason for placement change")).toHaveValue(reason);
    expect(onPlaced).not.toHaveBeenCalled();
  });

  it("loads audit history for a prior source year in the selected section", async () => {
    const user = userEvent.setup();
    const rpc = vi.fn().mockResolvedValueOnce({ data: [], error: null }).mockResolvedValueOnce({
      data: [{
        request_id: "placement-event", student_name: "QA Student", admission_no: "QA-101", change_kind: "promotion",
        destination_year_name: "Current session", destination_class_name: "Class Two", destination_section_name: "Section C",
        effective_date: "2000-01-01", reason, changed_by_name: "QA Principal", changed_at: "1999-12-30T12:00:00Z",
      }],
      error: null,
    });
    render(<StudentPlacementHistory client={{ rpc } as unknown as SupabaseClient} context={source}
      years={[currentYear, previousYear]} revision={0} />);

    expect(rpc).not.toHaveBeenCalled();
    const details = screen.getByText("Placement history").parentElement!;
    details.setAttribute("open", "");
    fireEvent(details, new Event("toggle"));
    expect(await screen.findByText(/no moves or promotions recorded/i)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Source academic year"), "previous");
    expect(await screen.findByText("Promotion prepared for Current session · Class Two · Section C")).toBeInTheDocument();
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(rpc).toHaveBeenLastCalledWith("list_roster_placement_changes", {
      p_school_id: "school-one", p_academic_year_id: "previous", p_class_id: "class-one", p_section_id: "section-a",
    });
  });
});
