import { act, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "../components/ui/theme-toggle";

const { setTheme } = vi.hoisted(() => ({ setTheme: vi.fn() }));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "dark", setTheme }) }));
beforeEach(() => { vi.clearAllMocks(); });

describe("ThemeToggle", () => {
  it.each(["light", "dark", "system"])("offers an accessible %s theme choice", (theme) => {
    render(<ThemeToggle />);
    const control = screen.getByRole("combobox", { name: "Color theme" });
    const option = screen.getByRole("option", { name: theme === "system" ? "System (device setting)" : theme === "light" ? "Light" : "Dark" });
    expect(control).toHaveValue("dark");
    expect(option).toHaveProperty("selected", theme === "dark");
    fireEvent.change(control, { target: { value: theme } });
    expect(setTheme).toHaveBeenCalledWith(theme);
  });

  it("hydrates the disabled System control into the active saved theme without mismatched markup", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(<ThemeToggle />);
    expect(container.querySelector("select")).toBeDisabled();
    expect(container.querySelector("select")).toHaveValue("system");
    document.body.append(container);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      await act(async () => { root = hydrateRoot(container, <ThemeToggle />); });
      expect(container.querySelectorAll("select")).toHaveLength(1);
      expect(container.querySelector("select")).toBeEnabled();
      expect(container.querySelector("select")).toHaveValue("dark");
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await act(async () => root?.unmount());
      errors.mockRestore();
      container.remove();
    }
  });
});
