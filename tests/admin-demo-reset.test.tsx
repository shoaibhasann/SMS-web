import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { AdminDemoWorkspace } from "../components/admin/admin-demo-workspace";

const key = (name: string) => `kids-corner-admin-demo:${name}`;

beforeEach(() => { window.localStorage.clear(); });

it("Reset demo data restores the module seed and its related list without touching other modules", async () => {
  window.localStorage.setItem(key("library"), JSON.stringify([{ id: "book-x", name: "Edited only book", status: "Available" }]));
  window.localStorage.setItem(key("library-loans"), JSON.stringify([]));
  window.localStorage.setItem(key("events"), JSON.stringify([{ id: "event-x", title: "Kept event" }]));

  render(<AdminDemoWorkspace module="library" />);
  expect(await screen.findByText("Edited only book")).toBeInTheDocument();
  expect(screen.queryByText("The Secret Garden")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /Reset demo data/ }));

  expect(await screen.findByText("The Secret Garden")).toBeInTheDocument();
  expect(screen.queryByText("Edited only book")).not.toBeInTheDocument();
  expect(window.localStorage.getItem(key("library"))).toBeNull();
  expect(window.localStorage.getItem(key("library-loans"))).toBeNull();
  expect(window.localStorage.getItem(key("events"))).not.toBeNull();
});

it("Reset demo data closes an open Record details panel for a removed record", async () => {
  window.localStorage.setItem(key("library"), JSON.stringify([{ id: "book-x", name: "Edited only book", status: "Available" }]));
  render(<AdminDemoWorkspace module="library" />);
  await screen.findByText("Edited only book");
  fireEvent.click(screen.getByRole("button", { name: "View details" }));
  expect(screen.getByRole("heading", { name: "Record details" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /Reset demo data/ }));

  expect(await screen.findByText("The Secret Garden")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Record details" })).not.toBeInTheDocument();
  expect(screen.queryByText("Edited only book")).not.toBeInTheDocument();
});
