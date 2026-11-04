import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AdminNoticesWorkspace } from "@/components/admin/admin-notices-workspace";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/client", () => mocks);

const teacherAudience = { roles: ["student", "parent"], teacher_id: "teacher-a" };

function principalClient() {
  const update = vi.fn();
  const insert = vi.fn();
  const rows: Record<string, unknown> = {
    user_roles: [{ role: "principal", school_id: "school-a" }],
    notices: [{
      id: "notice-a", title: "Class reminder", content: "Original message",
      audience: teacherAudience, published_at: "2026-11-04T18:45:00Z",
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

it("schedules a future parent notice at the start of the school day in IST", async () => {
  const { insert } = principalClient();
  render(<AdminNoticesWorkspace />);
  await screen.findByText("Class reminder");
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Parent briefing" } });
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Meeting details" } });
  fireEvent.change(screen.getByLabelText("Audience"), { target: { value: "Parents" } });
  fireEvent.change(screen.getByLabelText("Publish date (IST)"), { target: { value: "2099-11-05" } });
  fireEvent.click(screen.getByRole("button", { name: "Publish notice" }));

  await waitFor(() => expect(insert).toHaveBeenCalledWith({
    title: "Parent briefing", content: "Meeting details", published_at: "2099-11-05T09:00:00+05:30",
    audience: { roles: ["parent"] }, school_id: "school-a", created_by: "principal-a",
  }));
  expect(await screen.findByRole("status")).toHaveTextContent("Notice scheduled.");
});
