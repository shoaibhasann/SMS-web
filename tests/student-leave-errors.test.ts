import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { listFamilyStudentLeave, reviewStudentLeave, submitStudentLeave } from "@/lib/student-leave";

const requestId = "10000000-0000-4000-8000-000000000001";
const placementText = "This student has no active class placement for the current school year. Contact the school office.";
const failing = (code: string, message: string) =>
  ({ rpc: vi.fn().mockResolvedValue({ data: null, error: { code, message } }) } as unknown as SupabaseClient);

describe("student leave server error messages", () => {
  it("shows the server's placement message instead of an access failure", async () => {
    await expect(submitStudentLeave(failing("PT422", placementText), {
      studentId: "child-a", startDate: "2026-11-10", endDate: "2026-11-10", reason: "Family visit", idempotencyKey: requestId,
    })).rejects.toMatchObject({ code: "PT422", message: placementText });
  });

  it("explains an own-child review denial without changing the family access text", async () => {
    await expect(reviewStudentLeave(failing("42501", "SQL internal details"), requestId, "approved", "Approved"))
      .rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/your own child/) });
    await expect(listFamilyStudentLeave(failing("42501", "SQL internal details"), "child-a", "school-a"))
      .rejects.toThrow("Your access to this student or school could not be verified.");
  });
});
