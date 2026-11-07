import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFamilyAttendanceReportPdf, downloadFamilyAttendanceReportPdf } from "@/lib/attendance/report-export";
import { FamilyAttendanceSummaryError } from "@/lib/attendance/family-summary";
import { attendanceReportContextFixture as contextFixture, previousAttendanceSummaryFixture as fixture, previousSummaryYear as year, summaryOwner as owner, summaryStudent as student, summaryId as id, summaryPeriod } from "./attendance-summary-fixture";

const { report, context, family, build, bound } = vi.hoisted(() => ({ report: vi.fn(), context: vi.fn(), family: vi.fn(), build: vi.fn(), bound: vi.fn() }));
vi.mock("@/lib/attendance/family-summary", async original => ({ ...await original<typeof import("@/lib/attendance/family-summary")>(), loadFamilyAttendanceReport: report, loadFamilyAttendanceReportContext: context }));
vi.mock("@/lib/attendance/family", () => ({ loadFamilyStudents: family }));
vi.mock("@/lib/auth/staff-mfa", () => ({ boundMfaSession: bound }));
vi.mock("@/lib/attendance/report-pdf", () => ({ buildAttendanceReportPdf: build, AttendanceReportPdfError: class extends Error {} }));
const pupil = { ...student, first_name: "Aarav", middle_name: null, last_name: "Sharma", admission_no: "QA-123", status: "active" };
const bytes = new Uint8Array(Array.from("%PDF-1.7\nsynthetic", character => character.charCodeAt(0)));
const filename = "attendance-2025-04-01-2026-03-31-2026-03.pdf";
function client() {
  const query = { select: vi.fn(), eq: vi.fn(), abortSignal: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: { id: student.school_id, name: "Verified QA school" }, error: null }) };
  query.select.mockReturnValue(query); query.eq.mockReturnValue(query); query.abortSignal.mockReturnValue(query);
  const from = vi.fn().mockReturnValue(query);
  return { client: { from } as unknown as SupabaseClient, from, query };
}
const signal = () => new AbortController().signal;
function pending<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); report.mockReset().mockResolvedValue(fixture()); context.mockReset().mockResolvedValue(contextFixture());
  family.mockReset().mockResolvedValue([pupil]); build.mockReset().mockResolvedValue({ bytes, filename }); bound.mockReset().mockResolvedValue({ user: { id: owner }, access_token: "test-only" });
});
describe("verified official attendance PDF export", () => {
  it("pins an explicit year/month and rechecks actual report, context, names and school after rendering", async () => {
    const mock = client(), abort = signal();
    expect(await createFamilyAttendanceReportPdf(mock.client, owner, student, "parent", year.id, "2026-03-01", abort, fixture())).toEqual({ bytes, filename });
    expect(report).toHaveBeenCalledTimes(2); expect(context).toHaveBeenCalledTimes(2); expect(family).toHaveBeenCalledTimes(2); expect(bound).toHaveBeenCalledTimes(2);
    for (const call of report.mock.calls) expect(call).toEqual([mock.client, owner, student, "parent", year.id, "2026-03-01", abort]);
    expect(build).toHaveBeenCalledWith({ summary: fixture(), schoolName: "Verified QA school", studentName: "Aarav Sharma", admissionNo: "QA-123", generatedAt: expect.any(Date) }, abort);
    expect(mock.query.select).toHaveBeenCalledWith("id,name"); expect(mock.query.eq).toHaveBeenCalledWith("id", student.school_id); expect(mock.query.abortSignal).toHaveBeenCalledWith(abort);
  });
  it("allows incomplete rates through unchanged rather than turning missing marks into zero", async () => {
    const incomplete = summaryPeriod({ from: "2026-03-01", to: "2026-03-07", state: "attendance_incomplete", unmarked_days: 1, marked_days: 4, present_days: 1, earned_days: 2.5, percentage: null });
    report.mockResolvedValue(fixture({ month_summary: incomplete, year_summary: incomplete }));
    await createFamilyAttendanceReportPdf(client().client, owner, student, "parent", year.id, "2026-03-01", signal(), fixture({ month_summary: incomplete, year_summary: incomplete }));
    expect(build.mock.calls[0][0].summary.month_summary.percentage).toBeNull();
  });
  it("rejects fresh source changes against the displayed report before generating any PDF", async () => {
    report.mockResolvedValue(fixture({ calendar_revision: 9 }));
    await expect(createFamilyAttendanceReportPdf(client().client, owner, student, "parent", year.id, "2026-03-01", signal(), fixture())).rejects.toThrow("records changed");
    expect(build).not.toHaveBeenCalled();
  });
  it("validates the mandatory displayed report identity and counts before any network read", async () => {
    await expect(createFamilyAttendanceReportPdf(client().client, owner, student, "parent", year.id, "2026-03-01", signal(), fixture({ student_id: id(9) }))).rejects.toThrow("could not be verified");
    await expect(createFamilyAttendanceReportPdf(client().client, owner, student, "parent", year.id, "2026-03-01", signal(), fixture({ month_summary: summaryPeriod({ percentage: 99 }) }))).rejects.toThrow("could not be verified");
    expect(report).not.toHaveBeenCalled(); expect(build).not.toHaveBeenCalled();
  });
  it("keeps unexpected rendering failures generic and leaves the caller able to retry", async () => {
    build.mockRejectedValueOnce(new Error("Unexpected internal rendering details"));
    await expect(createFamilyAttendanceReportPdf(client().client, owner, student, "parent", year.id, "2026-03-01", signal(), fixture())).rejects.toThrow("PDF could not be prepared");
  });
  it("uses student identity authorization without a guardian fallback", async () => {
    report.mockResolvedValue(fixture({ role: "student" })); context.mockResolvedValue(contextFixture({ role: "student" }));
    const mock = client(); await createFamilyAttendanceReportPdf(mock.client, owner, student, "student", year.id, "2026-03-01", signal(), fixture({ role: "student" }));
    expect(family).toHaveBeenCalledWith(mock.client, "student", owner); expect(report.mock.calls.every(call => call[3] === "student")).toBe(true);
  });
  it("rejects invalid scopes and months before auth, data reads or generation", async () => {
    const mock = client();
    await expect(createFamilyAttendanceReportPdf(mock.client, owner, student, "parent", "bad-id", "2026-03-01", signal(), fixture())).rejects.toMatchObject({ code: "access" });
    for (const month of ["2026-03-02", "2026-02-30", "0000-01-01"]) await expect(createFamilyAttendanceReportPdf(mock.client, owner, student, "parent", year.id, month, signal(), fixture())).rejects.toMatchObject({ code: "validation" });
    expect(report).not.toHaveBeenCalled(); expect(family).not.toHaveBeenCalled(); expect(mock.from).not.toHaveBeenCalled(); expect(build).not.toHaveBeenCalled();
  });
  it("rejects a revoked child at the pre-render or post-render authoritative read", async () => {
    const denied = new FamilyAttendanceSummaryError("Child access revoked.", "access");
    report.mockRejectedValueOnce(denied);
    await expect(createFamilyAttendanceReportPdf(client().client, owner, student, "parent", year.id, "2026-03-01", signal(), fixture())).rejects.toBe(denied); expect(build).not.toHaveBeenCalled();
    report.mockResolvedValueOnce(fixture()).mockRejectedValueOnce(denied);
    await expect(createFamilyAttendanceReportPdf(client().client, owner, student, "parent", year.id, "2026-03-01", signal(), fixture())).rejects.toBe(denied); expect(build).toHaveBeenCalledOnce();
  });
  it.each([
    () => family.mockResolvedValueOnce([]),
    () => family.mockResolvedValueOnce([{ ...pupil, school_id: id(9) }]),
    () => family.mockResolvedValueOnce([{ ...pupil, id: id(9) }]),
  ])("denies missing or foreign pupil identities", async setup => {
    setup(); await expect(createFamilyAttendanceReportPdf(client().client, owner, student, "parent", year.id, "2026-03-01", signal(), fixture())).rejects.toMatchObject({ code: "access" }); expect(build).not.toHaveBeenCalled();
  });
  it("rejects mismatched year catalog, missing active periods and school identities", async () => {
    context.mockResolvedValueOnce(contextFixture({ years: [] }));
    await expect(createFamilyAttendanceReportPdf(client().client, owner, student, "parent", year.id, "2026-03-01", signal(), fixture())).rejects.toThrow("records changed");
    report.mockResolvedValueOnce(fixture({ month_summary: null }));
    await expect(createFamilyAttendanceReportPdf(client().client, owner, student, "parent", year.id, "2026-03-01", signal(), fixture())).rejects.toThrow("records changed");
    const mock = client(); mock.query.maybeSingle.mockResolvedValueOnce({ data: { id: id(9), name: "Foreign" }, error: null });
    await expect(createFamilyAttendanceReportPdf(mock.client, owner, student, "parent", year.id, "2026-03-01", signal(), fixture())).rejects.toMatchObject({ code: "access" }); expect(build).not.toHaveBeenCalled();
  });
  it("classifies an early family/profile read failure as access even while the protected report is pending", async () => {
    report.mockReturnValueOnce(new Promise(() => {})); family.mockRejectedValueOnce(new Error("Parent profile no longer visible"));
    await expect(createFamilyAttendanceReportPdf(client().client, owner, student, "parent", year.id, "2026-03-01", signal(), fixture())).rejects.toMatchObject({ code: "access" });
    expect(build).not.toHaveBeenCalled();
  });
  it("permits an authorized archive while the current setup is ambiguous", async () => {
    context.mockResolvedValue(contextFixture({ current_session_state: "ambiguous", current_year_id: null, years: [year] }));
    expect((await createFamilyAttendanceReportPdf(client().client, owner, student, "parent", year.id, "2026-03-01", signal(), fixture())).filename).toBe(filename);
  });
  it("rejects a year removed or renamed during current-year activation rather than falling back", async () => {
    context.mockResolvedValueOnce(contextFixture()).mockResolvedValueOnce(contextFixture({ years: [] }));
    await expect(createFamilyAttendanceReportPdf(client().client, owner, student, "parent", year.id, "2026-03-01", signal(), fixture())).rejects.toThrow("records changed");
    context.mockResolvedValueOnce(contextFixture()).mockResolvedValueOnce(contextFixture({ years: [{ ...year, name: "Renamed" }] }));
    await expect(createFamilyAttendanceReportPdf(client().client, owner, student, "parent", year.id, "2026-03-01", signal(), fixture())).rejects.toThrow("records changed");
  });
  it("withholds a finished PDF when corrections, calendar revision, names or school details change", async () => {
    for (const setup of [
      () => report.mockResolvedValueOnce(fixture()).mockResolvedValueOnce(fixture({ calendar_revision: 4 })),
      () => report.mockResolvedValueOnce(fixture()).mockResolvedValueOnce(fixture({ year_summary: summaryPeriod({ from: "2026-03-01", to: "2026-03-07", percentage: 80, present_days: 3, earned_days: 4, half_days: 0 }) })),
      () => family.mockResolvedValueOnce([pupil]).mockResolvedValueOnce([{ ...pupil, first_name: "Changed" }]),
    ]) {
      setup(); await expect(createFamilyAttendanceReportPdf(client().client, owner, student, "parent", year.id, "2026-03-01", signal(), fixture())).rejects.toThrow("records changed");
    }
    const mock = client(); mock.query.maybeSingle.mockResolvedValueOnce({ data: { id: student.school_id, name: "First" }, error: null });
    await expect(createFamilyAttendanceReportPdf(mock.client, owner, student, "parent", year.id, "2026-03-01", signal(), fixture())).rejects.toThrow("records changed");
  });
  it("rejects sign-out/account change after the final parallel reads", async () => {
    bound.mockResolvedValueOnce({ user: { id: owner } }).mockRejectedValueOnce(new Error("changed"));
    await expect(createFamilyAttendanceReportPdf(client().client, owner, student, "parent", year.id, "2026-03-01", signal(), fixture())).rejects.toMatchObject({ code: "access" });
  });
  it("cancels before reads and after slow rendering without downloading", async () => {
    const before = new AbortController(); before.abort();
    await expect(createFamilyAttendanceReportPdf(client().client, owner, student, "parent", year.id, "2026-03-01", before.signal, fixture())).rejects.toMatchObject({ name: "AbortError" }); expect(report).not.toHaveBeenCalled();
    const slow = pending<{ bytes: Uint8Array; filename: string }>(); build.mockReturnValueOnce(slow.promise); const controller = new AbortController();
    const result = createFamilyAttendanceReportPdf(client().client, owner, student, "parent", year.id, "2026-03-01", controller.signal, fixture());
    await vi.waitFor(() => expect(build).toHaveBeenCalledOnce()); controller.abort(); slow.resolve({ bytes, filename });
    await expect(result).rejects.toMatchObject({ name: "AbortError" }); expect(report).toHaveBeenCalledOnce();
  });
  it.each([
    { bytes: new TextEncoder().encode("<html>not a PDF</html>"), filename },
    { bytes: new Uint8Array(), filename },
    { bytes, filename: "../../foreign.pdf" },
  ])("rejects malformed renderer output or unexpected filenames", async output => {
    build.mockResolvedValueOnce(output);
    await expect(createFamilyAttendanceReportPdf(client().client, owner, student, "parent", year.id, "2026-03-01", signal(), fixture())).rejects.toThrow("PDF could not be verified");
  });
  it("downloads only an application/pdf blob with a deterministic non-PII filename and releases its URL", async () => {
    const create = vi.fn().mockReturnValue("blob:verified-attendance"), revoke = vi.fn(); vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {}), schedule = vi.spyOn(window, "setTimeout").mockReturnValue(0 as unknown as ReturnType<typeof window.setTimeout>);
    const remove = vi.spyOn(HTMLAnchorElement.prototype, "remove"), append = vi.spyOn(document.body, "appendChild");
    await downloadFamilyAttendanceReportPdf(client().client, owner, student, "parent", year.id, "2026-03-01", signal(), fixture());
    expect(create.mock.calls[0][0]).toMatchObject({ type: "application/pdf" }); expect(click).toHaveBeenCalledOnce();
    const anchor = append.mock.calls[0][0] as HTMLAnchorElement; expect(anchor.href).toBe("blob:verified-attendance"); expect(anchor.download).toBe(filename); expect(remove).toHaveBeenCalledOnce();
    const cleanup = schedule.mock.calls.find(call => call[1] === 30_000)?.[0] as () => void; expect(cleanup).toBeTypeOf("function"); cleanup(); expect(revoke).toHaveBeenCalledWith("blob:verified-attendance");
  });
});
