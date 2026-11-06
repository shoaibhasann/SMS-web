"use client";

import Link from "next/link";
import { ChevronDown, LogOut, Palette, Settings, Loader2 } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ThemeToggle } from "@/components/ui/theme-toggle";

const action = "flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-sm font-medium hover:bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:outline-[var(--primary)]";

export function AccountMenu({ identity, name, email, onLogout, signingOut }: {
  identity: ReactNode;
  name: string;
  email: string;
  onLogout: () => void;
  signingOut: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [appearance, setAppearance] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const firstLink = useRef<HTMLAnchorElement>(null);
  const pinned = useRef(false);
  const focusFirst = useRef(false);
  const panelId = useId();
  const appearanceId = useId();
  const identityId = useId();

  useEffect(() => {
    if (!open) return;
    if (focusFirst.current) {
      firstLink.current?.focus();
      focusFirst.current = false;
    }
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !container.current?.contains(event.target)) {
        pinned.current = false;
        setOpen(false);
      }
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      pinned.current = false;
      setOpen(false);
      trigger.current?.focus();
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return <div ref={container} className="relative shrink-0"
    onPointerEnter={(event) => { if (event.pointerType === "mouse") setOpen(true); }}
    onPointerLeave={() => {
      if (!pinned.current && !container.current?.contains(document.activeElement)) setOpen(false);
    }}
    onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        pinned.current = false;
        setOpen(false);
      }
    }}>
    <button ref={trigger} type="button" aria-label="Account options" aria-describedby={email ? identityId : undefined} aria-expanded={open} aria-controls={panelId}
      className="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-xl px-1.5 hover:bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]"
      onClick={() => {
        if (open && pinned.current) { pinned.current = false; setOpen(false); }
        else { pinned.current = true; setOpen(true); }
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          pinned.current = true;
          if (open) firstLink.current?.focus();
          else { focusFirst.current = true; setOpen(true); }
        }
      }}>
      {identity}
      {email && <span id={identityId} className="sr-only">{email}</span>}
      <ChevronDown size={14} aria-hidden="true" className="hidden muted sm:block" />
    </button>
    {open && <div className="absolute right-0 top-full z-40 w-[min(288px,calc(100vw-2rem))] pt-2">
      <div id={panelId} role="group" aria-label="Account options" className="max-h-[calc(100dvh-88px)] overflow-y-auto overscroll-contain rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-1.5 text-[var(--text)] shadow-[0_16px_48px_#00000024]">
        <div className="border-b border-[var(--border)] px-3 py-3">
          <p className="truncate text-sm font-semibold">{name}</p>
          {email && <p className="mt-1 break-all text-xs muted">{email}</p>}
        </div>
        <Link ref={firstLink} href="/account/settings" className={action} onClick={() => setOpen(false)}>
          <Settings size={17} aria-hidden="true" /> Account settings
        </Link>
        <button type="button" className={action} aria-expanded={appearance} aria-controls={appearanceId} onClick={() => setAppearance(!appearance)}>
          <Palette size={17} aria-hidden="true" /> Appearance <ChevronDown size={15} aria-hidden="true" className={`ml-auto transition-transform ${appearance ? "rotate-180" : ""}`} />
        </button>
        {appearance && <div id={appearanceId} className="px-3 pb-3 pt-1">
          <p className="mb-2 text-xs muted">Choose a theme or follow your device.</p>
          <ThemeToggle />
        </div>}
        <div className="mt-1 border-t border-[var(--border)] pt-1">
          <button type="button" className={`${action} text-red-700 disabled:opacity-60 dark:text-red-300`} disabled={signingOut} onClick={onLogout}>
            {signingOut ? <Loader2 size={17} aria-hidden="true" className="motion-safe:animate-spin" /> : <LogOut size={17} aria-hidden="true" />}
            {signingOut ? "Signing out…" : "Logout"}
          </button>
        </div>
      </div>
    </div>}
  </div>;
}
