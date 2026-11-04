"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";

// The browser environment is constant for this component's lifetime. React
// uses the server snapshot for hydration, then reads the browser snapshot.
const subscribe = () => () => {};
const browserSnapshot = () => true;
const serverSnapshot = () => false;
const choices = [["light", Sun], ["dark", Moon], ["system", Monitor]] as const;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const browserReady = useSyncExternalStore(subscribe, browserSnapshot, serverSnapshot);
  if (!browserReady) return <div aria-hidden="true" className="h-10 w-28 rounded-xl border border-[var(--border)]" />;

  return <div role="group" aria-label="Color theme" className="flex rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1">
    {choices.map(([value, Icon]) => <button key={value} type="button"
      aria-label={`Use ${value} theme`} aria-pressed={theme === value}
      onClick={() => setTheme(value)}
      className={`rounded-lg p-2 ${theme === value ? "bg-blue-50 text-blue-600 dark:bg-blue-950" : "muted"}`}>
      <Icon size={16} />
    </button>)}
  </div>;
}
