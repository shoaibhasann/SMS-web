"use client";

import Link from "next/link";
import { CalendarCheck, RefreshCw } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LoadingState } from "@/components/ui/skeleton";
import { loadFamilyAttendanceSummary, FamilyAttendanceSummaryError, type AttendanceSummaryPeriod, type FamilyAttendanceSummary, type FamilyAttendanceSummaryRole } from "@/lib/attendance/family-summary";

type Props = { client: SupabaseClient; userId: string; student: { id: string; school_id: string } | null;
  role: FamilyAttendanceSummaryRole; loading?: boolean };
const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-50";
const dateFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const monthFormat = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
const number = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const dateLabel = (value: string) => dateFormat.format(new Date(`${value}T00:00:00Z`));
const monthLabel = (value: string) => monthFormat.format(new Date(`${value}T00:00:00Z`));
function reportingMonths(summary: FamilyAttendanceSummary) {
  if (summary.session_state !== "active" || !summary.year) return [summary.month];
  const first = summary.year.start_date.slice(0, 7), last = (summary.year.end_date < summary.server_today ? summary.year.end_date : summary.server_today).slice(0, 7);
  const months = new Set([summary.month]);
  const cursor = new Date(`${first}-01T00:00:00Z`);
  for (let index = 0; index < 13 && cursor.toISOString().slice(0, 7) <= last; index++) {
    months.add(cursor.toISOString().slice(0, 10)); cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return [...months].sort();
}
const stateLabel = { complete: "Complete register", calendar_unconfigured: "Calendar setup needed", attendance_incomplete: "Awaiting attendance",
  enrollment_unverified: "Enrollment needs review", inconsistent: "Records need review", no_working_days: "No working days", not_enrolled: "No enrollment", not_started: "No elapsed school days" };
function periodExplanation(period: AttendanceSummaryPeriod) {
  if (period.state === "calendar_unconfigured") return `${period.unconfigured_days} enrolled ${period.unconfigured_days === 1 ? "day has" : "days have"} no saved school calendar. The school office must verify the reporting period.`;
  if (period.state === "attendance_incomplete") return `${period.unmarked_days} working ${period.unmarked_days === 1 ? "day is" : "days are"} unmarked. Missing marks are not counted as Absent.`;
  if (period.state === "enrollment_unverified") return "The school must verify enrollment dates before an official rate can be calculated.";
  if (period.state === "inconsistent") return "Some working-day records do not match the school register. Ask the school office to review them.";
  if (period.state === "no_working_days") return "This enrolled period has no school working days. A percentage does not apply.";
  if (period.state === "not_enrolled") return "No verified enrollment overlaps this reporting period.";
  if (period.state === "not_started") return "No elapsed enrollment days are available in this reporting period.";
  return "Based on the complete working-day register for this enrolled period.";
}
function PeriodCard({ title, period }: { title: string; period: AttendanceSummaryPeriod }) {
  return <article className="min-w-0 space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4 sm:p-5" aria-label={title}>
    <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="text-sm font-semibold">{title}</h3>
      {period.from && period.to && <p className="mt-1 text-xs leading-5 muted">{dateLabel(period.from)} – {dateLabel(period.to)}</p>}</div>
      <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${period.state === "complete" ? "bg-[var(--primary)]/10 text-[var(--primary)]" : "border border-[var(--border)] muted"}`}>{stateLabel[period.state]}</span></div>
    <div><p className="text-3xl font-bold tabular-nums tracking-tight sm:text-4xl">{period.percentage === null ? "—" : `${number.format(period.percentage)}%`}</p>
      <p className="mt-2 text-xs leading-5 muted">{periodExplanation(period)}</p></div>
    {period.from !== null && period.to !== null && <><dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
      {[["Working days", period.working_days], ["Closed days excluded", period.closed_days], ["Earned days", period.earned_days], ["Unmarked days", period.unmarked_days]].map(([label, value]) => <div key={label} className="min-w-0"><dt className="leading-5 muted">{label}</dt><dd className="mt-0.5 text-base font-semibold tabular-nums">{number.format(Number(value))}</dd></div>)}
    </dl>
    <details className="border-t border-[var(--border)] pt-3"><summary className="min-h-8 cursor-pointer text-xs font-semibold text-[var(--primary)] focus-visible:outline-2 focus-visible:outline-offset-2">Calculation details</summary>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">{[["Present", period.present_days], ["Late", period.late_days], ["Half Day", period.half_days], ["Leave", period.leave_days], ["Absent", period.absent_days], ["Calendar not configured", period.unconfigured_days], ["Records to review", period.invalid_days]].map(([label, value]) => <div className="flex justify-between gap-2" key={label}><dt className="muted">{label}</dt><dd className="font-semibold tabular-nums">{value}</dd></div>)}</dl>
    </details></>}
  </article>;
}
export function OfficialAttendanceSummary({ client, userId, student, role, loading = false }: Props) {
  return <OwnOfficialAttendanceSummary key={`${userId}:${role}:${student?.id ?? "none"}:${student?.school_id ?? "none"}`} client={client} userId={userId} student={student} role={role} loading={loading} />;
}
function OwnOfficialAttendanceSummary({ client, userId, student, role, loading }: Props) {
  const [month, setMonth] = useState<string | null>(null), [revision, setRevision] = useState(0), [sessionChanged, setSessionChanged] = useState(false);
  const [loaded, setLoaded] = useState<{ key: string; data?: FamilyAttendanceSummary; error?: string }>();
  const id = useId(), studentId = student?.id, schoolId = student?.school_id, key = `${month ?? "server"}:${revision}`;
  const current = loaded?.key === key ? loaded : undefined, summary = current?.error ? undefined : current?.data, controls = loaded?.data;
  useEffect(() => {
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) { setSessionChanged(true); setLoaded(undefined); }
    });
    return () => subscription.unsubscribe();
  }, [client, userId]);
  useEffect(() => {
    if (!studentId || sessionChanged) return;
    const refresh = () => { if (document.visibilityState === "visible") setRevision(value => value + 1); };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [studentId, sessionChanged]);
  useEffect(() => {
    if (!studentId || !schoolId || sessionChanged) return;
    const controller = new AbortController();
    loadFamilyAttendanceSummary(client, userId, { id: studentId, school_id: schoolId }, role, month, controller.signal).then(data => {
      if (!controller.signal.aborted) setLoaded({ key, data });
    }, (error: unknown) => {
      if (!controller.signal.aborted) setLoaded(previous => ({ key, data: previous?.data, error: error instanceof FamilyAttendanceSummaryError ? error.message : "Official attendance could not be loaded. Refresh to try again." }));
    });
    return () => controller.abort();
  }, [client, userId, studentId, schoolId, role, month, key, sessionChanged]);
  const href = role === "parent" ? "/modules/attendance?view=guardian" : "/modules/attendance";
  return <section className="dashboard-panel space-y-4 p-4 sm:p-5" aria-labelledby={`${id}-title`}>
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h2 id={`${id}-title`} className="flex items-center gap-2 text-base font-semibold"><CalendarCheck size={18} className="text-[var(--primary)]" aria-hidden="true" />Official attendance</h2>
      <p className="mt-1 text-xs leading-5 muted">{controls?.year ? controls.year.name : "School calendar and verified enrollment"}{summary ? ` · Through ${dateLabel(summary.server_today)} (IST)` : ""}</p></div>
      <div className="flex flex-wrap items-center gap-2">{controls && <label className="sr-only" htmlFor={`${id}-month`}>Reporting month</label>}{controls && <select id={`${id}-month`} className="field w-auto min-w-40 text-sm" value={month ?? controls.month} onChange={event => setMonth(event.target.value)} disabled={sessionChanged || !current || reportingMonths(controls).length < 2}>{reportingMonths(controls).map(value => <option value={value} key={value}>{monthLabel(value)}</option>)}</select>}
        <button type="button" className={button} disabled={!student || sessionChanged || !current} onClick={() => setRevision(value => value + 1)} aria-label="Refresh official attendance"><RefreshCw size={15} aria-hidden="true" />Refresh</button></div>
    </header>
    {sessionChanged ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">Your sign-in changed. Reopen your dashboard to check attendance.</p>
      : loading || student && !current ? <LoadingState variant="cards">Loading official attendance…</LoadingState>
        : !student ? <p className="text-sm muted">A verified student profile is needed to view official attendance.</p>
          : current?.error ? <div className="space-y-3"><p role="alert" className="rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-sm leading-6 text-red-700 dark:text-red-300">{current.error}</p>
            <button type="button" className={button} onClick={() => { setMonth(null); setRevision(value => value + 1); }}>Use current session month</button></div>
            : summary && <>
              {summary.session_state === "active" && summary.month_summary && summary.year_summary ? <div className="grid gap-3 lg:grid-cols-2"><PeriodCard title="Monthly attendance" period={summary.month_summary} /><PeriodCard title="Academic session attendance" period={summary.year_summary} /></div>
                : <p role="status" className="rounded-xl bg-[var(--surface-2)] p-4 text-sm leading-6">{summary.session_state === "missing" ? "Your school has no current academic session. Ask the school office to complete setup."
                  : summary.session_state === "ambiguous" ? "Your school has multiple current academic sessions. The school office must resolve this before a rate can be calculated."
                    : "This academic session needs a supported, verified date range before attendance can be calculated."}</p>}
              <footer className="flex flex-wrap items-start justify-between gap-3 border-t border-[var(--border)] pt-3"><p className="max-w-2xl text-xs leading-5 muted">Present/Late = 1 day · Half Day = 0.5 · Leave/Absent = 0. School-closed days are excluded. An unmarked working day never becomes an assumed absence.</p>
                <Link href={href} className="inline-flex min-h-11 items-center text-xs font-semibold text-[var(--primary)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2">View attendance history</Link></footer>
            </>}
  </section>;
}
