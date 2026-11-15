"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useId, useSyncExternalStore } from "react";

const subscribe = () => () => {};
const browserSnapshot = () => true;
const serverSnapshot = () => false;
const choices = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
] as const;

// In-page choices, not a native <select>: Windows, Android and iOS each draw that popup themselves and ignore the app's theme.
export function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const browserReady = useSyncExternalStore(subscribe, browserSnapshot, serverSnapshot);
  const name = useId();

  return (
    // preventDefault: a press here would otherwise blur focus to <body>, and the account menu closes on that blur before the click lands.
    <div role="radiogroup" aria-label="Color theme" onMouseDown={(event) => event.preventDefault()} className="grid grid-cols-3 gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-1">
      {choices.map(({ value, label, icon: Icon }) => {
        const checked = browserReady && theme === value;
        return (
          <label key={value} title={value === "system" && browserReady ? `System theme (${resolvedTheme === "dark" ? "dark" : "light"})` : undefined}
            className={`flex min-h-13 min-w-0 flex-col items-center justify-center gap-1 rounded-lg border px-1 py-1.5 text-xs motion-safe:transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-[var(--primary)] forced-colors:has-[:focus-visible]:outline-[CanvasText] ${browserReady ? "cursor-pointer" : "cursor-wait opacity-60"} ${checked
              ? "border-[var(--primary)] bg-[color-mix(in_srgb,var(--primary)_14%,var(--surface))] font-semibold text-[var(--text)] forced-colors:border-[Highlight] forced-colors:bg-[Highlight] forced-colors:text-[HighlightText] forced-colors:forced-color-adjust-none"
              : "border-transparent font-medium text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--text)]"}`}>
            <input type="radio" name={name} value={value} checked={checked} disabled={!browserReady} onChange={() => setTheme(value)} className="sr-only" />
            <Icon size={16} aria-hidden="true" />
            {label}
          </label>
        );
      })}
    </div>
  );
}
