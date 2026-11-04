import type { SupabaseClient } from "@supabase/supabase-js";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GuardianInvitationImport } from "@/components/admin/guardian-invitation-import";
import { guardianCsvTemplate, parseGuardianCsv } from "@/lib/guardian-invitations/guardian-csv";

const header = guardianCsvTemplate.split("\n")[0];
const token = "a".repeat(64);
const schoolId = "school-a";
const admissionNumber = "QA-01";
const email = "family@example.test";
const matched = { row_number: 1, admission_no: admissionNumber, email, student_id: "student-a", student_name: "QA Pupil", error: null };

function csvFile(text: string) {
  const bytes = new TextEncoder().encode(text);
  const file = new File([bytes], "guardian-list.csv", { type: "text/csv" });
  return Object.assign(file, { arrayBuffer: async () => bytes.buffer });
}

function importPanel(rpc: ReturnType<typeof vi.fn>) {
  const client = { rpc } as unknown as SupabaseClient;
  const onImported = vi.fn();
  const onBusyChange = vi.fn();
  const element = (school: string) => <GuardianInvitationImport key={school} client={client} schoolId={school}
    busy={false} onBusyChange={onBusyChange} onImported={onImported} />;
  return { ...render(element(schoolId)), element, onImported, onBusyChange };
}

async function upload(user: ReturnType<typeof userEvent.setup>, rows: string) {
  const summary = screen.getByText("Import guardian invitations from CSV");
  if (!summary.parentElement?.hasAttribute("open")) await user.click(summary);
  await user.upload(screen.getByLabelText("Guardian CSV file"), csvFile(`${header}\n${rows}`));
}

describe("guardian CSV import", () => {
  it("normalizes email while retaining admission case and allowing siblings and multiple guardians", () => {
    expect(parseGuardianCsv(`\uFEFF${header}\r\n" QA-01 ","FAMILY@EXAMPLE.TEST"\r\nQA-02,${email}\r\nQA-01,second@example.test\r\n`))
      .toEqual([
        { rowNumber: 1, admissionNumber: "QA-01", email, error: null },
        { rowNumber: 2, admissionNumber: "QA-02", email, error: null },
        { rowNumber: 3, admissionNumber: "QA-01", email: "second@example.test", error: null },
      ]);
    expect(() => parseGuardianCsv("guardian_email,admission_number\na@example.test,QA-01")).toThrow(/template columns/);
    expect(() => parseGuardianCsv(`${header}\n${Array.from({ length: 51 }, (_, index) => `QA-${index},${email}`).join("\n")}`))
      .toThrow(/between 1 and 50/);
  });

  it("shows local row errors before querying Supabase and prevents partial import", async () => {
    const user = userEvent.setup();
    const rpc = vi.fn();
    importPanel(rpc);
    await upload(user, `QA-01,${email}\nQA-01,FAMILY@EXAMPLE.TEST\nQA-03,invalid\n`);

    const preview = within(await screen.findByRole("region", { name: "Guardian CSV preview" }));
    expect(preview.getByText(/already appear in row 1/)).toBeInTheDocument();
    expect(preview.getByText("Enter a valid guardian email address.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create 3 guardian invitations" })).toBeDisabled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("previews matched, missing and ambiguous students without creating any invitation", async () => {
    const user = userEvent.setup();
    const rpc = vi.fn().mockResolvedValue({
      data: [
        matched,
        { row_number: 2, admission_no: "MISSING", email, student_id: null, student_name: null, error: "No active student matches this admission number." },
        { row_number: 3, admission_no: "AMBIGUOUS", email, student_id: null, student_name: null, error: "More than one current enrollment matches this student." },
      ],
      error: null,
    });
    importPanel(rpc);
    await upload(user, `QA-01,${email}\nMISSING,${email}\nAMBIGUOUS,${email}\n`);

    const preview = within(await screen.findByRole("region", { name: "Guardian CSV preview" }));
    expect(preview.getByText("QA Pupil")).toBeInTheDocument();
    expect(preview.getByText(/no active student matches/i)).toBeInTheDocument();
    expect(preview.getByText(/more than one current enrollment/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create 3 guardian invitations" })).toBeDisabled();
    expect(rpc).toHaveBeenCalledExactlyOnceWith("preview_guardian_invitation_import", {
      p_school_id: schoolId,
      p_rows: [admissionNumber, "MISSING", "AMBIGUOUS"].map((value) => ({ admissionNumber: value, email })),
    });
  });

  it("reuses one delivery request after a lost response, copies the correct URL and clears it on a school change", async () => {
    const user = userEvent.setup();
    const rpc = vi.fn().mockResolvedValueOnce({ data: [matched], error: null })
      .mockResolvedValueOnce({ data: null, error: { code: "", message: "Connection interrupted" } })
      .mockImplementationOnce(async (_functionName, params) => ({
        data: { request_id: params.p_request_id, invitations: [{ ...matched, id: "invite-a", token, expires_at: "2099-11-05T12:00:00Z" }] },
        error: null,
      }));
    const { element, onImported, rerender } = importPanel(rpc);
    await upload(user, `QA-01,${email}\n`);
    expect(await screen.findByText("QA Pupil")).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Create 1 guardian invitation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/retry from this same preview/i);
    expect(onImported).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Create 1 guardian invitation" }));
    const result = within(await screen.findByRole("region", { name: "Imported guardian invitations" }));
    expect(result.getByText("QA Pupil · QA-01")).toBeInTheDocument();
    expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[2]);
    expect(rpc.mock.calls[2]).toEqual(["import_guardian_invitations", {
      p_school_id: schoolId, p_request_id: expect.any(String), p_delivery_key: expect.stringMatching(/^[a-f0-9]{64}$/),
      p_rows: [{ admissionNumber, email, studentId: "student-a" }],
    }]);
    expect(onImported).toHaveBeenCalledOnce();

    await user.click(result.getByRole("button", { name: `Copy invitation link for ${email} · QA-01` }));
    expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/guardian-invite#token=${token}`);
    rerender(element("school-b"));
    expect(screen.queryByRole("region", { name: "Imported guardian invitations" })).not.toBeInTheDocument();
  });
});
