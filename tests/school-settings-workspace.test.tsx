import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SchoolSettingsWorkspace } from "@/components/admin/school-settings-workspace";
import { SchoolSettingsError, type SchoolSettings, type SchoolSettingsIntent } from "@/lib/admin/school-settings";

const mocks = vi.hoisted(() => ({ access: vi.fn(), load: vi.fn(), save: vi.fn(), auth: vi.fn() }));
vi.mock("@/components/admin/school-staff-mfa-policy", () => ({ SchoolStaffMfaPolicy: () => <section aria-label="School authenticator policy" /> }));
vi.mock("@/components/admin/school-attendance-calendar", () => ({ SchoolAttendanceCalendar: () => <section id="attendance-calendar" aria-label="School attendance calendar" /> }));
vi.mock("@/components/admin/school-late-alert-settings", () => ({ SchoolLateAlertSettings: () => <section aria-label="School Late alert policy" /> }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { onAuthStateChange: mocks.auth } }) }));
vi.mock("@/lib/attendance/repository", () => ({ loadSchoolManagementAccess: mocks.access }));
vi.mock("@/lib/admin/school-settings", async (original) => ({ ...await original<typeof import("@/lib/admin/school-settings")>(), loadSchoolSettings: mocks.load, saveSchoolSettings: mocks.save }));
const id = (n: number) => `a2000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const owner = id(1), schoolA = id(2), schoolB = id(3);
function snapshot(patch: Partial<SchoolSettings> = {}): SchoolSettings {
  return { school: { id: schoolA, name: "QA School", code: "QA-001", board: "CBSE", affiliation_no: null, address: null, city: "Firozabad", state: "Uttar Pradesh", pincode: null, phone: null, email: null, website: null, timezone: "UTC", revision: 3 },
    can_edit: true, setup: { school_day: "2026-11-07", current_year: null, current_year_count: 0, active_classes: 0, sections: 0, classes_without_sections: 0, active_subjects: 0,
      teachers: 2, linked_teachers: 1, teaching_assignments: 0, sections_without_class_teacher: 0, enrolled_students: 0, invalid_enrollments: 0,
      linked_students: 0, pending_guardian_invitations: 4, today_attendance: 0 }, history: [], ...patch };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  mocks.access.mockResolvedValue({ userId: owner, schools: [{ id: schoolA, name: "QA School" }], schoolAdminIds: [schoolA] });
  mocks.load.mockImplementation(async () => snapshot());
  mocks.save.mockResolvedValue({ revision: 4, changed: true, replayed: false });
});
async function edit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Edit school details" }));
  fireEvent.change(screen.getByLabelText("School name"), { target: { value: "Updated QA School" } });
  await user.type(screen.getByLabelText("Change reason"), "School approved contact updates.");
}

describe("real school settings workspace", () => {
  it("opens import templates and pins fee onboarding to the selected school", async () => {
    const user = userEvent.setup();
    mocks.access.mockResolvedValue({ userId: owner, schools: [{ id: schoolA, name: "QA School" }, { id: schoolB, name: "Second QA School" }], schoolAdminIds: [schoolA, schoolB] });
    render(<SchoolSettingsWorkspace userId={owner} />);
    const picker = await screen.findByRole("combobox", { name: "School" });
    expect(screen.queryByText("Import school data")).not.toBeInTheDocument();
    await user.selectOptions(picker, schoolB);
    await user.click(screen.getByText("Import school data"));
    const imports = screen.getByText("Import school data").closest("details")!;
    expect(within(imports).getByText("Second QA School", { selector: "strong" })).toBeVisible();
    await user.click(screen.getByText("Export school data"));
    expect(screen.getByRole("link", { name: "Download archive" })).toHaveAttribute("href", `/api/school-data/export?school=${schoolB}`);
    expect(screen.getByRole("link", { name: "Open opening fee balances" })).toHaveAttribute("href", `/modules/fees?school=${schoolB}`);
    expect(screen.getByRole("link", { name: "Students CSV template" })).toHaveAttribute("download", "students-template.csv");
    act(() => mocks.auth.mock.calls[0][0]("SIGNED_OUT", null));
    expect(screen.queryByText("Import school data")).not.toBeInTheDocument();
  });

  it("loads live scope and renders honest setup gaps with canonical links", async () => {
    render(<SchoolSettingsWorkspace userId={owner} />);
    expect(await screen.findByRole("heading", { name: "School details" })).toBeInTheDocument();
    expect(mocks.access).toHaveBeenCalledWith(expect.anything(), "school settings", ["school_admin", "principal"]);
    expect(mocks.load).toHaveBeenCalledWith(expect.anything(), owner, schoolA, expect.any(AbortSignal));
    expect(screen.getByLabelText("School name")).toHaveValue("QA School");
    expect(screen.getByText("1 verified sign-in link / 2 teacher directory records")).toBeInTheDocument();
    expect(screen.getByText("0 students with a verified guardian link · 4 pending invitations")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open academic year" })).toHaveAttribute("href", "/modules/academics");
    expect(screen.getByRole("link", { name: "Open guardian access" })).toHaveAttribute("href", "/modules/guardian-invitations");
    expect(screen.getByText(/do not certify full onboarding/)).toBeInTheDocument();
    expect(screen.getByText("Timezone: UTC")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Calendar & daily attendance rules" })).toHaveAttribute("href", "#attendance-calendar");
    expect(screen.getByRole("region", { name: "School attendance calendar" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("keeps Principal/server-readonly access out of mutation and export controls", async () => {
    mocks.access.mockResolvedValue({ userId: owner, schools: [{ id: schoolA, name: "QA School" }], schoolAdminIds: [] });
    mocks.load.mockResolvedValue(snapshot({ can_edit: false }));
    render(<SchoolSettingsWorkspace userId={owner} />);
    await screen.findByText(/Read-only access/);
    expect(screen.getByLabelText("School name")).toBeDisabled();
    expect(screen.queryByText("Export school data")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit school details" })).not.toBeInTheDocument();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("removes stale settings and draft when a fresh permission check denies access", async () => {
    const user = userEvent.setup();
    mocks.load.mockResolvedValueOnce(snapshot()).mockRejectedValueOnce(new SchoolSettingsError("Your current account cannot manage settings for this school.", "access"));
    render(<SchoolSettingsWorkspace userId={owner} />); await edit(user);
    await user.click(screen.getByRole("button", { name: "Reload school settings" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("cannot manage settings");
    expect(screen.queryByLabelText("School name")).not.toBeInTheDocument();
    expect(screen.queryByText("Updated QA School")).not.toBeInTheDocument();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("clears the editing controls when a fresh snapshot becomes read-only", async () => {
    const user = userEvent.setup(); mocks.load.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot({ can_edit: false }));
    render(<SchoolSettingsWorkspace userId={owner} />); await edit(user);
    await user.click(screen.getByRole("button", { name: "Reload school settings" }));
    await screen.findByText(/Read-only access/);
    expect(screen.queryByLabelText("Change reason")).not.toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Save school details" })).not.toBeInTheDocument();
  });

  it("saves normalized scoped details with a reason and revision, then reloads the saved version", async () => {
    const user = userEvent.setup();
    const next = snapshot(); next.school = { ...next.school, name: "Updated QA School", revision: 4, address: "Line 1\nLine 2", email: "office@example.test" };
    mocks.load.mockResolvedValueOnce(snapshot()).mockResolvedValue(next);
    render(<SchoolSettingsWorkspace userId={owner} />);
    await edit(user);
    fireEvent.change(screen.getByLabelText("School address"), { target: { value: "Line 1\nLine 2" } });
    await user.type(screen.getByLabelText("School email"), "OFFICE@EXAMPLE.TEST");
    await user.click(screen.getByRole("button", { name: "Save school details" }));
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2));
    expect(mocks.save).toHaveBeenCalledWith(expect.anything(), owner, expect.objectContaining({ schoolId: schoolA, expectedRevision: 3, reason: "School approved contact updates.", requestId: expect.any(String), details: expect.objectContaining({ name: "Updated QA School", address: "Line 1\nLine 2", email: "office@example.test" }) }), expect.any(AbortSignal));
    expect(Object.keys(mocks.save.mock.calls[0][2].details)).toHaveLength(10);
    expect(await screen.findByText(/Revision 4/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Change reason")).not.toBeInTheDocument();
    expect(screen.getByLabelText("School name")).toHaveValue("Updated QA School");
  });

  it("holds an uncertain save fixed and retries the identical request instead of creating new work", async () => {
    const user = userEvent.setup();
    mocks.save.mockRejectedValueOnce(new SchoolSettingsError("The save could not be confirmed. Retry the same save to check its outcome."))
      .mockResolvedValueOnce({ revision: 4, changed: true, replayed: true });
    render(<SchoolSettingsWorkspace userId={owner} />); await edit(user);
    await user.click(screen.getByRole("button", { name: "Save school details" }));
    expect(await screen.findByRole("button", { name: "Retry same save" })).toBeEnabled();
    expect(screen.getByLabelText("School name")).toBeDisabled(); expect(screen.getByLabelText("Change reason")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Cancel editing" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload school settings" })).toBeDisabled();
    const first = mocks.save.mock.calls[0][2] as SchoolSettingsIntent;
    await user.click(screen.getByRole("button", { name: "Retry same save" }));
    expect(mocks.save.mock.calls[1][2]).toBe(first);
    expect(await screen.findByRole("status")).toHaveTextContent("previous save is confirmed");
  });

  it("retains conflict draft, compares latest settings, and requires explicit revision adoption before retry", async () => {
    const user = userEvent.setup(), latest = snapshot(); latest.school = { ...latest.school, name: "Other admin saved", revision: 4 };
    mocks.load.mockResolvedValueOnce(snapshot()).mockResolvedValue(latest);
    mocks.save.mockRejectedValueOnce(new SchoolSettingsError("School settings changed elsewhere. Your draft is kept; reload saved settings before trying again.", "conflict"))
      .mockResolvedValueOnce({ revision: 5, changed: true, replayed: false });
    render(<SchoolSettingsWorkspace userId={owner} />); await edit(user);
    await user.click(screen.getByRole("button", { name: "Save school details" }));
    const comparison = await screen.findByRole("region", { name: "Compare school settings conflict" });
    expect(screen.getByLabelText("School name")).toHaveValue("Updated QA School");
    expect(screen.getByRole("button", { name: "Save school details" })).toBeDisabled();
    await user.click(within(comparison).getByRole("button", { name: "Reload saved settings for comparison" }));
    expect(await within(comparison).findByText("Other admin saved", { exact: false })).toBeInTheDocument();
    await user.click(within(comparison).getByRole("button", { name: "Keep draft against latest revision" }));
    expect(screen.getByLabelText("School name")).toHaveValue("Updated QA School");
    await user.click(screen.getByRole("button", { name: "Save school details" }));
    expect(mocks.save.mock.calls[1][2]).toMatchObject({ expectedRevision: 4, details: { name: "Updated QA School" } });
    expect(mocks.save.mock.calls[1][2].requestId).not.toBe(mocks.save.mock.calls[0][2].requestId);
  });

  it("aborts and removes a pending account's data when Auth changes, ignoring its late acknowledgment", async () => {
    const pending = deferred<{ revision: number; changed: boolean; replayed: boolean }>();
    mocks.save.mockReturnValue(pending.promise);
    const user = userEvent.setup(); render(<SchoolSettingsWorkspace userId={owner} />); await edit(user);
    await user.click(screen.getByRole("button", { name: "Save school details" }));
    const signal = mocks.save.mock.calls[0][3] as AbortSignal;
    act(() => mocks.auth.mock.calls[0][0]("SIGNED_IN", { user: { id: id(9) } }));
    expect(signal.aborted).toBe(true); expect(screen.getByRole("alert")).toHaveTextContent("sign-in changed");
    expect(screen.queryByLabelText("School name")).not.toBeInTheDocument();
    await act(async () => pending.resolve({ revision: 4, changed: true, replayed: false }));
    expect(screen.queryByText(/School details saved/)).not.toBeInTheDocument();
  });

  it("ignores a previous school's late load after the selected school changes", async () => {
    mocks.access.mockResolvedValue({ userId: owner, schools: [{ id: schoolA, name: "QA School" }, { id: schoolB, name: "Second school" }], schoolAdminIds: [schoolA, schoolB] });
    const pending = deferred<SchoolSettings>();
    const second = snapshot(); second.school = { ...second.school, id: schoolB, name: "Second school" };
    mocks.load.mockImplementation(async (_client, _owner, school) => school === schoolA ? pending.promise : second);
    const user = userEvent.setup(); render(<SchoolSettingsWorkspace userId={owner} />);
    const selector = await screen.findByRole("combobox", { name: "School" });
    await user.selectOptions(selector, schoolA); const signal = mocks.load.mock.calls[0][3] as AbortSignal;
    await user.selectOptions(selector, schoolB);
    expect(await screen.findByLabelText("School name")).toHaveValue("Second school"); expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(snapshot()));
    expect(screen.getByLabelText("School name")).toHaveValue("Second school");
  });

  it("keeps a current year outside today's dates flagged for review and records-only attendance wording", async () => {
    const data = snapshot(); data.setup.current_year_count = 1; data.setup.current_year = { id: id(8), name: "Future session", start_date: "2027-04-01", end_date: "2028-03-31" }; data.setup.today_attendance = 2;
    mocks.load.mockResolvedValue(data); render(<SchoolSettingsWorkspace userId={owner} />);
    expect(await screen.findByText("Future session · 1 Apr 2027 to 31 Mar 2028 · Review dates")).toBeInTheDocument();
    expect(screen.getByText(/2 saved attendance records for 7 Nov 2026\. This count does not confirm all registers are complete/)).toBeInTheDocument();
  });

  it("allows same-user token refresh and rejects a mismatched access-load owner", async () => {
    const view = render(<SchoolSettingsWorkspace userId={owner} />); await screen.findByLabelText("School name");
    act(() => mocks.auth.mock.calls[0][0]("TOKEN_REFRESHED", { user: { id: owner } }));
    expect(screen.getByLabelText("School name")).toHaveValue("QA School"); view.unmount();
    mocks.access.mockResolvedValue({ userId: id(9), schools: [{ id: schoolA, name: "QA School" }] });
    render(<SchoolSettingsWorkspace userId={owner} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("sign-in changed");
    expect(screen.queryByLabelText("School name")).not.toBeInTheDocument();
  });
});
