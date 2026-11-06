"use client";

import Link from "next/link";
import { ArrowUpRight, CalendarDays, ChartNoAxesColumn, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { attendanceLabels } from "@/lib/attendance/types";
import { schoolDate } from "@/lib/attendance/types";
import { LoadingState, Skeleton } from "@/components/ui/skeleton";

export function DashboardGreeting({ eyebrow, title, description, href, action, children }: {
  eyebrow: string; title: string; description: string; href: string; action: string; children?: ReactNode;
}) {
  const today = schoolDate();
  return <header className="dashboard-greeting"><div className="min-w-0"><p className="dashboard-eyebrow">{eyebrow}</p><h1>{title}</h1><p className="dashboard-description">{description}</p></div><div className="dashboard-header-actions"><time className="dashboard-date" dateTime={today}><CalendarDays size={15} aria-hidden="true" />{new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${today}T00:00:00Z`))}</time>{children}<Link className="dashboard-primary" href={href}>{action}<ArrowUpRight size={16} aria-hidden="true" /></Link></div></header>;
}
export function DashboardPanel({ title, icon, right, children, className = "", preview = true }: { title: string; icon?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; preview?: boolean }) {
  return <section className={`dashboard-panel${preview ? " dashboard-preview-panel" : ""} ${className}`}><div className="dashboard-panel-head"><div className="flex min-w-0 items-center gap-2.5">{icon && <span className="dashboard-panel-icon">{icon}</span>}<h2>{title}</h2></div>{right}</div><div className="dashboard-panel-body" role={preview ? "region" : undefined} aria-label={preview ? `${title} preview` : undefined} tabIndex={preview ? 0 : undefined}>{children}</div></section>;
}
export function DashboardMetric({ label, value, context, icon: Icon, featured = false, tone = "blue", loading = false }: { label: string; value: string | number; context?: string; icon?: LucideIcon; featured?: boolean; tone?: "blue" | "green" | "violet" | "amber" | "rose"; loading?: boolean }) {
  return <article className={`dashboard-metric dashboard-tone-${tone}${featured ? " is-featured" : ""}`} aria-busy={loading || undefined}><h3 className="dashboard-metric-label">{label}</h3>{Icon && <span className="dashboard-metric-icon"><Icon size={18} aria-hidden="true" /></span>}<p className="dashboard-metric-value">{loading ? <Skeleton className="h-7 w-20" /> : value}</p>{context && <p className="dashboard-metric-context">{loading ? <Skeleton className="h-3 w-28 max-w-full" /> : context}</p>}</article>;
}
export function DashboardViewAll({ href, children = "View all" }: { href: string; children?: ReactNode }) {
  return <Link className="dashboard-text-link" href={href}>{children}<ArrowUpRight size={14} aria-hidden="true" /></Link>;
}
export function DashboardActions({ actions }: { actions: { label: string; href: string; icon: ReactNode }[] }) {
  return <div className="dashboard-actions">{actions.map((action) => <Link key={action.href} href={action.href}><span className="dashboard-action-icon">{action.icon}</span><span>{action.label}</span><ArrowUpRight className="ml-auto shrink-0" size={15} aria-hidden="true" /></Link>)}</div>;
}
export const attendanceStatusStyles = [
  { key: "present", color: "#3867ff" }, { key: "absent", color: "#df5871" }, { key: "late", color: "#c28621" },
  { key: "leave", color: "#8796bf" }, { key: "half_day", color: "#6c9aa8" }, { key: "holiday", color: "#96a59a" },
];
export function AttendanceComposition({ rows, loading = false, unavailable = false, title = "Attendance overview", detail = "Recent saved records", href }: {
  rows: { status: string }[]; loading?: boolean; unavailable?: boolean; title?: string; detail?: string; href: string;
}) {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  return <AttendanceSegments segments={[...counts].map(([key, value]) => ({ label: attendanceLabels[key as keyof typeof attendanceLabels] ?? key.replaceAll("_", " "), count: value,
    color: attendanceStatusStyles.find((status) => status.key === key)?.color ?? "#8796bf" }))} loading={loading} unavailable={unavailable} title={title} detail={detail} href={href} />;
}
export function AttendanceSegments({ segments, loading = false, unavailable = false, title, detail, href }: {
  segments: { label: string; count: number; color: string }[]; loading?: boolean; unavailable?: boolean; title: string; detail: string; href: string;
}) {
  const total = segments.reduce((sum, row) => sum + row.count, 0), circumference = 2 * Math.PI * 43;
  let offset = 0;
  const arcs = [];
  for (const row of segments) {
    const length = total ? row.count / total * circumference : 0;
    arcs.push({ ...row, length, start: offset });
    offset += length;
  }
  return <DashboardPanel title={title} icon={<ChartNoAxesColumn size={17} />} right={<DashboardViewAll href={href} />}><p className="dashboard-caption">{detail}</p>{loading ? <LoadingState variant="list" className="dashboard-empty">Loading saved attendance…</LoadingState> : unavailable ? <p className="dashboard-empty">Attendance is unavailable. Refresh to check the saved records.</p> : total === 0 ? <p className="dashboard-empty">No attendance records available for this view.</p> : <div className="dashboard-ring-layout"><div className="dashboard-ring"><svg viewBox="0 0 120 120" role="img" aria-label={`${total} saved attendance records: ${segments.map((row) => `${row.label} ${row.count}`).join(", ")}`}><circle cx="60" cy="60" r="43" fill="none" stroke="var(--border)" strokeWidth="12" />{arcs.map(({ length, start, ...row }) => {
    return <circle key={row.label} cx="60" cy="60" r="43" fill="none" stroke={row.color} strokeWidth="12" strokeDasharray={`${length} ${circumference - length}`} strokeDashoffset={-start} transform="rotate(-90 60 60)" />;
  })}</svg><div className="dashboard-ring-label"><strong>{total}</strong><span>records</span></div></div><ul className="dashboard-legend">{segments.map((row) => <li key={row.label}><span><i style={{ background: row.color }} />{row.label}</span><strong>{row.count}</strong></li>)}</ul></div>}</DashboardPanel>;
}
export function RecentLogChart({ logs, loading = false }: { logs: { log_date: string }[]; loading?: boolean }) {
  const byDay = new Map<string, number>();
  for (const log of logs) if (/^\d{4}-\d{2}-\d{2}$/.test(log.log_date) && Number.isFinite(Date.parse(log.log_date))) byDay.set(log.log_date, (byDay.get(log.log_date) ?? 0) + 1);
  const days = [...byDay].sort(([a], [b]) => a.localeCompare(b)).slice(-7), maximum = Math.max(...days.map(([, count]) => count), 1);
  const shown = days.reduce((sum, [, count]) => sum + count, 0);
  return <DashboardPanel title="Learning activity" icon={<ChartNoAxesColumn size={17} />} right={<DashboardViewAll href="/modules/class-logs">Academic logs</DashboardViewAll>}><div className="dashboard-chart-summary"><p><strong>{loading ? "—" : shown}</strong><span>recent logs</span></p><span className="dashboard-caption">Latest available records by date</span></div>{loading ? <LoadingState variant="list" className="dashboard-empty">Loading recent learning activity…</LoadingState> : !days.length ? <p className="dashboard-empty">Published and draft academic logs appear here once recorded.</p> : <><svg className="dashboard-bar-chart" viewBox="0 0 560 145" role="img" aria-label={`Recent academic log sample, ${shown} logs: ${days.map(([day, count]) => `${day} ${count}`).join(", ")}`}>
    {[25, 65, 105].map((y) => <line key={y} x1="0" x2="560" y1={y} y2={y} stroke="var(--border)" strokeDasharray="3 5" />)}
    {days.map(([day, count], index) => { const cell = 560 / days.length, height = count / maximum * 82, width = Math.min(cell * .54, 44), x = index * cell + (cell - width) / 2;
      return <g key={day}><rect x={x} y={105 - height} width={width} height={height} rx="5" fill="var(--primary)" opacity={index === days.length - 1 ? 1 : .48} /><text x={x + width / 2} y={97 - height} textAnchor="middle" fill="var(--text)" fontSize="12" fontWeight="600">{count}</text><text x={x + width / 2} y="132" textAnchor="middle" fill="var(--muted)" fontSize="12">{new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`))}</text></g>;
    })}</svg><p className="dashboard-chart-note">Based on {logs.length} recently loaded logs; this is a record sample, not a complete school trend.</p></>}</DashboardPanel>;
}
export function DashboardIdentity({ name, subtitle, details, label = "Student details", loading = false }: { name: string; subtitle: string; label?: string; details: { label: string; value: string }[]; loading?: boolean }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "S";
  return <section className="dashboard-identity"><h2 className="sr-only">{label}</h2>{loading ? <LoadingState variant="form" label="Loading student details…" /> : <><div className="dashboard-identity-person"><span className="dashboard-avatar" aria-hidden="true">{initials}</span><div className="min-w-0"><h3>{name}</h3><p>{subtitle}</p></div></div><dl>{details.map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl></>}</section>;
}
