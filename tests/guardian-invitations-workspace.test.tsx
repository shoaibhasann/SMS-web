import type { ReactNode } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ModulePage from "../app/(dashboard)/modules/[module]/page";
import { GuardianInvitationsWorkspace } from "../components/admin/guardian-invitations-workspace";
import type { GuardianInvitation } from "../lib/guardian-invitations/admin";

type Row = Record<string, string | boolean | null>;
type AuthListener = (event: string, session: { user: { id: string } } | null) => void;

const { getUser, from, rpc, onAuthStateChange, client } = vi.hoisted(() => {
  const getUser = vi.fn();
  const from = vi.fn();
  const rpc = vi.fn();
  const onAuthStateChange = vi.fn();
  return { getUser, from, rpc, onAuthStateChange, client: { from, rpc, auth: { getUser, onAuthStateChange } } };
});

vi.mock("next/navigation", () => ({
  useParams: () => ({ module: "guardian-invitations" }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => client }));
vi.mock("@/components/layout/app-shell", () => ({
  AppShell: ({ role, children }: { role: string; children: ReactNode }) => <main aria-label={role}>{children}</main>,
}));

const actorId = "school-principal";
const token = "a".repeat(64);
const guardianEmail = "family@example.test";
const invite = { id: "invite-one", token, expires_at: "2099-11-07T12:00:00Z" };
let invitations: GuardianInvitation[];
let rows: Record<string, Row[]>;
let changeAuth: AuthListener;

beforeEach(() => {
  vi.clearAllMocks();
  invitations = [];
  rows = {
    user_roles: [
      { id: "role-1", user_id: actorId, school_id: "north", role: "principal" },
      { id: "role-2", user_id: actorId, school_id: "south", role: "teacher" },
    ],
    schools: [{ id: "north", name: "North School" }, { id: "south", name: "South School" }],
    academic_years: [
      { id: "north-year", school_id: "north", name: "2026–27", is_current: true },
      { id: "south-year", school_id: "south", name: "2026–27", is_current: true },
    ],
    classes: [
      { id: "north-six", school_id: "north", name: "Class 6" },
      { id: "south-six", school_id: "south", name: "Class 6" },
    ],
    sections: [
      { id: "north-six-a", school_id: "north", class_id: "north-six", name: "6A" },
      { id: "south-six-a", school_id: "south", class_id: "south-six", name: "6A" },
    ],
    enrollments: [
      { id: "enrollment-1", student_id: "one", academic_year_id: "north-year", class_id: "north-six", section_id: "north-six-a", status: "active" },
      { id: "enrollment-2", student_id: "two", academic_year_id: "north-year", class_id: "north-six", section_id: "north-six-a", status: "withdrawn" },
      { id: "enrollment-3", student_id: "three", academic_year_id: "south-year", class_id: "south-six", section_id: "south-six-a", status: "active" },
      { id: "enrollment-4", student_id: "four", academic_year_id: "north-year", class_id: "north-six", section_id: "north-six-a", status: "active" },
    ],
    students: [
      { id: "one", school_id: "north", first_name: "Pupil One", admission_no: "QA-001", status: "active" },
      { id: "two", school_id: "north", first_name: "Pupil Two", admission_no: "QA-002", status: "active" },
      { id: "three", school_id: "south", first_name: "Pupil Three", admission_no: "QA-003", status: "active" },
      { id: "four", school_id: "north", first_name: "Pupil Four", admission_no: "QA-004", status: "inactive" },
    ],
  };
  getUser.mockResolvedValue({ data: { user: { id: actorId } }, error: null });
  onAuthStateChange.mockImplementation((listener: AuthListener) => {
    changeAuth = listener;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
  from.mockImplementation((table: string) => {
    if (!rows[table]) throw new Error(`Unexpected read from ${table}`);
    const predicates: ((row: Row) => boolean)[] = [];
    return {
      select() { return this; },
      order() { return this; },
      eq(column: string, value: Row[string]) {
        predicates.push((row) => row[column] === value);
        return this;
      },
      in(column: string, values: Row[string][]) {
        predicates.push((row) => values.includes(row[column]));
        return this;
      },
      async range(start: number, end: number) {
        const matches = rows[table].filter((row) => predicates.every((predicate) => predicate(row)));
        return { data: matches.slice(start, end + 1), count: matches.length, error: null };
      },
      then(resolve: (result: { data: Row[]; error: null }) => void) {
        resolve({ data: rows[table].filter((row) => predicates.every((predicate) => predicate(row))), error: null });
      },
    };
  });
  rpc.mockImplementation(async (fn: string) => {
    if (fn === "list_guardian_invitations") return { data: invitations, error: null };
    if (fn === "issue_guardian_invitation") {
      invitations = [{ id: invite.id, email: guardianEmail, expires_at: invite.expires_at, created_at: "2099-11-04T12:00:00Z", accepted_at: null, revoked_at: null }];
      return { data: invite, error: null };
    }
    if (fn === "revoke_guardian_invitation") {
      invitations = invitations.map((item) => ({ ...item, revoked_at: "2099-11-04T14:00:00Z" }));
      return { data: true, error: null };
    }
    throw new Error(`Unexpected RPC ${fn}`);
  });
});

describe("guardian invitation administration", () => {
  it("issues and revokes a single-use link from the principal's scoped roster", async () => {
    const user = userEvent.setup();
    render(<ModulePage />);
    expect(await screen.findByRole("main", { name: "principal" })).toBeInTheDocument();
    const school = await screen.findByRole("combobox", { name: "School" });
    expect(school).toHaveValue("north");
    expect(within(school).queryByRole("option", { name: "South School" })).not.toBeInTheDocument();
    const student = await screen.findByRole("combobox", { name: "Student" });
    expect(within(student).getAllByRole("option").map((item) => item.textContent)).toEqual([
      "Select student",
      "Pupil One · QA-001",
    ]);

    await user.selectOptions(student, "one");
    await user.type(screen.getByRole("textbox", { name: "Guardian email" }), "Family@Example.Test");
    await user.click(screen.getByRole("button", { name: "Create invitation" }));
    expect(rpc).toHaveBeenCalledWith("issue_guardian_invitation", {
      p_school_id: "north", p_student_id: "one", p_email: guardianEmail,
    });

    const link = await screen.findByRole("textbox", { name: "Invitation link" });
    const expectedUrl = `${window.location.origin}/guardian-invite#token=${token}`;
    expect(link).toHaveValue(expectedUrl);
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(await navigator.clipboard.readText()).toBe(expectedUrl);

    await user.click(await screen.findByRole("button", { name: `Revoke invitation for ${guardianEmail}` }));
    expect(rpc).not.toHaveBeenCalledWith("revoke_guardian_invitation", expect.anything());
    await user.click(screen.getByRole("button", { name: "Confirm revoke" }));
    expect(rpc).toHaveBeenCalledWith("revoke_guardian_invitation", { p_invitation_id: "invite-one" });
    expect(await screen.findByText(/Revoked · Expires/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Invitation link" })).not.toBeInTheDocument();
  });

  it("suppresses a second submission and clears the scoped view on sign-out", async () => {
    const user = userEvent.setup();
    let finishIssue!: (value: { data: typeof invite; error: null }) => void;
    const issuance = new Promise<{ data: typeof invite; error: null }>((resolve) => { finishIssue = resolve; });
    rpc.mockImplementation((fn: string) => {
      if (fn === "list_guardian_invitations") return Promise.resolve({ data: [], error: null });
      if (fn === "issue_guardian_invitation") return issuance;
      throw new Error(`Unexpected RPC ${fn}`);
    });
    render(<GuardianInvitationsWorkspace userId={actorId} />);
    const student = await screen.findByRole("combobox", { name: "Student" });
    await user.selectOptions(student, "one");
    await user.type(screen.getByRole("textbox", { name: "Guardian email" }), guardianEmail);
    const form = screen.getByRole("button", { name: "Create invitation" }).closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(rpc.mock.calls.filter(([name]) => name === "issue_guardian_invitation")).toHaveLength(1);
    expect(student).toBeDisabled();

    act(() => changeAuth("SIGNED_OUT", null));
    await act(async () => finishIssue({ data: invite, error: null }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your account changed");
    expect(screen.queryByRole("combobox", { name: "Student" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Invitation link" })).not.toBeInTheDocument();
  });

  it("blocks direct access for non-management roles", async () => {
    rows.user_roles = [{ id: "role-1", user_id: actorId, school_id: "north", role: "parent" }];
    render(<ModulePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your role does not allow access");
    expect(rpc).not.toHaveBeenCalled();
  });
});
