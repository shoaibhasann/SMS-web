import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AdminNoticesWorkspace } from "@/components/admin/admin-notices-workspace";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/client", () => mocks);

type Row = Record<string, unknown>;
const everyone = { roles: ["student", "parent", "teacher", "staff"] };
const teachers = { roles: ["teacher"] };

function noticeClient() {
  let sequence = 1;
  const rows: Record<string, Row[]> = {
    user_roles: [{ user_id: "principal-a", role: "principal", school_id: "school-a" }],
    notices: [{ id: "notice-a", school_id: "school-a", title: "School update", content: "Original copy",
      audience: everyone, published_at: "2026-11-04T18:45:00Z", created_at: "2026-11-04T18:45:00Z", version: "version-1" }],
    classes: [], sections: [],
  };
  const writes: { kind: string; payload?: Row; filters: [string, unknown][] }[] = [];
  let readError = false;
  let lostAcknowledgement = false;
  let waitForMutation: Promise<void> | undefined;
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "principal-a" } }, error: null }) },
    from(table: string) {
      const filters: [string, unknown][] = [];
      let operation = "read";
      let payload: Row | undefined;
      const execute = async (single = false) => {
        if (operation !== "read") await waitForMutation;
        if (table === "notices" && operation === "read" && readError) return { data: null, error: { message: "Network failed" } };
        let matching = rows[table].filter((row) => filters.every(([key, value]) => row[key] === value));
        if (operation !== "read") {
          writes.push({ kind: operation, payload, filters: [...filters] });
          if (operation === "delete") rows[table] = rows[table].filter((row) => !matching.includes(row));
          else if (operation === "update") for (const row of matching) Object.assign(row, payload, { version: `version-${++sequence}` });
          else {
            const row = { ...payload, id: `notice-${++sequence}`, version: `version-${sequence}` };
            rows[table].push(row);
            matching = [row];
          }
        }
        if (operation !== "read" && lostAcknowledgement) return { data: null, error: { message: "Connection interrupted" } };
        const result = structuredClone(matching);
        return { data: single ? result[0] ?? null : result, error: null };
      };
      const query = {
        select: () => query,
        order: () => query,
        eq: (field: string, value: unknown) => { filters.push([field, value]); return query; },
        update: (value: Row) => { operation = "update"; payload = value; return query; },
        insert: (value: Row) => { operation = "insert"; payload = value; return query; },
        delete: () => { operation = "delete"; return query; },
        maybeSingle: () => execute(true),
        then: (resolve: (value: unknown) => unknown) => execute().then(resolve),
      };
      return query;
    },
  };
  mocks.createClient.mockReturnValue(client);
  return {
    writes,
    row: () => structuredClone(rows.notices[0]),
    change: (patch: Row) => Object.assign(rows.notices[0], patch, { version: `version-${++sequence}` }),
    remove: () => { rows.notices = []; },
    failReads: (value: boolean) => { readError = value; },
    loseAcknowledgement: () => { lostAcknowledgement = true; },
    missingVersion: () => { delete rows.notices[0].version; },
    deferMutation: () => { let finish!: () => void; waitForMutation = new Promise<void>((resolve) => { finish = resolve; }); return finish; },
  };
}

it("does not republish or widen a remotely withdrawn notice, even after refreshing the list during editing", async () => {
  const db = noticeClient();
  render(<AdminNoticesWorkspace />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit School update" }));
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "My unsaved title" } });
  db.change({ published_at: null, audience: teachers });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Teachers · Draft");
  expect(screen.getByLabelText("Title")).toHaveValue("My unsaved title");
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Your draft is kept");
  expect(db.row()).toMatchObject({ title: "School update", published_at: null, audience: teachers, version: "version-2" });
  expect(db.writes[0].filters).toContainEqual(["version", "version-1"]);
  expect(screen.getByLabelText("Title")).toHaveValue("My unsaved title");
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Discard draft and reload" }));
  expect(await screen.findByRole("status")).toHaveTextContent("previous draft was discarded");
  expect(screen.getByLabelText("Title")).toHaveValue("School update");
  expect(screen.getByLabelText("Audience")).toHaveValue("Teachers");
  expect(screen.getByLabelText("Status")).toHaveValue("Draft");
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Reviewed title" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Notice updated");
  expect(db.row()).toMatchObject({ title: "Reviewed title", published_at: null, audience: teachers });
  expect(db.writes[1].filters).toContainEqual(["version", "version-2"]);
});

it("rejects a stale publish toggle when the notice audience changed but its publication timestamp stayed identical", async () => {
  const db = noticeClient();
  render(<AdminNoticesWorkspace />);
  const unpublish = await screen.findByRole("button", { name: "Unpublish" });
  db.change({ audience: teachers });
  fireEvent.click(unpublish);
  expect(await screen.findByRole("alert")).toHaveTextContent("status was not changed");
  expect(db.row()).toMatchObject({ audience: teachers, published_at: "2026-11-04T18:45:00Z", version: "version-2" });
  expect(db.writes[0].filters).toContainEqual(["version", "version-1"]);
});

it("does not delete a newly changed notice from a stale list and permits an explicitly reviewed retry", async () => {
  const db = noticeClient();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<AdminNoticesWorkspace />);
  const remove = await screen.findByRole("button", { name: "Delete School update" });
  db.change({ content: "Another principal's new copy" });
  fireEvent.click(remove);
  expect(await screen.findByRole("alert")).toHaveTextContent("Nothing was deleted");
  expect(db.row()).toMatchObject({ content: "Another principal's new copy" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Another principal's new copy");
  fireEvent.click(screen.getByRole("button", { name: "Delete School update" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Notice deleted");
  expect(db.row()).toBeUndefined();
});

it("retains a conflict draft when reload fails or the notice was deleted; Cancel explicitly discards it", async () => {
  const db = noticeClient();
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(<AdminNoticesWorkspace />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit School update" }));
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Keep my draft" } });
  db.remove();
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByRole("alert");
  db.failReads(true);
  fireEvent.click(screen.getByRole("button", { name: "Discard draft and reload" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded. Your draft is kept");
  expect(screen.getByLabelText("Description")).toHaveValue("Keep my draft");
  db.failReads(false);
  fireEvent.click(screen.getByRole("button", { name: "Discard draft and reload" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("no longer available");
  expect(screen.getByLabelText("Description")).toHaveValue("Keep my draft");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByLabelText("Description")).toHaveValue("");
  expect(screen.getByRole("button", { name: "Publish notice" })).toBeEnabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("locks inputs and competing actions while a notice mutation is pending", async () => {
  const db = noticeClient();
  render(<AdminNoticesWorkspace />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit School update" }));
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Accepted copy" } });
  const finish = db.deferMutation();
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(screen.getByLabelText("Description")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  finish();
  expect(await screen.findByRole("status")).toHaveTextContent("Notice updated");
  expect(db.writes).toHaveLength(1);
  expect(db.row()).toMatchObject({ content: "Accepted copy" });
});

it("does not claim a network-interrupted save failed to commit and reconciles by explicit reload", async () => {
  const db = noticeClient();
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(<AdminNoticesWorkspace />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit School update" }));
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Saved but acknowledgement lost" } });
  db.loseAcknowledgement();
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Save could not be confirmed");
  expect(db.row()).toMatchObject({ content: "Saved but acknowledgement lost", version: "version-2" });
  expect(screen.getByLabelText("Description")).toHaveValue("Saved but acknowledgement lost");
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  expect(screen.queryByText(/has not been saved/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Discard draft and reload" }));
  await screen.findByRole("status");
  expect(screen.getByLabelText("Description")).toHaveValue("Saved but acknowledgement lost");
  expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
});

it("keeps the edit snapshot after a failed list refresh and recovers without silently rebasing", async () => {
  const db = noticeClient();
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(<AdminNoticesWorkspace />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit School update" }));
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Draft survives refresh" } });
  db.failReads(true);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Notices could not be loaded");
  expect(screen.getByLabelText("Title")).toHaveValue("Draft survives refresh");
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  db.change({ audience: teachers, published_at: null });
  db.failReads(false);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Teachers · Draft");
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Your draft is kept");
  expect(db.row()).toMatchObject({ audience: teachers, published_at: null });
});

it("fails closed with an actionable database-update message when version metadata is unavailable", async () => {
  const db = noticeClient();
  db.missingVersion();
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(<AdminNoticesWorkspace />);
  expect(await screen.findByRole("alert")).toHaveTextContent("latest database update");
  expect(screen.getByRole("button", { name: "Publish notice" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Edit School update" })).not.toBeInTheDocument();
  expect(db.writes).toEqual([]);
});
