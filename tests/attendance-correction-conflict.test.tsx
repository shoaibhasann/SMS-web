import type { SupabaseClient } from "@supabase/supabase-js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AttendanceCorrectionQueue } from "../components/academic/attendance-correction-queue";

describe("attendance correction review conflicts", () => {
  it.each(["PT409", "40001"])("retains the review reason and requires refresh before deciding a changed request (%s)", async (code) => {
    const user = userEvent.setup();
    let state = "pending";
    let reviewCalls = 0;
    const request = () => ({ id: "request-a", requested_by: "teacher-a", student_name: "QA Student", admission_no: "1001", section_name: "Class 6 A",
      attendance_date: "2026-11-04", state, requested_status: "late", request_reason: "Gate register checked", review_reason: null,
      requester_name: "QA Teacher", reviewer_name: null, before_record: { status: "absent", remarks: null }, after_record: null });
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "list_attendance_corrections") return { data: [request()], error: null };
      if (name !== "review_attendance_correction") throw new Error("Unexpected RPC " + name);
      reviewCalls += 1;
      if (reviewCalls === 1) return { data: null, error: { code, message: "Attendance no longer matches the requested before record." } };
      state = String(args.p_decision);
      return { data: state, error: null };
    });
    const onReviewed = vi.fn();
    render(<AttendanceCorrectionQueue client={{ rpc } as unknown as SupabaseClient} schoolId="school-a" userId="principal-a" onReviewed={onReviewed} />);
    await user.click(await screen.findByRole("button", { name: "Review request" }));
    const reason = screen.getByRole("textbox", { name: "Review reason" });
    await user.type(reason, "The register must be checked again.");
    await user.click(screen.getByRole("button", { name: "Approve correction" }));
    await screen.findByText("Attendance changed, so this request cannot be approved. Your review reason is kept. Refresh requests, reject the outdated request with a reason, and ask the teacher to reload and submit a new correction.");
    expect(reason).toHaveValue("The register must be checked again.");
    expect(screen.getByRole("button", { name: "Approve correction" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject correction" })).toBeDisabled();
    expect(onReviewed).not.toHaveBeenCalled();
    expect(screen.queryByText("Correction approved and attendance updated.")).not.toBeInTheDocument();
    expect(rpc.mock.calls.filter(([name]) => name === "list_attendance_corrections")).toHaveLength(1);
    expect(reviewCalls).toBe(1);

    await user.click(screen.getByRole("button", { name: "Refresh requests" }));
    const keptReason = await screen.findByRole("textbox", { name: "Review reason" });
    expect(keptReason).toHaveValue("The register must be checked again.");
    expect(screen.getByRole("button", { name: "Approve correction" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject correction" })).toBeEnabled();
    expect(screen.getByText("This request uses an outdated mark. Reject it with a reason; the teacher must reload and request a new correction.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reject correction" }));
    await screen.findByText("Correction rejected.");
    expect(rpc).toHaveBeenCalledWith("review_attendance_correction", { p_request_id: "request-a", p_decision: "rejected", p_reason: "The register must be checked again." });
    expect(reviewCalls).toBe(2); expect(onReviewed).toHaveBeenCalledTimes(1);
    expect(state).toBe("rejected");
  });
});
