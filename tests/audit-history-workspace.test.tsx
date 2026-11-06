import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuditHistoryWorkspace } from "../components/admin/audit-history-workspace";
import { auditPageSize, type AuditPage } from "../lib/admin/audit-history";

const { loadAccess, list, subscribe } = vi.hoisted(() => ({ loadAccess: vi.fn(), list: vi.fn(), subscribe: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { onAuthStateChange: subscribe } }) }));
vi.mock("@/lib/attendance/repository", () => ({ loadSchoolManagementAccess: loadAccess }));
vi.mock("@/lib/admin/audit-history", async (original) => ({ ...await original<typeof import("../lib/admin/audit-history")>(), listSchoolAuditEvents: list }));

const school = "00000000-0000-4000-8000-000000000001";
const secondSchool = "00000000-0000-4000-8000-000000000002";
const event = (n = 1, action = "Leave requested") => ({ id: `leave:00000000-0000-4000-8000-${String(n).padStart(12, "0")}:submitted`,
  occurred_at: "2026-11-06T10:00:00Z", actor_name: "QA Admin", module: "student-leave" as const, action, record_label: "Leave request reference" });
const page = (action = "Leave requested"): AuditPage => ({ events: [event(1, action)], next_cursor: null });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

beforeEach(() => {
  vi.clearAllMocks();
  loadAccess.mockResolvedValue({ userId: "admin", schools: [{ id: school, name: "QA school" }], schoolAdminIds: [school] });
  subscribe.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  list.mockResolvedValue(page());
});

describe("read-only school audit workspace", () => {
  it("shows recorded evidence and coverage with labeled controls and no write actions", async () => {
    render(<AuditHistoryWorkspace userId="admin" />);
    expect(await screen.findByText("Leave requested")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Audit Logs" })).toBeInTheDocument();
    expect(screen.getByText("Read-only history")).toBeInTheDocument();
    for (const name of ["School", "From (IST)", "To (IST)", "Module"]) expect(screen.getByLabelText(name)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "School" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Module" })).toBeInTheDocument();
    expect(screen.getByText("Recorded by QA Admin")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "What this history covers" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add|edit|delete|export/i })).not.toBeInTheDocument();
    expect(list.mock.calls[0][1]).toBe(school);
  });

  it("uses shaped access and history skeletons without invented event counts", async () => {
    const pendingAccess = deferred<unknown>(); const pendingPage = deferred<AuditPage>();
    loadAccess.mockReturnValue(pendingAccess.promise); list.mockReturnValue(pendingPage.promise);
    const { container } = render(<AuditHistoryWorkspace userId="admin" />);
    expect(container.querySelector('[data-skeleton="form"]')).toBeInTheDocument();
    expect(screen.queryByText("QA Admin")).not.toBeInTheDocument();
    await act(async () => { pendingAccess.resolve({ userId: "admin", schools: [{ id: school, name: "QA school" }] }); });
    expect(container.querySelector('[data-skeleton="table"]')).toBeInTheDocument();
    expect(screen.queryByText(/^0 events/)).not.toBeInTheDocument();
    await act(async () => { pendingPage.resolve(page()); });
    expect(await screen.findByText("Leave requested")).toBeInTheDocument();
  });

  it("keeps applied filters separate from drafts, resets cursor on Apply and refreshes the first page", async () => {
    const rows = Array.from({ length: auditPageSize }, (_, n) => event(n + 1)); const last = rows.at(-1)!;
    const cursor = { occurred_at: last.occurred_at, key: last.id };
    list.mockResolvedValueOnce({ events: rows, next_cursor: cursor }).mockResolvedValue(page("Next page event"));
    render(<AuditHistoryWorkspace userId="admin" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Module"), { target: { value: "guardians" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Next page event");
    expect(list.mock.lastCall?.[2].module).toBeNull();
    expect(list.mock.lastCall?.[3]).toEqual(cursor);
    expect(screen.getByText(/Page 2/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    expect(list.mock.lastCall?.[3]).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(4));
    expect(list.mock.lastCall?.[2].module).toBe("guardians");
    expect(list.mock.lastCall?.[3]).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh history" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(5));
    expect(list.mock.lastCall?.[2].module).toBe("guardians");
    expect(list.mock.lastCall?.[3]).toBeNull();
  });

  it("rejects invalid date ranges locally and preserves a draft through a failed read", async () => {
    render(<AuditHistoryWorkspace userId="admin" />); await screen.findByText("Leave requested");
    fireEvent.change(screen.getByLabelText("From (IST)"), { target: { value: "2025-01-01" } });
    fireEvent.change(screen.getByLabelText("To (IST)"), { target: { value: "2026-11-06" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("366 days");
    expect(list).toHaveBeenCalledTimes(1);
    list.mockRejectedValueOnce(new Error("Audit service unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh history" }));
    await screen.findByText("Audit service unavailable");
    expect(screen.getByLabelText("From (IST)")).toHaveValue("2025-01-01");
    expect(screen.queryByText("Leave requested")).not.toBeInTheDocument();
  });

  it("ignores a slow old-school response and aborts it when selecting another school", async () => {
    loadAccess.mockResolvedValue({ userId: "admin", schools: [{ id: school, name: "One" }, { id: secondSchool, name: "Two" }] });
    const old = deferred<AuditPage>(); list.mockReturnValueOnce(old.promise).mockResolvedValue(page("New school event"));
    render(<AuditHistoryWorkspace userId="admin" />);
    fireEvent.change(await screen.findByLabelText("School"), { target: { value: school } });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    const signal = list.mock.calls[0][4] as AbortSignal;
    fireEvent.change(screen.getByLabelText("School"), { target: { value: secondSchool } });
    await screen.findByText("New school event");
    expect(signal.aborted).toBe(true);
    await act(async () => { old.resolve(page("Stale school event")); });
    expect(screen.queryByText("Stale school event")).not.toBeInTheDocument();
    expect(list.mock.lastCall?.[1]).toBe(secondSchool);
  });

  it("clears the old account immediately and ignores its delayed result", async () => {
    const old = deferred<AuditPage>(); list.mockReturnValueOnce(old.promise).mockResolvedValue(page("New account event"));
    const view = render(<AuditHistoryWorkspace userId="admin" />);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    loadAccess.mockResolvedValue({ userId: "new-admin", schools: [{ id: secondSchool, name: "New school" }] });
    view.rerender(<AuditHistoryWorkspace userId="new-admin" />);
    await screen.findByText("New account event");
    await act(async () => { old.resolve(page("Old account event")); });
    expect(screen.queryByText("Old account event")).not.toBeInTheDocument();
    expect(list.mock.lastCall?.[1]).toBe(secondSchool);
  });

  it("hides cached history after sign-out and rejects late results", async () => {
    render(<AuditHistoryWorkspace userId="admin" />); await screen.findByText("Leave requested");
    const listener = subscribe.mock.calls[0][0];
    act(() => listener("SIGNED_OUT", null));
    expect(screen.getByRole("alert")).toHaveTextContent("Your account changed");
    expect(screen.queryByText("Leave requested")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
  });

  it("uses safe missing-actor fallback and distinct empty/error states", async () => {
    list.mockResolvedValueOnce({ events: [{ ...event(), actor_name: null }], next_cursor: null }).mockResolvedValue({ events: [], next_cursor: null });
    render(<AuditHistoryWorkspace userId="admin" />);
    expect(await screen.findByText("Recorded by School account (name unavailable)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh history" }));
    expect(await screen.findByText("No recorded activity matches these filters.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("refreshes real history on returning to the page and cleans up subscriptions", async () => {
    const unsubscribe = vi.fn(); subscribe.mockReturnValue({ data: { subscription: { unsubscribe } } });
    const view = render(<AuditHistoryWorkspace userId="admin" />); await screen.findByText("Leave requested");
    fireEvent.focus(window);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    view.unmount(); expect(unsubscribe).toHaveBeenCalledTimes(1);
    fireEvent.focus(window); expect(list).toHaveBeenCalledTimes(2);
  });

  it("does not request school history when access is denied and allows an explicit retry", async () => {
    loadAccess.mockRejectedValueOnce(new Error("A school administrator role is required"));
    render(<AuditHistoryWorkspace userId="admin" />);
    await screen.findByRole("alert"); expect(list).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reload school access" }));
    expect(await screen.findByText("Leave requested")).toBeInTheDocument();
  });
});
