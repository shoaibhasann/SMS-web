import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ParentDirectoryWorkspace } from "../components/admin/parent-directory-workspace";
import { StudentRosterWorkspace } from "../components/admin/student-roster-workspace";

const api = vi.hoisted(() => {
  class WriteError extends Error { constructor(message: string, readonly code = "unconfirmed") { super(message); } }
  return { client: {}, listeners: new Set<(event: string, session: { user: { id: string } } | null) => void>(),
    access: vi.fn(), setup: vi.fn(), enrolled: vi.fn(), directory: vi.fn(), admit: vi.fn(), WriteError,
    placementHistory: vi.fn(), withdrawalHistory: vi.fn(), import: vi.fn() };
});
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ ...api.client, auth: { onAuthStateChange(callback: (event: string, session: { user: { id: string } } | null) => void) {
  api.listeners.add(callback); return { data: { subscription: { unsubscribe() { api.listeners.delete(callback); } } } };
} } }) }));
vi.mock("@/lib/attendance/repository", () => ({ loadSchoolManagementAccess: api.access, loadAdminAttendanceSetup: api.setup, loadEnrolledStudents: api.enrolled }));
vi.mock("@/lib/guardian-invitations/directory", () => ({ loadGuardianDirectory: api.directory }));
vi.mock("@/lib/students/roster", () => ({ admitRosterStudent: api.admit, RosterWriteError: api.WriteError }));
vi.mock("@/components/admin/student-roster-import", () => ({ StudentRosterImport: (props: unknown) => { api.import(props); return <p>Reviewed student CSV import</p>; } }));
vi.mock("@/components/admin/student-roster-placements", () => ({ StudentPlacementDialog: () => null, StudentPlacementHistory: () => { api.placementHistory(); return <p>Placement history</p>; } }));
vi.mock("@/components/admin/student-roster-withdrawals", () => ({ StudentWithdrawalDialog: () => null, StudentWithdrawalHistory: () => { api.withdrawalHistory(); return <p>Withdrawal history</p>; } }));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const userId = id(1), schoolId = id(2), secondSchool = id(3), yearId = id(4), classId = id(5), sectionId = id(6);
const guardian = (n: number) => ({ id: id(10 + n), name: `Guardian ${n}`, code: `G-${n}`, mobile: n ? null : "+919876543210", account: "active" as const,
  children: [{ id: id(100 + n), name: `Child ${n}`, admissionNumber: `ADM-${n}`, status: "active", relationship: "Mother", primary: true }] });
const student = { id: id(100), first_name: "Existing pupil", middle_name: null, last_name: null, admission_no: "ADM-EXISTING", roll_no: "1", enrollment_id: id(200) };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function authChange() { for (const callback of api.listeners) callback("SIGNED_OUT", null); }
const showModal = HTMLDialogElement.prototype.showModal;

beforeEach(() => {
  vi.clearAllMocks(); api.listeners.clear(); window.localStorage.clear();
  api.access.mockResolvedValue({ userId, schools: [{ id: schoolId, name: "School A" }], schoolAdminIds: [schoolId] });
  api.directory.mockResolvedValue([guardian(0), guardian(1)]);
  api.setup.mockResolvedValue({ year: { id: yearId, name: "Current year", start_date: "2026-04-01", end_date: "2027-03-31", is_current: true }, years: [],
    classes: [{ id: classId, name: "Grade 6" }], sections: [{ id: sectionId, name: "A", class_id: classId }] });
  api.enrolled.mockResolvedValue([student]); api.admit.mockResolvedValue(id(300));
  // jsdom has no modal dialogs: open it and let close() fire the close event like a browser.
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
    this.close = () => { this.open = false; this.dispatchEvent(new Event("close")); };
  };
});
afterEach(() => { HTMLDialogElement.prototype.showModal = showModal; });

describe("real school guardian directory", () => {
  it("ignores old browser demo records and searches real child/admission/mobile records without edit controls", async () => {
    window.localStorage.setItem("kids-corner-admin-demo:parents", JSON.stringify([{ name: "Browser-only parent" }]));
    render(<ParentDirectoryWorkspace userId={userId} />);
    expect(await screen.findByRole("heading", { name: "Guardian 0" })).toBeInTheDocument();
    expect(screen.queryByText("Browser-only parent")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage guardian access" })).toHaveAttribute("href", "/modules/guardian-invitations");
    fireEvent.change(screen.getByRole("textbox", { name: "Search guardians" }), { target: { value: "ADM-1" } });
    expect(screen.getByRole("heading", { name: "Guardian 1" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Guardian 0" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit|delete|revoke|approve/i })).not.toBeInTheDocument();
    expect(api.directory.mock.calls[0].slice(1, 3)).toEqual([userId, schoolId]);
  });

  it("keeps Principal read-only and searches beyond the rendered 24-record page", async () => {
    api.access.mockResolvedValue({ userId, schools: [{ id: schoolId, name: "School A" }], schoolAdminIds: [] });
    api.directory.mockResolvedValue(Array.from({ length: 25 }, (_, n) => guardian(n)));
    render(<ParentDirectoryWorkspace userId={userId} />);
    expect(await screen.findByText("25 guardian records")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Manage guardian access" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Guardian 24" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next guardians" }));
    expect(screen.getByRole("heading", { name: "Guardian 24" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Search guardians" }), { target: { value: "ADM-0" } });
    expect(screen.getByRole("heading", { name: "Guardian 0" })).toBeInTheDocument();
  });

  it("aborts and discards a late previous-school result", async () => {
    const pending = deferred<ReturnType<typeof guardian>[]>();
    api.access.mockResolvedValue({ userId, schools: [{ id: schoolId, name: "School A" }, { id: secondSchool, name: "School B" }], schoolAdminIds: [schoolId, secondSchool] });
    api.directory.mockImplementation((_client, _user, school) => school === schoolId ? pending.promise : Promise.resolve([{ ...guardian(2), name: "School B Guardian" }]));
    render(<ParentDirectoryWorkspace userId={userId} />);
    fireEvent.change(await screen.findByRole("combobox", { name: "School" }), { target: { value: schoolId } });
    await waitFor(() => expect(api.directory).toHaveBeenCalledTimes(1));
    const oldSignal = api.directory.mock.calls[0][3] as AbortSignal;
    fireEvent.change(screen.getByRole("combobox", { name: "School" }), { target: { value: secondSchool } });
    expect(await screen.findByRole("heading", { name: "School B Guardian" })).toBeInTheDocument();
    expect(oldSignal.aborted).toBe(true);
    await act(async () => { pending.resolve([guardian(0)]); await pending.promise; });
    expect(screen.queryByRole("heading", { name: "Guardian 0" })).not.toBeInTheDocument();
  });

  it("clears private rows and aborts an in-flight refresh when the account changes", async () => {
    const pending = deferred<ReturnType<typeof guardian>[]>();
    render(<ParentDirectoryWorkspace userId={userId} />);
    await screen.findByRole("heading", { name: "Guardian 0" });
    api.directory.mockReturnValue(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Refresh guardians" }));
    await waitFor(() => expect(api.directory).toHaveBeenCalledTimes(2));
    const signal = api.directory.mock.calls[1][3] as AbortSignal;
    act(authChange);
    expect(screen.getByRole("alert")).toHaveTextContent("Your account changed");
    expect(signal.aborted).toBe(true);
    await act(async () => { pending.resolve([guardian(0)]); await pending.promise; });
    expect(screen.queryByText("Guardian 0")).not.toBeInTheDocument();
  });

  it("does not keep a stale directory when the same account loses office authority", async () => {
    render(<ParentDirectoryWorkspace userId={userId} />);
    await screen.findByRole("heading", { name: "Guardian 0" });
    api.directory.mockRejectedValueOnce(new Error("A current School Admin or Principal role is required to view this guardian directory."));
    fireEvent.click(screen.getByRole("button", { name: "Refresh guardians" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("current School Admin or Principal");
    expect(screen.queryByRole("heading", { name: "Guardian 0" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Guardian 1" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Manage guardian access" })).not.toBeInTheDocument();
  });
});

describe("dedicated real admissions view", () => {
  async function open() {
    render(<StudentRosterWorkspace userId={userId} view="admissions" />);
    expect(screen.queryByRole("textbox", { name: "Admission number" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Admit a student" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Admit a student" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Admission number" })).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox", { name: "Admission number" }), { target: { value: "ADM-NEW" } });
    fireEvent.change(screen.getByRole("textbox", { name: "First name" }), { target: { value: "New pupil" } });
    expect(screen.getByRole("button", { name: "Admit student" })).toBeEnabled();
  }

  it("reuses the saved admission/register/CSV workflow and omits fabricated enquiry stages and placement/withdrawal controls", async () => {
    await open();
    expect(screen.getByRole("heading", { name: "Admissions" })).toBeInTheDocument();
    expect(screen.getByText("Existing pupil")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /withdraw|change placement|promote|approve|reject/i })).not.toBeInTheDocument();
    expect(api.placementHistory).not.toHaveBeenCalled(); expect(api.withdrawalHistory).not.toHaveBeenCalled();
    expect(api.import).toHaveBeenLastCalledWith(expect.objectContaining({ ownerUserId: userId, context: { schoolId, academicYearId: yearId, classId, sectionId } }));
    fireEvent.click(screen.getByRole("button", { name: "Admit student" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Student admitted and enrolled");
    expect(api.admit).toHaveBeenCalledWith(expect.anything(), { schoolId, academicYearId: yearId, classId, sectionId },
      { admissionNumber: "ADM-NEW", firstName: "New pupil", lastName: "" }, { userId, signal: expect.any(AbortSignal) });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Admission number", hidden: true })).toHaveValue("");
    await waitFor(() => expect(api.enrolled).toHaveBeenCalledTimes(2));
  });

  it("requires a successful roster reconciliation after an unknown write result without discarding the original draft", async () => {
    api.admit.mockRejectedValueOnce(new api.WriteError("Admission could not be confirmed"));
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Admit student" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Admission could not be confirmed");
    expect(screen.getByRole("button", { name: "Admit student" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Admission number" })).toHaveValue("ADM-NEW");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("button", { name: "Admit a student" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Reload roster" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Admit a student" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Admit a student" }));
    expect(screen.getByRole("button", { name: "Admit student" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Admission number" })).toHaveValue("ADM-NEW");
    expect(api.admit).toHaveBeenCalledTimes(1);
  });

  it("keeps known validation failures retryable without requiring reconciliation", async () => {
    api.admit.mockRejectedValueOnce(new api.WriteError("Check the name", "validation"));
    await open(); fireEvent.click(screen.getByRole("button", { name: "Admit student" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Check the name");
    expect(screen.getByRole("button", { name: "Admit student" })).toBeEnabled();
  });

  it("aborts and clears an old account's pending admission without applying a late success", async () => {
    const pending = deferred<string>(); api.admit.mockReturnValueOnce(pending.promise);
    await open(); fireEvent.click(screen.getByRole("button", { name: "Admit student" }));
    const signal = api.admit.mock.calls[0][3].signal as AbortSignal;
    act(authChange);
    expect(screen.getByRole("alert")).toHaveTextContent("Your account changed");
    expect(signal.aborted).toBe(true);
    await act(async () => { pending.resolve(id(300)); await pending.promise; });
    expect(screen.queryByText("Student admitted and enrolled.")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Admission number" })).not.toBeInTheDocument();
  });

  it("opens admission and CSV import as modal dialogs from links and holds the import dialog while its save is unresolved", async () => {
    render(<StudentRosterWorkspace userId={userId} />);
    expect(await screen.findByText("Existing pupil")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Admit a student" }));
    const admit = screen.getByRole("dialog", { name: "Admit a student" });
    expect(within(admit).getByRole("textbox", { name: "First name" })).toBeEnabled();
    fireEvent.click(within(admit).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Import students from CSV" }));
    const upload = screen.getByRole("dialog", { name: "Import students from CSV" });
    expect(within(upload).getByText("Reviewed student CSV import")).toBeInTheDocument();
    const { onBusyChange } = api.import.mock.calls[0][0] as { onBusyChange: (busy: boolean) => void };
    act(() => onBusyChange(true));
    expect(within(upload).getByRole("button", { name: "Close" })).toBeDisabled();
    expect(fireEvent(upload, new Event("cancel", { cancelable: true }))).toBe(false);
    expect(screen.getByRole("button", { name: "Admit a student" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Import students from CSV" })).toBeEnabled();
    expect((api.import.mock.lastCall?.[0] as { onBusyChange: unknown }).onBusyChange).toBe(onBusyChange);
    act(() => onBusyChange(false));
    fireEvent.click(within(upload).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("preserves full placement/withdrawal controls in the existing Students view", async () => {
    render(<StudentRosterWorkspace userId={userId} />);
    expect(await screen.findByRole("button", { name: "Change placement for Existing pupil" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Withdraw Existing pupil" })).toBeInTheDocument();
    expect(api.placementHistory).toHaveBeenCalled(); expect(api.withdrawalHistory).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Promote this section" })).not.toBeInTheDocument();
  });

  it("offers a whole-section promotion in the Students view once a later academic year exists", async () => {
    const year = { id: yearId, name: "Current year", start_date: "2026-04-01", end_date: "2027-03-31", is_current: true };
    api.setup.mockResolvedValue({ year, years: [year, { id: id(7), name: "Next year", start_date: "2027-04-01", end_date: "2028-03-31", is_current: false }],
      classes: [{ id: classId, name: "Grade 6" }], sections: [{ id: sectionId, name: "A", class_id: classId }] });
    render(<StudentRosterWorkspace userId={userId} />);
    expect(await screen.findByRole("button", { name: "Change placement for Existing pupil" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Promote this section" })).toBeEnabled();
  });
  it("retries failed access and class setup reads in place without a page reload", async () => {
    api.access.mockRejectedValueOnce(new Error("Network offline"));
    api.setup.mockRejectedValueOnce(new Error("Classes offline"));
    render(<StudentRosterWorkspace userId={userId} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Network offline");
    expect(screen.getByRole("alert")).toHaveClass("text-danger");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Classes offline");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Change placement for Existing pupil" })).toBeInTheDocument();
    expect(api.access).toHaveBeenCalledTimes(2); expect(api.setup).toHaveBeenCalledTimes(2);
  });
});
