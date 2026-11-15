import { act, fireEvent, render, screen, within } from "@testing-library/react";
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
    const group = within(screen.getByRole("radiogroup", { name: "Color theme" }));
    const choice = group.getByRole("radio", { name: theme === "system" ? "System" : theme === "light" ? "Light" : "Dark" });
    expect(group.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(choice).toHaveProperty("checked", theme === "dark");
    fireEvent.click(choice);
    if (theme === "dark") expect(setTheme).not.toHaveBeenCalled();
    else expect(setTheme).toHaveBeenCalledWith(theme);
  });

  it("keeps focus in place when a choice is pressed, so the account menu does not close on blur", () => {
    render(<ThemeToggle />);
    expect(fireEvent.mouseDown(screen.getByText("Light"))).toBe(false);
  });

  it("hydrates the disabled choices into the active saved theme without mismatched markup", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(<ThemeToggle />);
    const radios = () => [...container.querySelectorAll<HTMLInputElement>("input[type=radio]")];
    expect(radios().map((radio) => [radio.value, radio.disabled, radio.checked])).toEqual([["system", true, false], ["light", true, false], ["dark", true, false]]);
    document.body.append(container);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      await act(async () => { root = hydrateRoot(container, <ThemeToggle />); });
      expect(radios().map((radio) => [radio.value, radio.disabled, radio.checked])).toEqual([["system", false, false], ["light", false, false], ["dark", false, true]]);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await act(async () => root?.unmount());
      errors.mockRestore();
      container.remove();
    }
  });
});
