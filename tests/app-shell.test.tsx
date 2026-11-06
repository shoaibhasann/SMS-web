import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../components/layout/app-shell";

const { getUser, signOut, unsubscribe, subscribe, replace, refresh, push } = vi.hoisted(() => ({
  getUser: vi.fn(), signOut: vi.fn(), unsubscribe: vi.fn(), subscribe: vi.fn(), replace: vi.fn(), refresh: vi.fn(), push: vi.fn(),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard", useRouter: () => ({ replace, refresh, push }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { getUser, signOut, onAuthStateChange: subscribe } }) }));
vi.mock("@/components/ui/theme-toggle", () => ({ ThemeToggle: () => <span>Theme options</span> }));

type DisplayUser = { email: string; user_metadata?: Record<string, unknown> };
type Identity = { data: { user: DisplayUser | null }; error: null };
let authChanged: (event: string, session: { user: DisplayUser } | null) => void;
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((complete) => { resolve = complete; }), resolve: (value: T) => resolve(value) };
}

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { email: "teacher@example.test" } }, error: null });
  signOut.mockResolvedValue({ error: null });
  subscribe.mockImplementation((callback: typeof authChanged) => {
    authChanged = callback;
    return { data: { subscription: { unsubscribe } } };
  });
});

describe("AppShell session lifecycle", () => {
  it("does not let an old identity lookup overwrite a newer session", async () => {
    const old = deferred<Identity>();
    getUser.mockReturnValue(old.promise);
    render(<AppShell role="teacher">Workspace</AppShell>);
    act(() => authChanged("SIGNED_IN", { user: { email: "new@example.test" } }));
    await act(async () => old.resolve({ data: { user: { email: "old@example.test" } }, error: null }));
    expect(screen.getByText("new@example.test")).toBeInTheDocument();
    expect(screen.queryByText("old@example.test")).not.toBeInTheDocument();
    act(() => authChanged("SIGNED_OUT", null));
    expect(screen.queryByText("new@example.test")).not.toBeInTheDocument();
  });

  it("unsubscribes and ignores an identity response after unmount", async () => {
    const lookup = deferred<Identity>();
    getUser.mockReturnValue(lookup.promise);
    const view = render(<AppShell role="teacher">Workspace</AppShell>);
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
    await act(async () => lookup.resolve({ data: { user: { email: "late@example.test" } }, error: null }));
    expect(screen.queryByText("late@example.test")).not.toBeInTheDocument();
  });

  it("retains the page and shows a retryable error when sign-out fails", async () => {
    signOut.mockResolvedValue({ error: { message: "Network unavailable" } });
    render(<AppShell role="admin">Workspace</AppShell>);
    fireEvent.click(screen.getAllByRole("button", { name: "Logout" })[0]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign out failed");
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button", { name: "Logout" })[0]).toBeEnabled();
  });

  it("submits one logout even when clicked twice before the response", async () => {
    const pending = deferred<{ error: null }>();
    signOut.mockReturnValue(pending.promise);
    render(<AppShell role="admin">Workspace</AppShell>);
    const button = screen.getByRole("button", { name: "Logout" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(signOut).toHaveBeenCalledOnce();
    await act(async () => pending.resolve({ error: null }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(refresh).toHaveBeenCalledOnce();
  });
});

it("finds only pages available to the active role and opens the first match with Enter", async () => {
  render(<AppShell role="parent">Workspace</AppShell>);
  const dialog = document.getElementById("workspace-search") as HTMLDialogElement;
  dialog.showModal = () => dialog.setAttribute("open", "");
  dialog.close = () => dialog.removeAttribute("open");
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  const search = within(screen.getByRole("dialog", { name: "Find a page" }));
  const field = search.getByRole("searchbox");
  fireEvent.change(field, { target: { value: "finance reports" } });
  expect(search.getByText("No pages match your search.")).toBeInTheDocument();
  fireEvent.change(field, { target: { value: "attendance" } });
  expect(search.getByRole("link", { name: /Attendance/ })).toHaveAttribute("href", "/modules/attendance?view=guardian");
  fireEvent.submit(search.getByRole("search"));
  expect(push).toHaveBeenCalledWith("/modules/attendance?view=guardian");
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  fireEvent.change(field, { target: { value: "advance credit" } });
  expect(search.getByRole("link", { name: /Advance credit/ })).toHaveAttribute("href", "/modules/advance-credit?view=guardian");
  fireEvent.change(field, { target: { value: "receipts" } });
  expect(search.getByRole("link", { name: /Invoices & Receipts/ })).toHaveAttribute("href", "/modules/invoices?view=guardian");
  fireEvent.submit(search.getByRole("search"));
  expect(push).toHaveBeenLastCalledWith("/modules/invoices?view=guardian");
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  fireEvent.change(field, { target: { value: "leave requests" } });
  expect(search.getByRole("link", { name: /Leave requests/ })).toHaveAttribute("href", "/modules/student-leave?view=guardian");
  fireEvent.change(field, { target: { value: "timetable" } });
  expect(search.getByRole("link", { name: /^Timetable/ })).toHaveAttribute("href", "/modules/timetable?view=guardian");
  fireEvent.submit(search.getByRole("search"));
  expect(push).toHaveBeenLastCalledWith("/modules/timetable?view=guardian");
  await screen.findByText("teacher@example.test");
});

it.each([
  ["parent", "/modules/invoices?view=guardian"],
  ["student", "/modules/invoices"],
  ["finance", "/modules/invoices"],
] as const)("uses the correct receipt scope across %s navigation and shortcuts", async (role, href) => {
  render(<AppShell role={role}>Workspace</AppShell>);
  const receipts = screen.getAllByRole("link", { name: "Invoices & Receipts" });
  expect(receipts.length).toBeGreaterThanOrEqual(2);
  for (const link of receipts) expect(link).toHaveAttribute("href", href);
  await screen.findByText("teacher@example.test");
});

it("keeps receipt navigation outside the teacher workspace", async () => {
  render(<AppShell role="teacher">Workspace</AppShell>);
  expect(screen.queryByRole("link", { name: "Invoices & Receipts" })).not.toBeInTheDocument();
  await screen.findByText("teacher@example.test");
});

it.each([
  ["parent", "/modules/student-leave?view=guardian"],
  ["student", "/modules/student-leave"],
  ["admin", "/modules/student-leave"],
  ["principal", "/modules/student-leave"],
] as const)("shows %s leave requests navigation with the correct scope", async (role, href) => {
  render(<AppShell role={role}>Workspace</AppShell>);
  const links = screen.getAllByRole("link", { name: "Leave requests" });
  expect(links.length).toBeGreaterThanOrEqual(1);
  for (const link of links) expect(link).toHaveAttribute("href", href);
  await screen.findByText("teacher@example.test");
});

it.each([
  ["parent", "/modules/timetable?view=guardian"],
  ["student", "/modules/timetable"],
  ["teacher", "/modules/timetable"],
  ["admin", "/modules/timetable"],
  ["principal", "/modules/timetable"],
] as const)("preserves the %s timetable scope in desktop and mobile page navigation", async (role, href) => {
  render(<AppShell role={role}>Workspace</AppShell>);
  expect(screen.getByRole("link", { name: "Timetable" })).toHaveAttribute("href", href);
  const menu = document.getElementById("workspace-menu") as HTMLDialogElement;
  menu.showModal = () => menu.setAttribute("open", "");
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  expect(within(screen.getByRole("dialog", { name: "Workspace menu" })).getByRole("link", { name: "Timetable" })).toHaveAttribute("href", href);
  await screen.findByText("teacher@example.test");
});

it.each(["finance", "reception"] as const)("does not list timetable pages for %s", async (role) => {
  render(<AppShell role={role}>Workspace</AppShell>);
  expect(screen.queryByRole("link", { name: "Timetable" })).not.toBeInTheDocument();
  await screen.findByText("teacher@example.test");
});


it.each([["parent", "/modules/results?view=guardian"], ["student", "/modules/results"]] as const)("provides one published-results family page for %s", async (role, href) => {
  render(<AppShell role={role}>Workspace</AppShell>);
  const links = screen.getAllByRole("link", { name: "Published results" });
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) expect(link).toHaveAttribute("href", href);
  expect(screen.queryByRole("link", { name: "Result publication" })).not.toBeInTheDocument();
  const dialog = document.getElementById("workspace-search") as HTMLDialogElement;
  dialog.showModal = () => dialog.setAttribute("open", "");
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  const search = within(screen.getByRole("dialog", { name: "Find a page" }));
  fireEvent.change(search.getByRole("searchbox"), { target: { value: "published results" } });
  expect(search.getByRole("link", { name: /Published results/ })).toHaveAttribute("href", href);
  expect(search.queryByRole("link", { name: /Result publication/ })).not.toBeInTheDocument();
  await screen.findByText("teacher@example.test");
});

it.each(["admin", "principal", "teacher"] as const)("offers %s an explicit publication workspace", async (role) => {
  render(<AppShell role={role}>Workspace</AppShell>);
  for (const link of screen.getAllByRole("link", { name: "Result publication" })) expect(link).toHaveAttribute("href", "/modules/published-results");
  await screen.findByText("teacher@example.test");
});

it.each(["finance", "reception"] as const)("keeps publication navigation outside %s", async (role) => {
  render(<AppShell role={role}>Workspace</AppShell>);
  expect(screen.queryByRole("link", { name: "Result publication" })).not.toBeInTheDocument();
  await screen.findByText("teacher@example.test");
});


it("uses verified-session display metadata without changing role navigation", async () => {
  getUser.mockResolvedValue({ data: { user: { email: "teacher@example.test", user_metadata: { full_name: "  Aditi   Sharma  ", role: "super_admin" } } }, error: null });
  render(<AppShell role="teacher">Workspace</AppShell>);
  const profile = screen.getByRole("link", { name: "Open my profile" });
  expect(profile).toHaveAttribute("href", "/modules/profile");
  expect(await within(profile).findByText("Aditi Sharma")).toBeInTheDocument();
  expect(within(profile).getByText("Teacher")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Guardian invitations" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Finance Reports" })).not.toBeInTheDocument();
});

it("keeps a newer session name when the old identity lookup completes later", async () => {
  const lookup = deferred<Identity>(); getUser.mockReturnValue(lookup.promise);
  render(<AppShell role="teacher">Workspace</AppShell>);
  act(() => authChanged("SIGNED_IN", { user: { email: "new@example.test", user_metadata: { full_name: "New identity" } } }));
  await act(async () => lookup.resolve({ data: { user: { email: "old@example.test", user_metadata: { full_name: "Old identity" } } }, error: null }));
  expect(within(screen.getByRole("link", { name: "Open my profile" })).getByText("New identity")).toBeInTheDocument();
  expect(screen.queryByText("Old identity")).not.toBeInTheDocument();
  expect(screen.getByText("new@example.test")).toBeInTheDocument();
});

it("preserves guardian scope for profile and notification header actions", async () => {
  render(<AppShell role="parent">Workspace</AppShell>);
  expect(screen.getByRole("link", { name: "Open my profile" })).toHaveAttribute("href", "/modules/profile?view=guardian");
  expect(screen.getByRole("link", { name: "Open notifications" })).toHaveAttribute("href", "/modules/notifications?view=guardian");
  expect(screen.getByRole("link", { name: "Profile" })).toHaveAttribute("href", "/modules/profile?view=guardian");
  expect(screen.getByRole("link", { name: "Open notifications" }).textContent).toBe("");
  await screen.findByText("teacher@example.test");
});

it("does not invent a profile destination or unread badge for a finance account", async () => {
  render(<AppShell role="finance">Workspace</AppShell>);
  expect(screen.queryByRole("link", { name: "Open my profile" })).not.toBeInTheDocument();
  const account = screen.getByRole("group", { name: "Signed-in account" });
  expect(within(account).getByText("Finance")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Notices and circulars" }).textContent).toBe("");
  await screen.findByText("teacher@example.test");
});

it("exposes page search as a named keyboard-accessible action", async () => {
  render(<AppShell role="student">Workspace</AppShell>);
  const control = screen.getByRole("button", { name: "Find a page" });
  expect(control).toHaveAttribute("aria-haspopup", "dialog");
  expect(control).toHaveAttribute("aria-keyshortcuts", "Control+k Meta+k");
  const dialog = document.getElementById("workspace-search") as HTMLDialogElement;
  dialog.showModal = () => dialog.setAttribute("open", "");
  fireEvent.click(control);
  expect(screen.getByRole("dialog", { name: "Find a page" })).toBeInTheDocument();
  await screen.findByText("teacher@example.test");
});
