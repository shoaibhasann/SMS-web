import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import NotFound, { metadata } from "@/app/not-found";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { getSession } }) }));

beforeEach(() => { getSession.mockResolvedValue({ data: { session: null }, error: null }); });

it("offers sign-in to a signed-out visitor", async () => {
  render(<NotFound />);
  expect(metadata.title).toBe("SMS | Page not found");
  expect(screen.getByRole("main")).toContainElement(screen.getByRole("heading", { level: 1, name: "We can’t find that page" }));
  await waitFor(() => expect(getSession).toHaveBeenCalled());
  expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
});

it("offers the dashboard once the browser session shows a signed-in user", async () => {
  getSession.mockResolvedValueOnce({ data: { session: { user: { id: "user-1" } } }, error: null });
  render(<NotFound />);
  expect(await screen.findByRole("link", { name: "Go to your dashboard" })).toHaveAttribute("href", "/dashboard");
  expect(screen.queryByRole("link", { name: "Sign in" })).not.toBeInTheDocument();
});

it("keeps sign-in when the session cannot be read", async () => {
  getSession.mockRejectedValueOnce(new Error("offline"));
  render(<NotFound />);
  await waitFor(() => expect(getSession).toHaveBeenCalled());
  expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
});

it("goes back through history when there is some, and otherwise links to /", () => {
  const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
  render(<NotFound />);
  const link = screen.getByRole("link", { name: "Go back" });
  expect(link).toHaveAttribute("href", "/");
  window.history.pushState(null, "", "/missing");
  expect(fireEvent.click(link)).toBe(false); // default prevented: no navigation to /
  expect(back).toHaveBeenCalledOnce();
});
