import type { SupabaseClient } from "@supabase/supabase-js";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SectionPromotionDialog } from "@/components/admin/student-roster-promotion";

const source = { schoolId: "school-one", academicYearId: "current", classId: "class-six", sectionId: "section-6a" };
const currentYear = { id: "current", name: "Current session", start_date: "2000-01-01", end_date: "2090-03-31", is_current: true };
const futureYear = { id: "future", name: "Next session", start_date: "2090-04-01", end_date: "2091-03-31", is_current: false };
const overlapYear = { id: "overlap", name: "Overlapping session", start_date: "2089-04-01", end_date: "2090-04-30", is_current: false };
const classes = [{ id: "class-six", name: "Class 6" }, { id: "class-seven", name: "Class 7" }];
const sections = [
  { id: "section-6a", class_id: "class-six", name: "A" },
  { id: "section-7a", class_id: "class-seven", name: "A" },
  { id: "section-7b", class_id: "class-seven", name: "B" },
];
const students = [1, 2, 3].map((n) => ({
  id: `student-${n}`, enrollment_id: `enrollment-${n}`, first_name: "Pupil", last_name: String(n), admission_no: `ADM-${n}`, roll_no: String(n),
}));
const reason = "Annual promotion to Class 7";

function renderDialog(rpc: ReturnType<typeof vi.fn>) {
  const onStaged = vi.fn();
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
    render(<SectionPromotionDialog client={{ rpc } as unknown as SupabaseClient} source={source} currentYear={currentYear}
      years={[currentYear, futureYear, overlapYear]} classes={classes} sections={sections} students={students}
      onClose={vi.fn()} onBusyChange={onBusyChange} onStaged={onStaged} />);
    return { dialog: within(screen.getByRole("dialog", { name: "Promote this section" })), onStaged, onBusyChange };
  } finally {
    HTMLDialogElement.prototype.showModal = showModal;
  }
}

async function fill(dialog: ReturnType<typeof renderDialog>["dialog"]) {
  const user = userEvent.setup();
  await user.selectOptions(dialog.getByLabelText("Destination class"), "class-seven");
  await user.selectOptions(dialog.getByLabelText("Destination section"), "section-7a");
  await user.type(dialog.getByLabelText("Reason for promotion"), reason);
  return user;
}

describe("section promotion", () => {
  it("stages the whole reviewed section except unticked students, and reuses the request id on retry", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: "", message: "Connection lost" } })
      .mockResolvedValueOnce({ data: { staged: 1, already_staged: 1 }, error: null });
    const { dialog, onStaged, onBusyChange } = renderDialog(rpc);

    const years = dialog.getByLabelText("Destination academic year");
    expect(within(years).getAllByRole("option").map((option) => option.textContent)).toEqual(["Select a later academic year", "Next session"]);
    expect(years).toHaveValue("future");
    const user = await fill(dialog);
    expect(dialog.getByRole("button", { name: "Stage promotion for 3 students" })).toBeEnabled();
    await user.click(dialog.getByLabelText("Pupil 3 · ADM-3"));
    expect(dialog.getByText("2 students → Next session · Class 7 · A")).toBeInTheDocument();
    expect(dialog.getByText(/unticked students stay unplaced/i)).toBeInTheDocument();

    await user.click(dialog.getByRole("button", { name: "Stage promotion for 2 students" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent(/retry with the same destination and reason/i);
    expect(onStaged).not.toHaveBeenCalled();
    await user.click(dialog.getByRole("button", { name: "Stage promotion for 2 students" }));

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
    expect(rpc).toHaveBeenCalledWith("stage_section_promotions", {
      p_school_id: "school-one", p_source_class_id: "class-six", p_source_section_id: "section-6a",
      p_enrollment_ids: ["enrollment-1", "enrollment-2"], p_destination_academic_year_id: "future",
      p_destination_class_id: "class-seven", p_destination_section_id: "section-7a", p_reason: reason, p_request_id: expect.any(String),
    });
    expect(onStaged).toHaveBeenCalledWith({ staged: 1, alreadyStaged: 1 });
    expect(onBusyChange.mock.calls).toEqual([[true], [false], [true], [false]]);
  });

  it("names the student who blocks the batch and keeps the draft", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null, error: { code: "55000", message: "Pupil ADM-2: Resolve pending attendance corrections before changing this placement." },
    });
    const { dialog, onStaged } = renderDialog(rpc);
    const user = await fill(dialog);
    await user.click(dialog.getByRole("button", { name: "Stage promotion for 3 students" }));

    expect(await dialog.findByRole("alert")).toHaveTextContent(/nothing was staged\. pupil ADM-2: resolve.*pending attendance corrections/i);
    expect(dialog.getByLabelText("Reason for promotion")).toHaveValue(reason);
    expect(onStaged).not.toHaveBeenCalled();
  });
});
