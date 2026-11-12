import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AuditHistoryWorkspace } from "../components/admin/audit-history-workspace";
import { auditPageSize } from "../lib/admin/audit-history";

const { loadAccess, list, subscribe } = vi.hoisted(() => ({ loadAccess: vi.fn(), list: vi.fn(), subscribe: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { onAuthStateChange: subscribe } }) }));
vi.mock("@/lib/attendance/repository", () => ({ loadSchoolManagementAccess: loadAccess }));
vi.mock("@/lib/admin/audit-history", async (original) => ({ ...await original<typeof import("../lib/admin/audit-history")>(), listSchoolAuditEvents: list }));

const school = "00000000-0000-4000-8000-000000000001";
const event = (n: number, action: string) => ({ id: `leave:00000000-0000-4000-8000-${String(n).padStart(12, "0")}:submitted`,
  occurred_at: "2026-11-06T10:00:00Z", actor_name: "QA Admin", module: "student-leave" as const, action, record_label: "Leave request reference" });

beforeEach(() => {
  vi.clearAllMocks();
  loadAccess.mockResolvedValue({ userId: "admin", schools: [{ id: school, name: "QA school" }], schoolAdminIds: [school] });
  subscribe.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
});

it("keeps the current page when the window regains focus; only Refresh history returns to page 1", async () => {
  const rows = Array.from({ length: auditPageSize }, (_, n) => event(n + 1, "First page event"));
  const cursor = { occurred_at: rows.at(-1)!.occurred_at, key: rows.at(-1)!.id };
  list.mockImplementation(async (_c, _s, _f, at) => at ? { events: [event(999, "Second page event")], next_cursor: null } : { events: rows, next_cursor: cursor });
  render(<AuditHistoryWorkspace userId="admin" />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Second page event");

  fireEvent.focus(window);
  await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
  expect(list.mock.lastCall?.[3]).toEqual(cursor);
  expect(await screen.findByText("Second page event")).toBeInTheDocument();
  expect(screen.getByText(/Page 2/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();

  fireEvent(document, new Event("visibilitychange"));
  await waitFor(() => expect(list).toHaveBeenCalledTimes(4));
  expect(list.mock.lastCall?.[3]).toEqual(cursor);
  expect(await screen.findByText(/Page 2/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Refresh history" }));
  await waitFor(() => expect(list).toHaveBeenCalledTimes(5));
  expect(list.mock.lastCall?.[3]).toBeNull();
  expect(await screen.findByText(/Page 1/)).toBeInTheDocument();
});
