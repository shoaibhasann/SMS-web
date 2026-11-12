import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  cancelPublication, decidePublication, getFamilyAssessmentResults, getResultSubmission, listPublicationCandidates, listResultSubmissions,
  previewPublication, printPublishedResult, requestPublication, validatePublicationReason,
} from "@/lib/result-publication";
import { familyResult, resultDetail, resultMetadata, resultPreview, resultSummary, resultToken, resultUuid } from "./result-publication-fixture";
function client(data: unknown, error: { code?: string; message: string } | null = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error }); return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe("result publication RPC boundary", () => {
  it("loads candidates and exact frozen source preview including zero marks", async () => {
    const candidates = client([resultMetadata()]); expect(await listPublicationCandidates(candidates.client)).toEqual([resultMetadata()]);
    const source = client(resultPreview()); expect((await previewPublication(source.client, "assessment-a")).pupils[1].marks_obtained).toBe(0);
    expect(source.rpc).toHaveBeenCalledWith("preview_assessment_publication", { p_assessment_id: "assessment-a" });
  });
  it.each([
    resultPreview({ metadata: resultMetadata({ assessment_id: "other" }) }), resultPreview({ source_token: "bad" }),
    resultPreview({ pupils: [...resultPreview().pupils, resultPreview().pupils[0]] }),
    resultPreview({ can_submit: true, pupils: [{ ...resultPreview().pupils[0], marks_obtained: null }] }),
    resultPreview({ can_submit: true, issues: ["Missing marks"] }), resultPreview({ pupils: [{ ...resultPreview().pupils[0], marks_obtained: 101 }] }),
  ])("rejects malformed or ineligible-but-submittable source previews", async (data) => {
    await expect(previewPublication(client(data).client, "assessment-a")).rejects.toThrow("could not be verified");
  });
  it("keeps explicit unmarked rows and issues in an ineligible preview", async () => {
    const source = resultPreview({ can_submit: false, issues: ["Enter all marks"], pupils: [{ ...resultPreview().pupils[0], mark_id: null, marks_obtained: null, mark_updated_at: null, mark_updated_by: null }] });
    expect(await previewPublication(client(source).client, "assessment-a")).toEqual(source);
  });
  it("sends only source hash/intent and accepts a confirmed UUID", async () => {
    const saved = client(resultUuid(1)); expect(await requestPublication(saved.client, "assessment-a", resultToken, resultUuid(2))).toBe(resultUuid(1));
    expect(saved.rpc).toHaveBeenCalledWith("request_assessment_publication", { p_assessment_id: "assessment-a", p_expected_source_token: resultToken, p_request_id: resultUuid(2) });
  });
  it("rejects invalid retry references and unknown acknowledgements", async () => {
    const saved = client(null);
    await expect(requestPublication(saved.client, "assessment-a", "bad", resultUuid(2))).rejects.toThrow("Refresh the preview"); expect(saved.rpc).not.toHaveBeenCalled();
    await expect(requestPublication(saved.client, "assessment-a", resultToken, resultUuid(2))).rejects.toThrow("could not be confirmed");
  });
  it("validates paged office/status scope and stable complete counts", async () => {
    const row = resultSummary(), page = client({ rows: [row], total_count: "51", offset: 50 });
    expect((await listResultSubmissions(page.client, "school-a", "pending", 50)).total_count).toBe(51);
    await expect(listResultSubmissions(client({ rows: [row], total_count: 1, offset: 0 }).client, "school-b", null)).rejects.toThrow("could not be verified");
    await expect(listResultSubmissions(client({ rows: [row, row], total_count: 2, offset: 0 }).client, "school-a", null)).rejects.toThrow("could not be verified");
    await expect(listResultSubmissions(page.client, null, null, -1)).rejects.toThrow("valid results page");
  });
  it("verifies immutable detail identity, complete marks and terminal decisions", async () => {
    expect(await getResultSubmission(client(resultDetail()).client, resultUuid(1))).toEqual(resultDetail());
    await expect(getResultSubmission(client(resultDetail({ id: resultUuid(9) })).client, resultUuid(1))).rejects.toThrow("could not be verified");
    await expect(getResultSubmission(client(resultDetail({ status: "published" })).client, resultUuid(1))).rejects.toThrow("could not be verified");
    const cancelled = resultDetail({ status: "cancelled", reviewed_by: "teacher", reviewer_name: "QA Teacher", review_note: "Replace this snapshot", reviewed_at: "2026-11-06T10:00:00Z", source_matches: null });
    expect(await getResultSubmission(client(cancelled).client, resultUuid(1))).toEqual(cancelled);
  });
  it("reads the viewer's live score authorship and rejects a malformed flag", async () => {
    expect((await getResultSubmission(client(resultDetail({ viewer_entered_marks: true })).client, resultUuid(1))).viewer_entered_marks).toBe(true);
    const { viewer_entered_marks: _flag, ...older } = resultDetail(); void _flag;
    expect((await getResultSubmission(client(older).client, resultUuid(1))).viewer_entered_marks).toBe(false);
    await expect(getResultSubmission(client({ ...resultDetail(), viewer_entered_marks: "yes" }).client, resultUuid(1))).rejects.toThrow("could not be verified");
  });
  it("trims bounded review/cancel reasons and requires canonical mutation IDs", async () => {
    expect(validatePublicationReason(" \n ")).toBeTruthy(); const saved = client(resultUuid(1));
    await decidePublication(saved.client, resultUuid(1), "published", "  Reviewed every score  ");
    expect(saved.rpc).toHaveBeenLastCalledWith("review_assessment_publication", { p_submission_id: resultUuid(1), p_decision: "published", p_reason: "Reviewed every score" });
    await cancelPublication(saved.client, resultUuid(1), " Refresh source ");
    expect(saved.rpc).toHaveBeenLastCalledWith("cancel_assessment_result_submission", { p_submission_id: resultUuid(1), p_reason: "Refresh source" });
    await expect(cancelPublication(saved.client, resultUuid(1), " ")).rejects.toThrow("reason between");
    await expect(decidePublication(client(null).client, resultUuid(1), "rejected", "Reject this" )).rejects.toThrow("could not be confirmed");
  });
  it.each(["pupils", "snapshot", "rank", "mark_id", "enrollment_id", "review_note"])("rejects peer/private field %s in family result rows", async (key) => {
    const value = { student_id: "child-a", school_id: "school-a", rows: [{ ...familyResult(), [key]: "private" }], total_count: 1, offset: 0 };
    await expect(getFamilyAssessmentResults(client(value).client, "child-a", "school-a")).rejects.toThrow("could not be verified");
  });
  it("checks child/school/source consistency, duplicate latest revisions and percentage", async () => {
    const page = (rows: unknown[]) => ({ student_id: "child-a", school_id: "school-a", rows, total_count: rows.length, offset: 0 });
    expect((await getFamilyAssessmentResults(client(page([familyResult()])).client, "child-a", "school-a")).rows).toHaveLength(1);
    for (const row of [familyResult({ student_id: "child-b" }), familyResult({ percentage: 30 }), familyResult({ metadata: resultMetadata({ school_id: "school-b" }) })]) {
      await expect(getFamilyAssessmentResults(client(page([row])).client, "child-a", "school-a")).rejects.toThrow("could not be verified");
    }
    await expect(getFamilyAssessmentResults(client(page([familyResult(), familyResult({ id: resultUuid(2), revision: 2 })])).client, "child-a", "school-a")).rejects.toThrow("could not be verified");
  });
  it("provides explicit access, schema, conflict and unknown-outcome messages", async () => {
    await expect(requestPublication(client(null, { code: "PT409", message: "The source changed" }).client, "assessment-a", resultToken, resultUuid(1))).rejects.toThrow("source changed");
    await expect(listPublicationCandidates(client(null, { code: "42501", message: "Denied" }).client)).rejects.toThrow("access or teaching assignment");
    await expect(listPublicationCandidates(client(null, { code: "PGRST202", message: "Missing" }).client)).rejects.toThrow("latest school update");
    await expect(decidePublication(client(null, { message: "Network lost" }).client, resultUuid(1), "published", "Reviewed this")).rejects.toThrow("reason and request reference are kept");
  });
  it("prints only the supplied pupil snapshot through escaped DOM text", () => {
    const doc = document.implementation.createHTMLDocument(), popup = { document: doc, focus: vi.fn(), print: vi.fn(), opener: {} };
    const opened = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    try {
      printPublishedResult(familyResult({ student_name: "<img src=x onerror=alert(1)>", remarks: "<script>bad()</script>" }));
      expect(doc.body.textContent).toContain("<img src=x onerror=alert(1)>"); expect(doc.body.querySelector("img,script")).toBeNull();
      expect(doc.body.textContent).toContain("74 / 100"); expect(doc.body.textContent).not.toContain("QA Kabir"); expect(popup.print).toHaveBeenCalledOnce(); expect(popup.opener).toBeNull();
    } finally { opened.mockRestore(); }
  });
  it("prints the publication time in IST and a readable assessment date", () => {
    const doc = document.implementation.createHTMLDocument(), popup = { document: doc, focus: vi.fn(), print: vi.fn(), opener: {} };
    const opened = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    try {
      printPublishedResult(familyResult({ published_at: "2026-11-05T19:30:00Z" }));
      const printed = doc.body.textContent ?? "";
      expect(printed).toContain("6 Nov 2026"); expect(printed).toContain("IST"); expect(printed).toContain("5 Nov 2026");
      expect(printed).not.toContain("2026-11-05T19:30"); expect(printed).not.toContain("2026-11-05");
    } finally { opened.mockRestore(); }
  });
  it("reports blocked print windows explicitly", () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    try { expect(() => printPublishedResult(familyResult())).toThrow("print window was blocked"); } finally { opened.mockRestore(); }
  });
});
