import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TeachingAssignmentManager } from "../components/academic/teaching-assignment-manager";
import type { AssignmentAccess, AssignmentData, TeachingAssignmentRepository, TeachingAssignmentRow } from "../lib/assignments/repository";
import { canAccessModule, getAdminNavigationModules, getTeacherNavigationModules, getVisibleModules } from "../lib/modules";

const row: TeachingAssignmentRow = { id: "assignment", teacher_id: "teacher", academic_year_id: "year", class_id: "class", section_id: "section", subject_id: "subject", is_class_teacher: false };
const data: AssignmentData = { year: { id: "year", name: "2026" }, teachers: [{ id: "teacher", name: "Teacher A" }],
  classes: [{ id: "class", name: "Class 1" }, { id: "class-2", name: "Class 2" }],
  sections: [{ id: "section", class_id: "class", name: "Section A" }, { id: "section-2", class_id: "class-2", name: "Section B" }],
  subjects: [{ id: "subject", name: "Mathematics" }], rows: [row],
};
const access: AssignmentAccess = { userId: "user", schools: [{ id: "a", name: "School A", canManage: true, teacherId: null }] };
function repository(value: AssignmentAccess = access): TeachingAssignmentRepository {
  return { access: vi.fn().mockResolvedValue(value), load: vi.fn().mockResolvedValue(data), save: vi.fn().mockResolvedValue(undefined), remove: vi.fn().mockResolvedValue(undefined) };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(await screen.findByRole("combobox", { name: "Teacher" }), "teacher");
  await user.selectOptions(screen.getByRole("combobox", { name: "Class" }), "class");
  await user.selectOptions(screen.getByRole("combobox", { name: "Section" }), "section");
  await user.selectOptions(screen.getByRole("combobox", { name: "Subject" }), "subject");
}

describe("teacher assignments are read-only", () => {
  it("shows a teacher's assigned work without self-assignment controls", async () => {
    const repo = repository({ userId: "teacher-user", schools: [{ id: "a", name: "School A", canManage: false, teacherId: "teacher" }] });
    render(<TeachingAssignmentManager repository={repo} />);
    await screen.findByRole("cell", { name: "Mathematics" });
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add Assignment|Edit|Remove/i })).not.toBeInTheDocument();
    expect(screen.getByText(/administrator or principal manages/)).toBeInTheDocument();
    expect(repo.save).not.toHaveBeenCalled(); expect(repo.remove).not.toHaveBeenCalled();
  });
  it("gives an unassigned teacher a clear administrator handoff", async () => {
    const repo = repository({ userId: "user", schools: [{ ...access.schools[0], canManage: false, teacherId: "teacher" }] });
    vi.mocked(repo.load).mockResolvedValue({ ...data, rows: [] });
    render(<TeachingAssignmentManager repository={repo} />);
    expect(await screen.findByText(/No teaching assignments found. Contact your school administrator/)).toBeInTheDocument();
  });
});

describe("administrator and principal assignment workflow", () => {
  it("saves chosen scope and class-teacher duty, then reloads confirmed data", async () => {
    const user = userEvent.setup(); const repo = repository();
    render(<TeachingAssignmentManager repository={repo} />);
    await fill(user); await user.click(screen.getByRole("checkbox", { name: "Mark as class teacher" }));
    await user.click(screen.getByRole("button", { name: "Add Assignment" }));
    await screen.findByText("Teaching assignment added.");
    expect(repo.save).toHaveBeenCalledWith("a", "year", { teacher_id: "teacher", class_id: "class", section_id: "section", subject_id: "subject", is_class_teacher: true }, null);
    await waitFor(() => expect(repo.load).toHaveBeenCalledTimes(2));
  });
  it("keeps failed draft values and focuses an announced error without a success message", async () => {
    const user = userEvent.setup(); const repo = repository(); vi.mocked(repo.save).mockRejectedValue(new Error("No successful save was confirmed. Refresh before retrying."));
    render(<TeachingAssignmentManager repository={repo} />); await fill(user);
    await user.click(screen.getByRole("button", { name: "Add Assignment" }));
    expect(await screen.findByRole("alert")).toHaveFocus();
    expect(screen.getByRole("combobox", { name: "Teacher" })).toHaveValue("teacher");
    expect(screen.queryByText("Teaching assignment added.")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "School" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Cancel assignment" }));
    expect(screen.getByRole("combobox", { name: "School" })).toBeEnabled();
  });
  it("guards immediate duplicate submission and locks form/school while saving", async () => {
    const user = userEvent.setup(); const repo = repository(); const pending = deferred<void>(); vi.mocked(repo.save).mockReturnValue(pending.promise);
    render(<TeachingAssignmentManager repository={repo} />); await fill(user);
    const form = screen.getByRole("form", { name: "Teaching assignment" }); fireEvent.submit(form); fireEvent.submit(form);
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("combobox", { name: "Teacher" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "School" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh assignments" })).toBeDisabled();
    await act(async () => { pending.resolve(); await pending.promise; });
    await screen.findByText("Teaching assignment added.");
  });
  it("passes the loaded record when editing so the adapter can detect concurrent changes", async () => {
    const user = userEvent.setup(); const repo = repository(); render(<TeachingAssignmentManager repository={repo} />);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("checkbox", { name: "Mark as class teacher" }));
    await user.click(screen.getByRole("button", { name: "Update Assignment" }));
    await screen.findByText("Teaching assignment updated.");
    expect(vi.mocked(repo.save).mock.calls[0][3]).toEqual(row);
  });
  it("clears the section when class changes and only lists that class's sections", async () => {
    const user = userEvent.setup(); render(<TeachingAssignmentManager repository={repository()} />); await fill(user);
    await user.selectOptions(screen.getByRole("combobox", { name: "Class" }), "class-2");
    expect(screen.getByRole("combobox", { name: "Section" })).toHaveValue("");
    expect(screen.queryByRole("option", { name: "Section A" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Section B" })).toBeInTheDocument();
  });
  it("requires removal confirmation and keeps the assignment when removal is not confirmed by the server", async () => {
    const user = userEvent.setup(); const repo = repository(); vi.mocked(repo.remove).mockRejectedValue(new Error("No removal was confirmed. Refresh before retrying."));
    render(<TeachingAssignmentManager repository={repo} />);
    await user.click(await screen.findByRole("button", { name: "Remove" })); expect(repo.remove).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm remove" }));
    await screen.findByRole("alert"); expect(screen.getByRole("cell", { name: "Mathematics" })).toBeInTheDocument();
    expect(screen.queryByText("Teaching assignment removed.")).not.toBeInTheDocument(); expect(repo.remove).toHaveBeenCalledWith("a", row);
  });
  it("keeps a successful write separate from a subsequent reload failure", async () => {
    const user = userEvent.setup(); const repo = repository(); vi.mocked(repo.load).mockResolvedValueOnce(data).mockRejectedValue(new Error("Assignments could not be reloaded."));
    render(<TeachingAssignmentManager repository={repo} />); await fill(user);
    await user.click(screen.getByRole("button", { name: "Add Assignment" }));
    await screen.findByText("Teaching assignment added."); expect(await screen.findByRole("alert")).toHaveTextContent("could not be reloaded");
    expect(screen.queryByRole("cell", { name: "Mathematics" })).not.toBeInTheDocument();
  });
});

describe("access and request lifecycle", () => {
  it("ignores an old school's slow response after another authorized scope is chosen", async () => {
    const user = userEvent.setup(); const old = deferred<AssignmentData>();
    const repo = repository({ userId: "user", schools: [access.schools[0], { id: "b", name: "School B", canManage: false, teacherId: "teacher" }] });
    vi.mocked(repo.load).mockImplementation((school) => school.id === "a" ? old.promise : Promise.resolve({ ...data, subjects: [{ id: "subject", name: "School B Math" }] }));
    render(<TeachingAssignmentManager repository={repo} />);
    const select = await screen.findByRole("combobox", { name: "School" });
    await user.selectOptions(select, "a"); await user.selectOptions(select, "b");
    await screen.findByRole("cell", { name: "School B Math" });
    await act(async () => { old.resolve(data); await old.promise; });
    expect(screen.getByRole("cell", { name: "School B Math" })).toBeInTheDocument(); expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });
  it("shows permission failures without exposing a management form", async () => {
    const repo = repository(); vi.mocked(repo.access).mockRejectedValue(new Error("School access is unavailable."));
    render(<TeachingAssignmentManager repository={repo} />); expect(await screen.findByRole("alert")).toHaveTextContent("School access is unavailable");
    expect(screen.queryByRole("form")).not.toBeInTheDocument(); expect(repo.load).not.toHaveBeenCalled();
  });
  it("identifies missing real school masters instead of offering browser demo records", async () => {
    const repo = repository(); vi.mocked(repo.load).mockResolvedValue({ ...data, teachers: [], rows: [] });
    render(<TeachingAssignmentManager repository={repo} />); expect(await screen.findByText(/School setup is incomplete/)).toBeInTheDocument(); expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });
  it("does not refresh or update an unmounted manager after its pending save completes", async () => {
    const user = userEvent.setup(); const repo = repository(); const pending = deferred<void>(); vi.mocked(repo.save).mockReturnValue(pending.promise);
    const view = render(<TeachingAssignmentManager repository={repo} />); await fill(user);
    fireEvent.submit(screen.getByRole("form", { name: "Teaching assignment" })); view.unmount();
    await act(async () => { pending.resolve(); await pending.promise; }); expect(repo.load).toHaveBeenCalledTimes(1);
  });
  it("makes the existing assignment route discoverable to administrators/principals and read-only teachers", () => {
    expect(canAccessModule("principal", "teacher-assignments")).toBe(true); expect(canAccessModule("finance", "teacher-assignments")).toBe(false);
    expect(getAdminNavigationModules().some((module) => module.key === "teacher-assignments")).toBe(true);
    expect(getVisibleModules("principal").some((module) => module.key === "teacher-assignments")).toBe(true);
    expect(getTeacherNavigationModules().some((module) => module.key === "teacher-assignments")).toBe(true);
  });
});
