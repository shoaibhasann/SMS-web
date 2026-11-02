"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import * as Icons from "lucide-react";
import { getAdminNavigationModules, getTeacherNavigationModules, getVisibleModules, roleLabels } from "@/lib/modules";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { createClient } from "@/lib/supabase/client";
import type { UiRole } from "@/lib/auth/roles";

export function AppShell({
  children,
  role,
}: {
  children: ReactNode;
  role: UiRole;
}) {
  const path = usePathname();
  const router = useRouter();
  const supabase = createClient();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [userEmail, setUserEmail] = useState("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUserEmail(data.user?.email ?? "");
    });
  }, []);

  async function handleLogout() {
    if (signingOut) return;

    setSigningOut(true);
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  const visibleModules = role === "teacher"
    ? getTeacherNavigationModules()
    : role === "admin"
      ? getAdminNavigationModules()
    : getVisibleModules(role);
  const groups = role === "teacher"
    ? ["Teaching"]
    : ["People", "Academics", "Assessment", "Finance", "Communication", "Operations", "System"];
  const mobileModules = visibleModules.slice(0, 3);

  const initials =
    userEmail
      ?.split("@")[0]
      ?.split(/[._-]/)
      .filter(Boolean)
      .slice(0, 2)
      .map((x) => x[0]?.toUpperCase())
      .join("") || "U";

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <aside
        className={`fixed z-40 inset-y-0 left-0 w-[272px] border-r border-[var(--border)] bg-[var(--surface)] transition-transform lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-3 px-6 py-5">
            <div className="grid h-11 w-11 place-items-center rounded-2xl gradient font-black text-lg text-white">
              KC
            </div>
            <div>
              <div className="font-extrabold tracking-tight">Kids Corner</div>
              <div className="text-xs muted">School Management System</div>
            </div>
          </div>

          <div className="px-4 pb-3">
            <Link
              href="/dashboard"
              className={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-semibold ${
                path === "/dashboard"
                  ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                  : "muted"
              }`}
            >
              <Icons.LayoutDashboard size={18} />
              Dashboard
            </Link>
          </div>

          <nav className="flex-1 overflow-y-auto px-4 pb-6">
            {groups.map((g) => (
              <div key={g} className="mb-5">
                <div className="px-4 pb-2 text-[10px] font-bold uppercase tracking-[.16em] muted">
                  {role === "teacher" ? "Teacher Tools" : g}
                </div>

                {visibleModules
                  .filter((m) => (role === "teacher" ? true : m.group === g))
                  .map((m) => {
                    const C = (Icons as any)[m.icon] ?? Icons.Circle;

                    return (
                      <Link
                        key={m.key}
                        href={`/modules/${m.key}`}
                        className={`mb-1 flex items-center gap-3 rounded-xl px-4 py-2.5 text-sm ${
                          path?.includes(`/modules/${m.key}`)
                            ? "bg-blue-50 font-semibold text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                            : "muted hover:bg-[var(--surface-2)]"
                        }`}
                        onClick={() => setOpen(false)}
                      >
                        <C size={18} strokeWidth={1.8} />
                        {m.label}
                      </Link>
                    );
                  })}
              </div>
            ))}
          </nav>

          <div className="m-4 rounded-2xl border border-[var(--border)] p-3">
            <div className="text-xs font-semibold">Logged in as</div>
            <div className="mt-1 text-sm">{roleLabels[role]}</div>

            {userEmail && (
              <div className="mt-1 truncate text-[11px] muted">
                {userEmail}
              </div>
            )}

            <div className="mt-3 flex items-center justify-between">
              <span className="text-xs muted">Theme</span>
              <ThemeToggle />
            </div>

            {role !== "teacher" && (
              <button
                onClick={handleLogout}
                disabled={signingOut}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-red-200 px-3 py-2.5 text-xs font-bold text-red-600 transition hover:bg-red-50 disabled:opacity-60 dark:border-red-900/60 dark:hover:bg-red-950/30"
              >
                {signingOut ? (
                  <Icons.Loader2 size={15} className="animate-spin" />
                ) : (
                  <Icons.LogOut size={15} />
                )}
                {signingOut ? "Signing out..." : "Logout"}
              </button>
            )}
          </div>
        </div>
      </aside>

      <main className="lg:pl-[272px]">
        <header className="sticky top-0 z-30 flex h-[72px] items-center gap-3 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] px-4 backdrop-blur-xl sm:px-6">
          <button
            className="rounded-xl border border-[var(--border)] p-2 lg:hidden"
            onClick={() => setOpen(!open)}
          >
            <Icons.Menu size={20} />
          </button>

          <div className="relative max-w-xl flex-1">
            <Icons.Search
              className="absolute left-3 top-1/2 -translate-y-1/2 muted"
              size={18}
            />
            <input
              className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] py-2.5 pl-10 pr-4 text-sm outline-none focus:ring-2 focus:ring-blue-500/20"
              placeholder="Search students, teachers, fees, reports..."
            />
          </div>

          <div className="hidden sm:block">
            <ThemeToggle />
          </div>

          <button className="rounded-xl p-2.5 muted hover:bg-[var(--surface)]">
            <Icons.Bell size={19} />
          </button>

          <div className="grid h-10 w-10 place-items-center rounded-full bg-blue-100 text-sm font-bold text-blue-700 dark:bg-blue-950 dark:text-blue-300">
            {initials}
          </div>
        </header>

        <div className="p-4 pb-24 sm:p-6 lg:p-8">{children}</div>
      </main>

      <nav className="fixed bottom-3 left-3 right-3 z-40 flex justify-around rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-2 shadow-xl lg:hidden">
        <Link
          href="/dashboard"
          className="grid place-items-center gap-1 rounded-xl px-4 py-2 text-blue-600"
        >
          <Icons.Home size={18} />
          <span className="text-[10px]">Home</span>
        </Link>
        {mobileModules.map((module) => {
          const Icon = (Icons as any)[module.icon] ?? Icons.Circle;
          return (
            <Link
              key={module.key}
              href={`/modules/${module.key}`}
              className="grid place-items-center gap-1 rounded-xl px-3 py-2 muted"
            >
              <Icon size={18} />
              <span className="max-w-16 truncate text-[10px]">{module.label}</span>
            </Link>
          );
        })}
        {role === "teacher" ? (
          <Link
            href="/modules/profile"
            className={`grid place-items-center gap-1 rounded-xl px-4 py-2 ${path?.includes("/modules/profile") ? "text-blue-600" : "muted"}`}
          >
            <Icons.UserRound size={18} />
            <span className="text-[10px]">Profile</span>
          </Link>
        ) : (
          <button
            onClick={handleLogout}
            className="grid place-items-center gap-1 rounded-xl px-4 py-2 muted"
          >
            <Icons.LogOut size={18} />
            <span className="text-[10px]">Logout</span>
          </button>
        )}
      </nav>
    </div>
  );
}
    