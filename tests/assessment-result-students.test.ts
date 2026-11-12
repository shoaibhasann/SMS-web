// @vitest-environment node
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { loadAssessmentResultStudents, type AssessmentStudent } from "../lib/assessments";

const pupil = (id: string): AssessmentStudent => ({ id, admission_no: id.toUpperCase(), first_name: id, middle_name: null, last_name: null, roll_no: null });

/** Mocks the RPC: returns pupils for assessments it knows, paged with an exact count. */
function client(byAssessment: Record<string, string[]>, options: { countDelta?: number } = {}) {
  const calls: { name: string; args: { p_school_id: string; p_assessment_ids: string[] } }[] = [];
  const mock = {
    rpc(name: string, args: { p_school_id: string; p_assessment_ids: string[] }) {
      calls.push({ name, args });
      const ids = [...new Set(args.p_assessment_ids.flatMap((assessment) => byAssessment[assessment] ?? []))].sort();
      let from = 0, to = Infinity;
      const builder = {
        order() { return builder; },
        range(start: number, end: number) { from = start; to = end; return builder; },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          return Promise.resolve({ data: ids.slice(from, to + 1).map(pupil), count: ids.length + (options.countDelta ?? 0), error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { client: mock as unknown as SupabaseClient, calls };
}

describe("loadAssessmentResultStudents", () => {
  it("resolves marked pupils through the result RPC for the school, de-duplicated across chunks", async () => {
    const assessments = Array.from({ length: 150 }, (_, index) => `a${String(index).padStart(3, "0")}`);
    const { client: mock, calls } = client({ a000: ["p1", "p2"], a149: ["p2", "p3"] });
    const rows = await loadAssessmentResultStudents(mock, "school-a", [...assessments, "a000"], ["p2", "p1", "p2"]);
    expect(rows.map((row) => row.id).sort()).toEqual(["p1", "p2"]);
    expect(calls.map((call) => [call.name, call.args.p_school_id, call.args.p_assessment_ids.length])).toEqual([
      ["list_assessment_result_students", "school-a", 100], ["list_assessment_result_students", "school-a", 50],
    ]);
  });

  it("fails closed when a marked pupil cannot be resolved", async () => {
    const { client: mock } = client({ a1: ["p1"] });
    await expect(loadAssessmentResultStudents(mock, "school-a", ["a1"], ["p1", "p9"])).rejects.toThrow("Some student details are unavailable");
  });

  it("propagates an incomplete page read", async () => {
    const { client: mock } = client({ a1: ["p1"] }, { countDelta: 1 });
    await expect(loadAssessmentResultStudents(mock, "school-a", ["a1"], ["p1"])).rejects.toThrow();
  });

  it("does not call the RPC when nothing is marked", async () => {
    const { client: mock, calls } = client({});
    expect(await loadAssessmentResultStudents(mock, "school-a", ["a1"], [])).toEqual([]);
    expect(calls).toEqual([]);
  });
});
