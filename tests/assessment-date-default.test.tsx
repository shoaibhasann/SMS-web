import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdminAssessmentWorkspace } from "../components/admin/admin-assessment-workspace";

const { loadAssessments } = vi.hoisted(() => ({ loadAssessments: vi.fn() }));
vi.mock("@/lib/assessments", async () => ({
  ...await vi.importActual<typeof import("../lib/assessments")>("../lib/assessments"),
  loadAssessments,
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({
  auth: { getUser: async () => ({ data: { user: { id: "admin" } }, error: null }) }, rpc: vi.fn(),
  from: (table: string) => {
    const rows: Record<string, unknown[]> = {
      user_roles: [{ role: "school_admin", school_id: "school" }], schools: [{ id: "school", name: "School" }],
      academic_years: [{ id: "year", name: "2026–27" }],
    };
    const query = { select: () => query, eq: () => query, in: () => query, order: () => query, range: () => query,
      then: (resolve: (value: { data: unknown[]; error: null }) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve) };
    return query;
  },
}) }));

beforeEach(() => {
  loadAssessments.mockResolvedValue([]);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T20:30:00Z")); // 02:00 IST on 12 Nov
});
afterEach(() => vi.useRealTimers());

it("defaults a new admin assessment to the IST school date, not the UTC date", async () => {
  render(<AdminAssessmentWorkspace mode="exams" />);
  await screen.findByRole("heading", { name: "Create assessment" });
  expect(screen.getByLabelText("Date")).toHaveValue("2026-11-12");
});
