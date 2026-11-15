"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import * as Icons from "lucide-react";
import { canAccessModule, getNavigationModules, type getVisibleModules, roleLabels } from "@/lib/modules";
import { AccountMenu } from "@/components/layout/account-menu";
import { createClient } from "@/lib/supabase/client";
import { toUiRole, type UiRole } from "@/lib/auth/roles";
import { readActiveSchoolAccess, SchoolAccessDeniedError } from "@/lib/auth/access";
import { loginPath, mfaPath, StaffMfaRequiredError } from "@/lib/auth/staff-mfa";
import { WorkspaceSkeleton } from "@/components/ui/skeleton";
import { BrandLogo } from "@/components/ui/brand-logo";
import { guardianAttendancePath, guardianNotificationsPath } from "@/lib/attendance/family";
import { FamilyNotificationBell } from "@/components/notifications/family-notification-bell";

type ModuleItem = Pick<ReturnType<typeof getVisibleModules>[number], "key" | "label" | "icon"> & { group: string };

const groups = ["People", "Academics", "Assessment", "Finance", "Communication", "Operations", "System"];
const quickLinks: Record<UiRole, readonly string[]> = {
  admin: ["students", "attendance", "fees"],
  principal: ["students", "attendance", "notices"],
  teacher: ["attendance", "homework", "profile"],
  finance: ["fees", "invoices", "finance-reports"],
  reception: ["notices"],
  student: ["attendance", "homework", "invoices"],
  parent: ["attendance", "invoices", "notices"],
};
const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]";
const iconButton = `min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)] ${focus}`;
const activeLink = "bg-[var(--primary)] font-semibold text-white shadow-[0_4px_12px_#3867ff20] dark:text-[#0b1020]";
const idleLink = "font-medium muted hover:bg-[var(--surface-2)] hover:text-[var(--text)]";

function moduleHref(role: UiRole, key: string) {
  if (key === "exams" && (role === "student" || role === "parent")) return `/modules/exams?view=${role === "parent" ? "guardian" : "student"}`;
  if (role === "parent" && key === "attendance") return guardianAttendancePath;
  if (role === "parent" && key === "notifications") return guardianNotificationsPath;
  // Every guardian link keeps guardian scope, so a teacher who is also a guardian is not switched into the staff workspace.
  if (role === "parent") return `/modules/${key}?view=guardian`;
  return `/modules/${key}`;
}

function Brand() {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-2 text-[28px] font-extrabold leading-none tracking-[-0.055em]"><BrandLogo size={28} />SMS</p>
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
  const teachingOnly = role === "teacher" && modules.every((item) => canAccessModule("teacher", item.key));
  const navigationGroups = teachingOnly ? ["Teaching"] : groups;
  const baseId = useId();
  return (
    <nav aria-label="Workspace pages" className="space-y-5 px-3 pb-5">
      <Link href="/dashboard" aria-current={currentKey === "dashboard" ? "page" : undefined} onClick={onNavigate}
        className={`flex min-h-11 items-center gap-3 rounded-xl px-3 text-[13px] font-semibold transition-colors ${currentKey === "dashboard" ? activeLink : idleLink} ${focus}`}>
        <Icons.LayoutDashboard aria-hidden="true" size={19} strokeWidth={1.8} />
        Dashboard
      </Link>
      {navigationGroups.map((group) => {
        const items = modules.filter((item) => teachingOnly || item.group === group);
        if (!items.length) return null;
        return (
          <div key={group} role="group" aria-labelledby={`${baseId}-${group}`} className="space-y-0.5">
            <p id={`${baseId}-${group}`} className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] muted">{group}</p>
            {items.map((item) => {
              const Icon = Icons[item.icon];
              const selected = currentKey === item.key;
              return (
                <Link key={item.key} href={moduleHref(role, item.key)} aria-current={selected ? "page" : undefined}
                  onClick={onNavigate}
                  className={`flex min-h-11 items-center gap-3 rounded-xl px-3 text-[13px] transition-colors ${selected ? activeLink : idleLink} ${focus}`}>
                  <Icon aria-hidden="true" size={19} strokeWidth={1.75} className="shrink-0" />
                  <span className="min-w-0 flex-1 leading-5">{item.label}</span>
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

function displayIdentity(user: { id?: string; email?: string; user_metadata?: unknown } | null | undefined) {
  const metadata = user?.user_metadata && typeof user.user_metadata === "object" && !Array.isArray(user.user_metadata)
    ? user.user_metadata as Record<string, unknown> : {};
  const rawName = typeof metadata.full_name === "string" && metadata.full_name.trim() ? metadata.full_name
    : typeof metadata.name === "string" ? metadata.name : "";
  return { id: user?.id ?? "", email: user?.email ?? "", name: rawName.replace(/\s+/g, " ").trim().slice(0, 80) };
}

export function AppShell({ children, role, userId, overviewSchoolId }: {
  children: ReactNode; role: UiRole; userId?: string; overviewSchoolId?: string;
}) {
  const path = usePathname();
  const router = useRouter();
  const [supabase] = useState(createClient);
  const [signingOut, setSigningOut] = useState(false);
  const [identity, setIdentity] = useState({ id: userId ?? "", email: "", name: "" });
  const [logoutError, setLogoutError] = useState("");
  const [accountChanged, setAccountChanged] = useState(false);
  const [security, setSecurity] = useState<"checking" | "ready" | "error">("checking");
  const [verifiedOnce, setVerifiedOnce] = useState(false);
  const [schoolRoles, setSchoolRoles] = useState<(UiRole | null)[]>([]);
  const accessFingerprint = useRef("");
  const accountOwner = useRef(userId ?? "");
  const [query, setQuery] = useState("");
  const logoutPending = useRef(false);
  const menuDialog = useRef<HTMLDialogElement>(null);
  const searchDialog = useRef<HTMLDialogElement>(null);
  const shortcut = useSyncExternalStore(() => () => {}, () => /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘ K" : "Ctrl K", () => "Ctrl K");

  useEffect(() => {
    let active = true, generation = 0, verified = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // quiet: re-verify behind the page already shown (e.g. returning to the tab); only a real change replaces it.
    async function check(quiet = false) {
      const version = ++generation;
      if (!quiet || !verified) setSecurity("checking");
      try {
        const access = await readActiveSchoolAccess(supabase).catch((failure: unknown) => {
          if (overviewSchoolId && path === "/dashboard" && role === "admin" && failure instanceof StaffMfaRequiredError
            && failure.status.dashboard_allowed && failure.status.user_id === userId
            && failure.status.profile_school_id === overviewSchoolId) {
            return { userId: failure.status.user_id, profileSchoolId: overviewSchoolId, roles: failure.status.roles };
          }
          throw failure;
        });
        if (!active || generation !== version) return;
        if (!access) {
          setSecurity("error");
          router.replace(loginPath(`${window.location.pathname}${window.location.search}`));
          return;
        }
        if ((accountOwner.current && access.userId !== accountOwner.current)
          || (overviewSchoolId && access.profileSchoolId !== overviewSchoolId)
          || !access.roles.some((row) => toUiRole(row.role) === role)) {
          setAccountChanged(true); return;
        }
        const fingerprint = JSON.stringify([access.userId, access.profileSchoolId, [...access.roles].sort((a, b) => `${a.role}:${a.school_id}`.localeCompare(`${b.role}:${b.school_id}`))]);
        if (accessFingerprint.current && fingerprint !== accessFingerprint.current) { setAccountChanged(true); return; }
        accessFingerprint.current = fingerprint;
        setSchoolRoles(access.roles.filter((row) => row.school_id === access.profileSchoolId).map((row) => toUiRole(row.role)));
        verified = true;
        setVerifiedOnce(true);
        setSecurity("ready");
      } catch (failure) {
        if (!active || generation !== version) return;
        if (failure instanceof StaffMfaRequiredError) {
          setSecurity("error");
          router.replace(mfaPath(`${window.location.pathname}${window.location.search}`)); return;
        }
        // A read that failed behind the verified page keeps it; a definite "no" still replaces it.
        if (!quiet || !verified || failure instanceof SchoolAccessDeniedError) setSecurity("error");
      }
    }
    const focus = () => { void check(true); };
    const visible = () => { if (document.visibilityState === "visible") void check(true); };
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "INITIAL_SESSION") return;
      // Supabase repeats SIGNED_IN / TOKEN_REFRESHED for the same user every time the tab becomes visible.
      const quiet = event !== "SIGNED_OUT" && !!accountOwner.current && session?.user.id === accountOwner.current;
      generation += 1; clearTimeout(timer);
      if (!quiet) setSecurity("checking");
      // Signing out is not a way back to this page: go to a clean sign-in (a silent session loss in check() keeps next).
      if (event === "SIGNED_OUT") { setSecurity("error"); router.replace("/login"); return; }
      // Never await Auth inside its own event callback.
      timer = setTimeout(() => { void check(quiet); }, 0);
    });
    window.addEventListener("focus", focus); document.addEventListener("visibilitychange", visible);
    void check();
    return () => { active = false; generation += 1; clearTimeout(timer); subscription.unsubscribe(); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visible); };
  }, [overviewSchoolId, path, role, router, supabase, userId]);

  useEffect(() => {
    let active = true;
    let identityVersion = 0;
    function acceptIdentity(user: { id?: string; email?: string; user_metadata?: unknown } | null | undefined) {
      if (!active) return;
      if (accountOwner.current && user?.id !== accountOwner.current) {
        setIdentity({ id: "", name: "", email: "" });
        setAccountChanged(true);
        return;
      }
      if (user?.id) accountOwner.current = user.id;
      setIdentity(displayIdentity(user));
    }
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      identityVersion += 1;
      acceptIdentity(session?.user);
    });
    const requestVersion = identityVersion;
    void supabase.auth.getUser().then(({ data, error }) => {
      if (identityVersion === requestVersion) acceptIdentity(error ? null : data.user);
    }, () => {
      if (identityVersion === requestVersion) acceptIdentity(null);
    });
    return () => { active = false; subscription.unsubscribe(); };
  }, [supabase]);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const dialog = searchDialog.current;
      if (!dialog || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      if (menuDialog.current?.open) menuDialog.current.close();
      if (!dialog.open) dialog.showModal();
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
      const { error } = await supabase.auth.signOut({ scope: "local" });
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

  const visibleModules = getNavigationModules(role, schoolRoles);
  const moduleKey = path?.split("/")[2];
  const currentKey = path === "/account/settings" ? "account-settings" : path === "/dashboard" ? "dashboard" : moduleKey === "result-report"
    || ((role === "parent" || role === "student") && moduleKey === "published-results") ? "results" : moduleKey;
  const currentModule = visibleModules.find((item) => item.key === currentKey);
  const mobileModules = quickLinks[role].flatMap((key) => {
    const item = visibleModules.find((candidate) => candidate.key === key);
    return item ? [item] : [];
  });
  const searchTerm = query.trim().toLowerCase();
  const pages = [
    { label: "Dashboard", group: "Workspace", href: "/dashboard" },
    { label: "Account settings", group: "Account", href: "/account/settings" },
    ...visibleModules.map((item) => ({ label: item.label, group: item.group, href: moduleHref(role, item.key) })),
  ];
  const matches = pages.filter((page) => `${page.label} ${page.group}`.toLowerCase().includes(searchTerm));
  const displayName = identity.name || roleLabels[role];
  const initials = displayName.split(/\s+/).filter(Boolean).slice(0, 2)
    .map((part) => Array.from(part)[0].toUpperCase()).join("") || "U";
  const notificationKey = (role === "parent" || role === "student") && visibleModules.some((item) => item.key === "notifications") ? "notifications"
    : visibleModules.some((item) => item.key === "notices") ? "notices" : null;
  const profileIdentity = <>
    <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full border border-[color-mix(in_srgb,var(--primary)_16%,transparent)] bg-[color-mix(in_srgb,var(--primary)_10%,var(--surface))] text-xs font-bold text-[var(--primary)]">{initials}</span>
    <span className="hidden min-w-0 text-left xl:block"><span className="block max-w-36 truncate text-[13px] font-semibold">{displayName}</span><span className="mt-0.5 block text-[11px] muted">{identity.name ? roleLabels[role] : "School workspace"}</span></span>
  </>;

  if (accountChanged) return <main className="grid min-h-screen place-items-center bg-[var(--bg)] p-6">
    <section className="card max-w-lg space-y-4 p-6">
      <h1 className="text-xl font-bold">Your sign-in changed</h1>
      <p role="status" className="text-sm muted">Reopen the workspace to verify the current account and school access.</p>
      <a href="/dashboard" className="account-primary inline-flex min-h-11 items-center rounded-xl px-4 text-sm font-semibold">Reopen workspace</a>
    </section>
  </main>;

  if (security === "checking" && !verifiedOnce) return <WorkspaceSkeleton />;
  if (security === "error") return <main className="grid min-h-screen place-items-center bg-[var(--bg)] p-6"><section className="card max-w-lg space-y-4 p-6"><h1 className="text-xl font-bold">Account security unavailable</h1><p role="alert" className="text-sm muted">Your current access could not be verified. Reopen the workspace before continuing.</p><a href="/dashboard" className="account-primary inline-flex min-h-11 items-center rounded-xl px-4 text-sm font-semibold">Reopen workspace</a></section></main>;

  const checking = security === "checking";
  return (
    <div className="min-h-screen bg-[var(--bg)]">
      {checking && <WorkspaceSkeleton label="Verifying current account access…" />}
      {!checking && <a href="#workspace-main" className={`sr-only z-50 rounded-xl bg-[var(--surface)] p-3 font-semibold focus:not-sr-only focus:fixed focus:left-3 focus:top-3 ${focus}`}>Skip to workspace</a>}
      {!checking && <aside aria-label="Desktop sidebar" className="fixed inset-y-0 left-0 z-30 hidden w-[240px] flex-col border-r border-[var(--border)] bg-[var(--surface)] lg:flex">
        <div className="flex h-[72px] shrink-0 items-center border-b border-[var(--border)] px-6"><Brand /></div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-5">
          <Navigation role={role} modules={visibleModules} currentKey={currentKey} />
        </div>
      </aside>}

      <div className="min-w-0 lg:pl-[240px]" hidden={checking} inert={checking}>
        {!checking && <header className="sticky top-0 z-20 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_96%,transparent)] backdrop-blur-xl">
          <div className="mx-auto flex min-h-16 w-full max-w-[1600px] items-center gap-3 px-4 sm:px-6 lg:min-h-[72px] lg:gap-5 lg:px-8">
            <button type="button" aria-label="Open workspace menu" aria-haspopup="dialog" aria-controls="workspace-menu"
              className={`inline-flex ${iconButton} lg:hidden`} onClick={() => menuDialog.current?.showModal()}>
              <Icons.Menu aria-hidden="true" size={20} />
            </button>
            <div className="min-w-0 flex-1">
              <p className="mb-0.5 hidden items-center gap-1.5 text-[11px] muted sm:flex"><span>{roleLabels[role]}</span><Icons.ChevronRight aria-hidden="true" size={11} /><span>{currentModule?.group ?? "Workspace"}</span></p>
              <p className="truncate text-[14px] font-semibold tracking-tight">{currentKey === "account-settings" ? "Account settings" : currentModule?.label ?? "Dashboard"}</p>
            </div>
            <button type="button" aria-label="Find a page" aria-haspopup="dialog" aria-controls="workspace-search" aria-keyshortcuts="Control+k Meta+k"
              className={`flex min-h-11 shrink-0 items-center justify-center gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 text-[13px] font-medium muted transition-colors hover:text-[var(--text)] lg:min-w-[232px] lg:justify-start ${focus}`}
              onClick={() => searchDialog.current?.showModal()}>
              <Icons.Search aria-hidden="true" size={18} />
              <span className="hidden sm:inline">Find a page</span>
              <kbd aria-hidden="true" className="ml-auto hidden px-1.5 py-0.5 font-sans text-[11px] muted lg:inline">{shortcut}</kbd>
            </button>
            {notificationKey === "notifications" && (role === "parent" || role === "student") && identity.id
              ? <FamilyNotificationBell userId={identity.id} role={role} className={iconButton} />
              : notificationKey && <Link href={moduleHref(role, notificationKey)} aria-label={notificationKey === "notifications" ? "Open notifications" : "Notices and circulars"} className={`${notificationKey === "notifications" ? "inline-flex" : "hidden sm:inline-flex"} ${iconButton}`}><Icons.Bell aria-hidden="true" size={19} strokeWidth={1.75} /></Link>}
            <AccountMenu key={`${path}:${identity.email}`} identity={profileIdentity} name={displayName} email={identity.email} onLogout={handleLogout} signingOut={signingOut} />
          </div>
        </header>}
        <main id="workspace-main" tabIndex={-1} className="mx-auto min-w-0 max-w-[1600px] px-4 pb-28 pt-6 outline-none sm:px-6 sm:pb-28 lg:px-8 lg:pb-8 lg:pt-7">
          {logoutError && <p role="alert" className="mb-4 rounded-xl border border-red-500/30 bg-[var(--surface)] p-3 text-sm text-red-700 dark:text-red-300">{logoutError}</p>}
          {children}
        </main>
      </div>

      {!checking && <nav aria-label="Mobile shortcuts" className="glass fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-30 flex gap-1 rounded-2xl p-1.5 shadow-[0_8px_32px_#12233c16] lg:hidden">
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
      </nav>}

      {!checking && <dialog ref={menuDialog} id="workspace-menu" aria-labelledby="workspace-menu-title"
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
        </div>
      </dialog>}

      {!checking && <dialog ref={searchDialog} id="workspace-search" aria-labelledby="workspace-search-title" onClose={() => setQuery("")}
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
      </dialog>}
    </div>
  );
}
