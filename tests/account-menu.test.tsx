import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AccountMenu } from "@/components/layout/account-menu";

vi.mock("@/components/ui/theme-toggle", () => ({ ThemeToggle: () => <select aria-label="Color theme"><option>System</option><option>Dark</option></select> }));
const props = { identity: <span>QA Principal</span>, name: "QA Principal", email: "qa@example.test", onLogout: vi.fn(), signingOut: false };

describe("header account disclosure", () => {
  it("keeps settings, appearance and logout behind one account button", () => {
    render(<AccountMenu {...props} />);
    expect(screen.queryByRole("button", { name: "Logout" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Account options" }));
    const options = within(screen.getByRole("group", { name: "Account options" }));
    expect(options.getByRole("link", { name: "Account settings" })).toHaveAttribute("href", "/account/settings");
    expect(options.queryByRole("combobox")).not.toBeInTheDocument();
    fireEvent.click(options.getByRole("button", { name: "Appearance" }));
    expect(options.getByRole("combobox", { name: "Color theme" })).toBeInTheDocument();
    fireEvent.click(options.getByRole("button", { name: "Logout" }));
    expect(props.onLogout).toHaveBeenCalledOnce();
  });

  it("supports keyboard open, Escape return and outside dismissal", async () => {
    const user = userEvent.setup();
    render(<><AccountMenu {...props} /><button>Outside</button></>);
    const button = screen.getByRole("button", { name: "Account options" });
    button.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("link", { name: "Account settings" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("dismisses a hovered menu without taking focus from a field", async () => {
    const user = userEvent.setup();
    render(<><AccountMenu {...props} /><input aria-label="Search students" /></>);
    const field = screen.getByRole("textbox", { name: "Search students" });
    const button = screen.getByRole("button", { name: "Account options" });
    await user.click(field);
    await user.hover(button);
    expect(screen.getByRole("link", { name: "Account settings" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(field).toHaveFocus();
  });

  it("closes when keyboard focus leaves and disables pending logout", async () => {
    const user = userEvent.setup();
    render(<><AccountMenu {...props} signingOut /><button>Outside</button></>);
    fireEvent.click(screen.getByRole("button", { name: "Account options" }));
    expect(screen.getByRole("button", { name: "Signing out…" })).toBeDisabled();
    screen.getByRole("button", { name: "Appearance" }).focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
    expect(screen.queryByRole("group", { name: "Account options" })).not.toBeInTheDocument();
  });
});
