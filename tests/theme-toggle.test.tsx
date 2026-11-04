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
    const button = screen.getByRole("button", { name: `Use ${theme} theme` });
    expect(button).toHaveAttribute("aria-pressed", String(theme === "dark"));
    fireEvent.click(button);
    expect(setTheme).toHaveBeenCalledWith(theme);
  });

  it("hydrates the server placeholder into controls without mismatched theme markup", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(<ThemeToggle />);
    expect(container.querySelector("button")).toBeNull();
    document.body.append(container);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      await act(async () => { root = hydrateRoot(container, <ThemeToggle />); });
      expect(container.querySelectorAll("button")).toHaveLength(3);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await act(async () => root?.unmount());
      errors.mockRestore();
      container.remove();
    }
  });
});
