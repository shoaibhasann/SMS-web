import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
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
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: {
  onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
} }) }));

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
  const control = screen.getByRole("radio", { name: "System" });
  expect(control).toBeChecked();
  expect(control).toBeEnabled();
  expect(document.documentElement).toHaveClass("light");
  expect(within(screen.getByRole("radiogroup", { name: "Color theme" })).getAllByRole("radio").map((radio) => radio.parentElement?.textContent)).toEqual([
    "System", "Light", "Dark",
  ]);
  control.focus();
  expect(control).toHaveFocus();

  changeSystemTheme(true);
  expect(document.documentElement).toHaveClass("dark");
  expect(control.parentElement).toHaveAttribute("title", "System theme (dark)");
  changeSystemTheme(false);
  expect(document.documentElement).toHaveClass("light");
  expect(control.parentElement).toHaveAttribute("title", "System theme (light)");
});

it("keeps login on the device theme without changing the saved workspace preference", () => {
  localStorage.setItem("theme", "light");
  systemDark = true;
  navigation.path = "/login";
  const view = render(<ThemeProvider attribute="class"><LoginPage /></ThemeProvider>);
  const scripts = [...view.container.querySelectorAll("script")];

  expect(screen.queryByLabelText("Color theme")).not.toBeInTheDocument();
  expect(document.documentElement).toHaveClass("dark");
  expect(localStorage.getItem("theme")).toBe("light");
  changeSystemTheme(false);
  expect(document.documentElement).toHaveClass("light");
  changeSystemTheme(true);
  expect(document.documentElement).toHaveClass("dark");

  navigation.path = "/dashboard";
  view.rerender(workspace());
  expect(view.container.querySelectorAll("script")).toHaveLength(scripts.length);
  scripts.forEach((script, index) => expect(view.container.querySelectorAll("script")[index]).toBe(script));
  expect(screen.getByRole("radio", { name: "Light" })).toBeChecked();
  expect(document.documentElement).toHaveClass("light");
  expect(localStorage.getItem("theme")).toBe("light");

  navigation.path = "/login";
  view.rerender(<ThemeProvider attribute="class"><LoginPage /></ThemeProvider>);
  expect(document.documentElement).toHaveClass("dark");
  expect(localStorage.getItem("theme")).toBe("light");
});

it("uses the device theme before login hydration without replacing the workspace preference", () => {
  localStorage.setItem("theme", "light");
  systemDark = true;
  navigation.path = "/login";
  const html = renderToString(<ThemeProvider attribute="class"><span>Login</span></ThemeProvider>);
  const host = document.createElement("div");
  host.innerHTML = html;
  window.history.replaceState(null, "", "/login");
  try {
    for (const script of host.querySelectorAll("script")) new Function(script.textContent ?? "")();
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement).not.toHaveClass("light");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(localStorage.getItem("theme")).toBe("light");
  } finally {
    window.history.replaceState(null, "", "/");
  }
});

it("persists a manual workspace choice across remounts and ignores device changes while overridden", () => {
  const view = render(workspace());
  fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
  expect(document.documentElement).toHaveClass("dark");
  expect(localStorage.getItem("theme")).toBe("dark");
  view.unmount();

  render(workspace());
  expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
  changeSystemTheme(false);
  expect(document.documentElement).toHaveClass("dark");
});

it("restores automatic device tracking when System is selected again", () => {
  localStorage.setItem("theme", "dark");
  render(workspace());
  const control = screen.getByRole("radio", { name: "System" });
  fireEvent.click(control);
  expect(localStorage.getItem("theme")).toBe("system");
  expect(document.documentElement).toHaveClass("light");
  changeSystemTheme(true);
  expect(document.documentElement).toHaveClass("dark");
  expect(control).toBeChecked();
});
