import type { ReactNode } from "react";
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

/** Role-neutral route fallback; authorization is still pending, so no sidebar/actions. */
export function WorkspaceSkeleton({ label = "Loading your workspace…", variant = "dashboard" }: { label?: string; variant?: "dashboard" | "form" }) {
  return <main className={styles.workspace}><div className={styles.workspaceHeader}><span className={styles.wordmark}>SMS</span><Skeleton className={styles.account} /></div>
    <div className={styles.workspaceBody}><LoadingState label={label} variant={variant} /></div></main>;
}
