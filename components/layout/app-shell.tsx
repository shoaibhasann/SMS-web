"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Icons from "lucide-react";
import { getAdminNavigationModules, getTeacherNavigationModules, getVisibleModules, roleLabels } from "@/lib/modules";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { createClient } from "@/lib/supabase/client";
import type { UiRole } from "@/lib/auth/roles";
import { guardianAttendancePath } from "@/lib/attendance/family";

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
const activeLink = "bg-blue-50 font-semibold text-blue-700 dark:bg-blue-950/70 dark:text-blue-200";
const idleLink = "muted hover:bg-[var(--surface-2)]";

function moduleHref(role: UiRole, key: string) {
  return role === "parent" && key === "attendance" ? guardianAttendancePath : `/modules/${key}`;
}

function Brand() {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div aria-hidden="true" className="gradient grid size-11 shrink-0 place-items-center rounded-2xl text-sm font-black shadow-sm">KC</div>
      <div className="min-w-0">
        <div className="truncate font-extrabold tracking-tight">Kids Corner</div>
        <div className="text-xs muted">School workspace</div>
      </div>
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
        className={`flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-semibold ${currentKey === "dashboard" ? activeLink : idleLink} ${focus}`}>
        <Icons.LayoutDashboard aria-hidden="true" size={18} />
        Dashboard
      </Link>
      {navigationGroups.map((group) => {
        const items = modules.filter((item) => role === "teacher" || item.group === group);
        if (!items.length) return null;
        return (
          <div key={group} className="space-y-0.5">
            <p className="px-3 pb-1 text-[11px] font-bold uppercase tracking-[0.14em] muted">{group}</p>
            {items.map((item) => {
              const Icon = Icons[item.icon];
              const selected = currentKey === item.key;
              return (
                <Link key={item.key} href={moduleHref(role, item.key)} aria-current={selected ? "page" : undefined}
                  onClick={onNavigate}
                  className={`flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm ${selected ? activeLink : idleLink} ${focus}`}>
                  <Icon aria-hidden="true" size={17} strokeWidth={1.8} className="shrink-0" />
                  <span className="flex-1">{item.label}</span>
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

export function AppShell({ children, role }: { children: ReactNode; role: UiRole }) {
  const path = usePathname();
  const router = useRouter();
  const [supabase] = useState(createClient);
  const [signingOut, setSigningOut] = useState(false);
  const [userEmail, setUserEmail] = useState("");
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
      if (active) setUserEmail(session?.user.email ?? "");
    });
    const requestVersion = identityVersion;
    void supabase.auth.getUser().then(({ data, error }) => {
      if (active && identityVersion === requestVersion) setUserEmail(error ? "" : data.user?.email ?? "");
    }, () => {
      if (active && identityVersion === requestVersion) setUserEmail("");
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
  const currentKey = path === "/dashboard" ? "dashboard" : moduleKey === "result-report" ? "results" : moduleKey;
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
  const initials = userEmail.split("@")[0].split(/[._-]/).filter(Boolean).slice(0, 2)
    .map((part) => part[0].toUpperCase()).join("") || "U";
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
      <aside aria-label="Desktop sidebar" className="fixed inset-y-0 left-0 z-30 hidden w-[272px] flex-col border-r border-[var(--border)] bg-[var(--surface)] lg:flex">
        <div className="border-b border-[var(--border)] px-5 py-5"><Brand /></div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-4">
          <Navigation role={role} modules={visibleModules} currentKey={currentKey} />
        </div>
        <div className="border-t border-[var(--border)] p-3">
          <div className="flex items-center gap-3 px-2 pt-1">
            <div aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-blue-100 text-xs font-bold text-blue-800 dark:bg-blue-950 dark:text-blue-200">{initials}</div>
            <div className="min-w-0">
              <p className="text-sm font-semibold">{roleLabels[role]}</p>
              {userEmail && <p className="truncate text-xs muted" title={userEmail}>{userEmail}</p>}
            </div>
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">{logout}<ThemeToggle /></div>
        </div>
      </aside>

      <div className="lg:pl-[272px]">
        <header className="sticky top-0 z-20 flex min-h-[68px] items-center gap-3 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_90%,transparent)] px-4 backdrop-blur-xl sm:px-6 lg:gap-5">
          <button type="button" aria-label="Open workspace menu" aria-haspopup="dialog" aria-controls="workspace-menu"
            className={`inline-flex ${iconButton} lg:hidden`} onClick={() => menuDialog.current?.showModal()}>
            <Icons.Menu aria-hidden="true" size={20} />
          </button>
          <div className="min-w-0 flex-1">
            <p className="hidden text-xs font-medium muted sm:block">{currentModule?.group ?? "Workspace"}</p>
            <p className="truncate text-sm font-bold tracking-tight sm:text-base">{currentModule?.label ?? "Dashboard"}</p>
          </div>
          <button type="button" aria-haspopup="dialog" aria-controls="workspace-search" aria-keyshortcuts="Control+k Meta+k"
            className={`flex min-h-11 shrink-0 items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-medium hover:bg-[var(--surface-2)] ${focus}`}
            onClick={() => searchDialog.current?.showModal()}>
            <Icons.Search aria-hidden="true" size={17} />
            <span>Find a page</span>
            <kbd aria-hidden="true" className="hidden rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 font-sans text-[11px] muted md:inline">Ctrl / ⌘ K</kbd>
          </button>
          {visibleModules.some((item) => item.key === "notices") && (
            <Link href="/modules/notices" aria-label="Notices and circulars" className={`hidden sm:inline-flex ${iconButton}`}>
              <Icons.Bell aria-hidden="true" size={18} />
            </Link>
          )}
        </header>
        <main id="workspace-main" tabIndex={-1} className="mx-auto max-w-[1600px] p-4 pb-28 outline-none sm:p-6 sm:pb-28 lg:p-8">
          {logoutError && <p role="alert" className="mb-4 rounded-xl border border-red-500/30 bg-[var(--surface)] p-3 text-sm text-red-700 dark:text-red-300">{logoutError}</p>}
          {children}
        </main>
      </div>

      <nav aria-label="Mobile shortcuts" className="glass fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-30 flex gap-1 rounded-2xl p-1.5 shadow-xl lg:hidden">
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
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold">{roleLabels[role]}</p>
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
