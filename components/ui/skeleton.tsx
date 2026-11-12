import type { ReactNode } from "react";
import { BrandLogo } from "./brand-logo";
import styles from "./skeleton.module.css";

type SkeletonVariant = "list" | "table" | "form" | "cards" | "dashboard";

/** Decorative geometry only: never contains cached names, values or actions. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`${styles.block} ${className}`} />;
}

function Rows({ table = false }: { table?: boolean }) {
  return <div className={styles.rows}>{[0, 1, 2].map((row) => <div key={row} className={table ? styles.tableRow : styles.listRow}>
    <Skeleton className={styles.avatar} /><div className={styles.rowText}><Skeleton className={styles.line} /><Skeleton className={styles.shortLine} /></div>{table && <Skeleton className={styles.cell} />}
  </div>)}</div>;
}

function Form() {
  return <div className={styles.form}>{[0, 1, 2, 3].map((field) => <div key={field} className={styles.field}><Skeleton className={styles.shortLine} /><Skeleton className={styles.input} /></div>)}</div>;
}

function Cards() {
  return <div className={styles.cards}>{[0, 1, 2, 3].map((card) => <div key={card} className={styles.metric}><Skeleton className={styles.shortLine} /><Skeleton className={styles.value} /><Skeleton className={styles.line} /></div>)}</div>;
}

/** Preserve the real loading announcement while visible content uses neutral shapes. */
export function LoadingState({ children, label = "Loading content…", variant = "list", className = "" }: {
  children?: ReactNode; label?: string; variant?: SkeletonVariant; className?: string;
}) {
  return <div role="status" aria-live="polite" aria-busy="true" data-skeleton={variant} className={`${styles.loading} ${className}`}>
    <span className={styles.srOnly}>{children ?? label}</span>
    <div aria-hidden="true" className={styles.geometry}>
      {variant === "dashboard" ? <><div className={styles.heading}><Skeleton className={styles.title} /><Skeleton className={styles.line} /></div><Cards /><div className={styles.panels}><div className={styles.panel}><Skeleton className={styles.line} /><Rows /></div><div className={styles.panel}><Skeleton className={styles.line} /><Rows /></div></div></>
        : variant === "cards" ? <Cards /> : variant === "form" ? <Form /> : <Rows table={variant === "table"} />}
    </div>
  </div>;
}

const sidebarRows = [
  ["w-24"],
  ["w-20", "w-28", "w-16", "w-24"],
  ["w-24", "w-16", "w-28"],
  ["w-20", "w-24"],
];

/** Matches the workspace footprint while current account access is being checked. */
export function WorkspaceSkeleton({ label = "Loading your workspace…", variant = "dashboard" }: { label?: string; variant?: "dashboard" | "form" }) {
  if (variant === "form") {
    return <main className={styles.workspace}><div className={styles.workspaceHeader}><span className={styles.wordmark}><BrandLogo size={28} />SMS</span><Skeleton className={styles.account} /></div>
      <div className={styles.workspaceBody}><LoadingState label={label} variant={variant} /></div></main>;
  }

  return (
    <div className={styles.workspace}>
      <aside aria-hidden="true" data-skeleton="sidebar"
        className="fixed inset-y-0 left-0 z-30 hidden w-[240px] flex-col border-r border-[var(--border)] bg-[var(--surface)] lg:flex">
        <div className="flex h-[72px] shrink-0 flex-col justify-center gap-1.5 border-b border-[var(--border)] px-6">
          <span className="flex items-center gap-2 text-[28px] font-extrabold leading-none tracking-[-0.055em]"><BrandLogo size={28} />SMS</span>
          <span className="text-[11px] leading-4 muted">School Management System</span>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-hidden px-3 pb-5 pt-5">
          {sidebarRows.map((rows, group) => (
            <div key={group}>
              {group > 0 && <Skeleton className="mb-2 ml-3 h-2 w-14" />}
              {rows.map((width, row) => (
                <div key={row} className="flex min-h-11 items-center gap-3 px-3">
                  <Skeleton className="size-[18px]" />
                  <Skeleton className={`h-2.5 ${width}`} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </aside>

      <div className="min-w-0 lg:pl-[240px]">
        <div aria-hidden="true" className="border-b border-[var(--border)] bg-[var(--surface)]">
          <div className="mx-auto flex min-h-16 max-w-[1600px] items-center gap-3 px-4 sm:px-6 lg:min-h-[72px] lg:gap-5 lg:px-8">
            <div className="lg:hidden"><Skeleton className="size-11" /></div>
            <div className="min-w-0 flex-1 space-y-2">
              <div className="hidden sm:block"><Skeleton className="h-2 w-16" /></div>
              <Skeleton className="h-3 w-24 max-w-full" />
            </div>
            <div className="hidden sm:block"><Skeleton className="h-11 w-32 lg:w-[232px]" /></div>
            <Skeleton className={styles.account} />
          </div>
        </div>
        <main className="mx-auto min-w-0 max-w-[1600px] px-4 pb-8 pt-6 sm:px-6 lg:px-8 lg:pt-7">
          <LoadingState label={label} variant={variant} />
        </main>
      </div>
    </div>
  );
}
