import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import LoginPage from "@/app/(auth)/login/page";
import { ThemeProvider } from "@/components/ui/theme-provider";
import { ThemeToggle } from "@/components/ui/theme-toggle";

const navigation = vi.hoisted(() => ({
  path: "/dashboard",
  router: { replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.path,
  useRouter: () => navigation.router,
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: {} }) }));

let systemDark = false;
let mediaListeners: Set<(event: MediaQueryListEvent) => void>;

beforeEach(() => {
  navigation.path = "/dashboard";
  systemDark = false;
  mediaListeners = new Set();
  localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.style.colorScheme = "";
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    media: query,
    get matches() { return systemDark; },
    addListener: (listener: (event: MediaQueryListEvent) => void) => mediaListeners.add(listener),
    removeListener: (listener: (event: MediaQueryListEvent) => void) => mediaListeners.delete(listener),
  })));
});

afterEach(() => { vi.unstubAllGlobals(); });

function changeSystemTheme(dark: boolean) {
  act(() => {
    systemDark = dark;
    for (const listener of [...mediaListeners]) listener({ matches: dark } as MediaQueryListEvent);
  });
}

function workspace() {
  return <ThemeProvider attribute="class"><ThemeToggle /></ThemeProvider>;
}

it("defaults the workspace to System and responds to live device theme changes", () => {
  render(workspace());
  const control = screen.getByRole("combobox", { name: "Color theme" });
  expect(control).toHaveValue("system");
  expect(control).toBeEnabled();
  expect(document.documentElement).toHaveClass("light");
  expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
    "System (device setting)", "Light", "Dark",
  ]);
  control.focus();
  expect(control).toHaveFocus();

  changeSystemTheme(true);
  expect(document.documentElement).toHaveClass("dark");
  expect(control).toHaveAttribute("title", "System theme (dark)");
  changeSystemTheme(false);
  expect(document.documentElement).toHaveClass("light");
  expect(control).toHaveAttribute("title", "System theme (light)");
});

it("keeps login on the device theme without changing the saved workspace preference", () => {
  localStorage.setItem("theme", "light");
  systemDark = true;
  navigation.path = "/login";
  const view = render(<ThemeProvider attribute="class"><LoginPage /></ThemeProvider>);

  expect(screen.queryByLabelText("Color theme")).not.toBeInTheDocument();
  expect(document.documentElement).toHaveClass("dark");
  expect(localStorage.getItem("theme")).toBe("light");
  changeSystemTheme(false);
  expect(document.documentElement).toHaveClass("light");
  changeSystemTheme(true);
  expect(document.documentElement).toHaveClass("dark");

  navigation.path = "/dashboard";
  view.rerender(workspace());
  expect(screen.getByRole("combobox", { name: "Color theme" })).toHaveValue("light");
  expect(document.documentElement).toHaveClass("light");
  expect(localStorage.getItem("theme")).toBe("light");

  navigation.path = "/login";
  view.rerender(<ThemeProvider attribute="class"><LoginPage /></ThemeProvider>);
  expect(document.documentElement).toHaveClass("dark");
  expect(localStorage.getItem("theme")).toBe("light");
});

it("persists a manual workspace choice across remounts and ignores device changes while overridden", () => {
  const view = render(workspace());
  fireEvent.change(screen.getByRole("combobox", { name: "Color theme" }), { target: { value: "dark" } });
  expect(document.documentElement).toHaveClass("dark");
  expect(localStorage.getItem("theme")).toBe("dark");
  view.unmount();

  render(workspace());
  expect(screen.getByRole("combobox", { name: "Color theme" })).toHaveValue("dark");
  changeSystemTheme(false);
  expect(document.documentElement).toHaveClass("dark");
});

it("restores automatic device tracking when System is selected again", () => {
  localStorage.setItem("theme", "dark");
  render(workspace());
  const control = screen.getByRole("combobox", { name: "Color theme" });
  fireEvent.change(control, { target: { value: "system" } });
  expect(localStorage.getItem("theme")).toBe("system");
  expect(document.documentElement).toHaveClass("light");
  changeSystemTheme(true);
  expect(document.documentElement).toHaveClass("dark");
  expect(control).toHaveValue("system");
});
