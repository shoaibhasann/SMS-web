"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Icons from "lucide-react";
import { getAdminNavigationModules, getTeacherNavigationModules, getVisibleModules, roleLabels } from "@/lib/modules";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { createClient } from "@/lib/supabase/client";
import type { UiRole } from "@/lib/auth/roles";
import { guardianAttendancePath, guardianNotificationsPath } from "@/lib/attendance/family";

type ModuleItem = Pick<ReturnType<typeof getVisibleModules>[number], "key" | "label" | "icon"> & { group: string };

const groups = ["People", "Academics", "Assessment", "Finance", "Communication", "Operations", "System"];
const quickLinks: Record<UiRole, readonly string[]> = {
  admin: ["students", "attendance", "fees"],
  principal: ["students", "attendance", "notices"],
  teacher: ["attendance", "homework", "profile"],
  finance: ["fees", "invoices", "finance-reports"],
  reception: ["students", "notices", "admissions"],
  student: ["attendance", "homework", "invoices"],
  parent: ["attendance", "invoices", "notices"],
};
const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]";
const iconButton = `min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)] ${focus}`;
const activeLink = "bg-[var(--primary)] font-semibold text-white shadow-[0_4px_12px_#3867ff20] dark:text-[#0b1020]";
const idleLink = "font-medium muted hover:bg-[var(--surface-2)] hover:text-[var(--text)]";

function moduleHref(role: UiRole, key: string) {
  if (role === "parent" && key === "attendance") return guardianAttendancePath;
  if (role === "parent" && key === "notifications") return guardianNotificationsPath;
  if (role === "parent" && (key === "advance-credit" || key === "invoices" || key === "student-leave" || key === "timetable" || key === "results" || key === "published-results" || key === "profile")) return `/modules/${key}?view=guardian`;
  return `/modules/${key}`;
}

function Brand() {
  return (
    <div className="min-w-0">
      <p className="text-[28px] font-extrabold leading-none tracking-[-0.055em]">SMS</p>
      <p className="mt-1.5 text-[11px] leading-4 muted">School Management System</p>
    </div>
  );
}

function Navigation({ role, modules, currentKey, onNavigate }: {
  role: UiRole;
  modules: ModuleItem[];
  currentKey?: string;
  onNavigate?: () => void;
}) {
  const navigationGroups = role === "teacher" ? ["Teaching"] : groups;
  return (
    <nav aria-label="Workspace pages" className="space-y-5 px-3 pb-5">
      <Link href="/dashboard" aria-current={currentKey === "dashboard" ? "page" : undefined} onClick={onNavigate}
        className={`flex min-h-11 items-center gap-3 rounded-xl px-3 text-[13px] font-semibold transition-colors ${currentKey === "dashboard" ? activeLink : idleLink} ${focus}`}>
        <Icons.LayoutDashboard aria-hidden="true" size={19} strokeWidth={1.8} />
        Dashboard
      </Link>
      {navigationGroups.map((group) => {
        const items = modules.filter((item) => role === "teacher" || item.group === group);
        if (!items.length) return null;
        return (
          <div key={group} className="space-y-0.5">
            <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] muted">{group}</p>
            {items.map((item) => {
              const Icon = Icons[item.icon];
              const selected = currentKey === item.key;
              return (
                <Link key={item.key} href={moduleHref(role, item.key)} aria-current={selected ? "page" : undefined}
                  onClick={onNavigate}
                  className={`flex min-h-11 items-center gap-3 rounded-xl px-3 text-[13px] transition-colors ${selected ? activeLink : idleLink} ${focus}`}>
                  <Icon aria-hidden="true" size={19} strokeWidth={1.75} className="shrink-0" />
                  <span className="min-w-0 flex-1 leading-5">{item.label}</span>
                  {selected && <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

function displayIdentity(user: { email?: string; user_metadata?: unknown } | null | undefined) {
  const metadata = user?.user_metadata && typeof user.user_metadata === "object" && !Array.isArray(user.user_metadata)
    ? user.user_metadata as Record<string, unknown> : {};
  const rawName = typeof metadata.full_name === "string" && metadata.full_name.trim() ? metadata.full_name
    : typeof metadata.name === "string" ? metadata.name : "";
  return { email: user?.email ?? "", name: rawName.replace(/\s+/g, " ").trim().slice(0, 80) };
}

export function AppShell({ children, role }: { children: ReactNode; role: UiRole }) {
  const path = usePathname();
  const router = useRouter();
  const [supabase] = useState(createClient);
  const [signingOut, setSigningOut] = useState(false);
  const [identity, setIdentity] = useState({ email: "", name: "" });
  const [logoutError, setLogoutError] = useState("");
  const [query, setQuery] = useState("");
  const logoutPending = useRef(false);
  const menuDialog = useRef<HTMLDialogElement>(null);
  const searchDialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let active = true;
    let identityVersion = 0;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      identityVersion += 1;
      if (active) setIdentity(displayIdentity(session?.user));
    });
    const requestVersion = identityVersion;
    void supabase.auth.getUser().then(({ data, error }) => {
      if (active && identityVersion === requestVersion) setIdentity(displayIdentity(error ? null : data.user));
    }, () => {
      if (active && identityVersion === requestVersion) setIdentity(displayIdentity(null));
    });
    return () => { active = false; subscription.unsubscribe(); };
  }, [supabase]);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      if (menuDialog.current?.open) menuDialog.current.close();
      if (!searchDialog.current?.open) searchDialog.current?.showModal();
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  async function handleLogout() {
    if (logoutPending.current) return;
    logoutPending.current = true;
    setSigningOut(true);
    setLogoutError("");
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      if (menuDialog.current?.open) menuDialog.current.close();
      router.replace("/login");
      router.refresh();
    } catch {
      setLogoutError("Sign out failed. Please try again.");
    } finally {
      logoutPending.current = false;
      setSigningOut(false);
    }
  }

  const visibleModules = role === "teacher"
    ? getTeacherNavigationModules()
    : role === "admin" ? getAdminNavigationModules() : getVisibleModules(role);
  const moduleKey = path?.split("/")[2];
  const currentKey = path === "/dashboard" ? "dashboard" : moduleKey === "result-report"
    || ((role === "parent" || role === "student") && moduleKey === "published-results") ? "results" : moduleKey;
  const currentModule = visibleModules.find((item) => item.key === currentKey);
  const mobileModules = quickLinks[role].flatMap((key) => {
    const item = visibleModules.find((candidate) => candidate.key === key);
    return item ? [item] : [];
  });
  const searchTerm = query.trim().toLowerCase();
  const pages = [
    { label: "Dashboard", group: "Workspace", href: "/dashboard" },
    ...visibleModules.map((item) => ({ label: item.label, group: item.group, href: moduleHref(role, item.key) })),
  ];
  const matches = pages.filter((page) => `${page.label} ${page.group}`.toLowerCase().includes(searchTerm));
  const displayName = identity.name || roleLabels[role];
  const initials = displayName.split(/\s+/).filter(Boolean).slice(0, 2)
    .map((part) => Array.from(part)[0].toUpperCase()).join("") || "U";
  const canOpenProfile = visibleModules.some((item) => item.key === "profile");
  const notificationKey = role === "parent" && visibleModules.some((item) => item.key === "notifications") ? "notifications"
    : visibleModules.some((item) => item.key === "notices") ? "notices" : null;
  const profileIdentity = <>
    <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full border border-[color-mix(in_srgb,var(--primary)_16%,transparent)] bg-[color-mix(in_srgb,var(--primary)_10%,var(--surface))] text-xs font-bold text-[var(--primary)]">{initials}</span>
    <span className="hidden min-w-0 text-left xl:block"><span className="block max-w-36 truncate text-[13px] font-semibold">{displayName}</span><span className="mt-0.5 block text-[11px] muted">{identity.name ? roleLabels[role] : "School workspace"}</span></span>
  </>;

  const logout = (
    <button type="button" onClick={handleLogout} disabled={signingOut}
      className={`inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-semibold muted hover:bg-[var(--surface-2)] disabled:opacity-60 ${focus}`}>
      {signingOut ? <Icons.Loader2 aria-hidden="true" size={17} className="motion-safe:animate-spin" /> : <Icons.LogOut aria-hidden="true" size={17} />}
      {signingOut ? "Signing out…" : "Logout"}
    </button>
  );

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <a href="#workspace-main" className={`sr-only z-50 rounded-xl bg-[var(--surface)] p-3 font-semibold focus:not-sr-only focus:fixed focus:left-3 focus:top-3 ${focus}`}>Skip to workspace</a>
      <aside aria-label="Desktop sidebar" className="fixed inset-y-0 left-0 z-30 hidden w-[240px] flex-col border-r border-[var(--border)] bg-[var(--surface)] lg:flex">
        <div className="flex h-[72px] shrink-0 items-center border-b border-[var(--border)] px-6"><Brand /></div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-5">
          <Navigation role={role} modules={visibleModules} currentKey={currentKey} />
        </div>
        <div className="shrink-0 border-t border-[var(--border)] p-3">
          <div className="flex items-center gap-2.5 rounded-xl bg-[var(--surface-2)] px-3 py-3">
            <div aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-[color-mix(in_srgb,var(--primary)_12%,var(--surface))] text-[11px] font-bold text-[var(--primary)]">{initials}</div>
            <div className="min-w-0"><p className="text-[12px] font-semibold">{roleLabels[role]}</p>
              {identity.email && <p className="mt-0.5 truncate text-[11px] muted" title={identity.email}>{identity.email}</p>}
            </div>
          </div>
          <div className="mt-2 flex items-center justify-between gap-1">{logout}<ThemeToggle /></div>
        </div>
      </aside>

      <div className="min-w-0 lg:pl-[240px]">
        <header className="sticky top-0 z-20 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_96%,transparent)] backdrop-blur-xl">
          <div className="mx-auto flex min-h-16 w-full max-w-[1600px] items-center gap-3 px-4 sm:px-6 lg:min-h-[72px] lg:gap-5 lg:px-8">
            <button type="button" aria-label="Open workspace menu" aria-haspopup="dialog" aria-controls="workspace-menu"
              className={`inline-flex ${iconButton} lg:hidden`} onClick={() => menuDialog.current?.showModal()}>
              <Icons.Menu aria-hidden="true" size={20} />
            </button>
            <div className="min-w-0 flex-1">
              <p className="mb-0.5 hidden items-center gap-1.5 text-[11px] muted sm:flex"><span>{roleLabels[role]}</span><Icons.ChevronRight aria-hidden="true" size={11} /><span>{currentModule?.group ?? "Workspace"}</span></p>
              <p className="truncate text-[14px] font-semibold tracking-tight">{currentModule?.label ?? "Dashboard"}</p>
            </div>
            <button type="button" aria-label="Find a page" aria-haspopup="dialog" aria-controls="workspace-search" aria-keyshortcuts="Control+k Meta+k"
              className={`flex min-h-11 shrink-0 items-center justify-center gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 text-[13px] font-medium muted transition-colors hover:text-[var(--text)] lg:min-w-[232px] lg:justify-start ${focus}`}
              onClick={() => searchDialog.current?.showModal()}>
              <Icons.Search aria-hidden="true" size={18} />
              <span className="hidden sm:inline">Find a page</span>
              <kbd aria-hidden="true" className="ml-auto hidden px-1.5 py-0.5 font-sans text-[11px] muted lg:inline">⌘ K</kbd>
            </button>
            {notificationKey && <Link href={moduleHref(role, notificationKey)} aria-label={notificationKey === "notifications" ? "Open notifications" : "Notices and circulars"} className={`hidden sm:inline-flex ${iconButton}`}><Icons.Bell aria-hidden="true" size={19} strokeWidth={1.75} /></Link>}
            {canOpenProfile ? <Link href={moduleHref(role, "profile")} aria-label="Open my profile" className={`hidden min-h-11 min-w-11 items-center gap-2.5 rounded-xl lg:flex ${focus}`}>{profileIdentity}</Link>
              : <div role="group" aria-label="Signed-in account" className="hidden min-h-11 min-w-11 items-center gap-2.5 lg:flex">{profileIdentity}</div>}
          </div>
        </header>
        <main id="workspace-main" tabIndex={-1} className="mx-auto min-w-0 max-w-[1600px] px-4 pb-28 pt-6 outline-none sm:px-6 sm:pb-28 lg:px-8 lg:pb-8 lg:pt-7">
          {logoutError && <p role="alert" className="mb-4 rounded-xl border border-red-500/30 bg-[var(--surface)] p-3 text-sm text-red-700 dark:text-red-300">{logoutError}</p>}
          {children}
        </main>
      </div>

      <nav aria-label="Mobile shortcuts" className="glass fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-30 flex gap-1 rounded-2xl p-1.5 shadow-[0_8px_32px_#12233c16] lg:hidden">
        <Link href="/dashboard" aria-current={currentKey === "dashboard" ? "page" : undefined}
          className={`flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[11px] font-semibold ${currentKey === "dashboard" ? activeLink : idleLink} ${focus}`}>
          <Icons.Home aria-hidden="true" size={18} />Home
        </Link>
        {mobileModules.map((item) => {
          const Icon = Icons[item.icon];
          const selected = currentKey === item.key;
          const label = item.key === "invoices" ? "Receipts"
            : item.key === "notices" ? "Notices"
              : item.key === "finance-reports" ? "Reports"
                : item.key === "attendance" ? "Attend" : item.label;
          return (
            <Link key={item.key} href={moduleHref(role, item.key)} aria-label={item.label} aria-current={selected ? "page" : undefined}
              className={`flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[11px] font-semibold ${selected ? activeLink : idleLink} ${focus}`}>
              <Icon aria-hidden="true" size={18} /><span className="max-w-full truncate">{label}</span>
            </Link>
          );
        })}
        <button type="button" aria-haspopup="dialog" aria-controls="workspace-menu"
          className={`flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[11px] font-semibold muted ${focus}`}
          onClick={() => menuDialog.current?.showModal()}>
          <Icons.Ellipsis aria-hidden="true" size={18} />More
        </button>
      </nav>

      <dialog ref={menuDialog} id="workspace-menu" aria-labelledby="workspace-menu-title"
        className="fixed inset-y-0 left-0 right-auto m-0 h-dvh max-h-none w-[min(100vw,360px)] max-w-none border-r border-[var(--border)] bg-[var(--surface)] p-0 text-[var(--text)] shadow-2xl backdrop:bg-slate-950/55"
        onClick={(event) => { if (event.target === event.currentTarget) menuDialog.current?.close(); }}>
        <div className="flex h-full flex-col">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] p-4">
            <h2 id="workspace-menu-title" className="text-lg font-extrabold">Workspace menu</h2>
            <button type="button" className={`inline-flex ${iconButton}`} aria-label="Close workspace menu" onClick={() => menuDialog.current?.close()}><Icons.X aria-hidden="true" size={19} /></button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-4">
            <Navigation role={role} modules={visibleModules} currentKey={currentKey} onNavigate={() => menuDialog.current?.close()} />
          </div>
          <div className="shrink-0 border-t border-[var(--border)] p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <p className="mb-2 text-sm font-semibold">{roleLabels[role]}</p>
            <div className="flex items-center justify-between gap-2">
              <ThemeToggle />
              {logout}
            </div>
            {logoutError && <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{logoutError}</p>}
          </div>
        </div>
      </dialog>

      <dialog ref={searchDialog} id="workspace-search" aria-labelledby="workspace-search-title" onClose={() => setQuery("")}
        className="fixed inset-x-0 top-[min(12vh,6rem)] bottom-auto mx-auto my-0 max-h-[75dvh] w-[calc(100%-2rem)] max-w-xl overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-0 text-[var(--text)] shadow-2xl backdrop:bg-slate-950/55"
        onClick={(event) => { if (event.target === event.currentTarget) searchDialog.current?.close(); }}>
        <div className="flex max-h-[75dvh] flex-col">
          <form role="search" className="shrink-0 space-y-3 border-b border-[var(--border)] p-4 sm:p-5" onSubmit={(event) => {
            event.preventDefault();
            if (!matches[0]) return;
            searchDialog.current?.close();
            router.push(matches[0].href);
          }}>
            <h2 id="workspace-search-title" className="text-lg font-extrabold">Find a page</h2>
            <div className="flex gap-2">
              <input type="search" aria-label="Search workspace pages" placeholder="Search by page or section" value={query}
                onChange={(event) => setQuery(event.target.value)} className="field min-w-0 flex-1" />
              <button type="button" className={`inline-flex ${iconButton}`} aria-label="Close page search" onClick={() => searchDialog.current?.close()}><Icons.X aria-hidden="true" size={19} /></button>
            </div>
          </form>
          <div className="min-h-0 overflow-y-auto overscroll-contain p-2">
            {matches.length ? matches.map((page) => (
              <Link key={page.href} href={page.href} onClick={() => searchDialog.current?.close()}
                className={`flex min-h-12 items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm font-semibold hover:bg-[var(--surface-2)] ${focus}`}>
                <span>{page.label}</span><span className="shrink-0 text-xs font-normal muted">{page.group}</span>
              </Link>
            )) : <p role="status" className="p-4 text-sm muted">No pages match your search.</p>}
          </div>
        </div>
      </dialog>
    </div>
  );
}
