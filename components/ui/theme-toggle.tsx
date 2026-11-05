"use client";

import { ChevronDown, Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const browserSnapshot = () => true;
const serverSnapshot = () => false;
const choices = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
] as const;

export function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const browserReady = useSyncExternalStore(subscribe, browserSnapshot, serverSnapshot);
  const choice = choices.find(({ value }) => browserReady && value === theme) ?? choices[0];
  const Icon = choice.icon;

  return (
    <label className="relative inline-flex min-h-12 min-w-28 shrink-0 items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-medium text-[var(--text)] hover:bg-[var(--surface-2)] focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--primary)]">
      <Icon size={17} aria-hidden="true" className="muted" />
      <span aria-hidden="true">{choice.label}</span>
      <ChevronDown size={14} aria-hidden="true" className="muted" />
      <select
        aria-label="Color theme"
        title={choice.value === "system" && browserReady ? `System theme (${resolvedTheme === "dark" ? "dark" : "light"})` : `${choice.label} theme`}
        value={choice.value}
        disabled={!browserReady}
        onChange={(event) => setTheme(event.target.value)}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-wait"
      >
        {choices.map(({ value, label }) => <option key={value} value={value}>{label === "System" ? "System (device setting)" : label}</option>)}
      </select>
    </label>
  );
}
