import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AdminNoticesWorkspace } from "@/components/admin/admin-notices-workspace";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/client", () => mocks);

const teacherAudience = { roles: ["student", "parent"], teacher_id: "teacher-a" };

function principalClient(audience: unknown = teacherAudience) {
  const update = vi.fn();
  const insert = vi.fn();
  const rows: Record<string, unknown> = {
    user_roles: [{ role: "principal", school_id: "school-a" }],
    notices: [{
      id: "notice-a", title: "Class reminder", content: "Original message",
      audience, published_at: "2026-11-04T18:45:00Z", version: "version-1",
    }],
    classes: [],
    sections: [],
  };
  const from = vi.fn((table: string) => {
    const query = {
      select: () => query,
      eq: () => query,
      order: () => query,
      update: (payload: unknown) => { update(payload); return query; },
      insert: (payload: unknown) => { insert(payload); return query; },
      maybeSingle: () => Promise.resolve({ data: { id: "notice-a" }, error: null }),
      then: (resolve: (response: unknown) => unknown) => Promise.resolve({ data: rows[table], error: null }).then(resolve),
    };
    return query;
  });
  mocks.createClient.mockReturnValue({
    auth: { getUser: async () => ({ data: { user: { id: "principal-a" } }, error: null }) },
    from,
  });
  return { update, insert };
}

it("preserves a teacher assignment audience and publication time when a principal edits only the copy", async () => {
  const { update } = principalClient();
  render(<AdminNoticesWorkspace />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit Class reminder" }));
  expect(screen.getByLabelText("Audience")).toHaveValue("Existing audience");
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Edited message" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() => expect(update).toHaveBeenCalledWith({
    title: "Class reminder", content: "Edited message", published_at: "2026-11-04T18:45:00Z",
    audience: teacherAudience,
  }));
});

it("schedules a future guardian notice at the start of the school day in IST and still stores the role key 'parent'", async () => {
  const { insert } = principalClient();
  render(<AdminNoticesWorkspace />);
  await screen.findByText("Class reminder");
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Parent briefing" } });
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Meeting details" } });
  const options = [...(screen.getByLabelText("Audience") as HTMLSelectElement).options].map((option) => option.text);
  expect(options).toContain("Guardians");
  expect(options).not.toContain("Parents");
  fireEvent.change(screen.getByLabelText("Audience"), { target: { value: "Guardians" } });
  fireEvent.change(screen.getByLabelText("Publish date (IST)"), { target: { value: "2099-11-05" } });
  fireEvent.click(screen.getByRole("button", { name: "Publish notice" }));

  await waitFor(() => expect(insert).toHaveBeenCalledWith({
    title: "Parent briefing", content: "Meeting details", published_at: "2099-11-05T09:00:00+05:30",
    audience: { roles: ["parent"] }, school_id: "school-a", created_by: "principal-a",
  }));
  expect(await screen.findByRole("status")).toHaveTextContent("Notice scheduled.");
});

it("shows a stored 'parent' audience as Guardians and saves it back unchanged when re-selected", async () => {
  const { update } = principalClient({ roles: ["parent"] });
  render(<AdminNoticesWorkspace />);
  expect(await screen.findByText(/^Guardians · /)).toBeInTheDocument();
  expect(screen.queryByText(/Parents/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Edit Class reminder" }));
  expect(screen.getByLabelText("Audience")).toHaveValue("Guardians");
  fireEvent.change(screen.getByLabelText("Audience"), { target: { value: "Students" } });
  fireEvent.change(screen.getByLabelText("Audience"), { target: { value: "Guardians" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() => expect(update).toHaveBeenCalledWith({
    title: "Class reminder", content: "Original message", published_at: "2026-11-04T18:45:00Z",
    audience: { roles: ["parent"] },
  }));
});

afterEach(() => vi.useRealTimers());

it("does not backdate a notice when the composer was opened before midnight IST", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T16:00:00Z")); // 21:30 IST, 10 Nov
  const { insert } = principalClient();
  render(<AdminNoticesWorkspace />);
  await screen.findByText("Class reminder");
  expect(screen.getByLabelText("Publish date (IST)")).toHaveValue("2026-11-10");

  vi.setSystemTime(new Date("2026-11-11T05:30:00Z")); // 11:00 IST, 11 Nov
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "School closed today" } });
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Heavy rain" } });
  fireEvent.click(screen.getByRole("button", { name: "Publish notice" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("The publish date was in the past");
  expect(insert).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Publish date (IST)")).toHaveValue("2026-11-11");

  fireEvent.click(screen.getByRole("button", { name: "Publish notice" }));
  await waitFor(() => expect(insert).toHaveBeenCalledTimes(1));
  expect(insert.mock.calls[0][0]).toMatchObject({ published_at: "2026-11-11T05:30:00.000Z" });
});
