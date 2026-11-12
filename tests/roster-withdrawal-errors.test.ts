import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { withdrawRosterStudent } from "@/lib/students/withdrawals";

const context = { schoolId: "school-a", academicYearId: "year-a", classId: "class-a", sectionId: "section-a" };

describe("withdrawal errors", () => {
  it("tells the office to resolve pending attendance corrections first", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "55000", message: "Resolve this pupil's pending attendance corrections before withdrawing." } }));
    await expect(withdrawRosterStudent({ rpc } as unknown as SupabaseClient, context, "student-a", "Family relocation"))
      .rejects.toThrow("Resolve this pupil’s pending attendance corrections before withdrawing.");
  });
});
