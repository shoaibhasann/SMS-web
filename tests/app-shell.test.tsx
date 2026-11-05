import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../components/layout/app-shell";

const { getUser, signOut, unsubscribe, subscribe, replace, refresh, push } = vi.hoisted(() => ({
  getUser: vi.fn(), signOut: vi.fn(), unsubscribe: vi.fn(), subscribe: vi.fn(), replace: vi.fn(), refresh: vi.fn(), push: vi.fn(),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard", useRouter: () => ({ replace, refresh, push }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { getUser, signOut, onAuthStateChange: subscribe } }) }));
vi.mock("@/components/ui/theme-toggle", () => ({ ThemeToggle: () => <span>Theme options</span> }));

type Identity = { data: { user: { email: string } | null }; error: null };
let authChanged: (event: string, session: { user: { email: string } } | null) => void;
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
  await screen.findByText("teacher@example.test");
});
