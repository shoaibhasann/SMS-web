import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  isLeaveDate, listFamilyStudentLeave, listStudentLeaveReview, reviewStudentLeave,
  submitStudentLeave, validateStudentLeave,
} from "@/lib/student-leave";

const requestId = "10000000-0000-4000-8000-000000000001";
const idempotencyKey = "10000000-0000-4000-8000-000000000002";
const row = {
  id: requestId, school_id: "school-a", student_id: "child-a", student_name: "QA Child", admission_no: "QA-01",
  academic_year_id: "year-a", academic_year_name: "2026–27", class_name: "Class 4", section_name: "A",
  start_date: "2026-11-10", end_date: "2026-11-12", reason: "Family visit", status: "pending",
  requester_id: "guardian-a", requester_name: "QA Guardian", created_at: "2026-11-06T10:00:00Z",
  reviewed_by: null, reviewer_name: null, review_note: null, reviewed_at: null, total_count: 1,
};

function mockClient(data: unknown, error: { code?: string; message?: string } | null = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { rpc, client: { rpc } as unknown as SupabaseClient };
}

describe("student leave client", () => {
  it("validates calendar dates without local timezone or date normalization", () => {
    expect(isLeaveDate("2028-02-29")).toBe(true);
    for (const value of ["2026-02-29", "2026-04-31", "2026-13-01", "0000-01-01", "infinity", "2026-1-02", "2026-11-01T00:00:00Z"]) expect(isLeaveDate(value)).toBe(false);
    expect(validateStudentLeave("2026-11-12", "2026-11-10", "Family visit")).toMatch(/end date/);
    expect(validateStudentLeave("2026-11-10", "2026-11-10", "  ok  ")).toMatch(/3 and/);
    expect(validateStudentLeave("2026-11-10", "2026-11-10", "  Valid reason  ")).toBeNull();
  });

  it("loads exact child history and normalizes a safe Postgres bigint count", async () => {
    const { client, rpc } = mockClient([{ ...row, total_count: "1" }]);
    expect(await listFamilyStudentLeave(client, "child-a", "school-a")).toEqual([row]);
    expect(rpc).toHaveBeenCalledWith("list_family_student_leave", { p_student_id: "child-a", p_offset: 0 });
  });

  it.each([
    { student_id: "other-child" }, { school_id: "other-school" }, { status: "cancelled" },
    { start_date: "2026-02-31" }, { end_date: "2026-11-01" }, { created_at: "invalid" },
    { total_count: 0 }, { total_count: "9007199254740992" }, { reviewed_by: "unexpected-reviewer" },
    { status: "approved", reviewed_by: null },
  ])("fails closed for malformed or mismapped family records: %j", async (patch) => {
    const { client } = mockClient([{ ...row, ...patch }]);
    await expect(listFamilyStudentLeave(client, "child-a", "school-a")).rejects.toThrow(/could not be verified/);
  });

  it("rejects duplicate rows and inconsistent pagination counts", async () => {
    const { client, rpc } = mockClient([{ ...row, total_count: 2 }, { ...row, total_count: 2 }]);
    await expect(listFamilyStudentLeave(client, "child-a", "school-a")).rejects.toThrow(/could not be verified/);
    rpc.mockResolvedValue({ data: [{ ...row, total_count: 2 }, { ...row, id: "other-request", total_count: 3 }], error: null });
    await expect(listFamilyStudentLeave(client, "child-a", "school-a")).rejects.toThrow(/could not be verified/);
  });

  it("scopes a review page to its school and selected status", async () => {
    const { client, rpc } = mockClient([{ ...row, total_count: 51 }]);
    await listStudentLeaveReview(client, "school-a", "pending", 50);
    expect(rpc).toHaveBeenCalledWith("list_student_leave_review", { p_school_id: "school-a", p_status: "pending", p_offset: 50 });
    rpc.mockResolvedValue({ data: [{ ...row, status: "rejected", reviewed_by: "reviewer", reviewed_at: "2026-11-06T11:00:00Z", review_note: "Reviewed" }], error: null });
    await expect(listStudentLeaveReview(client, "school-a", "pending")).rejects.toThrow(/could not be verified/);
    await expect(listStudentLeaveReview(client, "school-b", null)).rejects.toThrow(/could not be verified/);
    await expect(listStudentLeaveReview(client, "school-a", null, -1)).rejects.toThrow(/valid history page/);
  });

  it("submits a trimmed reason and caller-owned retry reference, without trusting a supplied actor", async () => {
    const { client, rpc } = mockClient(requestId);
    const result = await submitStudentLeave(client, { studentId: "child-a", startDate: "2026-11-10", endDate: "2026-11-12", reason: "  Family visit  ", idempotencyKey });
    expect(result).toBe(requestId);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("submit_student_leave", {
      p_student_id: "child-a", p_start_date: "2026-11-10", p_end_date: "2026-11-12", p_reason: "Family visit", p_idempotency_key: idempotencyKey,
    });
  });

  it("does not send invalid submissions or review notes", async () => {
    const { client, rpc } = mockClient(requestId);
    await expect(submitStudentLeave(client, { studentId: "child-a", startDate: "2026-11-12", endDate: "2026-11-10", reason: "Family visit", idempotencyKey })).rejects.toThrow(/valid dates/);
    await expect(submitStudentLeave(client, { studentId: "child-a", startDate: "2026-11-10", endDate: "2026-11-12", reason: "Family visit", idempotencyKey: "not-a-reference" })).rejects.toThrow(/reference/);
    await expect(reviewStudentLeave(client, requestId, "approved", "  ")).rejects.toThrow(/review reason/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("confirms only the canonical mutation result and preserves uncertain-acknowledgement wording", async () => {
    const { client, rpc } = mockClient(null);
    const request = { studentId: "child-a", startDate: "2026-11-10", endDate: "2026-11-12", reason: "Family visit", idempotencyKey };
    await expect(submitStudentLeave(client, request)).rejects.toThrow(/could not be confirmed/);
    rpc.mockResolvedValue({ data: "another-request", error: null });
    await expect(reviewStudentLeave(client, requestId, "approved", "Looks valid")).rejects.toThrow(/could not be confirmed/);
    rpc.mockResolvedValue({ data: null, error: { message: "Network failed" } });
    await expect(reviewStudentLeave(client, requestId, "approved", "Looks valid")).rejects.toThrow(/Retry the same decision/);
  });

  it("preserves actionable conflict reasons and trims review notes", async () => {
    const { client, rpc } = mockClient(requestId);
    expect(await reviewStudentLeave(client, requestId, "rejected", "  Dates overlap  ")).toBe(requestId);
    expect(rpc).toHaveBeenCalledWith("review_student_leave", { p_request_id: requestId, p_decision: "rejected", p_reason: "Dates overlap" });
    rpc.mockResolvedValue({ data: null, error: { code: "23505", message: "This request was already reviewed. Refresh its saved status." } });
    await expect(reviewStudentLeave(client, requestId, "approved", "Reviewed again")).rejects.toMatchObject({ code: "23505", message: expect.stringContaining("already reviewed") });
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "SQL internal details" } });
    await expect(listFamilyStudentLeave(client, "child-a", "school-a")).rejects.toThrow(/access.*could not be verified/);
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Missing RPC" } });
    await expect(listFamilyStudentLeave(client, "child-a", "school-a")).rejects.toThrow(/latest school update/);
  });
});
