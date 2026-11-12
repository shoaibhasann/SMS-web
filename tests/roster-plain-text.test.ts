import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { admitRosterStudent, importRosterStudents, plainRosterText } from "@/lib/students/roster";

const { bound } = vi.hoisted(() => ({ bound: vi.fn() }));
vi.mock("@/lib/auth/staff-mfa", () => ({ boundMfaSession: bound }));
const context = { schoolId: "school-a", academicYearId: "year-a", classId: "class-a", sectionId: "section-a" };
const pasted = { admissionNumber: " QA‎-01 ", firstName: "⁨Ayaan⁩", lastName: " Kh‮an⁩ " };
function client(data: unknown) {
  const query = { setHeader: vi.fn(), abortSignal: vi.fn(async () => ({ data, error: null })) };
  query.setHeader.mockReturnValue(query);
  const rpc = vi.fn(() => query);
  return { api: { rpc } as unknown as SupabaseClient, rpc };
}
beforeEach(() => { vi.resetAllMocks(); bound.mockResolvedValue({ access_token: "token", user: { id: "owner-a" } }); });

describe("roster writes strip pasted invisible marks", () => {
  it("cleans names and admission numbers for single admission and CSV import", async () => {
    const single = client("10000000-0000-4000-8000-000000000001");
    await admitRosterStudent(single.api, context, pasted, { userId: "owner-a" });
    expect(single.rpc).toHaveBeenCalledWith("admit_roster_student", expect.objectContaining({ p_admission_no: "QA-01", p_first_name: "Ayaan", p_last_name: "Khan" }));
    const batch = client(1);
    await importRosterStudents(batch.api, context, crypto.randomUUID(), [pasted], { userId: "owner-a" });
    expect(batch.rpc).toHaveBeenCalledWith("import_roster_students", expect.objectContaining({ p_students: [{ admissionNumber: "QA-01", firstName: "Ayaan", lastName: "Khan" }] }));
  });
  it("strips control characters too and trims", () => {
    expect(plainRosterText(" A\u0007b؜c  ")).toBe("Abc");
  });
});
