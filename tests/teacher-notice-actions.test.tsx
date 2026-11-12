import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoleDashboard } from "../components/dashboard/role-dashboard";

// web-notices#2: teacher notices still go live at once, but the teacher can edit and withdraw
// their own notices through the version-guarded, created_by-scoped update the RLS already allows.
const { from, client, attendance } = vi.hoisted(() => {
  const from = vi.fn();
  return {
    from,
    attendance: { locked: false },
    client: {
      from,
      rpc: () => ({ abortSignal: () => ({ returns: async () => ({ data: [], error: null }) }) }),
      auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }) },
    },
  };
});

vi.mock("@/lib/supabase/client", () => ({ createClient: () => client }));
vi.mock("@/components/layout/app-shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/academic/attendance-editor", async () => {
  const { useEffect } = await import("react");
  return { AttendanceEditor: ({ onLockChange }: { onLockChange?: (locked: boolean) => void }) => {
    useEffect(() => { onLockChange?.(attendance.locked); }, [onLockChange]);
    return null;
  } };
});
vi.mock("@/lib/assignments/attendance-coverage", () => ({ loadEffectiveAttendanceAssignments: async () => [] }));

type Query = { table: string; columns: string; filters: Record<string, unknown>; mutation?: { kind: string; payload: unknown } };
type Result = { data: unknown; error: { message: string } | null; count?: number | null };
let queries: Query[];
let mutationResult: Result;
const ok = (data: unknown): Result => ({ data, error: null, count: 0 });
const published = { id: "n1", title: "Trip on Friday", content: "Bring a packed lunch", published_at: "2026-11-10T04:00:00Z",
  created_at: "2026-11-10T04:00:00Z", version: "v1" };
const second = { id: "n3", title: "Sports day", content: "Wear house colours", published_at: "2026-11-09T04:00:00Z",
  created_at: "2026-11-09T04:00:00Z", version: "v3" };
let teacherNotices: unknown[];
const withdrawn = { id: "n2", title: "Old circular", content: "Withdrawn text", published_at: null, created_at: "2026-11-01T04:00:00Z", version: "v2" };

function resolve(query: Query): Result {
  if (query.mutation) return mutationResult;
  if (query.table === "teachers") return ok({ id: "teacher", school_id: "school", full_name: "Asha Teacher" });
  if (query.table === "academic_years") return ok({ id: "year" });
  if (query.table === "notices") return ok(teacherNotices);
  return ok([]);
}

beforeEach(() => {
  queries = [];
  attendance.locked = false;
  teacherNotices = [published, withdrawn];
  mutationResult = ok({ id: "n1" });
  from.mockImplementation((table: string) => {
    const query: Query = { table, columns: "", filters: {} };
    queries.push(query);
    const builder = {
      select(columns: string) { query.columns = columns; return builder; },
      update(payload: unknown) { query.mutation = { kind: "update", payload }; return builder; },
      insert(payload: unknown) { query.mutation = { kind: "insert", payload }; return builder; },
      delete() { query.mutation = { kind: "delete", payload: null }; return builder; },
      eq(column: string, value: unknown) { query.filters[column] = value; return builder; },
      in: () => builder, gte: () => builder, lte: () => builder, order: () => builder, limit: () => builder,
      returns: () => builder, or: () => builder, is: () => builder,
      maybeSingle: () => Promise.resolve(resolve(query)),
      then: (onFulfilled: (value: Result) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(resolve(query)).then(onFulfilled, onRejected),
    };
    return builder;
  });
});
afterEach(() => { vi.restoreAllMocks(); });

const mutations = () => queries.filter((query) => query.mutation);
const noticeReads = () => queries.filter((query) => query.table === "notices" && !query.mutation);
const noticeRow = (title: string) => within(screen.getByText(title).closest("li")!);

async function renderTeacher() {
  render(<RoleDashboard role="teacher" schoolId="school" userId="teacher-user" />);
  await screen.findByText("Trip on Friday");
}

describe("teacher notice edit and withdraw", () => {
  it("explains that notices go live at once and delivered pushes cannot be recalled", async () => {
    await renderTeacher();
    expect(screen.getByText(/push alert already delivered to a phone cannot be recalled/i)).toBeInTheDocument();
    expect(noticeReads()[0].columns).toContain("version");
    expect(noticeReads()[0].filters).toMatchObject({ created_by: "teacher-user" });
    expect(noticeRow("Old circular").getByText("Withdrawn")).toBeInTheDocument();
    expect(noticeRow("Old circular").queryByRole("button")).not.toBeInTheDocument();
  });

  it("edits the teacher's own notice with a version-guarded update and no new broadcast", async () => {
    await renderTeacher();
    fireEvent.click(screen.getByRole("button", { name: "Edit Trip on Friday" }));
    expect(screen.getByPlaceholderText("Notice title")).toHaveValue("Trip on Friday");
    expect(screen.getByPlaceholderText("Notice content")).toHaveValue("Bring a packed lunch");
    expect(screen.getByRole("textbox", { name: "Notice title" })).toHaveValue("Trip on Friday");
    expect(screen.getByRole("textbox", { name: "Notice content" })).toHaveValue("Bring a packed lunch");
    fireEvent.change(screen.getByPlaceholderText("Notice title"), { target: { value: "Trip on Saturday" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Notice updated.")).toBeInTheDocument();
    expect(mutations()).toEqual([expect.objectContaining({ table: "notices",
      mutation: { kind: "update", payload: { title: "Trip on Saturday", content: "Bring a packed lunch" } },
      filters: { id: "n1", created_by: "teacher-user", version: "v1" } })]);
    expect(noticeReads()).toHaveLength(2);
    expect(screen.getByPlaceholderText("Notice title")).toHaveValue("");
  });

  it("withdraws the teacher's own notice by unpublishing it, scoped by id, owner and version", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderTeacher();
    fireEvent.click(screen.getByRole("button", { name: "Withdraw Trip on Friday" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/cannot be recalled/));
    expect(await screen.findByText(/Notice withdrawn/)).toBeInTheDocument();
    expect(mutations()).toEqual([expect.objectContaining({ table: "notices",
      mutation: { kind: "update", payload: { published_at: null } },
      filters: { id: "n1", created_by: "teacher-user", version: "v1" } })]);
    expect(noticeReads()).toHaveLength(2);
  });

  it("does nothing when the withdraw confirmation is cancelled", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderTeacher();
    fireEvent.click(screen.getByRole("button", { name: "Withdraw Trip on Friday" }));
    expect(mutations()).toEqual([]);
  });

  it("reports a stale notice instead of claiming success when no row matched", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mutationResult = ok(null);
    await renderTeacher();
    fireEvent.click(screen.getByRole("button", { name: "Withdraw Trip on Friday" }));
    expect(await screen.findByText(/changed since it was loaded and could not be saved/)).toBeInTheDocument();
    expect(screen.queryByText(/Notice withdrawn/)).not.toBeInTheDocument();
  });

  it("keeps an unsaved edit of one notice when a different notice is withdrawn", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    teacherNotices = [published, second, withdrawn];
    mutationResult = ok({ id: "n3" });
    await renderTeacher();
    fireEvent.click(screen.getByRole("button", { name: "Edit Trip on Friday" }));
    fireEvent.change(screen.getByPlaceholderText("Notice title"), { target: { value: "Trip on Saturday" } });
    fireEvent.click(screen.getByRole("button", { name: "Withdraw Sports day" }));
    expect(await screen.findByText(/Notice withdrawn/)).toBeInTheDocument();
    expect(mutations()).toEqual([expect.objectContaining({ filters: { id: "n3", created_by: "teacher-user", version: "v3" } })]);
    await waitFor(() => expect(noticeReads()).toHaveLength(2));
    expect(screen.getByPlaceholderText("Notice title")).toHaveValue("Trip on Saturday");
    expect(screen.getByPlaceholderText("Notice content")).toHaveValue("Bring a packed lunch");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("explains why notice actions are paused while the attendance register is locked", async () => {
    attendance.locked = true;
    await renderTeacher();
    fireEvent.change(screen.getByPlaceholderText("Notice title"), { target: { value: "Trip" } });
    fireEvent.change(screen.getByPlaceholderText("Notice content"), { target: { value: "Details" } });
    expect(screen.getByRole("button", { name: /Publish Notice/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit Trip on Friday" })).toBeDisabled();
    expect(screen.getByText(/Notice actions are paused/)).toBeInTheDocument();
  });

  it("shows no pause hint when attendance is not locked", async () => {
    await renderTeacher();
    expect(screen.queryByText(/Notice actions are paused/)).not.toBeInTheDocument();
  });
});
