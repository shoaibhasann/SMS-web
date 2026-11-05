import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdvanceCreditWorkspace } from "../components/finance/advance-credit-workspace";

const mocks = vi.hoisted(() => ({ pages: vi.fn(), getUser: vi.fn(), subscribe: vi.fn() }));
vi.mock("@/lib/attendance/repository", () => ({ readPages: mocks.pages }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { getUser: mocks.getUser, onAuthStateChange: mocks.subscribe } }) }));
vi.mock("@/components/finance/advance-credit-account", () => ({
  AdvanceCreditAccount: ({ schoolId, studentId, canReview, onLockChange }: { schoolId: string; studentId: string; canReview: boolean; onLockChange: (locked: boolean) => void }) =>
    <section aria-label="Scoped advance account">{schoolId} {studentId} {canReview ? "review allowed" : "review denied"}<button type="button" onClick={() => onLockChange(true)}>Start unknown operation</button></section>,
}));
let roles: { role: string; school_id: string | null }[];
let schools: { id: string; name: string }[];
let changed: (event: string, session: { user: { id: string } } | null) => void;
const student = { id: "student-a", admission_no: "QA-1", first_name: "QA", middle_name: null, last_name: "Student", status: "active" };

beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear();
  roles = [{ role: "accountant", school_id: "school-a" }, { role: "principal", school_id: "school-b" }];
  schools = [{ id: "school-a", name: "School A" }, { id: "school-b", name: "School B" }];
  mocks.getUser.mockResolvedValue({ data: { user: { id: "actor" } }, error: null });
  mocks.subscribe.mockImplementation((callback) => { changed = callback; return { data: { subscription: { unsubscribe: vi.fn() } } }; });
  mocks.pages.mockImplementation((_query, description) => Promise.resolve(description === "Finance access" ? roles : description === "Authorized schools" ? schools : [student]));
});

describe("office advance-credit scope resolution", () => {
  it("requires an explicit school and uses reviewer permissions from that same school only", async () => {
    render(<AdvanceCreditWorkspace userId="actor" />);
    const school = await screen.findByRole("combobox", { name: "Credit school" });
    expect(school).toHaveValue("");
    fireEvent.change(school, { target: { value: "school-a" } });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Credit student" })).toBeEnabled());
    fireEvent.change(screen.getByRole("combobox", { name: "Credit student" }), { target: { value: "student-a" } });
    expect(await screen.findByRole("region", { name: "Scoped advance account" })).toHaveTextContent("school-a student-a review denied");
    fireEvent.change(school, { target: { value: "school-b" } });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Credit student" })).toBeEnabled());
    fireEvent.change(screen.getByRole("combobox", { name: "Credit student" }), { target: { value: "student-a" } });
    expect(await screen.findByRole("region", { name: "Scoped advance account" })).toHaveTextContent("school-b student-a review allowed");
  });

  it("restores the authorized student context for saved-operation recovery and locks scope while unresolved", async () => {
    sessionStorage.setItem("kids-corner-advance-context:v1:actor", JSON.stringify({ schoolId: "school-a", studentId: "student-a" }));
    render(<AdvanceCreditWorkspace userId="actor" />);
    await screen.findByRole("region", { name: "Scoped advance account" });
    fireEvent.click(screen.getByRole("button", { name: "Start unknown operation" }));
    expect(screen.getByRole("combobox", { name: "Credit school" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Credit student" })).toBeDisabled();
    expect(screen.getByRole("searchbox", { name: "Find student" })).toBeDisabled();
  });

  it.each(["teacher", "parent", "student", "reception_staff"])("does not resolve office data for a %s role", async (role) => {
    roles = [{ role, school_id: "school-a" }];
    render(<AdvanceCreditWorkspace userId="actor" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Admin, Principal or Finance role is required");
    expect(mocks.pages.mock.calls.map((call) => call[1])).toEqual(["Finance access"]);
    expect(screen.queryByRole("combobox", { name: "Credit student" })).not.toBeInTheDocument();
  });

  it("does not restore a previous school after that school is removed from authorized access", async () => {
    roles = [{ role: "accountant", school_id: "school-a" }]; schools = [schools[0]];
    sessionStorage.setItem("kids-corner-advance-context:v1:actor", JSON.stringify({ schoolId: "old-school", studentId: "student-a" }));
    render(<AdvanceCreditWorkspace userId="actor" />);
    expect(await screen.findByRole("combobox", { name: "Credit school" })).toHaveValue("school-a");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Credit student" })).toBeEnabled());
    expect(screen.getByRole("combobox", { name: "Credit student" })).toHaveValue("");
    expect(screen.queryByRole("region", { name: "Scoped advance account" })).not.toBeInTheDocument();
  });

  it("hides the previous school and selected child immediately when the account changes", async () => {
    sessionStorage.setItem("kids-corner-advance-context:v1:actor", JSON.stringify({ schoolId: "school-a", studentId: "student-a" }));
    render(<AdvanceCreditWorkspace userId="actor" />);
    await screen.findByRole("region", { name: "Scoped advance account" });
    act(() => changed("SIGNED_IN", { user: { id: "other-user" } }));
    expect(screen.getByRole("alert")).toHaveTextContent("Your sign-in changed");
    expect(screen.queryByRole("region", { name: "Scoped advance account" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Credit school" })).not.toBeInTheDocument();
  });
});
