"use client";

import Link from "next/link";
import { CalendarCheck, Download, RefreshCw } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LoadingState } from "@/components/ui/skeleton";
import { loadFamilyAttendanceSummary, loadFamilyAttendanceReportContext, loadFamilyAttendanceReport, restoreFamilyReportYear, rememberFamilyReportYear, FamilyAttendanceSummaryError, type AttendanceSummaryPeriod, type FamilyAttendanceSummary, type FamilyAttendanceSummaryRole, type FamilyAttendanceReportContext, type FamilyAttendanceReportYear } from "@/lib/attendance/family-summary";
import { downloadFamilyAttendanceReportPdf } from "@/lib/attendance/report-export";

type Props = { client: SupabaseClient; userId: string; student: { id: string; school_id: string } | null;
  role: FamilyAttendanceSummaryRole; loading?: boolean; showHistoryLink?: boolean };
const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-50";
const dateFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const monthFormat = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
const number = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const dateLabel = (value: string) => dateFormat.format(new Date(`${value}T00:00:00Z`));
const monthLabel = (value: string) => monthFormat.format(new Date(`${value}T00:00:00Z`));
function reportingMonths(year: FamilyAttendanceReportYear | undefined, today: string | undefined) {
  if (!year || !today) return [];
  const last = (year.end_date < today ? year.end_date : today).slice(0, 7), months: string[] = [];
  const cursor = new Date(`${year.start_date.slice(0, 7)}-01T00:00:00Z`);
  for (let index = 0; index < 13 && cursor.toISOString().slice(0, 7) <= last; index++) {
    months.push(cursor.toISOString().slice(0, 10)); cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
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
export function OfficialAttendanceSummary({ client, userId, student, role, loading = false, showHistoryLink = true }: Props) {
  return <OwnOfficialAttendanceSummary key={`${userId}:${role}:${student?.id ?? "none"}:${student?.school_id ?? "none"}:${loading ? "loading" : "ready"}`} client={client} userId={userId} student={student} role={role} loading={loading} showHistoryLink={showHistoryLink} />;
}
function OwnOfficialAttendanceSummary({ client, userId, student, role, loading, showHistoryLink }: Props) {
  const [yearId, setYearId] = useState<string | null>(() => student ? restoreFamilyReportYear(userId, role, student) : null), [month, setMonth] = useState<string | null>(null), [revision, setRevision] = useState(0), [sessionChanged, setSessionChanged] = useState(false);
  const [loaded, setLoaded] = useState<{ key: string; data?: FamilyAttendanceSummary; error?: string }>();
  const [catalog, setCatalog] = useState<FamilyAttendanceReportContext>();
  const [pdf, setPdf] = useState<{ key: string; busy?: boolean; error?: string; saved?: boolean }>();
  const read = useRef<AbortController | null>(null), pdfRead = useRef<AbortController | null>(null);
  const id = useId(), studentId = student?.id, schoolId = student?.school_id, key = `${yearId ?? "current"}:${month ?? "server"}:${revision}`;
  const current = loaded?.key === key ? loaded : undefined, summary = current?.data;
  const selectedYear = catalog?.years.find(year => year.id === (yearId ?? catalog.current_year_id));
  const months = reportingMonths(selectedYear, catalog?.server_today), archived = selectedYear?.is_current === false;
  useEffect(() => {
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) { read.current?.abort(); pdfRead.current?.abort(); setSessionChanged(true); setLoaded(undefined); setCatalog(undefined); setPdf(undefined); }
    });
    return () => { read.current?.abort(); pdfRead.current?.abort(); subscription.unsubscribe(); };
  }, [client, userId]);
  useEffect(() => () => { pdfRead.current?.abort(); pdfRead.current = null; }, [key]);
  useEffect(() => {
    if (!studentId || sessionChanged) return;
    const refresh = () => { if (document.visibilityState === "visible") { pdfRead.current?.abort(); setRevision(value => value + 1); } };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [studentId, sessionChanged]);
  useEffect(() => {
    if (!studentId || !schoolId || sessionChanged || loading) return;
    const controller = new AbortController(); read.current = controller;
    const target = { id: studentId, school_id: schoolId };
    const report = yearId === null ? loadFamilyAttendanceSummary(client, userId, target, role, month, controller.signal)
      : loadFamilyAttendanceReport(client, userId, target, role, yearId, month, controller.signal);
    const contextRead = loadFamilyAttendanceReportContext(client, userId, target, role, controller.signal).then(context => {
      if (!controller.signal.aborted) setCatalog(context);
      return context;
    });
    Promise.all([contextRead, report]).then(([context, data]) => {
      if (controller.signal.aborted) return;
      const chosen = context.years.find(year => year.id === (yearId ?? context.current_year_id));
      const currentMismatch = yearId === null && (context.current_session_state !== data.session_state
        || context.current_year_id !== null && data.year !== null && context.current_year_id !== data.year.id
        || data.session_state === "active" && (!data.year || context.current_year_id !== data.year.id
          || !chosen && data.year.start_date <= data.server_today));
      if (currentMismatch || yearId !== null && !chosen || data.session_state === "active" && chosen && (data.year?.id !== chosen.id || data.year.name !== chosen.name
        || data.year.start_date !== chosen.start_date || data.year.end_date !== chosen.end_date)) {
        throw new FamilyAttendanceSummaryError("The selected academic year changed. Refresh or choose the current session again.");
      }
      setCatalog(context); setLoaded({ key, data });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        if (error instanceof FamilyAttendanceSummaryError && error.code === "access") { controller.abort(); setCatalog(undefined); }
        setLoaded({ key, error: error instanceof FamilyAttendanceSummaryError ? error.message : "Official attendance could not be loaded. Refresh to try again." });
      }
    });
    return () => { controller.abort(); if (read.current === controller) read.current = null; };
  }, [client, userId, studentId, schoolId, role, yearId, month, key, sessionChanged, loading]);
  function selectYear(value: string) { read.current?.abort(); pdfRead.current?.abort(); if (student) rememberFamilyReportYear(userId, role, student, value || null); setYearId(value || null); setMonth(null); }
  async function exportPdf() {
    if (!student || !summary?.year || !summary.month_summary || !summary.year_summary || summary.session_state !== "active" || sessionChanged || pdfRead.current && !pdfRead.current.signal.aborted) return;
    const controller = new AbortController(); pdfRead.current = controller; setPdf({ key, busy: true });
    try {
      await downloadFamilyAttendanceReportPdf(client, userId, student, role, summary.year.id, summary.month, controller.signal, summary);
      if (!controller.signal.aborted) setPdf({ key, saved: true });
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        if (error instanceof FamilyAttendanceSummaryError && error.code === "access") {
          read.current?.abort(); setCatalog(undefined); setLoaded({ key, error: error.message }); setPdf(undefined);
        } else setPdf({ key, error: error instanceof Error ? error.message : "The PDF could not be downloaded. Refresh attendance and try again." });
      }
    } finally { if (pdfRead.current === controller) pdfRead.current = null; }
  }
  const currentPdf = pdf?.key === key ? pdf : undefined;
  const href = role === "parent" ? "/modules/attendance?view=guardian" : "/modules/attendance";
  const asOf = summary?.year ? summary.year.end_date < summary.server_today ? summary.year.end_date : summary.server_today : undefined;
  return <section className="dashboard-panel min-w-0 space-y-4 p-4 sm:p-5" aria-labelledby={`${id}-title`}>
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h2 id={`${id}-title`} className="flex items-center gap-2 text-base font-semibold"><CalendarCheck size={18} className="text-[var(--primary)]" aria-hidden="true" />Official attendance</h2>
      <p className="mt-1 text-xs leading-5 muted">{summary?.year ? `${summary.year.name}${archived ? " · Previous academic year" : ""}` : "School calendar and verified enrollment"}{summary && asOf ? ` · ${archived ? "Through year end" : "Through"} ${dateLabel(asOf)} (IST)` : ""}</p></div>
      <div className="flex max-w-full flex-wrap items-center gap-2">
        {catalog && <label className="block min-w-0 max-w-full"><span className="sr-only">Academic year</span><select aria-label="Academic year" className="field w-auto max-w-full text-sm sm:max-w-72" value={yearId ?? ""} disabled={sessionChanged} onChange={event => selectYear(event.target.value)}>
          {yearId !== null && !selectedYear && <option value={yearId} disabled>Selected year unavailable</option>}<option value="">Current session{catalog.current_session_state !== "active" ? ` · ${catalog.current_session_state}` : ""}</option>{catalog.years.map(year => <option value={year.id} key={year.id}>{year.name} · {year.is_current ? "Current" : "Previous year"}</option>)}
        </select></label>}
        {catalog && <label className="block min-w-0 max-w-full"><span className="sr-only">Reporting month</span><select aria-label="Reporting month" className="field w-auto max-w-full text-sm sm:min-w-40" value={month ?? summary?.month ?? ""} onChange={event => { read.current?.abort(); pdfRead.current?.abort(); setMonth(event.target.value); }} disabled={sessionChanged || !summary || months.length < 2}>
          {!summary && <option value="">Choose reporting month</option>}{summary && !months.includes(summary.month) && <option value={summary.month} disabled>No elapsed reporting months</option>}{months.map(value => <option value={value} key={value}>{monthLabel(value)}</option>)}
        </select></label>}
        <button type="button" className={button} disabled={!student || sessionChanged || !current} onClick={() => { pdfRead.current?.abort(); setRevision(value => value + 1); }} aria-label="Refresh official attendance"><RefreshCw size={15} aria-hidden="true" />Refresh</button>
        <button type="button" className={button} disabled={loading || sessionChanged || !student || !selectedYear || summary?.session_state !== "active" || !summary?.year || !summary.month_summary || !summary.year_summary || currentPdf?.busy} aria-busy={currentPdf?.busy || undefined} onClick={exportPdf}><Download size={15} aria-hidden="true" />{currentPdf?.busy ? "Preparing PDF…" : "Download PDF"}</button></div>
    </header>
    {!sessionChanged && currentPdf?.error && <p role="alert" className="rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-sm leading-6 text-red-700 dark:text-red-300">{currentPdf.error}</p>}
    {!sessionChanged && currentPdf?.saved && <p role="status" className="text-xs leading-5 muted">PDF download started for the selected academic year and month.</p>}
    {sessionChanged ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">Your sign-in changed. Reopen attendance to check your records.</p>
      : loading || student && !current ? <LoadingState variant="cards">Loading official attendance…</LoadingState>
        : !student ? <p className="text-sm muted">A verified student profile is needed to view official attendance.</p>
          : current?.error ? <div className="space-y-3"><p role="alert" className="rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-sm leading-6 text-red-700 dark:text-red-300">{current.error}</p>
            <button type="button" className={button} onClick={() => { selectYear(""); setRevision(value => value + 1); }}>Use current session month</button></div>
            : summary && <>
              {summary.session_state === "active" && summary.month_summary && summary.year_summary ? <div className="grid gap-3 lg:grid-cols-2"><PeriodCard title="Monthly attendance" period={summary.month_summary} /><PeriodCard title="Academic session attendance" period={summary.year_summary} /></div>
                : <p role="status" className="rounded-xl bg-[var(--surface-2)] p-4 text-sm leading-6">{summary.session_state === "missing" ? "Your school has no current academic session. Ask the school office to complete setup, or choose an available previous year."
                  : summary.session_state === "ambiguous" ? "Your school has multiple current academic sessions. The school office must resolve this; available previous years can still be selected."
                    : "This academic session needs a supported, verified date range before attendance can be calculated. Available previous years can still be selected."}</p>}
              <footer className="flex flex-wrap items-start justify-between gap-3 border-t border-[var(--border)] pt-3"><p className="max-w-2xl text-xs leading-5 muted">Present/Late = 1 day · Half Day = 0.5 · Leave/Absent = 0. School-closed days are excluded. An unmarked working day never becomes an assumed absence.{archived ? " Previous-year reports reflect the current verified school records, including approved corrections." : ""}</p>
                {showHistoryLink && <Link href={href} className="inline-flex min-h-11 items-center text-xs font-semibold text-[var(--primary)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2">View attendance history</Link>}</footer>
            </>}
  </section>;
}
